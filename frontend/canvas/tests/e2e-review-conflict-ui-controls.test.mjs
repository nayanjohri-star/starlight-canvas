import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME} from './e2e-helpers.mjs';

async function setup(t){
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{throw new Error('禁止真实上游请求');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const context=await browser.newContext({viewport:{width:1440,height:900}});await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__xp?.projectHub);
 await page.evaluate(async()=>{
  const {createIdbStorage}=await import('/storage.js'),{createStore}=await import('/store.js');
  const s=window.__xp.store;await s.newProject('本地冲突');window.__conflictPid=s.project.id;
  const other=createStore(await createIdbStorage());await other.openProject(s.project.id);other.addNode('note',0,0,{text:'外部稿'});await other.flush();
  s.addNode('note',0,0,{text:'保留的本地稿'});try{await s.flush();}catch(e){if(e.code!=='rev_conflict')throw e;}
  if(!s.getConflict())throw new Error('未建立冲突测试前提');
 });
 return page;
}

test('独立浏览器：冲突处理失败保留草稿，界面仍可重试另存',async t=>{
 const page=await setup(t);
 await page.evaluate(()=>{const s=window.__xp.store,real=s.resolveConflict.bind(s);window.__saveCalls=0;s.resolveConflict=async(...args)=>{if(++window.__saveCalls===1)throw new Error('模拟保存失败');return real(...args);};window.__xp.projectHub.open();});
 let save=page.locator('.modal').getByRole('button',{name:'另存本地副本',exact:true});await save.click();
 await page.getByText(/冲突处理未完成：模拟保存失败/).waitFor();
 assert.equal(await page.evaluate(()=>window.__xp.store.project.nodes.some(n=>n.data.text==='保留的本地稿')),true);
 save=page.locator('.modal').getByRole('button',{name:'另存本地副本',exact:true});await save.click();
 await page.waitForFunction(()=>window.__saveCalls===2&&!window.__xp.store.getConflict(window.__conflictPid));
});

test('独立浏览器：双击只处理一次，关闭面板后异步完成不重开或切走新项目',async t=>{
 const page=await setup(t);
 await page.evaluate(()=>{const s=window.__xp.store,real=s.resolveConflict.bind(s);window.__saveCalls=0;const gate=new Promise(r=>window.__releaseSave=r);s.resolveConflict=async(...args)=>{window.__saveCalls++;await gate;try{return await real(...args);}finally{window.__saveSettled=true;}};window.__xp.projectHub.open();});
 await page.locator('.modal').getByRole('button',{name:'另存本地副本',exact:true}).dblclick();
 assert.equal(await page.evaluate(()=>window.__saveCalls),1);
 await page.keyboard.press('Escape');await page.evaluate(async()=>{await window.__xp.store.newProject('稍后打开的新项目');window.__releaseSave();});
 await page.waitForFunction(()=>window.__saveSettled===true);
 assert.equal(await page.locator('.modal').count(),0,'关闭后不重新打开面板');
 assert.equal(await page.evaluate(()=>window.__xp.store.project.name),'稍后打开的新项目','完成只作用于捕获的旧项目');
});
