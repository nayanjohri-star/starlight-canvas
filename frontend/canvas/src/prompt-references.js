// Prompt references use the existing graph and stable asset bindings. Picking a
// reference never uploads media or starts generation.
import { el } from './ui.js';
import { getModel, wiredOutputs, syncPromptBindings, nodeOutputIds, IMAGE_EDIT_MAX_REFERENCES } from './capabilities.js';

const LABEL = { image: '图片', video: '视频', audio: '音频' };

// A local, non-interactive enlargement: hovering never attaches or submits media.
function referenceHover(control, asset, { store, assets, valid }) {
  let panel = null, timer = 0, observer = null, off = () => {}, revision = 0;
  const hide = () => {
    revision++; clearTimeout(timer); panel?.remove(); panel = null;
    observer?.disconnect(); observer = null; off(); off = () => {};
    window.removeEventListener('resize', hide); document.removeEventListener('scroll', hide, true);
  };
  const show = () => {
    hide(); if (asset.kind !== 'image') return;
    const ticket = revision;
    timer = setTimeout(async () => {
      const url = await assets?.objectURL?.(asset.id).catch(() => null);
      if (!url || ticket !== revision || !control.isConnected || !valid() || asset.missing || asset.deletedAt) return;
      const r = control.getBoundingClientRect(), w = Math.min(320, innerWidth - 24), h = Math.min(260, innerHeight - 24);
      const left = r.left >= w + 16 ? r.left - w - 10 : r.right + w + 16 <= innerWidth ? r.right + 10 : Math.max(12, Math.min(r.left, innerWidth - w - 12));
      const side = left + w <= r.left || left >= r.right;
      const top = side ? Math.max(12, Math.min(r.top, innerHeight - h - 12)) : r.top >= h + 16 ? r.top - h - 10 : Math.min(r.bottom + 10, innerHeight - h - 12);
      panel = el('div', { class: 'reference-hover', role: 'tooltip', style: `left:${left}px;top:${top}px;width:${w}px;height:${h}px` },
        el('img', { src: url, alt: asset.name }), el('span', { text: asset.name }));
      document.getElementById('overlay-root').append(panel);
      const check = () => { if (!control.isConnected || !valid() || asset.missing || asset.deletedAt) hide(); };
      observer = new MutationObserver(check); observer.observe(document.getElementById('inspector'), { childList: true, subtree: true });
      off = store.onChange(check);
      window.addEventListener('resize', hide); document.addEventListener('scroll', hide, true);
    }, 140);
  };
  control.addEventListener('pointerenter', show); control.addEventListener('pointerleave', hide);
  control.addEventListener('focus', show); control.addEventListener('blur', hide); control.addEventListener('click', hide);
}
export function mentionAt(text, caret) {
  const match = String(text).slice(0, caret).match(/@([^@\s]{0,80})$/u);
  return match ? { start: caret - match[0].length, end: caret, query: match[1] } : null;
}
export function referencePresentation(project, asset) {
  const nodes = project?.nodes ?? [];
  const source = nodes.find(n => n.data?.resultAssetId === asset.id || n.data?.outputAssetIds?.includes(asset.id));
  const onCanvas = Boolean(source || nodes.some(n => n.data?.assetId === asset.id));
  const generated = asset.category === 'gen' || Boolean(source);
  const name = String(asset.name || LABEL[asset.kind]);
  const title = generated ? name.replace(/^生成图-/, '').replace(/-[a-z0-9]{6,12}\.(png|jpg|jpeg|webp)$/i, '') : name;
  const date = Number(asset.addedAt) > 0 ? new Date(asset.addedAt).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }) : '';
  const origin = source ? `节点 ${nodes.indexOf(source) + 1} · ${source.data?.title || LABEL[asset.kind] + '生成'} · 当前结果`
    : onCanvas ? '画布素材' : generated ? '生成素材 · 素材库' : '素材库';
  return { title, detail: [origin, date].filter(Boolean).join(' · '), onCanvas };
}
export function referenceChoices(project, { query = '', kind = '', scope = 'all' } = {}) {
  const needle = query.toLocaleLowerCase();
  return Object.values(project?.assets ?? {}).filter(a => LABEL[a.kind] && !a.missing && !a.deletedAt &&
    (scope !== 'canvas' || referencePresentation(project, a).onCanvas) &&
    (!kind || a.kind === kind) && `${a.name} ${LABEL[a.kind]} ${a.tags ?? ''} ${referencePresentation(project, a).detail}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
}
export function referenceToken(asset, refs, bindings = {}, prompt = '') {
  const existing = Object.entries(bindings).find(([key, id]) => id === asset.id && key.startsWith(`${asset.kind}:`));
  let index = existing ? Number(existing[0].split(':')[1]) : refs.filter(a => a.kind === asset.kind).findIndex(a => a.id === asset.id) + 1;
  if (!existing) {
    index = Math.max(1, index);
    while (bindings[`${asset.kind}:${index}`] || prompt.includes(`@${LABEL[asset.kind]}${index}`)) index++;
  }
  return { text: `@${LABEL[asset.kind]}${index}`, bindings: { ...bindings, [`${asset.kind}:${index}`]: asset.id } };
}

export async function attachPromptReference({ store, node, assetId, assets, editor, canAttach = () => true }) {
  const project = store.project, asset = project?.assets?.[assetId];
  const current = () => store.project === project && store.node(node.id) === node && project.assets?.[assetId] === asset;
  if (!current() || !canAttach() || !asset || asset.missing || asset.deletedAt) throw new Error('素材已不可用，请重新选择');
  if (!['gen', 'image'].includes(node.type)) throw new Error('此节点不支持媒体引用');
  const before = wiredOutputs(store, node.id, 'refs');
  if (before.problems.length) throw new Error('已有引用缺失，请先修复或移除失效连线');
  if (node.type === 'image') {
    if (asset.kind !== 'image') throw new Error('图片生成只能引用图片素材');
    if (!before.items.some(a => a.id === assetId) && before.items.length >= IMAGE_EDIT_MAX_REFERENCES)
      throw new Error(`本站最多支持 ${IMAGE_EDIT_MAX_REFERENCES} 张参考图`);
  }
  const draft = node.data.draft;
  if (node.type === 'gen') {
    if (['frames', 'last_frame'].includes(draft.intent)) throw new Error('首尾帧模式请在编辑器上方的首帧/尾帧图片框中选择图片；切换为「素材参考」后可使用 @ 引用');
    const limits = getModel(draft.model)?.reference_limits;
    if (!limits?.[asset.kind]) throw new Error('当前模型不支持这种参考素材');
    if (!before.items.some(a => a.id === assetId) &&
      (before.items.length >= limits.total || before.items.filter(a => a.kind === asset.kind).length >= limits[asset.kind]))
      throw new Error('已达到当前模型的参考素材上限');
  }
  const state = () => JSON.stringify([node.data.draft ?? [node.data.prompt, node.data.bindings], store.edgesInto(node.id, 'refs')]);
  const baseline = state();
  if (assets?.blobOf && !await assets.blobOf(assetId)) throw new Error('本地素材文件缺失，请先重新绑定文件');
  if (!current() || !canAttach()) throw new Error('项目或节点已切换，本次引用未添加');
  if (asset.missing || asset.deletedAt || state() !== baseline) throw new Error('素材或参数已变化，请重新选择引用');
  editor?.checkpoint?.();
  const prompt = node.type === 'gen' ? draft.prompt : node.data.prompt;
  const previous = syncPromptBindings(prompt, before.items, node.type === 'gen' ? draft.bindings : node.data.bindings);
  if (!before.items.some(a => a.id === assetId)) {
    let source = project.nodes.find(n => n.type === 'asset' && n.data.assetId === assetId);
    const created = !source;
    if (!source) source = store.addNode('asset', node.x - 390, node.y + before.items.length * 36, { assetId });
    if (!store.addEdge(source.id, 'out', node.id, 'refs', asset.kind)) {
      if (created) store.removeNode(source.id);
      throw new Error('无法连接此素材');
    }
  }
  const result = referenceToken(asset, wiredOutputs(store, node.id, 'refs').items, previous, prompt);
  if (node.type === 'gen') { draft.bindings = result.bindings; if (draft.intent === 'text') draft.intent = 'refs'; }
  else node.data.bindings = result.bindings;
  store.saveSoon();
  return result.text;
}

export async function replacePromptReference({ store, node, oldId, assetId, assets, editor, canAttach = () => true }) {
  const project = store.project, asset = project.assets[assetId], old = project.assets[oldId];
  const baseline = JSON.stringify([node.data, store.edgesInto(node.id, 'refs')]);
  const current = () => store.project === project && store.node(node.id) === node && canAttach() && JSON.stringify([node.data, store.edgesInto(node.id, 'refs')]) === baseline;
  if (!asset || asset.missing || asset.deletedAt || !old || asset.kind !== old.kind) throw new Error('请选择同类型的可用素材');
  if (oldId === assetId) return;
  const refs = wiredOutputs(store, node.id, 'refs').items;
  if (refs.some(a => a.id === assetId)) throw new Error('这张素材已经连接，请选择其他素材');
  const edges = store.edgesInto(node.id, 'refs').filter(e => nodeOutputIds(store.node(e.from.node)).includes(oldId));
  if (!edges.length) throw new Error('原参考连线已变化，请重新选择');
  if (edges.some(e => nodeOutputIds(store.node(e.from.node)).length !== 1)) throw new Error('此连线包含多个素材，请先拆分后替换');
  if (assets?.blobOf && !await assets.blobOf(assetId)) throw new Error('本地素材文件缺失，请先重新绑定文件');
  if (!current() || project.assets[assetId] !== asset || asset.missing || asset.deletedAt) throw new Error('项目或素材已变化，本次未替换');
  editor?.checkpoint?.();
  let source = project.nodes.find(n => n.type === 'asset' && n.data.assetId === assetId);
  if (!source) source = store.addNode('asset', node.x - 390, node.y, { assetId });
  for (const e of edges) e.from = { node: source.id, port: 'out' };
  if (edges.length > 1) project.edges = project.edges.filter(e => !edges.slice(1).includes(e));
  const data = node.type === 'gen' ? node.data.draft : node.data;
  data.bindings = syncPromptBindings(data.prompt, refs, data.bindings);
  for (const key of Object.keys(data.bindings)) if (data.bindings[key] === oldId) data.bindings[key] = assetId;
  store.touch({ type: 'structure' });
}

let serial = 0;
export function promptReferencePicker({ textarea, store, node, assets, editor, onInsert, kinds = ['image', 'video', 'audio'], unavailableReason = '' }) {
  const project = store.project;
  const root = el('div', { class: 'prompt-reference-tools' });
  const trigger = el('button', { type: 'button', class: 'reference-trigger', text: '+ 参考素材', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const menu = el('div', { class: 'reference-menu', hidden: true });
  const search = el('input', { type: 'search', placeholder: '搜索素材名称', 'aria-label': '搜索引用素材' });
  const listId = `reference-options-${++serial}`;
  const list = el('div', { id: listId, class: 'reference-options', role: 'listbox', 'aria-label': '选择引用素材' });
  const feedback = el('p', { class: 'reference-feedback', role: 'status' });
  const scopes = el('div', { class: 'reference-kinds reference-scopes', role: 'group', 'aria-label': '素材范围' });
  const summary = el('p', { class: 'reference-summary' });
  const more = el('button', { type: 'button', class: 'reference-more', text: '显示更多素材', hidden: true });
  const tabs = el('div', { class: 'reference-kinds', role: 'group', 'aria-label': '素材类型' });
  const connected = el('div', { class: 'reference-connected', 'aria-label': '已连接参考素材' });
  let scope = 'canvas', limit = 60, replacing = null, mentionOnly = false;
  const scopeName = value => value === 'connected' ? '已连接' : value === 'canvas' ? '画布素材' : '全部素材';
  function choices(options = {}) {
    if (mentionOnly) options = { ...options, scope: 'connected' };
    const refs = wiredOutputs(store, node.id, 'refs').items, connectedIds = new Set(refs.map(a => a.id));
    const bindings = syncPromptBindings(textarea.value, refs, node.type === 'gen' ? node.data.draft?.bindings : node.data.bindings);
    const needle = String(options.query ?? '').toLocaleLowerCase();
    return referenceChoices(project, { ...options, query: '', scope: options.scope === 'connected' ? 'all' : options.scope })
      .filter(a => kinds.includes(a.kind) && (options.scope !== 'connected' || connectedIds.has(a.id)) && (!replacing || a.kind === project.assets[replacing]?.kind))
      .filter(a => `${a.name} ${LABEL[a.kind]} ${a.tags ?? ''} ${referencePresentation(project, a).detail} ${connectedIds.has(a.id) ? referenceToken(a, refs, bindings, textarea.value).text : ''}`.toLocaleLowerCase().includes(needle));
  }
  let filter = '', range = null, active = 0, rows = [], composing = false, pending = false, open = false;
  let frame = 0, detach = () => {};
  const valid = () => store.project === project && store.node(node.id) === node && root.isConnected;
  function close() {
    open = false; detach(); detach = () => {}; cancelAnimationFrame(frame); frame = 0;
    menu.hidden = true; root.append(menu);
    trigger.setAttribute('aria-expanded', 'false'); textarea.setAttribute('aria-expanded', 'false');
    textarea.removeAttribute('aria-activedescendant'); search.removeAttribute('aria-activedescendant');
  }
  function position() {
    frame = 0;
    if (!valid()) return close();
    const anchor = trigger.getBoundingClientRect();
    const panel = root.closest('#inspector') || textarea;
    const rect = panel.getBoundingClientRect(), gap = 10, w = innerWidth, h = innerHeight;
    // Place outside the entire editor so neither prompt nor submit controls are
    // covered. Use document coordinates, escaping the inspector's scroll clip.
    const spaces = [
      { side: 'above', x: gap, y: gap, width: w - 2 * gap, height: rect.top - 2 * gap },
      { side: 'left', x: gap, y: gap, width: rect.left - 2 * gap, height: h - 2 * gap },
      { side: 'right', x: rect.right + gap, y: gap, width: w - rect.right - 2 * gap, height: h - 2 * gap },
      { side: 'below', x: gap, y: rect.bottom + gap, width: w - 2 * gap, height: h - rect.bottom - 2 * gap },
    ].filter(s => s.width >= Math.min(240, w - 20) && s.height >= 150);
    spaces.sort((a, b) => Math.min(b.width, 440) * Math.min(b.height, 500) - Math.min(a.width, 440) * Math.min(a.height, 500));
    const space = spaces[0];
    if (!space) {
      // Very small viewports use document flow instead of obscuring controls.
      menu.dataset.placement = 'inline'; menu.style.cssText = ''; if (menu.parentElement !== root) root.append(menu); return;
    }
    const width = Math.min(440, space.width), height = Math.min(500, space.height);
    const x = space.side === 'left' ? rect.left - gap - width : space.side === 'right' ? space.x : Math.max(gap, Math.min(anchor.left, w - gap - width));
    const y = space.side === 'above' ? rect.top - gap - height : space.side === 'below' ? space.y : Math.max(gap, Math.min(anchor.top, h - gap - height));
    menu.dataset.placement = space.side;
    menu.style.cssText = `left:${x}px;top:${y}px;width:${width}px;max-height:${height}px`;
    const overlay = document.getElementById('overlay-root');
    // Re-appending an already placed menu drops focus from its search/options.
    // Scroll/resize should only reposition it, not detach the active control.
    if (menu.parentElement !== overlay) overlay.append(menu);
  }
  function schedule(event) {
    if (!open || (event?.target && menu.contains(event.target))) return;
    if (!frame) frame = requestAnimationFrame(position);
  }
  function highlight() {
    list.querySelectorAll('[role=option]').forEach((button, i) => button.setAttribute('aria-selected', String(i === active)));
    const id = rows.length ? `${listId}-${active}` : '';
    for (const input of [textarea, search]) id ? input.setAttribute('aria-activedescendant', id) : input.removeAttribute('aria-activedescendant');
  }
  function render() {
    if (!valid()) return close();
    rows = unavailableReason ? [] : choices({ query: search.value, kind: filter, scope }); active = 0;
    const total = rows.length;
    summary.textContent = `${replacing ? '选择替换素材 · ' : ''}${scopeName(scope)} · ${total} 项${total > limit ? `，已显示 ${limit} 项` : ''}`;
    more.hidden = total <= limit;
    for (const button of scopes.children) {
      button.hidden = mentionOnly && button.dataset.scope !== 'connected';
      const count = choices({ scope: button.dataset.scope }).length;
      button.textContent = `${scopeName(button.dataset.scope)} (${count})`;
      button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
    }
    list.replaceChildren();
    for (const [i, asset] of rows.slice(0, limit).entries()) {
      const display = referencePresentation(project, asset);
      const thumb = el('span', { class: 'reference-thumb', text: LABEL[asset.kind], 'aria-hidden': 'true' });
      const option = el('button', { type: 'button', role: 'option', id: `${listId}-${i}`, 'aria-selected': String(i === 0), class: 'reference-option', 'data-reference-asset': asset.id },
        thumb, el('span', { class: 'reference-copy' },
          el('span', { class: 'reference-name', text: display.title, title: asset.name }),
          el('span', { class: 'reference-meta', text: display.detail }),
          el('span', { class: 'reference-meta', text: `${LABEL[asset.kind]} · 点击引用` })));
      const preview = el('button', { type: 'button', class: 'reference-preview', text: '预览', 'aria-label': `预览 ${asset.name}` });
      preview.addEventListener('click', () => { close(); assets?.preview?.(asset.id); });
      option.addEventListener('click', () => pick(asset)); list.append(el('div', { class: 'reference-row' }, option, preview));
      referenceHover(option, asset, { store, assets, valid: () => valid() && open });
      if (asset.kind === 'image') assets?.objectURL?.(asset.id).then(url => {
        if (url && valid() && thumb.isConnected) thumb.replaceChildren(el('img', { src: url, alt: '', loading: 'lazy' }));
      }).catch(() => {});
    }
    rows = rows.slice(0, limit);
    if (!rows.length) list.append(el('p', { class: 'hint', text: unavailableReason || (scope === 'connected' ? '没有匹配的已连接素材。可用「+ 参考素材」添加，或切换「画布素材」查找。' : scope === 'canvas' ? '当前画布没有匹配素材，可切换「全部素材」查找上传文件和旧生成结果。' : '没有匹配素材。先把图片或视频拖入画布，再输入 @ 选择。') }));
    highlight();
  }
  async function pick(asset) {
    if (pending || !valid()) return;
    const requireConnected = mentionOnly;
    pending = true; feedback.textContent = '';
    const value = textarea.value, chosen = range ?? { start: textarea.selectionStart, end: textarea.selectionEnd };
    // Freeze the editor while reading a local blob; account/project changes are
    // independently checked before attaching anything to the graph.
    textarea.readOnly = true;
    try {
      if (replacing) {
        await replacePromptReference({ store, node, oldId: replacing, assetId: asset.id, assets, editor, canAttach: valid });
        if (!valid()) return;
        replacing = null; close(); onInsert(value, chosen.end); return;
      }
      const text = await attachPromptReference({ store, node, assetId: asset.id, assets, editor, canAttach: () => valid() && textarea.value === value && (!requireConnected || wiredOutputs(store, node.id, 'refs').items.some(a => a.id === asset.id)) });
      if (!valid()) return;
      const next = value.slice(0, chosen.start) + text + ' ' + value.slice(chosen.end);
      close(); onInsert(next, chosen.start + text.length + 1);
    } catch (error) { if (valid()) feedback.textContent = error.message; }
    finally { pending = false; textarea.readOnly = false; }
  }
  function show(at, focusSearch = false) {
    if (!open) {
      const outside = event => { if (!root.contains(event.target) && !menu.contains(event.target) && event.target !== textarea) close(); };
      document.addEventListener('pointerdown', outside, true);
      window.addEventListener('resize', schedule); document.addEventListener('scroll', schedule, true);
      const off = store.onChange(() => { if (!valid()) close(); });
      const inspector = document.getElementById('inspector');
      const observer = new MutationObserver(changes => {
        if (!valid()) close();
        else if (changes.some(change => change.target === inspector && change.type === 'attributes')) schedule();
      });
      observer.observe(inspector, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      detach = () => { off(); observer.disconnect(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); };
    }
    range = at; open = true; menu.hidden = false; feedback.textContent = ''; search.value = at?.query ?? '';
    trigger.setAttribute('aria-expanded', 'true'); textarea.setAttribute('aria-expanded', 'true'); render(); position();
    if (focusSearch) search.focus();
  }
  for (const value of ['connected', 'canvas', 'all']) {
    const button = el('button', { type: 'button', 'data-scope': value, 'aria-pressed': String(value === scope) });
    button.addEventListener('click', () => { scope = value; limit = 60; for (const b of scopes.children) b.setAttribute('aria-pressed', String(b === button)); render(); position(); });
    scopes.append(button);
  }
  more.addEventListener('click', () => { limit += 60; render(); });
  for (const [kind, label] of [['', '全部'], ...kinds.map(k => [k, LABEL[k]])]) {
    const button = el('button', { type: 'button', text: label, 'aria-pressed': String(kind === '') });
    button.addEventListener('click', () => { filter = kind; for (const b of tabs.children) b.setAttribute('aria-pressed', String(b === button)); render(); }); tabs.append(button);
  }
  search.setAttribute('aria-controls', listId);
  textarea.setAttribute('aria-controls', listId); textarea.setAttribute('aria-expanded', 'false'); textarea.setAttribute('aria-autocomplete', 'list');
  trigger.addEventListener('click', () => {
    const wasAdding = open && !mentionOnly && !replacing, at = open && range ? range : { start: textarea.selectionStart, end: textarea.selectionEnd, query: '' };
    close(); replacing = null; mentionOnly = false; scope = 'canvas';
    if (!wasAdding) show({ ...at, query: '' }, true);
  });
  search.addEventListener('input', render);
  textarea.addEventListener('compositionstart', () => { composing = true; close(); });
  textarea.addEventListener('compositionend', () => { composing = false; replacing = null; mentionOnly = true; scope = 'connected'; const at = mentionAt(textarea.value, textarea.selectionStart); if (at) show(at); });
  textarea.addEventListener('input', () => { if (composing || pending) return; replacing = null; mentionOnly = true; scope = 'connected'; const at = mentionAt(textarea.value, textarea.selectionStart); at ? show(at) : close(); });
  function renderConnected() {
    const refs = wiredOutputs(store, node.id, 'refs').items;
    const bindings = syncPromptBindings(textarea.value, refs, node.type === 'gen' ? node.data.draft?.bindings : node.data.bindings);
    connected.replaceChildren(); connected.hidden = !refs.length;
    for (const asset of refs) {
      const label = referenceToken(asset, refs, bindings, textarea.value).text;
      const button = el('button', { type: 'button', class: 'reference-connected-item', 'aria-label': `查看引用 ${label} ${asset.name}`, title: `${label} · ${asset.name}（点击看大图）` }, el('span', { text: label }));
      button.addEventListener('click', () => assets?.preview?.(asset.id));
      referenceHover(button, asset, { store, assets, valid });
      if (asset.kind === 'image') assets?.objectURL?.(asset.id).then(url => {
        if (url && button.isConnected) button.prepend(el('img', { src: url, alt: '' }));
      }).catch(() => {});
      const replace = el('button', { type: 'button', class: 'reference-preview', text: '替换', 'aria-label': `替换引用 ${label} ${asset.name}` });
      replace.addEventListener('click', () => { replacing = asset.id; mentionOnly = false; scope = 'all'; show(null, true); });
      connected.append(el('div', { class: 'reference-connected-pair' }, button, replace));
    }
  }
  textarea.addEventListener('input', renderConnected);
  function keydown(event) {
    if (!open || composing || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); textarea.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && rows.length) {
      event.preventDefault(); event.stopPropagation(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; highlight();
      list.querySelector(`[id="${listId}-${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter' && rows.length) { event.preventDefault(); event.stopPropagation(); pick(rows[active]); }
  }
  textarea.addEventListener('keydown', keydown); search.addEventListener('keydown', keydown);
  const ownsFocus = target => target instanceof Node && (root.contains(target) || menu.contains(target) || target === textarea);
  const focusout = event => {
    // During blur, activeElement may briefly be BODY before the destination
    // receives focus. relatedTarget identifies moves within this same picker.
    if (ownsFocus(event.relatedTarget)) return;
    queueMicrotask(() => { if (!ownsFocus(document.activeElement)) close(); });
  };
  root.addEventListener('focusout', focusout); menu.addEventListener('focusout', focusout);
  textarea.addEventListener('focusout', focusout);
  if (kinds.length === 1) tabs.hidden = true;
  menu.append(search, scopes, tabs, summary, list, more, feedback); root.append(trigger, el('span', { class: 'hint', text: '@ 仅引用已连接素材' }), menu, connected);
  renderConnected();
  return root;
}
