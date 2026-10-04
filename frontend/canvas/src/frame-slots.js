// 首尾帧图片框：用明确的“首帧 / 尾帧”选择框代替手动接线。
// 数据仍是节点「首尾帧」输入口的连线（按连线顺序：第 1 条=首帧，第 2 条=尾帧；仅尾帧模式使用最后一条），
// 因此提交、导出、撤销与既有工程完全沿用同一份图，不新增任何草稿字段。
import { el, toast, popup, confirmDialog } from './ui.js';
import { nodeOutputs } from './capabilities.js';
import { referenceChoices } from './prompt-references.js';
import { openMediaPreview } from './media-preview.js';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

// 按型号与模式给出需要的图片框
export function frameSlotSpec(model, intent) {
  if (intent === 'last_frame')
    return { slots: [{ key: 'last', label: '尾帧', required: true }], need: '需要 1 张图片作为尾帧' };
  if (model?.family === 'sd25')
    return { slots: [{ key: 'first', label: '首帧', required: true }, { key: 'last', label: '尾帧', required: true }], need: '需要 2 张图片：首帧和尾帧' };
  return { slots: [{ key: 'first', label: '首帧', required: true }, { key: 'last', label: '尾帧', required: false }], need: '需要 1–2 张图片：首帧必选，尾帧可选' };
}

// 与 runner.wired(node,'frames') 同顺序展开：每项对应一张实际会提交的图片及其连线
export function portEntries(store, nodeId, port) {
  const out = [];
  for (const edge of store.edgesInto(nodeId, port)) {
    const src = store.node(edge.from.node);
    if (!src) continue;
    for (const asset of nodeOutputs(store.project, src).assets) out.push({ asset, edge, src });
  }
  return out;
}

// 当前模式下各图片框对应的条目，以及已连接但本模式不会提交的条目
export function frameAssignment(entries, intent) {
  if (intent === 'last_frame')
    return { byKey: { last: entries[entries.length - 1] ?? null }, unused: entries.slice(0, -1) };
  return { byKey: { first: entries[0] ?? null, last: entries[1] ?? null }, unused: entries.slice(2) };
}

function sourceNodeFor(store, node, assetId, index, replacing = null) {
  // 被替换的那条连线即将移除，其来源节点可以复用
  const wiredFrom = new Set(store.edgesInto(node.id, 'frames').filter(e => e !== replacing).map(e => e.from.node));
  const existing = store.project.nodes.find(n => n.type === 'asset' && n.data.assetId === assetId && !wiredFrom.has(n.id));
  if (existing) return { source: existing, created: false };
  const asset = store.project.assets[assetId];
  return { source: store.addNode('asset', node.x - 390, node.y + index * 150, { assetId, title: asset?.name }), created: true };
}

// 按目标顺序重排「首尾帧」口的连线（order 即首/尾位置）
function applyOrder(store, edges) {
  edges.forEach((e, i) => { e.order = i; });
  store.touch({ type: 'structure' });
}

export function setFrame(ctx, key, assetId) {
  const { store, node, editor, intent } = ctx;
  const asset = store.project?.assets?.[assetId];
  if (!asset || asset.missing || asset.deletedAt) throw new Error('素材已不可用，请重新选择');
  if (asset.kind !== 'image') throw new Error('首尾帧只能使用图片');
  const edges = store.edgesInto(node.id, 'frames');
  const at = intent === 'last_frame' ? Math.max(0, edges.length - 1) : key === 'first' ? 0 : 1;
  if (intent !== 'last_frame' && key === 'last' && !edges.length) throw new Error('请先选择首帧');
  const replaced = edges[at] ?? null;
  if (replaced && store.node(replaced.from.node)?.data?.assetId === assetId) return replaced;   // 选了同一张图：不改动
  editor?.checkpoint?.();
  const { source, created } = sourceNodeFor(store, node, assetId, at, replaced);
  if (replaced) store.removeEdge(replaced.id);
  const edge = store.addEdge(source.id, 'out', node.id, 'frames', 'image');
  if (!edge) {
    if (created) store.removeNode(source.id);
    if (replaced) store.project.edges.push(replaced);
    store.touch({ type: 'structure' });
    throw new Error('无法把该图片接入首尾帧');
  }
  const rest = store.edgesInto(node.id, 'frames').filter(e => e.id !== edge.id);
  rest.splice(Math.min(at, rest.length), 0, edge);
  applyOrder(store, rest);
  return edge;
}

export function removeFrame(ctx, key) {
  const { store, node, editor, intent } = ctx;
  const edges = store.edgesInto(node.id, 'frames');
  const at = intent === 'last_frame' ? edges.length - 1 : key === 'first' ? 0 : 1;
  const edge = edges[at]; if (!edge) return;
  editor?.checkpoint?.();
  store.removeEdge(edge.id);
  applyOrder(store, store.edgesInto(node.id, 'frames'));
}

export function swapFrames(ctx) {
  const { store, node, editor } = ctx;
  const edges = store.edgesInto(node.id, 'frames');
  if (edges.length < 2) return;
  editor?.checkpoint?.();
  applyOrder(store, [edges[1], edges[0], ...edges.slice(2)]);
}

export function disconnectEntries(ctx, entries) {
  const ids = [...new Set(entries.map(x => x.edge.id))];
  if (!ids.length) return;
  ctx.editor?.checkpoint?.();
  for (const id of ids) ctx.store.removeEdge(id);
  ctx.store.touch({ type: 'structure' });
}

// 图片选择弹层：项目图片 + 从电脑上传；选择只改连线，不上传、不生成
function openImagePicker(anchor, { store, assets, title, currentId, onPick }) {
  const project = store.project;
  const grid = el('div', { class: 'frame-picker-grid', role: 'listbox', 'aria-label': title });
  const images = referenceChoices(project, { kind: 'image' });
  let refs = null;
  const pick = async id => {
    if (store.project !== project) return;
    refs?.close();
    try { await onPick(id); } catch (e) { toast(e.message, 'err'); }
  };
  for (const a of images.slice(0, 80)) {
    const thumb = el('span', { class: 'frame-picker-thumb', 'aria-hidden': 'true', text: '图片' });
    const option = el('button', { type: 'button', role: 'option', class: 'frame-picker-option', 'aria-selected': String(a.id === currentId), 'data-frame-asset': a.id, title: a.name },
      thumb, el('span', { class: 'frame-picker-name', text: a.name }));
    option.addEventListener('click', () => pick(a.id));
    assets?.objectURL?.(a.id).then(u => { if (u && thumb.isConnected) thumb.replaceChildren(el('img', { src: u, alt: '' })); }).catch(() => {});
    grid.append(option);
  }
  const upload = el('button', { type: 'button', class: 'frame-picker-upload', text: '从电脑上传图片…' });
  upload.addEventListener('click', () => {
    const input = el('input', { type: 'file', accept: IMAGE_ACCEPT });
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file) return;
      const list = await assets.addFiles([file]);
      if (list[0]) await pick(list[0].id);
    });
    input.click();
  });
  const body = el('div', { class: 'frame-picker' },
    el('div', { class: 'frame-picker-title', text: title }),
    images.length ? grid : el('p', { class: 'hint', text: '项目里还没有图片素材。可以从电脑上传，或把图片拖到这个框里。' }),
    upload);
  const r = anchor.getBoundingClientRect();
  refs = popup(body, { x: r.left, y: r.bottom + 6, maxHeight: 420 });
  refs.box.classList.add('frame-picker-popup');
  (grid.querySelector('[aria-selected=true]') ?? grid.firstElementChild ?? upload).focus?.();
}

export function renderFrameSlots(ctx) {
  const { store, node, assets, model, intent, onChange } = ctx;
  const spec = frameSlotSpec(model, intent);
  const entries = portEntries(store, node.id, 'frames');
  const { byKey, unused } = frameAssignment(entries, intent);
  const run = fn => async (...args) => {
    try { await fn(...args); onChange?.(); } catch (e) { toast(e.message, 'err'); onChange?.(); }
  };
  const choose = key => run(async id => setFrame(ctx, key, id));
  const root = el('div', { class: 'frame-slots', 'data-frames-intent': intent });
  const filled = spec.slots.filter(s => byKey[s.key]).length;
  root.append(el('div', { class: 'frame-slots-head' },
    el('b', { text: intent === 'last_frame' ? '尾帧图片' : '首尾帧图片' }),
    el('span', { class: 'hint', text: `${spec.need} · 已选 ${filled}/${spec.slots.length}` })));
  const row = el('div', { class: 'frame-slots-row' });
  spec.slots.forEach((slot, i) => {
    const entry = byKey[slot.key];
    const card = el('div', { class: `frame-slot-card${entry ? ' filled' : ''}`, 'data-slot': slot.key });
    card.append(el('div', { class: 'frame-slot-label' }, el('span', { text: slot.label }),
      el('span', { class: `frame-slot-req${slot.required ? ' required' : ''}`, text: slot.required ? '必选' : '可选' })));
    const blockedLast = !entry && slot.key === 'last' && intent !== 'last_frame' && !byKey.first;
    if (entry) {
      const preview = el('button', { type: 'button', class: 'frame-slot-preview', title: `放大预览：${entry.asset.name}`, 'aria-label': `放大预览${slot.label} ${entry.asset.name}` },
        el('span', { class: 'frame-slot-thumb-text', text: '图片' }));
      assets?.objectURL?.(entry.asset.id).then(u => {
        if (u && preview.isConnected) preview.replaceChildren(el('img', { src: u, alt: entry.asset.name }));
      }).catch(() => {});
      preview.addEventListener('click', () => openMediaPreview({ store, assets, assetId: entry.asset.id }));
      const replace = el('button', { type: 'button', class: 'mini', text: '替换', 'aria-label': `替换${slot.label}` });
      replace.addEventListener('click', () => openImagePicker(replace, { store, assets, title: `替换${slot.label}`, currentId: entry.asset.id, onPick: choose(slot.key) }));
      const remove = el('button', { type: 'button', class: 'mini', text: '移除', 'aria-label': `移除${slot.label}` });
      remove.addEventListener('click', run(async () => {
        if (slot.key === 'first' && intent !== 'last_frame' && byKey.last) {
          const ok = await confirmDialog('移除首帧？', el('p', { text: `首尾帧模式必须有首帧。移除后，当前尾帧「${byKey.last.asset.name}」会改为首帧。` }));
          if (!ok) return;
        }
        removeFrame(ctx, slot.key);
      }));
      card.append(preview, el('div', { class: 'frame-slot-name', text: entry.asset.name, title: entry.asset.name }),
        el('div', { class: 'frame-slot-actions' }, replace, remove));
    } else {
      const add = el('button', { type: 'button', class: 'frame-slot-empty', text: `+ 选择${slot.label}`, disabled: blockedLast,
        title: blockedLast ? '请先选择首帧' : `从项目图片中选择${slot.label}，或上传新图片` });
      add.addEventListener('click', () => openImagePicker(add, { store, assets, title: `选择${slot.label}`, onPick: choose(slot.key) }));
      card.append(add, el('div', { class: 'frame-slot-name hint', text: blockedLast ? '先选择首帧' : '拖入图片或点击选择' }));
    }
    // 从素材库或电脑拖入图片
    card.addEventListener('dragover', e => { if (!blockedLast) { e.preventDefault(); card.classList.add('drop-ok'); } });
    card.addEventListener('dragleave', () => card.classList.remove('drop-ok'));
    card.addEventListener('drop', run(async e => {
      e.preventDefault(); e.stopPropagation(); card.classList.remove('drop-ok');
      if (blockedLast) return;
      const libId = e.dataTransfer?.getData?.('text/x-asset');
      if (libId) return setFrame(ctx, slot.key, libId);
      const file = [...(e.dataTransfer?.files ?? [])].find(f => /^image\//.test(f.type));
      if (!file) throw new Error('这里只接受图片');
      const list = await assets.addFiles([file]);
      if (list[0]) setFrame(ctx, slot.key, list[0].id);
    }));
    row.append(card);
    if (i === 0 && spec.slots.length === 2) {
      const swap = el('button', { type: 'button', class: 'frame-swap', text: '⇄', title: '交换首帧和尾帧', 'aria-label': '交换首帧和尾帧', disabled: !(byKey.first && byKey.last) || byKey.first.edge === byKey.last.edge });
      swap.addEventListener('click', run(async () => swapFrames(ctx)));
      row.append(swap);
    }
  });
  root.append(row);
  if (unused.length) root.append(renderUnused(ctx, unused, intent === 'last_frame'
    ? '仅尾帧模式只使用最后一张图片，下面的图片不会提交'
    : '首尾帧最多使用两张图片，下面的图片不会提交'));
  return root;
}

// 已连接但当前模式不会提交的素材：说明原因并可一键断开
export function renderUnused(ctx, entries, reason) {
  const list = el('ul', { class: 'unused-inputs-list' });
  for (const x of entries) {
    const off = el('button', { type: 'button', class: 'mini', text: '断开', 'aria-label': `断开 ${x.asset.name}` });
    off.addEventListener('click', () => { disconnectEntries(ctx, [x]); ctx.onChange?.(); });
    list.append(el('li', {}, el('span', { text: x.asset.name, title: x.asset.name }), off));
  }
  const all = el('button', { type: 'button', class: 'mini', text: '全部断开' });
  all.addEventListener('click', () => { disconnectEntries(ctx, entries); ctx.onChange?.(); });
  return el('div', { class: 'unused-inputs', role: 'note' },
    el('div', { class: 'unused-inputs-head' }, el('span', { text: reason }), entries.length > 1 ? all : null), list);
}
