import test from 'node:test';
import assert from 'node:assert/strict';
import { openHostedCanvasSession, ApiError } from '../src/api.js';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createGenerators } from '../src/studio-gen.js';
import { clearKey, setKey, setAvailableModels } from '../src/keyvault.js';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const plain = () => ({ append(){}, remove(){}, setAttribute(){}, style:{} });
globalThis.document = { createElement: plain, getElementById: plain };

test('lost POST response is recovered with GET only; revoked identity never reposts', async () => {
  const calls=[]; let key='fixture-key', revoked=false;
  const session = await openHostedCanvasSession({ storage:createMemoryStorage(), getKey:()=>key, fetchImpl:async(url, opts)=>{
    calls.push({ url, method:opts.method });
    if(url.endsWith('/features')) return Response.json({mode:'hosted',apiVersion:1,features:{cancel:false,imageJobs:true}});
    if(url.endsWith('/identity')) return Response.json({subject:'u1'});
    if(opts.method==='POST') { assert.equal(opts.headers['X-Canvas-Image-Job'],'op_fixture_123'); throw new TypeError('lost response'); }
    if(revoked) { key='other'; return Response.json({data:[{b64_json:PNG}]}); }
    return Response.json({data:[{b64_json:PNG}]});
  }});
  const out=await session.api.imageGeneration('{}',{operationId:'op_fixture_123'});
  assert.equal(out.data[0].b64_json,PNG);
  assert.equal(calls.filter(x=>x.method==='POST').length,1);
  assert.ok(calls.some(x=>x.url.endsWith('/images/jobs/op_fixture_123')));
  revoked=true;
  await assert.rejects(session.api.waitImageJob('op_fixture_123'),e=>e.code==='identity_changed');
  assert.equal(calls.filter(x=>x.method==='POST').length,1);
});

test('persist operation ID before POST; reopen restores missing image through GET without rebuilding references', async () => {
  clearKey(); await setKey('fixture-key'); setAvailableModels(['gpt-image-2.5-flare']);
  const storage=createMemoryStorage(), store=createStore(storage);
  await store.newProject('fixture');
  const n=store.addNode('image',0,0,{model:'gpt-image-2.5-flare',prompt:'fixture',resolution:'4K',ratio:'16:9'});
  await store.flush(); let posts=0, queries=0;
  const api={supportsImageJobs:true,imageGeneration:async(body,options)=>{
    posts++;
    const op=await storage.get(`op:${store.project.id}:${n.id}`);
    assert.equal(op.id,options.operationId); assert.equal(op.state,'sent'); assert.equal(op.imageJob,true);
    throw new ApiError(0,'offline','fixture network interruption');
  },waitImageJob:async id=>{ queries++; assert.equal(id,n.data.operation.id); return {data:[{b64_json:PNG}]}; }};
  const deps={store,storage,api,submitLock:(_,fn)=>fn(),decodeImage:async()=>({width:1,height:1}),assets:{registerBlob:async(blob,name,kind)=>{
    const rec={id:'result',name,kind}; store.project.assets.result=rec; await storage.setBlob('blob:result',blob); return rec;
  }}};
  await assert.rejects(createGenerators(deps).generate(n),/未确认/);
  n.data.prompt=''; // Recovery must not need the original form or reference files.
  const recovered=createGenerators(deps);
  await recovered.restoreOperations();
  for(let i=0;i<100 && n.data.operation.state!=='completed';i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(n.data.operation.state,'completed'); assert.equal(n.data.resultAssetId,'result');
  assert.equal(posts,1); assert.equal(queries,1);
  const durable=await storage.get(`op:${store.project.id}:${n.id}`);
  assert.equal(durable.state,'completed');
});

for (const code of ['image_jobs_busy', 'image_upload_busy']) {
  test(`${code} is explicitly unsubmitted: no polling or automatic replay, manual retry remains possible`, async () => {
    clearKey(); await setKey('synthetic-busy-key'); setAvailableModels(['gpt-image-2.5-flare']);
    const storage = createMemoryStorage(), store = createStore(storage);
    await store.newProject('synthetic busy');
    const n = store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', prompt: 'synthetic', resolution: '4K', ratio: '16:9' });
    await store.flush(); let posts = 0, queries = 0;
    const session = await openHostedCanvasSession({ storage: createMemoryStorage(), getKey: () => 'synthetic-busy-key', fetchImpl: async (url, options) => {
      if (url.endsWith('/features')) return Response.json({mode:'hosted',apiVersion:1,features:{cancel:false,imageJobs:true}});
      if (url.endsWith('/identity')) return Response.json({subject:'u1'});
      if (options.method === 'POST') {
        posts++;
        return posts === 1 ? Response.json({error:{code,message:'本次尚未提交，请稍后重试'}}, {status:429,headers:{'Retry-After':'3'}})
          : Response.json({data:[{b64_json:PNG}]});
      }
      queries++; throw new Error('a rejected operation must not be polled');
    }});
    const generators = createGenerators({store, storage, api:session.api, submitLock:(_,fn)=>fn(),
      decodeImage:async()=>({width:1,height:1}), assets:{registerBlob:async(blob,name,kind)=>{
        const rec={id:'busy-result',name,kind};store.project.assets[rec.id]=rec;await storage.setBlob('blob:'+rec.id,blob);return rec;
      }}});
    await assert.rejects(generators.generate(n), e => e.code === 'rejected' && /429/.test(e.message) && /尚未提交/.test(e.message));
    assert.equal(n.data.operation.state, 'rejected');
    assert.equal((await storage.get(`op:${store.project.id}:${n.id}`)).state, 'rejected');
    await generators.restoreOperations();
    assert.equal(posts,1); assert.equal(queries,0);
    await generators.generate(n); // A second explicit user action, never an automatic retry.
    assert.equal(posts,2); assert.equal(queries,0); assert.equal(n.data.operation.state,'completed');
  });
}

test('a busy retry of an existing image remains protected and restores with GET only', async()=>{
  clearKey();await setKey('synthetic-retry');setAvailableModels(['gpt-image-2.5-flare']);
  const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('synthetic retry');
  const n=store.addNode('image',0,0,{model:'gpt-image-2.5-flare',prompt:'synthetic',resolution:'4K',ratio:'16:9'});
  let posts=0,gets=0;
  const generators=createGenerators({store,storage,submitLock:(_,fn)=>fn(),decodeImage:async()=>({width:1,height:1}),
    api:{supportsImageJobs:true,imageGeneration:async()=>{posts++;throw new ApiError(429,'image_job_retry_busy','原图片操作已有记录，请查询原任务');},
      waitImageJob:async()=>{gets++;return {data:[{b64_json:PNG}]};}},
    assets:{registerBlob:async(blob,name,kind)=>{const rec={id:'retry-result',name,kind};store.project.assets[rec.id]=rec;await storage.setBlob('blob:'+rec.id,blob);return rec;}}});
  await assert.rejects(generators.generate(n),e=>e.code==='unresolved');
  assert.equal(n.data.operation.state,'unresolved');
  await assert.rejects(generators.generate(n),/锁定/);assert.equal(posts,1);
  await generators.restoreOperations();
  for(let i=0;i<100&&n.data.operation.state!=='completed';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(n.data.operation.state,'completed');assert.equal(posts,1);assert.equal(gets,1);
});

test('a finished 4K job delivered as a link is downloaded in ranges and resumed after an interruption', async () => {
  const image = new Uint8Array(200003); image.set([0x89, 0x50, 0x4e, 0x47]); for (let i = 4; i < image.length; i++) image[i] = i % 251;
  const calls = []; let cut = true;
  const session = await openHostedCanvasSession({ storage: createMemoryStorage(), getKey: () => 'fixture-key', fetchImpl: async (url, opts) => {
    calls.push({ url, range: opts.headers?.Range, delivery: opts.headers?.['X-Canvas-Image-Delivery'] });
    if (url.endsWith('/features')) return Response.json({ mode: 'hosted', apiVersion: 1, features: { cancel: false, imageJobs: true } });
    if (url.endsWith('/identity')) return Response.json({ subject: 'u1' });
    if (url.endsWith('/images/jobs/op_fixture_4k/image')) {
      const start = Number(/bytes=(\d+)-/.exec(opts.headers?.Range ?? '')?.[1] ?? 0);
      const body = image.subarray(start);
      const headers = { 'content-type': 'image/png', 'content-length': String(body.length), ...(start ? { 'content-range': `bytes ${start}-${image.length - 1}/${image.length}` } : {}) };
      if (cut) { // the first transfer breaks halfway through
        cut = false;
        let sent = false;
        const stream = new ReadableStream({ pull(c) { if (sent) c.error(new TypeError('network lost')); else { sent = true; c.enqueue(body.subarray(0, 80000)); } } });
        return new Response(stream, { status: 200, headers });
      }
      return new Response(body, { status: start ? 206 : 200, headers });
    }
    if (url.endsWith('/images/jobs/op_fixture_4k')) return Response.json({ created: 1, data: [{ url: '/canvas-api/v1/images/jobs/op_fixture_4k/image', mime_type: 'image/png', bytes: image.length, width: 3840, height: 2160 }] });
    throw new Error('unexpected ' + url);
  } });
  const out = await session.api.waitImageJob('op_fixture_4k');
  const decoded = Uint8Array.from(atob(out.data[0].b64_json), c => c.charCodeAt(0));
  assert.deepEqual(decoded, image);
  assert.equal(out.data[0].url, undefined);
  assert.equal(out.data[0].width, 3840);
  assert.equal(calls.find(c => c.url.endsWith('/op_fixture_4k')).delivery, 'url');
  assert.deepEqual(calls.filter(c => c.url.endsWith('/image')).map(c => c.range), [undefined, 'bytes=80000-'], 'the second transfer resumes, not restarts');
});
