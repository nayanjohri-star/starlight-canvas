import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,SHOTS,realPng} from './e2e-helpers.mjs';

test('素材复用：多分镜关联、同名隔离、预览后外部变更、撤销与项目隔离',async t=>{
 let calls=0;
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{calls++;throw new Error('mock only');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const ctx=await browser.newContext({viewport:{width:1440,height:900}});await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.__xp?.library);
 const png=await realPng(page);
 const ids=await page.evaluate(async bytes=>{
  const x=window.__xp,blob=new Blob([new Uint8Array(bytes)],{type:'image/png'});
  const a=await x.assets.registerBlob(blob,'同名角色.png','image'),b=await x.assets.registerBlob(blob,'同名角色.png','image');
  const s1=x.storyboards.addShot({title:'雨夜相遇'}),s2=x.storyboards.addShot({title:'桥边告别'});
  return{a:a.id,b:b.id,s1:s1.id,s2:s2.id};
 },png);
 await page.evaluate(()=>window.__xp.library.open());await page.locator('.lib-head-actions').getByRole('button',{name:'复用到分镜',exact:true}).click();
 const assets=page.locator('[data-ar="assets"] input[type="checkbox"]'),shots=page.locator('[data-ar="shots"] input[type="checkbox"]');
 await page.locator(`[data-ar-asset="${ids.a}"] input`).check();await page.locator(`[data-ar-asset="${ids.b}"] input`).check();await shots.nth(0).check();await shots.nth(1).check();
 assert.equal(await page.locator('.ar-preview').getByText('null',{exact:true}).count(),0);
 for(const width of [1280,1440,1920])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.locator('.ar').screenshot({path:join(SHOTS,`mochiani-assets-${width}-${theme}.png`),animations:'disabled'});
  const overflow=await page.locator('.ar').evaluate(e=>e.scrollWidth>e.clientWidth+2);assert.equal(overflow,false);
 }
 await page.getByRole('button',{name:'关联到分镜',exact:true}).click();
 const refs=await page.evaluate(ids=>[window.__xp.storyboards.find(ids.s1).assetIds,window.__xp.storyboards.find(ids.s2).assetIds],ids);
 assert.deepEqual(refs,[[ids.a,ids.b],[ids.a,ids.b]]);
 await page.keyboard.press('Escape');await page.evaluate(()=>window.__xp.editor.undo());
 assert.deepEqual(await page.evaluate(ids=>[window.__xp.storyboards.find(ids.s1).assetIds,window.__xp.storyboards.find(ids.s2).assetIds],ids),[[],[]]);
 await page.evaluate(()=>window.__xp.library.open());await page.locator('.lib-head-actions').getByRole('button',{name:'复用到分镜',exact:true}).click();
 await page.locator(`[data-ar-asset="${ids.a}"] input`).check();await shots.nth(0).check();
 await page.evaluate(ids=>window.__xp.storyboards.updateShot(ids.s1,{assetIds:[ids.b]}),ids);
 await page.getByRole('button',{name:'关联到分镜',exact:true}).click();
 await page.getByText(/未写入：.*预览后已变更/).waitFor();
 assert.deepEqual(await page.evaluate(ids=>window.__xp.storyboards.find(ids.s1).assetIds,ids),[ids.b]);
 await page.evaluate(()=>window.__xp.store.newProject('无关新项目'));
 const apply=page.getByRole('button',{name:'关联到分镜',exact:true});if(await apply.isVisible())await apply.click();
 assert.equal(await page.evaluate(()=>window.__xp.storyboards.list().length),0);
 assert.equal(calls,0);assert.deepEqual(errors,[]);
});
