// 托管发布物验收：目录结构、SHA256SUMS、无本机专属/测试文件、未验证标记、正式打包的证据核验与拒绝覆盖。
// 不重建 dist-hosted（严格门禁在开头构建并对其做前后哈希核对）；单独运行且缺失时才构建一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { packageHosted, verifyHostedEvidence } from '../scripts/package-hosted.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

test.before(() => {
  if (!existsSync(join(ROOT, 'dist-hosted', 'build.json'))) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--mode', 'hosted'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

test('未附门禁证据的托管发布物：标记为未验证；结构、校验和、内容边界正确；拒绝覆盖', async t => {
  const out = await mkdtemp(join(tmpdir(), 'canvas-web-pkg-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const res = await packageHosted({ out, log: () => {} });
  assert.equal(res.verified, false);
  assert.match(res.name, /-UNVERIFIED$/);
  const release = JSON.parse(readFileSync(join(res.dir, 'release.json'), 'utf8'));
  assert.equal(release.verified, false); assert.match(release.note, /不得部署/);
  assert.equal(release.basePath, '/canvas/'); assert.equal(release.apiBase, '/canvas-api');
  const files = walk(res.dir).map(p => relative(res.dir, p).replaceAll('\\', '/'));
  for (const f of ['site/canvas/index.html', 'site/canvas/runtime-config.js', 'site/canvas/build.json', 'site/canvas/capabilities.json',
    'api/server.mjs', 'deploy/Caddyfile', 'deploy/primary-site.caddy', 'deploy/compose.canvas-web.yaml', 'deploy/README.md', 'release.json', 'SHA256SUMS'])
    assert.ok(files.includes(f), `缺少 ${f}`);
  const build = JSON.parse(readFileSync(join(res.dir, 'site/canvas/build.json'), 'utf8'));
  assert.match(build.assetPath, /^releases\/[a-f0-9]{64}\/$/, '导演台与画布属于同一版本资源目录');
  const director = `site/canvas/${build.assetPath}director/`;
  for (const file of ['index.html', 'source.zip'])
    assert.ok(files.includes(director + file), `托管发布物缺少导演台必需文件：${file}`);
  assert.ok(files.some(file => file.startsWith(director + 'assets/') && file.endsWith('.js')), '包含按需加载的导演台程序');
  const directorSource = readFileSync(join(res.dir, director, 'source.zip'));
  for (const entry of ['frontend/director/LICENSE', 'frontend/director/THIRD_PARTY_NOTICES.md',
    'frontend/director/UPSTREAM.json', 'frontend/director/package-lock.json', 'frontend/canvas/src/director-hosted.js'])
    assert.ok(directorSource.includes(Buffer.from(entry)), `导演台公开源码包缺少 ${entry}`);
  assert.deepEqual(files.filter(file => /(?:^|\/)(?:3d-director-stage|__hub-sdk__\.js)(?:\/|$)/.test(file)), [], '不分发旧本机插件或 SDK');
  assert.deepEqual(files.filter(f => /__hub-sdk__|\.test\.mjs$|node_modules|server\//.test(f)), [], '不含本机专属文件、测试或服务端代码');
  assert.match(readFileSync(join(res.dir, 'site/canvas/runtime-config.js'), 'utf8'), /mode: "hosted"/);
  const sums = readFileSync(join(res.dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, files.length - 1);
  for (const line of sums) {
    const hash = line.slice(0, 64), rel = line.slice(66);
    assert.equal(createHash('sha256').update(readFileSync(join(res.dir, rel))).digest('hex'), hash, rel);
  }
  await assert.rejects(packageHosted({ out, log: () => {} }), /拒绝覆盖/);
  await assert.rejects(packageHosted({ log: () => {} }), /--out/);
});

test('正式打包：缺少门禁报告拒绝；托管证据与产物不符（提交/哈希/形态/路径）一律拒绝', async () => {
  await assert.rejects(packageHosted({ out: tmpdir(), requireClean: true, log: () => {} }), /未提交改动|--gate-report/);
  const build = { mode: 'hosted', sourceCommit: 'abc', contentHash: 'h1', basePath: '/canvas/', apiBase: '' };
  const good = { hostedBuild: { ...build }, hostedArtifact: { before: 'h1', after: 'h1' } };
  assert.equal(verifyHostedEvidence(build, good, 'abc'), true);
  assert.throws(() => verifyHostedEvidence(build, good, 'other'), /提交不一致/);
  assert.throws(() => verifyHostedEvidence(build, { ...good, hostedArtifact: { before: 'h1', after: 'h2' } }, 'abc'), /哈希不一致/);
  assert.throws(() => verifyHostedEvidence({ ...build, mode: 'local' }, good, 'abc'), /不是托管构建/);
  assert.throws(() => verifyHostedEvidence(build, { ...good, hostedBuild: { ...build, apiBase: '/x' } }, 'abc'), /路径或 API 根/);
  assert.throws(() => verifyHostedEvidence(build, { hostedArtifact: good.hostedArtifact }, 'abc'), /提交不一致/);
});
