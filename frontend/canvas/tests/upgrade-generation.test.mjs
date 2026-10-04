// generation 域升级测试：文本/图片同步生成的操作守卫、请求合同、连线输出解析与助手白名单。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// —— 最小 DOM 桩：让 ui.toast/el 等在无浏览器环境可调用 ——
function stubDom() {
  const makeEl = () => ({
    children: [], className: '', textContent: '', value: '', style: {}, disabled: false, checked: false,
    append(...c) { this.children.push(...c); }, prepend(...c) { this.children.unshift(...c); },
    replaceChildren(...c) { this.children = c; }, appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, remove() {},
    querySelector() { return makeEl(); }, click() {},
  });
  const byId = makeEl();
  globalThis.document = { createElement: makeEl, getElementById: () => byId, body: makeEl(), addEventListener() {}, removeEventListener() {} };
  globalThis.window = { document: globalThis.document };
}
stubDom();

import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import {
  setCapabilities, imageSizeFor, imageRatios, estimateImageYuan,
  buildImageBody, buildImageEditBody, buildChatBody, parseImageDataURL,
  decodeBase64, bytesToBase64, sniffImageMime, nodeOutputs, wiredOutputs, effectivePrompt,
  chatModelIdsFromCatalog, imageModelIds, b64DecodedSize, IMAGE_RESULT_MAX_BYTES,
} from '../src/capabilities.js';
import { ApiError, chatResponseText, imageResponseB64 } from '../src/api.js';
import { setKey, clearKey, setAvailableModels, setModelCatalog, getFingerprint, getModelCatalog, getAvailableModels } from '../src/keyvault.js';
import { createGenerators } from '../src/studio-gen.js';
import { planActions, extractJson, canvasSignature, planStale } from '../src/assistant.js';
import { createTaskRunner } from '../src/gennode.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_TINY_B64 = '/9j/AA==';   // ff d8 ff 00

setCapabilities({
  models: {
    'm-vid': {
      family: 'h3', display_name: 'V', price_cny_per_second: 1, resolution: '768p', groups: ['default'],
      seconds: { min: 1, max: 15, default: 5 }, ratios: { default: '16:9', options: ['16:9'] },
      prompt_max_characters: 2000, reference_limits: { image: 9, video: 3, audio: 3, total: 9 },
      switches: { generate_audio: true, face_mode: false },
    },
  },
  upload_limits: {
    image: { content_types: ['image/png', 'image/jpeg', 'image/webp'], max_mib: 30 },
    video: { content_types: ['video/mp4'], max_mib: 100 },
    audio: { content_types: ['audio/mpeg'], max_mib: 30 },
  },
});

async function makeEnv() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('测试');
  const api = {};   // 测试内填充，createGenerators 持有同一引用
  const assets = {
    async registerBlob(blob, name, kind, extra = {}) {
      const id = `a_${Math.random().toString(36).slice(2)}`;
      await storage.setBlob(`blob:${id}`, blob);
      const rec = { id, name, kind, mime: blob.type || 'application/octet-stream', size: blob.size, addedAt: Date.now(), ...extra };
      store.project.assets[id] = rec; store.touch(); return rec;
    },
    async blobOf(id) { return storage.getBlob(`blob:${id}`); },
    async objectURL() { return null; },
    remoteValid: () => false,
    assetOfNode(n) { return n?.type === 'asset' ? store.project.assets[n.data.assetId] ?? null : null; },
  };
  const generators = createGenerators({ store, storage, api, assets, submitLock: { request: (n, f) => f() } });
  const runner = createTaskRunner({ store, storage, api, assets, onUpdate: () => {}, submitLock: (n, f) => f() });
  return { storage, store, api, assets, generators, runner };
}

beforeEach(() => { clearKey(); setAvailableModels(null); setModelCatalog(null); });

test('image2.5 档位/比例/估价', () => {
  assert.deepEqual(imageRatios('4K').sort(), ['16:9', '9:16']);
  for (const res of ['1K', '2K', '4K']) for (const r of imageRatios(res)) {
    const [w, h] = imageSizeFor(res, r).split('x').map(Number);
    assert.ok(Math.max(w, h) <= 3840, `${res} ${r} 边长超限`);
  }
  assert.equal(imageSizeFor('4K', '1:1'), null);
  assert.equal(estimateImageYuan('gpt-image-2.5-flare-special', '2K'), 0.08);
  assert.equal(estimateImageYuan('gpt-image-2.5-sunburst-special', '4K'), 0.14);
  assert.equal(estimateImageYuan('gpt-image-2.5-flare', '1K'), null);   // 标准价未验证
});

test('buildChatBody / buildImageBody 合同', () => {
  const chat = JSON.parse(buildChatBody({ model: 'deepseek-chat', system: 's', prompt: 'p', maxTokens: 128 }));
  assert.equal(chat.stream, false);
  assert.equal(chat.max_tokens, 128);
  assert.deepEqual(chat.messages.map(m => m.role), ['system', 'user']);
  assert.throws(() => buildChatBody({ model: 'x', prompt: 'p' }), /max_tokens/);
  const img = JSON.parse(buildImageBody({ model: 'gpt-image-2.5-flare', prompt: 'a', size: '3840x2160' }));
  assert.equal(img.n, 1); assert.equal(img.response_format, 'b64_json');
  assert.throws(() => buildImageBody({ model: 'gpt-image-2.5-flare', prompt: 'a', size: '4096x4096' }));
  assert.throws(() => buildImageBody({ model: 'gpt-image-2.5-flare', prompt: 'a', size: '1000x1000' }));  // 非枚举尺寸
  assert.throws(() => buildImageBody({ model: 'dall-e-3', prompt: 'a', size: '1024x1024' }));
});

test('parseImageDataURL / 魔数校验', () => {
  const ok = parseImageDataURL(`data:image/png;base64,${PNG_1PX}`);
  assert.equal(ok.mime, 'image/png');
  assert.throws(() => parseImageDataURL('data:image/png;base64,/9j/AA=='), /不符/);      // 声明 png 实为 jpeg
  assert.throws(() => parseImageDataURL('https://example.com/x.png'), /data URL/);       // 外部 url 拒绝
  assert.equal(sniffImageMime(decodeBase64(JPEG_TINY_B64)), 'image/jpeg');
});

test('nodeOutputs / effectivePrompt：缺失连线输出是显式问题', async () => {
  const env = await makeEnv();
  const img = env.store.addNode('image', 0, 0, { resultAssetId: 'a_gone' });
  const out = nodeOutputs(env.store.project, img);
  assert.equal(out.assets.length, 0);
  assert.equal(out.missing.length, 1);
  assert.match(out.missing[0], /不存在/);

  const t1 = env.store.addNode('text', 0, 0, { text: '第一段' });
  const t2 = env.store.addNode('text', 0, 0, { text: '' });
  const host = env.store.addNode('image', 0, 0, { prompt: '自身' });
  env.store.addEdge(t1.id, 'out', host.id, 'prompt', 'text');
  const eff = effectivePrompt(env.store, host, host.data.prompt);
  assert.equal(eff.prompt, '第一段\n\n自身');
  assert.equal(eff.wired, true);
  env.store.addEdge(t2.id, 'out', host.id, 'prompt', 'text');
  const eff2 = effectivePrompt(env.store, host, host.data.prompt);
  assert.ok(eff2.problems.length >= 1);   // 空输出 → 显式问题，不静默丢
});

test('chatModelIdsFromCatalog 只挑文本型号', () => {
  const ids = chatModelIdsFromCatalog([
    { id: 'm-vid' }, { id: 'gpt-image-2.5-flare' },
    { id: 'deepseek-chat', endpoints: ['/v1/chat/completions'] },
    { id: 'o3-mini' }, { id: 'custom-x', endpoints: ['/v1/images/generations'] },
  ]);
  assert.deepEqual(ids, ['deepseek-chat', 'o3-mini']);
});

test('文本节点：无模型时合成连线文本', async () => {
  const env = await makeEnv();
  const n1 = env.store.addNode('text', 0, 0, { text: '第一段' });
  const n2 = env.store.addNode('text', 0, 0, { text: '第二段' });
  env.store.addEdge(n1.id, 'out', n2.id, 'prompt', 'text');
  const r = await env.generators.generate(n2);
  assert.equal(r.text, '第一段\n\n第二段');
  assert.equal(n2.data.resultText, r.text);
  assert.equal(n2.data.operation, undefined);   // 非付费路径不留操作记录
});

test('文本节点：模型生成先落操作记录（sent）再发送', async () => {
  const env = await makeEnv();
  await setKey('sk-test-123');
  setAvailableModels(['deepseek-chat']);
  setModelCatalog([{ id: 'deepseek-chat', endpoints: ['/v1/chat/completions'] }]);
  const node = env.store.addNode('text', 0, 0, { model: 'deepseek-chat', text: '写一句问候', params: { max_tokens: 64 } });
  const seen = [];
  env.api.chatCompletion = async body => {
    seen.push(body);
    const persisted = await env.storage.get(`project:${env.store.project.id}`);
    const rec = persisted.nodes.find(n => n.id === node.id).data.operation;
    assert.equal(rec.state, 'sent');
    assert.ok(rec.sentAt > 0);
    assert.equal(rec.keyFp, getFingerprint());
    return { choices: [{ message: { content: '你好世界' } }] };
  };
  const r = await env.generators.generate(node);
  assert.equal(r.text, '你好世界');
  assert.equal(node.data.resultText, '你好世界');
  assert.equal(node.data.operation.state, 'completed');
  const sent = JSON.parse(seen[0]);
  assert.equal(sent.stream, false);
  assert.equal(sent.max_tokens, 64);
  assert.equal(sent.messages.at(-1).content, '写一句问候');
});

test('同步调用：明确拒绝可重来；结果未明锁定且不再发送', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['deepseek-chat']);
  const node = env.store.addNode('text', 0, 0, { model: 'deepseek-chat', text: 'hi' });
  let calls = 0;
  env.api.chatCompletion = async () => { calls++; throw new ApiError(400, 'bad_request', '内容违规'); };
  await assert.rejects(() => env.generators.generate(node), /被拒绝/);
  assert.equal(node.data.operation.state, 'rejected');
  env.api.chatCompletion = async () => { calls++; throw new Error('socket hangup'); };
  await assert.rejects(() => env.generators.generate(node), /未确认/);
  assert.equal(node.data.operation.state, 'unresolved');
  const before = calls;
  await assert.rejects(() => env.generators.generate(node), /锁定|未确认/);
  assert.equal(calls, before);   // 未再发送
  // 持久化到项目文档（导入后仍保持禁发）
  const persisted = await env.storage.get(`project:${env.store.project.id}`);
  assert.equal(persisted.nodes.find(n => n.id === node.id).data.operation.state, 'unresolved');
  await env.generators.resolveOperation(node, 'abandon');
  env.api.chatCompletion = async () => { calls++; return { choices: [{ message: { content: 'ok' } }] }; };
  const r = await env.generators.generate(node);
  assert.equal(r.text, 'ok');
  assert.equal(node.data.operation.state, 'completed');
  assert.ok(node.data.operationLog.length >= 2);   // rejected + unresolved 审计留档
});

test('图片文生图：b64 解码校验后入库', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['gpt-image-2.5-flare']);
  const bodies = [];
  env.api.imageGeneration = async b => { bodies.push(b); return { data: [{ b64_json: PNG_1PX }] }; };
  const node = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: '红色杯子' });
  const r = await env.generators.generate(node);
  assert.ok(r.assetId);
  assert.equal(node.data.resultAssetId, r.assetId);
  assert.deepEqual(node.data.outputAssetIds, [r.assetId]);
  const blob = await env.storage.getBlob(`blob:${r.assetId}`);
  assert.equal(blob.type, 'image/png');
  const sent = JSON.parse(bodies[0]);
  assert.equal(sent.n, 1);
  assert.equal(sent.response_format, 'b64_json');
  assert.equal(sent.size, '1024x1024');
  assert.equal(sent.model, 'gpt-image-2.5-flare');
});

test('图片编辑：单图兼容，多图完整传输并按实际顺序解析稳定绑定', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['gpt-image-2.5-flare']);
  const node = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '2K', ratio: '16:9', prompt: '改成蓝色' });
  const rec = await env.assets.registerBlob(new Blob([decodeBase64(PNG_1PX)], { type: 'image/png' }), 'ref.png', 'image');
  const a1 = env.store.addNode('asset', 0, 0, { assetId: rec.id });
  assert.ok(env.store.addEdge(a1.id, 'out', node.id, 'refs', 'image'));
  const bodies = [];
  env.api.imageEdit = async b => { bodies.push(b); return { data: [{ b64_json: PNG_1PX }] }; };
  await env.generators.generate(node);
  const sent = JSON.parse(bodies[0]);
  assert.ok(sent.image.startsWith('data:image/png;base64,'));
  assert.equal(sent.size, '2560x1440');
  const ref2 = new Blob([decodeBase64(PNG_1PX), new Uint8Array([2])], { type: 'image/png' });
  const rec2 = await env.assets.registerBlob(ref2, 'ref2.png', 'image');
  const a2 = env.store.addNode('asset', 0, 0, { assetId: rec2.id });
  env.store.addEdge(a2.id, 'out', node.id, 'refs', 'image');
  const rec3 = await env.assets.registerBlob(new Blob([decodeBase64(PNG_1PX), new Uint8Array([3])], { type: 'image/png' }), 'ref3.png', 'image');
  const a3 = env.store.addNode('asset', 0, 0, { assetId: rec3.id });
  env.store.addEdge(a3.id, 'out', node.id, 'refs', 'image');
  node.data.prompt = '构图 @图片1，蓝色角色 @图片2，金色角色 @图片3';
  node.data.bindings = { 'image:1': rec3.id, 'image:2': rec.id, 'image:3': rec2.id };
  await env.generators.generate(node);
  const multi = JSON.parse(bodies[1]);
  assert.equal(multi.image, undefined);
  assert.equal(multi.images.length, 3);
  assert.equal(multi.images[0], sent.image);
  assert.equal(multi.images[1], `data:image/png;base64,${bytesToBase64(new Uint8Array(await ref2.arrayBuffer()))}`);
  assert.equal(multi.prompt, '构图 @3，蓝色角色 @1，金色角色 @2');
  assert.equal(multi.n, 1);
  await env.storage.delBlob(`blob:${rec2.id}`);
  await assert.rejects(() => env.generators.generate(node), /本地文件缺失/);
  assert.equal(bodies.length, 2, 'a missing middle reference must not be silently omitted');
});

test('图片编辑：参考图本地文件缺失显式失败，不发送', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['gpt-image-2.5-flare']);
  const node = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: 'x' });
  env.store.project.assets['a_lost'] = { id: 'a_lost', name: 'lost.png', kind: 'image', mime: 'image/png', size: 5, addedAt: 1 };  // 无 blob
  const a1 = env.store.addNode('asset', 0, 0, { assetId: 'a_lost' });
  env.store.addEdge(a1.id, 'out', node.id, 'refs', 'image');
  let calls = 0;
  env.api.imageEdit = async () => { calls++; return {}; };
  await assert.rejects(() => env.generators.generate(node), /缺失/);
  assert.equal(calls, 0);
});

test('图片响应为 url 时拒绝拉取并标记未确认', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['gpt-image-2.5-flare']);
  env.api.imageGeneration = async () => ({ data: [{ url: 'https://example.com/x.png' }] });
  const node = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: 'x' });
  await assert.rejects(() => env.generators.generate(node), /b64_json|保存失败/);
  assert.equal(node.data.operation.state, 'unresolved');
  assert.throws(() => imageResponseB64({ data: [{ url: 'https://x' }] }), /b64_json/);
  assert.equal(chatResponseText({ choices: [{ message: { content: 't' } }] }), 't');
});

test('quote：估价标注与连线问题', async () => {
  const env = await makeEnv();
  const img = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare-special', resolution: '4K', ratio: '16:9', prompt: 'x' });
  const q = env.generators.quote(img);
  assert.equal(q.estimatedYuan, 0.11);
  assert.equal(q.priceKind, 'standard');
  const img2 = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: '' });
  const q2 = env.generators.quote(img2);
  assert.equal(q2.priceKind, 'standard_estimate');   // 版本化基线估算，非实际分组价
  assert.equal(q2.estimatedYuan, 0.03);
  assert.ok(q2.issues.some(i => i.includes('提示词')));
});

test('pruneParams 保留 shotId 等元数据；手动估算标注 manual', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['gpt-image-2.5-flare', 'deepseek-chat']);
  setModelCatalog([{ id: 'deepseek-chat', endpoints: ['/v1/chat/completions'] }]);
  env.api.imageGeneration = async () => ({ data: [{ b64_json: PNG_1PX }] });
  env.api.chatCompletion = async () => ({ choices: [{ message: { content: 'ok' } }] });
  const img = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: 'x', params: { shotId: 's_1', size: '9x9' } });
  await env.generators.generate(img);
  assert.equal(img.data.params.shotId, 's_1');             // 分镜链路元数据不得被清掉
  const t = env.store.addNode('text', 0, 0, { model: 'deepseek-chat', text: 'hi', params: { shotId: 's_2', size: '1x1', quoteEstimateYuan: 0.5 } });
  await env.generators.generate(t);
  assert.equal(t.data.params.shotId, 's_2');
  assert.equal(t.data.params.size, undefined);             // 外来请求字段被清理
  assert.equal(t.data.params.quoteEstimateYuan, 0.5);      // 手动估算保留
  const q = env.generators.quote(t);
  assert.equal(q.priceKind, 'manual');
  assert.equal(q.estimatedYuan, 0.5);
});

test('图片结果结构解析：截断 PNG 拒绝入库，操作保持未确认', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['gpt-image-2.5-flare']);
  const full = decodeBase64(PNG_1PX);
  const truncated = bytesToBase64(full.slice(0, full.length - 16));   // 去掉尾部 IEND
  env.api.imageGeneration = async () => ({ data: [{ b64_json: truncated }] });
  const node = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: 'x' });
  await assert.rejects(() => env.generators.generate(node), /保存失败|不完整|解码/);
  assert.equal(node.data.operation.state, 'unresolved');
  assert.equal(node.data.resultAssetId, undefined);
});

test('跨窗口：持久化未确认操作阻挡陈旧快照重复发送', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['deepseek-chat']);
  const nA = env.store.addNode('text', 0, 0, { model: 'deepseek-chat', text: 'hi' });
  await env.store.flush();
  const b = createStore(env.storage);
  await b.openProject(env.store.project.id);
  let queue = Promise.resolve(), calls = 0;
  const lock = (_n, fn) => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };
  const api = { chatCompletion: async () => { calls++; throw new ApiError(502, 'mock', 'x'); } };
  const gx = createGenerators({ store: env.store, storage: env.storage, api, assets: {}, submitLock: lock });
  const gy = createGenerators({ store: b, storage: env.storage, api, assets: {}, submitLock: lock });
  await Promise.allSettled([gx.generate(nA), gy.generate(b.node(nA.id))]);
  assert.equal(calls, 1, '锁内重读持久化操作，第二个窗口不得重复发送');
});

test('setKey 身份变化清理目录/可用范围；同键保留；陈旧响应被拒绝', async () => {
  await setKey('sk-a');
  setModelCatalog([{ id: 'm1' }]);
  setAvailableModels(['m1']);
  const fpA = getFingerprint();
  await setKey('sk-a');                            // 同键重设
  assert.ok(getModelCatalog());                    // 目录保留
  await setKey('sk-b');                            // 换钥
  assert.equal(getModelCatalog(), null);
  assert.equal(getAvailableModels(), null);
  assert.equal(setModelCatalog([{ id: 'stale' }], { keyFp: fpA }), false);   // 陈旧响应不得应用
  assert.equal(setAvailableModels(['stale'], { keyFp: fpA }), false);
});

test('chatModelIdsFromCatalog：名称暴露的非对话型号不被混入；显式端点优先', () => {
  const ids = chatModelIdsFromCatalog([
    { id: 'gpt-image-9' }, { id: 'minimax-tts-01' }, { id: 'minimax-h3-1080p' },
    { id: 'text-embedding-4' }, { id: 'whisper-1' }, { id: 'gpt-5.6-sol' },
    { id: 'odd-1', endpoints: ['/v1/chat/completions'] },
    { id: 'gpt-lookalike', endpoints: ['/v1/images/generations'] },
  ]);
  assert.deepEqual(ids, ['gpt-5.6-sol', 'odd-1']);
});

test('gen 节点：refs 缺失显式问题；prompt 连线合并进提交体', async () => {
  const env = await makeEnv();
  const gen = env.store.addNode('gen', 0, 0, { draft: { model: 'm-vid', intent: 'text', seconds: 5, ratio: '16:9', prompt: '追加', switches: { generate_audio: true } }, perModel: {} });
  const an = env.store.addNode('asset', 0, 0, {});
  env.store.addEdge(an.id, 'out', gen.id, 'refs', 'image');
  let w = env.runner.wired(gen.id, 'refs');
  assert.ok(w.problems.some(p => p.includes('未绑定')));
  const img = env.store.addNode('image', 0, 0, { resultAssetId: 'a_nonexist' });
  env.store.project.edges.push({ id: 'e_x', from: { node: img.id, port: 'out' }, to: { node: gen.id, port: 'refs' }, order: 1 });
  w = env.runner.wired(gen.id, 'refs');
  assert.ok(w.problems.some(p => p.includes('不存在')));
  // 清掉 refs 连线，专测 prompt 合并
  env.store.project.edges = env.store.project.edges.filter(e => !(e.to.node === gen.id && e.to.port === 'refs'));
  await setKey('sk-x');
  const tn = env.store.addNode('text', 0, 0, { text: '主线剧情' });
  assert.ok(env.store.addEdge(tn.id, 'out', gen.id, 'prompt', 'text'));
  const sent = [];
  env.api.createTask = async body => { sent.push(JSON.parse(body)); return { id: 'task_1', status: 'queued' }; };
  env.api.getTask = async () => ({ status: 'completed' });
  await env.runner.submit(gen);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].prompt, '主线剧情\n\n追加');
  assert.equal(gen.data.run.taskId, 'task_1');
  // 上游文本无输出 → 显式问题，不发请求
  tn.data.text = ''; delete tn.data.resultText;
  const gen2 = env.store.addNode('gen', 0, 0, { draft: { model: 'm-vid', intent: 'text', seconds: 5, ratio: '16:9', prompt: 'x' }, perModel: {} });
  env.store.addEdge(tn.id, 'out', gen2.id, 'prompt', 'text');
  await env.runner.submit(gen2);
  assert.equal(sent.length, 1);
});

test('assistant：动作白名单校验与应用', async () => {
  const env = await makeEnv();
  const t1 = env.store.addNode('text', 0, 0, { text: 'hello' });
  const g1 = env.store.addNode('image', 0, 0, { prompt: 'p' });
  const handles = new Map([['N1', { kind: 'node', id: t1.id }], ['N2', { kind: 'node', id: g1.id }]]);
  const planned = planActions([
    { type: 'add_note', text: '记一下' },
    { type: 'rename_node', node: 'N1', title: '新名' },
    { type: 'set_prompt', node: 'N2', prompt: '新提示词' },
    { type: 'connect', from: 'N1', to: 'N2', toPort: 'prompt' },
    { type: 'eval', code: 'alert(1)' },
    { type: 'delete_node', node: 'N1' },
    { type: 'set_node_text', node: 'N2', text: 'x' },
    'garbage',
  ], { store: env.store, handles });
  assert.equal(planned.filter(p => p.ok).length, 4);
  for (const p of planned) if (p.ok) p.run();
  assert.equal(env.store.node(t1.id).data.title, '新名');
  assert.equal(g1.data.prompt, '新提示词');
  assert.equal(env.store.project.edges.length, 1);
  assert.ok(env.store.project.nodes.some(n => n.type === 'note'));
});

test('extractJson 容错', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('说明\n```json\n{"a":2}\n```\n尾注'), { a: 2 });
  assert.equal(extractJson('没有 json'), null);
});

test('图片结果：b64 超长先在分配前拒绝；像素尺寸与文件结构不一致拒绝入库', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['gpt-image-2.5-flare']);
  assert.equal(b64DecodedSize(PNG_1PX), decodeBase64(PNG_1PX).length);
  let decodeCalls = 0;
  const gen = createGenerators({
    store: env.store, storage: env.storage, api: env.api, assets: env.assets,
    submitLock: { request: (n, f) => f() },
    decodeImage: async () => { decodeCalls++; return { width: 2, height: 2 }; },  // 谎报尺寸：PNG 实为 1x1
  });
  env.api.imageGeneration = async () => ({ data: [{ b64_json: PNG_1PX }] });
  const n1 = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: 'x' });
  await assert.rejects(() => gen.generate(n1), /不一致/);
  assert.equal(decodeCalls, 1, '真实解码路径确被调用（非仅结构兜底）');
  assert.equal(n1.data.operation.state, 'unresolved');
  assert.equal(n1.data.resultAssetId, undefined);
  // 超长 b64：长度门槛在解码/分配前拦截
  const huge = Buffer.alloc(IMAGE_RESULT_MAX_BYTES + 8).toString('base64');
  assert.ok(b64DecodedSize(huge) > IMAGE_RESULT_MAX_BYTES);
  env.api.imageGeneration = async () => ({ data: [{ b64_json: huge }] });
  const n2 = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: 'x' });
  await assert.rejects(() => gen.generate(n2), /上限/);
  assert.equal(decodeCalls, 1, '超长响应不得进入解码分配');
  assert.equal(n2.data.operation.state, 'unresolved');
});

test('图片结果：解码等待期间切换项目，既不写回也不污染新项目', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['gpt-image-2.5-flare']);
  const node = env.store.addNode('image', 0, 0, { model: 'gpt-image-2.5-flare', resolution: '1K', ratio: '1:1', prompt: 'x' });
  const pidA = env.store.project.id;
  env.api.imageGeneration = async () => ({ data: [{ b64_json: PNG_1PX }] });
  let release, entered;
  const gate = new Promise(r => release = r);
  const started = new Promise(r => entered = r);
  let regs = 0;
  const origReg = env.assets.registerBlob;
  env.assets.registerBlob = (...a) => { regs++; return origReg(...a); };
  const gen = createGenerators({
    store: env.store, storage: env.storage, api: env.api, assets: env.assets,
    submitLock: { request: (n, f) => f() },
    decodeImage: () => { entered(); return gate; },   // 可控延迟的真实解码替身
  });
  const pending = gen.generate(node);
  await started;                                     // 确认已进入解码等待
  await env.store.newProject('另一个项目');          // 解码期间切走
  release({ width: 1, height: 1 });
  await assert.rejects(pending, /变更|未确认/);
  assert.equal(regs, 0, '身份已变不得开始素材注册');
  assert.equal(Object.keys(env.store.project.assets).length, 0, '新项目素材表必须为空');
  const op = await env.storage.get(`op:${pidA}:${node.id}`);
  assert.equal(op.state, 'unresolved');
  assert.equal(op.projectId, pidA);
});

test('resolveOperation：锁内重读持久化事实，不覆盖其他窗口已终结的操作', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  setAvailableModels(['deepseek-chat']);
  const node = env.store.addNode('text', 0, 0, { model: 'deepseek-chat', text: 'hi' });
  env.api.chatCompletion = async () => { throw new Error('网络错误'); };
  await assert.rejects(() => env.generators.generate(node), /未确认/);
  assert.equal(node.data.operation.state, 'unresolved');
  // 另一窗口已把该操作终结为 completed（durable 记录更新、时间戳更新）
  const newer = { ...node.data.operation, state: 'completed', resolvedAt: Date.now() + 10000, completedAt: Date.now() + 10000 };
  await env.storage.set(`op:${env.store.project.id}:${node.id}`, newer);
  // 本窗口仍持旧内存态发起 abandon → 锁内重读后不得覆盖 durable 的 completed
  const r = await env.generators.resolveOperation(node, 'abandon');
  assert.equal(r, true);
  assert.equal(node.data.operation.state, 'completed');
  const dur = await env.storage.get(`op:${env.store.project.id}:${node.id}`);
  assert.equal(dur.state, 'completed');
});

test('restoreOperations：恢复期间切项目即停止，绝不写进新项目；同项目正常回填', async () => {
  const env = await makeEnv();
  const node = env.store.addNode('text', 0, 0, { text: 'x' });
  const pidA = env.store.project.id;
  await env.storage.set(`op:${pidA}:${node.id}`, { id: 'op1', kind: 'text', state: 'unresolved', projectId: pidA, nodeId: node.id, resolvedAt: Date.now(), createdAt: Date.now() });
  // 门控 storage.get：读到 op 记录时先放行进入循环，再闸住，切项目后放行
  const origGet = env.storage.get.bind(env.storage);
  let release, entered;
  const gate = new Promise(r => release = r);
  const started = new Promise(r => entered = r);
  env.storage.get = async k => {
    if (k.startsWith('op:')) { entered(); await gate; }
    return origGet(k);
  };
  const pr = env.generators.restoreOperations();
  await started;
  await env.store.newProject('另一个项目');
  release();
  const r = await pr;
  assert.equal(r.restored, 0, '项目已切换：不得继续恢复');
  env.storage.get = origGet;
  // 正常路径：同项目回填 durable 操作守卫并计数
  const env2 = await makeEnv();
  const n2 = env2.store.addNode('text', 0, 0, { text: 'y' });
  await env2.storage.set(`op:${env2.store.project.id}:${n2.id}`, { id: 'op9', kind: 'text', state: 'unresolved', projectId: env2.store.project.id, nodeId: n2.id, resolvedAt: Date.now() });
  const r2 = await env2.generators.restoreOperations();
  assert.equal(r2.restored, 1);
  assert.equal(env2.store.node(n2.id).data.operation.id, 'op9');
});

test('assistant：方案绑定发送前快照；句柄按不可变 id 解析，绝不漂移', async () => {
  const env = await makeEnv();
  await setKey('sk-x');
  const t1 = env.store.addNode('text', 0, 0, { text: 'hello' });
  const handles = new Map([['N1', { kind: 'node', id: t1.id }]]);
  const meta = { project: env.store.project, projectId: env.store.project.id, keyFp: getFingerprint(), signature: canvasSignature(env.store.project), handles };
  assert.equal(planStale(meta, env.store), false);
  t1.data.title = '改名';                                   // 结构签名变化 → 失效
  assert.equal(planStale(meta, env.store), true);
  await setKey('sk-y');                                     // 密钥变化 → 失效（用当前画布重算签名隔离变量）
  assert.equal(planStale({ ...meta, signature: canvasSignature(env.store.project) }, env.store), true);
  await setKey('sk-x');
  const env2 = await makeEnv();                             // 项目对象不同 → 失效
  assert.equal(planStale(meta, env2.store), true);
  // 句柄→id 冻结：原 N1 删除后新建节点顶到同序号，旧计划也绝不写新节点
  const planned = planActions([{ type: 'set_node_text', node: 'N1', text: '污染' }], { store: env.store, handles });
  assert.equal(planned[0].ok, true);
  env.store.removeNode(t1.id);
  const t2 = env.store.addNode('text', 0, 0, { text: '新节点' });
  assert.throws(() => planned[0].run(), /已删除/);
  assert.equal(t2.data.text, '新节点');
});
