import assert from 'node:assert/strict';
import { fixture, result, sample } from './fixture.mjs';
import { STUDIO_ACTIONS, studioActionRefusal } from '../../src/studio-actions.js';
for (const declaration of STUDIO_ACTIONS) {
  const f = fixture();
  const text = `Refusal from ${declaration.id}`;
  f.register(declaration.id, () => { f.toast(text, '한국어 알림'); });
  const args = sample(declaration.input);
  const confirmationToken = f.bus.confirm(declaration.id, args);
  const r = await f.bus.run(declaration.id, args, f.request('agent', { confirmationToken }));
  assert.equal(r.ok, false, declaration.id);
  assert.equal(r.code, 'TARGET_NOT_READY', declaration.id);
  assert.equal(r.message, text, declaration.id);
}
const f = fixture();
f.register('shot.create', () => { f.edit(1); f.toast('An English warning.', '한국어 경고'); return result(); });
const warning = await f.bus.run('shot.create', {}, f.request());
assert.equal(warning.ok, true);
assert.deepEqual(warning.warnings, [{ code: 'STUDIO_TOAST', message: 'An English warning.' }]);
f.register('shot.remove', () => { f.toast('Generic text.'); throw studioActionRefusal('INVALID_RANGE', 'Specific refusal.', '범위 오류'); });
assert.equal((await f.bus.run('shot.remove', { shotId: 'target' }, f.request())).message, 'Specific refusal.');
const shown = [];
f.ports.showRefusal = text => shown.push(text);
assert.equal((await f.bus.run('shot.remove', { shotId: 'target' }, f.request('ui'))).code, 'INVALID_RANGE');
assert.deepEqual(shown, ['범위 오류']);
console.log(`PASS bus acceptance 2: English toast refusals for all ${STUDIO_ACTIONS.length} actions, warnings and explicit precedence`);
