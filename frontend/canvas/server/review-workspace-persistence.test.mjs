import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createWorkspaceService} from './workspace-service.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'xp-review-persistence-'));let revoked=false;
 const svc=createWorkspaceService({dataDir:dir,upstreamFetch:async()=>revoked?Response.json({}, {status:401}):Response.json({success:true,data:{subject:'u_review'}})});
 const server=createServer((req,res)=>svc.handleRequest(req,res,req.url));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const call=async(path,body)=>{const res=await fetch(origin+'/workspace'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer mock-review-only',Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,body:await res.json()};};
 return{dir,call,revoke:()=>revoked=true};
}

test('独立复审：结构损坏但可解析的索引必须拒写，不能当空工作区覆盖',async t=>{
 const {dir,call}=await fixture(t);const path=join(dir,'index.json'),raw=JSON.stringify({format:'xp-workspace@2',projects:'damaged-original',shares:{}});
 await writeFile(path,raw);const result=await call('/projects',{name:'不能覆盖旧索引',clientRequestId:'review-corrupt-123456789'});
 assert.equal(result.status,500);assert.equal(result.body.error.code,'storage_corrupt');assert.equal(await readFile(path,'utf8'),raw,'必须保留原始损坏索引以便恢复');
});

test('独立复审：只读身份缓存不能允许已撤销密钥继续写入项目',async t=>{
 const {call,revoke}=await fixture(t);assert.equal((await call('/identity')).status,200);revoke();
 const result=await call('/projects',{name:'撤销后不允许创建',clientRequestId:'review-revoked-123456789'});
 assert.equal(result.status,401,'每次写操作需要重新验证密钥仍有效');
});

test('独立复审：索引文件内容为null时也必须保留并拒绝写入',async t=>{
 const {dir,call}=await fixture(t);const path=join(dir,'index.json');await writeFile(path,'null');
 const result=await call('/projects',{name:'不能覆盖null索引',clientRequestId:'review-null-index-123456789'});
 assert.equal(result.status,500);assert.equal(result.body.error.code,'storage_corrupt');assert.equal(await readFile(path,'utf8'),'null');
});
