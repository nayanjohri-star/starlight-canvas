// WO-C2 大画布性能测量（合同 §10）：200 节点/300 连线混合图，1440×900，
// 连续交互 ≥200 帧 ×3 轮，记录帧间隔 P95（目标 ≤50ms）；500/1000 完整性单独记。
// 真实 Chromium + 本地 loopback server（端口 4187，C 登记口）；watchEgress 证明零外联。
// 运行：node --test tests/e2e-perf-large.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, mockUpstream, makeState, watchEgress, skipIf } from './e2e-helpers.mjs';

const PERF_PORT = 4187;
const P95_TARGET = 50;                       // 合同 §10 阈值——不暗降
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)] : NaN; };
const fmt = ms => `${ms.toFixed(1)}ms`;

async function setup(t) {
  const state = makeState();
  const server = createCanvasServer({
    staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'),
    directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'),
    upstreamFetch: mockUpstream(state),
  });
  await new Promise(r => server.listen(PERF_PORT, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await ctx.newPage();
  const egress = await watchEgress(page);
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);
  return { page, egress };
}

// 混合图构建：按合法端口种类连线（NODE_TYPES 对齐），网格铺开（可见+离屏混合，贴合真实画布）。
// 返回 {ids, counts:{nodes,edges,added}}；addEdge 自带自环/端口/重复校验，added 必须等于计划数。
const buildGraphSrc = ({ nText, nImage, nGen, nAsset, plan }) => `(() => {
  const x = window.__xp, s = x.store, P = s.project;
  const mk = (t, xx, yy, d) => s.addNode(t, xx, yy, d).id;
  const ids = { text: [], image: [], gen: [], asset: [] };
  const W = Math.ceil(Math.sqrt(${nText + nImage + nGen + nAsset})) + 4;
  let k = 0; const pos = () => [(k % W) * 130, Math.floor(k++ / W) * 105];
  for (let i = 0; i < ${nText}; i++) { const [a, b] = pos(); ids.text.push(mk('text', a, b, { text: '剧本段 ' + i, title: '文本' + i })); }
  for (let i = 0; i < ${nImage}; i++) { const [a, b] = pos(); ids.image.push(mk('image', a, b, { prompt: '分镜图 ' + i, title: '图片' + i })); }
  for (let i = 0; i < ${nGen}; i++) { const [a, b] = pos(); ids.gen.push(mk('gen', a, b, { prompt: '镜头 ' + i, title: '视频' + i })); }
  for (let i = 0; i < ${nAsset}; i++) {
    const kind = i % 3 ? 'video' : 'image';
    const a = { id: 'pa' + i, name: '素材' + i + (kind === 'video' ? '.mp4' : '.png'), kind, mime: kind === 'video' ? 'video/mp4' : 'image/png', size: 1000 + i, addedAt: i };
    P.assets[a.id] = a;
    const [xx, yy] = pos(); ids.asset.push(mk('asset', xx, yy, { assetId: a.id }));
  }
  let ok = 0; const E = (f, fp, tn, tp, kd) => { if (s.addEdge(f, fp, tn, tp, kd)) ok++; };
  const N = a => a.length;
  ${plan}
  return { ids, counts: { nodes: P.nodes.length, edges: P.edges.length, added: ok } };
})()`;

// 300 边配方（200 节点）：全为合法端口组合
const PLAN_300 = `
  for (let i = 0; i < 60; i++) E(ids.text[i % N(ids.text)], 'out', ids.gen[i % N(ids.gen)], 'prompt', 'text');
  for (let i = 0; i < 40; i++) E(ids.text[(i + 20) % N(ids.text)], 'out', ids.image[i % N(ids.image)], 'prompt', 'text');
  for (let i = 0; i < 60; i++) E(ids.text[(i + 40) % N(ids.text)], 'out', ids.text[(i + 1) % N(ids.text)], 'prompt', 'text');
  for (let i = 0; i < 40; i++) E(ids.image[i % N(ids.image)], 'out', ids.gen[i % N(ids.gen)], 'frames', 'image');
  for (let i = 0; i < 30; i++) E(ids.image[(i + 10) % N(ids.image)], 'out', ids.image[(i + 11) % N(ids.image)], 'refs', 'image');
  for (let i = 0; i < 20; i++) E(ids.gen[i % N(ids.gen)], 'out', ids.gen[(i + 13) % N(ids.gen)], 'refs', 'video');
  for (let i = 0; i < 30; i++) E(ids.asset[i % N(ids.asset)], 'out', ids.gen[(i + 7) % N(ids.gen)], 'refs', P.assets['pa' + (i % N(ids.asset))].kind);
  for (let i = 0; i < 20; i++) E(ids.asset[(i + 11) % N(ids.asset)], 'out', ids.image[(i + 23) % N(ids.image)], 'refs', 'image');
`;

// 1000 边配方（500 节点）
const PLAN_1000 = `
  // 前 200 条 from 全异；i>=200 的 50 条 to 偏移 +50，避免与 (i-200) 撞同一 (from,to) 对被去重
  for (let i = 0; i < 250; i++) E(ids.text[i % N(ids.text)], 'out', ids.gen[(i + (i >= 200 ? 50 : 0)) % N(ids.gen)], 'prompt', 'text');
  for (let i = 0; i < 200; i++) E(ids.text[(i + 50) % N(ids.text)], 'out', ids.image[i % N(ids.image)], 'prompt', 'text');
  for (let i = 0; i < 200; i++) E(ids.text[(i + 90) % N(ids.text)], 'out', ids.text[(i + 1) % N(ids.text)], 'prompt', 'text');
  for (let i = 0; i < 150; i++) E(ids.image[i % N(ids.image)], 'out', ids.gen[i % N(ids.gen)], 'frames', 'image');
  for (let i = 0; i < 100; i++) E(ids.image[(i + 30) % N(ids.image)], 'out', ids.image[(i + 7) % N(ids.image)], 'refs', 'image');
  for (let i = 0; i < 100; i++) E(ids.asset[i % N(ids.asset)], 'out', ids.gen[(i + 17) % N(ids.gen)], 'refs', P.assets['pa' + (i % N(ids.asset))].kind);
`;

// 一轮连续交互采样：目标上 pointerdown，每帧一次 pointermove，记录帧间隔（含渲染耗时）。
async function dragRound(page, { targetSel, frames = 220, stepX = 3, stepY = 1 }) {
  return page.evaluate(async ({ targetSel, frames, stepX, stepY }) => {
    const el0 = document.querySelector(targetSel);
    if (!el0) throw new Error('measure target missing: ' + targetSel);
    const r = el0.getBoundingClientRect();
    const sx = r.x + r.width / 2, sy = r.y + r.height / 2;
    const ev = (t, x, y) => el0.dispatchEvent(new PointerEvent(t, {
      bubbles: true, pointerId: 9, pointerType: 'mouse', button: 0,
      buttons: t === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
    }));
    const iv = [];
    ev('pointerdown', sx, sy);
    let px = sx, py = sy, prev = performance.now();
    await new Promise(done => {
      const step = () => {
        px += stepX; py += stepY;
        ev('pointermove', px, py);
        const now = performance.now();
        iv.push(now - prev); prev = now;
        if (iv.length < frames) requestAnimationFrame(step);
        else { ev('pointerup', px, py); done(); }
      };
      requestAnimationFrame(step);
    });
    return iv;
  }, { targetSel, frames, stepX, stepY });
}

test('C2 性能：200 节点/300 连线混合图，三轮连续交互帧间隔', { skip: skipIf(!BROWSER_OK, '浏览器缺失——性能未验收'), timeout: 180000 }, async t => {
  const { page, egress } = await setup(t);
  const built = await page.evaluate(buildGraphSrc({ nText: 80, nImage: 50, nGen: 40, nAsset: 30, plan: PLAN_300 }));
  assert.equal(built.counts.nodes, 200);
  assert.equal(built.counts.edges, 300, `计划 300 边，实建 ${built.counts.edges}（added=${built.counts.added}）`);
  // 0.5：测量保持默认吸附（网格 + 对齐）开启，不以关闭默认功能换取性能数字
  await new Promise(r => setTimeout(r, 800));          // 首帧布局/小地图稳定
  const rounds = [
    // R1 拖 gen 节点：多条入边跟随重算——渲染路径最重场景
    await dragRound(page, { targetSel: `[data-node="${built.ids.gen[0]}"] .node-head` }),
    // R2 画布平移：全量可见性计算 + 小地图 + 边重算
    await dragRound(page, { targetSel: '#board', stepX: -4, stepY: -2 }),
    // R3 反向拖边缘 text 节点：覆盖离屏→可见节点挂载路径
    await dragRound(page, { targetSel: `[data-node="${built.ids.text[79]}"] .node-head`, stepX: -3, stepY: 2 }),
  ];
  const table = rounds.map((iv, i) => {
    const xs = iv.slice(4);                            // 丢前 4 帧预热
    return { round: i + 1, frames: xs.length, p50: quantile(xs, .5), p95: quantile(xs, .95), max: Math.max(...xs) };
  });
  console.log('PERF_MEASURE ' + JSON.stringify({ viewport: '1440x900', nodes: 200, edges: 300, target: 'p95<=50ms', rounds: table }));
  for (const r of table) console.log(`  R${r.round}: n=${r.frames} p50=${fmt(r.p50)} p95=${fmt(r.p95)} max=${fmt(r.max)}`);
  // 交互后完整性抽查：边归属未串、端口几何仍对齐、文本内容未丢
  const integrity = await page.evaluate(([genId]) => {
    const x = window.__xp, P = x.store.project;
    const edge = P.edges.find(e => e.to.node === genId) ?? P.edges[0];
    const p = x.board.portCenter(edge.from.node, 'out', 'out');
    const path = document.querySelector(`[data-edge="${edge.id}"] path`)?.getAttribute('d') ?? '';
    const m = path.match(/^M ([\d.-]+) ([\d.-]+)/);
    const aligned = m && p ? Math.abs(+m[1] - p.x) < 2 && Math.abs(+m[2] - p.y) < 2 : null;
    const ownership = P.edges.every(e => P.nodes.some(n => n.id === e.from.node) && P.nodes.some(n => n.id === e.to.node));
    const unique = new Set(P.edges.map(e => e.id)).size === P.edges.length;
    const textNode = P.nodes.find(n => n.type === 'text');
    return { aligned, ownership, unique, edgeCount: P.edges.length, nodeCount: P.nodes.length, textKept: textNode?.data?.text };
  }, [built.ids.gen[0]]);
  assert.equal(integrity.nodeCount, 200);
  assert.equal(integrity.edgeCount, 300);
  assert.equal(integrity.ownership, true, '连线归属完整：from/to 节点均存在');
  assert.equal(integrity.unique, true, '边 id 无重复');
  assert.equal(integrity.aligned, true, '采样边起点与源端口几何对齐');
  assert.match(integrity.textKept ?? '', /剧本段/);
  assert.deepEqual(egress(), [], '测量全程零非 loopback 外联');
  const worst = Math.max(...table.map(r => r.p95));
  assert.ok(worst <= P95_TARGET, `P95=${fmt(worst)} 超阈值 ${P95_TARGET}ms（如实上报不降阈值）`);
});

test('C2 完整性：500 节点/1000 连线不崩溃、不丢数据、归属正确', { skip: skipIf(!BROWSER_OK, '浏览器缺失——完整性未验收'), timeout: 300000 }, async t => {
  const { page, egress } = await setup(t);
  const built = await page.evaluate(buildGraphSrc({ nText: 200, nImage: 140, nGen: 100, nAsset: 60, plan: PLAN_1000 }));
  assert.equal(built.counts.nodes, 500);
  assert.equal(built.counts.edges, 1000, `计划 1000 边，实建 ${built.counts.edges}（added=${built.counts.added}）`);
  await new Promise(r => setTimeout(r, 1500));
  // 参照性帧采样（非验收阈值，只记录）
  const iv = await dragRound(page, { targetSel: `[data-node="${built.ids.gen[0]}"] .node-head`, frames: 60 });
  const xs = iv.slice(4);
  console.log('PERF_INTEGRITY ' + JSON.stringify({ nodes: 500, edges: 1000, frames: xs.length, p50: quantile(xs, .5), p95: quantile(xs, .95), max: Math.max(...xs), note: '参照值非验收阈值' }));
  const check = await page.evaluate(() => {
    const x = window.__xp, P = x.store.project;
    const ids = new Set(P.nodes.map(n => n.id));
    return {
      nodes: P.nodes.length, edges: P.edges.length,
      ownership: P.edges.every(e => ids.has(e.from.node) && ids.has(e.to.node)),
      unique: new Set(P.edges.map(e => e.id)).size === P.edges.length,
    };
  });
  assert.equal(check.nodes, 500); assert.equal(check.edges, 1000);
  assert.equal(check.ownership, true); assert.equal(check.unique, true);
  // 持久化后重载：数据不丢
  await page.evaluate(() => window.__xp.store.flush());
  await page.reload();
  await page.waitForFunction(() => window.__xp?.store?.project, { timeout: 60000 });
  const after = await page.evaluate(() => ({ n: window.__xp.store.project.nodes.length, e: window.__xp.store.project.edges.length }));
  assert.deepEqual(after, { n: 500, e: 1000 }, '重载后 500/1000 全量存活');
  assert.deepEqual(egress(), [], '完整性验证全程零非 loopback 外联');
});
