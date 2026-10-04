import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';
import {createWorkflow} from '../src/workflow.js';
import {setCapabilities} from '../src/capabilities.js';

// 合成能力表：只让测试型号 'm' 可估价（request 计费 ¥0.5/次），不依赖共享表
setCapabilities({models:{m:{billing_unit:'request',price_cny_per_request:0.5}}});

// WO-B1a 验收：workflow.waitTask/retryRow/classifyOnlyEmpty 统一消费 task-status.js 谓词。
// 旧实现把 completed+delivering 误判 failed、对 v2 completed+contentReady!==true 提前下载。

const lock=async(_name,fn)=>fn();
async function setup(){const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('统一终态验收');return{storage,store};}
const paidText=(store,title,data={})=>store.addNode('text',0,0,{title,model:'mock-text',prompt:title,...data});
const videoBlob=()=>new Blob([new Uint8Array([0,0,0,0,102,116,121,112,0,0,0,0])],{type:'video/mp4'});
const attach=async(storage,store,node,taskId,aid)=>{const blob=videoBlob();await storage.setBlob('blob:'+aid,blob);store.project.assets[aid]={id:aid,kind:'video',name:aid+'.mp4',mime:'video/mp4',size:blob.size,fromTask:taskId};node.data.resultAssetId=aid;};

test('waitTask：completed+delivering 不是终态，继续轮询直到可交付后下载入库',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-delivering'}});
  let polls=0,downloads=0,submits=0;
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},
    recOf:async()=>({taskId:'t-delivering',status:'completed',deliveryStatus:++polls<3?'delivering':undefined}),
    download:async()=>{downloads++;await attach(storage,store,g,'t-delivering','v1');return true;}};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  await wf.start({targets:[g.id],confirmed:true});
  const run=wf.getState();
  assert.equal(submits,0,'不重新提交');
  assert.equal(downloads,1,'交付完成后才下载');
  assert.ok(polls>=3,'delivering 期间持续等待而非判失败');
  assert.equal(run.nodes[g.id].status,'done');
  assert.equal(run.status,'done');
  await store.flush();
});

test('waitTask：v2 completed+contentReady=false 不下载不判失败，就绪翻转后下载成功',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-v2'}});
  let polls=0,downloads=0,submits=0;
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},
    recOf:async()=>({taskId:'t-v2',status:'completed',executorVersion:2,contentReady:++polls>=3}),
    download:async()=>{downloads++;await attach(storage,store,g,'t-v2','v2');return true;}};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  await wf.start({targets:[g.id],confirmed:true});
  const run=wf.getState();
  assert.equal(submits,0);
  assert.equal(downloads,1,'contentReady 翻转前不得下载');
  assert.ok(polls>=3,'未就绪期间继续等待');
  assert.equal(run.nodes[g.id].status,'done');
  assert.equal(run.status,'done');
  await store.flush();
});

test('waitTask：受损 v2 记录（缺 executorVersion 带特征字段）同样按 v2 门槛等待',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-v2damaged'}});
  let polls=0,downloads=0;
  const runner={adoptDurable:async()=>{},submit:async()=>{throw new Error('不得提交');},
    recOf:async()=>({taskId:'t-v2damaged',status:'completed',stage:'finalizing',contentReady:++polls>=2}),
    download:async()=>{downloads++;await attach(storage,store,g,'t-v2damaged','v3');return true;}};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  await wf.start({targets:[g.id],confirmed:true});
  assert.equal(downloads,1);
  assert.equal(wf.getState().nodes[g.id].status,'done');
  await store.flush();
});

test('waitTask：终态 failed → 行失败且零新增提交、零下载',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-failed'}});
  let submits=0,downloads=0;
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},
    recOf:async()=>({taskId:'t-failed',status:'failed',error:{message:'上游拒绝'}}),
    download:async()=>{downloads++;return true;}};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  await wf.start({targets:[g.id],confirmed:true});
  const run=wf.getState();
  assert.equal(submits,0);
  assert.equal(downloads,0);
  assert.equal(run.nodes[g.id].status,'failed');
  assert.match(run.nodes[g.id].error,/任务failed/);
  assert.equal(run.status,'failed');
  await store.flush();
});

test('waitTask+retryRow：交付失败保持 delivery 语义，重试只走下载入库、零 POST 零脱离',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-delivery'}});
  let submits=0,downloads=0,detaches=0;
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},detach:async()=>{detaches++;},
    recOf:async()=>({taskId:'t-delivery',status:'completed'}),
    download:async()=>{downloads++;if(downloads===1)return false;await attach(storage,store,g,'t-delivery','v4');return true;}};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  await wf.start({targets:[g.id],confirmed:true});
  let run=wf.getState();
  assert.equal(run.nodes[g.id].status,'failed');
  assert.equal(run.nodes[g.id].reason,'delivery','交付失败不等于生成失败');
  await wf.retryRow(run.rows[0].id);
  run=wf.getState();
  assert.equal(submits,0,'重试不得新增付费 POST');
  assert.equal(detaches,0,'不得脱离已付费任务');
  assert.equal(downloads,2,'重试只再次下载入库');
  assert.equal(run.nodes[g.id].status,'done');
  assert.equal(run.status,'done');
  await store.flush();
});

test('retryRow：v2 任务交付回退未就绪时保留身份等待，不脱离不重发',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-v2retry'}});
  let submits=0,downloads=0,detaches=0,np=0;
  let phase='ready';   // ready(首轮可交付) → notready(服务端回退重新交付) → ready
  const rec=ready=>({taskId:'t-v2retry',status:'completed',executorVersion:2,contentReady:ready});
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},detach:async()=>{detaches++;},
    recOf:async()=>{
      if(phase==='ready')return rec(true);
      if(++np>=3){phase='ready';return rec(true);}
      return rec(false);
    },
    download:async()=>{downloads++;if(downloads===1)return false;await attach(storage,store,g,'t-v2retry','v5');return true;}};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  await wf.start({targets:[g.id],confirmed:true});
  let run=wf.getState();
  assert.equal(run.nodes[g.id].status,'failed');
  assert.equal(run.nodes[g.id].reason,'delivery');
  assert.equal(downloads,1);
  // 服务端把任务回退为未就绪重新交付：显式重试必须保留任务身份、继续等待而非脱离重发
  phase='notready';
  await wf.retryRow(run.rows[0].id);
  run=wf.getState();
  assert.equal(submits,0,'零新增付费 POST');
  assert.equal(detaches,0,'未就绪任务不得脱离');
  assert.equal(downloads,2,'再次就绪后只走下载入库');
  assert.equal(run.nodes[g.id].status,'done');
  assert.equal(run.status,'done');
  await store.flush();
});

test('retryRow：终态失败任务显式重试才允许脱离重发',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-old-failed'}});
  let submits=0,detaches=0;
  const runner={adoptDurable:async()=>{},detach:async n=>{detaches++;n.data.run=null;return true;},
    recOf:async id=>({taskId:id,status:'failed'}),
    submit:async n=>{submits++;n.data.run={taskId:'t-new'};},
    download:async()=>{await attach(storage,store,g,'t-new','v6');return true;}};
  // 新任务提交后按 taskId 返回 completed
  const base=runner.recOf;
  runner.recOf=async id=>id==='t-new'?{taskId:'t-new',status:'completed'}:base(id);
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  await wf.start({targets:[g.id],confirmed:true});
  assert.equal(wf.getState().nodes[g.id].status,'failed');
  await wf.retryRow(wf.getState().rows[0].id);
  const run=wf.getState();
  assert.equal(detaches,1,'显式重试才脱离失败任务');
  assert.equal(submits,1,'脱离后允许一次新的付费提交');
  assert.equal(run.nodes[g.id].status,'done');
  await store.flush();
});

test('混合批次：成片复用+在途续跑+空白新跑+未决拦截同批',async()=>{
  const {store,storage}=await setup();
  // 成片复用：本地素材可验证且归属该任务
  const g1=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-done'},resultAssetId:'v-done'});
  const reusable=videoBlob();
  await storage.setBlob('blob:v-done',reusable);
  store.project.assets['v-done']={id:'v-done',kind:'video',name:'v.mp4',mime:'video/mp4',size:reusable.size,fromTask:'t-done'};
  // 在途续跑：无本地产出，任务仍在跟踪 → 就绪后下载
  const g2=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-fly'}});
  // 空白新跑：付费文本节点
  const b=paidText(store,'B');
  // 未决拦截 + 依赖拦截
  const u=paidText(store,'U',{operation:{id:'op-u',state:'unresolved',sentAt:1}});
  const dep=paidText(store,'DEP');
  store.addEdge(u.id,'out',dep.id,'prompt','text');
  let submits=0,downloads=0,flyPolls=0;
  const calls=[];
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},
    recOf:async id=>{
      if(id==='t-done')return{taskId:'t-done',status:'completed'};
      if(id==='t-fly')return{taskId:'t-fly',status:++flyPolls<3?'in_progress':'completed'};
      return null;
    },
    download:async id=>{downloads++;await attach(storage,store,g2,id,'v-fly');return true;}};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner,
    assets:{blobOf:async id=>id==='v-done'?reusable:null},
    generators:{quote:n=>n.data.model?0.5:0,generate:async n=>{calls.push(n.id);n.data.resultText='ok';}}});
  const targets=[g1.id,g2.id,b.id,u.id,dep.id];
  const pre=await wf.preview({targets,onlyEmpty:true});
  assert.deepEqual(pre.reusedIds,[g1.id],'成片归属核验通过 → 复用');
  assert.deepEqual(pre.resumeIds,[g2.id],'在途任务 → 续跑');
  assert.deepEqual(pre.runIds,[b.id],'空白节点 → 新跑');
  assert.deepEqual([...pre.blockedIds].sort(),[u.id,dep.id].sort(),'未决节点及其依赖 → 拦截');
  assert.equal(pre.skipSummary.resumed,1);
  assert.equal(pre.skipSummary.reused,1);
  assert.equal(pre.skipSummary.blocked,2);
  assert.equal(pre.skipSummary.paid,1,'估价只计 run 付费节点');
  assert.equal(pre.estimatedYuan,0.5,'续跑与复用不计费');
  await wf.start({targets,confirmed:true,onlyEmpty:true});
  const run=wf.getState();
  assert.equal(submits,0,'在途任务零新增 POST');
  assert.equal(downloads,1,'续跑只下载原成片');
  assert.deepEqual(calls,[b.id],'只有空白节点发起付费调用');
  assert.equal(run.nodes[g1.id].reused,true);
  assert.equal(run.nodes[g2.id].resumed,true);
  assert.equal(run.nodes[g2.id].status,'done');
  assert.equal(run.nodes[u.id].status,'blocked');
  assert.equal(run.nodes[dep.id].status,'skipped','依赖被拦节点不得执行');
  assert.equal(run.estimatedSpendYuan,0.5,'只计真实新工作');
  await store.flush();
});

test('onlyEmpty：任务记录缺席按 blocked 处理，不静默重发',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-gone'}});
  let submits=0;
  const runner={adoptDurable:async()=>{},submit:async()=>{submits++;},recOf:async()=>null,download:async()=>true};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  const pre=await wf.preview({targets:[g.id],onlyEmpty:true});
  assert.deepEqual(pre.blockedIds,[g.id],'记录缺席无法核验 → 拦截');
  await wf.start({targets:[g.id],confirmed:true,onlyEmpty:true});
  assert.equal(submits,0);
  assert.equal(wf.getState().nodes[g.id].status,'blocked');
  await store.flush();
});

// ---------- G3 审查回归（A 审 B）----------

test('retryRow：runner 无 recOf 查询接口时不可核验 → 不脱离不重发（m2 回归）',async()=>{
  const {store,storage}=await setup();
  const g=store.addNode('gen',0,0,{draft:{model:'m',seconds:5},run:{taskId:'t-unverifiable'}});
  let detaches=0,submits=0;
  // 故意不带 recOf：任务状态完全不可核验。修复前 !canQuery 分支会绕过核验直接 detach+重发
  const runner={adoptDurable:async()=>{},
    submit:async n=>{submits++;n.data.run={taskId:'t-new'};},
    detach:async n=>{detaches++;n.data.run=null;return true;},
    download:async()=>true};
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner});
  await wf.start({targets:[g.id],confirmed:true});
  assert.equal(wf.getState().nodes[g.id].status,'failed','waitTask 前置检查：查询接口缺席即失败');
  await wf.retryRow(wf.getState().rows[0].id);
  assert.equal(detaches,0,'不可核验时不得脱离原任务');
  assert.equal(submits,0,'不可核验时不得重发付费提交');
  assert.equal(wf.getState().nodes[g.id].status,'failed','保持失败等人工处理');
  await store.flush();
});
