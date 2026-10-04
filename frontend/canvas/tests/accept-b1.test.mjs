// WO-D1 独立验收 B1（contracts §2/裁决7；不替 B 改实现）：
// 「执行器、工作流、任务面板对同一任务给出一致判断」——waitTask 消费统一交付判断：
//   delivering / completed+!contentReady / rec 缺席 → 继续等待；
//   canFetchContent → 下载入库 → done；isFinalFailure → failed；
//   交付失败 reason='delivery' 只允许下载/入库恢复，绝不转新生成。
// 基线预期：B1-1/B1-2 RED（workflow.js waitTask 用旧判断与执行器分叉）；
// B1-3/4/5 为对照钉住（基线即正确）。面板一致性待 C1a 落地后补断言（工单注明）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, makeApi, makeRunner, makeWorkflow, stubAssets, genDraft, seedTask, sleep, MP4, MODEL } from './accept-helpers.mjs';

async function waitFor(fn, { timeout = 4000, step = 20 } = {}) {
  const t0 = Date.now();
  for (;;) { if (fn()) return; if (Date.now() - t0 > timeout) throw new Error('waitFor 超时'); await sleep(step); }
}

// serverView：可变的服务端视图。adoptDurable 触发的 runner.poll 会合并它——
// 与记录突变保持同步，避免真实轮询把测试驱动的记录状态打回。
async function startRun(t, taskFields, { onApi } = {}) {
  const { storage, store, pid, fp } = await setup(t);
  const serverView = { status: 'in_progress', stage: 'running', executor_version: taskFields?.executorVersion ?? null };
  const { api, calls } = makeApi({
    getTask: async id => (serverView),
    ...(onApi ? onApi() : {}),
  });
  const assets = stubAssets(store, storage);
  const runner = makeRunner({ store, storage, api, assets });
  const wf = makeWorkflow({ store, storage, runner, assets, pollMs: 30 });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'wjob', keyFp: fp, status: 'in_progress', ...taskFields });
  node.data.run = { taskId: 'wjob' };
  const done = wf.start({ targets: [node.id], confirmed: true })
    .then(s => ({ ok: true, state: s }), e => ({ ok: false, error: e }));
  const rec = () => runner.taskPeek('wjob', pid);
  const setServer = fields => {
    Object.assign(serverView, fields);
    const r = rec(); if (r) Object.assign(r, {
      status: fields.status ?? r.status,
      stage: fields.stage ?? r.stage,
      contentReady: fields.content_ready ?? r.contentReady,
      deliveryStatus: fields.delivery_status ?? r.deliveryStatus,
    });
  };
  return { store, runner, wf, node, pid, done, calls, setServer };
}

const nsOf = (wf, node) => wf.getState().nodes?.[node.id];
const nsStatus = (wf, node) => nsOf(wf, node)?.status;

test('B1-1：v2 completed+delivering（交付中）→ waitTask 持续等待不误 failed', async t => {
  const { runner, wf, node, done, calls, setServer } = await startRun(t, { executorVersion: 2 });
  await waitFor(() => nsStatus(wf, node) === 'waiting');
  setServer({ status: 'completed', stage: 'delivering', delivery_status: 'delivering', content_ready: false });
  await sleep(200);                                     // 覆盖数个 waitTask 节拍（pollMs=30）
  assert.equal(nsStatus(wf, node), 'waiting',
    `B1 复现：completed+delivering 被工作流误判为终态失败（实际 ${JSON.stringify(nsOf(wf, node))}；执行器 taskLive=${runner.taskLive('wjob')}）`);
  setServer({ stage: 'succeeded', delivery_status: 'ready', content_ready: true });
  const r = await done;
  assert.equal(r.ok, true, `工作流应正常结束：${r.error?.message ?? ''}`);
  assert.equal(nsOf(wf, node)?.status ?? r.state?.nodes?.[node.id]?.status, 'done');
  assert.equal(calls.creates.length, 0, '全程零生成 POST');
});

test('B1-2：v2 completed+contentReady=false（交付未就绪）→ 不下载不误 failed', async t => {
  const { runner, wf, node, done, calls, setServer } = await startRun(t, { executorVersion: 2 });
  await waitFor(() => nsStatus(wf, node) === 'waiting');
  setServer({ status: 'completed', stage: 'delivering', delivery_status: 'ready', content_ready: false });
  await sleep(200);
  const ns = nsOf(wf, node);
  assert.equal(ns?.status, 'waiting',
    `B1 复现：v2 completed+contentReady=false 被工作流误判 failed（实际 ${JSON.stringify(ns)}；执行器 canDownload=${runner.canDownload('wjob')} taskLive=${runner.taskLive('wjob')}）`);
  assert.equal(calls.downloads.length, 0, '未就绪不得发起内容 GET');
  setServer({ stage: 'succeeded', content_ready: true });
  const r = await done;
  assert.equal(r.ok, true);
  assert.equal(r.state?.nodes?.[node.id]?.status ?? nsOf(wf, node)?.status, 'done');
  assert.equal(calls.creates.length, 0);
});

test('B1-3：v2 completed+ready → 下载入库 done（对照钉住）', async t => {
  const { wf, node, done, calls, setServer } = await startRun(t, { executorVersion: 2 });
  await waitFor(() => nsStatus(wf, node) === 'waiting');
  setServer({ status: 'completed', stage: 'succeeded', delivery_status: 'ready', content_ready: true });
  const r = await done;
  assert.equal(r.ok, true, `对照用例应通过：${r.error?.message ?? ''}`);
  assert.equal(r.state?.nodes?.[node.id]?.status ?? nsOf(wf, node)?.status, 'done');
  assert.equal(calls.creates.length, 0);
});

test('B1-4：failed → isFinalFailure → ns=failed 且零 POST（对照钉住）', async t => {
  const { wf, node, done, calls, setServer } = await startRun(t, { executorVersion: 2 });
  await waitFor(() => nsStatus(wf, node) === 'waiting');
  setServer({ status: 'failed', error: { message: '服务端失败' } });
  const r = await done;
  assert.equal(r.ok, true);
  const ns = r.state?.nodes?.[node.id] ?? nsOf(wf, node);
  assert.equal(ns?.status, 'failed');
  assert.equal(calls.creates.length, 0, '终态失败不得触发新生成');
  assert.equal(calls.downloads.length, 0, '终态失败不得发起内容 GET');
});

test('B1-5：legacy completed（无 v2 字段）→ 下载入库 done（兼容对照）', async t => {
  const { wf, node, done, calls, setServer } = await startRun(t, {});
  await waitFor(() => nsStatus(wf, node) === 'waiting');
  setServer({ status: 'completed', delivery_status: 'ready' });
  const r = await done;
  assert.equal(r.ok, true);
  assert.equal(r.state?.nodes?.[node.id]?.status ?? nsOf(wf, node)?.status, 'done');
});

test('B1-6：rec 缺席 → 继续等待不误判（裁决7）', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const { api, calls } = makeApi();
  const assets = stubAssets(store, storage);
  const runner = makeRunner({ store, storage, api, assets });
  const wf = makeWorkflow({ store, storage, runner, assets, pollMs: 30 });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  node.data.run = { taskId: 'ghost' };                  // 无对应任务记录
  const done = wf.start({ targets: [node.id], confirmed: true })
    .then(s => ({ ok: true, state: s }), e => ({ ok: false, error: e }));
  await waitFor(() => nsStatus(wf, node) === 'waiting');
  await sleep(200);
  assert.equal(nsStatus(wf, node), 'waiting', 'rec 缺席应继续等待（不得 failed/done）');
  await wf.pause();                                     // 收尾：不让悬挂运行留到下个用例
  await done;
});
