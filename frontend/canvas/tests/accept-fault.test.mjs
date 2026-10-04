// WO-D2a 故障注入验收（单元/内存层；断言针对合同不变量，不绑定实现路径）：
// 覆盖 g0-d.md 风险清单与验收矩阵未覆盖的故障域。全部 loopback-free 内存 mock，零网络零付费。
// 对照组与既有 accept-a1/a2/b1 互不重叠；发现的新问题如实 RED 不包装。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { mergeTaskResponse, canFetchContent, isSettled, isV2Record } from '../src/task-status.js';
import { localRequest } from '../src/submit-lock.js';
import * as keys from '../src/keyvault.js';
import { setup, makeApi, makeRunner, stubAssets, genDraft, seedTask, faultStorage, sleep, MP4, MODEL } from './accept-helpers.mjs';

// ---------- F1：提交前 pending 落盘失败 → 绝不发付费 POST，恢复后同节点可重试 ----------
test('F1：pending 持久化失败 → 零 POST + 显式错误态 + 恢复可重试', async t => {
  const mem = createMemoryStorage();
  let armed = true;
  const fs = faultStorage(mem, k => armed && k.startsWith('pending:'));
  const { store, pid } = await setup(t, { storage: fs });
  t.after(() => { armed = false; });
  const { api, calls } = makeApi({ createTask: async () => { calls.creates.push(1); return { task_id: 'c1', status: 'queued' }; } });
  const runner = makeRunner({ store, storage: fs, api });
  t.after(async () => { await runner.setPollPaused('c1', true, pid).catch(() => {}); });

  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });

  await runner.submit(node);
  assert.equal(calls.creates.length, 0, '持久化写不进去绝不发付费请求');
  assert.ok(node.data.run?.storageError || node.data.run?.error,
    `失败应呈显式可恢复错误态，实际 run=${JSON.stringify(node.data.run)}`);
  assert.equal(node.data.run?.taskId ?? null, null);
  assert.equal(node.data.run?.pendingKey ?? null, null);

  armed = false;
  await runner.submit(node);
  assert.equal(calls.creates.length, 1, '存储恢复后同节点重试应正常发起一次');
  assert.ok(node.data.run?.taskId, '重试后节点应绑定受理任务');
});

// ---------- F2：下载收尾 putRec 失败 → 不重复注册素材，重试补齐落盘 ----------
test('F2：下载落盘写失败 → 任务不丢、素材不重复注册、重试完成', async t => {
  const mem = createMemoryStorage();
  let armed = false;
  const fs = faultStorage(mem, k => armed && k.startsWith('task:'));
  const { store, pid, fp } = await setup(t, { storage: fs });
  let registers = 0;
  const assets = stubAssets(store, fs);
  const origRegister = assets.registerBlob;
  assets.registerBlob = async (...a) => { registers++; return origRegister(...a); };
  const { api, calls } = makeApi();
  const runner = makeRunner({ store, storage: fs, api, assets });

  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'fjob', keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true, deliveryStatus: 'ready' });
  node.data.run = { taskId: 'fjob' };

  armed = true;                                   // 首次下载：注册素材后 task 落盘注入失败
  const first = await runner.download('fjob');
  armed = false;
  assert.equal(first, null, '落盘失败整体返回不成功（不谎报）');
  const rec = await store.taskIn(pid, 'fjob');
  assert.equal(rec.status, 'completed', '任务记录不丢、状态不被写坏');
  assert.equal(runner.canDownload('fjob', pid), true, '记录仍保持可下载可重试');

  const second = await runner.download('fjob');   // 重试：复用已注册素材/结果 blob，补齐落盘
  assert.equal(second, true, '恢复后重试应成功');
  assert.equal(registers, 1, '同一任务结果不得重复注册素材');
  const rec2 = await store.taskIn(pid, 'fjob');
  assert.ok(rec2.resultAssetId);
  assert.equal(store.node(node.id).data.resultAssetId, rec2.resultAssetId);
  assert.equal(calls.creates.length, 0);
});

// ---------- F3：迟到响应单调性（merge 合同 + runner 层 + 跨实例同写）----------
test('F3a：mergeTaskResponse 单调性 —— 终态不被非终态回退，粘性真值不回退', async () => {
  const base = { status: 'completed', contentReady: true, deliveryStatus: 'ready', cancelRequested: false };
  const r1 = mergeTaskResponse({ ...base }, { status: 'in_progress', progress: 40 });
  assert.equal(r1.status, 'completed', 'completed 不得被迟到的 in_progress 回退');
  const r2 = mergeTaskResponse({ status: 'failed' }, { status: 'in_progress' });
  assert.equal(r2.status, 'failed');
  const r3 = mergeTaskResponse({ status: 'cancelled' }, { status: 'in_progress' });
  assert.equal(r3.status, 'cancelled');
  // 粘性真值：contentReady/cancelRequested 一旦 true 不被后续响应回退
  const r4 = mergeTaskResponse({ status: 'in_progress', contentReady: true, cancelRequested: true }, { status: 'in_progress', content_ready: false, cancel_requested: false });
  assert.equal(r4.contentReady, true, 'contentReady 粘性真值');
  assert.equal(r4.cancelRequested, true, 'cancelRequested 粘性真值');
  // 终态→终态按服务端收敛（含迟到 completed 覆盖本地 cancelled 的冻结语义）
  const r5 = mergeTaskResponse({ status: 'cancelled' }, { status: 'completed', content_ready: true, delivery_status: 'ready' });
  assert.equal(r5.status, 'completed', '服务端终态之间按响应收敛（冻结语义）');
});

test('F3b：终态后不再发起查询（settled 任务的轮询物理关闭）', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const { api, calls } = makeApi();
  const runner = makeRunner({ store, storage, api });

  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'late', keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true, deliveryStatus: 'ready' });
  node.data.run = { taskId: 'late' };
  await runner.recOf('late', pid);                    // 填充缓存
  const before = calls.gets.length;
  runner.poll('late', pid);                           // 已终结 → tick 直接退出，不发起 GET
  await sleep(1400);
  assert.equal(calls.gets.length, before, '已终结任务不得再向服务端发起查询——迟到响应物理上无法到达');
  const rec = await runner.recOf('late', pid);
  assert.equal(rec.status, 'completed');
  assert.equal(runner.canDownload('late', pid), true);
});

test('F3c：跨实例同写 task 键 —— 陈旧 in_progress 不得覆盖新终态', async t => {
  // 两个 store/runner 实例共享同一存储：模拟两个标签页缓存各自的任务快照。
  const storage = createMemoryStorage();
  const store1 = createStore(storage);
  await store1.newProject('cas');
  const pid = store1.project.id;
  const n1 = store1.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await store1.flush();
  const store2 = createStore(storage);
  await store2.openProject(pid);
  const n2 = store2.node(n1.id);
  assert.ok(n2, '第二实例应载入同一节点');
  const { api: api1 } = makeApi({ getTask: async () => ({ status: 'failed' }) });
  const { api: api2 } = makeApi({ getTask: async () => ({ status: 'in_progress' }) });
  const runner1 = makeRunner({ store: store1, storage, api: api1 });
  const runner2 = makeRunner({ store: store2, storage, api: api2 });
  t.after(async () => {
    await runner1.setPollPaused('casjob', true, pid).catch(() => {});
    await runner2.setPollPaused('casjob', true, pid).catch(() => {});
  });
  await seedTask(store1, { pid, nodeId: n1.id, taskId: 'casjob', keyFp: null, status: 'in_progress', executorVersion: 2 });
  await runner1.recOf('casjob', pid);
  await runner2.recOf('casjob', pid);

  runner1.poll('casjob', pid);                        // 实例1：服务端判 failed → 终态落盘
  await sleep(1400);
  const stored1 = await storage.get(`task:${pid}:casjob`);
  assert.equal(stored1.status, 'failed', '实例1 应把终态落盘');

  runner2.poll('casjob', pid);                        // 实例2 持陈旧快照：仍收到 in_progress
  await sleep(1400);
  const stored2 = await storage.get(`task:${pid}:casjob`);
  assert.notEqual(stored2.status, 'in_progress',
    `矩阵行14：查询/迟到响应不得把新终态改回旧状态（跨实例陈旧写覆盖：failed → ${stored2.status}）`);
});

// ---------- F4：v2 字段缺失响应 → 不误判可下载 ----------
test('F4：服务器漏发 content_ready/delivery_status → v2 不误判可下载', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const serverView = { status: 'in_progress', stage: 'running', executor_version: 2 };
  const { api, calls } = makeApi({ getTask: async () => serverView });
  const runner = makeRunner({ store, storage, api });
  t.after(async () => { await runner.setPollPaused('miss', true, pid).catch(() => {}); });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'miss', keyFp: fp, status: 'in_progress', executorVersion: 2 });
  node.data.run = { taskId: 'miss' };

  Object.assign(serverView, { status: 'completed' });  // 漏发 content_ready/delivery_status
  runner.poll('miss', pid);
  await sleep(1400);
  const rec = await runner.recOf('miss', pid);
  assert.equal(rec.status, 'completed');
  assert.equal(isV2Record(rec), true);
  assert.equal(canFetchContent(rec), false, '缺 content_ready 的 v2 completed 不得误判可下载');
  assert.equal(runner.canDownload('miss', pid), false);
  assert.equal(runner.taskLive('miss', pid), true, '未就绪仍应跟踪');
  assert.equal(calls.downloads.length, 0, '不得发起内容 GET');

  Object.assign(serverView, { content_ready: true, delivery_status: 'ready', stage: 'succeeded' });
  runner.poll('miss', pid);
  await sleep(1400);
  assert.equal(runner.canDownload('miss', pid), true, '字段补齐后可下载');
});

// ---------- F5：结果素材被替换后重下 → 不静默删素材、关联纠正 ----------
test('F5：节点输出被换绑其他素材后重下 → 任务结果关联回自身成片，不重建素材', async t => {
  const { storage, store, pid, fp } = await setup(t);
  let registers = 0;
  const assets = stubAssets(store, storage);
  const origRegister = assets.registerBlob;
  assets.registerBlob = async (...a) => { registers++; return origRegister(...a); };
  const { api, calls } = makeApi();
  const runner = makeRunner({ store, storage, api, assets });

  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'swap', keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true, deliveryStatus: 'ready' });
  node.data.run = { taskId: 'swap' };

  assert.equal(await runner.download('swap'), true);
  const a1 = (await store.taskIn(pid, 'swap')).resultAssetId;
  assert.ok(a1 && store.project.assets[a1]);
  const getsAfterFirst = calls.downloads.length;

  store.project.assets.a_other = { id: 'a_other', kind: 'video', name: 'other.mp4', size: 9, mime: 'video/mp4', missing: false };
  node.data.resultAssetId = 'a_other';                // 用户把节点输出换成别的素材
  const before = Object.keys(store.project.assets).length;
  assert.equal(await runner.download('swap'), true, '重复下载应幂等成功');
  const rec = await store.taskIn(pid, 'swap');
  assert.equal(rec.resultAssetId, a1, '任务结果关联必须仍是本任务成片，不被换绑带偏');
  assert.ok(store.project.assets[a1], '本任务成片素材不得被静默删除');
  assert.ok(store.project.assets.a_other, '用户换入的素材不受影响');
  assert.equal(node.data.resultAssetId, a1, '绑定本任务的节点输出恢复为本任务成片');
  assert.equal(registers, 1, '不得重复注册素材');
  assert.equal(Object.keys(store.project.assets).length, before, '素材总数不增不减');
  assert.equal(calls.downloads.length, getsAfterFirst, '已有结果不再向服务端取');
});

// ---------- F6：下载失败恢复 → 任务可重试下载，绝不转生成 ----------
test('F6：downloadContent 失败 → 任务保持可重试下载，零生成 POST', async t => {
  const { storage, store, pid, fp } = await setup(t);
  let failOnce = true;
  const { api, calls } = makeApi({
    downloadContent: async () => {
      calls.downloads.push(1);
      if (failOnce) throw new Error('injected download failure');
      return { status: 200, contentType: 'video/mp4', blob: MP4() };
    },
  });
  const runner = makeRunner({ store, storage, api });

  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'dlf', keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true, deliveryStatus: 'ready' });
  node.data.run = { taskId: 'dlf' };

  assert.equal(await runner.download('dlf'), null, '下载失败返回不成功');
  const rec = await store.taskIn(pid, 'dlf');
  assert.equal(rec.status, 'completed', '下载失败不得改写任务状态');
  assert.equal(runner.canDownload('dlf', pid), true, '失败后可重试下载');
  assert.equal(runner.taskLive('dlf', pid), false, '终态不进入跟踪（非未决）');

  failOnce = false;
  assert.equal(await runner.download('dlf'), true, '重试下载成功');
  assert.ok(store.node(node.id).data.resultAssetId);
  assert.equal(calls.creates.length, 0, '交付失败绝不触发新生成 POST');
});

// ---------- F7：导入中断 → 原工程保留；缺素材 → 显式占位不丢引用 ----------
test('F7a：坏 JSON 导入被拒 → 原项目数据完整保留', async t => {
  const { store } = await setup(t);
  const keep = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await store.flush();
  const name = store.project.name, count = store.project.nodes.length;
  await assert.rejects(store.importJSON('{"format":"xingpan-canvas@2","project":{"name":"截断'));
  await assert.rejects(store.importJSON('{"format":"not-canvas","project":{}}'));
  assert.equal(store.project.name, name);
  assert.equal(store.project.nodes.length, count);
  assert.ok(store.node(keep.id), '原节点不得被失败导入波及');
});

test('F7b：导出含素材但导入缺媒体文件 → 显式 missing 占位，引用不丢不串', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  store.project.assets.a_src = { id: 'a_src', kind: 'video', name: 'v.mp4', size: 1, mime: 'video/mp4', missing: false };
  node.data.resultAssetId = 'a_src';
  await seedTask(store, { pid, nodeId: node.id, taskId: 'imjob', keyFp: fp, status: 'completed', resultAssetId: 'a_src', idempotencyKey: 'im-1' });
  const text = await store.exportJSON();

  const store2 = createStore(createMemoryStorage());
  await store2.importJSON(text);                      // 不提供 assetBlobs —— 媒体文件缺失
  const rec = (await store2.tasksOfProject())[0];
  assert.ok(rec.resultAssetId, '任务→素材关联不丢');
  const a = store2.project.assets[rec.resultAssetId];
  assert.ok(a, '素材占位必须存在');
  assert.equal(a.missing, true, '缺媒体文件的素材保持显式 missing 占位（不得假装可用）');
  const importedNode = store2.project.nodes.find(n => n.type === 'gen');
  assert.equal(importedNode.data.resultAssetId, rec.resultAssetId, '节点输出与任务关联指向同一占位素材');
});

// ---------- F8：重复提交 —— 同节点并发与同幂等键互斥 ----------
test('F8a：同 runner 并发 submit 同节点 → 至多一次 POST', async t => {
  const { storage, store, pid } = await setup(t);
  let release;
  const gate = new Promise(r => { release = r; });
  const { api, calls } = makeApi({ createTask: async () => { calls.creates.push(1); await gate; return { task_id: 'dup1', status: 'queued' }; } });
  const runner = makeRunner({ store, storage, api });
  t.after(async () => { await runner.setPollPaused('dup1', true, pid).catch(() => {}); });
  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  const p1 = runner.submit(node);
  const p2 = runner.submit(node);                     // 节点锁并发防护
  release();
  await Promise.all([p1, p2]);
  assert.equal(calls.creates.length, 1, `同节点并发提交应恰好一次 POST（实际 ${calls.creates.length}）`);
});

test('F8b：两实例共享存储同节点提交 → 互斥锁后持久化核查只放行一次', async t => {
  await keys.setKey('sk-accept');
  keys.setAvailableModels([MODEL]);
  t.after(async () => { keys.clearKey(); keys.setAvailableModels(null); });
  const storage = createMemoryStorage();
  const store1 = createStore(storage);
  await store1.newProject('dup');
  const pid = store1.project.id;
  const n1 = store1.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await store1.flush();
  const store2 = createStore(storage);
  await store2.openProject(pid);
  const n2 = store2.node(n1.id);
  const { api, calls } = makeApi({ createTask: async () => { calls.creates.push(1); return { task_id: 'shared1', status: 'queued' }; } });
  const r1 = makeRunner({ store: store1, storage, api, submitLock: localRequest });
  const r2 = makeRunner({ store: store2, storage, api, submitLock: localRequest });
  t.after(async () => {
    await r1.setPollPaused('shared1', true, pid).catch(() => {});
    await r2.setPollPaused('shared1', true, pid).catch(() => {});
  });
  await r1.submit(n1);
  await r2.submit(n2);                                 // 互斥锁内持久化核查：已有任务/未决记录 → 拒发
  assert.equal(calls.creates.length, 1, `跨实例同节点提交至多一次 POST（实际 ${calls.creates.length}）`);
  assert.equal(n2.data.run?.taskId, 'shared1', '第二实例应认领已有任务而非新建');
});

// ---------- F9：下载完成后节点重绑 + 脱离任务恢复到替代节点 ----------
test('F9a：下载完成后节点重绑 B → 再次下载 A 不覆盖 B 的节点', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const { api, calls } = makeApi();
  const runner = makeRunner({ store, storage, api });

  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'dA', keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true, deliveryStatus: 'ready' });
  node.data.run = { taskId: 'dA' };
  assert.equal(await runner.download('dA'), true);
  const aA = (await store.taskIn(pid, 'dA')).resultAssetId;
  assert.equal(node.data.resultAssetId, aA);

  node.data.run = { taskId: 'dB' };                   // 节点转给新任务
  node.data.resultAssetId = null;                     // 输出槽随新任务清空
  assert.equal(await runner.download('dA'), true, '旧任务重下应成功（结果仍在原记录）');
  assert.equal(node.data.resultAssetId, null, '已重绑 B 的节点不得被 A 的重下覆盖');
  assert.equal((await store.taskIn(pid, 'dA')).resultAssetId, aA, 'A 的结果关联保持');
  assert.equal(calls.creates.length, 0);
});

test('F9b：脱离任务恢复绑定到替代节点 → 结果写替代节点，原节点不动', async t => {
  const { storage, store, pid, fp } = await setup(t);
  const { api, calls } = makeApi();
  const runner = makeRunner({ store, storage, api });

  const node = store.addNode('gen', 0, 0, { draft: genDraft(), perModel: {} });
  await seedTask(store, { pid, nodeId: node.id, taskId: 'rA', keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true, deliveryStatus: 'ready' });
  node.data.run = { taskId: 'rA' };

  await runner.detach(node);
  node.data.run = { taskId: 'rB' };                   // 原节点转给 B
  const restored = await runner.restoreTask('rA', pid);
  assert.ok(restored, '已受理任务应可恢复');
  assert.notEqual(restored.id, node.id, '恢复不得抢占已绑 B 的原节点');
  assert.equal(node.data.run?.taskId, 'rB', '原节点仍绑定 B');
  assert.equal((await store.taskIn(pid, 'rA')).detached, false, '恢复后任务不再是脱离态');

  assert.equal(await runner.download('rA'), true);
  assert.ok(restored.data.resultAssetId, 'A 的结果写到恢复出的替代节点');
  assert.equal(node.data.resultAssetId ?? null, null, 'B 绑定节点不被 A 结果污染');
  assert.equal(calls.creates.length, 0);
});
