// verify:release —— 发布候选一站式验证编排（D 拥有）。
// 顺序：env-check → unit → contract → recovery → package → accept → e2e → performance → director
// 每一层记录命令/退出码/耗时；环境缺失层记 env-missing（77），不包装成通过。
// 用法：node scripts/verify-release.mjs [--skip=e2e,performance,director] [--json out.json]
//       node scripts/verify-release.mjs --tree=<工作树根|integration> [--json out.json]
// --tree 模式（WO-D2c 集成复核）：对指定工作树的 frontend/canvas/tests/accept-*.test.mjs
// 跑 accept 层验收（测试文件须已同步到该树），输出含命令/退出码/pass/fail/skip 的 JSON 证据。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeEnv, EXIT_ENV_MISSING } from './env-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const args = process.argv.slice(2);
const skipArg = args.find(a => a.startsWith('--skip='));
const skip = new Set(skipArg ? skipArg.slice(7).split(',') : []);
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const treeArg = args.find(a => a.startsWith('--tree='));

// ---------- --tree 模式：对指定工作树固化 accept 层验收入口 ----------
if (treeArg) {
  const t0 = Date.now();
  let treeRoot = treeArg.slice(7);
  if (!treeRoot.includes('/') && !treeRoot.includes('\\') && !/^[A-Za-z]:/.test(treeRoot))
    treeRoot = join(ROOT, '..', '..', '..', treeRoot);    // 短名：worktrees/ 下兄弟工作树（如 integration）
  const canvasDir = basename(treeRoot) === 'canvas' ? treeRoot : join(treeRoot, 'frontend', 'canvas');
  const testsDir = join(canvasDir, 'tests');
  const fail = (msg, code = 2) => { console.error(`[verify:tree] ${msg}`); process.exit(code); };
  if (!existsSync(join(canvasDir, 'package.json'))) fail(`目标树无 frontend/canvas：${canvasDir}`);
  if (!existsSync(testsDir)) fail(`目标树无 tests/ 目录：${testsDir}`);
  const files = readdirSync(testsDir).filter(f => /^accept-.*\.test\.mjs$/.test(f)).map(f => join(testsDir, f));
  if (!files.length) fail(`目标树无 accept-*.test.mjs（验收用例须先同步到该树）：${testsDir}`);

  const cmd = [NODE, '--test', ...files];
  console.log(`[verify:tree] 目标=${canvasDir}`);
  console.log(`[verify:tree] 命令=${cmd.join(' ')}  (cwd=${canvasDir})`);
  const r = spawnSync(NODE, ['--test', ...files], { cwd: canvasDir, stdio: ['ignore', 'pipe', 'inherit'] });
  const out = String(r.stdout ?? '');
  process.stdout.write(out);
  const code = r.status ?? 1;
  const num = (re, d = 0) => Number((out.match(re) ?? [])[1] ?? d);
  const report = {
    generatedAt: new Date().toISOString(), mode: 'tree', tree: treeRoot, canvasDir,
    command: `node --test ${files.map(f => basename(f)).join(' ')}`, cwd: canvasDir,
    files: files.map(f => basename(f)), exitCode: code, durationMs: Date.now() - t0,
    totals: { tests: num(/ℹ tests (\d+)/), pass: num(/ℹ pass (\d+)/), fail: num(/ℹ fail (\d+)/), skipped: num(/ℹ skipped (\d+)/) },
    ok: code === 0,
  };
  const outPath = resolve(jsonOut ?? join(ROOT, 'tests', 'out', `verify-tree-${basename(treeRoot)}-${Date.now()}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[verify:tree] exit=${code} pass=${report.totals.pass} fail=${report.totals.fail} skipped=${report.totals.skipped} → ${outPath}`);
  process.exit(code);
}

const TIERS = ['unit', 'contract', 'recovery', 'package', 'accept', 'e2e', 'performance', 'director'];
const results = [];
const t0 = Date.now();

const env = probeEnv();
console.log(`[verify] 基线环境：node ${env.node.version} | e2e=${env.summary.e2e} director=${env.summary.director} media=${env.summary.media}`);
results.push({ tier: 'env-check', ok: true, env: { node: env.node.version, summary: env.summary, hints: env.hints } });

for (const tier of TIERS) {
  if (skip.has(tier)) { results.push({ tier, ok: null, skipped: 'cli' }); continue; }
  const t1 = Date.now();
  const r = spawnSync(NODE, [join(ROOT, 'scripts', 'run-tests.mjs'), tier], { stdio: 'inherit' });
  const code = r.status ?? 1;
  const rec = { tier, exitCode: code, ms: Date.now() - t1 };
  if (code === EXIT_ENV_MISSING) { rec.ok = null; rec.skipped = 'env-missing'; }
  else { rec.ok = code === 0; }
  results.push(rec);
  console.log(`[verify] ${tier}: exit=${code}${rec.skipped ? ` (${rec.skipped})` : ''}`);
}

const failed = results.filter(r => r.ok === false);
const skipped = results.filter(r => r.skipped);
const report = {
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - t0,
  tiers: results,
  summary: {
    passed: results.filter(r => r.ok === true && r.tier !== 'env-check').length,
    failed: failed.map(r => r.tier),
    envMissing: skipped.filter(r => r.skipped === 'env-missing').map(r => r.tier),
    cliSkipped: skipped.filter(r => r.skipped === 'cli').map(r => r.tier),
  },
};
try {
  report.canvasVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
} catch { /* 版本不可读不阻塞 */ }

console.log('\n[verify] ===== 汇总 =====');
console.log(JSON.stringify(report.summary, null, 2));
if (jsonOut) {
  mkdirSync(dirname(resolve(jsonOut)), { recursive: true });
  writeFileSync(resolve(jsonOut), JSON.stringify(report, null, 2));
  console.log(`[verify] 报告已写入 ${jsonOut}`);
}
process.exit(failed.length ? 1 : 0);
