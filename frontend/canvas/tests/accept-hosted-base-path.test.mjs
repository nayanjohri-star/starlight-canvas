// 托管基础路径与运行形态的静态验收：页面资源不得用站点根绝对路径（否则 /canvas/ 下 404）；
// JS 中以 / 开头的请求只允许出现在已登记、并受运行形态开关保护的本机专属位置；
// 托管配置拒绝把请求指向其他主机；托管产物不含本机专属文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveRuntime, validateSitePath } from '../scripts/lib/runtime-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const files = ext => readdirSync(SRC).filter(f => f.endsWith(ext)).map(f => [f, readFileSync(join(SRC, f), 'utf8')]);

test('HTML 与 CSS 资源引用全部为相对路径（在 / 与 /canvas/ 下都能解析）', () => {
  const bad = [];
  for (const [f, s] of files('.html')) for (const m of s.matchAll(/\b(?:href|src)="(\/[^"]*)"/g)) bad.push(`${f}: ${m[1]}`);
  for (const [f, s] of files('.css')) for (const m of s.matchAll(/url\(\s*['"]?(\/[^'")]*)/g)) bad.push(`${f}: ${m[1]}`);
  assert.deepEqual(bad, []);
});

// 已登记的站点根请求：都属于本机形态，且在托管形态由 RUNTIME 开关阻断（见各文件中的判断）
const REGISTERED = {
  'api.js': ["'/site'", "'/canvas-api'"],                  // 本机 /site 默认值；托管合同路由 /canvas-api（hostedBase() 只接受该同源路径）
  'service-status.js': ["'/health'"],                     // 托管形态走 checkHosted()，不访问
  'timeline.js': ["'/media/capabilities'", "'/media/render'"], // serverCaps/服务器渲染受 feature('serverRender') 保护
  'workspace.js': ['`/workspace${path}`'],                // 托管形态不加载该模块
};
test('JS 中的站点根请求只出现在已登记且受运行形态保护的位置', () => {
  const found = [];
  for (const [f, s] of files('.js')) {
    for (const m of s.matchAll(/(?:fetch(?:Impl)?\(|import\(|new Worker\(|base = )\s*(['"`]\/[^'"`]*['"`])/g)) found.push([f, m[1]]);
  }
  const unregistered = found.filter(([f, lit]) => !(REGISTERED[f] ?? []).some(r => lit.startsWith(r.replace(/`$/, '').slice(0, -1)) || lit === r));
  assert.deepEqual(unregistered.map(x => x.join(': ')), [], '新增的站点根请求须登记并受运行形态保护');
  const svc = readFileSync(join(SRC, 'service-status.js'), 'utf8');
  assert.match(svc, /if \(runtime\.mode === 'hosted'\) return checkHosted\(\);/);
  const tl = readFileSync(join(SRC, 'timeline.js'), 'utf8');
  assert.match(tl, /async function serverCaps\(signal\) \{\s*if \(!feature\('serverRender'\)\) return null;/);
  const main = readFileSync(join(SRC, 'main.js'), 'utf8');
  assert.match(main, /createSiteClient\(\{ base: RUNTIME\.apiBase/);
  assert.match(main, /name === 'workspace' && !feature\('workspace'\)/);
});

test('托管配置：只接受单个 / 开头的站内路径；本机形态保持原有路由', () => {
  for (const v of ['https://evil.example', '//evil.example', '/v1/../admin', 'v1', '/a\\b', '/x?y'])
    assert.throws(() => validateSitePath('apiBase', v), /站内路径/, v);
  assert.equal(validateSitePath('apiBase', '', { allowEmpty: true }), '');
  assert.throws(() => resolveRuntime({ mode: 'hosted', basePath: '/canvas' }), /以 \/ 结尾/);
  assert.throws(() => resolveRuntime({ mode: 'cloud' }), /未知构建形态/);
  const hosted = resolveRuntime({ mode: 'hosted' });
  assert.equal(hosted.basePath, '/canvas/'); assert.equal(hosted.apiBase, '/canvas-api'); assert.equal(hosted.readyUrl, '/canvas-api/features');
  assert.deepEqual(hosted.features, { localService: false, serverRender: false, workspace: false, director: true, hostedDirector: true });
  assert.deepEqual(hosted.blockedModels, {}, 'verified production models are not held by stale build-time guards');
  const local = resolveRuntime({ mode: 'local' });
  assert.equal(local.apiBase, '/site'); assert.equal(local.features.serverRender, true);
  assert.deepEqual(local.blockedModels, {});
});

test('托管构建产物：运行形态为 hosted、不含本机专属文件、构建身份记录形态与路径', async t => {
  const out = await mkdtemp(join(tmpdir(), 'hosted-build-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--mode', 'hosted', '--out', out], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rt = readFileSync(join(out, 'runtime-config.js'), 'utf8');
  assert.match(rt, /mode: "hosted"/); assert.match(rt, /basePath: "\/canvas\/"/);
  assert.equal(existsSync(join(out, '__hub-sdk__.js')), false);
  const build = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
  assert.equal(build.mode, 'hosted'); assert.equal(build.basePath, '/canvas/'); assert.equal(build.apiBase, '/canvas-api');
  assert.match(build.assetPath, /^releases\/[a-f0-9]{64}\/$/);
  assert.ok(readFileSync(join(out, 'index.html'), 'utf8').includes(`<base href="./${build.assetPath}">`));
  for (const file of ['main.js', 'app.css', 'build-info.js', 'runtime-config.js', 'capabilities.json'])
    assert.equal(readFileSync(join(out, build.assetPath, file), 'utf8'), readFileSync(join(out, file), 'utf8'));
  const bad = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--mode', 'hosted', '--out', out, '--api-base', 'https://evil.example'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(bad.status, 0, '指向其他主机的 API 根必须使构建失败');
});

test('托管 API 根与就绪检查只接受合同的 /canvas-api：空值、其他路径、跨源、协议相对、不一致的就绪路径均在构建期拒绝', () => {
  const bad = [
    [{ apiBase: '' }, /站内路径/], [{ apiBase: '/api' }, /只支持 \/canvas-api/], [{ apiBase: '/canvas-api/v2' }, /只支持 \/canvas-api/],
    [{ apiBase: 'https://evil.example/canvas-api' }, /站内路径/], [{ apiBase: '//evil.example/canvas-api' }, /站内路径/],
    [{ readyUrl: '/health' }, /\/canvas-api\/features/], [{ readyUrl: '/canvas-api/identity' }, /\/canvas-api\/features/],
    [{ readyUrl: '//evil.example/canvas-api/features' }, /站内路径/],
  ];
  for (const [opt, re] of bad) assert.throws(() => resolveRuntime({ mode: 'hosted', ...opt }), re, JSON.stringify(opt));
  const ok = resolveRuntime({ mode: 'hosted' });
  assert.deepEqual([ok.apiBase, ok.readyUrl, ok.basePath], ['/canvas-api', '/canvas-api/features', '/canvas/']);
  assert.equal(resolveRuntime({ mode: 'hosted', basePath: '/studio/' }).basePath, '/studio/', '基础路径可配置（资源为相对路径）');
});

test('非默认基础路径的托管构建：入口与样式只含相对引用，运行配置记录该路径', async t => {
  const out = await mkdtemp(join(tmpdir(), 'hosted-base-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--mode', 'hosted', '--base', '/studio/', '--out', out], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(out, 'runtime-config.js'), 'utf8'), /basePath: "\/studio\/"/);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/\b(?:href|src)="(\/[^"]*)"/g)].map(m => m[1]), []);
  for (const f of readdirSync(out).filter(f => f.endsWith('.css')))
    assert.deepEqual([...readFileSync(join(out, f), 'utf8').matchAll(/url\(\s*['"]?(\/[^'")]*)/g)].map(m => m[1]), [], f);
});
