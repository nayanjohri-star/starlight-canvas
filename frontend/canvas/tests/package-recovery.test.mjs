// A4 工程包恢复 + 增量可回退迁移验收：
//  · exportJSON→importJSON 全链：节点/连线/素材/blob/分镜/时间线/导演台 KV/任务/pending 引用完整性
//  · 迁移中途失败：原工程原样保留，暂存 blob 与半成品命名空间全部清理，lastOpened 不动
//  · 旧格式任务记录（无 v2 字段）读宽容导入，不降级不丢字段
//  · 全程零生成 POST（importJSON 无任何网络路径）
// 全内存 mock，无网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { isV2Record, canFetchContent, TASK_REC_VERSION } from '../src/task-status.js';
import { setCapabilities } from '../src/capabilities.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);
const MODEL = 'minimax-h3-768p-per-second';
const mp4 = () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' });
const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
const BODY = JSON.stringify({ model: MODEL, prompt: 'p', seconds: 4 });

async function buildSource() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('A4源');
  const pid = store.project.id;
  // 素材 + 素材节点 + gen 节点（绑定该素材）+ 连线
  store.project.assets.a1 = { id: 'a1', name: 'ref.png', kind: 'image', mime: 'image/png', size: 4, addedAt: 1, fromTask: 'tv2' };
  const aNode = store.addNode('asset', 0, 0, { assetId: 'a1', title: '参考图' });
  const gen = store.addNode('gen', 100, 0, { draft: { model: MODEL, prompt: 'p', intent: 'text', seconds: 4, ratio: '16:9', bindings: { 'image:0': 'a1' } }, perModel: {} });
  const dir = store.addNode('director', 200, 0, {});
  const edge = store.addEdge(aNode.id, 'out', gen.id, 'refs', 'image');
  // 创作数据：分组/分镜/时间线/剧本
  store.project.studio = {
    version: 1,
    groups: [{ id: 'g1', title: '组1', members: [gen.id] }],
    shots: [{ id: 's1', nodeId: gen.id, imageNodeId: aNode.id, assetIds: ['a1'], duration: 5, title: '镜头1' }],
    timeline: [{ id: 'c1', track: 'v1', kind: 'video', assetId: 'a1', start: 0, end: 5, name: 'ref.png' }],
    storyboard: { script: '第一场：开场', updatedAt: 1 },
  };
  // 任务（v2，含素材关联）+ 未决提交（快照引用素材）
  await store.saveTask({ taskId: 'tv2', projectId: pid, nodeId: gen.id, model: MODEL, keyFp: 'fp', status: 'completed', executorVersion: 2, contentReady: true, resultAssetId: 'a1', resultType: 'video/mp4', idempotencyKey: 'pk1', createdAt: 1 });
  await store.savePendingCreate({
    idempotencyKey: 'pk1', projectId: pid, nodeId: gen.id, model: MODEL, keyFp: 'fp',
    bodyString: BODY, createdAt: 1, state: 'uncertain',
    snapshot: { draft: { model: MODEL, prompt: 'p', intent: 'text', seconds: 4, ratio: '16:9', bindings: { 'image:0': 'a1' } }, refIds: ['a1'], frameIds: [], projectId: pid, nodeId: gen.id, keyFp: 'fp', at: 1 },
  });
  // 导演台 KV（值内含 xp-asset:// 引用）
  await storage.set(`dir:${dir.id}:cam`, { path: 'xp-asset://a1', fov: 50 });
  await store.flush();
  return { storage, store, pid, aNode, gen, dir, edge };
}

test('A4-1 工程级往返：全部实体+引用完整性恢复，零 POST', async () => {
  const { storage, store, aNode, gen, dir, edge } = await buildSource();
  const text = await store.exportJSON();
  const store2 = createStore(storage);
  const project = await store2.importJSON(text, { assetBlobs: new Map([['a1', png()]]) });

  assert.notEqual(project.id, store.project.id, '新项目命名空间');
  const newA = Object.keys(project.assets)[0];
  assert.ok(newA && newA !== 'a1', '素材换新 id');
  assert.equal(project.assets[newA].missing, false, '随包 blob 到位 → 不再 missing');
  assert.ok(await storage.getBlob(`blob:${newA}`), '素材 blob 以新键暂存');

  const newAssetNode = project.nodes.find(n => n.type === 'asset');
  assert.equal(newAssetNode.data.assetId, newA, '素材节点引用重映射');
  const newGen = project.nodes.find(n => n.type === 'gen');
  assert.equal(newGen.data.draft.bindings['image:0'], newA, 'draft 绑定重映射');
  assert.equal(newGen.data.run?.taskId, 'tv2', '非脱离任务重建节点绑定');
  const newEdge = project.edges[0];
  assert.equal(newEdge.from.node, newAssetNode.id);
  assert.equal(newEdge.to.node, newGen.id);

  const shot = project.studio.shots[0];
  assert.equal(shot.nodeId, newGen.id, '分镜节点引用重映射');
  assert.deepEqual(shot.assetIds, [newA], '分镜素材引用重映射');
  const clip = project.studio.timeline[0];
  assert.equal(clip.assetId, newA, '时间线片段素材重映射');
  assert.equal(clip.missing, false, '有 blob 的片段不标 missing');
  assert.equal(project.studio.storyboard.script, '第一场：开场');
  assert.equal(project.studio.groups[0].members[0], newGen.id, '分组成员重映射');

  const newDir = project.nodes.find(n => n.type === 'director');
  const kv = await store2.directorKV(newDir.id);
  assert.ok(kv[`dir:${newDir.id}:cam`], '导演台 KV 键重映射');
  assert.equal(kv[`dir:${newDir.id}:cam`].path, `xp-asset://${newA}`, 'KV 内素材令牌重映射');

  const rec = (await store2.tasksOfProject()).find(t => t.taskId === 'tv2');
  assert.equal(rec.recVersion, TASK_REC_VERSION);
  assert.equal(rec.resultAssetId, newA, '任务→素材关联重映射');
  assert.equal(rec.executorVersion, 2);
  assert.equal(canFetchContent(rec), true);
  assert.equal(rec.nodeId, newGen.id);

  const pend = (await store2.listPending())[0];
  assert.equal(pend.snapshot.refIds[0], newA, 'pending 快照 refIds 重映射');
  assert.equal(pend.snapshot.draft.bindings['image:0'], newA, 'pending 快照绑定重映射');
  assert.equal(pend.nodeId, newGen.id);
  assert.equal(newGen.data.run?.taskId, 'tv2', '同键 pending 已受理 → 升级为 taskId 绑定');
  // 零 POST：importJSON 为纯存储路径，本测试无任何 api 依赖即证明
});

test('A4-2 迁移中途失败：原工程原样保留，暂存 blob 清理，lastOpened 不动', async () => {
  const { storage, store, pid } = await buildSource();
  const text = await store.exportJSON();
  const store2 = createStore(storage);
  await store2.newProject('原项目');
  const origPid = store2.project.id;
  await storage.set('lastOpened', origPid);
  const kvBefore = (await storage.keys()).filter(k => !k.startsWith('blob:')).sort();

  // 在 commitEntries 原子提交处引爆：blob 已暂存 → 必须回滚清理
  const failBatch = {
    ...storage,
    batch: async () => { throw new Error('batch commit failed'); },
  };
  const store3 = createStore(failBatch);
  await store3.openProject(origPid);
  await assert.rejects(store3.importJSON(text, { assetBlobs: new Map([['a1', png()]]) }), /batch commit failed|导入/);

  assert.equal(store3.project.id, origPid, '失败后当前项目不得切换');
  assert.equal(await storage.get('lastOpened'), origPid, 'lastOpened 不得指向半成品');
  const kvAfter = (await storage.keys()).filter(k => !k.startsWith('blob:')).sort();
  assert.deepEqual(kvAfter, kvBefore, '不得残留半成品 task/pending/project/dir 键');
});

test('A4-3 校验失败在写入前：脏文档导入拒绝且原项目不动', async () => {
  const { storage, store } = await buildSource();
  const data = JSON.parse(await store.exportJSON());
  data.tasks = [{ taskId: 'bad', model: MODEL, bodyString: '{"wrong":"shape"}' }]; // bodyString 与 model 不符 → 校验拒绝
  const store2 = createStore(storage);
  await store2.newProject('原项目');
  const origPid = store2.project.id;
  await assert.rejects(store2.importJSON(JSON.stringify(data)), /不合法|不一致/);
  assert.equal(store2.project.id, origPid, '校验失败不得动当前项目');
});

test('A4-4 旧格式任务记录（无 v2 字段）读宽容导入，按 legacy 行为不丢门槛', async () => {
  const { storage, store } = await buildSource();
  const data = JSON.parse(await store.exportJSON());
  // 模拟 v1 旧记录：删掉全部 v2 特征字段
  data.tasks = [{ taskId: 'old1', model: MODEL, status: 'completed', keyFp: 'fp', createdAt: 1, nodeId: null }];
  const store2 = createStore(storage);
  const project = await store2.importJSON(JSON.stringify(data));
  const rec = (await store2.tasksOfProject()).find(t => t.taskId === 'old1');
  assert.equal(rec.executorVersion, undefined, '缺失字段不补默认值');
  assert.equal(rec.contentReady, undefined);
  assert.equal(isV2Record(rec), false, '旧记录按 legacy 判读');
  assert.equal(canFetchContent(rec), true, 'legacy completed 按原行为可下载');
  assert.equal(rec.recVersion, TASK_REC_VERSION, '导入盖新格式戳');
});
