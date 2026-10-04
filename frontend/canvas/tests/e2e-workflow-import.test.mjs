import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,SHOTS,openCanvasDock} from './e2e-helpers.mjs';

test('工作流面板导入：原画布保留、节点连线恢复、取消与非法文件不修改项目，不自动生成',async t=>{
 let upstreamCalls=0;
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{upstreamCalls++;throw new Error('禁止真实上游');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const ctx=await browser.newContext({viewport:{width:1440,height:900}});
 await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.__xp?.store?.project);
 const original=await page.evaluate(async()=>{
  const s=window.__xp.store;s.project.name='保留原画布';
  const a=s.addNode('text',90,100,{text:'原提示词'}),b=s.addNode('gen',560,100,{directOutput:false,draft:{model:'wan-3.0',seconds:5}});
  s.addEdge(a.id,'out',b.id,'prompt','text');
  const doc=JSON.parse(await s.exportJSON());doc.project.name='导入工作流样例';
  return{id:s.project.id,file:JSON.stringify(doc)};
 });
 await openCanvasDock(page,'run');
 const button=page.getByRole('button',{name:'导入工作流',exact:true});
 assert.equal(await button.isVisible(),true);
 async function choose(files){const pick=page.waitForEvent('filechooser');await button.click();await (await pick).setFiles(files);}
 await choose([]);assert.equal(await page.evaluate(()=>window.__xp.store.project.id),original.id);
 await choose({name:'foreign.json',mimeType:'application/json',buffer:Buffer.from('{"nodes":[]}')});
 await page.getByText('导入失败：不是有效的画布导出文件（需 format=xingpan-canvas@2）',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__xp.store.project.id),original.id);
 await choose({name:'example.canvas.json',mimeType:'application/json',buffer:Buffer.from(original.file)});
 await page.waitForFunction(()=>window.__xp.store.project.name==='导入工作流样例（导入）');
 const imported=await page.evaluate(async()=>({id:window.__xp.store.project.id,nodes:window.__xp.store.project.nodes,edges:window.__xp.store.project.edges,projects:await window.__xp.store.listProjects()}));
 assert.notEqual(imported.id,original.id);assert.equal(imported.nodes.length,2);assert.equal(imported.edges.length,1);
 assert.equal(imported.nodes.find(n=>n.type==='gen').data.directOutput,false);
 assert.ok(imported.projects.some(p=>p.id===original.id&&p.name==='保留原画布'));
 for(const theme of ['light','dark']){
  await openCanvasDock(page,'run');await page.locator(`[data-theme-option="${theme}"]`).click();
  await page.locator('#sidebar').screenshot({path:join(SHOTS,`workflow-import-${theme}.png`),animations:'disabled'});
 }
 await page.reload();await page.waitForFunction(()=>window.__xp?.store?.project?.name==='导入工作流样例（导入）');
 await page.locator('#project-list').selectOption(original.id);
 await page.waitForFunction(id=>window.__xp.store.project.id===id,original.id);
 assert.equal(await page.evaluate(()=>window.__xp.store.project.nodes.find(n=>n.type==='text').data.text),'原提示词');
 assert.equal(await page.evaluate(()=>window.__xp.store.project.edges.length),1);
 assert.equal(upstreamCalls,0);assert.deepEqual(errors,[]);
});
