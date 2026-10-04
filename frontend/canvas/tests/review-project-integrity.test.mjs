import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/store.js';
import {createMemoryStorage} from '../src/storage.js';
import {createProjectHub} from '../src/project-hub.js';

async function setup(){const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('原项目');return{store,storage,hub:createProjectHub({store,storage})};}

test('复审：恢复旧版本后，保留的已生成结果必须仍有素材身份和文件',async()=>{
 const {store,storage,hub}=await setup();
 const node=store.addNode('image',0,0,{prompt:'场景'}),saved=await hub.saveVersion('生成前');
 const id='generated-after-version';
 store.project.assets[id]={id,name:'已付费结果.png',kind:'image',mime:'image/png',size:4,addedAt:1};
 await storage.setBlob('blob:'+id,new Blob(['data'],{type:'image/png'}));
 node.data.resultAssetId=id;node.data.outputAssetIds=[id];node.data.operation={state:'completed',id:'operation-a'};
 await store.flush();await hub.restoreVersion(saved.id);
 assert.equal(store.node(node.id).data.resultAssetId,id);
 assert.ok(store.project.assets[id],'恢复不能保留结果ID却移除其素材登记');
 assert.equal(await(await storage.getBlob('blob:'+id)).text(),'data');await store.flush();
});

test('复审：项目模板实例必须换新节点及素材身份，重绑副本不修改原素材',async()=>{
 const {store,storage,hub}=await setup();const sourceId=store.project.id,aid='original-media';
 store.project.assets[aid]={id:aid,name:'原图.png',kind:'image',mime:'image/png',size:4,addedAt:1};
 await storage.setBlob('blob:'+aid,new Blob(['OLD!'],{type:'image/png'}));
 const node=store.addNode('asset',0,0,{assetId:aid});
 const template=await hub.saveTemplate('带图模板');await hub.applyTemplate(template.id);
 const copy=store.project.nodes.find(n=>n.type==='asset');
 assert.notEqual(copy.id,node.id,'模板不能复用原节点ID');assert.notEqual(copy.data.assetId,aid,'模板不能复用全局blob键');
 await storage.setBlob('blob:'+copy.data.assetId,new Blob(['NEW!'],{type:'image/png'}));
 assert.equal(await(await storage.getBlob('blob:'+aid)).text(),'OLD!');
 assert.equal((await storage.get('project:'+sourceId)).nodes[0].id,node.id);await store.flush();
});

test('复审：版本读取期间切换项目，恢复操作中止且不对新项目写自动快照',async()=>{
 const {store,storage,hub}=await setup();store.addNode('note',0,0,{text:'旧稿'});const version=await hub.saveVersion('旧版');
 const get=storage.get.bind(storage);let switched=false,nextId;
 storage.get=async key=>{const value=await get(key);if(!switched&&key.endsWith(':'+version.id)){switched=true;await store.newProject('新项目');nextId=store.project.id;}return value;};
 await assert.rejects(()=>hub.restoreVersion(version.id),/项目|切换|changed/);
 assert.equal(store.project.id,nextId);assert.equal((await hub.listVersions(nextId)).length,0);await store.flush();
});
