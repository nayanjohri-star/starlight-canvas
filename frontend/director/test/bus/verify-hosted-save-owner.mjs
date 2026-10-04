import assert from 'node:assert/strict';
import { createHostedSaveCoordinator } from '../../integration/save-coordinator.js';
import { createDirectorClient } from '../../integration/client.js';
import { directorEnvelope, matchesDirectorEnvelope } from '../../../canvas/src/director-protocol.js';
import { projectFixture, ok } from './project-fixture.mjs';
import { deferred } from './fixture.mjs';

const f = projectFixture(), app = f.scope.appContext;
const previousWindow = globalThis.window;
const messages = new Set(), scope = { sessionId: 'save-session', projectId: 'canvas-project', nodeId: 'director-node' };
let record = null, artifact, copyCount = 0, gate = null;
const transported = [];
const win = { location: { origin: 'https://test.invalid' },
  addEventListener(type, listener) { if (type === 'message') messages.add(listener); },
  removeEventListener(type, listener) { if (type === 'message') messages.delete(listener); },
  parent: { postMessage(envelope) {
    assert.equal(matchesDirectorEnvelope(envelope, scope, 'request'), true);
    transported.push(envelope);
    queueMicrotask(async () => {
      try {
        let result;
        if (envelope.method === 'asset.write') {
          artifact = JSON.parse(new TextDecoder().decode(envelope.payload.bytes));
          result = { ref: 'xp-asset://owned-project', sha256: 'a'.repeat(64), role: 'project' };
        } else {
          assert.equal(envelope.method, 'document.save');
          assert.equal(envelope.payload.expectedRevision, record?.rev ?? null);
          if (gate) { gate.entered.resolve(); await gate.release.promise; }
          record = { format: 'starlight-director@1', ...scope, rev: (record?.rev ?? 0) + 1, scene: envelope.payload.scene, dependencies: envelope.payload.dependencies };
          result = record;
        }
        const response = directorEnvelope(scope, envelope.requestId, envelope.method, { ok: true, result }, 'response');
        for (const listener of messages) listener({ data: response, source: win.parent, origin: win.location.origin });
      } catch (error) { throw error; }
    });
  } },
};
const client = createDirectorClient({ window: win, scope });
const coordinator = createHostedSaveCoordinator({ session: { client, record: null }, active: () => true,
  identity: f.project.projectSaveIdentity,
  capture: resources => f.project.captureProjectSave('Heist', resources),
  serialize: (frozen, check) => f.project.collectProjectSerialized('Heist', frozen, check),
  extras: () => ({ bindings: [], exportResolution: 720 }),
});
const release = f.project.subscribeProject(({ snapshot }) => coordinator.observe(snapshot));
const adapter = { getSnapshot: coordinator.getSnapshot, save: () => coordinator.save(), exportCopy: async () => { copyCount++; return { fileName: 'Heist.cclayproject' }; } };
f.actionHandlers.current.projectPersistence = adapter;
app.updateActionPorts({ projectPersistence: adapter });
globalThis.window = { showOpenFilePicker() {}, showSaveFilePicker() { throw new Error('hosted project.save must never open a file picker'); } };
try {
  coordinator.finishRestore(coordinator.beginRestore());
  // Freeze the actual scene owner's input, then mutate its live stage. The
  // portable serializer must use the captured authoring envelope throughout.
  const frozen = f.project.captureProjectSave('Heist');
  const oldStyle = frozen.input.scenesDocument.scenes[0].stage.style;
  ok(await f.run('stage.setStyle', { style: 'Edited after freeze' }));
  const copied = JSON.parse(await f.project.collectProjectSerialized('Heist', frozen));
  assert.equal(copied.scenes.scenes[0].stage.style, oldStyle);
  assert.notEqual(f.project.collectProjectSnapshot('Heist'), frozen.snapshot);

  const walk = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(walk)];
  const menu = walk(f.panel({ hosted: true, projectDirty: coordinator.getSnapshot().dirty }));
  const save = menu.find(node => node.type === 'button' && node.props.children === '保存到当前画布项目');
  const copy = menu.find(node => node.type === 'button' && node.props.children === '导出工程副本到本机');
  assert.ok(save && copy);
  gate = { entered: deferred(), release: deferred() };
  const saving = save.props.onClick();
  await gate.entered.promise;
  assert.equal(coordinator.getSnapshot().saveState, 'saving');
  ok(await f.run('stage.setStyle', { style: 'Changed while ACK pending' }));
  gate.release.resolve(); const receipt = ok(await saving);
  assert.equal(receipt.output.revision, 1);
  assert.equal(artifact.scenes.scenes[0].stage.style, 'Edited after freeze');
  assert.equal(coordinator.getSnapshot().dirty, true);
  assert.equal(coordinator.getSnapshot().rev, 1);
  assert.deepEqual(transported.map(message => message.method), ['asset.write', 'document.save']);
  const before = coordinator.getSnapshot();
  ok(await copy.props.onClick()); assert.equal(copyCount, 1);
  assert.deepEqual(coordinator.getSnapshot(), before);
  assert.equal(transported.length, 2);
  gate = null; ok(await f.run('project.save'));
  assert.equal(coordinator.getSnapshot().saveState, 'saved');
  assert.equal(artifact.scenes.scenes[0].stage.style, 'Changed while ACK pending');
  console.log('PASS actual scene frozen serialization + real menu/bus/client scoped ACK + concurrent edits + independent copy');
} finally { release(); coordinator.close(); client.dispose(); f.dispose(); globalThis.window = previousWindow; }
