import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createWorkspaceService} from './workspace-service.mjs';

async function fixture(t,{upstreamFetch=async()=>Response.json({success:true,data:{subject:'u_1'}}),limits={}}={}){
 const dir=await mkdtemp(join(tmpdir(),'xp-independent-ws-'));
 const svc=createWorkspaceService({dataDir:dir,upstreamFetch,limits}),server=createServer((req,res)=>svc.handleRequest(req,res,req.url));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 return async(path,body)=>{const r=await fetch(origin+'/workspace'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer mock-only',Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
}
test('独立工作区：创建凭持久请求标识去重，不按同名项目认领',{timeout:5000},async t=>{
 const call=await fixture(t),a=await call('/projects',{name:'同名',clientRequestId:'request-a-123456789'}),b=await call('/projects',{name:'同名',clientRequestId:'request-b-123456789'}),again=await call('/projects',{name:'同名',clientRequestId:'request-b-123456789'});
 assert.equal(a.status,201);assert.equal(b.status,201);assert.notEqual(a.body.project.id,b.body.project.id);assert.equal(again.body.project.id,b.body.project.id);assert.equal((await call('/projects')).body.projects.length,2);
});
test('独立工作区：身份响应已经回头但正文不结束，也必须超时退出',{timeout:5000},async t=>{
 let cancelled=false;const call=await fixture(t,{limits:{identityFetchTimeoutMs:35},upstreamFetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:200})});
 const start=Date.now(),r=await call('/identity');assert.equal(r.status,503);assert.ok(Date.now()-start<1000);assert.equal(cancelled,true);
});
test('独立工作区：分块响应超限即停止读取；成功字段为假时不接受身份',{timeout:5000},async t=>{
 let cancelled=false;const call=await fixture(t,{limits:{identityMaxResponseBytes:64},upstreamFetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(128));},cancel(){cancelled=true;}}),{status:200})});
 assert.equal((await call('/identity')).status,502);assert.equal(cancelled,true);
 const denied=await fixture(t,{upstreamFetch:async()=>Response.json({success:false,data:{subject:'u_1'}})});assert.equal((await denied('/identity')).status,502);
});
