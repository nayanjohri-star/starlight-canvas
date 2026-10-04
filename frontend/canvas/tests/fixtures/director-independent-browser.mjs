// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, CHROME, MP4, MODELS_11, REPO_ROOT } from '../e2e-helpers.mjs';
import { startHostedTopology, syntheticNewApi, signIn, HOSTED_DIST } from '../hosted-topology.mjs';
import { directorDocumentKey } from '../../src/director-protocol.js';
import { bindHostedArtifact, observeHostedDirectorRealm } from './director-artifact-realm.mjs';

export const EVIDENCE = resolve(process.env.CANVAS_DIRECTOR_EVIDENCE_DIR || join(REPO_ROOT, '_temp/director-s0/f/v04-v20'));
export function evidence(name, value) {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, name), JSON.stringify(value, null, 2));
}
export async function bootIndependent(t, { width = 1366, height = 768, zoom = 1, hardware = false, native = true, initScript, api: suppliedApi } = {}) {
  const executablePath = process.env.CANVAS_E2E_CHROME || (!native && CHROME);
  assert.ok(executablePath, 'required acceptance browser is missing');
  if (native) {
    assert.ok(process.env.CANVAS_E2E_CHROME, 'native acceptance requires an explicit installed Chrome or Edge path');
    assert.equal(process.platform, 'win32', 'the fixed native reference computer runs Windows');
    assert.match(basename(executablePath).toLowerCase(), /^(?:chrome|msedge)\.exe$/,
      'Playwright Chromium cannot substitute for a supported installed browser');
  }
  assert.ok(!hardware || native, 'hardware performance remains a native acceptance tier');
  assert.ok(existsSync(executablePath), 'explicit supported browser is available');
  const build = JSON.parse(readFileSync(join(HOSTED_DIST, 'build.json'), 'utf8'));
  assert.equal(build.mode, 'hosted');
  assert.equal(build.sourceDirty, false, 'acceptance uses a clean frozen candidate');
  assert.match(build.sourceCommit, /^[a-f0-9]{40}$/);
  if (native) assert.ok(process.env.CANVAS_DIRECTOR_CANDIDATE_SHA, 'an explicit complete artifact SHA is required');
  if (process.env.CANVAS_DIRECTOR_CANDIDATE_SHA) assert.equal(build.sourceCommit, process.env.CANVAS_DIRECTOR_CANDIDATE_SHA);
  if (native) assert.ok(process.env.CANVAS_HOSTED_URL, 'native acceptance requires actual hosted routing');
  const api = suppliedApi || syntheticNewApi({ videoBytes: MP4, models: MODELS_11 });
  const topo = await startHostedTopology({ newApi: api });
  const profile = mkdtempSync(join(tmpdir(), 'f-director-browser-'));
  mkdirSync(join(profile, 'Default'));
  // Chromium's real HostZoomMap preference, default storage partition = "x".
  // No CSS zoom, pinch emulation, or deviceScaleFactor is used to simulate it.
  writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({
    partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } },
  }));
  let ctx, closed = false;
  async function close() {
    if (closed) return; closed = true;
    try { await ctx?.close(); } finally {
      await topo.close();
      assert.equal(dirname(profile), resolve(tmpdir()));
      assert.ok(basename(profile).startsWith('f-director-browser-'));
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); // only this fresh synthetic profile
    }
  }
  t.after(close);
  try {
    const args = ['--force-device-scale-factor=1', `--window-size=${width},${height}`,
      ...(hardware ? ['--use-angle=d3d11', '--disable-software-rasterizer']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'])];
    ctx = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
      viewport: null, acceptDownloads: true, args });
    if (initScript) await ctx.addInitScript(initScript);
    const seen = [], external = [], errors = [];
    await ctx.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
      if (url.origin !== topo.origin) { external.push(`${req.method()} ${url.origin}${url.pathname}`); return route.abort(); }
      seen.push({ method: req.method(), path: url.pathname }); return route.continue();
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(`${topo.origin}/canvas/`); await signIn(page, 'sk-synth-alice');
    await page.waitForLoadState('networkidle');
    const actualResourceIdentity = await bindHostedArtifact(page, { artifact: build, hostUrl: `${topo.origin}/canvas/` });
    // Calibrate physical CONTENT size, accounting for native window chrome.
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    for (let i = 0; i < 3; i++) {
      const metrics = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
      const dx = Math.round(width - metrics.w * zoom), dy = Math.round(height - metrics.h * zoom);
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break;
      const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + dx, height: bounds.height + dy } });
      await page.waitForTimeout(100);
    }
    await cdp.detach();
    const metrics = await page.evaluate(() => ({ innerWidth, innerHeight, outerWidth, outerHeight,
      dpr: devicePixelRatio, visualScale: visualViewport.scale, cssZoom: getComputedStyle(document.documentElement).zoom }));
    assert.ok(Math.abs(metrics.dpr - zoom) < 0.01, `actual browser zoom DPR: ${JSON.stringify(metrics)}`);
    assert.ok(Math.abs(metrics.innerWidth * zoom - width) <= 1.5 && Math.abs(metrics.innerHeight * zoom - height) <= 1.5,
      `actual physical content size: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.visualScale, 1, 'page pinch scale stays unchanged');
    assert.ok(['1', 'normal'].includes(metrics.cssZoom), 'CSS zoom stays unchanged');
    const identity = { artifact: build, browser: ctx.browser().version(), executablePath, args, metrics,
      topology: topo.external ? 'actual-Caddy' : 'local-static-semantics', origin: topo.origin, zoom, hardware, native,
      actualResourceIdentity };
    t.diagnostic(`identity=${JSON.stringify(identity)}`);
    return { page, ctx, api, seen, external, errors, identity, close };
  } catch (error) { await close(); throw error; }
}
export const bootFunctional = (t, options = {}) => bootIndependent(t, { ...options, native: false, hardware: false, zoom: 1 });
export async function openDirector(page) {
  await page.locator('#btn-director-mode').click();
  const locator = page.locator('iframe.director-frame'); await locator.waitFor({ state: 'visible' });
  const handle = await locator.elementHandle();
  let frame; try { frame = await handle.contentFrame(); } finally { await handle.dispose(); }
  assert.ok(frame);
  const url = new URL(await locator.getAttribute('src'), page.url());
  const scope = Object.fromEntries(['sessionId', 'projectId', 'nodeId'].map(key => [key, url.searchParams.get(key)]));
  assert.equal(url.origin, new URL(page.url()).origin);
  await frame.waitForFunction(() => {
    const crash = document.querySelector('.crash-screen .crash-detail');
    if (crash) throw new Error(crash.textContent);
    return window.__starlightDirector?.status?.().loaded && window.__cozyclay?.rigA;
  }, null, { timeout: 60000 });
  const realm = await observeHostedDirectorRealm(page, frame, url.href);
  return { frame, scope, realm };
}
export const activeScene = project => project.scenes.scenes.find(scene => scene.id === project.scenes.activeSceneId);
export const projectOf = frame => frame.evaluate(async () => JSON.parse(await window.__cozyclayProject.export('F synthetic independent project')));
export async function dualCharacters(frame) {
  const fixture = await projectOf(frame), scene = activeScene(fixture), first = scene.stage.characters[0];
  scene.stage.characters = [{ ...first, id: 'f-independent-a', subject: '合成角色甲', x: -1.2, y: 0, z: 0, hidden: false },
    { ...structuredClone(first), id: 'f-independent-b', subject: '合成角色乙', x: 1.2, y: 0, z: 0, hidden: false }];
  const result = await frame.evaluate(text => window.__cozyclayProject.open(text), JSON.stringify(fixture));
  assert.equal(result.ok, true);
  await frame.waitForFunction(() => ['f-independent-a', 'f-independent-b'].every(id => window.__cozyclayMcpRigReady?.includes(id)),
    null, { timeout: 30000 });
  return projectOf(frame);
}
export async function characterXInput(frame) {
  await frame.locator('[data-node-id="characterA"] > .hierarchy-row').click();
  const head = frame.locator('.foldout-head:visible').filter({ hasText: /Transform|Placement|变换|摆放|位置/ }).first();
  await head.waitFor(); if (await head.getAttribute('aria-expanded') === 'false') await head.click();
  return frame.locator('.vec3-row:visible').filter({ has: frame.locator('.vec3-label', { hasText: /Position|位置/ }) }).first()
    .locator('.number-field').filter({ has: frame.locator('.axis', { hasText: /^X$/ }) }).locator('input');
}
export async function saveAndRead(page, frame, scope) {
  await frame.getByTestId('hosted-director-save').click();
  const completed = await frame.evaluate(() => window.__starlightDirector.save());
  const result = await page.evaluate(async ({ scope, key }) => {
    const record = (await window.__xp.store.directorKV(scope.nodeId))[key];
    const blob = await window.__xp.assets.blobOf(record.scene.projectRef.slice(11));
    const bytes = await blob.arrayBuffer();
    return { record, project: JSON.parse(new TextDecoder().decode(bytes)), sha256:
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('') };
  }, { scope, key: directorDocumentKey(scope.projectId, scope.nodeId) });
  assert.equal(result.record.rev, completed.rev);
  assert.equal(result.sha256, result.record.scene.projectSha256);
  return result;
}
export function noModelCalls(run) {
  assert.equal(run.api.state.creates.length, 0); assert.equal(run.api.state.images.length, 0);
  assert.deepEqual(run.seen.filter(req => /\/canvas-api\/v1\/(?:chat\/completions|images\/(?:generations|edits)|videos(?:\/|$))/.test(req.path)), []);
  assert.deepEqual(run.external, []); assert.deepEqual(run.errors, []);
}
