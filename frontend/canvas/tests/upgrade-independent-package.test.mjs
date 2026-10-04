import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { buildProjectPackage, importProjectPackage, parseProjectPackage, zipStore } from '../src/export-project.js';

for (const phase of ['flush', 'blob', 'commit']) test(`独立验收：${phase} 期间切换项目，中止导入并清理暂存，不抢走新项目`, async () => {
  const { bytes } = await source();
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('导入发起项目');
  let nextId, fired = false;
  const switchOnce = async () => { if (fired) return; fired = true; await store.newProject('用户切换的项目'); nextId = store.project.id; };
  if (phase === 'flush') {
    const original = store.flushForSwitch.bind(store);
    store.flushForSwitch = async () => { await original(); await switchOnce(); };
  } else if (phase === 'blob') {
    const original = storage.setBlob.bind(storage);
    storage.setBlob = async (...args) => { await original(...args); await switchOnce(); };
  } else {
    const original = storage.batch.bind(storage);
    storage.batch = async entries => { await original(entries); await switchOnce(); };
  }
  await assert.rejects(importProjectPackage({ store, storage }, bytes), /项目已切换/);
  assert.equal(store.project.id, nextId);
  assert.equal(await storage.get('lastOpened'), nextId);
  assert.equal((await storage.keys()).filter(k => k.startsWith('project:')).length, 2);
  assert.equal((await storage.keys()).filter(k => k.startsWith('blob:')).length, 0);
  await store.flush();
});

test('独立验收：导入落盘期间外部身份守卫失败，回滚新记录且保留原项目', async () => {
  const { bytes } = await source();
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('原项目'); const originalId = store.project.id;
  let valid = true;
  const batch = storage.batch.bind(storage);
  storage.batch = async entries => { await batch(entries); valid = false; };
  await assert.rejects(importProjectPackage({ store, storage, assertCurrent: () => { if (!valid) throw new Error('账户已改变'); } }, bytes), /账户已改变/);
  assert.equal(store.project.id, originalId);
  assert.equal(await storage.get('lastOpened'), originalId);
  assert.equal((await storage.keys()).filter(k => k.startsWith('project:')).length, 1);
  await store.flush();
});

async function source(){
  const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('原素材项目');
  for(const [id,bytes] of [['asset-a','AB'],['asset-b','CD']]){
    store.project.assets[id]={id,name:'同名.png',kind:'image',mime:'image/png',size:2,addedAt:1};
    await storage.setBlob(`blob:${id}`,new Blob([bytes],{type:'image/png'}));
    store.addNode('asset',id==='asset-a'?0:300,0,{title:id,assetId:id});
  }
  const bytes=await buildProjectPackage({projectJson:await store.exportJSON(),clips:[],assets:store.project.assets,blobOf:id=>storage.getBlob(`blob:${id}`)});
  return {storage,store,bytes};
}

test('独立验收：项目包必须按原始素材身份映射，同名同大小不同文件不能互换',async()=>{
  const {storage,bytes}=await source();const parsed=parseProjectPackage(bytes);
  parsed.manifest.media.reverse();
  parsed.files.set('manifest.json',new TextEncoder().encode(JSON.stringify(parsed.manifest)));
  const shuffled=zipStore([...parsed.files].map(([name,data])=>({name,data})));
  const target=createStore(storage);await target.newProject('接收项目');
  const {project}=await importProjectPackage({store:target,storage},shuffled);
  const aid=project.nodes.find(n=>n.data.title==='asset-a').data.assetId;
  const bid=project.nodes.find(n=>n.data.title==='asset-b').data.assetId;
  assert.equal(await(await storage.getBlob(`blob:${aid}`)).text(),'AB');
  assert.equal(await(await storage.getBlob(`blob:${bid}`)).text(),'CD');await target.flush();
});

test('独立验收：项目包媒体写入失败不能切走当前项目或留下假完成',async()=>{
  const {storage,bytes}=await source();const originalSet=storage.setBlob;
  const target=createStore(storage);await target.newProject('必须保留的当前项目');const pid=target.project.id;
  storage.setBlob=async()=>{throw new Error('模拟磁盘已满');};
  await assert.rejects(()=>importProjectPackage({store:target,storage},bytes),/磁盘|空间|保存|写入/);
  assert.equal(target.project.id,pid);assert.equal(await storage.get('lastOpened'),pid);
  storage.setBlob=originalSet;await target.flush();
});

test('独立验收：完整项目包包含导演台的 GLB 素材，不静默只打包图片视频',async()=>{
  const storage=createMemoryStorage(),store=createStore(storage);await store.newProject('导演台工程');
  const d=store.addNode('director',0,0,{title:'布景'}),id='scene-glb';
  store.project.assets[id]={id,name:'场景.glb',kind:'file',mime:'model/gltf-binary',size:4,addedAt:1,fromDirector:d.id};
  await storage.setBlob(`blob:${id}`,new Blob(['glTF'],{type:'model/gltf-binary'}));
  await storage.set(`dir:${d.id}:composition`,{scene:`xp-asset://${id}`});
  const bytes=await buildProjectPackage({projectJson:await store.exportJSON(),clips:[],assets:store.project.assets,blobOf:aid=>storage.getBlob(`blob:${aid}`)});
  const parsed=parseProjectPackage(bytes);assert.ok(parsed.manifest.media.some(m=>m.assetId===id),'GLB 必须在包的文件清单中');
  const target=createStore(storage);await target.newProject('目标');const {project}=await importProjectPackage({store:target,storage},bytes);
  const a=Object.values(project.assets).find(x=>x.name==='场景.glb');assert.equal(a.missing,false);assert.equal(await(await storage.getBlob(`blob:${a.id}`)).text(),'glTF');
  const nd=project.nodes.find(n=>n.type==='director');const comp=await storage.get(`dir:${nd.id}:composition`);assert.equal(comp.scene,`xp-asset://${a.id}`);await store.flush();await target.flush();
});
