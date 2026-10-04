import assert from 'node:assert/strict';
import { STUDIO_ELEMENTS } from '../../src/studio-elements.js';
import { stageFixture } from './stage-fixture.mjs';
const values = { 'keyLight.x': -8, 'keyLight.y': 14, 'keyLight.z': -5, 'keyLight.intensity': 500, 'keyLight.warmth': .8,
  environmentImage: 'data:image/png;base64,QQ==', environment: 'A rooftop', style: 'Watercolour', hasEnvSheet: true,
  camera: '9:16', cameraPresetId: 'wide', sensorId: 'super35' };
function stable(receipt) {
  const { commandId, receiptId, undo, ...rest } = receipt;
  return { ...rest, undo: undo && { entries: undo.entries, canUndoDirect: undo.canUndoDirect } };
}
for (const element of STUDIO_ELEMENTS.filter(row => row.path.startsWith('stage.'))) {
  const a = stageFixture(), b = stageFixture();
  try {
    const key = element.path.slice(6), value = values[key];
    assert.notEqual(value, undefined, `fixture value for ${element.path}`);
    const names = (element.documentPath ?? key).split('.');
    const args = names.reduceRight((value, name) => ({ [name]: value }), value);
    const direct = a.run('stage.set', args, 'agent');
    const alias = b.binding.handlers.patch_elements(b.request('patch_elements', { ops: [{ target: { kind: 'stage' }, set: { [key]: value } }] }));
    assert.equal(direct.ok, true, JSON.stringify(direct));
    assert.deepEqual(stable(alias), stable(direct), `${element.path} shares the stage.set receipt`);
    assert.deepEqual(a.stage.read(), b.stage.read(), `${element.path} shares the stage.set poststate`);
  } finally { a.dispose(); b.dispose(); }
}
const f = stageFixture();
try {
  assert.equal(f.run('stage.setFilmback', { cameraPresetId: 'wide', sensorId: 'super35', shotAspect: '4:3' }).ok, true);
  assert.equal(f.run('stage.setFilmback', { cameraPresetId: null }).ok, true);
  assert.equal(f.stage.read().cameraPresetId, null);
  const before = f.stage.read();
  const refused = f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [
    { target: { kind: 'stage' }, set: { style: 'Must not land' } },
    { target: { kind: 'stage' }, set: { unknown: 1 } },
  ] }));
  assert.equal(refused.ok, false);
  assert.equal(f.stage.read(), before, 'a bad batch is atomic');
  console.log('PASS every stage path aliases stage.set state and receipts; complete filmback and atomic refusal');
} finally { f.dispose(); }
