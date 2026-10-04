import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryStorage} from '../src/storage.js';
import {createStore} from '../src/store.js';

test('独立复审：旧窗口保存必须报告冲突且保留另一窗口已落盘的修改',async()=>{
 const storage=createMemoryStorage(),a=createStore(storage),b=createStore(storage);
 await a.newProject('两个窗口');const n=a.addNode('note',0,0,{text:'原稿'});await a.flush();await b.openProject(a.project.id);
 a.node(n.id).data.text='窗口A新稿';a.touch();await a.flush();
 b.node(n.id).data.text='窗口B未保存草稿';b.touch();
 const outcome=await Promise.allSettled([b.flush()]);
 assert.equal(outcome[0].status,'rejected','旧窗口不能静默覆盖新版本');
 assert.equal((await storage.get('project:'+a.project.id)).nodes[0].data.text,'窗口A新稿');
 assert.equal(b.node(n.id).data.text,'窗口B未保存草稿','冲突也不能丢掉当前窗口草稿');
});

test('独立复审：两个旧版本同时保存，只有一次更新能提交',async()=>{
 const storage=createMemoryStorage(),a=createStore(storage),b=createStore(storage);
 await a.newProject('同时保存');const n=a.addNode('note',0,0,{text:'原稿'});await a.flush();await b.openProject(a.project.id);
 a.node(n.id).data.text='A';b.node(n.id).data.text='B';a.touch();b.touch();
 const outcomes=await Promise.allSettled([a.flush(),b.flush()]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1,'并发检查与写入必须原子完成');
 const winner=outcomes[0].status==='fulfilled'?'A':'B';
 assert.equal((await storage.get('project:'+a.project.id)).nodes[0].data.text,winner);
});

test('独立复审：其他窗口重命名未打开的项目后，旧窗口不能覆盖名称',async()=>{
 const storage=createMemoryStorage(),a=createStore(storage),b=createStore(storage);
 await a.newProject('原名');const pid=a.project.id;const n=a.addNode('note',0,0,{text:'原稿'});await a.flush();
 await b.newProject('其他项目');await b.renameProject(pid,'外部更新的名字');
 a.node(n.id).data.text='本地未保存草稿';a.touch();
 await assert.rejects(()=>a.flush(),/冲突|其他标签页|更新版本/);
 assert.equal((await storage.get('project:'+pid)).name,'外部更新的名字');assert.equal(a.node(n.id).data.text,'本地未保存草稿');
});

test('独立复审：合并任务结果不能授权旧快照覆盖外部新稿',async()=>{
 const storage=createMemoryStorage(),a=createStore(storage),b=createStore(storage);
 await a.newProject('项目');const pid=a.project.id,n=a.addNode('text',0,0,{text:'原输入'});await a.flush();await b.openProject(pid);
 b.addNode('note',0,0,{text:'另一个窗口的新内容'});await b.flush();
 n.data.resultText='模型已返回';
 await a.updateStoredProject(pid,doc=>{doc.nodes.find(x=>x.id===n.id).data.resultText='模型已返回';});
 await Promise.allSettled([a.flush()]);
 const stored=await storage.get('project:'+pid);
 assert.ok(stored.nodes.some(x=>x.data.text==='另一个窗口的新内容'),'结果字段合并后旧草稿仍不能覆盖外部新稿');
 assert.equal(stored.nodes.find(x=>x.id===n.id).data.resultText,'模型已返回');
});

test('独立复审：冲突后继续编辑，再另存副本必须包含最新草稿',async()=>{
 const storage=createMemoryStorage(),a=createStore(storage),b=createStore(storage);
 await a.newProject('项目');const pid=a.project.id;await b.openProject(pid);
 a.addNode('note',0,0,{text:'A'});await a.flush();b.addNode('note',0,0,{text:'B1'});await assert.rejects(()=>b.flush());
 b.addNode('note',0,0,{text:'B2继续编辑'});
 const copy=await b.resolveConflict(pid,'saveCopy');const doc=await storage.get('project:'+copy.copyId);
 assert.ok(doc.nodes.some(x=>x.data.text==='B1'));assert.ok(doc.nodes.some(x=>x.data.text==='B2继续编辑'),'不能只复制第一次冲突时的陈旧快照');
});

test('独立复审：先加载外部版本，之后仍能另存之前保留的本地冲突稿',async()=>{
 const storage=createMemoryStorage(),a=createStore(storage),b=createStore(storage);
 await a.newProject('项目');const pid=a.project.id;await b.openProject(pid);
 a.addNode('note',0,0,{text:'外部版本'});await a.flush();b.addNode('note',0,0,{text:'本地冲突稿'});await assert.rejects(()=>b.flush());
 await b.resolveConflict(pid,'reload');assert.ok(b.project.nodes.some(n=>n.data.text==='外部版本'));
 const copy=await b.resolveConflict(pid,'saveCopy');const saved=await storage.get('project:'+copy.copyId);
 assert.ok(saved.nodes.some(n=>n.data.text==='本地冲突稿'),'另存的是保留的冲突稿，不能误复制刚载入的外部版本');
 assert.ok((await storage.get('project:'+pid)).nodes.some(n=>n.data.text==='外部版本'));
});
