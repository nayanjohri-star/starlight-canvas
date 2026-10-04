import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageAssets } from '../../../deploy/canvas-web/stage-assets.mjs';

test('rollout and rollback retain both module graphs; conflicts and corrupt packages cannot overwrite them', async t => {
  const root = await mkdtemp(join(tmpdir(),'canvas-rollout-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store = join(root,'assets');
  async function fixture(name, id, source) {
    const release = join(root,name), assetPath=`releases/${id.repeat(64)}/`;
    const files = {'release.json':JSON.stringify({verified:true}), 'site/canvas/build.json':JSON.stringify({assetPath}),
      [`site/canvas/${assetPath}main.js`]:source};
    for (const [rel,data] of Object.entries(files)) { await mkdir(join(release,rel,'..'),{recursive:true}); await writeFile(join(release,rel),data); }
    await writeFile(join(release,'SHA256SUMS'),Object.entries(files).map(([rel,data])=>`${createHash('sha256').update(data).digest('hex')}  ${rel}`).join('\n'));
    return release;
  }
  const old = await fixture('old','a','old graph'), next = await fixture('new','b','new graph');
  await stageAssets(old,store); await stageAssets(next,store); await stageAssets(old,store);
  assert.equal(await readFile(join(store,'a'.repeat(64),'main.js'),'utf8'),'old graph');
  assert.equal(await readFile(join(store,'b'.repeat(64),'main.js'),'utf8'),'new graph');
  const conflict=await fixture('conflict','a','different graph');
  await assert.rejects(stageAssets(conflict,store),/collision/);
  await writeFile(join(next,'site/canvas/releases','b'.repeat(64),'main.js'),'corrupt');
  await assert.rejects(stageAssets(next,store),/checksum mismatch/);
  assert.equal(await readFile(join(store,'a'.repeat(64),'main.js'),'utf8'),'old graph');
});
