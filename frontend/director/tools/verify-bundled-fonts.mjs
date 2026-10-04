// SPDX-License-Identifier: AGPL-3.0-or-later
// Execute only the font resolver extracted from the actual bundled module.
// Every fetch is synthetic; a CDN attempt fails without using the network.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseAst } from 'rolldown/parseAst';

const bundle = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist/', import.meta.url));
const candidates = [];
for (const name of await readdir(join(bundle, 'assets'))) {
  if (!name.endsWith('.js')) continue;
  const source = await readFile(join(bundle, 'assets', name), 'utf8');
  if (!source.includes('getFontsForString') || !source.includes('codepoint-index/plane')) continue;
  const stack = [parseAst(source)];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'FunctionDeclaration') {
      const text = source.slice(node.start, node.end);
      if (text.includes('getFontsForString') && text.includes('codepoint-index/plane') && text.includes('/font-files/'))
        candidates.push(text);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value.filter(item => item && typeof item === 'object'));
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
}
assert.equal(candidates.length, 1, 'the production module contains one reviewed standalone font resolver');
const source = candidates[0], origin = 'https://bundled-font-test.invalid', prefix = '/fonts/unicode-local/';
const quietConsole = { log() {}, warn() {}, error() {}, debug() {} };
const resolver = fetch => runInNewContext(`(${source})`, { fetch, console: quietConsole }, { timeout: 1000 })();
const requests = [];
const success = resolver(async value => {
  const url = new URL(value); requests.push(url.origin);
  assert.equal(url.origin, origin, 'the actual factory never fetches an external font index');
  assert.ok(url.pathname.startsWith(prefix));
  const path = url.pathname.slice(prefix.length); assert.ok(!path.includes('..'));
  const body = await readFile(join(bundle, 'fonts/unicode-local', path), 'utf8');
  return { ok: true, json: async () => JSON.parse(body) };
});
const fonts = await success.getFontsForString('测试人物 A 😀 𠀀', { dataUrl: origin + '/fonts/unicode-local' });
assert.deepEqual(Array.from(fonts.fontUrls), [origin + '/fonts/unicode-local/font-files/noto-sc/sans-serif.normal.400.woff']);
assert.ok(requests.length > 0);
const failures = [];
const failure = resolver(async value => {
  failures.push(new URL(value).origin);
  return { ok: false, statusText: '404 synthetic local font index' };
});
await assert.rejects(failure.getFontsForString('本地失败', { dataUrl: origin + '/fonts/unicode-local' }), /404 synthetic/);
assert.ok(failures.length > 0);
assert.ok(failures.every(value => value === origin), 'a failed local font index must not retry a public CDN');
assert.ok(!source.includes('trying default CDN.'));
console.log('PASS actual bundled Troika factory: Chinese, emoji, rare Unicode and failed indexes stay local');
