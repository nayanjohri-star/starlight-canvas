import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {chromium,createCanvasServer,ROOT,CHROME,SHOTS,makeState,mockUpstream,MP4,setKey} from './e2e-helpers.mjs';

async function setup(t){
 const state=makeState();state.videoBytes=new Uint8Array(MP4);
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:mockUpstream(state)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const ctx=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
 await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.__xp?.store?.project);return{page,state,errors};
}

test('直接生成：默认无输出圆点，模拟成片自动预览，卡片下载及反复切换不重复收费', {timeout:60000},async t=>{
 const {page,state,errors}=await setup(t);await setKey(page);
 const id=await page.evaluate(()=>{const x=window.__xp;const n=x.spawnNodeAt('gen',{x:350,y:100});x.board.select('node',n.id);return n.id;});
 const card=page.locator(`[data-node="${id}"]`),toggle=card.getByRole('switch',{name:'节点内预览'}),port=card.locator('.port.out');
 assert.equal(await toggle.isChecked(),true);assert.equal(await port.isVisible(),false);
 await toggle.uncheck();assert.equal(await port.isVisible(),true);
 await toggle.check();assert.equal(state.creates.length,0,'切换不创建任务');
 await page.getByLabel('视频生成型号').selectOption('wan-3.0');
 await page.getByLabel('生成时长（秒）').fill('5');await page.locator('#inspector textarea').fill('清晨海面，一艘小船缓慢前进');
 await page.locator('#inspector textarea').blur();await page.locator('#inspector button.primary',{hasText:/^(上传并)?提交生成$/}).click();
 await page.waitForFunction(id=>window.__xp.store.node(id)?.data.run?.taskId,id);
 const taskId=await page.evaluate(id=>window.__xp.store.node(id).data.run.taskId,id);
 await card.locator('video').waitFor({timeout:20000});
 await page.waitForFunction(id=>{const v=document.querySelector(`[data-node="${id}"] video`);return v?.videoWidth>0;},id);
 assert.equal(state.creates.length,1);assert.equal(state.downloads.length,1);
 const resultId=await page.evaluate(id=>window.__xp.store.node(id).data.resultAssetId,id);
 const event=page.waitForEvent('download');await card.getByRole('button',{name:'保存到电脑'}).click();const saved=await event;
 assert.deepEqual([...await readFile(await saved.path())],MP4,'保存的是同一条真实可解码成片');
 await toggle.uncheck();assert.equal(await card.locator('video').count(),0);assert.equal(await port.isVisible(),true);
 await toggle.check();await card.locator('video').waitFor();
 assert.equal(state.creates.length,1);assert.equal(state.downloads.length,1,'已有本地成片不重复下载');
 assert.equal(await page.evaluate(id=>window.__xp.store.node(id).data.run.taskId,id),taskId);
 assert.equal(await page.evaluate(id=>window.__xp.store.node(id).data.resultAssetId,id),resultId);
 for(const theme of ['light','dark']){await page.locator(`[data-theme-option="${theme}"]`).click();await card.screenshot({path:join(SHOTS,`direct-output-${theme}.png`)});}
 await toggle.uncheck();await page.evaluate(()=>window.__xp.store.flush());await page.reload();await page.waitForFunction(()=>window.__xp?.store?.project);
 assert.equal(await toggle.isChecked(),false);assert.equal(await port.isVisible(),true);assert.equal(state.creates.length,1);
 assert.deepEqual(errors,[]);
});

test('连接模式：真实拖线、已有连线保护、断开后切回，选择模式不改变工作流依赖',async t=>{
 const {page,state,errors}=await setup(t);
 const [a,b]=await page.evaluate(()=>{const x=window.__xp;return[x.spawnNodeAt('gen',{x:130,y:80}).id,x.store.addNode('utility',660,140,{tool:'video_frame_extract',params:{at:0}}).id];});
 const card=page.locator(`[data-node="${a}"]`),toggle=card.getByRole('switch',{name:'节点内预览'});
 await toggle.uncheck();
 const from=await card.locator('.port.out .dot').boundingBox(),to=await page.locator(`[data-node="${b}"] .port.in .dot`).boundingBox();
 await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:12});await page.mouse.up();
 assert.equal(await page.evaluate(()=>window.__xp.store.project.edges.length),1);
 assert.equal(await toggle.isEnabled(),false);assert.equal(await toggle.isChecked(),false);
 assert.ok((await card.innerText()).includes('输出至 1 个下游节点'));
 await card.screenshot({path:join(SHOTS,'direct-output-linked.png')});
 await page.evaluate(()=>window.__xp.board.removeEdge(window.__xp.store.project.edges[0].id));
 assert.equal(await toggle.isEnabled(),true);await toggle.check();
 assert.equal(await card.locator('.port.out').isVisible(),false);
 assert.equal(state.creates.length,0,'连线和切换不会收费');assert.deepEqual(errors,[]);
});
