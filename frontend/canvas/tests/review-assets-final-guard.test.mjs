// review-assets-final-guard：素材删除/重绑的终审并发守卫。
//  · FG-01 删除期间切项目 + 外部推进旧稿 → 落盘只合并素材删除/引用/合集变化，
//    外部新节点/新素材/改名全部保留（不整篇盲写覆盖）
//  · FG-02 合并落盘失败 → 如实返回 false 不假报成功；存储稿原样保留，重新打开后可重试
//  · FG-03 rebindFile 调用即捕获 project+asset 身份：排队期间切项目，轮到执行时
//    明确拒绝——绝不绑到另一项目的同名素材、不写共享 blob 键
//  · FG-04 素材彻底删除后在队重绑 → 拒绝执行：不复活记录、不留孤儿 blob
// node 可跑：不发真实请求；toast/DOM 用最小桩承接。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { setCapabilities } from '../src/capabilities.js';
import { createAssets } from '../src/assets.js';

class StubEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; }
  set className(v) { this._c = v; } get className() { return this._c; }
  set textContent(v) { this._t = v; } get textContent() { return this._t; }
  setAttribute(k, v) { (this._a ??= {})[k] = v; }
  addEventListener() {}
  append(...c) { this.children.push(...c); }
  prepend(...c) { this.children.unshift(...c); }
  replaceChildren(...c) { this.children = c; }
  remove() {}
}
globalThis.document ??= {
  getElementById: id => (id === 'toast-root' ? new StubEl('div') : null),
  createElement: t => new StubEl(t),
  addEventListener() {}, removeEventListener() {}, body: new StubEl('body'),
};

setCapabilities({
  models: {},
  upload_limits: { image: { content_types: ['image/png'], max_mib: 8 } },
});

const file = (name, type, size = 64) => Object.assign(new Blob([new Uint8Array(size)], { type }), { name });
const tick = () => new Promise(r => setTimeout(r, 0));

async function boot() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('P1');
  const assets = createAssets({ store, storage, api: { uploadAsset: async () => { throw new Error('未接入'); } } });
  return { store, storage, assets };
}

test('FG-01：删除落盘合并——外部新增节点/素材/改名全部保留，只移除目标素材', async () => {
  const { store, storage, assets } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png', 32), 'a.png', 'image');
  const keep = await assets.registerBlob(file('keep.png', 'image/png', 16), 'keep.png', 'image');
  const pid = store.project.id;
  await store.flush();
  const del = storage.delBlob.bind(storage);
  storage.delBlob = async k => {
    await del(k);
    await store.newProject('P2');
    const latest = await storage.get(`project:${pid}`);
    latest.name = '外部改名';
    latest.nodes.push({ id: 'external-draft', type: 'note', x: 1, y: 1, data: { text: '他人的新稿' } });
    latest.assets['a_external'] = { id: 'a_external', name: 'ext.png', kind: 'image', mime: 'image/png', size: 8, addedAt: 1 };
    latest.rev++;
    await storage.set(`project:${pid}`, latest);
  };
  assert.equal(await assets.removeAsset(a.id), true);
  const saved = await storage.get(`project:${pid}`);
  assert.equal(saved.name, '外部改名', '合并不得覆盖外部改名');
  assert.ok(saved.nodes.some(n => n.id === 'external-draft'), '外部新节点不得被覆盖');
  assert.ok(saved.assets['a_external'], '外部新素材不得被覆盖');
  assert.ok(saved.assets[keep.id], '同项目其他素材保留');
  assert.equal(saved.assets[a.id], undefined, '目标素材记录已删除');
  assert.equal(store.project.name, 'P2');
  await store.flush();
});

test('FG-02：合并落盘失败→如实返回 false，存储稿保留，重新打开后可重试', async () => {
  const { store, storage, assets } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png', 32), 'a.png', 'image');
  const pid = store.project.id;
  await store.flush();
  const del = storage.delBlob.bind(storage);
  const origGet = storage.get.bind(storage);
  storage.delBlob = async k => {
    await del(k);
    await store.newProject('P2');
    const latest = await storage.get(`project:${pid}`);
    latest.nodes.push({ id: 'external-draft', type: 'note', x: 1, y: 1, data: { text: '他人的新稿' } });
    latest.rev++;
    await storage.set(`project:${pid}`, latest);
    storage.get = async key => {
      if (key === `project:${pid}`) throw new Error('IDB 读取故障');
      return origGet(key);
    };
  };
  assert.equal(await assets.removeAsset(a.id), false, '合并保存失败不得假报成功');
  storage.delBlob = del;
  storage.get = origGet;
  const saved = await storage.get(`project:${pid}`);
  assert.ok(saved.nodes.some(n => n.id === 'external-draft'), '外部新稿不受影响');
  assert.ok(saved.assets[a.id], '合并失败时素材记录保留在存储稿中');
  await store.openProject(pid);
  assert.equal(await assets.removeAsset(a.id), true, '存储恢复后重试删除成功');
  await store.flush();
  const after = await storage.get(`project:${pid}`);
  assert.equal(after.assets[a.id], undefined);
  assert.ok(after.nodes.some(n => n.id === 'external-draft'), '重试删除仍不覆盖外部新节点');
});

test('FG-03：rebindFile 调用即捕获身份——排队期间切项目，轮到执行时明确拒绝', async () => {
  const { store, storage, assets } = await boot();
  const a = await assets.registerBlob(file('old.png', 'image/png', 32), 'old.png', 'image');
  const pid1 = store.project.id;
  await store.flush();
  let release;
  const gate = new Promise(r => release = r);
  const origGetBlob = storage.getBlob.bind(storage);
  let gated = false;
  storage.getBlob = async k => { if (!gated) { gated = true; await gate; } return origGetBlob(k); };
  const r1 = assets.rebindFile(a.id, file('r1.png', 'image/png', 48));
  const r2 = assets.rebindFile(a.id, file('r2.png', 'image/png', 64));   // r1 在飞时排队
  await tick();                                                        // r1 进入 blobOf 等待 gate
  await store.newProject('P2');
  // 旧项目存储稿撤掉该素材（共享检查不拦截），新项目放同名 assetId 素材
  const doc1 = await storage.get(`project:${pid1}`);
  delete doc1.assets[a.id]; doc1.rev++;
  await storage.set(`project:${pid1}`, doc1);
  store.project.assets[a.id] = { id: a.id, name: 'B素材.png', kind: 'image', mime: 'image/png', size: 10, addedAt: 1, remote: null };
  release();
  assert.equal(await r1, null, '在飞重绑在项目切换后作废');
  assert.equal(await r2, null, '排队重绑必须按调用时身份拒绝，不得绑到新项目同名素材');
  storage.getBlob = origGetBlob;
  assert.equal(store.project.assets[a.id].size, 10, '新项目素材记录未被改写');
  assert.equal((await storage.getBlob(`blob:${a.id}`)).size, 32, '共享 blob 键未被写入');
});

test('FG-04：素材彻底删除后在队重绑→拒绝执行，不复活记录、不留孤儿 blob', async () => {
  const { store, storage, assets } = await boot();
  const a = await assets.registerBlob(file('old.png', 'image/png', 32), 'old.png', 'image');
  let release;
  const gate = new Promise(r => release = r);
  const origGetBlob = storage.getBlob.bind(storage);
  let gated = false;
  storage.getBlob = async k => { if (!gated) { gated = true; await gate; } return origGetBlob(k); };
  const r1 = assets.rebindFile(a.id, file('r1.png', 'image/png', 48));
  const r2 = assets.rebindFile(a.id, file('r2.png', 'image/png', 64));   // 在删除前已排队
  await tick();
  assert.equal(await assets.removeAsset(a.id), true, '无引用素材删除成功');   // r1 仍在 gate
  release();
  assert.equal(await r1, null);
  assert.equal(await r2, null, '删除后在队重绑不得执行');
  storage.getBlob = origGetBlob;
  assert.equal(store.project.assets[a.id], undefined, '记录不被重绑复活');
  assert.equal(await storage.getBlob(`blob:${a.id}`), undefined, '不留孤儿 blob');
});
