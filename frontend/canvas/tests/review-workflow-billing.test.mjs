import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';
import {createWorkflow} from '../src/workflow.js';
import {setCapabilities} from '../src/capabilities.js';
import {readFile} from 'node:fs/promises';

async function setup(){const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('独立计费复审');return{storage,store};}
const lock=async(_name,fn)=>fn();

test('独立复审：已完成视频入库失败后重试该行，只下载原成片、不创建付费任务',async()=>{
 setCapabilities(JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json',import.meta.url),'utf8')));
 const {store,storage}=await setup();const node=store.addNode('gen',0,0,{draft:{model:'minimax-h3-768p-per-second',seconds:5},run:{taskId:'already-paid'}});
 let posts=0,downloads=0,detaches=0;
 const runner={recOf:async()=>({status:'completed'}),download:async()=>{downloads++;if(downloads===1)return null;const blob=new Blob([new Uint8Array([0,0,0,0,102,116,121,112])],{type:'video/mp4'});await storage.setBlob('blob:result-original',blob);store.project.assets['result-original']={id:'result-original',kind:'video',name:'原成片.mp4',mime:'video/mp4',size:blob.size,fromTask:'already-paid'};node.data.resultAssetId='result-original';return true;},detach:async n=>{detaches++;n.data.run=null;},submit:async n=>{posts++;n.data.run={taskId:'wrong-second-task'};}};
 const workflow=createWorkflow({store,storage,runner,submitLock:lock,pollMs:1});
 await workflow.start({targets:[node.id],confirmed:true});assert.equal(workflow.getState().status,'failed');
 await workflow.retryRow(workflow.getState().rows[0].id);
 assert.equal(posts,0,'交付重试不得新增付费POST');assert.equal(detaches,0,'不得脱离原来的已付费任务');assert.equal(downloads,2);assert.equal(workflow.getState().status,'done');await store.flush();
});

test('独立复审：图文请求已发出且结果未知，预算仍保留一次估算成本',async()=>{
 const {store,storage}=await setup();const n=store.addNode('image',0,0,{model:'mock-image',resolution:'1K'});
 const workflow=createWorkflow({store,storage,submitLock:lock,generators:{quote:()=>0.06,generate:async node=>{node.data.operation={id:'same-paid-operation',state:'unresolved',sentAt:Date.now()};throw new Error('模拟上游已接收后断线');}}});
 await workflow.start({targets:[n.id],confirmed:true,budgetYuan:0.06});
 assert.equal(workflow.getState().estimatedSpendYuan,0.06,'未知结果不能当成没有消费，继续放行预算');
 await workflow.retryRow(workflow.getState().rows[0].id);assert.equal(workflow.getState().estimatedSpendYuan,0.06,'同一未知操作不可重复占用预算');await store.flush();
});

test('独立复审：CSV替换图片档位后，确认预估使用每行实际价格',async()=>{
 const {store,storage}=await setup();const n=store.addNode('image',0,0,{model:'mock-image',resolution:'{{res}}'});
 const workflow=createWorkflow({store,storage,submitLock:lock,generators:{quote:n=>n.data.resolution==='4K'?0.06:0.03}});
 const result=await workflow.preview({targets:[n.id],rows:[{res:'4K'},{res:'1K'}]});
 assert.equal(result.estimatedYuan,0.09);assert.equal(n.data.resolution,'{{res}}','估价不得修改用户模板');await store.flush();
});
