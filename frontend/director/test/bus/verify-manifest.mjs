import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = spawnSync(process.execPath, ['tools/run-tests.mjs', '--list'], { encoding: 'utf8' });
assert.equal(manifest.status, 0, manifest.stderr);
const runnable = new Set([...manifest.stdout.matchAll(/^RUN node (\S+)/gm)].map(match => match[1]));
for (const file of readdirSync(new URL('.', import.meta.url)).filter(file => /^verify-.*\.mjs$/.test(file))) assert.ok(runnable.has(`test/bus/${file}`), file);
assert.ok(runnable.size >= 222, `${runnable.size} runnable verification files`);
console.log(`PASS bus acceptance 9: manifest automatically includes bus tests (${runnable.size} Node files)`);
