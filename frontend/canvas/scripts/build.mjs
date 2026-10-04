// 零依赖构建：src/ + public/ 原样拷贝到 dist/，能力表从 docs/ 拷入。
// 画布全部为原生 ES module + 外链 CSS，满足父页 CSP script-src 'self'（无内联脚本）。
//
// 构建期防线：固定合同副本完整（哈希）且画布能力表与它逐项一致，否则拒绝产出。
// 构建身份可复现：builtAt 取 SOURCE_DATE_EPOCH 或源码提交时间（不用当前时钟）；
// contentHash 为 dist 业务文件（文本按 LF 归一）的 SHA-256，同一源码重复构建必须一致。
import { rm, mkdir, readdir, copyFile, stat, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { loadPinnedContract, compareTableToContract } from './lib/capability-contract.mjs';
import { SERVER_API_LEVEL } from '../server/app.mjs';
import { resolveRuntime, runtimeModuleSource } from './lib/runtime-config.mjs';
import { buildZip } from '../../director/src/zip-store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src');
const PUBLIC = join(root, 'public');
const DIRECTOR_ROOT = resolve(root, '../director');
// 运行形态：--mode local|hosted（或 CANVAS_BUILD_MODE）；托管另可 --base / --api-base / --ready-url（均为站内路径并经校验）
const argOf = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const MODE = argOf('--mode') ?? process.env.CANVAS_BUILD_MODE ?? 'local';
const DIST = resolve(argOf('--out') ?? process.env.CANVAS_BUILD_OUT ?? join(root, MODE === 'hosted' ? 'dist-hosted' : 'dist'));
// 托管产物不含只属于本机形态的文件（导演台宿主 SDK）
const LOCAL_ONLY = new Set(['__hub-sdk__.js']);
const CAPABILITY_SOURCE = resolve(root, '../../docs/星盘AI_视频模型能力表.json');
// 构建后生成的身份文件：不参与 contentHash（它们描述内容，不是内容本身）
export const GENERATED_IDENTITY = new Set(['build.json', 'build-info.js']);

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const s = join(from, entry.name), d = join(to, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await copyFile(s, d);
  }
}
async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(p, base));
    else if (entry.isFile()) out.push(relative(base, p).replaceAll('\\', '/'));
  }
  return out.sort();
}
async function sourceFiles(dir) {
  if (!await stat(dir).catch(() => null)) return [];
  const result = spawnSync('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '--', '.'],
    { encoding: 'utf8', windowsHide: true });
  const files = result.status === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  if (files.length) return files.sort();
  // Git-free community source builds must not walk installed dependencies or
  // their own generated distributions when preparing the source download.
  const walk = async (path, base = path) => {
    const out = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (/^(?:node_modules|dist|dist-hosted|\.git|\.vite|\.release-evidence|_temp|outputs|logs|shots|test-results|release-packages|playwright-report)$/.test(entry.name)) continue;
      const p = join(path, entry.name);
      if (entry.isDirectory()) out.push(...await walk(p, base));
      else if (entry.isFile()) out.push(relative(base, p).replaceAll('\\', '/'));
    }
    return out.sort();
  };
  return walk(dir);
}
const TEXT_EXT = /(?:\.(?:js|mjs|cjs|jsx|ts|tsx|css|html|json|svg|txt|md|py|yml|yaml|toml|ps1|sh|caddy|go|patch|obj|usda|otio)|\.env\.example|(?:^|\/)(?:LICENSE[^/]*|NOTICE[^/]*|Caddyfile(?:\.[^/]+)?|Dockerfile(?:\.[^/]+)?|\.gitignore))$/i;
export function normalizedText(path, bytes) {
  // FBX has ASCII and binary encodings; OBJ can also name a binary object
  // file. Decode only declared, NUL-free UTF-8 text without replacing bytes.
  const textPath = TEXT_EXT.test(path) || /\.fbx$/i.test(path);
  return textPath && !bytes.includes(0) && isUtf8(bytes)
    ? Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8') : bytes;
}
export async function distContentHash(dir) {
  const h = createHash('sha256');
  for (const rel of await listFiles(dir)) {
    if (GENERATED_IDENTITY.has(rel.split('/').at(-1))) continue;
    let buf = await readFile(join(dir, rel));
    buf = normalizedText(rel, buf);
    h.update(rel).update('\n').update(createHash('sha256').update(buf).digest('hex')).update('\n');
  }
  return h.digest('hex');
}
const git = args => {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (top.status !== 0 || resolve(top.stdout.trim()).toLowerCase() !== resolve(root, '../..').toLowerCase()) return null;
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stat(CAPABILITY_SOURCE).catch(() => { throw new Error(`缺少能力表：${CAPABILITY_SOURCE}`); });
  const table = JSON.parse((await readFile(CAPABILITY_SOURCE, 'utf8')).replace(/^﻿/, ''));
  const pinned = await loadPinnedContract(root);
  const problems = [...pinned.problems, ...compareTableToContract(table, pinned.contract)];
  if (problems.length) throw new Error(`能力表与固定合同不一致，拒绝构建：\n  - ${problems.join('\n  - ')}`);
  for (const [id, m] of Object.entries(table.models ?? {})) {
    const unit = m.billing_unit ?? table.billing_unit;
    const price = unit === 'request' ? m.price_cny_per_request : m.price_cny_per_second;
    if (!['request', 'second'].includes(unit) || !(Number.isFinite(price) && price > 0)) throw new Error(`能力表型号 ${id} 计价不完整`);
  }

  const runtime = resolveRuntime({ mode: MODE, basePath: argOf('--base') ?? process.env.CANVAS_BASE_PATH, apiBase: argOf('--api-base') ?? process.env.CANVAS_API_BASE, readyUrl: argOf('--ready-url') ?? process.env.CANVAS_READY_URL });
  const archivedIdentity = await readFile(resolve(root, '../../SOURCE-VERSION.json'), 'utf8').then(JSON.parse).catch(() => null);
  const sourceCommit = git(['rev-parse', 'HEAD']) ?? archivedIdentity?.sourceCommit ?? null;
  const liveGit = git(['rev-parse', 'HEAD']);
  const dirty = liveGit ? Boolean(git(['status', '--porcelain', '--', '.', '../director', '../../deploy/canvas-web', '../../deploy/canvas-hosted-api', '../../docs/director', '../../docs/星盘AI_视频模型能力表.json'])) : archivedIdentity?.sourceDirty ?? null;
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const builtAt = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString()
    : (liveGit ? new Date(git(['log', '-1', '--format=%cI']) || 0).toISOString() : archivedIdentity?.builtAt ?? null);
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await copyDir(SRC, DIST);
  await copyDir(PUBLIC, DIST);
  // The hosted editor is a required component, never the optional local
  // MiniMax plugin. Fail the build if its pinned dependencies cannot build.
  const dependencyNotices = spawnSync(process.execPath,
    [join(DIRECTOR_ROOT, 'tools/dependency-notices.mjs'), '--verify'],
    { cwd: DIRECTOR_ROOT, encoding: 'utf8', windowsHide: true });
  if (dependencyNotices.status !== 0) throw new Error(`导演台依赖许可清单不完整或与锁文件不一致：${dependencyNotices.stderr || dependencyNotices.stdout}`);
  const unicodeFonts = spawnSync(process.execPath,
    [join(DIRECTOR_ROOT, 'tools/build-unicode-fonts.mjs')],
    { cwd: DIRECTOR_ROOT, encoding: 'utf8', windowsHide: true });
  if (unicodeFonts.status !== 0) throw new Error(`导演台本地字体生成失败：${unicodeFonts.stderr || unicodeFonts.stdout}`);
  const directorBuild = spawnSync(process.execPath,
    [join(DIRECTOR_ROOT, 'node_modules/vite/bin/vite.js'), 'build'],
    { cwd: DIRECTOR_ROOT, encoding: 'utf8', windowsHide: true });
  if (directorBuild.status !== 0) throw new Error(`导演台构建失败：${directorBuild.stderr || directorBuild.stdout}`);
  const bundledFonts = spawnSync(process.execPath,
    [join(DIRECTOR_ROOT, 'tools/verify-bundled-fonts.mjs')],
    { cwd: DIRECTOR_ROOT, encoding: 'utf8', windowsHide: true });
  if (bundledFonts.status !== 0) throw new Error(`导演台字体产物校验失败：${bundledFonts.stderr || bundledFonts.stdout}`);
  await copyDir(join(DIRECTOR_ROOT, 'dist'), join(DIST, 'director'));
  const sourceEntries = [];
  for (const [directory, prefix] of [[DIRECTOR_ROOT, 'frontend/director/'], [root, 'frontend/canvas/'],
    [resolve(root, '../../deploy/canvas-web'), 'deploy/canvas-web/'],
    [resolve(root, '../../deploy/canvas-hosted-api'), 'deploy/canvas-hosted-api/'],
    [resolve(root, '../../docs/director'), 'docs/director/']]) {
    for (const file of await sourceFiles(directory)) {
      if (directory === DIRECTOR_ROOT && file.startsWith('public/fonts/unicode-local/')) continue; // rebuilt from the licensed font input, including in Git-free source builds
      if (/(^|\/)(node_modules|dist|dist-hosted|\.vite|\.git|\.release-evidence|_temp|outputs|logs|test-results|release-packages|playwright-report)(\/|$)/.test(file) ||
          /(^|\/)(\.env|cookies|secrets|sessions)(\.|\/|$)/i.test(file) || /\.(key|pem|pfx|har|dump|tgz|bak)$/i.test(file)) continue;
      const data = await readFile(join(directory, file)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (data) sourceEntries.push({ name: prefix + file, data: new Uint8Array(normalizedText(file, data)) });
    }
  }
  // The source archive also carries the fixed contract used by the canvas build.
  sourceEntries.push({ name: 'docs/星盘AI_视频模型能力表.json', data: new Uint8Array(normalizedText(CAPABILITY_SOURCE, await readFile(CAPABILITY_SOURCE))) });
  sourceEntries.push({ name: 'SOURCE-VERSION.json', data: new TextEncoder().encode(JSON.stringify({
    sourceCommit, sourceDirty: dirty, builtAt,
    cozyclay: JSON.parse(await readFile(join(DIRECTOR_ROOT, 'UPSTREAM.json'), 'utf8')).commit,
  })) });
  await writeFile(join(DIST, 'director', 'source.zip'), buildZip(sourceEntries));
  await copyFile(CAPABILITY_SOURCE, join(DIST, 'capabilities.json'));
  await writeFile(join(DIST, 'runtime-config.js'), runtimeModuleSource(runtime));
  if (runtime.mode === 'hosted') {
    for (const f of LOCAL_ONLY) await rm(join(DIST, f), { force: true });
    const html = await readFile(join(DIST, 'index.html'), 'utf8');
    await writeFile(join(DIST, 'index.html'), html.replace('<body>', '<body data-session-pending>\n<div id="hosted-bootstrap" class="hosted-gate-mask"><section class="hosted-gate"><h2>星光智能画布</h2><p role="status">正在确认账号登录…</p><noscript>请启用 JavaScript 后刷新页面。</noscript></section></div>'));
  }

  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  // Pin the entire module/worker/CSS graph to one immutable directory. Retain
  // these directories across rollout and rollback (see deployment README).
  let assetPath = null;
  if (runtime.mode === 'hosted') {
    const assetId = createHash('sha256').update(`${await distContentHash(DIST)}\n${sourceCommit}\n${builtAt}\n${dirty}`).digest('hex');
    assetPath = `releases/${assetId}/`;
    const originalFiles = await listFiles(DIST);
    for (const rel of originalFiles) {
      const target = join(DIST, assetPath, rel);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(DIST, rel), target);
    }
    const html = await readFile(join(DIST, 'index.html'), 'utf8');
    await writeFile(join(DIST, 'index.html'), html.replace('<head>', `<head>\n  <base href="./${assetPath}">`));
  }
  const contentHash = await distContentHash(DIST);
  const identity = {
    version, builtAt, sourceCommit, sourceDirty: dirty, contentHash,
    models: Object.keys(table.models).length, capabilityVersion: table.version,
    requiresServerApi: SERVER_API_LEVEL,
    mode: runtime.mode, basePath: runtime.basePath, apiBase: runtime.apiBase, assetPath,
  };
  await writeFile(join(DIST, 'build.json'), JSON.stringify(identity));
  await writeFile(join(DIST, 'build-info.js'),
    '// 由 scripts/build.mjs 生成：页面实际加载的构建身份。\n' +
    `export const BUILD = Object.freeze(${JSON.stringify({ version, builtAt, sourceCommit, sourceDirty: dirty, contentHash, capabilityVersion: table.version, requiresServerApi: SERVER_API_LEVEL, mode: runtime.mode })});\n`);
  if (assetPath) for (const file of GENERATED_IDENTITY)
    await copyFile(join(DIST, file), join(DIST, assetPath, file));
  console.log(`画布构建完成（${runtime.mode}${runtime.mode === 'hosted' ? ` ${runtime.basePath}` : ''}） → ${relative(process.cwd(), DIST) || '.'}（${identity.models} 个型号，能力版本 ${table.version}，内容 ${contentHash.slice(0, 12)}${dirty ? '，工作区有未提交改动' : ''}）`);
}
