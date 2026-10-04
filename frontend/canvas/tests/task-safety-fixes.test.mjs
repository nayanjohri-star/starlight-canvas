// 任务安全修复回归：R01 跨实例原子提交、R02 超窗恢复守卫、R03 perModel 隔离、
// R09 Retry-After 以收到响应起算、R14 存储失败显态、R05/R13 restoreTask/restorePending。
// 全内存 fake + 读写克隆的共享存储替身，无网络、无真实密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createTaskRunner, applyModelSwitch } from '../src/gennode.js';
import { createSubmitLock, localRequest } from '../src/submit-lock.js';
import { setCapabilities, intentsFor } from '../src/capabilities.js';
import * as keys from '../src/keyvault.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);
const MODEL = 'minimax-h3-768p-per-second';
const WAN = 'wan-3.0';
const draft = (over = {}) => ({ model: MODEL, intent: 'text', prompt: '移动镜头展示桌面模型', seconds: 4, ratio: '16:9', switches: {}, ...over });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// toast/el 需要最小 DOM 存根（与既有测试相同做法）
const element = () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} });
globalThis.document = { createElement: element, getElementById: element };

// 读写克隆的共享存储替身：两个独立 store 模拟两个标签页，不经共享对象引用串数据
const cloneOf = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
function cloneStorage() {
  const base = createMemoryStorage();
  return {
    get: async k => cloneOf(await base.get(k)),
    set: async (k, v) => base.set(k, cloneOf(v)),
    del: k => base.del(k),
    keys: () => base.keys(),
    setIfRev: (k, rev, value) => base.setIfRev(k, rev, cloneOf(value)),
    getBlob: k => base.getBlob(k), setBlob: (k, v) => base.setBlob(k, v), delBlob: k => base.delBlob(k),
  };
}
const noUpload = { remoteValid: () => true, assetOfNode: () => null, async upload() { throw new Error('not used'); } };
const genData = (over = {}) => ({ draft: draft(), perModel: {}, ...over });

async function setup(t, keyName) {
  const storage = cloneStorage();
  const store = createStore(storage);
  await keys.setKey(keyName);
  keys.setAvailableModels([MODEL, WAN]);
  t.after(async () => { await store.flush(); keys.clearKey(); keys.setAvailableModels(null); });
  return { storage, store };
}

// ---------- R01：跨标签页原子提交 ----------

test('R01 两个独立 store/runner 并发提交同节点 → 仅一次 POST，失败方认领持久化记录', async t => {
  const { storage, store: s1 } = await setup(t, 'mock-r01-key');
  const s2 = createStore(storage);                       // 共享同一存储的第二个实例
  await s1.newProject('R01');
  const pid = s1.project.id;
  const n1 = s1.addNode('gen', 0, 0, genData());
  await s1.flush();
  await s2.openProject(pid);
  const n2 = s2.node(n1.id);
  assert.ok(n2, '第二个 store 应读到同一节点');

  let creates = 0;
  const mkApi = tag => ({
    createTask: async () => { creates++; await sleep(30); return { id: `task-${tag}`, status: 'queued' }; },
    getTask: async () => ({ status: 'completed' }),
  });
  const r1 = createTaskRunner({ store: s1, storage, api: mkApi('a'), assets: noUpload });
  const r2 = createTaskRunner({ store: s2, storage, api: mkApi('b'), assets: noUpload });
  await Promise.all([r1.submit(n1), r2.submit(n2)]);
  assert.equal(creates, 1, '跨实例并发提交必须互斥，只允许一个 POST');
  for (const r of [n1.data.run, n2.data.run])
    assert.ok(r?.taskId === 'task-a' || r?.taskId === 'task-b', '失败方必须认领持久化任务，而非各自创建');
});

test('submit-lock：注入 Web Locks 按其互斥；本地队列同名串行', async () => {
  const calls = [];
  const fake = { request: async (name, opts, cb) => { calls.push([name, opts?.mode]); return cb(); } };
  const lock = createSubmitLock({ locks: fake });
  assert.equal(lock.scope, 'cross-tab');
  assert.equal(await lock.request('k1', () => 7), 7);
  assert.deepEqual(calls, [['k1', 'exclusive']]);

  const order = [];
  await Promise.all([
    localRequest('a', async () => { await sleep(20); order.push('a1'); }),
    localRequest('a', async () => { order.push('a2'); }),
  ]);
  assert.deepEqual(order, ['a1', 'a2'], '同名本地锁必须串行');
});

test('submit-lock：无 Web Locks 的浏览器环境 fail closed', async () => {
  globalThis.window = { document: {} };
  try {
    const lock = createSubmitLock({ locks: null });
    assert.equal(lock.scope, 'unsupported');
    await assert.rejects(lock.request('x', () => 1), /Web Locks/);
  } finally { delete globalThis.window; }
});

// ---------- R02：超窗未决记录恢复守卫 ----------

test('R02 expired_window 未决记录：resumeAll 恢复禁发守卫；新实例锁内核查同样拦截', async t => {
  const { storage, store } = await setup(t, 'mock-r02-key');
  await store.newProject('R02');
  const node = store.addNode('gen', 0, 0, genData());
  const pid = store.project.id;
  const body = JSON.stringify({ model: MODEL, prompt: '原提示词', seconds: 4 });
  await store.savePendingCreate({
    idempotencyKey: 'k-expired', projectId: pid, nodeId: node.id, model: MODEL,
    keyFp: keys.getFingerprint(), bodyString: body, state: 'expired_window',
    createdAt: Date.now() - 25 * 3600 * 1000, lastSubmitAt: Date.now() - 25 * 3600 * 1000,
  });
  let creates = 0;
  const api = { createTask: async () => { creates++; return { id: 't-x', status: 'queued' }; }, getTask: async () => ({ status: 'completed' }) };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload });
  await runner.resumeAll();
  assert.equal(node.data.run?.pendingKey, 'k-expired', '超窗未决记录必须恢复禁发守卫');
  assert.equal(node.data.run?.expired, true);
  await runner.submit(node);
  assert.equal(creates, 0, '守卫存在时不得新建');

  // 等同导入后：另一 store 里节点 run 为空，未经 resumeAll 也不得新建
  await store.flush();
  const s2 = createStore(storage);
  await s2.openProject(pid);
  const n2 = s2.node(node.id);
  n2.data.run = null;                                    // 模拟导入后无 run 的节点
  const r2 = createTaskRunner({ store: s2, storage, api, assets: noUpload });
  await r2.submit(n2);
  assert.equal(creates, 0, '锁内持久化核查必须拦下重复创建');
  assert.equal(n2.data.run?.pendingKey, 'k-expired');
  assert.equal(n2.data.run?.expired, true);
});

// ---------- R09：Retry-After 以收到响应起算 ----------

test('R09 慢响应 + Retry-After：立即重试不得重发，retryNotBefore 已持久化', async t => {
  const { storage, store } = await setup(t, 'mock-r09-key');
  await store.newProject('R09');
  const node = store.addNode('gen', 0, 0, genData());
  let creates = 0;
  const api = {
    // 模拟耗时 ~1.2s 的请求，返回 429 + Retry-After: 1（秒）
    createTask: async () => { creates++; await sleep(1200); throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 1 }); },
    getTask: async () => ({ status: 'queued' }),
  };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload });
  await runner.submit(node);
  assert.equal(creates, 1);
  const rec = await store.pendingCreate(node.data.run.pendingKey);
  assert.ok(Number.isFinite(rec.retryNotBefore), '必须持久化 retryNotBefore');
  assert.ok(rec.retryNotBefore > Date.now(), '退避截止必须晚于响应到达时刻');
  await runner.retrySubmit(node);                        // 旧实现以发出时刻起算，此刻会错误重发
  assert.equal(creates, 1, '未到 retryNotBefore 不得再次 POST');
});

// ---------- R14：存储失败显式可恢复态 ----------

test('R14 pending 落盘失败 → 显式可恢复错误态，无 POST，修复存储后可重新提交', async t => {
  const { storage, store } = await setup(t, 'mock-r14-key');
  await store.newProject('R14');
  const node = store.addNode('gen', 0, 0, genData());
  const rawSet = storage.set;
  storage.set = async (k, v) => {
    if (String(k).startsWith('pending:')) throw Object.assign(new Error('磁盘空间不足'), { name: 'QuotaExceededError' });
    return rawSet(k, v);
  };
  let creates = 0;
  const runner = createTaskRunner({
    store, storage, assets: noUpload,
    api: { createTask: async () => { creates++; return { id: 't14', status: 'queued' }; }, getTask: async () => ({ status: 'completed' }) },
  });
  await runner.submit(node);
  assert.equal(creates, 0, 'pending 写不进去绝不能发 POST');
  assert.ok(node.data.run?.storageError, '必须进入显式存储失败态而不是卡在 uploading');
  assert.match(node.data.run?.error ?? '', /未发送/);
  assert.ok(!node.data.run?.pendingKey && !node.data.run?.taskId && !node.data.run?.state);
  storage.set = rawSet;
  await runner.submit(node);
  assert.equal(creates, 1, '存储恢复后应可正常重新提交');
  assert.equal(node.data.run?.taskId, 't14');
});

test('R14b 已落盘记录的更新失败 → 不发 POST 且保留守卫与记录', async t => {
  const { storage, store } = await setup(t, 'mock-r14b-key');
  await store.newProject('R14b');
  const node = store.addNode('gen', 0, 0, genData());
  const rawSet = storage.set;
  let pendingWrites = 0;
  storage.set = async (k, v) => {
    if (String(k).startsWith('pending:') && ++pendingWrites > 1)
      throw Object.assign(new Error('io error'), { name: 'QuotaExceededError' });
    return rawSet(k, v);
  };
  let creates = 0;
  const runner = createTaskRunner({
    store, storage, assets: noUpload,
    api: { createTask: async () => { creates++; return { id: 't14b', status: 'queued' }; } },
  });
  await runner.submit(node);
  assert.equal(creates, 0, '记录更新失败不得继续发 POST');
  const key = node.data.run?.pendingKey;
  assert.ok(key, '已落盘的 pending 守卫必须保留');
  assert.ok(await store.pendingCreate(key), '原始记录仍在，可恢复后同键重试');
});

// ---------- R03：perModel 不得覆盖型号/提示词 ----------

test('R03 型号切换：perModel 残留整份草稿/畸形数据不得覆盖所选型号与公共提示词', () => {
  const wm = table.models[WAN];
  const d = {
    draft: draft({ prompt: '保留这条提示词' }),
    perModel: {
      // 导入残留的“整份草稿”形态：含 model/prompt 字段，绝不能覆盖当前选择
      [WAN]: { model: 'minimax-h3-1080p-per-second', prompt: '', intent: 'text', seconds: wm.seconds.min, ratio: wm.ratios.options[0], switches: { generate_audio: false } },
    },
  };
  applyModelSwitch(d, WAN);
  assert.equal(d.draft.model, WAN);
  assert.equal(d.draft.prompt, '保留这条提示词');
  assert.equal(d.draft.seconds, wm.seconds.min);
  assert.equal(d.draft.ratio, wm.ratios.options[0]);

  const d2 = {
    draft: draft({ prompt: 'P2' }),
    perModel: { [WAN]: { model: 'x', prompt: 'evil', intent: 'frames', seconds: 99999, ratio: 'bogus', switches: 'bad', bindings: 42 } },
  };
  applyModelSwitch(d2, WAN);
  assert.equal(d2.draft.model, WAN);
  assert.equal(d2.draft.prompt, 'P2');
  assert.ok(wm.seconds.min <= d2.draft.seconds && d2.draft.seconds <= wm.seconds.max, '畸形 seconds 必须回落默认');
  assert.ok(wm.ratios.options.includes(d2.draft.ratio), '畸形 ratio 必须回落默认');
  assert.ok(intentsFor(WAN).some(i => i.intent === d2.draft.intent), '畸形 intent 必须回落默认');
  assert.equal(d2.draft.bindings, undefined, '畸形 bindings 不得注入');

  // 来回切换：原模型控件设置被缓存、prompt 保留
  const d3 = { draft: draft({ prompt: 'P3', seconds: 4 }), perModel: {} };
  applyModelSwitch(d3, WAN);
  applyModelSwitch(d3, MODEL);
  assert.equal(d3.draft.model, MODEL);
  assert.equal(d3.draft.prompt, 'P3');
  assert.equal(d3.draft.seconds, 4);
});

// ---------- R05/R13：找回入口 ----------

test('R13 restorePending：节点已删 → 重建展示节点并保留原幂等键/请求体，不发 POST', async t => {
  const { storage, store } = await setup(t, 'mock-r13-key');
  await store.newProject('R13');
  const node = store.addNode('gen', 0, 0, genData());
  const pid = store.project.id;
  const body = JSON.stringify({ model: MODEL, prompt: '原始提示词', seconds: 4, metadata: { ratio: '16:9', mode: 'text_to_video' } });
  await store.savePendingCreate({
    idempotencyKey: 'k13', projectId: pid, nodeId: node.id, model: MODEL,
    keyFp: keys.getFingerprint(), bodyString: body, state: 'uncertain', createdAt: Date.now(),
  });
  store.removeNode(node.id);
  let posts = 0;
  const runner = createTaskRunner({ store, storage, assets: noUpload, api: { createTask: async () => { posts++; }, getTask: async () => ({ status: 'queued' }) } });
  const found = await runner.restorePending('k13');
  assert.ok(found && found.type === 'gen' && found.id !== node.id, '必须重建一个生成节点');
  assert.equal(found.data.run?.pendingKey, 'k13');
  assert.equal(found.data.draft?.prompt, '原始提示词', '展示草稿由原始请求体还原');
  const rec = await store.pendingCreate('k13');
  assert.equal(rec.nodeId, found.id, '待决记录必须持久化新节点关联');
  assert.equal(rec.bodyString, body, '原始请求体与幂等键不得改写');
  assert.equal(posts, 0, '找回绝不发 POST');
});

test('R05 restorePending 优先已受理任务并清理残留 pending；restoreTask 重建关联', async t => {
  const { storage, store } = await setup(t, 'mock-r05-key');
  await store.newProject('R05');
  const pid = store.project.id;
  await store.savePendingCreate({ idempotencyKey: 'k5', projectId: pid, nodeId: 'gone-pending', model: MODEL, keyFp: keys.getFingerprint(), bodyString: '{}', state: 'uncertain', createdAt: Date.now() });
  await store.saveTask({ taskId: 'task5', projectId: pid, nodeId: 'gone-node', model: MODEL, idempotencyKey: 'k5', status: 'completed', deliveryStatus: 'ready', keyFp: keys.getFingerprint(), createdAt: Date.now() });
  let posts = 0;
  const runner = createTaskRunner({ store, storage, assets: noUpload, api: { createTask: async () => { posts++; }, getTask: async () => ({ status: 'completed' }) } });
  const node = await runner.restorePending('k5');
  assert.ok(node, '应通过已受理任务重建节点');
  assert.equal(node.data.run?.taskId, 'task5');
  assert.equal(await store.pendingCreate('k5'), undefined, '已受理后残留 pending 应清理');
  const trec = await store.task('task5');
  assert.equal(trec.nodeId, node.id, '任务记录必须持久化新节点关联');
  assert.equal(posts, 0);
});

test('restoreTask 不覆盖持有其他活动任务的节点；不存在的任务返回 null', async t => {
  const { storage, store } = await setup(t, 'mock-rt-key');
  await store.newProject('RT');
  const pid = store.project.id;
  const busy = store.addNode('gen', 0, 0, { draft: draft(), perModel: {}, run: { taskId: 'other-task' } });
  await store.saveTask({ taskId: 't9', projectId: pid, nodeId: busy.id, model: MODEL, status: 'queued', keyFp: keys.getFingerprint(), createdAt: Date.now() });
  const runner = createTaskRunner({ store, storage, assets: noUpload, api: { getTask: async () => ({ status: 'queued' }) } });
  const recovered = await runner.restoreTask('t9');
  assert.ok(recovered, '旧任务应另建展示节点，保持可找回');
  assert.notEqual(recovered.id, busy.id, '目标节点持有别的活动任务时不得覆盖');
  assert.equal(recovered.data.run.taskId, 't9');
  assert.equal(busy.data.run.taskId, 'other-task');
  assert.equal(await runner.restoreTask('missing-task'), null);
});

test('R13 conflict 记录找回：保留 pendingKey 守卫，submit/retry 均不产生新 POST', async t => {
  const { storage, store } = await setup(t, 'mock-conflict-key');
  await store.newProject('RC');
  const pid = store.project.id;
  await store.savePendingCreate({
    idempotencyKey: 'kc', projectId: pid, nodeId: 'gone', model: MODEL,
    keyFp: keys.getFingerprint(), bodyString: '{}', state: 'conflict', createdAt: Date.now(),
  });
  let creates = 0;
  const runner = createTaskRunner({ store, storage, assets: noUpload, api: { createTask: async () => { creates++; return { id: 'x', status: 'queued' }; } } });
  const node = await runner.restorePending('kc');
  assert.ok(node);
  assert.equal(node.data.run?.pendingKey, 'kc', 'conflict 记录必须恢复禁发守卫');
  await runner.submit(node);
  await runner.retrySubmit(node);
  assert.equal(creates, 0, 'conflict 记录不得静默变成新 POST');
});

test('R13 rejected 记录找回：还原拒绝展示态，不产生 POST', async t => {
  const { storage, store } = await setup(t, 'mock-rejected-key');
  await store.newProject('RR');
  const pid = store.project.id;
  await store.savePendingCreate({
    idempotencyKey: 'kr', projectId: pid, nodeId: 'gone', model: MODEL,
    keyFp: keys.getFingerprint(), bodyString: '{}', state: 'rejected', lastError: '400 bad', createdAt: Date.now(),
  });
  const runner = createTaskRunner({ store, storage, assets: noUpload, api: {} });
  const node = await runner.restorePending('kr');
  assert.ok(node);
  assert.equal(node.data.run?.rejected, true);
  assert.equal(node.data.run?.error, '400 bad');
});
