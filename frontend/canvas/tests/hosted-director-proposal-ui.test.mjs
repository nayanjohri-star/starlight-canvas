// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bootFunctional, openDirector, characterXInput, EVIDENCE, evidence } from './fixtures/director-independent-browser.mjs';
import { directorUiApi } from './fixtures/director-ui-api.mjs';
import { waitUiCondition } from './fixtures/director-ui-wait.mjs';
import { observeUiDraws, seedUiProject, selectCharacter, authored, rig, waitSameBones, record,
  waitUiSaved, closeDirector, hashImage, noUnexpectedCalls } from './fixtures/director-ui-steps.mjs';
import { clickCanvasAction } from './e2e-helpers.mjs';

async function waitMessage(frame, text) {
  const ready = await frame.waitForFunction(text => [...document.querySelectorAll('section[aria-label="AI 运镜与动作提案"] [role="status"]')]
    .some(row => row.textContent.includes(text)), text); await ready.dispose();
}
async function waitAuthored(frame, expected) {
  await waitUiCondition(frame, async expected => {
    const project = JSON.parse(await window.__cozyclayProject.export('F synthetic independent project'));
    const scene = project.scenes.scenes.find(row => row.id === project.scenes.activeSceneId);
    return JSON.stringify({ scene, poses: project.poseLibrary }) === JSON.stringify(expected);
  }, expected, { description: 'proposal discard/undo/redo restores the exact authored project' });
}
async function openProposals(frame) {
  await frame.getByTestId('hosted-director-proposals').click();
  const panel = frame.locator('section[aria-label="AI 运镜与动作提案"]'); await panel.waitFor(); return panel;
}
async function quote(panel, instruction) {
  await panel.getByLabel('提案类型').selectOption('motion');
  await panel.getByLabel('你的要求').fill(instruction);
  await panel.getByTestId('proposal-quote').click();
  await panel.getByTestId('proposal-request').waitFor();
  await waitQuoteIdle(panel);
  assert.match(await panel.innerText(), /标准保守估算 US\$/);
  assert.equal(await panel.getByTestId('proposal-request').isEnabled(), false, 'quoted price alone cannot submit');
}
async function waitQuoteIdle(panel) {
  const until = Date.now() + 30000;
  while (!await panel.getByTestId('proposal-quote').isEnabled() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await panel.getByTestId('proposal-quote').isEnabled(), true, 'the actual quotation request completed');
  assert.equal(await panel.getByRole('checkbox').isChecked(), false, 'fresh quotation resets explicit confirmation');
}

test('V19 actual UI: explicit quote/confirmation, live rig preview without saving, discard, one-step apply/undo/redo and closed-session late reply',
  { timeout: 240000 }, async t => {
  const api = directorUiApi(), run = await bootFunctional(t, { width: 1920, height: 1080, api, initScript: observeUiDraws });
  t.after(() => api.releaseChat());
  let scope;
  try {
    const opened = await openDirector(run.page), frame = opened.frame; scope = opened.scope;
    await seedUiProject(frame); await waitUiSaved(run.page, frame, scope);
    const instruction = '保留合成角色甲和角色乙的原始描述，只让角色甲抬左臂并沿用户路径走位。';
    let panel = await openProposals(frame); await quote(panel, instruction);
    assert.equal(api.state.chats.length, 0, 'opening/quoting is not a model call');
    // Edit via the real inspector after quotation. A stale quote cannot submit.
    await panel.locator('header button').click();
    const input = await characterXInput(frame); await input.fill('-1.35'); await input.press('Enter'); await input.blur();
    await waitUiSaved(run.page, frame, scope, -1.35);
    panel = await openProposals(frame);
    await panel.getByRole('checkbox').check(); await panel.getByTestId('proposal-request').click();
    await waitMessage(frame, '场景已有修改'); assert.equal(api.state.chats.length, 0);
    await panel.getByTestId('proposal-quote').click();
    await panel.getByTestId('proposal-request').waitFor();
    await waitQuoteIdle(panel);
    assert.equal(await panel.getByTestId('proposal-request').isEnabled(), false);
    await panel.getByRole('checkbox').check();
    const baseline = await authored(frame), baselineRig = await rig(frame), savedBefore = await record(run.page, scope);
    const beforeImage = await frame.locator('#stage canvas').screenshot();
    await panel.getByTestId('proposal-request').click();
    await panel.getByTestId('proposal-preview').waitFor({ timeout: 30000 });
    assert.equal(api.state.chats.length, 1); assert.deepEqual(await authored(frame), baseline, 'receiving proposal never edits the scene');
    await waitSameBones(frame, baselineRig);
    assert.match(api.state.chats[0].messages.find(row => row.role === 'user').content, /合成角色甲/);
    await panel.getByTestId('proposal-preview').click();
    await panel.getByTestId('proposal-apply').waitFor();
    const rigReady = await frame.waitForFunction(before => {
      let different = false; window.__cozyclay.rigA.traverse(node => {
        const old = before.find(row => row.name === node.name);
        if (node.isBone && old && node.quaternion.toArray().some((n, index) => Math.abs(n - old.quaternion[index]) > .001)) different = true;
      }); return different;
    }, baselineRig.bones); await rigReady.dispose();
    const preview = await authored(frame), previewRig = await rig(frame);
    assert.notDeepEqual(preview, baseline); assert.ok(previewRig.draws > baselineRig.draws, 'real WebGL stage draws the proposed pose');
    assert.notEqual(hashImage(await frame.locator('#stage canvas').screenshot()), hashImage(beforeImage), 'the actual 3D viewport changes');
    assert.equal(await frame.getByTestId('hosted-director-save').isEnabled(), false);
    await frame.waitForTimeout(1200);
    assert.equal((await record(run.page, scope)).rev, savedBefore.rev, 'autosave cannot persist an unconfirmed preview');
    await panel.getByTestId('proposal-discard-preview').click(); await waitAuthored(frame, baseline);
    await waitSameBones(frame, baselineRig); assert.equal((await record(run.page, scope)).rev, savedBefore.rev);
    await panel.getByTestId('proposal-preview').click(); await panel.getByTestId('proposal-apply').click();
    await waitMessage(frame, '修改已应用'); await panel.locator('header button').click();
    const applied = await authored(frame), appliedRig = await rig(frame);
    assert.notDeepEqual(applied, baseline); assert.ok((await record(run.page, scope)).rev > savedBefore.rev);
    await selectCharacter(frame, 'a');
    await frame.locator('[data-node-id="characterA"] > .hierarchy-row').press('Control+z');
    await waitAuthored(frame, baseline); await waitSameBones(frame, baselineRig);
    await frame.locator('[data-node-id="characterA"] > .hierarchy-row').press('Control+Shift+z');
    await waitAuthored(frame, applied); await waitSameBones(frame, appliedRig);
    assert.equal(api.state.chats.length, 1, 'preview/discard/apply/undo/redo never call the model again');
    const persisted = await waitUiSaved(run.page, frame, scope);
    panel = await openProposals(frame); await quote(panel, '新的合成延迟提案，继续保留用户角色描述。');
    api.holdNextChat(); await panel.getByRole('checkbox').check(); await panel.getByTestId('proposal-request').click();
    const until = Date.now() + 10000;
    while (api.state.chats.length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(api.state.chats.length, 2);
    await closeDirector(run.page); await clickCanvasAction(run.page, '#btn-new-project');
    const switched = await run.page.waitForFunction(id => window.__xp.store.project.id !== id, scope.projectId); await switched.dispose();
    const initialNewProject = await run.page.evaluate(() => ({ id: window.__xp.store.project.id }));
    // newProject persists once, then its normal project event schedules a
    // second save. Let that existing save finish before releasing the reply;
    // the comparison below still includes every revision and timestamp.
    await waitUiCondition(run.page, async ({ id }) => {
      const store = window.__xp.store, project = store.project;
      if (project.id !== id || project.rev < 2) return false;
      const saved = (await store.listProjects()).find(row => row.id === id);
      return saved?.rev === project.rev && saved.updatedAt === project.updatedAt;
    }, initialNewProject, { description: 'new project normal autosave is committed to disk before the held reply' });
    const switchedProject = await run.page.evaluate(() => JSON.stringify(window.__xp.store.project));
    api.releaseChat(); await run.page.waitForTimeout(500);
    assert.equal(await run.page.evaluate(() => JSON.stringify(window.__xp.store.project)), switchedProject, 'late reply cannot write into the new project');
    assert.equal(await run.page.locator('iframe.director-frame').count(), 0);
    await run.page.locator('#project-list').selectOption(scope.projectId);
    const returned = await run.page.waitForFunction(id => window.__xp.store.project.id === id, scope.projectId); await returned.dispose();
    assert.equal((await record(run.page, scope)).rev, persisted.rev, 'closed editor cannot apply or save the delayed result');
    noUnexpectedCalls(run, { chats: 2 });
    const result = { identity: run.identity, originalRevision: savedBefore.rev, appliedRevision: persisted.rev,
      actualDraws: previewRig.draws, trustedClicks: previewRig.clicks, mockChatCalls: 2, liveRigAndHistory: true, paidSupplierCalls: 0 };
    evidence(`v19-${run.identity.browser}-ui.json`, result); t.diagnostic(`v19Result=${JSON.stringify(result)}`);
  } catch (error) {
    const frame = run.page.frames().find(frame => /\/director\/index\.html(?:\?|$)/.test(frame.url()));
    const ui = frame ? await frame.evaluate(() => ({ status: window.__starlightDirector?.status(),
      bar: document.querySelector('#hosted-director-bar')?.textContent,
      messages: [...document.querySelectorAll('section[aria-label="AI 运镜与动作提案"] [role="status"]')].map(row => row.textContent) })).catch(() => null) : null;
    evidence(`v19-${run.identity.browser}-failure.json`, { identity: run.identity, scope, message: error.stack, calls: api.state.chats.length, ui,
      currentDocument: scope && await record(run.page, scope).catch(() => null), authored: frame && await authored(frame).catch(() => null) });
    await run.page.screenshot({ path: join(EVIDENCE, `v19-${run.identity.browser}-failure.png`) }).catch(() => {}); throw error;
  } finally { api.releaseChat(); await run.close(); }
});
