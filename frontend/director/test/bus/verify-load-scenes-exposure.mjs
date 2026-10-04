import assert from 'node:assert/strict';
import { fixture, result } from './fixture.mjs';
const f = fixture();
let calls = 0;
f.patch({ scenes: [{ id: 'scene-a' }, { id: 'scene-b' }] });
f.registry.register({ id: 'load_scenes', label: 'Load scenes', description: 'Scene load fixture', kind: 'document', exposure: 'open',
  input: { type: 'object', properties: { document: { type: 'object', properties: {
    scenes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, minItems: 1 },
    activeSceneId: { type: 'string' },
  }, required: ['scenes', 'activeSceneId'], additionalProperties: false } }, required: ['document'], additionalProperties: false },
  available: () => true, run: () => { calls++; return result(); },
});
try {
  const same = { document: { scenes: [{ id: 'scene-b' }, { id: 'scene-a' }], activeSceneId: 'scene-b' } };
  assert.equal(f.bus.run('load_scenes', same, f.request('mcp')).ok, true, 'order and selected scene do not replace the id set');
  const different = { document: { scenes: [{ id: 'other-scene' }], activeSceneId: 'other-scene' } };
  assert.equal(f.bus.run('load_scenes', different, f.request('mcp')).code, 'CONFIRMATION_REQUIRED');
  assert.equal(calls, 1, 'refusal never reaches the load boundary');
  const token = f.bus.confirm('load_scenes', different);
  assert.equal(f.bus.run('load_scenes', different, f.request('mcp', { confirmationToken: token })).ok, true);
  assert.equal(f.bus.run('load_scenes', different, f.request('cli', { confirmationToken: token })).code, 'CONFIRMATION_REQUIRED');
  assert.equal(f.bus.run('load_scenes', different, f.request('ui')).ok, true);
  const added = { document: { scenes: [...f.state.scenes, { id: 'new-scene' }], activeSceneId: 'new-scene' } };
  assert.equal(f.bus.run('load_scenes', added, f.request('agent')).code, 'CONFIRMATION_REQUIRED', 'any different id set is replacement on the bus');
  console.log('PASS #480.3f load_scenes confirms changed id sets only, with one-use UI tokens');
} finally { f.bus.dispose(); }
