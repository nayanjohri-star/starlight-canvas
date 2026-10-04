// 0.4.1 串联验收（浏览器黑盒，全 loopback mock，零生产零付费）：
//   TXT 剧本文件 → 预览后应用为分镜 → 建图计划预览/应用（重复应用不重复建节点）
//   → 分镜「批量生成」真实确认弹窗 → 冻结计划执行（每个新节点一次创建 POST、键互不相同）
//   → 再次批量：仅补空白全部复用，零新增 POST
//   → 按分镜顺序入轨（同计划二次确认被拒，不重复片段）
//   → 时间线界面「导出项目包」真实下载 → 全新浏览器上下文（干净 IndexedDB）界面「导入项目包」
//   → 分镜/节点/片段/素材完整恢复，恢复轮询与刷新均零生成 POST
// 全程收集 pageerror 与 console.error（验收矩阵第 16 行），并阻断非 loopback 外联。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  chromium, createCanvasServer, ROOT, MP4, CHROME, BROWSER_OK,
  makeState, mockUpstream, setKey, watchEgress,
} from './e2e-helpers.mjs';
import { parseProjectPackage } from '../src/export-project.js';

const MODEL = 'minimax-h3-768p-per-second';
const SCRIPT = [
  '镜头一：清晨湖边，薄雾缓慢散开，远处有一只白鹭起飞。',
  '镜头二：主角沿木栈道走向镜头，脚步声清晰，镜头缓慢后退。',
  '镜头三：主角停下回望湖面，阳光穿过树叶洒在水面上。',
].join('\n\n');

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e?.message ?? e}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()} @ ${m.location()?.url ?? ''}`); });
  page.on('response', r => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`); });
  return errors;
}

test('串联：剧本→分镜→建图→批量生成→仅补空白→入轨→工程包界面导出/干净环境导入，零重复生成', { timeout: 240000, skip: !BROWSER_OK && '浏览器缺失：未验收' }, async t => {
  const state = makeState();
  state.videoBytes = MP4;
  const server = createCanvasServer({
    staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'),
    directorDir: join(ROOT, '..', '..', 'docs', 'minimax-video-ref', 'bundled-plugins', '3d-director-stage'),
    upstreamFetch: mockUpstream(state),
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(async () => { await browser.close().catch(() => {}); server.closeAllConnections(); await new Promise(r => server.close(r)); });

  // ---------- 1) 原环境 ----------
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p1 = await ctx1.newPage();
  const errors1 = watchErrors(p1);
  await p1.goto(origin);
  await p1.waitForFunction(() => window.__xp?.storyboards && window.__xp?.workflow && window.__xp?.timeline, null, { timeout: 30000 });
  await setKey(p1);
  const egress1 = await watchEgress(p1, { abort: true });

  // 剧本文件：先预览（prepareImport）后应用；预览本身不写项目
  const imported = await p1.evaluate(async text => {
    const x = window.__xp;
    await x.store.newProject('串联验收');
    const before = x.store.project.studio?.shots?.length ?? 0;
    const file = new File([text], '湖边.txt', { type: 'text/plain' });
    const prepared = await x.storyboards.prepareImport([file]);
    const afterPreview = x.store.project.studio?.shots?.length ?? 0;
    await x.storyboards.applyImport(prepared, { mode: 'append' });
    const shots = x.storyboards.list();
    return { before, afterPreview, previewCount: prepared.files[0].fields.length, ids: shots.map(s => s.id), titles: shots.map(s => s.title) };
  }, SCRIPT);
  assert.equal(imported.afterPreview, imported.before, '预览不得写入分镜');
  assert.equal(imported.previewCount, 3);
  assert.equal(imported.ids.length, 3, '应用后恰好 3 个分镜');

  // 建图计划：预览→应用；同一计划/重新预览再应用都不得重复建节点
  const built = await p1.evaluate(([ids, model]) => {
    const x = window.__xp;
    for (const id of ids) x.storyboards.updateShot(id, { duration: 4 });
    const r = x.storyboards.previewShotWorkflow({ shotIds: ids, template: 't2v', modelId: model });
    const nodesBefore = x.store.project.nodes.length;
    const applied = x.storyboards.applyShotWorkflow(r.plan);
    const nodesAfter = x.store.project.nodes.length;
    let again; try { again = x.storyboards.applyShotWorkflow(r.plan); } catch (e) { again = { error: String(e.message) }; }
    const r2 = x.storyboards.previewShotWorkflow({ shotIds: ids, template: 't2v', modelId: model });
    const nodesFinal = x.store.project.nodes.length;
    const gens = ids.map(id => x.storyboards.find(id).nodeId);
    for (const g of gens) { const d = x.store.node(g).data.draft; d.seconds = 4; d.ratio = '16:9'; }
    return { ok: r.ok, creates: r.plan?.creates?.length, nodesBefore, nodesAfter, again, reuse2: r2.plan?.reuses?.length, creates2: r2.plan?.creates?.length, nodesFinal, gens, applied: Boolean(applied) };
  }, [imported.ids, MODEL]);
  assert.ok(built.ok, '建图计划无冲突');
  assert.equal(built.nodesAfter - built.nodesBefore, built.creates, '应用恰好创建计划中的节点');
  assert.equal(built.nodesFinal, built.nodesAfter, '重复应用/重新预览不得重复建节点');
  assert.equal(built.creates2, 0, '已建图分镜再次预览应全部复用');
  assert.ok(built.gens.every(Boolean), '每个分镜都关联了生成节点');
  assert.equal(state.creates.length, 0, '建图不发起生成');

  // 分镜批量生成：真实确认弹窗 → 冻结计划执行
  const batch = p1.evaluate(ids => window.__xp.storyboards.batchGenerate(ids), imported.ids);
  const dialog = p1.locator('.modal', { hasText: '批量生成分镜' });
  await dialog.waitFor({ timeout: 15000 });
  const confirmText = await dialog.textContent();
  assert.match(confirmText, /新执行 3 个节点/);
  assert.match(confirmText, /1\.8 元/, '3 段 × 4 秒 × ¥0.15');
  await dialog.locator('.modal-actions button.primary', { hasText: '确认' }).click();
  await batch;
  await p1.waitForFunction(ids => ids.every(id => window.__xp.store.node(window.__xp.storyboards.find(id).nodeId)?.data.resultAssetId),
    imported.ids, { timeout: 60000, polling: 300 });
  assert.equal(state.creates.length, 3, '三个空白节点各一次创建 POST');
  assert.equal(new Set(state.creates.map(c => c.key)).size, 3, '每笔新生成使用不同幂等键');
  for (const c of state.creates) { const b = JSON.parse(String(c.body)); assert.equal(b.model, MODEL); assert.equal(b.seconds, 4); }

  // 再次批量：仅补空白应全部复用，零新增 POST（确认框如实显示）
  const again = p1.evaluate(ids => window.__xp.storyboards.batchGenerate(ids), imported.ids);
  const dialog2 = p1.locator('.modal', { hasText: '批量生成分镜' });
  await dialog2.waitFor({ timeout: 15000 });
  assert.match(await dialog2.textContent(), /新执行 0 个节点，复用 3 个/);
  await dialog2.locator('.modal-actions button.primary', { hasText: '确认' }).click();
  await again;
  assert.equal(state.creates.length, 3, '已有结果不得重复生成');

  // 按分镜顺序入轨；同一计划二次确认必须被拒，片段不重复
  const tl = await p1.evaluate(async ids => {
    const x = window.__xp;
    const r = await x.timeline.previewShotsToTimeline({ shotIds: ids });
    const a1 = await x.timeline.applyTimelinePlan(r.plan);
    const a2 = await x.timeline.applyTimelinePlan(r.plan);
    await x.store.flush();
    const clips = x.store.project.studio.timeline;
    const shotAsset = ids.map(id => x.store.node(x.storyboards.find(id).nodeId).data.resultAssetId);
    return { ok: r.ok, a1: a1.ok, a2: a2.ok, count: clips.length, order: clips.map(c => c.assetId), shotAsset };
  }, imported.ids);
  assert.ok(tl.ok && tl.a1, '入轨计划应用成功');
  assert.equal(tl.a2, false, '同一入轨计划不得二次应用');
  assert.equal(tl.count, 3);
  assert.deepEqual(tl.order, tl.shotAsset, '片段顺序与分镜顺序一致');

  // 时间线界面导出项目包（真实下载）
  await p1.click('#btn-timeline');
  await p1.locator('.tl-export > button', { hasText: '导出' }).click();
  const [download] = await Promise.all([
    p1.waitForEvent('download', { timeout: 30000 }),
    p1.locator('.tl-menu button', { hasText: '导出项目包' }).click(),
  ]);
  const zipPath = await download.path();
  const zip = await readFile(zipPath);
  assert.ok(zip.length > MP4.length * 3, '项目包应包含三段成片媒体');
  const pkg = parseProjectPackage(new Uint8Array(zip));
  const pkgText = pkg.projectJson + JSON.stringify(pkg.manifest);
  assert.ok(!pkgText.includes('sk-e2e-test') && !zip.includes(Buffer.from('sk-e2e-test')), '项目包不得包含 API 密钥');
  assert.equal(JSON.parse(pkg.projectJson).project.studio.shots.length, 3, '包内工程含 3 个分镜');
  const createsAtExport = state.creates.length;
  assert.deepEqual(egress1(), [], '原环境存在非 loopback 外联');
  assert.deepEqual(errors1, [], '原环境出现页面/console 错误');

  // ---------- 2) 干净环境：界面导入项目包 ----------
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => ctx2.close().catch(() => {}));
  const p2 = await ctx2.newPage();
  const errors2 = watchErrors(p2);
  await p2.goto(origin);
  await p2.waitForFunction(() => window.__xp?.timeline, null, { timeout: 30000 });
  await setKey(p2);
  const egress2 = await watchEgress(p2, { abort: true });
  await p2.click('#btn-timeline');
  await p2.locator('.tl-export > button', { hasText: '导出' }).click();
  const [chooser] = await Promise.all([
    p2.waitForEvent('filechooser', { timeout: 15000 }),
    p2.locator('.tl-menu button', { hasText: '导入项目包' }).click(),
  ]);
  await chooser.setFiles(zipPath);
  const importDialog = p2.locator('.modal:not(.modal-wide)', { hasText: '将创建一个新项目' });
  await importDialog.waitFor({ timeout: 15000 });
  await importDialog.locator('.modal-actions button.primary', { hasText: '确认' }).click();
  await p2.waitForFunction(() => (window.__xp.store.project?.studio?.shots?.length ?? 0) === 3, null, { timeout: 30000 });

  const restored = await p2.evaluate(async () => {
    const x = window.__xp, P = x.store.project;
    const shots = P.studio.shots;
    const gens = shots.map(s => x.store.node(s.nodeId));
    const blobs = [];
    for (const g of gens) blobs.push(Boolean(g?.data?.resultAssetId && (await x.assets.blobOf?.(g.data.resultAssetId))?.size));
    return { shots: shots.length, gens: gens.filter(Boolean).length, clips: P.studio.timeline.length, blobs, clipAssets: P.studio.timeline.map(c => c.assetId), genAssets: gens.map(g => g?.data?.resultAssetId) };
  });
  assert.equal(restored.shots, 3);
  assert.equal(restored.gens, 3, '生成节点与分镜关联恢复');
  assert.equal(restored.clips, 3, '时间线片段恢复');
  assert.deepEqual(restored.clipAssets, restored.genAssets, '片段仍指向各分镜成片');
  assert.deepEqual(restored.blobs, [true, true, true], '成片媒体随包恢复到本地');

  // 恢复/刷新：绝不补发生成 POST
  await p2.evaluate(() => window.__xp.runner.resumeAll());
  await p2.reload();
  await p2.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(state.creates.length, createsAtExport, '导入、恢复与刷新不得新建生成');
  assert.deepEqual(egress2(), [], '导入环境存在非 loopback 外联');
  assert.deepEqual(errors2, [], '导入环境出现页面/console 错误');
});
