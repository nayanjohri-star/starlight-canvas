// 密钥过滤修复回归：token 计量参数（有限数值）不误伤；真凭据名、伪装字符串 token、
// 深层嵌套密钥仍拒绝；循环引用安全。containsSecret 判定与 export→import 链路双层覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore, containsSecret } from '../src/store.js';

const doc = (project = {}, top = {}) => JSON.stringify({
  format: 'xingpan-canvas@2',
  project: { name: 'x', nodes: [], edges: [], ...project },
  ...top,
});
const textNode = (id, data) => ({ id, type: 'text', x: 0, y: 0, data });

test('token 计量参数（有限数值）不视为密钥', () => {
  assert.equal(containsSecret({ params: { max_tokens: 2048, temperature: 0.5 } }), false);
  assert.equal(containsSecret({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), false);
  assert.equal(containsSecret({ maxTokens: 512, tokenCount: 3, tokens_used: 7, token_budget: 64 }), false);
});

test('真实凭据字段名（含嵌套与命名变体）仍拒绝', () => {
  for (const k of ['apiKey', 'api_key', 'Authorization', 'authorization', 'Bearer', 'access_token',
    'accessToken', 'refresh_token', 'password', 'client_secret', 'private_key', 'session_token', 'token'])
    assert.equal(containsSecret({ [k]: 'x' }), true, k);
  assert.equal(containsSecret({ a: { b: { params: { apiKey: 'sk' } } } }), true);
  assert.equal(containsSecret({ headers: { authorization: 'Bearer x' } }), true);
});

test('非数值伪装的 token 计量参数不放行', () => {
  assert.equal(containsSecret({ params: { max_tokens: 'sk-disguised' } }), true);
  assert.equal(containsSecret({ params: { max_tokens: '2048' } }), true);   // 计量名只认数值
  assert.equal(containsSecret({ max_tokens: { v: 1 } }), true);
  assert.equal(containsSecret({ params: { max_tokens: true } }), true);
  assert.equal(containsSecret({ params: { max_tokens: 2048 } }), false);
});

test('未知 token 字样键与裸 token 仍拒绝', () => {
  for (const k of ['token', 'sessionToken', 'my_token', 'oauth_token', 'bearerToken', 'id_token', 'tokenId'])
    assert.equal(containsSecret({ [k]: 'v' }), true, k);
});

test('第 9 层及更深密钥不放过；循环引用不栈溢出', () => {
  let deep = { refresh_token: 'x' };
  for (let i = 0; i < 12; i++) deep = { wrap: deep };
  assert.equal(containsSecret(deep), true);
  let deepOk = { params: { max_tokens: 8 } };
  for (let i = 0; i < 12; i++) deepOk = { wrap: deepOk };
  assert.equal(containsSecret(deepOk), false);
  const cyc = { params: { max_tokens: 100 } };
  cyc.self = cyc;
  assert.equal(containsSecret(cyc), false);
  const cyc2 = { a: { apiKey: 'x' } };
  cyc2.a.back = cyc2;
  assert.equal(containsSecret(cyc2), true);
});

test('导出→导入回归：文本节点 params 完整保留', async () => {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('文本工程');
  store.addNode('text', 0, 0, { model: 'gpt-5.6-sol', text: '分镜提示词', params: { max_tokens: 2048, temperature: 0.5 } });
  const json = await store.exportJSON();
  await store.importJSON(json);
  const node = store.project.nodes.find(n => n.type === 'text');
  assert.equal(node.data.params.max_tokens, 2048);
  assert.equal(node.data.params.temperature, 0.5);
});

test('导入：嵌套/深层真秘密与伪装 token 字符串拒绝；合法整数 token 计数接受', async () => {
  const store = createStore(createMemoryStorage());
  await store.newProject('x');
  let deep = { access_token: 't' };
  for (let i = 0; i < 10; i++) deep = { wrap: deep };
  await assert.rejects(() => store.importJSON(doc({}, { extra: deep })), /密钥|秘密|secret|凭据/);
  await assert.rejects(() => store.importJSON(doc({}, { nested: { a: { b: { apiKey: 'k' } } } })), /密钥|秘密|secret|凭据/);
  await assert.rejects(() => store.importJSON(doc({
    nodes: [textNode('n1', { text: 'hi', params: { max_tokens: 'sk-fake' } })],
  })), /密钥|秘密|secret|凭据/);
  // 凭据名即使给数值也拒绝
  await assert.rejects(() => store.importJSON(doc({
    nodes: [textNode('n2', { text: 'hi', params: { access_token: 1 } })],
  })), /密钥|秘密|secret|凭据/);
  const p = await store.importJSON(doc({
    nodes: [textNode('n3', { model: 'mock', text: 'hi', params: { max_tokens: 4096, temperature: 0.3 } })],
  }));
  const n = p.nodes.find(x => x.type === 'text');
  assert.equal(n.data.params.max_tokens, 4096);
  assert.equal(n.data.params.temperature, 0.3);
});

test('待创建记录请求体含数值 max_tokens 不再误拒', async () => {
  const store = createStore(createMemoryStorage());
  await store.newProject('x');
  const bodyString = JSON.stringify({ model: 'm1', prompt: 'p', seconds: 5, max_tokens: 256 });
  await store.importJSON(doc({}, {
    pending: [{ idempotencyKey: 'k1', model: 'm1', bodyString, state: 'uncertain' }],
  }));
  const pend = await store.listPending();
  assert.equal(pend.length, 1);
  assert.equal(pend[0].idempotencyKey, 'k1');
});
