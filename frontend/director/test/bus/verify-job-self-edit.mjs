import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, deferred, result } from './fixture.mjs';

for (const edit of ['none', 'before', 'between', 'during', 'unrelated', 'owned-async']) {
  test(`shared core: nested job edits retain their fence (${edit})`, async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    let published = false;
    const external = () => { f.edit(7, 'motion'); f.patch({ tokens: { target: 'external' } }); };
    f.register('character.clearIkKeys', () => {
      f.edit(2, 'motion'); f.patch({ tokens: { target: 'own-edit' } }); return result();
    });
    f.register('ai.prepareShot', async (_args, context) => {
      entered.resolve(); await release.promise;
      if (edit === 'owned-async') context.commit(() => f.edit(3, 'motion'));
      return result([]);
    });
    f.registry.register({ id: 'fixture.generate', label: 'Generate', description: 'Job with preparation', kind: 'job', domain: 'motion', target: () => 'target',
      input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
      async run(_args, context) {
        if (edit === 'before') { entered.resolve(); await release.promise; }
        await context.run('character.clearIkKeys', { characterId: 'target' });
        if (['during', 'owned-async'].includes(edit)) await context.run('ai.prepareShot');
        else if (edit !== 'before') { entered.resolve(); await release.promise; }
        if (edit === 'between') await context.run('character.clearIkKeys', { characterId: 'target' });
        context.commit(() => { published = true; f.edit(10, 'motion'); });
        return result();
      },
    });
    try {
      const running = f.bus.run('fixture.generate', {}, f.request());
      // Both signals are subscribed before the job can resume. No timing races.
      await entered.promise;
      if (edit === 'unrelated') f.edit(7, 'objects');
      else if (!['none', 'owned-async'].includes(edit)) external();
      release.resolve();
      const receipt = await running;
      if (['none', 'unrelated', 'owned-async'].includes(edit)) {
        assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
        assert.equal(published, true); assert.ok(receipt.undo.historyEntryId);
      } else {
        assert.equal(receipt.code, 'STALE_TARGET', JSON.stringify(receipt));
        assert.equal(published, false); assert.equal(f.state.value, 7);
      }
    } finally { release.resolve(); f.bus.dispose(); }
  });
}
