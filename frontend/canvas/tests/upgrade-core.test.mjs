// 升级核心域回归：schema 缺失引用/工作流导入清洗、store 修订号/副本/回收站、
// editor 运行时事实隔离、版本安全恢复、模板、DAG 工作流（批量克隆/预算/暂停/重试/持久化守卫）。
// 全部内存 fake + 模拟 runner/generators/tools，无网络、无真实密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createEditor } from '../src/editor.js';
import { createWorkflow } from '../src/workflow.js';
import { createProjectHub } from '../src/project-hub.js';
import { outputOf, importStudio, studioState, parseCSV } from '../src/studio-schema.js';
import { setCapabilities, estimateCost, nodeOutputs } from '../src/capabilities.js';
import * as keys from '../src/keyvault.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);
const MODEL = 'minimax-h3-768p-per-second';
const draft = (over = {}) => ({ model: MODEL, intent: 'text', prompt: '镜头测试', seconds: 5, ratio: '16:9', switches: {}, ...over });

async function fixture(t, key) {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('核心升级');
  if (key) await keys.setKey(key);
  t.after(async () => { await store.flush().catch(() => {}); keys.clearKey(); });
  return { storage, store };
}

// 模拟任务域：submit 落任务记录（默认 completed）、download 把本地素材挂回节点
function wfDeps(store, storage, over = {}) {
  const calls = { submit: 0, generate: [], execute: [], download: 0, detach: 0, adopt: 0 };
  const runner = {
    async submit(node) {
      calls.submit++;
      if (over.onSubmit) return over.onSubmit(node, calls.submit);
      const taskId = `task-${calls.submit}`;
      node.data.run = { taskId };
      await store.saveTask({ taskId, projectId: over.projectId ?? store.project.id, nodeId: node.id, model: node.data.draft?.model ?? MODEL, status: over.taskStatus ?? 'completed', keyFp: keys.getFingerprint(), createdAt: Date.now() });
    },
    async adoptDurable(node) {
      calls.adopt++;
      const t = (await store.tasksOfProject()).find(t => t.nodeId === node.id && !t.detached);
      if (t) { node.data.run = { taskId: t.taskId }; return true; }
      const p = (await store.listPending()).filter(r => r.nodeId === node.id && r.state !== 'rejected').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
      if (p) { node.data.run = { pendingKey: p.idempotencyKey }; return true; }
      return false;
    },
    async recOf(id, pid) { return store.taskIn(pid ?? store.project.id, id); },
    async download(taskId) {
      calls.download++;
      const rec = await store.taskIn(over.projectId ?? store.project.id, taskId);
      if (!rec) return null;
      const aid = `a_${taskId}`;
      const blob = new Blob([new Uint8Array([0,0,0,0,102,116,121,112,0,0])], { type: 'video/mp4' });
      await storage.setBlob('blob:' + aid, blob);
      store.project.assets[aid] = { id: aid, name: '成片', kind: 'video', mime: 'video/mp4', size: blob.size, fromTask: taskId, addedAt: 1 };
      const n = store.node(rec.nodeId);
      if (n) n.data.resultAssetId = aid;
      store.touch();
      return true;
    },
    async detach(node) {
      calls.detach++;
      const r = node.data.run;
      if (r?.taskId) { const t = await store.task(r.taskId); if (t && t.nodeId === node.id) { t.detached = true; await store.saveTask(t); } }
      node.data.run = null;
      return true;
    },
    resumeAll() {}, isBusy() { return false; }, cancelUpload() {},
    // 与 gennode.wired 同一合同：nodeOutputs 直读 outputOf 语义，覆盖 asset/gen/image/utility/text 全部来源
    wired(nodeId, port) {
      const items = [], problems = [];
      for (const e of store.edgesInto(nodeId, port)) {
        const src = store.node(e.from.node);
        if (!src) { problems.push('来源节点已删除'); continue; }
        if (src.type === 'asset' && !src.data.assetId) { problems.push('素材节点未绑定文件'); continue; }
        const out = nodeOutputs(store.project, src);
        problems.push(...out.missing);
        items.push(...out.assets);
      }
      return { items, problems };
    },
  };
  const generators = {
    quote(node) { if (node.type === 'image') return 0.5; if (node.type === 'text' && node.data.model) return 0.1; return null; },
    async generate(node) {
      calls.generate.push(node.id);
      if (over.onGenerate) return over.onGenerate(node);
      if (node.type === 'text') { node.data.resultText = '生成:' + (node.data.prompt ?? node.data.fedText ?? node.data.text ?? ''); node.data.operation = { state: 'completed' }; }
      else { const aid = `img_${node.id}`; store.project.assets[aid] = { id: aid, name: '图', kind: 'image', mime: 'image/png', size: 5, addedAt: 1 }; node.data.resultAssetId = aid; node.data.operation = { state: 'completed' }; }
    },
  };
  const tools = {
    async execute(node) {
      calls.execute.push(node.id);
      if (over.onExecute) return over.onExecute(node, calls.execute.length);
      node.data.outputText = '工具输出'; node.data.outputAssetIds = [];
      return { text: '工具输出', assets: [] };
    },
  };
  return { calls, deps: { store, storage, runner, generators, tools, pollMs: 2, submitLock: async (n, fn) => fn(), onUpdate() {}, ...(over.deps ?? {}) } };
}
const genNode = (store, over = {}) => store.addNode('gen', 0, 0, { draft: draft(), perModel: {}, ...over });

// ---------- schema：缺失引用与导入清洗 ----------

test('schema：outputOf 保留缺失素材占位引用，不静默丢引用', async t => {
  const { store } = await fixture(t);
  const node = store.addNode('image', 0, 0, { model: 'm', prompt: 'x', resultAssetId: 'gone-asset' });
  const out = outputOf(store.project, node);
  assert.equal(out.assets.length, 1);
  assert.equal(out.assets[0].missing, true);
  assert.equal(out.missing[0].id, 'gone-asset');
  const an = store.addNode('asset', 0, 0, { assetId: 'also-gone' });
  assert.equal(outputOf(store.project, an).assets[0].missing, true);
  await store.flush();
});

test('schema：工作流运行态导入降级为 paused/pending，节点键全量重映射，meta 白名单', async t => {
  const { store } = await fixture(t);
  const n = store.addNode('gen', 0, 0, { draft: draft() });
  const wf = {
    id: 'r1', status: 'running', budgetYuan: 9, estimatedYuan: 3, spentYuan: 1, targets: [n.id],
    cursor: { row: 0 }, issues: ['x'],
    rows: [{ id: 'row1', index: 0, fields: { 角色: '甲' }, status: 'running', nodeIds: [n.id] }],
    nodes: { [n.id]: { src: n.id, type: 'gen', status: 'waiting', taskId: 't9', pendingKey: null, cost: 3 } },
  };
  const nodeMap = new Map([[n.id, 'new-id']]);
  const out = importStudio({ groups: [], shots: [], timeline: [], workflow: wf, meta: { x_origin: 'libtv', 'bad key': 'drop', nested: { no: 1 } } }, nodeMap, new Map());
  assert.equal(out.workflow.status, 'paused');
  assert.equal(out.workflow.nodes['new-id'].status, 'pending');
  assert.equal(out.workflow.nodes['new-id'].taskId, 't9', '任务身份文本保留供人工核对');
  assert.equal(out.workflow.rows[0].nodeIds[0], 'new-id');
  assert.equal(out.workflow.targets[0], 'new-id');
  assert.deepEqual(out.meta, { x_origin: 'libtv' });
  await store.flush();
});

// ---------- store：修订号 / 回收站 / 副本 ----------

test('store：修订号单调递增，回收站非破坏且可恢复', async t => {
  const { store, storage } = await fixture(t);
  const p1 = store.project.rev;
  store.touch(); await store.flush();
  assert.ok(store.project.rev > p1);
  const pid = store.project.id;
  await store.trashProject(pid);
  assert.equal((await store.listProjects()).length, 0, '回收站项目不出现在默认列表');
  assert.equal((await store.listProjects({ includeTrashed: true })).length, 1);
  assert.ok(await storage.get(`project:${pid}`), '文档未被删除');
  await store.untrashProject(pid);
  assert.equal((await store.listProjects()).length, 1);
  await store.flush();
});

test('store：副本剥离运行时身份与任务记录，节点/导演台 KV 全量换新 id，原项目不动', async t => {
  const { store, storage } = await fixture(t, 'mock-dup-key');
  const n = genNode(store, { run: { taskId: 't-old' }, resultAssetId: 'a1' });
  const d = store.addNode('director', 0, 0, {});
  await storage.set(`dir:${d.id}:scene`, { objects: 3 });
  const origId = store.project.id;
  await store.saveTask({ taskId: 't-old', projectId: origId, nodeId: n.id, model: MODEL, status: 'completed', createdAt: 1 });
  await store.savePendingCreate({ idempotencyKey: 'k-old', projectId: origId, nodeId: n.id, model: MODEL, state: 'uncertain', createdAt: 1 });
  const copy = await store.duplicateProject(origId, '副本');
  assert.notEqual(copy.id, origId);
  const cn = copy.nodes.find(x => x.type === 'gen');
  assert.notEqual(cn.id, n.id);
  assert.equal(cn.data.run, undefined);
  assert.equal(cn.data.resultAssetId, undefined, '副本不继承结果身份');
  assert.equal((await store.tasksOfProject()).length, 0, '任务记录不随副本');
  assert.equal((await store.listPending()).length, 0);
  const cd = copy.nodes.find(x => x.type === 'director');
  assert.deepEqual(await storage.get(`dir:${cd.id}:scene`), { objects: 3 });
  const orig = await storage.get(`project:${origId}`);
  assert.equal(orig.nodes.find(x => x.id === n.id).data.run.taskId, 't-old', '原项目任务事实不变');
  await store.flush();
});

// ---------- editor：运行时事实隔离 ----------

test('editor：撤销不复活已清掉的运行时字段；粘贴剥离 batch 身份', async t => {
  const { store } = await fixture(t);
  const editor = createEditor(store);
  const n = genNode(store);
  const cur = () => store.node(n.id);       // undo 整体替换节点对象——必须重读，不能复用旧引用
  cur().data.run = { taskId: 't1' };
  editor.checkpoint();
  delete cur().data.run;                   // 任务事实被“认领转移”式清掉
  editor.checkpoint();
  cur().x = 99;
  editor.undo();
  assert.equal(cur().data.run, undefined, '已消失的运行时键不得复活');
  cur().data.run = { taskId: 't1' };
  editor.checkpoint();
  cur().data.draft.prompt = '改';
  editor.undo();
  assert.equal(cur().data.run.taskId, 't1', '存在的任务事实撤销后保留');
  cur().data.batch = { run: 'r', row: 'x', src: n.id };
  const [copy] = editor.duplicate([n.id]);
  assert.equal(copy.data.batch, undefined);
  assert.equal(copy.data.run, undefined);
  assert.equal(editor.state().canUndo, true);
  await store.flush();
});

// ---------- project-hub：版本 / 模板 / 搜索 ----------

test('hub：命名版本安全恢复——先自动快照，运行时不回退成旧事实', async t => {
  const { store, storage } = await fixture(t);
  const hub = createProjectHub({ store, storage, editor: createEditor(store) });
  const n = genNode(store, { run: { taskId: 't1' } });
  await hub.saveVersion('v1');
  store.node(n.id).data.run = { taskId: 't2' };          // 版本保存后又受理了新任务
  store.node(n.id).data.draft.prompt = '改过的';
  const note = store.addNode('note', 0, 0, { text: '后加的' });
  const r = await hub.restoreVersion((await hub.listVersions()).find(v => v.name === 'v1').id);
  assert.equal(r.restored, true);
  assert.equal(store.node(n.id).data.draft.prompt, '镜头测试');
  assert.equal(store.node(n.id).data.run.taskId, 't2', '较新的任务事实不得回退');
  assert.equal(store.node(note.id), null);
  assert.ok((await hub.listVersions()).some(v => v.name.includes('自动快照')), '恢复前必须自动快照');
  await store.flush();
});

test('hub：版本恢复保留版本文档自带的任务事实（节点曾被删除）', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('v2');
  const hub = createProjectHub({ store, storage });
  const n = genNode(store, { run: { taskId: 't-kept' } });
  await hub.saveVersion('v2');
  store.removeNode(n.id);
  await hub.restoreVersion((await hub.listVersions())[0].id);
  const back = store.project.nodes.find(x => x.id === n.id);
  assert.equal(back.data.run.taskId, 't-kept', '版本文档里的事实身份恢复可用');
  await store.flush();
});

test('hub：文件夹/搜索/重命名/回收站恢复；项目模板与工作流模板', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('模板源');
  const hub = createProjectHub({ store, storage, editor: createEditor(store) });
  const t1 = store.addNode('text', 0, 0, { text: '你好{{角色}}' });
  const g = genNode(store);
  store.addEdge(t1.id, 'out', g.id, 'prompt', 'text');
  const folder = await hub.createFolder('短片');
  await hub.moveToFolder(store.project.id, folder.id);
  assert.equal((await hub.listProjects({ folder: folder.id }))[0].id, store.project.id);
  assert.equal((await hub.listProjects({ query: '模板源' })).length, 1);
  assert.equal((await hub.listProjects({ query: '不存在' })).length, 0);
  await hub.rename(store.project.id, '改名');
  assert.equal(store.project.name, '改名');
  const tpl = await hub.saveTemplate('流程模板', { kind: 'workflow', nodeIds: [g.id] });
  const created = await hub.applyTemplate(tpl.id);
  assert.equal(created.length, 2, '工作流模板应实例化文本+生成两个节点');
  const newText = store.node(created.find(id => store.node(id).type === 'text'));
  assert.notEqual(newText.id, t1.id);
  assert.equal(newText.data.text, '你好{{角色}}', '模板字段保留供批量替换');
  const ptpl = await hub.saveTemplate('项目模板', { kind: 'project' });
  await hub.applyTemplate(ptpl.id);
  assert.match(store.project.name, /模板/);
  // 保存模板时项目里已有 原 gen + 工作流模板实例化的 gen = 2 个
  assert.equal(store.project.nodes.filter(n => n.type === 'gen').length, 2);
  await store.flush();
});

// ---------- workflow：DAG / 批量 / 预算 / 暂停 / 重试 / 守卫 ----------

test('workflow：preview 标出循环与缺失引用；start 无确认路径需 confirmed', async t => {
  const { store, storage } = await fixture(t);
  const { calls, deps } = wfDeps(store, storage);
  const wf = createWorkflow(deps);
  const a = store.addNode('text', 0, 0, { text: 'x' });
  const b = store.addNode('text', 0, 0, { text: 'y' });
  store.project.edges.push({ id: 'e1', from: { node: a.id, port: 'out' }, to: { node: b.id, port: 'prompt' }, order: 0 });
  store.project.edges.push({ id: 'e2', from: { node: b.id, port: 'out' }, to: { node: a.id, port: 'prompt' }, order: 0 });
  const pre = await wf.preview({ targets: [b.id] });
  assert.equal(pre.priceKind, 'standard');
  assert.ok(pre.fatal.some(i => /循环/.test(i)));
  await assert.rejects(wf.start({ targets: [b.id], confirmed: true }), /循环/);
  assert.equal(calls.submit, 0);
  // 无 DOM 且未 confirmed → 拒绝启动
  const savedDoc = globalThis.document; delete globalThis.document;
  const g = genNode(store);
  await assert.rejects(wf.start({ targets: [g.id] }), /确认/);
  globalThis.document = savedDoc;
  await store.flush();
});

test('workflow：CSV 行克隆独立节点跑批量；文本模板逐行替换；付费前先持久化', async t => {
  const { store, storage } = await fixture(t);
  let sawPersisted = false;
  const { calls, deps } = wfDeps(store, storage, {
    onGenerate: async node => {
      const doc = await storage.get(`project:${store.project.id}`);
      const ns = doc.studio.workflow.nodes[node.id];
      if (ns?.status === 'submitting') sawPersisted = true;   // 付费调用发生前运行态必须已落盘
      node.data.resultText = node.data.text;
      node.data.operation = { state: 'completed' };
    },
  });
  const wf = createWorkflow(deps);
  const n = store.addNode('text', 0, 0, { model: 'llm-x', text: '你好{{角色}}' });
  const rows = parseCSV('角色\n小明\n小红');
  const st = await wf.start({ targets: [n.id], rows, confirmed: true });
  assert.equal(st.status, 'done');
  assert.equal(st.rows.length, 2);
  assert.equal(calls.generate.length, 2);
  const clones = store.project.nodes.filter(x => x.data.batch?.run === st.id);
  assert.equal(clones.length, 2);
  assert.ok(clones.every(c => c.id !== n.id && c.data.batch.src === n.id));
  assert.deepEqual(clones.map(c => c.data.resultText).sort(), ['你好小明', '你好小红']);
  assert.equal(store.node(n.id).data.resultText, undefined, '原节点不被批量行改写');
  assert.equal(sawPersisted, true, '付费工作之前运行态已落盘');
  // 缺字段的行在预检即拒绝
  await assert.rejects(wf.start({ targets: [n.id], rows: [{ 名字: 'x' }], confirmed: true }), /缺少批量字段/);
  await store.flush();
});

test('workflow：媒体/文本接线由执行器直读 outputOf——权威 edges 与草稿不改写、无瞬态代理，再跑引用上游新产出', async t => {
  const { store, storage } = await fixture(t, 'mock-wf-key');
  const seenAssetIds = [], seenDraftPrompts = [], seenWireFrom = [], seenImagePrompts = [];
  const { calls, deps } = wfDeps(store, storage, {
    onGenerate: async node => {
      seenImagePrompts.push(node.data.prompt);
      const aid = `img_${node.id}_${calls.generate.length}`;
      const blob = new Blob(['image'], { type: 'image/png' });
      await storage.setBlob('blob:' + aid, blob);
      store.project.assets[aid] = { id: aid, name: '图', kind: 'image', mime: 'image/png', size: blob.size, addedAt: 1 };
      node.data.resultAssetId = aid; node.data.operation = { state: 'completed' };
    },
    onSubmit: async node => {
      const w = deps.runner.wired(node.id, 'refs');          // 与 gennode.wired 同一合同：nodeOutputs 直读上游产出
      seenAssetIds.push(w.items[0]?.id ?? null);
      seenDraftPrompts.push(node.data.draft.prompt);
      seenWireFrom.push(store.edgesInto(node.id, 'refs')[0]?.from.node ?? null);
      node.data.run = { taskId: `t-w${calls.submit}` };
      await store.saveTask({ taskId: `t-w${calls.submit}`, projectId: store.project.id, nodeId: node.id, model: MODEL, status: 'completed', keyFp: keys.getFingerprint(), createdAt: Date.now() });
    },
  });
  const txt = store.addNode('text', 0, 0, { text: '汇聚文本' });
  const img = store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', prompt: '首帧' });
  const g = genNode(store);
  store.addEdge(txt.id, 'out', g.id, 'prompt', 'text');
  store.addEdge(img.id, 'out', g.id, 'refs', 'image');
  const wf = createWorkflow(deps);
  const st = await wf.start({ targets: [g.id], confirmed: true });
  assert.equal(st.status, 'done');
  assert.equal(calls.submit, 1);
  assert.equal(calls.download, 1, '任务完成后必须下载为本地校验素材');
  assert.equal(seenAssetIds[0], `img_${img.id}_1`, 'runner.wired 直读上游 image 节点产出，无需瞬态代理');
  assert.equal(seenWireFrom[0], img.id, '提交期间权威连线保持原上游，无代理改写');
  assert.equal(seenDraftPrompts[0], '镜头测试', '草稿提示词不被汇聚文本覆盖（合并由 runner.effectivePrompt 负责）');
  assert.equal(seenImagePrompts[0], '首帧', 'image 草稿提示词同样不被改写');
  assert.ok(!store.project.nodes.some(n => n.data?.batch?.proxyFor), '不存在瞬态代理素材节点');
  // 显式第二次运行：先脱离旧任务允许重跑；上游新产出仍按原连线被引用
  await deps.runner.detach(g);
  const st2 = await wf.start({ targets: [g.id], confirmed: true });
  assert.equal(st2.status, 'done');
  assert.equal(calls.submit, 2);
  assert.equal(seenAssetIds[1], `img_${img.id}_2`, '上游新产出经原连线被引用');
  await store.flush();
});

test('workflow：本地文本节点按连线顺序汇聚上游文本+自身文本，草稿不改写；来源缺失显式失败', async t => {
  const { store, storage } = await fixture(t);
  const { deps } = wfDeps(store, storage);
  const wf = createWorkflow(deps);
  const a = store.addNode('text', 0, 0, { text: '上游A' });
  const c = store.addNode('text', 0, 0, { text: '上游C' });
  const b = store.addNode('text', 0, 0, { text: '自身B' });
  store.addEdge(a.id, 'out', b.id, 'prompt', 'text');
  store.addEdge(c.id, 'out', b.id, 'prompt', 'text');
  const st = await wf.start({ targets: [b.id], confirmed: true });
  assert.equal(st.status, 'done');
  assert.equal(store.node(b.id).data.resultText, '上游A\n\n上游C\n\n自身B', '上游按连线 order 在前，自身文本在后');
  assert.equal(store.node(b.id).data.text, '自身B', '自身草稿内容不被改写');
  assert.equal(store.node(a.id).data.resultText, '上游A');
  // 悬挂连线（来源节点已删除）→ 显式失败而不是静默丢输入
  store.project.edges.push({ id: 'e-ghost', from: { node: 'ghost-node', port: 'out' }, to: { node: b.id, port: 'prompt' }, order: 9 });
  await assert.rejects(() => wf.start({ targets: [b.id], confirmed: true }), /缺失/);
  await store.flush();
});

test('store：副本素材克隆独立身份——blob 内容复制，重绑副本不污染原项目', async t => {
  const { store, storage } = await fixture(t);
  store.project.assets['shared-a'] = { id: 'shared-a', name: '参考.png', kind: 'image', mime: 'image/png', size: 3, addedAt: 1 };
  await storage.setBlob('blob:shared-a', new Blob(['old-bytes']));
  store.addNode('asset', 0, 0, { assetId: 'shared-a' });
  const g = genNode(store);
  g.data.draft.bindings = { 'image:1': 'shared-a' };
  const d = store.addNode('director', 0, 0, {});
  await storage.set(`dir:${d.id}:scene`, { bg: 'xp-asset://shared-a' });
  const st = studioState(store.project);
  st.shots.push({ id: 'shot-1', title: 's', duration: 5, nodeId: g.id, assetIds: ['shared-a'] });
  st.timeline.push({ id: 'clip-1', assetId: 'shared-a', track: 'v1', kind: 'image', start: 0, end: 5 });
  st.assetCollections = [{ id: 'col-1', name: '合集', assetIds: ['shared-a'] }];
  const origId = store.project.id;
  await store.flush();
  const copy = await store.duplicateProject(origId, '副本');
  const copiedAid = copy.nodes.find(n => n.type === 'asset').data.assetId;
  assert.notEqual(copiedAid, 'shared-a');
  assert.equal(await (await storage.getBlob(`blob:${copiedAid}`)).text(), 'old-bytes', 'blob 内容克隆到新键');
  assert.equal(copy.nodes.find(n => n.type === 'gen').data.draft.bindings['image:1'], copiedAid);
  assert.equal(copy.studio.shots[0].assetIds[0], copiedAid);
  assert.equal(copy.studio.timeline[0].assetId, copiedAid);
  assert.equal(copy.studio.assetCollections[0].assetIds[0], copiedAid);
  const cd = copy.nodes.find(n => n.type === 'director');
  assert.equal((await storage.get(`dir:${cd.id}:scene`)).bg, `xp-asset://${copiedAid}`, '导演台 xp-asset 令牌换绑新素材');
  await storage.setBlob(`blob:${copiedAid}`, new Blob(['new-bytes']));
  assert.equal(await (await storage.getBlob('blob:shared-a')).text(), 'old-bytes', '副本重绑不覆盖原项目文件');
  const orig = await storage.get(`project:${origId}`);
  assert.equal(orig.nodes.find(n => n.type === 'asset').data.assetId, 'shared-a');
  await store.flush();
});

test('store：importJSON assetBlobs——按原 assetId 精确落盘；blob/KV 失败不切项目、清理暂存', async t => {
  const storage = createMemoryStorage();
  const s1 = createStore(storage);
  await s1.newProject('源');
  for (const [id, bytes] of [['a-one', 'AB'], ['a-two', 'CD']]) {
    s1.project.assets[id] = { id, name: '同名.png', kind: 'image', mime: 'image/png', size: 2, addedAt: 1 };
    s1.addNode('asset', id === 'a-one' ? 0 : 200, 0, { title: id, assetId: id });
  }
  const exported = await s1.exportJSON();
  const blobs = new Map([['a-one', new Blob(['AB'], { type: 'image/png' })], ['a-two', new Blob(['CD'], { type: 'image/png' })]]);

  // 精确映射：同名同型同大小不互换；返回 assets map + 回填的 assetIdMap
  const s2 = createStore(storage);
  const idMapOut = new Map();
  const imported = await s2.importJSON(exported, { assetBlobs: blobs, assetIdMap: idMapOut });
  const newA = imported.nodes.find(n => n.data.title === 'a-one').data.assetId;
  const newB = imported.nodes.find(n => n.data.title === 'a-two').data.assetId;
  assert.notEqual(newA, newB);
  assert.equal(idMapOut.get('a-one'), newA);
  assert.equal(await (await storage.getBlob(`blob:${newA}`)).text(), 'AB');
  assert.equal(await (await storage.getBlob(`blob:${newB}`)).text(), 'CD');
  assert.equal(imported.assets[newA].missing, false);

  // blob 暂存中途失败：当前项目/lastOpened 不动，已写新键被清理
  const s3 = createStore(storage);
  await s3.newProject('保底项目');
  const keepId = s3.project.id;
  const origSetBlob = storage.setBlob;
  const seen = [];
  storage.setBlob = async (k, v) => { seen.push(k); if (seen.length > 1) throw new Error('模拟磁盘已满'); return origSetBlob(k, v); };
  const idMapFail = new Map();
  await assert.rejects(() => s3.importJSON(exported, { assetBlobs: blobs, assetIdMap: idMapFail }), /磁盘|写入|失败/);
  assert.equal(s3.project.id, keepId, '当前项目未被切走');
  assert.equal(await storage.get('lastOpened'), keepId, 'lastOpened 未指向半成品');
  assert.equal(await storage.getBlob(seen[0]), undefined, '已暂存的 blob 键已清理');
  storage.setBlob = origSetBlob;

  // KV 提交失败：blob 暂存同样回滚
  const s4 = createStore(storage);
  await s4.newProject('再保底');
  const keep2 = s4.project.id;
  const origBatch = storage.batch;
  storage.batch = async () => { throw new Error('KV 写入失败'); };
  const idMapFail2 = new Map();
  await assert.rejects(() => s4.importJSON(exported, { assetBlobs: blobs, assetIdMap: idMapFail2 }), /KV|写入|失败/);
  assert.equal(s4.project.id, keep2);
  assert.equal(await storage.get('lastOpened'), keep2);
  for (const nid of idMapFail2.values()) assert.equal(await storage.getBlob(`blob:${nid}`), undefined, 'KV 失败时 blob 暂存回滚');
  storage.batch = origBatch;

  // 纯 JSON 路径不变：缺媒体的素材保持显式 missing 占位
  const s5 = createStore(storage);
  const plain = await s5.importJSON(exported);
  assert.ok(Object.values(plain.assets).every(a => a.missing === true));
  await s1.flush(); await s2.flush(); await s3.flush(); await s4.flush(); await s5.flush();
});

test('schema：importStudio 保留富时间线/分镜脚本/镜头版本/合集/分组几何，标识全量重映射', async t => {
  const { store } = await fixture(t);
  const n = store.addNode('gen', 0, 0, { draft: draft() });
  const nodeMap = new Map([[n.id, 'n-new']]);
  const assetMap = new Map([['old-a', 'new-a']]);
  const assets = { 'new-a': { id: 'new-a', kind: 'video', missing: false } };
  const input = {
    groups: [{ id: 'g1', title: '组', members: [n.id], x: 10, y: 20, w: 300, h: 200, color: '#ffcc00' }],
    shots: [{ id: 'shot-x', title: '01', duration: 8, nodeId: n.id, imageNodeId: n.id, assetIds: ['old-a', 'ghost'],
      versions: [{ id: 'v1', assetId: 'old-a', nodeId: n.id, at: 5, prompt: 'p' }],
      sync: { at: 7, nodeId: n.id, assetId: 'old-a', note: 's' }, syncedAt: 9 }],
    timeline: [
      { id: 'c1', assetId: 'old-a', track: 'v1', kind: 'video', name: '片', start: 1, end: 6, in: 2, speed: 1.5, volume: 0.7, muted: false, fadeIn: 0.5, fadeOut: 0.4, sourceDuration: 60 },
      { id: 'c2', track: 'ov1', kind: 'text', text: '字幕', x: 0.1, y: 0.6, w: 0.5, h: 0.2, fontSize: 0.08, color: '#ff0000', align: 'left', start: 0, end: 3 },
    ],
    timelineMeta: { width: 1920, height: 1080, fps: 24, background: '#112233' },
    storyboard: { script: '第一幕……' },
    assetCollections: [{ id: 'col1', name: '角色', assetIds: ['old-a', 'ghost'] }],
    workflow: null,
  };
  const out = importStudio(input, nodeMap, assetMap, assets);
  const c1 = out.timeline.find(c => c.id === 'c1');
  assert.equal(c1.assetId, 'new-a');
  assert.equal(c1.track, 'v1'); assert.equal(c1.in, 2); assert.equal(c1.speed, 1.5); assert.equal(c1.volume, 0.7);
  assert.equal(c1.fadeIn, 0.5); assert.equal(c1.sourceDuration, 60); assert.equal(c1.missing, false);
  const c2 = out.timeline.find(c => c.id === 'c2');
  assert.equal(c2.text, '字幕'); assert.equal(c2.color, '#ff0000'); assert.equal(c2.align, 'left');
  assert.deepEqual({ w: out.timelineMeta.width, h: out.timelineMeta.height, fps: out.timelineMeta.fps, bg: out.timelineMeta.background }, { w: 1920, h: 1080, fps: 24, bg: '#112233' });
  assert.equal(out.storyboard.script, '第一幕……');
  const shot = out.shots[0];
  assert.equal(shot.id, 'shot-x', '分镜 id 稳定：节点 params.shotId 引用不失效');
  assert.equal(shot.nodeId, 'n-new');
  assert.deepEqual(shot.assetIds, ['new-a', null], '缺失引用保留空位');
  assert.equal(shot.versions[0].assetId, 'new-a');
  assert.equal(shot.sync.nodeId, 'n-new');
  assert.equal(shot.syncedAt, 9);
  assert.equal(out.assetCollections[0].assetIds[0], 'new-a');
  assert.equal(out.assetCollections[0].assetIds.length, 1, '合集过滤悬空引用');
  assert.equal(out.groups[0].x, 10); assert.equal(out.groups[0].color, '#ffcc00');
  await store.flush();
});

test('editor：跨项目粘贴——媒体克隆独立身份、分镜/导演台引用重映射、付费身份剥离、失败不碰当前项目', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const editor = createEditor(store, storage);
  await store.newProject('源项目');
  const srcPid = store.project.id;
  store.project.assets['pa'] = { id: 'pa', name: '图.png', kind: 'image', mime: 'image/png', size: 4, addedAt: 1 };
  await storage.setBlob('blob:pa', new Blob(['png!'], { type: 'image/png' }));
  const an = store.addNode('asset', 0, 0, { assetId: 'pa' });
  const g = genNode(store, { run: { taskId: 't-src' }, resultAssetId: 'pa' });
  g.data.draft.bindings = { 'image:1': 'pa' };
  g.data.params = { shotId: 'shot-1' };
  const d = store.addNode('director', 200, 0, {});
  await storage.set(`dir:${d.id}:scene`, { bg: 'xp-asset://pa' });
  studioState(store.project).shots.push({ id: 'shot-1', title: '镜头一', duration: 5, nodeId: g.id, assetIds: ['pa'] });
  assert.equal(editor.copy([an.id, g.id, d.id]), 3);
  await store.newProject('目标项目');
  // 暂存写失败：当前项目完全不动，暂存键清理
  const n0 = store.project.nodes.length, a0 = Object.keys(store.project.assets).length;
  const origSetBlob = storage.setBlob;
  storage.setBlob = async () => { throw new Error('模拟盘满'); };
  await assert.rejects(() => editor.pasteAcrossProject(), /盘满/);
  assert.equal(store.project.nodes.length, n0);
  assert.equal(Object.keys(store.project.assets).length, a0);
  storage.setBlob = origSetBlob;
  // 成功路径
  const pasted = await editor.pasteAcrossProject();
  assert.equal(pasted.length, 3);
  const pa2 = pasted.find(n => n.type === 'asset');
  const pg = pasted.find(n => n.type === 'gen');
  const pd = pasted.find(n => n.type === 'director');
  const newAid = pa2.data.assetId;
  assert.notEqual(newAid, 'pa');
  assert.equal(await (await storage.getBlob(`blob:${newAid}`)).text(), 'png!');
  assert.equal(store.project.assets[newAid].missing, false);
  assert.equal(pg.data.draft.bindings['image:1'], newAid);
  assert.equal(pg.data.run, undefined, '付费任务身份剥离');
  assert.equal(pg.data.resultAssetId, undefined);
  assert.equal(pg.data.params.shotId, 'shot-1');
  const shot = store.project.studio.shots.find(s => s.id === 'shot-1');
  assert.equal(shot.nodeId, pg.id);
  assert.equal(shot.assetIds[0], newAid);
  assert.equal((await storage.get(`dir:${pd.id}:scene`)).bg, `xp-asset://${newAid}`);
  // 源项目与源 blob 不动
  const srcDoc = await storage.get(`project:${srcPid}`);
  assert.equal(srcDoc.nodes.find(n => n.id === g.id).data.run.taskId, 't-src');
  assert.equal(await (await storage.getBlob('blob:pa')).text(), 'png!');
  // 同项目同步粘贴不受影响
  assert.equal(editor.copy([pg.id]), 1);
  const again = editor.paste();
  assert.equal(again.length, 1);
  assert.equal(again[0].data.draft.bindings['image:1'], newAid, '同项目粘贴沿用本项目素材身份');
  await store.flush();
});

test('editor：跨项目粘贴物化选区外上游——素材克隆、文本快照、缺失显式占位且不丢线', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const editor = createEditor(store, storage);
  await store.newProject('源');
  store.project.assets['up-a'] = { id: 'up-a', name: '上游.png', kind: 'image', mime: 'image/png', size: 2, addedAt: 1 };
  await storage.setBlob('blob:up-a', new Blob(['PX'], { type: 'image/png' }));
  const a = store.addNode('asset', 0, 0, { assetId: 'up-a' });
  const t1 = store.addNode('text', 0, 0, { text: '上游提示词' });
  const dead = store.addNode('asset', 0, 0, { assetId: 'ghost-asset' });   // 无素材记录 → 缺失输出
  const g = genNode(store, { draft: draft({ intent: 'refs' }) });
  const g2 = genNode(store, { x: 500 });
  store.addEdge(a.id, 'out', g.id, 'refs', 'image');
  store.addEdge(t1.id, 'out', g.id, 'prompt', 'text');
  store.addEdge(dead.id, 'out', g2.id, 'refs', 'image');
  assert.equal(editor.copy([g.id, g2.id]), 2);
  await store.newProject('目标');
  const pasted = await editor.pasteAcrossProject();
  assert.equal(pasted.length, 5, '2 个选区节点 + 3 个物化上游来源节点');
  const pg = pasted.find(n => n.type === 'gen' && n.data.draft.intent === 'refs');
  const pg2 = pasted.find(n => n.type === 'gen' && n !== pg);
  const rIn = store.edgesInto(pg.id, 'refs');
  assert.equal(rIn.length, 1, '上游素材连线被物化保留（不得静默退化成纯文本输入）');
  const am = store.node(rIn[0].from.node);
  assert.equal(am.type, 'asset');
  const naid = am.data.assetId;
  assert.ok(naid && store.project.assets[naid] && store.project.assets[naid].missing === false);
  assert.equal(await (await storage.getBlob(`blob:${naid}`)).text(), 'PX');
  const pIn = store.edgesInto(pg.id, 'prompt');
  assert.equal(pIn.length, 1);
  const tn = store.node(pIn[0].from.node);
  assert.equal(tn.type, 'text');
  assert.equal(tn.data.text, '上游提示词');
  const rIn2 = store.edgesInto(pg2.id, 'refs');
  assert.equal(rIn2.length, 1, '缺失输出也保留显式占位而不是丢线');
  const am2 = store.node(rIn2[0].from.node);
  assert.equal(am2.data.assetId, null);
  assert.equal(am2.data.needsRebind, true);
  // 缺失占位使下游在预检/提交中被显式阻止
  const { deps } = wfDeps(store, storage);
  const wf = createWorkflow(deps);
  const pre = await wf.preview({ targets: [pg2.id] });
  assert.ok(pre.issues.length || pre.fatal.length, '缺失上游在预检中可见');
  await store.flush();
});

test('editor：仅复制导演台——KV 内 xp-asset 引用随包收集克隆、全量换绑，源项目不动', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const editor = createEditor(store, storage);
  await store.newProject('源');
  store.project.assets['kv-a'] = { id: 'kv-a', name: '场景.glb', kind: 'file', mime: 'model/gltf-binary', size: 4, addedAt: 1 };
  await storage.setBlob('blob:kv-a', new Blob(['glTF'], { type: 'model/gltf-binary' }));
  const d = store.addNode('director', 0, 0, { title: '布景' });
  await storage.set(`dir:${d.id}:scene`, { bg: 'xp-asset://kv-a' });
  await storage.set(`dir:${d.id}:broken`, { x: 'xp-asset://no-such' });
  const srcPid = store.project.id;
  assert.equal(editor.copy([d.id]), 1);   // 没有任何节点 data 引用 kv-a——只能靠 KV 扫描收集
  await store.newProject('目标');
  const pasted = await editor.pasteAcrossProject();
  const pd = pasted.find(n => n.type === 'director');
  const comp = await storage.get(`dir:${pd.id}:scene`);
  const m = /^xp-asset:\/\/(.+)$/.exec(comp?.bg ?? '');
  assert.ok(m && m[1] !== 'kv-a', 'KV 令牌换新 id');
  const a = store.project.assets[m[1]];
  assert.ok(a && a.missing === false, '换绑目标是已注册的克隆素材，不残留旧项目未注册 id');
  assert.equal(await (await storage.getBlob(`blob:${a.id}`)).text(), 'glTF');
  const broken = await storage.get(`dir:${pd.id}:broken`);
  const bId = /^xp-asset:\/\/(.+)$/.exec(broken?.x ?? '')?.[1];
  const ba = store.project.assets[bId];
  assert.ok(ba && ba.missing === true, '源里不存在的素材落成显式 missing 占位而非旧 id');
  // 源侧不动
  assert.equal(await (await storage.getBlob('blob:kv-a')).text(), 'glTF');
  assert.equal((await storage.get(`dir:${d.id}:scene`)).bg, 'xp-asset://kv-a');
  assert.equal((await storage.get(`project:${srcPid}`)).nodes.length, 1);
  await store.flush();
});

test('editor：跨项目粘贴落盘失败——新增节点/边/素材/分镜/KV/blob 全部回滚，剪贴板保留可重试', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const editor = createEditor(store, storage);
  await store.newProject('源');
  store.project.assets['fa'] = { id: 'fa', name: 'f.png', kind: 'image', mime: 'image/png', size: 2, addedAt: 1 };
  await storage.setBlob('blob:fa', new Blob(['F'], { type: 'image/png' }));
  const an = store.addNode('asset', 0, 0, { assetId: 'fa' });
  const g = genNode(store);
  g.data.params = { shotId: 'sh-f' };
  store.addEdge(an.id, 'out', g.id, 'refs', 'image');
  const d = store.addNode('director', 0, 0, {});
  await storage.set(`dir:${d.id}:scene`, { v: 1 });
  studioState(store.project).shots.push({ id: 'sh-f', title: 'x', duration: 5, nodeId: g.id, assetIds: ['fa'] });
  assert.equal(editor.copy([g.id, d.id]), 2);
  await store.newProject('目标');
  const n0 = store.project.nodes.length, e0 = store.project.edges.length;
  const a0 = Object.keys(store.project.assets).length, s0 = (store.project.studio?.shots ?? []).length;
  const rawSet = storage.set, rawSB = storage.setBlob;
  const staged = [];
  storage.setBlob = async (k, v) => { staged.push(k); return rawSB(k, v); };
  let armed = true;
  storage.set = async (k, v) => { if (armed && String(k).startsWith('project:')) { armed = false; throw new Error('模拟盘满'); } return rawSet(k, v); };
  await assert.rejects(() => editor.pasteAcrossProject(), /盘满/);
  storage.set = rawSet; storage.setBlob = rawSB;
  assert.equal(store.project.nodes.length, n0, '内存新增节点回滚');
  assert.equal(store.project.edges.length, e0, '内存新增连线回滚');
  assert.equal(Object.keys(store.project.assets).length, a0, '内存新增素材回滚');
  assert.equal((store.project.studio?.shots ?? []).length, s0, '内存新增分镜回滚');
  for (const k of staged) assert.equal(await storage.getBlob(k), undefined, '暂存 blob 键已清理');
  const strayKV = (await storage.keys()).filter(k => /^(dir|dircfg):/.test(k) && !k.startsWith(`dir:${d.id}:`) && !k.startsWith(`dircfg:${d.id}:`));
  assert.equal(strayKV.length, 0, '暂存 KV 键已清理');
  const doc = await storage.get(`project:${store.project.id}`);
  assert.equal(doc.nodes.length, n0, '目标项目文档已尽力回滚为干净态');
  const pasted = await editor.pasteAcrossProject();
  assert.ok(pasted.length >= 3, '剪贴板保留：重试成功（含物化上游来源节点）');
  await store.flush();
});

test('workflow：未知报价付费节点被阻止——未知≠免费，任何预算（含 0）都不放行', async t => {
  const { store, storage } = await fixture(t);
  let calls = 0;
  const deps = {
    store, storage, pollMs: 1, submitLock: async (n, fn) => fn(),
    runner: { async adoptDurable() {}, async recOf() { return null; }, async download() { return true; }, async detach() { return true; }, wired() { return { items: [], problems: [] }; } },
    generators: { quote: () => null, generate: async node => { calls++; node.data.resultText = 'x'; node.data.operation = { state: 'completed' }; } },
  };
  const wf = createWorkflow(deps);
  const n = store.addNode('text', 0, 0, { title: '未定价', model: 'm-x', text: 'hi' });
  const pre = await wf.preview({ targets: [n.id] });
  assert.equal(pre.unknownPaid, 1);
  const st = await wf.start({ targets: [n.id], budgetYuan: 0, confirmed: true });
  assert.equal(calls, 0, '未知报价不得按 0 元放行付费调用');
  const ns = Object.values(st.nodes)[0];
  assert.equal(ns.status, 'blocked');
  assert.equal(ns.reason, 'unpriced');
  const st2 = await wf.start({ targets: [n.id], confirmed: true });   // 无预算同样不放行
  assert.equal(calls, 0);
  assert.equal(Object.values(st2.nodes)[0].status, 'blocked');
  await store.flush();
});

test('workflow：微元精度记账——0.001 元不被舍入；越过预算即停，可显式改预算沿用同一 run 继续', async t => {
  const { store, storage } = await fixture(t);
  let calls = 0;
  const deps = {
    store, storage, pollMs: 1, submitLock: async (n, fn) => fn(),
    generators: { quote: () => 0.001, generate: async node => { calls++; node.data.resultText = 'ok'; node.data.operation = { state: 'completed' }; } },
  };
  const wf = createWorkflow(deps);
  const a = store.addNode('text', 0, 0, { title: 'A', model: 'm', text: 'a' });
  const b = store.addNode('text', 0, 0, { title: 'B', model: 'm', text: 'b' });
  store.addEdge(a.id, 'out', b.id, 'prompt', 'text');
  const st = await wf.start({ targets: [b.id], budgetYuan: 0.0015, confirmed: true });
  assert.equal(calls, 1, '第二笔 0.001 元会越过 0.0015 预算，不得放行');
  assert.equal(st.status, 'paused');
  assert.equal(st.estimatedSpendYuan, 0.001);
  const st2 = await wf.resume({ budgetYuan: 0.005 });
  assert.equal(calls, 2);
  assert.equal(st2.status, 'done');
  assert.equal(st2.id, st.id, '沿用同一 run，不新建运行');
  const aNs = st2.nodes[st2.rows[0].nodeIds[0]];
  assert.equal(aNs.status, 'done', '已完成节点不重跑');
  assert.equal(st2.estimatedSpendYuan, 0.002);
  await store.flush();
});

test('workflow：上游失败经 skipped 传递闭包——隔代付费节点同样不执行', async t => {
  const { store, storage } = await fixture(t);
  const calls = [];
  const deps = {
    store, storage, pollMs: 1, submitLock: async (n, fn) => fn(),
    generators: {
      quote: () => 1,
      generate: async node => { calls.push(node.data.title); if (node.data.title === 'A') throw new Error('模拟失败'); node.data.resultText = node.data.title; node.data.operation = { state: 'completed' }; },
    },
  };
  const wf = createWorkflow(deps);
  const a = store.addNode('text', 0, 0, { title: 'A', model: 'm', text: 'a' });
  const b = store.addNode('text', 0, 0, { title: 'B', model: 'm', text: 'b' });
  const c = store.addNode('text', 0, 0, { title: 'C', model: 'm', text: 'c' });
  store.addEdge(a.id, 'out', b.id, 'prompt', 'text');
  store.addEdge(b.id, 'out', c.id, 'prompt', 'text');
  const st = await wf.start({ targets: [c.id], confirmed: true });
  assert.deepEqual(calls, ['A'], '失败节点的后继（含隔代）一律不发起付费调用');
  assert.equal(st.status, 'failed');
  const stat = Object.fromEntries(Object.entries(st.nodes).map(([id, ns]) => [store.node(id)?.data?.title, ns.status]));
  assert.equal(stat.B, 'skipped');
  assert.equal(stat.C, 'skipped', 'skipped 必须继续向下游传播');
  await store.flush();
});

test('workflow：预算上限触发自动暂停，且绝不越过上限提交', async t => {
  const { store, storage } = await fixture(t, 'mock-budget-key');
  const { calls, deps } = wfDeps(store, storage);
  const g1 = genNode(store, { x: 0 });
  const g2 = genNode(store, { x: 400 });
  const wf = createWorkflow(deps);
  const cost = estimateCost(MODEL, 5);
  const st = await wf.start({ targets: [g1.id, g2.id], budgetYuan: cost * 1.5, confirmed: true });
  assert.equal(st.status, 'paused');
  assert.equal(calls.submit, 1, '第二个付费节点不得越过预算提交');
  const blocked = Object.values(st.nodes).find(n => n.status === 'blocked');
  assert.ok(blocked && /预算/.test(blocked.error));
  await store.flush();
});

test('workflow：未确认提交不自动重放——blocked 保持到人工处理，resume/retryRow 都不重发', async t => {
  const { store, storage } = await fixture(t, 'mock-uncertain-key');
  const { calls, deps } = wfDeps(store, storage, {
    onSubmit: async node => {
      node.data.run = { pendingKey: 'k-uncertain' };
      await store.savePendingCreate({ idempotencyKey: 'k-uncertain', projectId: store.project.id, nodeId: node.id, model: MODEL, state: 'uncertain', createdAt: Date.now() });
    },
  });
  const g = genNode(store);
  const wf = createWorkflow(deps);
  const st = await wf.start({ targets: [g.id], confirmed: true });
  assert.equal(st.status, 'failed');
  const ns = Object.values(st.nodes)[0];
  assert.equal(ns.status, 'blocked');
  assert.equal(ns.pendingKey, 'k-uncertain');
  assert.equal(calls.submit, 1);
  await wf.resume();
  assert.equal(calls.submit, 1, 'resume 不得重放未确认提交');
  await wf.retryRow(st.rows[0].id);
  assert.equal(calls.submit, 1, 'retryRow 不得重发 pendingKey 节点');
  await store.flush();
});

test('workflow：失败行只能显式重试；重试经由 runner.detach 脱离旧任务后再提交', async t => {
  const { store, storage } = await fixture(t, 'mock-retry-key');
  let failOnce = true;
  const { calls, deps } = wfDeps(store, storage, {
    onSubmit: async node => {
      if (failOnce) { failOnce = false; node.data.run = { taskId: 't-fail' }; await store.saveTask({ taskId: 't-fail', projectId: store.project.id, nodeId: node.id, model: MODEL, status: 'failed', keyFp: keys.getFingerprint(), createdAt: 1 }); return; }
      node.data.run = { taskId: 't-ok' };
      await store.saveTask({ taskId: 't-ok', projectId: store.project.id, nodeId: node.id, model: MODEL, status: 'completed', keyFp: keys.getFingerprint(), createdAt: 2 });
    },
  });
  const g = genNode(store);
  const wf = createWorkflow(deps);
  const st = await wf.start({ targets: [g.id], confirmed: true });
  assert.equal(st.status, 'failed');
  assert.equal(calls.submit, 1);
  assert.equal((await store.task('t-fail')).status, 'failed');
  const st2 = await wf.retryRow(st.rows[0].id);
  assert.equal(st2.status, 'done');
  assert.equal(calls.submit, 2);
  assert.equal(calls.detach, 1, '重试前必须把失败任务与节点脱离');
  assert.equal((await store.task('t-fail')).detached, true);
  await store.flush();
});

test('workflow：项目切换即停止调度，运行态写回原项目文档', async t => {
  const { store, storage } = await fixture(t, 'mock-switch-key');
  const p1 = store.project.id;
  await store.newProject('另一个');
  const p2 = store.project.id;
  await store.openProject(p1);
  const { calls, deps } = wfDeps(store, storage, {
    onSubmit: async node => {
      node.data.run = { taskId: 't-sw' };
      await store.saveTask({ taskId: 't-sw', projectId: p1, nodeId: node.id, model: MODEL, status: 'queued', keyFp: keys.getFingerprint(), createdAt: 1 });
      await store.openProject(p2);          // 提交期间切换项目
    },
    projectId: p1,
  });
  const g = genNode(store);
  const wf = createWorkflow(deps);
  const st = await wf.start({ targets: [g.id], confirmed: true });
  assert.equal(st.status, 'paused');
  assert.match(st.pauseReason ?? '', /变更/);
  const doc = await storage.get(`project:${p1}`);
  assert.equal(doc.studio.workflow.status, 'paused', '暂停事实写回原项目');
  assert.equal(calls.submit, 1);
  await store.flush();
});

test('workflow：密钥变更即停止调度', async t => {
  const { store, storage } = await fixture(t, 'mock-key-a');
  const { calls, deps } = wfDeps(store, storage, {
    onSubmit: async node => {
      node.data.run = { taskId: 't-kc' };
      await store.saveTask({ taskId: 't-kc', projectId: store.project.id, nodeId: node.id, model: MODEL, status: 'queued', keyFp: keys.getFingerprint(), createdAt: 1 });
      await keys.setKey('mock-key-b');       // 提交期间换密钥
    },
  });
  const g = genNode(store);
  const wf = createWorkflow(deps);
  const st = await wf.start({ targets: [g.id], confirmed: true });
  assert.equal(st.status, 'paused');
  assert.equal(calls.submit, 1);
  await store.flush();
});

test('workflow：首次持久化失败 → 不创建运行、不发任何付费请求', async t => {
  const { store, storage } = await fixture(t);
  const rawSet = storage.set;
  let armed = true;
  storage.set = async (k, v) => {
    if (armed && String(k).startsWith('project:') && String(JSON.stringify(v)).includes('"workflow"')) {
      armed = false;
      throw Object.assign(new Error('写入失败'), { name: 'QuotaExceededError' });
    }
    return rawSet(k, v);
  };
  const { calls, deps } = wfDeps(store, storage);
  const wf = createWorkflow(deps);
  const g = genNode(store);
  await assert.rejects(wf.start({ targets: [g.id], confirmed: true }), /写入失败/);
  assert.equal(calls.submit, 0);
  assert.equal(store.project.studio?.workflow, null, '未建成的运行不得残留');
  storage.set = rawSet;
  const st = await wf.start({ targets: [g.id], confirmed: true });
  assert.equal(st.status, 'done');
  assert.equal(calls.submit, 1);
  await store.flush();
});

test('workflow：导入的工作流运行态随导出往返且全部降级、键重映射', async t => {
  const { store, storage } = await fixture(t, 'mock-export-key');
  const g = genNode(store);
  studioState(store.project).workflow = {
    id: 'r-exp', status: 'running', createdAt: 1, updatedAt: 1, budgetYuan: 5,
    estimatedYuan: 2, spentYuan: 0, priceKind: 'standard', targets: [g.id], cursor: { row: 0 }, issues: [],
    rows: [{ id: 'row1', index: 0, fields: {}, status: 'running', nodeIds: [g.id], error: null }],
    nodes: { [g.id]: { src: g.id, type: 'gen', status: 'waiting', taskId: 't-x', pendingKey: null, cost: 2, error: null } },
  };
  const exported = await store.exportJSON();
  const s2 = createStore(storage);
  const imported = await s2.importJSON(exported);
  const ig = imported.nodes.find(n => n.type === 'gen');
  const wf = imported.studio.workflow;
  assert.equal(wf.status, 'paused');
  assert.equal(wf.nodes[ig.id].status, 'pending');
  assert.equal(wf.nodes[ig.id].taskId, 't-x');
  assert.equal(wf.rows[0].nodeIds[0], ig.id);
  assert.ok(!wf.nodes[g.id], '旧节点 id 不得残留为键');
  await store.flush(); await s2.flush();
});

// ---------- hub 面板冒烟（DOM 存根） ----------

test('workflow.panel / hub.open：最小 DOM 存根下可渲染可关闭', async t => {
  const mk = () => ({ children: [], className: '', style: {}, value: '', append(...c) { this.children.push(...c); }, prepend() {}, remove() {}, setAttribute() {}, addEventListener() {}, removeEventListener() {}, replaceChildren(...c) { this.children = c; }, querySelector() { return null; }, appendChild(c) { this.children.push(c); }, click() {}, focus() {} });
  globalThis.document = { createElement: mk, getElementById: () => mk(), addEventListener() {}, removeEventListener() {}, querySelector: () => null, body: mk() };
  globalThis.URL.createObjectURL ??= () => 'blob:mock';
  t.after(() => { delete globalThis.document; });
  const { store, storage } = await fixture(t);
  const { deps } = wfDeps(store, storage);
  const wf = createWorkflow(deps);
  const p = wf.panel();
  assert.ok(p && typeof p.close === 'function');
  p.close();
  const hub = createProjectHub({ store, storage });
  const h = hub.open();
  assert.ok(h && typeof h.close === 'function');
  h.close();
  await store.flush();
});
