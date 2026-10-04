import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoEvidence, verifyNodeEvidence, verifyLaunchEvidence } from '../scripts/verify-backend-evidence.mjs';

test('backend gate rejects missing, zero, skipped and incomplete evidence', () => {
  const summary = {kind:'summary', success:true,counts:{tests:1,cancelled:0}}, pass = {kind:'test',status:'pass',name:'auth',file:'server.test.mjs',fileLevel:false};
  verifyNodeEvidence([pass,summary], ['server.test.mjs']);
  for (const rows of [[], [summary], [pass], [{...pass,status:'skip'},summary], [{...pass,fileLevel:true},summary],
    [pass,{...summary,counts:{tests:999}}], [pass,summary,summary], [pass,summary,{kind:'unknown'}], [pass,{...summary,success:false}]])
    assert.throws(() => verifyNodeEvidence(rows,['server.test.mjs']));
  const done = {Action:'pass',Package:'repo/controller'}, go = {...done,Test:'TestAuth'};
  const run = {...go,Action:'run'};
  verifyGoEvidence([run,go,done], {controller:['TestAuth']});
  for (const rows of [[],[done],[go],[{...go,Action:'skip'},done]]) assert.throws(() => verifyGoEvidence(rows,{controller:['TestAuth']}));
  assert.throws(() => verifyGoEvidence([run,go,done],{controller:['TestAuth','TestOwnership']}));
  assert.throws(() => verifyGoEvidence([run,done],{controller:['TestAuth']}));
  assert.throws(() => verifyGoEvidence([run,go,go,done],{controller:['TestAuth']}));
});

test('launch gate rejects wrong source, missing scenarios and invalid load evidence', () => {
  const report = { sourceCommit:'a'.repeat(40), cases:['real-authentication','queued-ownership-and-lost-response-replay',
    'durable-restart-and-account-key-rotation','query-delivery-recovery-and-range-without-regeneration','real-token-revocation',
    'real-group-revocation','browser-real-auth-and-versioned-modules','portal-session-account-switch-revocation-and-stable-task-recovery','bounded-load-four-concurrent-requests'],
    load:{requests:200,concurrency:4,errors:0,errorRate:0,identityChecks:200,ownershipChecks:200,sessionChecks:200,
      elapsedMs:1000,p50Ms:10,p95Ms:30,p99Ms:50,nodeRSSBytes:1000000,nodeCPU:{user:1,system:1}},
    containers:['staging-web','staging-primary'].map(Name=>({Name,MemUsage:'14MiB / 64MiB',CPUPerc:'0.00%'})) };
  verifyLaunchEvidence(report,report.sourceCommit);
  for (const change of [r=>r.cases.pop(),r=>r.sourceCommit='wrong',r=>r.load.errors=1,r=>r.load.p95Ms=NaN,
    r=>r.load.identityChecks=0,r=>r.containers=[],r=>r.containers[0]={}]) {
    const bad=structuredClone(report); change(bad); assert.throws(()=>verifyLaunchEvidence(bad,report.sourceCommit));
  }
});
