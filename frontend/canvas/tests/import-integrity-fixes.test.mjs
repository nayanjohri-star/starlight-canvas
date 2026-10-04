import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';

const model = 'minimax-h3-768p-per-second';
const draft = () => ({ model, prompt: 'mock import', intent: 'refs', seconds: 4, ratio: '16:9' });
async function fixture() {
  const s = createStore(createMemoryStorage()); await s.newProject('mock');
  const node = s.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  return { s, node };
}
test('导入保留快照缺失素材空位，不悄悄缩减参考数组', async () => {
  const { s, node } = await fixture();
  await s.savePendingCreate({ projectId: s.project.id, nodeId: node.id, model, idempotencyKey: 'mock-missing', bodyString: null, state: 'uncertain', snapshot: { nodeId: node.id, draft: draft(), refIds: ['missing'], frameIds: ['missing'] } });
  await s.importJSON(await s.exportJSON()); const rec = (await s.listPending())[0];
  assert.deepEqual(rec.snapshot.refIds, [null]); assert.deepEqual(rec.snapshot.frameIds, [null]); await s.flush();
});
test('导入检查原始请求体内的密钥字段，拒绝后原项目不变', async () => {
  const { s, node } = await fixture(), original = s.project;
  const data = JSON.parse(await s.exportJSON());
  data.pending = [{ projectId: original.id, nodeId: node.id, model, idempotencyKey: 'mock-planted', bodyString: JSON.stringify({ model, prompt: 'mock', seconds: 4, metadata: { authorization: 'mock-value-not-a-secret' } }) }];
  await assert.rejects(s.importJSON(JSON.stringify(data)), /密钥字段/); assert.equal(s.project, original);
});
test('导入与交互均拒绝无效的连线来源端口', async () => {
  const { s, node } = await fixture(); const note = s.addNode('note', 20, 20, { text: 'mock' });
  assert.equal(s.addEdge(note.id, 'out', node.id, 'refs', 'image'), null);
  assert.equal(s.addEdge('missing', 'out', node.id, 'refs', 'image'), null);
  const data = JSON.parse(await s.exportJSON());
  data.project.edges = [{ id: 'mock-edge', from: { node: note.id, port: 'out' }, to: { node: node.id, port: 'refs' } }];
  await assert.rejects(s.importJSON(JSON.stringify(data)), /来源端口/); await s.flush();
});

test('新建或切换项目先保存最后一笔尚未防抖落盘的修改', async () => {
  const { s, node } = await fixture(), originalId = s.project.id;
  node.data.draft.prompt = '立即切换也不能丢失'; s.saveSoon();
  await s.newProject('第二个项目'); const secondId = s.project.id;
  const note = s.addNode('note', 0, 0, { text: '尚未落盘' });
  await s.openProject(originalId);
  assert.equal(s.node(node.id).data.draft.prompt, '立即切换也不能丢失');
  await s.openProject(secondId); assert.equal(s.node(note.id).data.text, '尚未落盘'); await s.flush();
});
