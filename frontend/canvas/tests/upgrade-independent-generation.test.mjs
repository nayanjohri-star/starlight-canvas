import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';
import {createGenerators} from '../src/studio-gen.js';
import {setKey,clearKey,setAvailableModels,setModelCatalog,getModelCatalog,getAvailableModels} from '../src/keyvault.js';
import {ApiError} from '../src/api.js';
const plain=()=>({append(){},remove(){},setAttribute(){},style:{}});
globalThis.document={createElement:plain,getElementById:plain};
const init=async()=>{clearKey();await setKey('local-only-mock');setAvailableModels(['gpt-5.6-sol','gpt-image-2.5-flare']);};
const textNode=s=>s.addNode('text',0,0,{model:'gpt-5.6-sol',text:'测试',params:{max_tokens:8}});

test('独立验收：两个画布实例的旧内存快照不能重复发同一未知文本请求',async()=>{
  await init();const storage=createMemoryStorage(),a=createStore(storage);await a.newProject('双窗口');const n=textNode(a);await a.flush();const b=createStore(storage);await b.openProject(a.project.id);
  let queue=Promise.resolve(),calls=0;const lock=(_name,fn)=>{const result=queue.then(fn,fn);queue=result.catch(()=>{});return result;};
  const api={chatCompletion:async()=>{calls++;throw new ApiError(502,'mock','模拟未知结果');}};
  const x=createGenerators({store:a,storage,api,assets:{},submitLock:lock}),y=createGenerators({store:b,storage,api,assets:{},submitLock:lock});
  await Promise.allSettled([x.generate(n),y.generate(b.node(n.id))]);assert.equal(calls,1,'锁内必须重读持久化操作，不能只看各窗口内存');
  const saves=await Promise.allSettled([a.flush(),b.flush()]);
  for(const saved of saves)if(saved.status==='rejected')assert.equal(saved.reason.code,'rev_conflict','旧窗口只能以显式冲突拒绝保存，不能掩盖其他故障');
  const ops=await storage.keys();assert.equal(ops.filter(k=>k.startsWith(`op:${a.project.id}:`)).length,1,'只能保留一次请求的权威操作记录');
});

test('独立验收：最终结果记录落盘失败不能返回生成完成',async()=>{
  await init();const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('保存失败');const n=textNode(store);const original=storage.set;
  storage.set=async(k,v)=>{if(k.startsWith('project:')&&v.nodes?.some(x=>x.data?.operation?.state==='completed'))throw new Error('模拟完成记录磁盘已满');return original(k,v);};
  const gen=createGenerators({store,storage,api:{chatCompletion:async()=>({choices:[{message:{content:'已生成'}}]})},assets:{},submitLock:(_n,fn)=>fn()});
  await assert.rejects(()=>gen.generate(n),/保存|持久|记录|落盘|未确认/);storage.set=original;await store.flush();
});

test('独立验收：更换密钥后清除上一密钥模型目录和可见范围',async()=>{
  await init();setModelCatalog([{id:'old-private-model'}]);setAvailableModels(['old-private-model']);await setKey('different-local-mock');
  assert.equal(getModelCatalog(),null);assert.equal(getAvailableModels(),null);clearKey();
});

test('独立验收：图片解码期间切换项目不能把结果入库到新项目',async()=>{
  await init();const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('原项目');
  const n=store.addNode('image',0,0,{model:'gpt-image-2.5-flare',prompt:'测试画面',resolution:'1K',ratio:'1:1'});let registered=0;
  const gen=createGenerators({store,storage,submitLock:(_n,fn)=>fn(),
    api:{imageGeneration:async()=>({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}]})},
    decodeImage:async()=>{await store.newProject('切换后的项目');return {width:1,height:1};},
    assets:{registerBlob:async()=>{registered++;return{id:'wrong-project-result'};}}});
  await assert.rejects(()=>gen.generate(n),/项目|变更|未确认|保存/);assert.equal(registered,0,'不能在新的当前项目注册旧请求结果');assert.equal(store.project.name,'切换后的项目');await store.flush();
});
