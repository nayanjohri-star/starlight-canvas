import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateLayer } from './lib/release-gate-core.mjs';

export const HOSTED_API_EVIDENCE_FILES = ['server.test.mjs', 'video-routing.test.mjs',
  'stream-lifecycle.test.mjs', 'image-deadline.test.mjs'];

export function verifyNodeEvidence(rows, requiredFiles) {
  const summaries = rows.filter(r => r.kind === 'summary');
  assert.ok(summaries.length === 1 && summaries[0].success === true, 'missing or contradictory summary');
  const result = evaluateLayer({ layer:{name:'backend',required:true}, run:{ran:true,status:0,signal:null},
    files:{listed:requiredFiles.map(f=>basename(f)),missing:[]},
    reportText:rows.map(r => JSON.stringify(r.kind === 'test' ? {...r,file:basename(r.file || '')} : r)).join('\n') });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
}

export function verifyGoEvidence(rows, requiredByPackage) {
  assert.ok(rows.every(r => ['start','run','pause','cont','pass','bench','output','skip','fail','build-output','build-fail'].includes(r.Action)), 'unknown Go record');
  assert.ok(!rows.some(r => ['skip','fail','build-fail'].includes(r.Action)), 'Go failure or unapproved skip');
  const pending = new Set(), completed = new Set();
  for (const row of rows) {
    if (row.Action !== 'run' && !(row.Action === 'pass' && row.Test)) continue;
    assert.equal(typeof row.Package, 'string', 'missing Go package');
    assert.equal(typeof row.Test, 'string', 'missing Go test name');
    const key = `${row.Package}:${row.Test}`;
    if (row.Action === 'run') {
      assert.ok(!pending.has(key) && !completed.has(key), `duplicate Go test: ${key}`); pending.add(key);
    } else {
      assert.ok(pending.delete(key), `Go pass without run: ${key}`); completed.add(key);
    }
  }
  assert.equal(pending.size, 0, 'incomplete Go tests');
  for (const [pkg, names] of Object.entries(requiredByPackage)) {
    assert.ok(names.length, `zero source tests: ${pkg}`);
    assert.ok(rows.some(r => r.Action === 'pass' && !r.Test && r.Package.endsWith(`/${pkg}`)), `missing package completion: ${pkg}`);
    for (const name of names) assert.ok(rows.some(r => r.Action === 'pass' && r.Test === name && r.Package.endsWith(`/${pkg}`)), `missing test: ${pkg}/${name}`);
  }
}

export function verifyLaunchEvidence(report, commit) {
  assert.equal(report.sourceCommit, commit, 'staging source mismatch');
  const expected = ['real-authentication','queued-ownership-and-lost-response-replay','durable-restart-and-account-key-rotation',
    'query-delivery-recovery-and-range-without-regeneration','real-token-revocation','real-group-revocation',
    'browser-real-auth-and-versioned-modules','portal-session-account-switch-revocation-and-stable-task-recovery','bounded-load-four-concurrent-requests'];
  assert.deepEqual(report.cases, expected, 'missing launch scenarios');
  assert.equal(report.load?.requests,200); assert.equal(report.load.concurrency,4);
  assert.equal(report.load.errors,0); assert.equal(report.load.errorRate,0);
  assert.equal(report.load.identityChecks,200); assert.equal(report.load.ownershipChecks,200);
  assert.equal(report.load.sessionChecks,200);
  for (const key of ['elapsedMs','p50Ms','p95Ms','p99Ms','nodeRSSBytes'])
    assert.ok(Number.isFinite(report.load[key]) && report.load[key]>0, `invalid load metric ${key}`);
  assert.ok(report.load.p95Ms < 2000);
  for (const key of ['user','system']) assert.ok(Number.isFinite(report.load.nodeCPU?.[key]) && report.load.nodeCPU[key]>=0, 'missing CPU measurements');
  assert.equal(report.containers?.length,2, 'missing container measurements');
  for (const name of ['staging-web','staging-primary']) {
    const c = report.containers.find(c=>c.Name===name);
    assert.ok(c && /^[0-9.]+[A-Za-z]+ \/ /.test(c.MemUsage) && /^[0-9.]+%$/.test(c.CPUPerc), `invalid container measurement: ${name}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--launch') {
    verifyLaunchEvidence(JSON.parse(readFileSync(process.argv[3],'utf8')), process.argv[4]);
    console.log('launch evidence verified for exact source commit');
    process.exit(0);
  }
  const repo = resolve(import.meta.dirname, '../../..'), out = resolve(process.argv[2]);
  const rows = name => readFileSync(resolve(out, name), 'utf8').trim().split('\n').map(JSON.parse);
  const gateway = resolve(repo, 'deploy/task-error-gateway');
  for (const file of ['async-video-runtime.test.mjs', 'async-video-gateway.test.mjs', 'server.test.mjs', 'video-delivery.test.mjs']) readFileSync(resolve(gateway,file));
  verifyNodeEvidence(rows('gateway.jsonl'), readdirSync(gateway).filter(f => f.endsWith('.test.mjs')));
  verifyNodeEvidence(rows('adapter.jsonl'), HOSTED_API_EVIDENCE_FILES);
  const newapi = resolve(repo, 'src/new-api');
  for (const file of ['controller/canvas_identity_test.go','controller/canvas_video_ownership_test.go','middleware/auth_test.go','router/channel_access_integration_test.go'])
    assert.match(readFileSync(resolve(newapi,file),'utf8'), /^func Test\w+\(t \*testing\.T\)/m, `empty required test file: ${file}`);
  const required = Object.fromEntries(['controller','middleware','model','router'].map(pkg => [pkg,
    readdirSync(resolve(newapi,pkg)).filter(f => f.endsWith('_test.go')).flatMap(f => [...readFileSync(resolve(newapi,pkg,f),'utf8').matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map(m => m[1]))]));
  for (const name of ['TestCanvasBearerMiddlewareAndVideoOwnership', 'TestGetCanvasIdentityRejectsRevokedTokenAndDefaultGroups',
    'TestCanvasVideoOwnershipUsesGatewayScopeUntilTaskExists', 'TestCanvasVideoOwnershipAcceptsLegacyHeaderScopeAndFailsClosedWithoutGatewayTable'])
    assert.ok(required.controller.includes(name), `missing required security test: ${name}`);
  verifyGoEvidence(rows('go-test.jsonl'), required);
  console.log('backend evidence verified: every package/test completed; no zero tests or unapproved skips');
}
