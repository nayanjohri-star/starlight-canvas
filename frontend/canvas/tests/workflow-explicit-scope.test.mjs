// 工作流引擎层的范围防线（0.4.1）：UI 已拒绝空选择，但引擎本身也不得把
// 「未给范围 + 空 targets」隐式解释为全画布。全画布只能通过显式 scope:{kind:'all'}。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createWorkflow } from '../src/workflow.js';

const lock = async (_name, fn) => fn();
async function setup() {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('显式范围');
  const calls = [];
  const wf = createWorkflow({ store, storage, submitLock: lock, pollMs: 1,
    generators: { quote: () => 0.5, generate: async n => { calls.push(n.id); n.data.resultText = 'ok'; } } });
  const a = store.addNode('text', 0, 0, { title: 'A', model: 'mock-text', prompt: 'A' });
  const b = store.addNode('text', 0, 200, { title: 'B', model: 'mock-text', prompt: 'B' });
  return { store, wf, calls, a, b };
}

test('未给范围且 targets 缺省/为空：预检与启动都拒绝，零生成', async () => {
  const { wf, calls } = await setup();
  await assert.rejects(wf.preview({}), /空选择不启动/);
  await assert.rejects(wf.preview({ targets: [] }), /空选择不启动/);
  await assert.rejects(wf.start({ confirmed: true }), /空选择不启动/);
  await assert.rejects(wf.start({ targets: [], confirmed: true, onlyEmpty: true }), /空选择不启动/);
  assert.equal(calls.length, 0);
});

test('显式 scope:{kind:all} 才运行全画布；targets 仍按选择运行', async () => {
  const { wf, calls, a, b } = await setup();
  const pre = await wf.preview({ scope: { kind: 'all' } });
  assert.deepEqual([...pre.nodeIds].sort(), [a.id, b.id].sort());
  await wf.start({ targets: [a.id], confirmed: true });
  assert.deepEqual(calls, [a.id], '选择范围只运行所选节点');
  await wf.start({ scope: { kind: 'all' }, confirmed: true, onlyEmpty: true });
  assert.deepEqual(calls, [a.id, b.id], '显式全画布 + 仅补空白：只补 B');
});
