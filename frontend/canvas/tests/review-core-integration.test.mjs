import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/store.js';
import {createMemoryStorage} from '../src/storage.js';

test('集成复审：切换项目后，旧项目排队写入保留自身基线和定向合并结果',async()=>{
 const db=createMemoryStorage(),s=createStore(db);await s.newProject('甲');const original=s.project,pid=original.id;
 s.addNode('note',0,0,{text:'甲的未保存内容'});
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const merging=s.updateStoredProject(pid,async doc=>{entered();await gate;doc.name='甲的合并结果';});
 await started;const flushing=s.flush();
 await s.commitProject({id:'new-project',name:'乙',rev:1,createdAt:1,updatedAt:1,nodes:[],edges:[],assets:{}});
 release();await Promise.all([merging,flushing]);
 const a=await db.get('project:'+pid),b=await db.get('project:new-project');
 assert.equal(a.name,'甲的合并结果');assert.ok(a.nodes.some(n=>n.data.text==='甲的未保存内容'));
 assert.equal(b.name,'乙');assert.equal(b.rev,1);assert.equal(b.nodes.length,0);
 assert.equal(s.project.id,'new-project');assert.equal(s.getConflict(pid),null,'自身连续写入无需误报外部冲突');
});

test('集成复审：异步存储写入期间，同一修订只能被一份条件写消费',async()=>{
 const db=createMemoryStorage();await db.set('p',{rev:1,text:'原稿'});
 const original=db.set.bind(db);let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 db.set=async(k,v)=>{entered();await gate;return original(k,v);};
 const first=db.setIfRev('p',1,{rev:2,text:'甲'});await started;
 const second=db.setIfRev('p',1,{rev:2,text:'乙'});release();
 const result=await Promise.all([first,second]);assert.deepEqual(result.map(x=>x.ok),[true,false]);assert.equal((await db.get('p')).text,'甲');
});

test('集成复审：同基线结果合并后，未保存的本地新节点与结果都能继续保存',async()=>{
 const db=createMemoryStorage(),s=createStore(db);await s.newProject('项目');
 const n=s.addNode('text',0,0,{text:'输入'});await s.flush();s.addNode('note',200,0,{text:'尚未保存的新镜头'});
 await s.updateStoredProject(s.project.id,doc=>{doc.nodes.find(x=>x.id===n.id).data.resultText='结果';});
 assert.equal(s.node(n.id),n,'结果同步不能替换正在操作的节点对象');
 await s.flush();const doc=await db.get('project:'+s.project.id);
 assert.ok(doc.nodes.some(x=>x.data.text==='尚未保存的新镜头'));assert.equal(doc.nodes.find(x=>x.id===n.id).data.resultText,'结果');
});

test('集成复审：另存期间到来的新内容继续保留，不被随后加载外部稿吞掉',async()=>{
 const db=createMemoryStorage(),a=createStore(db),b=createStore(db);await a.newProject('项目');const pid=a.project.id;
 a.project.assets.asset={id:'asset',name:'参考.png',kind:'image',mime:'image/png',size:1};await db.setBlob('blob:asset',new Blob(['x']));await a.flush();await b.openProject(pid);
 a.addNode('note',0,0,{text:'外部稿'});await a.flush();b.addNode('note',0,0,{text:'本地稿'});await assert.rejects(()=>b.flush());
 const original=db.getBlob.bind(db);let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 db.getBlob=async k=>{entered();await gate;return original(k);};
 const saving=b.resolveConflict(pid,'saveCopy');await started;b.addNode('note',300,0,{text:'另存期间到来的新内容'});release();
 const copy=await saving;assert.equal(copy.remainingLocalChanges,true);assert.equal(b.project.id,pid);
 assert.ok(b.project.nodes.some(n=>n.data.text==='另存期间到来的新内容'));assert.ok(b.getConflict(pid));
 db.getBlob=original;const latest=await b.resolveConflict(pid,'saveCopy');
 assert.ok((await db.get('project:'+latest.copyId)).nodes.some(n=>n.data.text==='另存期间到来的新内容'));
});
