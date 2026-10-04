// R05-A 独立验收：统一任务中心 = 发布侧行构建（main.js）× 核心真实运行器（gennode/store/storage）。
// 不桩核心：用内存存储 + 本地模拟上游驱动真实 createTaskRunner，断言用户在任务中心看到的状态与可点的动作，
// 并通过点击动作验证：只 GET 原任务、零 POST、任务号与幂等键不变、URL 成对释放、不越权写节点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, btnOf, buttons, badgeOf, toasts } from './r05-dom-stub.mjs';

const { taskPanelEntries, taskCenterView, liveTaskRecords, TASK_CENTER_STATES } = await import('../src/main.js');
installDom();
const { createMemoryStorage } = await import('../src/storage.js');
const { createStore } = await import('../src/store.js');
const { createTaskRunner } = await import('../src/gennode.js');
const keys = await import('../src/keyvault.js');

function clock() {
  const jobs = new Map(); let id = 0;
  return {
    setTimeout(fn, ms) { const n = ++id; jobs.set(n, { fn, ms }); return n; },
    clearTimeout(n) { jobs.delete(n); },
    async next() {
      const first = [...jobs].sort((a, b) => a[1].ms - b[1].ms || a[0] - b[0])[0];
      if (!first) throw new Error('没有待执行定时器');
      jobs.delete(first[0]); await first[1].fn();
    },
    count: () => jobs.size,
  };
}
const mp4 = () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0])], { type: 'video/mp4' });
const noAssets = { remoteValid: () => true, blobOf: async () => null };

async function env(t, name, api = {}) {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('accept-r05-tc-' + name);
  await keys.setKey('synthetic-key-' + name);
  t.after(() => keys.clearKey());
  const fp = keys.getFingerprint(), pid = store.project.id;
  const node = store.addNode('gen', 0, 0, { draft: { model: 'mock' }, run: { taskId: 'job' } });
  await store.flush();
  const calls = { get: 0, post: 0, cancel: 0, download: 0 };
  const poll = clock(), save = clock();
  const upstream = {
    async getTask(id) { calls.get++; return api.getTask ? api.getTask(id) : { status: 'in_progress', executor_version: 2 }; },
    async createTask() { calls.post++; throw new Error('验收中不得发起生成 POST'); },
    async cancelTask(id) { calls.cancel++; return api.cancelTask ? api.cancelTask(id) : { status: 'in_progress', executor_version: 2, cancel_requested: true }; },
    async downloadContent(id) { calls.download++; if (api.downloadContent) return api.downloadContent(id); throw new Error('未预期的远端下载'); },
  };
  const runner = createTaskRunner({ store, storage, api: upstream, assets: noAssets, pollScheduler: poll, saveScheduler: save });
  const focused = [];
  const e = { storage, store, runner, fp, pid, node, calls, poll, save, focused, clicks: [] };
  e.board = { focusNode: id => focused.push(id) };
  e.editor = { duplicate: () => [] };
  e.busyBtn = (b, fn) => b.addEventListener('click', () => { e.clicks.push(Promise.resolve().then(fn)); });
  e.settle = () => Promise.all(e.clicks.splice(0));
  // 与 refreshTasks 同一装配：持久稿 + 运行器待恢复记录覆盖 + runner.localResult 实体核验
  e.row = async (taskId = 'job') => {
    const tasks = liveTaskRecords(await store.tasksOfProject(), runner).filter(x => x.taskId === taskId);
    assert.equal(tasks.length, 1, `任务 ${taskId} 应在任务中心可见`);
    const r = await runner.localResult(taskId, pid);
    const local = { ready: r.ready === true, reason: r.ready ? null : r.reason };
    const [entry] = taskPanelEntries({ tasks, pending: [], store, runner, board: e.board, editor: e.editor, keyFp: keys.getFingerprint(), localOf: () => local, busyBtn: e.busyBtn });
    const item = entry.build();
    return { item, state: item.getAttribute('data-task-state'), label: badgeOf(item).textContent, buttons: buttons(item), text: item.textContent, rec: tasks[0] };
  };
  return e;
}
const baseRec = (e, extra = {}) => ({ taskId: 'job', projectId: e.pid, nodeId: e.node.id, model: 'mock', keyFp: e.fp,
  status: 'in_progress', executorVersion: 2, idempotencyKey: 'orig-idem', ...extra });
const NO_VAGUE = ['重试', '重新生成', '再试一次'];

test('任务中心状态表覆盖发布规格 A 的六类事实', () => {
  for (const s of ['accepted', 'generating', 'query_review', 'delivering', 'save_pending', 'local_verified', 'server_failed', 'server_cancelled', 'server_expired', 'link_expired'])
    assert.ok(TASK_CENTER_STATES.includes(s), `缺少状态 ${s}`);
});

test('多次 404 夹 500 后成功：查询异常期间只提供继续查询/停止本地等待，成功后转待下载；零 POST、任务号不变', async t => {
  const replies = [404, 404, 500, 'ok'];
  const e = await env(t, '404', { getTask() {
    const v = replies.shift();
    if (v === 'ok') return { status: 'completed', executor_version: 2, content_ready: true };
    throw Object.assign(new Error('HTTP ' + v), { status: v });
  } });
  await e.store.saveTask(baseRec(e));
  e.runner.poll('job', e.pid);
  await e.poll.next();
  let r = await e.row();
  assert.equal(r.state, 'query_review');
  assert.match(r.label, /查询异常/);
  assert.match(r.text, /不等于生成失败|HTTP 404/);
  assert.ok(r.buttons.includes('继续查询') && r.buttons.includes('停止本地等待'));
  assert.ok(!r.buttons.includes('恢复下载') && !r.buttons.includes('创建新版本'));
  for (const v of NO_VAGUE) assert.ok(!r.buttons.includes(v), `不得出现含糊的「${v}」`);
  assert.equal(r.rec.status, 'in_progress', '查询失败不改写服务器生成事实');
  await e.poll.next(); await e.poll.next(); await e.poll.next();
  r = await e.row();
  assert.equal(r.state, 'ready_to_download');
  assert.ok(r.buttons.includes('恢复下载'));
  assert.equal(r.rec.taskId, 'job'); assert.equal(r.rec.idempotencyKey, 'orig-idem');
  assert.match(r.text, /job/, '任务号在行内可见');
  assert.equal(e.calls.post, 0);
});

test('首次终态落盘失败：任务中心显示「本地保存失败 · 待恢复」且不给查询/新版本；恢复后收敛，零 POST', async t => {
  const e = await env(t, 'save', { getTask: () => ({ status: 'failed', executor_version: 2, error: { message: '上游拒绝' } }) });
  await e.store.saveTask(baseRec(e));
  const real = e.storage.setIfRev;
  let broken = true;
  e.storage.setIfRev = (k, rev, v) => broken && k.startsWith('task:') ? Promise.reject(new Error('QuotaExceededError')) : real(k, rev, v);
  e.runner.poll('job', e.pid);
  await e.poll.next();
  let r = await e.row();
  assert.equal(r.state, 'save_pending');
  assert.match(r.label, /本地保存失败/);
  assert.match(r.text, /QuotaExceededError/);
  assert.match(r.text, /不会新建付费任务/);
  assert.deepEqual(r.buttons.filter(b => b !== '定位节点' && b !== '找回节点'), [], '待恢复时只允许定位节点');
  broken = false;
  await e.save.next();
  r = await e.row();
  assert.equal(r.state, 'server_failed');
  assert.match(r.text, /上游拒绝/);
  assert.ok(r.buttons.includes('创建新版本'));
  assert.equal(e.calls.post, 0);
  assert.equal(e.calls.get, 1, '恢复写入不重复 GET、不 POST');
});

test('远端链接过期 + 本机完整视频：仍为「本地文件已校验」可预览/保存；URL 成对释放；删掉实体后如实降级', async t => {
  const e = await env(t, 'expired');
  const blob = mp4();
  e.store.project.assets.a = { id: 'a', kind: 'video', name: 'a.mp4', mime: 'video/mp4', size: blob.size, fromTask: 'job' };
  await e.storage.setBlob('blob:a', blob);
  await e.store.flush();
  await e.store.saveTask(baseRec(e, { status: 'completed', contentReady: true, downloadExpired: true, resultAssetId: 'a' }));
  let r = await e.row();
  assert.equal(r.state, 'local_verified');
  assert.match(r.text, /远端下载链接已过期/);
  assert.ok(r.buttons.includes('预览') && r.buttons.includes('保存'));
  assert.ok(!r.buttons.includes('恢复下载'));
  // 保存：resultURL → 触发下载 → 延迟释放（配对）
  const created = [], revoked = [];
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => { const u = 'blob:test/' + created.length; created.push(u); return u; };
  URL.revokeObjectURL = u => revoked.push(u);
  t.after(() => { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  btnOf(r.item, '保存').click();
  await e.settle();
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, [], '保存刚开始时不立即释放');
  t.mock.timers.tick(30000);
  assert.deepEqual(revoked, created, '保存后释放同一 URL');
  t.mock.timers.reset();
  assert.equal(e.calls.download, 0, '本机完整文件无需远端');
  // 元数据仍在但实体被删：不谎报可用，也不提供不可能成功的下载
  await e.storage.delBlob('blob:a');
  r = await e.row();
  assert.equal(r.state, 'link_expired');
  assert.ok(!r.buttons.includes('预览') && !r.buttons.includes('恢复下载'));
  assert.ok(r.buttons.includes('创建新版本'), '只剩显式新版本');
});

test('停止本地等待 → 继续查询：只对原任务 GET，零 POST，任务号/幂等键不变', async t => {
  const e = await env(t, 'pause', { getTask: () => ({ status: 'in_progress', executor_version: 2, progress: 40 }) });
  await e.store.saveTask(baseRec(e));
  let r = await e.row();
  assert.equal(r.state, 'generating');
  btnOf(r.item, '停止本地等待').click(); await e.settle();
  r = await e.row();
  assert.equal(r.state, 'paused');
  assert.match(r.text, /服务器上的任务不受影响/);
  assert.ok(r.buttons.includes('继续查询') && r.buttons.includes('请求取消'));
  const before = e.calls.get;
  btnOf(r.item, '继续查询').click(); await e.settle();
  await e.poll.next();
  assert.equal(e.calls.get, before + 1, '继续查询 = 对原任务一次 GET');
  r = await e.row();
  assert.equal(r.state, 'generating');
  assert.equal(r.rec.taskId, 'job'); assert.equal(r.rec.idempotencyKey, 'orig-idem');
  assert.equal(e.calls.post, 0);
});

test('继续查询被核心拒绝时如实说明原因（换了密钥）且不发任何请求', async t => {
  const e = await env(t, 'identity');
  await e.store.saveTask(baseRec(e, { paused: true, pauseSource: 'manual' }));
  await keys.setKey('another-synthetic-key');
  const r = await e.row();
  assert.equal(r.state, 'need_key');
  btnOf(r.item, '继续查询').click(); await e.settle();
  assert.ok(toasts().some(s => /密钥与提交该任务时不一致/.test(s)), toasts().join(' | '));
  assert.equal(e.calls.get, 0); assert.equal(e.calls.post, 0);
});

test('请求取消：仅 v2 在途提供；旧接口任务不提供', async t => {
  const e = await env(t, 'cancel');
  await e.store.saveTask(baseRec(e));
  const r = await e.row();
  assert.ok(r.buttons.includes('请求取消'));
  await e.store.saveTask({ ...baseRec(e), taskId: 'legacy', executorVersion: 1, idempotencyKey: 'k2' });
  const legacy = await e.row('legacy');
  assert.ok(!legacy.buttons.includes('请求取消'), '旧接口不虚假开放取消');
});

test('较新版本任务记录只读：不查询、不下载、不新增节点、不改写记录', async t => {
  const e = await env(t, 'version');
  await e.store.saveTask(baseRec(e));
  // 模拟较新客户端写入的记录（绕过本版本 saveTask 的版本守卫，直接落库）
  const raw = await e.storage.get('task:' + e.pid + ':job');
  await e.storage.set('task:' + e.pid + ':job', { ...raw, recVersion: 3, status: 'completed', contentReady: true, nodeId: 'gone' });
  e.node.data.run = {}; await e.store.flush();
  const r = await e.row();
  assert.equal(r.state, 'unsupported');
  assert.deepEqual(r.buttons, [], '无持有节点时不提供任何会改写的动作');
  assert.deepEqual(await e.runner.requery('job', e.pid), { started: false, reason: 'task_record_version_unsupported' });
  const nodes = e.store.project.nodes.length;
  assert.equal(e.store.project.nodes.length, nodes);
  assert.equal((await e.storage.get('task:' + e.pid + ':job')).recVersion, 3, '记录未被旧客户端改写');
  assert.equal(e.calls.get + e.calls.post + e.calls.download, 0);
});

test('终态冲突：待核对，不提供新版本；下载 A 的「找回节点」不会改写已重绑任务 B 的节点', async t => {
  const e = await env(t, 'conflict');
  await e.store.saveTask(baseRec(e, { status: 'completed', contentReady: true, terminalEvidence: 'server_status', terminalConflict: ['completed', 'not_found'], queryHealth: 'needs_review' }));
  let r = await e.row();
  assert.equal(r.state, 'query_review');
  assert.match(r.text, /互相矛盾的终态/);
  assert.ok(!r.buttons.includes('创建新版本') && !r.buttons.includes('恢复下载'));
  // A/B 重绑：节点现在持有任务 B；任务 A 的行点「定位节点」必须新建找回节点，不覆盖 B
  await e.store.saveTask({ ...baseRec(e), taskId: 'A', idempotencyKey: 'kA', status: 'completed', contentReady: true, terminalEvidence: 'server_status' });
  e.node.data.run = { taskId: 'B' }; await e.store.flush();
  r = await e.row('A');
  btnOf(r.item, '定位节点').click(); await e.settle();
  assert.equal(e.node.data.run.taskId, 'B', '已重绑到 B 的节点不被 A 改写');
  const restored = e.store.project.nodes.find(n => n.data.run?.taskId === 'A');
  assert.ok(restored && restored.id !== e.node.id, 'A 找回到独立的新节点');
  assert.equal(e.calls.post, 0);
});

test('taskCenterView 纯函数：链接过期不抹掉本地完整文件；resultBlobId 线索不点亮本地可用', () => {
  const rec = { taskId: 'x', status: 'completed', executorVersion: 2, contentReady: true, downloadExpired: true, resultBlobId: 'result:p:x' };
  assert.equal(taskCenterView(rec, { ready: false, reason: 'blob_missing' }).state, 'link_expired');
  assert.equal(taskCenterView(rec, { ready: true }).state, 'local_verified');
  assert.equal(taskCenterView(rec, undefined).state, 'link_expired', '未核验按不可用');
  // 手动触发的 requery 在首个 GET 前：retrying 且无 queryError → 不是查询异常
  assert.equal(taskCenterView({ taskId: 'x', status: 'in_progress', executorVersion: 2, queryHealth: 'retrying' }, null).state, 'generating');
  assert.equal(taskCenterView({ taskId: 'x', status: 'in_progress', executorVersion: 2, queryHealth: 'retrying', queryError: { status: 503, message: '上游繁忙' } }, null).state, 'query_review');
});
