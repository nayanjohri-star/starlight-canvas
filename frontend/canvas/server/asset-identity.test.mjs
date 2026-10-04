// Independent local regressions: project and API identity must survive awaits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createAssets } from '../src/assets.js';
import { createTaskRunner } from '../src/gennode.js';
import * as keys from '../src/keyvault.js';
import { readFile } from 'node:fs/promises';
import { setCapabilities } from '../src/capabilities.js';

setCapabilities(JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8')));

const element = () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} });
globalThis.document = { createElement: element, getElementById: id => id === 'asset-list' ? null : element() };
const imageFixture = () => new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmGQAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t) {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('original');
  await keys.setKey('disposable-local-mock-key');
  t.after(async () => { await store.flush(); keys.clearKey(); });
  return { storage, store };
}

test('task cache does not override the current imported project record with an older project record', async t => {
  const { storage, store } = await setup(t);
  const taskId = 'mock_shared_remote_id';
  await store.saveTask({ taskId, projectId: store.project.id, status: 'completed', keyFp: keys.getFingerprint(), nodeId: null });
  const runner = createTaskRunner({ store, storage, api: {}, assets: {} });
  await runner.resumeAll();
  await store.newProject('imported-copy');
  await store.saveTask({ taskId, projectId: store.project.id, status: 'completed', keyFp: keys.getFingerprint(), nodeId: null });
  assert.equal((await runner.recOf(taskId)).projectId, store.project.id);
});

test('saving a blob across a project switch must never insert it in the newly opened project', async t => {
  const { storage, store } = await setup(t);
  const gate = deferred(), started = deferred(), setBlob = storage.setBlob;
  storage.setBlob = async (...args) => { started.resolve(); await gate.promise; return setBlob(...args); };
  const assets = createAssets({ store, storage, api: {} });
  const saving = assets.registerBlob(imageFixture(), 'mock.png', 'image');
  await started.promise;
  await store.newProject('other-project');
  gate.resolve();
  await saving.catch(() => {}); // aborting association is also safe
  assert.equal(Object.keys(store.project.assets).length, 0);
});

test('changing API identity while reading a local blob prevents the upload request', async t => {
  const { storage, store } = await setup(t);
  let uploads = 0;
  const assets = createAssets({ store, storage, api: { async uploadAsset() {
    uploads++;
    return { id: 'a'.repeat(64), url: `https://xingpan.site/reference-assets/${'a'.repeat(64)}.png`, kind: 'image', content_type: 'image/png', size: imageFixture().size, expires_at: Date.now() / 1000 + 86400 };
  } } });
  const asset = await assets.registerBlob(imageFixture(), 'mock.png', 'image');
  const gate = deferred(), started = deferred(), getBlob = storage.getBlob;
  storage.getBlob = async (...args) => { started.resolve(); await gate.promise; return getBlob(...args); };
  const uploading = assets.upload(asset.id, { keyFp: keys.getFingerprint() }).catch(() => {});
  await started.promise;
  await keys.setKey('different-disposable-local-key');
  gate.resolve();
  await uploading;
  assert.equal(uploads, 0, 'identity check is required after file reading and immediately before upload');
});

test('an image upload response reporting audio must not become a valid image reference', async t => {
  const { storage, store } = await setup(t);
  const assets = createAssets({ store, storage, api: { async uploadAsset() {
    return { id: 'b'.repeat(64), url: `https://xingpan.site/reference-assets/${'b'.repeat(64)}.wav`, kind: 'audio', content_type: 'audio/wav', size: imageFixture().size, expires_at: Date.now() / 1000 + 86400 };
  } } });
  const asset = await assets.registerBlob(imageFixture(), 'mock.png', 'image');
  await assert.rejects(assets.upload(asset.id), /.+/);
  assert.equal(assets.remoteValid(asset), false);
});

test('a download completing after switching projects does not insert its result into the new project', async t => {
  const { storage, store } = await setup(t);
  const projectId = store.project.id, taskId = 'mock_project_download';
  await store.saveTask({ taskId, projectId, nodeId: null, status: 'completed', deliveryStatus: 'ready', keyFp: keys.getFingerprint() });
  const gate = deferred(), started = deferred();
  const api = { async downloadContent() { started.resolve(); await gate.promise; return { blob: new Blob(['mock transport bytes'], { type: 'video/webm' }), contentType: 'video/webm' }; } };
  const assets = createAssets({ store, storage, api });
  const runner = createTaskRunner({ store, storage, api, assets });
  const downloading = runner.download(taskId);
  await started.promise;
  await store.newProject('opened-during-download');
  gate.resolve();
  await downloading;
  assert.equal(Object.keys(store.project.assets).length, 0, 'result association must stay in its original project or be safely deferred');
  assert.ok(await storage.get(`task:${projectId}:${taskId}`), 'original task remains recoverable without another generation');
});

for (const phase of ['result-blob-write', 'task-record-write']) {
  test(`download project identity survives ${phase} before creating its asset`, async t => {
    const { storage, store } = await setup(t);
    const projectId = store.project.id, taskId = 'mock_disk_race';
    await store.saveTask({ taskId, projectId, nodeId: null, status: 'completed', deliveryStatus: 'ready', keyFp: keys.getFingerprint() });
    const gate = deferred(), started = deferred();
    const setBlob = storage.setBlob, set = storage.set;
    storage.setBlob = async (key, value) => {
      if (phase === 'result-blob-write' && key.startsWith('result:')) { started.resolve(); await gate.promise; }
      return setBlob(key, value);
    };
    storage.set = async (key, value) => {
      if (phase === 'task-record-write' && key.startsWith('task:') && value.resultBlobId) { started.resolve(); await gate.promise; }
      return set(key, value);
    };
    const api = { async downloadContent() { return { blob: new Blob(['mock transport bytes'], { type: 'video/webm' }), contentType: 'video/webm' }; } };
    const assets = createAssets({ store, storage, api });
    const runner = createTaskRunner({ store, storage, api, assets });
    const downloading = runner.download(taskId);
    await started.promise;
    await store.newProject('opened-during-local-write');
    gate.resolve();
    await downloading;
    assert.equal(Object.keys(store.project.assets).length, 0, 'identity checks must also cover local storage awaits');
  });
}
