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
