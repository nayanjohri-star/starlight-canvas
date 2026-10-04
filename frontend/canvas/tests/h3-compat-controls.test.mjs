// H3 本地兼容控件回归：last_frame 意图接线/恢复/切换卫生、受限型号离散时长标签、
// 慢速版素材限制提示与逐素材说明、aria-label 透传、按次/按秒预估标注。
// 全内存替身，无网络、无真实密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createTaskRunner, applyModelSwitch, genBody, supportsLastFrameOnly, secondsFieldLabel, mediaLimitsHint, assetMediaProblems } from '../src/gennode.js';
import { createStoryboards } from '../src/storyboard.js';
import { setCapabilities, getModel, intentsFor } from '../src/capabilities.js';
import * as keys from '../src/keyvault.js';
import { el } from '../src/ui.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);
const H3 = 'minimax-h3-768p-per-second';
const FULLSLOW = 'minimax-h3-768p-full-slow';
const LIMITED = 'minimax-h3-768p-limited';
const WAN = 'wan-3.0';

// 最小 DOM 存根：setAttribute 记录到 attrs、append 记录到 children（供 aria/文本断言）
globalThis.document = {
  createElement: tag => ({ tag, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener() {}, append(...c) { this.children.push(...c); }, remove() {} }),
  getElementById: () => null,
};

test('ui.el 透传 aria-label：型号/模式/时长/比例控件可按 label 访问', () => {
  for (const label of ['视频生成型号', '生成模式', '生成时长（秒）', '画面比例']) {
    const n = el('select', { 'aria-label': label });
    assert.equal(n.attrs['aria-label'], label);
  }
});

test('supportsLastFrameOnly：仅能力表声明 supports_last_frame_only 的型号', () => {
  assert.equal(supportsLastFrameOnly(FULLSLOW), true);
  for (const id of [H3, LIMITED, WAN, 'minimax-h3-2k-per-second']) assert.equal(supportsLastFrameOnly(id), false, id);
});

test('受限版时长标签显示离散档位 6/10/15，连续区间型号保持 min–max', () => {
  assert.equal(secondsFieldLabel(getModel(LIMITED)), '时长 6/10/15 秒');
  assert.equal(secondsFieldLabel(getModel(H3)), '时长 4–15 秒');
});

test('慢速版素材限制提示：十进制 MB、视频仅 MP4、参考视频/音频每条 2–15 秒且各类合计≤15秒；无声明型号不提示', () => {
  const hint = mediaLimitsHint(getModel(FULLSLOW), FULLSLOW);
  assert.match(hint, /图片≤30MB/);
  assert.match(hint, /视频≤50MB（仅 MP4）/);
  assert.match(hint, /音频≤15MB/);
  assert.match(hint, /参考视频\/音频每条 2–15 秒/);
  assert.match(hint, /各类合计≤15 秒/);
  assert.equal(mediaLimitsHint(getModel(H3), H3), null);
});

test('assetMediaProblems：逐素材给出型号级说明，未声明型号不产生问题', () => {
  const m = getModel(FULLSLOW);
  assert.ok(assetMediaProblems(m, { kind: 'video', mime: 'video/webm', size: 100, name: 'a.webm' }).some(p => /MP4/.test(p)));
  assert.ok(assetMediaProblems(m, { kind: 'image', mime: 'image/png', size: 31000000, name: 'b.png' }).some(p => /30MB/.test(p)));
  assert.equal(assetMediaProblems(m, { kind: 'image', mime: 'image/png', size: 1000, name: 'ok.png' }).length, 0);
  assert.equal(assetMediaProblems(getModel(H3), { kind: 'video', mime: 'video/webm', size: 999000000, name: 'c.webm' }).length, 0);
});

test('genBody 预估：按次型号标注「按次」，按秒型号标注「按秒」', () => {
  const mk = model => ({ data: { draft: { model, intent: 'text', seconds: 15, ratio: '16:9' } } });
  const rowOf = model => genBody(mk(model), { runner: {} }).children.find(c => c.children?.[0]?.textContent === '预估');
  assert.match(rowOf(LIMITED).children[1].textContent, /¥1\.50（标准价·按次）/);
  assert.match(rowOf(H3).children[1].textContent, /按秒/);
  assert.match(rowOf(FULLSLOW).children[1].textContent, /¥1\.50（标准价·按秒）/);
});

test('型号切换：last_frame 存档进 perModel，不支持型号回落、切回支持型号恢复', () => {
  const d = { draft: { model: FULLSLOW, intent: 'last_frame', prompt: 'p', seconds: 15, ratio: '16:9', switches: {} }, perModel: {} };
  applyModelSwitch(d, WAN);
  assert.equal(d.perModel[FULLSLOW].intent, 'last_frame');   // 原样存档待恢复
  assert.notEqual(d.draft.intent, 'last_frame');             // Wan 不支持，绝不泄漏
  assert.ok(intentsFor(WAN).some(i => i.intent === d.draft.intent));
  applyModelSwitch(d, FULLSLOW);
  assert.equal(d.draft.intent, 'last_frame');                // 支持型号恢复已存意图
  const d2 = { draft: { model: H3, intent: 'text', prompt: '', seconds: 4, ratio: '16:9', switches: {} }, perModel: { [WAN]: { intent: 'last_frame', seconds: 5, ratio: '16:9' } } };
  applyModelSwitch(d2, WAN);
  assert.notEqual(d2.draft.intent, 'last_frame');            // 残留 last_frame 不得泄漏到 Wan
});

test('恢复：bodyString 仅 last_frame_url → last_frame；first+last → frames；不支持型号回落 frames', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await keys.setKey('mock-last-frame-key');
  t.after(async () => { await store.flush(); keys.clearKey(); });
  await store.newProject('LF');
  const pid = store.project.id;
  const runner = createTaskRunner({ store, storage, assets: { remoteValid: () => true }, api: {} });
  const seed = (key, model, metadata) => store.savePendingCreate({
    idempotencyKey: key, projectId: pid, nodeId: 'gone', model, keyFp: keys.getFingerprint(),
    bodyString: JSON.stringify({ model, prompt: 'p', seconds: 10, metadata }), state: 'rejected', createdAt: Date.now(),
  });
  await seed('k-last', FULLSLOW, { ratio: '16:9', mode: 'frames', last_frame_url: 'https://example.com/l.png' });
  assert.equal((await runner.restorePending('k-last')).data.draft.intent, 'last_frame');
  await seed('k-both', FULLSLOW, { ratio: '16:9', mode: 'frames', first_frame_url: 'https://example.com/f.png', last_frame_url: 'https://example.com/l.png' });
  assert.equal((await runner.restorePending('k-both')).data.draft.intent, 'frames');
  await seed('k-noleak', H3, { ratio: '16:9', mode: 'frames', last_frame_url: 'https://example.com/l.png' });
  assert.equal((await runner.restorePending('k-noleak')).data.draft.intent, 'frames');
});

test('分镜连线规划：last_frame 恰 1 图接 frames 口；第二图/视频整批拒绝且素材保留', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('SB-LF');
  const sb = createStoryboards({ store, storage });
  const s = sb.addShot({ title: '尾帧镜' });
  const node = store.addNode('gen', 0, 0, { title: 'g', draft: { model: FULLSLOW, intent: 'last_frame', prompt: 'p', seconds: 10, ratio: '16:9', switches: {} }, perModel: {}, run: null });
  s.nodeId = node.id;
  store.project.assets = {
    i1: { id: 'i1', name: 'a.png', kind: 'image' },
    i2: { id: 'i2', name: 'b.png', kind: 'image' },
    v1: { id: 'v1', name: 'c.mp4', kind: 'video' },
  };
  sb.updateShot(s.id, { assetIds: ['i1'] });
  const ok = sb.wireShotAssets(s.id);
  assert.equal(ok.wired, 1);
  assert.equal(store.edgesInto(node.id, 'frames').length, 1);   // 明确接 frames 口，不是 refs/纯文字
  sb.updateShot(s.id, { assetIds: ['i1', 'i2', 'v1'] });
  const bad = sb.wireShotAssets(s.id);
  assert.equal(bad.applied, false);
  assert.equal(bad.wired, 0);
  assert.ok(bad.problems.some(p => /容量已满/.test(p)));
  assert.ok(bad.problems.some(p => /不能接入/.test(p)));
  assert.equal(store.edgesInto(node.id, 'frames').length, 1);   // 整批未接，既有连线不动
  assert.deepEqual(s.assetIds, ['i1', 'i2', 'v1']);             // 素材留在分镜上可见，不静默清理
  await store.flush();
});

test('分镜连线规划：frames/text 意图行为不变', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('SB-FR');
  const sb = createStoryboards({ store, storage });
  store.project.assets = {
    i1: { id: 'i1', name: 'a.png', kind: 'image' },
    i2: { id: 'i2', name: 'b.png', kind: 'image' },
  };
  const s1 = sb.addShot({ title: '首尾帧' });
  const n1 = store.addNode('gen', 0, 0, { title: 'g1', draft: { model: H3, intent: 'frames', prompt: 'p', seconds: 4, ratio: '16:9', switches: {} }, perModel: {}, run: null });
  s1.nodeId = n1.id;
  sb.updateShot(s1.id, { assetIds: ['i1', 'i2'] });
  const r1 = sb.wireShotAssets(s1.id);
  assert.equal(r1.wired, 2);
  assert.equal(store.edgesInto(n1.id, 'frames').length, 2);
  const s2 = sb.addShot({ title: '纯文字' });
  const n2 = store.addNode('gen', 0, 0, { title: 'g2', draft: { model: H3, intent: 'text', prompt: 'p', seconds: 4, ratio: '16:9', switches: {} }, perModel: {}, run: null });
  s2.nodeId = n2.id;
  sb.updateShot(s2.id, { assetIds: ['i1'] });
  const r2 = sb.wireShotAssets(s2.id);
  assert.equal(r2.wired, 0);
  assert.ok(r2.problems.some(p => /不接受素材输入/.test(p)));
  await store.flush();
});
