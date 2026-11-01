import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, CHROME, ROOT, createCanvasServer, makeState, mockUpstream, MODELS_11, setKey, watchEgress } from './e2e-helpers.mjs';

// A node created from the empty-board menu lands in the middle of the view. The
// floating editor hangs below it, so without making room it was squeezed to its
// minimum height on a laptop screen: the fields hidden behind the submit row.
// Creating the first node of an empty board now makes room once, as a click on
// the node does; later additions never move the board (repeated moves would
// push the earlier nodes out of view).
test('a video node created from the menu gets room for its editor', { timeout: 90000 }, async t => {
  const state = makeState(), upstream = mockUpstream(state);
  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), upstreamFetch: (url, init) =>
    new URL(url).pathname.endsWith('/models') ? Response.json({ data: MODELS_11.map(id => ({ id })) }) : upstream(url, init) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser; t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await watchEgress(page, { abort: true });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__xp?.store.project); await setKey(page);
  const viewBefore = await page.evaluate(() => window.__xp.board.view.y);
  await page.getByText('新建视频节点', { exact: true }).click();
  await page.waitForSelector('#inspector.node-composer');
  await page.waitForFunction(before => window.__xp.board.view.y < before - 8, viewBefore);
  const placed = await page.evaluate(() => {
    const id = window.__xp.board.selectedIds[0];
    const root = document.querySelector(`[data-node="${id}"]`), node = root.getBoundingClientRect();
    const head = root.querySelector('.node-head').getBoundingClientRect();
    const editor = document.getElementById('inspector').getBoundingClientRect();
    return { below: editor.top >= node.bottom + 4, headVisible: head.top >= 60, height: Math.round(editor.height),
      submitVisible: document.querySelector('#inspector .gen-cta button.primary').getBoundingClientRect().bottom <= innerHeight };
  });
  assert.ok(placed.below && placed.headVisible && placed.submitVisible, JSON.stringify(placed));
  assert.ok(placed.height > 240, `the editor got room beyond its 220px minimum: ${JSON.stringify(placed)}`);
  // A second node from the toolbar does not move the board again.
  const afterFirst = await page.evaluate(() => window.__xp.board.view.y);
  // The palette lives in a closed dock; its button is pressed directly.
  await page.evaluate(() => document.querySelector('[data-add-node="gen"]').click());
  await page.waitForFunction(() => window.__xp.store.project.nodes.length === 2);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__xp.board.view.y), afterFirst, 'only the first node of an empty board makes room');
  // Selecting in code (no user request) still never moves the board.
  const view = await page.evaluate(() => window.__xp.board.view.y);
  await page.evaluate(() => {
    const x = window.__xp;
    const n = x.store.addNode('gen', 40, 40, { draft: { model: 'minimax-h3-768p-per-second', intent: 'text', seconds: 5, ratio: '16:9', prompt: '' }, perModel: {} });
    x.board.select('node', n.id);
  });
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__xp.board.view.y), view);
  assert.deepEqual(errors, []);
  assert.equal(state.creates.length + state.uploads.length, 0, 'creating and editing is local and nonbillable');
});
