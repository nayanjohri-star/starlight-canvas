import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createWorkflow } from '../src/workflow.js';

async function fixture(generators){const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('工作流独立验收');return {store,storage,workflow:createWorkflow({store,storage,generators,submitLock:async(_name,fn)=>fn(),pollMs:1})};}
const add=(s,title)=>s.addNode('text',0,0,{title,model:'mock-text',prompt:title});

test('独立验收：未知费用的付费节点不得以零元穿过预算闸门',async()=>{
  let calls=0;const {store,workflow}=await fixture({quote:()=>null,generate:async n=>{calls++;n.data.resultText='result';}});
  const n=add(store,'未知价');try{await workflow.start({targets:[n.id],budgetYuan:0,confirmed:true});}catch{}
  assert.equal(calls,0,'未知不等于免费，尤其不能突破0元预算');await store.flush();
});

test('独立验收：暂停后恢复从当前行未完成节点继续，不跳过整行',async()=>{
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),calls=[];
  const {store,workflow}=await fixture({quote:()=>1,generate:async n=>{calls.push(n.data.title);if(n.data.title==='A'){entered();await gate;}n.data.resultText=n.data.title;}});
  const a=add(store,'A'),b=add(store,'B');store.addEdge(a.id,'out',b.id,'prompt','text');
  const started=workflow.start({targets:[b.id],confirmed:true});await ready;await workflow.pause();release();await started;
  await workflow.resume();assert.deepEqual(calls,['A','B']);assert.equal(workflow.getState().status,'done');await store.flush();
});

test('独立验收：上游失败必须阻止所有后继付费节点，不能隔一层又继续执行',async()=>{
  const calls=[];const {store,workflow}=await fixture({quote:()=>1,generate:async n=>{calls.push(n.data.title);if(n.data.title==='A')throw new Error('模拟失败');n.data.resultText=n.data.title;}});
  const a=add(store,'A'),b=add(store,'B'),c=add(store,'C');store.addEdge(a.id,'out',b.id,'prompt','text');store.addEdge(b.id,'out',c.id,'prompt','text');
  await workflow.start({targets:[c.id],confirmed:true});assert.deepEqual(calls,['A']);assert.equal(workflow.getState().status,'failed');await store.flush();
});

test('独立验收：厘级文本费用不能四舍五入为零后突破批量预算',async()=>{
  let calls=0;const {store,workflow}=await fixture({quote:()=>0.001,generate:async n=>{calls++;n.data.resultText='ok';}});
  const a=add(store,'A'),b=add(store,'B');store.addEdge(a.id,'out',b.id,'prompt','text');
  try{await workflow.start({targets:[b.id],budgetYuan:0.0015,confirmed:true});}catch{}
  assert.ok(calls<=1,'最多允许第一笔0.001元，第二笔会超出预算');await store.flush();
});
