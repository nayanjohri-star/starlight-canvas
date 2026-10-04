// 发布包验收（门禁 package 层必需）：在仓库之外的干净临时目录中，
// ① 打包（不重新构建，dist 哈希须与 build.json 一致）→ ② 结构与 SHA256SUMS 校验、无测试/依赖/密钥混入 →
// ③ 离线安装（无运行时依赖，不得联网）→ ④ 以包内 server/main.mjs 真实启动，验证健康检查、版本、静态资源与安全头 →
// ⑤ 用包内 server/app.mjs + 本地模拟上游跑一遍主流程：提交生成 → 查询完成 → 任务中心下载并核验本机成片。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { packageRelease } from '../scripts/package-release.mjs';
import { chromium, CHROME, BROWSER_OK, MP4, makeState, mockUpstream, setKey, clickCanvasAction, openCanvasDock, ROOT } from './e2e-helpers.mjs';

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

let pkg, out;
test.before(async () => {
  out = await mkdtemp(join(tmpdir(), 'xp-release-pkg-'));
  pkg = await packageRelease({ out, log: () => {} });
});
test.after(() => out && rm(out, { recursive: true, force: true }));

test('发布包结构：必需文件齐全；无测试、依赖目录、证据或密钥；SHA256SUMS 全部匹配', () => {
  const dir = pkg.dir;
  const fromRepo = relative(ROOT, dir);
  assert.ok(fromRepo.startsWith('..') || isAbsolute(fromRepo), `包必须在仓库之外的临时目录：${dir}`);
  for (const f of ['package.json', 'README-运行.md', 'SHA256SUMS', 'server/main.mjs', 'server/app.mjs', 'server/media-service.mjs',
    'dist/index.html', 'dist/build.json', 'dist/build-info.js', 'dist/capabilities.json', 'contracts/site-video-capabilities.json', 'src/export-project.js'])
    assert.ok(existsSync(join(dir, f)), `缺少 ${f}`);
  const all = walk(dir).map(p => relative(dir, p).replaceAll('\\', '/'));
  assert.deepEqual(all.filter(f => /\.test\.mjs$|node_modules|\.release-evidence|^tests\//.test(f)), []);
  const leak = all.filter(f => { const s = statSync(join(dir, f)).size < 5e6 ? readFileSync(join(dir, f), 'utf8') : ''; return /sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9]{20,}/.test(s); });
  assert.deepEqual(leak, [], '包内不得含疑似密钥');
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkgVersion);
  assert.equal(manifest.dependencies, undefined); assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual(Object.keys(manifest.scripts), ['start']);
  const build = JSON.parse(readFileSync(join(dir, 'dist', 'build.json'), 'utf8'));
  assert.equal(build.version, pkgVersion); assert.equal(build.contentHash, pkg.contentHash);
  const lines = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(lines.length, all.length - 1, 'SHA256SUMS 覆盖除自身外的全部文件');
  for (const line of lines) {
    const [hash, rel] = [line.slice(0, 64), line.slice(66)];
    assert.equal(createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex'), hash, rel);
  }
});

test('打包是确定的：同一 dist 再打一次，SHA256SUMS 摘要相同', async () => {
  const again = await packageRelease({ out: join(out, 'again'), log: () => {} });
  assert.equal(again.packageHash, pkg.packageHash);
});

test('干净目录离线安装后以包内 main.mjs 启动：健康检查报告运行版本，静态资源与安全头正常', { timeout: 120000 }, async t => {
  const dir = pkg.dir;
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
    { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 });
  assert.equal(npm.status, 0, `离线安装失败：${npm.stderr}`);
  const nm = join(dir, 'node_modules');
  assert.ok(!existsSync(nm) || readdirSync(nm).filter(n => !n.startsWith('.')).length === 0, '不应安装任何依赖');
  const port = await freePort();
  const ws = join(out, 'workspace-data');
  const child = spawn(process.execPath, ['server/main.mjs', '--port', String(port)], { cwd: dir, env: { ...process.env, CANVAS_WORKSPACE_DIR: ws }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let health = null;
  for (let i = 0; i < 100 && !health; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) health = await r.json(); } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(health, `服务未启动：${stderr}`);
  assert.equal(health.version, pkgVersion); assert.equal(health.apiLevel, 5);
  assert.ok(health.instance?.codeHash);
  assert.equal(health.director.available, true, '托管导演台随包分发，无需本机插件');
  assert.equal((await fetch(`${base}/director/index.html`)).status, 200);
  assert.equal((await fetch(`${base}/director/source.zip`)).status, 200);
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy') ?? '', /object-src 'none'/);
  const info = await (await fetch(`${base}/build-info.js`)).text();
  assert.ok(info.includes(pkgVersion), 'build-info.js 带发布版本');
  const caps = await (await fetch(`${base}/capabilities.json`)).json();
  assert.equal(caps.version, JSON.parse(readFileSync(join(dir, 'dist', 'build.json'), 'utf8')).capabilityVersion);
  assert.equal((await fetch(`${base}/package.json`)).status, 404, '包根目录文件不经静态服务暴露');
});

test('包内服务主流程（本地模拟上游）：提交生成 → 完成 → 任务中心核验本机成片', { timeout: 180000, skip: !BROWSER_OK && '浏览器缺失（严格门禁中缺失即失败）' }, async t => {
  const dir = pkg.dir;
  const { createCanvasServer } = await import(pathToFileURL(join(dir, 'server', 'app.mjs')).href);
  const state = makeState(); state.videoBytes = MP4;
  const server = createCanvasServer({ staticDir: join(dir, 'dist'), directorDir: join(dir, 'no-director'), mediaService: false, upstreamFetch: mockUpstream(state) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu'] });
  t.after(() => browser.close().catch(() => {}));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const blocked = [];
  await ctx.route('**/*', r => { const u = new URL(r.request().url()); if (u.origin === origin) return r.continue(); blocked.push(u.href); return r.abort(); });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.__xp?.store?.project);
  assert.equal(await page.locator('#build-badge').innerText().then(s => s.includes(pkgVersion)), true, '页面显示发布版本');
  await setKey(page, 'synthetic-package-key');
  await clickCanvasAction(page, '[data-add-node="gen"]');
  await page.click('.node-gen .node-head');
  await page.fill('#inspector textarea', '发布包主流程验证');
  await page.getByRole('button', { name: /^(上传并)?提交生成$/ }).click();
  const taskId = await page.waitForFunction(() => window.__xp.store.project.nodes.find(n => n.type === 'gen')?.data.run?.taskId, null, { timeout: 20000 }).then(h => h.jsonValue());
  await openCanvasDock(page, 'task');
  const row = page.locator(`#task-list .task-item[data-task-id="${taskId}"]`);
  await page.waitForFunction(id => ['ready_to_download', 'local_verified'].includes(document.querySelector(`#task-list .task-item[data-task-id="${id}"]`)?.dataset.taskState), taskId, { timeout: 30000 });
  // 成片可能已被自动取回（行随之从「待下载」变为「本地文件已校验」并重建）：先等自动取回，仍待下载才由用户点「恢复下载」
  const auto = await page.waitForFunction(id => document.querySelector(`#task-list .task-item[data-task-id="${id}"]`)?.dataset.taskState === 'local_verified', taskId, { timeout: 5000 }).then(() => true, () => false);
  if (!auto) await row.getByRole('button', { name: '恢复下载' }).click();
  await page.waitForFunction(id => document.querySelector(`#task-list .task-item[data-task-id="${id}"]`)?.dataset.taskState === 'local_verified', taskId, { timeout: 30000 });
  assert.equal(state.creates.length, 1, '一次提交恰好一个生成请求');
  assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
});
