// createRemoteWatch 单元测试（审查修复 WS-3）：watch 每拍重读当时项目/链接/密钥——
// 自己 push 不再误报「远端已更新」；切项目/换 key/关面板后，飞行中的旧拍不渲染、不写 presence。
// 全部注入替身：不触 DOM、不触网络、不触真实 storage。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteWatch } from '../src/workspace.js';

function harness() {
  const env = {
    project: { id: 'p1' },
    key: 'k1',
    links: { p1: { owner: 'u_1', id: 'wp_1', head: 1 } },
    remoteHead: 1,
    disposed: false,
    remoteGate: null,   // 设为 Promise 可把 checkRemote 卡在飞行中
    onRemote: null,     // checkRemote 飞行中回调（模拟链接被改写）
    dirtyHook: null,    // isDirty 执行中回调（模拟 key 变更）
    calls: { remote: [], beats: [], notices: [], peers: [] },
  };
  const watch = createRemoteWatch({
    alive: () => !env.disposed,
    getProjectId: () => env.project?.id ?? null,
    getLink: async pid => env.links[pid] ?? null,
    getKey: () => env.key,
    checkRemote: async l => {
      env.calls.remote.push(l.head);
      if (env.remoteGate) await env.remoteGate;
      await env.onRemote?.(l);
      return { changed: env.remoteHead !== l.head, head: env.remoteHead };
    },
    isDirty: async () => { await env.dirtyHook?.(); return true; },
    beat: async (l, editing) => {
      env.calls.beats.push({ id: l.id, head: l.head, editing, key: env.key });
      return { peers: [{ subject: 'u_2', clientId: 'c', editing: false }] };
    },
    onNotice: r => env.calls.notices.push(r),
    onPeers: list => env.calls.peers.push(list),
  });
  return { env, watch };
}

test('WS-3 每拍读当时链接：自己 push 后不再把自家修订误报成远端更新', async () => {
  const { env, watch } = harness();
  env.remoteHead = 2;                                        // 远端先到 r2，本地链接还停在 r1
  await watch.tick();
  assert.equal(env.calls.notices.length, 1);
  assert.equal(env.calls.notices[0].head, 2);
  env.links.p1 = { owner: 'u_1', id: 'wp_1', head: 2 };      // 自己推送成功：链接前进到 r2
  await watch.tick();
  assert.equal(env.calls.notices.length, 1);                 // 不再误报——旧实现闭包旧 head，每 15s 重复提醒
  assert.deepEqual(env.calls.remote, [1, 2]);                // 轮询始终用当时链接的 head
});

test('WS-3 轮询飞行中链接被改写 → 本拍作废，下一拍按新链接重新评估', async () => {
  const { env, watch } = harness();
  env.remoteHead = 3;
  env.onRemote = async () => { env.links.p1 = { owner: 'u_1', id: 'wp_1', head: 2 }; };   // 飞行中自己的 push 落盘
  await watch.tick();
  assert.equal(env.calls.notices.length, 0);                 // changed:true 的结果因链接已前进而作废
  await watch.tick();
  assert.equal(env.calls.notices.length, 1);                 // 下一拍用新链接评估，r3 仍是真实远端更新
  assert.equal(env.calls.notices[0].head, 3);
});

test('WS-3 切项目后：飞行中的旧拍不渲染，心跳跟随新项目的当时链接', async () => {
  const { env, watch } = harness();
  let release;
  env.remoteHead = 5;
  env.remoteGate = new Promise(r => { release = r; });
  const t = watch.tick();
  env.project = { id: 'p2' };                                // checkRemote 飞行中切项目
  env.links.p2 = { owner: 'u_1', id: 'wp_2', head: 7 };
  release();
  await t;
  assert.equal(env.calls.notices.length, 0);                 // 旧项目的提示不写进新项目
  await watch.tickPeers();
  assert.equal(env.calls.beats.at(-1).id, 'wp_2');           // 心跳按当时项目 + 当时链接写 presence
  assert.equal(env.calls.beats.at(-1).key, 'k1');
});

test('WS-3 换 key 后旧拍不写 presence；关面板/alive=false 后一切停止', async () => {
  const { env, watch } = harness();
  env.dirtyHook = async () => { env.key = 'k2'; };           // isDirty 期间密钥变更
  await watch.tickPeers();
  assert.equal(env.calls.beats.length, 0);                   // beat 前最后复核拦住旧 key 的 presence 写入
  assert.equal(env.calls.peers.length, 0);
  env.dirtyHook = null;
  env.disposed = true;                                       // 关闭面板
  await watch.tick();
  await watch.tickPeers();
  assert.equal(env.calls.remote.length, 0);
  assert.equal(env.calls.beats.length, 0);
});

test('WS-3 无链接/无密钥时轮询静默跳过；stop() 幂等', async () => {
  const { env, watch } = harness();
  delete env.links.p1;
  await watch.tick();
  env.links.p1 = { owner: 'u_1', id: 'wp_1', head: 1 };
  env.key = null;
  await watch.tick();
  await watch.tickPeers();
  assert.equal(env.calls.remote.length, 0);
  assert.equal(env.calls.beats.length, 0);
  env.key = 'k1';
  await watch.tickPeers();
  assert.equal(env.calls.beats.length, 1);
  watch.stop(); watch.stop();
  await watch.tickPeers();
  assert.equal(env.calls.beats.length, 1);
});
