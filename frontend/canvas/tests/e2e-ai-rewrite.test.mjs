// AI 改写：改写结果为主、角色注入、H3 专用角色按下游模式显示、最近版本切换、H3 视频节点里的改写入口（确认后才替换）、
// 角色保存在项目里。全部使用本地模拟上游与合成密钥，禁止外部出站。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, BROWSER_OK, ROOT, SHOTS, createCanvasServer, makeState, mockUpstream, MODELS_11, setKey, watchEgress } from './e2e-helpers.mjs';

const TEXT_MODELS = ['gemini-3.8-flash-high', 'deepseek-v4.1-flash'];

test('AI 改写：角色注入、H3 专用角色按模式显示、版本切换与 H3 视频节点入口', { timeout: 120000, skip: !BROWSER_OK && '浏览器缺失' }, async t => {
  const state = makeState(), upstream = mockUpstream(state), chats = [];
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),
    upstreamFetch: async (url, init) => {
      const p = new URL(url).pathname;
      if (p.endsWith('/models')) return Response.json({ data: [...MODELS_11, ...TEXT_MODELS].map(id => ({ id })) });
      if (p === '/v1/chat/completions' && init.method === 'POST') {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(new Uint8Array(await new Response(init.body).arrayBuffer())));
        chats.push(body);
        const all = body.messages.map(m => m.content).join('\n');
        const content = /prompt_cn/.test(all)
          ? JSON.stringify({ prompt_cn: `第${chats.length}次：镜头缓慢推近，@图片1 中的少年抬头望向城门。`, prompt_en: 'Camera slowly pushes in on the boy from @图片1.' })
          : `第${chats.length}次\n1-1 城门 [黄昏] [外]\n△ 城门洞开，林远走进城内。`;
        return Response.json({ id: `chat-${chats.length}`, choices: [{ message: { role: 'assistant', content } }] });
      }
      return upstream(url, init);
    } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser; t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const egress = await watchEgress(page, { abort: true });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  await page.waitForFunction(() => window.__xp.generators?.textModels?.().length >= 2);

  const ids = await page.evaluate(() => {
    const x = window.__xp, s = x.store;
    const text = x.spawnNodeAt('text', { x: 200, y: 140 });
    Object.assign(text.data, { model: 'gemini-3.8-flash-high', text: '描写一些英雄归来的内容' });
    const gen = s.addNode('gen', 760, 140, { draft: { model: 'minimax-h3-768p-per-second', intent: 'text', seconds: 5, ratio: '16:9', prompt: '' }, perModel: {} });
    s.addEdge(text.id, 'out', gen.id, 'prompt', 'text'); s.touch({ type: 'structure' });
    return { text: text.id, gen: gen.id };
  });
  await page.evaluate(id => window.__xp.board.select('node', id), ids.text);
  await page.waitForSelector('#inspector .rewrite-form');
  assert.equal(await page.locator('#inspector').evaluate(el => el.querySelector('h3')?.textContent ?? document.querySelector('.insp-head b')?.textContent), 'AI 改写');
  const roles = () => page.locator('#inspector .rewrite-role').allTextContents();
  const setDownstream = (model, intent) => page.evaluate(([id, model, intent]) => {
    const g = window.__xp.store.node(id); g.data.draft.model = model; g.data.draft.intent = intent; window.__xp.store.touch({ type: 'data', id });
  }, [ids.gen, model, intent]);

  // ① H3 专用角色：只在下游是对应模式的 H3 视频节点时显示，并说明原因
  assert.deepEqual(await roles(), ['专业编剧', '分镜润色', '文字润色', '不使用角色'], 'H3 纯文字模式不显示视频润色角色');
  assert.match(await page.locator('#inspector .rewrite-role-group').innerText(), /专为 MiniMax H3 编写/);
  await setDownstream('minimax-h3-768p-per-second', 'frames');
  await page.waitForFunction(() => [...document.querySelectorAll('#inspector .rewrite-role')].some(b => b.textContent.startsWith('图生视频润色')));
  assert.ok(!(await roles()).some(r => r.startsWith('参考生视频润色')), '首尾帧模式只显示图生视频润色');
  await setDownstream('minimax-h3-768p-per-second', 'refs');
  await page.waitForFunction(() => [...document.querySelectorAll('#inspector .rewrite-role')].some(b => b.textContent.startsWith('参考生视频润色')));
  assert.ok(!(await roles()).some(r => r.startsWith('图生视频润色')));
  await setDownstream('seedance-2.5-vip-480p', 'frames');
  await page.waitForFunction(() => ![...document.querySelectorAll('#inspector .rewrite-role')].some(b => /视频润色/.test(b.textContent)));
  await setDownstream('minimax-h3-768p-per-second', 'frames');
  await page.waitForFunction(() => [...document.querySelectorAll('#inspector .rewrite-role')].some(b => b.textContent.startsWith('图生视频润色')));

  // ② 用图生视频润色改写：角色提示词作为系统提示注入，JSON 里的中文作为结果、英文另存
  await page.locator('#inspector .rewrite-role', { hasText: '图生视频润色' }).click();
  await page.locator('#inspector .gen-cta button.primary', { hasText: /^改写$/ }).click();
  await page.waitForFunction(id => window.__xp.store.node(id).data.resultText, ids.text);
  assert.equal(chats.length, 1);
  assert.match(chats[0].messages[0].content, /图生视频/);
  assert.equal(chats[0].messages.at(-1).content, '描写一些英雄归来的内容');
  const r1 = await page.evaluate(id => window.__xp.store.node(id).data, ids.text);
  assert.equal(r1.resultText, '第1次：镜头缓慢推近，@图片1 中的少年抬头望向城门。');
  assert.equal(r1.outputText, r1.resultText, '下游读取改写结果');
  assert.equal(r1.rewrite.history[0].en, 'Camera slowly pushes in on the boy from @图片1.');
  await page.waitForSelector('#inspector .rewrite-en');

  // ③ 换专业编剧 + 改写要求 → 第 2 版；手改保存在当前版；上一版/下一版切换且下游随之变化
  await page.locator('#inspector .rewrite-role', { hasText: '专业编剧' }).click();
  await page.getByRole('textbox', { name: '改写要求' }).fill('写成 1 场戏');
  await page.locator('#inspector .gen-cta button.primary', { hasText: '重新改写' }).click();
  await page.waitForFunction(id => window.__xp.store.node(id).data.rewrite?.history?.length === 2, ids.text);
  assert.equal(chats[1].messages.at(-1).content, '描写一些英雄归来的内容\n\n【改写要求】写成 1 场戏');
  await page.locator('#inspector .rewrite-result-group', { hasText: /第 2 \/ 2 版 · 专业编剧/ }).waitFor();   // 等检查器按新版本重绘
  await page.getByRole('textbox', { name: '改写结果' }).fill('我手改的第二版');
  await page.locator('#inspector .link-btn', { hasText: '上一版' }).click();
  await page.waitForFunction(id => window.__xp.store.node(id).data.outputText.startsWith('第1次'), ids.text);
  await page.locator('#inspector .link-btn', { hasText: '下一版' }).click();
  await page.waitForFunction(id => window.__xp.store.node(id).data.outputText === '我手改的第二版', ids.text);
  await page.screenshot({ path: join(SHOTS, 'ai-rewrite-node.png') });

  // ④ H3 视频节点里的入口：只在 H3 的首尾帧/素材参考模式出现；结果确认后才替换提示词
  await page.evaluate(([t, g]) => {
    const s = window.__xp.store;
    s.removeEdge(s.project.edges.find(e => e.from.node === t && e.to.node === g).id);
    s.node(g).data.draft.prompt = '少年@图片1站在城门口'; s.touch({ type: 'structure' });
    window.__xp.board.select('node', g);
  }, [ids.text, ids.gen]);
  await page.waitForSelector('#inspector .composer-rewrite');
  await setDownstream('seedance-2.5-vip-480p', 'frames');
  await page.waitForFunction(() => !document.querySelector('#inspector .composer-rewrite'));
  await setDownstream('minimax-h3-768p-per-second', 'text');
  await page.waitForFunction(() => !document.querySelector('#inspector .composer-rewrite'));
  await setDownstream('minimax-h3-768p-per-second', 'refs');
  await page.locator('#inspector .composer-rewrite').click();
  const dlg = page.locator('.modal .h3-rewrite');
  await dlg.waitFor();
  assert.match(await dlg.locator('.rewrite-role[aria-checked=true]').innerText(), /参考生视频润色/);
  await dlg.getByRole('button', { name: '改写', exact: true }).click();
  await dlg.locator('.rewrite-result').evaluate(el => new Promise(r => { const t = setInterval(() => { if (el.value) { clearInterval(t); r(); } }, 50); }));
  assert.match(chats.at(-1).messages.map(m => m.content).join('\n'), /参考生视频/);
  assert.equal(await page.evaluate(g => window.__xp.store.node(g).data.draft.prompt, ids.gen), '少年@图片1站在城门口', '确认前不改提示词');
  await dlg.getByRole('button', { name: '替换提示词' }).click();
  await page.waitForFunction(g => window.__xp.store.node(g).data.draft.prompt.includes('镜头缓慢推近'), ids.gen);
  assert.equal(state.creates.length, 0, '改写不会创建视频任务');

  // 回归：提交等待锁期间检查器重建（草稿键顺序变化、补出空的 @绑定）不算“草稿已修改”，提交照常受理
  await setDownstream('minimax-h3-768p-per-second', 'text');
  const accepted = await page.evaluate(async g => {
    const x = window.__xp, n = x.store.node(g);
    n.data.draft.prompt = '少年站在城门口，晚霞';   // 本段不连素材，用不含 @ 引用的提示词
    const pending = x.runner.submit(n);
    const { model, ...rest } = n.data.draft;
    n.data.draft = { ...rest, model, bindings: {} };   // 与重建检查器同类的无害写入
    await pending;
    return n.data.run?.taskId ?? null;
  }, ids.gen);
  assert.ok(accepted, '无害的草稿重写不应中止提交');
  assert.equal(state.creates.length, 1);

  // ⑤ 管理角色：新增一个仅 H3 素材参考的角色，保存在项目里
  await page.evaluate(id => window.__xp.board.select('node', id), ids.text);
  await page.locator('#inspector .rewrite-manage').click();
  const mgr = page.locator('.modal .role-manager');
  await mgr.getByRole('button', { name: '+ 新增角色' }).click();
  await mgr.getByRole('textbox', { name: '角色名称' }).fill('古风短剧编剧');
  await mgr.getByRole('textbox', { name: '角色提示词' }).fill('你是一名古风短剧编剧。');
  await mgr.getByRole('combobox', { name: '适用范围' }).selectOption('h3-refs');
  await page.locator('.modal .modal-x').click();
  const saved = await page.evaluate(() => window.__xp.store.project.studio.rewriteRoles);
  assert.deepEqual(saved.map(r => [r.name, r.scope]), [['古风短剧编剧', 'h3-refs']]);

  assert.deepEqual(errors, []); assert.deepEqual(egress(), []);
});
