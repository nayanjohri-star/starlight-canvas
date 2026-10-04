// 本机媒体服务验收：工具探测、filtergraph 构建、任务校验边界、请求处理、
// 以及（本机装有 FFmpeg 时）用 tests/fixtures 真实媒体跑一次端到端渲染并用 ffprobe 验证产物。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import {
  createMediaService, detectMediaTools, buildFilterGraph, MEDIA_LIMITS, MediaError,
} from './media-service.mjs';
import { zipStore } from '../src/export-project.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
const enc = new TextEncoder();

// ---------- 假 spawn：覆盖探测 + 渲染全流程（不落真 ffmpeg） ----------
function fakeSpawn({ renderOk = true } = {}) {
  const calls = [];
  const fn = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd });
    const tail = args.join(' ');
    if (/-version$/.test(tail)) return { code: 0, stdout: `${cmd} version 6.1.1-test`, stderr: '' };
    if (tail.includes('-encoders')) return { code: 0, stdout: ' V..... libx264\n A..... aac\n', stderr: '' };
    if (tail.includes('-filters')) return { code: 0, stdout: ' ..C subtitles\n ..C drawtext\n', stderr: '' };
    // 输出校验探针带 format=（同查流构成）：须同时给出 streams+format，符合真实 ffprobe 合同
    if (cmd.includes('ffprobe') && tail.includes('format='))
      return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 2 } }), stderr: '' };
    if (cmd.includes('ffprobe') && tail.includes('codec_type'))
      return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }), stderr: '' };
    if (cmd.includes('ffmpeg') && tail.includes('filter_complex_script')) {
      opts.onStdoutLine?.('out_time_ms=1000000\nprogress=end\n');
      if (!renderOk) return { code: 1, stdout: '', stderr: 'forced failure' };
      await writeFile(join(opts.cwd, 'out.mp4'), Buffer.from('FAKEMP4DATA'.repeat(64)));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { fn, calls };
}
const TOOLS = { available: true, ffmpegVersion: '6.1.1', ffprobeVersion: '6.1.1', canMp4: true, filters: { subtitles: true, drawtext: true }, encoders: { libx264: true, aac: true } };

function fakeReq(body, method = 'POST') {
  const r = Readable.from(body ? [body] : []);
  r.method = method;
  r.headers = {};
  return r;
}
// res 必须是真 Writable：render 成功路径走 createReadStream.pipe(res)
function fakeRes() {
  const state = { statusCode: 0, headers: {}, chunks: [] };
  const res = new Writable({ write(c, _e, cb) { state.chunks.push(Buffer.from(c)); cb(); } });
  res.writeHead = (s, h) => { state.statusCode = s; Object.assign(state.headers, h ?? {}); };
  res.state = state;
  res.bodyText = () => Buffer.concat(state.chunks).toString();
  res.bodyBytes = () => Buffer.concat(state.chunks);
  return res;
}

function sampleJob() {
  return {
    format: 'xp-render@1', version: 1,
    output: { width: 320, height: 180, fps: 30, format: 'mp4', background: '#000000' },
    duration: 2,
    tracks: {
      video: [{ file: 'media/a.mp4', start: 0, end: 2, in: 0, speed: 1, volume: 1, fadeIn: 0.2, fadeOut: 0.2 }],
      overlay: [{ kind: 'text', text: '你好', x: 0.1, y: 0.1, w: 0.8, h: 0.2, fontSize: 0.08, color: '#ffffff', align: 'center', start: 0.5, end: 1.5, fadeIn: 0, fadeOut: 0 }],
      audio: [{ file: 'media/m.wav', start: 0, end: 2, in: 0, speed: 1, volume: 0.8, fadeIn: 0, fadeOut: 0.5, track: 'a1' }],
      subtitle: [{ start: 0.2, end: 1.8, text: '字幕行' }],
    },
    media: [
      { key: 'media/a.mp4', assetId: 'a', name: 'a.mp4', kind: 'video', mime: 'video/mp4', size: 10 },
      { key: 'media/m.wav', assetId: 'm', name: 'm.wav', kind: 'audio', mime: 'audio/wav', size: 10 },
    ],
  };
}
const sampleFiles = () => new Map([
  ['media/a.mp4', new Uint8Array([1, 2, 3])],
  ['media/m.wav', new Uint8Array([4, 5])],
]);

test('媒体服务：detectMediaTools 解析版本/编码器/滤镜（注入假 spawn）', async () => {
  const fake = fakeSpawn();
  const caps = await detectMediaTools({ spawnImpl: fake.fn });
  assert.equal(caps.available, true);
  assert.equal(caps.ffmpegVersion, '6.1.1-test');
  assert.equal(caps.encoders.libx264, true);
  assert.equal(caps.filters.subtitles, true);
  const dead = await detectMediaTools({ spawnImpl: async () => { throw new Error('ENOENT'); }, ffmpeg: 'no-such-ffmpeg' });
  assert.equal(dead.available, false);
});

test('媒体服务：buildFilterGraph 组装 overlay 叠链/音频混音/字幕，全部 argv 化无 shell', () => {
  const layout = {
    inputs: [
      { key: 'media/a.mp4', local: 'in0.mp4', isImage: false, hasAudio: true },
      { key: 'media/m.wav', local: 'in1.wav', isImage: false, hasAudio: true },
    ],
    hasSubtitles: true, hasDrawtext: true, subsFile: 'subs.srt',
    textFiles: new Map([['ov0.txt', 'ov0.txt']]),
  };
  const job = sampleJob();
  job.tracks.overlay[0].__oid = 'ov0.txt';
  const { graph, hasAudio, warnings } = buildFilterGraph(job, layout);
  assert.equal(warnings.length, 0);
  assert.match(graph, /color=c=0x000000:s=320x180:r=30/);
  assert.match(graph, /\[0:v\]trim=start=0\.0:end=2\.0/);
  assert.match(graph, /tpad=start_mode=clone:start_duration=0\.0/);
  assert.match(graph, /overlay=0:0:enable='between\(t,0\.0,2\.0\)'/);
  assert.match(graph, /drawtext=textfile='ov0\.txt'/);
  assert.match(graph, /subtitles='subs\.srt'/);
  assert.match(graph, /\[1:a\]atrim/);
  assert.match(graph, /amix=inputs=3:duration=first:normalize=0/);
  assert.equal(hasAudio, true);
  // 无字幕/文字滤镜时降级为告警而非伪造
  const g2 = buildFilterGraph(job, { ...layout, hasSubtitles: false, hasDrawtext: false, textFiles: new Map() });
  assert.ok(g2.warnings.length >= 2);
});

test('媒体服务：render 走假 spawn 全流程——临时目录/argv/进度/缺媒体拒绝/清理', async () => {
  const fake = fakeSpawn();
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  const svc = createMediaService({ spawnImpl: fake.fn, tools: TOOLS, tmpRoot });
  const progress = [];
  const r = await svc.render(sampleJob(), sampleFiles(), { onProgress: p => progress.push(p) });
  try {
    assert.ok(r.size > 100);
    assert.equal(r.mime, 'video/mp4');
    const ffcall = fake.calls.find(c => c.args.includes('-filter_complex_script'));
    assert.ok(ffcall, '未调用 ffmpeg 渲染');
    assert.ok(ffcall.cwd.startsWith(tmpRoot));
    assert.ok(ffcall.args.includes('-map') && ffcall.args.includes('[aout]'));
    assert.ok(ffcall.args.includes('libx264'));
    assert.ok(progress.some(p => p.ratio >= 0));
    // 缺媒体文件 → 明确 400
    await assert.rejects(
      () => svc.render(sampleJob(), new Map([['media/a.mp4', new Uint8Array([1])]])),
      e => e instanceof MediaError && e.status === 400 && /m\.wav/.test(e.message));
    // 预中止信号 → AbortError，不起渲染
    const ac = new AbortController(); ac.abort();
    await assert.rejects(() => svc.render(sampleJob(), sampleFiles(), { signal: ac.signal }),
      e => e?.name === 'AbortError');
  } finally { await r.cleanup(); await rm(tmpRoot, { recursive: true, force: true }); }
});

test('媒体服务：取消传播——永不返回的 spawn 也能 AbortError 且目录清理', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  // spawnImpl 模拟长任务：只在 abort 时拒绝（等价于 runProc 内 SIGKILL 路径对外语义）
  const neverDone = (cmd, args, opts = {}) => new Promise((_, rej) => {
    if (opts.signal?.aborted) return rej(Object.assign(new Error('已取消'), { name: 'AbortError' }));
    opts.signal?.addEventListener('abort', () => rej(Object.assign(new Error('已取消'), { name: 'AbortError' })), { once: true });
  });
  const svc = createMediaService({ spawnImpl: neverDone, tools: TOOLS, tmpRoot });
  const ac = new AbortController();
  const p = svc.render(sampleJob(), sampleFiles(), { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, e => e?.name === 'AbortError');
  await rm(tmpRoot, { recursive: true, force: true });
});

test('媒体服务：渲染槽位在读取请求体前占用——并发慢速上传第二个请求立即 429', { timeout: 15000 }, async () => {
  const fake = fakeSpawn();
  const svc = createMediaService({ spawnImpl: fake.fn, tools: TOOLS });
  const job = sampleJob();
  const pkg = Buffer.from(zipStore([
    { name: 'render.json', data: enc.encode(JSON.stringify(job)) },
    ...[...sampleFiles()].map(([k, v]) => ({ name: k, data: v })),
  ]));
  // 慢速上传：先推 64 字节挂住读体阶段，剩余在 429 断言后补推
  let open = true;
  const slow = new Readable({
    read() {
      if (!open) return;
      open = false;
      this.push(pkg.subarray(0, 64));
    },
  });
  slow.method = 'POST'; slow.headers = {};
  const res1 = fakeRes();
  const first = svc.handleRequest(slow, res1, '/media/render');
  await new Promise(r => setTimeout(r, 30));
  const res2 = fakeRes();
  await svc.handleRequest(fakeReq(pkg), res2, '/media/render');
  assert.equal(res2.state.statusCode, 429, '渲染中第二个请求必须 429，不得穿过槽位检查');
  slow.push(pkg.subarray(64)); slow.push(null);
  await first;
  assert.equal(res1.state.statusCode, 200);
});

test('媒体服务：探测阶段取消——signal 到达 ffprobe 且不启动编码', { timeout: 15000 }, async () => {
  let probeEntered; const entered = new Promise(r => probeEntered = r);
  let encodes = 0;
  const fn = (cmd, args, opts = {}) => {
    if (args.includes('-show_entries')) {
      probeEntered();
      return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' })), { once: true }));
    }
    encodes++;
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  const svc = createMediaService({ spawnImpl: fn, tools: TOOLS, tmpRoot });
  const ac = new AbortController();
  const p = svc.render(sampleJob(), sampleFiles(), { signal: ac.signal });
  await entered; ac.abort();
  await assert.rejects(p, e => e?.name === 'AbortError');
  assert.equal(encodes, 0, '探测阶段中止绝不能启动 ffmpeg 编码');
  await rm(tmpRoot, { recursive: true, force: true });
});

test('媒体服务：编码阶段取消——AbortError 传播且临时目录清理', { timeout: 15000 }, async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  let entered; const encodeStarted = new Promise(r => entered = r);
  const fn = (cmd, args, opts = {}) => {
    const tail = args.join(' ');
    if (/-version$/.test(tail)) return Promise.resolve({ code: 0, stdout: 'ffmpeg version 6.1', stderr: '' });
    if (tail.includes('codec_type')) return Promise.resolve({ code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }), stderr: '' });
    if (tail.includes('format=')) return Promise.resolve({ code: 0, stdout: JSON.stringify({ format: { format_name: 'mov,mp4', duration: 2 } }), stderr: '' });
    if (tail.includes('filter_complex_script')) {
      entered();
      return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' })), { once: true }));
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const svc = createMediaService({ spawnImpl: fn, tools: TOOLS, tmpRoot });
  const ac = new AbortController();
  const p = svc.render(sampleJob(), sampleFiles(), { signal: ac.signal });
  await encodeStarted;
  ac.abort();
  await assert.rejects(p, e => e?.name === 'AbortError');
  const left = await readdir(tmpRoot).catch(() => []);
  assert.equal(left.length, 0, '取消后临时目录应已清理');
  await rm(tmpRoot, { recursive: true, force: true });
});

test('媒体服务：下载阶段断连——pipeline 终结并释放槽位，后续请求不卡 429', { timeout: 15000 }, async () => {
  const fake = fakeSpawn();
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  const svc = createMediaService({ spawnImpl: fake.fn, tools: TOOLS, tmpRoot });
  const pkg = Buffer.from(zipStore([
    { name: 'render.json', data: enc.encode(JSON.stringify(sampleJob())) },
    ...[...sampleFiles()].map(([k, v]) => ({ name: k, data: v })),
  ]));
  // 客户端在响应体写出时立即断开
  const gone = new Writable({ write(c, _e, cb) { cb(new Error('EPIPE')); } });
  gone.state = { statusCode: 0, headers: {} };
  gone.writeHead = (s, h) => { gone.state.statusCode = s; Object.assign(gone.state.headers, h ?? {}); };
  await svc.handleRequest(fakeReq(pkg), gone, '/media/render');
  const res2 = fakeRes();
  await svc.handleRequest(fakeReq(pkg), res2, '/media/render');
  assert.equal(res2.state.statusCode, 200, '断连后槽位必须释放');
  await rm(tmpRoot, { recursive: true, force: true });
});

test('媒体服务：伪装成 mp4 的播放列表只走强制 demuxer + file 协议，无远端/本地嵌套抓取', { timeout: 15000 }, async () => {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push([...args]);
    const tail = args.join(' ');
    if (/-version$/.test(tail)) return { code: 0, stdout: 'ffmpeg version 6.1', stderr: '' };
    if (tail.includes('codec_type')) return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }] }), stderr: '' };
    if (tail.includes('format=')) return { code: 0, stdout: JSON.stringify({ format: {} }), stderr: '' };
    if (tail.includes('filter_complex_script')) return { code: 1, stdout: '', stderr: 'Invalid data found when processing input' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  const svc = createMediaService({ spawnImpl: fn, tools: TOOLS, tmpRoot });
  // m3u8 内容伪装成 mp4：若被自动探测为 hls 将抓取远端/本地文件
  const playlist = enc.encode('#EXTM3U\n#EXTINF:1.0,\nhttps://169.254.169.254/x.ts\nfile:///etc/passwd\n');
  const job = {
    format: 'xp-render@1', version: 1,
    output: { width: 160, height: 90, fps: 24, format: 'mp4', background: '#000000' },
    duration: 1,
    tracks: { video: [{ file: 'media/x.mp4', start: 0, end: 1, in: 0, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0 }], overlay: [], audio: [], subtitle: [] },
    media: [{ key: 'media/x.mp4', assetId: 'x', name: 'x.mp4', kind: 'video', mime: 'video/mp4', size: playlist.length }],
  };
  await assert.rejects(() => svc.render(job, new Map([['media/x.mp4', playlist]])));
  const ff = calls.find(a => a.includes('-filter_complex_script'));
  assert.ok(ff, 'ffmpeg 未被调用');
  const iPos = ff.indexOf('-i');
  assert.equal(ff[iPos - 2], '-f');
  assert.equal(ff[iPos - 1], 'mov', 'mp4 输入必须强制 mov demuxer，禁自动探测');
  const wl = ff.indexOf('-protocol_whitelist');
  assert.ok(wl >= 0 && ff[wl + 1] === 'file', '输入必须限定 file 协议');
  assert.ok(ff.includes('-enable_drefs'), 'MOV 外部数据引用必须显式关闭');
  assert.ok(!ff.some(a => /^https?:\/\//.test(a) || a.includes('..')), 'argv 不得含远端地址或相对路径');
  await rm(tmpRoot, { recursive: true, force: true });
});

test('媒体服务：工具探测受限且可中止——signal 直达探测子进程，中止不缓存失败', { timeout: 15000 }, async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  let sawSignal = false;
  const neverDone = (cmd, args, opts = {}) => new Promise((_, rej) => {
    if (opts.signal) sawSignal = true;
    if (opts.signal?.aborted) return rej(Object.assign(new Error('abort'), { name: 'AbortError' }));
    opts.signal?.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' })), { once: true });
  });
  const svc = createMediaService({ spawnImpl: neverDone, tmpRoot });
  const ac = new AbortController();
  const p = svc.render(sampleJob(), sampleFiles(), { signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, e => e?.name === 'AbortError');
  assert.ok(sawSignal, '中止信号必须传给探测子进程');
  await rm(tmpRoot, { recursive: true, force: true });
});

test('媒体服务：handleRequest 边界（404/坏包/坏任务）', async () => {
  const fake = fakeSpawn();
  const svc = createMediaService({ spawnImpl: fake.fn, tools: TOOLS });
  // capabilities
  const capRes = fakeRes();
  await svc.handleRequest(fakeReq(null, 'GET'), capRes, '/media/capabilities');
  assert.equal(capRes.state.statusCode, 200);
  const caps = JSON.parse(capRes.bodyText());
  assert.equal(caps.available, true);
  assert.deepEqual(caps.formats, ['mp4']);
  // 未知路由
  const r404 = fakeRes();
  await svc.handleRequest(fakeReq(null, 'GET'), r404, '/media/whatever');
  assert.equal(r404.state.statusCode, 404);
  // 坏 zip
  const rBad = fakeRes();
  await svc.handleRequest(fakeReq(enc.encode('not zip')), rBad, '/media/render');
  assert.equal(rBad.state.statusCode, 400);
  assert.match(JSON.parse(rBad.bodyText()).error.code, /bad_package/);
  // zip 无 render.json
  const rBad2 = fakeRes();
  await svc.handleRequest(fakeReq(Buffer.from(zipStore([{ name: 'x.txt', data: enc.encode('x') }]))), rBad2, '/media/render');
  assert.equal(rBad2.state.statusCode, 400);
  // render.json 校验失败（引用不存在媒体）
  const badJob = sampleJob(); badJob.tracks.video[0].file = 'media/ghost.mp4';
  const badPkg = zipStore([{ name: 'render.json', data: enc.encode(JSON.stringify(badJob)) }, ...[...sampleFiles()].map(([k, v]) => ({ name: k, data: v }))]);
  const rBad3 = fakeRes();
  await svc.handleRequest(fakeReq(Buffer.from(badPkg)), rBad3, '/media/render');
  assert.equal(rBad3.state.statusCode, 400);
});

test('媒体服务：handleRequest POST /media/render 完整假渲染 → video/mp4 200 流式返回', async () => {
  const fake = fakeSpawn();
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  const svc = createMediaService({ spawnImpl: fake.fn, tools: TOOLS, tmpRoot });
  const job = sampleJob();
  const pkg = zipStore([
    { name: 'render.json', data: enc.encode(JSON.stringify(job)) },
    ...[...sampleFiles()].map(([k, v]) => ({ name: k, data: v })),
  ]);
  const res = fakeRes();
  await svc.handleRequest(fakeReq(pkg), res, '/media/render');
  assert.equal(res.state.statusCode, 200);
  assert.equal(res.state.headers['Content-Type'], 'video/mp4');
  assert.ok(res.bodyBytes().length > 100);
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------- 真实 FFmpeg（环境有则跑真渲染；无则跳过，不伪造通过） ----------
const real = await detectMediaTools({});
const FFMPEG_OK = real.available && real.canMp4;

test('媒体服务：真实 ffmpeg 渲染 fixtures → mp4 产物 ftyp 可验', { skip: !FFMPEG_OK && '本机无 FFmpeg' }, async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-real-'));
  const svc = createMediaService({ tmpRoot });
  const mp4 = await readFile(join(FIXTURES, 'sample.mp4'));
  const wav = await readFile(join(FIXTURES, 'sample.wav'));
  const job = {
    format: 'xp-render@1', version: 1,
    output: { width: 320, height: 180, fps: 24, format: 'mp4', background: '#000000' },
    duration: 1.5,
    tracks: {
      video: [{ file: 'media/v.mp4', start: 0, end: 1.5, in: 0, speed: 1, volume: 0.7, fadeIn: 0.1, fadeOut: 0.1 }],
      overlay: [], audio: [{ file: 'media/a.wav', start: 0, end: 1.5, in: 0, speed: 1, volume: 0.5, fadeIn: 0, fadeOut: 0.2, track: 'a1' }],
      subtitle: [{ start: 0.1, end: 1.2, text: '真实渲染测试' }],
    },
    media: [
      { key: 'media/v.mp4', assetId: 'v', name: 'sample.mp4', kind: 'video', mime: 'video/mp4', size: mp4.length },
      { key: 'media/a.wav', assetId: 'a', name: 'sample.wav', kind: 'audio', mime: 'audio/wav', size: wav.length },
    ],
  };
  const files = new Map([['media/v.mp4', new Uint8Array(mp4)], ['media/a.wav', new Uint8Array(wav)]]);
  const progress = [];
  const r = await svc.render(job, files, { onProgress: p => progress.push(p.ratio) });
  try {
    assert.ok(r.size > 1000, `产物过小 ${r.size}`);
    const bytes = await readFile(r.path);
    assert.equal(bytes.subarray(4, 8).toString('ascii'), 'ftyp');   // 真 mp4，不是 JSON 伪装
    assert.ok(!r.warnings.some(w => /容器校验未通过/.test(w)), `warnings: ${r.warnings}`);
    assert.ok(progress.length > 0);
  } finally { await r.cleanup(); await rm(tmpRoot, { recursive: true, force: true }); }
});

test('媒体服务：真实 ffmpeg 渲染预中止信号立即拒绝', { skip: !FFMPEG_OK && '本机无 FFmpeg' }, async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-real-'));
  const svc = createMediaService({ tmpRoot });
  const mp4 = await readFile(join(FIXTURES, 'sample.mp4'));
  const job = {
    format: 'xp-render@1', version: 1,
    output: { width: 320, height: 180, fps: 24, format: 'mp4', background: '#000000' },
    duration: 5,
    tracks: {
      video: [{ file: 'media/v.mp4', start: 0, end: 5, in: 0, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0 }],
      overlay: [], audio: [], subtitle: [],
    },
    media: [{ key: 'media/v.mp4', assetId: 'v', name: 'sample.mp4', kind: 'video', mime: 'video/mp4', size: mp4.length }],
  };
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => svc.render(job, new Map([['media/v.mp4', new Uint8Array(mp4)]]), { signal: ac.signal }),
    e => e?.name === 'AbortError');
  await rm(tmpRoot, { recursive: true, force: true });
});

test('媒体服务：文字/字幕烧录失败不静默省略——无声明即失败，显式声明才降级且留告警', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  const calls = [];
  const fn = async (cmd, args, opts = {}) => {
    calls.push([...args]);
    const tail = args.join(' ');
    if (/-version$/.test(tail)) return { code: 0, stdout: 'ffmpeg version 6.1', stderr: '' };
    if (tail.includes('-encoders')) return { code: 0, stdout: ' V..... libx264\n A..... aac\n', stderr: '' };
    if (tail.includes('-filters')) return { code: 0, stdout: ' ..C subtitles\n ..C drawtext\n', stderr: '' };
    if (cmd.includes('ffprobe') && tail.includes('format='))
      return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }], format: { format_name: 'mov,mp4', duration: 2 } }), stderr: '' };
    if (cmd.includes('ffprobe') && tail.includes('codec_type'))
      return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }), stderr: '' };
    if (cmd.includes('ffmpeg') && tail.includes('filter_complex_script')) {
      const fg = await readFile(join(opts.cwd, 'fg.txt'), 'utf8').catch(() => '');
      if (/drawtext|subtitles=/.test(fg)) throw Object.assign(new Error('no such filter: drawtext'), { code: 1 });
      await writeFile(join(opts.cwd, 'out.mp4'), Buffer.from('FAKEMP4DATA'.repeat(64)));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const svc = createMediaService({ spawnImpl: fn, tools: TOOLS, tmpRoot });
  // 未声明省略：烧录失败 = 整体失败，用户文字绝不静默丢弃
  await assert.rejects(() => svc.render(sampleJob(), sampleFiles()),
    e => e instanceof MediaError && e.code === 'text_unsupported');
  // 显式声明用户已同意省略：降级重试成功，warnings 明确记录内容被省略
  const r = await svc.render({ ...sampleJob(), allowTextFallback: true }, sampleFiles());
  try {
    assert.ok(r.warnings.some(w => /省略/.test(w) && /文字|字幕/.test(w)), '降级产物必须携带「文字/字幕被省略」告警');
    assert.equal(calls.filter(a => a.includes('-filter_complex_script')).length, 3, '第一次拒绝；确认后再尝试一次并仅允许一次无文字重试');
  } finally { await r.cleanup(); }
  // 滤镜缺失同理：无声明即 text_unsupported；声明后降级成功且留告警
  const svcNoFilters = createMediaService({ spawnImpl: fn, tools: { ...TOOLS, filters: { subtitles: false, drawtext: false } }, tmpRoot });
  await assert.rejects(() => svcNoFilters.render(sampleJob(), sampleFiles()),
    e => e instanceof MediaError && e.code === 'text_unsupported');
  const r2 = await svcNoFilters.render({ ...sampleJob(), allowTextFallback: true }, sampleFiles());
  try { assert.ok(r2.warnings.length > 0); } finally { await r2.cleanup(); }
  await rm(tmpRoot, { recursive: true, force: true });
});

test('媒体服务：装了 ffprobe 就必须验证产物——容器/时长/视频流/预期音轨缺一不可', async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'xp-msvc-test-'));
  const mk = probeOut => async (cmd, args, opts = {}) => {
    const tail = args.join(' ');
    if (/-version$/.test(tail)) return { code: 0, stdout: 'ffmpeg version 6.1', stderr: '' };
    if (cmd.includes('ffprobe') && tail.includes('format=')) return { code: 0, stdout: JSON.stringify(probeOut), stderr: '' };
    if (cmd.includes('ffprobe') && tail.includes('codec_type')) return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }), stderr: '' };
    if (cmd.includes('ffmpeg') && tail.includes('filter_complex_script')) { await writeFile(join(opts.cwd, 'out.mp4'), Buffer.from('FAKEMP4DATA'.repeat(64))); return { code: 0, stdout: '', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  // 时长与预期不符 → 拒绝
  const svcBadDur = createMediaService({ spawnImpl: mk({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }], format: { format_name: 'mov,mp4', duration: 9 } }), tools: TOOLS, tmpRoot });
  await assert.rejects(() => svcBadDur.render(sampleJob(), sampleFiles()), /时长|校验/);
  // 缺预期音轨 → 拒绝
  const svcNoAudio = createMediaService({ spawnImpl: mk({ streams: [{ codec_type: 'video' }], format: { format_name: 'mov,mp4', duration: 2 } }), tools: TOOLS, tmpRoot });
  await assert.rejects(() => svcNoAudio.render(sampleJob(), sampleFiles()), /音轨|音频|校验/);
  // 容器不是 mp4 → 拒绝
  const svcBadFmt = createMediaService({ spawnImpl: mk({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }], format: { format_name: 'matroska,webm', duration: 2 } }), tools: TOOLS, tmpRoot });
  await assert.rejects(() => svcBadFmt.render(sampleJob(), sampleFiles()), /容器|校验|mp4/);
  // ffprobe 自身执行失败 → 拒绝（装了但不验证一律不放行）
  const svcProbeFail = createMediaService({ spawnImpl: async (cmd, args, opts = {}) => {
    const tail = args.join(' ');
    if (/-version$/.test(tail)) return { code: 0, stdout: 'ffmpeg version 6.1', stderr: '' };
    if (cmd.includes('ffprobe') && tail.includes('format=')) throw new Error('ffprobe 崩溃');
    if (cmd.includes('ffprobe') && tail.includes('codec_type')) return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }] }), stderr: '' };
    if (cmd.includes('ffmpeg') && tail.includes('filter_complex_script')) { await writeFile(join(opts.cwd, 'out.mp4'), Buffer.from('FAKEMP4DATA'.repeat(64))); return { code: 0, stdout: '', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  }, tools: TOOLS, tmpRoot });
  await assert.rejects(() => svcProbeFail.render(sampleJob(), sampleFiles()), /校验/);
  await rm(tmpRoot, { recursive: true, force: true });
});
