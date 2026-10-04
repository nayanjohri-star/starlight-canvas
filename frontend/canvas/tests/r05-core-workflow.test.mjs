import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createWorkflow } from '../src/workflow.js';
import { setup, makeWorkflow, genDraft, seedTask, sleep } from './accept-helpers.mjs';
import * as keys from '../src/keyvault.js';

const lock = async (_name, fn) => fn();
async function fixture() {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('0.5 workflow');
  return { storage, store };
}
const paid = (store, name) => store.addNode('text', 0, 0, { title: name, model: 'mock-text', prompt: name });

test('新跑的上游结果被修改后，下游付费步骤暂停并要求重新确认', async () => {
  const { storage, store } = await fixture();
  const a = paid(store, 'A'), middle = paid(store, 'M'), downstream = paid(store, 'C');
  store.addEdge(a.id, 'out', middle.id, 'prompt', 'text');
  store.addEdge(middle.id, 'out', downstream.id, 'prompt', 'text');
  store.addEdge(a.id, 'out', downstream.id, 'prompt', 'text');
  const calls = [];
  const workflow = createWorkflow({ store, storage, submitLock: lock, generators: {
    quote: () => 0.1,
    generate: async node => {
      calls.push(node.data.title);
      node.data.resultText = node.data.title;
      if (node === middle) a.data.resultText = '外部修改';
    },
  } });
  await workflow.start({ targets: [downstream.id], confirmed: true });
  const run = workflow.getState();
  assert.deepEqual(calls, ['A', 'M']);
  assert.equal(run.status, 'paused');
  assert.equal(run.nodes[downstream.id].status, 'pending');
  assert.match(run.pauseReason, /上游产出/);
});

test('另一驱动器在付费前接管运行时，本驱动器停止且不发请求', async () => {
  const { storage, store } = await fixture();
  const node = paid(store, 'P');
  const read = storage.get;
  let stolen = false, calls = 0;
  storage.get = async key => {
    const value = await read(key);
    if (!stolen && key === 'project:' + store.project.id
      && value?.studio?.workflow?.nodes?.[node.id]?.status === 'submitting') {
      stolen = true;
      value.studio.workflow.driverId = 'other-driver';
    }
    return value;
  };
  const workflow = createWorkflow({ store, storage, submitLock: lock, generators: {
    quote: () => 0.1,
    generate: async () => { calls++; },
  } });
  await workflow.start({ targets: [node.id], confirmed: true });
  assert.equal(stolen, true);
  assert.equal(calls, 0);
});

const waitingRunner = () => {
  let submits = 0;
  return { runner: {
    async adoptDurable() { return true; },
    async recOf() { return { status: 'in_progress', executorVersion: 2 }; },
    async download() { throw new Error('在途任务不得下载'); },
    async submit() { submits++; throw new Error('续跑不得新建任务'); },
  }, posts: () => submits };
};
async function waitForWaiting(wf, nodeId) {
  for (let i = 0; i < 100 && wf.getState().nodes?.[nodeId]?.status !== 'waiting'; i++) await sleep(10);
  assert.equal(wf.getState().nodes[nodeId]?.status, 'waiting');
}

test('切回同一项目后按持久化运行身份继续在途任务，零新提交', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {}, run: { taskId: 'job' } });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'job', keyFp: fp, status: 'in_progress', executorVersion: 2 });
  await store.flush();
  const fake = waitingRunner(), wf = makeWorkflow({ store, storage, runner: fake.runner, pollMs: 10 });
  const first = wf.start({ targets: [node.id], confirmed: true });
  await waitForWaiting(wf, node.id);
  await store.newProject('other');
  await first;
  await store.openProject(pid); // 重新载入的项目对象不是切走前的同一个对象
  assert.equal(wf.getState().status, 'paused');
  const resumed = wf.resume();
  for (let i = 0; i < 100 && wf.getState().status !== 'running'; i++) await sleep(10);
  assert.equal(wf.getState().status, 'running', wf.getState().pauseReason);
  assert.ok(!(wf.getState().issues ?? []).includes('项目或密钥已变更，无法继续调度'));
  await wf.pause(); await resumed;
  assert.equal(fake.posts(), 0);
});

test('刷新遗留的旧驱动可接管并处理原任务，零新提交', async t => {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('stale-driver'); await keys.setKey('mock-stale-driver');
  t.after(() => keys.clearKey());
  const pid = store.project.id, fp = keys.getFingerprint();
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {}, run: { taskId: 'job' } });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'job', keyFp: fp, status: 'in_progress', executorVersion: 2 });
  const nodes = { [node.id]: { src: node.id, type: 'gen', status: 'waiting', taskId: 'job', cost: 0.6 } };
  store.project.studio ??= { version: 1, groups: [], shots: [], timeline: [], workflow: null };
  store.project.studio.workflow = { id: 'run_old', projectId: pid, keyFp: fp, driverId: 'dead-page',
    driverAt: Date.now() - 600_000, status: 'running', targets: [node.id], issues: [],
    rows: [{ id: 'row0', index: 0, status: 'running', nodeIds: [node.id] }], nodes, cursor: { row: 0 },
    estimatedSpendYuan: 0.6 };
  await store.flush();
  const secondStore = createStore(storage); await secondStore.openProject(pid);
  let posts = 0;
  const runner = { async adoptDurable() { return true; }, async recOf() { return { status: 'failed' }; },
    async download() { throw new Error('失败任务不得下载'); }, async submit() { posts++; } };
  const recovered = makeWorkflow({ store: secondStore, storage, runner, pollMs: 10 });
  await recovered.resume();
  assert.equal(recovered.getState().status, 'failed', '旧页面已失效时应实际运行至结果，而非只显示 running');
  assert.equal(posts, 0);
});

test('他端驱动仍存活时不可抢占，也不可代它暂停', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const node2 = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {}, run: { taskId: 'job2' } });
  await seedTask(store, { pid, nodeId: node2.id, taskId: 'job2', keyFp: fp, status: 'in_progress', executorVersion: 2 });
  await store.flush();
  const fake = waitingRunner();
  const live = makeWorkflow({ store, storage, runner: fake.runner, pollMs: 10 });
  const running = live.start({ targets: [node2.id], confirmed: true });
  await waitForWaiting(live, node2.id);
  const observerStore = createStore(storage); await observerStore.openProject(pid);
  const observer = makeWorkflow({ store: observerStore, storage, runner: fake.runner, pollMs: 10 });
  const owner = (await storage.get('project:' + pid)).studio.workflow.driverId;
  await observer.resume(); await observer.pause();
  const persisted = (await storage.get('project:' + pid)).studio.workflow;
  assert.equal(persisted.driverId, owner);
  assert.equal(persisted.status, 'running');
  await live.pause(); await running;
  assert.equal(fake.posts(), 0);
});

test('工程包导入的历史工作流明确要求重新预检，原任务身份仍可恢复', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {}, run: { taskId: 'job' } });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'job', keyFp: fp, status: 'in_progress', executorVersion: 2, idempotencyKey: 'original-key' });
  store.project.studio ??= { version: 1, groups: [], shots: [], timeline: [], workflow: null };
  store.project.studio.workflow = { id: 'run_import', projectId: pid, keyFp: fp, status: 'running',
    targets: [node.id], rows: [{ id: 'row', index: 0, status: 'running', nodeIds: [node.id] }],
    nodes: { [node.id]: { src: node.id, type: 'gen', status: 'waiting', taskId: 'job' } }, cursor: { row: 0 } };
  await store.flush();
  const imported = await store.importJSON(await store.exportJSON());
  assert.equal(imported.studio.workflow.imported, true);
  assert.match(imported.studio.workflow.pauseReason, /重新预检/);
  const fake = waitingRunner(), wf = makeWorkflow({ store, storage, runner: fake.runner });
  await assert.rejects(wf.resume(), /重新预检/);
  await assert.rejects(wf.retryRow('row'), /重新预检/);
  const rec = await store.task('job');
  assert.equal(rec.taskId, 'job');
  assert.equal(rec.idempotencyKey, 'original-key');
  assert.equal(fake.posts(), 0);
});

test('换密钥后继续或重试不会改写他端运行稿', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {}, run: { taskId: 'job' } });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'job', keyFp: fp, status: 'in_progress', executorVersion: 2 });
  store.project.studio ??= { version: 1, groups: [], shots: [], timeline: [], workflow: null };
  store.project.studio.workflow = { id: 'run_key', projectId: pid, keyFp: fp, status: 'paused',
    targets: [node.id], rows: [{ id: 'row', index: 0, status: 'paused', nodeIds: [node.id] }],
    nodes: { [node.id]: { src: node.id, type: 'gen', status: 'waiting', taskId: 'job' } }, cursor: { row: 0 } };
  await store.flush();
  const before = await storage.get('project:' + pid);
  await keys.setKey('different-key');
  const fake = waitingRunner(), wf = makeWorkflow({ store, storage, runner: fake.runner });
  await assert.rejects(wf.resume(), /密钥已变更/);
  await assert.rejects(wf.retryRow('row'), /密钥已变更/);
  assert.deepEqual(await storage.get('project:' + pid), before);
  assert.equal(fake.posts(), 0);
});
