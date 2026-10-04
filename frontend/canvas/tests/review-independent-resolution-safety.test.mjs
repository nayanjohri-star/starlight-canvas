import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';
import {createGenerators} from '../src/studio-gen.js';
import {clearKey,setKey,setAvailableModels,getFingerprint} from '../src/keyvault.js';

const element=()=>({append(){},remove(){},setAttribute(){},style:{}});
globalThis.document={createElement:element,getElementById:element};

for(const action of ['abandon','acknowledge'])for(const failure of ['both','operation','project'])test(`独立验收：${action} 人工确认遇 ${failure} 写入故障，返回失败不能解除原请求保护`,async()=>{
 clearKey();await setKey('local-only-resolution-test');setAvailableModels(['gpt-5.6-sol']);
 const db=createMemoryStorage(),store=createStore(db);await store.newProject('项目');
 const node=store.addNode('text',0,0,{model:'gpt-5.6-sol',text:'只回复OK',params:{max_tokens:8}}),pid=store.project.id;
 const unresolved={id:'existing-operation',state:'unresolved',keyFp:getFingerprint(),createdAt:1,sentAt:2};
 node.data.operation=structuredClone(unresolved);await store.flush();
 const opKey=`op:${pid}:${node.id}`;await db.set(opKey,{...unresolved,projectId:pid,nodeId:node.id});
 let posts=0;
 const generators=createGenerators({
  store,storage:db,submitLock:(_key,fn)=>fn(),assets:{},
  api:{chatCompletion:async()=>{posts++;return{choices:[{message:{content:'OK'}}]};}},
 });
 const original=db.set.bind(db);
 db.set=async(k,v)=>{if((failure!=='project'&&k.startsWith('op:'))||(failure!=='operation'&&k.startsWith('project:')))throw new Error('模拟本地写入失败');return original(k,v);};
 let result,error;try{result=await generators.resolveOperation(node,action);}catch(e){error=e;}
 db.set=original;
 if(result!==true){
  let rejected=false;try{await generators.generate(node);}catch{rejected=true;}
  assert.equal(posts,0,'解除失败后不能把旧请求当作已人工确认，从而再创建一次');
  assert.equal(rejected,true,'结果未确认的旧请求应继续阻止新生成');
 }else{
  assert.equal(error,undefined);assert.equal((await db.get(opKey)).state,action==='abandon'?'abandoned':'completed','只有独立操作记录已确认解除，才可返回成功');
 }
});
