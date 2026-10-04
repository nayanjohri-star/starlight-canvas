// 画布测试环境探测：全部用 spawn/文件系统实探，不猜 PATH。
// shell PATH 与 Node 进程 PATH 可能不同——只信 spawnSync 实际结果。
// 用法：
//   node scripts/env-check.mjs            → 输出 JSON 结论，退出码 0
//   node scripts/env-check.mjs --require e2e|director|media|unit
//                                         → 指定能力缺失时退出码 77（环境缺失，非断言失败）
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDirectorAssets } from '../server/app.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');        // frontend/canvas
const REPO = resolve(ROOT, '..', '..');
const DIRECTOR_DIR = join(REPO, 'docs', 'minimax-video-ref', 'bundled-plugins', '3d-director-stage');
const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const EXIT_ENV_MISSING = 77;

const run = (cmd, args, timeoutMs = 8000) => {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (r.error || r.status !== 0) return { ok: false, error: r.error?.message ?? `exit ${r.status}` };
    return { ok: true, out: (r.stdout || r.stderr || '').trim() };
  } catch (e) { return { ok: false, error: e.message }; }
};

export function probeEnv() {
  const env = {
    node: { version: process.version, execPath: process.execPath },
    cwd: ROOT,
    probes: {},
  };

  // ---- 外部可执行（spawn 实探）----
  const npm = ['npm', 'npm.cmd'].map(c => run(c, ['--version'])).find(r => r.ok) ?? run('npm', ['--version']);
  env.probes.npm = { ok: npm.ok, version: npm.ok ? npm.out : null, error: npm.error ?? null };
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const r = run(tool, ['-version']);
    env.probes[tool] = {
      ok: r.ok,
      version: r.ok ? (/version\s+(\S+)/.exec(r.out)?.[1] ?? r.out.split('\n')[0]) : null,
      error: r.error ?? null,
    };
  }

  // ---- playwright-core 模块解析（canvas 自身优先，portal 回退）----
  const req = createRequire(join(ROOT, 'tests', 'e2e-helpers.mjs'));
  let pw = null, pwFrom = null, pwErr = null;
  try { pw = req('playwright-core'); pwFrom = 'canvas:node_modules'; }
  catch (e1) {
    try { pw = req('../../portal/node_modules/playwright-core'); pwFrom = 'portal:node_modules'; }
    catch (e2) { pwErr = e2.message; }
  }
  const canvasDep = existsSync(join(ROOT, 'node_modules', 'playwright-core', 'package.json'));
  const portalDep = existsSync(join(REPO, 'frontend', 'portal', 'node_modules', 'playwright-core', 'package.json'));
  let pwVersion = null;
  if (pw) {
    try {
      const pkgPath = req.resolve('playwright-core/package.json');
      pwVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    } catch { /* 版本读取失败不阻塞 */ }
  }
  env.probes.playwrightCore = {
    ok: Boolean(pw), resolvedFrom: pwFrom, version: pwVersion,
    canvasDepInstalled: canvasDep, portalDepInstalled: portalDep,
    error: pw ? null : pwErr,
  };

  // ---- 浏览器二进制：playwright 托管优先，其次环境变量，最后系统 Chrome ----
  const candidates = [];
  if (pw) { try { const p = pw.chromium.executablePath(); if (p) candidates.push({ path: p, via: 'playwright' }); } catch { /* 未安装时可能抛错 */ } }
  if (process.env.CANVAS_E2E_CHROME) candidates.push({ path: process.env.CANVAS_E2E_CHROME, via: 'CANVAS_E2E_CHROME' });
  candidates.push({ path: SYSTEM_CHROME, via: 'system' });
  let browser = null;
  for (const c of candidates) if (existsSync(c.path)) { browser = c; break; }
  let browserVersion = null;
  if (browser) {
    const v = run(browser.path, ['--version']);
    browserVersion = v.ok ? v.out.split('\n')[0] : null;
    if (!browserVersion) {
      // 部分二进制（headless shell）不支持 --version：回退到产品版字段解析
      try {
        const exeDir = dirname(browser.path);
        const pkg = join(exeDir, '..', 'INSTALLATION_COMPLETE');
        if (existsSync(pkg)) browserVersion = 'playwright-managed';
      } catch { /* 版本不可读不阻塞 */ }
    }
  }
  env.probes.browser = {
    ok: Boolean(browser), path: browser?.path ?? null, via: browser?.via ?? null,
    version: browserVersion,
    playwrightManaged: browser?.via === 'playwright',
    candidates: candidates.map(c => ({ ...c, exists: existsSync(c.path) })),
  };

  // ---- 导演台资源（不随共享分支分发）----
  env.probes.director = {
    // 与本机服务 /health 同一检查：manifest、id、entry 与引用资源逐项核对（不只看 index.html）
    ok: checkDirectorAssets(DIRECTOR_DIR).available,
    reason: checkDirectorAssets(DIRECTOR_DIR).reason,
    dir: DIRECTOR_DIR,
    note: '真实导演台资源不随共享分支分发；缺失时相关测试按合同如实 skip 标注「未验收」',
  };

  // ---- 汇总能力位 ----
  env.summary = {
    unit: true,                                        // 零依赖 node --test
    contract: true,
    e2e: Boolean(pw) && Boolean(browser),              // playwright-core + 浏览器二进制
    director: env.probes.director.ok,
    media: env.probes.ffmpeg.ok && env.probes.ffprobe.ok,
  };
  env.hints = [];
  if (!pw) env.hints.push('缺 playwright-core：cd frontend/canvas && npm install');
  if (pw && !browser) env.hints.push('缺浏览器二进制：npx playwright install chromium（或设置 CANVAS_E2E_CHROME）');
  if (!env.probes.ffmpeg.ok) env.hints.push('缺 ffmpeg：媒体渲染测试将按合同 skip（不视为通过）');
  if (!env.probes.director.ok) env.hints.push('导演台为开发中功能，插件资源不随仓库分发：导演台用例跳过（未验收），其他层级不受影响');
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = probeEnv();
  const reqIdx = process.argv.indexOf('--require');
  const need = reqIdx >= 0 ? process.argv[reqIdx + 1] : null;
  console.log(JSON.stringify(env, null, 2));
  if (need) {
    if (!(need in env.summary)) { console.error(`未知能力：${need}`); process.exit(2); }
    if (!env.summary[need]) {
      console.error(`\n环境缺失能力「${need}」：${env.hints.join('；') || '见上方 JSON'}`);
      process.exit(EXIT_ENV_MISSING);
    }
  }
}
