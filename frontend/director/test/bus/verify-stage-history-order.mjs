import assert from 'node:assert/strict';
import { stageFixture } from './stage-fixture.mjs';
import { createSceneObject } from '../../src/scene-objects.js';
for (const native of ['cast', 'objects']) {
  const f = stageFixture();
  try {
    if (native === 'cast') assert.equal(f.run('character.addWaypoint', { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } }).ok, true);
    else f.actual.commitStudioDraft({ domain: 'objects', draft: [createSceneObject('cube', [])] });
    const original = f.stage.read().style;
    const receipt = f.run('stage.setStyle', { style: 'After native edit' });
    assert.equal(receipt.ok, true);
    f.actual.undoScene();
    assert.equal(f.stage.read().style, original);
    f.actual.undoScene();
    f.actual.redoScene();
    assert.equal(f.stage.read().style, original, 'redo restores the older native edit first');
    f.actual.redoScene();
    assert.equal(f.stage.read().style, 'After native edit', `${native} redo preserves the stage history boundary`);
    console.log(`PASS native ${native} and owned stage undo/redo ordering`);
  } finally { f.dispose(); }
}
