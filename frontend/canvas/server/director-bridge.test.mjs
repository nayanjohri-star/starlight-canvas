// Isolated SDK checks for the original director iframe; no browser/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/__hub-sdk__.js', import.meta.url), 'utf8');
const expectedParent = 'http://127.0.0.1:4178';
const NONCE = 'session_test';

function host(referrer = expectedParent + '/', urlFn) {
  const sent = [], listeners = new Map();
  class LocalURL extends URL {}
  LocalURL.createObjectURL = urlFn ?? (() => 'blob:http://localhost:4178/mock');
  LocalURL.revokeObjectURL = () => {};
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const scope = {
    URL: LocalURL, URLSearchParams, Blob, ArrayBuffer, Map, Set, Promise, crypto,
    location: new URL('http://localhost:4178/director/index.html?node=director_test&nonce=' + NONCE),
    document: { referrer }, innerWidth: 1280, innerHeight: 800, parent,
    addEventListener: (type, listener) => listeners.set(type, listener),
    setTimeout: () => 0, clearTimeout() {},
  };
  scope.window = scope;
  vm.runInContext(source, vm.createContext(scope));
  const reply = (req, patch) => listeners.get('message')?.({
    source: parent, origin: expectedParent,
    data: { ns: 'xp-hub', kind: 'rpc-res', id: req.id, nonce: NONCE, ...patch },
  });
  return {
    scope, sent,
    receive: data => listeners.get('message')?.({ source: parent, origin: expectedParent, data }),
    receiveFrom: (data, origin) => listeners.get('message')?.({ source: parent, origin, data }),
    ok: (req, result) => reply(req, { ok: true, result }),
    fail: (req, error) => reply(req, { ok: false, error }),
  };
}
const spin = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('director discovers its known local parent when the host sends Referrer-Policy no-referrer', () => {
  const h = host('');
  assert.ok(h.sent.some(x => x.message.kind === 'hello' && x.origin === expectedParent), 'the production local server deliberately does not disclose a referrer');
});

test('director ignores a response without the current session nonce', async () => {
  const h = host();
  let resolved = false;
  h.scope.hub.storage.get('composition').then(() => { resolved = true; }, () => {});
  const request = h.sent.find(x => x.message.kind === 'rpc').message;
  h.receive({ ns: 'xp-hub', kind: 'rpc-res', id: request.id, ok: true, result: null });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(resolved, false, 'session validation must reject a missing nonce, not only an incorrect nonce');
});

test('director file writes transfer cloneable resolved bytes rather than a Promise', async () => {
  const h = host();
  h.scope.hub.files.writeToPluginDir('scene.glb', new Blob([new Uint8Array([1, 2, 3])], { type: 'model/gltf-binary' })).catch(() => {});
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const request = h.sent.find(x => x.message.method === 'files.writeToPluginDir');
  assert.ok(request, 'a local file write must reach the host');
  assert.doesNotThrow(() => structuredClone(request.message), 'postMessage cannot transfer a pending Promise');
});

test('original director object-form file writes preserve the source bytes and return a usable local URL', async () => {
  // Original index-BoG959qJ.js calls writeToPluginDir({path, source}).url.
  const h = host();
  const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
  const writing = h.scope.hub.files.writeToPluginDir({ path: 'models/mock.glb', source: new Blob([bytes], { type: 'model/gltf-binary' }) });
  writing.catch(() => {});
  await spin(8);
  const request = h.sent.find(x => x.message.method === 'files.writeToPluginDir')?.message;
  assert.ok(request, 'the actual bundled plugin signature reaches the host');
  assert.deepEqual(Array.from(new Uint8Array(request.args?.bytes ?? [])), Array.from(bytes));
  h.receive({ ns: 'xp-hub', kind: 'rpc-res', nonce: NONCE, id: request.id, ok: true, result: { assetId: 'mock_glb', name: 'mock.glb' } });
  const result = await writing;
  assert.match(result.url, /^blob:http:\/\/localhost:4178\//, 'original loaders need a usable iframe-local URL, not a nonexistent /files/id path');
});

test('export of a TypedArray view transfers only the view range, not the whole backing buffer', async () => {
  const h = host();
  const view = new Uint8Array([9, 9, 9, 1, 2, 3, 4, 8, 8, 8]).subarray(3, 7);
  const writing = h.scope.hub.canvas.insertImageNode({ name: 'v.png', source: view, mime: 'image/png' });
  writing.catch(() => {});
  await spin(8);
  const request = h.sent.find(x => x.message.method === 'canvas.insertImageNode')?.message;
  assert.ok(request, 'image export must reach the host');
  const bytes = request.args?.bytes;
  assert.equal(bytes?.byteLength ?? bytes?.length, 4, 'only the 4-byte view range is transferred');
  assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3, 4]);
  assert.equal(request.args.source, undefined, 'source is resolved into bytes');
});

test('director drops parent messages arriving from a wrong origin even with a valid nonce', async () => {
  const h = host();
  let resolved = undefined;
  const getting = h.scope.hub.storage.get('composition');
  getting.then(v => { resolved = v; }, () => {});
  const request = h.sent.find(x => x.message.kind === 'rpc').message;
  // 异源伪造应答（携带了猜对的 nonce）必须被 source/origin 双重校验丢弃
  h.receiveFrom({ ns: 'xp-hub', kind: 'rpc-res', id: request.id, ok: true, result: 'leak', nonce: NONCE }, 'http://evil.example');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(resolved, undefined, 'wrong-origin responses must be dropped');
  h.receive({ ns: 'xp-hub', kind: 'rpc-res', id: request.id, ok: true, result: 'real', nonce: NONCE });
  // get() 内部还串着 detokenize 的异步采用——直接 await 真实 promise，不数 microtask
  assert.equal(await getting, 'real');
  assert.equal(resolved, 'real');
});

test('director refuses to persist a scene whose referenced blob failed to embed', async () => {
  const h = host();
  const url = h.scope.URL.createObjectURL(new Blob(['local-scene'], { type: 'model/gltf-binary' }));
  const saving = h.scope.hub.storage.set('composition', { scene: url });
  const assertion = assert.rejects(saving, /托管|素材|失败/);
  await spin();
  const embedReq = h.sent.find(x => x.message.method === 'asset.embed');
  assert.ok(embedReq, 'referenced blob triggers asset.embed before saving');
  h.fail(embedReq.message, '模拟空间不足');
  await assertion;
  assert.equal(h.sent.filter(x => x.message.method === 'storage.set').length, 0, 'failed embed must not overwrite the last recoverable scene with a dead blob: URL');
});

test('an unrelated failed embed does not poison a save whose own references are recoverable', async () => {
  let n = 0;
  const h = host(expectedParent + '/', () => `blob:http://localhost:4178/u${++n}`);
  h.scope.URL.createObjectURL(new Blob(['bad'], { type: 'model/gltf-binary' }));    // 不被本次保存引用
  const good = h.scope.URL.createObjectURL(new Blob(['good'], { type: 'model/gltf-binary' }));
  const saving = h.scope.hub.storage.set('composition', { scene: good });
  saving.catch(() => {});
  await spin();
  const embeds = h.sent.filter(x => x.message.method === 'asset.embed');
  assert.equal(embeds.length, 2, 'both blobs offered for embed');
  h.fail(embeds[0].message, 'quota');              // 无关引用托管失败
  h.ok(embeds[1].message, { assetId: 'a_good' });  // 本次引用的托管成功
  await spin();
  const setReq = h.sent.find(x => x.message.method === 'storage.set');
  assert.ok(setReq, 'save proceeds once its own references are tokenizable');
  const saved = JSON.stringify(setReq.message.args.value);
  assert.match(saved, /xp-asset:\/\/a_good/);
  assert.ok(!saved.includes('blob:'), 'no ephemeral blob URL persisted');
  h.ok(setReq.message, true);
  assert.equal(await saving, true);
});

test('restore maps xp-asset tokens to real local URLs; an incomplete bytes map is an explicit error', async () => {
  const h = host();
  const getting = h.scope.hub.storage.get('composition');
  getting.catch(() => {});
  await spin();
  const getReq = h.sent.find(x => x.message.method === 'storage.get');
  h.ok(getReq.message, { scene: 'xp-asset://a1' });
  await spin();
  const bytesReq = h.sent.find(x => x.message.method === 'asset.bytes');
  assert.ok(bytesReq, 'token restore requests asset bytes');
  assert.deepEqual(Array.from(bytesReq.message.args.ids), ['a1']);
  h.ok(bytesReq.message, { a1: { mime: 'model/gltf-binary', bytes: new Uint8Array([0x67, 0x6c]).buffer } });
  const restored = await getting;
  assert.match(restored.scene, /^blob:http:\/\/localhost:4178\//, 'token swapped for a usable iframe-local URL');
  assert.ok(!JSON.stringify(restored).includes('xp-asset://'), 'no dead token handed to the plugin');

  // 恢复出的 URL 与令牌同源绑定：再次保存直接令牌化回 xp-asset://a1，不重复托管
  const saving = h.scope.hub.storage.set('composition', restored);
  saving.catch(() => {});
  await spin();
  assert.equal(h.sent.filter(x => x.message.method === 'asset.embed').length, 0, 'restored URL needs no re-embed');
  const setReq = h.sent.find(x => x.message.method === 'storage.set');
  assert.ok(setReq, 're-saving a restored scene proceeds');
  assert.match(JSON.stringify(setReq.message.args.value), /xp-asset:\/\/a1/);
  h.ok(setReq.message, true);
  assert.equal(await saving, true);

  // 不完整 asset.bytes 映射 = 显式错误，而不是静默留下死 xp-asset 引用
  const getting2 = h.scope.hub.storage.get('composition2');
  const assertion = assert.rejects(getting2, /缺失|恢复|素材/);
  await spin();
  const getReq2 = h.sent.filter(x => x.message.method === 'storage.get').at(-1);
  h.ok(getReq2.message, { scene: 'xp-asset://gone' });
  await spin();
  const bytesReq2 = h.sent.filter(x => x.message.method === 'asset.bytes').at(-1);
  h.ok(bytesReq2.message, {});
  await assertion;
});
