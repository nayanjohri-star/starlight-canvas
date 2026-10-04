import assert from 'node:assert/strict';
import { motionBytes } from './generation-fixture.mjs';

// Shared generation prepares authored prompt blocks before its take job. These
// composition cases start with that prompt intent already authored, so Undo is
// judged against the pre-publication state (not the old candidate's schedule).
export function prepareGeneration(f) {
  const receipt = f.run('cast.setLayer', { characterId: 'actor-a', layer: { promptClips: [{ id: 'generation-block-0', text: 'Stand', startFrame: 0, endFrame: 96 }] } });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
}

// Only the network boundary is replaced; the real generation job builds the
// request, decodes NPZ, publishes all owners and returns its retained receipt.
export async function installGenerated(f) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (url === '/ardy/generate') return new Response(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n');
    assert.equal(url, '/ardy/motions/123456-abcdef'); return new Response(motionBytes);
  };
  try {
    const invoke = f.tools().internal.invoke;
    await invoke('inspect_studio', { scope: 'motion', ids: ['actor-a'] });
    return await invoke('generate_motion', { characterId: 'actor-a', source: { kind: 'generate', beats: [{ text: 'Stand' }], durationSeconds: 4, seed: 17 } });
  }
  finally { globalThis.fetch = original; }
}
