// store.updateStoredProject CAS 合并回归：定向合并只写本节点 operation/result
// 字段与结果素材登记，不覆盖外部新稿/项目名，也不把旧项目结果写进新项目。
// 所有接口均为 mock，绝不发起真实付费请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';
import {createGenerators} from '../src/studio-gen.js';
import {setKey,clearKey,setAvailableModels} from '../src/keyvault.js';

const plain=()=>({append(){},remove(){},setAttribute(){},style:{}});
globalThis.document={createElement:plain,getElementById:plain};
const passthrough=(_n,fn)=>fn();
const init=async()=>{clearKey();await setKey('local-only-mock');setAvailableModels(['gpt-5.6-sol','gpt-image-2.5-flare']);};
const PNG_1PX='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

test('CAS-01 外部新稿之上只合并本节点操作/结果，不覆盖外部节点与项目名',async()=>{
  await init();
  const storage=createMemoryStorage(),a=createStore(storage);
  await a.newProject('原名');
  const n=a.addNode('text',0,0,{model:'gpt-5.6-sol',text:'测试',params:{max_tokens:8}});
  await a.flush();
  const b=createStore(storage);
  await b.openProject(a.project.id);
  b.project.name='外部改名';
  b.addNode('text',10,10,{text:'外部草稿'});
  await b.flush();                                   // 持久稿前进：a 的内存稿已成旧基线
  assert.equal(typeof a.updateStoredProject,'function','依赖新版 store 的 CAS 合并接口');
  const gen=createGenerators({store:a,storage,submitLock:passthrough,assets:{},
    api:{chatCompletion:async()=>({choices:[{message:{content:'已生成'}}]})}});
  await gen.generate(n);
  const doc=await storage.get(`project:${a.project.id}`);
  assert.equal(doc.name,'外部改名','定向合并不得用陈旧快照覆盖项目名');
  assert.ok(doc.nodes.some(x=>x.data?.text==='外部草稿'),'外部新增节点必须保留');
  const sn=doc.nodes.find(x=>x.id===n.id);
  assert.equal(sn?.data?.operation?.state,'completed');
  assert.equal(sn?.data?.resultText,'已生成');
  const rec=await storage.get(`op:${a.project.id}:${n.id}`);
  assert.equal(rec?.state,'completed','op: 独立记录仍是权威');
});

test('CAS-02 结果素材登记随结果字段写入原项目最新持久稿',async()=>{
  await init();
  const storage=createMemoryStorage(),a=createStore(storage);
  await a.newProject('图项目');
  const n=a.addNode('image',0,0,{model:'gpt-image-2.5-flare',prompt:'画',resolution:'1K',ratio:'1:1'});
  await a.flush();
  const b=createStore(storage);
  await b.openProject(a.project.id);
  b.project.assets['ext-1']={id:'ext-1',name:'ext.png',kind:'image',missing:false,size:1};
  b.addNode('text',5,5,{text:'外'});
  await b.flush();
  assert.equal(typeof a.updateStoredProject,'function','依赖新版 store 的 CAS 合并接口');
  const gen=createGenerators({store:a,storage,submitLock:passthrough,
    api:{imageGeneration:async()=>({data:[{b64_json:PNG_1PX}]})},
    decodeImage:async()=>({width:1,height:1}),
    assets:{registerBlob:async(blob,name,kind,extra={})=>{
      const rec={id:'gen-1',name,kind,mime:blob.type,size:blob.size,missing:false,...extra};
      a.project.assets[rec.id]=rec;                  // 真实 assets 行为：登记进当前项目内存稿
      await storage.setBlob(`blob:${rec.id}`,blob);
      return rec;}}});
  await gen.generate(n);
  const doc=await storage.get(`project:${a.project.id}`);
  const sn=doc.nodes.find(x=>x.id===n.id);
  assert.equal(sn?.data?.operation?.state,'completed');
  assert.equal(sn?.data?.resultAssetId,'gen-1');
  assert.deepEqual(sn?.data?.outputAssetIds,['gen-1']);
  assert.equal(doc.assets?.['gen-1']?.kind,'image','只写 resultAssetId 不够：素材登记记录必须进入持久稿');
  assert.ok(doc.assets?.['ext-1'],'外部登记的素材不得被合并冲掉');
  assert.ok(await storage.getBlob('blob:gen-1'),'素材 blob 留在共享存储');
});

test('CAS-03 请求期间切换项目：未确认事实合并进原项目持久稿，新项目不被污染',async()=>{
  await init();
  const storage=createMemoryStorage(),a=createStore(storage);
  await a.newProject('原项目');
  const n=a.addNode('text',0,0,{model:'gpt-5.6-sol',text:'测试',params:{max_tokens:8}});
  await a.flush();
  const pid=a.project.id;
  assert.equal(typeof a.updateStoredProject,'function','依赖新版 store 的 CAS 合并接口');
  const gen=createGenerators({store:a,storage,submitLock:passthrough,assets:{},
    api:{chatCompletion:async()=>{await a.newProject('新项目');return {choices:[{message:{content:'迟到的结果'}}]};}}});
  await assert.rejects(()=>gen.generate(n),/变更|未确认/);
  const oldDoc=await storage.get(`project:${pid}`);
  const sn=oldDoc?.nodes?.find(x=>x.id===n.id);
  assert.equal(sn?.data?.operation?.state,'unresolved','未确认事实必须落回原项目持久稿');
  assert.equal(sn?.data?.resultText,undefined,'迟到结果不得写回');
  assert.equal(a.project.name,'新项目');
  const keys=await storage.keys();
  assert.ok(!keys.some(k=>k.startsWith(`op:${a.project.id}:`)),'新项目命名空间不得出现旧请求操作记录');
  const newDoc=await storage.get(`project:${a.project.id}`).catch(()=>null);
  if(newDoc)assert.ok(!newDoc.nodes?.some(x=>x.data?.operation),'新项目文档不得写入旧操作记录');
  const rec=await storage.get(`op:${pid}:${n.id}`);
  assert.equal(rec?.state,'unresolved','原项目 op: 记录保持权威');
});
