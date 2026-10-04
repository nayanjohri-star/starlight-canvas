import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/store.js';
import {createMemoryStorage} from '../src/storage.js';
import {createAssets} from '../src/assets.js';
import {createTaskRunner} from '../src/gennode.js';
import {setKey} from '../src/keyvault.js';

globalThis.document={getElementById:()=>null,createElement:()=>({append(){},remove(){},setAttribute(){},style:{}})};
async function setup(){const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('原项目');const fp=await setKey('mock-generation-review');const assets=createAssets({store,storage,api:{}});return{storage,store,fp,assets};}

test('独立复审：明确未发送的pending解除后，不会被再次认领而永久锁住节点',async()=>{
 const {store,storage,assets,fp}=await setup();const n=store.addNode('gen',0,0,{draft:{model:'mock'},run:{pendingKey:'never-sent'}});
 await store.savePendingCreate({idempotencyKey:'never-sent',projectId:store.project.id,nodeId:n.id,model:'mock',keyFp:fp,bodyString:null,lastSubmitAt:null,createdAt:Date.now(),state:'uncertain'});
 const runner=createTaskRunner({store,storage,assets,api:{},submitLock:(_name,fn)=>fn()});await runner.releasePending(n);
 assert.equal(n.data.run,null);await runner.adoptDurable(n);assert.equal(n.data.run,null,'解除后的从未发送记录不能又恢复禁发守卫');await store.flush();
});

test('独立复审：读缓存成片期间切项目，不把旧成片注册到新项目',async()=>{
 const {store,storage,assets,fp}=await setup();const oldPid=store.project.id,node=store.addNode('gen',0,0,{draft:{model:'mock'},run:{taskId:'cached-task'}});
 const resultKey='result:'+oldPid+':cached-task';await storage.setBlob(resultKey,new Blob([new Uint8Array([0,0,0,24,102,116,121,112])],{type:'video/mp4'}));
 await store.saveTask({taskId:'cached-task',projectId:oldPid,nodeId:node.id,model:'mock',keyFp:fp,status:'completed',resultBlobId:resultKey,resultType:'video/mp4'});
 const get=storage.getBlob.bind(storage);let switched=false;storage.getBlob=async key=>{const value=await get(key);if(key===resultKey&&!switched){switched=true;await store.newProject('新项目');}return value;};
 const runner=createTaskRunner({store,storage,assets,api:{downloadContent:async()=>{throw new Error('缓存存在不应下载');}},submitLock:(_name,fn)=>fn()});
 await runner.download('cached-task');assert.equal(store.project.name,'新项目');assert.equal(Object.keys(store.project.assets).length,0,'旧成片不能混入新项目素材');assert.ok(await get(resultKey),'原成片缓存必须保留');await store.flush();
});

test('独立复审：下载报告成功时项目素材与任务关联已经持久化',async()=>{
 const {store,storage,assets,fp}=await setup();const pid=store.project.id,n=store.addNode('gen',0,0,{draft:{model:'mock'},run:{taskId:'durable-result'}});await store.flush();
 await store.saveTask({taskId:'durable-result',projectId:pid,nodeId:n.id,model:'mock',keyFp:fp,status:'completed'});
 const runner=createTaskRunner({store,storage,assets,api:{downloadContent:async()=>({contentType:'video/mp4',blob:new Blob(['mock-video'],{type:'video/mp4'})})},submitLock:(_name,fn)=>fn()});
 assert.equal(await runner.download('durable-result'),true);
 const rec=await storage.get(`task:${pid}:durable-result`),doc=await storage.get(`project:${pid}`);
 try {assert.ok(doc.assets[rec.resultAssetId],'不能只保存task关联就宣称完成，重开项目必须找到素材');assert.equal(doc.nodes.find(x=>x.id===n.id).data.resultAssetId,rec.resultAssetId);}
 finally {await store.flush();}
});

test('独立复审：成片入库保存失败不报告成功，重试只修复落盘',async()=>{
 const {store,storage,assets,fp}=await setup();const pid=store.project.id,n=store.addNode('gen',0,0,{draft:{model:'mock'},run:{taskId:'save-retry'}});await store.flush();
 await store.saveTask({taskId:'save-retry',projectId:pid,nodeId:n.id,model:'mock',keyFp:fp,status:'completed'});
 let gets=0;const runner=createTaskRunner({store,storage,assets,api:{downloadContent:async()=>{gets++;return{contentType:'video/mp4',blob:new Blob(['mock-video'],{type:'video/mp4'})};}},submitLock:(_name,fn)=>fn()});
 const flush=store.flush;store.flush=async()=>{throw new Error('mock disk full');};
 try {assert.equal(await runner.download('save-retry'),null,'本地素材写回失败时不能返回成功');}
 finally {store.flush=flush;await store.flush();}
 const count=Object.keys(store.project.assets).length;
 assert.equal(await runner.download('save-retry'),true);assert.equal(gets,1);assert.equal(Object.keys(store.project.assets).length,count,'重试不能新增重复素材');
});
