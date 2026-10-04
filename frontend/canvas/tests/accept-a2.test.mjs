// WO-D1 独立验收 A2（contracts §2 记录格式 v2 + §3 不变量；不替 A 改实现）：
// 「v2 任务导出→导入：状态不退化、不丢交付门槛、不新增 POST」；
// 「受损 v2（缺 executorVersion 带 v2 特征字段）按 v2 门槛处理，不降级为可下载旧任务」；
// 「legacy 记录（无 v2 特征字段）保持 legacy 行为」。
// 基线预期：字段白名单断言 RED（sanitizeTask 丢 v2 字段）；门槛断言随之 RED。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { setup, makeApi, makeRunner, stubAssets, genDraft, seedTask, sleep, MP4, MODEL } from './accept-helpers.mjs';

const V2_EXP = 1730000000000;

async function roundtrip(t, taskFields, { seedAssets = false } = {}) {
  const { storage, store, pid, fp } = await setup(t);
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  if (seedAssets) {
    store.project.assets.a_src = { id: 'a_src', kind: 'video', name: 'v.mp4', size: 1, mime: 'video/mp4', missing: false };
    taskFields.resultAssetId = 'a_src';
  }
  await seedTask(store, { pid, nodeId: node.id, taskId: taskFields.taskId, keyFp: fp, ...taskFields });
  const text = await store.exportJSON();

  const storage2 = createMemoryStorage();
  const store2 = createStore(storage2);
  // 服务端视图与种子记录一致：resumeAll 若触发 poll，合并不该改变任务语义
  const serverView = {
    status: taskFields.status, stage: taskFields.stage,
    content_ready: taskFields.contentReady, delivery_status: taskFields.deliveryStatus,
    executor_version: taskFields.executorVersion, progress: taskFields.progress,
  };
  const { api, calls } = makeApi({ getTask: async () => serverView });
  const runner2 = makeRunner({ store: store2, storage: storage2, api });
  await store2.importJSON(text);
  await runner2.resumeAll();                       // 忠实启动路径：填充任务缓存（poll 只允许 GET，绝不允许 POST）
  return { store2, runner2, calls, pid2: store2.project.id, serverView };
}

test('A2-1：v2 completed+contentReady=false 导出→导入不退化，保持等待不丢门槛零POST', async t => {
  const { store2, runner2, calls, pid2 } = await roundtrip(t, {
    taskId: 'v2job',
    status: 'completed', executorVersion: 2, contentReady: false,
    stage: 'delivering', deliveryStatus: 'ready', progress: 100,
    cancelRequested: true, cancelPhase: 'stopping', downloadExpiresAt: V2_EXP,
    idempotencyKey: 'idem-v2', resultType: 'video/mp4',
  });
  const rec = (await store2.tasksOfProject()).find(x => x.taskId === 'v2job');
  assert.ok(rec, '任务记录应随导入存在');
  // 字段白名单（contracts §2）：全部必须保留
  for (const [f, v] of Object.entries({
    executorVersion: 2, contentReady: false, stage: 'delivering',
    cancelRequested: true, cancelPhase: 'stopping', downloadExpiresAt: V2_EXP,
    resultType: 'video/mp4', idempotencyKey: 'idem-v2',
  })) {
    assert.equal(rec[f], v, `A2 缺陷复现：导入丢失字段 ${f}（${JSON.stringify(v)} → ${JSON.stringify(rec[f])}）`);
  }
  // 交付门槛：v2 completed 但 contentReady≠true → 不可下载、仍应跟踪
  assert.equal(runner2.canDownload('v2job', pid2), false,
    'v2 completed+contentReady=false 导入后不得被当成可下载旧任务');
  assert.equal(runner2.taskLive('v2job', pid2), true,
    'v2 交付未就绪任务导入后仍应保持跟踪（不可判终态）');
  assert.equal(calls.creates.length, 0, '导入恢复全程零生成 POST');
});

test('A2-2：受损 v2（缺 executorVersion 带 v2 特征字段）不降级为可下载旧任务', async t => {
  const { store2, runner2, calls, pid2 } = await roundtrip(t, {
    taskId: 'dmgjob',
    status: 'completed', contentReady: false, stage: 'delivering',
    deliveryStatus: 'ready', progress: 100, idempotencyKey: 'idem-dmg',
  });
  const rec = (await store2.tasksOfProject()).find(x => x.taskId === 'dmgjob');
  assert.ok(rec);
  assert.equal(runner2.canDownload('dmgjob', pid2), false,
    '受损 v2 记录须按 v2 门槛处理（isV2Record 判真），不得按 legacy 放行下载');
  assert.equal(runner2.taskLive('dmgjob', pid2), true, '受损 v2 未就绪仍应跟踪');
  assert.equal(calls.creates.length, 0);
});

test('A2-3：legacy 记录（无 v2 特征字段）往返保持 legacy 行为（兼容政策回归钉住）', async t => {
  const { store2, runner2, pid2 } = await roundtrip(t, {
    taskId: 'legacyjob',
    status: 'completed', progress: 100, idempotencyKey: 'idem-lg',
  });
  const rec = (await store2.tasksOfProject()).find(x => x.taskId === 'legacyjob');
  assert.ok(rec);
  assert.equal(rec.status, 'completed');
  assert.equal(runner2.canDownload('legacyjob', pid2), true, 'legacy completed 无 v2 门槛，应可下载');
  assert.equal(runner2.taskLive('legacyjob', pid2), false);
});

test('A2-4：resultAssetId 随导入重映射且指向存在素材；resultBlobId 按设计不导出', async t => {
  const { store2, calls } = await roundtrip(t, {
    taskId: 'linkjob',
    status: 'completed', progress: 100, idempotencyKey: 'idem-lk',
  }, { seedAssets: true });
  const rec = (await store2.tasksOfProject()).find(x => x.taskId === 'linkjob');
  assert.ok(rec);
  assert.equal(rec.resultBlobId, null, '结果 blob 按设计不随导出');
  assert.ok(rec.resultAssetId, 'A2 缺陷复现：resultAssetId 导入丢失（任务→素材关联断裂）');
  assert.ok(store2.project.assets[rec.resultAssetId],
    `resultAssetId 应重映射到导入后的素材 id（得到 ${rec.resultAssetId}）`);
  assert.equal(calls.creates.length, 0);
});

test('A2-5：导入后等待→服务端 ready（真实 getTask→merge 路径）→可下载', async t => {
  const { store2, runner2, pid2, serverView } = await roundtrip(t, {
    taskId: 'v2wait',
    status: 'in_progress', executorVersion: 2, stage: 'running',
    deliveryStatus: 'ready', progress: 60, idempotencyKey: 'idem-w',
  });
  // 导入后任务未终态：执行器口径不可下载、仍跟踪（storage 读回的是克隆体，
  // 不得直接改它模拟服务端——真实更新路径是 poll→mergeTaskResponse 原地合并缓存记录）
  assert.equal(runner2.canDownload('v2wait', pid2), false, '未 ready 前不得可下载');
  assert.equal(runner2.taskLive('v2wait', pid2), true, '未终态应保持跟踪');

  // 服务端稍后交付：翻转为 ready 响应，走真实 runner.poll→GET→normalize/merge 路径
  Object.assign(serverView, {
    status: 'completed', stage: 'succeeded', delivery_status: 'ready',
    content_ready: true, executor_version: 2, progress: 100,
  });
  runner2.poll('v2wait', pid2);            // tick 约 1200ms 后发起 getTask 并合并
  await sleep(1400);

  const rec = await runner2.recOf('v2wait', pid2);
  assert.equal(rec.contentReady, true, 'content_ready 应经归一化合并写入缓存记录');
  assert.equal(rec.status, 'completed');
  assert.equal(runner2.canDownload('v2wait', pid2), true, '服务端明确 ready 后才可下载');
});
