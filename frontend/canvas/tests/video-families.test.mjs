// 新视频型号族（SD 2.0、可灵、Muse，以及 Wan 480P/720P）在画布里的能力：
// 模式映射、提交前校验、请求体、型号下拉分组、单图锚点方案与草稿默认时长。
// 全内存替身，无网络、无真实密钥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setCapabilities, intentsFor, modeForIntent, validateDraft, buildCreateBody, modelIds, estimateCost } from '../src/capabilities.js';
import { fillDraftDefaults, modelFamilyGroups } from '../src/gennode.js';
import { singleImagePlan } from '../src/storyboard.js';

const TABLE = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(TABLE);

const SEEDANCE_SHAPED = ['seedance-2.0-480p', 'seedance-2.0-720p', 'seedance-2.0-discount-720p', 'seedance-2.0-fast-720p',
  'seedance-2.0-mini-720p', 'kling-v4-720p', 'kling-v4-1080p', 'kling-omni-4-720p', 'muse-720p', 'seedance-2.5-discount-1080p'];
const img = (u = 'https://x/a.png') => ({ id: u, kind: 'image', name: 'a.png', mime: 'image/png', size: 1024, remote: { url: u, expiresAt: 1999999999 } });
const vid = (u = 'https://x/a.mp4', s = 8) => ({ id: u, kind: 'video', name: 'a.mp4', mime: 'video/mp4', size: 1024, remote: { url: u, expiresAt: 1999999999, durationSeconds: s } });
const aud = (u = 'https://x/a.mp3', s = 8) => ({ id: u, kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1024, remote: { url: u, expiresAt: 1999999999, durationSeconds: s } });
const draft = (model, over = {}) => ({ seconds: TABLE.models[model].seconds.default, ratio: '16:9', intent: 'refs', prompt: '测试提示词', switches: {}, ...over });

test('SD 2.0、可灵、Muse 纯文字与素材参考都发 references，没有首尾帧', () => {
  for (const id of SEEDANCE_SHAPED) {
    assert.deepEqual(intentsFor(id).map(i => [i.intent, i.mode]), [['text', 'references'], ['refs', 'references']], id);
    assert.equal(modeForIntent(id, 'frames'), null, id);
    assert.equal(modeForIntent(id, 'i2v'), null, id);
    assert.deepEqual(singleImagePlan(id), { intent: 'refs', port: 'refs' }, id);
    assert.equal(validateDraft(id, draft(id, { intent: 'frames' }), [], [img(), img('https://x/b.png')]), '该型号不支持所选模式', id);
  }
  const body = JSON.parse(buildCreateBody('kling-v4-720p', draft('kling-v4-720p', { intent: 'text', switches: { generate_audio: false } }), [], []));
  assert.deepEqual(body, { model: 'kling-v4-720p', prompt: '测试提示词', seconds: 5, metadata: { ratio: '16:9', mode: 'references', generate_audio: false } });
  const muse = JSON.parse(buildCreateBody('muse-720p', draft('muse-720p', { switches: { generate_audio: true } }), [img()], []));
  assert.deepEqual(muse.metadata, { ratio: '16:9', mode: 'references', image_urls: ['https://x/a.png'] }, 'Muse 无声音开关，不发 generate_audio');
});

test('提交前校验按各型号的时长、比例与素材上限', () => {
  assert.equal(validateDraft('seedance-2.0-720p', draft('seedance-2.0-720p', { seconds: 15 }), [img(), vid()], []), '');
  assert.match(validateDraft('seedance-2.0-720p', draft('seedance-2.0-720p', { seconds: 16 }), [img()], []), /4–15/);
  assert.equal(validateDraft('seedance-2.0-720p', draft('seedance-2.0-720p'), [aud()], []), '素材数量超过该型号分项上限');
  assert.equal(validateDraft('seedance-2.0-mini-720p', draft('seedance-2.0-mini-720p', { ratio: 'auto', intent: 'text' }), [], []), '');
  assert.equal(validateDraft('seedance-2.0-mini-720p', draft('seedance-2.0-mini-720p'), [vid()], []), '素材数量超过该型号分项上限');
  assert.equal(validateDraft('kling-v4-720p', draft('kling-v4-720p', { seconds: 3 }), [img(), vid(), aud()], []), '');
  assert.equal(validateDraft('kling-v4-720p', draft('kling-v4-720p', { ratio: '4:3' }), [img()], []), '比例不在该型号支持范围');
  assert.match(validateDraft('kling-omni-4-720p', draft('kling-omni-4-720p', { seconds: 4 }), [img()], []), /5–30/);
  assert.equal(validateDraft('muse-720p', draft('muse-720p', { seconds: 45, ratio: '9:16' }), Array.from({ length: 7 }, (_, i) => img(`https://x/${i}.png`)), []), '');
  assert.equal(validateDraft('muse-720p', draft('muse-720p'), [aud()], []), '素材数量超过该型号分项上限');
  assert.equal(estimateCost('muse-720p', 10), 1.3);
  assert.equal(estimateCost('kling-v4-1080p', 5), 4);
});

test('Wan 新合同：参考音频要配图片或视频，1080P 带参考视频最多 15 秒，声音开关不发送', () => {
  for (const id of ['wan-3.0', 'wan-3.0-480p', 'wan-3.0-720p']) {
    assert.equal(validateDraft(id, draft(id), [aud()], []), 'Wan 音频参考需要同时带图片或视频', id);
    assert.equal(validateDraft(id, draft(id), [img(), aud()], []), '', id);
  }
  assert.equal(validateDraft('wan-3.0', draft('wan-3.0', { seconds: 16 }), [vid()], []), 'Wan 1080P 带参考视频时时长最多 15 秒');
  assert.equal(validateDraft('wan-3.0-prime', draft('wan-3.0-prime', { seconds: 15 }), [vid()], []), '');
  assert.equal(validateDraft('wan-3.0', draft('wan-3.0', { seconds: 30 }), [img()], []), '');
  assert.equal(validateDraft('wan-3.0-720p', draft('wan-3.0-720p', { seconds: 30 }), [vid()], []), '');
  assert.equal(validateDraft('wan-3.0', draft('wan-3.0', { seconds: 4, ratio: '21:9', intent: 'text' }), [], []), '');
  assert.match(validateDraft('wan-3.0-480p', draft('wan-3.0-480p', { seconds: 4, intent: 'text' }), [], []), /5–30/);
  const body = JSON.parse(buildCreateBody('wan-3.0', draft('wan-3.0', { intent: 'i2v', switches: { generate_audio: false } }), [img()], []));
  assert.deepEqual(body.metadata, { ratio: '16:9', mode: 'image_to_video', image_urls: ['https://x/a.png'] });
});

test('能力表可选标志 audio_requires_image：参考音频必须搭配参考图片', () => {
  const stub = structuredClone(TABLE);
  stub.models['kling-v4-720p'].audio_requires_image = true;
  setCapabilities(stub);
  try {
    assert.equal(validateDraft('kling-v4-720p', draft('kling-v4-720p'), [vid(), aud()], []), '该型号的参考音频必须搭配参考图片');
    assert.equal(validateDraft('kling-v4-720p', draft('kling-v4-720p'), [img(), aud()], []), '');
  } finally { setCapabilities(TABLE); }
});

test('型号下拉按族分组，覆盖能力表全部型号', () => {
  const groups = modelFamilyGroups();
  assert.deepEqual(groups.map(g => g.family), ['h3', 'sd25', 'sd20', 'kling', 'muse', 'wan']);
  assert.deepEqual(groups.flatMap(g => g.ids).sort(), modelIds().sort());
  assert.equal(groups.find(g => g.family === 'kling').label, '可灵 Kling');
  const extra = structuredClone(TABLE);
  extra.models['future-1'] = { ...extra.models['muse-720p'], family: 'future' };
  setCapabilities(extra);
  try { assert.deepEqual(modelFamilyGroups().at(-1), { family: 'future', label: 'future', ids: ['future-1'] }); }
  finally { setCapabilities(TABLE); }
});

test('未填时长的草稿按所选型号的默认时长，不再一律 15 秒', () => {
  const cases = { 'seedance-2.5-vip-720p': 4, 'seedance-2.0-720p': 4, 'kling-v4-720p': 5, 'muse-720p': 5, 'wan-3.0': 5, 'minimax-h3-768p-per-second': 15 };
  for (const [model, seconds] of Object.entries(cases)) {
    const d = { draft: { model } };
    assert.equal(fillDraftDefaults(d).seconds, seconds, model);
    assert.deepEqual(d.perModel, {});
  }
  assert.equal(fillDraftDefaults({ draft: { model: 'seedance-2.5-vip-720p', seconds: 12 } }).seconds, 12, '已有时长保留');
  assert.equal(fillDraftDefaults({}).seconds, 15, '无草稿时默认 H3 的 15 秒');
  const unknown = fillDraftDefaults({ draft: { model: 'retired-model' } });
  assert.deepEqual([unknown.model, unknown.seconds], ['minimax-h3-768p-per-second', 15]);
});
