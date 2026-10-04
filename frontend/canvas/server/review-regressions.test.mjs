// Independent acceptance regressions from Codex's second source review.
// These use only memory storage, disposable DOM stubs, and a mock upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { buildCreateBody, setCapabilities } from '../src/capabilities.js';
import { createTaskRunner } from '../src/gennode.js';
import * as keys from '../src/keyvault.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);
const model = 'minimax-h3-768p-per-second';
const draft = (intent = 'text') => ({ model, intent, prompt: '移动镜头展示桌面模型', seconds: 4, ratio: '16:9', switches: {} });
const element = () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} });
globalThis.document = { createElement: element, getElementById: element };

async function setup(t) {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('acceptance-test');
  t.after(async () => { await store.flush(); keys.clearKey(); });
  await keys.setKey('canvas-disposable-test-key');
  keys.setAvailableModels([model]);
  return { storage, store };
}

test('asynchronous task completion remains in its original project after a project switch', async t => {
  const { storage, store } = await setup(t);
  const originalProject = store.project.id;
  const rec = { taskId: 'mock_task', projectId: originalProject, nodeId: 'mock_node', model, status: 'queued' };
  await store.newProject('another-project');
  const nextProject = store.project.id;
  await store.saveTask(rec);
  assert.equal((await storage.get(`task:${originalProject}:mock_task`))?.projectId, originalProject);
  assert.equal(await storage.get(`task:${nextProject}:mock_task`), undefined);
});

test('project import never reuses original local blob identifiers', async t => {
  const { store } = await setup(t);
  store.project.assets.original_asset = { id: 'original_asset', name: 'reference.png', kind: 'image', mime: 'image/png', size: 100 };
  store.addNode('asset', 0, 0, { assetId: 'original_asset' });
  const exported = await store.exportJSON();
  const imported = await store.importJSON(exported);
  assert.ok(!Object.hasOwn(imported.assets, 'original_asset'), 'rebinding an imported file must not replace the original project blob');
  assert.ok(imported.assets[imported.nodes[0].data.assetId]);
});

test('invalid imported connections reject the entire import without changing the open project', async t => {
  const { store } = await setup(t);
  const originalProject = store.project.id;
  const exported = JSON.parse(await store.exportJSON());
  exported.project.edges.push({ id: 'bad_edge', from: { node: 'missing', port: 'out' }, to: { node: 'also_missing', port: 'refs' }, order: 0 });
  await assert.rejects(store.importJSON(JSON.stringify(exported)), /.+/);
  assert.equal(store.project.id, originalProject);
});

test('expired reference cannot be serialized into a billable create request', () => {
  const reference = { id: 'a', name: 'old.png', kind: 'image', remote: { url: 'https://xingpan.site/reference-assets/mock.png', expiresAt: 1 } };
  assert.throws(() => buildCreateBody(model, draft('refs'), [reference], []), /.+/);
});

test('unknown reference type must not silently become a text-only create request', () => {
  const reference = { id: 'a', name: 'scene.glb', kind: 'file', remote: { url: 'https://xingpan.site/reference-assets/mock.glb', expiresAt: Date.now() / 1000 + 86400 } };
  assert.throws(() => buildCreateBody(model, draft('refs'), [reference], []), /.+/);
});

test('uncertain submission cannot be detached and immediately submitted with another idempotency key', async t => {
  const { storage, store } = await setup(t);
  let creates = 0;
  const api = { async createTask() { creates++; throw Object.assign(new Error('mock timeout'), { status: 502 }); } };
  const runner = createTaskRunner({ store, storage, api, assets: { remoteValid: () => false } });
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  await runner.submit(node);
  await runner.detach(node);
  await runner.submit(node);
  assert.equal(creates, 1, 'unknown billable request must retain a retry guard');
});

test('a reference removed during upload must stop creation rather than be filtered out', async t => {
  const { storage, store } = await setup(t);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let creates = 0;
  const expiry = Date.now() / 1000 + 86400;
  for (const id of ['a1', 'a2']) store.project.assets[id] = { id, name: `${id}.png`, kind: 'image', remote: null };
  const node = store.addNode('gen', 0, 0, { draft: draft('refs'), perModel: {} });
  for (const id of ['a1', 'a2']) {
    const source = store.addNode('asset', 0, 0, { assetId: id });
    store.addEdge(source.id, 'out', node.id, 'refs', 'image');
  }
  const originalAssets = { ...store.project.assets };
  const assets = {
    assetOfNode: n => store.project.assets[n.data.assetId],
    remoteValid: () => false,
    async upload(id) { await wait; originalAssets[id].remote = { url: `https://xingpan.site/reference-assets/${id}.png`, expiresAt: expiry, keyFp: keys.getFingerprint() }; },
  };
  const api = { async createTask() { creates++; throw Object.assign(new Error('mock uncertain'), { status: 502 }); } };
  const runner = createTaskRunner({ store, storage, api, assets });
  const submission = runner.submit(node);
  delete store.project.assets.a2;
  release();
  await submission.catch(() => {});
  assert.equal(creates, 0, 'the complete reference snapshot must survive until POST');
});

test('a fresh SD reference video is uploaded before server-probed duration is required', async t => {
  const { storage, store } = await setup(t);
  const sd = 'seedance-2.5-vip-480p';
  keys.setAvailableModels([sd]);
  const reference = { id: 'fresh_video', name: 'reference.mp4', kind: 'video', remote: null };
  store.project.assets[reference.id] = reference;
  const source = store.addNode('asset', 0, 0, { assetId: reference.id });
  const node = store.addNode('gen', 0, 0, { draft: { ...draft('refs'), model: sd }, perModel: {} });
  store.addEdge(source.id, 'out', node.id, 'refs', 'video');
  let uploads = 0, creates = 0;
  const assets = {
    assetOfNode: n => store.project.assets[n.data.assetId], remoteValid: () => false,
    async upload() { uploads++; reference.remote = { url: 'https://xingpan.site/reference-assets/mock.mp4', expiresAt: Date.now() / 1000 + 86400, durationSeconds: 3.2, keyFp: keys.getFingerprint() }; },
  };
  const api = { async createTask() { creates++; throw Object.assign(new Error('mock uncertain'), { status: 502 }); } };
  const runner = createTaskRunner({ store, storage, api, assets });
  await runner.submit(node);
  assert.equal(uploads, 1, 'local file cannot have a server probe before its first upload');
  assert.equal(creates, 1);
});

test('two simultaneous retry clicks issue only one POST', async t => {
  const { storage, store } = await setup(t);
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {}, run: { pendingKey: 'mock_retry' } });
  await store.savePendingCreate({ idempotencyKey: 'mock_retry', projectId: store.project.id, nodeId: node.id, keyFp: keys.getFingerprint(), model, bodyString: JSON.stringify(draft()), state: 'uncertain', createdAt: Date.now() });
  let creates = 0;
  const runner = createTaskRunner({ store, storage, assets: {}, api: { async createTask() { creates++; throw Object.assign(new Error('mock uncertain'), { status: 502 }); } } });
  await Promise.all([runner.retrySubmit(node), runner.retrySubmit(node)]);
  assert.equal(creates, 1);
});

test('restoring the original key resumes an existing paused task with GET only', async t => {
  const { storage, store } = await setup(t);
  await store.saveTask({ taskId: 'mock_resume', projectId: store.project.id, nodeId: null, model, status: 'need_key', keyFp: keys.getFingerprint(), createdAt: Date.now() });
  let gets = 0;
  const runner = createTaskRunner({ store, storage, assets: {}, api: { async getTask() { gets++; return { status: 'completed', delivery_status: 'ready' }; } } });
  await runner.resumeAll();
  await new Promise(resolve => setTimeout(resolve, 1400));
  assert.equal(gets, 1, 'a correct restored key must unlock GET polling without a fresh POST');
});

test('expiry of the idempotency window never proves an unknown request failed', async t => {
  const { storage, store } = await setup(t);
  const node = store.addNode('gen', 0, 0, { draft: draft(), run: { pendingKey: 'mock_old_unknown' }, perModel: {} });
  await store.savePendingCreate({ idempotencyKey: 'mock_old_unknown', projectId: store.project.id, nodeId: node.id, keyFp: keys.getFingerprint(), model, bodyString: JSON.stringify(draft()), state: 'uncertain', createdAt: Date.now() - 25 * 3600 * 1000 });
  let creates = 0;
  const runner = createTaskRunner({ store, storage, assets: { remoteValid: () => false }, api: { async createTask() { creates++; throw Object.assign(new Error('mock uncertain'), { status: 502 }); } } });
  await runner.releasePending?.(node);
  await new Promise(resolve => setImmediate(resolve));
  await runner.submit(node);
  assert.equal(creates, 0, '24h expiry requires resolution of the original outcome, not a new billable POST');
});

test('changing key during pending-record persistence cannot send POST as the new identity', async t => {
  const { storage, store } = await setup(t);
  const set = storage.set;
  let switched = false;
  storage.set = async (name, value) => {
    await set(name, value);
    if (!switched && name.startsWith('pending:')) { switched = true; await keys.setKey('another-disposable-test-key'); }
  };
  let creates = 0;
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  const runner = createTaskRunner({ store, storage, assets: { remoteValid: () => false }, api: { async createTask() { creates++; throw Object.assign(new Error('mock uncertain'), { status: 502 }); } } });
  await runner.submit(node);
  assert.equal(creates, 0, 'identity must be checked immediately before the network request, after every persistence await');
});

test('accepted task restores its node after a crash between clearing pending and saving the node', async t => {
  const { storage, store } = await setup(t);
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {}, run: { pendingKey: 'mock_accepted' } });
  await store.saveTask({ taskId: 'mock_accepted_task', projectId: store.project.id, nodeId: node.id, model, idempotencyKey: 'mock_accepted', status: 'completed', deliveryStatus: 'ready', keyFp: keys.getFingerprint(), createdAt: Date.now() });
  const runner = createTaskRunner({ store, storage, assets: {}, api: {} });
  await runner.resumeAll();
  assert.equal(node.data.run?.taskId, 'mock_accepted_task', 'a persisted accepted task is authoritative over a stale pending node link');
});
