// 发布侧交回核心的问题的独立测试（见 docs/canvas-release/0.5/release-to-core-requests.md）。
// 核心修复前这些测试按预期失败，使严格发布门禁保持阻断；发布侧不以跳过或删断言让其通过。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { getElementById: () => null, createElement: () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} }) };
const { createMemoryStorage } = await import('../src/storage.js');
const { createStore } = await import('../src/store.js');
const { createTaskRunner } = await import('../src/gennode.js');
const keys = await import('../src/keyvault.js');

test('R05-CORE-2：restoreTask 遇较新版本任务记录时不新增节点、不改写记录、不查询', async t => {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('core-2');
  await keys.setKey('synthetic-core-2'); t.after(() => keys.clearKey());
  const pid = store.project.id;
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: 'gone', model: 'mock', keyFp: keys.getFingerprint(), status: 'in_progress', executorVersion: 2, idempotencyKey: 'k' });
  const raw = await storage.get('task:' + pid + ':job');
  await storage.set('task:' + pid + ':job', { ...raw, recVersion: 3 });   // 较新客户端写入
  let gets = 0, posts = 0;
  const runner = createTaskRunner({ store, storage, assets: { remoteValid: () => true, blobOf: async () => null },
    api: { async getTask() { gets++; return {}; }, async createTask() { posts++; throw new Error('不得生成'); } } });
  const before = store.project.nodes.length;
  let result, error = null;
  try { result = await runner.restoreTask('job', pid); } catch (e) { error = e; }
  assert.equal(store.project.nodes.length, before, `不得新增「找回的生成任务」孤儿节点（结果：${result?.id ?? result}，错误：${error?.code ?? error?.message ?? '无'}）`);
  assert.equal(result ?? null, null, '只读记录返回 null（或等价的明确拒绝），而不是抛出后留下副作用');
  const stored = await storage.get('task:' + pid + ':job');
  assert.equal(stored.recVersion, 3); assert.equal(stored.nodeId, 'gone');
  assert.equal(gets + posts, 0);
});

test('R05-CORE-3：切换到其他项目再切回同一项目（同一密钥）后，暂停的工作流可以继续调度', async t => {
  const { setup, makeApi, makeRunner, makeWorkflow, genDraft, seedTask, sleep } = await import('./accept-helpers.mjs');
  const { storage, store, pid, fp } = await setup(t);
  let status = 'in_progress';
  const { api, calls } = makeApi({ getTask: async () => ({ status, executor_version: 2, content_ready: status === 'completed', stage: status === 'completed' ? 'succeeded' : 'running' }) });
  const runner = makeRunner({ store, storage, api });
  const wf = makeWorkflow({ store, storage, runner, pollMs: 30 });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'wjob', keyFp: fp, status: 'in_progress', executorVersion: 2 });
  node.data.run = { taskId: 'wjob' };
  await store.flush();
  const first = wf.start({ targets: [node.id], confirmed: true }).catch(e => e);
  for (let i = 0; i < 100 && wf.getState()?.nodes?.[node.id]?.status !== 'waiting'; i++) await sleep(20);
  assert.equal(wf.getState().nodes[node.id].status, 'waiting');
  // 与界面一致：flush → 新建项目（切走）→ openProject 切回原项目
  await store.flush(); await store.newProject('other');
  for (let i = 0; i < 100 && (await storage.get('project:' + pid))?.studio?.workflow?.status !== 'paused'; i++) await sleep(20);
  await first;
  await store.flush(); await store.openProject(pid);
  assert.equal(keys.getFingerprint(), fp, '密钥未变');
  status = 'completed';
  const resumed = wf.resume();
  await sleep(50);
  const st = wf.getState();
  assert.ok(!(st.issues ?? []).includes('项目或密钥已变更，无法继续调度'), `同一项目、同一密钥不应被判为已变更：${JSON.stringify(st.issues)}`);
  assert.equal(st.status, 'running', `应恢复调度，实际 ${st.status}（${st.pauseReason}）`);
  await resumed;
  assert.equal(calls.creates.length, 0, '续跑零生成 POST');
});

test('R05-CORE-4：页面刷新后遗留的「运行中」记录（原驱动已失效）可以由新页面一步继续', async t => {
  const { makeApi, makeRunner, makeWorkflow, genDraft, seedTask, sleep } = await import('./accept-helpers.mjs');
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('core-4'); await keys.setKey('synthetic-core-4');
  t.after(() => keys.clearKey());
  const pid = store.project.id, fp = keys.getFingerprint();
  const { api, calls } = makeApi({ getTask: async () => ({ status: 'completed', executor_version: 2, content_ready: true, stage: 'succeeded', delivery_status: 'ready' }) });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'wjob', keyFp: fp, status: 'in_progress', executorVersion: 2 });
  node.data.run = { taskId: 'wjob' };
  // 刷新前页面留下的持久化运行态：running，驱动者是已随页面销毁的旧实例，十分钟未有任何进展
  const nodes = { [node.id]: { src: node.id, type: 'gen', status: 'waiting', taskId: 'wjob', cost: 0.6, spendKey: 'wjob' } };
  store.project.studio ??= { version: 1, groups: [], shots: [], timeline: [], workflow: null };
  store.project.studio.workflow = { id: 'run_old', projectId: pid, keyFp: fp, driverId: 'drv_dead_page', driverAt: Date.now() - 600000,
    status: 'running', targets: [node.id], issues: [], rows: [{ id: 'row0', status: 'running', nodeIds: [node.id] }], nodes, cursor: { row: 0 },
    budgetYuan: null, estimatedSpendYuan: 0.6, createdAt: Date.now() - 600000, updatedAt: Date.now() - 600000 };
  await store.flush();
  // 刷新后的新页面：新 store / runner / workflow 实例（新 driverId）
  const store2 = createStore(storage); await store2.openProject(pid);
  const runner = makeRunner({ store: store2, storage, api });
  const wf = makeWorkflow({ store: store2, storage, runner, pollMs: 30 });
  const resumed = wf.resume().catch(e => e);
  await sleep(100);
  const st = wf.getState();
  assert.equal(st.status === 'running' || st.status === 'done', true, `应接管继续：${st.status}`);

  if (st.status === 'running') {
    for (let i = 0; i < 100 && wf.getState().nodes[node.id]?.status !== 'done'; i++) await sleep(30);
  }
  await resumed;
  assert.equal(wf.getState().nodes[node.id]?.status, 'done', `遗留运行应由新页面驱动完成：${JSON.stringify(wf.getState().nodes[node.id])}`);
  assert.equal(calls.creates.length, 0, '续跑零生成 POST');
});
