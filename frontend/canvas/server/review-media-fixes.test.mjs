// review 轮服务端修复验收（node --test，无需真实 FFmpeg）：
//  · SVC-1 负探测短 TTL 可重试、正结果长期缓存、不高频 spawn
//  · TL-5 非黑背景 fade 与底色统一（alpha 淡化叠到底色）、叠加 pad 透明、atempo 链保持
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaService } from './media-service.mjs';
import { sanitizeRenderJob } from '../src/export-project.js';

const mkSvc = (over = {}) => createMediaService({
  tools: { available: true, canMp4: true, filters: {}, encoders: {} },
  ...over,
});
const baseJob = over => sanitizeRenderJob({
  format: 'xp-render@1', version: 1,
  output: { width: 320, height: 180, fps: 24, format: 'mp4', background: '#112233' },
  duration: 2,
  tracks: { video: [], overlay: [], audio: [], subtitle: [] },
  media: [], ...over,
});

test('SVC-1：负探测短 TTL 后可重试；TTL 内复用；正结果长期缓存', async () => {
  let calls = 0, failVersion = true;
  const fake = async (cmd, args = []) => {
    calls++;
    if (cmd === 'ffmpeg' && args.includes('-version') && failVersion) {
      failVersion = false;
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    }
    if (args.includes('-encoders')) return { code: 0, stdout: ' V....D libx264\n A....D aac\n', stderr: '' };
    if (args.includes('-filters')) return { code: 0, stdout: ' ... subtitles\n ... drawtext\n', stderr: '' };
    return { code: 0, stdout: 'ffmpeg version 7.0\n', stderr: '' };
  };
  const svc = createMediaService({ spawnImpl: fake, negativeToolsTtlMs: 25 });
  assert.equal((await svc.capabilities()).available, false, 'ffmpeg 缺失诚实报不可用');
  const n1 = calls;
  assert.equal((await svc.capabilities()).available, false, 'TTL 内负结果直接复用');
  assert.equal(calls, n1, 'TTL 内不再 spawn，避免高频探测');
  await new Promise(r => setTimeout(r, 40));
  assert.equal((await svc.capabilities()).available, true, 'TTL 到期重探成功，无需重启');
  const n3 = calls;
  assert.equal((await svc.capabilities()).available, true);
  assert.equal(calls, n3, '正结果长期缓存不再 spawn');
});

test('TL-5：非黑背景下 v1 视频片段 fade 走 alpha 叠到底色（不淡向黑）；pad 与底色一致', () => {
  const job = baseJob({
    tracks: {
      video: [{ file: 'media/a.mp4', start: 0, end: 2, in: 0, speed: 1, volume: 0, fadeIn: 0.5, fadeOut: 0.25 }],
      overlay: [], audio: [], subtitle: [],
    },
    media: [{ key: 'media/a.mp4', assetId: 'a', name: 'a.mp4', kind: 'video', mime: 'video/mp4', size: 1 }],
  });
  const { graph } = mkSvc().buildFilterGraph(job, {
    inputs: [{ key: 'media/a.mp4', local: 'in0.mp4', isImage: false, hasAudio: false }],
    hasSubtitles: false, hasDrawtext: false, subsFile: null, textFiles: new Map(),
  });
  assert.match(graph, /color=c=0x112233:s=320x180/, '底色取用户背景');
  assert.match(graph, /format=rgba,scale/, 'v1 片段先转 rgba');
  assert.match(graph, /fade=t=in:st=0:d=0\.5:alpha=1/, '淡入按 alpha 叠到底色，不淡向黑');
  assert.match(graph, /fade=t=out:st=1\.75:d=0\.25:alpha=1/, '淡出按 alpha');
  assert.match(graph, /pad=320:180:\(ow-iw\)\/2:\(oh-ih\)\/2:0x112233/, 'letterbox 与底色一致');
});

test('TL-5：图片主轨同样 alpha 淡化 + 底色 pad（绝对时间轴语义不变）', () => {
  const job = baseJob({
    tracks: {
      video: [{ file: 'media/p.png', start: 0.5, end: 2, in: 0, speed: 1, volume: 1, fadeIn: 0.5, fadeOut: 0 }],
      overlay: [], audio: [], subtitle: [],
    },
    media: [{ key: 'media/p.png', assetId: 'p', name: 'p.png', kind: 'image', mime: 'image/png', size: 1 }],
  });
  const { graph } = mkSvc().buildFilterGraph(job, {
    inputs: [{ key: 'media/p.png', local: 'in0.png', isImage: true, hasAudio: false, loopT: 2 }],
    hasSubtitles: false, hasDrawtext: false, subsFile: null, textFiles: new Map(),
  });
  assert.match(graph, /format=rgba,scale/, '图片主轨先转 rgba');
  assert.match(graph, /fade=t=in:st=0\.5:d=0\.5:alpha=1/, '图片淡化保持绝对时间轴 + alpha');
  assert.match(graph, /pad=320:180:\(ow-iw\)\/2:\(oh-ih\)\/2:0x112233/, '图片 letterbox 与底色一致');
});

test('TL-5：叠加图片 rect 内 pad 透明透出下层；音轨 atempo 保调链保持', () => {
  const job = baseJob({
    output: { width: 320, height: 180, fps: 24, format: 'mp4', background: '#000000' },
    tracks: {
      video: [{ file: 'media/a.mp4', start: 0, end: 2, in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 }],
      overlay: [{ kind: 'image', file: 'media/p.png', x: 0.1, y: 0.1, w: 0.4, h: 0.4, start: 0.5, end: 1.5, fadeIn: 0.2, fadeOut: 0 }],
      audio: [{ file: 'media/m.wav', track: 'a1', start: 0, end: 2, in: 0, speed: 2, volume: 0.8, fadeIn: 0, fadeOut: 0 }],
      subtitle: [],
    },
    media: [
      { key: 'media/a.mp4', assetId: 'a', name: 'a.mp4', kind: 'video', mime: 'video/mp4', size: 1 },
      { key: 'media/p.png', assetId: 'p', name: 'p.png', kind: 'image', mime: 'image/png', size: 1 },
      { key: 'media/m.wav', assetId: 'm', name: 'm.wav', kind: 'audio', mime: 'audio/wav', size: 1 },
    ],
  });
  const { graph, hasAudio } = mkSvc().buildFilterGraph(job, {
    inputs: [
      { key: 'media/a.mp4', local: 'in0.mp4', isImage: false, hasAudio: true },
      { key: 'media/p.png', local: 'in1.png', isImage: true, hasAudio: false, loopT: 1.5 },
      { key: 'media/m.wav', local: 'in2.wav', isImage: false, hasAudio: true },
    ],
    hasSubtitles: false, hasDrawtext: false, subsFile: null, textFiles: new Map(),
  });
  assert.equal(hasAudio, true, '音轨保留');
  assert.match(graph, /pad=128:72:\(ow-iw\)\/2:\(oh-ih\)\/2:0x00000000/, '叠加图片 pad 透明（透出下层画面）');
  assert.match(graph, /fade=t=in:st=0\.5:d=0\.2:alpha=1/, '叠加 alpha 淡化保持');
  assert.match(graph, /atempo=2(\.0)?/, 'atempo 保调链保持');
});
