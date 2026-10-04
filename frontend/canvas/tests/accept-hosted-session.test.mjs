// 托管会话失效的独立验收（纯逻辑，不依赖浏览器）：错误分类只按合同，守卫幂等、只读克隆、
// 失效后本地拒绝新请求（不发出），迟到到换会话之后的失效响应不影响新会话。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { getElementById: () => null, createElement: () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} }) };
const { classifySessionResponse, createSessionGuard } = await import('../src/hosted-session.js');

const res = (status, body) => new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });

test('分类只按合同：401 与 409 identity_changed 使会话失效；403、计费门控 409、503、其他 409 不失效', () => {
  assert.equal(classifySessionResponse(401, 'auth_required'), 'auth_invalid');
  assert.equal(classifySessionResponse(401, null), 'auth_invalid');
  assert.equal(classifySessionResponse(409, 'identity_changed'), 'identity_changed');
  assert.equal(classifySessionResponse(403, 'identity_forbidden'), 'identity_forbidden', '身份核验确认撤权');
  for (const [s, c] of [[403, 'forbidden'], [403, null], [409, 'model_billing_unverified'], [409, 'task_write_conflict'], [503, 'identity_unavailable'], [404, 'task_not_found'], [200, null]])
    assert.equal(classifySessionResponse(s, c), null, `${s} ${c}`);
});

test('守卫：登录期间不触发；绑定后 401 只触发一次；之后新请求在本地得到 409 identity_changed、不发出；原响应体仍可读取', async () => {
  const calls = [];
  let next = res(401, { error: { code: 'auth_required' } });
  const events = [];
  const guard = createSessionGuard({ fetchImpl: async u => { calls.push(u); return next; }, onInvalid: info => events.push(info) });
  await guard.fetch('/canvas-api/identity');                     // 未绑定：登录表单自己解释 401
  assert.equal(events.length, 0);
  guard.bind({ id: 'A' });
  next = res(401, { error: { code: 'auth_required', message: 'x' } });
  const r = await guard.fetch('/canvas-api/v1/videos/task_1?q=1');
  assert.deepEqual(await r.json(), { error: { code: 'auth_required', message: 'x' } }, '调用方拿到的响应体未被守卫消费');
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'auth_invalid'); assert.equal(events[0].url, '/canvas-api/v1/videos/task_1');
  const before = calls.length;
  const refused = await guard.fetch('/canvas-api/v1/videos', { method: 'POST' });
  assert.equal(calls.length, before, '失效后不再发出请求');
  assert.equal(refused.status, 409); assert.equal((await refused.json()).error.code, 'identity_changed');
  next = res(401, {}); await guard.fetch('/x');
  assert.equal(events.length, 1, '幂等：只触发一次');
});

test('守卫：计费门控 409、单任务 403、身份服务 503 都不使会话失效，会话继续可用', async () => {
  const events = [], calls = [];
  const replies = [res(409, { error: { code: 'model_billing_unverified' } }), res(403, { error: { code: 'forbidden' } }), res(503, { error: { code: 'identity_unavailable' } }), res(200, { data: [] })];
  const guard = createSessionGuard({ fetchImpl: async u => { calls.push(u); return replies.shift(); }, onInvalid: i => events.push(i) });
  guard.bind({ id: 'A' });
  for (const u of ['/canvas-api/v1/videos', '/canvas-api/v1/videos/t/content', '/canvas-api/v1/models', '/canvas-api/v1/models']) await guard.fetch(u);
  assert.equal(events.length, 0); assert.equal(guard.invalid, null); assert.equal(calls.length, 4, '请求照常发出');
});

test('守卫：请求在会话 A 期间发出、响应迟到到换成会话 B 之后——A 的 401 不能使 B 失效', async () => {
  const events = [];
  let release;
  const guard = createSessionGuard({ fetchImpl: () => new Promise(r => { release = () => r(res(401, {})); }), onInvalid: i => events.push(i) });
  guard.bind({ id: 'A' });
  const late = guard.fetch('/canvas-api/v1/videos/task_1');
  guard.bind({ id: 'B' });
  release();
  await late;
  assert.equal(events.length, 0); assert.equal(guard.invalid, null);
});

test('守卫：身份核验撤权 403 identity_forbidden 立即使会话失效；同状态码的单任务 403 forbidden 不失效', async () => {
  const events = [];
  const replies = [res(403, { error: { code: 'forbidden' } }), res(403, { error: { code: 'identity_forbidden' } })];
  const guard = createSessionGuard({ fetchImpl: async () => replies.shift(), onInvalid: i => events.push(i) });
  guard.bind({ id: 'A' });
  await guard.fetch('/canvas-api/v1/videos/vjob_0123456789abcdef0123456789abcdef');
  assert.equal(events.length, 0, '单任务 403 不登出');
  const r = await guard.fetch('/canvas-api/v1/models');
  assert.equal((await r.json()).error.code, 'identity_forbidden', '原响应体仍可读取');
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'identity_forbidden');
  assert.equal((await guard.fetch('/canvas-api/v1/videos', { method: 'POST' })).status, 409, '之后新请求在本地被拒');
});
