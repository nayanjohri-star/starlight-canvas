import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { zipStore, buildProjectPackage, parseProjectPackage } from '../src/export-project.js';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';

const require = createRequire(new URL('../../director/package.json', import.meta.url));
const { unzipSync } = require('fflate');
const enc = new TextEncoder();

test('STORE exports preserve UTF-8 names and exact bytes in an independent ZIP reader', () => {
  const entries = [
    { name: 'manifest.json', data: enc.encode('{"version":1}') },
    { name: 'media/角色.bin', data: Uint8Array.of(0, 255, 1, 127) },
    { name: '中文.txt', data: enc.encode('可迁移工程') },
    { name: 'empty.bin', data: new Uint8Array() },
  ];
  const files = unzipSync(zipStore(entries));
  assert.deepEqual(Object.keys(files).sort(), entries.map(row => row.name).sort());
  for (const row of entries) assert.deepEqual(files[row.name], row.data, row.name);
});

test('a complete director canvas package exposes the same project and asset bytes to a standard ZIP reader', async () => {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('独立工程包验收');
  const director = store.addNode('director', 0, 0, { title: '原始导演工程' });
  const assetId = 'original-scene', bytes = Uint8Array.of(103, 108, 84, 70, 0, 255);
  store.project.assets[assetId] = { id: assetId, name: '场景.glb', kind: 'file',
    mime: 'model/gltf-binary', size: bytes.length, addedAt: 1, fromDirector: director.id };
  await storage.setBlob(`blob:${assetId}`, new Blob([bytes], { type: 'model/gltf-binary' }));
  await storage.set(`dir:${director.id}:composition`, { scene: `xp-asset://${assetId}` });
  const projectJson = await store.exportJSON();
  const archive = await buildProjectPackage({ projectJson, clips: [], assets: store.project.assets,
    blobOf: id => storage.getBlob(`blob:${id}`) });
  const ordinary = unzipSync(archive), own = parseProjectPackage(archive);
  assert.deepEqual(Object.keys(ordinary).sort(), [...own.files.keys()].sort());
  for (const [name, data] of own.files) assert.deepEqual(ordinary[name], data, name);
  assert.equal(new TextDecoder().decode(ordinary['project.json']), projectJson);
  const media = own.manifest.media.find(row => row.assetId === assetId);
  assert.ok(media); assert.deepEqual(ordinary[media.path], bytes);
  await store.flush();
});
