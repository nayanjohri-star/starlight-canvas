import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyGateEvidence } from '../scripts/package-release.mjs';
import { LAYERS } from '../scripts/release-gate.config.mjs';

const SHA = 'a'.repeat(40), HASH = 'b'.repeat(64);
const CONFIG_HASH = createHash('sha256').update(readFileSync(new URL('../scripts/release-gate.config.mjs', import.meta.url))).digest('hex');
const build = { sourceCommit: SHA, sourceDirty: false, version: '0.5.0', capabilityVersion: '2026-09-18.1', contentHash: HASH };
const report = () => ({
  kind: 'canvas-release-gate', mode: 'strict', source: { sha: SHA, dirty: false },
  config: { path: 'scripts/release-gate.config.mjs', sha256: CONFIG_HASH },
  version: build.version, capabilityVersion: build.capabilityVersion, build: { ...build },
  artifact: { before: HASH, after: HASH }, envOverride: {}, gate: { ok: true, blockers: [] },
  layers: LAYERS.map(l => ({ layer: l.name, required: l.required !== false, ok: true, outcome: 'passed' })),
});

test('正式打包只接受同提交、同产物且全部必需层通过的严格门禁报告', () => {
  assert.equal(verifyGateEvidence(build, report(), SHA), true);
  const cases = [
    r => { r.source.sha = 'other'; },
    r => { r.source.dirty = true; },
    r => { r.config.path = 'scripts/test-gate.config.mjs'; },
    r => { r.config.sha256 = 'other'; },
    r => { r.build.sourceCommit = 'other'; },
    r => { r.build.sourceDirty = true; },
    r => { r.artifact.after = 'other'; },
    r => { r.envOverride.browser = false; },
    r => { r.gate.ok = false; },
    r => { r.layers.find(l => l.layer === 'recovery').ok = false; },
    r => { r.layers = r.layers.filter(l => l.layer !== 'unit'); },
  ];
  for (const change of cases) {
    const altered = report(); change(altered);
    assert.throws(() => verifyGateEvidence(build, altered, SHA), /严格门禁证据无效/);
  }
});
