import assert from 'node:assert/strict';
import { stageFixture } from './stage-fixture.mjs';
const f = stageFixture();
try {
  const receipt = f.binding.handlers.run_action(f.request('run_action', { action: 'stage.set', args: { keyLight: { intensity: 500 } } }));
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(f.stage.read().keyLight.intensity, 4);
  assert.equal(receipt.undo.entries, 1);
  assert.equal(f.stage.documentStore.depths().past, 1);
  const before = f.stage.read();
  assert.equal(f.run('stage.set', { keyLight: { intensity: 'bright' } }, 'agent').ok, false);
  assert.equal(f.stage.read(), before);
  assert.equal(f.run('stage.setStyle', { style: '' }, 'agent').ok, true, 'text can be cleared');
  console.log('PASS stage.set agent clamp, typed boundary, one receipt and clearable text');
} finally { f.dispose(); }
