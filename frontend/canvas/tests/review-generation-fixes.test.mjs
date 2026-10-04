// 审查修复回归测试（G-01~G-08）。所有付费/网络接口均为 mock，绝不发起真实付费请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createAssets } from '../src/assets.js';
import { setKey } from '../src/keyvault.js';
import { setCapabilities } from '../src/capabilities.js';
import { createTaskRunner } from '../src/gennode.js';
import { createGenerators } from '../src/studio-gen.js';
import { createWorkflow } from '../src/workflow.js';

// Node 环境最小 DOM 桩：toast/modal 等 UI 助手只要求这两个方法存在
globalThis.document = { getElementById: () => null, createElement: () => ({ append() {}, remove() {}, setAttribute() {}, style: {} }) };

const passthrough = (_name, fn) => fn();
const sleep = ms => new Promise(r => setTimeout(r, ms));

setCapabilities({
  models: {
    m1: {
      display_name: 'M1', family: 'h3', price_cny_per_second: 0.2,
      seconds: { min: 1, max: 30, default: 5 },
      ratios: { options: ['16:9'], default: '16:9' },
      reference_limits: { image: 9, video: 3, audio: 3, total: 9 },
      switches: {}, prompt_max_characters: 2000, resolution: '768p', groups: ['std'],
    },
  },
  upload_limits: {
    image: { content_types: ['image/png'], max_mib: 30 },
    video: { content_types: ['video/mp4'], max_mib: 200 },
    audio: { content_types: ['audio/mpeg'], max_mib: 50 },
  },
});

async function makeEnv() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('t');
  const fp = await setKey('test-key');
  return { storage, store, fp, project: store.project };
}

const videoBlob = () => new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])], { type: 'video/mp4' });
const genDraft = () => ({ model: 'm1', intent: 'text', seconds: 5, ratio: '16:9', prompt: 'p', switches: {} });

// 素材资产 mock：registerBlob 计数并真实落 blob，blobOf 直读存储
function mockAssets(store, storage) {
  const calls = { register: 0 };
  return {
    calls,
    remoteValid: () => false,
    blobOf: id => storage.getBlob(`blob:${id}`),
    registerBlob: async (blob, name, kind, extra = {}) => {
      calls.register++;
      const id = `a${calls.register}`;
      await storage.setBlob(`blob:${id}`, blob);
      const rec = { id, name, kind, mime: blob.type || 'video/mp4', size: blob.size, missing: false, ...extra };
      store.project.assets[id] = rec;
      return rec;
    },
  };
}

test('G-01 交付失败行重试只重跑下载/入库，不重新提交、不重复计费', async () => {
  const { storage, store, fp, project } = await makeEnv();
  const node = store.addNode('gen', 0, 0, { title: 'g', draft: genDraft(), perModel: {} });
  const rec = { taskId: 't1', projectId: project.id, nodeId: node.id, model: 'm1', status: 'completed', keyFp: fp, createdAt: Date.now() };
  await store.saveTask(rec);
  const localVideo = videoBlob();
  await storage.setBlob('blob:a1', localVideo);
  project.assets['a1'] = { id: 'a1', name: 'v.mp4', kind: 'video', mime: 'video/mp4', missing: false, size: localVideo.size, fromTask: 't1' };
  let submitCalls = 0, detachCalls = 0, downloadCalls = 0;
  const runner = {
    recOf: async () => rec,
    download: async () => {
      downloadCalls++;
      if (downloadCalls === 1) return null;              // 首次下载失败（网络抖动等）
      node.data.resultAssetId = 'a1';
      return true;
    },
    submit: async n => { submitCalls++; n.data.run = { taskId: 't1' }; },
    detach: async () => { detachCalls++; return true; },
  };
  const wf = createWorkflow({ store, storage, runner, pollMs: 1, submitLock: passthrough });
  const st = await wf.start({ targets: [node.id], confirmed: true });
  assert.equal(st.status, 'failed');
  assert.equal(st.nodes[node.id].reason, 'delivery');
  assert.equal(submitCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.equal(st.estimatedSpendYuan, 1);
  await wf.retryRow(st.rows[0].id);
  const run = project.studio.workflow;
  assert.equal(submitCalls, 1, '已完成任务不得二次提交付费请求');
  assert.equal(detachCalls, 0, '已完成任务不得 detach');
  assert.equal(downloadCalls, 2, '重试只应重跑下载/入库');
  assert.equal(run.nodes[node.id].status, 'done');
  assert.equal(run.estimatedSpendYuan, 1, '同一任务重试不得重复计费');
});

test('G-02 结果未明（可能已发送）的图文请求预算恰好预留一次', async () => {
  const { storage, store } = await makeEnv();
  const node = store.addNode('text', 0, 0, { title: 't', model: 'chat-x', text: 'hello' });
  let calls = 0;
  const generators = {
    quote: () => ({ estimatedYuan: 0.5, kind: 'standard' }),
    generate: async n => {
      calls++;
      n.data.operation = { id: 'op1', kind: 'text', model: 'chat-x', state: 'unresolved', sentAt: Date.now(), createdAt: Date.now() };
      throw new Error('网络错误');
    },
  };
  const wf = createWorkflow({ store, storage, runner: {}, generators, pollMs: 1, submitLock: passthrough });
  const st = await wf.start({ targets: [node.id], confirmed: true });
  assert.equal(st.status, 'failed');
  assert.equal(calls, 1);
  assert.equal(st.estimatedSpendYuan, 0.5, '已发送未确认的请求必须占一次预算');
  await wf.retryRow(st.rows[0].id);
  const run = store.project.studio.workflow;
  assert.equal(calls, 2);
  assert.equal(run.estimatedSpendYuan, 0.5, '同一操作记录不得重复记账');
});

test('G-03 runner 导出 adoptDurable：持久化任务被认领且不重新提交、不计入本 run', async () => {
  const { storage, store, fp, project } = await makeEnv();
  const assets = mockAssets(store, storage);
  const api = {
    downloadContent: async () => ({ status: 200, contentType: 'video/mp4', blob: videoBlob() }),
    getTask: async () => { throw new Error('不应轮询'); },
    createTask: async () => { throw new Error('不应创建'); },
  };
  const runner = createTaskRunner({ store, storage, api, assets, onUpdate: () => {}, submitLock: passthrough });
  assert.equal(typeof runner.adoptDurable, 'function');
  const node = store.addNode('gen', 0, 0, { title: 'g', draft: genDraft(), perModel: {} });
  await store.saveTask({ taskId: 't7', projectId: project.id, nodeId: node.id, model: 'm1', status: 'completed', keyFp: fp, createdAt: Date.now() });
  let submitCalls = 0;
  const realSubmit = runner.submit;
  runner.submit = async n => { submitCalls++; return realSubmit(n); };
  const wf = createWorkflow({ store, storage, runner, pollMs: 1, submitLock: passthrough });
  const st = await wf.start({ targets: [node.id], confirmed: true });
  assert.equal(submitCalls, 0, '已存在持久化任务时不得再走价格闸/提交');
  assert.equal(node.data.run?.taskId, 't7', 'adoptDurable 应关联既有任务');
  assert.equal(st.nodes[node.id].status, 'done');
  assert.equal(assets.calls.register, 1, '认领后仍应完成下载入库');
  assert.equal(st.estimatedSpendYuan, 0, '非本 run 发起的任务不计入本 run 估算');
});

test('G-04 发送前身份变更回退为 saved（可证明未发送），不留 sent 阻塞', async () => {
  const { storage, store, project } = await makeEnv();
  const node = store.addNode('text', 0, 0, { title: 't', model: 'chat-x', text: 'hello' });
  let sent = 0;
  const api = { chatCompletion: async () => { sent++; return { choices: [{ message: { content: 'ok' } }] }; } };
  // 第二次 op: 写入（即 state='sent' 的持久化）时移除节点 → 模拟发送前节点被删/项目被切
  const realSet = storage.set;
  let opWrites = 0;
  const hacked = {
    ...storage,
    set: async (k, v) => {
      const r = await realSet(k, v);
      if (k.startsWith('op:') && ++opWrites === 2) store.removeNode(node.id);
      return r;
    },
  };
  const generators = createGenerators({ store, api, assets: {}, storage: hacked, submitLock: passthrough });
  await assert.rejects(() => generators.generate(node), /未发送/);
  assert.equal(sent, 0, '请求绝不应发出');
  assert.equal(node.data.operation.state, 'saved');
  assert.equal(node.data.operation.sentAt, null);
  const rec = await storage.get(`op:${project.id}:${node.id}`);
  assert.equal(rec.state, 'saved', '持久化记录必须回退为 saved，不留 sent 阻塞');
  assert.equal(rec.sentAt, null);
});

test('G-05 可证明未发送的提交可立即解除；已发送/未明仍守 24h 窗', async () => {
  const { storage, store, fp, project } = await makeEnv();
  const runner = createTaskRunner({ store, storage, api: {}, assets: {}, onUpdate: () => {}, submitLock: passthrough });
  const node = store.addNode('gen', 0, 0, { title: 'g', draft: genDraft(), perModel: {} });
  // 未构建/未发送：bodyString 与 lastSubmitAt 均为空 → 立即可解除且不再被认领
  await store.savePendingCreate({ idempotencyKey: 'k1', projectId: project.id, nodeId: node.id, model: 'm1', bodyString: null, keyFp: fp, createdAt: Date.now(), lastSubmitAt: null, state: 'uncertain' });
  node.data.run = { pendingKey: 'k1' };
  await runner.releasePending(node);
  assert.equal(node.data.run, null, '可证明未发送的提交应可解除');
  assert.equal(await store.pendingCreate('k1'), undefined, '未发送记录解除后应清除，不得留 abandoned 守卫');
  await runner.adoptDurable(node);
  assert.equal(node.data.run, null, '已解除的未发送记录不得再恢复禁发守卫');
  // 旧路径遗留的 abandoned 未发送记录同样不得再武装守卫
  await store.savePendingCreate({ idempotencyKey: 'k1b', projectId: project.id, nodeId: node.id, model: 'm1', bodyString: null, keyFp: fp, createdAt: Date.now(), lastSubmitAt: null, state: 'abandoned' });
  await runner.adoptDurable(node);
  assert.equal(node.data.run, null, '旧版解除遗留的 abandoned 未发送记录不得再恢复守卫');
  // 可能已发送：lastSubmitAt 非空且仍在 24h 窗内 → 保持禁发
  await store.savePendingCreate({ idempotencyKey: 'k2', projectId: project.id, nodeId: node.id, model: 'm1', bodyString: '{}', keyFp: fp, createdAt: Date.now(), lastSubmitAt: Date.now(), state: 'uncertain' });
  node.data.run = { pendingKey: 'k2' };
  await runner.releasePending(node);
  assert.equal(node.data.run?.pendingKey, 'k2', '可能已发送的提交不得提前解除');
  const r2 = await store.pendingCreate('k2');
  assert.equal(r2.state, 'uncertain');
  // 有完整请求体的未知旧记录（lastSubmitAt 缺失不能证明没发过）→ 仍守 24h
  node.data.run = null;
  await store.savePendingCreate({ idempotencyKey: 'k3', projectId: project.id, nodeId: node.id, model: 'm1', bodyString: '{}', keyFp: fp, createdAt: Date.now(), lastSubmitAt: null, state: 'uncertain' });
  node.data.run = { pendingKey: 'k3' };
  await runner.releasePending(node);
  assert.equal(node.data.run?.pendingKey, 'k3', '有完整 body 的旧记录仍守 24h 窗');
  assert.equal((await store.pendingCreate('k3')).state, 'uncertain');
});

test('G-06 同任务并发/重复下载只入库一次；素材在 blob 缺失正确修复', async () => {
  const { storage, store, fp, project } = await makeEnv();
  const assets = mockAssets(store, storage);
  let fetches = 0, release;
  const gate = new Promise(r => { release = r; });
  const api = {
    downloadContent: async () => {
      fetches++;
      await gate;                                    // 强制并发窗口
      return { status: 200, contentType: 'video/mp4', blob: videoBlob() };
    },
  };
  const runner = createTaskRunner({ store, storage, api, assets, onUpdate: () => {}, submitLock: passthrough });
  await store.saveTask({ taskId: 't1', projectId: project.id, nodeId: null, model: 'm1', status: 'completed', keyFp: fp, createdAt: Date.now() });
  const p1 = runner.download('t1');
  const p2 = runner.download('t1');
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(assets.calls.register, 1, '并发下载只能注册一次素材');
  assert.equal(fetches, 1);
  // 第三次重复调用：已入库素材+blob 有效 → 直接复用
  const r3 = await runner.download('t1');
  assert.equal(r3, true);
  assert.equal(assets.calls.register, 1, '重复下载不得重复注册');
  assert.equal(fetches, 1, '结果 blob 仍在时不得重复 GET');
  // 素材在但 blob 缺失：用已下载结果 blob 修复，不重注册、不重 GET
  project.assets['a9'] = { id: 'a9', name: 'v.mp4', kind: 'video', missing: true, size: 0 };
  await storage.setBlob(`result:${project.id}:t2`, videoBlob());
  await store.saveTask({ taskId: 't2', projectId: project.id, nodeId: null, model: 'm1', status: 'completed', keyFp: fp, createdAt: Date.now(), resultAssetId: 'a9', resultBlobId: `result:${project.id}:t2`, resultType: 'video/mp4' });
  const r4 = await runner.download('t2');
  assert.equal(r4, true);
  assert.equal(assets.calls.register, 1, '修复缺失 blob 不得重复注册素材');
  assert.equal(fetches, 1);
  assert.equal(project.assets['a9'].missing, false, '素材缺失标记应被修复');
  assert.ok(await storage.getBlob('blob:a9'), '素材 blob 应被回填');
});

test('G-07 401 停止轮询不空转，显式恢复仅再查询一次', async () => {
  const { storage, store, fp, project } = await makeEnv();
  let calls = 0;
  const api = { getTask: async () => { calls++; throw Object.assign(new Error('密钥无效'), { status: 401 }); } };
  const runner = createTaskRunner({ store, storage, api, assets: {}, onUpdate: () => {}, submitLock: passthrough });
  await store.saveTask({ taskId: 't9', projectId: project.id, nodeId: null, model: 'm1', status: 'queued', keyFp: fp, createdAt: Date.now() });
  runner.poll('t9', project.id);
  await sleep(1600);
  assert.equal(calls, 1);
  const rec = await storage.get(`task:${project.id}:t9`);
  assert.equal(rec.paused, true, '401/403 后必须暂停轮询');
  await sleep(1400);
  assert.equal(calls, 1, '暂停后不得继续自动轮询');
  runner.poll('t9', project.id);                     // 用户更新密钥后的恢复路径 = 仅恢复查询
  await sleep(1600);
  assert.equal(calls, 2, '恢复路径只应再查询一次，不得自动循环');
  const rec2 = await storage.get(`task:${project.id}:t9`);
  assert.equal(rec2.paused, true);
});

test('G-08 预览按 CSV 行展开模板后估价（4K 按实际展开价）', async () => {
  const { storage, store } = await makeEnv();
  const node = store.addNode('image', 0, 0, { title: 'i', model: 'gpt-image-2.5-flare-special', resolution: '{{res}}', ratio: '16:9', prompt: 'draw' });
  const generators = createGenerators({ store, api: {}, assets: {}, storage, submitLock: passthrough });
  const wf = createWorkflow({ store, storage, runner: {}, generators, pollMs: 1, submitLock: passthrough });
  const r4k = await wf.preview({ targets: [node.id], rows: 'res\n4K' });
  assert.equal(r4k.fatal.length, 0);
  assert.equal(r4k.estimatedYuan, 0.11, '4K 行必须按展开后的 4K 价估算');
  const r1k = await wf.preview({ targets: [node.id], rows: 'res\n1K' });
  assert.equal(r1k.estimatedYuan, 0.06);
  const mix = await wf.preview({ targets: [node.id], rows: 'res\n4K\n1K' });
  assert.equal(mix.estimatedYuan, 0.17, '预估必须逐行按展开价累计');
});

test('G-09 另一实例持同锁提交中时，releasePending 不得提前解除', async () => {
  const { storage, store, fp, project } = await makeEnv();
  const tails = new Map();   // 同 realm 串行锁：模拟跨标签页 xp-submit 互斥
  const sharedLock = (name, fn) => { const prev = tails.get(name) ?? Promise.resolve(); const run = prev.then(() => fn()); tails.set(name, run.then(() => undefined, () => undefined)); return run; };
  let releaseGate, enteredResolve;
  const gate = new Promise(r => { releaseGate = r; });
  const entered = new Promise(r => { enteredResolve = r; });
  const api1 = {
    createTask: async () => { enteredResolve(); await gate; return { id: 'tx', status: 'completed' }; },
    getTask: async () => ({ status: 'completed', progress: 100 }),
  };
  const runner1 = createTaskRunner({ store, storage, api: api1, assets: {}, onUpdate: () => {}, submitLock: sharedLock });
  const runner2 = createTaskRunner({ store, storage, api: {}, assets: {}, onUpdate: () => {}, submitLock: sharedLock });
  const node = store.addNode('gen', 0, 0, { title: 'g', draft: genDraft(), perModel: {} });
  await store.savePendingCreate({ idempotencyKey: 'k9', projectId: project.id, nodeId: node.id, model: 'm1', bodyString: '{}', keyFp: fp, createdAt: Date.now(), lastSubmitAt: null, state: 'uncertain' });
  node.data.run = { pendingKey: 'k9' };
  const p1 = runner1.retrySubmit(node);
  await entered;                                   // runner1 持锁且 POST 在途
  const p2 = runner2.releasePending(node);         // 另一实例此时请求解除 → 必须排队等同锁并重读事实
  releaseGate();
  await Promise.all([p1, p2]);
  assert.equal(node.data.run?.taskId, 'tx', '在途提交期间不得把节点释放成可再发状态');
  assert.equal(await store.pendingCreate('k9'), undefined, '已受理的 pending 由提交方正常清理');
});

test('G-10 读缓存成片期间切项目，不把旧成片注册进新项目', async () => {
  const { storage, store, fp } = await makeEnv();
  const assets = createAssets({ store, storage, api: {} });
  const oldPid = store.project.id;
  const node = store.addNode('gen', 0, 0, { title: 'g', draft: genDraft(), perModel: {}, run: { taskId: 'tc' } });
  const resultKey = `result:${oldPid}:tc`;
  await storage.setBlob(resultKey, videoBlob());
  await store.saveTask({ taskId: 'tc', projectId: oldPid, nodeId: node.id, model: 'm1', status: 'completed', keyFp: fp, createdAt: Date.now(), resultBlobId: resultKey, resultType: 'video/mp4' });
  const realGetBlob = storage.getBlob.bind(storage);
  let switched = false;
  storage.getBlob = async key => { const v = await realGetBlob(key); if (key === resultKey && !switched) { switched = true; await store.newProject('新项目'); } return v; };
  const runner = createTaskRunner({ store, storage, api: { downloadContent: async () => { throw new Error('缓存存在不应发起 GET'); } }, assets, onUpdate: () => {}, submitLock: passthrough });
  const r = await runner.download('tc');
  assert.equal(r, null);
  assert.equal(store.project.name, '新项目');
  assert.equal(Object.keys(store.project.assets).length, 0, '旧成片不得混入新项目素材');
  assert.ok(await realGetBlob(resultKey), '原成片缓存必须保留');
  const rec = await storage.get(`task:${oldPid}:tc`);
  assert.equal(rec.resultDeferred, true, '切换后结果应标记保留在原任务记录');
});

test('G-11 existing 素材复用必须确属本任务，不能拿节点上他任务的 resultAssetId 冒充', async () => {
  const { storage, store, fp, project } = await makeEnv();
  const assets = mockAssets(store, storage);
  let fetches = 0;
  const api = { downloadContent: async () => { fetches++; return { status: 200, contentType: 'video/mp4', blob: videoBlob() }; } };
  const runner = createTaskRunner({ store, storage, api, assets, onUpdate: () => {}, submitLock: passthrough });
  const node = store.addNode('gen', 0, 0, { title: 'g', draft: genDraft(), perModel: {} });
  // 节点当前 resultAssetId 已被另一个任务改写（fromTask 指向别的任务，本任务记录也未关联）
  project.assets['aOther'] = { id: 'aOther', name: 'other.mp4', kind: 'video', missing: false, size: 8, fromTask: 'other-task' };
  await storage.setBlob('blob:aOther', videoBlob());
  node.data.resultAssetId = 'aOther';
  await store.saveTask({ taskId: 'tA', projectId: project.id, nodeId: node.id, model: 'm1', status: 'completed', keyFp: fp, createdAt: Date.now() });
  node.data.run = { taskId: 'tA' };   // A1 合同：节点须绑定本任务，下载收尾才允许写回节点输出
  const r1 = await runner.download('tA');
  assert.equal(r1, true);
  assert.equal(fetches, 1, '非本任务素材不得复用，必须真实下载');
  assert.equal(assets.calls.register, 1, '应注册全新素材');
  assert.notEqual(node.data.resultAssetId, 'aOther', '不得沿用他任务素材充当本任务成片');
  assert.equal(project.assets['aOther'].fromTask, 'other-task', '他任务素材保持原样');
  // kind 非 video 的记录关联同样不得复用
  project.assets['aImg'] = { id: 'aImg', name: 'x.png', kind: 'image', missing: false, size: 8 };
  await storage.setBlob('blob:aImg', videoBlob());
  await store.saveTask({ taskId: 'tB', projectId: project.id, nodeId: null, model: 'm1', status: 'completed', keyFp: fp, createdAt: Date.now(), resultAssetId: 'aImg' });
  const r2 = await runner.download('tB');
  assert.equal(r2, true);
  assert.equal(fetches, 2, '非视频素材不得冒充成片复用');
  assert.notEqual((await runner.recOf('tB', project.id)).resultAssetId, 'aImg');
  // 正向：记录关联属于本任务的 video 素材直接复用，不再 GET
  project.assets['aOwn'] = { id: 'aOwn', name: 'own.mp4', kind: 'video', missing: false, size: 8, fromTask: 'tC' };
  await storage.setBlob('blob:aOwn', videoBlob());
  await store.saveTask({ taskId: 'tC', projectId: project.id, nodeId: null, model: 'm1', status: 'completed', keyFp: fp, createdAt: Date.now(), resultAssetId: 'aOwn' });
  const r3 = await runner.download('tC');
  assert.equal(r3, true);
  assert.equal(fetches, 2, '属于本任务的已入库素材直接复用，不再 GET');
});

test('G-12 发送前回退写盘失败：内存恢复 sent 保护，UI 与 durable 不冲突', async () => {
  const { storage, store, project } = await makeEnv();
  const node = store.addNode('text', 0, 0, { title: 't', model: 'chat-x', text: 'hello' });
  let sent = 0;
  const api = { chatCompletion: async () => { sent++; return { choices: [{ message: { content: 'ok' } }] }; } };
  const realSet = storage.set;
  let opWrites = 0;
  const hacked = {
    ...storage,
    set: async (k, v) => {
      if (k.startsWith('op:')) {
        opWrites++;
        if (opWrites === 2) { const r = await realSet(k, v); store.removeNode(node.id); return r; }  // sent 落盘成功后节点被删
        if (opWrites >= 3) throw new Error('模拟存储写回失败');                                    // 回退 saved 的写盘失败
      }
      return realSet(k, v);
    },
  };
  const generators = createGenerators({ store, api, assets: {}, storage: hacked, submitLock: passthrough });
  await assert.rejects(() => generators.generate(node), /未发送/);
  assert.equal(sent, 0, '请求绝不应发出');
  assert.equal(node.data.operation.state, 'sent', '回退写盘失败必须恢复 sent 保护');
  assert.ok(node.data.operation.sentAt, 'sentAt 必须保留');
  const rec = await storage.get(`op:${project.id}:${node.id}`);
  assert.equal(rec.state, 'sent', 'durable 保持 sent，与内存一致');
});

test('G-13 resumeAll/adoptDurable 不在无身份更新时唤醒 authFailed 任务', async () => {
  const { storage, store, fp, project } = await makeEnv();
  let calls = 0;
  const api = { getTask: async () => { calls++; return { status: 'completed', progress: 100 }; } };
  const runner = createTaskRunner({ store, storage, api, assets: {}, onUpdate: () => {}, submitLock: passthrough });
  await store.saveTask({ taskId: 'ta', projectId: project.id, nodeId: null, model: 'm1', status: 'in_progress', keyFp: fp, createdAt: Date.now(), paused: true, authFailed: true });
  await runner.resumeAll();
  await sleep(1400);
  assert.equal(calls, 0, '无身份更新时 resumeAll 不得唤醒 authFailed 任务轮询');
  const node = store.addNode('gen', 0, 0, { title: 'g', draft: genDraft(), perModel: {} });
  await store.saveTask({ taskId: 'tb', projectId: project.id, nodeId: node.id, model: 'm1', status: 'in_progress', keyFp: fp, createdAt: Date.now(), paused: true, authFailed: true });
  await runner.adoptDurable(node);
  assert.equal(node.data.run?.taskId, 'tb', '认领关联仍然生效');
  await sleep(1400);
  assert.equal(calls, 0, 'adoptDurable 不得唤醒 authFailed 任务');
  runner.poll('tb', project.id);                   // 用户显式恢复：仅恢复查询，不产生新 POST
  await sleep(1400);
  assert.equal(calls, 1, '显式恢复只应再查询一次');
  const rec = await storage.get(`task:${project.id}:tb`);
  assert.equal(rec.authFailed, false, '查询成功后应清除 authFailed 标记');
});
