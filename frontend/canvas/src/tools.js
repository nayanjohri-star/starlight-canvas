// 工具节点（utility）执行器：本地确定性处理，不发起任何生成请求。
// 输入经 refs 连线（按 order）汇聚为文本序列与素材序列；产出写入
// node.data.outputText / outputAssetIds，可被下游节点复用为生成引用。
// 媒体类工具走浏览器 Canvas2D / <video> 真实解码：网格与像素设上限、
// 视频处理 30s 超时与中断、自建 objectURL 用毕回收；等间隔抽帧与直方图
// 切点检测是两种独立方法，命名与摘要如实区分，不互相冒充。

import { el, toast } from './ui.js';
import { TOOLS, parseCSV, template } from './studio-schema.js';

const MAX_CELLS = 25;             // 切格/拼格单元上限
const MAX_DIM = 8192;             // 单边像素上限
const MAX_PIXELS = 33_554_432;    // 单画布总像素上限（≈32MP，防内存爆）
const MAX_VIDEO_SECONDS = 600;    // 本地逐帧处理时长上限
const IO_TIMEOUT_MS = 30_000;     // 视频加载/定位超时（回滚版 150s 过长，压缩为 30s）
const IMG_TIMEOUT_MS = 15_000;
const KINDL = { image: '一个图片', video: '一个视频', audio: '一个音频' };

export function createTools(deps) {
  const { store } = deps;

  // ---- 输入汇聚：缺失引用保留占位，绝不静默丢引用后执行 ----
  function nodeOutputs(src) {
    const d = src.data ?? {};
    // 不过滤：null/失效 id 保留槽位，由 gather 落成缺失占位（占位即事实，执行据此拒绝而非拿残缺输入跑）
    const ids = src.type === 'asset' ? [d.assetId ?? null]
      : Array.isArray(d.outputAssetIds) && d.outputAssetIds.length ? d.outputAssetIds
      : d.resultAssetId ? [d.resultAssetId] : [];
    return { text: src.type === 'text' ? (d.resultText || d.text || '') : (d.outputText || ''), assetIds: ids };
  }
  function gather(node) {
    const p = store.project;
    const texts = [], ins = [];
    for (const e of store.edgesInto(node.id, 'refs')) {
      const src = p.nodes.find(n => n.id === e.from.node);
      if (!src) continue;
      const out = nodeOutputs(src);
      if (out.text) texts.push(out.text);
      for (const id of out.assetIds) {
        const a = typeof id === 'string' && id ? p.assets[id] : null;
        ins.push(a ?? { id: typeof id === 'string' ? id : null, name: '（缺失素材）', kind: null, missing: true });
      }
    }
    return { texts, ins };
  }

  // ---- 守卫与参数 ----
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  const intIn = (v, min, max, dflt) => {
    if (v === undefined || v === null || v === '') return dflt;
    const n = Number(v);
    need(Number.isInteger(n) && n >= min && n <= max, `参数 ${v} 须为 ${min}–${max} 整数`);
    return n;
  };
  const numIn = (v, min, max, dflt) => {
    if (v === undefined || v === null || v === '') return dflt;
    const n = Number(v);
    need(Number.isFinite(n) && n >= min && n <= max, `参数 ${v} 须为 ${min}–${max} 数字`);
    return n;
  };
  const aborted = s => { if (s?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' }); };
  const requireDOM = () => {
    if (typeof document !== 'object' || document === null || typeof document.createElement !== 'function')
      throw new Error('此工具需要浏览器环境（Canvas2D / 视频解码），当前环境无法产出真实结果');
  };
  function pickAsset(ins, kind) {
    const a = ins.find(x => x.kind === kind);
    if (a) { need(!a.missing, `素材「${a.name}」已缺失`); return a; }
    if (ins.some(x => x.missing)) throw new Error('连线素材缺失或已删除，无法执行');
    throw new Error(`需要${KINDL[kind] ?? kind}素材输入`);
  }
  async function blobOfAsset(a) {
    const b = await deps.assets.blobOf(a.id);
    if (!b || !b.size) { a.missing = true; throw new Error(`素材「${a.name}」本地文件缺失`); }
    return b;
  }
  const baseName = n => String(n || '素材').replace(/\.[a-z0-9]{1,8}$/i, '');

  // ---- 浏览器解码原语（仅媒体工具调用）----
  const dims = b => ({ w: b.width || b.naturalWidth || b.videoWidth || 0, h: b.height || b.naturalHeight || b.videoHeight || 0 });
  function checkPixels(w, h) {
    need(w > 0 && h > 0, '媒体尺寸不可读');
    need(w <= MAX_DIM && h <= MAX_DIM, `尺寸超过 ${MAX_DIM}px 上限`);
    need(w * h <= MAX_PIXELS, '像素总量超过本地处理上限');
  }
  function makeCanvas(w, h) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; }
  const toBlob = cv => new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('PNG 导出失败')), 'image/png'));
  function withTimeout(promise, ms, label, signal) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${label}超时（${ms / 1000}s）`)), ms);
      const onAbort = () => { clearTimeout(t); rej(Object.assign(new Error('已取消'), { name: 'AbortError' })); };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      promise.then(v => { clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); res(v); },
                 e => { clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); rej(e); });
    });
  }
  async function decodeImage(blob, signal) {
    requireDOM();
    if (typeof createImageBitmap === 'function')
      return withTimeout(createImageBitmap(blob), IMG_TIMEOUT_MS, '图片解码', signal);
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      const p = new Promise((res, rej) => { img.onload = () => res(img); img.onerror = () => rej(new Error('图片解码失败')); });
      img.src = url;
      return await withTimeout(p, IMG_TIMEOUT_MS, '图片解码', signal);
    } finally { URL.revokeObjectURL(url); }
  }
  async function loadVideo(blob, signal) {
    requireDOM();
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true; video.preload = 'auto';
    const cleanup = () => {
      try { video.pause(); video.removeAttribute('src'); video.load?.(); } catch { /* 忽略 */ }
      URL.revokeObjectURL(url);
    };
    try {
      const ready = new Promise((res, rej) => {
        video.onloadedmetadata = res;
        video.onerror = () => rej(new Error('视频元数据读取失败（格式可能不受支持）'));
      });
      video.src = url;
      await withTimeout(ready, IO_TIMEOUT_MS, '视频加载', signal);
      const { duration, videoWidth: w, videoHeight: h } = video;
      need(Number.isFinite(duration) && duration > 0, '视频时长不可读');
      need(duration <= MAX_VIDEO_SECONDS, `视频超过 ${MAX_VIDEO_SECONDS / 60} 分钟，超出本地处理上限`);
      checkPixels(w, h);
      return { video, duration, w, h, cleanup };
    } catch (e) { cleanup(); throw e; }
  }
  function seekTo(video, t, signal) {
    return withTimeout(new Promise((res, rej) => {
      video.onseeked = () => res();
      video.onerror = () => rej(new Error('视频定位失败'));
      video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.05));
    }), IO_TIMEOUT_MS, '视频定位', signal);
  }
  async function grab(video, t, signal) {
    await seekTo(video, t, signal);
    const cv = makeCanvas(video.videoWidth, video.videoHeight);
    cv.getContext('2d').drawImage(video, 0, 0);
    return cv;
  }
  // 直方图镜头切点检测：等距采样 ≤60 帧，96×54 缩图 32bin 亮度直方图，
  // 相邻差分超过 均值+1.2σ 的局部峰记为切点；无峰时取最强差分点。
  async function detectCuts(meta, want, signal) {
    const samples = Math.max(16, Math.min(60, Math.floor(meta.duration * 2)));
    const w = 96, h = 54;
    const cv = makeCanvas(w, h), ctx = cv.getContext('2d', { willReadFrequently: true });
    const hists = [];
    for (let i = 0; i < samples; i++) {
      aborted(signal);
      await seekTo(meta.video, i * meta.duration / samples, signal);
      ctx.drawImage(meta.video, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      const hist = new Float64Array(32);
      for (let p = 0; p < d.length; p += 4) hist[(((d[p] * 3 + d[p + 1] * 4 + d[p + 2]) >> 3)) >> 3]++;
      hists.push(hist);
    }
    const diffs = [];
    for (let i = 1; i < samples; i++) {
      let s = 0; for (let b = 0; b < 32; b++) s += Math.abs(hists[i][b] - hists[i - 1][b]);
      diffs.push({ t: i * meta.duration / samples, score: s / (w * h) });
    }
    const mean = diffs.reduce((a, d) => a + d.score, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, d) => a + (d.score - mean) ** 2, 0) / diffs.length) || 1;
    const thr = mean + 1.2 * sd;
    const peaks = diffs.filter((d, i) => d.score >= thr && d.score >= (diffs[i - 1]?.score ?? -1) && d.score >= (diffs[i + 1]?.score ?? -1));
    const chosen = (peaks.length ? peaks : [...diffs].sort((x, y) => y.score - x.score).slice(0, 1))
      .sort((x, y) => y.score - x.score).slice(0, want).sort((x, y) => x.t - y.t);
    return chosen.map(d => Math.max(0, Math.min(d.t, meta.duration - 0.05)));
  }

  // JSON 提取路径：a.b[0].c / $.a[0] 形式
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  function parsePath(path) {
    const p = String(path).replace(/^\$\.?/, '');
    const segs = [];
    for (const part of p.split('.')) {
      need(part !== '' && /^[^[\]]*(\[\d{1,6}\])*$/.test(part), `路径语法不合法：${path}（支持 a.b[0] 形式）`);
      const pieces = part.split(/[\[\]]/).filter(x => x !== '');
      const head = pieces.shift();
      need(head !== undefined, `路径语法不合法：${path}`);
      if (/^\d+$/.test(head)) segs.push(Number(head));   // 点号数字段/根级数字都是数组或对象索引
      else {
        need(!FORBIDDEN_KEYS.has(head), `路径访问受保护字段：${head}`);
        segs.push(head);
      }
      for (const r of pieces) segs.push(Number(r));
    }
    return segs;
  }

  const IMPL = {
    text_input({ params }) {
      const text = String(params.text ?? '');
      return { text, summary: `文本输入 ${[...text].length} 字` };
    },
    json_parse({ params, texts }) {
      const src = (texts.join('\n') || String(params.source ?? '')).trim();
      need(src, '缺少 JSON 输入文本（连线文本节点或填 source 参数）');
      let doc; try { doc = JSON.parse(src); } catch (e) { throw new Error(`输入不是合法 JSON：${e.message}`); }
      const path = String(params.path ?? '').trim();
      let val = doc;
      if (path) {
        for (const seg of parsePath(path)) { if (val == null) break; val = val[seg]; }
        need(val !== undefined, `路径不存在：${path}`);
      }
      return { text: typeof val === 'string' ? val : JSON.stringify(val, null, 2), summary: `JSON 提取 ${path || '(根)'}` };
    },
    index_selector({ params, texts, ins }) {
      const idx = intIn(params.index, 1, 1000, 1);
      if (ins.length) {
        const a = ins[idx - 1];
        need(a, `第 ${idx} 项不存在（共 ${ins.length} 项）`);
        need(!a.missing, `第 ${idx} 项素材已缺失`);
        return { assets: [a], text: `${idx}. ${a.name}`, summary: `选择第 ${idx} 个素材` };
      }
      const t = texts[idx - 1];
      need(t !== undefined, `第 ${idx} 项不存在（共 ${texts.length} 项）`);
      return { text: t, summary: `选择第 ${idx} 段文本` };
    },
    resource_merge({ texts, ins }) {
      const seen = new Set(), assets = [];
      for (const a of ins) {
        need(!a.missing, `素材「${a.name}」已缺失`);
        if (!seen.has(a.id)) { seen.add(a.id); assets.push(a); }
      }
      return { assets, text: texts.filter(Boolean).join('\n'), summary: `合并 ${assets.length} 个素材` };
    },
    async grid_split({ params, ins, signal, registerBlob, checkScope }) {
      const a = pickAsset(ins, 'image');
      const rows = intIn(params.rows, 1, MAX_CELLS, 2), cols = intIn(params.cols, 1, MAX_CELLS, 2);
      need(rows * cols <= MAX_CELLS, `切格数超限（行×列 ≤ ${MAX_CELLS}）`);
      const blob = await blobOfAsset(a);
      checkScope?.();
      requireDOM();
      const bmp = await decodeImage(blob, signal);
      checkScope?.();
      const { w: W, h: H } = dims(bmp); checkPixels(W, H);
      const out = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        aborted(signal);
        const x0 = Math.floor(c * W / cols), x1 = Math.floor((c + 1) * W / cols);
        const y0 = Math.floor(r * H / rows), y1 = Math.floor((r + 1) * H / rows);
        const cv = makeCanvas(x1 - x0, y1 - y0);
        cv.getContext('2d').drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
        out.push(await registerBlob(await toBlob(cv), `${baseName(a.name)}-格${r * cols + c + 1}.png`, 'image', { category: a.category, tags: a.tags }));
      }
      return { assets: out, text: `${cols}×${rows} → ${out.length} 格`, summary: `切格 ${cols}×${rows}` };
    },
    async grid_merge({ params, ins, signal, registerBlob, checkScope }) {
      const miss = ins.find(x => x.missing);
      need(!miss, `素材「${miss?.name}」已缺失`);
      const imgs = ins.filter(x => x.kind === 'image');
      need(imgs.length >= 1, '需要至少一个图片素材输入');
      need(imgs.length <= MAX_CELLS, `单次最多拼 ${MAX_CELLS} 张`);
      const items = [];
      for (const a of imgs) { items.push({ a, blob: await blobOfAsset(a) }); checkScope?.(); aborted(signal); }
      requireDOM();
      for (const it of items) {
        it.bmp = await decodeImage(it.blob, signal);
        checkScope?.();
        const d = dims(it.bmp); checkPixels(d.w, d.h);
        Object.assign(it, d);
      }
      const cols = intIn(params.cols, 1, MAX_CELLS, Math.ceil(Math.sqrt(imgs.length)));
      const rows = Math.ceil(imgs.length / cols);
      const pad = intIn(params.padding, 0, 400, 0);
      const cw = intIn(params.cellWidth, 8, MAX_DIM, Math.max(...items.map(i => i.w)));
      const ch = intIn(params.cellHeight, 8, MAX_DIM, Math.max(...items.map(i => i.h)));
      let W = cols * cw + (cols - 1) * pad, H = rows * ch + (rows - 1) * pad;
      let scale = 1;
      if (W * H > MAX_PIXELS) { scale = Math.sqrt(MAX_PIXELS / (W * H)); W = Math.max(1, Math.floor(W * scale)); H = Math.max(1, Math.floor(H * scale)); }
      const cv = makeCanvas(W, H), ctx = cv.getContext('2d');
      ctx.fillStyle = typeof params.background === 'string' && /^#[0-9a-f]{3,8}$/i.test(params.background) ? params.background : '#000000';
      ctx.fillRect(0, 0, W, H);
      items.forEach((it, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const dw = Math.max(1, Math.floor(cw * scale)), dh = Math.max(1, Math.floor(ch * scale));
        const dx = Math.floor(c * (cw + pad) * scale), dy = Math.floor(r * (ch + pad) * scale);
        const s = Math.min(dw / it.w, dh / it.h);
        const w = Math.max(1, Math.round(it.w * s)), h = Math.max(1, Math.round(it.h * s));
        ctx.drawImage(it.bmp, dx + ((dw - w) >> 1), dy + ((dh - h) >> 1), w, h);
      });
      const rec = await registerBlob(await toBlob(cv), `拼图-${imgs.length}张-${cols}x${rows}.png`, 'image');
      return { assets: [rec], text: `${cols}×${rows} ${W}×${H}${scale < 1 ? '（已按比例缩放）' : ''}`, summary: `拼格 ${imgs.length}→1` };
    },
    async crop({ params, ins, signal, registerBlob, checkScope }) {
      const a = pickAsset(ins, 'image');
      need([params.x, params.y, params.w, params.h].every(v => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))),
        '请填写裁切参数 x/y/w/h（像素）');
      const blob = await blobOfAsset(a);
      checkScope?.();
      requireDOM();
      const bmp = await decodeImage(blob, signal);
      checkScope?.();
      const { w: W, h: H } = dims(bmp); checkPixels(W, H);
      const x = numIn(params.x, 0, W - 1, 0), y = numIn(params.y, 0, H - 1, 0);
      const w = numIn(params.w, 1, W, 0), h = numIn(params.h, 1, H, 0);
      need(x + w <= W && y + h <= H, `裁切区域越界（图 ${W}×${H}）`);
      const cv = makeCanvas(w, h);
      cv.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
      const rec = await registerBlob(await toBlob(cv), `${baseName(a.name)}-裁切${w}x${h}.png`, 'image', { category: a.category, tags: a.tags });
      return { assets: [rec], text: `裁切 ${w}×${h} @(${x},${y})`, summary: '裁切' };
    },
    async video_frame_extract({ params, ins, signal, registerBlob, checkScope }) {
      const v = pickAsset(ins, 'video');
      const blob = await blobOfAsset(v);
      checkScope?.();
      requireDOM();
      const meta = await loadVideo(blob, signal);
      try {
        checkScope?.();   // 加载期间切项目/删节点也在 finally 里 cleanup，不泄漏 objectURL
        const at = numIn(params.at, 0, MAX_VIDEO_SECONDS, 0);
        const t = Math.max(0, Math.min(at, meta.duration - 0.05));
        const rec = await registerBlob(await toBlob(await grab(meta.video, t, signal)), `${baseName(v.name)}-帧@${t.toFixed(2)}s.png`, 'image');
        return { assets: [rec], text: `定点取帧 @${t.toFixed(2)}s`, summary: `定点取帧 ${t.toFixed(2)}s` };
      } finally { meta.cleanup(); }
    },
    async shot_extraction({ params, ins, signal, registerBlob, checkScope }) {
      const v = pickAsset(ins, 'video');
      const mode = params.mode === undefined || params.mode === '' || params.mode === 'interval' ? 'interval'
        : params.mode === 'histogram' ? 'histogram' : null;
      need(mode, `未知抽帧方式：${params.mode}（interval=等间隔抽帧，histogram=直方图切点检测）`);
      const count = intIn(params.count, 1, 25, 4);
      const blob = await blobOfAsset(v);
      checkScope?.();
      requireDOM();
      const meta = await loadVideo(blob, signal);
      try {
        checkScope?.();
        const times = mode === 'interval'
          ? Array.from({ length: count }, (_, i) => (i + 0.5) * meta.duration / count)
          : await detectCuts(meta, count, signal);
        checkScope?.();
        const out = [];
        const label = mode === 'interval' ? '等间隔抽帧' : '镜头切点';
        for (const t of times) {
          aborted(signal);
          const rec = await registerBlob(await toBlob(await grab(meta.video, t, signal)), `${baseName(v.name)}-${label}@${t.toFixed(2)}s.png`, 'image');
          out.push(rec);
        }
        const method = mode === 'interval' ? `等间隔抽帧 ×${times.length}` : `直方图切点检测 ×${times.length}`;
        return { assets: out, text: times.map(t => `${t.toFixed(2)}s`).join(', '), summary: method };
      } finally { meta.cleanup(); }
    },
    batch_table({ params }) {
      const raw = String(params.csv ?? '');
      need(raw.trim(), '请在参数中粘贴 CSV 文本');
      const rows = parseCSV(raw);                      // 表头/列数/≤100 行由 schema 强校验
      const tpl = String(params.template ?? '');
      if (tpl.trim()) {
        const rendered = rows.map(r => template(tpl, r));
        return { text: JSON.stringify(rendered, null, 2), tableRows: rows, summary: `模板渲染 ${rendered.length} 行` };
      }
      return { text: JSON.stringify(rows, null, 2), tableRows: rows, summary: `解析 ${rows.length} 行` };
    },
  };

  // 执行 → 持久化 outputText/outputAssetIds/operation。
  // 作用域守卫：整个操作钉在发起时的 project/node 上——IMPL 内每个 await 之后、
  // 每次 registerBlob 入库之前都重新核验；切换项目或发起节点被删即中止，
  // 产出绝不落进新项目；失败时原草稿与既有媒体原样保留，不假返回完整成功。
  async function execute(node, { signal } = {}) {
    need(node && node.type === 'utility', '仅工具节点可执行');
    const tool = node.data?.tool;
    need(TOOLS[tool] && IMPL[tool], `未配置工具或工具未知：${tool ?? '（空）'}`);
    const project = store.project;
    const checkScope = () => {
      if (!project || store.project !== project || !project.nodes.some(n => n.id === node.id))
        throw new Error('项目已切换或节点已删除，执行中止');
    };
    const registerBlob = (blob, name, kind, extra) => {
      checkScope();
      return deps.assets.registerBlob(blob, name, kind, extra, { project, nodeId: node.id });
    };
    checkScope();
    const { texts, ins } = gather(node);
    const result = await IMPL[tool]({ node, params: node.data.params ?? {}, texts, ins, signal, registerBlob, checkScope });
    checkScope();
    const patch = {
      outputText: result.text ?? '',
      outputAssetIds: (result.assets ?? []).map(a => a.id),
      operation: { state: 'completed', tool, at: Date.now(), summary: result.summary ?? '' },
    };
    if (result.tableRows) patch.tableRows = result.tableRows;
    store.updateNodeData(node.id, patch);
    deps.onUpdate?.();
    return { text: result.text ?? '', assets: (result.assets ?? []).map(a => ({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size })) };
  }

  function body(node) {
    const d = node.data ?? {};
    const box = el('div', {});
    box.append(el('div', { class: 'row' }, el('b', { text: TOOLS[d.tool] ?? '未选工具' })));
    if (d.operation?.summary) box.append(el('div', { class: 'hint', text: String(d.operation.summary) }));
    if (d.outputText) box.append(el('pre', { style: 'max-height:90px;overflow:auto;font-size:11px;white-space:pre-wrap', text: String(d.outputText).slice(0, 400) }));
    const first = (d.outputAssetIds ?? []).map(id => store.project.assets[id]).find(a => a?.kind === 'image');
    if (first) deps.assets.objectURL(first.id).then(u => { if (u) box.prepend(el('img', { class: 'preview', src: u, alt: '' })); }).catch(() => {});
    return box;
  }

  const PARAM_FIELDS = {
    text_input: [['text', '文本内容', 'textarea']],
    json_parse: [['path', '提取路径（如 a.b[0].c，空=整体）', 'text'], ['source', '兜底 JSON 文本（空=用连线输入）', 'textarea']],
    index_selector: [['index', '第 N 项（≥1，按连线顺序）', 'number']],
    resource_merge: [],
    grid_split: [['rows', '行数', 'number'], ['cols', '列数', 'number']],
    grid_merge: [['cols', '列数（空=自动）', 'number'], ['padding', '间距 px', 'number'], ['cellWidth', '单元宽 px（空=最大原图）', 'number'], ['cellHeight', '单元高 px', 'number'], ['background', '背景色 #rrggbb', 'text']],
    crop: [['x', '起点 x（px）', 'number'], ['y', '起点 y（px）', 'number'], ['w', '宽（px）', 'number'], ['h', '高（px）', 'number']],
    video_frame_extract: [['at', '时间点（秒）', 'number']],
    shot_extraction: [['mode', '方式', 'select:interval|histogram'], ['count', '帧数（1–25）', 'number']],
    batch_table: [['csv', 'CSV 文本', 'textarea'], ['template', '渲染模板 {{字段}}（空=输出表 JSON）', 'textarea']],
  };

  function inspector(node) {
    const d = node.data ?? {};
    const box = el('div', {});
    const sel = el('select', {}, Object.entries(TOOLS).map(([k, label]) => el('option', { value: k, text: label, selected: k === d.tool })));
    sel.addEventListener('change', () => { store.updateNodeData(node.id, { tool: sel.value }); deps.onUpdate?.(); });
    box.append(el('div', { class: 'kv' }, el('span', { text: '工具' }), sel));
    const { texts, ins } = gather(node);
    box.append(el('p', { class: 'hint', text: `输入：文本 ×${texts.length}，素材 ×${ins.length}${ins.some(x => x.missing) ? '（含缺失！）' : ''}` }));
    for (const [key, label, kind] of PARAM_FIELDS[d.tool] ?? []) {
      const cur = d.params?.[key];
      let input;
      if (kind === 'textarea') input = el('textarea', { rows: 4, value: cur ?? '' });
      else if (kind.startsWith('select:')) {
        const labels = { interval: '等间隔抽帧', histogram: '直方图切点检测' };
        input = el('select', {}, kind.slice(7).split('|').map(v => el('option', { value: v, text: labels[v] ?? v, selected: String(cur ?? 'interval') === v })));
      } else input = el('input', { type: kind, value: cur ?? '', step: 'any' });
      input.addEventListener('change', () => {
        const params = { ...(node.data.params ?? {}) };
        let v = input.value;
        if (kind === 'number' && v !== '') v = Number(v);
        if (v === '' || (kind === 'number' && !Number.isFinite(v))) delete params[key]; else params[key] = v;
        store.updateNodeData(node.id, { params });
      });
      box.append(el('label', { class: 'field' }, el('span', { text: label }), input));
    }
    const run = el('button', { class: 'primary', type: 'button', text: '执行工具' });
    run.addEventListener('click', async () => {
      run.disabled = true;
      try { const r = await execute(node); toast(`完成：${node.data.operation?.summary ?? 'ok'}（素材 ${r.assets.length}）`, 'ok'); }
      catch (e) { toast(`工具失败：${e.message}`, 'err', 6000); }
      finally { run.disabled = false; deps.onUpdate?.(); }
    });
    box.append(el('div', { class: 'modal-actions' }, run));
    const outs = (d.outputAssetIds ?? []).map(id => store.project.assets[id]).filter(Boolean);
    if (outs.length) box.append(el('div', {}, el('h4', { text: `输出素材（${outs.length}）` }),
      ...outs.map(a => {
        const spawn = el('button', { class: 'mini', type: 'button', text: '＋节点' });
        spawn.addEventListener('click', () => {
          const ref = store.node(node.id);
          store.addNode('asset', (ref?.x ?? 0) + 260, ref?.y ?? 0, { assetId: a.id, title: a.name });
          deps.onUpdate?.();
        });
        return el('div', { class: 'row' }, el('span', { text: `${a.name}（${a.kind}）` }), spawn);
      })));
    if (d.tableRows?.length) box.append(el('pre', { style: 'max-height:140px;overflow:auto;font-size:11px', text: JSON.stringify(d.tableRows.slice(0, 20), null, 2) }));
    return box;
  }

  return { execute, body, inspector };
}
