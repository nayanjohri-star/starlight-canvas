import {clickCanvasAction,openCanvasDock} from './e2e-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceService,WORKSPACE_IDENTITY_URL} from '../server/workspace-service.mjs';
import {chromium,createCanvasServer,ROOT,CHROME,makeState,mockUpstream,setKey} from './e2e-helpers.mjs';

test('独立浏览器工作区：真实本地服务、两账户权限、邀请、修订冲突与撤销，全模拟身份',{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'xp-workspace-e2e-'));
 const state=makeState(),upstream=mockUpstream(state),identityCalls=[];
 const identity=async(url,init)=>{
  assert.equal(String(url),WORKSPACE_IDENTITY_URL);identityCalls.push(String(url));
  const bearer=init.headers.Authorization;
  const subject=bearer==='Bearer workspace-mock-a'?'u_1':bearer==='Bearer workspace-mock-b'?'u_2':null;
  return subject?Response.json({success:true,data:{subject,display_name:subject}}):Response.json({success:false},{status:401});
 };
 const service=createWorkspaceService({dataDir:dir,upstreamFetch:identity});
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:upstream,workspaceService:service});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--disable-gpu']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const pages=[];
 for(const key of ['workspace-mock-a','workspace-mock-b']){
  const context=await browser.newContext();await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__xp?.workspace);await setKey(page,key);pages.push(page);
 }
 const [a,b]=pages;
 const saved=await a.evaluate(async()=>{const x=window.__xp;await x.store.newProject('账户项目');x.store.addNode('text',0,0,{text:'共享稿件'});await x.store.flush();return x.workspace.backup();});
 const ref={owner:saved.owner,id:saved.id,head:saved.rev};assert.equal(saved.rev,1);
 assert.equal(await b.evaluate(async ref=>{try{await window.__xp.workspace.meta(ref);return 'leaked';}catch(e){return e.status;}},ref),404);
 const share=await a.evaluate(ref=>window.__xp.workspace.createShare(ref,{role:'viewer',expiresInHours:24}),ref);
 await b.evaluate(url=>window.__xp.workspace.claim(url),share.url);
 const pulled=await b.evaluate(ref=>window.__xp.workspace.pull(ref),ref);assert.equal(pulled.project.name,'账户项目（导入）');
 assert.equal(await b.evaluate(async()=>{const x=window.__xp;x.store.addNode('text',500,0,{text:'只读者修改本地副本'});await x.store.flush();try{await x.workspace.backup();return 'wrote';}catch(e){return e.status;}}),403);
 await a.evaluate(ref=>window.__xp.workspace.setMember(ref,'u_2','editor'),ref);
 assert.equal((await b.evaluate(()=>window.__xp.workspace.backup())).rev,2);
 const conflict=await a.evaluate(async()=>{const x=window.__xp;x.store.addNode('text',700,0,{text:'保留甲的草稿'});await x.store.flush();try{await x.workspace.backup();return null;}catch(e){return {code:e.code,nodes:x.store.project.nodes.map(n=>n.data.text)};}});
 assert.equal(conflict.code,'revision_conflict');assert.ok(conflict.nodes.includes('保留甲的草稿'));
 await a.evaluate(ref=>window.__xp.workspace.removeMember(ref,'u_2'),ref);
 assert.equal(await b.evaluate(async ref=>{try{await window.__xp.workspace.meta(ref);return 'leaked';}catch(e){return e.status;}},ref),404);
 // 真实按钮链路：生成的邀请链接必须在自动重绘后仍可复制；不通过脚本绕过界面。
 await clickCanvasAction(a, '#btn-workspace');
 await a.getByRole('button',{name:'创建邀请链接',exact:true}).click();
 const countBefore=await a.evaluate(async ref=>(await window.__xp.workspace.members(ref)).shares.length,ref);
 await a.getByRole('button',{name:'生成邀请链接',exact:true}).click();
 const invite=a.locator('.modal input[readonly]');
 await invite.waitFor({state:'visible'});
 const firstInvite=await invite.inputValue();assert.match(firstInvite,/#ws-claim=/);
 await a.getByRole('button',{name:'版本/成员',exact:true}).click();
 assert.equal(await invite.inputValue(),firstInvite,'重绘后仍保留当前面板生成的邀请链接');
 let memberRefreshFailed=false;
 await a.route('**/workspace/projects/*/*/members',route=>{
  if(route.request().method()==='GET'&&!memberRefreshFailed){memberRefreshFailed=true;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'mock_members_failure',message:'测试刷新失败'}})});}
  return route.fallback();
 });
 await a.getByRole('button',{name:'生成邀请链接',exact:true}).click();
 await a.waitForFunction(old=>document.querySelector('.modal input[readonly]')?.value!==old,firstInvite);
 const secondInvite=await invite.inputValue();assert.match(secondInvite,/#ws-claim=/);assert.notEqual(secondInvite,firstInvite);
 assert.equal(memberRefreshFailed,true,'确实覆盖成员刷新失败，已生成链接仍可见');
 assert.equal(await a.evaluate(async ref=>(await window.__xp.workspace.members(ref)).shares.length,ref),countBefore+2,'每次点击只能生成一个链接');
 await a.keyboard.press('Escape');await clickCanvasAction(a, '#btn-workspace');
 await a.getByRole('button',{name:'创建邀请链接',exact:true}).click();
 assert.equal(await a.locator('.modal input[readonly]').count(),0,'关闭面板后不再保留一次性邀请令牌');
 await a.keyboard.press('Escape');
 assert.equal(state.creates.length,0,'分享、导入与修订冲突不创建视频');assert.ok(identityCalls.length>=2);
});
