import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,WAV} from './e2e-helpers.mjs';

async function setup(t){
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{throw new Error('禁止真实上游');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const context=await browser.newContext();await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__xp);return page;
}

test('独立浏览器复审：删除时间线音轨后立即停止旧音频并释放媒体元素',async t=>{
 const page=await setup(t);const result=await page.evaluate(async bytes=>{
  const {createTimelineEngine}=await import('/media-worker.js');const blob=new Blob([new Uint8Array(bytes)],{type:'audio/wav'});
  const engine=createTimelineEngine({blobOf:async()=>blob}),clip={id:'removed',kind:'audio',assetId:'a',track:'a1',start:0,end:2,sourceDuration:2,trimIn:0,speed:1,volume:1};
  await engine.load([clip]);engine.sync(0.1,[clip],true);const element=engine.mediaOf(clip.id).el;
  await engine.load([]);engine.sync(0.2,[],true);const out={removed:!engine.mediaOf(clip.id),paused:element.paused};engine.dispose();return out;
 },WAV);
 assert.equal(result.removed,true,'删除的片段必须从播放引擎移除');assert.equal(result.paused,true,'旧片段不能在背景继续播放');
});

test('独立浏览器复审：关闭剪辑器后，迟到的文件读取不得重新创建媒体URL',async t=>{
 const page=await setup(t);const result=await page.evaluate(async()=>{
  const {createTimelineEngine}=await import('/media-worker.js');const c=document.createElement('canvas');c.width=c.height=2;const blob=await new Promise(r=>c.toBlob(r));
  let resolveBlob;const delayed=new Promise(r=>resolveBlob=r);const engine=createTimelineEngine({blobOf:()=>delayed});
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;let made=0,freed=0;
  URL.createObjectURL=(...args)=>{made++;return create(...args);};URL.revokeObjectURL=(...args)=>{freed++;return revoke(...args);};
  try{const pending=engine.load([{id:'late',kind:'image',assetId:'a',track:'v1',start:0,end:1}]);engine.dispose();resolveBlob(blob);await pending;return{made,freed,empty:!engine.mediaOf('late')};}
  finally{URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
 });
 assert.equal(result.made-result.freed,0,'dispose后的迟到结果不得泄漏ObjectURL');assert.equal(result.empty,true);
});
