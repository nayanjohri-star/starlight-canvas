// R05 独立验收：本机服务状态与导演台四态（纯逻辑）。
// 不变量：只有服务正面确认资源完整才是 available；旧服务、异常响应、超时、连接失败都不是可用；
// 前后端匹配以运行中服务报告的 apiLevel 为准。
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHealth, createServiceStatus, DIRECTOR_STATES } from '../src/service-status.js';
import { checkDirectorAssets, SERVER_API_LEVEL } from '../server/app.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const build = { version: '0.5.0', requiresServerApi: SERVER_API_LEVEL };
const health = over => ({ ok: true, service: 'xingpan-canvas', version: '0.5.0', apiLevel: SERVER_API_LEVEL, director: { available: true, reason: null }, ...over });

test('四态集合固定', () => assert.deepEqual(DIRECTOR_STATES, ['checking', 'available', 'unavailable', 'failed']));

test('只有服务报告 director.available=true 才是 available', () => {
  assert.equal(classifyHealth(health(), build).director, 'available');
  assert.equal(classifyHealth(health({ director: { available: false, reason: '缺少插件资源' } }), build).director, 'unavailable');
});

test('0.4.4 旧服务（只有 director_available、无 apiLevel）：导演台检测失败且提示服务过旧', () => {
  const old = { ok: true, service: 'xingpan-canvas', upstream: 'https://xingpan.site', director_url: 'x', director_available: true };
  const r = classifyHealth(old, build);
  assert.equal(r.director, 'failed', '旧服务的布尔值不足以确认资源完整');
  assert.equal(r.compat, 'service-outdated');
});

test('协议级别：低于页面要求 → 服务过旧；高于 → 页面过旧；相同但版本号不同 → 仅提示', () => {
  assert.equal(classifyHealth(health({ apiLevel: SERVER_API_LEVEL - 1 }), build).compat, 'service-outdated');
  assert.equal(classifyHealth(health({ apiLevel: SERVER_API_LEVEL + 1 }), build).compat, 'page-outdated');
  assert.equal(classifyHealth(health({ version: '0.5.1' }), build).compat, 'version-differs');
  assert.equal(classifyHealth(health(), build).compat, 'ok');
});

test('异常响应（非本服务、ok=false、非对象）不视为可用', () => {
  for (const h of [null, 'x', { ok: false }, { ok: true, service: 'other' }]) assert.equal(classifyHealth(h, build).director, 'failed');
});

test('检测过程：先 checking，超时/HTTP 错误/连接失败都落到 failed，重试成功后 available', async () => {
  const seen = [];
  let mode = 'hang';
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    if (mode === 'hang') { signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); return; }
    if (mode === '500') return resolve({ ok: false, status: 500 });
    if (mode === 'down') return reject(new TypeError('fetch failed'));
    resolve({ ok: true, json: async () => health() });
  });
  const svc = createServiceStatus({ fetchImpl, build, runtime: { mode: 'local', features: { hostedDirector: false } }, timeoutMs: 30, onChange: s => seen.push(s.director) });
  await svc.check();
  assert.equal(seen[0], 'checking');
  assert.equal(svc.state.director, 'failed'); assert.match(svc.state.directorReason, /超时/);
  mode = '500'; await svc.check(); assert.equal(svc.state.director, 'failed'); assert.match(svc.state.directorReason, /500/);
  mode = 'down'; await svc.check(); assert.equal(svc.state.director, 'failed'); assert.match(svc.state.directorReason, /无法连接/);
  mode = 'ok'; await svc.check(); assert.equal(svc.state.director, 'available');
});

test('已安装的同源导演台在本机检测、超时和重试期间一直可用，兼容性错误仍可见', async () => {
  const svc = createServiceStatus({ build, runtime: { mode: 'local', features: { hostedDirector: true } },
    fetchImpl: async () => { throw new Error('synthetic offline local service'); } });
  assert.equal(svc.state.director, 'available');
  await svc.check(); assert.equal(svc.state.director, 'available'); assert.equal(svc.state.directorReason, null);
  assert.equal(svc.state.compat, 'unknown'); assert.match(svc.state.compatReason, /无法连接/);
});

test('服务端资源检查不只看 index.html：manifest、id、entry 与引用资源逐项核对', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r05-director-'));
  try {
    assert.match(checkDirectorAssets(dir).reason, /manifest\.json 不存在/);
    await writeFile(join(dir, 'index.html'), '<script src="./assets/a.js"></script>');
    assert.equal(checkDirectorAssets(dir).available, false, '只有 index.html 不算可用');
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: 'other', entry: 'index.html' }));
    assert.match(checkDirectorAssets(dir).reason, /不是导演台插件/);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: '3d-director-stage', entry: '../x.html' }));
    assert.match(checkDirectorAssets(dir).reason, /entry 不合法/);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: '3d-director-stage', entry: 'index.html', version: '9.9.9' }));
    assert.match(checkDirectorAssets(dir).reason, /assets\/a\.js/, '引用资源缺失');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'a.js'), '');
    assert.match(checkDirectorAssets(dir).reason, /assets\/a\.js/, '空文件不算');
    await writeFile(join(dir, 'assets', 'a.js'), 'x');
    assert.deepEqual(checkDirectorAssets(dir), { available: true, reason: null, pluginVersion: '9.9.9' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
