import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';
import {createWorkflow} from '../src/workflow.js';
import {createEditor} from '../src/editor.js';
import {effectivePrompt, wiredOutputs} from '../src/capabilities.js';
const fx=async()=>{const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('跨模块完整性');return{store,storage,editor:createEditor(store,storage)}};
const draft=()=>({model:'minimax-h3-768p-per-second',seconds:5,ratio:'16:9',intent:'omni',prompt:'自己的动作',switches:{}});
test('独立验收：切换 A→B→A 即使 B 没有编辑，也必须清空旧撤销历史',async()=>{
 const{store,editor}=await fx();const n=store.addNode('text',0,0,{text:'A'});editor.checkpoint();n.data.text='A2';const a=store.project.id;await store.newProject('B');await store.openProject(a);assert.equal(editor.state().depth.undo,0);await store.flush();
});
test('独立验收：工作流不改草稿、不重复上游提示词、不覆盖等待期间新连线',{timeout:10000},async()=>{
 const{store,storage}=await fx();
 const source=store.addNode('text',0,0,{text:'上游场景'}),n=store.addNode('image',400,0,{model:'mock-image',prompt:'自己的动作'});
 store.addEdge(source.id,'out',n.id,'prompt','text');let observed,extra;
 const generators={quote:()=>1,generate:async node=>{
   observed=effectivePrompt(store,node,node.data.prompt).prompt;
   const x=store.addNode('note',800,0,{text:'等待期间新增'});extra=x.id;
   store.project.edges=[...store.project.edges,{id:'concurrent',from:{node:x.id,port:'out'},to:{node:source.id,port:'prompt'}}];
   await store.flush();node.data.resultText='完成';
 }};
 const w=createWorkflow({store,storage,generators,submitLock:(_n,f)=>f()});
 await w.start({targets:[n.id],confirmed:true});
 assert.equal(observed,'上游场景\n\n自己的动作');assert.equal(n.data.prompt,'自己的动作');
 assert.ok(store.project.edges.some(e=>e.id==='concurrent'),'等待时的新连线不能被旧数组覆盖');assert.ok(store.node(extra));await store.flush();
});
test('独立验收：真实报价对象 estimatedYuan:null 也必须阻止零预算生成',async()=>{
 const{store,storage}=await fx();const n=store.addNode('text',0,0,{model:'mock-text',text:'未知价格'});let calls=0;
 const w=createWorkflow({store,storage,submitLock:(_n,f)=>f(),generators:{quote:()=>({estimatedYuan:null,kind:'unknown'}),generate:async node=>{calls++;node.data.resultText='ok';}}});
 await w.start({targets:[n.id],budgetYuan:0,confirmed:true});assert.equal(calls,0);await store.flush();
});
test('独立验收：跨项目只复制视频节点也保留必需参考输入',async()=>{
 const{store,storage,editor}=await fx();const aid='reference-a';store.project.assets[aid]={id:aid,name:'参考.png',kind:'image',mime:'image/png',size:3};
 await storage.setBlob('blob:'+aid,new Blob(['ref'],{type:'image/png'}));const a=store.addNode('asset',0,0,{assetId:aid}),n=store.addNode('gen',400,0,{draft:draft(),run:{taskId:'old-paid'}});
 store.addEdge(a.id,'out',n.id,'refs','image');editor.copy([n.id]);await store.newProject('目标');
 const pasted=await editor.pasteAcrossProject(),video=pasted.find(x=>x.type==='gen')??store.project.nodes.find(x=>x.type==='gen');
 assert.ok(video);assert.equal(video.data.run,undefined);assert.equal(store.edgesInto(video.id,'refs').length,1,'不能静默丢图后变文生视频');
 const refs=wiredOutputs(store,video.id,'refs');assert.equal(refs.items.length,1);assert.notEqual(refs.items[0].id,aid);assert.equal(await(await storage.getBlob('blob:'+refs.items[0].id)).text(),'ref');await store.flush();
});
test('独立验收：只复制导演台也随带场景嵌入的 GLB',async()=>{
 const{store,storage,editor}=await fx();const d=store.addNode('director',0,0,{title:'场景'}),aid='glb-only';
 store.project.assets[aid]={id:aid,name:'模型.glb',kind:'file',mime:'model/gltf-binary',size:4};
 await storage.setBlob('blob:'+aid,new Blob(['glTF'],{type:'model/gltf-binary'}));
 await storage.set('dir:'+d.id+':composition',{schemaVersion:1,composition:{model:'xp-asset://'+aid}});
 editor.copy([d.id]);await store.newProject('目标');const pasted=await editor.pasteAcrossProject(),copy=pasted.find(n=>n.type==='director');
 const kv=await storage.get('dir:'+copy.id+':composition'),newId=kv.composition.model.slice('xp-asset://'.length);
 assert.notEqual(newId,aid);assert.ok(store.project.assets[newId]);assert.equal(await(await storage.getBlob('blob:'+newId)).text(),'glTF');await store.flush();
});
test('独立验收：跨项目粘贴的项目提交失败必须回滚，不返回成功',async()=>{
 const{store,storage,editor}=await fx();const n=store.addNode('text',0,0,{text:'源'});editor.copy([n.id]);await store.newProject('目标');
 const p=store.project,base=JSON.stringify(p.nodes),set=storage.set;
 storage.set=async(k,v)=>{if(k==='project:'+p.id&&v.nodes?.length)throw new Error('模拟项目提交磁盘已满');return set(k,v);};
 await assert.rejects(()=>editor.pasteAcrossProject(),/磁盘|保存|提交/);assert.equal(store.project,p);assert.equal(JSON.stringify(p.nodes),base);
 storage.set=set;await store.flush();assert.equal((await storage.get('project:'+p.id)).nodes.length,0);
});
