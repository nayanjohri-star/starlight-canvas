import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, CHROME, MODELS_11, realPng, SHOTS } from './e2e-helpers.mjs';
import { startHostedTopology, syntheticNewApi, signIn } from './hosted-topology.mjs';

test('4K image waits beyond edge deadline and survives refresh: one paid POST, authenticated GET recovery', {timeout:200000}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'canvas-image-e2e-'));
  const api=syntheticNewApi({models:[...MODELS_11,'gpt-image-2.5-flare']});
  const handler=api.handler; let posts=0, startedAt=0;
  api.handler=async(req,res)=>{
    if(req.method==='POST' && req.url==='/v1/images/generations') {
      posts++; startedAt=Date.now(); await new Promise(r=>setTimeout(r,130000));
    }
    return handler(req,res);
  };
  const topo=await startHostedTopology({newApi:api,imageJobsDir:directory});
  const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--disable-gpu']});
  t.after(async()=>{await browser.close();await topo.close();await rm(directory,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:1440,height:900}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===topo.origin?route.continue():route.abort());
  await page.goto(topo.origin+'/canvas/'); await signIn(page,'sk-synth-alice');
  api.setImage(await realPng(page,3840,2160));
  const accepted=page.waitForResponse(r=>r.url().endsWith('/v1/images/generations')&&r.status()===202);
  const nodeId=await page.evaluate(async()=>{
    const x=window.__xp;await x.store.newProject('图片断线恢复验收');
    const n=x.store.addNode('image',0,0,{model:'gpt-image-2.5-flare',prompt:'测试风景',resolution:'4K',ratio:'16:9'});
    await x.store.flush();void x.generators.generate(n).catch(()=>{});return n.id;
  });
  await accepted; assert.ok(Date.now()-startedAt<5000,'acceptance must not wait for generation');
  await page.reload(); await page.waitForFunction(()=>window.__xp?.generators);
  await page.waitForFunction(id=>window.__xp.store.node(id)?.data?.operation?.state==='completed',nodeId,{timeout:160000});
  const result=await page.evaluate(id=>{
    const x=window.__xp,n=x.store.node(id);return {op:n.data.operation,asset:x.store.project.assets[n.data.resultAssetId]};
  },nodeId);
  assert.ok(result.asset);assert.equal(result.op.imageJob,true);assert.ok(Date.now()-startedAt>=130000);
  assert.equal(posts,1);assert.equal(api.state.images.length,1);assert.deepEqual(errors,[]);
  await page.screenshot({path:join(SHOTS,'image-job-recovery-4k.png')});
});
