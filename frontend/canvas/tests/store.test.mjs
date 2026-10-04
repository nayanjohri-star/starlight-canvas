// 项目存储：端口类型匹配、严格导入校验、id 全量重映射、密钥泄漏拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore, portAccepts } from '../src/store.js';

test('端口类型匹配规则', () => {
  assert.ok(portAccepts('media', 'image') && portAccepts('media', 'video') && portAccepts('media', 'audio'));
  assert.ok(portAccepts('image', 'image') && !portAccepts('image', 'video'));
  assert.ok(!portAccepts('media', 'file'));
});

test('待创建幂等记录/任务记录按项目命名空间隔离', async () => {
  const storage = createMemoryStorage();
  const s1 = createStore(storage), s2 = createStore(storage);
  await s1.newProject('A'); await s1.newProject('B');
  const pA = s1.project;
  await s1.saveTask({ taskId: 't1', projectId: pA.id, nodeId: 'g', model: 'wan-3.0', status: 'queued', keyFp: 'f' });
  await s2.newProject('C');
  await s2.saveTask({ taskId: 't1', projectId: s2.project.id, nodeId: 'g', model: 'wan-3.0', status: 'completed', keyFp: 'f' });
  // 同 taskId 不同项目互不覆盖
  assert.equal((await s1.tasksOfProject())[0].status, 'queued');
  assert.equal((await s2.tasksOfProject())[0].status, 'completed');
});

test('导出/导入：节点 id 与任务 nodeId 全量重映射，导演台 KV 键重映射', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('t');
  const a = store.addNode('asset', 0, 0, { assetId: 'a1', title: 'x' });
  const g = store.addNode('gen', 300, 0, { draft: { model: 'wan-3.0' } });
  const d = store.addNode('director', 600, 0, {});
  store.addEdge(a.id, 'out', g.id, 'refs', 'image');
  store.project.assets['a1'] = { id: 'a1', name: 'x.png', kind: 'image', mime: 'image/png', size: 10, addedAt: 1, remote: { url: 'https://x/y.png' } };
  await storage.set(`dir:${d.id}:composition`, '{"v":1}');
  await storage.set(`dircfg:${d.id}:theme`, 'dark');
  await store.saveTask({ taskId: 'task-1', projectId: store.project.id, nodeId: g.id, model: 'wan-3.0', status: 'completed', keyFp: 'fp' });
  await store.savePendingCreate({ idempotencyKey: 'k-1', projectId: store.project.id, nodeId: g.id, model: 'wan-3.0', bodyString: JSON.stringify({ model: 'wan-3.0', prompt: 'x', seconds: 5 }), keyFp: 'fp', createdAt: 1, state: 'uncertain' });

  const text = await store.exportJSON();
  assert.ok(!/authorization|bearer|secret/i.test(text), '导出不得含密钥字段');
  const exported = JSON.parse(text);
  assert.equal(exported.format, 'xingpan-canvas@2');
  assert.ok(Object.keys(exported.director).length === 2, '导演台 KV 随项目导出');

  const store2 = createStore(storage);
  const p2 = await store2.importJSON(text);
  assert.notEqual(p2.id, store.project.id);
  assert.equal(p2.nodes.length, 3);
  assert.equal(p2.edges.length, 1);
  const newGen = p2.nodes.find(n => n.type === 'gen'), newAsset = p2.nodes.find(n => n.type === 'asset');
  assert.equal(p2.edges[0].from.node, newAsset.id);
  assert.equal(p2.edges[0].to.node, newGen.id);
  const tasks = await store2.tasksOfProject();
  assert.equal(tasks[0].nodeId, newGen.id, '任务 nodeId 重映射');
  assert.equal(tasks[0].projectId, p2.id);
  const pend = await store2.listPending();
  assert.equal(pend[0].nodeId, newGen.id, 'pending nodeId 重映射');
  assert.equal(pend[0].idempotencyKey, 'k-1');
  // 素材换新 id 且标记缺文件；远端 url 不迁移；节点 assetId 指向新 id
  assert.ok(!p2.assets['a1'], '原素材 id 不复用');
  const impAsset = p2.assets[newAsset.data.assetId];
  assert.equal(impAsset.missing, true);
  assert.equal(impAsset.remote, undefined);
  assert.equal(impAsset.name, 'x.png');
  // 导演台 KV 键内节点 id 已重映射
  const newDir = p2.nodes.find(n => n.type === 'director');
  assert.equal(await storage.get(`dir:${newDir.id}:composition`), '{"v":1}');
  assert.equal(await storage.get(`dir:${d.id}:composition`), '{"v":1}', '原项目记录不动');
});

test('导入严格校验：拒绝坏格式/密钥字段/非法节点', async () => {
  const store = createStore(createMemoryStorage());
  await store.newProject('x');
  await assert.rejects(() => store.importJSON('{"a":1}'), /有效的画布导出/);
  await assert.rejects(() => store.importJSON(JSON.stringify({ format: 'xingpan-canvas@2', project: { name: 'x', nodes: [], edges: [] }, apiKey: 'sk-1' })), /密钥字段/);
  await assert.rejects(() => store.importJSON(JSON.stringify({ format: 'xingpan-canvas@2', project: { name: 'x', nodes: [{ id: 'n', type: 'evil', x: 0, y: 0 }], edges: [] } })), /节点数据不合法/);
  // 悬空连线整份拒绝（不静默丢线），且当前项目不被改动
  const cur = store.project.id;
  await assert.rejects(
    store.importJSON(JSON.stringify({ format: 'xingpan-canvas@2', project: { name: 'bad', nodes: [{ id: 'a', type: 'note', x: 0, y: 0, data: { text: 'hi' } }], edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'ghost', port: 'refs' } }] } })),
    /端点缺失/);
  assert.equal(store.project.id, cur);
});
