// Codex 独立验收，不连接上游；存储读写克隆，避免共享对象掩盖持久化问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../src/store.js';
import { setCapabilities, buildCreateBody } from '../src/capabilities.js';
import { createTaskRunner } from '../src/gennode.js';
import { ApiError } from '../src/api.js';
import * as keys from '../src/keyvault.js';

setCapabilities(JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8')));
const dummy = () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} });
globalThis.document = { createElement: dummy, getElementById: dummy };
const model = 'minimax-h3-768p-per-second';
const draft = () => ({ model, prompt: '独立模拟验收', intent: 'text', seconds: 4, ratio: '16:9', switches: {} });
const clone = v => v === undefined ? undefined : structuredClone(v);
function storage() {
  const kv = new Map(), blobs = new Map();
  return { get: async k => clone(kv.get(k)), set: async (k, v) => void kv.set(k, clone(v)), del: async k => void kv.delete(k), keys: async () => [...kv.keys()],
    setIfRev: async (k, expected, value) => {
      const old = kv.get(k), rev = old && typeof old === 'object' ? (old.rev ?? 0) : null;
      if (rev !== expected) return { ok: false, storedRev: rev };
      kv.set(k, clone(value)); return { ok: true };
    },
    getBlob: async k => blobs.get(k), setBlob: async (k, v) => void blobs.set(k, v) };
}
async function fixture() {
  await keys.setKey('mock-independent-only'); keys.setAvailableModels([model]);
  const db = storage(), store = createStore(db); await store.newProject('独立模拟');
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  return { db, store, node };
}
const done = async () => ({ status: 'completed', delivery_status: 'ready' });

test('独立验收：超窗未确认记录导入后仍禁止新 POST', async () => {
  const { db, store, node } = await fixture(); let calls = 0;
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { createTask: async () => { calls++; return { id: 'must-not-create', status: 'queued' }; }, getTask: done } });
  const rec = { projectId: store.project.id, nodeId: node.id, model, keyFp: keys.getFingerprint(), idempotencyKey: 'mock-expired', createdAt: Date.now() - 25 * 3600000, state: 'uncertain', bodyString: buildCreateBody(model, node.data.draft, [], []) };
  await store.savePendingCreate(rec); node.data.run = { pendingKey: rec.idempotencyKey }; await runner.releasePending(node);
  await store.importJSON(await store.exportJSON()); await runner.resumeAll();
  const restored = store.project.nodes[0]; await runner.submit(restored);
  assert.equal(calls, 0); assert.equal(restored.data.run.pendingKey, rec.idempotencyKey); await store.flush();
});

test('独立验收：慢 429 从响应到达起等待 Retry-After，之后同键同体重试', async () => {
  const { db, store, node } = await fixture(), actual = Date.now; let now = actual(); const calls = [];
  Date.now = () => now;
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { createTask: async (body, key) => { calls.push({ body, key }); if (calls.length === 1) { now += 120000; throw new ApiError(429, 'rate_limit', 'mock slow response', 60); } return { id: 'mock-retry', status: 'queued' }; }, getTask: done } });
  try {
    await runner.submit(node); await runner.retrySubmit(node); assert.equal(calls.length, 1, '收到 429 后不能立即重试');
    now += 60001; await runner.retrySubmit(node); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  } finally { Date.now = actual; await store.flush(); }
});

test('独立验收：导入写入失败保留当前项目和已有数据', async () => {
  const { db, store } = await fixture(), original = store.project, exported = await store.exportJSON(), priorKeys = new Set(await db.keys());
  const write = db.set; db.set = async (k, v) => { if (k.startsWith('project:') && k !== `project:${original.id}`) throw Object.assign(new Error('mock disk full'), { name: 'QuotaExceededError' }); return write(k, v); };
  await assert.rejects(store.importJSON(exported));
  assert.equal(store.project, original); assert.equal(await db.get('lastOpened'), original.id);
  assert.deepEqual(new Set(await db.keys()), priorKeys, '失败导入不得留下半成品项目'); db.set = write; await store.flush();
});

test('独立验收：pending 快照与提示词绑定指向相同新素材', async () => {
  const { db, store, node } = await fixture();
  store.project.assets['mock-image-old'] = { id: 'mock-image-old', name: 'mock.png', kind: 'image', mime: 'image/png', size: 12 };
  await store.savePendingCreate({ projectId: store.project.id, nodeId: node.id, model, keyFp: keys.getFingerprint(), idempotencyKey: 'mock-snapshot', createdAt: Date.now(), state: 'uncertain', bodyString: null, snapshot: { nodeId: node.id, refIds: ['mock-image-old'], frameIds: [], draft: { ...draft(), prompt: '参考 @图片1', bindings: { 'image:1': 'mock-image-old' } } } });
  await store.importJSON(await store.exportJSON());
  const rec = (await store.listPending())[0], id = rec.snapshot.refIds[0];
  assert.ok(store.project.assets[id]); assert.equal(rec.snapshot.draft.bindings['image:1'], id); await store.flush();
});

test('独立验收：pending 写入失败不发送且退出上传状态', async () => {
  const { db, store, node } = await fixture(); let calls = 0; const write = db.set;
  db.set = async (k, v) => { if (k.startsWith('pending:')) throw Object.assign(new Error('mock disk full'), { name: 'QuotaExceededError' }); return write(k, v); };
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { createTask: async () => { calls++; return { id: 'must-not-create' }; } } });
  await runner.submit(node); assert.equal(calls, 0); assert.notEqual(node.data.run?.state, 'uploading'); assert.ok(node.data.run?.error, '明确提示失败'); assert.equal(runner.isBusy(node.id), false);
  db.set = write; await store.flush();
});

test('独立验收：删除未知结果节点后找回，重试保持原键原体', async () => {
  const { db, store, node } = await fixture(), calls = [];
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { createTask: async (body, key) => { calls.push({ body, key }); if (calls.length === 1) throw new ApiError(502, 'mock_error', 'mock lost response'); return { id: 'mock-recovered', status: 'queued' }; }, getTask: done } });
  await runner.submit(node); const pending = (await store.listPending())[0]; store.removeNode(node.id);
  const restored = await runner.restorePending(pending.idempotencyKey); assert.ok(restored && store.node(restored.id)); assert.equal(calls.length, 1, '找回操作本身不能 POST');
  await runner.retrySubmit(restored); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); await store.flush();
});

test('独立验收：找回旧任务不会覆盖节点已有新任务', async () => {
  const { db, store, node } = await fixture(); node.data.run = { taskId: 'mock-active-new' };
  await store.saveTask({ projectId: store.project.id, nodeId: node.id, taskId: 'mock-old-completed', model, status: 'completed', keyFp: keys.getFingerprint(), bodyString: buildCreateBody(model, draft(), [], []) });
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { getTask: done } });
  const restored = await runner.restoreTask('mock-old-completed');
  assert.equal(node.data.run.taskId, 'mock-active-new'); assert.ok(restored); assert.notEqual(restored.id, node.id); assert.equal(restored.data.run.taskId, 'mock-old-completed'); await store.flush();
});

test('独立验收：显式脱离已完成任务后允许同节点开始新任务', async () => {
  const { db, store, node } = await fixture(), calls = [];
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { createTask: async (body, key) => { calls.push(key); return { id: `mock-explicit-${calls.length}`, status: 'completed', delivery_status: 'ready' }; }, getTask: done } });
  await runner.submit(node); await runner.detach(node); await runner.submit(node);
  assert.equal(calls.length, 2, '不能因历史已完成任务永久锁住节点'); assert.notEqual(calls[0], calls[1]); await store.flush();
});

test('独立验收：不同节点仍可各自提交，不能变成账户级锁', async () => {
  const { db, store, node } = await fixture(); let calls = 0;
  const other = store.addNode('gen', 300, 0, { draft: draft(), perModel: {} });
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { createTask: async () => ({ id: `mock-other-${++calls}`, status: 'completed', delivery_status: 'ready' }), getTask: done } });
  await Promise.all([runner.submit(node), runner.submit(other)]); assert.equal(calls, 2); await store.flush();
});

test('独立验收：等待跨标签锁时切换项目，不得把旧草稿提交到新项目', async () => {
  const { db, store, node } = await fixture(); let release; let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = createTaskRunner({ store, storage: db, assets: {}, submitLock: { request: async (_name, fn) => { await gate; return fn(); } }, api: { createTask: async () => { calls++; return { id: 'must-not-create', status: 'completed' }; }, getTask: done } });
  const submitting = runner.submit(node); await store.newProject('用户切换的新项目'); release(); await submitting;
  assert.equal(calls, 0); assert.equal(store.project.nodes.length, 0); assert.equal((await store.listPending()).length, 0); await store.flush();
});

test('独立验收：等待跨标签锁时换密钥，不得用新密钥提交旧点击', async () => {
  const { db, store, node } = await fixture(); let release; let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = createTaskRunner({ store, storage: db, assets: {}, submitLock: { request: async (_name, fn) => { await gate; return fn(); } }, api: { createTask: async () => { calls++; return { id: 'must-not-create', status: 'completed' }; }, getTask: done } });
  const submitting = runner.submit(node); await keys.setKey('mock-other-key-only'); keys.setAvailableModels([model]); release(); await submitting;
  assert.equal(calls, 0); assert.equal((await store.listPending()).length, 0); await store.flush();
});

test('独立验收：导出导入仍保留退避截止时间和原键原体', async () => {
  const { db, store, node } = await fixture(), actual = Date.now, calls = []; let now = actual(); Date.now = () => now;
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { createTask: async (body, key) => { calls.push({ body, key }); if (calls.length === 1) { now += 120000; throw new ApiError(429, 'rate_limit', 'mock', 60); } return { id: 'mock-import-retry', status: 'completed' }; }, getTask: done } });
  try {
    await runner.submit(node); const deadline = (await store.listPending())[0].retryNotBefore;
    await store.importJSON(await store.exportJSON()); await runner.resumeAll(); const imported = store.project.nodes[0];
    assert.equal((await store.listPending())[0].retryNotBefore, deadline);
    await runner.retrySubmit(imported); assert.equal(calls.length, 1);
    now += 60001; await runner.retrySubmit(imported); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  } finally { Date.now = actual; await store.flush(); }
});

test('独立验收：显式脱离标记经过导入和恢复后仍然有效', async () => {
  const { db, store, node } = await fixture(); let calls = 0;
  const runner = createTaskRunner({ store, storage: db, assets: {}, api: { createTask: async () => ({ id: `mock-detached-import-${++calls}`, status: 'completed', delivery_status: 'ready' }), getTask: done } });
  await runner.submit(node); await runner.detach(node); await store.importJSON(await store.exportJSON()); await runner.resumeAll();
  const imported = store.project.nodes[0]; assert.ok(!imported.data.run?.taskId);
  await runner.submit(imported); assert.equal(calls, 2); await store.flush();
});
