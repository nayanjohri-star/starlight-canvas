// 时间线媒体引擎：预览合成 + 浏览器内实时渲染导出（“worker”=渲染执行体，主线程串行）。
//  · 预览：canvas 2D 合成（v1 主画面 + ov1 叠加 + s1 字幕），HTMLMediaElement + WebAudio 混音
//  · 导出：canvas.captureStream + MediaRecorder + AudioContext→MediaStreamDestination
//    —— 真实本地视频文件（WebM 默认；浏览器支持时可选 MP4）。录制为实时时长，不是 JSON 伪装。
//  · 安全：仅用本机 blob；时长/像素/片段数上限；AbortSignal 取消即释放元素/URL/音轨。
// 本文件无顶层 DOM 依赖：所有 document/AudioContext 使用都在函数体内，node --test 可导入纯函数。

import {
  TL_LIMITS, TL_DEFAULT_META, laneClips, timelineDuration,
  clipSourceTime, fadeFactor, clipVisualLen,
} from './export-project.js';

// ---------- 纯函数（node 可测） ----------

export function probeRenderSupport() {
  const has = typeof document !== 'undefined'
    && typeof MediaRecorder === 'function'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  const pick = cands => {
    if (!has) return null;
    return cands.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) ?? null;
  };
  return {
    supported: !!has,
    webm: pick(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']),
    mp4: pick(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']),
    audio: typeof AudioContext === 'function' || typeof globalThis.webkitAudioContext === 'function',
  };
}
export const renderMimeLabel = m => !m ? null : m.startsWith('video/mp4') ? 'mp4' : m.startsWith('video/webm') ? 'webm' : 'bin';

// 片段在时间 t 的音量增益（mute/volume × 淡入淡出包络）
export const clipGain = (clip, t) => (clip.muted ? 0 : (clip.volume ?? 1)) * fadeFactor(clip, t);

// 需要在该时刻播放的媒体片段（v1 取最上层一个；a1/a2 全部）
export function audioClipsAt(clips, t) {
  return clips.filter(c =>
    (c.track === 'a1' || c.track === 'a2' || c.track === 'v1') &&
    (c.kind === 'video' || c.kind === 'audio') &&
    t >= c.start && t < c.end);
}
export function videoClipAt(clips, t) {
  const lane = laneClips(clips, 'v1').filter(c => t >= c.start && t < c.end);
  return lane.at(-1) ?? null;
}

// 探测本地 blob 媒体信息（时长/画面尺寸）。超时/失败返回 null——不阻塞剪辑操作。
export function probeBlobAsset(blob, timeoutMs = 6000) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const done = v => { URL.revokeObjectURL(url); resolve(v); };
    const to = setTimeout(() => done(null), timeoutMs);
    const kind = blob.type.startsWith('image/') ? 'image' : blob.type.startsWith('audio/') ? 'audio' : 'video';
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => { clearTimeout(to); done({ kind, duration: null, width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(to); done(null); };
      img.src = url;
      return;
    }
    const el = document.createElement(kind);
    el.preload = 'metadata';
    el.onloadedmetadata = () => { clearTimeout(to); done({ kind, duration: Number.isFinite(el.duration) ? el.duration : null, width: el.videoWidth || 0, height: el.videoHeight || 0 }); };
    el.onerror = () => { clearTimeout(to); done(null); };
    el.src = url;
  });
}

// ---------- 引擎 ----------

export function createTimelineEngine({ blobOf, maxDuration = TL_LIMITS.maxDuration, maxPixels = 1920 * 1920 } = {}) {
  const media = new Map();   // clipId → {clip, kind, el, img, gain, src, ready, broken, url, duration}
  let actx = null, master = null, streamDest = null, disposed = false;
  let loadGen = 0;           // 代际令牌：旧 load 在新 load/dispose 之后不得再放回媒体或建 AudioContext
  const urls = new Set();
  const clock = () => actx ? actx.currentTime : performance.now() / 1000;
  const AC = () => (typeof AudioContext === 'function' ? AudioContext : globalThis.webkitAudioContext);

  async function ensureAudio() {
    if (disposed || actx || !AC()) return actx;
    actx = new (AC())();
    master = actx.createGain();
    master.gain.value = 1;
    master.connect(actx.destination);
    return actx;
  }
  function renderSink() {
    if (!streamDest && actx) { streamDest = actx.createMediaStreamDestination(); master.connect(streamDest); }
    return streamDest;
  }

  // 可取消超时：竞速落定即清定时器——成功路径不残留 10–15s 计时器
  const timeout = ms => {
    let id = 0;
    const p = new Promise((_, rej) => { id = setTimeout(() => rej(new Error('媒体加载超时')), ms); });
    return { p, cancel: () => clearTimeout(id) };
  };

  // 单条媒体记录完整回收：停播 → 断开 WebAudio → 卸载元素 → 回收 blob URL。
  // 只回收本记录自建资源；素材文件本体（blob:<assetId>）不归引擎管——删片段绝不动共享素材。
  function dropRec(rec) {
    try { if (rec.el && !rec.el.paused) rec.el.pause(); } catch {}
    try { rec.src?.disconnect(); rec.gain?.disconnect(); } catch {}
    if (rec.el) { try { rec.el.removeAttribute('src'); rec.el.load(); } catch {} }
    if (rec.url) { try { URL.revokeObjectURL(rec.url); } catch {} urls.delete(rec.url); }
    rec.el = null; rec.img = null; rec.src = null; rec.gain = null; rec.url = null; rec.ready = false;
  }

  // 为媒体片段建立元素/图源。可在时间线变更后重复调用（增量，按 clip.id 复用）；
  // 本次清单外的旧记录立即停播/断连/回收——删除片段不再发声（TL-1）；
  // 在途加载的每个落点都过「代际仍活 || 记录已被更新的 load 收养」+ 未 dispose 闸——
  // 被剪掉/dispose 的在途加载立即回收自建资源，不放回媒体、不建 AudioContext（TL-3）。
  async function load(clips) {
    if (disposed) return;
    const gen = ++loadGen;
    const live = () => !disposed && gen === loadGen;
    const needed = clips.filter(c => (c.kind === 'video' || c.kind === 'audio' || c.kind === 'image') && c.assetId && !c.missing);
    const neededIds = new Set(needed.map(c => c.id));
    for (const [id, rec] of [...media]) {
      if (!neededIds.has(id)) { dropRec(rec); media.delete(id); }
    }
    const dropIfStale = (rec, id) => {
      // media.get(id)===rec：记录仍被跟踪（含被新代际收养的复用记录——其装载必须继续完成）
      if (!disposed && (live() || media.get(id) === rec)) return false;
      dropRec(rec);
      return true;
    };
    await Promise.all(needed.map(async c => {
      const exist = media.get(c.id);
      if (exist) { exist.clip = c; exist.gen = gen; return; }   // 复用即收养到本代际
      const rec = { clip: c, kind: c.kind, el: null, img: null, gain: null, src: null, ready: false, broken: false, url: null, duration: null, omitted: false, gen };
      media.set(c.id, rec);
      try {
        const blob = await blobOf(c.assetId);
        if (dropIfStale(rec, c.id)) return;
        if (!blob || !blob.size) { rec.broken = true; return; }
        const url = URL.createObjectURL(blob);
        rec.url = url; urls.add(url);
        if (c.kind === 'image') {
          const img = new Image();
          img.src = url;
          const to = timeout(10000);
          try { await Promise.race([img.decode(), to.p]); } finally { to.cancel(); }
          if (dropIfStale(rec, c.id)) return;
          rec.img = img; rec.ready = true;
          return;
        }
        const el = document.createElement(c.kind === 'audio' ? 'audio' : 'video');
        el.preload = 'auto'; el.playsInline = true; el.muted = false; el.volume = 1;
        // 变速不变调：与服务端 atempo 链同语义（preservesPitch 默认多为 true，显式声明防歧义）
        el.preservesPitch = true;
        if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
        if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
        el.src = url;
        const to = timeout(15000);
        try {
          await Promise.race([
            new Promise((res, rej) => {
              el.addEventListener('loadeddata', res, { once: true });
              el.addEventListener('error', () => rej(new Error('媒体解码失败')), { once: true });
            }),
            to.p,
          ]);
        } finally { to.cancel(); }
        if (dropIfStale(rec, c.id)) return;
        rec.el = el; rec.ready = true;
        if (Number.isFinite(el.duration) && el.duration > 0) {
          rec.duration = el.duration;
          if (!Number.isFinite(c.sourceDuration)) c.sourceDuration = el.duration;
        }
        if (AC()) {
          try {
            await ensureAudio();
            if (dropIfStale(rec, c.id) || !actx) return;
            const gain = actx.createGain();
            gain.gain.value = 0;
            const src = actx.createMediaElementSource(el);
            src.connect(gain).connect(master);
            rec.src = src; rec.gain = gain;   // 全部成功才算启用 WebAudio 通路
          } catch { try { rec.src?.disconnect(); rec.gain?.disconnect(); } catch {} rec.src = null; rec.gain = null; }
        }
      } catch {
        if (dropIfStale(rec, c.id)) return;
        rec.broken = true;
      }
    }));
  }

  // 把源内容按“contain”画进 W×H 或指定 rect
  function drawContain(g, source, sw, sh, W, H, alpha) {
    if (!sw || !sh) return;
    const s = Math.min(W / sw, H / sh);
    const dw = sw * s, dh = sh * s;
    g.save();
    g.globalAlpha = alpha;
    g.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
    g.restore();
  }
  function missingBox(g, W, H, label = '素材缺失') {
    g.save();
    g.fillStyle = '#14171c'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#3a4150'; g.setLineDash([8, 6]); g.strokeRect(8, 8, W - 16, H - 16);
    g.fillStyle = '#9aa3b2'; g.font = `${Math.round(H * 0.045)}px sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, W / 2, H / 2);
    g.restore();
  }
  function drawTextBlock(g, text, rect, meta, { fontSize = 0.06, color = '#ffffff', align = 'center', alpha = 1, baseline = 'middle', bar = false } = {}) {
    const W = meta.width, H = meta.height;
    const px = Math.max(12, Math.round((fontSize || 0.06) * H));
    const lines = String(text ?? '').split('\n').slice(0, 12);
    const x = (rect.x + (align === 'center' ? rect.w / 2 : align === 'right' ? rect.w : 0)) * W;
    const lh = px * 1.35;
    const cy = (rect.y + rect.h / 2) * H;
    const y0 = cy - lh * (lines.length - 1) / 2;
    g.save();
    g.globalAlpha = alpha;
    g.font = `${px}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    g.textAlign = align; g.textBaseline = baseline;
    if (bar) {
      const wmax = Math.max(...lines.map(l => g.measureText(l).width), 1);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      const pad = px * 0.4;
      g.fillRect(x - (align === 'center' ? wmax / 2 : align === 'right' ? wmax : 0) - pad, y0 - lh / 2 - pad * 0.6, wmax + pad * 2, lh * lines.length + pad * 0.8);
    }
    g.fillStyle = color;
    g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = Math.max(2, px * 0.12);
    lines.forEach((l, i) => g.fillText(l, x, y0 + i * lh));
    g.restore();
  }

  // 合成单帧到 canvas 2D 上下文（g 尺寸 = 输出尺寸）。
  // omitMissingMedia：导出省略模式——缺失/损坏/被确认省略的媒体不画占位框（露出底色），
  // 与「确认省略缺失素材」及服务端 fileOf 跳过语义一致；预览不传此旗标，仍显示醒目占位。
  function draw(g, t, clips, meta = TL_DEFAULT_META, { omitMissingMedia = false } = {}) {
    const W = meta.width, H = meta.height;
    g.fillStyle = meta.background ?? '#000000';
    g.fillRect(0, 0, W, H);
    const v = videoClipAt(clips, t);
    if (v) {
      const rec = media.get(v.id);
      const alpha = fadeFactor(v, t);
      if (rec?.broken || rec?.omitted || v.missing) { if (!omitMissingMedia) missingBox(g, W, H); }
      else if (rec?.img) drawContain(g, rec.img, rec.img.naturalWidth, rec.img.naturalHeight, W, H, alpha);
      else if (rec?.el && rec.el.readyState >= 2) drawContain(g, rec.el, rec.el.videoWidth, rec.el.videoHeight, W, H, alpha);
      else if (!omitMissingMedia) missingBox(g, W, H, '加载中…');
    }
    for (const c of laneClips(clips, 'ov1')) {
      if (t < c.start || t >= c.end) continue;
      const alpha = fadeFactor(c, t);
      const rect = { x: c.x ?? 0.1, y: c.y ?? 0.62, w: c.w ?? 0.8, h: c.h ?? 0.3 };
      if (c.kind === 'text') {
        drawTextBlock(g, c.text, rect, meta, { fontSize: c.fontSize, color: c.color, align: c.align, alpha });
      } else {
        const rec = media.get(c.id);
        if (rec?.img && !rec.omitted) {
          const rx = rect.x * W, ry = rect.y * H, rw = rect.w * W, rh = rect.h * H;
          const s = Math.min(rw / rec.img.naturalWidth, rh / rec.img.naturalHeight);
          const dw = rec.img.naturalWidth * s, dh = rec.img.naturalHeight * s;
          g.save(); g.globalAlpha = alpha;
          g.drawImage(rec.img, rx + (rw - dw) / 2, ry + (rh - dh) / 2, dw, dh);
          g.restore();
        }
      }
    }
    const sub = laneClips(clips, 's1').find(c => t >= c.start && t < c.end);
    if (sub?.text) drawTextBlock(g, sub.text, { x: 0.05, y: 0.84, w: 0.9, h: 0.12 }, meta, { fontSize: 0.05, bar: true, baseline: 'middle' });
    return t;
  }

  // 同步元素播放态与增益到时间 t（playing=false 时只对齐 currentTime）
  function sync(t, clips, playing) {
    for (const rec of media.values()) {
      const el = rec.el;
      if (!el) continue;
      const c = rec.clip;
      const active = t >= c.start && t < c.end && !rec.broken && !rec.omitted;
      if (!active) {
        if (!el.paused) el.pause();
        if (rec.gain) rec.gain.gain.value = 0; else el.volume = 0;
        continue;
      }
      const target = clipSourceTime(c, t);
      if (playing) {
        el.playbackRate = c.speed || 1;
        if (el.paused) { try { el.currentTime = Math.min(target, Math.max(0, (rec.duration ?? Infinity) - 0.05)); } catch {} el.play().catch(() => {}); }
        else if (Math.abs(el.currentTime - target) > 0.3) { try { el.currentTime = target; } catch {} }
      } else if (Math.abs(el.currentTime - target) > 0.05) {
        try { el.currentTime = Math.min(target, Math.max(0, (rec.duration ?? Infinity) - 0.05)); } catch {}
      }
      const g = clipGain(c, t);
      if (rec.gain) rec.gain.gain.value = g;
      else { el.volume = Math.min(1, g); el.muted = g <= 0; }
    }
  }
  function pauseAll() {
    for (const rec of media.values()) {
      if (rec.el && !rec.el.paused) rec.el.pause();
      if (rec.gain) rec.gain.gain.value = 0;
    }
  }

  function release() {
    pauseAll();
    for (const rec of media.values()) dropRec(rec);
    media.clear();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    loadGen++;            // 在途 load 立即失代际：恢复后走 dropIfStale 回收，不重建资源
    release();
    for (const u of urls) { try { URL.revokeObjectURL(u); } catch {} }
    urls.clear();
    try { streamDest?.disconnect(); } catch {}
    try { master?.disconnect(); } catch {}
    actx?.close?.().catch(() => {});
    actx = null; master = null; streamDest = null;
  }

  // 浏览器实时渲染导出：MediaRecorder 录制 canvas 流 + WebAudio 混音流。
  // 时长=时间线时长（实时）；支持取消；产物为真实 WebM/MP4（视浏览器能力）。
  // allowMissing：调用方显式确认后才省略损坏/缺失媒体；默认遇坏即中止，绝不产出“看似成功”的残缺成片。
  async function render({ clips, meta = TL_DEFAULT_META, mime, onProgress, signal, allowMissing = false, omitClipIds } = {}) {
    if (typeof document === 'undefined') throw new Error('浏览器渲染需要 DOM 环境');
    const sup = probeRenderSupport();
    if (!sup.supported) throw new Error('当前浏览器不支持 canvas.captureStream + MediaRecorder，无法本地导出');
    const picked = mime ?? sup.webm ?? sup.mp4;
    if (!picked) throw new Error('当前浏览器不支持导出 WebM/MP4 容器');
    const W = meta.width, H = meta.height;
    if (W * H > maxPixels || W < 16 || H < 16) throw new Error('输出尺寸超限');
    const dur = timelineDuration(clips);
    if (!(dur > 0)) throw new Error('时间线为空，无内容可渲染');
    if (dur > maxDuration) throw new Error(`时间线超过 ${maxDuration} 秒上限`);
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    await load(clips);
    if (disposed) throw new Error('渲染引擎已释放');
    // 损坏/缺失媒体不得静默导出：默认中止；仅调用方显式确认省略（allowMissing）才继续。
    // omitClipIds：调用方确认省略清单（与服务端 buildRenderJob 的 omitted 对齐）——
    // 即便本机可解码，被确认省略的片段也不进成片：两条导出路径语义一致（TL-2）。
    const omitIds = new Set(omitClipIds ?? []);
    const broken = clips.filter(c => ['video', 'audio', 'image'].includes(c.kind) && c.assetId)
      .filter(c => omitIds.has(c.id) || c.missing || ((r) => !r || r.broken || !r.ready)(media.get(c.id)));
    if (broken.length && !allowMissing)
      throw new Error(`媒体加载失败，已中止导出：${broken.map(c => c.name || c.id).slice(0, 6).join('、')}（共 ${broken.length} 项）`);
    const omittedIds = new Set(broken.map(c => c.id));
    // 全部被省略时与服务端「没有任何可渲染内容」一致明确失败，不产空白片
    if (omittedIds.size && !clips.some(c => !omittedIds.has(c.id)))
      throw new Error('所有片段素材缺失/不可用或被确认省略，没有可渲染内容');
    for (const [id, rec] of media) rec.omitted = omittedIds.has(id);
    await ensureAudio();
    try { await actx?.resume(); } catch {}

    // 按目标帧率显式出帧：captureStream(0) + requestFrame()，每个 1/fps 间隔至多一帧。
    // 自动捕获（captureStream(fps)）会在每次 rAF 重绘时出帧，间隔不均，解码端按推断帧率取整时会出现重复时间戳。
    const fps = meta.fps ?? 30;
    const vstream = canvas.captureStream(0);
    const vtrack = vstream.getVideoTracks()[0];
    const paced = typeof vtrack?.requestFrame === 'function';
    if (!paced) { vtrack?.stop(); }
    const source = paced ? vstream : canvas.captureStream(fps);
    let tracks = [...source.getVideoTracks()];
    if (actx) tracks = tracks.concat(renderSink().stream.getAudioTracks());
    const combined = new MediaStream(tracks);
    const recorder = new MediaRecorder(combined, { mimeType: picked, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise((res, rej) => {
      recorder.onstop = res;
      recorder.onerror = () => rej(recorder.error ?? new Error('录制失败'));
    });

    let aborted = false;
    const onAbort = () => { aborted = true; };
    signal?.addEventListener('abort', onAbort, { once: true });
    stopped.catch(() => {});   // start 抛错等早退路径不产生未处理拒绝
    onProgress?.({ t: 0, ratio: 0, phase: 'render' });
    try {
      recorder.start(250);
      // MediaRecorder timestamps use elapsed wall time. An audio device can
      // start late or advance its clock in blocks, so it must not lengthen or
      // shorten the exported timeline while the recorder is already running.
      const t0 = performance.now() / 1000;
      const frameSec = 1 / fps;
      let nextFrame = 0;
      await new Promise(resolve => {
        const step = () => {
          if (aborted || disposed) return resolve();
          const t = performance.now() / 1000 - t0;
          if (t >= dur) return resolve();
          sync(t, clips, true);
          draw(g, t, clips, meta, { omitMissingMedia: allowMissing });
          // AudioContext advances in blocks, so two close animation callbacks
          // can appear a whole frame apart on the audio clock. Pace capture by
          // wall time after drawing, using the same time base as the recorder.
          const captureTime = performance.now() / 1000;
          if (paced && captureTime >= nextFrame) { vtrack.requestFrame(); nextFrame = captureTime + frameSec * 0.9; }
          onProgress?.({ t, ratio: Math.min(1, t / dur), phase: 'render' });
          requestAnimationFrame(step);
        };
        step();
      });
      pauseAll();
      try { recorder.state !== 'inactive' && recorder.stop(); } catch {}
      await stopped;
    } finally {
      // 任何路径都回收取消监听与媒体轨，不泄漏
      signal?.removeEventListener('abort', onAbort);
      combined.getTracks().forEach(tr => { try { tr.stop(); } catch {} });
    }
    if (aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    const type = picked.split(';')[0];
    const blob = new Blob(chunks, { type });
    if (!blob.size) throw new Error('录制结果为空');
    const warnings = broken.map(c => `按确认省略片段「${c.name || c.id}」（素材缺失/不可用，时段保留为背景）`);
    return { blob, mime: type, ext: renderMimeLabel(picked), seconds: dur, width: W, height: H, via: 'browser', warnings };
  }

  return { load, draw, sync, pauseAll, dispose, release, render, clock,
    get audioContext() { return actx; }, mediaOf: id => media.get(id) };
}
