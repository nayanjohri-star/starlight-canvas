import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createTaskRunner } from '../src/gennode.js';
import { isFinalFailure, canFetchContent, taskPhase } from '../src/task-status.js';
import * as keys from '../src/keyvault.js';

function scheduler() {
  const jobs = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { const n = ++id; jobs.set(n, { fn, ms }); return n; },
    clearTimeout(n) { jobs.delete(n); },
    async next() {
      const first = [...jobs].sort((a, b) => a[1].ms - b[1].ms || a[0] - b[0])[0];
      if (!first) throw new Error('没有待执行定时器');
      jobs.delete(first[0]); await first[1].fn(); return first[1].ms;
    },
    count() { return jobs.size; },
  };
}
const noAssets = { remoteValid: () => true, blobOf: async () => null };
const video = () => new Blob([new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112, 0, 0, 0, 0])], { type: 'video/mp4' });
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} }),
};

async function fixture(t, suffix) {
  const storage = createMemoryStorage(), store = createStore(storage);
  await store.newProject('r05-' + suffix);
  await keys.setKey('mock-r05-' + suffix);
  const fp = keys.getFingerprint(), pid = store.project.id;
  const node = store.addNode('gen', 0, 0, { draft: { model: 'mock' }, run: { taskId: 'job' } });
  await store.flush();
  t.after(() => keys.clearKey());
  return { storage, store, fp, pid, node };
}

test('多次 404、夹杂 500、成功和 200 明确不存在均只按证据改变状态，零 POST', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'query');
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'in_progress', executorVersion: 2, idempotencyKey: 'original-key' });
  const replies = [404, 404, 500, 404, 404, 404, 404, 200, 'absent'];
  let posts = 0;
  const api = {
    async getTask() {
      const value = replies.shift();
      if (value === 200) return { status: 'completed', executor_version: 2, content_ready: true };
      if (value === 'absent') return { status: 'not_found', executor_version: 2 };
      throw Object.assign(new Error('query ' + value), { status: value });
    },
    async createTask() { posts++; throw new Error('不得生成'); },
  };
  const clock = scheduler();
  const runner = createTaskRunner({ store, storage, api, assets: noAssets, pollScheduler: clock });
  runner.poll('job', pid);
  for (let i = 0; i < 7; i++) await clock.next();
  let rec = await store.task('job');
  assert.equal(rec.status, 'in_progress');
  assert.equal(rec.notFoundPolls, 4, '500 重置连续 404 计数');
  assert.equal(rec.idempotencyKey, 'original-key');
  await clock.next();
  rec = await store.task('job');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.notFoundPolls, 0);
  assert.equal(rec.terminalEvidence, 'server_status');
  assert.equal(posts, 0);
  const started = await runner.requery('job', pid);
  assert.equal(started.started, true);
  await clock.next();
  rec = await store.task('job');
  assert.equal(rec.status, 'completed', '互斥终态没有可靠服务器顺序时保留已落盘事实');
  assert.deepEqual(rec.terminalConflict, ['completed', 'not_found']);
  assert.equal(isFinalFailure(rec), false, '冲突进入人工核对，不让工作流当确定失败');
  assert.equal(posts, 0);
});

test('200 响应明确报告任务不存在时，原在途任务才可进入有证据的终态', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'absent');
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock', keyFp: fp, status: 'in_progress' });
  const clock = scheduler();
  const runner = createTaskRunner({ store, storage, assets: noAssets, pollScheduler: clock,
    api: { async getTask() { return { status: 'not_found', executor_version: 2 }; } } });
  runner.poll('job', pid);
  await clock.next();
  const rec = await store.task('job');
  assert.equal(rec.status, 'not_found');
  assert.equal(rec.terminalEvidence, 'server_status');
  assert.equal(isFinalFailure(rec), true);
});

test('旧 not_found 无证据重开后可重新查询；HTTP 410 保留已知生成状态', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'reopen');
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'not_found', executorVersion: 2, idempotencyKey: 'same-key' });
  const second = createStore(storage); await second.openProject(pid);
  const clock = scheduler();
  let gets = 0;
  const runner = createTaskRunner({ store: second, storage, assets: noAssets, pollScheduler: clock, api: {
    async getTask() { gets++; if (gets === 1) throw Object.assign(new Error('gone'), { status: 410 }); return { status: 'completed', content_ready: true, executor_version: 2 }; },
    async createTask() { throw new Error('不得生成'); },
  } });
  await runner.resumeAll();
  await clock.next();
  let rec = await second.task('job');
  assert.equal(rec.status, 'not_found', '旧记录保留，410 不再伪造另一生成终态');
  assert.equal(rec.queryHealth, 'needs_review');
  assert.equal(isFinalFailure(rec), false);
  await runner.requery('job', pid);
  await clock.next();
  rec = await second.task('job');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.idempotencyKey, 'same-key');
  assert.equal(gets, 2);
});

test('连续超过四次 CAS 冲突与缺少原子能力都拒绝覆盖，保留调用方待处理记录', async t => {
  const { storage, store, pid, fp } = await fixture(t, 'cas');
  const base = { taskId: 'cas', projectId: pid, model: 'mock', keyFp: fp, status: 'in_progress' };
  await store.saveTask(base);
  let attempts = 0;
  const real = storage.setIfRev;
  storage.setIfRev = (key, rev, value) => {
    if (key.startsWith('task:')) { attempts++; return Promise.resolve({ ok: false, storedRev: rev }); }
    return real(key, rev, value);
  };
  const pending = { ...base, status: 'completed' };
  await assert.rejects(store.saveTask(pending), e => e.code === 'task_write_conflict');
  assert.equal(attempts, 4);
  assert.equal((await store.task('cas')).status, 'in_progress');
  assert.equal(pending.status, 'completed', '失败后待处理内容仍在调用方内存');
  storage.setIfRev = undefined;
  await assert.rejects(store.saveTask(pending), e => e.code === 'task_atomic_unavailable');
  assert.equal((await store.task('cas')).status, 'in_progress');
});

test('首次终态保存失败后内存待恢复，存储恢复只重写原任务且不新增 POST', async t => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const { storage, store, fp, pid, node } = await fixture(t, 'save-' + status);
    await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock', keyFp: fp, status: 'in_progress' });
    const real = storage.setIfRev;
    let broken = true, posts = 0, gets = 0;
    storage.setIfRev = (key, rev, value) => broken && key.startsWith('task:')
      ? Promise.reject(new Error('disk full')) : real(key, rev, value);
    const pollClock = scheduler(), saveClock = scheduler();
    const runner = createTaskRunner({ store, storage, assets: noAssets, pollScheduler: pollClock, saveScheduler: saveClock, api: {
      async getTask() { gets++; return { status, content_ready: status === 'completed', executor_version: 2 }; },
      async createTask() { posts++; throw new Error('不得生成'); },
    } });
    runner.poll('job', pid);
    await pollClock.next();
    assert.equal((await runner.recOf('job', pid)).localSaveState, 'pending');
    assert.equal((await store.task('job')).status, 'in_progress');
    assert.equal(saveClock.count(), 1);
    broken = false;
    await saveClock.next();
    assert.equal((await store.task('job')).status, status);
    assert.equal((await runner.recOf('job', pid)).localSaveState, 'saved');
    assert.equal(gets, 1);
    assert.equal(posts, 0);
  }
});

test('远端过期但本地成片完整可用；元数据有而文件缺失不谎报可用', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'local');
  const blob = video();
  store.project.assets.a = { id: 'a', kind: 'video', name: 'a.mp4', mime: 'video/mp4',
    size: blob.size, fromTask: 'job' };
  node.data.resultAssetId = 'a';
  await storage.setBlob('blob:a', blob);
  await store.flush();
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true,
    downloadExpired: true, resultAssetId: 'a' });
  let downloads = 0;
  const runner = createTaskRunner({ store, storage, assets: noAssets, api: {
    async downloadContent() { downloads++; throw new Error('远端不应访问'); },
  } });
  assert.equal((await runner.localResult('job', pid)).ready, true);
  assert.equal(await runner.download('job'), true);
  assert.equal(downloads, 0);
  await storage.delBlob('blob:a');
  assert.equal((await runner.localResult('job', pid)).ready, false);
  assert.equal(await runner.download('job'), null);
  assert.equal(downloads, 0);
});

test('旧任务 A 的结果下载不会写到已重绑任务 B 的节点', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'ownership');
  const blob = video();
  store.project.assets.a = { id: 'a', kind: 'video', name: 'a.mp4', mime: 'video/mp4',
    size: blob.size, fromTask: 'A' };
  node.data.run = { taskId: 'B' };
  await storage.setBlob('blob:a', blob);
  await store.flush();
  await store.saveTask({ taskId: 'A', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true, resultAssetId: 'a' });
  const runner = createTaskRunner({ store, storage, assets: noAssets, api: {
    async downloadContent() { throw new Error('本地成片不应访问远端'); },
  } });
  assert.equal(await runner.download('A'), true);
  assert.equal(node.data.run.taskId, 'B');
  assert.equal(node.data.resultAssetId, undefined);
  assert.equal((await storage.get('project:' + pid)).nodes.find(n => n.id === node.id).data.resultAssetId, undefined);
});

test('跨标签暂停/脱离由新持久稿持有；晚到的旧 GET 不能回退已确认终态', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'tabs');
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'in_progress', executorVersion: 2 });
  const other = createStore(storage); await other.openProject(pid);
  const clock = scheduler();
  let firstResolve, gets = 0;
  const runner = createTaskRunner({ store, storage, assets: noAssets, pollScheduler: clock, api: {
    async getTask() {
      gets++;
      if (gets === 1) return new Promise(resolve => { firstResolve = resolve; });
      return { status: 'completed', executor_version: 2, content_ready: true, progress: 100 };
    },
  } });
  await runner.recOf('job', pid); // 独立缓存，不与另一 store 共享对象引用
  const changed = await other.task('job');
  changed.detached = true;
  await other.saveTask(changed, { fields: ['detached'] });
  runner.poll('job', pid);
  const oldRequest = clock.next();
  await Promise.resolve(); await Promise.resolve();
  const explicit = await runner.requery('job', pid);
  assert.equal(explicit.started, true);
  await clock.next();
  firstResolve({ status: 'in_progress', executor_version: 2, progress: 10 });
  await oldRequest;
  const saved = await store.task('job');
  assert.equal(saved.status, 'completed');
  assert.equal(saved.progress, 100);
  assert.equal(saved.detached, true, '查询字段写入不得覆盖另一标签页的脱离意图');
});

test('工程包只有重映射后的素材 blob 时仍可找回原任务成片；未知记录版本拒绝导入', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'import');
  const blob = video();
  store.project.assets.old = { id: 'old', kind: 'video', name: 'old.mp4', mime: 'video/mp4',
    size: blob.size, fromTask: 'job' };
  node.data.resultAssetId = 'old';
  await store.flush();
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true,
    resultAssetId: 'old', resultBlobId: 'result:' + pid + ':job' });
  const json = await store.exportJSON();
  const invalid = JSON.parse(json);
  invalid.tasks[0].recVersion = 99;
  await assert.rejects(store.importJSON(JSON.stringify(invalid)), /版本未知/);
  assert.equal(store.project.id, pid, '失败导入保留原工程');
  const project = await store.importJSON(json, { assetBlobs: new Map([['old', blob]]) });
  const imported = await store.task('job');
  assert.equal(imported.resultBlobId, null, '工程包不会沿用原结果 blob 键');
  const runner = createTaskRunner({ store, storage, assets: noAssets, api: {} });
  const local = await runner.localResult('job', project.id);
  assert.equal(local.ready, true);
  assert.equal(local.source, 'asset');
  assert.equal(local.assetId, imported.resultAssetId);
});

test('旧任务暂停来源不明时重开仍暂停，换钥也不改成可自动恢复；显式查询只 GET', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'legacy-pause');
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'in_progress', paused: true, idempotencyKey: 'original-key' });
  const reopened = createStore(storage); await reopened.openProject(pid);
  const clock = scheduler(); let gets = 0, posts = 0;
  const runner = createTaskRunner({ store: reopened, storage, assets: noAssets, pollScheduler: clock, api: {
    async getTask() { gets++; return { status: 'in_progress' }; },
    async createTask() { posts++; throw new Error('不得生成'); },
  } });
  await keys.setKey('different-key');
  await runner.resumeAll();
  assert.equal(clock.count(), 0);
  assert.equal((await reopened.task('job')).pauseSource, undefined);
  await keys.setKey('mock-r05-legacy-pause');
  await runner.resumeAll();
  assert.equal(clock.count(), 0);
  assert.equal((await runner.requery('job', pid)).started, true);
  await clock.next();
  assert.equal(gets, 1);
  assert.equal(posts, 0);
});

test('外任务结果键与大小不符的素材实体不能冒充本任务本地成片', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'blob-identity');
  const blob = video();
  await storage.setBlob('result:' + pid + ':other', blob);
  store.project.assets.a = { id: 'a', kind: 'video', mime: 'video/mp4',
    size: blob.size + 1, fromTask: 'job' };
  await storage.setBlob('blob:a', blob);
  await store.flush();
  await store.saveTask({ taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'completed', executorVersion: 2, contentReady: true,
    downloadExpired: true, resultAssetId: 'a', resultBlobId: 'result:' + pid + ':other' });
  const runner = createTaskRunner({ store, storage, assets: noAssets, api: {} });
  assert.equal((await runner.localResult('job', pid)).ready, false);
  assert.equal(await runner.download('job'), null);
});

test('本机较新任务记录版本只读待核对，脱离标记不能解除原节点的付费保护', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'future-record');
  node.data.run = null; await store.flush();
  const future = { taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'completed', contentReady: true, detached: true, recVersion: 99, rev: 1 };
  await storage.set('task:' + pid + ':job', future);
  await assert.rejects(store.saveTask({ ...future, recVersion: 2 }),
    e => e.code === 'task_record_version_unsupported');
  assert.equal((await store.task('job')).recVersion, 99);
  assert.equal(canFetchContent(future), false);
  assert.equal(taskPhase(future), 'reconciling');
  const runner = createTaskRunner({ store, storage, assets: noAssets, api: {} });
  assert.deepEqual(await runner.requery('job', pid), { started: false, reason: 'task_record_version_unsupported' });
  assert.equal((await runner.localResult('job', pid)).ready, false);
  assert.equal(await runner.adoptDurable(node), true);
  assert.equal(node.data.run.taskId, 'job');
});

test('较新版本任务恢复在任何节点或 pending 副作用前拒绝', async t => {
  const { storage, store, fp, pid, node } = await fixture(t, 'future-restore');
  store.project.nodes = []; await store.flush();
  await storage.set('task:' + pid + ':job', { taskId: 'job', projectId: pid, nodeId: node.id,
    model: 'mock', keyFp: fp, status: 'in_progress', idempotencyKey: 'same-key', recVersion: 3, rev: 1 });
  await store.savePendingCreate({ projectId: pid, nodeId: node.id, idempotencyKey: 'same-key', state: 'uncertain' });
  let gets = 0, posts = 0;
  const runner = createTaskRunner({ store, storage, assets: noAssets, api: {
    async getTask() { gets++; return {}; }, async createTask() { posts++; return {}; },
  } });
  assert.equal(await runner.restoreTask('job', pid), null);
  assert.equal(await runner.restorePending('same-key', pid), null);
  assert.equal(store.project.nodes.length, 0);
  assert.equal((await storage.get('task:' + pid + ':job')).recVersion, 3);
  assert.ok(await store.pendingCreateIn(pid, 'same-key'), '不清除较新任务关联的待核对提交');
  assert.equal(gets + posts, 0);
});

test('0.4.4 无版本任务以新项目导入，原工程保留供回退且旧未核对状态不放行新生成', async t => {
  const { storage, store, pid, fp, node } = await fixture(t, 'upgrade-copy');
  const legacy = { taskId: 'job', projectId: pid, nodeId: node.id, model: 'mock',
    keyFp: fp, status: 'not_found', idempotencyKey: 'legacy-key',
    bodyString: JSON.stringify({ model: 'mock', prompt: '原请求', seconds: 5 }) };
  await storage.set('task:' + pid + ':job', { ...legacy, rev: 1 });
  const oldProject = pid, oldRecord = await store.task('job');
  const json = await store.exportJSON();
  const importedProject = await store.importJSON(json);
  const importedRecord = await store.task('job');
  assert.notEqual(importedProject.id, oldProject);
  assert.equal(importedRecord.taskId, 'job');
  assert.equal(importedRecord.idempotencyKey, 'legacy-key');
  assert.equal(importedRecord.bodyString, legacy.bodyString);
  assert.equal(importedRecord.status, 'not_found');
  assert.equal(isFinalFailure(importedRecord), false);
  await store.openProject(oldProject);
  assert.deepEqual(await store.task('job'), oldRecord, '导入没有迁移或覆盖原工程记录');
});
