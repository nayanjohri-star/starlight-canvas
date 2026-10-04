// 严格发布门禁：npm run verify:release:strict
//
//  1. 前置：记录源码 SHA 与工作区状态（严格模式要求已提交；--allow-dirty 仅供开发，报告标记为不可发布）；
//  2. 只构建一次，记录产物内容哈希；所有层都对同一产物运行（--no-build + CANVAS_TEST_DIST），结束时复核哈希；
//  3. 逐层运行 node --test，JSONL 报告器逐条记录用例；测试进程预加载 block-egress，主动阻断非本机网络；
//  4. 判定（scripts/lib/release-gate-core.mjs）：必需层的任何缺失/未运行/77/非零/异常终止/解析失败/
//     报告不完整/零测试/失败/未登记跳过都使整体失败；
//  5. 报告与日志写到外部证据目录（默认 .release-evidence/，已被 .gitignore 排除），不提交进源码。
//
// 用法：node scripts/release-gate.mjs [--out 目录] [--allow-dirty] [--layers a,b]（仅开发：部分运行视为不可发布）
//       [--config 路径]（门禁自测用） [--env-override browser=0,ffmpeg=0]（门禁自测用：报告标记为不可发布）
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateLayer, evaluateGate, overlapReport } from './lib/release-gate-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flag = name => args.includes(name);
const configPath = resolve(opt('--config') ?? join(ROOT, 'scripts', 'release-gate.config.mjs'));
const envOverride = Object.fromEntries((opt('--env-override') ?? '').split(',').filter(Boolean).map(kv => { const [k, v] = kv.split('='); return [k, v === '1' || v === 'true']; }));
const onlyLayers = opt('--layers')?.split(',').filter(Boolean) ?? null;
const allowDirty = flag('--allow-dirty');
const git = a => { const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.trim() : null; };
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', windowsHide: true, timeout: 20000, ...o });
const sha256File = p => createHash('sha256').update(readFileSync(p)).digest('hex');

const config = await import(pathToFileURL(configPath).href);
const LAYERS = config.LAYERS;
const allowlist = typeof config.loadSkipAllowlist === 'function' ? await config.loadSkipAllowlist() : (config.SKIP_ALLOWLIST ?? []);
const testRoot = resolve(config.TEST_ROOT ?? ROOT);

// ---------- 前置信息 ----------
const sha = git(['rev-parse', 'HEAD']);
const dirtyList = git(['status', '--porcelain', '--', '.', '../director', '../../deploy/canvas-web', '../../docs/星盘AI_视频模型能力表.json']) ?? '';
const dirty = dirtyList.length > 0;
const outDir = resolve(opt('--out') ?? join(ROOT, '.release-evidence', `${(sha ?? 'nosha').slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
mkdirSync(join(outDir, 'layers'), { recursive: true });

async function probeEnvironment() {
  const { probeEnv } = await import(pathToFileURL(join(ROOT, 'scripts', 'env-check.mjs')).href);
  const e = probeEnv();
  const env = { browser: Boolean(e.summary.e2e), ffmpeg: Boolean(e.summary.media), director: Boolean(e.summary.director) };
  return { env: { ...env, ...envOverride }, raw: e };
}
const { env, raw: rawEnv } = await probeEnvironment();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lockPath = join(ROOT, 'package-lock.json');
const versions = {
  node: process.version,
  npm: rawEnv.probes?.npm?.version ?? null,
  playwrightCore: rawEnv.probes?.playwrightCore?.version ?? null,
  browser: { path: rawEnv.probes?.browser?.path ?? null, version: rawEnv.probes?.browser?.version ?? null, via: rawEnv.probes?.browser?.via ?? null },
  ffmpeg: rawEnv.probes?.ffmpeg?.version ?? null, ffprobe: rawEnv.probes?.ffprobe?.version ?? null,
  platform: `${process.platform} ${process.arch}`,
};

// ---------- 单次构建 ----------
let artifact = { before: null, after: null };
// A self-test with its own test root owns its own outputs. Rebuilding the
// ordinary dist here would race packaging tests and replace a frozen candidate.
const artifactRoot = testRoot === ROOT ? ROOT : join(outDir, 'artifacts');
const distDir = join(artifactRoot, 'dist');
const build = run(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--out', distDir], { timeout: 120000, cwd: ROOT });
writeFileSync(join(outDir, 'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`);
const { distContentHash } = await import(pathToFileURL(join(ROOT, 'scripts', 'build.mjs')).href);
if (build.status === 0) artifact.before = await distContentHash(distDir);
const buildInfo = build.status === 0 ? JSON.parse(readFileSync(join(distDir, 'build.json'), 'utf8')) : null;
// 托管产物：同一源码的第二个构建形态（/canvas/），同样只构建一次、前后核对哈希；托管验收测试经 CANVAS_HOSTED_DIST 使用它
const hostedDir = join(artifactRoot, 'dist-hosted');
const hostedBuild = run(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--mode', 'hosted', '--out', hostedDir], { timeout: 120000, cwd: ROOT });
writeFileSync(join(outDir, 'build-hosted.log'), `${hostedBuild.stdout ?? ''}${hostedBuild.stderr ?? ''}`);
const hostedArtifact = { before: hostedBuild.status === 0 ? await distContentHash(hostedDir) : null, after: null };
const hostedInfo = hostedBuild.status === 0 ? JSON.parse(readFileSync(join(hostedDir, 'build.json'), 'utf8')) : null;

// ---------- 文件清单 ----------
function layerFiles(layer) {
  const listed = new Set(), missing = [];
  for (const f of layer.requiredFiles ?? []) {
    if (existsSync(join(testRoot, f))) listed.add(f); else missing.push(f);
  }
  for (const d of layer.discover ?? []) {
    const dir = join(testRoot, d.dir);
    if (!existsSync(dir)) { missing.push(`${d.dir}/`); continue; }
    for (const f of readdirSync(dir).filter(n => n.endsWith('.test.mjs') && d.match(n)).sort()) listed.add(`${d.dir}/${f}`);
  }
  return { listed: [...listed], missing };
}

// ---------- 逐层运行 ----------
const egressHook = pathToFileURL(join(ROOT, 'scripts', 'lib', 'block-egress.mjs')).href;
const reporter = pathToFileURL(join(ROOT, 'scripts', 'lib', 'jsonl-reporter.mjs')).href;
function runLayer(layer, files) {
  return new Promise(resolveRun => {
    const reportPath = join(outDir, 'layers', `${layer.name}.jsonl`);
    const logPath = join(outDir, 'layers', `${layer.name}.log`);
    const argv = ['--test', `--test-concurrency=${layer.concurrency ?? 8}`,
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${reporter}`, `--test-reporter-destination=${reportPath}`, ...files];
    const envVars = { ...process.env, ...(layer.env ?? {}),
      CANVAS_TEST_DIST: distDir, CANVAS_HOSTED_DIST: hostedDir,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${egressHook}`.trim() };
    // 门禁本身若在另一个 node --test 进程中启动，会继承 NODE_TEST_CONTEXT，使子运行器进入「子进程模式」
    // 而忽略报告器，产出空报告。层进程必须是独立的顶层测试运行。
    delete envVars.NODE_TEST_CONTEXT;
    const log = createWriteStream(logPath);
    const started = Date.now();
    let child;
    try { child = spawn(process.execPath, argv, { cwd: testRoot, env: envVars, windowsHide: true }); }
    catch (e) { resolveRun({ run: { ran: false, spawnError: e.message }, command: [process.execPath, ...argv], reportPath, logPath }); return; }
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    const limit = (layer.timeoutMin ?? 30) * 60000;
    const timer = setTimeout(() => child.kill('SIGKILL'), limit);
    child.on('close', (status, signal) => {
      clearTimeout(timer); log.end();
      resolveRun({ run: { ran: true, status, signal, ms: Date.now() - started }, command: ['node', ...argv.map(a => a.replaceAll(ROOT, '.'))], reportPath, logPath });
    });
  });
}

const results = [];
for (const layer of LAYERS) {
  const files = layerFiles(layer);
  const selected = !onlyLayers || onlyLayers.includes(layer.name);
  const unmet = (layer.requires ?? []).filter(c => !env[c]);
  let exec = { run: { ran: false } };
  if (!selected) exec = { run: { ran: false, spawnError: '本次未选择该层（部分运行）' } };
  else if (build.status !== 0) exec = { run: { ran: false, spawnError: '构建失败，未运行' } };
  else if (unmet.length && layer.required !== false) exec = { run: { ran: false, spawnError: `环境缺失：${unmet.join(', ')}` } };
  else if (unmet.length) exec = { run: { ran: false, spawnError: `可选层环境缺失：${unmet.join(', ')}` } };
  else if (files.listed.length) {
    process.stdout.write(`[gate] ${layer.name}：${files.listed.length} 个文件…\n`);
    exec = await runLayer(layer, files.listed);
    if (exec.run.ran && exec.run.status === 0) for (const script of layer.postVerify ?? []) {
      const v = run(process.execPath, [join(ROOT, script)], { cwd: ROOT, timeout: 120000, env: { ...process.env, CANVAS_TEST_DIST: distDir, CANVAS_HOSTED_DIST: hostedDir } });
      if (v.status !== 0) { exec.run.status = v.status ?? 1; exec.postVerifyError = `${script}：${(v.stdout ?? '') + (v.stderr ?? '')}`.slice(0, 2000); }
    }
  }
  const reportText = exec.reportPath && existsSync(exec.reportPath) ? readFileSync(exec.reportPath, 'utf8') : '';
  const r = evaluateLayer({ layer, env, run: exec.run, files, reportText, allowlist });
  if (exec.postVerifyError) r.problems.push({ code: 'post_verify_failed', detail: exec.postVerifyError }), r.ok = false, r.outcome = r.required ? 'failed' : r.outcome;
  r.command = exec.command ?? null; r.exitCode = exec.run.status ?? null; r.signal = exec.run.signal ?? null; r.ms = exec.run.ms ?? null;
  r.files = files.listed; r.missingFiles = files.missing;
  r.logPath = exec.logPath ? relative(outDir, exec.logPath) : null;
  results.push(r);
  process.stdout.write(`[gate] ${layer.name}：${r.outcome}（${r.counts.pass} 通过 / ${r.counts.fail} 失败 / ${r.counts.skip} 跳过）${r.ok ? '' : ' ← ' + r.problems.map(p => p.code).join(', ')}\n`);
}
if (build.status === 0) artifact.after = await distContentHash(distDir);
if (hostedBuild.status === 0) hostedArtifact.after = await distContentHash(hostedDir);

// ---------- 总判定与报告 ----------
const gate = evaluateGate(results, { artifact });
if (build.status !== 0) gate.blockers.unshift('构建失败'), gate.ok = false;
if (hostedBuild.status !== 0) gate.blockers.unshift('托管构建失败'), gate.ok = false;
else if (hostedArtifact.before !== hostedArtifact.after) gate.blockers.push(`托管构建产物在验证过程中被改变（${hostedArtifact.before?.slice(0, 12)} → ${hostedArtifact.after?.slice(0, 12)}）`), gate.ok = false;
if (onlyLayers) gate.blockers.push('部分运行（--layers）：不可作为发布证据'), gate.ok = false;
if (Object.keys(envOverride).length) gate.blockers.push(`使用了环境覆盖 ${JSON.stringify(envOverride)}：仅供门禁自测`), gate.ok = false;
if (dirty && !allowDirty) gate.blockers.push('工作区有未提交改动：严格模式须针对已提交的 SHA 验证'), gate.ok = false;
if (dirty && allowDirty) gate.blockers.push('工作区有未提交改动（--allow-dirty）：结果不对应任何提交，不可作为发布证据'), gate.ok = false;
const overlap = overlapReport(results);
const report = {
  kind: 'canvas-release-gate', mode: 'strict', generatedAt: new Date().toISOString(),
  config: { path: relative(ROOT, configPath).replaceAll('\\', '/'), sha256: sha256File(configPath) },
  source: { sha, dirty, dirtyFiles: dirtyList.split('\n').filter(Boolean) },
  version: pkg.version, build: buildInfo, artifact, hostedBuild: hostedInfo, hostedArtifact,
  capabilityVersion: buildInfo?.capabilityVersion ?? null,
  lockfile: existsSync(lockPath) ? { path: 'package-lock.json', sha256: sha256File(lockPath), lockfileVersion: JSON.parse(readFileSync(lockPath, 'utf8')).lockfileVersion } : null,
  versions, environment: env, envOverride,
  egressBlocking: 'scripts/lib/block-egress.mjs 预加载到所有测试进程（非本机连接直接抛错）；浏览器上下文由各测试路由阻断',
  layers: results.map(r => ({
    layer: r.layer, required: r.required, outcome: r.outcome, ok: r.ok, command: r.command, exitCode: r.exitCode, signal: r.signal, ms: r.ms,
    counts: r.counts, problems: r.problems, skips: r.skips, files: r.files, missingFiles: r.missingFiles, log: r.logPath,
    tests: r.tests.map(t => ({ file: t.file, name: t.name, nesting: t.nesting, status: t.status, skipReason: t.skipReason ?? undefined })),
  })),
  overlap, gate,
};
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const md = [
  `# 严格发布门禁报告`,
  ``,
  `- 源码：\`${sha ?? '未知'}\`${dirty ? '（工作区有未提交改动）' : ''}`,
  `- 版本：${pkg.version}｜能力版本：${report.capabilityVersion ?? '—'}｜产物内容哈希：\`${artifact.before ?? '—'}\`${artifact.before && artifact.before !== artifact.after ? `（验证后变为 \`${artifact.after}\`）` : ''}`,
  `- Node ${versions.node}｜npm ${versions.npm ?? '—'}｜playwright-core ${versions.playwrightCore ?? '—'}｜浏览器 ${versions.browser.version ?? '—'}（${versions.browser.via ?? '—'}）｜FFmpeg ${versions.ffmpeg ?? '—'}｜${versions.platform}`,
  `- 依赖锁：package-lock.json sha256 \`${report.lockfile?.sha256 ?? '—'}\`（lockfileVersion ${report.lockfile?.lockfileVersion ?? '—'}）`,
  ``,
  `| 层 | 必需 | 结果 | 退出码 | 通过 | 失败 | 跳过 | 文件数 | 问题 |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...report.layers.map(l => `| ${l.layer} | ${l.required ? '是' : '否'} | ${l.outcome} | ${l.exitCode ?? '—'}${l.signal ? `/${l.signal}` : ''} | ${l.counts.pass} | ${l.counts.fail} | ${l.counts.skip} | ${l.files.length} | ${l.problems.map(p => p.code).join(', ') || '—'} |`),
  ``,
  `## 跳过（逐条，均须命中精确登记）`,
  ...(report.layers.flatMap(l => l.skips.map(s => `- [${l.layer}] ${s.file}｜${s.test}｜${s.reason}`)) || []),
  ``,
  `## 跨层重叠`,
  `- 各层用例相加 ${overlap.summedAcrossLayers}；按（文件, 测试名, 层级）去重后的唯一用例 ${overlap.uniqueTestCases}。`,
  ...overlap.overlapping.map(o => `- ${o.file}：${o.layers.join(' + ')}`),
  ``,
  `## 结论`,
  gate.ok ? '- 严格门禁：**通过**' : `- 严格门禁：**未通过**`,
  ...gate.blockers.map(b => `- 阻断：${b}`),
  ...gate.notAccepted.map(n => `- 未验收（可选层）：${n}`),
].join('\n');
writeFileSync(join(outDir, 'report.md'), md + '\n');
process.stdout.write(`\n${md}\n\n[gate] 证据目录：${outDir}\n`);
process.exit(gate.ok ? 0 : 1);
