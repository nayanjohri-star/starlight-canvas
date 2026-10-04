// H3 多渠道父任务 v2 衔接回归：executor_version/stage/content_ready 持久化、
// completed&&contentReady 下载门槛、cancelTask 幂等与持续跟踪、停止等待/继续查询。
// 全内存 fake + 显式响应队列，无网络、无真实密钥；不用高频 sleep 做压力测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createTaskRunner } from '../src/gennode.js';
import { setCapabilities } from '../src/capabilities.js';
import * as keys from '../src/keyvault.js';

const table = JSON.parse(await readFile(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8'));
setCapabilities(table);
const MODEL = 'minimax-h3-768p-per-second';
const draft = (over = {}) => ({ model: MODEL, intent: 'text', prompt: '测试提示词', seconds: 4, ratio: '16:9', switches: {}, ...over });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const element = () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} });
globalThis.document = { createElement: element, getElementById: element };
const noUpload = { remoteValid: () => true, assetOfNode: () => null, async upload() { throw new Error('not used'); } };

async function setup(t, keyName) {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await keys.setKey(keyName);
  keys.setAvailableModels([MODEL]);
  t.after(async () => { await store.flush(); keys.clearKey(); keys.setAvailableModels(null); });
  await store.newProject('V2');
  return { storage, store, pid: store.project.id };
}

test('v2 轮询：stage/executorVersion/contentReady/cancelRequested 持久化；completed 未 ready 继续查询', async t => {
  const { storage, store, pid } = await setup(t, 'mock-v2-poll');
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  const gets = [];
  const queue = [
    { status: 'in_progress', stage: 'running', executor_version: 2, progress: 40 },
    { status: 'completed', stage: 'delivering', executor_version: 2, content_ready: false, progress: 100 },
  ];
  const api = {
    getTask: async id => { gets.push(id); return queue.length ? queue.shift() : { status: 'completed', stage: 'succeeded', executor_version: 2, content_ready: true }; },
    createTask: async () => { throw new Error('不得新建'); },
  };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload, onUpdate() {} });
  await store.saveTask({ taskId: 'vjob_a', projectId: pid, nodeId: node.id, model: MODEL, status: 'in_progress', keyFp: keys.getFingerprint() });
  node.data.run = { taskId: 'vjob_a' };

  runner.poll('vjob_a', pid);
  await sleep(1400);
  let rec = await store.task('vjob_a');
  assert.equal(rec.executorVersion, 2);
  assert.equal(rec.stage, 'running');
  assert.equal(rec.status, 'in_progress');

  runner.poll('vjob_a', pid);                          // 等价下一次 tick（poll 自带 clearTimeout 幂等）
  await sleep(1400);
  rec = await store.task('vjob_a');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.contentReady, false);
  assert.equal(runner.taskLive('vjob_a'), true, 'completed 但 content_ready=false 不得停轮');
  assert.equal(runner.canDownload('vjob_a'), false, '未 ready 不得放行下载');

  runner.poll('vjob_a', pid);
  await sleep(1400);
  rec = await store.task('vjob_a');
  assert.equal(rec.contentReady, true);
  assert.equal(runner.taskLive('vjob_a'), false);
  assert.equal(runner.canDownload('vjob_a'), true, 'ready 后才可下载（晚成功正常下载）');
});

test('下载门槛：v2 未 ready download 返回 null；legacy completed 无 executorVersion 直接放行', async t => {
  const { storage, store, pid } = await setup(t, 'mock-v2-dl');
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  const downloads = [];
  const api = { getTask: async () => ({status:'completed', executor_version:2, content_ready:true}), downloadContent: async id => { downloads.push(id); return { status: 200, contentType: 'video/mp4', blob: new Blob(['x'], { type: 'video/mp4' }) }; } };
  const assets = { remoteValid: () => true, async blobOf() { return null; }, async registerBlob(blob, name, kind, meta) { return { id: 'asset-1', kind, fromTask: meta?.fromTask, size: blob.size, mime: blob.type }; } };
  const runner = createTaskRunner({ store, storage, api, assets, onUpdate() {} });
  await store.saveTask({ taskId: 'vjob_b', projectId: pid, nodeId: node.id, model: MODEL, status: 'completed', executorVersion: 2, contentReady: false, keyFp: keys.getFingerprint() });
  assert.equal(await runner.download('vjob_b'), null, 'v2 未 ready 不得下载');
  assert.equal(downloads.length, 0);
  runner.poll('vjob_b');
  await sleep(1400);
  assert.ok(await runner.download('vjob_b'), 'ready 后下载入库');
  assert.equal(downloads.length, 1);
  await store.saveTask({ taskId: 'legacy', projectId: pid, nodeId: node.id, model: MODEL, status: 'completed', keyFp: keys.getFingerprint() });
  await runner.recOf('legacy');
  assert.equal(runner.canDownload('legacy'), true, '旧任务无 executorVersion 保持原行为');
});

test('cancelTask：v2 在途发送取消；按响应 status 持续跟踪；双击幂等；移除节点不隐式取消', async t => {
  const { storage, store, pid } = await setup(t, 'mock-v2-cancel');
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  const cancels = [], gets = [];
  const api = {
    cancelTask: async id => { cancels.push(id); return { status: 'in_progress', stage: 'switching', executor_version: 2, cancel_requested: true, cancel_phase: 'stopping' }; },
    getTask: async id => { gets.push(id); return { status: 'cancelled', stage: 'cancelled', executor_version: 2 }; },
  };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload, onUpdate() {} });
  await store.saveTask({ taskId: 'vjob_c', projectId: pid, nodeId: node.id, model: MODEL, status: 'in_progress', executorVersion: 2, keyFp: keys.getFingerprint() });
  node.data.run = { taskId: 'vjob_c' };

  await runner.cancelTask(node);
  assert.deepEqual(cancels, ['vjob_c']);
  let rec = await store.task('vjob_c');
  assert.equal(rec.cancelRequested, true);
  assert.equal(rec.status, 'in_progress', '取消成功不直接本地标 cancelled');
  assert.equal(rec.stage, 'switching');

  await runner.cancelTask(node);                       // 双击：cancelRequested 去重
  assert.equal(cancels.length, 1);

  runner.poll('vjob_c', pid);                          // 持续跟踪：响应 in_progress → 继续 GET
  await sleep(1400);
  rec = await store.task('vjob_c');
  assert.ok(gets.length >= 1);
  assert.equal(rec.status, 'cancelled', '以服务端 status 为准进入终态');
  assert.equal(runner.taskLive('vjob_c'), false);

  const node2 = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  await store.saveTask({ taskId: 'vjob_d', projectId: pid, nodeId: node2.id, model: MODEL, status: 'in_progress', executorVersion: 2, keyFp: keys.getFingerprint() });
  node2.data.run = { taskId: 'vjob_d' };
  await runner.detach(node2);                          // 脱离/移除节点不得触发隐式退款取消
  assert.equal(cancels.length, 1, 'detach 不得调用 cancel');
});

test('cancelTask：先成功后服务端 409 → 刷新原任务；网络异常只报未确认；非 v2 不发送', async t => {
  const { storage, store, pid } = await setup(t, 'mock-v2-cancel2');
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  const cancels = [], gets = [];
  let mode = 'fail409';
  const api = {
    cancelTask: async id => {
      cancels.push(id);
      if (mode === 'fail409') throw Object.assign(new Error('terminal conflict'), { status: 409 });
      if (mode === 'neterr') throw Object.assign(new TypeError('socket hangup'), { status: 0 });
      return { status: 'in_progress', executor_version: 2, cancel_requested: true };
    },
    getTask: async id => { gets.push(id); return { status: 'completed', executor_version: 2, content_ready: true }; },
    createTask: async () => { throw new Error('不得新建'); },
  };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload, onUpdate() {} });
  await store.saveTask({ taskId: 'vjob_e', projectId: pid, nodeId: node.id, model: MODEL, status: 'in_progress', executorVersion: 2, keyFp: keys.getFingerprint() });
  node.data.run = { taskId: 'vjob_e' };

  await runner.cancelTask(node);                       // 409：不标 cancelled，刷新原任务
  let rec = await store.task('vjob_e');
  assert.equal(rec.status, 'in_progress');
  assert.match(rec.pollError ?? '', /终态/);
  await sleep(1400);
  assert.ok(gets.length >= 1, '409 后必须 GET 刷新原任务而非新 POST');
  rec = await store.task('vjob_e');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.contentReady, true);

  const node2 = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  await store.saveTask({ taskId: 'vjob_f', projectId: pid, nodeId: node2.id, model: MODEL, status: 'in_progress', executorVersion: 2, keyFp: keys.getFingerprint() });
  node2.data.run = { taskId: 'vjob_f' };
  mode = 'neterr';
  await runner.cancelTask(node2);
  rec = await store.task('vjob_f');
  assert.equal(rec.status, 'in_progress', '网络异常不得改变任务状态');
  assert.match(rec.pollError ?? '', /未确认/);

  const node3 = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  await store.saveTask({ taskId: 'legacy_g', projectId: pid, nodeId: node3.id, model: MODEL, status: 'in_progress', keyFp: keys.getFingerprint() });
  node3.data.run = { taskId: 'legacy_g' };
  const before = cancels.length;
  await runner.cancelTask(node3);
  assert.equal(cancels.length, before, '无明确 executor_version=2 不得提供取消');
});

test('setPollPaused：停止等待冻结轮询，继续查询恢复；换密钥仍按既有守卫暂停', async t => {
  const { storage, store, pid } = await setup(t, 'mock-v2-pause');
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  const gets = [];
  const api = { getTask: async id => { gets.push(id); return { status: 'in_progress', stage: 'running', executor_version: 2 }; } };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload, onUpdate() {} });
  await store.saveTask({ taskId: 'vjob_p', projectId: pid, nodeId: node.id, model: MODEL, status: 'in_progress', executorVersion: 2, keyFp: keys.getFingerprint() });
  node.data.run = { taskId: 'vjob_p' };

  runner.poll('vjob_p', pid);
  await sleep(1400);
  assert.ok(gets.length >= 1);
  await runner.setPollPaused('vjob_p', true);
  let rec = await store.task('vjob_p');
  assert.equal(rec.paused, true);
  const n = gets.length;
  await sleep(1400);
  assert.equal(gets.length, n, '停止等待不得再有 GET');
  await runner.setPollPaused('vjob_p', false);
  await sleep(1400);
  assert.ok(gets.length > n, '继续查询必须恢复 GET');

  await keys.setKey('mock-v2-other');                  // 换密钥：既有守卫暂停而非继续
  runner.poll('vjob_p', pid);
  await sleep(1400);
  rec = await store.task('vjob_p');
  assert.equal(rec.paused, true);
});

test('404 只改变查询健康：连续错误待核对、成功复位；旧版也不伪造生成终态', async t => {
  const { storage, store, pid } = await setup(t, 'mock-v2-404');
  const node = store.addNode('gen', 0, 0, { draft: draft(), perModel: {} });
  const err404 = () => Object.assign(new Error('gone'), { status: 404 });
  const api = {
    getTask: async id => {
      if (id === 'nf_c') return { status: 'in_progress', stage: 'reconciling', executor_version: 2 };
      throw err404();
    },
    createTask: async () => { throw new Error('不得新建'); },
  };
  const runner = createTaskRunner({ store, storage, api, assets: noUpload, onUpdate() {} });
  const fp = keys.getFingerprint();
  const base = { projectId: pid, nodeId: node.id, model: MODEL, keyFp: fp };
  // a：普通 v2 单次 404；b：已计 4 次的 v2 本次进入待核对；
  // c：v2 查询成功复位；d：旧版同样不能把查询错误伪造成服务器失败
  await store.saveTask({ ...base, taskId: 'nf_a', status: 'in_progress', executorVersion: 2 });
  await store.saveTask({ ...base, taskId: 'nf_b', status: 'in_progress', executorVersion: 2, notFoundPolls: 4 });
  await store.saveTask({ ...base, taskId: 'nf_c', status: 'in_progress', executorVersion: 2, notFoundPolls: 3 });
  await store.saveTask({ ...base, taskId: 'nf_d', status: 'in_progress' });
  for (const id of ['nf_a', 'nf_b', 'nf_c', 'nf_d']) runner.poll(id, pid);
  await sleep(1600);

  const a = await store.task('nf_a');
  assert.equal(a.status, 'in_progress', 'v2 单次 404 不得判终态');
  assert.equal(a.notFoundPolls, 1, '404 计数推进');
  const b = await store.task('nf_b');
  assert.equal(b.status, 'in_progress', '连续 5 次 404 仍保留最后确认的服务器状态');
  assert.equal(b.queryHealth, 'needs_review');
  const c = await store.task('nf_c');
  assert.equal(c.notFoundPolls, 0, '查询成功复位 404 计数');
  assert.equal(c.status, 'in_progress');
  const d = await store.task('nf_d');
  assert.equal(d.status, 'in_progress', '旧版 404 也不是任务删除证据');
  assert.equal(d.queryHealth, 'retrying');
});
