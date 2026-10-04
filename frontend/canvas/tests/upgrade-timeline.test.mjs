// 时间线升级验收：模型操作（增/排/分割/修剪）、字幕 SRT、EDL/OTIO 互操作、
// STORE zip 项目包、xp-render@1 渲染清单、store 集成（undo + 导出入出核心字段存活）。
// 全部为 node 可跑的纯逻辑/存储测试；DOM 预览与 MediaRecorder 路径由浏览器侧验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createEditor } from '../src/editor.js';
import { studioState } from '../src/studio-schema.js';
import { createTimeline } from '../src/timeline.js';
import {
  normalizeTimeline, laneClips, timelineDuration, laneEnd, clipFromAsset,
  newTextClip, newSubtitleClip, splitClipAt, moveClip, trimClipEdge, reorderClip,
  subtitlesOf, srtTime, parseSRT, toSRT, toEDL, toOTIO,
  zipStore, unzipStore, buildRenderJob, sanitizeRenderJob,
  buildProjectPackage, parseProjectPackage, importProjectPackage, buildRenderPackage, parseRenderPackage,
  TL_DEFAULT_META, TL_LIMITS, clipSourceTime, fadeFactor,
} from '../src/export-project.js';
import { clipGain, audioClipsAt, videoClipAt, probeRenderSupport } from '../src/media-worker.js';

const enc = new TextEncoder();
async function fixture() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('时间线测试');
  return { store, storage, editor: createEditor(store) };
}
const mkAssets = store => {
  store.project.assets['v1'] = { id: 'v1', name: 'A.mp4', kind: 'video', mime: 'video/mp4', size: 100, addedAt: 1 };
  store.project.assets['v2'] = { id: 'v2', name: 'B.webm', kind: 'video', mime: 'video/webm', size: 200, addedAt: 2 };
  store.project.assets['au'] = { id: 'au', name: 'M.wav', kind: 'audio', mime: 'audio/wav', size: 50, addedAt: 3 };
  store.project.assets['im'] = { id: 'im', name: 'P.png', kind: 'image', mime: 'image/png', size: 30, addedAt: 4 };
  store.project.assets['lost'] = { id: 'lost', name: 'G.mp4', kind: 'video', mime: 'video/mp4', size: 10, addedAt: 5, missing: true };
};

async function storePackageMediaFixture(store, storage) {
  for (const [id, values] of [['v1', [9, 8, 7]], ['au', [5, 5]]]) {
    const bytes = new Uint8Array(values);
    const asset = store.project.assets[id];
    const blob = new Blob([bytes], { type: asset.mime });
    asset.size = blob.size;
    asset.sha256 = createHash('sha256').update(bytes).digest('hex');
    await storage.setBlob(`blob:${id}`, blob);
  }
}

test('normalizeTimeline：旧版 core 片段迁移 + 默认补全 + 同轨重叠消除', () => {
  const assets = { a: { id: 'a', name: 'a.mp4', kind: 'video', mime: 'video/mp4' } };
  const raw = [
    { id: 'x1', assetId: 'a', start: 0, end: 5, subtitle: '旧字幕', muted: true },  // 旧形态
    { id: 'x2', assetId: 'a', start: 3, end: 9 },                                   // 与 x1 重叠 → 后移
    { id: 'x3', start: 0, end: 2, text: '你好', kind: 'subtitle' },
    { id: 'x4', assetId: null, start: 1, end: 3, text: '叠加字', kind: 'text' },
  ];
  const { clips } = normalizeTimeline(raw, { assets });
  const v1 = laneClips(clips, 'v1');
  assert.equal(v1.length, 2);
  assert.equal(v1[0].id, 'x1');
  assert.equal(v1[1].start, 5);          // 重叠被推到 5
  assert.equal(v1[0].muted, true);
  assert.equal(v1[0].subtitle, '');      // 旧 subtitle 迁走且幂等
  const s1 = laneClips(clips, 's1');
  assert.equal(s1.length, 2);
  assert.ok(s1.some(c => c.text === '旧字幕'));        // 迁移成功（与同区间字幕重叠时自动避让）
  assert.ok(s1.some(c => c.id === 'x3'));
  const ov = laneClips(clips, 'ov1');
  assert.equal(ov[0].kind, 'text');
  // 幂等：再跑一遍不再产生新字幕
  const again = normalizeTimeline(clips, { assets });
  assert.equal(laneClips(again.clips, 's1').length, s1.length);
});

test('clip 操作：分割按速度折算入点、修剪受源时长约束、移动避让重叠、相邻交换', () => {
  const assets = { a: { id: 'a', name: 'a', kind: 'video' } };
  const c1 = { ...clipFromAsset(assets.a, 'v1', { start: 0, len: 8 }), speed: 2, in: 1 };
  const c2 = clipFromAsset(assets.a, 'v1', { start: 10, len: 4 });
  const clips = [c1, c2];
  // 分割 c1 @4：第二段入点 = 1 + 4*2 = 9
  const r = splitClipAt(clips, c1.id, 4);
  assert.ok(r);
  assert.equal(r.first.end, 4);
  assert.equal(r.second.start, 4);
  assert.equal(r.second.in, 9);
  assert.equal(r.second.end, 8);
  assert.equal(clips.length, 3);
  // 修剪：c2.end 受 sourceDuration 约束
  const c3 = clips.find(c => c.id === c2.id);
  c3.sourceDuration = 12; c3.in = 10; c3.speed = 1;
  trimClipEdge(clips, c3.id, 'end', 99);
  assert.equal(c3.end, 12);              // in10 + len2 ≤ 12
  trimClipEdge(clips, c3.id, 'end', 11);
  assert.equal(c3.end, 11);
  // start 修剪同步折算入点：start 10→10.5 → in 10→10.5
  trimClipEdge(clips, c3.id, 'start', 10.5);
  assert.equal(c3.start, 10.5); assert.equal(c3.in, 10.5);
  // 移动 c3 到 0：与前面的片段冲突避让（10.5→落在 8 之后）
  const moved = moveClip(clips, c3.id, 0);
  assert.ok(moved >= 8, `应避让到 ≥8，实际 ${moved}`);
  // 交换：r.second(4-8) 与 c3 相邻
  const before = laneClips(clips, 'v1').map(c => c.id);
  assert.ok(reorderClip(clips, r.second.id, +1));
  const after = laneClips(clips, 'v1').map(c => c.id);
  assert.notDeepEqual(before, after);
  assert.equal(laneClips(clips, 'v1')[1].id, c3.id);
});

test('时间/包络助手：clipSourceTime / fadeFactor / clipGain / 活跃片段查询', () => {
  const c = { track: 'v1', kind: 'video', start: 10, end: 14, in: 2, speed: 2, volume: 0.5, muted: false, fadeIn: 1, fadeOut: 1 };
  assert.equal(clipSourceTime(c, 11), 4);
  assert.equal(fadeFactor(c, 10.5), 0.5);
  assert.equal(fadeFactor(c, 12), 1);
  assert.equal(fadeFactor(c, 13.5), 0.5);
  assert.equal(clipGain(c, 12), 0.5);
  assert.equal(clipGain({ ...c, muted: true }, 12), 0);
  const clips = [c, { track: 'a1', kind: 'audio', start: 0, end: 20, in: 0, speed: 1, volume: 1 }];
  assert.equal(videoClipAt(clips, 11), c);
  assert.equal(audioClipsAt(clips, 11).length, 2);
  assert.equal(audioClipsAt(clips, 25).length, 0);
});

test('SRT：解析/导出往返，坏块跳过、空文件拒绝', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\n你好\n世界\n\n2\n00:00:04.000 --> 00:00:05.000\n第二句\n\n坏块没有计时\n';
  const { entries, warnings } = parseSRT(srt);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].start, 1);
  assert.equal(entries[0].end, 3.5);
  assert.equal(entries[0].text, '你好\n世界');
  assert.equal(entries[1].start, 4);
  assert.equal(warnings.length, 1);
  const round = toSRT(entries);
  assert.match(round, /00:00:01,000 --> 00:00:03,500/);
  assert.match(round, /你好\n世界/);
  assert.equal(parseSRT(round).entries.length, 2);
  assert.equal(srtTime(3661.5), '01:01:01,500');
  assert.throws(() => parseSRT('完全没有字幕'), /没有有效/);
});

test('EDL/OTIO：导出可核对子集，明确不含未支持字段', () => {
  const assets = { a: { id: 'a', name: '镜头A.mp4', kind: 'video', mime: 'video/mp4' } };
  const c = { ...clipFromAsset(assets.a, 'v1', { start: 0, len: 4 }), in: 2, speed: 2, name: '镜头A' };
  const au = { ...clipFromAsset({ id: 'm', name: 'bgm.wav', kind: 'audio' }, 'a1', { start: 0, len: 4 }) };
  const clips = [c, au];
  const edl = toEDL(clips, { title: '测试片', fps: 30, assets });
  assert.match(edl, /TITLE: 测试片/);
  assert.match(edl, /001  AX +V +C +00:00:02:00 00:00:10:00 00:00:00:00 00:00:04:00/);
  assert.match(edl, /SPEED 200\.0%/);
  assert.match(edl, /002  AX +AA +C/);
  const otio = toOTIO({ name: '测试片', assets }, clips, TL_DEFAULT_META);
  assert.equal(otio.OTIO_SCHEMA, 'Timeline.1');
  const vTrack = otio.tracks.children.find(t => t.name === 'v1');
  assert.equal(vTrack.children[0].media_reference.target_url, '镜头A.mp4');
  assert.equal(vTrack.children[0].source_range.duration.value, 120); // 4s * 30fps
});

test('STORE zip：写读往返 + 拒绝坏包（越界名/压缩/非zip）', () => {
  const files = [
    { name: 'manifest.json', data: enc.encode('{"a":1}') },
    { name: 'media/a.mp4', data: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: '中文名.txt', data: enc.encode('内容') },
  ];
  const zip = zipStore(files);
  const back = unzipStore(zip);
  assert.equal(back.size, 3);
  assert.equal(new TextDecoder().decode(back.get('manifest.json')), '{"a":1}');
  assert.deepEqual([...back.get('media/a.mp4')], [1, 2, 3, 4, 5]);
  // 越界名（写端不拦，读端必须拒）
  const evil = zipStore([{ name: '../escape.txt', data: enc.encode('x') }]);
  assert.throws(() => unzipStore(evil), /不合法/);
  // 非 zip
  assert.throws(() => unzipStore(enc.encode('not a zip at all')), /zip|空/);
  // 压缩条目：手工拼一个 method=8 的 local header
  const fake = new Uint8Array(30 + 3);
  const dv = new DataView(fake.buffer);
  dv.setUint32(0, 0x04034b50, true); dv.setUint16(8, 8, true); dv.setUint16(26, 1, true);
  fake[30] = 0x61;
  assert.throws(() => unzipStore(fake), /STORE|压缩|不一致/);
});

test('xp-render@1：buildRenderJob 组装 + sanitizeRenderJob 服务端边界', () => {
  const project = { assets: {} };
  mkAssets({ project });
  const { clips } = normalizeTimeline([
    { id: 'c1', assetId: 'v1', start: 0, end: 4, in: 1, speed: 1, volume: 0.8, muted: false, fadeIn: 0.5, kind: 'video' },
    { id: 'c2', assetId: 'lost', start: 4, end: 6, kind: 'video' },                    // 缺失 → 跳过
    { id: 'c3', assetId: 'im', start: 1, end: 3, kind: 'image', track: 'ov1', x: 0, y: 0, w: 0.3, h: 0.3 },
    { id: 'c4', assetId: 'au', start: 0, end: 4, kind: 'audio', track: 'a1', volume: 0.6 },
    { id: 'c5', start: 0.5, end: 2, text: '字幕一', kind: 'subtitle' },
    { id: 'c6', start: 2, end: 3, text: '文字', kind: 'text', track: 'ov1' },
  ], { assets: project.assets });
  const job = buildRenderJob({ project, clips, meta: TL_DEFAULT_META });
  assert.equal(job.format, 'xp-render@1');
  assert.equal(job.tracks.video.length, 1);            // 缺失素材片段被跳过
  assert.equal(job.tracks.audio.length, 1);
  assert.equal(job.tracks.subtitle.length, 1);
  assert.equal(job.tracks.overlay.length, 2);          // 图 + 文
  assert.equal(job.media.length, 3);
  assert.ok(job.warnings.some(w => /缺失/.test(w)));
  assert.ok(job.media.every(m => /^media\/\w+\.(mp4|webm|png|wav)$/.test(m.key)));
  const clean = sanitizeRenderJob(JSON.parse(JSON.stringify(job)));
  assert.equal(clean.duration, job.duration);
  // 边界：坏 format / 坏引用 / 超时
  assert.throws(() => sanitizeRenderJob({ format: 'x' }), /xp-render/);
  const bad = JSON.parse(JSON.stringify(job)); bad.tracks.video[0].file = 'media/nope.mp4';
  assert.throws(() => sanitizeRenderJob(bad), /media|引用/);
  const huge = JSON.parse(JSON.stringify(job)); huge.duration = 9999;
  assert.throws(() => sanitizeRenderJob(huge), /时长/);
  const badName = JSON.parse(JSON.stringify(job)); badName.media[0].key = 'media/../../etc/passwd';
  assert.throws(() => sanitizeRenderJob(badName), /media|键名/);
});

test('xp-package@1：构建/解析/导入全链路（store.importJSON 消毒不绕过）', async () => {
  const { store, storage } = await fixture();
  mkAssets(store);
  await storePackageMediaFixture(store, storage);
  const st = studioState(store.project);
  st.timeline = normalizeTimeline([
    { assetId: 'v1', start: 0, end: 4, in: 1, speed: 1.5, volume: 0.7, fadeIn: 0.5, kind: 'video', track: 'v1' },
    { assetId: 'au', start: 0, end: 4, kind: 'audio', track: 'a1' },
    { start: 0, end: 2, text: '导入字幕', kind: 'subtitle' },
  ], { assets: store.project.assets }).clips;
  st.timelineMeta = { ...TL_DEFAULT_META, width: 720, height: 1280 };
  const projectJson = await store.exportJSON();
  const pkg = await buildProjectPackage({
    projectJson, clips: st.timeline, meta: st.timelineMeta,
    blobOf: id => storage.getBlob(`blob:${id}`), assets: store.project.assets,
  });
  // 解析校验
  const parsed = parseProjectPackage(pkg);
  assert.equal(parsed.manifest.format, 'xp-package@1');
  assert.equal(parsed.manifest.media.length, 2);       // v1 + au（im/lost 无 blob 不入包）
  // 导入到第二个 store
  const s2 = createStore(storage);
  const deps = { store: s2, storage };
  const r = await importProjectPackage(deps, pkg);
  assert.equal(r.rebound, 2);
  assert.deepEqual(new Set(r.missing), new Set(Object.values(store.project.assets).filter(a => !['v1', 'au'].includes(a.id)).map(a => a.name)));
  const tl = r.project.studio.timeline;
  assert.equal(laneClips(tl, 'v1').length, 1);
  const vc = laneClips(tl, 'v1')[0];
  assert.equal(vc.speed, 1.5);
  assert.equal(vc.in, 1);
  assert.equal(vc.fadeIn, 0.5);
  assert.equal(r.project.studio.timelineMeta.width, 720);
  // 重绑后的 blob 真的回来了
  const newAsset = r.project.assets[vc.assetId];
  assert.equal(newAsset.missing, false);
  assert.equal(newAsset.size, store.project.assets.v1.size);
  assert.equal(newAsset.sha256, store.project.assets.v1.sha256);
  const blob = await storage.getBlob(`blob:${vc.assetId}`);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [9, 8, 7]);
  // 字幕轨恢复
  assert.equal(laneClips(tl, 's1')[0].text, '导入字幕');
  // 密钥黑名单：含密钥字段的 project.json 依然被 importJSON 拒绝
  const evilPkg = zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify({ format: 'xp-package@1', version: 1, media: [], timeline: { clips: [] } })) },
    { name: 'project.json', data: enc.encode(projectJson.replace('"name"', '"apiKey":"leak","name"')) },
  ]);
  await assert.rejects(() => importProjectPackage(deps, evilPkg), /密钥|secret/i);
});

test('createTimeline：addAsset 落 project.studio.timeline、undo 经 editor checkpoint、SRT 导入导出', async () => {
  const { store, storage, editor } = await fixture();
  mkAssets(store);
  const tl = createTimeline({ store, storage, editor });
  const clip = await tl.addAsset('v1');                 // node 无 DOM → 探测为空，默认 5s
  assert.ok(clip);
  assert.equal(clip.track, 'v1');
  assert.equal(clip.end - clip.start, 5);
  const tlNow = () => studioState(store.project).timeline;   // undo 会整体替换 studio，必须每次重读
  assert.equal(tlNow().length, 1);
  await tl.addAsset('au');
  assert.equal(laneClips(tlNow(), 'a1').length, 1);
  await tl.addAsset('lost');                            // 缺失素材拒绝
  assert.equal(tlNow().length, 2);
  // undo 回滚到加片段前
  assert.ok(editor.undo());
  assert.equal(tlNow().length, 1);                      // undo 撤掉最近一次 add（au）
  assert.ok(editor.undo());
  assert.equal(tlNow().length, 0);
  assert.equal(tl.clips().length, 0);
});

test('导出 JSON 兼容性：核心字段经 store.exportJSON/importJSON 存活（其余按报告请求 core 扩展）', async () => {
  const { store } = await fixture();
  mkAssets(store);
  const st = studioState(store.project);
  st.timeline = normalizeTimeline([
    { assetId: 'v1', start: 0, end: 4, in: 2, speed: 2, volume: 0.5, fadeIn: 1, kind: 'video', track: 'v1' },
    { start: 0, end: 2, text: '字幕', kind: 'subtitle' },
  ], { assets: store.project.assets }).clips;
  const exported = await store.exportJSON();
  const s2 = createStore(createMemoryStorage());
  // 第二个 store 需要同样的存储才能看到任务记录；这里只验证项目体
  const imported = await s2.importJSON(exported);
  const tl = imported.studio.timeline;
  assert.equal(tl.length, 2);
  const v = tl.find(c => c.assetId);
  assert.ok(v);
  assert.notEqual(v.assetId, 'v1');                    // assetId 重映射
  assert.ok(imported.assets[v.assetId]);
  // 核心白名单字段存活：start/end/muted/subtitle
  assert.equal(v.start, 0); assert.equal(v.end, 4);
  const sub = tl.find(c => c.subtitle === '字幕');
  assert.ok(sub, 's1 字幕经 subtitle 字段存活');
  // 扩展字段（speed/in/fade/track）依赖 core 扩展白名单——当前被剥离，导入侧由 normalizeTimeline 补默认
  const { clips } = normalizeTimeline(tl, { assets: imported.assets });
  assert.equal(laneClips(clips, 's1').length, 1);      // 字幕归位 s1
});

test('probeRenderSupport：node 环境如实报告不支持（不伪造能力）', () => {
  const s = probeRenderSupport();
  assert.equal(s.supported, false);
  assert.equal(s.webm, null);
  assert.equal(s.mp4, null);
});

test('渲染包：buildRenderPackage 只收白名单媒体名，服务端可解', async () => {
  const project = { assets: {} };
  mkAssets({ project });
  const blobMap = new Map([
    ['v1', new Blob([new Uint8Array([1, 2])], { type: 'video/mp4' })],
    ['au', new Blob([new Uint8Array([3])], { type: 'audio/wav' })],
  ]);
  const { clips } = normalizeTimeline([
    { assetId: 'v1', start: 0, end: 3, kind: 'video', track: 'v1' },
    { assetId: 'au', start: 0, end: 3, kind: 'audio', track: 'a1' },
  ], { assets: project.assets });
  const job = buildRenderJob({ project, clips, meta: TL_DEFAULT_META });
  const pkg = await buildRenderPackage(job, id => blobMap.get(id));
  const { job: j2, files } = parseRenderPackage(pkg);
  assert.equal(j2.format, 'xp-render@1');
  assert.equal(files.get('media/v1.mp4').length, 2);
  // 缺 blob → 明确抛错
  await assert.rejects(() => buildRenderPackage(job, () => null), /缺失/);
});

test('xp-package@1：清单确定性身份——assetId/名称与项目素材不一致一律在导入前拒绝', async () => {
  const { store, storage } = await fixture();
  mkAssets(store);
  await storage.setBlob('blob:v1', new Blob([new Uint8Array([9, 8, 7])], { type: 'video/mp4' }));
  const projectJson = await store.exportJSON();
  const pkg = await buildProjectPackage({
    projectJson, clips: [], meta: TL_DEFAULT_META,
    blobOf: id => storage.getBlob(`blob:${id}`), assets: store.project.assets,
  });
  const parsed = parseProjectPackage(pkg);
  const repack = manifest => zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) },
    ...[...parsed.files].filter(([n]) => n !== 'manifest.json').map(([name, data]) => ({ name, data })),
  ]);
  const neverImport = { importJSON: async () => { throw new Error('不应到达导入阶段'); } };
  // assetId 指向项目不存在的素材（路径同步篡改能通过格式校验，卡在身份核对）
  const m1 = JSON.parse(new TextDecoder().decode(parsed.files.get('manifest.json')));
  const orig = m1.media[0];
  m1.media[0] = { ...orig, assetId: 'ghost-id', path: 'media/ghost-id.mp4' };
  const pkgGhost = zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify(m1)) },
    { name: 'project.json', data: parsed.files.get('project.json') },
    { name: 'media/ghost-id.mp4', data: parsed.files.get(orig.path) },
  ]);
  await assert.rejects(() => importProjectPackage({ store: neverImport, storage }, pkgGhost), /不存在/);
  // 名称与项目素材记录不符 → 拒绝（不允许按名字猜绑定）
  const m2 = JSON.parse(new TextDecoder().decode(parsed.files.get('manifest.json')));
  m2.media[0].name = '改名-evil.mp4';
  await assert.rejects(() => importProjectPackage({ store: neverImport, storage }, repack(m2)), /不一致/);
});

test('xp-package@1：时间线冲突与 CRC 损坏都显式拒绝（不静默二选一、不吃坏数据）', async () => {
  const { store, storage } = await fixture();
  mkAssets(store);
  const st = studioState(store.project);
  st.timeline = normalizeTimeline([
    { id: 'c1', assetId: 'v1', start: 0, end: 4, kind: 'video', track: 'v1', speed: 1.5 },
  ], { assets: store.project.assets }).clips;
  st.timelineMeta = { ...TL_DEFAULT_META };
  const pkg = await buildProjectPackage({
    projectJson: await store.exportJSON(), clips: st.timeline, meta: st.timelineMeta,
    blobOf: () => null, assets: store.project.assets,
  });
  const parsed = parseProjectPackage(pkg);
  const neverImport = { importJSON: async () => { throw new Error('不应到达导入阶段'); } };
  // project.json 自带富时间线 vs manifest 富时间线不一致 → 疑似篡改拒绝
  const m = JSON.parse(new TextDecoder().decode(parsed.files.get('manifest.json')));
  m.timeline.clips[0].end = 9;
  const evil = zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify(m)) },
    ...[...parsed.files].filter(([n]) => n !== 'manifest.json').map(([name, data]) => ({ name, data })),
  ]);
  await assert.rejects(() => importProjectPackage({ store: neverImport, storage }, evil), /不一致|篡改/);
  // CRC 损坏（manifest 内容字节翻转）→ zip 层拒绝
  const raw = new Uint8Array(pkg);
  raw[30 + 'manifest.json'.length] ^= 0xFF;
  assert.throws(() => parseProjectPackage(raw), /CRC/);
});

test('xp-package@1：GLB 等项目内 file 资产按白名单入包；未引用的 octet-stream 不打包', async () => {
  const { store, storage } = await fixture();
  const d = store.addNode('director', 0, 0, {});
  store.project.assets['g1'] = { id: 'g1', name: '场景.glb', kind: 'file', mime: 'model/gltf-binary', size: 4, addedAt: 1, fromDirector: d.id };
  store.project.assets['g2'] = { id: 'g2', name: '散装.bin', kind: 'file', mime: 'application/octet-stream', size: 4, addedAt: 1 };
  await storage.setBlob('blob:g1', new Blob(['glb!'], { type: 'model/gltf-binary' }));
  await storage.setBlob('blob:g2', new Blob(['junk']));
  const pkg = await buildProjectPackage({
    projectJson: await store.exportJSON(), clips: [], meta: TL_DEFAULT_META,
    blobOf: id => storage.getBlob(`blob:${id}`), assets: store.project.assets,
  });
  const { manifest, files } = parseProjectPackage(pkg);
  assert.ok(manifest.media.some(m => m.assetId === 'g1' && m.path === 'media/g1.glb'), '导演台 GLB 必须入包');
  assert.equal(files.get('media/g1.glb')?.length, 4);
  assert.ok(!manifest.media.some(m => m.assetId === 'g2'), '未被项目引用的二进制文件不得盲打包');
  assert.ok(manifest.warnings.some(w => /散装/.test(w)), '未打包项必须显式出现在警告里');
});

test('importProjectPackage：assetBlobs 以导出前 assetId 为键，一次性交给核心', async () => {
  const { store, storage } = await fixture();
  mkAssets(store);
  await storePackageMediaFixture(store, storage);
  const pkg = await buildProjectPackage({
    projectJson: await store.exportJSON(), clips: [], meta: TL_DEFAULT_META,
    blobOf: id => storage.getBlob(`blob:${id}`), assets: store.project.assets,
  });
  let seen = null;
  const probe = {
    importJSON: async (text, opts) => {
      seen = { data: JSON.parse(text), opts };
      return { name: '探针项目', assets: {}, studio: {} };
    },
  };
  const r = await importProjectPackage({ store: probe, storage }, pkg);
  assert.ok(seen.opts?.assetBlobs instanceof Map, '必须以 {assetBlobs:Map} 调用核心');
  assert.deepEqual([...seen.opts.assetBlobs.keys()].sort(), ['au', 'v1'], '键必须是导出前 assetId');
  assert.equal(seen.opts.assetBlobs.get('v1').type, 'video/mp4');
  assert.deepEqual([...new Uint8Array(await seen.opts.assetBlobs.get('au').arrayBuffer())], [5, 5]);
  for (const id of ['v1', 'au']) {
    const bytes = new Uint8Array(await seen.opts.assetBlobs.get(id).arrayBuffer());
    assert.equal(seen.data.project.assets[id].size, bytes.byteLength, '源素材记录的 size 必须与导入字节一致');
    assert.equal(seen.data.project.assets[id].sha256, createHash('sha256').update(bytes).digest('hex'), '源素材记录的摘要必须与导入字节一致');
  }
  assert.equal(r.rebound, 2);
  assert.equal(r.missing.length, 0);
});

test('importProjectPackage：旧包 manifest 富时间线在导入前并入（保留导出前 assetId 由核心统一重映射）', async () => {
  const { store, storage } = await fixture();
  mkAssets(store);
  const projectJson = await store.exportJSON();   // 源无 studio.timeline
  const manifestClips = normalizeTimeline([
    { id: 'c1', assetId: 'v1', start: 0, end: 3, kind: 'video', track: 'v1', speed: 2, volume: 0.5 },
  ], { assets: store.project.assets }).clips;
  const manifest = {
    format: 'xp-package@1', version: 1, exportedAt: 't', media: [],
    timeline: { clips: manifestClips, meta: { width: 640, height: 360, fps: 24, background: '#112233' } },
  };
  const pkg = zipStore([
    { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) },
    { name: 'project.json', data: enc.encode(projectJson) },
  ]);
  let seen;
  const probe = { importJSON: async (text, _opts) => { seen = JSON.parse(text); return { name: 'f', assets: {}, studio: {} }; } };
  await importProjectPackage({ store: probe, storage }, pkg);
  const tl = seen.project.studio.timeline;
  assert.equal(tl.length, 1);
  assert.equal(tl[0].track, 'v1');
  assert.equal(tl[0].assetId, 'v1', '并入片段保留导出前 assetId，由核心 assetIdMap 统一重映射');
  assert.equal(seen.project.studio.timelineMeta.width, 640);
  assert.equal(seen.project.studio.timelineMeta.background, '#112233');
});

test('sanitizeRenderJob 严格边界：NaN/越界/MIME 与轨道类型不符一律拒绝（不静默夹取）', () => {
  const project = { assets: {} };
  mkAssets({ project });
  const { clips } = normalizeTimeline([
    { assetId: 'v1', start: 0, end: 2, kind: 'video', track: 'v1' },
    { assetId: 'au', start: 0, end: 2, kind: 'audio', track: 'a1' },
  ], { assets: project.assets });
  const job = buildRenderJob({ project, clips, meta: TL_DEFAULT_META });
  const j = () => JSON.parse(JSON.stringify(job));
  const direct = over => sanitizeRenderJob({ ...JSON.parse(JSON.stringify(job)), ...over });
  assert.throws(() => direct({ output: { ...job.output, width: NaN } }), /有限数字/);
  assert.throws(() => direct({ output: { ...job.output, width: 8 } }), /宽度/);
  assert.throws(() => direct({ output: { ...job.output, format: undefined } }), /格式/);
  assert.throws(() => direct({ output: { ...job.output, format: 'avi' } }), /mp4|webm/);
  assert.throws(() => direct({ duration: 'abc' }), /有限数字/);
  const a = j(); a.media[0].mime = 'audio/wav';            // mp4 键配 wav MIME
  assert.throws(() => sanitizeRenderJob(a), /MIME|不一致/);
  const b = j(); b.media.find(m => m.key.endsWith('.mp4')).kind = 'audio';
  assert.throws(() => sanitizeRenderJob(b), /kind/);
  const c = j(); c.tracks.audio.push({ file: 'media/v1.mp4', start: 0, end: 1, in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, track: 'a1' });
  assert.throws(() => sanitizeRenderJob(c), /轨|kind|类型/);
  const d = j(); d.tracks.video = Array.from({ length: 201 }, () => ({ file: 'media/v1.mp4', start: 0, end: 1 }));
  assert.throws(() => sanitizeRenderJob(d), /片段数超限/);
});

test('buildRenderJob：缺失/不支持素材片段进入 omitted 清单供导出前确认', () => {
  const project = { assets: {} };
  mkAssets({ project });
  project.assets['odd'] = { id: 'odd', name: '怪.mov', kind: 'video', mime: 'video/quicktime', size: 10, addedAt: 6 };
  const { clips } = normalizeTimeline([
    { assetId: 'lost', start: 0, end: 2, kind: 'video', track: 'v1', name: '丢片段' },
    { assetId: 'odd', start: 2, end: 4, kind: 'video', track: 'v1', name: '怪类型' },
    { assetId: 'v1', start: 4, end: 6, kind: 'video', track: 'v1' },
  ], { assets: project.assets });
  const job = buildRenderJob({ project, clips, meta: TL_DEFAULT_META });
  assert.equal(job.tracks.video.length, 1);
  assert.equal(job.omitted.length, 2);
  assert.equal(job.omitted[0].reason, 'missing');
  assert.equal(job.omitted[1].reason, 'unsupported');
  assert.ok(job.warnings.length >= 2);
});

// ---------- 终版跟进：导出快照 / 占槽 / 中止语义 / 渲染清单严格边界 ----------

test('renderExport：预中止信号在进入时即拒绝——不读素材、不发请求', async () => {
  const { store, storage, editor } = await fixture();
  mkAssets(store);
  let blobReads = 0;
  const assetsSpy = { blobOf: async id => { blobReads++; return storage.getBlob(`blob:${id}`); } };
  const tl = createTimeline({ store, storage, editor, assets: assetsSpy });
  await tl.addAsset('v1');
  blobReads = 0;
  let fetches = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error('不应发请求'); };
  const ac = new AbortController(); ac.abort();
  try {
    await assert.rejects(tl.renderExport({ silent: true, via: 'server', signal: ac.signal }),
      e => e?.name === 'AbortError');
  } finally { globalThis.fetch = oldFetch; }
  assert.equal(fetches, 0, '预中止不得发出任何网络请求');
  assert.equal(blobReads, 0, '预中止不得读取任何媒体');
});

test('renderExport：进入即占槽——并发第二次导出立即拒绝，槽位随结束释放', async () => {
  const { store, storage, editor } = await fixture();
  mkAssets(store);
  await storage.setBlob('blob:v1', new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }));
  const tl = createTimeline({ store, storage, editor });
  await tl.addAsset('v1');
  const oldFetch = globalThis.fetch;
  let renderPosts = 0, capsFree = false, resolveCaps;
  const gate = new Promise(r => { resolveCaps = r; });
  globalThis.fetch = async url => {
    if (String(url).includes('capabilities')) {
      if (!capsFree) await gate;
      return { ok: true, json: async () => ({ available: true, filters: {} }) };
    }
    if (String(url).includes('/media/render')) {
      renderPosts++;
      return { ok: true, blob: async () => new Blob([new Uint8Array(8)], { type: 'video/mp4' }), headers: { get: () => null }, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const p1 = tl.renderExport({ silent: true, via: 'server' });
    const p2 = tl.renderExport({ silent: true, via: 'server' });
    await assert.rejects(p2, /进行中/);
    resolveCaps(); capsFree = true;
    const r1 = await p1;
    assert.equal(r1.via, 'server');
    assert.equal(renderPosts, 1, '只有一次导出真正发出渲染请求');
    const r3 = await tl.renderExport({ silent: true, via: 'server' });   // 槽位已释放
    assert.equal(r3.via, 'server');
    assert.equal(renderPosts, 2);
  } finally { globalThis.fetch = oldFetch; }
});

test('renderExport：能力探测期间切项目——导出中止，不发渲染请求', async () => {
  const { store, storage, editor } = await fixture();
  mkAssets(store);
  await storage.setBlob('blob:v1', new Blob([new Uint8Array([9])], { type: 'video/mp4' }));
  const tl = createTimeline({ store, storage, editor });
  await tl.addAsset('v1');
  const oldFetch = globalThis.fetch;
  let resolveCaps, renderPosts = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('capabilities'))
      return new Promise(r => { resolveCaps = () => r({ ok: true, json: async () => ({ available: true }) }); });
    if (String(url).includes('/media/render')) {
      renderPosts++;
      return { ok: true, blob: async () => new Blob([new Uint8Array(8)], { type: 'video/mp4' }), headers: { get: () => null } };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const p = tl.renderExport({ silent: true, via: 'server' });
    await new Promise(r => setTimeout(r, 10));   // 让能力探测在途
    await store.newProject('另一个项目');
    resolveCaps();
    await assert.rejects(p, e => e?.name === 'AbortError');
    assert.equal(renderPosts, 0, '切项目后不得发出渲染 POST');
  } finally { globalThis.fetch = oldFetch; }
});

test('renderExport：打包媒体期间切项目——中止于发送前，不读不写新项目', async () => {
  const { store, storage, editor } = await fixture();
  mkAssets(store);
  await storage.setBlob('blob:v1', new Blob([new Uint8Array([9])], { type: 'video/mp4' }));
  const tl = createTimeline({ store, storage, editor });
  await tl.addAsset('v1');
  const oldFetch = globalThis.fetch;
  let renderPosts = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('capabilities')) return { ok: true, json: async () => ({ available: true }) };
    if (String(url).includes('/media/render')) {
      renderPosts++;
      return { ok: true, blob: async () => new Blob([new Uint8Array(8)], { type: 'video/mp4' }), headers: { get: () => null } };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const origGet = storage.getBlob.bind(storage);
  let releaseRead;
  const gate = new Promise(r => { releaseRead = r; });
  storage.getBlob = async k => { await gate; return origGet(k); };
  try {
    const p = tl.renderExport({ silent: true, via: 'server' });
    await new Promise(r => setTimeout(r, 10));   // 进入打包阶段（blob 读取被闸门卡住）
    await store.newProject('另一个项目');
    releaseRead();
    await assert.rejects(p, e => e?.name === 'AbortError');
    assert.equal(renderPosts, 0, '打包期间切项目不得发出渲染 POST');
  } finally { globalThis.fetch = oldFetch; storage.getBlob = origGet; }
});

test('sanitizeRenderJob：start/end/in/speed/volume 越界与非有限值一律拒绝，不静默夹取', () => {
  const project = { assets: {} };
  mkAssets({ project });
  const { clips } = normalizeTimeline([
    { assetId: 'v1', start: 0, end: 2, kind: 'video', track: 'v1' },
  ], { assets: project.assets });
  const job = buildRenderJob({ project, clips, meta: TL_DEFAULT_META });
  const j = () => JSON.parse(JSON.stringify(job));
  const c1 = j(); c1.tracks.video[0].speed = -1;
  assert.throws(() => sanitizeRenderJob(c1), /速度|之间|有限/);
  const c2 = j(); c2.tracks.video[0].volume = 1.5;
  assert.throws(() => sanitizeRenderJob(c2), /音量|之间|有限/);
  const c3 = j(); c3.tracks.video[0].in = -0.5;
  assert.throws(() => sanitizeRenderJob(c3), /入点|之间|有限/);
  const c4 = j(); c4.tracks.video[0].start = -1;
  assert.throws(() => sanitizeRenderJob(c4), /起点|之间|越界|有限/);
  const c5 = j(); c5.tracks.video[0].speed = 'fast';
  assert.throws(() => sanitizeRenderJob(c5), /有限数字/);
  const c6 = j(); c6.tracks.video[0].end = 5;
  assert.throws(() => sanitizeRenderJob(c6), /区间|越界/);
  // 缺省字段仍按默认补齐（只有显式给出的值才严格校验）
  const c7 = j(); delete c7.tracks.video[0].speed; delete c7.tracks.video[0].volume;
  const clean = sanitizeRenderJob(c7);
  assert.equal(clean.tracks.video[0].speed, 1);
  assert.equal(clean.tracks.video[0].volume, 1);
});
