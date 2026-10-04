import assert from 'node:assert/strict';
import { projectFixture, ok } from './project-fixture.mjs';
import { createSceneStage } from '../../src/scenes.js';
import { createShotAuthoringDocument } from '../../src/shot-authoring.js';

for (const concurrent of [false, true]) {
  const f = projectFixture();
  try {
    ok(await f.run('project.new', { name: 'Fresh checkpoint' }));
    // These are the persisted envelopes App publishes at the next React
    // commit; the project command must not checkpoint the outgoing refs.
    f.scope.shotDocumentRef.current = createShotAuthoringDocument({ shots: f.live.current.shots, waypoints: [], frameCount: 360 });
    f.scope.actorStageRef.current = createSceneStage(f.project.read()[0].stage);
    if (concurrent) ok(await f.run('stage.setStyle', { style: 'Authored before the load render' }));
    // Mount the current useScenes render before publishing its after-render
    // boundary; the outgoing render must not acknowledge the loaded document.
    f.renderProject().refreshProjectDirty();
    assert.equal(f.project.dirtyStore.read('projectDirty'), concurrent, 'only authored edits after the load make the project dirty');
    if (!concurrent) {
      ok(await f.run('scene.rename', { sceneId: f.project.read()[0].id, name: 'Changed after load' }));
      f.renderProject().refreshProjectDirty();
      assert.equal(f.project.dirtyStore.read('projectDirty'), true);
    }
    console.log(`PASS project checkpoint follows persisted render envelopes; concurrent authored edit=${concurrent}`);
  } finally { f.dispose(); }
}
