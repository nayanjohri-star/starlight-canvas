// 生成请求体构造与校验：mode 映射、首尾帧字段、开关门控、数量上限、H3 音频约束、@引用、严格丢素材。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setCapabilities, validateDraft, buildCreateBody, modeForIntent, resolvePromptRefs, syncPromptBindings } from '../src/capabilities.js';

const TABLE = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/星盘AI_视频模型能力表.json'), 'utf8'));
setCapabilities(TABLE);

const img = (u = 'https://x/a.png') => ({ kind: 'image', name: 'a.png', remote: { url: u, expiresAt: 1999999999 } });
const vid = (u = 'https://x/a.mp4', s = 8) => ({ kind: 'video', name: 'a.mp4', remote: { url: u, expiresAt: 1999999999, durationSeconds: s } });
const aud = (u = 'https://x/a.mp3') => ({ kind: 'audio', name: 'a.mp3', remote: { url: u, expiresAt: 1999999999 } });
const draft = over => ({ seconds: 8, ratio: '16:9', intent: 'text', prompt: '测试提示词', switches: {}, ...over });

test('mode 映射词表', () => {
  assert.equal(modeForIntent('minimax-h3-768p-per-second', 'text'), 'text_to_video');
  assert.equal(modeForIntent('minimax-h3-768p-per-second', 'refs'), 'omni_reference');
  assert.equal(modeForIntent('minimax-h3-768p-per-second', 'frames'), 'frames');
  assert.equal(modeForIntent('seedance-2.5-vip-720p', 'refs'), 'references');
  assert.equal(modeForIntent('seedance-2.5-vip-720p', 'frames'), 'frames');
  assert.equal(modeForIntent('wan-3.0', 'i2v'), 'image_to_video');
  assert.equal(modeForIntent('wan-3.0', 'frames'), null);
});

test('H3 文生最小请求体', () => {
  const body = JSON.parse(buildCreateBody('minimax-h3-768p-per-second', draft({ seconds: 4 }), [], []));
  assert.deepEqual(body, { model: 'minimax-h3-768p-per-second', prompt: '测试提示词', seconds: 4, metadata: { ratio: '16:9', mode: 'text_to_video' } });
});

test('H3 首尾帧只发 first/last_frame_url；仅首帧可提交', () => {
  const body = JSON.parse(buildCreateBody('minimax-h3-2k-per-second', draft({ intent: 'frames', seconds: 5, ratio: 'auto' }), [], [img('https://x/f.png'), img('https://x/l.png')]));
  assert.equal(body.metadata.mode, 'frames');
  assert.equal(body.metadata.first_frame_url, 'https://x/f.png');
  assert.equal(body.metadata.last_frame_url, 'https://x/l.png');
  assert.ok(!('image_urls' in body.metadata));
  assert.equal(validateDraft('minimax-h3-768p-per-second', draft({ intent: 'frames' }), [], [img()]), '');
});

test('SD refs 携带三类素材数组 + 显式开关', () => {
  assert.match(validateDraft('seedance-2.5-vip-720p', draft({ intent: 'frames' }), [], [img()]), /两张/);
  const body = JSON.parse(buildCreateBody('seedance-2.5-discount-720p', draft({ intent: 'refs', seconds: 10, switches: { generate_audio: true } }), [img(), vid(), aud()], []));
  assert.equal(body.metadata.mode, 'references');
  assert.equal(body.metadata.image_urls.length, 1);
  assert.equal(body.metadata.generate_audio, true);
});

test('Wan 单图模式恰一图；omni 保留显式 false', () => {
  assert.match(validateDraft('wan-3.0', draft({ intent: 'i2v', seconds: 5 }), [img(), vid()], []), /一张图片/);
  assert.equal(validateDraft('wan-3.0', draft({ intent: 'i2v', seconds: 5 }), [img()], []), '');
  const body = JSON.parse(buildCreateBody('wan-3.0-prime', draft({ intent: 'refs', seconds: 5, switches: { generate_audio: false } }), [img(), img()], []));
  assert.equal(body.metadata.mode, 'omni_reference');
  assert.equal(body.metadata.generate_audio, false, '显式 false 必须保留');
});

test('不支持的开关不发送（H3/SD特殊）', () => {
  const h3 = JSON.parse(buildCreateBody('minimax-h3-768p-per-second', draft({ switches: { generate_audio: false, face_mode: true } }), [], []));
  assert.ok(!('generate_audio' in h3.metadata) && !('face_mode' in h3.metadata));
  const sp = JSON.parse(buildCreateBody('seedance-2.5-special-720p', draft({ switches: { generate_audio: false } }), [], []));
  assert.ok(!('generate_audio' in sp.metadata));
});

test('SD 参考视频：上传后（post）ceil(合计秒数)≤30 且必须有可信时长；上传前（pre）不阻塞', () => {
  const d = draft({ intent: 'refs', seconds: 10 });
  assert.match(validateDraft('seedance-2.5-vip-720p', d, [vid('https://x/a.mp4', 20), vid('https://x/b.mp4', 20)], [], [], 'post'), /30 秒/);
  const noDur = { kind: 'video', name: 'x.mp4', remote: { url: 'https://x/c.mp4', expiresAt: 1999999999 } };
  assert.match(validateDraft('seedance-2.5-vip-720p', d, [noDur], [], [], 'post'), /可信时长/);
  assert.equal(validateDraft('seedance-2.5-vip-720p', d, [vid('https://x/a.mp4', 20.4), vid('https://x/b.mp4', 9.2)], [], [], 'post'), '');
  // pre 阶段：本地新文件（无 remote）允许进入上传流程
  const fresh = { kind: 'video', name: 'new.mp4', remote: null };
  assert.equal(validateDraft('seedance-2.5-vip-720p', d, [fresh], [], [], 'pre'), '');
  assert.match(validateDraft('seedance-2.5-vip-720p', d, [fresh], [], [], 'post'), /远端/);
});

test('缺远端 url 直接抛错，不静默丢素材', () => {
  const noRemote = { kind: 'image', name: 'lost.png', remote: null };
  assert.throws(() => buildCreateBody('seedance-2.5-vip-720p', draft({ intent: 'refs' }), [noRemote], []), /缺少有效远端地址/);
  const badUrl = { kind: 'image', name: 'bad.png', remote: { url: 'http://insecure/x.png' } };
  assert.throws(() => buildCreateBody('seedance-2.5-vip-720p', draft({ intent: 'refs' }), [badUrl], []), /远端地址/);
});

test('@引用按连线顺序绑定；失效引用报错', () => {
  const r = resolvePromptRefs('保持@图片1的人物，配@音频1的背景音乐', [img('https://x/p.png'), aud('https://x/m.mp3')]);
  assert.equal(r.normalized, '保持@1的人物，配@音频1的背景音乐');
  assert.equal(r.missing.length, 0);
  const bad = resolvePromptRefs('@图片2 特写', [img()]);
  assert.deepEqual(bad.missing, ['@图片2']);
  assert.match(validateDraft('seedance-2.5-vip-720p', draft({ intent: 'refs', prompt: '@视频2 运镜' }), [vid()], []), /未连接素材/);
});

test('@引用稳定绑定：删前图后 @图片1 不失联到别的素材', () => {
  const a = { id: 'A', kind: 'image', name: 'a.png', remote: { url: 'https://x/a.png', expiresAt: 1999999999 } };
  const b = { id: 'B', kind: 'image', name: 'b.png', remote: { url: 'https://x/b.png', expiresAt: 1999999999 } };
  let bindings = syncPromptBindings('@图片1 特写', [a, b], {});
  assert.equal(bindings['image:1'], 'A');
  // 删除 A 后引用失效（报错），而不是悄悄指到 B
  const r = resolvePromptRefs('@图片1 特写', [b], bindings);
  assert.deepEqual(r.missing, ['@图片1']);
  // 连线顺序变化后绑定跟随素材本体
  const r2 = resolvePromptRefs('@图片1 特写', [b, a], bindings);
  assert.equal(r2.normalized, '@2 特写');
});

test('数量/规则校验与问题连线阻断', () => {
  assert.match(validateDraft('minimax-h3-768p-per-second', draft({ intent: 'refs' }), [aud()], []), /音频参考需要同时/);
  assert.match(validateDraft('wan-3.0', draft({ seconds: 4 }), [], []), /5–30/);
  assert.match(validateDraft('minimax-h3-768p-per-second', draft({ ratio: '21:9' }), [], []), /比例/);
  assert.match(validateDraft('seedance-2.5-vip-720p', draft({ intent: 'frames' }), [img()], [img(), img()]), /不应连接普通素材/);
  assert.match(validateDraft('seedance-2.5-vip-720p', draft(), [], [], ['上游生成节点尚无可用成片']), /连线来源未就绪/);
});

test('提示词长度与空 prompt', () => {
  assert.match(validateDraft('wan-3.0', draft({ prompt: '  ' }), [], []), /不能为空/);
  assert.match(validateDraft('seedance-2.5-special-480p', draft({ prompt: 'x'.repeat(5001) }), [], []), /5000/);
});
