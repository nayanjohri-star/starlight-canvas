import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationFixture, motionBytes } from './generation-fixture.mjs';

export const source = { kind: 'generate', beats: [{ text: 'Walk' }, { text: 'Stop' }], durationSeconds: 4, seed: 17 };
export const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
test('#444.3: agent generate_motion follows the editor root path and installs the real NPZ', async () => {
  const f = generationFixture(), originalFetch = globalThis.fetch, requests = [];
  try {
    const character = f.cast.read()[0];
    ok(f.run('cast.setLayer', { characterId: 'actor-a', layer: { waypoints: [{ id: 'destination', frame: 72, x: character.x, z: character.z + 3 }] } }));
    globalThis.fetch = async (url, options) => {
      if (url === '/ardy/generate') { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n'); }
      assert.equal(url, '/ardy/motions/123456-abcdef'); return new Response(motionBytes);
    };
    const tools = f.tools();
    await tools.find(row => row.name === 'inspect_studio').handler({ scope: 'motion', ids: ['actor-a'] });
    const tool = tools.find(row => row.name === 'generate_motion');
    const receipt = ok(await tool.handler({ characterId: 'actor-a', source }));
    assert.equal(receipt.status, 'completed');
    assert.equal(requests.length, 1); assert.equal(requests[0].waypoints.at(-1).frame, 72);
    assert.equal(requests[0].segments.length, 2); assert.equal(requests[0].seed, 17);
    assert.equal(f.motion.motionFor('actor-a').frames, 96);
    assert.equal(f.motion.layer('actor-a').takeRecipe.seed, 17);
    assert.equal(f.motion.documentStore.depths().past, 1);
  } finally { globalThis.fetch = originalFetch; f.dispose(); }
});
