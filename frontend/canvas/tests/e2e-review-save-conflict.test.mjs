import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium,createCanvasServer,ROOT,CHROME} from './e2e-helpers.mjs';

test('独立浏览器复审：真实IndexedDB双标签并发保存，只能有一个成功且双方草稿仍在',async t=>{
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{throw new Error('禁止真实请求');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const context=await browser.newContext();await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const a=await context.newPage();await a.goto(origin);await a.waitForFunction(()=>window.__xp?.store?.project);
 const ids=await a.evaluate(async()=>{const s=window.__xp.store;await s.newProject('并发保存验证');const n=s.addNode('note',20,20,{text:'原稿'});await s.flush();return{pid:s.project.id,nid:n.id};});
 const b=await context.newPage();await b.goto(origin);await b.waitForFunction(()=>window.__xp?.store?.project);await b.evaluate(async pid=>{await window.__xp.store.openProject(pid);},ids.pid);
 await a.evaluate(({nid})=>{const s=window.__xp.store;s.node(nid).data.text='A草稿';s.touch();},ids);
 await b.evaluate(({nid})=>{const s=window.__xp.store;s.node(nid).data.text='B草稿';s.touch();},ids);
 const outcomes=await Promise.all([a,b].map(page=>page.evaluate(async()=>{try{await window.__xp.store.flush();return true;}catch{return false;}})));
 assert.equal(outcomes.filter(Boolean).length,1,'IndexedDB必须原子比较修订并写入');
 assert.equal(await a.evaluate(nid=>window.__xp.store.node(nid).data.text,ids.nid),'A草稿');assert.equal(await b.evaluate(nid=>window.__xp.store.node(nid).data.text,ids.nid),'B草稿');
 const stored=await a.evaluate(async pid=>{const {createIdbStorage}=await import('/storage.js');const db=await createIdbStorage();return(await db.get('project:'+pid)).nodes[0].data.text;},ids.pid);
 assert.equal(stored,outcomes[0]?'A草稿':'B草稿');
 const loser=outcomes[0]?b:a;
 await loser.evaluate(async nid=>{const s=window.__xp.store;s.node(nid).data.text='冲突后继续编辑的最新草稿';s.addNode('note',350,50,{text:'冲突后新增镜头'});s.touch();try{await s.flush();}catch(e){if(e.code!=='rev_conflict')throw e;}window.__xp.projectHub.open();},ids.nid);
 const saveCopy=loser.locator('.modal').getByRole('button',{name:/另存.*副本/}).first();await saveCopy.waitFor({timeout:2500});await saveCopy.click();
 await loser.waitForFunction(async pid=>{const {createIdbStorage}=await import('/storage.js');const db=await createIdbStorage();for(const k of await db.keys()){if(!k.startsWith('project:')||k==='project:'+pid)continue;const p=await db.get(k);if(p?.nodes?.some(n=>n.data?.text==='冲突后继续编辑的最新草稿')&&p.nodes.some(n=>n.data?.text==='冲突后新增镜头'))return true;}return false;},ids.pid,{timeout:4000});
 const retained=await a.evaluate(async pid=>{const {createIdbStorage}=await import('/storage.js');const db=await createIdbStorage();return(await db.get('project:'+pid)).nodes[0].data.text;},ids.pid);
 assert.equal(retained,stored,'通过界面另存冲突副本不得覆盖获胜窗口的稿件');
});
