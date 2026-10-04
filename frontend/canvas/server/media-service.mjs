// 本机媒体渲染服务（窄接口，由 app.mjs 属主挂载到 /media/*）。
//  · POST /media/render：body = xp-render 包（STORE zip：render.json + media/*）
//    → 严格校验（sanitizeRenderJob 独立服务端边界）→ 临时目录写媒体 → argv 数组 spawn ffmpeg
//    （无 shell、无任意路径、无远端）→ ffprobe 在位时验证产物（容器/时长/流构成）→ 真实 mp4 回流式返回。
//    文字/字幕绝不静默省略：滤镜缺失或烧录失败默认整体失败（text_unsupported），
//    仅当任务显式声明 allowTextFallback（用户已确认省略）才降级重试并在 X-Render-Warnings 如实告知。
//  · GET /media/capabilities：{available, version, canMp4, filters, limits}
// 约束：输入只接受包内 media/ 白名单名；所有文件路径由本服务在 mkdtemp 内生成；
//       串行渲染（同一时间一个任务）；AbortSignal/断连即 SIGKILL + 清理临时目录；
//       进度经 ffmpeg -progress 解析（out_time_us）上报。

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  parseRenderPackage, sanitizeRenderJob, srtTime, TL_LIMITS,
} from '../src/export-project.js';

const MiB = 1024 * 1024;
export const MEDIA_LIMITS = Object.freeze({
  maxPackageBytes: 768 * MiB,
  maxMediaFileBytes: 256 * MiB,
  maxMediaFiles: 64,
  maxDuration: TL_LIMITS.maxDuration,
  maxPixels: 1920 * 1920,
  maxClips: 200,
});

export class MediaError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new MediaError(status, code, message); };
const abortError = () => Object.assign(new Error('已取消'), { name: 'AbortError' });

// 渲染白名单扩展名 → 强制 demuxer：输入只走这些解复用器，禁止自动探测
// （伪装成 mp4 的 m3u8/concat/SVG 等不会触发播放列表抓取或本地文件嵌套读取）。
const DEMUXER_OF_EXT = Object.freeze({
  mp4: 'mov', m4a: 'mov', webm: 'matroska',
  mp3: 'mp3', wav: 'wav', aac: 'aac',
  png: 'image2', jpg: 'image2', jpeg: 'image2', webp: 'image2',
});

// ---------- 进程执行（argv 数组，无 shell） ----------

function runProc(cmd, args, { cwd, timeoutMs = 15000, signal, onStdoutLine, stdin, maxOutputBytes = 8192 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let outTail = '', errTail = '', settled = false, killErr = null;
    const keep = (buf, s) => (buf + s).slice(-maxOutputBytes);
    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killWait);
      signal?.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve({ code, stdout: outTail, stderr: errTail });
    };
    // 终止后等待 exit（Windows 上文件句柄随进程退出才释放），宽限 5s 兜底不挂死
    let killWait = null;
    const kill = err => {
      killErr = err;
      try { child.kill('SIGKILL'); } catch {}
      killWait = setTimeout(() => finish(killErr), 5000);
    };
    const onAbort = () => kill(abortError());
    const timer = setTimeout(() => kill(new Error('进程超时')), timeoutMs);
    child.stdout?.on('data', d => { const s = d.toString('utf8'); outTail = keep(outTail, s); onStdoutLine?.(s); });
    child.stderr?.on('data', d => { errTail = keep(errTail, d.toString('utf8')); });
    child.on('error', e => finish(killErr ?? (e.code === 'ENOENT' ? new Error(`找不到可执行文件：${cmd}`) : e)));
    child.on('exit', code => finish(killErr ?? (code === 0 ? null : Object.assign(new Error(`进程退出码 ${code}：${errTail.slice(-400)}`), { code, stderr: errTail })), code));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end(); }
    else child.stdin?.end();
  });
}

// ---------- 工具探测 ----------

// spawnImpl 注入点：(cmd, args, opts) → Promise<{code,stdout,stderr}>（测试替身；默认 runProc）
// 每一步都受 timeoutMs 约束且可中止；AbortError 不吞掉，直接向上传播。
export async function detectMediaTools({ spawnImpl, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', signal } = {}) {
  const out = { available: false, ffmpeg, ffprobe, ffmpegVersion: null, ffprobeVersion: null, canMp4: false, filters: { subtitles: false, drawtext: false }, encoders: { libx264: false, aac: false } };
  const call = spawnImpl ?? ((c, a, o) => runProc(c, a, o));
  const step = async fn => {
    if (signal?.aborted) throw abortError();
    try { return await fn(); }
    catch (e) { if (e?.name === 'AbortError') throw e; return null; }
  };
  const v = await step(() => call(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 8000, signal }));
  if (!v) return out;
  out.ffmpegVersion = /ffmpeg version (\S+)/.exec(v.stdout + v.stderr)?.[1] ?? 'unknown';
  const pv = await step(() => call(ffprobe, ['-hide_banner', '-version'], { timeoutMs: 8000, signal }));
  if (pv) out.ffprobeVersion = /ffprobe version (\S+)/.exec(pv.stdout + pv.stderr)?.[1] ?? 'unknown';
  const enc = await step(() => call(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 8000, signal, maxOutputBytes: 262144 }));
  if (enc) {
    out.encoders.libx264 = /\blibx264\b/.test(enc.stdout);
    out.encoders.aac = /\baac\b/.test(enc.stdout);
    out.canMp4 = out.encoders.libx264 && out.encoders.aac;
  }
  const flt = await step(() => call(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 8000, signal, maxOutputBytes: 262144 }));
  if (flt) {
    out.filters.subtitles = /\bsubtitles\b/.test(flt.stdout);
    out.filters.drawtext = /\bdrawtext\b/.test(flt.stdout);
  }
  out.available = true;
  return out;
}

// ---------- filter_complex 构建（纯函数，可测） ----------

const F = n => { const s = Number(n).toFixed(3); return s.replace(/0+$/, '').replace(/\.$/, '.0'); };
const colorOf = hex => /^#[0-9a-fA-F]{6}$/.test(hex) ? `0x${hex.slice(1)}` : 'black';

// 变速 → atempo 链（ffmpeg 单级范围 0.5–100）
function atempoChain(speed) {
  let s = speed; const parts = [];
  while (s > 2) { parts.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${F(s)}`);
  return parts.join(',');
}

// layout: { inputs: [{key, local, isImage, hasAudio, loopT}], subsFile, textFiles:Map }
export function buildFilterGraph(job, layout) {
  const { width: W, height: H, fps, background } = job.output;
  const D = job.duration;
  const warnings = [];
  const idx = new Map(layout.inputs.map((inp, i) => [inp.key, { ...inp, i }]));
  const nodes = [];
  const vsegs = [];   // 待 overlay 的视频段标签
  let label = 0;
  const fresh = p => `${p}${label++}`;

  nodes.push(`color=c=${colorOf(background)}:s=${W}x${H}:r=${fps}:d=${F(D)}[base]`);

  // 统计每个输入的引用次数，>1 需 split
  const vUses = new Map(), aUses = new Map();
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const c of job.tracks.video) count(vUses, c.file);
  for (const c of job.tracks.overlay) if (c.kind === 'image') count(vUses, c.file);
  // 只对确有音频流的输入计 audio 引用；无音频输入不得生成 [i:a] 引用（否则整图失败）
  for (const c of job.tracks.video) if (c.volume > 0 && idx.get(c.file)?.hasAudio) count(aUses, c.file);
  for (const c of job.tracks.audio) if (c.volume > 0 && idx.get(c.file)?.hasAudio) count(aUses, c.file);
  for (const [key, n] of vUses) {
    if (n > 1) {
      const inp = idx.get(key);
      const names = Array.from({ length: n }, () => fresh('vs'));
      nodes.push(`[${inp.i}:v]split=${n}${names.map(t => `[${t}]`).join('')}`);
      inp.vOuts = [...names];
    }
  }
  for (const [key, n] of aUses) {
    if (n > 1) {
      const inp = idx.get(key);
      const names = Array.from({ length: n }, () => fresh('as'));
      // 音频扇出必须 asplit——split 是视频滤镜，产出的视频垫接入 atrim 会被 ffmpeg 拒
      // （Media type mismatch）；同素材多片段引用音频（再次插入/重复入轨）即触发。
      nodes.push(`[${inp.i}:a]asplit=${n}${names.map(t => `[${t}]`).join('')}`);
      inp.aOuts = [...names];
    }
  }
  const takeV = key => {
    const inp = idx.get(key);
    return inp.vOuts?.length ? `[${inp.vOuts.shift()}]` : `[${inp.i}:v]`;
  };
  const takeA = key => {
    const inp = idx.get(key);
    return inp.aOuts?.length ? `[${inp.aOuts.shift()}]` : `[${inp.i}:a]`;
  };

  // ---- 视频主轨（v1 片段按 start 排序；间隙由 base 黑场透出）----
  for (const c of [...job.tracks.video].sort((a, b) => a.start - b.start)) {
    const inp = idx.get(c.file);
    const segLen = c.end - c.start;
    const srcLen = segLen * (c.speed || 1);
    const tag = fresh('v');
    let chain;
    if (inp.isImage) {
      // 图片输入已 -loop 1 -t <end>：流覆盖 [0,end)，窗口由 overlay enable 控制。
      // format=rgba + alpha fade + 底色 pad：淡化按 alpha 叠到输出底色、letterbox 与底色一致——
      // 与浏览器路径 globalAlpha-over-background 同语义（非黑背景不淡向黑）
      chain = `${takeV(c.file)}format=rgba,scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:${colorOf(background)},setsar=1,fps=${fps}` +
        (c.fadeIn > 0 ? `,fade=t=in:st=${F(c.start)}:d=${F(c.fadeIn)}:alpha=1` : '') +
        (c.fadeOut > 0 ? `,fade=t=out:st=${F(c.end - c.fadeOut)}:d=${F(c.fadeOut)}:alpha=1` : '');
      chain += `[${tag}]`;
    } else {
      chain = `${takeV(c.file)}trim=start=${F(c.in)}:end=${F(c.in + srcLen)},setpts=(PTS-STARTPTS)/${F(c.speed || 1)},` +
        `format=rgba,scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:${colorOf(background)},setsar=1,fps=${fps}` +
        (c.fadeIn > 0 ? `,fade=t=in:st=0:d=${F(c.fadeIn)}:alpha=1` : '') +
        (c.fadeOut > 0 ? `,fade=t=out:st=${F(segLen - c.fadeOut)}:d=${F(c.fadeOut)}:alpha=1` : '') +
        `,tpad=start_mode=clone:start_duration=${F(c.start)},setpts=PTS-STARTPTS[${tag}]`;
    }
    nodes.push(chain);
    vsegs.push({ tag, start: c.start, end: c.end });
  }
  // ---- 图片叠加（ov1）----
  const ovsegs = [];
  for (const c of [...job.tracks.overlay].sort((a, b) => a.start - b.start)) {
    if (c.kind !== 'image') continue;
    const tag = fresh('ov');
    const wPx = Math.max(2, Math.round(c.w * W)), hPx = Math.max(2, Math.round(c.h * H));
    // 叠加用 alpha 淡化（普通 fade 会淡到黑块）；rgba 保证 alpha 通道存在；
    // pad 透明填充——rect 内图片外区域透出下层画面，与浏览器 drawImage 一致
    nodes.push(`${takeV(c.file)}format=rgba,scale=w=${wPx}:h=${hPx}:force_original_aspect_ratio=decrease,` +
      `pad=${wPx}:${hPx}:(ow-iw)/2:(oh-ih)/2:0x00000000,setsar=1` +
      (c.fadeIn > 0 ? `,fade=t=in:st=${F(c.start)}:d=${F(c.fadeIn)}:alpha=1` : '') +
      (c.fadeOut > 0 ? `,fade=t=out:st=${F(c.end - c.fadeOut)}:d=${F(c.fadeOut)}:alpha=1` : '') +
      `[${tag}]`);
    ovsegs.push({ tag, x: Math.round(c.x * W), y: Math.round(c.y * H), start: c.start, end: c.end });
  }
  // 叠链
  let cur = 'base';
  for (const s of [...vsegs.map(v => ({ ...v, x: 0, y: 0 })), ...ovsegs].sort((a, b) => a.start - b.start)) {
    const nxt = fresh('t');
    nodes.push(`[${cur}][${s.tag}]overlay=${s.x}:${s.y}:enable='between(t,${F(s.start)},${F(s.end)})':eof_action=pass[${nxt}]`);
    cur = nxt;
  }
  // ---- 文字叠加（drawtext；缺滤镜则跳过并告警）----
  for (const c of job.tracks.overlay) {
    if (c.kind !== 'text') continue;
    if (!layout.hasDrawtext) { warnings.push('ffmpeg 无 drawtext 滤镜，按确认省略叠加文字烧录'); continue; }
    const tf = layout.textFiles.get(c.__oid);
    if (!tf) { warnings.push('文字叠加缺少文本文件'); continue; }
    const xPx = Math.round(c.x * W), yPx = Math.round(c.y * H), wPx = Math.round(c.w * W), hPx = Math.round(c.h * H);
    const xExpr = c.align === 'right' ? `${xPx}+${wPx}-text_w` : c.align === 'left' ? `${xPx}` : `${xPx}+(${wPx}-text_w)/2`;
    const yExpr = `${yPx}+(${hPx}-text_h)/2`;
    const fs = Math.max(8, Math.round((c.fontSize ?? 0.06) * H));
    const nxt = fresh('t');
    nodes.push(`[${cur}]drawtext=textfile='${tf}':fontsize=${fs}:fontcolor=${colorOf(c.color ?? '#ffffff').replace('0x', '0x')}:x=${xExpr}:y=${yExpr}:line_spacing=6:borderw=2:bordercolor=black@0.5:enable='between(t,${F(c.start)},${F(c.end)})'[${nxt}]`);
    cur = nxt;
  }
  // ---- 字幕烧录（subtitles 滤镜；缺则告警跳过）----
  if (job.tracks.subtitle.length) {
    if (layout.hasSubtitles && layout.subsFile) {
      const nxt = fresh('t');
      nodes.push(`[${cur}]subtitles='${layout.subsFile}'[${nxt}]`);
      cur = nxt;
    } else warnings.push('ffmpeg 无 subtitles 滤镜，按确认省略字幕烧录（时间线字幕仍可单独导出 SRT）');
  }
  nodes.push(`[${cur}]format=yuv420p[vout]`);

  // ---- 音频：片段→对齐→adelay→amix（含视频片段自带声轨，静音片段跳过）----
  const asegs = [];
  const addAudio = (c, tag) => {
    const inp = idx.get(c.file);
    if (!inp?.hasAudio) return;
    const segLen = c.end - c.start;
    const srcLen = segLen * (c.speed || 1);
    nodes.push(`${takeA(c.file)}atrim=start=${F(c.in)}:end=${F(c.in + srcLen)},asetpts=PTS-STARTPTS,` +
      ((c.speed || 1) !== 1 ? atempoChain(c.speed) + ',' : '') +
      `volume=${F(c.volume)}` +
      (c.fadeIn > 0 ? `,afade=t=in:st=0:d=${F(c.fadeIn)}` : '') +
      (c.fadeOut > 0 ? `,afade=t=out:st=${F(segLen - c.fadeOut)}:d=${F(c.fadeOut)}` : '') +
      `,aformat=sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(c.start * 1000)}|${Math.round(c.start * 1000)}[${tag}]`);
    asegs.push(tag);
  };
  for (const c of job.tracks.video) if (c.volume > 0) addAudio(c, fresh('av'));
  for (const c of job.tracks.audio) if (c.volume > 0) addAudio(c, fresh('aa'));
  let hasAudio = asegs.length > 0;
  if (hasAudio) {
    nodes.push(`anullsrc=r=48000:cl=stereo:d=${F(D)}[abase]`);
    const ins = ['abase', ...asegs].map(t => `[${t}]`).join('');
    nodes.push(`${ins}amix=inputs=${asegs.length + 1}:duration=first:normalize=0,atrim=0:${F(D)},asetpts=PTS-STARTPTS[aout]`);
  }
  return { graph: nodes.join(';\n'), hasAudio, warnings };
}

// ---------- 服务 ----------

export function createMediaService({
  ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', spawnImpl, tmpRoot = tmpdir(),
  limits = MEDIA_LIMITS, tools, renderTimeoutMs, negativeToolsTtlMs = 30_000,
} = {}) {
  let toolsPromise = tools ? Promise.resolve(tools) : null;
  const toolsFixed = !!tools;          // 注入的固定能力集：不重探不过期
  let toolsNegativeUntil = 0;          // 负探测结果短 TTL：ffmpeg 后装/PATH 延迟生效可自愈，无需重启服务
  // 探测受调用方 signal 约束；失败/中止不缓存，避免毒化后续请求；
  // available:false 负结果只保留 negativeToolsTtlMs——既不每请求高频 spawn，也不终身拒绝渲染。
  const detect = async signal => {
    const cached = toolsPromise;
    if (cached) {
      const t = await cached;
      if (signal?.aborted) throw abortError();
      if (t.available || toolsFixed || Date.now() < toolsNegativeUntil) return t;
      if (toolsPromise === cached) toolsPromise = null;   // 只清自己那份过期负缓存
    }
    const p = detectMediaTools({ spawnImpl, ffmpeg, ffprobe, signal });
    toolsPromise = p;
    try {
      const t = await p;
      if (t?.available) toolsNegativeUntil = 0;
      else toolsNegativeUntil = Date.now() + negativeToolsTtlMs;
      return t;
    }
    catch (e) { if (toolsPromise === p) toolsPromise = null; throw e; }
  };
  const call = spawnImpl ?? ((c, a, o) => runProc(c, a, o));
  let busy = false;
  const checkAbort = s => { if (s?.aborted) throw abortError(); };

  // 探流同样走强制 demuxer + file 协议白名单；signal 透传，中止时向上抛 AbortError
  async function probeStreams(local, demux, { signal } = {}) {
    const args = ['-v', 'error', '-protocol_whitelist', 'file'];
    if (demux === 'mov') args.push('-enable_drefs', '0');
    if (demux) args.push('-f', demux);
    args.push('-show_entries', 'stream=codec_type', '-of', 'json', local);
    const r = await call(ffprobe, args, { timeoutMs: 15000, signal });
    try {
      const j = JSON.parse(r.stdout);
      return (j.streams ?? []).map(s => s.codec_type);
    } catch { return []; }
  }

  // job 已经过 sanitizeRenderJob；files: Map<key,Uint8Array>
  async function render(jobRaw, files, { onProgress, signal } = {}) {
    checkAbort(signal);
    const job = sanitizeRenderJob(jobRaw);
    if (job.output.format !== 'mp4') fail(400, 'format_unsupported', '服务端仅产出 mp4 容器（webm 走浏览器导出路径）');
    onProgress?.({ t: 0, ratio: 0, phase: 'prepare' });
    const caps = await detect(signal);
    checkAbort(signal);
    if (!caps.available) fail(503, 'ffmpeg_missing', '本机未安装 FFmpeg，无法使用服务端渲染');
    if (!caps.canMp4) fail(503, 'encoder_missing', '本机缺少 H.264/AAC 编码器，请改用浏览器导出或安装完整 FFmpeg');
    // 用户文字/字幕不是可丢弃项：滤镜缺失时默认明确失败（text_unsupported），
    // 只有任务显式声明「用户已确认省略」（allowTextFallback）才允许无文字降级。
    if (!job.allowTextFallback) {
      if (job.tracks.subtitle.length && !caps.filters?.subtitles)
        fail(422, 'text_unsupported', '本机 FFmpeg 缺少 subtitles 滤镜，无法烧录字幕；不会自动省略用户内容（可改用浏览器导出，或确认省略后重试）');
      if (job.tracks.overlay.some(c => c.kind === 'text') && !caps.filters?.drawtext)
        fail(422, 'text_unsupported', '本机 FFmpeg 缺少 drawtext 滤镜，无法烧录叠加文字；不会自动省略用户内容（可改用浏览器导出，或确认省略后重试）');
    }
    if (job.output.width * job.output.height > limits.maxPixels) fail(400, 'pixels_too_large', '输出像素超限');
    const mediaKeys = new Set(job.media.map(m => m.key));
    for (const k of mediaKeys) {
      const data = files.get(k);
      if (!data) fail(400, 'media_missing', `渲染包缺少媒体文件 ${k}`);
      if (data.length > limits.maxMediaFileBytes) fail(413, 'media_too_large', `媒体文件超限：${k}`);
    }
    const dir = await mkdtemp(join(tmpRoot, 'xp-render-'));
    const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
    const brief = s => String(s ?? '').replaceAll(dir, '<dir>').replaceAll(tmpRoot, '<tmp>').slice(-200);
    try {
      // 媒体落盘：本地名 in<i>.<ext>，杜绝任何路径注入面
      const inputs = [];
      for (const [i, m] of job.media.entries()) {
        checkAbort(signal);
        const ext = m.key.split('.').pop();
        const demux = DEMUXER_OF_EXT[ext];
        if (!demux) fail(400, 'demux_not_allowed', `不支持的媒体容器：${ext}`);
        const local = `in${i}.${ext}`;
        await writeFile(join(dir, local), files.get(m.key));
        inputs.push({ key: m.key, local, isImage: m.kind === 'image', hasAudio: false, demux });
      }
      // 探测每路输入的流构成（决定能否取 [i:a]）；中止信号透传，绝不吞成空流
      for (const inp of inputs) {
        checkAbort(signal);
        try { inp.streams = await probeStreams(join(dir, inp.local), inp.demux, { signal }); }
        catch (e) { if (e?.name === 'AbortError') throw e; inp.streams = []; }
        inp.hasAudio = (inp.streams ?? []).includes('audio');
      }
      checkAbort(signal);
      // 图片输入需要的循环时长 = 引用它的片段最大 end
      for (const inp of inputs.filter(x => x.isImage)) {
        let need = 0;
        for (const c of job.tracks.video) if (c.file === inp.key) need = Math.max(need, c.end);
        for (const c of job.tracks.overlay) if (c.kind === 'image' && c.file === inp.key) need = Math.max(need, c.end);
        inp.loopT = Math.max(0.1, need);
      }
      // 字幕/文字文件
      const layout = { inputs, hasSubtitles: caps.filters.subtitles, hasDrawtext: caps.filters.drawtext, subsFile: null, textFiles: new Map() };
      if (job.tracks.subtitle.length && caps.filters.subtitles) {
        const srt = job.tracks.subtitle
          .sort((a, b) => a.start - b.start)
          .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.replace(/-->/g, '→')}`).join('\n\n') + '\n';
        await writeFile(join(dir, 'subs.srt'), srt, 'utf8');
        layout.subsFile = 'subs.srt';
      }
      let ti = 0;
      for (const c of job.tracks.overlay) {
        if (c.kind !== 'text') continue;
        if (!caps.filters.drawtext) break;
        const name = `ov${ti++}.txt`;
        await writeFile(join(dir, name), c.text, 'utf8');
        c.__oid = name;
        layout.textFiles.set(name, name);
      }
      const { graph, hasAudio, warnings } = buildFilterGraph(job, layout);
      await writeFile(join(dir, 'fg.txt'), graph, 'utf8');
      checkAbort(signal);

      // 输入 argv：每路输入强制白名单 demuxer + 仅 file 协议；图片 -framerate/-loop/-t 前置。
      // 伪装容器（m3u8/concat/SVG 等）不会被自动探测成播放列表，远端 URL 与本地嵌套路径都不可达。
      const argv = ['-hide_banner', '-nostdin', '-y'];
      for (const inp of inputs) {
        argv.push('-protocol_whitelist', 'file');
        if (inp.demux === 'mov') argv.push('-enable_drefs', '0');   // MOV 外部数据引用保持关闭
        if (inp.isImage) argv.push('-framerate', String(job.output.fps), '-loop', '1', '-t', F(inp.loopT));
        argv.push('-f', inp.demux, '-i', inp.local);
      }
      argv.push('-filter_complex_script', 'fg.txt', '-map', '[vout]');
      if (hasAudio) argv.push('-map', '[aout]');
      argv.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
      argv.push('-pix_fmt', 'yuv420p', '-r', String(job.output.fps));
      if (hasAudio) argv.push('-c:a', 'aac', '-b:a', '160k');
      else argv.push('-an');
      argv.push('-movflags', '+faststart', '-t', F(job.duration), '-progress', 'pipe:1', '-nostats', 'out.mp4');

      const timeout = renderTimeoutMs ?? Math.min(Math.max(job.duration * 10_000, 60_000), 1_800_000);
      const runOnce = () => call(ffmpeg, argv, {
        cwd: dir, timeoutMs: timeout, signal,
        onStdoutLine: s => {
          for (const m of s.matchAll(/out_time_(?:us|ms)=(\d+)/g)) {
            const t = Number(m[1]) / 1e6;
            onProgress?.({ t, ratio: Math.min(1, t / job.duration), phase: 'render' });
          }
        },
      });
      try {
        await runOnce();
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        const texty = layout.subsFile || [...layout.textFiles.keys()].length;
        if (!texty) throw e;
        // 文字/字幕烧录失败：用户内容绝不静默丢——默认整体失败（客户端可确认后带
        // allowTextFallback 重试）；仅任务显式声明已获同意才做唯一一次降级重试并留告警。
        if (!job.allowTextFallback)
          fail(422, 'text_unsupported', `渲染失败：文字/字幕内容无法烧录，已中止而非省略（${brief(e.message)}）。确认省略后请重试`);
        const layout2 = { ...layout, hasSubtitles: false, hasDrawtext: false, subsFile: null, textFiles: new Map() };
        const g2 = buildFilterGraph(job, layout2);
        warnings.push(`按用户确认省略了文字/字幕烧录（字幕可另行导出 SRT）；原始错误：${brief(e.message).slice(-120)}`);
        await writeFile(join(dir, 'fg.txt'), g2.graph, 'utf8');
        checkAbort(signal);
        await runOnce();
      }
      checkAbort(signal);
      const outPath = join(dir, 'out.mp4');
      const st = await stat(outPath).catch(() => null);
      if (!st || !st.size) fail(500, 'render_empty', '渲染产物为空');
      // ffprobe 在位时产物必须真实可放：容器 mp4 + 时长符合预期 + 视频流在列 +
      // 预期音轨在列（hasAudio 由 filtergraph 决定）。任一不符即失败，绝不把未验证文件当成功返回。
      if (caps.ffprobeVersion != null) {
        checkAbort(signal);
        let probe;
        try {
          const pr = await call(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov',
            '-show_entries', 'stream=codec_type:format=format_name,duration', '-of', 'json', outPath],
            { timeoutMs: 15000, signal });
          probe = JSON.parse(pr.stdout);
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          fail(500, 'render_verify', '产物校验执行失败，未放行');
        }
        const fmt = probe?.format ?? {};
        const kinds = Array.isArray(probe?.streams) ? probe.streams.map(s => s?.codec_type) : [];
        if (!/mp4|mov/.test(fmt.format_name ?? '')) fail(500, 'render_verify', '产物容器不是有效 mp4');
        const outDur = Number(fmt.duration);
        if (!Number.isFinite(outDur) || Math.abs(outDur - job.duration) > 1)
          fail(500, 'render_verify', `产物时长 ${Number.isFinite(outDur) ? outDur.toFixed(2) : '未知'}s 与预期 ${job.duration.toFixed(2)}s 不符`);
        if (!kinds.includes('video')) fail(500, 'render_verify', '产物缺少视频流');
        if (hasAudio && !kinds.includes('audio')) fail(500, 'render_verify', '产物缺少预期音轨');
      } else warnings.push('无 ffprobe，产物未做容器校验');
      return { path: outPath, size: st.size, mime: 'video/mp4', duration: job.duration, warnings, cleanup };
    } catch (e) {
      await cleanup();
      throw e;
    }
  }

  async function readBody(req, cap) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > cap) fail(413, 'package_too_large', '渲染包超过大小限制');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  function writeJson(res, status, obj, headers = {}) {
    if (res.headersSent || res.writableFinished || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(obj));
  }

  // 挂载契约：app.mjs 属主在本地源校验后调用 —— handleRequest(req,res,pathname)
  async function handleRequest(req, res, pathname) {
    try {
      if (req.method === 'GET' && pathname === '/media/capabilities') {
        const caps = await detect();
        return writeJson(res, 200, {
          available: caps.available && caps.canMp4, ffmpegVersion: caps.ffmpegVersion,
          formats: caps.available ? ['mp4'] : [], filters: caps.filters,
          limits: { maxDuration: limits.maxDuration, maxPixels: limits.maxPixels, maxMediaFiles: limits.maxMediaFiles, maxMediaFileBytes: limits.maxMediaFileBytes },
        });
      }
      if (req.method === 'POST' && pathname === '/media/render') {
        // 渲染槽位在进入处理前占用：覆盖读体/解析/渲染/回流全程，finally 释放（并发慢速上传也无法穿过）
        if (busy) return writeJson(res, 429, { error: { code: 'render_busy', message: '已有渲染任务进行中，请稍后重试' } });
        busy = true;
        const ac = new AbortController();
        const onResClose = () => { if (!res.writableFinished) ac.abort(); };
        const onReqAbort = () => ac.abort();
        res.on?.('close', onResClose);       // 响应侧 close = 客户端断开（写完不算断开）
        req.on?.('aborted', onReqAbort);     // 上传途中断开同样中止渲染
        try {
          const body = await readBody(req, limits.maxPackageBytes);
          let parsed;
          try { parsed = parseRenderPackage(new Uint8Array(body)); }
          catch (e) { return writeJson(res, 400, { error: { code: 'bad_package', message: e.message } }); }
          let job;
          try { job = sanitizeRenderJob(parsed.job); }
          catch (e) { return writeJson(res, 400, { error: { code: 'bad_job', message: e.message } }); }
          const result = await render(job, parsed.files, { signal: ac.signal });
          try {
            res.writeHead(200, {
              'Content-Type': 'video/mp4', 'Content-Length': result.size,
              'Content-Disposition': 'attachment; filename="render.mp4"',
              'X-Render-Warnings': encodeURIComponent(JSON.stringify(result.warnings)),
              'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            });
            // pipeline 覆盖 finish/close/error 三态：断连或流出错即完结并回收流，槽位绝不悬挂
            await pipeline(createReadStream(result.path), res);
          } catch { try { res.destroy?.(); } catch {} }
          finally { await result.cleanup(); }
          return;
        } catch (e) {
          const status = e?.name === 'AbortError' ? 499 : e instanceof MediaError ? e.status : 500;
          const code = e instanceof MediaError ? e.code : 'render_error';
          const msg = e?.name === 'AbortError' ? '渲染已取消' : String(e.message ?? e).replaceAll(tmpRoot, '<tmp>');
          writeJson(res, status, { error: { code, message: msg } });
        } finally {
          res.off?.('close', onResClose);
          req.off?.('aborted', onReqAbort);
          busy = false;
        }
        return;
      }
      writeJson(res, 404, { error: { code: 'route_not_allowed', message: '该接口不属于媒体服务范围' } });
    } catch (e) {
      const status = e instanceof MediaError ? e.status : 500;
      const code = e instanceof MediaError ? e.code : 'render_error';
      const msg = e?.name === 'AbortError' ? '渲染已取消' : String(e.message ?? e).replaceAll(tmpRoot, '<tmp>');
      writeJson(res, status, { error: { code, message: msg } });
    }
  }

  return { capabilities: detect, render, handleRequest, limits, buildFilterGraph: (job, layout) => buildFilterGraph(job, layout) };
}
