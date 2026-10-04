// dbg: node click → inspector
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('../../portal/node_modules/playwright-core');
const { createCanvasServer } = await import('../server/app.mjs');
const { join } = await import('node:path');

const server = createCanvasServer({
  staticDir: join(import.meta.dirname, '..', 'dist'),
  directorDir: join(import.meta.dirname, '..', '..', '..', 'docs', 'minimax-video-ref', 'bundled-plugins', '3d-director-stage'),
  upstreamFetch: async () => Response.json({ data: [] }),
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
p.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
await p.goto(`http://127.0.0.1:${port}/`);
await p.waitForFunction(() => window.__xp?.store?.project, null, { timeout: 10000 });
await p.evaluate(() => window.__xp.store.addNode('gen', 300, 200, { draft: {}, perModel: {} }));
await p.waitForTimeout(300);
console.log('nodes:', await p.locator('.node').count(), 'gen:', await p.locator('.node-gen').count());
const box = await p.locator('.node-gen .node-head').boundingBox();
console.log('head box:', JSON.stringify(box));
await p.mouse.move(box.x + 40, box.y + 10); await p.mouse.down(); await p.mouse.up();
await p.waitForTimeout(300);
console.log('selected:', JSON.stringify(await p.evaluate(() => window.__xp.board?.selected ?? null)));
console.log('inspector html head:', (await p.locator('#inspector').innerHTML()).slice(0, 300));
console.log('selects:', await p.locator('#inspector select').count());
await b.close(); server.closeAllConnections(); server.close();
