import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/store.js';
import {createMemoryStorage} from '../src/storage.js';

async function conflicted() {
 const db=createMemoryStorage(),a=createStore(db),b=createStore(db);
 await a.newProject('原项目');const pid=a.project.id;await b.openProject(pid);
 a.addNode('note',0,0,{text:'外部稿'});await a.flush();
 b.addNode('note',0,0,{text:'本地稿'});await assert.rejects(()=>b.flush());
 return {db,b,pid};
}
const nextProject=()=>({id:'next-project',name:'另一个项目',rev:1,createdAt:1,updatedAt:1,nodes:[],edges:[],assets:{}});
const barrier=()=>{let entered,release;return{started:new Promise(r=>entered=r),wait:new Promise(r=>release=r),enter:()=>entered(),release:()=>release()};};

test('覆盖保存读取期间切项目：不得把新项目文档写入旧项目键',async()=>{
 const {db,b,pid}=await conflicted(),gate=barrier(),original=db.get.bind(db);let once=true;
 db.get=async k=>{if(k===`project:${pid}`&&once){once=false;gate.enter();await gate.wait;}return original(k);};
 const saving=b.resolveConflict(pid,'overwrite').catch(e=>e);await gate.started;
 await b.commitProject(nextProject());gate.release();await saving;db.get=original;
 assert.equal((await db.get(`project:${pid}`)).id,pid);assert.equal(b.project.id,'next-project');
 assert.equal(await db.get('lastOpened'),'next-project');assert.equal((await db.get('project:next-project')).rev,1);
});

test('覆盖CAS提交期间切项目：原稿可写回，当前基线和最近项目仍属于新项目',async()=>{
 const {db,b,pid}=await conflicted(),gate=barrier(),original=db.setIfRev.bind(db);let once=true;
 db.setIfRev=async(k,rev,value)=>{if(k===`project:${pid}`&&once){once=false;gate.enter();await gate.wait;}return original(k,rev,value);};
 const saving=b.resolveConflict(pid,'overwrite');await gate.started;await b.commitProject(nextProject());gate.release();await saving;
 assert.equal((await db.get(`project:${pid}`)).id,pid);assert.equal(b.project.id,'next-project');assert.equal(await db.get('lastOpened'),'next-project');
 await b.flush();assert.equal((await db.get('project:next-project')).name,'另一个项目');
});

test('冲突稿另存后：已完整备份的旧排队保存不应重新锁住当前较新稿',async()=>{
 const {db,b,pid}=await conflicted(),gate=barrier(),original=db.get.bind(db);let once=true;
 await db.set('project:queue-holder',{id:'queue-holder',name:'队列占位',rev:1});
 db.get=async k=>{if(k==='project:queue-holder'&&once){once=false;gate.enter();await gate.wait;}return original(k);};
 const holding=b.renameProject('queue-holder','占位更新');await gate.started;
 const queued=b.flush().catch(e=>e);const copy=await b.resolveConflict(pid,'saveCopy');
 gate.release();await holding;await queued;db.get=original;
 assert.ok((await db.get(`project:${copy.copyId}`)).nodes.some(n=>n.data.text==='本地稿'));
 assert.ok(b.project.nodes.some(n=>n.data.text==='外部稿'));assert.equal(b.getConflict(pid),null);
 await b.flush();
});
