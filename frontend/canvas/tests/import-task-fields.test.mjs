// A2 任务记录 v2 字段导入恢复验收（合同 §2 记录格式 v2 / §3「恢复、导入不得产生新的生成 POST」）：
//  · 白名单补齐 + recVersion 盖戳；resultAssetId 经 assetIdMap 重映射
//  · 读宽容：legacy 保持 legacy 行为；受损 v2（缺 executorVersion 带特征字段）按 v2 门槛
//  · 绝不补默认值把 v2 任务降成可下载旧任务；pollError/pollFails 瞬态不迁移；resultBlobId 不导出
// 内存 storage + mock api，零网络零付费。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createAssets } from '../src/assets.js';
import { createTaskRunner } from '../src/gennode.js';
import { setKey } from '../src/keyvault.js';
import { TASK_REC_VERSION, isV2Record, isSettled, canFetchContent, needsTracking } from '../src/task-status.js';

globalThis.document = { getElementById: () => null, createElement: () => ({ append() {}, remove() {}, setAttribute() {}, style: {} }) };
const passthrough = (_name, fn) => fn();

async function roundtrip(taskFields, { withAsset } = {}) {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('A2往返');
  const g = store.addNode('gen', 0, 0, { draft: { model: 'minimax-h3-768p-per-second' }, perModel: {} });
  const pid = store.project.id;
  if (withAsset) store.project.assets.a1 = { id: 'a1', name: '成片-v2.mp4', kind: 'video', mime: 'video/mp4', size: 8, addedAt: 1, fromTask: 'v2job' };
  await store.saveTask({ taskId: 'v2job', projectId: pid, nodeId: g.id, model: 'minimax-h3-768p-per-second', keyFp: 'fp', createdAt: 1, ...taskFields });
  const text = await store.exportJSON();
  const store2 = createStore(storage);
  await store2.importJSON(text);
  const rec = (await store2.tasksOfProject()).find(t => t.taskId === 'v2job');
  return { storage, store, store2, rec };
}

test('A2-1 v2 completed+contentReady=false 往返：门槛保留、recVersion 盖戳、仍可继续查询', async () => {
  const { rec } = await roundtrip({
    status: 'completed', executorVersion: 2, contentReady: false,
    stage: 'delivering', deliveryStatus: 'delivering', progress: 100,
    cancelRequested: true, cancelPhase: 'stopping', downloadExpiresAt: 1730000000000,
    resultType: 'video/mp4', authFailed: false, resultDeferred: false, updatedAt: 42,
  });
  assert.equal(rec.recVersion, TASK_REC_VERSION, '导入盖本地格式版本戳');
  assert.equal(rec.executorVersion, 2);
  assert.equal(rec.contentReady, false, 'contentReady=false 不得丢成 legacy');
  assert.equal(rec.stage, 'delivering');
  assert.equal(rec.cancelRequested, true);
  assert.equal(rec.cancelPhase, 'stopping');
  assert.equal(rec.downloadExpiresAt, 1730000000000);
  assert.equal(rec.resultType, 'video/mp4');
  assert.equal(rec.updatedAt, 42);
  assert.equal(isV2Record(rec), true);
  assert.equal(canFetchContent(rec), false, '未 ready 的 v2 任务导入后仍不得下载');
  assert.equal(isSettled(rec), false, '交付中未终结');
  assert.equal(needsTracking(rec), true, '未暂停未脱离：导入后仍可继续查询');
});

test('A2-2 resultAssetId 经 assetIdMap 重映射到新素材；瞬态字段不迁移', async () => {
  const { store2, rec } = await roundtrip({
    status: 'completed', executorVersion: 2, contentReady: true,
    resultAssetId: 'a1', pollError: 'boom', pollFails: 3, resultBlobId: 'result:p:v2job',
  }, { withAsset: true });
  const newAid = rec.resultAssetId;
  assert.ok(newAid && newAid !== 'a1', '素材关联必须重映射到新 id');
  assert.ok(store2.project.assets[newAid]?.fromTask === 'v2job', '新素材存在且归属本任务');
  assert.equal(rec.resultBlobId, null, '结果 blob 不随导出');
  assert.equal(rec.pollError, undefined, 'pollError 瞬态不迁移');
  assert.equal(rec.pollFails, undefined, 'pollFails 瞬态不迁移');
  assert.equal(canFetchContent(rec), true, 'v2 ready 任务导入后可下载');
});

test('A2-3 兼容政策：legacy 按旧行为；受损 v2 按 v2 门槛不降级；恢复零 POST', async () => {
  // legacy：无任何 v2 特征字段 → 旧行为放行
  const { rec: leg } = await roundtrip({ status: 'completed' });
  assert.equal(isV2Record(leg), false);
  assert.equal(canFetchContent(leg), true, 'legacy completed 按原行为可下载');

  // 受损 v2：缺 executorVersion 但带 stage/contentReady → 按 v2 门槛，不放行
  const { rec: dmg } = await roundtrip({ status: 'completed', contentReady: false, stage: 'delivering' });
  assert.equal(dmg.executorVersion, undefined, '缺失即缺失，不补默认版本');
  assert.equal(isV2Record(dmg), true, '受损 v2 判真');
  assert.equal(canFetchContent(dmg), false, '受损 v2 不得降成可下载旧任务');

  // 恢复零 POST：导入项目跑 resumeAll/restoreTask 只发 GET，绝不新创建
  const { storage, store, store2 } = await roundtrip({
    status: 'completed', executorVersion: 2, contentReady: false, stage: 'delivering',
  });
  let posts = 0, gets = 0;
  const api = {
    createTask: async () => { posts++; throw new Error('不得发起创建'); },
    getTask: async () => { gets++; return { status: 'in_progress', executor_version: 2, content_ready: false }; },
    cancelTask: async () => { posts++; throw new Error('不得发起取消'); },
    downloadContent: async () => { gets++; return { contentType: 'video/mp4', blob: new Blob([1], { type: 'video/mp4' }) }; },
  };
  const assets = createAssets({ store: store2, storage, api });
  const runner = createTaskRunner({ store: store2, storage, api, assets, submitLock: passthrough });
  await setKey('mock-a2');   // 与导入记录 keyFp 不同 → paused 不查询；先验证身份守卫
  const g2 = store2.project.nodes.find(n => n.type === 'gen');
  assert.ok(g2.data.run?.taskId === 'v2job', '导入后节点关联已重建');
  const node2 = await runner.restoreTask('v2job', store2.project.id);
  assert.ok(node2, '找回不依赖密钥一致');
  assert.equal(posts, 0, '恢复/找回全程零 POST');
  assert.equal(gets, 0, '密钥不符时连 GET 都不发');
});

test('A2-补 导入重建 detached 不复活节点绑定；resultDeferred/authFailed 保留', async () => {
  const { store2, rec } = await roundtrip({
    status: 'in_progress', executorVersion: 2, contentReady: false,
    detached: true, authFailed: true, resultDeferred: true, paused: true,
  });
  assert.equal(rec.detached, true);
  assert.equal(rec.authFailed, true);
  assert.equal(rec.resultDeferred, true);
  assert.equal(rec.paused, true);
  const g = store2.project.nodes.find(n => n.type === 'gen');
  assert.equal(g.data.run?.taskId, undefined, 'detached 任务不得重建节点绑定');
});
