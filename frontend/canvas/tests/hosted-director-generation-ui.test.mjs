// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bootFunctional, openDirector, characterXInput, activeScene, projectOf, EVIDENCE, evidence } from './fixtures/director-independent-browser.mjs';
import { directorUiApi, VIDEO_MODEL, digest } from './fixtures/director-ui-api.mjs';
import { observeUiDraws, seedUiProject, selectCharacter, waitUiSaved, closeDirector, generationPanel, setGeneration,
  selectRefs, clickCreateDraft, draftOf, submitGen, selectGen, exportCanvasPack, importCanvasPack, record,
  scrubUi, noUnexpectedCalls } from './fixtures/director-ui-steps.mjs';
import { addAsset, realPng, openCanvasDock, clickCanvasAction, assertVideoDecodes } from './e2e-helpers.mjs';
import { directorDocumentKey } from '../src/director-protocol.js';
import { parseProjectPackage } from '../src/export-project.js';
import { waitUiCondition } from './fixtures/director-ui-wait.mjs';

async function actualOutput(page, frame, scope, kind) {
  const before = await page.evaluate(() => Object.keys(window.__xp.store.project.assets));
  await frame.getByTestId(`hosted-director-export-${kind}`).click();
  const ready = await page.waitForFunction(({ before, nodeId, kind }) => Object.values(window.__xp.store.project.assets)
    .some(row => !before.includes(row.id) && row.fromDirector === nodeId && row.kind === (kind === 'png' ? 'image' : 'video')),
    { before, nodeId: scope.nodeId, kind }, { timeout: 180000 }); await ready.dispose();
  return page.evaluate(async ({ before, kind, nodeId }) => {
    const asset = Object.values(window.__xp.store.project.assets).find(row => !before.includes(row.id) && row.fromDirector === nodeId && row.kind === (kind === 'png' ? 'image' : 'video'));
    const blob = await window.__xp.assets.blobOf(asset.id), bytes = await blob.arrayBuffer();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    let decoded = null;
    if (kind === 'png') { const bitmap = await createImageBitmap(blob); decoded = { width: bitmap.width, height: bitmap.height }; bitmap.close(); }
    return { asset, sha256, decoded, bytes: bytes.byteLength };
  }, { before, kind, nodeId: scope.nodeId });
}
async function waitBinding(page, scope, characterId, assetId) {
  await waitUiCondition(page, async ({ key, scope, characterId, assetId }) =>
    (await window.__xp.store.directorKV(scope.nodeId))[key]?.scene.characterBindings?.some(row => row.characterId === characterId && row.assetId === assetId),
    { key: directorDocumentKey(scope.projectId, scope.nodeId), scope, characterId, assetId },
    { description: 'saved A/B reference binding' });
}
async function bindOriginal(page, frame, scope, which, name, assetId) {
  await selectCharacter(frame, which);
  const panel = await generationPanel(frame);
  await panel.locator('.hosted-gen-asset').filter({ hasText: name }).getByRole('button', { name: '绑定所选人物', exact: true }).click();
  await waitBinding(page, scope, `f-independent-${which}`, assetId);
  await panel.locator('header button').click();
}
function bindingsRetained(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (const before of expected) {
    const after = actual.find(row => row.characterId === before.characterId);
    assert.ok(after); assert.notEqual(after.assetId, before.assetId); assert.equal(after.ref, `xp-asset://${after.assetId}`);
    assert.equal(after.sha256, before.sha256);
  }
}
async function waitTask(page, id) {
  await waitUiCondition(page, id => window.__xp.runner.localResult(id).then(result => result.ready), id,
    { timeout: 60000, description: 'task result is ready in local storage' });
}
async function cloneViaUi(page, originalId) {
  assert.equal(await page.evaluate(() => window.__xp.store.project.id), originalId);
  await clickCanvasAction(page, '#btn-hub');
  const hub = page.locator('.modal').filter({ has: page.getByRole('button', { name: '保存当前为版本', exact: true }) }); await hub.waitFor();
  await hub.locator('.task-item').filter({ hasText: '当前' }).getByRole('button', { name: '副本', exact: true }).click();
  // The actual copy action atomically stores and opens its new project. The
  // header follows that opened project; do not issue a second project switch.
  const ready = await page.waitForFunction(id => window.__xp.store.project.id !== id, originalId); await ready.dispose();
  const clonedId = await page.evaluate(() => window.__xp.store.project.id);
  const header = await page.waitForFunction(id => document.querySelector('#project-list').value === id
    && [...document.querySelector('#project-list').options].some(option => option.value === id), clonedId);
  await header.dispose();
  await hub.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await hub.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__xp.store.project.id), clonedId);
  assert.notEqual(clonedId, originalId); return clonedId;
}

test('V17/V18 actual new-director UI: A/B identity bindings and numbered refs, real first/last/video outputs, two modes, lost accepted reply, query/download recovery, clone and clean-profile package import',
  { timeout: 600000 }, async t => {
  const api = directorUiApi(); let run = await bootFunctional(t, { width: 1920, height: 1080, api, initScript: observeUiDraws });
  let scope;
  try {
    const opened = await openDirector(run.page), frame = opened.frame; scope = opened.scope;
    await seedUiProject(frame);
    await frame.getByTestId('hosted-director-camera-controls').click();
    const cameraPanel = frame.locator('section[aria-label="机位与时间"]');
    await cameraPanel.getByTestId('director-resolution').selectOption('720'); await cameraPanel.locator('header button').click();
    // Real offline action UI makes first and last outputs different. It must
    // remain free, and its full motion resource must survive the package.
    await frame.getByTestId('hosted-director-motion').click();
    const motionPanel = frame.locator('section[aria-label="离线动作与兼容动画导入"]');
    await motionPanel.getByLabel('基本动作').selectOption('walk'); await motionPanel.getByTestId('motion-apply-preset').click();
    const moved = await frame.waitForFunction(() => window.__cozyclay.motion?.frames === 150); await moved.dispose();
    await motionPanel.locator('header button').click(); await waitUiSaved(run.page, frame, scope);
    const pngA = await realPng(run.page, 25), pngB = await realPng(run.page, 205);
    const originalA = await addAsset(run.page, pngA, 'F角色甲原始参考图.png', 'image', 30, 100);
    const originalB = await addAsset(run.page, pngB, 'F角色乙原始参考图.png', 'image', 30, 300);
    await scrubUi(frame, 0); const first = await actualOutput(run.page, frame, scope, 'png');
    await scrubUi(frame, 149); const last = await actualOutput(run.page, frame, scope, 'png');
    assert.equal(first.asset.directorOutput.frameIndex, 0); assert.equal(last.asset.directorOutput.frameIndex, 149);
    assert.notEqual(first.sha256, last.sha256); assert.ok(first.decoded.width > 0 && last.decoded.height > 0);
    const video = await actualOutput(run.page, frame, scope, 'video');
    assert.equal(video.asset.directorOutput.fps, 24); assert.equal(video.asset.directorOutput.frameCount, 150);
    await bindOriginal(run.page, frame, scope, 'a', 'F角色甲原始参考图.png', originalA.assetId);
    await bindOriginal(run.page, frame, scope, 'b', 'F角色乙原始参考图.png', originalB.assetId);
    const sourceRecord = await record(run.page, scope), originalBindings = sourceRecord.scene.characterBindings;
    assert.deepEqual(originalBindings.map(row => [row.characterId, row.assetId, row.sha256]), [
      ['f-independent-a', originalA.assetId, digest(Buffer.from(pngA))], ['f-independent-b', originalB.assetId, digest(Buffer.from(pngB))],
    ]);
    const referencePrompt = '保留合成角色甲和合成角色乙的原始人物描述；第一张图片是乙，第二张图片是甲，参考视频仅提供动作与运镜。';
    let panel = await generationPanel(frame); await setGeneration(panel, { model: VIDEO_MODEL, intent: 'refs', prompt: referencePrompt });
    const numbering = await selectRefs(panel, ['F角色乙原始参考图.png', 'F角色甲原始参考图.png', video.asset.name]);
    const refsNodeId = await clickCreateDraft(run.page, frame), referenceDraft = await draftOf(run.page, refsNodeId);
    assert.deepEqual(referenceDraft.refs, [originalB.assetId, originalA.assetId, video.asset.id]); assert.deepEqual(referenceDraft.frames, []);
    assert.equal(referenceDraft.node.data.draft.prompt, referencePrompt);
    assert.deepEqual(referenceDraft.node.data.directorSource.characterBindings, originalBindings);
    panel = await generationPanel(frame); await setGeneration(panel, { model: VIDEO_MODEL, intent: 'frames', prompt: '用户首尾帧描述，保持两个原始角色。' });
    await selectRefs(panel, [video.asset.name]);
    const beforeInvalid = await run.page.evaluate(() => window.__xp.store.project.nodes.length);
    await frame.getByTestId('hosted-director-create-generation').click();
    const invalid = await frame.waitForFunction(() => document.querySelector('#hosted-director-bar [role="alert"]')?.textContent.includes('首尾帧模式只接受图片')); await invalid.dispose();
    assert.equal(await run.page.evaluate(() => window.__xp.store.project.nodes.length), beforeInvalid);
    await selectRefs(panel, [first.asset.name, last.asset.name]);
    const framesNodeId = await clickCreateDraft(run.page, frame), framesDraft = await draftOf(run.page, framesNodeId);
    assert.deepEqual(framesDraft.frames, [first.asset.id, last.asset.id]); assert.deepEqual(framesDraft.refs, []);
    noUnexpectedCalls(run);
    await closeDirector(run.page);
    const cloneId = await cloneViaUi(run.page, scope.projectId);
    const cloned = await run.page.evaluate(prompt => {
      const node = window.__xp.store.project.nodes.find(row => row.type === 'gen' && row.data.draft.prompt === prompt);
      return { bindings: node.data.directorSource.characterBindings, director: window.__xp.store.project.nodes.find(row => row.type === 'director').id };
    }, referencePrompt);
    bindingsRetained(cloned.bindings, originalBindings);
    const cloneEditor = await openDirector(run.page);
    assert.equal(cloneEditor.scope.nodeId, cloned.director);
    assert.deepEqual(activeScene(await projectOf(cloneEditor.frame)).stage.characters.map(row => row.subject), ['合成角色甲', '合成角色乙']);
    await actualOutput(run.page, cloneEditor.frame, cloneEditor.scope, 'png'); await closeDirector(run.page);
    await run.page.locator('#project-list').selectOption(scope.projectId);
    const originalOpened = await run.page.waitForFunction(id => window.__xp.store.project.id === id, scope.projectId); await originalOpened.dispose();
    assert.notEqual(cloneId, scope.projectId); noUnexpectedCalls(run);
    // The real adapter/gateway has accepted this job before its response is
    // deliberately lost. Recovery must reuse its exact key and body.
    let dropNext = true, dropped = false;
    await run.ctx.route('**/canvas-api/v1/videos', async route => {
      if (route.request().method() !== 'POST' || !dropNext) return route.continue();
      dropNext = false; const response = await route.fetch(); assert.equal(response.status(), 200);
      const accepted = await response.json(); api.failQueries(accepted.id, 2); api.failContent(accepted.id, 3);
      dropped = true; return route.abort('failed');
    });
    api.holdNext(1); await submitGen(run.page, refsNodeId);
    const retryReady = await run.page.waitForFunction(() => [...document.querySelectorAll('#inspector button')]
      .some(button => button.textContent === '再次确认结果' && !button.disabled)); await retryReady.dispose();
    assert.equal(dropped, true); assert.equal(api.state.creates.length, 1);
    const accepted = api.state.creates[0];
    const pendingKey = await run.page.evaluate(id => window.__xp.store.node(id).data.run.pendingKey, refsNodeId);
    assert.equal(pendingKey, accepted.key);
    const request = api.state.createAttempts[0].body, uploaded = url => api.state.uploadDetails.find(row => row.remoteUrl === url);
    assert.deepEqual(request.metadata.image_urls.map(url => uploaded(url)?.sha256), [digest(Buffer.from(pngB)), digest(Buffer.from(pngA))]);
    assert.deepEqual(request.metadata.video_urls.map(url => uploaded(url)?.sha256), [video.sha256]);
    assert.equal(request.prompt, referencePrompt); assert.equal(request.metadata.first_frame_url, undefined);
    await run.page.reload(); const restored = await run.page.waitForFunction(() => window.__xp?.store?.project); await restored.dispose();
    await selectGen(run.page, refsNodeId);
    const restoredRetry = await run.page.waitForFunction(() => [...document.querySelectorAll('#inspector button')]
      .some(button => button.textContent === '再次确认结果' && !button.disabled)); await restoredRetry.dispose();
    assert.equal(api.state.creates.length, 1, 'refresh cannot create a replacement task');
    await run.page.locator('#inspector').getByRole('button', { name: '再次确认结果', exact: true }).click();
    const linked = await run.page.waitForFunction(({ nodeId, taskId }) => window.__xp.store.node(nodeId).data.run.taskId === taskId,
      { nodeId: refsNodeId, taskId: accepted.jobId }); await linked.dispose();
    assert.equal(api.state.creates.length, 1); assert.equal(api.state.createAttempts.length, 2);
    assert.equal(api.state.createAttempts[1].key, accepted.key); assert.deepEqual(api.state.createAttempts[1].body, request);
    await openCanvasDock(run.page, 'task');
    const row = run.page.locator(`#task-list .task-item[data-task-id="${accepted.jobId}"]`);
    const queryError = await run.page.waitForFunction(id => window.__xp.taskPeek(id)?.queryError, accepted.jobId); await queryError.dispose();
    assert.match(await row.innerText(), /查询异常/);
    await row.getByRole('button', { name: '继续查询', exact: true }).click();
    const failedTwiceUntil = Date.now() + 10000;
    while (api.state.failures.filter(row => row.status === 503).length < 2 && Date.now() < failedTwiceUntil) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(api.state.failures.filter(row => row.status === 503).length, 2);
    api.release(accepted.jobId); await row.getByRole('button', { name: '继续查询', exact: true }).click();
    await row.getByRole('button', { name: '恢复下载', exact: true }).waitFor({ timeout: 60000 });
    assert.ok(api.state.failures.some(row => row.status === 502), 'the real adapter exposed the synthetic delivery failure');
    api.failContent(accepted.jobId, 0); await row.getByRole('button', { name: '恢复下载', exact: true }).click(); await waitTask(run.page, accepted.jobId);
    assert.equal(api.state.creates.length, 1);
    const resultBytes = await run.page.evaluate(async id => [...new Uint8Array(await (await window.__xp.runner.localResult(id)).blob.arrayBuffer())], accepted.jobId);
    assert.equal(await assertVideoDecodes(run.page, resultBytes, 'video/mp4'), true);
    await submitGen(run.page, framesNodeId);
    const frameTask = await run.page.waitForFunction(id => window.__xp.store.node(id).data.run?.taskId, framesNodeId); await frameTask.dispose();
    const frameTaskId = await run.page.evaluate(id => window.__xp.store.node(id).data.run.taskId, framesNodeId); await waitTask(run.page, frameTaskId);
    assert.equal(api.state.creates.length, 2);
    const frameRequest = api.state.createAttempts[2].body;
    assert.equal(uploaded(frameRequest.metadata.first_frame_url)?.sha256, first.sha256);
    assert.equal(uploaded(frameRequest.metadata.last_frame_url)?.sha256, last.sha256);
    assert.equal(frameRequest.metadata.image_urls, undefined); assert.equal(frameRequest.metadata.video_urls, undefined);
    const packed = await exportCanvasPack(run.page);
    assert.ok(packed.length > video.bytes); assert.equal(packed.includes(Buffer.from('sk-synth-')), false);
    const parsedPack = parseProjectPackage(new Uint8Array(packed));
    assert.equal(parsedPack.projectJson.includes('sk-synth-'), false);
    assert.ok(parsedPack.manifest.media.some(row => row.assetId === video.asset.id && row.sha256 === video.sha256));
    noUnexpectedCalls(run, { videos: 2 });
    const firstIdentity = run.identity; await run.close();
    run = await bootFunctional(t, { width: 1920, height: 1080, api, initScript: observeUiDraws });
    assert.equal(await run.page.evaluate(() => Object.keys(window.__xp.store.project.assets).length), 0, 'fresh physical profile starts without the original browser cache');
    await importCanvasPack(run.page, packed);
    const imported = await run.page.evaluate(async prompt => {
      const node = window.__xp.store.project.nodes.find(row => row.type === 'gen' && row.data.draft.prompt === prompt);
      return { id: window.__xp.store.project.id, nodeId: node.id, source: node.data.directorSource, tasks: (await window.__xp.store.tasksOfProject()).map(row => row.taskId).sort() };
    }, referencePrompt);
    assert.notEqual(imported.id, scope.projectId); assert.notEqual(imported.nodeId, refsNodeId);
    bindingsRetained(imported.source.characterBindings, originalBindings);
    assert.deepEqual(imported.tasks, [accepted.jobId, frameTaskId].sort());
    await waitTask(run.page, accepted.jobId); await waitTask(run.page, frameTaskId);
    const reopened = await openDirector(run.page), restoredProject = await projectOf(reopened.frame);
    assert.equal(reopened.scope.nodeId, imported.source.nodeId);
    assert.deepEqual(activeScene(restoredProject).stage.characters.map(row => row.subject), ['合成角色甲', '合成角色乙']);
    assert.equal(activeScene(restoredProject).shotDocument.frameCount, 150); assert.ok(restoredProject.resources.motions.length > 0);
    const input = await characterXInput(reopened.frame); await input.fill('-1.6'); await input.press('Enter'); await input.blur();
    await waitUiSaved(run.page, reopened.frame, reopened.scope, -1.6); await actualOutput(run.page, reopened.frame, reopened.scope, 'png');
    noUnexpectedCalls(run, { videos: 2 });
    const result = { identity: firstIdentity, cleanProfileIdentity: run.identity, numbering, originalBindings,
      importedBindings: imported.source.characterBindings, acceptedTasks: [accepted.jobId, frameTaskId],
      createAttempts: api.state.createAttempts.length, acceptedMockCreates: 2, supplierPaidCalls: 0, failureResponses: api.state.failures,
      outputFrames: { fps: 24, frameCount: 150, first: 0, last: 149 }, packageBytes: packed.length, cleanProfileImport: true };
    evidence(`v17-v18-${run.identity.browser}-ui.json`, result); t.diagnostic(`v17v18Result=${JSON.stringify(result)}`);
  } catch (error) {
    const frame = run.page.frames().find(frame => /\/director\/index\.html(?:\?|$)/.test(frame.url()));
    const ui = frame ? await frame.evaluate(() => ({ bar: document.querySelector('#hosted-director-bar')?.textContent,
      generationSelectors: [...document.querySelectorAll('section[aria-label="模型生成草稿"] select')].map(select => ({ value: select.value, options: [...select.options].map(option => ({ value: option.value, label: option.textContent })) })) })).catch(() => null) : null;
    evidence(`v17-v18-${run.identity.browser}-failure.json`, { identity: run.identity, scope, message: error.stack,
      acceptedMockCreates: api.state.creates.length, attempts: api.state.createAttempts, failures: api.state.failures, ui });
    await run.page.screenshot({ path: join(EVIDENCE, `v17-v18-${run.identity.browser}-failure.png`) }).catch(() => {}); throw error;
  } finally { await run.close(); }
});
