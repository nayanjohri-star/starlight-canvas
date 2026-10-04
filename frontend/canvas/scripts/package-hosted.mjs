// 托管网页版发布物：把严格门禁验证过的 dist-hosted（/canvas/ 构建）与部署模板打成可部署的发布目录。
// 不重新构建：dist-hosted 的内容哈希须等于其 build.json 记录；正式发布（--require-clean）还须提供同一提交、
// 同一产物且全部必需层通过的严格门禁 report.json——它既证明本机形态产物（dist），也记录托管产物哈希（hostedArtifact）。
// 未附门禁证据的包在 release.json 中标记 verified:false，只能用于开发调试，不能部署。
// 用法：node scripts/package-hosted.mjs --out <目录> [--require-clean --gate-report <report.json>] [--archive]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyGateEvidence } from './package-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..', '..');
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.md', '.txt', '.css', '.html', '.svg', '.yaml', '.yml', '.caddy', '.example', '.patch', '']);
const walk = (dir, base = dir) => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [relative(base, p).replaceAll('\\', '/')];
}).sort();
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const normalize = (rel, buf) => (TEXT_EXT.has(extname(rel).toLowerCase()) ? Buffer.from(buf.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8') : buf);
const git = args => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });

export function verifyHostedEvidence(hostedBuild, report, commit) {
  const reject = reason => { throw new Error(`托管门禁证据无效：${reason}`); };
  if (hostedBuild.mode !== 'hosted') reject('产物不是托管构建');
  if (report?.hostedBuild?.mode !== 'hosted' || report.hostedBuild.sourceCommit !== commit || hostedBuild.sourceCommit !== commit) reject('托管构建提交不一致');
  if (report.hostedArtifact?.before !== hostedBuild.contentHash || report.hostedArtifact?.after !== hostedBuild.contentHash
    || report.hostedBuild.contentHash !== hostedBuild.contentHash) reject('托管产物哈希不一致');
  if (report.hostedBuild.basePath !== hostedBuild.basePath || report.hostedBuild.apiBase !== hostedBuild.apiBase) reject('托管基础路径或 API 根不一致');
  return true;
}

export async function packageHosted({ out, requireClean = false, gateReport = null, archive = false, log = console.log } = {}) {
  if (!out) throw new Error('必须用 --out 指定输出目录（发布物不写入源码目录）');
  const hostedDir = join(ROOT, 'dist-hosted'), localDir = join(ROOT, 'dist');
  if (!existsSync(join(hostedDir, 'build.json'))) throw new Error('dist-hosted/build.json 不存在：请先运行严格门禁（它会构建托管产物）');
  const hosted = JSON.parse(readFileSync(join(hostedDir, 'build.json'), 'utf8'));
  const { distContentHash } = await import(pathToFileURL(join(ROOT, 'scripts', 'build.mjs')).href);
  if (await distContentHash(hostedDir) !== hosted.contentHash) throw new Error('dist-hosted 内容与其 build.json 不一致：拒绝打包未经验证的产物');
  let gate = null;
  if (requireClean) {
    if (hosted.sourceDirty !== false) throw new Error('托管产物来自有未提交改动的工作区，正式发布物必须从干净提交构建');
    if (!gateReport) throw new Error('正式打包必须提供 --gate-report（同一提交的严格门禁 report.json）');
    const head = git(['rev-parse', 'HEAD']), state = git(['status', '--porcelain', '--', '.', '../director', '../../docs/星盘AI_视频模型能力表.json', '../../deploy/canvas-web', '../../deploy/canvas-hosted-api']);
    if (head.status !== 0 || state.status !== 0 || state.stdout.trim()) throw new Error('源码或部署模板有未提交改动，拒绝正式打包');
    const bytes = readFileSync(resolve(gateReport));
    const report = JSON.parse(bytes.toString('utf8'));
    const local = JSON.parse(readFileSync(join(localDir, 'build.json'), 'utf8'));
    verifyGateEvidence(local, report, head.stdout.trim());
    verifyHostedEvidence(hosted, report, head.stdout.trim());
    gate = { reportSha256: sha256(bytes), ok: report.gate.ok, generatedAt: report.generatedAt ?? null,
      layers: report.layers.map(l => ({ layer: l.layer, outcome: l.outcome, required: l.required })) };
  }
  const name = `canvas-web-${hosted.version}-${String(hosted.sourceCommit ?? 'unknown').slice(0, 7)}${gate ? '' : '-UNVERIFIED'}`;
  const dest = join(resolve(out), name);
  if (existsSync(dest)) throw new Error(`发布目录已存在，拒绝覆盖：${dest}`);
  const files = new Map();
  for (const rel of walk(hostedDir)) files.set(`site/canvas/${rel}`, normalize(rel, readFileSync(join(hostedDir, rel))));
  // 托管 API 适配层（Sol，deploy/canvas-hosted-api/server.mjs）：单文件、无依赖，与静态产物同版本发布
  files.set('api/server.mjs', normalize('server.mjs', readFileSync(join(REPO, 'deploy', 'canvas-hosted-api', 'server.mjs'))));
  files.set('api/image-jobs.mjs', normalize('image-jobs.mjs', readFileSync(join(REPO, 'deploy', 'canvas-hosted-api', 'image-jobs.mjs'))));
  for (const rel of walk(join(REPO, 'deploy', 'canvas-web'))) files.set(`deploy/${rel}`, normalize(rel, readFileSync(join(REPO, 'deploy', 'canvas-web', rel))));
  const release = {
    kind: 'canvas-web-release', verified: Boolean(gate), version: hosted.version, sourceCommit: hosted.sourceCommit,
    contentHash: hosted.contentHash, basePath: hosted.basePath, apiBase: hosted.apiBase, capabilityVersion: hosted.capabilityVersion,
    files: files.size, gate,
    note: gate ? '严格门禁已通过（见 gate）；部署前仍需完成 deploy/README.md 第 8 节列出的环境输入与批准。' : '未附严格门禁证据：仅供开发调试，不得部署。',
  };
  files.set('release.json', Buffer.from(JSON.stringify(release, null, 2) + '\n'));
  for (const [rel, buf] of files) { mkdirSync(dirname(join(dest, rel)), { recursive: true }); writeFileSync(join(dest, rel), buf); }
  const sums = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([rel, buf]) => `${sha256(buf)}  ${rel}`).join('\n') + '\n';
  writeFileSync(join(dest, 'SHA256SUMS'), sums);
  const result = { name, dir: dest, files: files.size, verified: release.verified, contentHash: hosted.contentHash, sumsSha256: sha256(Buffer.from(sums)), archive: null };
  if (archive) {
    const r = spawnSync('tar', ['-czf', `${name}.tgz`, name], { cwd: resolve(out), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar 打包失败：${r.stderr || r.error?.message}`);
    result.archive = join(resolve(out), `${name}.tgz`);
    result.archiveSha256 = sha256(readFileSync(result.archive));
  }
  writeFileSync(join(resolve(out), `${name}.json`), JSON.stringify(result, null, 2) + '\n');
  log(`托管发布物 → ${dest}（${files.size} 个文件，${release.verified ? '已附门禁证据' : '未验证'}，SHA256SUMS ${result.sumsSha256.slice(0, 12)}）`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
  try {
    await packageHosted({ out: arg('--out'), requireClean: process.argv.includes('--require-clean'), gateReport: arg('--gate-report'), archive: process.argv.includes('--archive') });
  } catch (e) { console.error(`托管打包失败：${e.message}`); process.exitCode = 1; }
}
