// 任务恢复回归：项目切换/重开后 resumeAll 恢复在途任务轮询（全内存 fake，无网络）。
// 对应缺陷：afterProjectSwitch 只刷新视图不调用 resumeAll，切回项目后在途任务 GET 永不恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createTaskRunner } from '../src/gennode.js';
import { setKey, getFingerprint, clearKey } from '../src/keyvault.js';

function fakeApi() {
  const gets = [], posts = [];
  return {
    gets, posts,
    getTask: async id => { gets.push(id); return { id, status: 'in_progress', progress: 50 }; },
    createVideo: async () => { posts.push(1); return { task_id: 'unexpected' }; },
    downloadContent: async () => { throw new Error('not used'); },
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('切回含在途任务的项目 → resumeAll 后自动恢复 GET 轮询，不产生新 POST', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const api = fakeApi();
  const runner = createTaskRunner({ store, storage, api, assets: {}, onUpdate() {} });
  await setKey('sk-resume-a');
  await store.newProject('A');
  const g = store.addNode('gen', 0, 0, { draft: { model: 'wan-3.0' } });
  const pidA = store.project.id;
  await store.saveTask({ taskId: 'taskA', projectId: pidA, nodeId: g.id, model: 'wan-3.0', status: 'queued', keyFp: getFingerprint() });
  // 新建 B 再切回 A（等同 afterProjectSwitch → resumeAll 路径）
  await store.newProject('B');
  assert.equal(api.gets.length, 0);
  await store.openProject(pidA);
  await runner.resumeAll();
  await sleep(1600);                                   // poll 首 tick 1.2s
  assert.ok(api.gets.length >= 1, '切回项目在途任务必须恢复 GET 轮询');
  assert.equal(api.posts.length, 0, '恢复轮询不得产生新 POST');
  assert.equal((await store.task('taskA')).status, 'in_progress');
});

test('终态任务与异密钥任务：resumeAll 不恢复轮询', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  const api = fakeApi();
  const runner = createTaskRunner({ store, storage, api, assets: {}, onUpdate() {} });
  await setKey('sk-resume-b');
  await store.newProject('C');
  const pid = store.project.id;
  await store.saveTask({ taskId: 'done1', projectId: pid, nodeId: 'x', model: 'wan-3.0', status: 'completed', keyFp: getFingerprint() });
  await store.saveTask({ taskId: 'other1', projectId: pid, nodeId: 'y', model: 'wan-3.0', status: 'queued', keyFp: 'other-key-fp' });
  await runner.resumeAll();
  await sleep(1600);
  assert.equal(api.gets.length, 0, '终态与异密钥任务不得轮询');
  assert.equal((await store.task('other1')).paused, true, '异密钥任务保持暂停');
  clearKey();
});
