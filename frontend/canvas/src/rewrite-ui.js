// AI 改写的界面部分：角色选择条、「管理角色」窗口、H3 视频节点里的「AI 改写」窗口。
// 角色数据与组装规则在 rewrite-roles.js；这里只负责展示与编辑。
import { el, toast, modal, confirmDialog } from './ui.js';
import { getModel } from './capabilities.js';
import {
  resolveRoles, saveRoles, findRole, roleFits, ROLE_SCOPES, builtinRole, isBuiltinRole,
  renderRolePrompt, roleIdForH3Intent, MAX_ROLES,
} from './rewrite-roles.js';

const isH3 = model => getModel(model)?.family === 'h3';

// 文本节点的输出连到了哪些 H3 视频节点、各是什么模式
export function downstreamH3Intents(store, nodeId) {
  const out = new Set();
  for (const e of store.project?.edges ?? []) {
    if (e.from.node !== nodeId) continue;
    const target = store.node(e.to.node);
    if (target?.type === 'gen' && isH3(target.data?.draft?.model) && target.data?.draft?.intent) out.add(target.data.draft.intent);
  }
  return out;
}

// 角色选择条：按场景过滤；H3 专用角色带标记并说明适用范围
export function roleChips({ roles, selectedId, h3Intents, onPick, onManage }) {
  const row = el('div', { class: 'rewrite-roles', role: 'radiogroup', 'aria-label': '改写角色' });
  for (const r of roles) {
    if (!roleFits(r, h3Intents) && r.id !== selectedId) continue;
    const scope = ROLE_SCOPES[r.scope ?? ''];
    const b = el('button', { type: 'button', class: 'rewrite-role', role: 'radio', 'aria-checked': String(r.id === selectedId), title: [r.desc, scope?.intents ? scope.label : ''].filter(Boolean).join('\n') },
      el('span', { text: r.name }), scope?.short ? el('span', { class: 'rewrite-role-tag', text: scope.short }) : null);
    b.addEventListener('click', () => onPick(r.id));
    row.append(b);
  }
  if (onManage) {
    const manage = el('button', { type: 'button', class: 'rewrite-manage', text: '管理角色' });
    manage.addEventListener('click', onManage);
    row.append(manage);
  }
  return row;
}

// ---------------- 管理角色 ----------------
export function openRoleManager({ store, editor, onChange }) {
  const project = store.project;
  let roles = resolveRoles(project, { includeHidden: true }).map(r => ({ ...r }));
  let current = roles[0]?.id;
  const list = el('div', { class: 'role-list', role: 'listbox', 'aria-label': '角色列表' });
  const form = el('div', { class: 'role-form' });
  let saveTimer = 0;
  const persist = (now = false) => {
    clearTimeout(saveTimer);
    const run = () => {
      if (store.project !== project) return;
      saveRoles(project, roles); store.saveSoon(); store.touch({ type: 'data' }); onChange?.();
    };
    if (now) run(); else saveTimer = setTimeout(run, 300);
  };
  const newId = () => `role-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  function renderList() {
    list.replaceChildren();
    const section = (title, items) => {
      list.append(el('div', { class: 'role-list-head', text: title }));
      for (const r of items) {
        const scope = ROLE_SCOPES[r.scope ?? ''];
        const item = el('button', { type: 'button', class: 'role-item', role: 'option', 'aria-selected': String(r.id === current) },
          el('span', { class: 'role-item-name', text: r.name }),
          scope?.short ? el('span', { class: 'rewrite-role-tag', text: scope.short }) : null,
          r.hidden ? el('span', { class: 'hint', text: '已隐藏' }) : r.modified ? el('span', { class: 'hint', text: '已修改' }) : null);
        item.addEventListener('click', () => { persist(true); current = r.id; renderList(); renderForm(); });
        list.append(item);
      }
    };
    section('内置', roles.filter(r => r.builtin));
    section('我的', roles.filter(r => !r.builtin));
    const add = el('button', { type: 'button', class: 'role-add', text: '+ 新增角色', disabled: roles.length >= MAX_ROLES });
    add.addEventListener('click', () => {
      const r = { id: newId(), name: '新角色', desc: '', prompt: '你是一名……', scope: '', builtin: false };
      roles.push(r); current = r.id; persist(true); renderList(); renderForm();
      form.querySelector('input')?.select();
    });
    list.append(add);
  }
  function renderForm() {
    const r = roles.find(x => x.id === current);
    if (!r) { form.replaceChildren(el('p', { class: 'hint', text: '选择左侧的角色进行编辑' })); return; }
    const name = el('input', { type: 'text', value: r.name, maxlength: 64, 'aria-label': '角色名称' });
    name.addEventListener('input', () => { r.name = name.value.trim() || r.name; persist(); list.querySelector('[aria-selected=true] .role-item-name').textContent = r.name; });
    const desc = el('input', { type: 'text', value: r.desc ?? '', maxlength: 200, 'aria-label': '一句话说明', placeholder: '显示在角色按钮的提示里' });
    desc.addEventListener('input', () => { r.desc = desc.value; persist(); });
    const prompt = el('textarea', { value: r.prompt ?? '', 'aria-label': '角色提示词', class: 'role-prompt' });
    prompt.addEventListener('input', () => { r.prompt = prompt.value; persist(); });
    const scopeSel = el('select', { 'aria-label': '适用范围', disabled: r.builtin },
      Object.entries(ROLE_SCOPES).map(([k, v]) => el('option', { value: k, text: v.label, selected: (r.scope ?? '') === k })));
    scopeSel.addEventListener('change', () => { r.scope = scopeSel.value; persist(true); renderList(); });
    const acts = el('div', { class: 'role-actions' });
    const copy = el('button', { type: 'button', text: '复制为我的角色' });
    copy.addEventListener('click', () => {
      const c = { id: newId(), name: `${r.name}（副本）`.slice(0, 64), desc: r.desc ?? '', prompt: r.prompt ?? '', scope: r.scope ?? '', builtin: false };
      roles.push(c); current = c.id; persist(true); renderList(); renderForm();
    });
    acts.append(copy);
    if (r.builtin) {
      const b = builtinRole(r.id);
      const restore = el('button', { type: 'button', text: '恢复默认', disabled: !r.modified && r.name === b.name && r.prompt === b.prompt && (r.desc ?? '') === b.desc });
      restore.addEventListener('click', async () => {
        if (!await confirmDialog('恢复默认提示词？', el('p', { text: `「${b.name}」的名称、说明和提示词会恢复为内置内容，你的修改将丢失。` }))) return;
        Object.assign(r, { name: b.name, desc: b.desc, prompt: b.prompt, modified: false }); persist(true); renderList(); renderForm();
      });
      const hide = el('button', { type: 'button', text: r.hidden ? '重新显示' : '隐藏' });
      hide.addEventListener('click', () => { r.hidden = !r.hidden; persist(true); renderList(); renderForm(); });
      acts.append(restore, hide);
    } else {
      const del = el('button', { type: 'button', class: 'danger', text: '删除' });
      del.addEventListener('click', async () => {
        if (!await confirmDialog('删除这个角色？', el('p', { text: `「${r.name}」会从本项目中删除。已经用它改写出的结果不受影响。` }))) return;
        roles = roles.filter(x => x.id !== r.id); current = roles[0]?.id; persist(true); renderList(); renderForm();
      });
      acts.append(del);
    }
    form.replaceChildren(
      el('div', { class: 'field' }, el('label', { text: '名称' }), name),
      el('div', { class: 'field' }, el('label', { text: '一句话说明' }), desc),
      el('div', { class: 'field' }, el('label', { text: r.builtin ? '适用范围（内置角色固定）' : '适用范围' }), scopeSel),
      el('div', { class: 'field' }, el('label', { text: '提示词（改写前注入）' }), prompt,
        el('p', { class: 'hint', text: '可以使用 {DRAFT} 表示原文放入的位置；不写时原文与改写要求作为单独的一条消息发送。' })),
      r.builtin && builtinRole(r.id)?.source === 'iframe-studio' ? el('p', { class: 'hint', text: '提示词来自开源项目 iFrame Studio，经原开发者同意使用。' }) : null,
      acts);
  }
  const exportBtn = el('button', { type: 'button', class: 'mini', text: '导出' });
  exportBtn.addEventListener('click', () => {
    persist(true);
    const blob = new Blob([JSON.stringify({ kind: 'xp-rewrite-roles', version: 1, roles: project.studio?.rewriteRoles ?? [] }, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: '改写角色.json' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  const importBtn = el('button', { type: 'button', class: 'mini', text: '导入' });
  importBtn.addEventListener('click', () => {
    const input = el('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await input.files[0].text());
        if (data?.kind !== 'xp-rewrite-roles' || !Array.isArray(data.roles)) throw new Error('不是改写角色文件');
        let added = 0;
        for (const r of data.roles) {
          if (isBuiltinRole(r?.id)) { const t = roles.find(x => x.id === r.id); if (t) Object.assign(t, { ...r, builtin: true }); continue; }
          if (typeof r?.name !== 'string' || typeof r?.prompt !== 'string' || roles.length >= MAX_ROLES) continue;
          const id = roles.some(x => x.id === r.id) ? newId() : r.id;
          roles.push({ id, name: r.name.slice(0, 64), desc: String(r.desc ?? '').slice(0, 200), prompt: r.prompt, scope: ROLE_SCOPES[r.scope] ? r.scope : '', builtin: false }); added++;
        }
        persist(true); renderList(); renderForm(); toast(`已导入，新增 ${added} 个角色`, 'ok');
      } catch (e) { toast(`导入失败：${e.message}`, 'err'); }
    });
    input.click();
  });
  renderList(); renderForm();
  modal(el('div', { class: 'role-manager' },
    el('div', { class: 'role-manager-head' }, el('h3', { text: '改写角色' }), el('span', { class: 'hint', text: '保存在当前项目里，随工程包导出' }), importBtn, exportBtn),
    el('div', { class: 'role-manager-body' }, list, form)), { wide: true, onClose: () => persist(true) });
}

// ---------------- H3 视频节点里的「AI 改写」 ----------------
// 只在 MiniMax H3 的「首帧/首尾帧」或「素材参考」模式下出现。结果先给用户看，点「替换提示词」才写回节点。
const LAST_MODEL_KEY = 'xp-rewrite-model';
export function canRewriteH3(draft) {
  return isH3(draft?.model) && !!roleIdForH3Intent(draft?.intent);
}
export function openH3Rewrite({ store, node, generators, editor, onApply }) {
  const project = store.project, draft = node.data.draft;
  const intents = new Set([draft.intent]);
  const roles = resolveRoles(project).filter(r => roleFits(r, intents));
  let roleId = roleIdForH3Intent(draft.intent);
  if (!roles.some(r => r.id === roleId)) roleId = roles.find(r => r.scope)?.id ?? roles[0]?.id;
  const models = (generators?.textModels?.() ?? []).filter(m => m.availability !== 'unavailable');
  let model = (() => { try { return localStorage.getItem(LAST_MODEL_KEY); } catch { return null; } })();
  if (!models.some(m => m.id === model)) model = models.find(m => m.usable)?.id ?? models[0]?.id ?? '';
  const source = draft.prompt ?? '';
  let result = null, busy = false;

  const chipsSlot = el('div');
  const renderChips = () => chipsSlot.replaceChildren(roleChips({ roles, selectedId: roleId, h3Intents: intents, onPick: id => { roleId = id; renderChips(); renderPreview(); } }));
  const request = el('textarea', { rows: 2, 'aria-label': '改写要求', placeholder: '可选，例如：镜头更慢、突出人物表情、控制在 80 字以内' });
  const modelSel = el('select', { 'aria-label': '改写使用的文本型号' }, models.map(m => el('option', { value: m.id, text: m.id + (m.availability === 'unverified' ? '（可用性未验证）' : ''), selected: m.id === model })));
  modelSel.addEventListener('change', () => { model = modelSel.value; try { localStorage.setItem(LAST_MODEL_KEY, model); } catch { /* 偏好可选 */ } });
  const previewText = el('pre', { class: 'rewrite-preview-text' });
  const renderPreview = () => {
    const r = findRole(project, roleId);
    const { system, prompt } = renderRolePrompt(r?.prompt ?? '', { source, request: request.value });
    previewText.textContent = system ? `【系统提示】\n${system}\n\n【发送内容】\n${prompt}` : prompt;
  };
  request.addEventListener('input', renderPreview);
  const out = el('textarea', { class: 'rewrite-result', rows: 6, 'aria-label': '改写结果', placeholder: '改写结果会显示在这里，可以先修改再替换' });
  const enBox = el('details', { class: 'rewrite-en', hidden: true }, el('summary', { text: '英文版' }), el('pre', {}));
  const status = el('p', { class: 'hint rewrite-status' });
  const run = el('button', { type: 'button', class: 'primary', text: '改写' });
  const apply = el('button', { type: 'button', text: '替换提示词', disabled: true });
  run.addEventListener('click', async () => {
    if (busy) return;
    if (!source.trim()) { status.textContent = '先在视频节点里写一段提示词再改写。'; return; }
    if (!model) { status.textContent = '没有可用的文本型号：请先设置 API Key。'; return; }
    const r = findRole(project, roleId);
    const { system, prompt } = renderRolePrompt(r?.prompt ?? '', { source, request: request.value });
    busy = true; run.disabled = true; run.classList.add('busy'); run.textContent = '改写中'; status.textContent = '';
    const t0 = performance.now();
    try {
      result = await generators.rewriteText({ model, system, prompt, key: `h3:${node.id}` });
      out.value = result.text; apply.disabled = !result.text.trim();
      enBox.hidden = !result.en; enBox.querySelector('pre').textContent = result.en ?? '';
      status.textContent = `用时 ${Math.round((performance.now() - t0) / 1000)} 秒 · 确认无误后点「替换提示词」`;
    } catch (e) { status.textContent = `改写失败：${e.message}`; }
    finally { busy = false; run.disabled = false; run.classList.remove('busy'); run.textContent = result ? '重新改写' : '改写'; }
  });
  out.addEventListener('input', () => { apply.disabled = !out.value.trim(); });
  const dlg = modal(el('div', { class: 'h3-rewrite' },
    el('h3', { text: 'AI 改写提示词' }),
    el('p', { class: 'hint', text: `专为 MiniMax H3「${draft.intent === 'refs' ? '素材参考' : '首帧 / 首尾帧'}」模式；改写结果需要你确认后才替换提示词，@图片N 等素材引用会要求原样保留。` }),
    el('div', { class: 'field' }, el('label', { text: '当前提示词' }), el('div', { class: 'rewrite-source', text: source || '（空）' })),
    el('div', { class: 'field' }, el('label', { text: '角色' }), chipsSlot),
    el('div', { class: 'field' }, el('label', { text: '改写要求' }), request),
    el('details', { class: 'rewrite-injected' }, el('summary', { text: '查看本次发送的完整提示词' }), previewText),
    el('div', { class: 'field rewrite-model' }, el('label', { text: '文本型号' }), modelSel, el('span', { class: 'hint', text: '文本型号标准价未知，费用以实际扣费为准' })),
    el('div', { class: 'modal-actions' }, run),
    el('div', { class: 'field' }, el('label', { text: '改写结果' }), out, enBox),
    status,
    el('div', { class: 'modal-actions' }, apply)), { wide: true });
  apply.addEventListener('click', () => {
    if (store.project !== project || store.node(node.id) !== node) { toast('项目或节点已变更，未替换', 'warn'); return; }
    editor?.checkpoint?.();
    node.data.draft.prompt = out.value.trim();
    store.saveSoon(); store.touch({ type: 'data', id: node.id });
    onApply?.(); dlg.close?.();
    toast('已替换提示词，可用 Ctrl+Z 撤销', 'ok');
  });
  renderChips(); renderPreview();
}
