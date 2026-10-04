// G3-1 回归：buildFilterGraph 音频扇出滤镜——同一素材被 ≥2 个片段引用音频
// （「再次插入」/同素材重复入轨，aUses>1）时必须产出 asplit；视频垫扇出仍为 split。
// 基线缺陷：音频垫误用视频滤镜 split → ffmpeg「Media type mismatch」渲染整体失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterGraph } from '../server/media-service.mjs';

const baseJob = video => ({
  duration: 10,
  output: { width: 1280, height: 720, fps: 30, background: '#000000' },
  tracks: { video, overlay: [], audio: [], subtitle: [] },
});
const baseLayout = inputs => ({
  inputs, textFiles: new Map(), hasDrawtext: false, hasSubtitles: false, subsFile: null,
});
const clip = (file, start, end, over = {}) => ({
  file, start, end, in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, ...over,
});

test('同素材双音频引用（再次插入）→ 音频垫产出 asplit，不产出音频 split', () => {
  const job = baseJob([clip('a.mp4', 0, 5), clip('a.mp4', 5, 10)]);
  const layout = baseLayout([{ key: 'a.mp4', local: '/t/a.mp4', isImage: false, hasAudio: true }]);
  const { graph, hasAudio } = buildFilterGraph(job, layout);
  assert.match(graph, /\[0:a\]asplit=2\[as\d+\]\[as\d+\]/, '音频扇出必须是 asplit=2');
  assert.ok(!/\[\d+:a\]split/.test(graph), '任何音频垫不得使用视频滤镜 split');
  assert.equal(hasAudio, true);
  // 两路 as* 垫各自进入 atrim 音频链（音量/变速处理）
  const atrimCount = (graph.match(/atrim=start=/g) ?? []).length;
  assert.equal(atrimCount, 2, '两片段音频各自走 atrim');
  assert.match(graph, /amix=inputs=3/, 'abase+两段音频入 amix');
});

test('同素材双视频引用 → 视频垫扇出仍为 split（不误伤视频分支）', () => {
  const job = baseJob([clip('a.mp4', 0, 5), clip('a.mp4', 5, 10)]);
  const layout = baseLayout([{ key: 'a.mp4', local: '/t/a.mp4', isImage: false, hasAudio: true }]);
  const { graph } = buildFilterGraph(job, layout);
  assert.match(graph, /\[0:v\]split=2\[vs\d+\]\[vs\d+\]/, '视频扇出保持 split=2');
  assert.ok(!/\[\d+:v\]asplit/.test(graph), '视频垫不得使用 asplit');
});

test('同素材三次音频引用 → asplit=3；静音片段不计音频引用', () => {
  const job = baseJob([clip('a.mp4', 0, 3), clip('a.mp4', 3, 6), clip('a.mp4', 6, 9)]);
  const layout = baseLayout([{ key: 'a.mp4', local: '/t/a.mp4', isImage: false, hasAudio: true }]);
  const { graph } = buildFilterGraph(job, layout);
  assert.match(graph, /\[0:a\]asplit=3/, '三次引用 asplit=3');
  // volume=0 片段不算音频引用 → 单引用不扇出
  const muted = baseJob([clip('a.mp4', 0, 3), clip('a.mp4', 3, 6, { volume: 0 })]);
  const g2 = buildFilterGraph(muted, layout).graph;
  assert.ok(!/\[0:a\]a?split/.test(g2), '仅一个有声引用时无音频扇出');
});

test('单素材单引用 → 不产生任何扇出滤镜（既有行为不变）', () => {
  const job = baseJob([clip('a.mp4', 0, 5)]);
  const layout = baseLayout([{ key: 'a.mp4', local: '/t/a.mp4', isImage: false, hasAudio: true }]);
  const { graph, hasAudio } = buildFilterGraph(job, layout);
  assert.ok(!/a?split/.test(graph), '单引用不产出 split/asplit');
  assert.equal(hasAudio, true);
});

test('视频片段音频 + 音频轨片段同素材 → 同样走 asplit', () => {
  const job = {
    ...baseJob([clip('a.mp4', 0, 5)]),
    tracks: {
      video: [clip('a.mp4', 0, 5)],
      overlay: [], subtitle: [],
      audio: [clip('a.mp4', 5, 10)],
    },
  };
  const layout = baseLayout([{ key: 'a.mp4', local: '/t/a.mp4', isImage: false, hasAudio: true }]);
  const { graph } = buildFilterGraph(job, layout);
  assert.match(graph, /\[0:a\]asplit=2/, '视频轨音频+音频轨同素材也计两次引用');
  assert.ok(!/\[\d+:a\]split/.test(graph));
});
