import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, createAccountScopedStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { openHostedCanvasSession, ApiError } from '../src/api.js';
import { createTaskRunner } from '../src/gennode.js';
import { createWorkflow } from '../src/workflow.js';
import { createSubmitLock } from '../src/submit-lock.js';
import { taskPhase } from '../src/task-status.js';
import { setKey, clearKey, getFingerprint } from '../src/keyvault.js';

const reply = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});

test('Portal re-login keeps the verified relay fingerprint but cookies accompany only its bound session', async () => {
  const fp='1234567890abcdef';
  await setKey('cs1.sessionA.signature',{verifiedFingerprint:fp});assert.equal(getFingerprint(),fp);
  await setKey('cs1.sessionA2.signature',{verifiedFingerprint:fp});assert.equal(getFingerprint(),fp);
  await assert.rejects(setKey('ordinary-key',{verifiedFingerprint:fp}));
  const options=[];
  const session=await openHostedCanvasSession({storage:createMemoryStorage(),getKey:()=> 'cs1.sessionA2.signature',fetchImpl:async(url,opts)=>{
    options.push(opts);
    if(url.endsWith('/features'))return reply({mode:'hosted',apiVersion:1,features:{cancel:false}});
    if(url.endsWith('/identity'))return reply({subject:'u101'});
    return reply({data:[]});
  }});
  await session.api.listModels();assert.ok(options.every(o=>o.credentials==='same-origin'));
  clearKey();session.invalidate();
});

test('server subject scopes projects, task cache and blobs; old local keys and guest drafts stay separate', async () => {
  const raw = createMemoryStorage();
  await raw.set('project:legacy', { id: 'legacy', name: 'local' });
  const a = createAccountScopedStorage(raw, { subject: 'u101' });
  const b = createAccountScopedStorage(raw, { subject: 'u102' });
  const guest = createAccountScopedStorage(raw, { guest: true });
  const storeA = createStore(a);
  const project = await storeA.newProject('A private');
  await a.set('task:private', { taskId: 'task-a', rev: 1 });
  await a.setBlob('blob:private', new Blob(['a'], { type: 'text/plain' }));
  await guest.set('project:guest', { id: 'guest' });
  assert.equal((await createStore(b).listProjects()).length, 0);
  assert.deepEqual((await createStore(guest).listProjects()).map(p => p.id), ['guest']);
  assert.equal(await b.get('task:private'), undefined);
  assert.equal(await b.getBlob('blob:private'), undefined);
  assert.equal(await a.get('project:legacy'), undefined);
  assert.equal((await a.keys()).some(key => key === `project:${project.id}`), true);
  assert.equal((await raw.keys()).some(key => key === 'project:legacy'), true);
  const [first, second] = await Promise.all([
    a.setIfRev('task:private', 1, { rev: 2 }),
    a.setIfRev('task:private', 1, { rev: 3 }),
  ]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1, 'scoping preserves CAS conflicts');
  a.invalidate();
  await assert.rejects(a.get('task:private'), error => error.code === 'identity_changed');
  await assert.rejects(a.set('task:private', { rev: 4 }), error => error.code === 'identity_changed');
  assert.equal(await b.get('task:private'), undefined);
});

test('late identity and model responses cannot cross a key change or logout', async () => {
  const raw = createMemoryStorage();
  let currentKey = 'key-a';
  let releaseIdentity;
  const pendingIdentity = new Promise(resolve => { releaseIdentity = resolve; });
  const delayedFetch = (url) => String(url).endsWith('/features')
    ? Promise.resolve(reply({ mode: 'hosted', apiVersion: 1, features: { cancel: false } }))
    : pendingIdentity;
  const opening = openHostedCanvasSession({ storage: raw, getKey: () => currentKey, fetchImpl: delayedFetch });
  await new Promise(resolve => setImmediate(resolve));
  currentKey = 'key-b';
  releaseIdentity(reply({ subject: 'u101', displayName: 'A' }));
  await assert.rejects(opening, error => error.code === 'identity_changed');
  assert.deepEqual(await raw.keys(), []);

  currentKey = 'key-a';
  let releaseModels;
  const pendingModels = new Promise(resolve => { releaseModels = resolve; });
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    if (String(url).endsWith('/features')) return Promise.resolve(reply({ mode: 'hosted', apiVersion: 1, features: { cancel: false } }));
    if (String(url).endsWith('/identity')) return Promise.resolve(reply({ subject: 'u101', displayName: 'A' }));
    if (String(url).endsWith('/v1/models')) return pendingModels;
    return Promise.resolve(reply({ error: { code: 'not_found' } }, 404));
  };
  const session = await openHostedCanvasSession({ storage: raw, getKey: () => currentKey, fetchImpl });
  const listing = session.api.listModels();
  session.invalidate();
  releaseModels(reply({ data: [{ id: 'verified-model' }] }));
  await assert.rejects(listing, error => error.code === 'identity_changed');
  await assert.rejects(session.api.listModels(), error => error.code === 'identity_changed');
  assert.equal(calls.filter(x => String(x.url).endsWith('/v1/models')).length, 1);
  assert.equal(calls.every(x => x.options.credentials === 'omit' && x.options.cache === 'no-store' && x.options.redirect === 'manual'), true);
  assert.equal(calls.some(x => x.options.headers?.Cookie), false);
});

test('a new verified key for the same subject can query an imported task without re-POST', async t => {
  t.after(clearKey);
  const raw = createMemoryStorage();
  const scope = createAccountScopedStorage(raw, { subject: 'u101' });
  const store = createStore(scope);
  const source = {
    format: 'xingpan-canvas@2', project: { id: 'old-local-project', name: 'Imported', nodes: [], edges: [], assets: {}, studio: {} },
    tasks: [{ taskId: 'original-task-id', projectId: 'old-local-project', model: 'verified-model',
      keyFp: 'old-local-fingerprint', status: 'queued', idempotencyKey: 'original-idempotency-key',
      bodyString: '{"model":"verified-model","prompt":"synthetic","seconds":5}' }],
    pending: [{ idempotencyKey: 'uncertain-original-key', projectId: 'old-local-project', model: 'verified-model',
      keyFp: 'old-local-fingerprint', state: 'uncertain', bodyString: '{"model":"verified-model","prompt":"synthetic","seconds":5}' }],
  };
  const imported = await store.importJSON(JSON.stringify(source));
  let posts = 0, gets = 0;
  const timers = [];
  const runner = createTaskRunner({ store, storage: scope, accountScope: scope, assets: {},
    api: { getTask: async id => { gets++; assert.equal(id, 'original-task-id'); return { id, status: 'queued' }; },
      createTask: async () => { posts++; throw new Error('must not create'); } },
    pollScheduler: { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {} },
  });
  const [before] = await store.tasksOfProject();
  assert.equal(before.taskId, 'original-task-id');
  assert.equal(before.idempotencyKey, 'original-idempotency-key');
  assert.equal(before.ownerSubject, undefined, 'imported owner claims are not trusted');
  assert.equal((await store.listPending())[0].state, 'uncertain');
  assert.equal((await runner.requery('original-task-id', imported.id)).started, true);
  await timers.shift()();
  const [after] = await store.tasksOfProject();
  assert.equal(gets, 1);
  assert.equal(posts, 0);
  assert.equal(after.taskId, 'original-task-id');
  assert.equal(after.idempotencyKey, 'original-idempotency-key');
  assert.equal(after.keyFp, 'old-local-fingerprint');
  assert.equal(after.ownerSubject, 'u101');
  await setKey('changed-after-old-runner-started');
  if (timers.length) await timers.shift()();
  assert.equal(gets, 1, 'old runner stops after its key session changes');
  runner.stopForIdentityChange();
});

test('hosted feature version and identity failures stop opening a data session', async () => {
  const raw = createMemoryStorage();
  const getKey = () => 'key-a';
  await assert.rejects(openHostedCanvasSession({ storage: raw, getKey,
    fetchImpl: async () => reply({ mode: 'local', apiVersion: 1, features: { cancel: true } }) }),
  error => error instanceof ApiError && error.code === 'unsupported_hosted_api');
  await assert.rejects(openHostedCanvasSession({ storage: raw, getKey,
    fetchImpl: async url => String(url).endsWith('/features')
      ? reply({ mode: 'hosted', apiVersion: 1, features: { cancel: false } })
      : reply({ error: { code: 'auth_required' } }, 401) }),
  error => error instanceof ApiError && error.status === 401);
  assert.deepEqual(await raw.keys(), []);
});

test('hosted workflow invalidates its old key session while a new key retains stable account identity', async t => {
  t.after(clearKey);
  await setKey('hosted-workflow-key-a');
  const raw = createMemoryStorage();
  const first = createAccountScopedStorage(raw, { subject: 'u101' });
  const storeA = createStore(first);
  await storeA.newProject('workflow');
  const node = storeA.addNode('text', 0, 0, { title: 'Text', model: 'synthetic-text', prompt: 'hello' });
  await storeA.flush();
  let posts = 0;
  const deps = { store: storeA, storage: first, accountScope: first, submitLock: async (_name, fn) => fn(),
    generators: { quote: () => 1, generate: async n => { posts++; n.data.resultText = 'synthetic'; } } };
  const oldWorkflow = createWorkflow(deps);
  const plan = (await oldWorkflow.preview({ targets: [node.id] })).plan;
  assert.equal(plan.keyFp, 'u101');
  await setKey('hosted-workflow-key-b');
  await assert.rejects(oldWorkflow.start({ plan, confirmed: true }), error => error.code === 'identity_changed');
  assert.equal(posts, 0);
  first.invalidate();
  const second = createAccountScopedStorage(raw, { subject: 'u101' });
  const storeB = createStore(second);
  await storeB.openProject(storeA.project.id);
  const newWorkflow = createWorkflow({ ...deps, store: storeB, storage: second, accountScope: second });
  const nextPlan = (await newWorkflow.preview({ targets: [node.id] })).plan;
  assert.equal(nextPlan.keyFp, 'u101');
  await newWorkflow.start({ plan: nextPlan, confirmed: true });
  assert.equal(posts, 1);
});

test('account locks use separate names and reject a queued callback after logout', async () => {
  const names = [];
  const locks = { request: async (name, _options, fn) => { names.push(name); return fn(); } };
  const raw = createMemoryStorage();
  const a = createAccountScopedStorage(raw, { subject: 'u101' });
  const b = createAccountScopedStorage(raw, { subject: 'u102' });
  const la = createSubmitLock({ locks, namespace: a.lockNamespace, assertActive: a.assertActive });
  const lb = createSubmitLock({ locks, namespace: b.lockNamespace, assertActive: b.assertActive });
  await la.request('xp-submit:p:n', () => 1);
  await lb.request('xp-submit:p:n', () => 1);
  assert.notEqual(names[0], names[1]);
  a.invalidate();
  assert.throws(() => la.request('xp-submit:p:n', () => 2), error => error.code === 'identity_changed');
});

test('verified hosted task subject keeps pause status usable after key rotation', () => {
  const rec = { taskId: 'original', recVersion: 1, status: 'queued', paused: true,
    pauseSource: 'identity', keyFp: 'old-fingerprint', ownerSubject: 'u101' };
  assert.equal(taskPhase(rec, { keyFp: 'new-fingerprint', accountSubject: 'u101' }), 'paused');
  assert.equal(taskPhase(rec, { keyFp: 'new-fingerprint', accountSubject: 'u102' }), 'need_key');
});

test('uncertain intent cannot be replayed by a rotated Key; the original Key retains the same-body retry', async t => {
  t.after(clearKey);
  const oldDocument = globalThis.document;
  globalThis.document = { getElementById: () => null,
    createElement: () => ({ append() {}, setAttribute() {} }) };
  t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  await setKey('original-user-key');
  const originalFingerprint = getFingerprint();
  await setKey('rotated-user-key');
  const raw = createMemoryStorage();
  const scope = createAccountScopedStorage(raw, { subject: 'u101' });
  const store = createStore(scope);
  await store.newProject('uncertain');
  const node = store.addNode('gen', 0, 0);
  const bodyString = '{"model":"verified-model","prompt":"unchanged","seconds":5}';
  const old = { idempotencyKey: 'original-intent-key', projectId: store.project.id, nodeId: node.id,
    model: 'verified-model', bodyString, keyFp: originalFingerprint, ownerSubject: 'u101',
    createdAt: Date.now() - 20000, lastSubmitAt: Date.now() - 10000, state: 'uncertain' };
  await store.savePendingCreate(old);
  node.data.run = { pendingKey: old.idempotencyKey };
  await store.flush();
  const calls = [];
  let rejection = new ApiError(503, 'upstream_unavailable', 'submit result unknown');
  const runner = createTaskRunner({ store, storage: scope, accountScope: scope, assets: {},
    api: { createTask: async (body, idem) => {
      calls.push({ body, idem });
      throw rejection;
    } },
    pollScheduler: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  await runner.retrySubmit(node);
  assert.deepEqual(calls, [], 'a same-account new Key cannot reuse the gateway idempotency scope');
  const pending = await store.pendingCreate(old.idempotencyKey);
  assert.equal(pending.state, 'uncertain');
  assert.equal(node.data.run.pendingKey, old.idempotencyKey);
  assert.equal((await store.tasksOfProject()).length, 0);
  runner.stopForIdentityChange();
  await setKey('original-user-key');
  const originalScope = createAccountScopedStorage(raw, { subject: 'u101' });
  const originalRunner = createTaskRunner({ store, storage: originalScope, accountScope: originalScope, assets: {},
    api: { createTask: async (body, idem) => { calls.push({ body, idem }); throw rejection; } },
    pollScheduler: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  await originalRunner.retrySubmit(node);
  assert.deepEqual(calls, [{ body: bodyString, idem: old.idempotencyKey }]);
  rejection = new ApiError(409, 'model_billing_unverified', 'new creation paused');
  await originalRunner.retrySubmit(node);
  assert.equal((await store.pendingCreate(old.idempotencyKey)).state, 'uncertain');
  assert.equal(node.data.run.pendingKey, old.idempotencyKey);
  assert.equal(calls.length, 2);
  originalRunner.stopForIdentityChange();
});

test('ordinary workflow preview names paid outputs that would be regenerated', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('regeneration');
  const node = store.addNode('text', 0, 0, { title: 'Paid draft', model: 'synthetic-text',
    prompt: 'x', resultText: 'existing result', operation: { state: 'completed' } });
  const wf = createWorkflow({ store, storage, submitLock: async (_name, fn) => fn(),
    generators: { quote: () => 1, generate: async () => { throw new Error('must not generate in preview'); } } });
  const ordinary = await wf.preview({ targets: [node.id], onlyEmpty: false });
  assert.deepEqual(ordinary.regeneration, [{ id: node.id, title: 'Paid draft', type: 'text' }]);
  await assert.rejects(wf.start({ plan: ordinary.plan }), /显式确认/);
  const onlyEmpty = await wf.preview({ targets: [node.id], onlyEmpty: true });
  assert.deepEqual(onlyEmpty.regeneration, []);
  assert.equal(onlyEmpty.skipSummary.reused, 1);
  const batch = await wf.preview({ targets: [node.id], rows: [{}], onlyEmpty: false });
  assert.deepEqual(batch.regeneration, [], 'new batch clones do not overwrite this output');
});
