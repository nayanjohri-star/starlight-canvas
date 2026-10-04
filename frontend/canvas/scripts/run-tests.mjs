// 分层测试运行器（D 拥有）。用法：
//   node scripts/run-tests.mjs <tier> [--no-build] [--list]
// 层级：
//   unit        单元/服务端测试全集（排除 e2e-* 与 accept-*；零依赖）
//   contract    跨模块/上游合同子集（能力表、H3 兼容、负载、任务状态）
//   recovery    升级/导入/持久化恢复子集（unit 子集视图）
//   accept      D 独立验收（对未关闭缺陷可为 RED——RED 是如实证据，不得删断言求绿）
//   e2e         浏览器端到端（需 playwright-core + 浏览器；缺失 → 退出 77 而非断言失败）
//   performance 大画布/拖动性能 e2e（同 e2e 依赖）
//   package     构建 + dist 结构核验 + 工程包相关单测
//   director    导演台 e2e（需 E2E_DIRECTOR=1 + 导演台资源 + 浏览器）
// 退出码：0=通过；1=断言失败；2=用法错误；77=环境缺失（env-check 同口径）。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeEnv, EXIT_ENV_MISSING } from './env-check.mjs';
import { HOSTED_DIRECTOR_REQUIRED_FILES } from './lib/hosted-director-evidence.mjs';
import { BROWSER_FILE } from './release-gate.config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');
const SERVER = join(ROOT, 'server');
const NODE = process.execPath;

const isTest = f => f.endsWith('.test.mjs');
const NATIVE_DIRECTOR_FILES = ['hosted-director-v04.test.mjs', 'hosted-director-native-performance.test.mjs'];
const isNativeDirector = f => NATIVE_DIRECTOR_FILES.includes(f);
const isE2E = f => /^e2e/.test(f) || ['hosted-director-acceptance.test.mjs', 'hosted-director-operations-ui.test.mjs',
  'hosted-director-generation-ui.test.mjs', 'hosted-director-proposal-ui.test.mjs'].includes(f);
const isAccept = f => /^accept-/.test(f);
const testFiles = dir => existsSync(dir) ? readdirSync(dir).filter(isTest).map(f => join(dir, f)) : [];

const CONTRACT_FILES = [
  'server/capability-contract.test.mjs',
  'tests/api.test.mjs',
  'tests/capabilities.test.mjs',
  'tests/h3-compat-controls.test.mjs',
  'tests/h3-compat-payload.test.mjs',
  'tests/h3-v2-runner.test.mjs',
  'tests/payload.test.mjs',
];
const RECOVERY_PATTERNS = [
  /^upgrade-/, /^runner-resume/, /^storage-transaction-fixes/,
  /^import-integrity-fixes/, /^review-result-durability/, /^review-project-integrity/,
];
const PERFORMANCE_FILES = ['tests/e2e-drag-performance.test.mjs', 'tests/e2e-large-canvas.test.mjs', 'tests/e2e-perf-large.test.mjs'];
const PACKAGE_FILES = [/^upgrade-.*package/, 'release-package.test.mjs'];

const matchAny = (name, pats) => pats.some(p => (p instanceof RegExp ? p.test(name) : name === p));
const rel = f => f.slice(ROOT.length + 1).replaceAll('\\', '/');
const inList = (dir, pats) => testFiles(dir).filter(f => matchAny(basename(f), pats) || matchAny(rel(f), pats));

const TIERS = {
  unit: {
    desc: '单元与服务端测试全集（排除 e2e-/accept-）',
    files: () => [...testFiles(TESTS), ...testFiles(SERVER)].filter(f => !BROWSER_FILE(basename(f))),
    build: true,
  },
  contract: {
    desc: '跨模块/上游合同子集',
    files: () => CONTRACT_FILES.map(f => join(ROOT, f)).filter(existsSync),
    build: true,
  },
  recovery: {
    desc: '升级/导入/持久化恢复子集（unit 子集）',
    files: () => [...inList(TESTS, RECOVERY_PATTERNS), ...inList(SERVER, RECOVERY_PATTERNS)],
    build: true,
  },
  accept: {
    desc: 'D 独立验收（未关闭缺陷的 RED 为如实证据）',
    files: () => testFiles(TESTS).filter(f => isAccept(basename(f))),
    build: true,
  },
  e2e: {
    desc: '浏览器端到端（playwright-core + 浏览器；性能测量文件单列 performance 层，并行下不受争用干扰）',
    files: () => testFiles(TESTS).filter(f => isE2E(basename(f)) && !/^e2e-director/.test(basename(f))
      && basename(f) !== 'hosted-director-acceptance.test.mjs'
      && !PERFORMANCE_FILES.some(p => basename(p) === basename(f))),
    build: true, require: 'e2e',
  },
  performance: {
    desc: '大画布/拖动性能 e2e',
    files: () => PERFORMANCE_FILES.map(f => join(ROOT, f)).filter(existsSync),
    build: true, require: 'e2e',
  },
  package: {
    desc: '构建 + dist 结构核验 + 工程包单测',
    files: () => inList(TESTS, PACKAGE_FILES),
    build: true, require: 'e2e', postVerify: 'scripts/verify-package.mjs',
  },
  director: {
    desc: '导演台 e2e（E2E_DIRECTOR=1 + 资源 + 浏览器）',
    files: () => [join(TESTS, 'e2e-director.test.mjs')].filter(existsSync),
    build: true, require: 'director',
    env: { E2E_DIRECTOR: '1' },
  },
  'hosted-director': {
    desc: '必需托管导演台：真实3D、账号工程隔离、恢复与输出',
    files: () => HOSTED_DIRECTOR_REQUIRED_FILES.map(file => join(ROOT, file)),
    build: true, buildMode: 'hosted', require: 'e2e', concurrency: 1,
  },
  'director-native': {
    desc: '固定 Windows 参考电脑：正式 Chrome/Edge 的布局、真实缩放与硬件性能独立验收；环境缺失直接失败',
    files: () => NATIVE_DIRECTOR_FILES.map(file => join(TESTS, file)),
    build: true, buildMode: 'hosted', concurrency: 1,
  },
};

export function resolveTier(name) {
  const tier = TIERS[name];
  if (!tier) return null;
  return { name, ...tier, files: tier.files() };
}

function build(mode = 'local') {
  const r = spawnSync(NODE, [join(ROOT, 'scripts', 'build.mjs'), '--mode', mode], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('构建失败，中止测试'); process.exit(r.status ?? 1); }
}

export function runTier(name, { build: doBuild = true, env: extraEnv = {} } = {}) {
  const tier = resolveTier(name);
  if (!tier) { console.error(`未知层级：${name}（可选：${Object.keys(TIERS).join(', ')}）`); process.exit(2); }
  if (!tier.files.length) { console.error(`层级 ${name} 没有匹配的测试文件`); process.exit(2); }
  if (tier.require) {
    const env = probeEnv();
    if (!env.summary[tier.require]) {
      console.error(`环境缺失能力「${tier.require}」，层级 ${name} 不可运行：`);
      console.error((env.hints.length ? env.hints : ['见 npm run test:env']).map(h => `  - ${h}`).join('\n'));
      process.exit(EXIT_ENV_MISSING);
    }
  }
  if (doBuild && tier.build) build(tier.buildMode);
  // 浏览器层限流：每个文件各启一个 Chrome，全部并行（21 个）时启动等待超时来自资源争用而非断言，
  // 会掩盖真实缺陷。默认 4 路，可用 CANVAS_BROWSER_CONCURRENCY 覆盖；非浏览器层保持 node 默认并发。
  const conc = tier.concurrency ?? (tier.require ? Math.max(1, Number(process.env.CANVAS_BROWSER_CONCURRENCY) || 4) : null);
  console.log(`[run-tests] ${name}：${tier.desc}（${tier.files.length} 个文件${conc ? `，浏览器并发 ${conc}` : ''}）`);
  const r = spawnSync(NODE, ['--test', ...(conc ? [`--test-concurrency=${conc}`] : []), ...tier.files], { stdio: 'inherit', env: { ...process.env, ...extraEnv, ...tier.env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (tier.postVerify) {
    const v = spawnSync(NODE, [join(ROOT, tier.postVerify)], { stdio: 'inherit' });
    if (v.status !== 0) process.exit(v.status ?? 1);
  }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tier = args.find(a => !a.startsWith('--'));
  const doBuild = !args.includes('--no-build');
  if (!tier || tier === 'help' || args.includes('--help')) {
    console.log(`用法：node scripts/run-tests.mjs <${Object.keys(TIERS).join('|')}> [--no-build] [--list]\n退出码：0 通过 / 1 断言失败 / 2 用法错误 / 77 环境缺失`);
    process.exit(tier ? 0 : 2);
  }
  if (args.includes('--list')) {
    const t = resolveTier(tier);
    if (!t) { console.error(`未知层级：${tier}`); process.exit(2); }
    console.log(t.files.map(f => rel(f)).join('\n'));
    process.exit(0);
  }
  runTier(tier, { build: doBuild });
}
