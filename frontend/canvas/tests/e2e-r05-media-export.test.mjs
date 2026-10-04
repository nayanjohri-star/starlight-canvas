// R05 媒体验证层：界面所声明的每种导出能力都用真实可解码媒体验证。
//  · 本机 FFmpeg 渲染（MP4）× 时间线导出面板列出的全部 4 个预设：H.264 + AAC、尺寸与预设一致、
//    时长与时间线一致（±0.3s）、ffmpeg 全量解码无错误；
//  · 浏览器 MediaRecorder 导出（WebM）：可解码、尺寸正确；
//  · 导出失败路径：源素材缺失时默认阻断并说明，不静默省略。
// 素材：仓库夹具 + 测试时用 FFmpeg lavfi 生成的 3 秒 1280×720 片段（本地、可复现、无下载）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { chromium, createCanvasServer, ROOT, CHROME, BROWSER_OK, FFMPEG_OK, MP4, WAV, makeState, mockUpstream } from './e2e-helpers.mjs';
import { TL_SIZES } from '../src/export-project.js';

const probe = file => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `ffprobe 失败：${r.stderr}`);
  return JSON.parse(r.stdout);
};
// vfr：MediaRecorder 产物按墙钟打时间戳（可变帧率）。默认 null 输出会按推断帧率重新量化时间戳，
// 相邻帧间隔略小于 1/fps 时会在输出端撞同一刻度而报错——那是检查命令自身的取整，不是文件缺陷。
// 可变帧率文件改为按源时间基逐帧解码（仍能发现截断与码流损坏），并另行断言帧时间戳严格递增。
const decodesCleanly = (file, { vfr = false } = {}) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, ...(vfr ? ['-fps_mode', 'passthrough', '-enc_time_base', 'demux'] : []), '-f', 'null', '-'], { encoding: 'utf8' });
  return { ok: r.status === 0 && !r.stderr.trim(), stderr: r.stderr };
};

test('R05 媒体：4 个导出预设的本机 MP4 + 浏览器 WebM 均产出可解码、尺寸与时长正确的视频；缺素材阻断', { timeout: 420000, skip: (!BROWSER_OK || !FFMPEG_OK) && '需要浏览器与 FFmpeg（严格门禁中缺失即失败）' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'r05-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 3 秒 1280×720 测试片段（testsrc2 + 440Hz 正弦音）
  const gen = join(dir, 'gen.mp4');
  const g = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', gen], { encoding: 'utf8' });
  assert.equal(g.status, 0, `生成测试片段失败：${g.stderr}`);
  const genBytes = [...await readFile(gen)];

  const server = createCanvasServer({ staticDir: process.env.CANVAS_TEST_DIST || join(ROOT, 'dist'), directorDir: join(ROOT, 'tests', 'no-director-assets'), upstreamFetch: mockUpstream(makeState()) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close().catch(() => {}));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.timeline && window.__xp?.store?.project);

  // 时间线：3 秒生成片段 + 1 秒夹具片段（视频轨），0.5 秒 WAV（音轨）
  const timelineSeconds = await page.evaluate(async ([gb, mp4, wav]) => {
    const x = window.__xp;
    const reg = async (b, name, mime, kind) => (await x.assets.registerBlob(new Blob([new Uint8Array(b)], { type: mime }), name, kind)).id;
    const a1 = await reg(gb, 'gen.mp4', 'video/mp4', 'video');
    const a2 = await reg(mp4, 'fixture.mp4', 'video/mp4', 'video');
    const a3 = await reg(wav, 'fixture.wav', 'audio/wav', 'audio');
    for (const id of [a1, a2, a3]) { const c = await x.timeline.addAsset(id); if (!c) throw new Error('入轨失败 ' + id); }
    return Math.max(...x.timeline.clips().map(c => c.end));
  }, [genBytes, MP4, WAV]);
  assert.ok(Math.abs(timelineSeconds - 4) < 0.05, `时间线应约 4 秒，实际 ${timelineSeconds}`);

  const exportOnce = async (via, size, format) => page.evaluate(async ([via, size, format]) => {
    const x = window.__xp;
    const m = x.store.project.studio.timelineMeta;
    m.width = size.width; m.height = size.height;
    const r = await x.timeline.renderExport({ via, silent: true, ...(format ? { format } : {}) });
    return { bytes: [...new Uint8Array(await r.blob.arrayBuffer())], mime: r.mime, via: r.via, seconds: r.seconds };
  }, [via, size, format]);

  // 本机 MP4：面板列出的全部预设
  const results = [];
  for (const size of TL_SIZES) {
    const r = await exportOnce('server', size);
    assert.equal(r.via, 'server'); assert.equal(r.mime, 'video/mp4');
    const file = join(dir, `server-${size.id}.mp4`);
    await writeFile(file, Buffer.from(r.bytes));
    const info = probe(file);
    const v = info.streams.find(s => s.codec_type === 'video'), a = info.streams.find(s => s.codec_type === 'audio');
    assert.equal(v?.codec_name, 'h264', `${size.id} 视频编码`);
    assert.equal(a?.codec_name, 'aac', `${size.id} 音频编码`);
    assert.deepEqual([v.width, v.height], [size.width, size.height], `${size.id} 尺寸与预设一致`);
    const dur = Number(info.format.duration);
    assert.ok(Math.abs(dur - timelineSeconds) <= 0.3, `${size.id} 时长 ${dur} 应≈${timelineSeconds}`);
    const dec = decodesCleanly(file);
    assert.ok(dec.ok, `${size.id} 解码有错误：${dec.stderr.slice(0, 300)}`);
    results.push({ preset: size.id, width: v.width, height: v.height, duration: dur, bytes: r.bytes.length });
  }
  t.diagnostic(`MEDIA_SERVER ${JSON.stringify(results)}`);

  // 浏览器 WebM（本机渲染不可用时的回退路径），取第一个预设
  const b = await exportOnce('browser', TL_SIZES[0], 'webm');
  assert.equal(b.via ?? 'browser', 'browser');
  const wfile = join(dir, 'browser.webm');
  await writeFile(wfile, Buffer.from(b.bytes));
  const winfo = probe(wfile);
  const wv = winfo.streams.find(s => s.codec_type === 'video');
  assert.ok(['vp8', 'vp9'].includes(wv?.codec_name), `浏览器导出编码 ${wv?.codec_name}`);
  assert.deepEqual([wv.width, wv.height], [TL_SIZES[0].width, TL_SIZES[0].height]);
  const wdec = decodesCleanly(wfile, { vfr: true });
  assert.ok(wdec.ok, `浏览器导出解码有错误：${wdec.stderr.slice(0, 300)}`);
  // 逐帧时间戳严格递增；按目标帧率出帧（平均间隔接近 1/fps，且没有过密的突发帧）
  const fr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', wfile], { encoding: 'utf8' });
  const pts = fr.stdout.trim().split(/\r?\n/).map(x => Number(x.replace(/,/g, ''))).filter(Number.isFinite);
  assert.ok(pts.length > 30, `浏览器导出帧数过少：${pts.length}`);
  const gaps = pts.slice(1).map((p, i) => p - pts[i]);
  assert.ok(gaps.every(g => g > 0), '浏览器导出帧时间戳必须严格递增');
  const fps = 30, avg = (pts.at(-1) - pts[0]) / gaps.length;
  assert.ok(avg >= 0.8 / fps && avg <= 1.6 / fps, `平均帧间隔 ${avg.toFixed(4)}s 应接近 1/${fps}`);
  assert.ok(Math.min(...gaps) >= 0.5 / fps, `存在过密的突发帧（最小间隔 ${Math.min(...gaps).toFixed(4)}s）`);
  // MediaRecorder WebM may omit the container duration. Its packet timestamps
  // still establish actual duration, including audio-device startup latency.
  const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', wfile], { encoding: 'utf8' });
  assert.equal(pr.status, 0, '浏览器导出包时间戳必须可读');
  const packets = JSON.parse(pr.stdout).packets;
  const recordedEnd = Math.max(...packets.map(p => Number(p.pts_time) + Number(p.duration_time ?? 0)));
  assert.ok(Number.isFinite(recordedEnd) && Math.abs(recordedEnd - timelineSeconds) <= 0.3, `浏览器实际时长 ${recordedEnd} 应≈${timelineSeconds}`);
  t.diagnostic(`MEDIA_BROWSER ${JSON.stringify({ codec: wv.codec_name, width: wv.width, height: wv.height, bytes: b.bytes.length })}`);

  // A one-second clip exposes audio-device startup extending an otherwise
  // valid, decodable recording. Keep its real duration; do not pad the source.
  await page.evaluate(() => {
    const x = window.__xp, clip = x.timeline.clips().find(c => c.kind === 'video' && c.start > 0);
    if (!clip) throw new Error('短片夹具缺失');
    x.store.project.studio.timeline = [{ ...clip, start: 0, end: clip.end - clip.start }];
  });
  const short = await exportOnce('browser', TL_SIZES[0], 'webm');
  assert.ok(Math.abs(short.seconds - 1) < 0.05, '保留一秒素材真实时长');
  const shortFile = join(dir, 'browser-short.webm');
  await writeFile(shortFile, Buffer.from(short.bytes));
  const shortProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', shortFile], { encoding: 'utf8' });
  assert.equal(shortProbe.status, 0);
  const shortEnd = Math.max(...JSON.parse(shortProbe.stdout).packets.map(p => Number(p.pts_time) + Number(p.duration_time ?? 0)));
  assert.ok(Number.isFinite(shortEnd) && Math.abs(shortEnd - short.seconds) <= 0.3, `短片实际时长 ${shortEnd} 应≈${short.seconds}`);
  assert.ok(decodesCleanly(shortFile, { vfr: true }).ok, '短片可完整解码');
  t.diagnostic(`MEDIA_BROWSER_SHORT ${JSON.stringify({ expected: short.seconds, actual: shortEnd })}`);

  // 导出失败路径：源素材被标记缺失 → 默认阻断并列出，不静默省略
  const failure = await page.evaluate(async () => {
    const x = window.__xp;
    const first = x.timeline.clips()[0];
    x.store.project.assets[first.assetId].missing = true;
    try { await x.timeline.renderExport({ via: 'server', silent: true }); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  assert.equal(failure.ok, false, '缺素材的导出必须失败');
  assert.match(failure.message, /无法渲染|缺失/);
  assert.deepEqual(errors, []);
});
