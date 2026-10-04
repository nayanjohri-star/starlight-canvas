import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { normalizeTimeline, buildProjectPackage, importProjectPackage } from '../src/export-project.js';

const clip = extra => ({ id: 'clip1', track: 'v1', kind: 'video', assetId: 'a1',
  name: '分镜成片', start: 0, end: 4.5, in: 0, speed: 1, ...extra });

test('手动时长标记经过归一化仍保留，不能伪装成实测 sourceDuration', () => {
  const assets = { a1: { id: 'a1', kind: 'video' } };
  const once = normalizeTimeline([clip({ durationManual: true })], { assets }).clips[0];
  const twice = normalizeTimeline([once], { assets }).clips[0];
  assert.equal(once.durationManual, true);
  assert.equal(twice.durationManual, true);
  assert.equal(once.sourceDuration, undefined);
  assert.equal(twice.sourceDuration, undefined);
  assert.equal(Object.hasOwn(normalizeTimeline([clip({ durationManual: false })], { assets }).clips[0], 'durationManual'), false);
  assert.equal(Object.hasOwn(normalizeTimeline([clip({ durationManual: 'true' })], { assets }).clips[0], 'durationManual'), false);
  assert.equal(Object.hasOwn(normalizeTimeline([clip({ durationManual: true, sourceDuration: 4.5 })], { assets }).clips[0], 'durationManual'), false,
    '已有实测时长的片段不保留冲突的手动来源标记');
});

test('手动时长随工程包导出与导入保留，旧工程无该字段仍可读', async () => {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('手动时长工程');
  const blob = new Blob([new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112])], { type: 'video/mp4' });
  store.project.assets.a1 = { id: 'a1', name: 'a1.mp4', kind: 'video', mime: 'video/mp4', size: blob.size };
  store.project.studio = { version: 1, groups: [], shots: [], timeline: [clip({ durationManual: true })], workflow: null };
  await storage.setBlob('blob:a1', blob);
  const json = await store.exportJSON();
  const packed = await buildProjectPackage({ projectJson: json, clips: store.project.studio.timeline,
    blobOf: id => storage.getBlob('blob:' + id), assets: store.project.assets });
  const imported = await importProjectPackage({ store }, packed);
  const restored = imported.project.studio.timeline[0];
  assert.equal(restored.durationManual, true);
  assert.equal(restored.sourceDuration, undefined);
  assert.notEqual(restored.assetId, 'a1', '导入仍重映射素材身份');
  assert.equal(imported.rebound, 1);
  const old = normalizeTimeline([clip({})], { assets: store.project.assets }).clips[0];
  assert.equal(Object.hasOwn(old, 'durationManual'), false);
});
