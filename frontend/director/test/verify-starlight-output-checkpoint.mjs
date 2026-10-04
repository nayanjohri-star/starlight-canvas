// SPDX-License-Identifier: AGPL-3.0-or-later
// Execute the shipped hook and transport ordering; constant port bytes are CPU
// control-flow fixtures, never real renderer, PNG, codec or media evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedSaveFixture, until, deferred } from './hosted-save-fixture.mjs';

async function fixture() {
  const f = await hostedSaveFixture({ savedResolution: 720 }); await f.ready();
  f.appContext.live = { state: { shots: [{ id: 'shot', startFrame: 0, endFrame: 149 }], activeShotId: 'shot',
    timeline: { fps: 24, frameCount: 150, currentFrame: 0 } } };
  const captures = [], publications = [], bytes = new Uint8Array([1, 2, 3]), original = f.session.client.request;
  let waitRender = null, changeAtCapture = null;
  f.ports.captureFrame = frame => { captures.push({ kind: 'png', frame }); changeAtCapture?.(); return 'data:image/png;base64,AQID'; };
  f.ports.exportVideo = async () => { captures.push({ kind: 'video' }); if (waitRender) await waitRender.promise;
    return { blob: new Blob([bytes], { type: 'video/mp4' }), frameCount: 150, fps: 24 }; };
  f.ports.exportPack = async () => { captures.push({ kind: 'pack' }); if (waitRender) await waitRender.promise;
    return { bytes, name: 'cpu-pack.zip', entries: [{ name: 'first.png', data: bytes }, { name: 'clip.mp4', data: bytes }] }; };
  f.session.client.request = async (method, payload) => {
    if (method === 'output.publishBatch') { publications.push(payload); return payload.entries.map((_entry, i) => ({ assetId: `cpu-output-${i}` })); }
    return original(method, payload);
  };
  return { ...f, captures, publications, output(kind) { return window.__starlightDirector[{ png: 'exportPng', video: 'exportVideo', pack: 'exportPack' }[kind]](0); },
    holdRender() { return (waitRender = deferred()); }, changeAtCapture(fn) { changeAtCapture = fn; } };
}
test('PNG/video/pack stop before rendering when save ACK belongs to an older authoring checkpoint', async () => {
  for (const kind of ['png', 'video', 'pack']) {
    const f = await fixture();
    try {
      f.edit(); const gate = f.holdAssetWrite(), output = f.output(kind);
      await until(() => f.calls.includes('asset.write')); f.setResolution(1080); gate.resolve();
      await assert.rejects(output, error => error.code === 'saved_content_changed');
      assert.equal(f.payloads[0].scene.exportResolution, 720);
      assert.equal(f.status().saveState, 'dirty'); assert.equal(f.status().busy, false);
      assert.deepEqual(f.captures, []); assert.deepEqual(f.publications, []);
      const result = await f.output(kind);
      assert.ok(result.assetId); assert.equal(f.status().saveState, 'saved');
      assert.equal(f.publications[0].entries[0].sceneRevision, 4);
      assert.equal(f.payloads[1].scene.exportResolution, 1080);
    } finally { await f.dispose(); }
  }
});
test('changes during capture/encoding or pack await cannot publish under the saved revision', async () => {
  for (const kind of ['png', 'video', 'pack']) {
    const f = await fixture();
    try {
      f.edit(); let gate;
      if (kind === 'png') f.changeAtCapture(() => f.setLayout(400)); else gate = f.holdRender();
      const output = f.output(kind);
      if (gate) { await until(() => f.captures.length > 0); f.setResolution(1080); gate.resolve(); }
      await assert.rejects(output, error => error.code === 'saved_content_changed');
      assert.equal(f.captures.length, 1); assert.deepEqual(f.publications, []);
      assert.equal(f.status().saveState, 'dirty'); assert.equal(f.status().busy, false);
    } finally { await f.dispose(); }
  }
});
test('unchanged PNG/video/pack publish completed bytes with the acknowledged revision', async () => {
  for (const kind of ['png', 'video', 'pack']) {
    const f = await fixture();
    try {
      f.edit(); const result = await f.output(kind); assert.ok(result.assetId);
      assert.equal(f.status().saveState, 'saved'); assert.equal(f.status().busy, false);
      assert.equal(f.publications.length, 1);
      assert.ok(f.publications[0].entries.every(entry => entry.completed === true && entry.sceneRevision === 3));
    } finally { await f.dispose(); }
  }
});

test('generation draft cannot combine an older save ACK with newly edited authoring; an explicit retry uses the new revision', async () => {
  const f = await hostedSaveFixture({ videoModels: [{ id: 'cpu-seed-model', intents: ['reference'], defaultSeconds: 4 }] });
  try {
    await f.ready(); f.appContext.live = { state: { activeShotId: 'shot' } };
    const drafts = [], request = f.session.client.request;
    f.session.client.request = async (method, payload) => {
      if (method === 'generation.createDraft') { drafts.push(payload); return { nodeId: 'cpu-draft' }; }
      return request(method, payload);
    };
    f.edit(); const gate = f.holdAck(), pending = window.__starlightDirector.createGenerationDraft();
    await until(() => f.calls.includes('document.save')); f.setLayout(400); gate.resolve();
    await assert.rejects(pending, error => error.code === 'saved_content_changed');
    assert.deepEqual(drafts, []); assert.equal(f.status().saveState, 'dirty');
    await window.__starlightDirector.createGenerationDraft();
    assert.equal(drafts.length, 1); assert.equal(drafts[0].sceneRevision, 4);
  } finally { await f.dispose(); }
});

test('a project change while awaiting generation assets cannot open the stale selection panel', async () => {
  const f = await hostedSaveFixture({ portal: true });
  try {
    await f.ready(); const gate = deferred(), request = f.session.client.request;
    let requested = false;
    f.session.client.request = async (method, payload) => {
      if (method === 'asset.list') { requested = true; await gate.promise; return []; }
      return request(method, payload);
    };
    const walk = node => !node || typeof node !== 'object' ? [] : [node,
      ...[node.props?.children ?? node.children].flat(Infinity).flatMap(walk)];
    const button = walk(f.render().bar).find(node => node.props?.['data-testid'] === 'hosted-director-generation');
    const opening = button.props.onClick(); await until(() => requested);
    f.replaceDocument(); gate.resolve(); await opening;
    assert.equal(walk(f.render().bar).some(node => node.props?.['aria-label'] === '模型生成草稿'), false);
    assert.match(f.status().saveState, /dirty/);
  } finally { await f.dispose(); }
});

test('reopening identical project content retires an in-flight encoded output by its document epoch', async () => {
  const f = await fixture();
  try {
    f.edit(); const gate = f.holdRender(), output = f.output('video');
    await until(() => f.captures.length > 0);
    const before = f.domain.collectProjectSnapshot(); f.reopenSameDocument();
    assert.equal(f.domain.collectProjectSnapshot(), before, 'authoring key alone cannot detect the reopened document');
    gate.resolve(); await assert.rejects(output, error => error.code === 'saved_content_changed');
    assert.deepEqual(f.publications, []); assert.equal(f.status().busy, false);
  } finally { await f.dispose(); }
});

test('late reference bytes or FileReader completion never bind a reopened project; unchanged binding still saves', async () => {
  for (const phase of ['asset-read', 'file-reader', 'unchanged']) {
    const previousReader = globalThis.FileReader, f = await hostedSaveFixture({ portal: true });
    try {
      await f.ready(); f.appContext.live = { state: { activeCharacterId: 'actor-a', activeShotId: null } };
      const asset = { assetId: 'cpu-portrait', kind: 'image', mime: 'image/png', name: 'CPU portrait', ref: 'xp-asset://cpu-portrait', sha256: 'd'.repeat(64) };
      const gate = deferred(), request = f.session.client.request, mutations = [];
      let readEntered = false, readerEntered = false;
      globalThis.FileReader = class {
        readAsDataURL() { readerEntered = true; (async () => {
          if (phase === 'file-reader') await gate.promise;
          this.result = 'data:image/png;base64,AQID'; this.onload();
        })(); }
      };
      f.session.client.request = async (method, payload) => {
        if (method === 'asset.list') return [asset];
        if (method === 'asset.read') { readEntered = true; if (phase === 'asset-read') await gate.promise;
          return { ...asset, bytes: new Uint8Array([1, 2, 3]).buffer }; }
        return request(method, payload);
      };
      f.appContext.bus.run = async (id, args) => { mutations.push({ id, args }); f.edit('bound portrait'); return { ok: true }; };
      const walk = node => !node || typeof node !== 'object' ? [] : [node,
        ...[node.props?.children ?? node.children].flat(Infinity).flatMap(walk)];
      const opening = walk(f.render().bar).find(node => node.props?.['data-testid'] === 'hosted-director-generation');
      await opening.props.onClick();
      const button = walk(f.render().bar).find(node => node.type === 'button' && node.props.children === '绑定所选人物');
      assert.ok(button); const binding = button.props.onClick();
      if (phase !== 'unchanged') {
        await until(() => phase === 'asset-read' ? readEntered : readerEntered);
        f.reopenSameDocument(); gate.resolve();
      }
      await binding;
      if (phase === 'unchanged') {
        assert.equal(mutations.length, 1); assert.equal(mutations[0].args.characterId, 'actor-a');
        assert.equal(f.payloads.at(-1).scene.characterBindings[0].assetId, asset.assetId);
        assert.equal(f.status().saveState, 'saved');
      } else { assert.deepEqual(mutations, []); assert.equal(f.payloads.length, 0, 'no late binding is saved'); }
    } finally { globalThis.FileReader = previousReader; await f.dispose(); }
  }
});
