import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { hostedSaveFixture, until } from './hosted-save-fixture.mjs';

test('real scene owner, project menu, command bus and scoped transport share one ACK', async () => {
  await import('./bus/verify-hosted-save-owner.mjs');
});

test('host ACK saves its frozen content and leaves intervening edits dirty', async () => {
  const f = await hostedSaveFixture();
  try {
    await f.ready(); f.edit('first');
    const ack = f.holdAck(), save = f.save();
    await until(() => f.calls.includes('document.save'));
    f.edit('new edit'); ack.resolve(); await save;
    assert.equal(f.writes[0].scenes.scenes[0].stage.characters[0].subject, 'first');
    assert.equal(f.status().saveState, 'dirty');
    assert.match(f.message(), /新修改|待保存/);
  } finally { await f.dispose(); }
});

test('editing during initial restore is never checkpointed as saved', async () => {
  const f = await hostedSaveFixture();
  try {
    await until(() => f.domain.projectSaveIdentity().documentEpoch === 'restored-1');
    f.edit('edited during restore'); await f.ready();
    assert.equal(f.calls.includes('document.save'), false);
    assert.equal(f.status().saveState, 'dirty');
  } finally { await f.dispose(); }
});

test('a nonhistory workspace edit during restore remains dirty until an actual save', async () => {
  const f = await hostedSaveFixture();
  try {
    await until(() => f.domain.projectSaveIdentity().documentEpoch === 'restored-1');
    const before = f.domain.projectSaveIdentity();
    f.setLayout(400); await f.ready();
    assert.deepEqual(f.domain.projectSaveIdentity(), before, 'panel resize does not increment the author history clock');
    assert.equal(JSON.parse(f.domain.collectProjectSnapshot()).workspace.hierarchyWidth, 400);
    assert.equal(f.status().saveState, 'dirty', 'an older stored record cannot acknowledge the new layout');
  } finally { await f.dispose(); }
});

test('a nonhistory workspace edit during hydration prevents replacement of the current draft', async () => {
  const f = await hostedSaveFixture({ delayHydration: true });
  try {
    const before = f.domain.projectSaveIdentity();
    f.setLayout(400); f.releaseHydration();
    await until(() => f.status()?.saveState === 'error' || f.status()?.loaded);
    assert.deepEqual(f.domain.projectSaveIdentity(), before);
    assert.equal(JSON.parse(f.domain.collectProjectSnapshot()).workspace.hierarchyWidth, 400);
    assert.equal(f.status().saveState, 'error');
    assert.equal(f.status().loaded, false);
  } finally { await f.dispose(); }
});

test('failed save and CAS conflict never advance the acknowledged revision', async () => {
  for (const error of [new Error('disk failure'), new Error('ACK timeout failure'), Object.assign(new Error('CAS failure'), { code: 'revision_conflict' })]) {
    const f = await hostedSaveFixture();
    try {
      await f.ready(); f.edit(); f.fail(error);
      await assert.rejects(f.save(), /failure/);
      assert.equal(f.status().rev, 2);
      assert.equal(f.status().saveState, error.code ? 'conflict' : 'error');
    } finally { await f.dispose(); }
  }
});

test('unknown or incomplete dependency ACKs cannot advance the complete saved revision', async () => {
  for (const mutate of [record => ({ ...record, format: 'unknown@99' }), record => ({ ...record, dependencies: [] }),
    record => ({ ...record, dependencies: record.dependencies.map(entry => ({ ...entry, sha256: 'b'.repeat(64) })) }),
    record => ({ ...record, dependencies: record.dependencies.map(entry => ({ ...entry, role: 'other-owner' })) })]) {
    const f = await hostedSaveFixture();
    try {
      await f.ready(); f.edit();
      const request = f.session.client.request;
      f.session.client.request = async (method, payload) => {
        const result = await request(method, payload);
        return method === 'document.save' ? mutate(result) : result;
      };
      await assert.rejects(f.save(), error => error.code === 'save_ack_invalid');
      assert.equal(f.status().rev, 2);
      assert.equal(f.status().saveState, 'error');
      assert.equal(f.status().dirty, true);
    } finally { await f.dispose(); }
  }
});

test('bindings and resolution use the same frozen attempt, then new metadata stays dirty', async () => {
  const f = await hostedSaveFixture();
  try {
    await f.ready(); f.edit();
    const asset = f.holdAssetWrite(), save = f.save();
    await until(() => f.calls.includes('asset.write'));
    f.setBindings(); f.setResolution(1080); asset.resolve(); await save;
    assert.equal(f.payloads[0].scene.characterBindings[0].assetId, 'before');
    assert.equal(f.payloads[0].scene.exportResolution, 720);
    assert.equal(f.status().saveState, 'dirty');
    await f.save();
    assert.equal(f.payloads[1].scene.characterBindings[0].assetId, 'after');
    assert.equal(f.payloads[1].scene.exportResolution, 1080);
    assert.equal(f.status().saveState, 'saved');
  } finally { await f.dispose(); }
});

test('an edit during serialization retries a whole frozen document, never mixed content', async () => {
  const f = await hostedSaveFixture();
  try {
    await f.ready(); f.edit('first'); f.holdSerialization();
    const save = f.save(); await new Promise(resolve => setTimeout(resolve, 5));
    f.edit('new serialization'); f.releaseSerialization(); await save;
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].scenes.scenes[0].stage.characters[0].subject, 'new serialization');
    assert.equal(f.status().saveState, 'saved');
  } finally { await f.dispose(); }
});

test('a different document before ACK stays dirty while the validated host revision advances', async () => {
  const f = await hostedSaveFixture();
  try {
    await f.ready(); f.edit();
    const ack = f.holdAck(), save = f.save();
    await until(() => f.calls.includes('document.save'));
    f.replaceDocument(); ack.resolve();
    await assert.rejects(save, /工程已切换/);
    assert.equal(f.status().rev, 3, 'the same session remembers its validated committed transport revision');
    assert.equal(f.status().dirty, true);
    assert.equal(f.status().saveState, 'error', 'the replaced author document is not acknowledged by the old save');
    assert.equal(f.writes[0].scenes.scenes[0].stage.characters[0].subject, 'after', 'the ACK still belongs to the frozen old document');
  } finally { await f.dispose(); }
});

test('a download copy never changes the host revision, dirty state, or writes', async () => {
  const f = await hostedSaveFixture();
  try {
    await f.ready(); f.edit();
    const before = f.status();
    await f.appContext.actionPorts.projectPersistence.exportCopy();
    assert.deepEqual(f.status(), before);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.downloads, ['导演工程.cclayproject']);
  } finally { await f.dispose(); }
});

test('host shortcut saves through project.save without stealing composition or focus', async () => {
  const f = await hostedSaveFixture();
  try {
    await f.ready();
    let prevented = 0;
    const key = { code: 'KeyS', ctrlKey: true, target: { tagName: 'TEXTAREA' }, preventDefault() { prevented++; } };
    f.key(key); await Promise.resolve();
    f.key({ ...key, isComposing: true }); f.key({ ...key, repeat: true }); f.key({ ...key, shiftKey: true });
    assert.deepEqual(f.keys, ['project.save']); assert.equal(prevented, 1);
    assert.equal(key.target.tagName, 'TEXTAREA');
  } finally { await f.dispose(); }
});

test('hydrate-time edits stop restoration before it can replace current content', async () => {
  // Delay the actual hook's asset restoration stage, before applyProject.
  const f = await hostedSaveFixture({ delayHydration: true });
  try {
    f.edit('before apply'); f.releaseHydration();
    await until(() => f.status()?.saveState === 'error' || f.status()?.loaded);
    assert.equal(f.status().saveState, 'error');
    assert.equal(f.status().loaded, false);
    assert.match(f.domain.collectProjectSnapshot(), /before apply/);
  } finally { await f.dispose(); }
});

test('actual resolution UI callback transports numeric 720/1080 and restore retains both', async () => {
  const source = readFileSync(new URL('../integration/camera-controls.jsx', import.meta.url), 'utf8');
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'JSXOpeningElement' && node.attributes.some(attribute => attribute.name?.name === 'data-testid' && attribute.value?.value === 'director-resolution')) return node;
    for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) { const found = find(child); if (found) return found; }
    return null;
  }
  const element = find(parseSync('camera-controls.jsx', source).program);
  const callback = element.attributes.find(attribute => attribute.name?.name === 'onChange').value.expression;
  const change = new Function('ports', 'blocked', `return (${source.slice(callback.start, callback.end)});`);
  for (const resolution of [720, 1080]) {
    const f = await hostedSaveFixture({ savedResolution: resolution });
    try {
      await f.ready(); assert.equal(f.ports.outputResolution, resolution);
      // Supply the real callback's closure dependency, and exercise both
      // locked and enabled branches before transporting the numeric value.
      change(f.ports, () => true)({ target: { value: String(resolution === 720 ? 1080 : 720) } });
      assert.equal(f.ports.outputResolution, resolution, 'a blocked control cannot change the saved resolution');
      change(f.ports, () => false)({ target: { value: String(resolution === 720 ? 1080 : 720) } }); f.render();
      await f.save();
      assert.equal(typeof f.payloads[0].scene.exportResolution, 'number');
      assert.equal(f.payloads[0].scene.exportResolution, resolution === 720 ? 1080 : 720);
      assert.equal(f.status().saveState, 'saved');
    } finally { await f.dispose(); }
  }
  const f = await hostedSaveFixture({ savedResolution: '720' });
  try { await until(() => f.status()?.saveState === 'error'); assert.equal(f.status().loaded, false); assert.equal(f.ports.outputResolution, 1080); }
  finally { await f.dispose(); }
});

test('closing the root before a resolved ACK cannot update the old facade', async () => {
  const f = await hostedSaveFixture();
  try {
    await f.ready(); f.edit();
    const ack = f.holdAck(), save = f.save();
    await until(() => f.calls.includes('document.save'));
    f.close(); ack.resolve();
    await assert.rejects(save, /关闭|closed|会话/);
  } finally { await f.dispose(); }
});
