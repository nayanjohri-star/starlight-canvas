import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, createAccountScopedStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createAssets } from '../src/assets.js';
import { createHostedDirectorHost, hostedDirectorURL } from '../src/director-hosted.js';
import { createDirectorHost } from '../src/director.js';
import { directorEnvelope, directorDocumentKey } from '../src/director-protocol.js';
import { buildProjectPackage, importProjectPackage, parseProjectPackage, zipStore } from '../src/export-project.js';
import { setCapabilities } from '../src/capabilities.js';
import { setAvailableModels } from '../src/keyvault.js';
import { createHostedSaveCoordinator } from '../../director/integration/save-coordinator.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attrs = new Map(); this.style = {}; this.dataset = {}; this.parentNode = null; this.className = ''; this.textContent = ''; }
  append(...items) { for (const item of items) { if (item == null) continue; if (!(item instanceof Element)) continue; item.remove(); item.parentNode = this; this.children.push(item); } }
  setAttribute(key, value) { this.attrs.set(key, String(value)); if (key === 'src') this.src = value; }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  addEventListener(name, fn) { (this.listeners.get(name) ?? this.listeners.set(name, new Set()).get(name)).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; } }
  get lastElementChild() { return this.children.at(-1); }
  replaceChildren(...children) { for (const n of [...this.children]) n.remove(); this.append(...children); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  contains(node) { return this === node || this.children.some(n => n.contains(node)); }
  focus() { document.activeElement = this; }
}
const documentTarget = new Element('document');
const windowTarget = new Element('window');
const overlay = new Element('overlay');
globalThis.document = Object.assign(documentTarget, { baseURI: 'https://example.test/canvas/_v/0.5.0/index.html',
  createElement: tag => new Element(tag), getElementById: id => id === 'overlay-root' ? overlay : null,
  body: new Element('body'), documentElement: new Element('html'), activeElement: null });
globalThis.window = windowTarget;
globalThis.location = { origin: 'https://example.test', protocol: 'https:', hostname: 'example.test' };
setCapabilities({ upload_limits: { image: { content_types: ['image/png'], max_mib: 30 }, video: { content_types: ['video/mp4'], max_mib: 100 }, audio: { content_types: ['audio/wav'], max_mib: 30 } },
  models: { 'test-sd25': { family: 'sd25', capability_modes: ['first_last_frame'], billing_unit: 'second', price_cny_per_second: 1 } } });
setAvailableModels(['test-sd25']);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const bytes = text => new TextEncoder().encode(text);
let requests = 0;

async function fixture(t, raw = createMemoryStorage(), subject = 'u101', hostOptions = {}) {
  const storage = createAccountScopedStorage(raw, { subject });
  const store = createStore(storage); await store.newProject('导演测试');
  let paid = 0;
  const assets = createAssets({ store, storage, api: { uploadAsset() { paid++; throw new Error('unexpected model request'); } } });
  const { createHost = createHostedDirectorHost, ...options } = hostOptions;
  const host = createHost({ store, storage, assets, ...options });
  const node = store.addNode('director', 20, 30, { title: '场景' });
  const s = host.openEditor(node);
  const win = { sent: [], postMessage(data, origin) { this.sent.push({ data, origin }); } };
  s.frame.contentWindow = win;
  t.after(() => host.dispose());
  async function rpc(method, payload = {}, id = `r${++requests}`, eventPatch = {}) {
    const before = win.sent.length;
    await host.onMessage({ data: directorEnvelope(s, id, method, payload), origin: s.origin, source: win, ...eventPatch });
    const response = win.sent.slice(before).find(x => x.data.kind === 'response');
    return response?.data.payload;
  }
  async function save(summary = '测试场景', expectedRevision = null) {
    const asset = (await rpc('asset.write', { name: 'scene.cclayproject', mime: 'application/json', bytes: bytes(JSON.stringify({ version: 1, scene: { name: summary }, assets: { embedded: 'test' } })), role: 'project' })).result;
    const scene = { projectRef: asset.ref, projectSha256: asset.sha256, summary };
    const result = await rpc('document.save', { expectedRevision, scene, dependencies: [{ ...asset, role: 'project' }] });
    return { asset, scene, result };
  }
  return { raw, storage, store, assets, host, node, s, win, rpc, save, get paid() { return paid; } };
}

// Keep the shipped child coordinator and host CAS together. The transport can
// hold a successful host ACK after its record has actually committed.
async function coordinatedFixture(t) {
  const f = await fixture(t), calls = [];
  let epoch = 'default-document', clock = 0, active = true, held = null;
  let project = { name: 'default', scenes: { scenes: [{ id: 'default-scene', stage: { characters: [] } }] } };
  const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
  const client = {
    scope: f.s, closed: false,
    async request(method, payload) {
      calls.push({ method, ...(method === 'document.save' ? { expectedRevision: payload.expectedRevision } : {}) });
      const response = await f.rpc(method, payload);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      const gate = method === 'document.save' ? held : null;
      if (gate) {
        held = null; gate.committed.resolve(response.result); await gate.release.promise;
        return gate.mutate(response.result);
      }
      return response.result;
    },
  };
  const identity = () => ({ documentEpoch: epoch, clock });
  const capture = () => ({ ...identity(), snapshot: JSON.stringify(project), input: structuredClone(project) });
  const coordinator = createHostedSaveCoordinator({ session: { client, record: null }, active: () => active,
    identity, capture, extras: () => ({ bindings: [], exportResolution: 720 }), serialize: frozen => JSON.stringify(frozen.input) });
  coordinator.finishRestore(coordinator.beginRestore());
  const stored = () => f.storage.get(directorDocumentKey(f.s.projectId, f.s.nodeId));
  return { f, coordinator, client, calls, stored,
    holdAck(mutate = record => record) { return (held = { committed: deferred(), release: deferred(), mutate }); },
    deactivate() { active = false; },
    replaceDocument() {
      epoch = 'imported-document'; clock++;
      project = { name: 'imported two actors', scenes: { scenes: [{ id: 'imported-scene', stage: {
        characters: [{ id: 'a', x: -1.35 }, { id: 'b', x: 1.65 }],
      } }] } };
      coordinator.observe(JSON.stringify(project));
    },
  };
}

test('a committed same-session ACK advances transport revision without acknowledging a newly opened author document', async t => {
  const f = await coordinatedFixture(t), gate = f.holdAck();
  const oldSave = assert.rejects(f.coordinator.save(), cause => cause.code === 'document_changed');
  const oldRecord = await gate.committed.promise;
  assert.equal(oldRecord.rev, 1);
  assert.equal((await f.stored()).rev, 1, 'the actual host committed before ACK delivery');
  f.replaceDocument(); gate.release.resolve(); await oldSave;
  assert.equal(f.coordinator.record.rev, 1, 'the fully validated own ACK is the next CAS baseline');
  assert.equal(f.coordinator.getSnapshot().dirty, true, 'old bytes cannot mark the incoming author state saved');
  assert.equal(f.coordinator.getSnapshot().saveState, 'error', 'the old save still rejects after document replacement');
  const next = await f.coordinator.save();
  assert.equal(next.rev, 2);
  assert.deepEqual(f.calls.filter(row => row.method === 'document.save').map(row => row.expectedRevision), [null, 1]);
  const stored = await f.stored();
  assert.equal(stored.scene.projectSha256, next.scene.projectSha256);
  const bytes = await f.f.assets.blobOf(stored.scene.projectRef.slice('xp-asset://'.length));
  assert.deepEqual(JSON.parse(await bytes.text()).scenes.scenes[0].stage.characters, [{ id: 'a', x: -1.35 }, { id: 'b', x: 1.65 }]);
  assert.equal(f.coordinator.getSnapshot().saveState, 'saved');
  assert.equal(f.f.paid, 0);
});

test('concurrent click, public save and autosave checkpoints share one queued same-epoch host revision', async t => {
  const f = await coordinatedFixture(t), gate = f.holdAck();
  const first = f.coordinator.save(); await gate.committed.promise;
  const second = f.coordinator.save(), third = f.coordinator.save();
  gate.release.resolve();
  assert.deepEqual((await Promise.all([first, second, third])).map(record => record.rev), [1, 1, 1]);
  assert.deepEqual(f.calls.map(row => row.method), ['asset.write', 'document.save']);
  assert.equal((await f.stored()).rev, 1);
  assert.equal(f.coordinator.getSnapshot().saveState, 'saved');
});

test('adopting a valid old own ACK cannot absorb a later foreign revision or overwrite either draft', async t => {
  const f = await coordinatedFixture(t), gate = f.holdAck();
  const oldSave = assert.rejects(f.coordinator.save(), cause => cause.code === 'document_changed');
  await gate.committed.promise; f.replaceDocument();
  const foreign = await f.f.save('foreign window content', 1);
  assert.equal(foreign.result.result.rev, 2);
  gate.release.resolve(); await oldSave;
  assert.equal(f.coordinator.record.rev, 1);
  let conflict;
  await assert.rejects(f.coordinator.save(), cause => { conflict = cause; return cause.code === 'revision_conflict' && cause.storedRevision === 2; });
  assert.equal((await f.stored()).scene.summary, 'foreign window content');
  assert.equal(f.coordinator.record.rev, 1);
  assert.equal(f.coordinator.getSnapshot().dirty, true);
  assert.equal(f.coordinator.getSnapshot().saveState, 'conflict');
  const draft = await f.f.storage.get(`dir:${f.f.node.id}:hosted-conflict:${f.f.store.project.id}:${conflict.conflictId}`);
  const blob = await f.f.assets.blobOf(draft.scene.projectRef.slice('xp-asset://'.length));
  assert.equal(JSON.parse(await blob.text()).name, 'imported two actors', 'the rejected incoming draft is retained separately');
});

test('document replacement cannot adopt an incomplete, foreign-scope or mismatched ACK', async t => {
  for (const mutate of [record => ({ ...record, format: 'unknown@99' }), record => ({ ...record, dependencies: [] }),
    record => ({ ...record, projectId: 'foreign-project' }), record => ({ ...record, rev: 5 }),
    record => ({ ...record, scene: { ...record.scene, projectSha256: '0'.repeat(64) } }),
    record => ({ ...record, scene: { ...record.scene, exportResolution: 1080 } })]) {
    const f = await coordinatedFixture(t), gate = f.holdAck(mutate);
    const save = assert.rejects(f.coordinator.save(), cause => cause.code === 'save_ack_invalid');
    await gate.committed.promise; f.replaceDocument(); gate.release.resolve(); await save;
    assert.equal(f.coordinator.record, null, 'invalid ACK does not become the transport baseline');
    assert.equal(f.coordinator.getSnapshot().dirty, true);
    assert.equal(f.coordinator.getSnapshot().saveState, 'error');
  }
});

test('a closed coordinator, closed transport or inactive session cannot adopt its late committed ACK', async t => {
  for (const close of [f => f.coordinator.close(), f => { f.client.closed = true; }, f => f.deactivate()]) {
    const f = await coordinatedFixture(t), gate = f.holdAck();
    const save = assert.rejects(f.coordinator.save(), cause => cause.code === 'session_closed');
    await gate.committed.promise; f.replaceDocument(); close(f); gate.release.resolve(); await save;
    assert.equal(f.coordinator.record, null);
    assert.equal(f.coordinator.getSnapshot().dirty, true);
  }
});

test('versioned lazy URL and exact source/origin/session/project checks', async t => {
  const f = await fixture(t);
  assert.match(hostedDirectorURL(f.s), /^https:\/\/example.test\/canvas\/_v\/0.5.0\/director\/index.html\?/);
  for (const patch of [{ origin: 'https://foreign.test' }, { source: {} },
    { data: { ...directorEnvelope(f.s, 'bad', 'ready', {}), sessionId: 'old' } },
    { data: { ...directorEnvelope(f.s, 'bad', 'ready', {}), projectId: 'foreign' } }]) {
    assert.equal(await f.rpc('ready', {}, 'bad', patch), undefined);
  }
  const ready = (await f.rpc('ready')).result;
  assert.equal(ready.accountScope, 'u101'); assert.equal(ready.document, null); assert.equal(ready.legacy, null);
  assert.equal(ready.videoModels[0].id, 'test-sd25'); assert.equal(ready.modelCatalogVerified, true);
  assert.equal(f.s.ready, true);
});

test('full project bytes autosave deduplication, digest validation and CAS conflicts preserve both drafts', async t => {
  const f = await fixture(t);
  const first = await f.save(); assert.equal(first.result.ok, true); assert.equal(first.result.result.rev, 1);
  const second = await f.save('测试场景', 1); assert.equal(second.asset.assetId, first.asset.assetId);
  assert.equal(Object.keys(f.store.project.assets).length, 1);
  const conflict = await f.save('迟到草稿', 1);
  assert.equal(conflict.result.ok, false); assert.equal(conflict.result.error.code, 'revision_conflict');
  assert.equal((await f.rpc('document.load')).result.rev, 2);
  assert.equal((await f.storage.get(`dir:${f.node.id}:hosted-conflict:${f.store.project.id}:${conflict.result.error.conflictId}`)).scene.summary, '迟到草稿');
  const bad = await f.rpc('asset.read', { assetId: first.asset.assetId, sha256: '0'.repeat(64) });
  assert.equal(bad.error.code, 'asset_digest_mismatch');
  assert.equal(f.paid, 0);
});

test('export resolution survives acknowledged storage and a new host session without changing legacy records', async t => {
  const f = await fixture(t);
  const initial = await f.save();
  assert.equal(Object.hasOwn(initial.result.result.scene, 'exportResolution'), false, 'older documents remain readable without this optional setting');
  let expectedRevision = 1;
  for (const exportResolution of [720, 1080]) {
    const saved = await f.rpc('document.save', { expectedRevision, scene: { ...initial.scene, exportResolution },
      dependencies: [{ ...initial.asset, role: 'project' }] });
    assert.equal(saved.ok, true);
    assert.equal(saved.result.scene.exportResolution, exportResolution, 'ACK carries the persisted setting');
    const restored = (await f.rpc('document.load')).result;
    assert.equal(restored.scene.exportResolution, exportResolution);
    assert.equal(restored.rev, ++expectedRevision);
  }
  f.host.dispose();
  const reopened = createHostedDirectorHost({ store: f.store, storage: f.storage, assets: f.assets });
  t.after(() => reopened.dispose());
  const session = reopened.openEditor(f.node), sent = [];
  const win = { postMessage(data) { sent.push(data); } }; session.frame.contentWindow = win;
  await reopened.onMessage({ origin: session.origin, source: win, data: directorEnvelope(session, 'restored-resolution', 'document.load', {}) });
  const response = sent.find(row => row.kind === 'response').payload;
  assert.equal(response.ok, true);
  assert.equal(response.result.scene.exportResolution, 1080);
  assert.equal(response.result.rev, 3);
  assert.equal(f.paid, 0);
});

test('unsupported export resolution cannot replace the last valid complete revision', async t => {
  const f = await fixture(t), initial = await f.save();
  for (const exportResolution of ['4k', '720', '1080', null, {}, '']) {
    const saved = await f.rpc('document.save', { expectedRevision: 1, scene: { ...initial.scene, exportResolution },
      dependencies: [{ ...initial.asset, role: 'project' }] });
    assert.equal(saved.ok, false);
    assert.equal(saved.error.code, 'document_invalid');
    const restored = (await f.rpc('document.load')).result;
    assert.equal(restored.rev, 1);
    assert.equal(restored.scene.projectSha256, initial.scene.projectSha256);
    assert.equal(Object.hasOwn(restored.scene, 'exportResolution'), false);
  }
  assert.equal(f.paid, 0);
});

test('a malformed stored export resolution preserves the original record and prevents a silent fallback overwrite', async t => {
  const f = await fixture(t), initial = await f.save();
  const key = directorDocumentKey(f.store.project.id, f.node.id);
  const malformed = { ...initial.result.result, scene: { ...initial.result.result.scene, exportResolution: '4k' } };
  await f.storage.set(key, malformed);
  assert.equal((await f.rpc('document.load')).error.code, 'document_invalid');
  const attempted = await f.rpc('document.save', { expectedRevision: 1, scene: initial.scene,
    dependencies: [{ ...initial.asset, role: 'project' }] });
  assert.equal(attempted.error.code, 'document_invalid');
  assert.deepEqual(await f.storage.get(key), malformed);
  assert.equal(f.paid, 0);
});

test('legacy records remain intact; unknown hosted document cannot be overwritten', async t => {
  const f = await fixture(t);
  await f.storage.set(`dir:${f.node.id}:composition`, { legacy: 'kept' });
  const ready = await f.rpc('ready'); assert.deepEqual(ready.result.legacy.records, { [`dir:${f.node.id}:composition`]: { legacy: 'kept' } });
  await f.storage.set(directorDocumentKey(f.store.project.id, f.node.id), { format: 'starlight-director@2', rev: 1 });
  const attempted = await f.save('unsupported', 1);
  assert.equal(attempted.result.error.code, 'document_version_unsupported');
  assert.equal((await f.storage.get(directorDocumentKey(f.store.project.id, f.node.id))).format, 'starlight-director@2');
});

test('node deletion during asset write produces no metadata, node or orphan bytes', async t => {
  const f = await fixture(t); const original = f.storage.setBlob;
  let release; let started;
  const wait = new Promise(resolve => { started = resolve; });
  f.storage.setBlob = async (...args) => { started(); await new Promise(resolve => { release = resolve; }); return original(...args); };
  const request = f.rpc('asset.write', { mime: 'image/png', name: 'late.png', bytes: bytes('image bytes') });
  await wait; f.store.removeNode(f.node.id); release(); await request;
  assert.equal(f.host.isOpen(f.node.id), false);
  assert.deepEqual(f.store.project.assets, {});
  assert.equal(f.store.project.nodes.length, 0);
  assert.equal(await f.storage.getBlob((await f.storage.keys()).find(k => k.startsWith('blob:')) ?? 'not-found'), undefined);
});

test('retry creates a fresh session and discards an old asynchronous reply', async t => {
  const f = await fixture(t); const original = f.storage.get;
  let release; let started; const wait = new Promise(resolve => { started = resolve; });
  f.storage.get = async key => { if (key === directorDocumentKey(f.s.projectId, f.s.nodeId)) { started(); await new Promise(resolve => { release = resolve; }); } return original(key); };
  const pending = f.rpc('document.load'); await wait;
  f.host.closeEditor(f.node.id); const replacement = f.host.openEditor(f.node);
  const newWin = { sent: [], postMessage(data) { this.sent.push(data); } }; replacement.frame.contentWindow = newWin;
  release(); await pending;
  assert.notEqual(replacement.sessionId, f.s.sessionId);
  assert.equal(newWin.sent.length, 0);
  assert.equal(f.win.sent.filter(x => x.data.kind === 'response').length, 0);
});

test('inactive account and switched project reject old writes and never access another account', async t => {
  const f = await fixture(t);
  f.storage.invalidate();
  assert.equal(await f.rpc('asset.write', { mime: 'image/png', bytes: bytes('old') }), undefined);
  const other = createAccountScopedStorage(f.raw, { subject: 'u202' });
  assert.deepEqual(await other.keys(), []);
  const g = await fixture(t); await g.store.newProject('另一个项目');
  assert.equal(await g.rpc('asset.write', { mime: 'image/png', bytes: bytes('old') }), undefined);
  assert.deepEqual(g.store.project.assets, {});
});

test('only completed current revision output becomes a canvas asset and replay creates no second node', async t => {
  const f = await fixture(t); await f.save();
  const payload = { mime: 'image/png', name: 'first.png', bytes: bytes('png image fixture'), sceneRevision: 1, completed: true, fps: 24, frameIndex: 0, frameCount: 150 };
  assert.equal((await f.rpc('output.publish', { ...payload, completed: false })).error.code, 'output_incomplete');
  assert.equal((await f.rpc('output.publish', { ...payload, sceneRevision: 0 })).error.code, 'revision_conflict');
  const first = await f.rpc('output.publish', payload, 'same-output');
  const retry = await f.rpc('output.publish', payload, 'same-output');
  assert.equal(first.result.assetNodeId, retry.result.assetNodeId);
  assert.equal(f.store.project.nodes.filter(n => n.type === 'asset').length, 1);
  assert.deepEqual(f.store.project.assets[first.result.assetId].directorOutput, { sceneRevision: 1, shotId: null, frameIndex: 0, fps: 24, frameCount: 150 });
});

test('generation drafts preserve character order, separate frames and refs, and never submit', async t => {
  const f = await fixture(t); await f.save();
  const ids = [];
  for (const name of ['character A', 'character B', 'first', 'last']) ids.push((await f.rpc('asset.write', { name, mime: 'image/png', bytes: bytes(name) })).result.assetId);
  const refs = await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'refs', prompt: '用户人物描述', sceneRevision: 1, refAssetIds: ids.slice(0, 2) });
  assert.equal(refs.ok, true, JSON.stringify(refs));
  const gen = f.store.node(refs.result.nodeId);
  assert.equal(gen.data.draft.prompt, '用户人物描述');
  assert.deepEqual(f.store.edgesInto(gen.id, 'refs').map(e => f.store.node(e.from.node).data.assetId), ids.slice(0, 2));
  const frames = await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'frames', sceneRevision: 1, frameAssetIds: ids.slice(2) });
  assert.deepEqual(f.store.edgesInto(frames.result.nodeId, 'frames').map(e => f.store.node(e.from.node).data.assetId), ids.slice(2));
  assert.equal((await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'frames', sceneRevision: 1, refAssetIds: [ids[0]], frameAssetIds: [ids[2]] })).ok, false);
  assert.equal(f.paid, 0);
});

function assertCardsDoNotOverlap(nodes) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j], height = node => node.type === 'gen' ? 440 : 280;
    assert.ok(a.x + 360 <= b.x || b.x + 360 <= a.x || a.y + height(a) <= b.y || b.y + height(b) <= a.y,
      `${a.type} ${a.id} and ${b.type} ${b.id} must remain independently selectable`);
  }
}

test('consecutive drafts and missing reference cards use the canvas layout callback through the director wrapper', async t => {
  let f;
  const calls = [];
  const spawnPosition = type => {
    calls.push(type);
    const index = calls.filter(value => value === type).length - 1;
    return type === 'gen' ? { x: 420 + index * 420, y: 40 } : { x: -400, y: 40 + index * 360 };
  };
  f = await fixture(t, createMemoryStorage(), 'u101', { createHost: createDirectorHost, spawnPosition });
  assert.deepEqual(calls, [], 'layout is evaluated only when creating a card, after the board is initialized');
  await f.save();
  const ids = [];
  for (const name of ['original A', 'original B'])
    ids.push((await f.rpc('asset.write', { name, mime: 'image/png', bytes: bytes(name) })).result.assetId);
  const first = await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'refs', sceneRevision: 1, refAssetIds: ids });
  const second = await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'refs', sceneRevision: 1, refAssetIds: [...ids].reverse() });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(calls, ['gen', 'asset', 'asset', 'gen'], 'already present reference cards are reused');
  assert.deepEqual([first.result, second.result].map(result => {
    const node = f.store.node(result.nodeId); return { x: node.x, y: node.y };
  }), [{ x: 420, y: 40 }, { x: 840, y: 40 }]);
  assertCardsDoNotOverlap(f.store.project.nodes);
  for (const [result, expected] of [[first, ids], [second, [...ids].reverse()]]) {
    assert.deepEqual(f.store.edgesInto(result.result.nodeId, 'refs').map(edge => f.store.node(edge.from.node).data.assetId), expected);
    assert.equal(f.store.node(result.result.nodeId).data.directorSource.nodeId, f.node.id);
    assert.equal(f.store.node(result.result.nodeId).data.directorSource.sceneRevision, 1);
  }
  const persisted = await f.storage.get(`project:${f.store.project.id}`);
  assert.deepEqual(persisted.nodes.map(node => [node.id, node.x, node.y]), f.store.project.nodes.map(node => [node.id, node.x, node.y]));
  assert.equal(f.paid, 0);
});

test('a host without DOM layout keeps consecutive draft and reference cards apart from existing nodes', async t => {
  const f = await fixture(t); await f.save();
  f.store.addNode('gen', f.node.x + 540, f.node.y, { title: 'existing card at the former fixed spawn point' });
  const image = (await f.rpc('asset.write', { name: 'original', mime: 'image/png', bytes: bytes('original image') })).result;
  const first = await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'refs', sceneRevision: 1, refAssetIds: [image.assetId] });
  const second = await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'refs', sceneRevision: 1, refAssetIds: [image.assetId] });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(second.ok, true, JSON.stringify(second));
  assertCardsDoNotOverlap(f.store.project.nodes);
  assert.equal(f.store.project.nodes.filter(node => node.type === 'asset').length, 1);
  assert.notDeepEqual([f.store.node(first.result.nodeId).x, f.store.node(first.result.nodeId).y],
    [f.store.node(second.result.nodeId).x, f.store.node(second.result.nodeId).y]);
  assert.equal(f.paid, 0);
});

test('an invalid reference-card layout rolls back the new draft without changing its saved scene or assets', async t => {
  const f = await fixture(t, createMemoryStorage(), 'u101', {
    spawnPosition: type => type === 'gen' ? { x: 500, y: 30 } : { x: NaN, y: 30 },
  });
  await f.save();
  const image = (await f.rpc('asset.write', { name: 'original', mime: 'image/png', bytes: bytes('original image') })).result;
  const nodeIds = f.store.project.nodes.map(node => node.id), assetIds = Object.keys(f.store.project.assets);
  const result = await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'refs', sceneRevision: 1, refAssetIds: [image.assetId] });
  assert.equal(result.error.code, 'generation_position_invalid');
  assert.deepEqual(f.store.project.nodes.map(node => node.id), nodeIds);
  assert.deepEqual(Object.keys(f.store.project.assets), assetIds);
  assert.equal((await f.rpc('document.load')).result.rev, 1);
  await f.store.flush();
  assert.deepEqual((await f.storage.get(`project:${f.store.project.id}`)).nodes.map(node => node.id), nodeIds);
  assert.equal(f.paid, 0);
});

test('saved character reference bindings retain stable ID/ref/digest in dependencies and generation provenance', async t => {
  const f = await fixture(t);
  const image = (await f.rpc('asset.write', { name: '用户人物原图', mime: 'image/png', bytes: bytes('original character image') })).result;
  const binding = { characterId: 'actor-a', assetId: image.assetId, ref: image.ref, sha256: image.sha256 };
  const project = (await f.rpc('asset.write', { name: 'scene.cclayproject', mime: 'application/json', role: 'project',
    bytes: bytes(JSON.stringify({ app: 'cozyclay', kind: 'project', version: 4, scenes: { activeSceneId: 'scene-a', scenes: [
      { id: 'scene-a', stage: { characters: [{ id: 'actor-a', subject: '用户描述' }] } },
    ] } })) })).result;
  const scene = { projectRef: project.ref, projectSha256: project.sha256, characterBindings: [binding],
    summary: { name: '人物场景', scenes: 1, characters: 1 } };
  const saved = await f.rpc('document.save', { expectedRevision: null, scene, dependencies: [{ ...project, role: 'project' }] });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(saved.result.scene.characterBindings, [binding]); assert.deepEqual(saved.result.scene.summary, scene.summary);
  assert.equal(saved.result.dependencies.find(dep => dep.assetId === image.assetId).role, 'character-reference');
  const result = await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'refs', prompt: '用户描述', sceneRevision: 1, refAssetIds: [image.assetId] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.store.node(result.result.nodeId).data.directorSource.characterBindings, [binding]);
  const invalid = await f.rpc('document.save', { expectedRevision: 1, scene: { ...scene, characterBindings: [{ ...binding, sha256: '0'.repeat(64) }] }, dependencies: saved.result.dependencies });
  assert.equal(invalid.error.code, 'asset_digest_mismatch');
  assert.equal((await f.rpc('document.load')).result.rev, 1); assert.equal(f.paid, 0);
  const packed = await buildProjectPackage({ projectJson: await f.store.exportJSON(), assets: f.store.project.assets, blobOf: f.assets.blobOf });
  const clean = createStore(createAccountScopedStorage(createMemoryStorage(), { subject: 'u303' }));
  await clean.newProject('clean');
  const imported = await importProjectPackage({ store: clean }, packed);
  const importedGen = imported.project.nodes.find(node => node.type === 'gen');
  const remapped = importedGen.data.directorSource.characterBindings[0];
  assert.equal(remapped.characterId, binding.characterId); assert.equal(remapped.sha256, binding.sha256);
  assert.notEqual(remapped.assetId, binding.assetId); assert.equal(remapped.ref, `xp-asset://${remapped.assetId}`);
  assert.ok(imported.project.assets[remapped.assetId]);
  const clone = await f.store.duplicateProject(f.store.project.id);
  const cloned = clone.nodes.find(node => node.type === 'gen').data.directorSource.characterBindings[0];
  assert.notEqual(cloned.assetId, binding.assetId); assert.equal(cloned.ref, `xp-asset://${cloned.assetId}`);
  assert.equal(cloned.sha256, binding.sha256); assert.equal(cloned.characterId, binding.characterId);
});

test('complete pack imports into clean storage with remapped project/node/ref IDs and byte-exact digests', async t => {
  const f = await fixture(t); const saved = await f.save();
  const projectJson = await f.store.exportJSON();
  const pack = await buildProjectPackage({ projectJson, assets: f.store.project.assets, blobOf: f.assets.blobOf });
  const parsed = parseProjectPackage(pack); assert.match(parsed.manifest.media[0].path, /\.cclayproject$/);
  const cleanStorage = createAccountScopedStorage(createMemoryStorage(), { subject: 'u303' });
  const cleanStore = createStore(cleanStorage); await cleanStore.newProject('干净环境');
  const imported = await importProjectPackage({ store: cleanStore }, pack);
  assert.deepEqual(imported.missing, []);
  const node = imported.project.nodes.find(n => n.type === 'director');
  const record = await cleanStorage.get(directorDocumentKey(imported.project.id, node.id));
  assert.notEqual(imported.project.id, f.store.project.id); assert.notEqual(node.id, f.node.id);
  assert.equal(record.projectId, imported.project.id); assert.equal(record.nodeId, node.id);
  const id = record.scene.projectRef.slice('xp-asset://'.length);
  assert.notEqual(id, saved.asset.assetId); assert.equal(record.dependencies[0].assetId, id);
  assert.equal(record.dependencies[0].ref, record.scene.projectRef);
  assert.equal(record.scene.projectSha256, imported.project.assets[id].sha256);
  assert.deepEqual(new Uint8Array(await (await cleanStorage.getBlob(`blob:${id}`)).arrayBuffer()), new Uint8Array((await f.rpc('asset.read', { assetId: saved.asset.assetId })).result.bytes));
  const files = parsed.files;
  const media = parsed.manifest.media[0]; files.get(media.path)[0] ^= 1;
  const broken = zipStore([...files].map(([name, data]) => ({ name, data })));
  const before = cleanStore.project;
  await assert.rejects(importProjectPackage({ store: cleanStore }, broken), /SHA-256/);
  assert.equal(cleanStore.project, before);
});

test('20 open/close cycles remove message listeners, frames and session maps', async t => {
  const f = await fixture(t); f.host.closeAll();
  const before = windowTarget.listeners.get('message').size;
  for (let i = 0; i < 20; i++) { const s = f.host.openEditor(f.node); f.host.closeEditor(f.node.id); assert.equal(s.frame.parentNode, null); assert.equal(f.host.sessionOf(f.node.id), null); }
  f.host.dispose(); assert.equal(windowTarget.listeners.get('message').size, before - 1);
  await tick();
});

test('canvas project clone remaps hosted keys, document and generation source while preserving old archive', async t => {
  const f = await fixture(t); const saved = await f.save();
  const image = (await f.rpc('asset.write', { mime: 'image/png', name: 'A', bytes: bytes('A') })).result;
  await f.rpc('generation.createDraft', { model: 'test-sd25', intent: 'refs', sceneRevision: 1, refAssetIds: [image.assetId] });
  const originalProjectId = f.store.project.id;
  const clone = await f.store.duplicateProject(originalProjectId);
  const clonedNode = clone.nodes.find(n => n.type === 'director');
  const record = await f.storage.get(directorDocumentKey(clone.id, clonedNode.id));
  assert.equal(record.projectId, clone.id); assert.equal(record.nodeId, clonedNode.id);
  assert.notEqual(record.dependencies[0].assetId, saved.asset.assetId);
  assert.equal(clone.nodes.find(n => n.type === 'gen').data.directorSource.nodeId, clonedNode.id);
  assert.equal((await f.storage.get(directorDocumentKey(originalProjectId, f.node.id))).scene.projectRef, saved.asset.ref);
});

test('asset listing follows incoming edge order and distinct identical first/last outputs retain roles', async t => {
  const f = await fixture(t); await f.save();
  const ids = [];
  for (const name of ['A', 'B']) ids.push((await f.rpc('asset.write', { mime: 'image/png', name, bytes: bytes(name) })).result.assetId);
  for (const id of [...ids].reverse()) {
    const node = f.store.addNode('asset', 0, 0, { assetId: id }); f.store.addEdge(node.id, 'out', f.node.id, 'refs', 'image');
  }
  for (const role of ['first-frame', 'last-frame']) {
    assert.equal((await f.rpc('output.publish', { mime: 'image/png', name: role, role, bytes: bytes('identical pixels'), completed: true, sceneRevision: 1 })).ok, true);
  }
  const list = (await f.rpc('asset.list')).result;
  assert.deepEqual(list.slice(0, 2).map(a => a.assetId), [...ids].reverse());
  assert.deepEqual(list.slice(2, 4).map(a => a.role), ['first-frame', 'last-frame']);
  assert.notEqual(list[2].assetId, list[3].assetId);
});

test('dependency checksum and unknown document imports fail before changing the current project', async t => {
  const f = await fixture(t); await f.save(); const data = JSON.parse(await f.store.exportJSON());
  const key = directorDocumentKey(f.store.project.id, f.node.id);
  const original = f.store.project;
  data.director[key].dependencies[0].sha256 = '0'.repeat(64);
  await assert.rejects(f.store.importJSON(JSON.stringify(data)), /缺少完整工程|摘要/);
  assert.equal(f.store.project, original);
  data.director[key].format = 'starlight-director@9';
  await assert.rejects(f.store.importJSON(JSON.stringify(data)), /版本不受支持/);
  assert.equal(f.store.project, original);
});

test('a scene revision changed during output staging leaves neither success asset nor orphan blob', async t => {
  const f = await fixture(t); await f.save();
  let release, started, stagedKey;
  const wait = new Promise(resolve => { started = resolve; }); const original = f.storage.setBlob;
  f.storage.setBlob = async (key, blob) => { stagedKey = key; started(); await new Promise(resolve => { release = resolve; }); return original(key, blob); };
  const request = f.rpc('output.publish', { mime: 'image/png', bytes: bytes('stale output'), name: 'stale.png', completed: true, sceneRevision: 1 });
  await wait;
  const key = directorDocumentKey(f.s.projectId, f.s.nodeId); const record = await f.storage.get(key);
  await f.storage.setIfRev(key, 1, { ...record, rev: 2 }); release();
  assert.equal((await request).error.code, 'revision_conflict');
  assert.equal(Object.keys(f.store.project.assets).length, 1);
  assert.equal(f.store.project.nodes.filter(n => n.type === 'asset').length, 0);
  assert.equal(await f.storage.getBlob(stagedKey), undefined);
});

test('output batches publish once, roll back every staged byte on mid-pack failure, and keep existing assets', async t => {
  const f = await fixture(t); await f.save(); await f.store.flush();
  const batch = ['first-frame', 'last-frame', 'reference-video', 'reference-pack'].map(role => ({
    name: role, role, mime: role === 'reference-video' ? 'video/mp4' : role === 'reference-pack' ? 'application/zip' : 'image/png',
    bytes: bytes(`complete ${role}`), completed: true, sceneRevision: 1, fps: 30, frameCount: role.includes('reference') ? 188 : 1,
  }));
  const initialIds = Object.keys(f.store.project.assets), stagedKeys = [];
  const original = f.storage.setBlob;
  f.storage.setBlob = async (key, blob) => {
    if (stagedKeys.length === 2) throw new Error('simulated third write quota failure');
    stagedKeys.push(key); return original(key, blob);
  };
  const failure = await f.rpc('output.publishBatch', { entries: batch });
  assert.equal(failure.ok, false); assert.match(failure.error.message, /quota failure/);
  assert.deepEqual(Object.keys(f.store.project.assets), initialIds);
  assert.equal(f.store.project.nodes.filter(node => node.type === 'asset').length, 0);
  for (const key of stagedKeys) assert.equal(await f.storage.getBlob(key), undefined);
  f.storage.setBlob = original;
  const success = await f.rpc('output.publishBatch', { entries: batch }, 'same-pack');
  assert.equal(success.ok, true, JSON.stringify(success)); assert.equal(success.result.length, 4);
  const replay = await f.rpc('output.publishBatch', { entries: batch }, 'same-pack');
  assert.deepEqual(replay, success);
  assert.equal(f.store.project.nodes.filter(node => node.type === 'asset').length, 4);
  const persisted = await f.storage.get(`project:${f.store.project.id}`);
  assert.equal(persisted.nodes.filter(node => node.type === 'asset').length, 4);
  for (const result of success.result) assert.ok(persisted.assets[result.assetId]);
  assert.ok(await f.storage.getBlob(`blob:${initialIds[0]}`)); assert.equal(f.paid, 0);
});

test('scene revision CAS or storage failure rejects the complete batch without modifying the project', async t => {
  for (const mode of ['scene-revision', 'storage-failure']) {
    const f = await fixture(t); await f.save(); await f.store.flush();
    const original = f.storage.setIfRevs; let staged;
    const write = f.storage.setBlob; f.storage.setBlob = async (key, blob) => { staged = key; return write(key, blob); };
    f.storage.setIfRevs = async (...args) => {
      if (mode === 'storage-failure') throw new Error('simulated atomic transaction quota failure');
      const key = directorDocumentKey(f.s.projectId, f.s.nodeId), record = await f.storage.get(key);
      await f.storage.setIfRev(key, 1, { ...record, rev: 2 }); return original(...args);
    };
    const result = await f.rpc('output.publishBatch', { entries: [{ mime: 'image/png', bytes: bytes(mode), completed: true, sceneRevision: 1 }] });
    assert.equal(result.ok, false);
    assert.equal(f.store.project.nodes.filter(node => node.type === 'asset').length, 0);
    assert.equal((await f.storage.get(`project:${f.store.project.id}`)).nodes.filter(node => node.type === 'asset').length, 0);
    assert.equal(await f.storage.getBlob(staged), undefined);
  }
});

test('UI listener or library-render failure after the atomic commit preserves all saved output bytes and success', async t => {
  for (const mode of ['listener', 'library']) {
    const f = await fixture(t); await f.save(); await f.store.flush();
    let remove;
    if (mode === 'listener') remove = f.store.onChange(() => { throw new Error('synthetic post-commit view error'); });
    else f.assets.renderLibrary = () => { throw new Error('synthetic library render error'); };
    const result = await f.rpc('output.publishBatch', { entries: [{ name: 'committed.png', mime: 'image/png', bytes: bytes(mode), completed: true, sceneRevision: 1 }] });
    remove?.(); assert.equal(result.ok, true, JSON.stringify(result));
    const id = result.result[0].assetId, persisted = await f.storage.get(`project:${f.store.project.id}`);
    assert.ok(persisted.assets[id]); assert.ok(persisted.nodes.some(node => node.data.assetId === id));
    assert.equal(await (await f.storage.getBlob(`blob:${id}`)).text(), mode);
  }
});
