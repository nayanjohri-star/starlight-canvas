// genBody 渲染路径引用完整性 smoke：e2e 曾暴露 task 状态行回调内 statusTone/statusLabel
// 未导入 → 浏览器 ReferenceError、状态行永停「…」。单测未覆盖该 DOM 路径，此文件以
// 最小 DOM 桩在 node 层真实执行 genBody 的任务行分支，断言异步回调无未处理拒绝、
// 徽章实际渲染出统一谓词的文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createTaskRunner, genBody } from '../src/gennode.js';
import { setCapabilities } from '../src/capabilities.js';
import * as keys from '../src/keyvault.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);
const MODEL = 'minimax-h3-768p-per-second';
const draft = (over = {}) => ({ model: MODEL, intent: 'text', prompt: '测试提示词', seconds: 4, ratio: '16:9', switches: {}, ...over });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 最小 DOM 桩：覆盖 el() 与状态行用到的 children/lastChild/replaceChildren/textContent 语义
const mkEl = () => {
  const e = {
    children: [], attrs: {},
    append(...cs) {
      for (const c of cs.flat(Infinity)) if (c != null) {
        const n = typeof c === 'object' ? c : { textContent: String(c), children: [] };
        n.parentNode = e; e.children.push(n);
      }
      e.lastChild = e.children[e.children.length - 1] ?? null;
    },
    replaceChildren(...cs) { e.children = []; e.lastChild = null; e.append(...cs); },
    remove() {}, setAttribute(k, v) { e.attrs[k] = String(v); },
    getAttribute(k) { return e.attrs[k] ?? null; },
    addEventListener() {},
  };
  return e;
};
globalThis.document = { createElement: mkEl, getElementById: () => null };

const noUpload = { remoteValid: () => true, assetOfNode: () => null, async upload() { throw new Error('not used'); } };

test('genBody 任务状态行：statusTone/statusLabel 引用完整、徽章渲染真实文案（e2e ReferenceError 回归）', async t => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await keys.setKey('mock-genbody');
  keys.setAvailableModels([MODEL]);
  t.after(async () => { await store.flush(); keys.clearKey(); keys.setAvailableModels(null); });
  await store.newProject('SMOKE');
  const pid = store.project.id;
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  await store.saveTask({ taskId: 'smoke_t', projectId: pid, nodeId: node.id, model: MODEL, status: 'in_progress', executorVersion: 2, stage: 'running', progress: 40, keyFp: keys.getFingerprint() });
  node.data.run = { taskId: 'smoke_t' };
  const runner = createTaskRunner({
    store, storage,
    api: { getTask: async () => { throw new Error('not used'); }, createTask: async () => { throw new Error('not used'); } },
    assets: noUpload, onUpdate() {},
  });

  const rejections = [];
  const onRej = r => rejections.push(r);
  process.on('unhandledRejection', onRej);
  t.after(() => process.off('unhandledRejection', onRej));

  const box = genBody(node, { runner, store });
  assert.ok(box, 'genBody 应返回容器');
  await sleep(20);   // recOf().then 回调链全部落地
  assert.deepEqual(rejections.map(String), [], '回调内引用错误会形成未处理拒绝（statusTone/statusLabel 未导入即此类）');

  const statusRow = box.children.find(c => c.children?.[0]?.textContent === '状态');
  assert.ok(statusRow, '任务状态行应存在');
  const badgeEl = statusRow.lastChild?.children?.[0];
  assert.ok(badgeEl && String(badgeEl.className).includes('badge'), '状态徽章应已 replaceChildren 写入（回调未抛错）');
  assert.equal(badgeEl.textContent, '生成中', 'in_progress 经统一谓词渲染真实文案而非「…」占位');
});
