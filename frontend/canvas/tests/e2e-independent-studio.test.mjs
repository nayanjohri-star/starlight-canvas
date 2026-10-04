import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,MODELS_11,setKey,SHOTS} from './e2e-helpers.mjs';

test('独立浏览器验收：启动不弹遮挡层、模型目录全域可用、三种宽度能打开工作台', {timeout:90000},async t=>{
 const calls=[];const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async(url,init)=>{calls.push({path:new URL(url).pathname,method:init.method});return Response.json({data:[...MODELS_11,'gpt-5.6-sol','gpt-image-2.5-flare','gpt-image-2.5-sunburst','gpt-image-2.5-flare-special','gpt-image-2.5-sunburst-special'].map(id=>({id}))});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--disable-gpu']});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.__xp?.store?.project);
 const modules=await page.evaluate(()=>window.__xp.moduleStatus);assert.ok(Object.values(modules).every(s=>s.ok),JSON.stringify(modules));
 assert.equal(await page.locator('#overlay-root .mask').count(),0,'工作流面板不能在启动时自动变成遮住顶栏的弹窗');
 await setKey(page);assert.equal(await page.evaluate(()=>window.__xp.generators.textModels().filter(m=>m.usable).length),1);assert.equal(await page.evaluate(()=>window.__xp.generators.imageModels().filter(m=>m.usable).length),4);
 for(const width of [1440,768,390]){
  await page.setViewportSize({width,height:900});await page.screenshot({path:join(SHOTS,`independent-studio-${width}.png`)});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),`${width} 横向溢出`);
  for(const [button,title] of [['#btn-storyboard','分镜'],['#btn-timeline','剪辑']]){
   await page.locator(button).click();await page.waitForSelector('.modal');assert.ok((await page.locator('.modal').last().innerText()).includes(title),`${width} 工作台必须真打开`);await page.keyboard.press('Escape');await page.waitForSelector('.modal',{state:'detached'});
  }
 }
 assert.equal(calls.filter(c=>c.method==='POST').length,0,'查看和切换工作台不能自动触发生成');assert.deepEqual(errors,[]);
});
