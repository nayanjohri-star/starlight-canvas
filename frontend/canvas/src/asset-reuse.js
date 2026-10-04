// 素材复用：把素材库素材按稳定 assetId 追加/替换到多个分镜的 shot.assetIds（权威数据）。
// previewAssetReuse 纯预览（不写数据）；applyAssetReuse 全或无写入——写前复核项目身份、
// 分镜存在性、assetIds 预览基线与所选素材可用性，任一不过 → 一条不写。
// openAssetReuse 弹窗：角色/场景/道具等分类筛选 + 文本搜索、逐镜预览（现有/新增/缺失槽）、
// 选择汇总；可把生成产出就地改分类归档（改记录，不复制文件）。
// 不创建节点、不自动连线：应用后提示「已关联，去分镜检查并连线」。不做名称匹配——同名素材按 id 独立。
//
// 集成说明（supervisor 用，本文件不改 storyboard.js）：
//   · 分镜卡片/头部入口：在 storyboard.js 里加按钮调 openAssetReuse(deps, { shotIds:[s.id] })
//     或所选集合 openAssetReuse(deps, { shotIds:[...selected] })；
//   · createLibrary 的 deps 需带 storyboards（createStoryboards 返回值）与 assets；
//   · 页面引入 asset-reuse.css。

import { el, modal, toast, confirmDialog } from './ui.js';
import { ASSET_CATEGORIES, KIND_LABEL } from './assets.js';

export const REUSE_MAX_REFS = 50;   // 与 storyboard.updateShot 的 assetIds 上限一致

const catOf = a => a?.category ?? 'other';
const shotList = project => (Array.isArray(project?.studio?.shots) ? project.studio.shots : []);
const assetOk = a => !!a && a.missing !== true && a.deletedAt == null;
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// 纯预览：assetIds 按 mode（append 默认 / replace）写入 shotIds 的结果，不修改任何数据。
// 整批校验：未知素材/分镜 id、缺失或已删除素材、结果超 REUSE_MAX_REFS → ok=false；
// append 保留现有引用顺序与 null 缺失槽，已在分镜中的 id 记 already 不重复追加。
// shots[].base 为写前复核基线；added=新增引用数；dirty=是否有分镜会实际变化。
export function previewAssetReuse(project, { assetIds = [], shotIds = [], mode = 'append' } = {}) {
  const problems = [];
  if (mode !== 'append' && mode !== 'replace') problems.push(`未知写入模式：${mode}`);
  if (!project) problems.push('无打开的项目');
  const assets = [], seenA = new Set();
  for (const id of assetIds ?? []) {
    if (typeof id !== 'string' || !id || seenA.has(id)) continue;
    seenA.add(id);
    const a = project?.assets?.[id];
    if (!a) { problems.push(`素材引用 ${id} 不存在或已删除`); continue; }
    if (assetOk(a)) assets.push(a);
    else problems.push(`素材「${a.name ?? id}」本地文件缺失或已删除，请先在素材库重绑`);
  }
  if (!seenA.size) problems.push('未选择素材');
  const shots = [], seenS = new Set();
  for (const id of shotIds ?? []) {
    if (typeof id !== 'string' || !id || seenS.has(id)) continue;
    seenS.add(id);
    const s = shotList(project).find(x => x.id === id);
    if (s) shots.push(s);
    else problems.push(`分镜 ${id} 不存在或已删除`);
  }
  if (!seenS.size) problems.push('未选择分镜');
  const wanted = assets.map(a => a.id);
  const rows = shots.map(s => {
    const base = Array.isArray(s.assetIds) ? [...s.assetIds] : [];
    const held = new Set(base.filter(x => typeof x === 'string' && x));
    const missing = base.filter(x => !x || !assetOk(project.assets?.[x])).length;
    const additions = wanted.filter(id => !held.has(id));
    const next = mode === 'replace' ? [...wanted] : [...base, ...additions];
    const row = {
      shotId: s.id, title: s.title || s.id, base, current: base.length, missing,
      already: wanted.length - additions.length, additions, next,
    };
    if (next.length > REUSE_MAX_REFS)
      problems.push(`分镜「${row.title}」引用数将达 ${next.length}，超过 ${REUSE_MAX_REFS} 上限`);
    return row;
  });
  return {
    ok: problems.length === 0, problems, mode, project, assets, shots: rows,
    added: rows.reduce((n, r) => n + r.additions.length, 0),
    dirty: rows.some(r => !sameIds(r.next, r.base)),
  };
}
export const planAssetReuse = previewAssetReuse;   // 预览即写入方案

// 全或无写入：复核「同一项目 + 每个分镜存在且 assetIds 与预览基线一致 + 所选素材仍可用」，
// 全部通过才逐镜 updateShot（同步写，批内无交错）；任一复核失败 → 一条不写。
export function applyAssetReuse(deps, plan) {
  const none = problems => ({ applied: false, problems, wrote: 0, added: 0 });
  if (!plan?.ok) return none(plan?.problems?.length ? plan.problems : ['复用方案无效']);
  const { store, storyboards } = deps ?? {};
  if (typeof storyboards?.updateShot !== 'function') return none(['分镜功能未就绪']);
  if (!store?.project || store.project !== plan.project) return none(['项目已切换，本次关联未写入']);
  const find = typeof storyboards.find === 'function'
    ? id => storyboards.find(id)
    : id => shotList(store.project).find(s => s.id === id) ?? null;
  const problems = [];
  for (const r of plan.shots) {
    const s = find(r.shotId);
    if (!s) { problems.push(`分镜「${r.title}」已删除`); continue; }
    const cur = Array.isArray(s.assetIds) ? s.assetIds : [];
    if (!sameIds(cur, r.base)) problems.push(`分镜「${s.title || r.title}」的素材引用在预览后已变更`);
  }
  for (const a of plan.assets ?? [])
    if (!assetOk(store.project.assets?.[a.id])) problems.push(`素材「${a.name}」已不可用`);
  if (problems.length) return none(problems);
  let wrote = 0, added = 0;
  const restore = plan.shots.map(r => ({ shot: find(r.shotId), value: structuredClone(find(r.shotId)) }));
  if (plan.dirty) deps.editor?.checkpoint?.();
  try {
    for (const r of plan.shots) {
      if (sameIds(r.next, r.base)) continue;
      if (!storyboards.updateShot(r.shotId, { assetIds: r.next })) throw new Error('目标分镜已变更');
      wrote++; added += r.additions.length;
    }
  } catch (e) {
    for (const { shot, value } of restore) {
      for (const k of Object.keys(shot)) delete shot[k];
      Object.assign(shot, value);
    }
    store.touch?.({ type: 'data' });
    return none([`关联失败，整批已回滚：${e.message}`]);
  }
  return { applied: true, problems: [], wrote, added };
}

// 弹窗 UI。deps: { store, assets, storyboards }；入参 assetIds/shotIds 为预选集合。
export function openAssetReuse(deps, { assetIds = [], shotIds = [] } = {}) {
  const { store, assets, storyboards } = deps ?? {};
  if (typeof document !== 'object' || !document.getElementById?.('overlay-root')) return null;
  const project = store?.project;
  if (!project) { toast('无打开的项目', 'warn'); return null; }
  if (typeof storyboards?.find !== 'function' || typeof storyboards?.updateShot !== 'function') {
    toast('分镜功能未就绪', 'warn'); return null;
  }
  const pickedA = new Set(), pickedS = new Set();
  for (const id of assetIds ?? []) pickedA.add(id);
  for (const id of shotIds ?? []) pickedS.add(id);
  let shownPlan = null;
  const filter = { category: '', text: '' };
  const btn = (t, fn, cls = 'mini') => { const b = el('button', { class: cls, type: 'button', text: t }); b.addEventListener('click', fn); return b; };
  const selOf = (opts, cur, on) => { const s = el('select', {}, opts.map(([v, l]) => el('option', { value: v, text: l, selected: v === cur }))); s.addEventListener('change', () => on(s.value)); return s; };
  const modeSel = selOf([['append', '追加（保留现有引用与空槽）'], ['replace', '替换为所选素材']], 'append', () => renderPreview());
  const summaryEl = el('span', { class: 'ar-summary' });
  const previewBox = el('div', { class: 'ar-preview' });
  const applyBtn = btn('关联到分镜', doApply, 'primary');
  const content = el('div', { class: 'ar' });
  let closed = false, unsubscribe = null;
  const dlg = modal(content, { wide: true, onClose: () => { closed = true; unsubscribe?.(); } });
  unsubscribe = store.onChange?.(() => { if (store.project !== project) dlg.close(); });
  const currentPlan = () => previewAssetReuse(store.project,
    { assetIds: [...pickedA], shotIds: [...pickedS], mode: modeSel.value });
  const assetItems = () => (typeof assets?.queryAssets === 'function'
    ? assets.queryAssets({ category: filter.category, text: filter.text })
    : Object.values(project.assets ?? {}));

  function render() {
    const catSel = selOf([['', '全部分类'], ...Object.entries(ASSET_CATEGORIES).map(([v, l]) => [v, l])],
      filter.category, v => { filter.category = v; renderLists(); });
    catSel.title = '按分类筛选（角色/场景/道具/风格/镜头/其他）';
    const search = el('input', { type: 'search', class: 'ar-search', placeholder: '搜索名称/标签/MIME', value: filter.text });
    search.addEventListener('input', () => { filter.text = search.value; renderLists(); });
    content.replaceChildren(
      el('div', { class: 'ar-head' },
        el('h3', { text: '素材复用到分镜' }),
        el('p', { class: 'hint', text: '按引用关联，不复制文件、不生成节点；关联后请去分镜检查并连线。' })),
      el('div', { class: 'ar-cols' },
        el('section', { class: 'ar-col' },
          el('div', { class: 'ar-col-head' }, el('b', { text: '选择素材' }), catSel, search),
          el('div', { class: 'ar-list', 'data-ar': 'assets' })),
        el('section', { class: 'ar-col' },
          el('div', { class: 'ar-col-head' }, el('b', { text: '选择分镜' })),
          el('div', { class: 'ar-list', 'data-ar': 'shots' }))),
      el('div', { class: 'ar-foot' }, summaryEl,
        el('div', { class: 'row ar-mode' }, el('span', { class: 'hint', text: '写入方式' }), modeSel)),
      previewBox,
      el('div', { class: 'modal-actions' }, applyBtn));
    renderLists();
  }

  function renderLists() {
    const al = content.querySelector('[data-ar="assets"]');
    const sl = content.querySelector('[data-ar="shots"]');
    if (al) {
      const rows = assetItems().map(assetRow);
      al.replaceChildren(...(rows.length ? rows : [el('p', { class: 'hint', text: '无匹配素材' })]));
    }
    if (sl) {
      const rows = shotList(project).map(shotRow);
      sl.replaceChildren(...(rows.length ? rows : [el('p', { class: 'hint', text: '尚无分镜——先在分镜表中创建' })]));
    }
    renderSummary();
    renderPreview();
  }

  function assetRow(a) {
    const unusable = !assetOk(a);
    const cb = el('input', { type: 'checkbox' });
    cb.checked = pickedA.has(a.id);
    cb.disabled = unusable;
    cb.addEventListener('change', () => {
      cb.checked ? pickedA.add(a.id) : pickedA.delete(a.id);
      renderSummary(); renderPreview();
    });
    const cat = selOf(Object.entries(ASSET_CATEGORIES).map(([v, l]) => [v, l]), catOf(a), v => {
      assets?.setCategory?.(a.id, v);
      renderLists();
    });
    cat.title = '分类：生成产出的媒体可在此归档为角色/场景/道具（不产生副本）';
    const thumb = el('span', { class: 'ar-thumb', 'aria-hidden': 'true' });
    if (a.kind === 'image' && !unusable) assets?.objectURL?.(a.id).then(url => {
      if (url && thumb.isConnected && store.project === project) thumb.append(el('img', { src: url, alt: '', loading: 'lazy' }));
    }).catch(() => {});
    else thumb.textContent = KIND_LABEL[a.kind] ?? a.kind;
    return el('div', { class: `ar-item${unusable ? ' ar-item-off' : ''}`, 'data-ar-asset': a.id },
      el('label', { class: 'ar-pick' }, cb, thumb,
        el('span', { class: 'ar-name', text: a.name, title: `${a.name} · ${a.id}` }),
        el('span', { class: 'badge', text: KIND_LABEL[a.kind] ?? a.kind }),
        unusable ? el('span', { class: 'badge err', text: '缺文件' }) : null),
      cat);
  }

  function shotRow(s, i) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = pickedS.has(s.id);
    cb.addEventListener('change', () => {
      cb.checked ? pickedS.add(s.id) : pickedS.delete(s.id);
      renderSummary(); renderPreview();
    });
    const refs = Array.isArray(s.assetIds) ? s.assetIds.length : 0;
    return el('label', { class: 'ar-item', 'data-ar-shot': s.id }, cb,
      el('span', { class: 'ar-name', text: `${i + 1}. ${s.title || '未命名'}`, title: s.title || s.id }),
      el('span', { class: 'hint', text: `已关联 ${refs}` }));
  }

  function renderSummary() {
    const by = {};
    for (const id of pickedA) {
      const a = project.assets?.[id];
      if (a) by[catOf(a)] = (by[catOf(a)] ?? 0) + 1;
    }
    const cats = Object.entries(by).map(([c, n]) => `${ASSET_CATEGORIES[c] ?? c}×${n}`).join(' · ');
    summaryEl.textContent = `已选 ${pickedA.size} 个素材${cats ? `（${cats}）` : ''} · ${pickedS.size} 个分镜`;
  }

  function renderPreview() {
    const p = shownPlan = currentPlan();
    previewBox.replaceChildren(...[
      p.shots.length
        ? el('div', { class: 'ar-lines' }, p.shots.map(r => el('div', { class: 'ar-line' },
            el('span', { class: 'ar-line-title', text: r.title, title: r.title }),
            el('span', { class: 'ar-line-detail', text:
              `现有 ${r.current} 项${r.missing ? `（${r.missing} 个缺失槽）` : ''}`
              + ` · 新增 ${r.additions.length}${r.already ? ` · 已存在 ${r.already}` : ''}`
              + ` → 共 ${r.next.length} 项` }))))
        : el('p', { class: 'hint', text: '勾选分镜后，在此预览每个镜头的现有/新增/缺失引用。' }),
      p.problems.length ? el('div', { class: 'ar-problems' }, p.problems.map(t => el('div', { text: `· ${t}` }))) : null].filter(Boolean));
    applyBtn.disabled = !p.ok || !p.dirty;
  }

  async function doApply() {
    if (closed || applyBtn.disabled) return;
    if (store.project !== project) {   // 弹窗数据对应旧项目：不写新项目，直接关闭
      toast('项目已切换，本次关联未写入', 'err', 5000); dlg.close(); return;
    }
    const plan = shownPlan;
    applyBtn.disabled = true;
    if (plan.mode === 'replace' && !await confirmDialog('替换分镜素材引用', el('p', { text: `将替换 ${plan.shots.length} 个分镜的素材关联；原素材文件保留。` }))) {
      renderPreview(); return;
    }
    if (closed) return;
    const res = applyAssetReuse(deps, plan);
    if (!res.applied) {
      toast(`未写入：${res.problems.slice(0, 3).join('；')}${res.problems.length > 3 ? ` 等${res.problems.length}项` : ''}`, 'err', 7000);
      renderLists(); return;
    }
    toast(`已关联，去分镜检查并连线（新增 ${res.added} 处素材引用，共 ${res.wrote} 个分镜）`, 'ok', 6000);
    dlg.close();
  }

  render();
  return dlg;
}
