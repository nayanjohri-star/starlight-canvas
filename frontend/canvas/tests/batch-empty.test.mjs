import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';
import {createWorkflow} from '../src/workflow.js';

const lock=async(_name,fn)=>fn();
async function setup(){const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('仅补空白验收');return{storage,store};}
const paid=(store,title,data={})=>store.addNode('text',0,0,{title,model:'mock-text',prompt:title,...data});
const videoBlob=()=>new Blob([new Uint8Array([0,0,0,0,102,116,121,112])],{type:'video/mp4'});

test('启动等待期间修改草稿：拒绝调用并保留之前的工作流记录',async()=>{
  const {store,storage}=await setup();const n=paid(store,'保留');
  const prior={id:'old-run',status:'done',rows:[],nodes:{}};
  store.project.studio={version:1,groups:[],shots:[],timeline:[],workflow:prior};await store.flush();let calls=0;
  const wf=createWorkflow({store,storage,submitLock:async(_name,fn)=>{n.data.prompt='等待锁时修改';return fn();},
    generators:{quote:()=>0.5,generate:async()=>{calls++;}}});
  await assert.rejects(wf.start({targets:[n.id],onlyEmpty:true,confirmed:true}),/画布已修改/);
  assert.equal(calls,0);assert.equal(store.project.studio.workflow,prior);
  assert.equal(n.data.prompt,'等待锁时修改');await store.flush();
});

test('onlyEmpty：上游已完成产出被复用且不重复计费，下游空节点照常执行',async()=>{
  const {store,storage}=await setup();
  const a=paid(store,'A',{resultText:'已写好',operation:{id:'op-a',state:'completed'}});
  const b=paid(store,'B');
  store.addEdge(a.id,'out',b.id,'prompt','text');
  const calls=[];
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:()=>0.5,generate:async n=>{calls.push(n.data.title);n.data.resultText=n.data.title;}}});
  await workflow.start({targets:[b.id],confirmed:true,onlyEmpty:true});
  const run=workflow.getState();
  assert.deepEqual(calls,['B'],'复用节点不重新生成');
  assert.equal(run.status,'done');
  assert.equal(run.nodes[a.id].status,'done');
  assert.equal(run.nodes[a.id].reused,true);
  assert.equal(run.nodes[a.id].cost,null,'复用不计价');
  assert.equal(a.data.resultText,'已写好','既有产出原样保留');
  assert.equal(run.estimatedSpendYuan,0.5,'估算消耗只计真实新工作');
  await store.flush();
});

test('onlyEmpty：未确认付费操作不按空节点重试，下游付费节点不启动',async()=>{
  const {store,storage}=await setup();
  const a=paid(store,'A',{operation:{id:'op-x',state:'unresolved',sentAt:Date.now()}});
  const b=paid(store,'B');
  store.addEdge(a.id,'out',b.id,'prompt','text');
  let calls=0;
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:()=>0.5,generate:async n=>{calls++;n.data.resultText='x';}}});
  await workflow.start({targets:[b.id],confirmed:true,onlyEmpty:true});
  const run=workflow.getState();
  assert.equal(calls,0,'未决节点与其下游都不产生付费调用');
  assert.equal(run.nodes[a.id].status,'blocked');
  assert.equal(run.nodes[a.id].reason,'unsettled');
  assert.equal(run.nodes[b.id].status,'skipped');
  assert.equal(run.estimatedSpendYuan,0);
  await store.flush();
});

test('onlyEmpty：在途视频任务按 resume 续跑——只查询/下载入库，零新增提交',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'task-inflight'}});
  let submits=0,downloads=0,polls=0;
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},
    recOf:async()=>({taskId:'task-inflight',status:++polls<2?'in_progress':'completed'}),
    download:async()=>{downloads++;const blob=videoBlob();await storage.setBlob('blob:v-done',blob);store.project.assets['v-done']={id:'v-done',kind:'video',name:'v.mp4',mime:'video/mp4',size:blob.size,fromTask:'task-inflight'};g.data.resultAssetId='v-done';return true;}};
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  const pre=await workflow.preview({targets:[g.id],onlyEmpty:true});
  assert.deepEqual(pre.resumeIds,[g.id],'在途任务列入续跑而非新跑/拦截');
  assert.equal(pre.skipSummary.resumed,1);assert.equal(pre.skipSummary.run,0);
  assert.equal(pre.estimatedYuan,0,'续跑不计入预估费用');
  await workflow.start({targets:[g.id],confirmed:true,onlyEmpty:true});
  const run=workflow.getState();
  assert.equal(submits,0,'绝不重新提交付费任务');
  assert.equal(downloads,1,'任务就绪后下载原成片入库');
  assert.equal(run.nodes[g.id].status,'done');
  assert.equal(run.nodes[g.id].resumed,true);
  assert.equal(run.status,'done');
  await store.flush();
});

test('onlyEmpty：已入库的视频成片直接复用，不重新提交任务',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'task-done'},resultAssetId:'v1'});
  const local=videoBlob();await storage.setBlob('blob:v1',local);
  store.project.assets['v1']={id:'v1',kind:'video',name:'v.mp4',mime:'video/mp4',size:local.size,fromTask:'task-done'};
  let submits=0;
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},recOf:async()=>({taskId:'task-done',status:'completed'}),download:async()=>true};
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner,
    assets:{blobOf:async id=>id==='v1'?local:null}});
  await workflow.start({targets:[g.id],confirmed:true,onlyEmpty:true});
  const run=workflow.getState();
  assert.equal(submits,0);
  assert.equal(run.nodes[g.id].status,'done');
  assert.equal(run.nodes[g.id].reused,true);
  await store.flush();
});

test('onlyEmpty：曾完成但本地产出失效的节点被拦截而非重新扣费',async()=>{
  const {store,storage}=await setup();
  const img=store.addNode('image',0,0,{model:'mock-image',operation:{id:'op-i',state:'completed'},resultAssetId:'gone'});
  let calls=0;
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:()=>0.2,generate:async()=>{calls++;}}});
  await workflow.start({targets:[img.id],confirmed:true,onlyEmpty:true});
  const run=workflow.getState();
  assert.equal(calls,0,'失效产出不当空节点重试');
  assert.equal(run.nodes[img.id].status,'blocked');
  assert.equal(run.nodes[img.id].reason,'invalid-output');
  await store.flush();
});

test('onlyEmpty：素材元数据存在但本地实体缺失同样不算可复用产出',async()=>{
  const {store,storage}=await setup();
  const img=store.addNode('image',0,0,{model:'mock-image',operation:{id:'op-i',state:'completed'},resultAssetId:'a1'});
  store.project.assets['a1']={id:'a1',kind:'image',name:'x.png',missing:false,size:10};
  let calls=0;
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    assets:{blobOf:async()=>null},
    generators:{quote:()=>0.2,generate:async()=>{calls++;}}});
  await workflow.start({targets:[img.id],confirmed:true,onlyEmpty:true});
  assert.equal(calls,0,'只验证 metadata.missing=false 不足以复用');
  assert.equal(workflow.getState().nodes[img.id].status,'blocked');
  await store.flush();
});

test('onlyEmpty 预检：报告范围/新跑/复用/拦截且预估只含新工作',async()=>{
  const {store,storage}=await setup();
  const a=paid(store,'A',{resultText:'ok',operation:{id:'o',state:'completed'}});
  const b=paid(store,'B');
  const c=paid(store,'C',{operation:{id:'o2',state:'unresolved',sentAt:1}});
  const d=store.addNode('text',0,0,{title:'D',text:'本地内容'});
  store.addEdge(a.id,'out',b.id,'prompt','text');
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:n=>n.data.model?0.3:0,generate:async()=>{}}});
  const pre=await workflow.preview({targets:[b.id,c.id,d.id],onlyEmpty:true});
  assert.equal(pre.onlyEmpty,true);
  assert.deepEqual([...pre.scope.selected].sort(),[b.id,c.id,d.id].sort());
  assert.ok(pre.scope.nodeIds.includes(a.id),'范围含必需上游依赖');
  assert.ok(pre.reusedIds.includes(a.id));
  assert.ok(pre.runIds.includes(b.id)&&pre.runIds.includes(d.id));
  assert.ok(pre.blockedIds.includes(c.id));
  assert.equal(pre.skipSummary.reused,1);
  assert.equal(pre.skipSummary.blocked,1);
  assert.equal(pre.skipSummary.paid,1);
  assert.equal(pre.estimatedYuan,0.3,'预估费用只计真正会新跑的付费节点');
  await store.flush();
});

test('onlyEmpty 与批量行互斥：明确拒绝而不是改变语义',async()=>{
  const {store,storage}=await setup();
  const a=paid(store,'A');
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:()=>1,generate:async()=>{}}});
  await assert.rejects(()=>workflow.preview({targets:[a.id],rows:[{x:'1'}],onlyEmpty:true}),/批量/);
  await assert.rejects(()=>workflow.start({targets:[a.id],rows:[{x:'1'}],onlyEmpty:true,confirmed:true}),/批量/);
  await store.flush();
});

test('未开启 onlyEmpty 时行为不变：既有产出节点照常重跑',async()=>{
  const {store,storage}=await setup();
  const a=paid(store,'A',{resultText:'old',operation:{id:'o',state:'completed'}});
  let calls=0;
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:()=>0.1,generate:async n=>{calls++;n.data.resultText='new';}}});
  await workflow.start({targets:[a.id],confirmed:true});
  assert.equal(calls,1,'默认路径不受 onlyEmpty 影响');
  assert.equal(a.data.resultText,'new');
  await store.flush();
});

test('onlyEmpty：被复用的上游产出在运行中变更即暂停，绝不静默重生成',async()=>{
  const {store,storage}=await setup();
  const a=paid(store,'A',{resultText:'V1',operation:{id:'o',state:'completed'}});
  const m=paid(store,'M');
  const c=paid(store,'C');
  store.addEdge(a.id,'out',m.id,'prompt','text');
  store.addEdge(m.id,'out',c.id,'prompt','text');
  store.addEdge(a.id,'out',c.id,'prompt','text');
  const calls=[];
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:()=>0.1,generate:async n=>{
      calls.push(n.data.title);
      if(n.data.title==='M')a.data.resultText='V2';
      n.data.resultText=n.data.title;
    }}});
  await workflow.start({targets:[m.id,c.id],confirmed:true,onlyEmpty:true});
  let run=workflow.getState();
  assert.equal(run.status,'paused','复用产出变更必须暂停而非继续消费');
  assert.deepEqual(calls,['M'],'下游在快照复核前不得发起付费调用');
  assert.equal(run.nodes[a.id].reused,true,'被复用节点自身不重生成');
  a.data.resultText='V1';
  await workflow.resume();
  run=workflow.getState();
  assert.equal(run.status,'done');
  assert.deepEqual(calls,['M','C']);
  assert.equal(run.estimatedSpendYuan,0.2);
  await store.flush();
});

test('onlyEmpty：新跑节点报价未知仍被拦截，未知报价不等于免费',async()=>{
  const {store,storage}=await setup();
  const a=paid(store,'A');
  let calls=0;
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:()=>null,generate:async()=>{calls++;}}});
  await workflow.start({targets:[a.id],confirmed:true,onlyEmpty:true,budgetYuan:0});
  assert.equal(calls,0);
  assert.equal(workflow.getState().nodes[a.id].status,'blocked');
  await store.flush();
});

test('onlyEmpty：上游新跑失败即阻断下游，不启动任何后续付费节点',async()=>{
  const {store,storage}=await setup();
  const a=paid(store,'A'),b=paid(store,'B'),c=paid(store,'C');
  store.addEdge(a.id,'out',b.id,'prompt','text');store.addEdge(b.id,'out',c.id,'prompt','text');
  const calls=[];
  const workflow=createWorkflow({store,storage,submitLock:lock,pollMs:1,
    generators:{quote:()=>1,generate:async n=>{calls.push(n.data.title);if(n.data.title==='A')throw new Error('模拟失败');n.data.resultText='x';}}});
  await workflow.start({targets:[c.id],confirmed:true,onlyEmpty:true});
  assert.deepEqual(calls,['A']);
  const run=workflow.getState();
  assert.equal(run.nodes[b.id].status,'skipped');
  assert.equal(run.nodes[c.id].status,'skipped');
  await store.flush();
});

test('只有付费文本输入不是生成结果；丢失输出无 operation 也不得当空白收费',async()=>{
 const {store,storage}=await setup();const a=paid(store,'A',{text:'请回答问题'}),b=store.addNode('image',0,0,{model:'image',resultAssetId:'lost'});
 const calls=[];const wf=createWorkflow({store,storage,submitLock:lock,generators:{quote:()=>.1,generate:async n=>{calls.push(n.id);n.data.resultText='真实输出';}}});
 await wf.start({targets:[a.id,b.id],onlyEmpty:true,confirmed:true});assert.deepEqual(calls,[a.id]);assert.equal(wf.getState().nodes[b.id].status,'blocked');
});

test('视频旧产出不得冒充新的在途任务；同大小素材变更暂停消费者',async()=>{
 const {store,storage}=await setup();const n=store.addNode('gen',0,0,{run:{taskId:'new-task'},resultAssetId:'v'});
 store.project.assets.v={id:'v',kind:'video',mime:'video/mp4',size:8,fromTask:'old-task'};
 const wf=createWorkflow({store,storage,submitLock:lock,runner:{recOf:async()=>({status:'running'})},assets:{blobOf:async()=>videoBlob()}});
 const pre=await wf.preview({targets:[n.id],onlyEmpty:true});assert.deepEqual(pre.blockedIds,[n.id]);
 const a=store.addNode('image',0,0,{model:'image',resultAssetId:'a'}),b=store.addNode('image',0,0,{model:'image',title:'B'}),c=store.addNode('image',0,0,{model:'image',title:'C'});
 store.project.assets.a={id:'a',kind:'image',size:3};assert.ok(store.addEdge(a.id,'out',b.id,'refs','image'));assert.ok(store.addEdge(b.id,'out',c.id,'refs','image'));assert.ok(store.addEdge(a.id,'out',c.id,'refs','image'));
 const calls=[];const next=createWorkflow({store,storage,submitLock:lock,assets:{blobOf:async()=>new Blob(['123'])},generators:{quote:()=>.1,generate:async n=>{calls.push(n.id);store.project.assets.a.contentRevision='rebound';n.data.resultAssetId='new-result';store.project.assets['new-result']={id:'new-result',kind:'image',size:3};}}});
 await next.start({targets:[c.id],onlyEmpty:true,confirmed:true});assert.deepEqual(calls,[b.id]);assert.equal(next.getState().status,'paused');
});
