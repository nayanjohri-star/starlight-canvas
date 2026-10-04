// 存储安全修复回归：R02 未决记录导入重建提交保护、R03 perModel 瘦身、R11 导入原子写入、R12 快照绑定重映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';

const BODY = JSON.stringify({ model: 'wan-3.0', prompt: 'x', seconds: 5 });
const quotaErr = () => Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
// 无 batch 的注入存储（旧接口形态）：逐条 set，走 staged+rollback 路径
const storageWithoutBatch = inner => ({
  get: inner.get, set: inner.set, del: inner.del, keys: inner.keys,
  setIfRev: inner.setIfRev,
  getBlob: inner.getBlob, setBlob: inner.setBlob, delBlob: inner.delBlob,
});

test('R03 导入 perModel 仅保留控件设置：不携带型号/提示词，绑定照常重映射', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('t');
  store.project.assets['a1'] = { id: 'a1', name: 'x.png', kind: 'image', mime: 'image/png', size: 1, addedAt: 1 };
  store.addNode('asset', 0, 0, { assetId: 'a1' });
  store.addNode('gen', 10, 0, {
    title: 'gen',
    draft: { model: 'wan-3.0', prompt: '公共提示词', intent: 'text', seconds: 6, ratio: '16:9' },
    perModel: {
      // 旧版导出会把整份草稿（含补默认的 model/prompt）塞进 perModel
      'minimax-h3-768p-per-second': { model: 'minimax-h3-768p-per-second', prompt: '', intent: 'frames', seconds: 4, ratio: '9:16', switches: { generate_audio: false }, bindings: { 'image:1': 'a1' } },
    },
  });
  const imported = await store.importJSON(await store.exportJSON());
  const ng = imported.nodes.find(n => n.type === 'gen');
  const newAssetId = imported.nodes.find(n => n.type === 'asset').data.assetId;
  const saved = ng.data.perModel['minimax-h3-768p-per-second'];
  assert.ok(saved, 'perModel 条目保留');
  assert.ok(!('model' in saved), 'perModel 不得保存型号');
  assert.ok(!('prompt' in saved), 'perModel 不得保存提示词');
  assert.equal(saved.intent, 'frames');
  assert.equal(saved.seconds, 4);
  assert.equal(saved.ratio, '9:16');
  assert.equal(saved.switches.generate_audio, false);
  assert.equal(saved.bindings['image:1'], newAssetId, 'perModel 内绑定同样重映射到新素材');
  // 模拟检查器型号切换的展开：{ model: 新型号, prompt: 当前提示词, ...saved }
  const switched = { model: 'wan-3.0', prompt: ng.data.draft.prompt, bindings: ng.data.draft.bindings, ...saved };
  assert.equal(switched.model, 'wan-3.0', '切换后型号不得被 perModel 覆盖');
  assert.equal(switched.prompt, '公共提示词', '切换后提示词不得被 perModel 覆盖');
});

test('R12 导入 pending 快照的 draft.bindings 与 refIds 一致重映射，请求体原字节保留', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('t');
  store.project.assets['a1'] = { id: 'a1', name: 'v.mp4', kind: 'video', mime: 'video/mp4', size: 2, addedAt: 1 };
  store.addNode('asset', 0, 0, { assetId: 'a1' });
  const g = store.addNode('gen', 10, 0, { draft: { model: 'wan-3.0' } });
  const body = JSON.stringify({ model: 'wan-3.0', prompt: '@视频1 动一下', seconds: 5 });
  await store.savePendingCreate({
    idempotencyKey: 'k-snap', projectId: store.project.id, nodeId: g.id, model: 'wan-3.0',
    bodyString: body, keyFp: 'fp', createdAt: 123, state: 'uncertain',
    snapshot: {
      nodeId: g.id, refIds: ['a1'], frameIds: [], at: 99,
      draft: { model: 'wan-3.0', prompt: '@视频1 动一下', intent: 'refs', seconds: 5, ratio: '16:9', bindings: { 'video:1': 'a1' } },
    },
  });
  const imported = await store.importJSON(await store.exportJSON());
  const newAssetId = Object.keys(imported.assets)[0];
  const [rec] = await store.listPending();
  assert.equal(rec.idempotencyKey, 'k-snap');
  assert.equal(rec.snapshot.refIds[0], newAssetId);
  assert.equal(rec.snapshot.draft.bindings['video:1'], newAssetId, '快照绑定必须与 refIds 指向同一新素材');
  assert.equal(rec.snapshot.nodeId, imported.nodes.find(n => n.type === 'gen').id);
  assert.equal(rec.bodyString, body, '已发请求体保持原字节，不得为修引用改体重放');
});

test('R02 未决/超窗 pending 导入后在节点上重建提交保护；rejected 不阻塞新建', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('t');
  const pid = store.project.id;
  const mk = title => store.addNode('gen', 0, 0, { title, draft: { model: 'wan-3.0' } });
  const g1 = mk('g-unc'), g2 = mk('g-exp'), g3 = mk('g-rej'), g4 = mk('g-accepted'), g5 = mk('g-guarded');
  const old = Date.now() - 25 * 3600 * 1000;
  const rec = (key, nodeId, extra = {}) => ({ idempotencyKey: key, projectId: pid, nodeId, model: 'wan-3.0', bodyString: BODY, keyFp: 'fp', createdAt: Date.now(), state: 'uncertain', ...extra });
  await store.savePendingCreate(rec('k-unc', g1.id));
  await store.savePendingCreate(rec('k-exp', g2.id, { state: 'expired_window', createdAt: old }));
  await store.savePendingCreate(rec('k-rej', g3.id, { state: 'rejected', lastError: '400 bad_prompt' }));
  await store.savePendingCreate(rec('k-same', g4.id));
  await store.savePendingCreate(rec('k-other', g5.id));
  await store.saveTask({ taskId: 't-ok', projectId: pid, nodeId: g4.id, model: 'wan-3.0', status: 'completed', keyFp: 'fp', idempotencyKey: 'k-same', createdAt: 1 });
  await store.saveTask({ taskId: 't-unrelated', projectId: pid, nodeId: g5.id, model: 'wan-3.0', status: 'completed', keyFp: 'fp', idempotencyKey: 'different-key', createdAt: 1 });

  const imported = await store.importJSON(await store.exportJSON());
  const byTitle = t => imported.nodes.find(n => n.data.title === t);
  assert.deepEqual(byTitle('g-unc').data.run, { pendingKey: 'k-unc' }, '未决提交重建 pendingKey 保护');
  assert.deepEqual(byTitle('g-exp').data.run, { pendingKey: 'k-exp', detached: true, expired: true }, '超窗记录保持禁发保护');
  const rej = byTitle('g-rej').data.run;
  assert.equal(rej?.rejected, true);
  assert.equal(rej?.error, '400 bad_prompt');
  assert.equal(rej?.pendingKey, undefined, '明确拒绝的记录不阻塞新建');
  assert.deepEqual(byTitle('g-accepted').data.run, { taskId: 't-ok' }, '同键已受理任务优先于 pendingKey');
  assert.deepEqual(byTitle('g-guarded').data.run, { pendingKey: 'k-other', }, '另有未确认键时任务记录不覆盖保护');

  const pend = await store.listPending();
  assert.equal(pend.length, 5);
  const exp = pend.find(r => r.idempotencyKey === 'k-exp');
  assert.equal(exp.state, 'expired_window');
  assert.equal(exp.createdAt, old, 'createdAt 原样保留，窗口判定不失真');
  assert.equal(exp.bodyString, BODY, '幂等请求体原字节保留');
  assert.ok(pend.every(r => r.projectId === imported.id));
});

test('R02 导入文件里捏造的 run 字段不被信任', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('t');
  store.addNode('gen', 0, 0, { title: 'plain', draft: { model: 'wan-3.0' } });
  const exported = JSON.parse(await store.exportJSON());
  exported.project.nodes[0].data.run = { taskId: 'fake-task', pendingKey: 'fake-key' };
  const imported = await store.importJSON(JSON.stringify(exported));
  assert.equal(imported.nodes[0].data.run, undefined, '无持久化记录背书时不得复活 run');
});

test('R11 staged 路径：导入写入中途配额失败，当前项目不切换且新记录回滚', async () => {
  const storage = storageWithoutBatch(createMemoryStorage());
  const store = createStore(storage);
  await store.newProject('old');
  const oldId = store.project.id;
  await store.saveTask({ taskId: 't1', projectId: oldId, nodeId: 'g', model: 'wan-3.0', status: 'completed', keyFp: 'fp', createdAt: 1 });
  await store.savePendingCreate({ idempotencyKey: 'k1', projectId: oldId, nodeId: 'g', model: 'wan-3.0', bodyString: BODY, keyFp: 'fp', createdAt: 1, state: 'uncertain' });
  const text = await store.exportJSON();
  const beforeKeys = (await storage.keys()).sort();

  const realSet = storage.set;
  let failPrefix = null;
  storage.set = async (k, v) => { if (failPrefix && k.startsWith(failPrefix)) throw quotaErr(); return realSet(k, v); };
  failPrefix = 'pending:';   // 新命名空间的 pending 写入时抛错：project/task 已先写入
  await assert.rejects(() => store.importJSON(text), /QuotaExceeded/);

  assert.equal(store.project.id, oldId, '存储失败不得切换当前项目');
  assert.equal(await storage.get('lastOpened'), oldId, 'lastOpened 保持指向原项目');
  assert.deepEqual((await storage.keys()).sort(), beforeKeys, '新建命名空间记录全部回滚，既有数据不动');
});

test('R11 batch 路径：整体写入失败保持原项目；成功路径数据完整', async () => {
  const storage = createMemoryStorage();
  assert.equal(typeof storage.batch, 'function', '内存存储提供 batch');
  const store = createStore(storage);
  await store.newProject('old');
  const oldId = store.project.id;
  store.addNode('gen', 0, 0, { draft: { model: 'wan-3.0' } });
  await store.saveTask({ taskId: 't1', projectId: oldId, nodeId: 'g', model: 'wan-3.0', status: 'queued', keyFp: 'fp', createdAt: 1 });
  const text = await store.exportJSON();

  const failBatch = storage.batch;
  storage.batch = async () => { throw quotaErr(); };
  const beforeKeys = (await storage.keys()).sort();
  await assert.rejects(() => store.importJSON(text), /QuotaExceeded/);
  assert.equal(store.project.id, oldId);
  assert.equal(await storage.get('lastOpened'), oldId);
  assert.deepEqual((await storage.keys()).sort(), beforeKeys, 'batch 失败不留任何新键');

  storage.batch = failBatch;
  const imported = await store.importJSON(text);
  assert.equal(store.project.id, imported.id, '成功后切换当前项目');
  assert.equal(await storage.get('lastOpened'), imported.id);
  assert.ok(await storage.get(`project:${imported.id}`), '项目文档已入库');
  const tasks = await store.tasksOfProject();
  assert.equal(tasks[0].projectId, imported.id);
  assert.equal(tasks[0].taskId, 't1');
});

test('R11 导入开始时冲刷旧项目的防抖保存，未落盘编辑不丢', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('old');
  const oldId = store.project.id;
  const text = await store.exportJSON();
  const n = store.addNode('note', 1, 2, { text: 'unsaved-note' });   // 只调度 400ms 防抖写
  await store.importJSON(text);                                     // 内部必须先 flush 旧项目
  const persistedOld = await storage.get(`project:${oldId}`);
  assert.ok(persistedOld.nodes.some(x => x.id === n.id && x.data.text === 'unsaved-note'), '旧项目待写修改已落盘');
});

test('内存存储模拟克隆语义：读写不共享引用', async () => {
  const s = createMemoryStorage();
  const obj = { nested: { v: 1 } };
  await s.set('k', obj);
  obj.nested.v = 2;
  assert.equal((await s.get('k')).nested.v, 1, '入库后外部改动不可见');
  (await s.get('k')).nested.v = 3;
  assert.equal((await s.get('k')).nested.v, 1, '读出副本的改动不落库');
});
