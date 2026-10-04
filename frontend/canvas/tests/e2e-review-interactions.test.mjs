import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME} from './e2e-helpers.mjs';

async function setup(t){
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{throw new Error('复审不允许真实模型请求');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__xp?.library);return page;
}

test('复审浏览器：弹窗Tab与ShiftTab不能逃到背景，关闭返回触发按钮',async t=>{
 const page=await setup(t);await page.locator('#btn-key').click();
 for(let i=0;i<12;i++){await page.keyboard.press(i%2?'Tab':'Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.modal')),true,'焦点不能落入背景界面');}
 assert.equal(await page.locator('.modal').getAttribute('role'),'dialog');await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'btn-key');
});

test('独立浏览器：右键不拖节点，Shift取消最后节点，滚轮同步缩放显示',async t=>{
 const page=await setup(t);const id=await page.evaluate(()=>window.__xp.store.addNode('note',80,100,{text:'真实交互'}).id);
 const head=page.locator(`[data-node="${id}"] .node-head`);await head.waitFor();const rect=await head.boundingBox();
 await page.mouse.move(rect.x+70,rect.y+14);await page.mouse.down({button:'right'});await page.mouse.move(rect.x+180,rect.y+80);await page.mouse.up({button:'right'});
 assert.deepEqual(await page.evaluate(id=>{const n=window.__xp.store.node(id);return[n.x,n.y];},id),[80,100],'右键手势不能修改节点位置');
 await page.keyboard.press('Escape');await head.click();await head.click({modifiers:['Shift']});
 assert.equal(await page.evaluate(()=>window.__xp.board.selected),null,'取消最后一个选择后状态为null');
 assert.equal(await page.locator('#inspector .inspector-empty').count(),1,'检查器同步清空');
 const board=await page.locator('#board').boundingBox();await page.mouse.move(board.x+board.width-90,board.y+board.height-180);await page.mouse.wheel(0,-120);
 await page.waitForFunction(()=>document.querySelector('#statusbar')?.textContent.includes(`缩放 ${Math.round(window.__xp.board.view.scale*100)}%`));
});

test('复审浏览器：节点内长文本滚动不能缩放画布',async t=>{
 const page=await setup(t);const id=await page.evaluate(()=>window.__xp.store.addNode('note',80,40,{text:Array.from({length:80},(_,i)=>'第'+i+'行长剧本').join('\n')}).id);
 const text=page.locator(`[data-node="${id}"] textarea`);await text.waitFor();await text.hover();
 const scale=await page.evaluate(()=>window.__xp.board.view.scale);await page.mouse.wheel(0,250);await page.waitForTimeout(120);
 assert.equal(await page.evaluate(()=>window.__xp.board.view.scale),scale,'滚动文本时不应改变画布缩放');
 assert.ok(await text.evaluate(e=>e.scrollTop>0),'长文本应该真实滚动');
});

test('复审浏览器：编辑参数或输入法按Escape，不清选择和检查器',async t=>{
 const page=await setup(t);const id=await page.evaluate(()=>window.__xp.store.addNode('text',80,40,{text:'保留编辑'}).id);
 await page.locator(`[data-node="${id}"] .node-head`).click();const input=page.locator('#inspector textarea').first();await input.waitFor();await input.focus();
 await page.keyboard.press('Escape');assert.equal(await page.locator('#inspector textarea').count()>0,true);
 assert.ok(await page.evaluate(id=>window.__xp.board.selectedIds.includes(id),id));
 await input.evaluate(e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true})));
 assert.ok(await page.evaluate(id=>window.__xp.board.selectedIds.includes(id),id));
});

test('复审浏览器：素材库与分镜有真实网格，大图不会撑破卡片',async t=>{
 const page=await setup(t);
 await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=2048;c.height=1024;c.getContext('2d').fillRect(0,0,2048,1024);const b=await new Promise(r=>c.toBlob(r));await window.__xp.assets.registerBlob(b,'大图.png','image');window.__xp.library.open();});
 const grid=page.locator('.lib-grid');await grid.waitFor();assert.equal(await grid.evaluate(e=>getComputedStyle(e).display),'grid');
 assert.ok(await page.locator('.modal').evaluate(e=>e.scrollWidth<=e.clientWidth+2));await page.keyboard.press('Escape');
 await page.evaluate(()=>{window.__xp.storyboards.createGrid(4);window.__xp.storyboards.open();});
 assert.equal(await page.locator('.sb-grid').evaluate(e=>getComputedStyle(e).display),'grid');
});

test('独立浏览器复审：用真实鼠标右键连线能打开连线菜单',async t=>{
 const page=await setup(t);const edgeId=await page.evaluate(()=>{const s=window.__xp.store;const a=s.addNode('text',50,150,{text:'输入'}),b=s.addNode('gen',550,150,{draft:{model:'minimax-h3-768p-per-second',seconds:5,ratio:'16:9',intent:'text'}});return s.addEdge(a.id,'out',b.id,'prompt','text').id;});
 const point=await page.locator(`[data-edge="${edgeId}"] path`).first().evaluate(p=>{const v=p.getPointAtLength(p.getTotalLength()/2);const screen=new DOMPoint(v.x,v.y).matrixTransform(p.getScreenCTM());return{x:screen.x,y:screen.y};});
 await page.mouse.click(point.x,point.y,{button:'right'});
 const menu=page.locator('.popup').getByRole('menuitem',{name:/删除连线/});await menu.waitFor({timeout:2000});
 assert.equal(await menu.count(),1);await menu.click();
 assert.equal(await page.evaluate(id=>window.__xp.store.project.edges.some(e=>e.id===id),edgeId),false,'菜单确实删除所选连线');
 await page.keyboard.press('Control+z');
 assert.equal(await page.evaluate(id=>window.__xp.store.project.edges.some(e=>e.id===id),edgeId),true,'误删连线能够撤销恢复');
});
