import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME,clickCanvasAction,openCanvasDock} from './e2e-helpers.mjs';

test('桌面布局：三种宽度的菜单、搜索、互斥面板和参数恢复实际可操作',{timeout:90000},async t=>{
 let posts=0;
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async(_url,init)=>{if(init.method==='POST')posts++;throw new Error('禁止真实上游');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 for(const width of [1280,1440,1920]){
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.waitForFunction(()=>window.__xp?.store?.project);
  assert.ok(await page.locator('#board').evaluate(e=>e.clientWidth>=innerWidth-8),'初始空画布应展开');
  assert.equal(await page.locator('#inspector').evaluate(e=>e.inert),true);
  assert.ok(await page.locator('#view-bar #btn-undo').isVisible());
  const menu=page.locator('#btn-project-menu');
  assert.ok(await page.locator('#topbar #btn-export').isVisible(),'导出迁至顶栏后仍直接可用');
  await menu.click();assert.equal(await page.locator('.popup .menu-item').count(),5);
  await page.mouse.click(width-30,200);assert.equal(await page.locator('.popup').count(),0);
  await menu.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.popup .menu-item').count(),5,'点外部关闭后，键盘应能重新打开菜单');
  await page.keyboard.press('Escape');assert.equal(await menu.evaluate(e=>e===document.activeElement),true);
  await clickCanvasAction(page,'#btn-rename');assert.equal(await page.locator('.modal').count(),1);
  assert.equal(await page.locator('.popup').count(),0,'打开重命名后，只关闭原菜单');
  await page.keyboard.press('Escape');await menu.click();assert.equal(await page.locator('.popup .menu-item').count(),5);await page.keyboard.press('Escape');
  await openCanvasDock(page,'create');await page.locator('#create-search').fill('视频');
  const visible=await page.locator('#sidebar [data-dock="create"] button').evaluateAll(bs=>bs.filter(b=>b.getClientRects().length&&getComputedStyle(b).visibility!=='hidden').map(b=>b.textContent));
  assert.ok(visible.length>0);assert.ok(visible.every(s=>s.includes('视频')),JSON.stringify(visible));
  await page.locator('#create-search').press('Escape');
  assert.equal(await page.locator('#create-search').inputValue(),'');
  await openCanvasDock(page,'task');assert.ok(await page.locator('[data-dock="task"]').isVisible());assert.ok(!await page.locator('[data-dock="create"]').isVisible());
  await clickCanvasAction(page,'[data-add-node="gen"]');
  assert.equal(await page.locator('#sidebar').evaluate(e=>e.inert),true,'创建后收起面板，不挡新节点或端口');
  assert.equal(await page.locator('#inspector').evaluate(e=>e.inert),false,'选中生成节点自动展开参数');
  const prompt=page.locator('#inspector textarea').first();await prompt.fill('保留这段镜头提示词');
  await page.locator('.insp-x').click();assert.equal(await page.locator('#inspector').evaluate(e=>e.inert),true);
  await page.locator('#btn-right-panel').click();assert.equal(await prompt.inputValue(),'保留这段镜头提示词');
  await page.locator('#node-search').fill('视频');
  assert.ok(await page.locator('.popup .menu-item').count()>0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#node-search').inputValue(),'','一次 Esc 清除搜索结果和输入');
  assert.equal(await page.locator('.popup').count(),0);
  await openCanvasDock(page,'create');
  for(const dockWidth of [200,296,560]){
   const resize=await page.locator('#sidebar-resizer').boundingBox();
   const current=await page.locator('#sidebar').evaluate(e=>e.getBoundingClientRect().width);
   await page.mouse.move(resize.x+resize.width/2,resize.y+200);await page.mouse.down();
   await page.mouse.move(resize.x+resize.width/2+dockWidth-current,resize.y+200,{steps:5});await page.mouse.up();
   const boxes=await page.evaluate(()=>({dock:document.querySelector('#sidebar').getBoundingClientRect().toJSON(),bar:document.querySelector('#sel-bar').getBoundingClientRect().toJSON(),board:document.querySelector('#board-wrap').getBoundingClientRect().toJSON()}));
   assert.ok(boxes.bar.x>=boxes.dock.right+8,`选择工具条不遮挡浮动面板 ${JSON.stringify(boxes)}`);
   assert.ok(boxes.bar.right<=boxes.board.right,'选择工具条保持在画布内');
  }
  await menu.click();await page.setViewportSize({width:900,height:900});
  // setViewportSize returns before matchMedia's queued change event on some
  // Chrome runs. Wait for the actual close operation, keeping the assertion.
  await page.waitForFunction(()=>!document.querySelector('.popup'),null,{timeout:2000});
  assert.equal(await page.locator('.popup').count(),0,'跨断点关闭原项目菜单');
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(errors,[]);await context.close();
 }
 assert.equal(posts,0,'查看和编辑画布不会自动产生生成请求');
});
