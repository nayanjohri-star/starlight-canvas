import assert from 'node:assert/strict';
import { stageFixture } from './stage-fixture.mjs';

const origins = ['ui', 'agent', 'mcp', 'cli'];
const commands = ['stage.set', 'stage.setKeyLight', 'stage.setEnvironment', 'stage.setStyle', 'stage.setFilmback'];
for (const command of commands) for (const origin of origins) {
  const args = value => command === 'stage.setKeyLight' ? { keyLight: { x: value % 30 } }
    : command === 'stage.setFilmback' ? { cameraPresetId: `preset-${value}` }
      : { [command === 'stage.setStyle' ? 'style' : 'environment']: `Parity ${value}` };
  const f = stageFixture();
  try {
    const before = structuredClone(f.actual.readStudioState().stage);
    const receipt = f.run(command, args(1), origin);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(f.stage.documentStore.owns('stage'), true, 'the actual stage hook owns the store slice');
    assert.equal(receipt.revision.after, receipt.revision.before + 1);
    assert.deepEqual(receipt.affectedIds, [f.host().sceneId]);
    assert.ok(receipt.undo.historyEntryId);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }, origin).status, 'undone');
    assert.deepEqual(f.actual.readStudioState().stage, before);
    const first = f.run(command, args(2), origin);
    for (let i = 0; i < 51; i++) assert.equal(f.run(command, args(i + 3), origin).ok, true);
    assert.equal(f.run('edit.undo', { receiptId: first.receiptId }, origin).code, 'UNDO_EXPIRED');
    const saved = structuredClone(f.actual.readStudioState().stage);
    const tx = f.run('run.begin', { id: command, args: {} }, origin);
    assert.equal(f.run('run.update', { txId: tx.txId, args: args(70) }, origin).ok, true);
    assert.equal(f.run('run.cancel', { txId: tx.txId }, origin).ok, true);
    assert.deepEqual(f.actual.readStudioState().stage, saved);
    const revision = f.binding.refresh().revision;
    f.run(command, args(71));
    const stale = f.run(command, args(72), origin, { expectedRevision: revision });
    if (origin !== 'ui') assert.equal(stale.code, 'STALE_SCENE');
    else assert.equal(stale.ok, true, 'trusted UI runs on current state rather than an external admission revision');
    // UI has no external admission revision: job publication still has a
    // domain revision fence. Resolve preparation explicitly, never by sleep.
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    f.registry.register({ id: 'fixture.stageJob', label: 'Stage job', description: 'Stage job', kind: 'job', domain: 'stage',
      input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
      run: async (_args, context) => { await ready; context.commit(() => f.stage.setKeyLight({ intensity: 2 })); return { affectedIds: [f.host().sceneId], summary: 'Prepared stage' }; } });
    const job = f.run('fixture.stageJob', {}, origin);
    f.run(command, args(73));
    release();
    assert.equal((await job).code, 'STALE_TARGET');
    console.log(`PASS real stage parity ${command} ${origin}: receipt, undo, UNDO_EXPIRED, tx cancel, stale revision policy, concurrent job`);
  } finally { f.dispose(); }
}
