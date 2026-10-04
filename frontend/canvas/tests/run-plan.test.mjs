// WO-B3 冻结运行计划（§6.2）：preview 签发 plan → start({plan}) 逐项核验执行。
// 核验面：对象身份（WeakMap）、projectId、keyFp、sig（节点草稿+连线+素材状态）、
// estimateVersion（能力表/计费字段）、一次性消费；任一变化即拒绝并提示重新预览。

import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';
import {createWorkflow} from '../src/workflow.js';
import {setCapabilities} from '../src/capabilities.js';
import {setKey, clearKey} from '../src/keyvault.js';

const lock=async(_name,fn)=>fn();
async function setup(){
  const storage=createMemoryStorage(),store=createStore(storage);
  await store.newProject('冻结计划验收');
  return{storage,store};
}
const paidText=(store,title,data={})=>store.addNode('text',0,0,{title,model:'mock-text',prompt:title,...data});
const genNode=(store,data={})=>store.addNode('gen',0,0,{draft:{model:'m',seconds:5},...data});
const runner=()=>({adoptDurable:async()=>{},submit:async n=>{n.data.run={taskId:'t1'};},
  recOf:async()=>({taskId:'t1',status:'completed'}),download:async()=>true});
const gens=()=>({quote:()=>0.5,generate:async n=>{n.data.resultText='ok';}});
const TABLE=()=>({models:{m:{billing_unit:'request',price_cny_per_request:0.5}}});

test('preview 签发冻结 plan：合同字段齐备，scope 按 targets 推断为 selection',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),generators:gens()});
  const pre=await wf.preview({targets:[n.id],budgetYuan:5});
  const p=pre.plan;
  assert.ok(p,'preview 必须附带 plan');
  assert.equal(typeof p.id,'string');
  assert.equal(p.projectId,store.project.id);
  assert.equal(p.keyFp,null,'无密钥时 keyFp 为 null');
  assert.equal(p.scope.kind,'selection');
  assert.deepEqual(p.scope.ids,[n.id]);
  assert.deepEqual(p.nodeIds,[n.id]);
  assert.equal(typeof p.sig,'string');
  assert.equal(p.rows,null);
  assert.equal(p.budgetYuan,5);
  assert.equal(p.onlyEmpty,false);
  assert.equal(p.estimatedYuan,pre.estimatedYuan);
  assert.equal(p.priceKind,pre.priceKind);
  assert.equal(typeof p.estimateVersion,'string');
  assert.ok(p.createdAt>0);
  await store.flush();
});

test('start({plan}) 按计划执行；同一 plan 重复提交被拒',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const calls=[];
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),
    generators:{quote:()=>0.5,generate:async x=>{calls.push(x.id);x.data.resultText='ok';}}});
  const pre=await wf.preview({targets:[n.id]});
  const res=await wf.start({plan:pre.plan,confirmed:true});
  assert.equal(res.status,'done');
  assert.deepEqual(calls,[n.id],'计划节点被真实执行');
  assert.deepEqual(res.targets,[n.id]);
  await assert.rejects(()=>wf.start({plan:pre.plan,confirmed:true}),/已提交执行|重新预览/,'同 plan 不得二次启动');
  await store.flush();
});

test('scope.kind=selection 空 ids → 拒绝；kind=all 显式全画布',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  paidText(store,'A');paidText(store,'B');
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),generators:gens()});
  await assert.rejects(()=>wf.preview({scope:{kind:'selection',ids:[]}}),/空选择不启动/);
  await assert.rejects(()=>wf.preview({scope:{kind:'group',ids:[]}}),/空选择不启动/);
  await assert.rejects(()=>wf.preview({scope:{kind:'bogus',ids:['x']}}),/未知运行范围/);
  const pre=await wf.preview({scope:{kind:'all',ids:[]}});
  assert.equal(pre.plan.scope.kind,'all');
  assert.equal(pre.nodeIds.length,2,'all 覆盖全部可执行节点');
  await store.flush();
});

test('scope.kind=group：nodeIds = 成员 + orderedGraph 必需上游闭包',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const a=paidText(store,'上游A');
  const b=store.addNode('gen',0,0,{draft:{model:'m',seconds:5}});
  const c=paidText(store,'下游C');
  store.addEdge(a.id,'out',b.id,'prompt','text');
  store.addEdge(b.id,'out',c.id,'prompt','text');
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),generators:gens()});
  // group 成员 = [b,c]：b 的必需上游 a 被闭包拉入，a→b→c 拓扑有序
  const pre=await wf.preview({scope:{kind:'group',ids:[b.id,c.id]}});
  assert.equal(pre.plan.scope.kind,'group');
  assert.deepEqual(pre.plan.scope.ids,[b.id,c.id],'scope.ids 保留成员而非闭包');
  assert.deepEqual(pre.nodeIds,[a.id,b.id,c.id],'必需上游闭包被拉入且拓扑有序');
  await store.flush();
});

test('plan 失效：改节点草稿/加连线/切项目/换密钥/换能力表 → start 逐项拒绝',async()=>{
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),generators:gens()});
  setCapabilities(TABLE());
  // 1) 节点草稿变更 → sig 失效
  let pre=await wf.preview({targets:[n.id]});
  store.updateNodeData(n.id,{prompt:'changed'});
  await assert.rejects(()=>wf.start({plan:pre.plan,confirmed:true}),/已修改|重新预览/);
  // 2) 新增外部连线到计划节点 → sig 失效（必需上游可能已变）
  pre=await wf.preview({targets:[n.id]});
  const src=paidText(store,'SRC');
  store.addEdge(src.id,'out',n.id,'prompt','text');
  await assert.rejects(()=>wf.start({plan:pre.plan,confirmed:true}),/已修改|重新预览/);
  store.removeEdge(store.project.edges.find(e=>e.to.node===n.id).id);
  // 3) 密钥变更 → keyFp 失效
  pre=await wf.preview({targets:[n.id]});
  await setKey('key-alpha');
  await assert.rejects(()=>wf.start({plan:pre.plan,confirmed:true}),/密钥已变更/);
  // 4) 能力表/计费字段变更 → estimateVersion 失效
  pre=await wf.preview({targets:[n.id]});
  setCapabilities({models:{m:{billing_unit:'request',price_cny_per_request:0.9}}});
  await assert.rejects(()=>wf.start({plan:pre.plan,confirmed:true}),/估价依据|重新预览/);
  setCapabilities(TABLE());
  await clearKey();
  await store.flush();
});

test('plan 失效：项目切换 → 拒绝；伪造 plan 对象 → 拒绝',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),generators:gens()});
  const pre=await wf.preview({targets:[n.id]});
  await assert.rejects(()=>wf.start({plan:{...pre.plan},confirmed:true}),/无效或已过期/,'克隆对象非签发令牌');
  await assert.rejects(()=>wf.start({plan:'not-a-plan',confirmed:true}),/无效或已过期/);
  // 切项目后 plan 失效
  const pre2=await wf.preview({targets:[n.id]});
  await store.newProject('另一个项目');
  await assert.rejects(()=>wf.start({plan:pre2.plan,confirmed:true}),/项目已切换/);
  await store.flush();
});

test('plan.rows 冻结：预览后的批量行不被调用方后续改动影响',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const calls=[];
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),
    generators:{quote:()=>0.5,generate:async x=>{calls.push(x.id);x.data.resultText='ok';}}});
  const rows=[{f:'一'},{f:'二'}];
  const pre=await wf.preview({targets:[n.id],rows});
  assert.equal(pre.plan.rows.length,2);
  rows.push({f:'三'});   // 调用方改动入参不影响已冻结计划
  const res=await wf.start({plan:pre.plan,confirmed:true});
  assert.equal(res.rows.length,2,'按冻结的 2 行执行');
  assert.equal(calls.length,2);
  await store.flush();
});

test('无 plan 旧调用保持兼容：targets 路径照常启动',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const calls=[];
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),
    generators:{quote:()=>0.5,generate:async x=>{calls.push(x.id);x.data.resultText='ok';}}});
  const res=await wf.start({targets:[n.id],confirmed:true});
  assert.equal(res.status,'done');
  assert.deepEqual(calls,[n.id]);
  await store.flush();
});

// ---------- G3 审查回归（A 审 B）----------

test('start({scope}) 无 plan 路径：selection/group/all 与 preview 同解析不误拒（M1 回归）',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const a=paidText(store,'上游A');
  const c=paidText(store,'下游C');
  store.addEdge(a.id,'out',c.id,'prompt','text');
  const calls=[];
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),
    generators:{quote:()=>0.5,generate:async x=>{calls.push(x.id);x.data.resultText='ok';}}});
  // selection：ids 为选中集，nodeIds 含必需上游闭包——修复前 sig0 按 targets(空→all) 推导必误拒
  const r1=await wf.start({scope:{kind:'selection',ids:[c.id]},confirmed:true});
  assert.equal(r1.status,'done','scope.selection 不得被签名守卫误拒');
  assert.deepEqual(r1.targets,[a.id,c.id],'selection 命中必需上游闭包');
  // group：同闭包语义
  const r2=await wf.start({scope:{kind:'group',ids:[c.id]},confirmed:true});
  assert.equal(r2.status,'done','scope.group 不得误拒');
  // all：显式全画布
  const r3=await wf.start({scope:{kind:'all'},confirmed:true});
  assert.equal(r3.status,'done','scope.all 不得误拒');
  await store.flush();
});

test('无 plan 路径守卫不弱化：启动等待期间画布变更仍拒（M1 回归·反向）',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),generators:gens()});
  // xlock 内 storage.get 是守卫前最后的异步窗口——在那里改画布，guard 必须拦下
  const origGet=storage.get.bind(storage);
  let armed=true;
  storage.get=async k=>{const v=await origGet(k);if(armed){armed=false;store.updateNodeData(n.id,{prompt:'tampered'});}return v;};
  try{
    await assert.rejects(()=>wf.start({targets:[n.id],confirmed:true}),/已修改|重新预览/);
  }finally{storage.get=origGet;}
  await store.flush();
});

test('plan 路径守卫：启动等待期间换能力表 → 按估价版本拒绝（m5 回归）',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),generators:gens()});
  const pre=await wf.preview({targets:[n.id]});
  // 入口核验通过后才换表：模拟确认/启动锁等待期间的估价依据变化
  const origGet=storage.get.bind(storage);
  let armed=true;
  storage.get=async k=>{const v=await origGet(k);if(armed){armed=false;setCapabilities({models:{m:{billing_unit:'request',price_cny_per_request:0.9}}});}return v;};
  try{
    await assert.rejects(()=>wf.start({plan:pre.plan,confirmed:true}),/估价依据|能力表|重新预览/);
  }finally{storage.get=origGet;setCapabilities(TABLE());}
  await store.flush();
});

test('plan.rows 深冻结：调用方改嵌套字段值不渗透已签发计划（m4 回归）',async()=>{
  setCapabilities(TABLE());
  const {store,storage}=await setup();
  const n=paidText(store,'N');
  const wf=createWorkflow({store,storage,submitLock:lock,pollMs:1,runner:runner(),generators:gens()});
  const rows=[{f:'一',nested:{v:1}}];
  const pre=await wf.preview({targets:[n.id],rows});
  rows[0].nested.v=999;          // 浅拷贝下此处会同步改写已签发计划
  assert.equal(pre.plan.rows[0].nested.v,1,'嵌套字段值必须与调用方对象断引用');
  await store.flush();
});
