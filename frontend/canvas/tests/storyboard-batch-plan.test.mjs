// 分镜「批量生成所选」必须执行用户确认的那份冻结计划（0.4.1）：
// 预检签发 plan → 确认 → start({plan})；确认等待期间改提示词/切项目 → 拒绝且零生成；
// 同一确认不能重复启动；预检未签发计划 → 不进入确认、不生成。
// 使用真实 createWorkflow + 内存存储；生成器为计数桩，不触达任何网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { setCapabilities } from '../src/capabilities.js';
import { createAssets } from '../src/assets.js';
import { createStoryboards } from '../src/storyboard.js';
import { createWorkflow } from '../src/workflow.js';

class StubEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; }
  set className(v) { this._c = v; } get className() { return this._c; }
  set textContent(v) { this._t = v; } get textContent() { return this._t; }
  setAttribute(k, v) { (this._a ??= {})[k] = v; }
  addEventListener() {}
  append(...c) { this.children.push(...c); }
  prepend(...c) { this.children.unshift(...c); }
  replaceChildren(...c) { this.children = c; }
  remove() {}
}
globalThis.document ??= {
  getElementById: id => (id === 'toast-root' ? new StubEl('div') : null),
  createElement: t => new StubEl(t),
  addEventListener() {}, removeEventListener() {}, body: new StubEl('body'),
};
setCapabilities({ models: {}, upload_limits: {} });

const lock = async (_name, fn) => fn();

async function boot({ confirm } = {}) {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('分镜批量计划');
  const assets = createAssets({ store, storage, api: { uploadAsset: async () => { throw new Error('未接入'); } } });
  const calls = [];
  const workflow = createWorkflow({ store, storage, submitLock: lock, pollMs: 1,
    generators: { quote: () => 0.5, generate: async n => { calls.push(n.id); n.data.resultText = `done:${n.data.prompt}`; } } });
  const starts = [];
  const wfSpy = {
    preview: args => workflow.preview(args),
    start: args => { starts.push(args); return workflow.start(args); },
  };
  const deps = { store, storage, assets, board: { select() {} }, workflow: wfSpy, onUpdate() {}, confirm };
  const sb = createStoryboards(deps);
  // 两个分镜各绑定一个空白付费节点 + 一个已有结果的节点（仅补空白应复用）
  const shots = ['镜头一', '镜头二', '镜头三'].map(title => sb.addShot({ title }));
  const nodes = shots.map((s, i) => {
    const n = store.addNode('text', 0, i * 200, { title: s.title, model: 'mock-text', prompt: s.title,
      ...(i === 2 ? { resultText: '已有结果', operation: { id: 'op-3', state: 'completed' } } : {}) });
    s.nodeId = n.id;
    return n;
  });
  return { store, sb, shots, nodes, calls, starts, workflow };
}

test('确认后按预检签发的冻结计划启动：仅新执行空白节点，复用已有结果', async () => {
  let shown = null;
  const { sb, shots, nodes, calls, starts, workflow } = await boot({ confirm: async (_t, body) => { shown = body; return true; } });
  const r = await sb.batchGenerate(shots.map(s => s.id));
  assert.ok(r, '批量生成应启动');
  assert.equal(starts.length, 1);
  assert.ok(starts[0].plan, 'start 必须携带预检签发的计划');
  assert.equal(starts[0].targets, undefined, '不得绕过计划按 targets 重新计算');
  assert.deepEqual(calls.sort(), [nodes[0].id, nodes[1].id].sort(), '只生成两个空白节点');
  assert.equal(workflow.getState().nodes[nodes[2].id].reused, true, '已有结果复用');
  const textOf = n => n == null ? '' : typeof n === 'string' ? n : `${n.textContent ?? ''}${(n.children ?? []).map(textOf).join('')}`;
  const text = textOf(shown);
  assert.match(text, /新执行 2 个节点/);
  assert.match(text, /复用 1 个/);
  assert.match(text, /1 元/, '估价只含新执行：2 × 0.5');
});

test('确认等待期间修改所选节点提示词 → 冻结计划失效，零生成', async () => {
  let nodesRef;
  const { sb, shots, nodes, calls, starts } = await boot({
    confirm: async () => { nodesRef[0].data.prompt = '确认期间被改'; return true; },
  });
  nodesRef = nodes;
  const r = await sb.batchGenerate(shots.map(s => s.id));
  assert.equal(r, null, '计划失效必须拒绝');
  assert.equal(starts.length, 1, '按计划尝试启动一次');
  assert.equal(calls.length, 0, '不得按修改后的内容照旧生成');
});

test('用户取消确认 → 不启动；再次发起需重新预检确认，不重复生成', async () => {
  let answer = false;
  const { sb, shots, calls, starts } = await boot({ confirm: async () => answer });
  assert.equal(await sb.batchGenerate(shots.map(s => s.id)), null);
  assert.equal(starts.length, 0);
  answer = true;
  assert.ok(await sb.batchGenerate(shots.map(s => s.id)));
  assert.equal(calls.length, 2);
  // 第二次批量：全部已有结果 → 仅补空白零新执行
  assert.ok(await sb.batchGenerate(shots.map(s => s.id)));
  assert.equal(calls.length, 2, '已完成的节点不再重复生成');
});

test('预检未签发计划（旧模块/异常）→ 不进入确认、不启动', async () => {
  let asked = 0;
  const starts = [];
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('无计划预检');
  const sb = createStoryboards({ store, storage, assets: createAssets({ store, storage, api: {} }), board: { select() {} },
    workflow: { preview: async () => ({ issues: [], fatal: [], estimatedYuan: 0 }), start: async a => { starts.push(a); return {}; } },
    onUpdate() {}, confirm: async () => { asked++; return true; } });
  const s = sb.addShot({ title: 'x' });
  s.nodeId = store.addNode('text', 0, 0, { title: 'x', model: 'mock-text', prompt: 'x' }).id;
  assert.equal(await sb.batchGenerate([s.id]), null);
  assert.equal(asked, 0, '无计划不得进入确认');
  assert.equal(starts.length, 0);
});
