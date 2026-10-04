// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedSaveFixture, until } from './hosted-save-fixture.mjs';
import { createHostedSaveCoordinator } from '../integration/save-coordinator.js';

test('the real hook checkpoints the fixed incoming owner snapshot after an asynchronous React projection', async () => {
  const f = await hostedSaveFixture({ delayProjection: true, restoredCharacterId: 'incoming-actor' });
  try {
    await until(() => f.domain.projectSaveIdentity().documentEpoch === 'restored-1');
    assert.match(f.domain.captureProjectSave().snapshot, /"subject":"before"/, 'the immediate React projection is still outgoing');
    assert.match(JSON.stringify(f.session.initialProject), /restored owner/);
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(f.status().loaded, false, 'elapsed time cannot substitute for actual incoming projection completion');
    f.settleProjection(); await f.ready();
    assert.equal(f.status().saveState, 'saved');
    assert.equal(f.status().rev, 2);
    assert.equal(f.session.record.scene.characterBindings[0].characterId, 'incoming-actor');
    await f.save();
    assert.deepEqual(f.calls, [], 'an unchanged reopened project does not write a new resource or revision');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual(f.calls, [], 'the ordinary autosave interval also preserves the stored revision');
  } finally { await f.dispose(); }
});

test('asynchronous restoration cannot checkpoint real authored, nonhistory, metadata or document changes', async () => {
  for (const [name, mutate] of [
    ['authored edit', f => f.edit('real intervening edit')],
    ['nonhistory workspace', f => f.setLayout(400)],
    ['reference binding', f => f.setBindings()],
    ['output resolution', f => f.setResolution(1080)],
    ['same-content document replacement', f => f.reopenSameDocument()],
  ]) {
    const f = await hostedSaveFixture({ delayProjection: true });
    try {
      await until(() => f.domain.projectSaveIdentity().documentEpoch === 'restored-1');
      mutate(f); f.settleProjection();
      if (name === 'same-content document replacement') await until(() => f.status()?.saveState === 'error');
      else await f.ready();
      assert.equal(f.status().saveState, name === 'same-content document replacement' ? 'error' : 'dirty', name);
      if (name === 'same-content document replacement') assert.equal(f.status().loaded, false);
      assert.equal(f.status().rev, 2, name);
      assert.equal(f.calls.includes('document.save'), false, name);
      if (name === 'authored edit') assert.match(f.domain.captureProjectSave().snapshot, /real intervening edit/);
      if (name === 'nonhistory workspace') assert.equal(JSON.parse(f.domain.captureProjectSave().snapshot).workspace.hierarchyWidth, 400);
    } finally { await f.dispose(); }
  }
});

test('closing the account session while its incoming projection is pending cannot finish or autosave restoration', async () => {
  const f = await hostedSaveFixture({ delayProjection: true });
  try {
    await until(() => f.domain.projectSaveIdentity().documentEpoch === 'restored-1');
    const persistence = f.appContext.actionPorts.projectPersistence;
    f.close(); f.settleProjection();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(f.calls, []);
    await assert.rejects(persistence.save(), /关闭|closed|会话/);
  } finally { await f.dispose(); }
});

test('restore compares the full author document exactly except for object field order', () => {
  const expected = { name: 'Project', rows: [{ id: 'a', frame: 0 }, { id: 'b', frame: 1 }], workspace: { width: 280 } };
  for (const [name, value, saved] of [
    ['field order only', { workspace: { width: 280 }, rows: [{ frame: 0, id: 'a' }, { frame: 1, id: 'b' }], name: 'Project' }, true],
    ['array order', { ...expected, rows: [...expected.rows].reverse() }, false],
    ['nested scalar', { ...expected, workspace: { width: 281 } }, false],
    ['added property', { ...expected, extra: null }, false],
    ['missing property', { rows: expected.rows, workspace: expected.workspace }, false],
  ]) {
    const identity = { documentEpoch: 'incoming', clock: 0 };
    const coordinator = createHostedSaveCoordinator({ session: { record: { rev: 2 }, client: { closed: false } }, active: () => true,
      identity: () => identity, capture: () => ({ ...identity, snapshot: JSON.stringify(value) }), extras: () => ({ bindings: [], exportResolution: 720 }) });
    try {
      const ticket = coordinator.beginRestore(undefined, { ...identity, snapshot: JSON.stringify(expected) });
      coordinator.finishRestore(ticket);
      assert.equal(coordinator.getSnapshot().saveState, saved ? 'saved' : 'dirty', name);
    } finally { coordinator.close(); }
  }
});

test('the shipped scene owner returns its loaded cast, camera, workflow and workspace independently of outgoing React refs', async t => {
  const { projectFixture } = await import('./bus/project-fixture.mjs');
  const { createSceneDocument, createSceneStage } = await import('../src/scenes.js');
  const { createProjectDocument, readProjectDocument } = await import('../src/project.js');
  const { createShotAuthoringDocument } = await import('../src/shot-authoring.js');
  for (const retainLocalPose of [false, true]) {
    const f = projectFixture({ singleScene: true }), app = f.scope.appContext;
    try {
      if (retainLocalPose) f.scope.customPoses = [{ id: 'local-operator-pose', label: 'Retained local pose', bones: {} }];
      const scenesDocument = createSceneDocument('Incoming');
      scenesDocument.scenes[0].stage = createSceneStage({ characters: [{ id: 'incoming-a', subject: '甲', x: -1.2 }, { id: 'incoming-b', subject: '乙', x: 1.2 }], style: 'incoming style' });
      scenesDocument.scenes[0].shotDocument = createShotAuthoringDocument({ ...app.storeDomain('shot').authoringDocument(), frameCount: 150, shots: [] });
      const workflow = { version: 1, nodes: [{ id: 'incoming-node', type: 'Text', position: { x: 1, y: 2 }, data: { text: 'incoming workflow' } }], edges: [] };
      const opened = readProjectDocument(JSON.stringify(createProjectDocument({ name: 'Incoming', scenesDocument,
        workspaceLayout: { hierarchyWidth: 333 }, customPoses: [], workflow })));
      assert.equal(opened.ok, true);
      const outgoing = f.project.captureProjectSave().snapshot;
      const ticket = f.project.applyProject(opened.project, true);
      assert.equal(ticket.documentEpoch, f.project.projectSaveIdentity().documentEpoch);
      assert.equal(ticket.clock, f.project.projectSaveIdentity().clock);
      const expected = JSON.parse(ticket.snapshot), active = expected.scenes.scenes[0];
      assert.deepEqual(active.stage.characters.map(row => row.id), ['incoming-a', 'incoming-b']);
      assert.equal(active.stage.characters[0].subject, '甲'); assert.equal(active.shotDocument.frameCount, 150);
      assert.equal(expected.workspace.hierarchyWidth, 333); assert.deepEqual(expected.workflow, workflow);
      assert.notEqual(f.project.captureProjectSave().snapshot, ticket.snapshot, 'the immediate capture still contains outgoing projection refs');
      assert.notEqual(outgoing, ticket.snapshot);
      let projected = false;
      const completion = ticket.whenProjected().then(() => { projected = true; });
      f.project.refreshProjectDirty(); await Promise.resolve();
      assert.equal(projected, false, 'an after-render callback captured by the outgoing render cannot finish the new restoration');
      // Supply only App's later React publication; all document owners above
      // were the real shipped owners loaded by the real applyProject action.
      f.scope.actorStageRef.current = active.stage; f.scope.shotDocumentRef.current = active.shotDocument;
      f.scope.projectStateRef.current = { ...f.scope.projectStateRef.current, workspaceLayout: expected.workspace, customPoses: app.storeDomain('cast').state().customPoses };
      f.renderProject().refreshProjectDirty(); await completion;
      assert.equal(projected, true, 'the current App projection publishes the actual completion signal');
      assert.equal(f.project.projectProjection.listeners.size, 0, 'a completed projection releases its waiter');
      if (retainLocalPose) {
        assert.deepEqual(expected.poseLibrary, [], 'the incoming stored document does not own the unrelated local pose');
        assert.equal(JSON.parse(f.project.captureProjectSave().snapshot).poseLibrary[0].id, 'local-operator-pose');
        assert.notDeepEqual(JSON.parse(f.project.captureProjectSave().snapshot), expected, 'merging actual new library content remains an author change');
      } else assert.deepEqual(JSON.parse(f.project.captureProjectSave().snapshot), expected);
      const coordinator = createHostedSaveCoordinator({ session: { record: { rev: 2 }, client: { closed: false } }, active: () => true,
        identity: f.project.projectSaveIdentity, capture: () => f.project.captureProjectSave(), extras: () => ({ bindings: [], exportResolution: 720 }) });
      try { coordinator.finishRestore(coordinator.beginRestore(undefined, ticket)); assert.equal(coordinator.getSnapshot().saveState, retainLocalPose ? 'dirty' : 'saved'); }
      finally { coordinator.close(); }

      const aborted = f.project.applyProject(opened.project, true), controller = new AbortController();
      const cancelled = aborted.whenProjected(controller.signal);
      assert.equal(f.project.projectProjection.listeners.size, 1);
      controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
      assert.equal(f.project.projectProjection.listeners.size, 0, 'account/cleanup abort releases the native owner waiter');

      const replaced = f.project.applyProject(opened.project, true), stale = replaced.whenProjected();
      f.project.applyProject(opened.project, true);
      await assert.rejects(stale, error => error.code === 'document_changed');
      assert.equal(f.project.projectProjection.listeners.size, 0, 'a same-content epoch replacement retires the old waiter');

      const timed = f.project.applyProject(opened.project, true);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const pending = timed.whenProjected(); t.mock.timers.tick(30000);
        await assert.rejects(pending, error => error.code === 'restore_projection_timeout');
        assert.equal(f.project.projectProjection.listeners.size, 0, 'the bounded failure releases its native listener and never confirms projection');
      } finally { t.mock.timers.reset(); }
    } finally { f.dispose(); }
  }
});
