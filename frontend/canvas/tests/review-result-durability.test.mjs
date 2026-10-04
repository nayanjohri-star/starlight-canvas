// 成片下载落盘耐久性测试：download 返回 true 必须意味着 素材元信息 + 节点关联 + 任务关联 全部持久化；
// 任一落盘环节失败不得报告成功（不能只 toast 却返回 true），重试复用 resultBlobId / fromTask /
// 节点关联找回同一素材，只补齐落盘——不重复注册素材、不重复 GET、绝不发起 POST。
// 全部网络/付费接口均为 mock，绝不发起真实请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createAssets } from '../src/assets.js';
import { createTaskRunner } from '../src/gennode.js';
import { setKey } from '../src/keyvault.js';

globalThis.document = { getElementById: () => null, createElement: () => ({ append() {}, remove() {}, setAttribute() {}, style: {} }) };
const passthrough = (_name, fn) => fn();
const mp4 = () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' });

async function setup() {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('原项目');
  const fp = await setKey('mock-result-durability');
  const assets = createAssets({ store, storage, api: {} });
  return { storage, store, fp, assets };
}

test('返回 true 时 素材/节点关联 已随项目文档落盘且任务关联已持久化', async () => {
  const { storage, store, fp, assets } = await setup();
  const pid = store.project.id;
  const n = store.addNode('gen', 0, 0, { draft: { model: 'mock' }, run: { taskId: 'rd-ok' } });
  await store.flush();
  await store.saveTask({ taskId: 'rd-ok', projectId: pid, nodeId: n.id, model: 'mock', keyFp: fp, status: 'completed', createdAt: Date.now() });
  const runner = createTaskRunner({ store, storage, assets, api: { downloadContent: async () => ({ contentType: 'video/mp4', blob: mp4() }) }, submitLock: passthrough });
  assert.equal(await runner.download('rd-ok'), true);
  const rec = await storage.get(`task:${pid}:rd-ok`), doc = await storage.get(`project:${pid}`);
  assert.ok(rec.resultAssetId, '任务记录必须持有素材关联');
  assert.ok(doc.assets[rec.resultAssetId], '项目文档必须已含素材记录，不能等防抖');
  assert.equal(doc.nodes.find(x => x.id === n.id).data.resultAssetId, rec.resultAssetId, '节点关联必须随项目文档落盘');
  assert.ok(await storage.getBlob(`blob:${rec.resultAssetId}`), '素材文件本体必须已落盘');
  assert.equal(await runner.download('rd-ok'), true, '已入库复用路径同样只在落盘后返回 true');
  assert.equal(Object.keys(store.project.assets).length, 1, '复用不得注册重复素材');
});

test('项目文档落盘失败返回 null；重试复用已下载结果只补齐落盘', async () => {
  const { storage, store, fp, assets } = await setup();
  const pid = store.project.id;
  const n = store.addNode('gen', 0, 0, { draft: { model: 'mock' }, run: { taskId: 'rd-flush' } });
  await store.flush();
  await store.saveTask({ taskId: 'rd-flush', projectId: pid, nodeId: n.id, model: 'mock', keyFp: fp, status: 'completed', createdAt: Date.now() });
  let gets = 0;
  const runner = createTaskRunner({ store, storage, assets, api: { downloadContent: async () => { gets++; return { contentType: 'video/mp4', blob: mp4() }; } }, submitLock: passthrough });
  const realFlush = store.flush;
  store.flush = async () => { throw new Error('mock disk full'); };
  try { assert.equal(await runner.download('rd-flush'), null, '项目文档落盘失败不得报告成功'); }
  finally { store.flush = realFlush; }
  const count = Object.keys(store.project.assets).length;
  assert.equal(await runner.download('rd-flush'), true);
  assert.equal(gets, 1, '重试必须复用已下载结果 blob，不重复 GET');
  assert.equal(Object.keys(store.project.assets).length, count, '重试必须复用同一素材，不重复注册');
  const rec = await storage.get(`task:${pid}:rd-flush`), doc = await storage.get(`project:${pid}`);
  assert.ok(doc.assets[rec.resultAssetId], '重试后素材与任务关联必须全部落盘');
});

test('任务关联落盘失败返回 null；素材与节点关联已先落盘，重试只补任务记录', async () => {
  const { storage, store, fp, assets } = await setup();
  const pid = store.project.id;
  const n = store.addNode('gen', 0, 0, { draft: { model: 'mock' }, run: { taskId: 'rd-task' } });
  await store.flush();
  await store.saveTask({ taskId: 'rd-task', projectId: pid, nodeId: n.id, model: 'mock', keyFp: fp, status: 'completed', createdAt: Date.now() });
  let gets = 0;
  const runner = createTaskRunner({ store, storage, assets, api: { downloadContent: async () => { gets++; return { contentType: 'video/mp4', blob: mp4() }; } }, submitLock: passthrough });
  const realSave = store.saveTask;
  store.saveTask = async r => { if (r.resultAssetId) throw new Error('mock task store full'); return realSave(r); };
  try { assert.equal(await runner.download('rd-task'), null, '任务关联写盘失败不得报告成功'); }
  finally { store.saveTask = realSave; }
  // 顺序保证：素材+节点关联随项目文档先持久化，仅剩任务关联待补
  const doc = await storage.get(`project:${pid}`);
  const aid = doc.nodes.find(x => x.id === n.id).data.resultAssetId;
  assert.ok(aid && doc.assets[aid], '素材与节点关联必须先于任务关联持久化');
  assert.equal(await runner.download('rd-task'), true);
  assert.equal(gets, 1, '重试不重复 GET');
  const rec = await storage.get(`task:${pid}:rd-task`);
  assert.equal(rec.resultAssetId, aid, '重试沿用同一素材，只补写任务关联');
  assert.equal(Object.values(store.project.assets).filter(a => a.fromTask === 'rd-task').length, 1, '不得出现重复素材');
});

test('落盘期间切换项目：产出只写原项目命名空间，新项目零污染', async () => {
  const { storage, store, fp, assets } = await setup();
  const oldPid = store.project.id;
  const n = store.addNode('gen', 0, 0, { draft: { model: 'mock' }, run: { taskId: 'rd-switch' } });
  await store.flush();
  await store.saveTask({ taskId: 'rd-switch', projectId: oldPid, nodeId: n.id, model: 'mock', keyFp: fp, status: 'completed', createdAt: Date.now() });
  const runner = createTaskRunner({ store, storage, assets, api: { downloadContent: async () => ({ contentType: 'video/mp4', blob: mp4() }) }, submitLock: passthrough });
  const realFlush = store.flush;
  let switching = false;
  store.flush = async () => {
    if (switching) return realFlush();
    switching = true;
    await realFlush();                          // 原项目文档正常落盘（含本次素材与节点关联）
    await store.newProject('新项目');            // flush 返回前切走当前项目
  };
  let r;
  try { r = await runner.download('rd-switch'); }
  finally { store.flush = realFlush; }
  assert.equal(r, true, '素材/节点/任务关联均已按原项目落盘，切换不改变既成事实');
  assert.equal(store.project.name, '新项目');
  assert.equal(Object.keys(store.project.assets).length, 0, '成片绝不混入新项目素材');
  const rec = await storage.get(`task:${oldPid}:rd-switch`), oldDoc = await storage.get(`project:${oldPid}`);
  assert.ok(rec.resultAssetId, '任务关联写回原项目命名空间');
  assert.ok(oldDoc.assets[rec.resultAssetId], '原项目文档已含素材');
  assert.equal(oldDoc.nodes.find(x => x.id === n.id).data.resultAssetId, rec.resultAssetId);
  await store.flush();
});
