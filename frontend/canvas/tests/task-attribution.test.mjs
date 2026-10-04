// A1 下载归属验收（合同 §3 任务关联检查）：
// 下载收尾仅在「节点当前仍绑定该任务且关联未撤销」时写回节点输出；
// 旧任务下载可保存旧任务结果与素材，但不得写入已重绑新任务/已脱离/已删除的节点。
// 覆盖三条成功分支（新入库/已入库复用/本地 blob 修复）与下载中脱离、重绑、删节点。
// 全部 mock，内存 storage，零网络零付费。
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

async function setup(dlImpl) {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('A1归属');
  const fp = await setKey('mock-a1');
  const assets = createAssets({ store, storage, api: {} });
  const runner = createTaskRunner({
    store, storage, assets, submitLock: passthrough,
    api: { downloadContent: dlImpl ?? (async () => ({ contentType: 'video/mp4', blob: mp4() })) },
  });
  return { storage, store, fp, assets, runner };
}

async function bindTask(store, fp, node, taskId, status = 'completed') {
  const pid = store.project.id;
  await store.saveTask({ taskId, projectId: pid, nodeId: node.id, model: 'mock', keyFp: fp, status, createdAt: Date.now() });
  node.data.run = { taskId };
}

test('A1-1 脱离→重绑B→下载A：三分支均不写入B节点，结果留A记录与素材库', async () => {
  const { storage, store, fp, runner } = await setup();
  const pid = store.project.id;
  const node = store.addNode('gen', 0, 0, { draft: { model: 'mock' } });
  await bindTask(store, fp, node, 'A');
  await runner.detach(node);                                   // A 脱离：rec.detached=true、run 清空
  await store.saveTask({ taskId: 'B', projectId: pid, nodeId: node.id, model: 'mock', keyFp: fp, status: 'in_progress', createdAt: Date.now() });
  node.data.run = { taskId: 'B' };
  node.data.resultAssetId = 'asset_B';                         // B 已有自身结果关联

  // 分支一：新下载入库
  assert.equal(await runner.download('A'), true);
  let recA = await store.taskIn(pid, 'A');
  assert.ok(recA.resultAssetId, '结果必须写回原任务记录');
  assert.ok(store.project.assets[recA.resultAssetId]?.fromTask === 'A', '素材入库且归属 A');
  assert.equal(node.data.resultAssetId, 'asset_B', '不得改写已绑定 B 的节点输出');
  assert.equal(node.data.run.taskId, 'B', '不得改写节点任务绑定');
  const aid = recA.resultAssetId;

  // 分支二：已入库素材复用（resultBlobId 在 → existing+hasBlob）
  node.data.resultAssetId = 'asset_B';
  assert.equal(await runner.download('A'), true);
  assert.equal(node.data.resultAssetId, 'asset_B', '复用分支同样不得改写 B 节点');

  // 分支三：素材在但 blob 缺失 → 用已下载结果 blob 修复
  await storage.delBlob(`blob:${aid}`);
  node.data.resultAssetId = 'asset_B';
  assert.equal(await runner.download('A'), true);
  recA = await store.taskIn(pid, 'A');
  assert.equal(recA.resultAssetId, aid, '修复后仍指向同一素材');
  assert.equal(node.data.resultAssetId, 'asset_B', '修复分支不得改写 B 节点');
  assert.ok(await storage.getBlob(`blob:${aid}`), '素材 blob 已修复');
});

test('A1-2 下载进行中脱离：结果落原任务记录，不写已脱离节点', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const { store, fp, runner } = await setup(() => held.then(() => ({ contentType: 'video/mp4', blob: mp4() })));
  const node = store.addNode('gen', 0, 0, { draft: { model: 'mock' } });
  await bindTask(store, fp, node, 'A');
  const p = runner.download('A');                              // GET 在途
  await runner.detach(node);                                   // 下载期间脱离
  release();
  assert.equal(await p, true);
  const recA = await store.taskIn(store.project.id, 'A');
  assert.ok(recA.resultAssetId, '结果写回任务记录');
  assert.equal(node.data.resultAssetId, undefined, '已脱离节点不得被写');
  assert.equal(node.data.run, null, '节点保持无绑定');
});

test('A1-3 下载进行中重绑B：不写 B 节点；restoreTask 重绑新节点后写新节点', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const { storage, store, fp, runner } = await setup(() => held.then(() => ({ contentType: 'video/mp4', blob: mp4() })));
  const pid = store.project.id;
  const node = store.addNode('gen', 0, 0, { draft: { model: 'mock' } });
  await bindTask(store, fp, node, 'A');
  const p = runner.download('A');                              // GET 在途
  await runner.detach(node);
  await store.saveTask({ taskId: 'B', projectId: pid, nodeId: node.id, model: 'mock', keyFp: fp, status: 'in_progress', createdAt: Date.now() });
  node.data.run = { taskId: 'B' };                             // 在途期间重绑 B
  release();
  assert.equal(await p, true);
  const recA = await store.taskIn(pid, 'A');
  assert.ok(recA.resultAssetId);
  assert.equal(node.data.resultAssetId, undefined, '重绑 B 的节点不得被 A 写');

  // restoreTask 把 A 找回绑定到新节点：绑定关系成立 → 允许写新节点
  const node2 = await runner.restoreTask('A', pid);
  assert.ok(node2 && node2.data.run?.taskId === 'A');
  await storage.delBlob(`blob:${recA.resultAssetId}`);         // 删素材 blob 迫使走修复分支
  assert.equal(await runner.download('A'), true);
  assert.equal(store.node(node2.id).data.resultAssetId, recA.resultAssetId, '重绑 A 的新节点允许写回');
});

test('A1-4 下载进行中删除节点：不写任何节点，结果仍入任务记录', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const { store, fp, runner } = await setup(() => held.then(() => ({ contentType: 'video/mp4', blob: mp4() })));
  const node = store.addNode('gen', 0, 0, { draft: { model: 'mock' } });
  await bindTask(store, fp, node, 'A');
  const nid = node.id;
  const p = runner.download('A');
  store.removeNode(nid);                                       // 在途期间删节点
  release();
  assert.equal(await p, true);
  const recA = await store.taskIn(store.project.id, 'A');
  assert.ok(recA.resultAssetId, '结果仍入任务记录与素材库');
  assert.equal(store.node(nid) ?? null, null, '节点已删无从可写');
});

