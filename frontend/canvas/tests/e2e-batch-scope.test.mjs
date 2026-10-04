import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,SHOTS,openCanvasDock} from './e2e-helpers.mjs';

test('工作流分组范围与保留结果：真实面板选择、预检、确认运行均不越界',async t=>{
 let calls=0;
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{calls++;throw new Error('mock only');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.__xp?.workflow);
 const ids=await page.evaluate(()=>{
  const x=window.__xp,a=x.store.addNode('text',60,80,{text:'第一组内容'}),b=x.store.addNode('text',460,80,{text:'第二组内容'});
  x.store.project.studio.groups=[{id:'g1',title:'第一集',members:[a.id]},{id:'g2',title:'第二集',members:[b.id]}];x.store.touch({type:'structure'});
  return[a.id,b.id];
 });
 await openCanvasDock(page,'run');
 await page.getByRole('combobox',{name:'工作流运行范围'}).locator('option[value="group:g1"]').waitFor({state:'attached'});
 await page.getByRole('combobox',{name:'工作流运行范围'}).selectOption('group:g1');
 assert.equal(await page.getByRole('checkbox',{name:'仅补齐空白节点'}).isChecked(),true);
 await page.getByPlaceholder('预算上限 ¥',{exact:true}).fill('0');
 await page.getByRole('button',{name:'提交运行',exact:true}).click();
 await page.getByRole('button',{name:'确认',exact:true}).click();
 await page.waitForFunction(()=>window.__xp.workflow.getState().status==='done');
 const first=await page.evaluate(([a,b])=>({a:window.__xp.store.node(a).data.resultText,b:window.__xp.store.node(b).data.resultText,run:window.__xp.workflow.getState()}),ids);
 assert.equal(first.a,'第一组内容');assert.ok(!first.b);assert.deepEqual(first.run.targets,[ids[0]]);
 assert.equal(first.run.budgetYuan,0,'explicit zero budget must not become unlimited');
 await page.getByRole('combobox',{name:'工作流运行范围'}).selectOption('all');
 await page.getByRole('button',{name:'预检',exact:true}).click();
 await page.getByText('工作流预检',{exact:true}).waitFor();await page.keyboard.press('Escape');
 for(const theme of ['light','dark']){
  await page.locator(`[data-theme-option="${theme}"]`).click();
  await page.locator('#sidebar').screenshot({path:join(SHOTS,`mochiani-workflow-${theme}.png`),animations:'disabled'});
 }
 await page.evaluate(async()=>{const x=window.__xp;await x.store.importJSON(await x.store.exportJSON());});
 await page.getByRole('button',{name:'继续',exact:true}).click();
 await page.getByText('导入的仅补空白工作流需重新预检并提交运行，不支持直接续跑旧记录',{exact:true}).waitFor();
 const reused=await page.evaluate(async()=>{
  const x=window.__xp;await x.store.newProject('真实存储素材复用');
  const media=await x.assets.registerBlob(new Blob(['nonempty mock bytes'],{type:'image/png'}),'mock-result.png','image');
  const n=x.store.addNode('image',100,100,{model:'mock-image',resultAssetId:media.id,operation:{state:'completed'}});
  const pre=await x.workflow.preview({targets:[n.id],onlyEmpty:true});
  await x.workflow.start({targets:[n.id],onlyEmpty:true,confirmed:true});
  return{reused:pre.reusedIds.includes(n.id),status:x.workflow.getState().status,cost:x.workflow.getState().estimatedSpendYuan};
 });
 assert.deepEqual(reused,{reused:true,status:'done',cost:0},'真实素材 API 和 IndexedDB 中的已有产出可以复用');
 assert.equal(calls,0);assert.deepEqual(errors,[]);
});
