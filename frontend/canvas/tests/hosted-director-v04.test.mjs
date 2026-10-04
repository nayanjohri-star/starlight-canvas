// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EVIDENCE, evidence, bootIndependent, openDirector, dualCharacters, characterXInput,
  activeScene, projectOf, saveAndRead, noModelCalls } from './fixtures/director-independent-browser.mjs';
import { captureNativeViewport } from './fixtures/director-native-screenshot.mjs';

test('V04 native acceptance: physical 1366/1920 content sizes and genuine 125% browser zoom preserve Chinese input, every toolbar hit target, save and PNG',
  { timeout: 480000 }, async t => {
  const results = [];
  for (const [width, height] of [[1366, 768], [1920, 1080]]) for (const zoom of [1, 1.25]) {
    const label = `${width}x${height}-zoom${Math.round(zoom * 100)}`;
    await t.test(label, async item => {
    const run = await bootIndependent(item, { width, height, zoom, hardware: true });
    try {
      const { frame, scope } = await openDirector(run.page);
      await dualCharacters(frame);
      const gpu = await frame.evaluate(() => {
        const canvas = document.querySelector('#stage canvas'), gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const extension = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
          vendor: extension && gl.getParameter(extension.UNMASKED_VENDOR_WEBGL), version: gl.getParameter(gl.VERSION) };
      });
      assert.ok(gpu.renderer, 'the native layout flow must observe its actual GPU');
      assert.doesNotMatch(gpu.renderer, /SwiftShader|llvmpipe|software|Microsoft Basic|WARP/i, 'native layout acceptance cannot substitute software rendering');
      assert.match(gpu.renderer, /NVIDIA|GeForce/i, 'native layout acceptance uses the fixed NVIDIA reference computer');
      const toolbar = await frame.evaluate(() => [...document.querySelectorAll('#hosted-director-bar button')]
        .filter(button => button.getClientRects().length).map(button => {
          const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { text: button.textContent.trim(), testId: button.dataset.testid ?? null, disabled: button.disabled,
            x: box.x, y: box.y, width: box.width, height: box.height,
            inViewport: box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
            hit: hit === button || button.contains(hit) };
        }));
      const stage = await frame.locator('#stage').boundingBox();
      const entry = { ...run.identity, label, toolbar, stage, gpu };
      results.push(entry); evidence(`v04-${run.identity.browser}-${label}-layout.json`, entry);
      entry.layoutScreenshot = await captureNativeViewport(run.page, {
        path: join(EVIDENCE, `v04-${run.identity.browser}-${label}-layout.png`), width, height });
      evidence(`v04-${run.identity.browser}-${label}-layout.json`, entry);
      assert.ok(toolbar.length >= 9, 'the complete hosted toolbar is present');
      for (const button of toolbar) {
        assert.ok(button.inViewport && button.hit, `${label}: toolbar button is visible and directly hit-testable: ${JSON.stringify(button)}`);
        assert.ok(button.width >= 24 && button.height >= 24, 'toolbar controls retain usable target sizes');
      }
      const childWidth = await frame.evaluate(() => innerWidth);
      const parentHits = await run.page.evaluate(({ toolbar, childWidth }) => {
        const iframe = document.querySelector('iframe.director-frame'), box = iframe.getBoundingClientRect();
        const scale = iframe.clientWidth / childWidth;
        return toolbar.map(button => document.elementFromPoint(box.x + iframe.clientLeft + (button.x + button.width / 2) * scale,
          box.y + iframe.clientTop + (button.y + button.height / 2) * scale) === iframe);
      }, { toolbar, childWidth });
      assert.ok(parentHits.every(Boolean), `${label}: no parent modal element obscures toolbar targets`);
      assert.ok(stage.width >= 320 && stage.height >= 200, `${label}: core 3D editor keeps usable space: ${JSON.stringify(stage)}`);
      const input = await characterXInput(frame);
      await input.fill('-1.45'); await frame.evaluate(() => window.__cozyclay.scrub(2));
      const wait = await frame.waitForFunction(() => window.__cozyclay.tlFrame === 2); await wait.dispose();
      assert.equal(await input.inputValue(), '-1.45');
      assert.equal(await input.evaluate(node => document.activeElement === node), true);
      await input.press('Enter'); await input.blur();
      assert.equal(activeScene(await projectOf(frame)).stage.characters[0].x, -1.45);
      await frame.getByTestId('hosted-director-generation').click();
      const panel = frame.locator('section[aria-label="模型生成草稿"]'), prompt = panel.locator('textarea');
      const chinese = '保持合成角色甲和角色乙的原始描述，摄影机沿侧面缓慢推近，人物走位与镜头节奏保持一致。';
      await prompt.fill(chinese); await frame.evaluate(() => window.__cozyclay.scrub(3));
      const focusWait = await frame.waitForFunction(() => window.__cozyclay.tlFrame === 3); await focusWait.dispose();
      assert.equal(await prompt.inputValue(), chinese);
      assert.equal(await prompt.evaluate(node => document.activeElement === node), true);
      await panel.locator('header button').click();
      const saved = await saveAndRead(run.page, frame, scope);
      assert.equal(activeScene(saved.project).stage.characters[0].x, -1.45);
      const before = await run.page.evaluate(() => Object.keys(window.__xp.store.project.assets));
      await frame.getByTestId('hosted-director-export-png').click();
      const outputWait = await run.page.waitForFunction(ids => Object.values(window.__xp.store.project.assets)
        .some(asset => asset.kind === 'image' && !ids.includes(asset.id)), before, { timeout: 60000 }); await outputWait.dispose();
      const image = await run.page.evaluate(async ids => {
        const asset = Object.values(window.__xp.store.project.assets).find(row => row.kind === 'image' && !ids.includes(row.id));
        const bitmap = await createImageBitmap(await window.__xp.assets.blobOf(asset.id));
        const result = { width: bitmap.width, height: bitmap.height, fromDirector: asset.fromDirector,
          node: window.__xp.store.project.nodes.some(node => node.type === 'asset' && node.data.assetId === asset.id) };
        bitmap.close(); return result;
      }, before);
      assert.equal(image.fromDirector, scope.nodeId); assert.equal(image.node, true);
      assert.ok(image.width > 0 && image.height > 0);
      noModelCalls(run);
      Object.assign(entry, { savedRevision: saved.record.rev, image });
      entry.completedScreenshot = await captureNativeViewport(run.page, {
        path: join(EVIDENCE, `v04-${run.identity.browser}-${label}.png`), width, height });
      evidence(`v04-${run.identity.browser}-${label}.json`, entry);
    } finally { await run.close(); }
    });
  }
  for (const [width, height] of [[1366, 768], [1920, 1080]]) {
    const normal = results.find(row => row.label === `${width}x${height}-zoom100`);
    const zoomed = results.find(row => row.label === `${width}x${height}-zoom125`);
    assert.ok(Math.abs(zoomed.metrics.dpr / normal.metrics.dpr - 1.25) < 0.01);
    assert.ok(Math.abs(zoomed.metrics.innerWidth / normal.metrics.innerWidth - 0.8) < 0.002);
  }
  t.diagnostic(`v04Results=${JSON.stringify(results)}`);
});
