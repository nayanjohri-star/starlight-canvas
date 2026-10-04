import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createStoryboards } from '../src/storyboard.js';
import {readFile} from 'node:fs/promises';
import {setCapabilities,validateDraft,buildCreateBody} from '../src/capabilities.js';
import {setAvailableModels} from '../src/keyvault.js';

async function fixture(generators){const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('分镜独立验收');return {store,storage,sb:createStoryboards({store,storage,generators})};}

test('独立验收：正式能力表十三型号逐个受限密钥，分镜单图请求可通过合同校验',async()=>{
 const caps=JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json',import.meta.url),'utf8'));
 setCapabilities(caps);
 try{
  for(const [id,m] of Object.entries(caps.models)){
   setAvailableModels([id]);const {store,sb}=await fixture();
   const shot=sb.addShot({title:id,duration:m.seconds.min,videoPrompt:'湖边镜头'});const anchor=sb.ensureImageNode(shot),node=sb.ensureVideoNode(shot);
   assert.equal(node.data.draft.model,id);assert.equal(node.data.draft.seconds,m.seconds.min);
   const edge=store.project.edges.find(e=>e.from.node===anchor.id&&e.to.node===node.id);
   assert.equal(edge.to.port,m.family==='h3'&&id!=='minimax-h3-768p-limited'?'frames':'refs');
   const image={id:'reference',name:'reference.png',kind:'image',mime:'image/png',size:1024,remote:{url:'https://xingpan.site/reference-assets/mock.png',expiresAt:Math.floor(Date.now()/1000)+3600}};
   const refs=edge.to.port==='refs'?[image]:[],frames=edge.to.port==='frames'?[image]:[];
   assert.equal(validateDraft(id,node.data.draft,refs,frames),'',id);
   const body=JSON.parse(buildCreateBody(id,node.data.draft,refs,frames));assert.equal(body.model,id);
   assert.ok(JSON.stringify(body.metadata).includes('reference-assets/mock.png'));await store.flush();
  }
 }finally{setAvailableModels(null);}
});
test('独立验收：仅受限型号可用时，8秒分镜明确提示6/10/15且不创建节点',async()=>{
 const caps=JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json',import.meta.url),'utf8'));
 setCapabilities(caps);setAvailableModels(['minimax-h3-768p-limited']);
 const {store,sb}=await fixture();
 try {
  const shot=sb.addShot({title:'8秒镜头',duration:8,videoPrompt:'湖边镜头'});
  const before=store.project.nodes.length;
  assert.throws(()=>sb.ensureVideoNode(shot),/6\/10\/15s/);
  assert.equal(store.project.nodes.length,before);
 } finally {setAvailableModels(null);await store.flush();}
});
test('独立验收：超限分镜导入必须整批拒绝，不能只插入前半批',async()=>{
  const {store,sb}=await fixture();for(let i=0;i<199;i++)sb.addShot({title:String(i)});
  const before=JSON.stringify(store.project.studio.shots);
  assert.throws(()=>sb.fromScript(JSON.stringify([{title:'A'},{title:'B'}])),/超限|数量/);
  assert.equal(JSON.stringify(store.project.studio.shots),before);await store.flush();
});
test('独立验收：超限宫格必须整组拒绝，不能留下残缺分镜或节点',async()=>{
  const {store,sb}=await fixture();for(let i=0;i<199;i++)sb.addShot({title:String(i)});
  const before=JSON.stringify({shots:store.project.studio.shots,nodes:store.project.nodes});
  assert.throws(()=>sb.createGrid(4),/超限|数量/);
  assert.equal(JSON.stringify({shots:store.project.studio.shots,nodes:store.project.nodes}),before);await store.flush();
});
test('独立验收：AI 拆分返回时若已切换项目，不得把旧剧本写进新项目',async()=>{
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const {store,sb}=await fixture({generate:async n=>{entered();await gate;n.data.resultText=JSON.stringify({shots:[{title:'旧项目镜头'}]});}});
  const pending=sb.breakdownWithAI('旧项目剧本');pending.catch(()=>{});await ready;await store.newProject('另一个项目');release();
  try{await pending;}catch{}
  assert.equal(store.project.studio?.shots?.length??0,0);await store.flush();
});
