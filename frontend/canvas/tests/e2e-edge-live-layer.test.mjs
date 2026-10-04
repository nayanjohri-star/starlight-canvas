// 拖动实时连线层（0.4.1 大画布性能）：拖动帧内主连线 SVG 零修改，相连连线以临时副本画在
// #edges-live；副本端点始终贴合端口；松手/纯点击/Esc 后原连线几何正确、恢复显示、无残留副本。
// 端口锚点缓存：节点正文变高后端口下移，连线端点必须随之更新（缓存失效正确）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, makeState, mockUpstream } from './e2e-helpers.mjs';

test('实时连线层：拖动中副本贴合端口、主层零修改；结束后原连线正确恢复；锚点缓存随尺寸失效', { timeout: 120000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: ROOT, upstreamFetch: mockUpstream(makeState()) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(async () => { await browser.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);

  const r = await page.evaluate(async () => {
    const x = window.__xp, s = x.store, frame = () => new Promise(requestAnimationFrame);
    x.board.snap.grid = false; x.board.snap.align = false;
    const a = s.addNode('text', 80, 120, { text: '源' }), b = s.addNode('text', 620, 160, { text: '目标' }), c = s.addNode('text', 80, 520, { text: '旁路' });
    const e1 = s.addEdge(a.id, 'out', b.id, 'prompt', 'text'), e2 = s.addEdge(c.id, 'out', b.id, 'prompt', 'text');
    await frame(); await frame();
    const endOf = d => { const m = d.match(/M ([\d.-]+) ([\d.-]+)/); return m ? { x: +m[1], y: +m[2] } : null; };
    const near = (p, q) => p && q && Math.abs(p.x - q.x) < 1.5 && Math.abs(p.y - q.y) < 1.5;
    const mainPath = id => document.querySelector(`#edges [data-edge="${id}"] path`);
    const mainG = id => document.querySelector(`#edges [data-edge="${id}"]`);
    const head = document.querySelector(`[data-node="${a.id}"] .node-head`), hr = head.getBoundingClientRect();
    const ev = (type, dx, target = head) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: hr.x + 60 + dx, clientY: hr.y + 12 }));
    const out = {};
    // 拖动：主层零 childList/attribute 修改；副本端点贴合端口
    let mutations = 0;
    const ob = new MutationObserver(ms => { mutations += ms.filter(m => m.type === 'childList' || (m.type === 'attributes' && m.attributeName === 'd')).length; });
    ev('pointerdown', 0); await frame();
    ob.observe(document.getElementById('edges'), { childList: true, subtree: true, attributes: true, attributeFilter: ['d'] });
    for (let dx = 10; dx <= 120; dx += 10) { ev('pointermove', dx); await frame(); }
    ob.disconnect();
    const copy = document.querySelector(`#edges-live [data-live-edge="${e1.id}"]`);
    out.midMutations = mutations;
    out.midHidden = mainG(e1.id)?.style.visibility === 'hidden';
    out.midOtherVisible = mainG(e2.id)?.style.visibility === '';
    out.midCopyTracks = near(endOf(copy?.getAttribute('d') ?? ''), x.board.portCenter(a.id, 'out', 'out'));
    out.midLiveCount = document.querySelectorAll('#edges-live [data-live-edge]').length;
    ev('pointerup', 120); await frame();
    out.endLiveCount = document.querySelectorAll('#edges-live [data-live-edge]').length;
    out.endVisible = mainG(e1.id)?.style.visibility === '';
    out.endGeometry = near(endOf(mainPath(e1.id).getAttribute('d')), x.board.portCenter(a.id, 'out', 'out'));
    out.movedX = s.node(a.id).x;
    // 纯点击：不移动也不残留
    ev('pointerdown', 120); await frame(); ev('pointerup', 120); await frame();
    out.clickLive = document.querySelectorAll('#edges-live [data-live-edge]').length;
    out.clickVisible = mainG(e1.id)?.style.visibility === '';
    // Esc 取消：同样恢复
    ev('pointerdown', 120); await frame(); ev('pointermove', 150); await frame();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame();
    head.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 5 })); await frame();
    out.escLive = document.querySelectorAll('#edges-live [data-live-edge]').length;
    out.escVisible = mainG(e1.id)?.style.visibility === '';
    out.escGeometry = near(endOf(mainPath(e1.id).getAttribute('d')), x.board.portCenter(a.id, 'out', 'out'));
    // 锚点缓存失效：目标节点正文变高 → 其输入端口下移 → 连线终点随之更新
    const endPt = d => { const n = d.trim().split(/[ ,]+/); return { x: +n.at(-2), y: +n.at(-1) }; };
    const before = endPt(mainPath(e1.id).getAttribute('d'));
    s.updateNodeData(b.id, { text: Array.from({ length: 30 }, (_, i) => `第 ${i} 行较长的文本内容`).join('\n') });
    s.touch({ type: 'data', id: b.id });
    await frame(); await frame(); await frame();
    const after = endPt(mainPath(e1.id).getAttribute('d'));
    const dotB = document.querySelector(`[data-node="${b.id}"] [data-port="prompt"][data-dir="in"] .dot`).getBoundingClientRect();
    const layer = document.getElementById('nodes').getBoundingClientRect(), sc = x.board.view.scale;
    const trueB = { x: (dotB.left + dotB.width / 2 - layer.left) / sc, y: (dotB.top + dotB.height / 2 - layer.top) / sc };
    out.resizeMoved = Math.abs(after.y - before.y) > 5 || Math.abs(after.x - before.x) > 5 || near(before, trueB);
    out.resizeGeometry = near(after, trueB);
    return out;
  });
  assert.equal(r.midMutations, 0, '拖动帧内主连线层不得被修改');
  assert.equal(r.midHidden, true, '拖动中原连线原地隐藏');
  assert.equal(r.midOtherVisible, true, '不相连的连线不受影响');
  assert.equal(r.midCopyTracks, true, '实时副本端点贴合移动节点端口');
  assert.equal(r.midLiveCount, 1, '只有相连连线进入实时层');
  assert.equal(r.endLiveCount, 0, '松手后无残留副本');
  assert.equal(r.endVisible, true, '松手后原连线恢复显示');
  assert.equal(r.endGeometry, true, '松手后原连线几何贴合端口');
  assert.ok(r.movedX > 80, '节点确实移动');
  assert.equal(r.clickLive, 0); assert.equal(r.clickVisible, true, '纯点击不残留');
  assert.equal(r.escLive, 0); assert.equal(r.escVisible, true, 'Esc 取消后恢复');
  assert.equal(r.escGeometry, true, 'Esc 取消后几何正确');
  assert.equal(r.resizeGeometry, true, '节点尺寸变化后连线终点贴合新的端口位置（锚点缓存失效）');
  assert.deepEqual(errors, []);
});
