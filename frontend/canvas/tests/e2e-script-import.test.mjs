import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {docxFixture,SCRIPT_XML} from './fixtures/docx.mjs';
import {chromium,createCanvasServer,ROOT,CHROME,SHOTS} from './e2e-helpers.mjs';

test('剧本文件：真实 DOCX 解压/预览、TXT 批量追加、错误保留、取消替换、导出恢复',async t=>{
 let calls=0;
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{calls++;throw new Error('mock only');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>window.__xp?.storyboards);
 const fidelity=await page.evaluate(async()=>{
   const {docxXmlToText}=await import('/script-import.js');
   return docxXmlToText('<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><mc:AlternateContent><mc:Choice><w:p><w:r><w:t>只保留一次</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>只保留一次</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格外层</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>嵌套表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl></w:body></w:document>');
 });
 assert.equal(fidelity.split('只保留一次').length-1,1);assert.match(fidelity,/表格外层 嵌套表格/);
 await page.evaluate(()=>window.__xp.storyboards.open());
 async function openImport(){
  const b=page.getByRole('button',{name:'导入脚本 / 文件',exact:true});if(!await b.isVisible())await page.locator('.sb-tools summary').click();await b.click();
 }
 await openImport();
 const file=page.getByLabel('选择脚本文件（TXT/DOCX/JSON）');
 const docx=docxFixture(SCRIPT_XML),txt=Buffer.from('第1镜 清晨的街道，5秒\n第2镜 地铁驶过，8秒');
 await file.setInputFiles([{name:'第一集.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:docx},{name:'第二集.txt',mimeType:'text/plain',buffer:txt}]);
 await page.getByText('共 2 个文件 · 5 个分镜（追加到现有分镜）',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__xp.storyboards.list().length),0,'preview creates no shots');
 for(const width of [1280,1440,1920])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.locator('.sb-import').screenshot({path:join(SHOTS,`mochiani-import-${width}-${theme}.png`),animations:'disabled'});
  assert.equal(await page.locator('.sb-import').evaluate(e=>e.scrollWidth>e.clientWidth+2),false);
 }
 await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.waitForFunction(()=>window.__xp.storyboards.list().length===5);
 const content=await page.evaluate(()=>({shots:window.__xp.storyboards.list(),text:window.__xp.storyboards.scriptText()}));
 assert.match(content.text,/序幕：夜色中的城市/);assert.match(content.text,/两人相视/);assert.match(content.text,/地铁驶过/);
 assert.equal(content.shots[0].description,'序幕：夜色中的城市');
 await openImport();
 await file.setInputFiles([{name:'good.txt',mimeType:'text/plain',buffer:txt},{name:'bad.docx',mimeType:'application/octet-stream',buffer:Buffer.from('notzip')}]);
 await page.locator('.sbi-error').getByText(/bad.docx/).waitFor();
 assert.equal(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.__xp.storyboards.list().length),5);
 await file.setInputFiles({name:'replace.txt',mimeType:'text/plain',buffer:Buffer.from('新的分镜')});
 await page.getByText('共 1 个文件 · 1 个分镜（追加到现有分镜）',{exact:true}).waitFor();
 await page.locator('.sb-import-mode select').selectOption('replace');
 await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__xp.storyboards.list().length),5);
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 const roundtrip=await page.evaluate(async()=>{
  const x=window.__xp,raw=await x.store.exportJSON(),text=x.storyboards.scriptText();
  await x.store.importJSON(raw);return{same:x.storyboards.scriptText()===text,count:x.storyboards.list().length};
 });assert.deepEqual(roundtrip,{same:true,count:5});
 assert.equal(calls,0);assert.deepEqual(errors,[]);
});

test('文件选择竞争：慢文件不得覆盖新预览，关闭弹窗不得晚到写入',async t=>{
 const server=createCanvasServer({staticDir:process.env.CANVAS_TEST_DIST||join(ROOT,'dist'),directorDir:join(ROOT,'../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),upstreamFetch:async()=>{throw new Error('mock only');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:CHROME,headless:true});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const ctx=await browser.newContext({viewport:{width:1440,height:900}});await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await ctx.newPage();await page.goto(origin);await page.waitForFunction(()=>window.__xp?.storyboards);await page.evaluate(()=>window.__xp.storyboards.open());await page.getByRole('button',{name:'导入脚本 / 文件',exact:true}).click();
 await page.evaluate(()=>{const native=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){if(this.name==='slow.txt')return new Promise(resolve=>window.__releaseScript=()=>native.call(this).then(resolve));return native.call(this);};});
 const file=page.getByLabel('选择脚本文件（TXT/DOCX/JSON）');
 await file.setInputFiles({name:'slow.txt',mimeType:'text/plain',buffer:Buffer.from('旧选择')});await page.waitForFunction(()=>typeof window.__releaseScript==='function');
 await file.setInputFiles({name:'new.txt',mimeType:'text/plain',buffer:Buffer.from('正确的新选择')});await page.getByText('共 1 个文件 · 1 个分镜（追加到现有分镜）',{exact:true}).waitFor();
 await page.evaluate(()=>window.__releaseScript());await page.waitForTimeout(80);
 assert.equal(await page.locator('.sbi-name').textContent(),'new.txt');
 await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.waitForFunction(()=>window.__xp.storyboards.list().length===1);
 assert.equal(await page.evaluate(()=>window.__xp.storyboards.list()[0].description),'正确的新选择');
 const importButton=page.getByRole('button',{name:'导入脚本 / 文件',exact:true});if(!await importButton.isVisible())await page.locator('.sb-tools summary').click();await importButton.click();
 await page.evaluate(()=>{delete window.__releaseScript;});
 await file.setInputFiles({name:'slow.txt',mimeType:'text/plain',buffer:Buffer.from('关闭后不能写入')});await page.waitForFunction(()=>typeof window.__releaseScript==='function');
 await page.keyboard.press('Escape');await page.evaluate(()=>window.__releaseScript());await page.waitForTimeout(80);
 assert.equal(await page.evaluate(()=>window.__xp.storyboards.list().length),1);
 await importButton.click();await page.locator('.sbi-paste summary').click();
 await page.locator('.sbi-paste textarea').fill('粘贴的分镜');await page.getByRole('button',{name:'预览文本',exact:true}).click();
 await page.getByText('共 1 个文件 · 1 个分镜（追加到现有分镜）',{exact:true}).waitFor();
 await page.locator('.sbi-head select').selectOption('gb18030');
 assert.equal(await page.locator('.sbi-name').textContent(),'粘贴剧本.txt','文件编码选项不得清掉粘贴预览');
 await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.waitForFunction(()=>window.__xp.storyboards.list().length===2);
});
