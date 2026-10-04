// WO-D1 独立验收 A1（contracts §3 不变量；不替 A 改实现）：
// 「下载收尾仅在节点当前仍绑定该任务且关联未撤销时写回节点输出；
//   结果可存原任务记录。旧任务下载可保存旧任务结果，但不得写入已重绑新任务的节点。」
// 基线预期：RED（gennode.js finalize 只查项目/密钥，不查节点绑定）。
// A 修复合入后应转 GREEN。断言针对合同不变量，不绑定具体实现路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, makeApi, makeRunner, stubAssets, genDraft, seedTask, sleep, MP4, MODEL } from './accept-helpers.mjs';

async function bind(store, node, taskId, fields = {}) {
  await seedTask(store, { pid: store.project.id, nodeId: node.id, taskId, ...fields });
  node.data.run = { taskId };
}

test('A1-1：脱离→节点重绑任务B→下载A，不得覆盖绑定B的节点输出', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const { api, calls } = makeApi();
  const runner = makeRunner({ store, storage, api });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await bind(store, node, 'taskA', { status: 'completed', keyFp: fp });

  assert.equal(await runner.detach(node), true, '脱离应成功');
  const recA0 = await store.taskIn(pid, 'taskA');
  assert.equal(recA0.detached, true);
  assert.equal(node.data.run, null);

  // 同一节点重绑新任务 B（在途）
  await bind(store, node, 'taskB', { status: 'in_progress', keyFp: fp });

  const ok = await runner.download('taskA');
  const recA = await store.taskIn(pid, 'taskA');
  const nodeNow = store.node(node.id);
  assert.equal(nodeNow.data.run?.taskId, 'taskB', '节点当前绑定任务 B');
  assert.equal(ok, true, 'A 的下载应成功：结果保留在原任务记录与素材库（不失败也不静默丢弃）');
  assert.ok(recA.resultAssetId, 'A 的结果应写入原任务记录（rec.resultAssetId）');
  assert.ok(store.project.assets[recA.resultAssetId], 'A 的成片应入库为项目素材');
  assert.notEqual(nodeNow.data.resultAssetId, recA.resultAssetId,
    'A1 缺陷复现：已脱离的旧任务 A 下载收尾写入了绑定 B 的节点 resultAssetId（串任务）');
  assert.equal(calls.creates.length, 0, '全程零生成 POST');
});

test('A1-2：下载进行中脱离 → 收尾不得写节点', async t => {
  const { storage, store, pid, fp } = await setup(t);
  let release;
  const gate = new Promise(r => { release = r; });
  const { api } = makeApi({ downloadContent: () => gate.then(() => ({ status: 200, contentType: 'video/mp4', blob: MP4() })) });
  const runner = makeRunner({ store, storage, api });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await bind(store, node, 'taskA', { status: 'completed', keyFp: fp });

  const p = runner.download('taskA');
  await sleep(20);                       // 确保下载已进入 in-flight
  await runner.detach(node);
  release();
  await p;

  const recA = await store.taskIn(pid, 'taskA');
  assert.ok(recA.resultAssetId, 'A 的结果仍应落进原任务记录');
  assert.equal(store.node(node.id).data.resultAssetId ?? null, null,
    'A1 缺陷复现：下载期间脱离后，收尾仍写入了节点 resultAssetId');
});

test('A1-3：下载进行中节点重绑B → 收尾不得写节点', async t => {
  const { storage, store, pid, fp } = await setup(t);
  let release;
  const gate = new Promise(r => { release = r; });
  const { api } = makeApi({ downloadContent: () => gate.then(() => ({ status: 200, contentType: 'video/mp4', blob: MP4() })) });
  const runner = makeRunner({ store, storage, api });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await bind(store, node, 'taskA', { status: 'completed', keyFp: fp });

  const p = runner.download('taskA');
  await sleep(20);
  await bind(store, node, 'taskB', { status: 'in_progress', keyFp: fp });   // 重绑（不经过 detach 的并行写入路径）
  release();
  await p;

  const recA = await store.taskIn(pid, 'taskA');
  const nodeNow = store.node(node.id);
  assert.equal(nodeNow.data.run?.taskId, 'taskB');
  assert.notEqual(nodeNow.data.resultAssetId, recA.resultAssetId ?? 'unset',
    'A1 缺陷复现：下载期间节点重绑 B 后，A 的收尾仍覆盖了节点输出');
});

test('A1-4：下载期间删除节点 → 不写（基线即安全，回归钉住）', async t => {
  const { storage, store, pid, fp } = await setup(t);
  let release;
  const gate = new Promise(r => { release = r; });
  const { api } = makeApi({ downloadContent: () => gate.then(() => ({ status: 200, contentType: 'video/mp4', blob: MP4() })) });
  const runner = makeRunner({ store, storage, api });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await bind(store, node, 'taskA', { status: 'completed', keyFp: fp });

  const p = runner.download('taskA');
  await sleep(20);
  store.removeNode?.(node.id) ?? store.project.nodes.splice(store.project.nodes.findIndex(n => n.id === node.id), 1);
  release();
  await p;

  const recA = await store.taskIn(pid, 'taskA');
  assert.ok(recA.resultAssetId, '结果仍存原任务记录');
  assert.equal(store.node(node.id), null, '节点已删除');
});
