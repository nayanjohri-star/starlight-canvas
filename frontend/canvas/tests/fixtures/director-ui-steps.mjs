// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { directorDocumentKey } from '../../src/director-protocol.js';
import { activeScene, projectOf } from './director-independent-browser.mjs';
import { waitUiCondition } from './director-ui-wait.mjs';

export function observeUiDraws() {
  if (parent === window || !/\/director\/index\.html$/.test(location.pathname)) return;
  const state = window.__fDirectorUi = { draws: 0, trustedClicks: 0, trustedKeys: 0 };
  document.addEventListener('click', event => { if (event.isTrusted) state.trustedClicks++; }, true);
  document.addEventListener('keydown', event => { if (event.isTrusted) state.trustedKeys++; }, true);
  for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const native = prototype[method]; if (!native) continue;
      prototype[method] = function (...args) { const result = native.apply(this, args);
        if (this.canvas.closest('#stage')) state.draws++; return result; };
    }
  }
}
// Synthetic preparation only. All tested edits below use actual UI controls.
export async function seedUiProject(frame) {
  // Import once, with new actor identities. Waiting for old same-ID rigs after
  // a second import could observe the previous renderer rather than this scene.
  const project = await projectOf(frame), scene = activeScene(project), firstActor = scene.stage.characters[0];
  scene.stage.characters = [{ ...firstActor, id: 'f-independent-a', subject: '合成角色甲', x: -1.2, y: 0, z: 0, hidden: false },
    { ...structuredClone(firstActor), id: 'f-independent-b', subject: '合成角色乙', x: 1.2, y: 0, z: 0, hidden: false }];
  const cameras = scene.shotDocument.cameraLibrary.cameras;
  scene.shotDocument.fps = 24; scene.shotDocument.frameCount = 150;
  const first = scene.shotDocument.shots[0] ?? {};
  scene.shotDocument.shots = [{ ...first, id: 'f-ui-shot', name: 'F合成验收镜头', startFrame: 0, endFrame: 149,
    cameraId: cameras[0].id, camera: { ...structuredClone(cameras[0].framing), mode: 'keys' }, cameraKeys: [] }];
  const result = await frame.evaluate(text => window.__cozyclayProject.open(text), JSON.stringify(project));
  assert.equal(result.ok, true, JSON.stringify(result));
  const ready = await frame.waitForFunction(() => ['f-independent-a', 'f-independent-b'].every(id => window.__cozyclayMcpRigReady?.includes(id))); await ready.dispose();
  await selectCharacter(frame, 'a');
  return projectOf(frame);
}
export async function selectCharacter(frame, which) {
  await frame.locator(`[data-node-id="character${which === 'a' ? 'A' : 'B'}"] > .hierarchy-row`).click();
}
export async function foldout(frame, name) {
  const head = frame.locator('.foldout-head:visible').filter({ hasText: name }).first();
  await head.waitFor(); if (await head.getAttribute('aria-expanded') === 'false') await head.click();
  return head.locator('xpath=ancestor::section[1]');
}
export async function authored(frame) {
  const project = await projectOf(frame), scene = activeScene(project);
  return { scene, poses: project.poseLibrary };
}
export async function untilProject(frame, predicate, description, timeout = 30000) {
  const until = Date.now() + timeout; let value;
  do {
    value = await projectOf(frame);
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < until);
  assert.fail(`actual committed project did not satisfy: ${description}`);
}
export const rig = frame => frame.evaluate(() => {
  const bones = []; window.__cozyclay.rigA.traverse(node => { if (node.isBone) bones.push({ name: node.name, quaternion: node.quaternion.toArray(), position: node.position.toArray() }); });
  return { bones, x: window.__cozyclay.rigA.matrixWorld.elements[12], frame: window.__cozyclay.tlFrame,
    draws: window.__fDirectorUi.draws, clicks: window.__fDirectorUi.trustedClicks };
});
export function sameBones(actual, expected) {
  assert.equal(actual.bones.length, expected.bones.length);
  for (let i = 0; i < actual.bones.length; i++) {
    assert.equal(actual.bones[i].name, expected.bones[i].name);
    for (const key of ['quaternion', 'position']) actual.bones[i][key].forEach((n, axis) =>
      assert.ok(Math.abs(n - expected.bones[i][key][axis]) < 1e-5, `${actual.bones[i].name} ${key}[${axis}]`));
  }
}
export async function waitSameBones(frame, expected) {
  const ready = await frame.waitForFunction(expected => {
    const actual = []; window.__cozyclay.rigA.traverse(node => { if (node.isBone) actual.push({ name: node.name, quaternion: node.quaternion.toArray(), position: node.position.toArray() }); });
    return actual.length === expected.bones.length && actual.every((bone, i) => bone.name === expected.bones[i].name &&
      ['quaternion', 'position'].every(key => bone[key].every((value, axis) => Math.abs(value - expected.bones[i][key][axis]) < 1e-5)));
  }, expected); await ready.dispose(); sameBones(await rig(frame), expected);
}
export async function record(page, scope) {
  return page.evaluate(async ({ scope, key }) => (await window.__xp.store.directorKV(scope.nodeId))[key],
    { scope, key: directorDocumentKey(scope.projectId, scope.nodeId) });
}
export async function waitUiSaved(page, frame, scope, expectedX = null) {
  const current = await authored(frame);
  const idle = await frame.waitForFunction(() => !window.__starlightDirector.status().busy); await idle.dispose();
  await frame.getByTestId('hosted-director-save').click();
  const ready = await frame.waitForFunction(() => window.__starlightDirector.status().saveState === 'saved'); await ready.dispose();
  await waitUiCondition(page, async ({ scope, key, current }) => {
    const record = (await window.__xp.store.directorKV(scope.nodeId))[key];
    if (!record?.scene?.projectRef) return false;
    const blob = await window.__xp.assets.blobOf(record.scene.projectRef.slice(11));
    if (!blob) return false;
    const project = JSON.parse(await blob.text());
    const scene = project.scenes.scenes.find(row => row.id === project.scenes.activeSceneId);
    return JSON.stringify({ scene, poses: project.poseLibrary }) === JSON.stringify(current);
  }, { scope, key: directorDocumentKey(scope.projectId, scope.nodeId), current },
  { description: 'saved full project matches the committed scene and pose library' });
  const value = await record(page, scope); assert.ok(value?.rev);
  if (expectedX != null) {
    const project = await page.evaluate(async ref => JSON.parse(await (await window.__xp.assets.blobOf(ref.slice(11))).text()), value.scene.projectRef);
    assert.equal(activeScene(project).stage.characters[0].x, expectedX, 'saved bytes contain the actual committed edit');
  }
  return value;
}
export async function closeDirector(page) {
  const modal = page.locator('.modal').filter({ has: page.locator('iframe.director-frame') });
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('iframe.director-frame').waitFor({ state: 'detached' });
}
export async function generationPanel(frame) {
  await frame.getByTestId('hosted-director-generation').click();
  const panel = frame.locator('section[aria-label="模型生成草稿"]'); await panel.waitFor(); return panel;
}
export async function setGeneration(panel, { model, intent, prompt, seconds = 6 }) {
  await panel.locator('label').filter({ hasText: /^模型/ }).locator('select').selectOption(model);
  await panel.locator('label').filter({ hasText: /^模式/ }).locator('select').selectOption(intent);
  await panel.getByLabel('生成秒数', { exact: true }).fill(String(seconds));
  // A controlled textarea's text content joins its wrapping label text after
  // the first edit. Preserve the native label association for later edits.
  const promptInput = panel.getByLabel(/^提示词/);
  assert.equal(await promptInput.evaluate(input => input.tagName === 'TEXTAREA'
    && [...input.labels].some(label => label.textContent.startsWith('提示词'))), true);
  await promptInput.fill(prompt);
  assert.equal(await promptInput.inputValue(), prompt);
}
export async function selectRefs(panel, names) {
  for (const checkbox of await panel.locator('.hosted-gen-asset input[type="checkbox"]').all()) await checkbox.uncheck();
  for (const name of names) await panel.locator('.hosted-gen-asset').filter({ hasText: name }).getByRole('checkbox').check();
  const numbering = await panel.locator('.hosted-gen-asset').evaluateAll(rows => rows.filter(row => row.querySelector('input').checked)
    .map(row => ({ name: row.querySelector('label').textContent.trim(), number: Number(row.querySelector('span').textContent.replace('引用 ', '')) })));
  for (const [index, name] of names.entries()) assert.equal(numbering.find(row => row.name === name)?.number, index + 1);
  return numbering;
}
export async function clickCreateDraft(page, frame) {
  const before = await page.evaluate(() => window.__xp.store.project.nodes.filter(row => row.type === 'gen').map(row => row.id));
  await frame.getByTestId('hosted-director-create-generation').click();
  const ready = await page.waitForFunction(ids => window.__xp.store.project.nodes.some(row => row.type === 'gen' && !ids.includes(row.id)), before); await ready.dispose();
  await frame.locator('section[aria-label="模型生成草稿"]').waitFor({ state: 'hidden' });
  return page.evaluate(ids => window.__xp.store.project.nodes.find(row => row.type === 'gen' && !ids.includes(row.id)).id, before);
}
export async function draftOf(page, nodeId) {
  return page.evaluate(id => {
    const store = window.__xp.store, node = store.node(id), ids = port => store.edgesInto(id, port).map(edge => store.node(edge.from.node).data.assetId);
    return { node, refs: ids('refs'), frames: ids('frames') };
  }, nodeId);
}
export async function selectGen(page, id) {
  // Drafts occupy the infinite canvas. Use its actual navigation control to
  // reveal nodes after creation, project switching or physical refresh.
  await page.locator('#btn-fit').click();
  await page.locator(`[data-node="${id}"] .node-head`).click();
  assert.deepEqual(await page.evaluate(() => window.__xp.board.selected), { type: 'node', id });
  await page.locator('#inspector.node-composer').waitFor();
}
export async function submitGen(page, id) {
  await selectGen(page, id);
  assert.match(await page.locator('#inspector .gen-cta').innerText(), /预估 ¥\d/);
  const button = page.locator('#inspector .gen-cta button.primary'); assert.equal(await button.isEnabled(), true);
  await button.click();
}
export async function exportCanvasPack(page) {
  await page.locator('#btn-timeline').click();
  await page.locator('.tl-export > button', { hasText: '导出' }).click();
  const promise = page.waitForEvent('download');
  await page.locator('.tl-menu button', { hasText: '导出项目包' }).click();
  const download = await promise; assert.equal(await download.failure(), null);
  return readFileSync(await download.path());
}
export async function importCanvasPack(page, bytes) {
  const initial = await page.evaluate(() => window.__xp.store.project.id);
  await page.locator('#btn-timeline').click();
  await page.locator('.tl-export > button', { hasText: '导出' }).click();
  const picker = page.waitForEvent('filechooser');
  await page.locator('.tl-menu button', { hasText: '导入项目包' }).click();
  await (await picker).setFiles({ name: 'F-synthetic-full-project.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  const modal = page.locator('.modal:not(.modal-wide)', { hasText: '将创建一个新项目' }); await modal.waitFor();
  await modal.getByRole('button', { name: '确认', exact: true }).click();
  const ready = await page.waitForFunction(id => window.__xp.store.project.id !== id, initial); await ready.dispose();
}
export const hashImage = bytes => createHash('sha256').update(bytes).digest('hex');
export async function scrubUi(frame, target) {
  const slider = frame.locator('.tl-ruler-lane'), box = await slider.boundingBox();
  await slider.click({ position: { x: target === 0 ? 1 : box.width - 1, y: box.height / 2 } });
  for (let i = 0; i < 500; i++) {
    const current = Number(await slider.getAttribute('aria-valuenow'));
    if (current === target) break;
    await slider.press(current > target ? 'ArrowLeft' : 'ArrowRight');
  }
  assert.equal(Number(await slider.getAttribute('aria-valuenow')), target);
  const ready = await frame.waitForFunction(target => window.__cozyclay.tlFrame === target, target); await ready.dispose();
}
export function noUnexpectedCalls(run, { chats = 0, videos = 0 } = {}) {
  assert.equal(run.api.state.chats?.length ?? 0, chats); assert.equal(run.api.state.creates.length, videos);
  assert.equal(run.api.state.images.length, 0); assert.equal(run.api.state.directVideoPosts, 0);
  assert.deepEqual(run.external, []); assert.deepEqual(run.errors, []);
}
