// SPDX-License-Identifier: AGPL-3.0-or-later
// F independent acceptance: real hosted canvas, real CozyClay/WebGL and the
// real host adapter. Only the account/provider data plane is synthetic.
// Required release coverage: missing browsers/resources fail; there is no skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitUiCondition } from './fixtures/director-ui-wait.mjs';
import { bindHostedArtifact, observeHostedDirectorRealm } from './fixtures/director-artifact-realm.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chromium, CHROME, BROWSER_OK, MP4, MODELS_11, REPO_ROOT, realPng, clickCanvasAction,
} from './e2e-helpers.mjs';
import { startHostedTopology, syntheticNewApi, signIn, HOSTED_DIST } from './hosted-topology.mjs';
import {
  DIRECTOR_NAMESPACE, DIRECTOR_PROTOCOL_VERSION, directorDocumentKey, directorEnvelope,
} from '../src/director-protocol.js';

const DIRECTOR_RESOURCE = /\/director\//;
const MODEL_REQUEST = /\/canvas-api\/v1\/(?:chat\/completions|images\/(?:generations|edits)|videos(?:\/|$))/;
const IDB_FAILURE = () => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (window.__fRejectDirectorBlob && this.name === 'blobs')
      throw new DOMException('F synthetic disk-full failure', 'QuotaExceededError');
    return put.call(this, value, key);
  };
};
const OBSERVE_DIRECTOR_GL = () => {
  if (window.parent === window) { window.__fDirectorGl = []; return; }
  if (!/\/director\/index\.html$/.test(location.pathname)) return;
  const getContext = HTMLCanvasElement.prototype.getContext, observed = new WeakSet();
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const context = getContext.call(this, type, ...args);
    if (/^webgl2?$/.test(type) && context && !observed.has(context)) {
      observed.add(context);
      // Weak references observe real contexts without retaining the iframe or
      // its renderer. An explicit loss or collection makes the context inactive.
      // This record lives in the parent array. A child-realm object literal
      // retains its Object.prototype/constructor and therefore its old window,
      // even when the GL reference is weak. Keep the record's realm parent-side.
      const record = new parent.Object();
      record.ref = new parent.WeakRef(context);
      record.lost = false;
      parent.__fDirectorGl.push(record);
      this.addEventListener('webglcontextlost', () => { record.lost = true; }, { once: true });
    }
    return context;
  };
};

async function boot(t) {
  assert.equal(BROWSER_OK, true, 'required hosted director browser is installed');
  const executablePath = process.env.CANVAS_E2E_CHROME || CHROME;
  assert.ok(existsSync(executablePath), 'the explicitly selected supported browser exists');
  const build = JSON.parse(readFileSync(join(HOSTED_DIST, 'build.json'), 'utf8'));
  assert.equal(build.mode, 'hosted');
  assert.match(build.sourceCommit, /^[a-f0-9]{40}$/);
  if (process.env.CANVAS_DIRECTOR_CANDIDATE_SHA)
    assert.equal(build.sourceCommit, process.env.CANVAS_DIRECTOR_CANDIDATE_SHA, 'test the fixed candidate SHA');
  t.diagnostic(`candidate=${build.sourceCommit} contentHash=${build.contentHash} topology=${process.env.CANVAS_HOSTED_URL ? 'external-Caddy' : 'local-static-semantics'}`);
  const api = syntheticNewApi({ videoBytes: MP4, models: MODELS_11 });
  const topo = await startHostedTopology({ newApi: api });
  t.after(() => topo.close());
  const browser = await chromium.launch({ executablePath, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'] });
  t.diagnostic(`browser=${browser.version()} executable=${executablePath}`);
  t.after(() => browser.close().catch(() => {}));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(IDB_FAILURE);
  await ctx.addInitScript(OBSERVE_DIRECTOR_GL);
  const seen = [], external = [], errors = [];
  await ctx.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== topo.origin) { external.push(`${req.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    seen.push({ method: req.method(), path: url.pathname });
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto(`${topo.origin}/canvas/`);
  await signIn(page, 'sk-synth-alice');
  await page.waitForLoadState('networkidle');
  const actualResourceIdentity = await bindHostedArtifact(page, { artifact: build, hostUrl: `${topo.origin}/canvas/`,
    onObserved: realm => t.diagnostic(`observedHostedDirector=${JSON.stringify(realm)}`) });
  t.diagnostic(`observedHostedParent=${JSON.stringify(actualResourceIdentity.parent)}`);
  return { api, topo, page, ctx, seen, external, errors, actualResourceIdentity };
}

async function openDirector(page) {
  await page.locator('#btn-director-mode').click();
  const element = page.locator('iframe.director-frame');
  await element.waitFor({ state: 'visible', timeout: 30000 });
  const src = new URL(await element.getAttribute('src'), page.url());
  const expected = await page.evaluate(() => new URL('director/index.html', document.baseURI).href);
  assert.equal(`${src.origin}${src.pathname}`, expected, 'iframe uses the hosted immutable module graph');
  const scope = Object.fromEntries(['sessionId', 'projectId', 'nodeId'].map(key => [key, src.searchParams.get(key)]));
  for (const [key, value] of Object.entries(scope)) assert.ok(value, `iframe binds ${key}`);
  assert.equal(src.origin, new URL(page.url()).origin, 'hosted frame is same origin');
  assert.equal(scope.projectId, await page.evaluate(() => window.__xp.store.project.id));
  const handle = await element.elementHandle();
  let frame;
  try { frame = await handle.contentFrame(); }
  finally { await handle.dispose(); }
  assert.ok(frame);
  await frame.waitForFunction(() => {
    const crash = document.querySelector('.crash-screen .crash-detail');
    if (crash) throw new Error(crash.textContent);
    return window.__starlightDirector?.status?.().loaded && window.__cozyclayProject?.export && window.__cozyclay?.rigA;
  }, null, { timeout: 60000 });
  const realm = await observeHostedDirectorRealm(page, frame, src.href);
  assert.equal(await frame.evaluate(() => [...document.querySelectorAll('canvas')].some(canvas =>
    !!(canvas.getContext('webgl2') || canvas.getContext('webgl')))), true, 'real WebGL scene initialized');
  return { frame, scope, realm };
}


async function serializedProject(frame) {
  return frame.evaluate(async () => JSON.parse(await window.__cozyclayProject.export('F synthetic director project')));
}
function activeScene(project) {
  return project.scenes.scenes.find(scene => scene.id === project.scenes.activeSceneId);
}
async function readDocument(page, scope) {
  return page.evaluate(async ({ nodeId, key }) => (await window.__xp.store.directorKV(nodeId))[key],
    { nodeId: scope.nodeId, key: directorDocumentKey(scope.projectId, scope.nodeId) });
}
async function waitSaved(page, scope, minRev = 1) {
  await waitUiCondition(page, async ({ nodeId, key, minRev }) => {
    const record = (await window.__xp.store.directorKV(nodeId))[key];
    return Number.isInteger(record?.rev) && record.rev >= minRev && /^xp-asset:\/\//.test(record.scene?.projectRef ?? '');
  }, { nodeId: scope.nodeId, key: directorDocumentKey(scope.projectId, scope.nodeId), minRev },
  { timeout: 30000, description: 'saved hosted document contains the completed project revision' });
  return readDocument(page, scope);
}
async function saveFromUi(page, frame, scope) {
  await frame.getByTestId('hosted-director-save').click();
  // The click queues an asynchronous save. An earlier autosave already has
  // rev >= 1, so observing that alone does not prove THIS edit is durable.
  // The same public save seam queues behind the click and returns its complete
  // revision; unchanged checkpoints must be no-ops rather than extra writes.
  const completed = await frame.evaluate(() => window.__starlightDirector.save());
  assert.ok(Number.isInteger(completed?.rev) && completed.rev >= 1, 'save returns a completed revision');
  const record = await waitSaved(page, scope, completed.rev);
  assert.equal(record.rev, completed.rev, 'wait for the completed save, not an older autosave');
  assert.equal(record.scene.projectRef, completed.scene.projectRef);
  assert.equal(record.scene.projectSha256, completed.scene.projectSha256);
  await frame.waitForFunction(() => window.__starlightDirector.status().saveState === 'saved');
  return record;
}
async function projectBlob(page, document) {
  return page.evaluate(async ({ projectRef, projectSha256 }) => {
    const id = projectRef.slice('xp-asset://'.length);
    const blob = await window.__xp.assets.blobOf(id);
    if (!blob) throw new Error(`missing persisted project asset ${id}`);
    const bytes = await blob.arrayBuffer();
    const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    return { project: JSON.parse(new TextDecoder().decode(bytes)), actual, expected: projectSha256, bytes: blob.size };
  }, document.scene);
}
async function assetIds(page) {
  return page.evaluate(() => Object.keys(window.__xp.store.project.assets ?? {}).sort());
}
async function setCharacterX(frame, row, value) {
  await frame.locator(`[data-node-id="${row}"] > .hierarchy-row`).click();
  const transform = frame.locator('.foldout-head:visible').filter({ hasText: /Transform|Placement|变换|摆放|位置/ }).first();
  await transform.waitFor();
  if (await transform.getAttribute('aria-expanded') === 'false') await transform.click();
  const position = frame.locator('.vec3-row:visible').filter({ has: frame.locator('.vec3-label', { hasText: /Position|位置/ }) }).first();
  const input = position.locator('.number-field').filter({ has: frame.locator('.axis', { hasText: /^X$/ }) }).locator('input');
  await input.fill(String(value));
  const nextFrame = await frame.evaluate(() => {
    const next = window.__cozyclay.tlFrame === 0 ? 1 : 0;
    window.__cozyclay.scrub(next);
    return next;
  });
  await frame.waitForFunction(frame => window.__cozyclay.tlFrame === frame, nextFrame);
  assert.equal(await input.inputValue(), String(value), 'live timeline re-render keeps the input draft');
  assert.equal(await input.evaluate(element => document.activeElement === element), true, 'live timeline re-render preserves input focus');
  await input.press('Enter');
  await input.blur();
}
function assertNoModelCalls({ api, seen, external, errors }) {
  assert.equal(api.state.creates.length, 0);
  assert.equal(api.state.images.length, 0);
  assert.deepEqual(seen.filter(request => MODEL_REQUEST.test(request.path)), [], 'ordinary edits/export/save never call model routes');
  assert.deepEqual(external, [], 'editor, fonts, models and workers never leave hosted origin');
  assert.deepEqual(errors, [], 'no uncaught browser failures');
}

test('hosted director: lazy /canvas entry, real dual characters, full-project refresh recovery and PNG returns to canvas without model calls', { timeout: 240000 }, async t => {
  const run = await boot(t), { page, seen } = run;
  assert.deepEqual(seen.filter(request => DIRECTOR_RESOURCE.test(request.path)), [], 'canvas startup does not download the director');
  assert.equal(await page.locator('iframe.director-frame').count(), 0);
  const { frame, scope } = await openDirector(page);
  assert.ok(seen.some(request => /\/director\/index\.html$/.test(request.path)));

  // The fixture comes from a clean browser's production serializer. Importing
  // via the existing project seam avoids native OS pickers, not the real parser.
  const fixture = await serializedProject(frame), scene = activeScene(fixture);
  assert.ok(scene?.stage?.characters?.[0], 'clean default project contains a supported character');
  const first = scene.stage.characters[0];
  scene.name = 'F synthetic dual-character scene';
  scene.stage.characters = [
    { ...first, id: 'f-synthetic-character-a', x: -1.2, y: 0, z: 0, hidden: false, subject: 'Synthetic character A' },
    { ...structuredClone(first), id: 'f-synthetic-character-b', x: 1.2, y: 0, z: 0, hidden: false, subject: 'Synthetic character B' },
  ];
  fixture.name = 'F synthetic dual-character project';
  const imported = await frame.evaluate(text => window.__cozyclayProject.open(text), JSON.stringify(fixture));
  assert.equal(imported.ok, true, 'production project parser accepts the synthetic fixture');
  await frame.waitForFunction(() => ['f-synthetic-character-a', 'f-synthetic-character-b'].every(id => window.__cozyclayMcpRigReady?.includes(id)), null, { timeout: 30000 });
  await setCharacterX(frame, 'characterA', -1.35);
  await setCharacterX(frame, 'characterB', 1.65);
  const edited = await serializedProject(frame), characters = activeScene(edited).stage.characters;
  assert.equal(characters.length, 2);
  assert.equal(characters[0].x, -1.35, 'editing B preserves A');
  assert.equal(characters[1].x, 1.65, 'B edits its own position');
  const record = await saveFromUi(page, frame, scope);
  const persisted = await projectBlob(page, record);
  assert.ok(persisted.bytes > 0);
  assert.equal(persisted.actual, persisted.expected, 'saved full-project blob has verified SHA-256');
  assert.deepEqual(activeScene(persisted.project).stage.characters, characters, 'host record points to the complete authored cast');
  await page.evaluate(() => window.__xp.store.flush());
  await page.reload();
  await page.waitForFunction(() => window.__xp?.store?.project);
  assert.equal(await page.evaluate(() => window.__xp.store.project.id), scope.projectId);
  assert.equal(await page.locator('iframe.director-frame').count(), 0, 'refresh does not reopen heavyweight editor');
  const reopened = await openDirector(page);
  assert.equal(reopened.scope.nodeId, scope.nodeId);
  assert.notEqual(reopened.scope.sessionId, scope.sessionId, 'refresh creates a new session');
  assert.deepEqual(activeScene(await serializedProject(reopened.frame)).stage.characters, characters, 'characters restore from host project bytes');

  const before = await assetIds(page);
  await reopened.frame.getByTestId('hosted-director-export-png').click();
  await page.waitForFunction(ids => Object.values(window.__xp.store.project.assets).some(asset => asset.kind === 'image' && !ids.includes(asset.id)), before, { timeout: 60000 });
  const image = await page.evaluate(async ids => {
    const asset = Object.values(window.__xp.store.project.assets).find(item => item.kind === 'image' && !ids.includes(item.id));
    const node = window.__xp.store.project.nodes.find(item => item.type === 'asset' && item.data.assetId === asset.id);
    const bitmap = await createImageBitmap(await window.__xp.assets.blobOf(asset.id));
    try { return { id: asset.id, fromDirector: asset.fromDirector, mime: asset.mime, size: asset.size, nodeId: node?.id, width: bitmap.width, height: bitmap.height }; }
    finally { bitmap.close(); }
  }, before);
  assert.equal(image.fromDirector, scope.nodeId);
  assert.equal(image.mime, 'image/png');
  assert.ok(image.nodeId && image.size > 0 && image.width > 0 && image.height > 0, 'real decoded PNG and asset node are committed together');
  assertNoModelCalls(run);
});

test('hosted director: incomplete/stale exports and disk failure never create success assets; project/account changes invalidate the old session', { timeout: 240000 }, async t => {
  const run = await boot(t), { page, topo } = run;
  const { frame, scope } = await openDirector(page);
  const record = await saveFromUi(page, frame, scope), png = await realPng(page);
  const before = await assetIds(page);
  const publish = async patch => frame.evaluate(async ({ bytes, patch, rev }) => {
    try {
      await window.__starlightDirector.rpc('output.publish', { kind: 'image', mime: 'image/png', name: 'F synthetic negative export.png',
        bytes: new Uint8Array(bytes).buffer, completed: true, sceneRevision: rev, ...patch });
      return { rejected: false };
    } catch (error) { return { rejected: true, message: error.message, code: error.code ?? null }; }
  }, { bytes: png, patch, rev: record.rev });
  assert.equal((await publish({ completed: false })).rejected, true, 'unfinished export rejected');
  assert.equal((await publish({ sceneRevision: record.rev - 1 })).rejected, true, 'stale scene export rejected');
  assert.deepEqual(await assetIds(page), before, 'rejected exports create no asset metadata or nodes');

  // Inject a real host IndexedDB write failure; the editor still renders and
  // takes its normal PNG path. Failure must be visible and no success returned.
  await page.evaluate(() => { window.__fRejectDirectorBlob = true; });
  await frame.getByTestId('hosted-director-export-png').click();
  await frame.waitForFunction(() => {
    const status = typeof window.__starlightDirector.status === 'function' ? window.__starlightDirector.status() : window.__starlightDirector.status;
    return !status?.busy && /F synthetic disk-full failure|QuotaExceeded|保存失败|导出失败/.test(document.body.innerText);
  }, null, { timeout: 30000 });
  await page.evaluate(() => { window.__fRejectDirectorBlob = false; });
  assert.deepEqual(await assetIds(page), before);
  assert.equal((await readDocument(page, scope)).rev, record.rev, 'last complete document survives failed bytes write');

  await page.evaluate(() => { window.__fOldDirectorWindow = document.querySelector('iframe.director-frame').contentWindow; });
  const newPid = await page.evaluate(async () => { await window.__xp.store.newProject('F synthetic second project'); return window.__xp.store.project.id; });
  assert.notEqual(newPid, scope.projectId);
  await page.locator('iframe.director-frame').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(id => window.__xp.host.isOpen(id), scope.nodeId), false, 'project switch terminates old host session');
  const oldOutput = directorEnvelope(scope, 'f-late-output', 'output.publish', { kind: 'image', mime: 'image/png', name: 'F late export.png', completed: true, sceneRevision: record.rev });
  await page.evaluate(({ envelope, png }) => {
    envelope.payload.bytes = new Uint8Array(png).buffer;
    window.dispatchEvent(new MessageEvent('message', { data: envelope, source: window.__fOldDirectorWindow, origin: location.origin }));
  }, { envelope: oldOutput, png });
  assert.deepEqual(await assetIds(page), [], 'old session cannot publish into the new project');
  await page.locator('#project-list').selectOption(scope.projectId);
  await page.waitForFunction(pid => window.__xp.store.project.id === pid, scope.projectId);
  assert.equal((await readDocument(page, scope)).rev, record.rev);
  assert.equal(await page.locator('iframe.director-frame').count(), 0);

  await signIn(page, 'sk-synth-bob');
  assert.notEqual(await page.evaluate(() => window.__xp.store.project.id), scope.projectId, 'another account cannot resume Alice project');
  assert.equal(await page.locator('#project-list option').filter({ hasText: 'F synthetic second project' }).count(), 0);
  assert.deepEqual(await assetIds(page), []);
  await signIn(page, 'sk-synth-alice');
  assert.equal(new URL(page.url()).origin, topo.origin);
  assert.equal(await page.evaluate(() => window.__xp.store.project.id), scope.projectId, 'original account retains its project');
  assert.equal((await readDocument(page, scope)).rev, record.rev, 'account switch preserves prior complete revision');
  assertNoModelCalls(run);
});

test('hosted director: 20 ordinary open/close cycles and visible project-list switches release WebGL contexts and workers without accumulating DOM listeners', { timeout: 360000 }, async t => {
  const run = await boot(t), { page, ctx } = run;
  const cdp = await ctx.newCDPSession(page);
  t.after(() => cdp.detach().catch(() => {}));
  // This fresh synthetic profile owns both projects. The full-screen director
  // modal blocks the background selector, so close normally before switching.
  const projectA = await page.evaluate(() => window.__xp.store.project.id);
  await clickCanvasAction(page, '#btn-new-project');
  await page.waitForFunction(previous => window.__xp.store.project.id !== previous
    && document.querySelector('#project-list').value === window.__xp.store.project.id, projectA);
  const projectB = await page.evaluate(() => window.__xp.store.project.id);
  assert.notEqual(projectA, projectB, 'the fixture owns two distinct synthetic projects');
  const projectList = page.locator('#project-list');
  await projectList.selectOption(projectA);
  await page.waitForFunction(id => window.__xp.store.project.id === id
    && document.querySelector('#project-list').value === id, projectA);
  t.diagnostic(`lifecyclePlan=${JSON.stringify({ projects: [projectA, projectB], cycles: 20,
    closeReason: 'ordinary-close-button', switchTrigger: 'visible-project-list-after-close' })}`);
  const samples = [];
  for (let cycle = 1; cycle <= 20; cycle++) {
    const fromProjectId = cycle % 2 ? projectA : projectB;
    const toProjectId = cycle % 2 ? projectB : projectA;
    assert.equal(await page.evaluate(() => window.__xp.store.project.id), fromProjectId);
    const { frame, scope } = await openDirector(page);
    assert.equal(scope.projectId, fromProjectId, `cycle ${cycle} opens the selected project`);
    await frame.evaluate(() => window.__starlightDirector.save());
    const modal = page.locator('.modal').filter({ has: page.locator('iframe.director-frame') });
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('iframe.director-frame').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(id => window.__xp.host.isOpen(id), scope.nodeId), false);
    assert.equal(await projectList.evaluate(element => {
      const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === element || element.contains(hit);
    }), true, `cycle ${cycle} exposes the real project selector after ordinary close`);
    await projectList.click({ trial: true }); // Check pointer actionability; never force through the modal mask.
    assert.deepEqual(await projectList.selectOption(toProjectId), [toProjectId]);
    await page.waitForFunction(id => window.__xp.store.project.id === id
      && document.querySelector('#project-list').value === id, toProjectId);
    assert.equal(await page.evaluate(id => window.__xp.host.isOpen(id), scope.nodeId), false,
      `cycle ${cycle} leaves the old session closed after project selection`);
    const deadline = Date.now() + 10000;
    while (page.workers().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(page.workers().length, 0, `cycle ${cycle} leaves no dedicated worker`);
    // React Three Fiber deliberately defers renderer disposal by 500 ms.
    // Observe eventual disposal after the child navigation/unmount, not the
    // transient interval immediately after the parent removes its iframe.
    let activeGl = null;
    const releaseDeadline = Date.now() + 10000;
    do {
      await cdp.send('HeapProfiler.collectGarbage');
      activeGl = await page.evaluate(() => window.__fDirectorGl.filter(record => {
        const context = record.ref.deref();
        // Losing a context is synchronous; its DOM event is asynchronous and
        // can be discarded when the iframe is detached. Query the actual GL
        // state as well, so a released renderer is never reported as active.
        return context && !record.lost && !context.isContextLost();
      }).length);
      if (!activeGl) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < releaseDeadline);
    assert.equal(activeGl, 0, `cycle ${cycle} releases or collects every observed WebGL context`);
    // Periodic parent UI updates replace text nodes between protocol commands.
    // Observe a fixed five post-GC samples and select one actual low-water row
    // so a transient, uncollected text node is not treated as retained. Keep
    // every raw observation and the original zero-growth threshold; resources
    // that remain strongly held are present in every observation.
    const observations = [];
    for (let observation = 0; observation < 5; observation++) {
      await cdp.send('HeapProfiler.collectGarbage');
      const counters = await cdp.send('Memory.getDOMCounters');
      const usage = await cdp.send('Runtime.getHeapUsage');
      observations.push({ ...counters, usedHeapBytes: usage.usedSize });
    }
    const dom = [...observations].sort((a, b) => a.documents - b.documents
      || a.nodes - b.nodes || a.jsEventListeners - b.jsEventListeners)[0];
    samples.push({ cycle, fromProjectId, toProjectId, closeReason: 'ordinary-close-button',
      switchTrigger: 'visible-project-list-after-close', ...dom,
      sampling: 'fixed-five-post-GC-low-water-row', observations });
  }
  assert.equal(samples.length, 20, 'all 20 close-and-switch cycles completed');
  assert.equal(await page.evaluate(() => window.__xp.store.project.id), projectA, '20 switches return to the first synthetic project');
  assert.ok(await page.evaluate(() => window.__fDirectorGl.length) >= 20, 'the observer saw actual WebGL creation in all cycles');
  t.diagnostic(`resourceSamples=${JSON.stringify(samples)}`);
  const warmup = samples.slice(0, 5), last = samples.at(-1);
  for (const counter of ['documents', 'nodes', 'jsEventListeners'])
    assert.ok(last[counter] <= Math.max(...warmup.map(sample => sample[counter])), `${counter} does not accumulate across 20 cycles: ${JSON.stringify(samples)}`);
  assertNoModelCalls(run);
});

test('hosted director vendor: pinned AGPL source, preserved font licenses and no proprietary raw Mixamo rig files', () => {
  const director = join(REPO_ROOT, 'frontend/director');
  const upstream = JSON.parse(readFileSync(join(director, 'UPSTREAM.json'), 'utf8'));
  assert.equal(upstream.commit, '4226099b42958b9d76ef390aa067d2449d3c2994');
  assert.equal(upstream.license, 'AGPL-3.0-or-later');
  assert.match(readFileSync(join(director, 'LICENSE'), 'utf8'), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.ok(existsSync(join(director, 'LICENSES/GPL-3.0-or-later.txt')));
  for (const name of ['Inter-OFL.txt', 'InstrumentSerif-OFL.txt'])
    assert.match(readFileSync(join(director, 'public/fonts', name), 'utf8'), /SIL OPEN FONT LICENSE/i);
  for (const name of ['x-bot-tpose.fbx', 'y-bot-tpose.fbx'])
    assert.equal(existsSync(join(director, 'public/models', name)), false, 'excluded upstream raw rig stays excluded');
  assert.equal(DIRECTOR_NAMESPACE, 'starlight-director');
  assert.equal(DIRECTOR_PROTOCOL_VERSION, 1);
});
