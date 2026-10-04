import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, createAccountScopedStorage } from '../src/storage.js';
import { setModelCatalog, setAvailableModels, clearKey, setKey } from '../src/keyvault.js';
import { createDirectorProposals, directorProposalOperationKey, normalizeProposalContext, validateProposalCommands, quoteProposalPrice } from '../src/director-proposals.js';

const framing = { pos: { x: 0, y: 1.6, z: 5 }, yaw: 0, pitch: 0, fovDeg: 45 };
const context = () => ({ sceneId: 'scene-a', fps: 30, frameCount: 180,
  shots: [{ id: 'shot-a', name: '用户镜头', startFrame: 0, endFrame: 179, cameraKeys: [{ id: 'key-a', frame: 0, framing }] }],
  cameraLibrary: { cameras: [{ id: 'camera-a', name: '主机位', framing }] },
  characters: [{ id: 'actor-a', subject: '用户的人物描述', x: 1, z: 2, rot: 0, layer: { waypoints: [{ frame: 30, x: 2, z: 3 }] } }],
  poses: [{ id: 'pose-a', name: '用户姿势', bones: { head: [0, 0, 0] } }] });
const catalog = [{ id: 'gpt-director-test', endpoints: ['/v1/chat/completions'] }, { id: 'image-only', endpoints: ['/v1/images/generations'] }];
const pricing = () => ({ success: true, pricing_version: 'test-version', group_ratio: { default: 1, other: 1.5 },
  data: [{ model_name: 'gpt-director-test', billing_configured: true, quota_type: 0, model_ratio: 1, completion_ratio: 3, enable_groups: ['default', 'other'] }] });
const command = () => ({ id: 'shot.set', args: { id: 'shot-a', set: { cameraKeys: [
  { id: 'key-a', frame: 0, framing }, { id: 'key-b', frame: 179, framing: { ...framing, pos: { x: 1, y: 1.6, z: 3 } } },
] } } });
const response = (commands = [command()]) => ({ choices: [{ message: { content: JSON.stringify({ reply: '推近用户角色', commands }) } }] });
const deferred = () => { let resolve, reject; const promise = new Promise((ok, bad) => { resolve = ok; reject = bad; }); return { promise, resolve, reject }; };

async function fixture({ raw = createMemoryStorage(), chat = async () => response() } = {}) {
  clearKey(); await setKey('synthetic-test-only'); setModelCatalog(catalog); setAvailableModels(catalog.map(row => row.id));
  const storage = createAccountScopedStorage(raw, { subject: 'u101' }), project = { id: 'project-a' };
  const session = { projectId: project.id, nodeId: 'director-a', project, closed: false, epoch: storage.epoch };
  let currentProject = project, revision = 1, calls = 0, clock = 0, tariff = pricing();
  const sent = [], signals = [];
  const api = { listModels: async () => ({ data: catalog }), pricing: async () => structuredClone(tariff),
    chatCompletion: async (body, options) => { calls++; sent.push(JSON.parse(body)); signals.push(options?.signal); return chat(body); } };
  const assertCurrent = s => {
    storage.assertActive();
    if (s.closed || s.epoch !== storage.epoch || s.project !== currentProject) throw Object.assign(new Error('stale editor'), { code: 'session_closed' });
  };
  const recordOf = async s => { assertCurrent(s); return { rev: revision }; };
  const projectOf = async () => ({ scenes: { activeSceneId: 'scene-a', scenes: [{ id: 'scene-a',
    shotDocument: { fps: 30, frameCount: 180, shots: context().shots }, stage: { characters: context().characters } }] } });
  const factory = () => createDirectorProposals({ storage, api, assertCurrent, recordOf, projectOf, now: () => clock });
  const service = factory();
  const quote = (s = session, svc = service, patch = {}) => svc.quote(s, { kind: 'camera', model: 'gpt-director-test', instruction: '推近角色，保留我的描述', sceneRevision: revision, context: context(), ...patch });
  return { service, storage, raw, session, api, quote, factory, sent, signals,
    get calls() { return calls; }, set revision(value) { revision = value; }, set tariff(value) { tariff = value; },
    set clock(value) { clock = value; }, switchProject() { currentProject = { id: 'other-project' }; } };
}

test('runtime prices quote real USD token rates, byte upper bound and capped output; unknown prices are never zero', () => {
  const body = JSON.stringify({ model: 'gpt-director-test', messages: [{ role: 'user', content: '中文 prompt' }], max_tokens: 1024 });
  const q = quoteProposalPrice(pricing(), 'gpt-director-test', body);
  assert.equal(q.currency, 'USD'); assert.equal(q.estimatedYuan, null); assert.equal(q.detail.inputUSDPerMillion, 2);
  assert.equal(q.detail.outputUSDPerMillion, 6); assert.equal(q.detail.groupRatio, 1.5);
  assert.equal(q.detail.inputTokenUpperBound, new TextEncoder().encode(body).length + 6);
  assert.equal(q.detail.maxOutputTokens, 1024); assert.ok(q.estimatedAmount > 0);
  for (const p of [null, { models: { 'gpt-director-test': { per_request: 0.01 } } },
    { ...pricing(), data: [{ ...pricing().data[0], billing_configured: false }] },
    { ...pricing(), data: [{ ...pricing().data[0], billing_mode: 'tiered_expr' }] }]) {
    const unknown = quoteProposalPrice(p, 'gpt-director-test', body);
    assert.equal(unknown.kind, 'unknown'); assert.equal(unknown.estimatedAmount, null);
  }
  const fixed = pricing(); fixed.data[0] = { ...fixed.data[0], quota_type: 1, model_price: 0.02 };
  assert.equal(quoteProposalPrice(fixed, 'gpt-director-test', body).estimatedAmount, 0.03);
});

test('restricted proposal validation accepts editor shapes and rejects JS, jobs, unknown entities and extra payload', () => {
  const original = context(); original.characters[0].sessionMotion = { rootPos: new Float32Array(100000) };
  original.characters[0].identityImage = 'data:image/png;base64,private-user-image';
  assert.equal(JSON.stringify(normalizeProposalContext(original)).includes('base64'), false);
  const camera = validateProposalCommands([command(), { id: 'shot.setCamera', args: { shotId: 'shot-a', patch: { mode: 'rail', followCam: { height: 2 }, focusDistance: 4 } } },
    { id: 'shot.bindCamera', args: { shotId: 'shot-a', cameraId: 'camera-a' } },
    { id: 'eval', args: { javascript: 'throw 1' } }, { id: 'motion.generate', args: {} },
    { id: 'shot.rename', args: { shotId: 'foreign-shot', name: 'bad' } }, { ...command(), code: 'bad' }], original, 'camera');
  assert.equal(camera.commands.length, 3); assert.equal(camera.rejected.length, 4);
  const motion = validateProposalCommands([
    { id: 'character.addWaypoint', args: { characterId: 'actor-a', frame: 60, position: { x: 3, z: 4 } } },
    { id: 'character.moveWaypoint', args: { characterId: 'actor-a', frame: 60, position: { x: 4, z: 5 } } },
    { id: 'ik.applyPose', args: { characterId: 'actor-a', frame: 0, pose: { bones: { lArm: [1, 0, 0] }, rootY: 0.1 } } },
    { id: 'character.setPromptBlocks', args: { characterId: 'actor-a', blocks: [{ id: 'block-a', startFrame: 0, endFrame: 180, text: '用户角色抬手' }] } },
    { id: 'ik.applyPose', args: { characterId: 'actor-a', frame: 180, pose: { bones: { evil: [0, 0, 0] } } } },
  ], original, 'motion');
  assert.equal(motion.commands.length, 4); assert.equal(motion.rejected.length, 1);
  assert.equal(original.characters[0].layer.waypoints.length, 1, 'caller scene is not mutated');
});

test('every accepted proposal command validates against the real director command declaration', async () => {
  const [{ declarations: shots }, { declarations: cast }, { declarations: motion }, { validateStudioSchema }] = await Promise.all([
    import('../../director/src/commands/shot.js'), import('../../director/src/commands/cast.js'),
    import('../../director/src/commands/motion.js'), import('../../director/src/studio-agent-protocol.js'),
  ]);
  const declarations = new Map([...shots, ...cast, ...motion].map(row => [row.id, row]));
  const inputs = { camera: [command(),
    { id: 'shot.setCamera', args: { shotId: 'shot-a', patch: { mode: 'follow', followCam: { distance: 3 }, depthOfField: true } } },
    { id: 'shot.setCameraRail', args: { shotId: 'shot-a', points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] } },
    { id: 'shot.bindCamera', args: { shotId: 'shot-a', cameraId: 'camera-a' } },
    { id: 'shot.rename', args: { shotId: 'shot-a', name: '用户镜头' } },
  ], motion: [
    { id: 'character.addWaypoint', args: { characterId: 'actor-a', frame: 60, position: { x: 3, z: 4 } } },
    { id: 'character.moveWaypoint', args: { characterId: 'actor-a', frame: 30, position: { x: 4, z: 5 } } },
    { id: 'ik.applyPose', args: { characterId: 'actor-a', frame: 0, pose: { bones: { lArm: [1, 0, 0] }, rootY: 0.1 } } },
    { id: 'character.setPromptBlocks', args: { characterId: 'actor-a', blocks: [{ id: 'block-a', startFrame: 0, endFrame: 180, text: '用户角色抬手' }] } },
  ] };
  for (const [kind, proposed] of Object.entries(inputs)) {
    const result = validateProposalCommands(proposed, context(), kind); assert.equal(result.rejected.length, 0);
    for (const row of result.commands) assert.doesNotThrow(() => validateStudioSchema(declarations.get(row.id).input, row.args), row.id);
  }
});

test('quotation is read-only, confirmation and exact price/revision/snapshot are required, result remains preview-only', async () => {
  const f = await fixture(); const quote = await f.quote(); assert.equal(f.calls, 0); assert.equal(quote.canRequest, true);
  await assert.rejects(f.service.request(f.session, { quoteId: quote.quoteId, confirmed: false }), e => e.code === 'proposal_confirmation_required');
  assert.equal(f.calls, 0);
  const proposal = await f.service.request(f.session, { quoteId: quote.quoteId, confirmed: true });
  assert.equal(f.calls, 1); assert.equal(proposal.rawText, response().choices[0].message.content); assert.deepEqual(proposal.commands, [command()]);
  assert.equal(f.sent[0].stream, false); assert.equal(f.sent[0].max_tokens, 2048); assert.match(f.sent[0].messages[1].content, /用户的人物描述/);
  assert.equal((await f.storage.get(directorProposalOperationKey('project-a', 'director-a'))).state, 'completed');
  const verified = await f.service.status(f.session, { proposalId: proposal.proposalId, sceneRevision: 1, context: context() });
  assert.equal(verified.canApply, true);
  const changed = context(); changed.characters[0].subject = '已修改的描述';
  await assert.rejects(f.service.status(f.session, { proposalId: proposal.proposalId, sceneRevision: 1, context: changed }), e => e.code === 'proposal_stale');
  await assert.rejects(f.service.request(f.session, { quoteId: quote.quoteId, confirmed: true, instruction: 'replace frozen prompt' }), e => e.code === 'proposal_invalid');
  assert.equal(f.calls, 1);
});

test('unknown/unavailable pricing, changed prices, expired quote and mismatched saved scene never send', async () => {
  const f = await fixture(); f.tariff = null;
  const unknown = await f.quote(); assert.equal(unknown.canRequest, false);
  await assert.rejects(f.service.request(f.session, { quoteId: unknown.quoteId, confirmed: true }), e => e.code === 'proposal_price_unknown');
  f.tariff = pricing(); const q = await f.quote(); const changedPrice = pricing(); changedPrice.data[0].completion_ratio = 6; f.tariff = changedPrice;
  await assert.rejects(f.service.request(f.session, { quoteId: q.quoteId, confirmed: true }), e => e.code === 'proposal_quote_changed');
  const expired = await f.quote(); f.clock = 3 * 60 * 1000;
  await assert.rejects(f.service.request(f.session, { quoteId: expired.quoteId, confirmed: true }), e => e.code === 'proposal_quote_expired');
  const c = context(); c.characters.push({ id: 'foreign-actor' });
  await assert.rejects(f.quote(f.session, f.service, { context: c }), e => e.code === 'proposal_context_mismatch');
  await assert.rejects(f.quote(f.session, f.service, { model: 'image-only' }), e => e.code === 'proposal_model_unavailable');
  assert.equal(f.calls, 0);
});

test('two windows and repeated confirmations reuse one completed request with durable ledger', async () => {
  const gate = deferred(), entered = deferred();
  const f = await fixture({ chat: async () => { entered.resolve(); return gate.promise; } });
  const other = { ...f.session }, svc = f.factory();
  const q1 = await f.quote(), q2 = await f.quote(other, svc);
  const first = f.service.request(f.session, { quoteId: q1.quoteId, confirmed: true }); await entered.promise;
  const second = svc.request(other, { quoteId: q2.quoteId, confirmed: true }); gate.resolve(response());
  const [a, b] = await Promise.all([first, second]); assert.equal(f.calls, 1); assert.equal(a.proposalId, b.proposalId);
  assert.equal((await svc.request(other, { quoteId: q2.quoteId, confirmed: true })).proposalId, a.proposalId); assert.equal(f.calls, 1);
});

test('scene revision changed while durable sent marker settles rejects before POST, permits a new quote, and preserves later attempted-request guards', async () => {
  let loseReply = false;
  const f = await fixture({ chat: async () => { if (loseReply) throw new Error('synthetic lost response'); return response(); } });
  const quote = await f.quote(), entered = deferred(), release = deferred(), original = f.storage.set;
  let held = false;
  f.storage.set = async (key, record) => {
    const result = await original(key, record);
    if (!held && record.state === 'sent') { held = true; entered.resolve(); await release.promise; }
    return result;
  };
  const pending = f.service.request(f.session, { quoteId: quote.quoteId, confirmed: true });
  await entered.promise;
  f.revision = 2; release.resolve();
  await assert.rejects(pending, error => error.code === 'revision_conflict');
  assert.equal(f.calls, 0, 'a quote made stale before any POST cannot call the supplier');
  assert.equal((await f.service.status(f.session)).blocked, false, 'a positively known unsent request is recoverable');
  const current = await f.quote();
  assert.equal(current.canRequest, true); assert.equal(current.sceneRevision, 2);
  const proposal = await f.service.request(f.session, { quoteId: current.quoteId, confirmed: true });
  assert.equal(proposal.sceneRevision, 2); assert.equal(f.calls, 1);
  const next = await f.quote(f.session, f.service, { instruction: '另一笔明确确认的合成提案，保留当前角色描述' });
  loseReply = true;
  await assert.rejects(f.service.request(f.session, { quoteId: next.quoteId, confirmed: true }), error => error.code === 'proposal_unresolved');
  assert.equal(f.calls, 2);
  assert.equal((await f.service.status(f.session)).blocked, true, 'an attempted POST with a lost response keeps its durable guard');
  const retry = await f.quote(); assert.equal(retry.canRequest, false);
  await assert.rejects(f.service.request(f.session, { quoteId: retry.quoteId, confirmed: true }), error => error.code === 'proposal_unresolved');
  assert.equal(f.calls, 2, 'recovery of the known unsent request never weakens later uncertain-request protection');
});

test('a quote expiring while its durable sent marker settles never POSTs and can be explicitly re-quoted', async () => {
  const f = await fixture(), quote = await f.quote(), entered = deferred(), release = deferred(), original = f.storage.set;
  let held = false;
  f.storage.set = async (key, record) => {
    const result = await original(key, record);
    if (!held && record.state === 'sent') { held = true; entered.resolve(); await release.promise; }
    return result;
  };
  const pending = f.service.request(f.session, { quoteId: quote.quoteId, confirmed: true });
  await entered.promise;
  f.clock = 3 * 60 * 1000; release.resolve();
  await assert.rejects(pending, error => error.code === 'proposal_quote_expired');
  assert.equal(f.calls, 0, 'expiry at the last durable pre-POST boundary disables the quoted call');
  assert.equal((await f.service.status(f.session)).blocked, false);
  await assert.rejects(f.service.request(f.session, { quoteId: quote.quoteId, confirmed: true }), error => error.code === 'proposal_quote_expired');
  assert.equal(f.calls, 0);
  const fresh = await f.quote(); assert.equal(fresh.canRequest, true); assert.ok(fresh.expiresAt > 3 * 60 * 1000);
  const proposal = await f.service.request(f.session, { quoteId: fresh.quoteId, confirmed: true });
  assert.equal(proposal.sceneRevision, 1); assert.equal(f.calls, 1);
});

test('failure to reset a positively unsent marker retains the durable sent guard and blocks repeated requests', async () => {
  const f = await fixture(), quote = await f.quote(), entered = deferred(), release = deferred(), original = f.storage.set;
  let held = false;
  f.storage.set = async (key, record) => {
    if (held && record.state === 'saved') throw new Error('synthetic preflight reset write failed');
    const result = await original(key, record);
    if (!held && record.state === 'sent') { held = true; entered.resolve(); await release.promise; }
    return result;
  };
  const pending = f.service.request(f.session, { quoteId: quote.quoteId, confirmed: true });
  await entered.promise; f.revision = 2; release.resolve();
  await assert.rejects(pending, /synthetic preflight reset write failed/);
  assert.equal(f.calls, 0);
  const stored = await f.raw.get(`hosted:v1:u101:${directorProposalOperationKey('project-a', 'director-a')}`);
  assert.equal(stored.state, 'sent'); assert.equal(stored.quoteId, quote.quoteId);
  assert.equal((await f.service.status(f.session)).blocked, true);
  const retry = await f.quote(); assert.equal(retry.canRequest, false);
  await assert.rejects(f.service.request(f.session, { quoteId: retry.quoteId, confirmed: true }), error => error.code === 'proposal_unresolved');
  assert.equal(f.calls, 0, 'a failed persistence reset cannot silently unlock a stale durable marker');
});

test('closing or changing identity during sent-marker settlement never POSTs or writes a rollback through the old scope', async () => {
  for (const mutate of [f => { f.session.closed = true; f.service.cancel(f.session); }, f => f.switchProject(),
    f => f.storage.invalidate(), async () => { await setKey('another-synthetic-test-only'); }]) {
    const f = await fixture(), quote = await f.quote(), entered = deferred(), release = deferred(), original = f.storage.set;
    const writes = []; let held = false;
    f.storage.set = async (key, record) => {
      writes.push(record.state);
      const result = await original(key, record);
      if (!held && record.state === 'sent') { held = true; entered.resolve(); await release.promise; }
      return result;
    };
    const pending = f.service.request(f.session, { quoteId: quote.quoteId, confirmed: true });
    await entered.promise; await mutate(f); release.resolve();
    await assert.rejects(pending);
    assert.equal(f.calls, 0);
    assert.deepEqual(writes, ['saved', 'sent'], 'the invalidated session never evaluates a rollback storage.set');
    const stored = await f.raw.get(`hosted:v1:u101:${directorProposalOperationKey('project-a', 'director-a')}`);
    assert.equal(stored.state, 'sent'); assert.equal(stored.quoteId, quote.quoteId);
    const otherAccount = createAccountScopedStorage(f.raw, { subject: 'u202' });
    assert.deepEqual(await otherAccount.keys(), [], 'old preflight settlement cannot write into the new account');
  }
});

test('uncertain requests stay locked across reload, and storage failures before POST fail closed', async () => {
  const f = await fixture({ chat: async () => { throw new Error('lost response'); } }); const q = await f.quote();
  await assert.rejects(f.service.request(f.session, { quoteId: q.quoteId, confirmed: true }), e => e.code === 'proposal_unresolved');
  assert.equal(f.calls, 1); assert.equal((await f.service.status(f.session)).blocked, true);
  const other = { ...f.session }, svc = f.factory(), q2 = await f.quote(other, svc);
  assert.equal(q2.canRequest, false);
  await assert.rejects(svc.request(other, { quoteId: q2.quoteId, confirmed: true }), e => e.code === 'proposal_unresolved'); assert.equal(f.calls, 1);
  const g = await fixture(), q3 = await g.quote(); const original = g.storage.set;
  g.storage.set = async () => { throw new Error('quota failure'); };
  await assert.rejects(g.service.request(g.session, { quoteId: q3.quoteId, confirmed: true }), /quota failure/); assert.equal(g.calls, 0);
  g.storage.set = original;
});

test('browser without cross-tab locks and foreign/future billing ledger fail closed', async () => {
  const f = await fixture(); const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    globalThis.window = { document: {} };
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const service = f.factory(), quote = await f.quote(f.session, service);
    await assert.rejects(service.request(f.session, { quoteId: quote.quoteId, confirmed: true }), e => e.code === 'submit_lock_unsupported');
    assert.equal(f.calls, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  }
  await f.storage.set(directorProposalOperationKey('project-a', 'director-a'), { format: 'starlight-director-proposal@2', state: 'completed' });
  await assert.rejects(f.quote(), e => e.code === 'proposal_operation_unsupported'); assert.equal(f.calls, 0);
});

test('editor close, project switch, account invalidation, key change and revision change discard delayed replies without scene writes', async () => {
  for (const mutate of [f => { f.session.closed = true; f.service.cancel(f.session); assert.equal(f.signals[0].aborted, true); }, f => f.switchProject(), f => f.storage.invalidate(),
    async () => { await setKey('another-synthetic-test-only'); }, f => { f.revision = 2; }]) {
    const gate = deferred(), entered = deferred(); const f = await fixture({ chat: async () => { entered.resolve(); return gate.promise; } });
    const q = await f.quote(), pending = f.service.request(f.session, { quoteId: q.quoteId, confirmed: true }); await entered.promise;
    await mutate(f); gate.resolve(response()); await assert.rejects(pending);
    assert.equal(f.calls, 1);
    const saved = await f.raw.get(`hosted:v1:u101:${directorProposalOperationKey('project-a', 'director-a')}`);
    assert.equal(saved.state, 'sent'); assert.equal(saved.proposal, undefined);
    const otherAccount = createAccountScopedStorage(f.raw, { subject: 'u202' }); assert.deepEqual(await otherAccount.keys(), []);
  }
});

test('completed-write failure retains sent guard; malformed reply is preserved with no applicable commands', async () => {
  const f = await fixture(); const q = await f.quote(), original = f.storage.set;
  f.storage.set = async (key, record) => { if (record.state === 'completed') throw new Error('failed completion write'); return original(key, record); };
  await assert.rejects(f.service.request(f.session, { quoteId: q.quoteId, confirmed: true }), /failed completion write/);
  assert.equal(f.calls, 1); assert.equal((await f.service.status(f.session)).state, 'sent');
  const g = await fixture({ chat: async () => ({ choices: [{ message: { content: '原文里有未结构化运镜解释' } }] }) });
  const q2 = await g.quote(), result = await g.service.request(g.session, { quoteId: q2.quoteId, confirmed: true });
  assert.deepEqual(result.commands, []); assert.ok(result.rejected.length); assert.equal(result.rawText, '原文里有未结构化运镜解释');
});
