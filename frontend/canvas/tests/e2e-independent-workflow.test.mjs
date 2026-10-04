import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {chromium,createCanvasServer,ROOT,CHROME,MODELS_11,MP4,makeState,mockUpstream,setKey,realPng,assertVideoDecodes} from './e2e-helpers.mjs';

test('独立全链路：十二分镜项目中两镜图片→视频→剪辑→带素材导入，全模拟生成',{timeout:150000},async t=>{
 const state=makeState();state.videoBytes=MP4;const base=mockUpstream(state),images=[],texts=[];let png;
 const upstream=async(url,init)=>{
  const path=new URL(url).pathname;
  if(path==='/v1/models')return Response.json({data:[...MODELS_11,'gpt-5.6-sol','gpt-image-2.5-flare','gpt-image-2.5-sunburst'].map(id=>({id}))});
  if(path==='/v1/images/generations'){images.push(JSON.parse(init.body));return Response.json({data:[{b64_json:Buffer.from(png).toString('base64')}]});}
  if(path==='/v1/chat/completions'){texts.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:'文本已完成'}}]});}
  if(/^\/v1\/videos\/[^/]+$/.test(path)&&init.method==='GET')return Response.json({id:path.split('/').pop(),status:'completed',delivery_status:'ready',progress:100,download_expires_at:Math.floor(Date.now()/1000)+3600});
  return base(url,init);
 };
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:upstream});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--disable-gpu']});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const context=await browser.newContext({viewport:{width:1440,height:900}});await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.__xp?.workflow);await setKey(page,'integration-mock-only');png=await realPng(page);
 const prep=await page.evaluate(async()=>{
  const x=window.__xp,s=x.store;await s.newProject('十二分镜验收');
  const grid=x.storyboards.createGrid(12),selected=grid.shots.slice(0,2),targets=[];
  for(const [i,shot] of selected.entries()){
   x.storyboards.updateShot(shot.id,{duration:4,imagePrompt:'独立画面-'+i,videoPrompt:'缓慢推进镜头-'+i});x.storyboards.syncShotToNodes(shot.id);
   const image=s.node(shot.imageNodeId);image.data.model='gpt-image-2.5-flare';image.data.resolution='1K';image.data.ratio='16:9';
   const text=s.addNode('text',image.x-300,image.y,{text:'共同场景：阳光湖边'});s.addEdge(text.id,'out',image.id,'prompt','text');
   const video=x.storyboards.ensureVideoNode(shot);video.data.draft.model='minimax-h3-768p-per-second';video.data.draft.ratio='16:9';targets.push(video.id);
  }
  await s.flush();const preview=await x.workflow.preview({targets});
  return {targets,price:preview.estimatedYuan,unknown:preview.unknownPaid,shots:s.project.studio.shots.length};
 });
 assert.equal(prep.shots,12);assert.equal(prep.unknown,0);assert.equal(prep.price,1.26,'两张1K图+两段H3四秒的标准估算');
 const run=await page.evaluate(async targets=>window.__xp.workflow.start({targets,budgetYuan:1.27,confirmed:true}),prep.targets);
 assert.equal(run.status,'done',JSON.stringify(run.nodes));assert.equal(images.length,2);assert.equal(state.creates.length,2);assert.equal(new Set(state.creates.map(c=>c.key)).size,2);
 images.forEach((r,i)=>{assert.equal((r.prompt.match(/共同场景：阳光湖边/g)||[]).length,1);assert.ok(r.prompt.includes('独立画面-'+i));});
 for(const c of state.creates){const b=JSON.parse(c.body);assert.equal(b.model,'minimax-h3-768p-per-second');assert.equal(b.seconds,4);assert.ok(JSON.stringify(b).includes('https://xingpan.site/reference-assets/'),'实际视频请求必须包含生成图片');}
 assert.equal(texts.length,0,'手动文本上游不能产生文本计费');
 const videoIds=await page.evaluate(ids=>ids.map(id=>window.__xp.store.node(id).data.resultAssetId),prep.targets);assert.equal(videoIds.length,2);assert.ok(videoIds.every(Boolean));
 const rendered=await page.evaluate(async ids=>{
  const x=window.__xp;
  for(const id of ids)await x.timeline.addAsset(id);
  const r=await x.timeline.renderExport({via:'server'});
  const completedModal = document.body.textContent.includes('导出完成（MP4 · 本机服务）');
  const p=await x.store.exportJSON(),{buildProjectPackage,importProjectPackage}=await import('/export-project.js'),{createIdbStorage}=await import('/storage.js'),storage=await createIdbStorage();
  const bytes=await buildProjectPackage({projectJson:p,clips:x.store.project.studio.timeline,meta:x.store.project.studio.timelineMeta,assets:x.store.project.assets,blobOf:id=>storage.getBlob('blob:'+id)});
  const result=await importProjectPackage({store:x.store,storage,assets:x.assets},bytes);
  return {completedModal,render:[...new Uint8Array(await r.blob.arrayBuffer())],mime:r.mime,shots:result.project.studio.shots.length,clips:result.project.studio.timeline.length,missing:result.missing};
 },videoIds);
 assert.equal(rendered.completedModal,true);assert.equal(rendered.shots,12);assert.equal(rendered.clips,2);assert.equal(rendered.missing.length,0);
 if(process.env.CANVAS_QA_VIDEO)await writeFile(process.env.CANVAS_QA_VIDEO,Buffer.from(rendered.render));
 assert.ok(await assertVideoDecodes(page,rendered.render,rendered.mime));
 assert.equal(state.creates.length,2,'剪辑和导入工程不能再次创建视频');assert.deepEqual(errors,[]);
});
