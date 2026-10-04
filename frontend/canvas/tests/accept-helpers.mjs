// D 独立验收共享 harness（内存 storage + 注入 api/assets，零网络零付费）。
// 范式对齐 tests/h3-v2-runner.test.mjs；只组装公共件，不复制被测判断逻辑。
import { readFile } from 'node:fs/promises';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createTaskRunner } from '../src/gennode.js';
import { createWorkflow } from '../src/workflow.js';
import { setCapabilities } from '../src/capabilities.js';
import * as keys from '../src/keyvault.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);

export const MODEL = 'minimax-h3-768p-per-second';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const passthrough = (_name, fn) => fn();
export const MP4 = () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 0, 0, 0, 0])], { type: 'video/mp4' });

const el = () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {}, style: {} });
export function stubDom() {
  globalThis.document = { createElement: el, getElementById: el };
}
stubDom();

export function genDraft(over = {}) {
  return { model: MODEL, intent: 'text', prompt: 'accept 测试提示词', seconds: 4, ratio: '16:9', switches: {}, ...over };
}

// 素材层替身：registerBlob 与真实 assets.registerBlob 同口径——blob 实体写入 storage（blob:<id>），
// 记录写入 project.assets（finalize 依赖它落产出关联；0.5 核心 localResult 会核验实体存在）
export function stubAssets(store, storage) {
  return {
    remoteValid: () => true,
    assetOfNode: () => null,
    async blobOf() { return null; },
    async registerBlob(blob, name, kind, meta) {
      const a = { id: `asset_${meta?.fromTask ?? 'x'}`, name, kind, fromTask: meta?.fromTask, size: blob.size, mime: blob.type, missing: false };
      if (storage) await storage.setBlob(`blob:${a.id}`, blob);
      store.project.assets[a.id] = a;
      return a;
    },
  };
}

export async function setup(t, { key = 'sk-accept', models = [MODEL], storage } = {}) {
  const storage0 = storage ?? createMemoryStorage();
  const store = createStore(storage0);
  await keys.setKey(key);
  keys.setAvailableModels(models);
  t.after(async () => { await store.flush(); keys.clearKey(); keys.setAvailableModels(null); });
  await store.newProject('accept');
  return { storage: storage0, store, pid: store.project.id, fp: keys.getFingerprint() };
}

export function makeApi(over = {}) {
  const calls = { creates: [], gets: [], downloads: [], cancels: [] };
  const api = {
    createTask: async () => { calls.creates.push(1); throw new Error('验收路径不得新建生成 POST'); },
    getTask: async id => { calls.gets.push(id); return { status: 'in_progress' }; },
    downloadContent: async () => { calls.downloads.push(1); return { status: 200, contentType: 'video/mp4', blob: MP4() }; },
    cancelTask: async () => { calls.cancels.push(1); throw new Error('不应请求取消'); },
    ...over,
  };
  return { api, calls };
}

export function makeRunner({ store, storage, api, assets, onUpdate, submitLock } = {}) {
  return createTaskRunner({ store, storage, api, assets: assets ?? stubAssets(store, storage), submitLock: submitLock ?? passthrough, onUpdate: onUpdate ?? (() => {}) });
}

export function makeWorkflow({ store, storage, runner, assets, pollMs = 40 } = {}) {
  return createWorkflow({
    store, storage, runner, pollMs,
    submitLock: passthrough,
    assets: assets ?? stubAssets(store, storage),
    generators: { quote: () => { throw new Error('验收路径不经生成器'); } },
    tools: { execute: () => { throw new Error('验收路径不经工具'); } },
    onUpdate() {},
  });
}

// 任务记录种子（字段形态=服务端响应经 normalize 的本地记录）
export function seedTask(store, { pid, nodeId, taskId, ...fields }) {
  return store.saveTask({ taskId, projectId: pid, nodeId, model: MODEL, ...fields });
}

// 故障注入存储包装：failOn(key, op) 返回真即让该次写入抛错（不吞、不改写数据）。
// 用法：let arm = k => k.startsWith('task:'); const fs = faultStorage(storage, (k, op) => arm(k));
// 注入的是「写路径失败」这一持久层事实，与 IDB 事务失败语义一致。
export function faultStorage(inner, failOn) {
  const boom = () => { throw new Error('injected storage write failure'); };
  return {
    ...inner,
    get: inner.get.bind(inner),
    keys: inner.keys.bind(inner),
    getBlob: inner.getBlob.bind(inner),
    set: async (k, v) => { if (failOn(k, 'set')) boom(); return inner.set(k, v); },
    setBlob: async (k, v) => { if (failOn(k, 'setBlob')) boom(); return inner.setBlob(k, v); },
    del: async k => { if (failOn(k, 'del')) boom(); return inner.del(k); },
    delBlob: async k => { if (failOn(k, 'delBlob')) boom(); return inner.delBlob(k); },
    batch: async entries => {
      if (entries.some(([k]) => failOn(k, 'batch'))) boom();
      return inner.batch(entries);
    },
    setIfRev: (k, rev, v) => (failOn(k, 'setIfRev') ? Promise.reject(new Error('injected storage write failure')) : inner.setIfRev(k, rev, v)),
  };
}
