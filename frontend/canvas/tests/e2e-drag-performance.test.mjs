import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME} from './e2e-helpers.mjs';

async function setup(t) {
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{throw new Error('drag test must not call models');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const ctx=await browser.newContext({viewport:{width:1440,height:900}});
 await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await ctx.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__xp?.store?.project);return page;
}

test('拖动连续跟手、每帧合并输入、松手落网格、连线DOM保留及撤销恢复',async t=>{
 const page=await setup(t);
 const ids=await page.evaluate(()=>{
  const x=window.__xp;const a=x.store.addNode('text',80,100,{text:'drag source'});
  const b=x.store.addNode('text',620,180,{text:'drag target'});
  x.store.addEdge(a.id,'out',b.id,'prompt','text');x.board.snap.align=false;
  return[a.id,b.id];
 });
 const measured=await page.evaluate(async id=>{
  const x=window.__xp,head=document.querySelector(`[data-node="${id}"] .node-head`),r=head.getBoundingClientRect();
  const event=(type,dx)=>head.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:7,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:r.x+70+dx,clientY:r.y+16}));
  event('pointerdown',0);
  const svg=document.querySelector('#edges'),original=svg.querySelector('[data-edge]');
  let rebuilds=0,moves=0;const ob=new MutationObserver(ms=>{rebuilds+=ms.filter(m=>m.type==='childList').length;});ob.observe(svg,{childList:true,subtree:true});
  const off=x.store.onChange(reason=>{if(reason?.type==='move')moves++;});
  const positions=[];
  for(let dx=5;dx<=35;dx++){
   event('pointermove',dx);await new Promise(requestAnimationFrame);positions.push(x.store.node(id).x);
  }
  const beforeBurst=moves;
  for(let dx=36;dx<=115;dx++)event('pointermove',dx);
  await new Promise(requestAnimationFrame);const burstMoves=moves-beforeBurst;
  event('pointermove',119);event('pointerup',119);
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  ob.disconnect();off();
  const result={positions,burstMoves,rebuilds,edgeRetained:svg.querySelector('[data-edge]')===original,final:x.store.node(id).x};
  x.editor.undo();result.undo=x.store.node(id).x;x.editor.redo();result.redo=x.store.node(id).x;
  await x.store.flush();return result;
 },ids[0]);
 console.log('DRAG_MEASURE',JSON.stringify(measured));
 if(process.env.CANVAS_DRAG_BASELINE!=='1'){
  assert.deepEqual(measured.positions,Array.from({length:31},(_,i)=>85+i),'slow drag must not stick and jump by grid cells');
  assert.equal(measured.burstMoves,1,'high-frequency pointer input commits once per displayed frame');
  assert.equal(measured.edgeRetained,true,'moving preserves interactive edge elements');
  assert.equal(measured.rebuilds,0,'drag updates geometry without rebuilding SVG children');
 }
 assert.equal(measured.final,200,'last pending pointer movement is flushed and snapped on release');
 assert.equal(measured.undo,80);assert.equal(measured.redo,200);
 await page.reload();await page.waitForFunction(()=>window.__xp?.store?.project);
 assert.equal(await page.evaluate(id=>window.__xp.store.node(id).x,ids[0]),200);
});

test('真实鼠标多选拖动保留相对位置、接线端点正确，切项目后不串写',async t=>{
 const page=await setup(t);
 const ids=await page.evaluate(()=>{
  const x=window.__xp;
  const a=x.store.addNode('text',100,140,{text:'a'}),b=x.store.addNode('text',100,400,{text:'b'}),c=x.store.addNode('text',680,200,{text:'c'});
  x.store.addEdge(a.id,'out',c.id,'prompt','text');x.board.snap.grid=false;x.board.snap.align=false;x.board.selectMany([a.id,b.id]);return[a.id,b.id,c.id];
 });
 const head=page.locator(`[data-node="${ids[0]}"] .node-head`),r=await head.boundingBox();
 await page.mouse.move(r.x+100,r.y+14);await page.mouse.down();await page.mouse.move(r.x+221,r.y+61,{steps:20});await page.mouse.up();
 const result=await page.evaluate(([a,b])=>{
  const x=window.__xp,na=x.store.node(a),nb=x.store.node(b),p=x.board.portCenter(a,'out','out');
  const d=document.querySelector('[data-edge] path').getAttribute('d').match(/^M ([\d.-]+) ([\d.-]+)/);
  return{positions:[[na.x,na.y],[nb.x,nb.y]],start:[+d[1],+d[2]],port:p};
 },ids);
 assert.deepEqual(result.positions,[[221,187],[221,447]]);
 assert.ok(Math.abs(result.start[0]-result.port.x)<1&&Math.abs(result.start[1]-result.port.y)<1,'edge follows actual port');
 const switched=await page.evaluate(async id=>{
  const x=window.__xp,head=document.querySelector(`[data-node="${id}"] .node-head`),r=head.getBoundingClientRect();
  const opts={bubbles:true,pointerId:19,pointerType:'mouse',button:0,buttons:1,clientX:r.x+100,clientY:r.y+14};
  head.dispatchEvent(new PointerEvent('pointerdown',opts));head.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:opts.clientX+95}));
  await x.store.newProject('drag isolation');
  const fresh=x.store.addNode('text',19,23,{text:'unrelated'});
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  return{x:x.store.node(fresh.id).x,y:x.store.node(fresh.id).y,oldPresent:!!x.store.node(id)};
 },ids[0]);
 assert.deepEqual(switched,{x:19,y:23,oldPresent:false});
});
