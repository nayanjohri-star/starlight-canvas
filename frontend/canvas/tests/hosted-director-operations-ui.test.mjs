// SPDX-License-Identifier: AGPL-3.0-or-later
// V03 is an executable operation comparison, not a claim of live MiniMax parity.
// Fixture import prepares synthetic actors only. Every operation under test uses
// a trusted user gesture; the scene, rig, history and disk are read independently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bootFunctional, openDirector, activeScene, projectOf, EVIDENCE, evidence } from './fixtures/director-independent-browser.mjs';
import { directorUiApi } from './fixtures/director-ui-api.mjs';
import { waitUiCondition } from './fixtures/director-ui-wait.mjs';
import { observeUiDraws, seedUiProject, selectCharacter, foldout, authored, rig, waitSameBones,
  waitUiSaved, scrubUi, noUnexpectedCalls, untilProject, record, closeDirector } from './fixtures/director-ui-steps.mjs';
import { addAsset, realPng } from './e2e-helpers.mjs';
import { DIRECTOR_NAMESPACE, DIRECTOR_PROTOCOL_VERSION } from '../src/director-protocol.js';

async function scenario(t, label, callback, { chats = 0 } = {}) {
  const run = await bootFunctional(t, { width: 1920, height: 1080, api: directorUiApi(), initScript: observeUiDraws });
  try {
    const opened = await openDirector(run.page); await seedUiProject(opened.frame);
    const result = await callback(run, opened);
    noUnexpectedCalls(run, { chats });
    const currentFrame = run.page.frames().find(frame => /\/director\/index\.html(?:\?|$)/.test(frame.url()));
    assert.ok(currentFrame, 'actual director iframe remains available after the operation');
    const currentGestures = await currentFrame.evaluate(() => window.__fDirectorUi);
    const gestures = Object.fromEntries(Object.keys(currentGestures).map(key => [key, currentGestures[key] + (run.priorGestures?.[key] || 0)]));
    assert.ok(gestures.trustedClicks > 0 && gestures.draws > 0);
    evidence(`v03-${label}-${run.identity.browser}.json`, { identity: run.identity, result, gestures, supplierPaidCalls: 0,
      comparisonScope: 'actual CozyClay user operation; live MiniMax comparison remains separate' });
  } catch (error) {
    const frame = run.page.frames().find(frame => /\/director\/index\.html(?:\?|$)/.test(frame.url()));
    const project = frame ? await projectOf(frame).catch(() => null) : null;
    const ui = frame ? await frame.evaluate(() => ({ bar: document.querySelector('#hosted-director-bar')?.textContent,
      status: window.__starlightDirector?.status(),
      encoderHold: window.__fUiEncoderHold && { entered: window.__fUiEncoderHold.entered,
        inputs: window.__fUiEncoderHold.inputs, realFlushes: window.__fUiEncoderHold.realFlushes,
        encoderStates: window.__fUiEncoderHold.encoders.map(encoder => encoder.state) },
      cameraValue: document.querySelector('[data-testid="director-camera-library"]')?.value,
      ikPositions: window.__ikControlScreenPositions?.(),
      ikWorldPositions: Object.fromEntries(['leftHand', 'rightHand', 'head'].map(id => {
        const p = window.__ikHandlePos?.(id); return [id, p && { x: p.x, y: p.y, z: p.z }];
      })),
      ikRigMatches: window.__cozyclay?.ik?.rig === window.__cozyclay?.rigA,
      cameras: Object.fromEntries(['activeCam', 'poserCam', 'editorCam', 'shotCam'].map(name => {
        const camera = window.__cozyclay?.[name]; return [name, camera && { uuid: camera.uuid,
          position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
          aspect: camera.aspect, fov: camera.fov, world: camera.matrixWorld.toArray(),
          inverse: camera.matrixWorldInverse.toArray(), projection: camera.projectionMatrix.toArray() }];
      })),
      rigEffectors: window.__cozyclay?.ikChains && Object.fromEntries([...window.__cozyclay.ikChains].map(([id, chain]) => {
        const bone = chain.bones[2], position = bone.getWorldPosition(bone.position.clone());
        const projected = position.clone().project(window.__cozyclay.activeCam);
        const box = document.querySelector('#stage canvas').getBoundingClientRect();
        return [id, { bone: bone.name, world: position.toArray(),
          pixel: { x: box.left + (projected.x + 1) / 2 * box.width, y: box.top + (1 - projected.y) / 2 * box.height } }];
      })),
      canvasBox: (() => { const box = document.querySelector('#stage canvas')?.getBoundingClientRect(); return box && { x: box.x, y: box.y, width: box.width, height: box.height }; })(),
      visibleRows: [...document.querySelectorAll('[role="treeitem"]')].map(row => ({ id: row.dataset.nodeId, selected: row.getAttribute('aria-selected'), expanded: row.getAttribute('aria-expanded') })) })).catch(() => null) : null;
    const actualRig = frame && run.poseSnapshots ? await rig(frame).catch(() => null) : null;
    evidence(`v03-${label}-${run.identity.browser}-failure.json`, { identity: run.identity, stack: error.stack,
      scene: project && activeScene(project), ui, poseSnapshots: run.poseSnapshots, actualRig,
      controlLockSnapshots: run.controlLockSnapshots, resolutionSnapshots: run.resolutionSnapshots });
    await run.page.screenshot({ path: join(EVIDENCE, `v03-${label}-${run.identity.browser}-failure.png`) }).catch(() => {}); throw error;
  } finally { await run.close(); }
}
const sceneObjects = async frame => activeScene(await projectOf(frame)).objects;
const objectRow = (frame, id) => frame.locator(`[role="treeitem"][data-node-id="object:${id}"]`);
async function objectsEqual(frame, expected) {
  await waitUiCondition(frame, async expected => {
    const project = JSON.parse(await window.__cozyclayProject.export('F synthetic independent project'));
    return JSON.stringify(project.scenes.scenes.find(row => row.id === project.scenes.activeSceneId).objects) === JSON.stringify(expected);
  }, expected, { description: 'actual object document matches the expected undo/redo state' });
}
async function undo(frame) { await frame.locator('#stage canvas').press('Control+z'); }
async function redo(frame) { await frame.locator('#stage canvas').press('Control+Shift+z'); }
async function addProp(frame, name) {
  const before = await sceneObjects(frame);
  await frame.locator('[data-node-id="props"] > .hierarchy-row').click();
  await frame.locator('.props-drop .add-object-trigger').click();
  await frame.locator('.props-drop .add-object-item').filter({ hasText: name }).click();
  await waitUiCondition(frame, async length => {
    const project = JSON.parse(await window.__cozyclayProject.export('F synthetic independent project'));
    return project.scenes.scenes.find(row => row.id === project.scenes.activeSceneId).objects.length === length + 1;
  }, before.length, { description: 'catalogue click adds one object to the real project' });
  return (await sceneObjects(frame)).find(row => !before.some(old => old.id === row.id)).id;
}
async function selectObjects(frame, ids) {
  const objects = await sceneObjects(frame);
  const reveal = async id => {
    const parent = objects.find(row => row.id === id)?.parent;
    if (parent) await reveal(parent);
    const ancestor = parent ? objectRow(frame, parent) : frame.locator('[role="treeitem"][data-node-id="props"]');
    if (await ancestor.getAttribute('aria-expanded') === 'false') await ancestor.locator('> .hierarchy-toggle').click();
  };
  for (const id of ids) await reveal(id);
  await objectRow(frame, ids[0]).locator('> .hierarchy-row').click();
  for (const id of ids.slice(1)) await objectRow(frame, id).locator('> .hierarchy-row').click({ modifiers: ['Control'] });
  assert.deepEqual(await frame.locator('[role="treeitem"][aria-selected="true"][data-node-id^="object:"]').evaluateAll(rows => rows.map(row => row.dataset.nodeId.slice(7)).sort()), [...ids].sort());
  assert.equal(await objectRow(frame, ids.at(-1)).getAttribute('data-active'), 'true');
}

test('V03/V05 actual object UI: catalogue, Ctrl multiselect, relative transform, one undo, grouping, inherited lock, hiding, duplicate/delete and refresh',
  { timeout: 240000 }, t => scenario(t, 'objects', async (run, { frame, scope }) => {
    const cube = await addProp(frame, /^立方体|Cube/), sphere = await addProp(frame, /^球体|Sphere/);
    await selectObjects(frame, [cube, sphere]);
    const before = await sceneObjects(frame);
    await frame.getByTestId('object-selection-x').fill('0.4');
    await frame.getByTestId('object-selection-rotation-y').fill('10');
    await frame.getByTestId('object-selection-scale-x').fill('1.2');
    await frame.getByTestId('object-selection-transform-apply').click();
    let transformed = await sceneObjects(frame);
    for (const id of [cube, sphere]) {
      const old = before.find(row => row.id === id), current = transformed.find(row => row.id === id);
      assert.ok(Math.abs(current.x - old.x - .4) < 1e-6);
      assert.ok(Math.abs(current.rot - old.rot - 10) < 1e-6);
      assert.ok(Math.abs(current.scaleX - old.scaleX * 1.2) < 1e-6);
    }
    await undo(frame); await objectsEqual(frame, before); await redo(frame); await objectsEqual(frame, transformed);
    await selectObjects(frame, [cube, sphere]); await frame.getByTestId('hierarchy-multiselect-group').click();
    const grouped = await sceneObjects(frame); assert.equal(grouped.find(row => row.id === cube).parent, sphere);
    assert.equal(grouped.find(row => row.id === sphere).parent, null);
    await undo(frame); await objectsEqual(frame, transformed); await redo(frame); await objectsEqual(frame, grouped);
    await selectObjects(frame, [cube, sphere]);
    await frame.getByTestId('object-selection-x').fill('0.2');
    await frame.getByTestId('object-selection-rotation-y').fill('0');
    await frame.getByTestId('object-selection-scale-x').fill('1');
    await frame.getByTestId('object-selection-transform-apply').click();
    transformed = await sceneObjects(frame);
    for (const id of [cube, sphere]) assert.ok(Math.abs(transformed.find(row => row.id === id).x - grouped.find(row => row.id === id).x - .2) < 1e-6, 'parent and selected child move exactly once');
    await undo(frame); await objectsEqual(frame, grouped); await redo(frame); await objectsEqual(frame, transformed);
    await selectObjects(frame, [sphere]); await frame.getByTestId('hierarchy-multiselect-lock').click();
    const locked = await sceneObjects(frame); assert.equal(locked.find(row => row.id === sphere).locked, true);
    await selectObjects(frame, [cube]);
    assert.equal(await objectRow(frame, cube).getAttribute('data-locked'), 'true');
    await frame.getByTestId('object-locked-notice').waitFor();
    assert.notEqual(await frame.getByTestId('object-transform-fields').getAttribute('disabled'), null);
    for (const field of await frame.getByTestId('object-transform-fields').locator('input, select, button').all()) assert.equal(await field.isDisabled(), true, 'every actual locked transform control is disabled');
    for (const action of ['lock', 'hide', 'duplicate', 'delete']) assert.equal(await frame.getByTestId(`hierarchy-multiselect-${action}`).isEnabled(), false);
    await objectRow(frame, cube).locator('> .hierarchy-row').press('Delete'); await objectsEqual(frame, locked);
    await selectObjects(frame, [sphere]); await frame.getByTestId('hierarchy-multiselect-lock').click();
    await selectObjects(frame, [cube, sphere]);
    const visible = await sceneObjects(frame); await frame.getByTestId('hierarchy-multiselect-hide').click();
    const hidden = await sceneObjects(frame); assert.ok(hidden.filter(row => [cube, sphere].includes(row.id)).every(row => row.hidden));
    await undo(frame); await objectsEqual(frame, visible);
    await selectObjects(frame, [sphere]); await frame.getByTestId('hierarchy-multiselect-duplicate').click();
    const duplicated = await sceneObjects(frame), copies = duplicated.filter(row => !visible.some(old => old.id === row.id));
    assert.equal(copies.length, 2); assert.ok(copies.some(row => copies.some(other => row.parent === other.id)), 'copied group remaps its child parent');
    await undo(frame); await objectsEqual(frame, visible); await redo(frame); await objectsEqual(frame, duplicated);
    await selectObjects(frame, copies.map(row => row.id)); await frame.getByTestId('hierarchy-multiselect-delete').click();
    await objectsEqual(frame, visible); await undo(frame); await objectsEqual(frame, duplicated);
    await redo(frame); await objectsEqual(frame, visible);
    await selectObjects(frame, [cube]); await objectRow(frame, cube).locator('> .hierarchy-row').press('F2');
    const rename = objectRow(frame, cube).locator('.hierarchy-rename-input'); await rename.fill('F 用户立方体');
    await rename.press('Control+d'); assert.equal((await sceneObjects(frame)).length, visible.length, 'text focus blocks scene duplicate shortcut');
    await rename.press('Enter'); assert.equal((await sceneObjects(frame)).find(row => row.id === cube).name, 'F 用户立方体');
    const final = await sceneObjects(frame); await waitUiSaved(run.page, frame, scope);
    run.priorGestures = await frame.evaluate(() => window.__fDirectorUi);
    await run.page.reload(); const reopened = await openDirector(run.page); await objectsEqual(reopened.frame, final);
    return { cube, sphere, checks: ['catalogue', 'Ctrl selection', 'translation/rotation/scale', 'one undo/redo', 'group parent', 'parent lock', 'hide', 'group duplicate remap', 'delete', 'text focus', 'saved refresh'] };
  }));

async function realIkDrag(run, frame) {
  const ready = await frame.waitForFunction(() => {
    const positions = window.__ikControlScreenPositions?.(), canvas = document.querySelector('#stage canvas'), box = canvas?.getBoundingClientRect();
    return positions && box && ['leftHand', 'rightHand'].some(id => {
      const p = positions[id]; return p?.exposed && p.x > box.left + 12 && p.x < box.right - 12 && p.y > box.top + 12 && p.y < box.bottom - 12 && document.elementFromPoint(p.x, p.y) === canvas;
    });
  }); await ready.dispose();
  const projected = await frame.evaluate(() => {
    const positions = window.__ikControlScreenPositions(), canvas = document.querySelector('#stage canvas'), box = canvas.getBoundingClientRect();
    return { positions, id: ['leftHand', 'rightHand'].find(id => {
      const p = positions[id]; return p?.exposed && p.x > box.left + 12 && p.x < box.right - 12 && p.y > box.top + 12 && p.y < box.bottom - 12 && document.elementFromPoint(p.x, p.y) === canvas;
    }) };
  });
  const { positions, id } = projected, canvas = frame.locator('#stage canvas'); assert.ok(id);
  const rect = await canvas.evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  await canvas.click({ position: { x: positions[id].x - rect.x, y: positions[id].y - rect.y } });
  const focused = await frame.waitForFunction(id => window.__cozyclay.ikFocus === id && window.__ikPickScreenPositions?.().some(pick => pick.trackId === id && pick.part === 'tip'), id); await focused.dispose();
  const picks = await frame.evaluate(id => window.__ikPickScreenPositions().filter(pick => pick.trackId === id), id);
  const center = (await frame.evaluate(() => window.__ikControlScreenPositions()))[id];
  const tip = picks.find(pick => pick.part === 'tip' && pick.axis === 'x') ?? picks.find(pick => pick.part === 'tip');
  assert.ok(Number.isFinite(tip?.x));
  const box = await canvas.boundingBox(), dx = tip.x - center.x, dy = tip.y - center.y, length = Math.hypot(dx, dy) || 1;
  const start = { x: box.x + tip.x - rect.x, y: box.y + tip.y - rect.y };
  const before = await frame.evaluate(id => window.__ikHandlePos(id), id);
  await run.page.mouse.move(start.x, start.y); await run.page.mouse.down();
  await run.page.mouse.move(start.x + dx / length * 36, start.y + dy / length * 36, { steps: 12 }); await run.page.mouse.up();
  const changed = await frame.waitForFunction(({ id, before }) => {
    const after = window.__ikHandlePos(id); return Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) > .005;
  }, { id, before }); await changed.dispose();
  return { id, before, after: await frame.evaluate(id => window.__ikHandlePos(id), id) };
}
test('V03/V06 actual dual actor UI: IK hand drag/foot lock, one undo/redo, mirror, pose save/reuse, offline walk/wave, scrub/play and refreshed full motion',
  { timeout: 300000 }, t => scenario(t, 'pose-motion', async (run, { frame, scope }) => {
    const baselineB = activeScene(await projectOf(frame)).stage.characters[1];
    await frame.locator('.workflow-mode-switch').getByRole('tab', { name: '动作', exact: true }).click();
    // The real F shortcut frames the selected actor before entering the poser.
    // This is navigation, not a scene mutation or a direct camera seam write.
    await frame.locator('#stage canvas').press('f'); await frame.waitForTimeout(500);
    const ik = frame.locator('.tl-btn.ik:not(.snap):not(.contact)'); await ik.click();
    const enabled = await frame.waitForFunction(() => window.__cozyclay.ikMode); await enabled.dispose();
    const snap = frame.locator('.tl-btn.ik.snap'), initialSnap = await snap.getAttribute('aria-pressed');
    await snap.click(); assert.notEqual(await snap.getAttribute('aria-pressed'), initialSnap); await snap.click();
    const beforeDrag = await authored(frame), beforeRig = await rig(frame), drag = await realIkDrag(run, frame);
    const afterDrag = await authored(frame); assert.notDeepEqual(afterDrag, beforeDrag);
    const afterRig = await rig(frame); assert.notDeepEqual(afterRig.bones, beforeRig.bones);
    run.poseSnapshots = { before: beforeRig, after: afterRig, drag, phase: 'undo' };
    await undo(frame);
    await waitUiCondition(frame, async expected => {
      const project = JSON.parse(await window.__cozyclayProject.export('F synthetic independent project'));
      const scene = project.scenes.scenes.find(row => row.id === project.scenes.activeSceneId);
      return JSON.stringify({ scene, poses: project.poseLibrary }) === JSON.stringify(expected);
    }, beforeDrag, { description: 'IK undo restores the exact scene and pose library' }); await waitSameBones(frame, beforeRig);
    run.poseSnapshots.phase = 'redo';
    await redo(frame); await waitSameBones(frame, afterRig);
    await ik.click(); const disabled = await frame.waitForFunction(() => !window.__cozyclay.ikMode); await disabled.dispose();
    // The trusted IK pick selects the hand joint. Pose belongs to the whole
    // character, so navigate back through its actual hierarchy row first.
    await selectCharacter(frame, 'a');
    assert.equal(await frame.locator('[role="treeitem"][data-node-id="characterA"]').getAttribute('aria-selected'), 'true');
    const posePanel = await foldout(frame, /姿态|Pose/);
    await posePanel.getByTestId('character-mirror-pose').click();
    const mirrored = activeScene(await projectOf(frame)).stage.characters[0].pose;
    assert.deepEqual(activeScene(await projectOf(frame)).stage.characters[1], baselineB, 'actor A pose/IK never edits actor B');
    const beforePoses = (await projectOf(frame)).poseLibrary;
    await posePanel.locator('[data-save-current-pose]').click();
    const savedPose = (await projectOf(frame)).poseLibrary.find(row => !beforePoses.some(old => old.id === row.id)); assert.ok(savedPose);
    // A fresh project contains the default and the pose just saved. Select
    // their real IDs rather than assuming additional library presets exist.
    await posePanel.locator('.pose-tile[data-pose-id="default"]').click();
    assert.equal(activeScene(await projectOf(frame)).stage.characters[0].pose.id, 'default');
    await posePanel.locator(`[data-pose-id="${savedPose.id}"]`).click();
    assert.equal(activeScene(await projectOf(frame)).stage.characters[0].pose.id, savedPose.id);
    await frame.getByTestId('hosted-director-motion').click();
    let motion = frame.locator('section[aria-label="离线动作与兼容动画导入"]');
    await motion.getByLabel('基本动作').selectOption('walk'); await motion.getByTestId('motion-apply-preset').click();
    let loaded = await frame.waitForFunction(() => window.__cozyclay.motion?.frames === 150); await loaded.dispose();
    await motion.locator('header button').click(); await scrubUi(frame, 0); const first = await rig(frame);
    await scrubUi(frame, 35); const middle = await rig(frame); assert.notDeepEqual(middle.bones, first.bones);
    await frame.locator('.tl-btn.play').click();
    const played = await frame.waitForFunction(() => window.__cozyclay.playing && window.__cozyclay.tlFrame > 35); await played.dispose();
    await frame.locator('.tl-btn.play').click(); await scrubUi(frame, 35); await waitSameBones(frame, middle);
    const actorA = activeScene(await projectOf(frame)).stage.characters[0];
    const motionsA = (await projectOf(frame)).resources.motions.length;
    await selectCharacter(frame, 'b'); await frame.getByTestId('hosted-director-motion').click();
    motion = frame.locator('section[aria-label="离线动作与兼容动画导入"]');
    await motion.getByLabel('基本动作').selectOption('wave'); await motion.getByTestId('motion-apply-preset').click();
    await untilProject(frame, project => project.resources.motions.length > motionsA, 'B wave publishes a new full motion resource');
    loaded = await frame.waitForFunction(() => window.__cozyclay.motion?.frames === 150); await loaded.dispose();
    await motion.getByRole('status').filter({ hasText: '动作已应用' }).waitFor(); await motion.locator('header button').click();
    assert.deepEqual(activeScene(await projectOf(frame)).stage.characters[0], actorA, 'actor B action never edits A');
    const full = await projectOf(frame); assert.ok(full.resources.motions.length >= 2);
    await waitUiSaved(run.page, frame, scope); run.priorGestures = await frame.evaluate(() => window.__fDirectorUi); await run.page.reload();
    const reopened = await openDirector(run.page), restored = await projectOf(reopened.frame);
    assert.deepEqual(activeScene(restored).stage.characters, activeScene(full).stage.characters);
    assert.deepEqual(restored.poseLibrary, full.poseLibrary); assert.deepEqual(restored.resources.motions, full.resources.motions);
    return { drag, savedPose: savedPose.id, mirrored, motionResources: full.resources.motions.length, sampledFrames: [0, 35], fullMotionRefresh: true };
  }));

test('V03/V08 actual camera/time/layout UI: three camera library slots, switch/bind/copy/delete, focus, frame quantization, resizing/collapse/maximize and refresh',
  { timeout: 240000 }, t => scenario(t, 'camera-layout', async (run, { frame, scope }) => {
    const splitter = frame.locator('.hierarchy-splitter'), originalWidth = Number(await splitter.getAttribute('aria-valuenow'));
    await splitter.press('ArrowRight'); assert.ok(Number(await splitter.getAttribute('aria-valuenow')) > originalWidth);
    await frame.getByTestId('collapse-hierarchy').click(); assert.equal(await frame.getByTestId('toggle-hierarchy').getAttribute('aria-pressed'), 'false');
    await frame.getByTestId('toggle-hierarchy').click();
    await frame.getByTestId('maximize-viewport').click(); assert.equal(await frame.getByTestId('maximize-viewport').getAttribute('aria-pressed'), 'true');
    await frame.locator('#stage canvas').press('Escape'); assert.equal(await frame.getByTestId('maximize-viewport').getAttribute('aria-pressed'), 'false');
    await frame.getByTestId('hosted-director-camera-controls').click();
    const panel = frame.locator('section[aria-label="机位与时间"]');
    const initial = activeScene(await projectOf(frame)).shotDocument.cameraLibrary.cameras;
    const added = [];
    for (const name of ['F 中文侧面机位', 'F 中文近景机位']) {
      await panel.getByLabel('机位名称', { exact: true }).fill(name);
      await panel.getByRole('button', { name: '保存当前取景为新机位', exact: true }).click();
      const project = await untilProject(frame, project => activeScene(project).shotDocument.cameraLibrary.cameras.some(row => row.name === name), 'named camera saved');
      const camera = activeScene(project).shotDocument.cameraLibrary.cameras.find(row => row.name === name);
      assert.ok(camera); added.push(camera.id);
    }
    const ids = [initial[0].id, ...added]; assert.equal(ids.length, 3);
    for (const id of ids) {
      await panel.getByTestId('director-camera-library').selectOption(id);
      await untilProject(frame, project => activeScene(project).shotDocument.cameraLibrary.activeCameraId === id, 'camera library selection');
      const selected = activeScene(await projectOf(frame)).shotDocument.cameraLibrary.activeCameraId; assert.equal(selected, id);
      await panel.getByRole('button', { name: '绑定当前镜头', exact: true }).click();
      await untilProject(frame, project => activeScene(project).shotDocument.shots[0].cameraId === id, 'shot camera binding');
      assert.equal(activeScene(await projectOf(frame)).shotDocument.shots[0].cameraId, id);
    }
    await panel.getByLabel('焦平面距离（米）').fill('4.2'); await panel.getByLabel('焦平面距离（米）').blur();
    await panel.getByLabel('光圈 f 值').fill('2.8'); await panel.getByLabel('光圈 f 值').blur();
    await panel.getByLabel('在成片视角和导出中启用景深').check();
    await untilProject(frame, project => {
      const focus = activeScene(project).shotDocument.shots[0].camera;
      return focus.focusDistance === 4.2 && focus.fStop === 2.8 && focus.depthOfField === true;
    }, 'focus and depth of field committed');
    const focused = activeScene(await projectOf(frame)).shotDocument.shots[0].camera;
    assert.equal(focused.focusDistance, 4.2); assert.equal(focused.fStop, 2.8); assert.equal(focused.depthOfField, true);
    const beforeCopy = activeScene(await projectOf(frame)).shotDocument.cameraLibrary.cameras;
    await panel.getByRole('button', { name: '复制机位', exact: true }).click();
    await untilProject(frame, project => activeScene(project).shotDocument.cameraLibrary.cameras.length === beforeCopy.length + 1, 'copy camera');
    const copied = activeScene(await projectOf(frame)).shotDocument.cameraLibrary.cameras.find(row => !beforeCopy.some(old => old.id === row.id)); assert.ok(copied);
    await panel.getByTestId('director-camera-library').selectOption(copied.id);
    await panel.getByRole('button', { name: '删除机位', exact: true }).click();
    await untilProject(frame, project => activeScene(project).shotDocument.cameraLibrary.cameras.length === beforeCopy.length, 'delete copied camera');
    assert.equal(activeScene(await projectOf(frame)).shotDocument.cameraLibrary.cameras.length, beforeCopy.length);
    await panel.getByTestId('director-fps').selectOption('30'); await panel.getByTestId('director-seconds').fill('6.25');
    await panel.getByTestId('director-apply-duration').click();
    await untilProject(frame, project => activeScene(project).shotDocument.frameCount === 188 && activeScene(project).shotDocument.fps === 30, '30 fps integer duration');
    assert.equal(activeScene(await projectOf(frame)).shotDocument.frameCount, 188);
    // Autosave legitimately replaces the global status announcement. Check
    // the persistent user-visible production clock as well as the document.
    const roundedClock = panel.locator('p').filter({ hasText: /^当前 188 帧 · 6\.266667 秒。/ });
    await roundedClock.waitFor({ state: 'visible' });
    assert.match(await roundedClock.innerText(), /^当前 188 帧 · 6\.266667 秒。/);
    await panel.getByTestId('director-fps').selectOption('24'); await panel.getByTestId('director-seconds').fill('6.25');
    await panel.getByTestId('director-apply-duration').click();
    // v4 serializes 30 fps explicitly and omits the default 24 fps. Only an
    // absent field denotes 24; null and unknown explicit rates must fail.
    await untilProject(frame, project => {
      const clock = activeScene(project).shotDocument;
      return clock.frameCount === 150 && (clock.fps === undefined ? 24 : clock.fps) === 24;
    }, '24 fps exact duration');
    const exactDocument = activeScene(await projectOf(frame)).shotDocument;
    assert.equal(exactDocument.frameCount, 150);
    assert.equal(exactDocument.fps === undefined ? 24 : exactDocument.fps, 24);
    assert.equal(await panel.getByTestId('director-fps').inputValue(), '24');
    const exactClock = panel.locator('p').filter({ hasText: /^当前 150 帧 · 6\.250000 秒。/ });
    await exactClock.waitFor({ state: 'visible' });
    assert.match(await exactClock.innerText(), /^当前 150 帧 · 6\.250000 秒。/);
    await panel.locator('header button').click(); await scrubUi(frame, 149);
    const final = activeScene(await projectOf(frame)).shotDocument; await waitUiSaved(run.page, frame, scope);
    run.priorGestures = await frame.evaluate(() => window.__fDirectorUi);
    await run.page.reload(); const reopened = await openDirector(run.page);
    assert.deepEqual(activeScene(await projectOf(reopened.frame)).shotDocument, final);
    return { cameraIds: ids, focus: focused, quantization: { requestedSeconds: 6.25, fps30Frames: 188, fps24Frames: 150 }, layout: ['resize', 'collapse/restore', 'maximize/Escape'] };
  }));

async function installRealFlushHold(frame) {
  await frame.evaluate(() => {
    if (typeof VideoEncoder !== 'function') throw Error('Actual VideoEncoder is required for busy UI acceptance');
    if (window.__fUiEncoderHold) throw Error('A previous encoder observer was not retired');
    const NativeEncoder = window.VideoEncoder;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const stats = window.__fUiEncoderHold = { inputs: 0, realFlushes: 0, entered: false,
      released: false, encoders: [], release: () => { stats.released = true; release(); } };
    class ObservedEncoder extends NativeEncoder {
      constructor(...args) { super(...args); stats.encoders.push(this); }
      encode(...args) { const result = super.encode(...args); stats.inputs++; return result; }
      async flush() {
        const result = await super.flush();
        stats.realFlushes++; stats.entered = true;
        await gate;
        return result;
      }
    }
    window.VideoEncoder = ObservedEncoder;
    stats.restore = () => {
      if (window.VideoEncoder !== ObservedEncoder) throw Error('The real encoder observer lost ownership');
      window.VideoEncoder = NativeEncoder;
      delete window.__fUiEncoderHold;
    };
  });
}

const completedOutputIds = page => page.evaluate(() => Object.values(window.__xp.store.project.assets)
  .filter(asset => asset.directorOutput).map(asset => asset.id).sort());

async function inspectHeldEncoder(frame) {
  return frame.evaluate(() => {
    const state = window.__fUiEncoderHold;
    if (!state) throw Error('The real encoder observer is missing');
    return { inputs: state.inputs, realFlushes: state.realFlushes, entered: state.entered,
      released: state.released, encoderStates: state.encoders.map(encoder => encoder.state),
      status: window.__starlightDirector.status(), inert: document.querySelector('.app').inert };
  });
}

async function lockedPanelExport(run, frame, scope, panel, label, minimumControls) {
  const progress = { label };
  run.controlLockSnapshots.push(progress);
  const before = await authored(frame), saved = await record(run.page, scope), outputs = await completedOutputIds(run.page);
  await installRealFlushHold(frame);
  try {
    await frame.getByTestId('hosted-director-export-video').click();
    await waitUiCondition(frame, () => window.__fUiEncoderHold?.entered === true && window.__starlightDirector.status().busy,
      null, { description: 'a real native flush completed and the actual export remains held' });
    progress.held = await inspectHeldEncoder(frame);
    assert.ok(progress.held.inputs > 0 && progress.held.realFlushes > 0);
    assert.equal(progress.held.inert, true);
    const controls = progress.controls = await panel.evaluate(section => [...section.querySelectorAll('input,select,textarea,button')]
      .filter(node => !node.closest('header') && node.getClientRects().length > 0)
      .map(node => ({ tag: node.tagName, testId: node.dataset.testid ?? null,
        label: node.labels?.[0]?.textContent.trim() ?? node.textContent.trim(), disabled: node.matches(':disabled') })));
    assert.ok(controls.length >= minimumControls, 'the already-open panel retains its complete author controls');
    for (const control of controls) assert.equal(control.disabled, true, label + ': native author control remains enabled: ' + JSON.stringify(control));
    assert.equal(await panel.locator('header button').isEnabled(), true, label + ': close remains usable during an external export');
    await panel.locator('header button').click();
    await panel.waitFor({ state: 'hidden' });
    progress.afterClose = await inspectHeldEncoder(frame);
    assert.equal(progress.afterClose.status.busy, true, 'closing a panel cannot release the other export');
    assert.equal(progress.afterClose.inert, true);
    assert.deepEqual(await authored(frame), before, 'locked controls and closing never alter authoring');
    assert.equal((await record(run.page, scope)).rev, saved.rev);
    assert.deepEqual(await completedOutputIds(run.page), outputs, 'no output is published while a real encoder is held');
    await frame.getByTestId('hosted-director-cancel').click();
    await frame.evaluate(() => window.__fUiEncoderHold.release());
    await waitUiCondition(frame, () => !window.__starlightDirector.status().busy
      && window.__fUiEncoderHold.encoders.every(encoder => encoder.state === 'closed'),
    null, { description: 'ordinary cancel completes and closes every real encoder' });
    progress.cancelled = await inspectHeldEncoder(frame);
    assert.ok(progress.cancelled.encoderStates.length > 0);
    assert.equal(progress.cancelled.inert, false);
    assert.deepEqual(await completedOutputIds(run.page), outputs, 'cancelled output cannot create a success asset');
    assert.deepEqual(await authored(frame), before);
    assert.equal((await record(run.page, scope)).rev, saved.rev);
  } finally {
    try {
      await frame.evaluate(() => { window.__starlightDirector.cancel(); window.__fUiEncoderHold.release(); });
      await waitUiCondition(frame, () => !window.__starlightDirector.status().busy, null,
        { description: 'the owned encoder observation always retires its export' });
    } finally { await frame.evaluate(() => window.__fUiEncoderHold.restore()); }
  }
  return progress;
}

test('V12/V16 actual UI: already-open Camera, Motion, Generation and Proposal author controls lock during a real held export and close cannot release it',
  { timeout: 300000 }, t => scenario(t, 'busy-panels', async (run, { frame, scope }) => {
    run.controlLockSnapshots = [];
    await frame.getByTestId('hosted-director-camera-controls').click();
    let panel = frame.locator('section[aria-label="机位与时间"]');
    await panel.getByTestId('director-resolution').selectOption('720');
    await panel.getByTestId('director-seconds').fill('1'); await panel.getByTestId('director-apply-duration').click();
    await untilProject(frame, project => activeScene(project).shotDocument.frameCount === 24, 'one second of real frames for the busy-control check');
    await panel.locator('header button').click(); await waitUiSaved(run.page, frame, scope);
    await addAsset(run.page, await realPng(run.page, 135), 'F合成忙碌锁参考图.png', 'image', 40, 120);
    for (const entry of [
      { id: 'hosted-director-camera-controls', name: '机位与时间', label: 'camera', count: 13 },
      { id: 'hosted-director-motion', name: '离线动作与兼容动画导入', label: 'motion', count: 5 },
      { id: 'hosted-director-generation', name: '模型生成草稿', label: 'generation', count: 7 },
      { id: 'hosted-director-proposals', name: 'AI 运镜与动作提案', label: 'proposal-quote', count: 6 },
    ]) {
      await frame.getByTestId(entry.id).click();
      panel = frame.locator('section[aria-label="' + entry.name + '"]'); await panel.waitFor();
      if (entry.label === 'generation') {
        assert.ok(await panel.getByRole('button', { name: '绑定所选人物', exact: true }).count() > 0, 'the reference binding action is included in the real lock check');
      }
      if (entry.label === 'proposal-quote') {
        await panel.getByLabel('你的要求').fill('保留两个合成角色，为当前镜头提出用户主动要求的取景。');
        await panel.getByTestId('proposal-quote').click();
        await waitUiCondition(frame, () => document.querySelector('[data-testid="proposal-request"]') !== null
          && !document.querySelector('[data-testid="proposal-quote"]').disabled, null, { description: 'the actual free quote is settled' });
        await panel.getByRole('checkbox').check();
        assert.equal(await panel.getByTestId('proposal-request').isEnabled(), true);
      }
      await lockedPanelExport(run, frame, scope, panel, entry.label, entry.count);
    }
    // A returned proposal has additional preview/discard actions. Its one
    // explicitly confirmed supplier response is synthetic; no real API is used.
    await frame.getByTestId('hosted-director-proposals').click();
    panel = frame.locator('section[aria-label="AI 运镜与动作提案"]'); await panel.waitFor();
    await waitUiCondition(frame, () => !document.querySelector('[data-testid="proposal-quote"]').disabled,
      null, { description: 'the reopened proposal panel finishes its real status/save request' });
    await panel.getByTestId('proposal-request').click();
    await panel.getByTestId('proposal-preview').waitFor();
    assert.equal(run.api.state.chats.length, 1);
    await lockedPanelExport(run, frame, scope, panel, 'proposal-returned', 6);
    assert.deepEqual(run.controlLockSnapshots.map(row => row.label),
      ['camera', 'motion', 'generation', 'proposal-quote', 'proposal-returned']);
    return { panels: run.controlLockSnapshots, realCodec: true, fakeCodec: false, mockChatCalls: 1 };
  }, { chats: 1 }));

async function outputPngFromUi(page, frame, scope) {
  const before = await completedOutputIds(page);
  // Observe real postMessage events without replacing either transport or
  // producing output. Completion belongs to the publish request; the durable
  // asset stores revision/frame metadata and the real host reply binds its ID.
  await page.evaluate(({ scope, namespace, version }) => {
    const editor = document.querySelector('iframe.director-frame').contentWindow;
    const state = { requests: [], replies: [] };
    const matches = (event, source, kind) => event.source === source && event.origin === location.origin
      && event.data?.namespace === namespace && event.data.version === version && event.data.kind === kind
      && event.data.method === 'output.publishBatch'
      && ['sessionId', 'projectId', 'nodeId'].every(key => event.data[key] === scope[key]);
    const identity = event => ({ namespace: event.data.namespace, version: event.data.version,
      sessionId: event.data.sessionId, projectId: event.data.projectId, nodeId: event.data.nodeId,
      requestId: event.data.requestId, method: event.data.method, kind: event.data.kind,
      trusted: event.isTrusted, origin: event.origin });
    const request = event => {
      if (!matches(event, editor, 'request')) return;
      state.requests.push({ ...identity(event), entries: event.data.payload.entries.map(entry => {
        const { bytes, ...metadata } = entry;
        return { ...metadata, bytes: new Uint8Array(bytes).slice().buffer };
      }) });
    };
    const response = event => {
      if (matches(event, window, 'response'))
        state.replies.push({ ...identity(event), payload: structuredClone(event.data.payload) });
    };
    window.addEventListener('message', request); editor.addEventListener('message', response);
    state.dispose = () => { window.removeEventListener('message', request); editor.removeEventListener('message', response); };
    window.__fUiPngPublish = state;
  }, { scope, namespace: DIRECTOR_NAMESPACE, version: DIRECTOR_PROTOCOL_VERSION });
  try {
    await frame.getByTestId('hosted-director-export-png').click();
    await waitUiCondition(page, ({ before, nodeId }) => Object.values(window.__xp.store.project.assets)
      .some(asset => asset.fromDirector === nodeId && asset.kind === 'image' && !before.includes(asset.id)),
    { before, nodeId: scope.nodeId }, { description: 'actual PNG bytes and the canvas asset are committed' });
    await waitUiCondition(frame, () => !window.__starlightDirector.status().busy, null,
      { description: 'the real PNG output finishes its host transaction' });
    return await page.evaluate(async ({ before, nodeId }) => {
      const asset = Object.values(window.__xp.store.project.assets).find(row => row.fromDirector === nodeId
        && row.kind === 'image' && !before.includes(row.id));
      const blob = await window.__xp.assets.blobOf(asset.id), bytes = await blob.arrayBuffer();
      const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(n => n.toString(16).padStart(2, '0')).join('');
      const state = window.__fUiPngPublish;
      const requests = await Promise.all(state.requests.map(async request => ({ ...request,
        entries: await Promise.all(request.entries.map(async ({ bytes, ...entry }) =>
          ({ ...entry, byteLength: bytes.byteLength, sha256: await sha256(bytes) }))) })));
      const replies = state.replies;
      const nodeIds = replies.flatMap(reply => reply.payload.result ?? []).map(result => result.assetNodeId);
      const nodes = window.__xp.store.project.nodes.filter(node => nodeIds.includes(node.id));
      const bitmap = await createImageBitmap(blob);
      try {
        return { asset, byteLength: bytes.byteLength, width: bitmap.width, height: bitmap.height,
          sha256: await sha256(bytes), publish: { requests, replies, nodes } };
      } finally { bitmap.close(); }
    }, { before, nodeId: scope.nodeId });
  } finally {
    await page.evaluate(() => { window.__fUiPngPublish.dispose(); delete window.__fUiPngPublish; });
  }
}

async function savedProjectFile(page, saved) {
  const result = await page.evaluate(async ref => {
    const blob = await window.__xp.assets.blobOf(ref.slice(11));
    const bytes = await blob.arrayBuffer();
    return { project: JSON.parse(new TextDecoder().decode(bytes)), byteLength: bytes.byteLength,
      sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('') };
  }, saved.scene.projectRef);
  assert.equal(result.sha256, saved.scene.projectSha256, 'the actual saved complete-project bytes match the acknowledged hash');
  return result;
}

function assertSameProjectAuthoring(actual, expected, message) {
  // collectProjectSerialized timestamps each fresh export at Date.now(). The
  // actual persisted file (including savedAt) is compared byte-for-byte below;
  // only this new export's time is outside the authoring-state comparison.
  for (const project of [actual, expected]) assert.ok(Number.isFinite(project.savedAt) && project.savedAt > 0);
  const { savedAt: actualExportTime, ...actualAuthoring } = actual;
  const { savedAt: expectedExportTime, ...expectedAuthoring } = expected;
  assert.deepEqual(actualAuthoring, expectedAuthoring, message);
  return { actualExportTime, expectedExportTime };
}

test('V13 actual UI: numeric 720/1080 survives save ACK, ordinary close/reopen and refresh with exact full-project authoring, unchanged saved bytes and PNG dimensions',
  { timeout: 240000 }, t => scenario(t, 'resolution-restore', async (run, opened) => {
    let { frame, scope } = opened;
    assert.equal(activeScene(await projectOf(frame)).stage.shotAspect, '16:9', 'the resolution fixture has an explicit landscape composition');
    const rows = [], snapshots = run.resolutionSnapshots = [];
    for (const [resolution, width, height] of [[720, 1280, 720], [1080, 1920, 1080]]) {
      const progress = { resolution }; snapshots.push(progress);
      await frame.getByTestId('hosted-director-camera-controls').click();
      let panel = frame.locator('section[aria-label="机位与时间"]');
      await panel.getByTestId('director-resolution').selectOption(String(resolution));
      await panel.locator('header button').click();
      const saved = await waitUiSaved(run.page, frame, scope), project = await projectOf(frame);
      const savedFile = await savedProjectFile(run.page, saved);
      progress.saved = { record: saved, savedFile, status: await frame.evaluate(() => window.__starlightDirector.status()) };
      assertSameProjectAuthoring(savedFile.project, project, 'the acknowledged saved file contains every current authoring field');
      assert.equal(saved.scene.exportResolution, resolution);
      assert.equal(typeof saved.scene.exportResolution, 'number');
      progress.beforeClose = { record: await record(run.page, scope), status: await frame.evaluate(() => window.__starlightDirector.status()) };
      await closeDirector(run.page);
      progress.closedRecord = await record(run.page, scope);
      assert.deepEqual(progress.closedRecord, saved, 'ordinary close retains the complete acknowledged saved record');
      ({ frame, scope } = await openDirector(run.page));
      progress.reopened = { record: await record(run.page, scope), status: await frame.evaluate(() => window.__starlightDirector.status()) };
      await frame.getByTestId('hosted-director-camera-controls').click();
      panel = frame.locator('section[aria-label="机位与时间"]');
      assert.equal(await panel.getByTestId('director-resolution').inputValue(), String(resolution));
      const reopenedExportTimes = assertSameProjectAuthoring(await projectOf(frame), project, 'ordinary reopen restores every serialized authoring field');
      const reopenedRecord = await record(run.page, scope);
      progress.afterReopenedInspection = { record: reopenedRecord, savedFile: await savedProjectFile(run.page, reopenedRecord),
        status: await frame.evaluate(() => window.__starlightDirector.status()) };
      assert.deepEqual(reopenedRecord, saved, 'ordinary reopen retains the complete acknowledged saved record');
      assert.deepEqual(await savedProjectFile(run.page, reopenedRecord), savedFile, 'ordinary reopen retains the exact saved file, including its original timestamp');
      await panel.locator('header button').click();
      run.priorGestures = await frame.evaluate(() => window.__fDirectorUi);
      await run.page.reload();
      ({ frame, scope } = await openDirector(run.page));
      await frame.getByTestId('hosted-director-camera-controls').click();
      panel = frame.locator('section[aria-label="机位与时间"]');
      assert.equal(await panel.getByTestId('director-resolution').inputValue(), String(resolution));
      const refreshedExportTimes = assertSameProjectAuthoring(await projectOf(frame), project, 'physical refresh restores the same complete authoring project');
      const restored = await record(run.page, scope);
      progress.refreshed = { record: restored, savedFile: await savedProjectFile(run.page, restored),
        status: await frame.evaluate(() => window.__starlightDirector.status()) };
      assert.deepEqual(restored, saved, 'physical refresh retains the complete acknowledged saved record');
      assert.deepEqual(await savedProjectFile(run.page, restored), savedFile, 'physical refresh retains the exact saved file, including its original timestamp');
      assert.equal(restored.scene.exportResolution, resolution); assert.equal(restored.rev, saved.rev);
      assert.equal(restored.scene.projectSha256, saved.scene.projectSha256);
      assert.equal(await frame.evaluate(() => window.__starlightDirector.status().saveState), 'saved');
      await panel.locator('header button').click();
      const png = await outputPngFromUi(run.page, frame, scope);
      assert.equal(png.width, width); assert.equal(png.height, height);
      assert.equal(png.publish.requests.length, 1, 'one real child-to-host PNG publish request is observed');
      assert.equal(png.publish.replies.length, 1, 'one real host-to-child publish response is observed');
      const request = png.publish.requests[0], reply = png.publish.replies[0];
      assert.equal(request.trusted, true); assert.equal(reply.trusted, true);
      assert.equal(request.namespace, DIRECTOR_NAMESPACE); assert.equal(request.version, DIRECTOR_PROTOCOL_VERSION);
      assert.equal(request.kind, 'request'); assert.equal(reply.kind, 'response');
      for (const key of ['namespace', 'version', 'sessionId', 'projectId', 'nodeId', 'requestId', 'method', 'origin'])
        assert.equal(reply[key], request[key], 'the real response belongs to the observed publish request: ' + key);
      for (const key of ['sessionId', 'projectId', 'nodeId']) assert.equal(request[key], scope[key]);
      assert.equal(request.method, 'output.publishBatch'); assert.ok(request.requestId);
      assert.equal(request.entries.length, 1);
      const entry = request.entries[0];
      assert.equal(entry.completed, true, 'the actual publish request declares successful completion');
      assert.equal(entry.sceneRevision, saved.rev, 'the actual completed bytes are published for the acknowledged current revision');
      assert.equal(entry.kind, 'image'); assert.equal(entry.mime, 'image/png');
      assert.equal(entry.byteLength, png.byteLength); assert.equal(entry.sha256, png.sha256);
      assert.equal(reply.payload.ok, true); assert.equal(reply.payload.result.length, 1);
      const published = reply.payload.result[0];
      assert.equal(published.assetId, png.asset.id); assert.equal(published.ref, 'xp-asset://' + png.asset.id);
      assert.equal(published.sceneRevision, saved.rev);
      assert.equal(published.sha256, png.sha256); assert.equal(published.size, png.byteLength);
      assert.equal(published.kind, 'image'); assert.equal(published.mime, 'image/png');
      assert.equal(png.publish.nodes.length, 1); assert.equal(png.publish.nodes[0].id, published.assetNodeId);
      assert.equal(png.publish.nodes[0].data.assetId, png.asset.id);
      assert.equal(png.asset.directorOutput.sceneRevision, saved.rev);
      assert.equal((await record(run.page, scope)).rev, saved.rev);
      rows.push({ resolution, revision: saved.rev, projectSha256: saved.scene.projectSha256,
        png, savedFile, reopenedExportTimes, refreshedExportTimes, ordinaryReopen: true, physicalRefresh: true });
    }
    return { resolutions: rows };
  }));
