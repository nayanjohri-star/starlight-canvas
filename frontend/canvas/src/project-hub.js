// 项目中枢：文件夹/搜索、重命名/副本、非破坏性回收站、命名版本、项目与工作流模板、JSON 导入导出。
// 约定：
//  · 回收站只在项目文档上打 trashed 标记——绝不删除任何记录/素材/任务
//  · 版本快照存 version:<pid>:<vid>；恢复前先自动快照当前态，恢复时按 nodeId 合并运行时事实
//  · 模板存 tpl:<id>；workflow 模板实例化进当前项目时全部换新节点 id，不复制运行时身份
//  · 文件夹归属存 hub:v1（folderOf 映射），与项目文档解耦

import { el, toast, modal, confirmDialog, fmtTime } from './ui.js';
import { uid, containsSecret } from './store.js';
import { clone, studioState, orderedGraph, RUNTIME_KEYS, BATCH_KEY, captureRuntime, mergeRuntime } from './studio-schema.js';
import { createSubmitLock } from './submit-lock.js';

const HUB_KEY = 'hub:v1';
const vkey = (pid, vid) => `version:${pid}:${vid}`;
const tkey = id => `tpl:${id}`;

export function createProjectHub(deps) {
  const { store, storage } = deps;
  // 恢复版本「读→快照→覆盖写」临界区的跨标签互斥；不支持 Web Locks 时降级（CAS 仍保底，不锁死功能）
  const xlock = typeof deps.submitLock === 'function' ? { request: deps.submitLock }
    : deps.submitLock?.request ? deps.submitLock
      // 托管形态：付费提交锁按已核验账户分区，会话失效后拒绝新提交（核心合同）
      : createSubmitLock(deps.accountScope ? { namespace: deps.accountScope.lockNamespace, assertActive: deps.accountScope.assertActive } : {});
  const withLock = (name, fn) => xlock.request(name, fn).catch(e => {
    if (e?.code === 'submit_lock_unsupported') return fn();
    throw e;
  });

  async function hubGet() {
    const h = await storage.get(HUB_KEY);
    return h && typeof h === 'object' ? { folders: [], folderOf: {}, ...h } : { folders: [], folderOf: {} };
  }
  const hubSet = h => storage.set(HUB_KEY, h);

  // ---------- 项目列表 / 文件夹 / 回收站 ----------
  async function listProjects({ query = '', folder, includeTrashed = false, trashedOnly = false } = {}) {
    const h = await hubGet();
    const items = await store.listProjects({ includeTrashed: true });
    const q = query.trim().toLowerCase();
    return items.filter(p => {
      if (trashedOnly) return !!p.trashed;
      if (p.trashed && !includeTrashed) return false;
      if (folder === '__none__' && h.folderOf[p.id]) return false;
      if (folder && folder !== '__none__' && h.folderOf[p.id] !== folder) return false;
      if (q && !(p.name ?? '').toLowerCase().includes(q)) return false;
      return true;
    }).map(p => ({ ...p, folderId: h.folderOf[p.id] ?? null }));
  }
  async function createFolder(name) {
    const h = await hubGet();
    const f = { id: uid('f'), name: String(name || '未命名文件夹').slice(0, 100), createdAt: Date.now() };
    h.folders.push(f); await hubSet(h); return f;
  }
  async function renameFolder(id, name) {
    const h = await hubGet();
    const f = h.folders.find(f => f.id === id);
    if (f) { f.name = String(name || f.name).slice(0, 100); await hubSet(h); }
    return f;
  }
  async function moveToFolder(projectId, folderId) {
    const h = await hubGet();
    if (folderId == null || !h.folders.some(f => f.id === folderId)) delete h.folderOf[projectId];
    else h.folderOf[projectId] = folderId;
    await hubSet(h);
  }
  const listFolders = async () => (await hubGet()).folders;
  const rename = (id, name) => store.renameProject(id, name);
  const copy = (id, name) => store.duplicateProject(id, name);
  const trash = id => store.trashProject(id);         // 只打标记，可恢复
  const restore = id => store.untrashProject(id);
  const openProject = id => store.openProject(id);

  // ---------- 命名版本 ----------
  // 版本快照：归属固定项目命名空间（version:<pid>:<vid>），切项目也不会写错位置。
  // flush 遇跨标签冲突不阻断快照：版本本就用于留存草稿（含未落盘的本地稿）。
  async function saveVersion(name) {
    const p = store.project;
    if (!p) throw new Error('没有打开的项目');
    try { await store.flush(); }
    catch (e) { if (e?.code !== 'rev_conflict') throw e; }
    return saveVersionDoc(p.id, p, name);
  }
  // 对任意项目文档（含存储稿）写版本记录——恢复前自动快照「较新外部稿/本窗口未落盘稿」用
  async function saveVersionDoc(pid, doc, name) {
    const v = {
      id: uid('v'), projectId: pid, name: String(name || '未命名版本').slice(0, 200),
      createdAt: Date.now(), rev: doc.rev ?? 0,
      doc: clone({ name: doc.name, nodes: doc.nodes ?? [], edges: doc.edges ?? [], assets: doc.assets ?? {},
        studio: doc.studio ?? { version: 1, groups: [], shots: [], timeline: [], workflow: null } }),
    };
    await storage.set(vkey(pid, v.id), v);
    return v;
  }
  async function listVersions(pid = store.project?.id) {
    if (!pid) return [];
    const out = [];
    for (const k of (await storage.keys()).filter(k => k.startsWith(`version:${pid}:`))) {
      const v = await storage.get(k);
      if (v) out.push({ id: v.id, projectId: v.projectId, name: v.name, createdAt: v.createdAt, rev: v.rev });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  // 安全恢复：持久化互斥区内 读存储稿→检测外部写入→快照较新稿→恢复→CAS 写回。
  //  · 外部检测必须先于任何 flush：否则本窗口旧稿先盖住外部稿，检测永远失效且对方工作无快照
  //  · 检测到外部更新：自动快照的是「存储中的较新稿」；本窗口未落盘旧稿另存一份版本——双方草稿都可达
  //  · 每个 await 后重新核验 store.project 仍是恢复开始时的对象——切走即中止，
  //    绝不给新项目写自动快照、不改 lastOpened
  //  · 运行时事实（任务/未决/结果身份）按 nodeId 合并不回退；被运行时引用但旧快照未登记的
  //    素材记录保留（含 blob 键原样），付费完成结果不丢
  async function restoreVersion(versionId) {
    const p = store.project;
    if (!p) throw new Error('没有打开的项目');
    const pid = p.id;
    const alive = () => store.project === p;
    return withLock(`xp-restore:${pid}`, async () => {
      const stored0 = await storage.get(`project:${pid}`).catch(() => null);
      if (!alive()) throw new Error('项目已切换，恢复未提交');
      const v = await storage.get(vkey(pid, versionId));
      if (!alive()) throw new Error('项目已切换，恢复未提交');
      if (!v?.doc) throw new Error('版本不存在');
      const externalChanges = !!(stored0 && (stored0.rev ?? 0) > (p.rev ?? 0));
      let base = stored0;
      if (externalChanges) {
        await saveVersionDoc(pid, stored0, `恢复「${v.name}」前自动快照（含其他标签页更新）`);
        if (!alive()) throw new Error('项目已切换，恢复未提交');
        const localDiffers = JSON.stringify({ n: p.nodes, e: p.edges, a: p.assets, s: p.studio })
          !== JSON.stringify({ n: stored0.nodes, e: stored0.edges, a: stored0.assets, s: stored0.studio });
        if (localDiffers) {
          await saveVersionDoc(pid, p, `恢复「${v.name}」前自动快照（本窗口未落盘稿）`);
          if (!alive()) throw new Error('项目已切换，恢复未提交');
        }
      } else {
        try { await store.flush(); }
        catch (e) { if (e?.code !== 'rev_conflict') throw e; }
        if (!alive()) throw new Error('项目已切换，恢复未提交');
        base = await storage.get(`project:${pid}`).catch(() => null) ?? p;
        if (!alive()) throw new Error('项目已切换，恢复未提交');
        await saveVersionDoc(pid, base, `恢复「${v.name}」前自动快照`);
        if (!alive()) throw new Error('项目已切换，恢复未提交');
      }
      deps.editor?.checkpoint?.();
      const runtime = captureRuntime(p.nodes);
      const keepWorkflow = studioState(p).workflow;
      const oldAssets = p.assets ?? {};
      const doc = clone(v.doc);
      const baseRev = base?.rev ?? p.rev ?? 0;   // 以已快照的存储稿为授权基线
      p.name = doc.name ?? p.name;
      p.nodes = doc.nodes ?? [];
      p.edges = doc.edges ?? [];
      p.assets = doc.assets ?? {};
      p.studio = doc.studio ?? { version: 1, groups: [], shots: [], timeline: [], workflow: null };
      mergeRuntime(p.nodes, runtime);
      // 运行时事实引用的素材（版本后付费产出等）：恢复其登记记录，blob 键原样不动——
      // 不能只留 resultAssetId 却把 assets 登记清成旧快照
      const referenced = new Set();
      for (const n of p.nodes) {
        const d = n.data ?? {};
        if (typeof d.resultAssetId === 'string') referenced.add(d.resultAssetId);
        for (const x of Array.isArray(d.outputAssetIds) ? d.outputAssetIds : []) if (typeof x === 'string') referenced.add(x);
      }
      for (const id of referenced) if (oldAssets[id] && !p.assets[id]) p.assets[id] = oldAssets[id];
      p.studio.workflow = keepWorkflow ?? p.studio.workflow ?? null;
      if (p.studio.workflow?.status === 'running') p.studio.workflow.status = 'paused';  // 恢复出的运行态不自动续跑
      store.touch({ type: 'structure' });
      await store.flush({ baseRev });            // CAS：期间再有外部写则失败（外部稿已有快照）
      if (!alive()) throw new Error('项目已切换，恢复未提交');
      deps.onUpdate?.();
      return { restored: true, version: v.id, externalChanges };
    });
  }

  // ---------- 模板 ----------
  function stripAllRuntime(nodes) {
    for (const n of nodes) { for (const k of RUNTIME_KEYS) delete n.data[k]; delete n.data[BATCH_KEY]; }
  }
  async function saveTemplate(name, { kind = 'project', nodeIds } = {}) {
    const p = store.project;
    if (!p) throw new Error('没有打开的项目');
    let doc;
    if (kind === 'workflow') {
      const order = orderedGraph(p, nodeIds?.length ? nodeIds : null);
      const set = new Set(order);
      doc = {
        nodes: clone(p.nodes.filter(n => set.has(n.id))),
        edges: clone(p.edges.filter(e => set.has(e.from.node) && set.has(e.to.node))),
      };
      stripAllRuntime(doc.nodes);
    } else {
      doc = clone({ name: p.name, nodes: p.nodes, edges: p.edges, assets: p.assets, studio: studioState(p) });
      stripAllRuntime(doc.nodes);
      doc.studio.workflow = null;
    }
    const t = { id: uid('t'), name: String(name || '模板').slice(0, 200), kind, createdAt: Date.now(), doc };
    await storage.set(tkey(t.id), t);
    return t;
  }
  async function listTemplates() {
    const out = [];
    for (const k of (await storage.keys()).filter(k => k.startsWith('tpl:'))) {
      const t = await storage.get(k);
      if (t) out.push({ id: t.id, name: t.name, kind: t.kind, createdAt: t.createdAt });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  // 应用模板：project → 以模板新建项目并切换；workflow → 实例化进当前项目（全新节点 id、内部连线重映射）。
  async function applyTemplate(id) {
    const before = store.project;
    const t = await storage.get(tkey(id));
    if (!t?.doc) throw new Error('模板不存在');
    if (t.kind === 'project') {
      // 项目模板实例化 = 副本级克隆：全新节点/素材 id、全部引用重映射、blob 克隆到新键、
      // 导演台 KV 重键+令牌换绑——写副本 blob 绝不触碰源项目全局键。
      // 兼容旧模板（文档内仍是原 id——重映射在实例化时发生，不要求重新导入媒体）；
      // 任何一步失败仅清理本次新建键，当前项目与 lastOpened 不动。
      await store.flushForSwitch();
      const staged = await store.stageProjectClone(t.doc, {
        name: `${t.doc.name ?? t.name}（模板）`,
        guard: () => { if (store.project !== before) throw new Error('项目已切换，模板未应用'); },
      });
      try {
        if (store.project !== before) throw new Error('项目已切换，模板未应用');
        return await store.commitProject(staged.doc, staged.kv);
      } catch (e) { await staged.cleanup(); throw e; }
    }
    const p = store.project;
    if (!p) throw new Error('没有打开的项目');
    if (p !== before) throw new Error('项目已切换，模板未应用');
    deps.editor?.checkpoint?.();
    const map = new Map();
    const nodes = clone(t.doc.nodes).map(n => {
      const nid = uid(String(n.type)[0] ?? 'n'); map.set(n.id, nid); n.id = nid;
      stripAllRuntime([n]);
      if (n.type === 'asset' && !p.assets[n.data.assetId]) { n.data.assetId = null; n.data.needsRebind = true; }
      // @绑定只在当前项目确实存在该素材时保留，否则置空（不跨项目偷媒体身份）
      const fix = d => { if (d?.bindings) for (const k of Object.keys(d.bindings)) d.bindings[k] = p.assets[d.bindings[k]] ? d.bindings[k] : null; };
      fix(n.data); fix(n.data.draft);
      for (const sd of Object.values(n.data.perModel ?? {})) fix(sd);
      return n;
    });
    const edges = clone(t.doc.edges)
      .filter(e => map.has(e.from.node) && map.has(e.to.node))
      .map(e => ({ ...e, id: uid('e'), from: { ...e.from, node: map.get(e.from.node) }, to: { ...e.to, node: map.get(e.to.node) } }));
    p.nodes.push(...nodes); p.edges.push(...edges);
    store.touch({ type: 'structure' });
    try {
      await store.flush();
    } catch (e) {
      // 落盘失败：本次实例化的节点/边完整回滚，不污染当前工程
      const nids = new Set(nodes.map(n => n.id)), eids = new Set(edges.map(e => e.id));
      p.nodes = p.nodes.filter(n => !nids.has(n.id));
      p.edges = p.edges.filter(x => !eids.has(x.id));
      store.touch({ type: 'structure' });
      throw e;
    }
    deps.onUpdate?.();
    return nodes.map(n => n.id);
  }

  // ---------- 导入 / 导出 ----------
  // 导出任意项目（不切换当前项目）：项目文档 + 任务/未决 + 导演台 KV；无密钥、无 blob。
  async function exportProject(id) {
    const pid = id ?? store.project?.id;
    if (!pid) throw new Error('没有打开的项目');
    if (pid === store.project?.id) return store.exportJSON();
    const doc = await storage.get(`project:${pid}`);
    if (!doc) throw new Error('项目不存在');
    const tasks = [], pending = [], director = {};
    const nodeIds = new Set((doc.nodes ?? []).map(n => n.id));
    for (const k of await storage.keys()) {
      if (k.startsWith(`task:${pid}:`)) { const v = await storage.get(k); if (v) tasks.push(v); }
      else if (k.startsWith(`pending:${pid}:`)) { const v = await storage.get(k); if (v) pending.push(v); }
      else {
        const m = k.match(/^(dir|dircfg):([^:]+):/);
        if (m && nodeIds.has(m[2])) director[k] = await storage.get(k);
      }
    }
    const data = { format: 'xingpan-canvas@2', exportedAt: new Date().toISOString(), project: doc, tasks, pending, director };
    if (containsSecret(data)) throw new Error('导出被阻止：数据中存在疑似密钥字段，请先清理');
    return JSON.stringify({ ...data, note: '不含 API Key 与素材文件本体；素材需重新添加本地文件后生成。' }, null, 2);
  }
  const importProject = text => store.importJSON(text);

  // ---------- 面板 ----------
  let hubGeneration = 0;
  function open() {
    if (typeof document === 'undefined' || !document.getElementById) return null;
    let query = '', folder = '';
    const box = el('div', {});
    // 面板存活标记/代次：关闭一律由 ui.modal 的 onClose 回调通报（Esc/×/遮罩同路径）；
    // 在途异步回返若面板已关或已被新一轮渲染取代，不再写面板、不重开、不对新项目生效。
    let alive = true, epoch = 0;
    const instanceGeneration = ++hubGeneration;
    const live = () => alive && instanceGeneration === hubGeneration;
    const { close } = modal(el('div', {}, el('h3', { text: '项目中枢' }), box), { wide: true, onClose: () => { alive = false; } });
    const rerender = () => render(++epoch).catch(e => { if (live()) box.replaceChildren(el('p', { class: 'err-text', text: e.message })); });

    async function render(gen) {
      const stale = () => !live() || gen !== epoch;
      const [projects, trashed, folders, versions, templates, allProjects, conflictPids] = await Promise.all([
        listProjects({ query, folder: folder || undefined }), listProjects({ trashedOnly: true }),
        listFolders(), listVersions(), listTemplates(),
        store.listProjects({ includeTrashed: true }).catch(() => []),
        Promise.resolve(typeof store.listConflicts === 'function' ? store.listConflicts() : []).catch(() => []),
      ]);
      const nameOf = new Map(allProjects.map(p => [p.id, p.name]));
      const search = el('input', { type: 'search', placeholder: '搜索项目名…', value: query });
      search.addEventListener('input', () => { query = search.value; rerender(); });
      const fsel = el('select', {},
        el('option', { value: '', text: '全部项目', selected: !folder }),
        el('option', { value: '__none__', text: '未归档', selected: folder === '__none__' }),
        folders.map(f => el('option', { value: f.id, text: f.name, selected: folder === f.id })));
      fsel.addEventListener('change', () => { folder = fsel.value; rerender(); });
      const newFolder = el('button', { class: 'mini', type: 'button', text: '＋文件夹' });
      newFolder.addEventListener('click', async () => { await createFolder(`文件夹 ${folders.length + 1}`); rerender(); });

      const list = el('div', {});
      for (const p of projects) {
        const btn = (text, fn, cls = 'mini') => {
          const b = el('button', { class: cls, type: 'button', text });
          b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'err', 5000); } rerender(); });
          return b;
        };
        const fmove = el('select', { class: 'mini' },
          el('option', { value: '', text: '未归档' }),
          folders.map(f => el('option', { value: f.id, text: f.name, selected: p.folderId === f.id })));
        fmove.addEventListener('change', async () => { await moveToFolder(p.id, fmove.value || null); rerender(); });
        list.append(el('div', { class: 'task-item' },
          el('div', { class: 'row' }, el('b', { text: p.name }), p.id === store.project?.id ? el('span', { class: 'badge ok', text: '当前' }) : null,
            el('span', { class: 'muted', text: `r${p.rev ?? 0} · ${fmtTime(p.updatedAt)}` })),
          el('div', { class: 'row actions' },
            btn('打开', () => openProject(p.id).then(() => deps.onUpdate?.())),
            btn('重命名', async () => { await rename(p.id, `${p.name}-改`); }),
            btn('副本', () => copy(p.id)),
            btn('回收站', async () => {
              if (typeof confirmDialog === 'function' && !(await confirmDialog('移入回收站？', el('p', { text: '项目内容、任务与素材记录全部保留，可随时恢复。' })))) return;
              await trash(p.id);
            }),
            fmove)));
      }
      if (!projects.length) list.append(el('p', { class: 'hint', text: '没有匹配的项目' }));

      const trashBox = el('div', {});
      if (trashed.length) {
        trashBox.append(el('h4', { text: '回收站' }));
        for (const p of trashed) {
          const b = el('button', { class: 'mini', type: 'button', text: '恢复' });
          b.addEventListener('click', async () => { await restore(p.id); rerender(); });
          trashBox.append(el('div', { class: 'row' }, el('span', { text: p.name }), el('span', { class: 'muted', text: fmtTime(p.trashedAt) }), b));
        }
      }

      const verBox = el('div', {}, el('h4', { text: '版本' }));
      const saveV = el('button', { class: 'mini', type: 'button', text: '保存当前为版本' });
      saveV.addEventListener('click', async () => { const v = await saveVersion(`快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`); toast(`已保存版本：${v.name}`, 'ok'); rerender(); });
      verBox.append(saveV);
      for (const v of versions) {
        const b = el('button', { class: 'mini', type: 'button', text: '恢复' });
        b.addEventListener('click', async () => {
          const r = await restoreVersion(v.id);
          toast(r.externalChanges ? '已恢复；检测到其他标签页曾有写入，恢复前状态已另存为快照' : `已恢复到「${v.name}」`, 'ok', 5000);
          rerender();
        });
        verBox.append(el('div', { class: 'row' }, el('span', { text: v.name }), el('span', { class: 'muted', text: `${fmtTime(v.createdAt)} · r${v.rev}` }), b));
      }

      const tplBox = el('div', {}, el('h4', { text: '模板' }));
      const saveT = el('button', { class: 'mini', type: 'button', text: '存为项目模板' });
      saveT.addEventListener('click', async () => { await saveTemplate(`${store.project?.name ?? '项目'}模板`, { kind: 'project' }); toast('已存为项目模板', 'ok'); rerender(); });
      tplBox.append(saveT);
      for (const t of templates) {
        const b = el('button', { class: 'mini', type: 'button', text: t.kind === 'project' ? '新建项目' : '加入画布' });
        b.addEventListener('click', async () => { await applyTemplate(t.id); deps.onUpdate?.(); rerender(); });
        tplBox.append(el('div', { class: 'row' }, el('span', { text: t.name }), el('span', { class: 'muted', text: `${t.kind === 'project' ? '项目' : '工作流'} · ${fmtTime(t.createdAt)}` }), b));
      }

      const io = el('div', { class: 'modal-actions' });
      const exp = el('button', { type: 'button', text: '导出当前项目 JSON' });
      exp.addEventListener('click', async () => {
        try {
          const text = await exportProject();
          const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: `${store.project?.name ?? '项目'}.canvas.json` });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } catch (e) { toast(`导出失败：${e.message}`, 'err'); }
      });
      const imp = el('button', { type: 'button', text: '导入 JSON' });
      imp.addEventListener('click', () => {
        const inp = el('input', { type: 'file', accept: '.json,application/json' });
        inp.addEventListener('change', async () => {
          try { const p = await importProject(await inp.files[0].text()); deps.onUpdate?.(); toast(`导入完成：${p.name}`, 'ok', 5000); }
          catch (e) { toast(`导入失败：${e.message}`, 'err', 6000); }
        });
        inp.click();
      });
      io.append(exp, imp);

      // 本地冲突清单（功能恢复入口）：其他标签页/窗口写入了更新的存储稿，本窗口草稿被
      // CAS 拒收但完整保留。绝不默认覆盖/丢弃，只提供两个显式操作；语义由
      // store.resolveConflict 保证：'saveCopy' → {copyId}（本地稿另存独立副本、源项目
      // 载入外部稿并清冲突）；'reload' → {reloaded:true}（载入外部稿、本地快照保留可再另存）。
      const conflictRows = [];
      for (const pid of conflictPids) {
        const c = typeof store.getConflict === 'function' ? await Promise.resolve(store.getConflict(pid)).catch(() => null) : { projectId: pid };
        if (!c) continue;   // 渲染间隙冲突已被解决——跳过
        let busy = false;
        const saveBtn = el('button', { class: 'mini', type: 'button', text: '另存本地副本' });
        const loadBtn = el('button', { class: 'mini', type: 'button', text: '加载外部版本（保留本地草稿）' });
        loadBtn.disabled = pid !== store.project?.id;
        if (loadBtn.disabled) loadBtn.title = '请先打开该项目，再加载外部版本';
        const btns = [saveBtn, loadBtn];
        const act = async mode => {
          if (busy || !live() || typeof store.resolveConflict !== 'function') return;
          busy = true;
          for (const b of btns) b.disabled = true;          // 操作中禁重点击
          const projAtStart = store.project, g0 = epoch;    // capture 当前项目与面板代次
          try {
            const result = await store.resolveConflict(pid, mode);
            toast(mode === 'saveCopy'
              ? (result?.remainingLocalChanges ? '本地草稿已另存副本；另存期间还有更新，当前草稿继续保留' : '已把本地草稿另存为独立副本')
              : '已加载外部版本；本地草稿快照仍保留，可随时另存副本', 'ok', 5200);
            // 只有「解决的正是当前项目且期间未切走」才刷新画布——绝不为新项目生效
            if (live() && g0 === epoch && projAtStart && store.project === projAtStart && pid === projAtStart.id) deps.onUpdate?.();
          } catch (e) {
            saveBtn.disabled = false;
            loadBtn.disabled = pid !== store.project?.id;
            toast(`冲突处理未完成：${e?.message ?? e}；本地草稿已保留，可重试`, 'err', 6000);
          }
          if (live() && g0 === epoch) rerender();            // 面板已关/已有更新渲染：不重开不写
          else for (const b of btns) b.disabled = false;
          busy = false;
        };
        saveBtn.addEventListener('click', () => act('saveCopy'));
        loadBtn.addEventListener('click', () => act('reload'));
        conflictRows.push(el('div', { class: 'task-item' },
          el('div', { class: 'row' },
            el('b', { text: nameOf.get(pid) ?? `项目 ${pid}` }),
            pid === store.project?.id ? el('span', { class: 'badge warn', text: '当前项目' }) : null,
            c.blocking ? el('span', { class: 'badge err', text: '保存被阻塞' }) : null),
          el('div', { class: 'row muted' },
            el('span', { text: `外部稿 r${c.storedRev ?? '—'} · ${fmtTime(c.at)}` })),
          el('div', { class: 'row actions' }, saveBtn, loadBtn)));
      }
      const conflictBox = el('div', {});
      if (conflictRows.length) {
        conflictBox.append(
          el('h4', { text: '本地冲突' }),
          el('p', { class: 'hint', text: '检测到其他标签页/窗口写入了更新版本；本地草稿完整保留，不会自动覆盖或丢弃：' }),
          ...conflictRows);
      }
      if (stale()) return;
      box.replaceChildren(
        el('div', { class: 'row' }, search, fsel, newFolder),
        conflictBox, list, trashBox, verBox, tplBox, io);
    }
    rerender();
    return { close };
  }

  return {
    open,
    listProjects, createFolder, renameFolder, moveToFolder, listFolders,
    rename, copy, trash, restore, openProject,
    saveVersion, listVersions, restoreVersion,
    saveTemplate, listTemplates, applyTemplate,
    exportProject, importProject,
  };
}
