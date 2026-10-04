// 发布打包：把「已构建且经门禁验证」的 dist 连同本机服务打成可独立运行的发布包。
// 不重新构建：dist 的内容哈希必须等于 dist/build.json 记录的 contentHash，否则拒绝打包（防止打入未验证产物）。
// 包内容：dist/（前端产物）、server/*.mjs（不含测试）、src/（服务端运行时依赖的共享模块）、contracts/、
// 精简 package.json（仅 start，无开发依赖）、运行说明 README-运行.md、SHA256SUMS（标准 sha256sum 格式）。
// 文本文件统一 LF，保证同一提交在 Windows 与 Linux 打出的包逐字节一致。
// 用法：node scripts/package-release.mjs [--out <dir>] [--require-clean --gate-report <report.json>] [--archive]
//   --require-clean：正式打包须有同一提交、同一产物且全部必需层通过的严格门禁报告
//   --archive：另外生成 <包名>.tgz（使用系统 tar）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LAYERS } from './release-gate.config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_CONFIG = join(ROOT, 'scripts', 'release-gate.config.mjs');
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.html', '.svg', '.webmanifest']);
const EXCLUDE = [/\.test\.mjs$/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.release-evidence(\/|$)/, /(^|\/)\.DS_Store$/];

const walk = (dir, base = dir) => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [relative(base, p).replaceAll('\\', '/')];
}).sort();
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const normalize = (rel, buf) => (TEXT_EXT.has(extname(rel).toLowerCase()) ? Buffer.from(buf.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8') : buf);
const git = args => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });

export function verifyGateEvidence(build, report, currentCommit) {
  const reject = reason => { throw new Error(`严格门禁证据无效：${reason}`); };
  if (report?.kind !== 'canvas-release-gate' || report.mode !== 'strict') reject('报告类型或模式不符');
  if (report.config?.path !== 'scripts/release-gate.config.mjs'
    || report.config?.sha256 !== sha256(readFileSync(GATE_CONFIG))) reject('门禁配置不符');
  if (report.source?.dirty !== false || Object.keys(report.envOverride ?? {}).length) reject('报告来自脏工作区或环境覆盖');
  if (report.source?.sha !== currentCommit || report.build?.sourceCommit !== currentCommit
    || report.build?.sourceDirty !== false || build.sourceCommit !== currentCommit) reject('源码提交不一致');
  if (report.version !== build.version || report.build?.version !== build.version
    || report.capabilityVersion !== build.capabilityVersion) reject('版本或能力合同不一致');
  if (report.artifact?.before !== build.contentHash || report.artifact?.after !== build.contentHash
    || report.build?.contentHash !== build.contentHash) reject('构建产物哈希不一致');
  if (report.gate?.ok !== true || !Array.isArray(report.gate.blockers) || report.gate.blockers.length)
    reject('严格门禁未通过');
  if (!Array.isArray(report.layers)) reject('缺少逐层验收结果');
  for (const layer of LAYERS.filter(l => l.required !== false)) {
    const matches = (report.layers ?? []).filter(r => r.layer === layer.name);
    if (matches.length !== 1 || matches[0].required !== true || matches[0].ok !== true || matches[0].outcome !== 'passed')
      reject(`必需层 ${layer.name} 未完整通过`);
  }
  return true;
}

export async function packageRelease({ out = join(ROOT, 'release-packages'), requireClean = false, gateReport = null, archive = false, log = console.log } = {}) {
  const dist = join(ROOT, 'dist');
  if (!existsSync(join(dist, 'build.json'))) throw new Error('dist/build.json 不存在：请先构建并通过门禁');
  const build = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'));
  const { distContentHash } = await import(pathToFileURL(join(ROOT, 'scripts', 'build.mjs')).href);
  const actual = await distContentHash(dist);
  if (actual !== build.contentHash) throw new Error(`dist 内容哈希 ${actual.slice(0, 12)} 与 build.json 记录 ${String(build.contentHash).slice(0, 12)} 不一致：拒绝打包未经验证的产物`);
  let gateReportSha256 = null;
  if (requireClean) {
    if (build.sourceDirty !== false) throw new Error('dist 来自有未提交改动的工作区（sourceDirty），正式发布包必须从干净提交构建');
    if (!gateReport) throw new Error('正式打包必须提供 --gate-report，指向同版本严格门禁的 report.json');
    const head = git(['rev-parse', 'HEAD']);
    const state = git(['status', '--porcelain', '--', '.', '../director', '../../docs/星盘AI_视频模型能力表.json']);
    if (head.status !== 0 || state.status !== 0 || state.stdout.trim()) throw new Error('当前源码工作区未提交或 Git 状态不可核验，拒绝正式打包');
    const bytes = readFileSync(resolve(gateReport));
    let report;
    try { report = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('严格门禁 report.json 无法解析'); }
    verifyGateEvidence(build, report, head.stdout.trim());
    gateReportSha256 = sha256(bytes);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (pkg.version !== build.version) throw new Error(`package.json 版本 ${pkg.version} 与 dist 构建版本 ${build.version} 不一致`);
  const commit = String(build.sourceCommit ?? 'unknown').slice(0, 7);
  const name = `xingpan-canvas-${pkg.version}-${commit}`;
  const outRoot = resolve(out), dest = resolve(outRoot, name);
  const inside = relative(outRoot, dest);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('发布包目标路径超出输出目录');
  if (existsSync(dest) || existsSync(join(outRoot, `${name}.json`))) throw new Error('发布包目标已存在，请指定新的 --out 目录，避免覆盖已有包');

  const files = new Map();
  const add = (rel, buf) => { if (EXCLUDE.some(re => re.test(rel))) return; files.set(rel, normalize(rel, buf)); };
  for (const [dir, prefix] of [['dist', 'dist'], ['server', 'server'], ['src', 'src'], ['contracts', 'contracts']])
    for (const rel of walk(join(ROOT, dir))) add(`${prefix}/${rel}`, readFileSync(join(ROOT, dir, rel)));
  // 精简运行时 package.json：无依赖、无开发依赖、仅 start
  add('package.json', Buffer.from(JSON.stringify({
    name: pkg.name, version: pkg.version, private: true, type: 'module', description: pkg.description,
    engines: pkg.engines, scripts: { start: 'node server/main.mjs' },
  }, null, 2) + '\n'));
  add('README-运行.md', Buffer.from(readme({ version: pkg.version, build })));
  for (const [rel] of files) if (/\.test\.mjs$/.test(rel)) throw new Error(`包内混入测试文件：${rel}`);

  for (const [rel, buf] of files) { mkdirSync(dirname(join(dest, rel)), { recursive: true }); writeFileSync(join(dest, rel), buf); }
  const sums = [...files].map(([rel, buf]) => `${sha256(buf)}  ${rel}`).join('\n') + '\n';
  writeFileSync(join(dest, 'SHA256SUMS'), sums);
  const packageHash = sha256(Buffer.from(sums));
  const result = { name, dir: dest, files: files.size, version: pkg.version, sourceCommit: build.sourceCommit, contentHash: build.contentHash,
    packageHash, gateReportSha256, archive: null };
  if (archive) {
    const tgz = `${name}.tgz`;
    const r = spawnSync('tar', ['-czf', tgz, name], { cwd: out, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar 打包失败：${r.stderr || r.error?.message}`);
    result.archive = join(out, tgz);
    result.archiveSha256 = sha256(readFileSync(result.archive));
  }
  writeFileSync(join(out, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
  log(`发布包 → ${dest}（${files.size} 个文件，SHA256SUMS 摘要 ${packageHash.slice(0, 12)}${result.archive ? `，归档 ${result.archiveSha256.slice(0, 12)}` : ''}）`);
  return result;
}

function readme({ version, build }) {
  return `# 星盘智能画布 ${version} · 本机运行说明

构建：提交 \`${build.sourceCommit}\`，能力合同 ${build.capabilityVersion}，内容哈希 \`${build.contentHash}\`。

## 环境要求
- Node.js 24 或更高版本（本版本在 Node 24 上验收）。
- 可选：FFmpeg 与 FFprobe 在 PATH 中时，时间线可导出 MP4（本机渲染）；缺少时使用浏览器导出（WebM）。
- 现代 Chromium 内核浏览器（Chrome / Edge）。

## 安装与启动
1. 校验文件：\`sha256sum -c SHA256SUMS\`（Windows 可用 \`Get-FileHash\` 逐个比对）。
2. 本包没有运行时依赖；可执行 \`npm install --omit=dev\`，该步骤不会下载任何内容。
3. 启动：\`npm start\`（或 \`node server/main.mjs --port 4178\`）。
4. 浏览器打开 \`http://127.0.0.1:4178\`，在页面中输入本站 API Key 后使用。

## 说明与边界
- 服务只监听本机回环地址 127.0.0.1，是单用户本机工具，**不是多用户托管服务**。不要改成 0.0.0.0 或套反向代理对外提供（见源码仓库 \`docs/open-source/SECURITY.md\`）。
- API Key 只保存在当前浏览器会话中，服务端不存储；刷新页面后需要重新输入。
- 项目与成片保存在本机浏览器（IndexedDB）中；请用“导出工程包”定期备份。
- 3D 导演台已随包提供，点击后按需加载。摆场、预览、保存、PNG/MP4 导出无需本机插件，也不会调用收费模型。页脚提供本版本的完整对应源码。
- 账户工作区依赖尚未部署的站点身份接口，当前不可用；本地项目不受影响。
- 页面上的价格与预算均为本地估算，不是实际扣费。
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
  try {
    await packageRelease({ out: resolve(arg('--out') ?? join(ROOT, 'release-packages')),
      requireClean: process.argv.includes('--require-clean'), gateReport: arg('--gate-report'), archive: process.argv.includes('--archive') });
  } catch (e) { console.error(`打包失败：${e.message}`); process.exitCode = 1; }
}
