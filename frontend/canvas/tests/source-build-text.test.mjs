// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizedText, distContentHash } from '../scripts/build.mjs';
import { buildZip } from '../../director/src/zip-store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Actual source.zip members that differed between the clean Windows 639b
// artifact and the same commit's raw Git archive on 2026-10-01.
const FULL_TEXT_MEMBERS = [
  'deploy/canvas-hosted-api/Caddyfile.session-staging',
  'deploy/canvas-hosted-api/production-staging.go',
  'deploy/canvas-web/Dockerfile.gateway-compat',
  'deploy/canvas-web/Dockerfile.new-api-compat',
  'deploy/canvas-web/Dockerfile.portal-compat',
  'deploy/canvas-web/canvas-web.env.example',
  'frontend/canvas/tests/hosted-ci/Caddyfile.primary',
  ...['giant', 'tiny', 'unit'].flatMap(size => ['fbx', 'obj'].map(ext =>
    `frontend/director/test/fixtures/${size}-cube.${ext}`)),
  'frontend/director/test/snapshots/arrival-camera.usda',
  'frontend/director/test/snapshots/courtyard-cut-list.otio',
  'frontend/director/tools/morphgs/patches/preprocess_src-none-mode.patch',
];
const sourceIdentity = await readFile(join(ROOT, 'SOURCE-VERSION.json'), 'utf8').then(JSON.parse).catch(() => null);
const community = sourceIdentity?.kind === 'canvas-open-source-candidate';
// Community packages deliberately omit production deployment overlays. Keep
// the same byte/hash assertions for all ten actual community source members;
// the production repository still exercises all sixteen original members.
const TEXT_MEMBERS = community ? FULL_TEXT_MEMBERS.filter(p => !p.startsWith('deploy/')) : FULL_TEXT_MEMBERS;
const lf = bytes => Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
const endings = (bytes, ending) => Buffer.from(lf(bytes).toString('utf8').replace(/\n/g, ending), 'utf8');

async function members(ending) {
  return Promise.all(TEXT_MEMBERS.map(async name => ({ name,
    data: normalizedText(name, endings(await readFile(join(ROOT, name)), ending)) })));
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'xp-source-eol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function graph(root, entries) {
  await mkdir(join(root, 'director'), { recursive: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.data);
  }
  const zip = buildZip(entries);
  await writeFile(join(root, 'director/source.zip'), zip);
  return { zip, hash: await distContentHash(root) };
}

test(`source text: all ${TEXT_MEMBERS.length} packaged real members canonicalize LF, CRLF and CR identically`, async () => {
  assert.equal(FULL_TEXT_MEMBERS.length, 16);
  assert.equal(TEXT_MEMBERS.length, community ? 10 : 16);
  for (const name of TEXT_MEMBERS) {
    const original = await readFile(join(ROOT, name));
    for (const ending of ['\n', '\r\n', '\r'])
      assert.deepEqual(normalizedText(name, endings(original, ending)), lf(original), name);
  }
});

test('source text: real member ZIP bytes and the full public graph hash match across platforms', async t => {
  const root = await temporary(t);
  const unix = await graph(join(root, 'lf'), await members('\n'));
  const windows = await graph(join(root, 'crlf'), await members('\r\n'));
  const classic = await graph(join(root, 'cr'), await members('\r'));
  assert.deepEqual(windows.zip, unix.zip);
  assert.deepEqual(classic.zip, unix.zip);
  assert.equal(windows.hash, unix.hash);
  assert.equal(classic.hash, unix.hash);
});

const binaryFbx = () => {
  const version = Buffer.alloc(4); version.writeUInt32LE(7400);
  return Buffer.concat([Buffer.from('Kaydara FBX Binary  \0\x1a\0'), version,
    Buffer.alloc(13), Buffer.from([0xff, 0xfe, 0x0d, 0x0a, 0x00, 0x81])]);
};

test('source binary: binary FBX header, NUL and invalid UTF-8 block FBX text decoding', () => {
  for (const data of [binaryFbx(), Buffer.from('FBX\0property\r\n'), Buffer.from([0xc3, 0x28, 0x0d, 0x0a])]) {
    assert.equal(normalizedText('scene.fbx', data), data, 'keep the original binary Buffer');
    assert.deepEqual(normalizedText('scene.fbx', data), data);
  }
  const binaryObj = Buffer.from([0x64, 0x86, 0, 1, 13, 10]);
  assert.equal(normalizedText('compiled.obj', binaryObj), binaryObj, 'OBJ also names binary object files');
});

test('source binary: real GLB/font and opaque PNG/ZIP/unknown bytes are preserved', async () => {
  const entries = [
    { name: 'cube.glb', data: await readFile(join(ROOT, 'frontend/director/test/fixtures/unit-cube.glb')) },
    { name: 'inter.woff2', data: await readFile(join(ROOT, 'frontend/director/public/fonts/inter-latin.woff2')) },
    { name: 'image.png', data: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('payload\r\n')]) },
    { name: 'project.zip', data: Buffer.from(buildZip([{ name: 'text.txt', data: 'inner\r\nbytes' }])) },
    { name: 'opaque.bin', data: Buffer.from('valid UTF-8\r\nis still binary by path') },
  ];
  for (const { name, data } of entries) assert.equal(normalizedText(name, data), data, name);
});

test('source binary: CRLF changes in binary assets retain distinct ZIP bytes and graph hashes', async t => {
  const root = await temporary(t);
  for (const name of ['scene.fbx', 'scene.glb', 'font.woff', 'image.png', 'archive.zip']) {
    const prefix = name.endsWith('.fbx') ? binaryFbx() : Buffer.from([0, 255, 128, 1]);
    const left = Buffer.concat([prefix, Buffer.from('raw\r\nbytes')]);
    const right = Buffer.concat([prefix, Buffer.from('raw\nbytes')]);
    const a = await graph(join(root, name + '-crlf'), [{ name, data: normalizedText(name, left) }]);
    const b = await graph(join(root, name + '-lf'), [{ name, data: normalizedText(name, right) }]);
    assert.deepEqual(normalizedText(name, left), left, name);
    assert.deepEqual(normalizedText(name, right), right, name);
    assert.notDeepEqual(a.zip, b.zip, name);
    assert.notEqual(a.hash, b.hash, name);
  }
});

async function builtFiles(directory, base = directory) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await builtFiles(path, base));
    else files[path.slice(base.length + 1).replaceAll('\\', '/')] =
      createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return files;
}
async function htmlFixture(root, lineEnding, plugins, build, config) {
  await mkdir(root, { recursive: true });
  const html = ['<!doctype html>', '<html><head>', '', '<title>Fixture</title>', '</head>',
    '<body><div id="root">Load</div>', '', '<script type="module" src="./main.js"></script></body>',
    '</html>', ''].join(lineEnding);
  const input = Buffer.from(html);
  await writeFile(join(root, 'index.html'), input);
  await writeFile(join(root, 'main.js'), 'console.log("html-line-ending-fixture");\n');
  await build({ ...config, configFile: false, root, plugins, logLevel: 'silent',
    build: { ...config.build, outDir: 'dist', emptyOutDir: true } });
  assert.deepEqual(await readFile(join(root, 'index.html')), input, 'build must not rewrite the source HTML');
  return { html: await readFile(join(root, 'dist/index.html'), 'utf8'), files: await builtFiles(join(root, 'dist')) };
}

test('HTML baseline: locked real Vite without the pre-hook retains the CRLF script-removal counterexample', async t => {
  const root = await temporary(t);
  const { build } = await import('../../director/node_modules/vite/dist/node/index.js');
  const { default: config } = await import('../../director/vite.config.js');
  const plugins = config.plugins.filter(plugin => plugin.name !== 'starlight-html-line-endings');
  const a = await htmlFixture(join(root, 'lf'), '\n', plugins, build, config);
  const b = await htmlFixture(join(root, 'crlf'), '\r\n', plugins, build, config);
  assert.notEqual(b.html.replace(/\r\n?/g, '\n'), a.html,
    'the pre-fix output has an extra normalized newline, not merely CRLF bytes');
});

test('HTML fix: actual production pre-hook preserves author blank lines and yields identical Vite outputs', async t => {
  const root = await temporary(t);
  const { build } = await import('../../director/node_modules/vite/dist/node/index.js');
  const { default: config } = await import('../../director/vite.config.js');
  const plugin = config.plugins.find(plugin => plugin.name === 'starlight-html-line-endings');
  assert.ok(plugin, 'the tested hook must be included in the real production config');
  assert.equal(plugin.transformIndexHtml.order, 'pre');
  assert.equal(plugin.transformIndexHtml.handler('a\r\n\r\nb\r'), 'a\n\nb\n', 'do not trim author blank lines');
  const a = await htmlFixture(join(root, 'lf'), '\n', config.plugins, build, config);
  const b = await htmlFixture(join(root, 'crlf'), '\r\n', config.plugins, build, config);
  assert.deepEqual(b.files, a.files, 'all actual emitted resource paths and byte hashes must match');
  assert.equal(b.html, a.html);
});
