import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,SHOTS} from './e2e-helpers.mjs';

test('大画布 50/100/200 节点：导航、端口、输入保留与项目隔离',async t=>{
 let calls=0;
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{calls++;throw new Error('mock only');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.__xp?.store?.project);
 for(const count of [50,100,200]){
  const metrics=await page.evaluate(async count=>{
   const x=window.__xp;await x.store.newProject(`large-${count}`);
   const nodes=Array.from({length:count},(_,i)=>({id:`large-${count}-${i}`,type:'text',x:(i%20)*400+80,y:Math.floor(i/20)*320+80,data:{title:`镜头 ${i+1}`,text:`分镜 ${i+1} 的原始剧本`,resultText:'',model:''}}));
   x.store.project.nodes=nodes;x.store.project.edges=[{id:'large-edge',from:{node:nodes[0].id,port:'out'},to:{node:nodes[1].id,port:'prompt'},order:0}];
   const start=performance.now();x.store.touch({type:'structure'});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
   const initialMs=performance.now()-start;
   const farHeight=x.board.measureNode(nodes.at(-1)).h;
   const bodyChildren=[...document.querySelectorAll('#nodes .node-body')].filter(e=>e.childElementCount).length;
   const frames=[];
   for(let i=0;i<12;i++){const at=performance.now();x.board.view.x-=60;x.board.applyView();await new Promise(requestAnimationFrame);frames.push(performance.now()-at);}
   x.board.focusNode(nodes.at(-1).id);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
   const el=document.querySelector(`[data-node="${nodes.at(-1).id}"]`),rect=el.getBoundingClientRect();
   return{count,initialMs:Math.round(initialMs),bodyChildren,frameP95:Math.round(frames.sort((a,b)=>a-b)[11]),farHeight,focusedHeight:x.board.measureNode(nodes.at(-1)).h,focused:{x:rect.x,y:rect.y,w:rect.width},ids:nodes.map(n=>n.id)};
  },count);
  console.log('LARGE_CANVAS',JSON.stringify({...metrics,ids:undefined}));
  assert.ok(metrics.focused.x+metrics.focused.w>0&&metrics.focused.x<1440,'distant node can be located');
  assert.ok(Math.abs(metrics.farHeight-metrics.focusedHeight)<=1,`never-visible node keeps real height: ${metrics.farHeight} -> ${metrics.focusedHeight}`);
  assert.equal(await page.locator(`[data-node="${metrics.ids.at(-1)}"] .node-body`).evaluate(e=>e.childElementCount>0),true,'focused node materializes');
  const result=await page.evaluate(async ids=>{
   const x=window.__xp;x.board.focusNode(ids[0]);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
   const before=x.store.node(ids[0]).data.text;
   const beforeHeight=x.board.measureNode(x.store.node(ids[1])).h;
   x.board.view.scale=.1;x.board.applyView();await new Promise(requestAnimationFrame);
   const overview=x.board.visStats?.(),afterHeight=x.board.measureNode(x.store.node(ids[1])).h;
   x.board.view.scale=1;x.board.focusNode(ids[0]);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
   const center=x.board.portCenter(ids[0],'out','out');
   const path=document.querySelector('#edges [data-edge="large-edge"] path')?.getAttribute('d')??'';
   return{same:x.store.node(ids[0]).data.text===before,count:x.store.project.nodes.length,edges:x.store.project.edges.length,center,path,overview,beforeHeight,afterHeight};
  },metrics.ids);
  assert.equal(result.same,true);assert.equal(result.count,count);assert.equal(result.edges,1);
  if(process.env.CANVAS_LARGE_BASELINE!=='1'){
   assert.ok(result.overview?.enabled&&result.overview.lite>=count-2,'large overview simplifies unselected cards');
   assert.ok(Math.abs(result.beforeHeight-result.afterHeight)<=1,'overview retains measured node geometry');
  }
  const match=result.path.match(/^M ([\d.-]+) ([\d.-]+)/);assert.ok(match);
  assert.ok(Math.abs(Number(match[1])-result.center.x)<1&&Math.abs(Number(match[2])-result.center.y)<1,'edge still uses real port after zoom');
 }
 if(process.env.CANVAS_LARGE_BASELINE!=='1')for(const theme of ['light','dark']){
  await page.locator(`[data-theme-option="${theme}"]`).click();
  await page.screenshot({path:join(SHOTS,`mochiani-large-${theme}.png`),animations:'disabled'});
 }
 assert.equal(calls,0);assert.deepEqual(errors,[]);
});
