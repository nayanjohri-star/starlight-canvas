import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distContentHash } from '../scripts/build.mjs';
import { verifyHostedDirectorCLI } from '../scripts/verify-hosted-director-evidence.mjs';
import { HOSTED_DIRECTOR_REQUIRED_FILES as REQUIRED, HOSTED_DIRECTOR_EVIDENCE_KIND,
  evidenceSha256, evaluateHostedDirectorEvidence } from '../scripts/lib/hosted-director-evidence.mjs';
import { evaluateLayer } from '../scripts/lib/release-gate-core.mjs';
import { LAYERS } from '../scripts/release-gate.config.mjs';

const SHA = 'a'.repeat(40), HASH = 'b'.repeat(64);
const build = () => ({ sourceCommit: SHA, sourceDirty: false, mode: 'hosted', contentHash: HASH,
  basePath: '/canvas/', apiBase: '/canvas-api', version: '0.5.0', builtAt: '2026-09-30T00:00:00.000Z' });
const cases = () => REQUIRED.map((file, i) => ({ kind: 'test', status: 'pass', name: `case ${i}`, file,
  nesting: 0, testType: 'test', fileLevel: false }));
const summary = rows => {
  const counted = rows.filter(t => t.testType !== 'suite');
  return { kind: 'summary', success: true, counts: { tests: counted.length,
    passed: counted.filter(t => t.status === 'pass').length, failed: counted.filter(t => t.status === 'fail').length,
    skipped: counted.filter(t => t.status === 'skip').length, todo: counted.filter(t => t.status === 'todo').length,
    cancelled: 0, suites: rows.filter(t => t.testType === 'suite').length } };
};
const report = (rows = cases(), summaries = [summary(rows)]) => [...rows, ...summaries].map(r => JSON.stringify(r)).join('\n') + '\n';
function evidence(reportText = report(), overrides = {}) {
  const buildText = JSON.stringify(build());
  return { reportText, buildText, candidate: SHA,
    identity: { kind: HOSTED_DIRECTOR_EVIDENCE_KIND, candidate: SHA, contentHash: HASH,
      buildSha256: evidenceSha256(buildText), before: HASH, after: HASH,
      reportSha256: evidenceSha256(reportText), run: { ran: true, status: 0, signal: null } }, ...overrides };
}
const rejects = (input, code) => {
  const r = evaluateHostedDirectorEvidence(input);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => p.code === code), JSON.stringify(r.problems));
  return r;
};

test('one complete report covers every mandatory director file and agrees with the packaged build', () => {
  const r = evaluateHostedDirectorEvidence(evidence(report(), { candidateBuild: build() }));
  assert.equal(r.ok, true); assert.equal(r.counts.tests, REQUIRED.length); assert.deepEqual(r.files, REQUIRED);
  const configured = LAYERS.find(l => l.name === 'hosted-director');
  assert.deepEqual(configured.requiredFiles, REQUIRED); assert.equal(configured.strictEvidence, true);
});

test('a silent or empty mandatory file cannot be covered by passes from the others', () => {
  rejects(evidence(report(cases().slice(1))), 'file_without_tests');
  const rows = cases(); rows[0] = { ...rows[0], name: rows[0].file, fileLevel: true };
  const r = rejects(evidence(report(rows)), 'file_without_tests');
  assert.equal(r.counts.tests, REQUIRED.length - 1, 'file-level pass is never a case');
  rejects(evidence(report(), { missingFiles: [REQUIRED[0]] }), 'missing_required_files');
});

test('a passing suite with no actual test cannot cover a required file', () => {
  const rows = cases(); rows[0].testType = 'suite';
  rejects(evidence(report(rows)), 'file_without_tests');
});

test('zero cases, absent/duplicate summaries and malformed records all fail closed', () => {
  rejects(evidence(report([])), 'zero_tests');
  rejects(evidence(report(cases(), [])), 'incomplete_report');
  rejects(evidence(report(cases(), [summary(cases()), summary(cases())])), 'report_parse_error');
  rejects(evidence(report() + '{broken\n'), 'report_parse_error');
  const rows = cases(); delete rows[0].testType;
  rejects(evidence(report(rows)), 'invalid_test_record');
});

test('every summary counter and its explicit success flag must match the actual records', () => {
  for (const field of ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled', 'suites']) {
    const s = summary(cases()); s.counts[field]++;
    rejects(evidence(report(cases(), [s])), 'incomplete_report');
    delete s.counts[field];
    rejects(evidence(report(cases(), [s])), 'incomplete_report');
  }
  for (const success of [false, null, undefined]) {
    const s = summary(cases()); s.success = success;
    rejects(evidence(report(cases(), [s])), 'incomplete_report');
  }
});

test('skip, todo, fail, cancellation and nonzero/incomplete process results are rejected', () => {
  for (const [status, code] of [['skip', 'unapproved_skip'], ['todo', 'todo_tests'], ['fail', 'test_failures']]) {
    const rows = cases(); rows[0].status = status;
    rejects(evidence(report(rows)), code);
  }
  for (const run of [{ ran: false }, { ran: true, status: 1 }, { ran: true, status: 77 }, { ran: true, status: null, signal: 'SIGKILL' }]) {
    const e = evidence(); e.identity.run = run;
    assert.equal(evaluateHostedDirectorEvidence(e).ok, false);
  }
  const s = summary(cases()); s.counts.cancelled = 1;
  rejects(evidence(report(cases(), [s])), 'cancelled_tests');
});

test('hosted strict mode does not accept an allowlisted skip or relax other layer policies', () => {
  const rows = cases(); rows[0] = { ...rows[0], status: 'skip', skipReason: 'historical contract' };
  const input = { run: { ran: true, status: 0 }, files: { listed: REQUIRED, missing: [] }, reportText: report(rows),
    allowlist: [{ file: rows[0].file, test: rows[0].name, reason: rows[0].skipReason }] };
  assert.equal(evaluateLayer({ ...input, layer: { name: 'existing', required: true } }).ok, true);
  assert.equal(evaluateLayer({ ...input, layer: { name: 'hosted-director', required: true, strictEvidence: true } }).ok, false);
});

test('same basenames in another directory and unrelated passing files do not replace mandatory tests', () => {
  const rows = cases(); rows[0].file = rows[0].file.replace('tests/', 'other/');
  rejects(evidence(report(rows)), 'file_without_tests');
  rejects(evidence(report([...cases(), { ...cases()[0], file: 'tests/unrelated.test.mjs' }])), 'unexpected_test_file');
});

test('candidate commit, clean hosted build, full build identity and byte bindings must agree', () => {
  for (const patch of [{ sourceCommit: 'c'.repeat(40) }, { sourceDirty: true }, { mode: 'local' },
    { contentHash: 'invalid' }, { basePath: '/' }, { apiBase: '/api' }]) {
    const e = evidence(); e.buildText = JSON.stringify({ ...build(), ...patch });
    e.identity.buildSha256 = evidenceSha256(e.buildText);
    rejects(e, 'build_identity_mismatch');
  }
  for (const field of ['kind', 'candidate', 'contentHash', 'buildSha256', 'before', 'after']) {
    const e = evidence(); e.identity[field] = 'different'; rejects(e, 'build_identity_mismatch');
  }
  const changed = evidence(); changed.reportText += '\n'; rejects(changed, 'report_identity_mismatch');
  for (const patch of [{ sourceCommit: 'c'.repeat(40) }, { contentHash: 'd'.repeat(64) }, { builtAt: 'different' }])
    rejects(evidence(report(), { candidateBuild: { ...build(), ...patch } }), 'candidate_build_mismatch');
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hosted-director-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist'), out = join(dir, 'evidence');
  await mkdir(dist); await mkdir(join(dir, 'tests'));
  await writeFile(join(dist, 'app.js'), 'export const synthetic = true;\n');
  const manifest = { ...build(), contentHash: await distContentHash(dist) };
  await writeFile(join(dist, 'build.json'), JSON.stringify(manifest));
  for (const [index, file] of REQUIRED.entries())
    await writeFile(join(dir, file), index === 0
      ? "import { test, describe } from 'node:test'; describe('actual suite', () => test('actual case', () => {}));\n"
      : "import test from 'node:test'; test('actual case', () => {});\n");
  const common = ['--evidence', out, '--candidate', SHA];
  await verifyHostedDirectorCLI(['--capture', ...common, '--dist', dist]);
  const execute = () => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--test', '--test-concurrency=1',
      `--test-reporter=${pathToFileURL(resolve(import.meta.dirname, '../scripts/lib/jsonl-reporter.mjs')).href}`,
      `--test-reporter-destination=${join(out, 'director.jsonl')}`, ...REQUIRED],
    { cwd: dir, env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  };
  return { dir, dist, out, common, execute };
}

test('real Node reporter → captured build → seal → fresh verdict CLI validates every mandatory file', async t => {
  const f = await fixture(t), run = f.execute();
  assert.equal(run.status, 0, run.stderr);
  const seal = await verifyHostedDirectorCLI(['--seal', ...f.common, '--dist', f.dist, '--exit-code', String(run.status)]);
  assert.equal(seal.counts.tests, REQUIRED.length, 'suite completion is not counted as a case');
  const cli = resolve(import.meta.dirname, '../scripts/verify-hosted-director-evidence.mjs');
  const verdict = spawnSync(process.execPath, [cli, ...f.common, '--candidate-build', join(f.dist, 'build.json')],
    { cwd: f.dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(verdict.status, 0, verdict.stderr); assert.equal(JSON.parse(verdict.stdout).verified, true);
  await assert.rejects(verifyHostedDirectorCLI(['--capture', ...f.common, '--dist', f.dist]), /existing captured run/);
  await assert.rejects(verifyHostedDirectorCLI(['--seal', ...f.common, '--dist', f.dist, '--exit-code', '0']), /reseal/);
  await writeFile(join(f.dist, 'app.js'), 'different bytes');
  await assert.rejects(verifyHostedDirectorCLI([...f.common, '--candidate-build', join(f.dist, 'build.json')]), /candidate package bytes/);
});

test('real empty-file success is rejected and failure evidence remains available', async t => {
  const f = await fixture(t); await writeFile(join(f.dir, REQUIRED[1]), '// intentionally empty file\n');
  const run = f.execute(); assert.equal(run.status, 0);
  await assert.rejects(verifyHostedDirectorCLI(['--seal', ...f.common, '--dist', f.dist, '--exit-code', '0']), /file_without_tests/);
  const result = JSON.parse(await readFile(join(f.out, 'verification.json'), 'utf8'));
  assert.equal(result.ok, false); assert.ok(result.problems.some(p => p.code === 'file_without_tests'));
});

test('an explicit missing file cannot pass just because Node ran the other required paths', async t => {
  const f = await fixture(t); await rm(join(f.dir, REQUIRED[0]));
  const run = f.execute(); assert.notEqual(run.status, null, run.stderr);
  await assert.rejects(verifyHostedDirectorCLI(['--seal', ...f.common, '--dist', f.dist, '--exit-code', String(run.status)]), /file_without_tests/);
});

test('changed test artifact, changed build identity and altered JSONL fail the CLI', async t => {
  const f = await fixture(t); assert.equal(f.execute().status, 0);
  const original = await readFile(join(f.dist, 'build.json'), 'utf8');
  await writeFile(join(f.dist, 'build.json'), original + '\n');
  await assert.rejects(verifyHostedDirectorCLI(['--seal', ...f.common, '--dist', f.dist, '--exit-code', '0']), /build.json changed/);
  await writeFile(join(f.dist, 'build.json'), original);
  await writeFile(join(f.dist, 'app.js'), 'changed after capture');
  await assert.rejects(verifyHostedDirectorCLI(['--seal', ...f.common, '--dist', f.dist, '--exit-code', '0']), /build_identity_mismatch/);
  const g = await fixture(t); assert.equal(g.execute().status, 0);
  await verifyHostedDirectorCLI(['--seal', ...g.common, '--dist', g.dist, '--exit-code', '0']);
  const path = join(g.out, 'director.jsonl'); await writeFile(path, await readFile(path, 'utf8') + '\n');
  await assert.rejects(verifyHostedDirectorCLI([...g.common, '--candidate-build', join(g.dist, 'build.json')]), /report_identity_mismatch/);
});

test('verdict cannot accept an unsealed run, an omitted package identity or unknown CLI arguments', async t => {
  const f = await fixture(t); assert.equal(f.execute().status, 0);
  await assert.rejects(verifyHostedDirectorCLI([...f.common, '--candidate-build', join(f.dist, 'build.json')]), /not_run/);
  await assert.rejects(verifyHostedDirectorCLI(f.common), /candidate-build/);
  await assert.rejects(verifyHostedDirectorCLI(['--seal', ...f.common, '--dist', f.dist]), /real --exit-code/);
  await assert.rejects(verifyHostedDirectorCLI([...f.common, '--allow-dirty']), /unknown or duplicate/);
});
