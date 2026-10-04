// A3 跨标签/竞态安全验收：
//  · 不同节点并行提交不被全账户锁阻塞（锁粒度 = 项目:节点）
//  · saveTask 写侧对账：跨标签旧写不得回退终态/粘性字段/结果关联
//  · pending 吸收态：rejected/conflict/expired_window 不被 uncertain 覆盖
//  · putRec 持久化失败时轮询不静默死亡（降级继续）
//  · retrySubmit：快照素材远端过期 → 拒绝重建请求体、零 POST（不换体重投）
// 全内存 mock，无网络、无真实密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createTaskRunner } from '../src/gennode.js';
import { setCapabilities } from '../src/capabilities.js';
import * as keys from '../src/keyvault.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);
const MODEL = 'minimax-h3-768p-per-second';
const draft = (over = {}) => ({ model: MODEL, intent: 'text', prompt: '移动镜头展示桌面模型', seconds: 4, ratio: '16:9', switches: {}, ...over });
const genData = (over = {}) => ({ draft: draft(), perModel: {}, ...over });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const element = () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} });
globalThis.document = { createElement: element, getElementById: element };

// 读写克隆的共享存储：两个独立 store 实例模拟两个标签页（不经对象引用串数据）
const cloneOf = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
function cloneStorage() {
  const base = createMemoryStorage();
  return {
    get: async k => cloneOf(await base.get(k)),
    set: async (k, v) => base.set(k, cloneOf(v)),
    del: k => base.del(k),
    keys: () => base.keys(),
    getBlob: k => base.getBlob(k), setBlob: (k, v) => base.setBlob(k, v), delBlob: k => base.delBlob(k),
    batch: entries => base.batch(entries),
    setIfRev: (k, r, v) => base.setIfRev(k, r, v),
    raw: base,
  };
}
const noUpload = { remoteValid: () => true, assetOfNode: () => null, async upload() { throw new Error('not used'); } };

async function setup(t, keyName = 'mock-a3') {
  const storage = cloneStorage();
  const store = createStore(storage);
  await store.newProject('A3');
  const fp = await keys.setKey(keyName);
  keys.setAvailableModels([MODEL]);
  t.after(async () => { await store.flush(); keys.clearKey(); keys.setAvailableModels(null); });
  return { storage, store, fp };
}

test('A3-1 不同节点并行提交不被全账户锁阻塞：各自获得独立任务', async t => {
  const { storage, store } = await setup(t, 'mock-a3a');
  const n1 = store.addNode('gen', 0, 0, genData());
  const n2 = store.addNode('gen', 50, 0, genData());
  await store.flush();
  let creates = 0;
  const api = {
    createTask: async () => { const n = ++creates; await sleep(30); return { id: `task-${n}`, status: 'queued' }; },
    getTask: async () => ({ status: 'completed' }),
  };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload });
  await Promise.all([runner.submit(n1), runner.submit(n2)]);
  assert.equal(creates, 2, '不同节点必须并行受理，不被全局锁阻塞');
  assert.ok(n1.data.run?.taskId && n2.data.run?.taskId);
  assert.notEqual(n1.data.run.taskId, n2.data.run.taskId, '任务必须互不串扰');
});

test('A3-2 跨标签写竞态：旧写不得回退终态/粘性字段/结果关联', async t => {
  const { storage, store: s1 } = await setup(t, 'mock-a3b');
  const pid = s1.project.id;
  const base = { taskId: 'tX', projectId: pid, nodeId: 'n1', model: MODEL, keyFp: 'fp', createdAt: 1 };
  await s1.saveTask({ ...base, status: 'in_progress', progress: 10 });
  // 标签页2 缓存的是 in_progress 旧视图；标签页1 完成并入库结果
  const staleView = { ...base, status: 'in_progress', progress: 30 };
  await s1.saveTask({ ...base, status: 'completed', executorVersion: 2, contentReady: true, cancelRequested: true, resultAssetId: 'a_res', resultBlobId: `result:${pid}:tX`, resultType: 'video/mp4', progress: 100 });
  // 标签页2 迟到写入 in_progress
  await store2save(storage, staleView);
  const final = await storage.get(`task:${pid}:tX`);
  assert.equal(final.status, 'completed', '终态不得被迟到 in_progress 回退');
  assert.equal(final.contentReady, true, 'contentReady 粘性');
  assert.equal(final.cancelRequested, true, 'cancelRequested 粘性');
  assert.equal(final.resultAssetId, 'a_res', '结果关联不得被旧写抹掉');
  assert.equal(final.resultBlobId, `result:${pid}:tX`);
  assert.equal(final.resultType, 'video/mp4');
  assert.equal(final.progress, 100, '旧 GET 的进度不得覆盖已确认完成进度');
  assert.equal(staleView.status, 'completed', '合并结果写回调用方记录（缓存收敛）');
});

async function store2save(storage, rec) {
  // 模拟另一标签页经同一 store API 路径写入（含合并）
  const s2 = createStore(storage);
  await s2.saveTask(rec);
}

test('A3-3 pending 吸收态：rejected/conflict/expired_window 不被 uncertain 覆盖', async t => {
  const { store } = await setup(t, 'mock-a3c');
  const pid = store.project.id;
  const key = 'idem-absorb';
  await store.savePendingCreate({ idempotencyKey: key, projectId: pid, nodeId: 'n1', model: MODEL, keyFp: 'fp', bodyString: '{"a":1}', createdAt: 1, state: 'uncertain' });
  await store.updatePendingCreate({ idempotencyKey: key, projectId: pid, nodeId: 'n1', model: MODEL, keyFp: 'fp', bodyString: '{"a":1}', createdAt: 1, state: 'rejected', lastError: '400 bad' });
  // 迟到的在途写不得回退定性结局
  await store.updatePendingCreate({ idempotencyKey: key, projectId: pid, nodeId: 'n1', model: MODEL, keyFp: 'fp', bodyString: '{"a":1}', createdAt: 1, state: 'uncertain', lastError: 'late timeout' });
  const rec = await store.pendingCreate(key);
  assert.equal(rec.state, 'rejected', 'uncertain 不得覆盖 rejected');
  assert.equal(rec.lastError, 'late timeout', '其余字段仍可更新（不丢新信息）');
});

test('A3-4 putRec 落盘失败：轮询降级继续，不静默死亡', async t => {
  const { storage, store, fp } = await setup(t, 'mock-a3d');
  const pid = store.project.id;
  await store.saveTask({ taskId: 'tPoll', projectId: pid, nodeId: 'n1', model: MODEL, keyFp: fp, status: 'in_progress', createdAt: Date.now() });
  let gets = 0;
  const api = { getTask: async () => { gets++; return { status: 'in_progress', progress: gets * 10 }; } };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload });
  // 第一次任务写盘失败（saveTask CAS 化后写路径经 setIfRev，两个原语都要拦）
  const realSet = storage.set;
  const realCas = storage.setIfRev;
  let sabotage = true;
  storage.set = async (k, v) => { if (sabotage && k.startsWith('task:')) throw new Error('disk full'); return realSet(k, v); };
  storage.setIfRev = async (k, r, v) => { if (sabotage && k.startsWith('task:')) throw new Error('disk full'); return realCas(k, r, v); };
  runner.poll('tPoll', pid);
  await sleep(1400);   // 首个 tick（1.2s）应已执行：GET 成功但落盘失败
  const rec1 = await runner.recOf('tPoll', pid);
  assert.ok(gets >= 1, '首个 tick 应已发起查询');
  assert.match(rec1.pollError ?? '', /本地落盘失败/, '落盘失败应标记为 pollError');
  await sleep(13000);  // 退避后第二个 tick 应再次发起（轮询未死）
  assert.ok(gets >= 2, `轮询应继续（gets=${gets}），不得静默死亡`);
});

test('A3-5 retrySubmit：快照素材远端过期 → 拒绝重建请求体、零 POST', async t => {
  const { storage, store, fp } = await setup(t, 'mock-a3e');
  const pid = store.project.id;
  store.project.assets.a1 = { id: 'a1', name: 'old.png', kind: 'image', mime: 'image/png', size: 10, remote: { url: 'https://cdn.example.com/a1.png', expiresAt: Math.floor((Date.now() - 3600e3) / 1000) } };
  const node = store.addNode('gen', 0, 0, genData());
  await store.flush();
  const key = 'idem-exp';
  await store.savePendingCreate({
    idempotencyKey: key, projectId: pid, nodeId: node.id, model: MODEL, keyFp: fp,
    bodyString: null, createdAt: Date.now(), lastSubmitAt: null, state: 'uncertain',
    snapshot: { draft: draft({ intent: 'frames', prompt: 'p' }), refIds: [], frameIds: ['a1'], projectId: pid, nodeId: node.id, keyFp: fp, at: Date.now() },
  });
  node.data.run = { pendingKey: key };
  let posts = 0;
  const api = { createTask: async () => { posts++; return { id: 'x', status: 'queued' }; } };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload });
  await runner.retrySubmit(node);
  const rec = await store.pendingCreate(key);
  assert.equal(posts, 0, '素材过期绝不自动新 POST');
  assert.equal(rec.bodyString, null, '不得换体重投：bodyString 必须保持为空');
});

test('A3-6 saveTask CAS 争用重试：他写抢先落地→重读重合并，双方单调数据不丢', async t => {
  const storage = cloneStorage();
  // 拦截 task 键的首次 CAS：模拟另一标签页在 get 与 setIfRev 之间抢先写入竞争者记录
  const origCas = storage.setIfRev;
  let armed = false, injected = false;
  storage.setIfRev = async (k, r, v) => {
    if (armed && !injected && k.startsWith('task:')) {
      injected = true;
      const cur = await storage.get(k);
      const rival = { ...cur, status: 'failed', cancelRequested: true, rev: (cur?.rev ?? 0) + 1 };
      await origCas(k, cur?.rev ?? 0, rival);
      return { ok: false, storedRev: rival.rev };
    }
    return origCas(k, r, v);
  };
  const s1 = createStore(storage);
  await s1.newProject('A3-6');
  const fp = await keys.setKey('mock-a3d');
  keys.setAvailableModels([MODEL]);
  t.after(async () => { await s1.flush(); keys.clearKey(); keys.setAvailableModels(null); });
  const pid = s1.project.id;
  const base = { taskId: 'tCAS', projectId: pid, nodeId: 'n1', model: MODEL, keyFp: 'fp', createdAt: 1 };
  await s1.saveTask({ ...base, status: 'in_progress', progress: 10 });
  armed = true;
  // 本写携带终态+结果关联；竞争者（抢先落地）携带 failed 终态+cancelRequested 粘性
  await s1.saveTask({ ...base, status: 'completed', executorVersion: 2, contentReady: true, resultAssetId: 'a_x', progress: 100 });
  const final = await storage.get(`task:${pid}:tCAS`);
  assert.equal(injected, true, 'CAS 路径确实经历了一次争用失败重试');
  assert.equal(final.status, 'failed', '无服务器顺序证据时先保留已落盘终态');
  assert.deepEqual(final.terminalConflict, ['failed', 'completed'], '互斥终态均保留供核对，不能任选最后写入者');
  assert.equal(final.queryHealth, 'needs_review');
  assert.equal(final.cancelRequested, true, '竞争者的粘性字段不丢（无静默覆盖）');
  assert.equal(final.resultAssetId, 'a_x', '本写结果关联不丢');
  assert.equal(final.contentReady, true, 'contentReady 不丢');
});
