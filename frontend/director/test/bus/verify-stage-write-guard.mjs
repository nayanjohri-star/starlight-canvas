import assert from 'node:assert/strict';
import { stageFixture } from './stage-fixture.mjs';
const f = stageFixture();
try {
  const before = f.stage.read();
  assert.throws(() => f.stage.setKeyLight({ intensity: 2 }), /bus run/);
  assert.equal(f.stage.read(), before);
  assert.throws(() => f.stage.documentStore.write('stage', { ...before, style: 'Bypass' }), /bus run/);
  const result = f.run('stage.setKeyLight', { keyLight: { intensity: 2 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.stage.read().keyLight.intensity, 2);
  f.stage.load({ environment: 'Loaded outside a run' });
  assert.equal(f.stage.read().environment, 'Loaded outside a run');
  assert.equal(f.stage.documentStore.depths().past, 0);
  console.log('PASS dev stage setter/write guard, bus mutation, and explicit non-authored load');
} finally { f.dispose(); }
