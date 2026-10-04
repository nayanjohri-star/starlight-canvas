import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationFixture } from './generation-fixture.mjs';
import { seedMotion } from './motion-fixture.mjs';
import { installGenerated, prepareGeneration } from './install-generated-motion.mjs';

for (const priorTake of [false, true]) test(`motion generation receipt retains the actual composed history ID (${priorTake ? 'replacement' : 'first take'})`, async () => {
  const f = generationFixture();
  try {
    f.scope.shotsDomain.load({ ...f.scope.shotsDomain.state(), camera: f.actual.readStudioCamera() });
    if (priorTake) f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    prepareGeneration(f);
    const beforeShots = structuredClone(f.scope.shotsDomain.state()), beforeMotion = f.snapshot(), beforeCast = structuredClone(f.cast.read());
    const receipt = await installGenerated(f);
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
    assert.equal(receipt.undo.entries, 1);
    // A made-up binding history UUID would fail retention and receipt Undo.
    assert.equal(f.ports.isRetained(receipt), true);
    assert.equal(f.ports.canUndo(receipt), true);
    const undo = f.binding.bus.run('edit.undo', { receiptId: receipt.receiptId });
    assert.equal(undo.status, 'undone', JSON.stringify(undo));
    assert.deepEqual(f.scope.shotsDomain.state(), beforeShots);
    assert.deepEqual(f.snapshot(), beforeMotion); assert.deepEqual(f.cast.read(), beforeCast);
  } finally { f.dispose(); }
});
