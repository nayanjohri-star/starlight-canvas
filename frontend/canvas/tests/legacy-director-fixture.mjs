// Explicit legacy-plugin fixtures. Default builds use the same-origin hosted
// director; these fixtures retain optional MiniMax resource/status coverage.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveRuntime, runtimeModuleSource } from '../scripts/lib/runtime-config.mjs';

export function legacyDirectorRuntime() {
  const runtime = resolveRuntime({ mode: 'local' });
  return { ...runtime, features: { ...runtime.features, hostedDirector: false } };
}

export async function installLegacyDirectorRuntime(context, directorStatus = null) {
  await context.route('**/runtime-config.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript; charset=utf-8',
    body: runtimeModuleSource(legacyDirectorRuntime()),
  }));
  if (directorStatus) await context.route('**/health', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, director: directorStatus, director_available: directorStatus.available } });
  });
}

// Native legacy bridge unit tests load the current implementation with an
// explicit legacy runtime module. All other imports resolve to real sources;
// production runtime defaults and source files remain untouched.
export async function loadLegacyDirectorSource() {
  const file = new URL('../src/director.js', import.meta.url);
  const source = readFileSync(file, 'utf8');
  assert.match(source, /from ['"]\.\/runtime-config\.js['"]/);
  const runtime = 'data:text/javascript;base64,' + Buffer.from(runtimeModuleSource(legacyDirectorRuntime())).toString('base64');
  const resolveImport = specifier => specifier === './runtime-config.js' ? runtime : new URL(specifier, file).href;
  const fixture = source.replace(/\bfrom (['"])(\.[^'"]+)\1/g, (match, quote, specifier) =>
    `from ${quote}${resolveImport(specifier)}${quote}`)
    .replace(/\bimport\(\s*(['"])(\.[^'"]+)\1\s*\)/g, (match, quote, specifier) =>
      `import(${quote}${resolveImport(specifier)}${quote})`);
  return import('data:text/javascript;base64,' + Buffer.from(fixture).toString('base64'));
}

// Canvas regression suites check entry assembly, not 3D correctness. Serve an
// inert document at the real requested director entry; independent hosted
// acceptance loads the complete renderer and tests media/WebGL separately.
export async function installDirectorAssemblyFixture(context) {
  const entries = [];
  await context.route(/\/director\/index\.html(?:\?|$)/, route => {
    entries.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="zh-CN"><body><p data-director-assembly-fixture>导演台入口装配测试</p></body></html>' });
  });
  return entries;
}

export function assertHostedDirectorEntry(src, origin, { projectId, nodeId }) {
  const url = new URL(src, origin);
  assert.equal(url.origin, origin, '导演台使用画布同源入口');
  assert.ok(url.pathname.endsWith('/director/index.html'), '加载发布物中的导演台入口');
  assert.equal(url.searchParams.get('projectId'), projectId);
  assert.equal(url.searchParams.get('nodeId'), nodeId);
  assert.ok(url.searchParams.get('sessionId'), '每次打开绑定独立会话');
  assert.equal(url.searchParams.has('nonce'), false, '不使用旧插件桥参数');
}
