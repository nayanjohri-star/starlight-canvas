// 独立验收：由协调者编写，开发角色不得降低这些用户数据/计费保护要求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createEditor } from '../src/editor.js';
import { orderedGraph, parseCSV, template, studioState, outputOf } from '../src/studio-schema.js';

async function fixture() { const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('独立验收');return {store,storage,editor:createEditor(store)}; }
const draft=()=>({model:'minimax-h3-768p-per-second',prompt:'镜头测试',intent:'text',seconds:5,ratio:'16:9',switches:{}});

test('独立验收：复制生成节点不继承已付费任务、未知提交和结果身份，原任务仍完整',async()=>{
  const {store,editor}=await fixture();
  const node=store.addNode('gen',0,0,{draft:draft(),perModel:{},run:{pendingKey:'original-pending'},resultAssetId:'result-1'});
  await store.savePendingCreate({projectId:store.project.id,nodeId:node.id,idempotencyKey:'original-pending',state:'uncertain',model:draft().model,bodyString:JSON.stringify({model:draft().model,prompt:'镜头测试',seconds:5})});
  const [copy]=editor.duplicate([node.id]);
  assert.ok(copy&&copy.id!==node.id);assert.equal(copy.data.run?.pendingKey,undefined);assert.equal(copy.data.run?.taskId,undefined);assert.equal(copy.data.resultAssetId,undefined);
  assert.equal(store.node(node.id).data.run.pendingKey,'original-pending');assert.equal((await store.listPending()).length,1);
  await store.flush();
});

test('独立验收：撤销编辑不能把新受理的任务退回到可再次创建状态',async()=>{
  const {store,editor}=await fixture();const n=store.addNode('gen',0,0,{draft:draft(),perModel:{}});
  editor.checkpoint();n.x=300;n.data.run={taskId:'accepted-after-checkpoint'};
  await store.saveTask({projectId:store.project.id,nodeId:n.id,taskId:'accepted-after-checkpoint',model:n.data.draft.model,status:'queued'});
  editor.undo();assert.equal(store.node(n.id).data.run.taskId,'accepted-after-checkpoint');assert.equal((await store.tasksOfProject()).length,1);
  editor.redo();assert.equal(store.node(n.id).data.run.taskId,'accepted-after-checkpoint');await store.flush();
});

test('独立验收：图片未知操作在编辑历史中不可消失，副本不冒用原操作',async()=>{
  const {store,editor}=await fixture();const n=store.addNode('image',0,0,{model:'gpt-image-2.5-flare-special',prompt:'杯子'});
  editor.checkpoint();n.data.prompt='新草稿';n.data.operation={state:'uncertain',id:'operation-1'};
  editor.undo();assert.equal(store.node(n.id).data.operation.state,'uncertain');
  const [copy]=editor.duplicate([n.id]);assert.equal(copy.data.operation,undefined);assert.equal(store.node(n.id).data.operation.state,'uncertain');await store.flush();
});

test('独立验收：保护节点不被普通删除，撤销删除不擦除任务记录',async()=>{
  const {store,editor}=await fixture();const n=store.addNode('gen',0,0,{draft:draft(),run:{taskId:'t-active'},locked:true});
  editor.delete([n.id]);assert.ok(store.node(n.id));n.data.locked=false;
  await store.saveTask({projectId:store.project.id,nodeId:n.id,taskId:'t-active',model:n.data.draft.model,status:'queued'});
  editor.delete([n.id]);assert.equal(store.node(n.id),null);editor.undo();assert.equal(store.node(n.id).data.run.taskId,'t-active');assert.equal((await store.tasksOfProject()).length,1);await store.flush();
});

test('独立验收：分镜和剪辑导入后引用新节点新素材，不借用旧项目媒体身份',async()=>{
  const {store,storage}=await fixture();
  store.project.assets['local-a']={id:'local-a',name:'场景.png',kind:'image',mime:'image/png',size:24,addedAt:1,category:'scene',tags:'室内'};
  const image=store.addNode('image',0,0,{model:'gpt-image-2.5-flare',prompt:'场景',resultAssetId:'local-a'});
  const video=store.addNode('gen',400,0,{draft:draft()});store.addEdge(image.id,'out',video.id,'refs','image');
  const studio=studioState(store.project);studio.shots=[{id:'s1',title:'01',duration:5,description:'场景',imageNodeId:image.id,nodeId:video.id,assetIds:['local-a']}];studio.groups=[{id:'g1',title:'第一场',members:[image.id,video.id]}];studio.timeline=[{id:'c1',assetId:'local-a',start:0,end:5,subtitle:'你好',muted:false}];
  const exported=await store.exportJSON();const second=createStore(storage);const imported=await second.importJSON(exported);const ni=imported.nodes.find(n=>n.type==='image'),nv=imported.nodes.find(n=>n.type==='gen');
  assert.notEqual(ni.id,image.id);assert.notEqual(ni.data.resultAssetId,'local-a');assert.equal(imported.assets[ni.data.resultAssetId].missing,true);
  assert.equal(imported.studio.shots[0].imageNodeId,ni.id);assert.equal(imported.studio.shots[0].nodeId,nv.id);assert.equal(imported.studio.shots[0].assetIds[0],ni.data.resultAssetId);assert.equal(imported.studio.timeline[0].assetId,ni.data.resultAssetId);
  assert.ok(imported.studio.groups[0].members.includes(nv.id));assert.equal(store.project.assets['local-a'].missing,undefined);await store.flush();await second.flush();
});

test('独立验收：循环工作流和不完整批量变量在创建前明确拒绝',()=>{
  const nodes=['a','b','c'].map(id=>({id,type:'text',data:{}}));const edge=(a,b)=>({from:{node:a,port:'out'},to:{node:b,port:'prompt'}});
  assert.throws(()=>orderedGraph({nodes,edges:[edge('a','b'),edge('b','a')]},['b']),/循环|cycle/i);
  assert.deepEqual(orderedGraph({nodes,edges:[edge('a','b'),edge('b','c')]},['c']),['a','b','c']);
  const rows=parseCSV('\uFEFF角色,台词\r\n小明,"你好,世界"\r\n小红,"第一行\n第二行"');assert.equal(rows.length,2);assert.equal(rows[0]['台词'],'你好,世界');
  assert.equal(template('{{角色}}：{{台词}}',rows[0]),'小明：你好,世界');assert.throws(()=>template('{{不存在}}',rows[0]));assert.throws(()=>parseCSV('角色,角色\nx,y'));
});

test('独立验收：复制生成节点保留上游参考连线，但不复制下游和任务',async()=>{
  const {store,editor}=await fixture();
  const a=store.addNode('asset',0,0,{assetId:'reference-a'}),n=store.addNode('gen',300,0,{draft:draft(),run:{taskId:'original-task'}}),down=store.addNode('gen',600,0,{draft:draft()});
  store.addEdge(a.id,'out',n.id,'refs','image');store.addEdge(n.id,'out',down.id,'refs','video');
  const [copy]=editor.duplicate([n.id]);const inputs=store.edgesInto(copy.id,'refs');
  assert.equal(inputs.length,1);assert.equal(inputs[0].from.node,a.id);assert.equal(copy.data.run,undefined);
  assert.ok(!store.project.edges.some(e=>e.from.node===copy.id&&e.to.node===down.id));await store.flush();
});

test('独立验收：工具输出中的缺失素材位置不能被过滤后继续下游生成',()=>{
  const asset={id:'ok',name:'ok.png',kind:'image'};
  const result=outputOf({assets:{ok:asset}},{type:'utility',data:{outputAssetIds:['ok',null]}});
  assert.equal(result.assets.length,2,'保留原输出位置，缺失项由下游显式拒绝');assert.ok(result.assets[1]?.missing);
});

test('独立验收：复制项目后重新绑定副本素材不能覆盖原项目文件',async()=>{
  const {store,storage}=await fixture();const id='original-asset';
  store.project.assets[id]={id,name:'参考.png',kind:'image',mime:'image/png',size:3,addedAt:1};await storage.setBlob(`blob:${id}`,new Blob(['old']));
  store.addNode('asset',0,0,{assetId:id});const original=store.project.id;await store.flush();
  const copy=await store.duplicateProject(original,'副本');const copiedId=copy.nodes[0].data.assetId;
  assert.notEqual(copiedId,id,'项目副本需要独立的可重新绑定素材身份');
  await storage.setBlob(`blob:${copiedId}`,new Blob(['new']));assert.equal(await(await storage.getBlob(`blob:${id}`)).text(),'old');await store.flush();
});
