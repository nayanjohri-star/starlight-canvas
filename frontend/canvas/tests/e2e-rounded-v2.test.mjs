import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,SHOTS,makeState,mockUpstream,MP4,realPng,addAsset,setKey,downloadCurrent} from './e2e-helpers.mjs';
import {installDirectorAssemblyFixture,assertHostedDirectorEntry} from './legacy-director-fixture.mjs';

test('圆润 V2：真实素材引用、单次模拟生成、新版本保护、双主题桌面与模块入口', {timeout:150000}, async t=>{
 const state=makeState();state.videoBytes=new Uint8Array(MP4);
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:mockUpstream(state)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--disable-gpu']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const ctx=await browser.newContext({viewport:{width:1440,height:900}});
 await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const directorEntries=await installDirectorAssemblyFixture(ctx);
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.__xp?.store?.project);
 await setKey(page);
 const a=await addAsset(page,await realPng(page,24),'海岸参考.png','image',100,120);
 const b=await addAsset(page,await realPng(page,170),'灯塔参考.png','image',100,420);
 const gen=await page.evaluate(([a,b])=>{
  const x=window.__xp;const n=x.spawnNodeAt('gen',{x:480,y:150});
  x.store.addEdge(a,'out',n.id,'refs','image');x.store.addEdge(b,'out',n.id,'refs','image');
  x.board.select('node',n.id);return n.id;
 },[a.nodeId,b.nodeId]);
 const model=page.getByLabel('视频生成型号');
 assert.equal(await model.locator('option').count(),13,'所有已接入型号仍可选择或显示明确的分组限制');
 await model.selectOption('wan-3.0');await page.getByLabel('生成模式').selectOption('refs');
 await page.getByLabel('生成时长（秒）').fill('5');
 const prompt=page.locator('#inspector textarea');await prompt.fill('清晨沿海岸向灯塔缓慢推进，保持主体一致。');
 await page.getByRole('button',{name:'插入引用 @图片1 海岸参考.png',exact:true}).click();
 assert.match(await prompt.inputValue(),/@图片1/);
 assert.equal(await page.locator('.ref-thumbs img').count(),2);
 assert.match(await page.locator('#inspector .cost').innerText(),/2\.25/);
 assert.equal(state.creates.length,0,'编辑与引用操作不自动生成');
 await page.getByRole('button',{name:/^(上传并)?提交生成$/}).click();
 await page.waitForFunction(id=>window.__xp.store.node(id)?.data.run?.taskId,gen);
 const taskId=await page.evaluate(id=>window.__xp.store.node(id).data.run.taskId,gen);
 await page.waitForFunction(id=>window.__xp.taskPeek(id)?.status==='completed',taskId,{timeout:20000});
 await downloadCurrent(page,taskId);
 await page.waitForFunction(id=>document.querySelector(`[data-node="${id}"] .gen-media video`)?.readyState>=1,gen);
 assert.equal(state.creates.length,1,'一份草稿只创建一次任务');
 const stable=await page.evaluate(async id=>{
  const v=document.querySelector(`[data-node="${id}"] .gen-media video`);v.muted=true;await v.play();v.currentTime=0.2;
  window.__xp.board.render();
  const retained=document.querySelector(`[data-node="${id}"] .gen-media video`)===v;
  const time=v.currentTime;v.pause();return{retained,time};
 },gen);
 assert.equal(stable.retained,true,'更新画布不重建已经下载的成片播放器');assert.ok(stable.time>=0.19);
 const original=await page.evaluate(id=>JSON.parse(JSON.stringify(window.__xp.store.node(id).data)),gen);
 await page.getByRole('button',{name:'创建新版本',exact:true}).click();
 const copy=await page.evaluate(()=>window.__xp.board.selectedIds[0]);
 assert.notEqual(copy,gen);
 assert.deepEqual(await page.evaluate(id=>window.__xp.store.node(id).data.run,gen),original.run);
 assert.equal(await page.evaluate(id=>!!window.__xp.store.node(id).data.run,copy),false);
 assert.equal(await page.evaluate(id=>window.__xp.store.edgesInto(id,'refs').length,copy),2);
 assert.equal(state.creates.length,1,'创建新版本只建草稿，不自动计费');
 // 实际排列按钮按当前节点尺寸布局，不再让媒体预览互相压住。
 await page.evaluate(()=>window.__xp.board.selectMany(window.__xp.store.project.nodes.map(n=>n.id)));
 await page.locator('#btn-arrange').click();
 const overlap=await page.evaluate(()=>{
  const boxes=[...document.querySelectorAll('.node')].map(e=>e.getBoundingClientRect());
  return boxes.some((a,i)=>boxes.slice(i+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));
 });assert.equal(overlap,false,'排列后的不同宽度节点不重叠');
 // 回到两参考图 + 已完成节点，删除测试副本可撤销，原成片不受影响。
 await page.evaluate(([copy,gen,a,b])=>{
  const x=window.__xp;x.editor.delete([copy]);
  Object.assign(x.store.node(a),{x:100,y:100});Object.assign(x.store.node(b),{x:100,y:140+x.board.measureNode(x.store.node(a)).h});Object.assign(x.store.node(gen),{x:480,y:150});
  x.store.touch({type:'structure'});x.board.selectMany([gen]);x.board.fit();
 },[copy,gen,a.nodeId,b.nodeId]);
 await page.waitForFunction(()=>!document.querySelector('#toast-root .toast'),null,{timeout:10000});
 // This existing layout contract applies to the pinned inspector. The default
 // node-local editor is exercised separately, including pin/unpin behavior.
 await page.getByRole('button',{name:'固定到右侧',exact:true}).click();
 await page.waitForFunction(()=>!document.getElementById('inspector').classList.contains('node-composer'));
 for(const [width,height] of [[1280,800],[1440,900],[1920,1080]]){
  await page.setViewportSize({width,height});
  for(const theme of ['light','dark']){
   await page.locator(`[data-theme-option="${theme}"]`).click();
   await page.evaluate(()=>{window.__xp.board.fit();document.getElementById('inspector').scrollTop=0;});
   await page.waitForTimeout(100);
   const layout=await page.evaluate(()=>{
    const board=document.getElementById('board-wrap').getBoundingClientRect(),ins=document.getElementById('inspector').getBoundingClientRect();
    const controls=[...document.querySelectorAll('#topbar button,#topbar select')].filter(e=>e.getClientRects().length);
    return{overflow:document.documentElement.scrollWidth>innerWidth+1,insOverflow:document.getElementById('inspector').scrollWidth>document.getElementById('inspector').clientWidth+1,boardRight:board.right,insLeft:ins.left,
     clipped:controls.filter(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth+1||r.top<0||r.bottom>60;}).map(e=>e.id),
     theme:document.documentElement.dataset.theme};
   });
   assert.equal(layout.overflow,false);assert.equal(layout.insOverflow,false);assert.deepEqual(layout.clipped,[]);
   assert.ok(layout.boardRight<=layout.insLeft,'检查器占用独立宽度');assert.equal(layout.theme,theme);
   assert.equal(await prompt.inputValue(),original.draft.prompt,'主题/尺寸切换保留草稿');
   await page.screenshot({path:join(SHOTS,`rounded-v2-${theme}-${width}.png`)});
  }
 }
 await page.locator('#btn-storyboard').click();await page.waitForSelector('.sb');
 await page.screenshot({path:join(SHOTS,'rounded-v2-storyboard.png')});await page.keyboard.press('Escape');
 await page.locator('#btn-timeline').click();await page.waitForSelector('.tl-root');
 await page.screenshot({path:join(SHOTS,'rounded-v2-timeline.png')});await page.keyboard.press('Escape');
 // 默认托管入口沿同一项目复用场景；此处用无脚本 fixture 验收装配，WebGL 单独实测。
 assert.equal(directorEntries.length,0,'启动与其他模块导航不加载完整导演台');
 assert.equal(await page.locator('#btn-director-mode .dev-badge').count(),0);
 for(let attempt=0;attempt<2;attempt++){
  await page.locator('#btn-director-mode').click();
  await page.frameLocator('.director-frame').locator('[data-director-assembly-fixture]').waitFor();
  const scope=await page.evaluate(()=>({projectId:window.__xp.store.project.id,nodeId:window.__xp.store.project.nodes.find(n=>n.type==='director').id}));
  assertHostedDirectorEntry(await page.locator('.director-frame').getAttribute('src'),origin,scope);
  assert.equal(await page.evaluate(()=>window.__xp.store.project.nodes.filter(n=>n.type==='director').length),1);
  assert.doesNotMatch(await page.locator('.modal').last().innerText(),/开发中|插件资源/);
  await page.evaluate(id=>window.__xp.host.closeEditor(id),scope.nodeId);
 }
 assert.equal(directorEntries.length,2);
 await page.evaluate(()=>window.__xp.store.flush());await page.reload();await page.waitForFunction(()=>window.__xp?.store?.project);
 assert.equal(await page.evaluate(id=>window.__xp.store.node(id).data.run.taskId,gen),taskId);
 assert.equal(state.creates.length,1,'重开与模块导航不会重复创建任务');
 assert.deepEqual(errors,[]);
});
