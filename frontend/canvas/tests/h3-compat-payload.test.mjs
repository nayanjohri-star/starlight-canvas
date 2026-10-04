// H3 两个独立型号（能力受限768p / 满参慢速版768p）的本地兼容：
// 能力过滤与 mode 映射、离散时长、auto 比例、仅尾帧（last_frame）校验与请求体、
// 介质预检（mime/size）、上传后时长合同、规范化后提示词上限、按次估价与旧型号回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCapabilities, intentsFor, modeForIntent, estimateCost, validateDraft, buildCreateBody,
  mediaLimitSummary, mediaDurationRule, mediaPrecheckError, resolvePromptRefs } from '../src/capabilities.js';

const TABLE = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/星盘AI_视频模型能力表.json'), 'utf8'));
setCapabilities(TABLE);

const LIMITED = 'minimax-h3-768p-limited';    // 能力受限768p：仅 6/10/15s、16:9、按次 ¥1.50、无视频参考/首尾帧
const FULLSLOW = 'minimax-h3-768p-full-slow'; // 满参慢速版768p：1–15s、仅尾帧、型号级介质与时长合同

const img = (u = 'https://x/a.png', over = {}) => ({ kind: 'image', name: 'a.png', mime: 'image/png', size: 1024, remote: { url: u, expiresAt: 1999999999 }, ...over });
const vid = (u = 'https://x/a.mp4', s = 8, over = {}) => ({ kind: 'video', name: 'a.mp4', mime: 'video/mp4', size: 1024, remote: { url: u, expiresAt: 1999999999, durationSeconds: s }, ...over });
const aud = (u = 'https://x/a.mp3', s = 8, over = {}) => ({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1024, remote: { url: u, expiresAt: 1999999999, durationSeconds: s }, ...over });
const draft = over => ({ seconds: 10, ratio: '16:9', intent: 'refs', prompt: '测试提示词', switches: {}, ...over });

test('能力过滤：受限型号无首尾帧，慢速版含 last_frame', () => {
  assert.deepEqual(intentsFor(LIMITED).map(i => i.intent), ['text', 'refs']);
  assert.deepEqual(intentsFor(FULLSLOW).map(i => i.intent), ['text', 'refs', 'frames', 'last_frame']);
  assert.equal(modeForIntent(FULLSLOW, 'last_frame'), 'frames');
  assert.equal(modeForIntent(FULLSLOW, 'refs'), 'omni_reference');
  assert.equal(modeForIntent(LIMITED, 'refs'), 'omni_reference');
  assert.equal(modeForIntent(LIMITED, 'frames'), null);
  assert.equal(modeForIntent(LIMITED, 'last_frame'), null);
  assert.equal(modeForIntent('minimax-h3-768p-per-second', 'last_frame'), null);
  assert.equal(modeForIntent('wan-3.0', 'last_frame'), null);
});

test('受限版固定按次、满参慢速版按请求秒数估价', () => {
  assert.equal(estimateCost(LIMITED, 6), 1.5);
  assert.equal(estimateCost(LIMITED, 15), 1.5);
  assert.equal(estimateCost(FULLSLOW, 1), 0.1);
  assert.equal(estimateCost(FULLSLOW, 5), 0.5);
  assert.equal(estimateCost(FULLSLOW, 10), 1);
  assert.equal(estimateCost(FULLSLOW, 15), 1.5);
  assert.equal(estimateCost('minimax-h3-768p-per-second', 4), 0.6);
});

test('受限型号时长：仅 6/10/15，错误显示离散值而非区间', () => {
  for (const s of [5, 8, 12, 16]) assert.match(validateDraft(LIMITED, draft({ intent: 'text', seconds: s }), [], []), /6\/10\/15/);
  for (const s of [6, 10, 15]) assert.equal(validateDraft(LIMITED, draft({ intent: 'text', seconds: s }), [], []), '');
});

test('慢速版时长 1–15 整数秒与 auto 比例约束', () => {
  assert.match(validateDraft(FULLSLOW, draft({ intent: 'text', seconds: 0 }), [], []), /1–15/);
  assert.match(validateDraft(FULLSLOW, draft({ intent: 'text', seconds: 16 }), [], []), /1–15/);
  assert.equal(validateDraft(FULLSLOW, draft({ intent: 'text', seconds: 1 }), [], []), '');
  assert.match(validateDraft(FULLSLOW, draft({ intent: 'text', ratio: 'auto', seconds: 5 }), [], []), /自适应比例/);
  assert.match(validateDraft(FULLSLOW, draft({ intent: 'refs', ratio: 'auto' }), [aud()], []), /自适应比例/);
  assert.equal(validateDraft(FULLSLOW, draft({ intent: 'refs', ratio: 'auto' }), [img()], []), '');
  assert.equal(validateDraft(LIMITED, draft({ intent: 'text', ratio: 'auto' }), [], []), '比例不在该型号支持范围');
});

test('21:9 按型号区分：满参慢速版支持，两个按秒档及受限版拒绝', () => {
  assert.equal(validateDraft(FULLSLOW, draft({ intent: 'text', ratio: '21:9' }), [], []), '');
  assert.equal(JSON.parse(buildCreateBody(FULLSLOW, draft({ intent: 'text', ratio: '21:9' }), [], [])).metadata.ratio, '21:9');
  for (const id of [LIMITED, 'minimax-h3-768p-per-second', 'minimax-h3-2k-per-second']) {
    assert.equal(validateDraft(id, draft({ intent: 'text', ratio: '21:9' }), [], []), '比例不在该型号支持范围');
  }
});

test('型号介质大小错误使用与提示相同的十进制 MB', () => {
  assert.match(mediaPrecheckError(FULLSLOW, [vid('https://x/large.mp4', 8, { size: 60000000 })]), /50MB，1MB=1,000,000字节/);
});

test('受限型号素材约束：无视频参考、音频须搭配图片', () => {
  assert.match(validateDraft(LIMITED, draft(), [vid()], []), /分项上限/);
  assert.match(validateDraft(LIMITED, draft(), [aud()], []), /音频参考需要同时/);
  assert.equal(validateDraft(LIMITED, draft(), [img(), aud()], []), '');
  assert.equal(validateDraft(LIMITED, draft(), Array.from({ length: 9 }, (_, i) => img(`https://x/${i}.png`)), []), '');
});

test('慢速版允许纯音频参考（supports_audio_only）', () => {
  assert.equal(validateDraft(FULLSLOW, draft(), [aud(), aud('https://x/b.mp3')], []), '');
});

test('仅尾帧校验：恰好一张图片，拒绝普通素材/多张/非图', () => {
  const d = draft({ intent: 'last_frame' });
  assert.equal(validateDraft(FULLSLOW, d, [], [img()]), '');
  assert.match(validateDraft(FULLSLOW, d, [], []), /恰好一张/);
  assert.match(validateDraft(FULLSLOW, d, [], [img(), img()]), /恰好一张/);
  assert.match(validateDraft(FULLSLOW, d, [img()], [img()]), /不应连接普通素材/);
  assert.match(validateDraft(FULLSLOW, d, [], [vid()]), /只能使用图片/);
  assert.match(validateDraft(LIMITED, d, [], [img()]), /不支持所选模式/);
  assert.match(validateDraft('minimax-h3-768p-per-second', d, [], [img()]), /不支持所选模式/);
});

test('仅尾帧请求体：只发 mode=frames + last_frame_url', () => {
  const body = JSON.parse(buildCreateBody(FULLSLOW, draft({ intent: 'last_frame' }), [], [img('https://x/last.png')]));
  assert.equal(body.metadata.mode, 'frames');
  assert.equal(body.metadata.last_frame_url, 'https://x/last.png');
  for (const k of ['first_frame_url', 'image_urls', 'video_urls', 'audio_urls', 'generate_audio', 'face_mode'])
    assert.ok(!(k in body.metadata), `不应发送 ${k}`);
});

test('仅尾帧构造严格：多张/夹带素材/非图/缺远端一律抛错', () => {
  const d = draft({ intent: 'last_frame' });
  assert.throws(() => buildCreateBody(FULLSLOW, d, [], [img(), img()]), /恰好一张/);
  assert.throws(() => buildCreateBody(FULLSLOW, d, [img()], [img()]), /普通素材/);
  assert.throws(() => buildCreateBody(FULLSLOW, d, [], [vid()]), /只能使用图片/);
  const noRemote = { kind: 'image', name: 'x.png', mime: 'image/png', size: 10, remote: null };
  assert.throws(() => buildCreateBody(FULLSLOW, d, [], [noRemote]), /远端地址/);
});

test('frames 模式回归：首帧/首尾帧与普通素材数组行为不变', () => {
  const one = JSON.parse(buildCreateBody(FULLSLOW, draft({ intent: 'frames' }), [], [img('https://x/f.png')]));
  assert.equal(one.metadata.first_frame_url, 'https://x/f.png');
  assert.ok(!('last_frame_url' in one.metadata));
  const two = JSON.parse(buildCreateBody(FULLSLOW, draft({ intent: 'frames' }), [], [img('https://x/f.png'), img('https://x/l.png')]));
  assert.equal(two.metadata.last_frame_url, 'https://x/l.png');
  const sd = JSON.parse(buildCreateBody('seedance-2.5-vip-720p', draft({ intent: 'frames' }), [], [img('https://x/f.png'), img('https://x/l.png')]));
  assert.deepEqual([sd.metadata.first_frame_url, sd.metadata.last_frame_url], ['https://x/f.png', 'https://x/l.png']);
  assert.match(validateDraft(FULLSLOW, draft({ intent: 'frames' }), [img()], [img()]), /不应连接普通素材/);
  assert.match(validateDraft(FULLSLOW, draft({ intent: 'frames' }), [], []), /1–2 张/);
  assert.match(validateDraft('seedance-2.5-vip-720p', draft({ intent: 'frames' }), [], [img()]), /两张/);
});

test('介质预检：webm 视频/超限/缺元数据明确拒绝，其他型号不受限', () => {
  const d = draft();
  const webm = vid('https://x/a.webm', 8, { name: 'a.webm', mime: 'video/webm' });
  assert.match(validateDraft(FULLSLOW, d, [webm], []), /不在该型号支持范围/);
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/big.mp4', 8, { size: 60_000_000 })], []), /50MB/);
  assert.match(validateDraft(FULLSLOW, d, [aud('https://x/a.mp3', 8, { size: 20_000_000 })], []), /15MB/);
  assert.match(validateDraft(FULLSLOW, d, [img('https://x/a.png', { size: 40_000_000 })], []), /30MB/);
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/a.mp4', 8, { mime: '' })], []), /重新绑定/);
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/a.mp4', 8, { size: undefined })], []), /重新绑定/);
  // 合法组合在 post 同样通过本地介质检查
  assert.equal(validateDraft(FULLSLOW, d, [img(), vid(), aud()], [], [], 'post'), '');
  // 未声明介质限制的型号不受约束
  assert.equal(validateDraft('minimax-h3-768p-per-second', draft({ seconds: 8 }), [webm], []), '');
  // 首尾帧图片同样走介质预检
  assert.match(validateDraft(FULLSLOW, draft({ intent: 'last_frame' }), [], [img('https://x/f.png', { size: 40_000_000 })]), /30MB/);
});

test('介质预检大小字段：声明上限型号下 0/负/NaN/缺失均为可操作错误，未声明型号不受影响', () => {
  const d = draft();
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/z0.mp4', 8, { size: 0 })], []), /为空或大小异常/);
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/z1.mp4', 8, { size: -5 })], []), /为空或大小异常/);
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/z2.mp4', 8, { size: NaN })], []), /缺少本地大小信息/);
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/z3.mp4', 8, { size: undefined })], []), /缺少本地大小信息/);
  assert.match(mediaPrecheckError(FULLSLOW, [vid('https://x/z4.mp4', 8, { size: 0 })]), /为空或大小异常/);
  // 未声明介质限制的旧型号：size 为 0/缺失不触发该预检，行为保留
  assert.equal(mediaPrecheckError('minimax-h3-768p-per-second', [{ kind: 'video', name: 'z.mp4', size: 0 }]), '');
  assert.equal(validateDraft('minimax-h3-768p-per-second', draft({ seconds: 8 }), [vid('https://x/z.mp4', 8, { size: 0 })], []), '');
});

test('上传后时长合同：每条 2–15s、各类型合计 ≤15s、缺可信时长拒绝', () => {
  const d = draft();
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/a.mp4', 20)], [], [], 'post'), /2–15/);
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/a.mp4', 1)], [], [], 'post'), /2–15/);
  assert.match(validateDraft(FULLSLOW, d, [vid('https://x/a.mp4', 8), vid('https://x/b.mp4', 8)], [], [], 'post'), /合计/);
  assert.match(validateDraft(FULLSLOW, d, [aud('https://x/a.mp3', 9), aud('https://x/b.mp3', 8)], [], [], 'post'), /合计/);
  const noDurV = { kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 100, remote: { url: 'https://x/v.mp4', expiresAt: 1999999999 } };
  assert.match(validateDraft(FULLSLOW, d, [noDurV], [], [], 'post'), /可信时长/);
  const noDurA = { kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 100, remote: { url: 'https://x/a.mp3', expiresAt: 1999999999 } };
  assert.match(validateDraft(FULLSLOW, d, [img(), noDurA], [], [], 'post'), /可信时长/);
  // 边界：单条恰好 15s、合计恰好 15s 均可
  assert.equal(validateDraft(FULLSLOW, d, [vid('https://x/a.mp4', 15)], [], [], 'post'), '');
  assert.equal(validateDraft(FULLSLOW, d, [vid('https://x/a.mp4', 7), vid('https://x/b.mp4', 8)], [], [], 'post'), '');
});

test('陈旧/过期 remote 不在 pre 阻挡重新上传，post 仍严格拦截', () => {
  const d = draft();
  const stale = { kind: 'video', name: 's.mp4', mime: 'video/mp4', size: 100, remote: { url: 'https://x/s.mp4', expiresAt: 1, durationSeconds: 99 } };
  assert.equal(validateDraft(FULLSLOW, d, [stale], [], [], 'pre'), '');
  assert.match(validateDraft(FULLSLOW, d, [stale], [], [], 'post'), /过期/);
  const fresh = { kind: 'video', name: 'n.mp4', mime: 'video/mp4', size: 100, remote: null };
  assert.equal(validateDraft(FULLSLOW, d, [fresh], [], [], 'pre'), '');
  assert.match(validateDraft(FULLSLOW, d, [fresh], [], [], 'post'), /远端/);
});

test('规范化后提示词同样受型号字符上限约束', () => {
  // '@视频1' 经绑定指向第 10 个视频 → '@视频10'（视频保留类名 token），每处 +1 字符：raw 不超限、规范化后超限
  const vids = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, kind: 'video', name: `v${i}.mp4`, mime: 'video/mp4', size: 100, remote: { url: `https://x/${i}.mp4`, expiresAt: 1999999999 } }));
  const d = draft({ prompt: '@视频1'.repeat(13333), bindings: { 'video:1': 'v9' } });
  const { normalized, missing } = resolvePromptRefs(d.prompt, vids, d.bindings);
  assert.deepEqual(missing, []);
  assert.equal([...d.prompt].length, 53332);            // raw 恰在上限内
  assert.equal([...normalized].length, 66665);          // 规范化后才越界
  assert.ok(normalized.startsWith('@视频10'));          // 绑定确指向第 10 个视频
  assert.match(validateDraft('seedance-2.5-vip-720p', d, vids, []), /规范化后提示词超过 60000/);
  assert.throws(() => buildCreateBody('seedance-2.5-vip-720p', d, vids, []), /规范化后提示词超过 60000/);
});

test('介质限制摘要与时长规则 API', () => {
  const s = mediaLimitSummary(FULLSLOW);
  assert.equal(s.video.maxBytes, 50000000);
  assert.deepEqual(s.video.contentTypes, ['video/mp4']);
  assert.equal(s.image.maxBytes, 30000000);
  assert.equal(s.audio.maxBytes, 15000000);
  assert.ok(s.audio.contentTypes.includes('audio/x-wav'));
  assert.equal(mediaLimitSummary(LIMITED), null);
  assert.equal(mediaLimitSummary('wan-3.0'), null);
  assert.deepEqual(mediaDurationRule(FULLSLOW), { min: 2, max: 15, kind_total: 15 });
  assert.equal(mediaDurationRule(LIMITED), null);
  assert.equal(mediaPrecheckError(FULLSLOW, []), '');
  assert.match(mediaPrecheckError(FULLSLOW, [vid('https://x/a.webm', 8, { mime: 'video/webm' })]), /不在该型号支持范围/);
});

test('auto 比例约束同样约束按秒的仅尾帧型号（supports_last_frame_only）', () => {
  // WO-B-PORT1 移植：auto-ratio 守卫原为仅 billing_unit==='request'；
  // 按秒计费但声明 supports_last_frame_only 的型号（如新版满参慢速档）同样需要视觉素材。
  const synthetic = {
    ...TABLE,
    models: {
      ...TABLE.models,
      'h3-sec-lastframe': {
        ...TABLE.models[FULLSLOW],
        billing_unit: 'second',
        price_cny_per_second: 0.1,
      },
    },
  };
  setCapabilities(synthetic);
  try {
    assert.match(validateDraft('h3-sec-lastframe', draft({ intent: 'text', ratio: 'auto', seconds: 5 }), [], []), /自适应比例/);
    assert.match(validateDraft('h3-sec-lastframe', draft({ intent: 'refs', ratio: 'auto' }), [aud()], []), /自适应比例/);
    assert.equal(validateDraft('h3-sec-lastframe', draft({ intent: 'refs', ratio: 'auto' }), [img()], []), '');
    assert.equal(estimateCost('h3-sec-lastframe', 10), 1);
  } finally { setCapabilities(TABLE); }
});

test('受限型号请求体：omni_reference + 素材数组，不发送开关', () => {
  const b = JSON.parse(buildCreateBody(LIMITED, draft(), [img('https://x/p.png'), aud('https://x/m.mp3')], []));
  assert.equal(b.metadata.mode, 'omni_reference');
  assert.deepEqual(b.metadata.image_urls, ['https://x/p.png']);
  assert.deepEqual(b.metadata.audio_urls, ['https://x/m.mp3']);
  for (const k of ['generate_audio', 'face_mode', 'first_frame_url', 'last_frame_url']) assert.ok(!(k in b.metadata));
});

test('旧型号回归：按秒 H3 / SD / Wan 关键契约不变', () => {
  const h3 = JSON.parse(buildCreateBody('minimax-h3-768p-per-second', draft({ intent: 'frames', seconds: 8 }), [], [img('https://x/f.png')]));
  assert.equal(h3.metadata.first_frame_url, 'https://x/f.png');
  assert.ok(!('last_frame_url' in h3.metadata));
  assert.match(validateDraft('minimax-h3-768p-per-second', draft({ seconds: 8 }), [aud()], []), /音频参考需要同时/);
  assert.match(validateDraft('wan-3.0', draft({ intent: 'i2v', seconds: 5 }), [img(), vid()], []), /一张图片/);
  assert.match(validateDraft('wan-3.0', draft({ intent: 'last_frame' }), [], [img()]), /不支持所选模式/);
});
