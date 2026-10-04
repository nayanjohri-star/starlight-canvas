import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasServer } from './app.mjs';
import { resolve } from 'node:path';

async function fixture(t, reply) {
  const calls=[];
  const server=createCanvasServer({staticDir:resolve('dist'),directorDir:resolve('../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async(url,init)=>{calls.push({url:String(url),method:init.method,body:init.body,headers:init.headers});return reply?.(url,init)??Response.json({data:[{b64_json:'mock-only'}]});}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>{server.closeAllConnections();server.close();});
  const send=(path,body={},extra={})=>fetch(base+'/site'+path,{method:'POST',headers:{Origin:base,Authorization:'Bearer local-mock-credential','Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  return {base,calls,send};
}

test('独立验收：图片和文本代理仅发本站、不会转发 Cookie 或自动重试 502',async t=>{
  const {calls,send}=await fixture(t,()=>Response.json({error:{message:'mock transient'}},{status:502}));
  for(const [path,body] of [['/v1/chat/completions',{model:'gpt-5.6-sol',messages:[{role:'user',content:'测试'}],stream:false,max_tokens:64}],['/v1/images/generations',{model:'gpt-image-2.5-flare-special',prompt:'杯子',size:'1024x1024',n:1,response_format:'b64_json'}]]){
    const before=calls.length;const res=await send(path,body,{Cookie:'private=not-forwarded'});assert.equal(res.status,502);assert.equal(calls.length,before+1);const c=calls.at(-1);assert.equal(new URL(c.url).origin,'https://xingpan.site');assert.equal(c.headers.Cookie??c.headers.cookie,undefined);
  }
});

test('独立验收：新增生成接口也拒绝异源请求和任意代理地址',async t=>{
  const {calls,send}=await fixture(t);const body={model:'gpt-image-2.5-flare',prompt:'x'};
  assert.equal((await send('/v1/images/generations',body,{Origin:'https://evil.example'})).status,403);
  assert.equal((await send('/v1/images/generations?url=https://evil.example',body)).status,400);
  assert.equal((await send('/https://evil.example/generate',body)).status,404);assert.equal(calls.length,0);
});

test('独立验收：新增接口不跟随上游重定向，不泄漏上游 Location/Cookie',async t=>{
  const {calls,send}=await fixture(t,()=>new Response(null,{status:302,headers:{Location:'https://private-upstream.example/result','Set-Cookie':'session=private'}}));
  const res=await send('/v1/images/generations',{model:'gpt-image-2.5-flare',prompt:'x',n:1,response_format:'b64_json'});
  assert.equal(res.status,502);assert.equal(res.headers.get('location'),null);assert.equal(res.headers.get('set-cookie'),null);assert.equal(calls.length,1);assert.doesNotMatch(await res.text(),/private-upstream|session=private/);
});

test('独立验收：30MiB 参考图片不再被旧视频 8MiB JSON 上限误伤',async t=>{
  const {send,calls}=await fixture(t);const bytes=Buffer.alloc(30*1024*1024);
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=','base64').copy(bytes);
  const body={model:'gpt-image-2.5-flare-special',prompt:'保持参考内容',size:'1024x1024',n:1,response_format:'b64_json',image:'data:image/png;base64,'+bytes.toString('base64')};
  const res=await send('/v1/images/edits',body);assert.equal(res.status,200);assert.equal(calls.length,1);
});
