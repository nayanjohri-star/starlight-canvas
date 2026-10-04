import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,makeState,mockUpstream,realPng} from './e2e-helpers.mjs';

test('独立素材编辑：文字层导出可用，导出期间切项目不污染新项目',{timeout:45000},async t=>{
 const state=makeState(),server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:mockUpstream(state)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--disable-gpu']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const context=await browser.newContext({viewport:{width:1440,height:900}});await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.__xp?.library);const png=await realPng(page);
 const aid=await page.evaluate(async bytes=>{const x=window.__xp;await x.store.newProject('图片编辑验收');const a=await x.assets.registerBlob(new Blob([new Uint8Array(bytes)],{type:'image/png'}),'source.png','image');x.library.open();return a.id;},png);
 await page.locator(`[data-asset="${aid}"]`).getByRole('button',{name:'编辑',exact:true}).click();
 await page.getByPlaceholder('文字内容').fill('星盘');await page.getByRole('button',{name:'添加文字层',exact:true}).click();await page.getByRole('button',{name:'导出为新素材',exact:true}).click();
 await page.waitForFunction(()=>Object.keys(window.__xp.store.project.assets).length===2);
 assert.equal(await page.evaluate(async()=>{const x=window.__xp,a=Object.values(x.store.project.assets).find(a=>a.name.includes('-编辑'));const b=await x.assets.blobOf(a.id);const bitmap=await createImageBitmap(b);const ok=bitmap.width===96&&bitmap.height===54;bitmap.close();return ok;}),true);
 await page.locator(`[data-asset="${aid}"]`).getByRole('button',{name:'编辑',exact:true}).click();
 await page.evaluate(()=>{const native=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(cb,...args){native.call(this,b=>{window.__releaseEditedImage=()=>{HTMLCanvasElement.prototype.toBlob=native;cb(b);};},...args);};});
 await page.getByRole('button',{name:'导出为新素材',exact:true}).click();await page.waitForFunction(()=>typeof window.__releaseEditedImage==='function');
 await page.evaluate(async()=>{await window.__xp.store.newProject('新项目');window.__releaseEditedImage();});
 await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>Object.keys(window.__xp.store.project.assets).length),0);assert.equal(state.creates.length,0);assert.deepEqual(errors,[]);
});
