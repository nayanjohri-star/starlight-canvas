// 素材库面板：检索/筛选（类型/分类/合集/收藏/标签/文本）、预览、复用为素材节点、
// 校验重绑、引用扫描后删除、合集管理；内置非破坏性图片编辑（裁切/翻转/旋转/
// 文字图层 → 导出为新素材，原图不动）。AI 修图未接入：按钮禁用并说明原因。

import { el, modal, toast, confirmDialog, fmtBytes, fmtTime } from './ui.js';
import { ASSET_CATEGORIES, KIND_LABEL } from './assets.js';
import { IMAGE_DECODE_MAX_SIDE, IMAGE_DECODE_MAX_PIXELS } from './capabilities.js';
import { openAssetReuse } from './asset-reuse.js';

// 「＋节点」落点必须在当前视口内：优先 deps.spawnPos()，其次 board.toWorld（含 scale），
// 再次按 view 平移/缩放把固定屏幕偏移换算成世界坐标——绝不 Math.random 到视口外。
export function assetSpawnPos(deps) {
  const ok = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (typeof deps?.spawnPos === 'function') {
    const p = deps.spawnPos();
    if (ok(p)) return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  const view = deps?.board?.view;
  if (typeof deps?.board?.toWorld === 'function') {
    try {
      const p = deps.board.toWorld({ clientX: 200, clientY: 160 });
      if (ok(p)) return { x: Math.round(p.x), y: Math.round(p.y) };
    } catch { /* 退回 view 换算 */ }
  }
  const s = view?.scale > 0 ? view.scale : 1;
  return view && Number.isFinite(view.x) && Number.isFinite(view.y)
    ? { x: Math.round((200 - view.x) / s), y: Math.round((160 - view.y) / s) }
    : { x: 80, y: 80 };
}

export function createLibrary(deps) {
  const { store, assets } = deps;
  let dlg = null, content = null, countEl = null;
  let editDialog = null;
  store.onChange?.(event => { if (event?.type === 'project') { editDialog?.close(); dlg?.close(); } });
  const filter = { text: '', kind: '', category: '', collectionId: '', favorite: false };
  const canDOM = () => typeof document === 'object' && !!document.getElementById?.('overlay-root');
  const btn = (t, fn, cls = 'mini') => { const b = el('button', { class: cls, type: 'button', text: t }); b.addEventListener('click', fn); return b; };
  const selOf = (opts, cur, on) => { const s = el('select', {}, opts.map(([v, l]) => el('option', { value: v, text: l, selected: v === cur }))); s.addEventListener('change', () => on(s.value)); return s; };
  const pickFiles = (fn, multiple = true) => { const inp = el('input', { type: 'file', multiple }); inp.addEventListener('change', () => { if (inp.files?.length) fn([...inp.files]); }); inp.click(); };
  const askText = (title, label, value = '') => new Promise(res => {
    const input = el('input', { type: 'text', value });
    const ok = btn('确定', () => { res(input.value); m.close(); }, 'primary');
    const m = modal(el('div', {}, el('h3', { text: title }),
      el('label', { class: 'field' }, el('span', { text: label }), input),
      el('div', { class: 'modal-actions' }, ok)), { onClose: () => res(null) });
  });

  const hasFilter = () => !!(filter.text || filter.kind || filter.category || filter.collectionId || filter.favorite);
  const addAssetFiles = () => pickFiles(async fs => {
    try { await assets.addFiles(fs); } catch (e) { toast(`素材入库失败：${e.message}`, 'err', 6000); }
    renderGrid();
  });

  function open() {
    if (!canDOM()) return null;
    if (dlg) { render(); return dlg; }
    content = el('div', { class: 'lib' });
    dlg = modal(content, { wide: true, onClose: () => { dlg = null; content = null; } });
    render(); return dlg;
  }

  function render() {
    if (!content || !canDOM()) return;
    const cols = assets.listCollections();
    const side = el('div', { class: 'lib-side' },
      el('div', { class: 'lib-side-head' },
        el('span', { class: 'lib-side-title', text: '合集' }),
        btn('＋新建', async () => { const n = await askText('新建合集', '名称'); if (n) { assets.createCollection(n); render(); } })),
      el('div', { class: `lib-col ${filter.collectionId === '' ? 'on' : ''}`, onclick: () => { filter.collectionId = ''; render(); } },
        el('span', { class: 'lib-col-name', text: '全部' })),
      ...cols.map(c => el('div', { class: `lib-col ${filter.collectionId === c.id ? 'on' : ''}` },
        el('span', { class: 'lib-col-name', text: `${c.name}（${c.assetIds.length}）`, title: c.name, onclick: () => { filter.collectionId = c.id; render(); } }),
        el('span', { class: 'lib-col-acts' },
          btn('改名', async () => { const n = await askText('合集改名', '名称', c.name); if (n) { assets.renameCollection(c.id, n); render(); } }),
          btn('删', async () => {
            if (await confirmDialog('删除合集', el('p', { text: `删除合集「${c.name}」？素材保留。` }))) {
              assets.deleteCollection(c.id);
              if (filter.collectionId === c.id) filter.collectionId = '';
              render();
            }
          })))));
    const search = el('input', { type: 'search', class: 'lib-search', placeholder: '搜索名称/标签/MIME', value: filter.text });
    search.addEventListener('input', () => { filter.text = search.value; renderGrid(); });
    const kindSel = selOf([['', '全部类型'], ...Object.entries(KIND_LABEL).map(([v, l]) => [v, l])], filter.kind, v => { filter.kind = v; renderGrid(); });
    const catSel = selOf([['', '全部分类'], ...Object.entries(ASSET_CATEGORIES).map(([v, l]) => [v, l])], filter.category, v => { filter.category = v; renderGrid(); });
    const favBtn = btn(filter.favorite ? '★ 仅收藏' : '☆ 收藏', () => { filter.favorite = !filter.favorite; render(); }, 'mini lib-fav-toggle');
    favBtn.setAttribute('aria-pressed', filter.favorite ? 'true' : 'false');
    const addBtn = btn('添加文件', addAssetFiles, 'primary');
    const reuseBtn = btn('复用到分镜', () => openAssetReuse(deps, {}));
    reuseBtn.title = '把素材按引用关联到分镜（不复制文件、不生成节点）';
    const grid = el('div', { class: 'lib-grid' });
    countEl = el('span', { class: 'lib-count' });
    content.replaceChildren(
      el('div', { class: 'lib-head' },
        el('div', { class: 'lib-titles' },
          el('h3', { class: 'lib-title', text: '素材库' }),
          countEl),
        el('div', { class: 'lib-head-actions' }, reuseBtn, addBtn)),
      el('div', { class: 'row lib-bar' },
        el('div', { class: 'lib-bar-group lib-bar-search' }, search),
        el('div', { class: 'lib-bar-group' }, kindSel, catSel, favBtn)),
      el('div', { class: 'lib-main' }, side, grid));
    renderGrid();
  }

  function renderGrid() {
    const grid = content?.querySelector('.lib-grid'); if (!grid) return;
    const items = assets.queryAssets(filter);
    grid.replaceChildren(...items.map(card));
    updateCount(items.length);
    if (items.length) return;
    grid.append(hasFilter()
      ? el('div', { class: 'lib-empty' },
          el('p', { class: 'lib-empty-title', text: '无匹配素材' }),
          el('p', { class: 'hint', text: '当前搜索或筛选条件下没有素材。' }),
          btn('清除筛选', () => {
            filter.text = ''; filter.kind = ''; filter.category = ''; filter.collectionId = ''; filter.favorite = false;
            render();
          }))
      : el('div', { class: 'lib-empty' },
          el('p', { class: 'lib-empty-title', text: '素材库为空' }),
          el('p', { class: 'hint', text: '添加图片、视频或音频后，可在此预览、生成画布节点或整理到合集。' }),
          btn('添加文件', addAssetFiles, 'primary')));
  }

  function updateCount(shown) {
    if (!countEl) return;
    let total = shown;
    if (hasFilter()) {
      try { total = assets.queryAssets({ text: '', kind: '', category: '', collectionId: '', favorite: false }).length; }
      catch { total = shown; }
    }
    countEl.textContent = hasFilter() ? `筛选 ${shown} / 共 ${total} 个素材` : `共 ${shown} 个素材`;
  }

  function card(a) {
    const box = el('div', { class: 'lib-card', 'data-asset': a.id });
    const pv = el('div', { class: 'lib-pv' });
    if (a.missing) pv.append(el('span', { class: 'badge err', text: '缺文件' }));
    else if (a.kind === 'image') assets.objectURL(a.id).then(u => { if (u) pv.append(el('img', { src: u, alt: a.name })); }).catch(() => {});
    else pv.append(el('span', { class: 'badge', text: KIND_LABEL[a.kind] ?? a.kind }));
    const fav = btn(a.favorite ? '★' : '☆', () => { assets.setFavorite(a.id, !a.favorite); renderGrid(); }, 'mini lib-fav');
    fav.setAttribute('aria-pressed', a.favorite ? 'true' : 'false');
    fav.title = a.favorite ? '取消收藏' : '收藏';
    const cat = selOf(Object.entries(ASSET_CATEGORIES).map(([v, l]) => [v, l]), a.category ?? 'other', v => { assets.setCategory(a.id, v); });
    cat.title = '分类';
    const colSel = selOf([['', '（无合集）'], ...assets.listCollections().map(c => [c.id, c.name])],
      assets.collectionOf(a.id)?.id ?? '', v => { assets.setAssetCollection(a.id, v || null); });
    colSel.title = '所属合集';
    const tagLine = el('div', { class: 'lib-tags' },
      ...assets.tagList(a).map(t => el('span', { class: 'chip', text: t, title: `筛选「${t}」`, onclick: () => { filter.text = t; render(); } })),
      btn('＋标签', async () => { const s = await askText('编辑标签', '逗号分隔', a.tags ?? ''); if (s != null) { assets.setTags(a.id, s); renderGrid(); } }));
    const reuseShotBtn = btn('→分镜', () => openAssetReuse(deps, { assetIds: [a.id] }), 'mini lib-act-reuse');
    reuseShotBtn.title = '把该素材按引用关联到分镜';
    const acts = el('div', { class: 'row actions lib-acts' },
      btn('预览', () => preview(a)),
      btn('＋节点', () => {
        try {
          const p = assetSpawnPos(deps);
          store.addNode('asset', p.x, p.y, { assetId: a.id, title: a.name });
          toast('已生成素材节点');
        } catch (e) { toast(`生成素材节点失败：${e.message}`, 'err'); }
      }, 'mini lib-act-main'),
      reuseShotBtn,
      a.kind === 'image' && !a.missing ? btn('编辑', () => openEditor(a)) : null,
      btn('重绑', () => pickFiles(async fs => {
        try { if (await assets.rebindFile(a.id, fs[0])) { toast('已重绑'); renderGrid(); } }
        catch (e) { toast(`重绑失败：${e.message}`, 'err', 6000); }
      }, false)),
      btn('导出', async () => {
        try {
          const u = await assets.objectURL(a.id);
          if (!u) { toast('本地文件缺失，无法导出', 'err'); return; }
          el('a', { href: u, download: a.name, rel: 'noopener' }).click();
        } catch (e) { toast(`导出失败：${e.message}`, 'err', 6000); }
      }),
      btn('删除', async () => {
        try {
          const refs = await assets.assetRefs(a.id);
          if (refs.length) {
            const ok = await confirmDialog('素材仍被引用', el('div', {},
              el('p', { text: `「${a.name}」被 ${refs.length} 处引用：` }),
              el('pre', { class: 'lib-ref-list', text: refs.map(r => `· ${r.type} ${r.title ?? r.id}`).join('\n') }),
              el('p', { text: '强制删除将断开这些引用（素材节点标记缺失）。' })));
            if (!ok) return;
            await assets.removeAsset(a.id, { force: true });
          } else {
            if (!(await confirmDialog('删除素材', el('p', { text: `删除「${a.name}」？本地文件一并移除。` })))) return;
            await assets.removeAsset(a.id);
          }
          renderGrid();
        } catch (e) { toast(`删除失败：${e.message}`, 'err', 6000); }
      }, 'mini danger'));
    box.append(pv, el('b', { class: 'lib-name', text: a.name, title: a.name }),
      el('small', { class: 'lib-meta', text: `${KIND_LABEL[a.kind] ?? a.kind} · ${fmtBytes(a.size)}` }),
      el('div', { class: 'row lib-flags' }, fav, cat), colSel, tagLine, acts);
    return box;
  }

  async function preview(a) {
    return assets.preview(a.id);
  }

  // 非破坏性图片编辑：裁切/翻转/旋转/文字图层 → 导出为新素材（原图不改）
  async function openEditor(a) {
    const project = store.project;
    const current = () => store.project === project && project.assets[a.id] === a;
    const url = await assets.objectURL(a.id);
    if (!current()) return;
    if (!url) { toast('本地文件缺失，无法编辑', 'err'); return; }
    let img;
    try { img = await new Promise((res, rej) => { const i = new Image(); const timer = setTimeout(() => rej(new Error('图片解码超时')), 15000); i.onload = () => { clearTimeout(timer); res(i); }; i.onerror = () => { clearTimeout(timer); rej(new Error('图片解码失败')); }; i.src = url; }); }
    catch (e) { toast(e.message, 'err'); return; }
    if (!current()) return;
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth > IMAGE_DECODE_MAX_SIDE || img.naturalHeight > IMAGE_DECODE_MAX_SIDE || img.naturalWidth * img.naturalHeight > IMAGE_DECODE_MAX_PIXELS) { toast('图片尺寸过大，无法在本地编辑', 'err'); return; }
    let closed = false;
    const ops = { crop: null, flipH: false, flipV: false, rot: 0, texts: [] };
    const stage = el('div', { class: 'lib-edit-stage' });
    const renderStage = () => {
      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
      if (ops.crop) ({ x: sx, y: sy, w: sw, h: sh } = ops.crop);
      const rot = ((ops.rot % 360) + 360) % 360;
      const W = rot % 180 ? sh : sw, H = rot % 180 ? sw : sh;
      const cv = el('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(rot * Math.PI / 180); ctx.scale(ops.flipH ? -1 : 1, ops.flipV ? -1 : 1);
      ctx.drawImage(img, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh); ctx.restore();
      for (const t of ops.texts) {
        ctx.font = `${t.size}px sans-serif`; ctx.fillStyle = t.color; ctx.textBaseline = 'top';
        ctx.fillText(t.text, t.x / 100 * W, t.y / 100 * H);
      }
      stage.replaceChildren(cv); stage._final = cv;
    };
    const num = ph => el('input', { type: 'number', class: 'lib-crop-num', placeholder: ph });
    const cx = num('x'), cy = num('y'), cw = num('宽'), ch = num('高');
    const applyCrop = () => {
      const x = +cx.value || 0, y = +cy.value || 0, w = +cw.value || 0, h = +ch.value || 0;
      if (w < 8 || h < 8 || x < 0 || y < 0 || x + w > img.naturalWidth || y + h > img.naturalHeight) { toast('裁切参数越界', 'err'); return; }
      ops.crop = { x, y, w, h }; renderStage();
    };
    const txt = el('input', { type: 'text', placeholder: '文字内容' });
    const tsize = el('input', { type: 'number', value: 32, min: 8, max: 400, title: '字号' });
    const tcolor = el('input', { type: 'color', value: '#ffffff', title: '颜色' });
    const tx = el('input', { type: 'number', value: 5, min: 0, max: 100, title: 'x%' });
    const ty = el('input', { type: 'number', value: 5, min: 0, max: 100, title: 'y%' });
    const textList = el('div', { class: 'lib-text-list' });
    const refreshTexts = () => textList.replaceChildren(...ops.texts.map((t, i) =>
      el('div', { class: 'row' }, el('span', { text: `${t.text}（${t.x}%,${t.y}% ${t.size}px）` }),
        btn('删', () => { ops.texts.splice(i, 1); refreshTexts(); renderStage(); }))));
    const exportBtn = btn('导出为新素材', async () => {
      if (closed || !current() || exportBtn.disabled) return;
      exportBtn.disabled = true;
      try {
        const b = await new Promise(res => stage._final.toBlob(res, 'image/png'));
        if (closed || !current()) return;
        if (!b) throw new Error('导出失败');
        const rec = await assets.registerBlob(b, `${a.name.replace(/\.[a-z0-9]+$/i, '')}-编辑.png`, 'image', { category: a.category, tags: a.tags });
        if (!current()) return;
        await store.flush();
        toast(`已生成新素材「${rec.name}」（原图未修改）`, 'ok');
        ed.close(); render();
      } catch (e) { toast(e.message, 'err'); }
      finally { exportBtn.disabled = false; }
    }, 'primary');
    const ed = modal(el('div', { class: 'lib-editor' },
      el('h3', { text: `编辑图片：${a.name}（非破坏性，导出为新素材）` }),
      stage,
      el('div', { class: 'lib-edit-sec' },
        el('div', { class: 'lib-edit-sec-title', text: '裁切（像素，基于原图）' }),
        el('div', { class: 'row lib-crop' }, cx, cy, cw, ch, btn('应用裁切', applyCrop), btn('清除裁切', () => { ops.crop = null; renderStage(); }))),
      el('div', { class: 'lib-edit-sec' },
        el('div', { class: 'lib-edit-sec-title', text: '变换' }),
        el('div', { class: 'row' },
          btn('左右翻转', () => { ops.flipH = !ops.flipH; renderStage(); }),
          btn('上下翻转', () => { ops.flipV = !ops.flipV; renderStage(); }),
          btn('旋转 90°', () => { ops.rot = (ops.rot + 90) % 360; renderStage(); }))),
      el('div', { class: 'lib-edit-sec' },
        el('div', { class: 'lib-edit-sec-title', text: '文字图层（位置为画面百分比）' }),
        el('div', { class: 'row lib-text-add' }, txt, tsize, tcolor, tx, ty,
          btn('添加文字层', () => {
            if (!txt.value.trim()) { toast('文字为空', 'warn'); return; }
            if (ops.texts.length >= 100) { toast('文字层最多 100 个', 'warn'); return; }
            ops.texts.push({ text: txt.value.slice(0, 4000), size: Math.min(400, Math.max(8, +tsize.value || 32)), color: tcolor.value, x: Math.min(100, Math.max(0, +tx.value || 0)), y: Math.min(100, Math.max(0, +ty.value || 0)) });
            txt.value = ''; refreshTexts(); renderStage();
          })),
        textList),
      el('p', { class: 'hint', text: '需要 AI 修改画面时，将图片连到生图节点的参考输入，再填写修改要求。' }),
      el('div', { class: 'modal-actions' }, exportBtn)), { wide: true, onClose: () => { closed = true; editDialog = null; } });
    editDialog = ed;
    refreshTexts(); renderStage();
  }

  return { open };
}
