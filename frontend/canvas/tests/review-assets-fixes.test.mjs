// review-assets-fixes：素材/工具/分镜的跨项目边界与输入安全回归。
// 覆盖：removeAsset 项目身份守卫（AST-01）、共享 assetId blob 保护与重绑阻止（AST-02）、
// 上传在飞×强制删除碰撞守卫、上传响应 origin 绑定（AST-03）、工具执行作用域与
// registerBlob scope（TLB-01）、json_parse 数字段/根数组/原型防护（TLB-02）、
// versions.fields 导入往返与缺字段明确错误（SB-01）、批量生成死链整批阻止与
// 异步错误反馈（SB-02）、编号与小数时长/区间区分（SB-03）、素材库「＋节点」视口
// 落点（UX-04）、assetIds null 槽位保留、AI 拆分不立即标过期。
// 本轮新增：同 size/mime 重绑使在飞上传作废（本地版本守卫）、rebindFile 与删除
// 交错清理、ensureRemote 同 id 跨项目不复用在飞上传、delBlob 失败不假报成功可重试、
// batchGenerate 未知所选 id / preview issues / 确认期间切项目或改关联整批中止。
// node 可跑：不发真实请求；toast/DOM 用最小桩承接。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { setCapabilities } from '../src/capabilities.js';
import { createAssets } from '../src/assets.js';
import { createTools } from '../src/tools.js';
import { createStoryboards } from '../src/storyboard.js';
import { assetSpawnPos } from '../src/library.js';

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
  upload_limits: {
    image: { content_types: ['image/png'], max_mib: 8 },
    video: { content_types: ['video/mp4'], max_mib: 50 },
    audio: { content_types: ['audio/mpeg'], max_mib: 10 },
  },
});

const file = (name, type, size = 64) => Object.assign(new Blob([new Uint8Array(size)], { type }), { name });
const tick = () => new Promise(r => setTimeout(r, 0));

async function boot() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('测试项目');
  const assets = createAssets({ store, storage, api: { uploadAsset: async () => { throw new Error('未接入'); } } });
  const deps = {
    store, storage, assets,
    board: { select() {} },
    generators: { generate: async () => { throw new Error('生成未接入'); } },
    workflow: null,
    onUpdate() {},
  };
  const tools = createTools({ store, storage, assets, onUpdate() {} });
  const sb = createStoryboards(deps);
  return { store, storage, assets, deps, tools, sb };
}

test('AST-01：removeAsset 扫描期间切项目 → 中止，新项目 nodes/assets 不受影响', async () => {
  const { assets, store, storage } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  const pid1 = store.project.id;
  const origKeys = storage.keys.bind(storage);
  let flipped = false;
  storage.keys = async () => {
    const r = await origKeys();
    if (!flipped) {
      flipped = true;
      await store.newProject('另一项目');
      // 新项目出现同名 assetId 引用（历史共享身份）：删除中止后它必须原样保留
      store.addNode('asset', 0, 0, { assetId: a.id });
    }
    return r;
  };
  const res = await assets.removeAsset(a.id, { force: true });
  storage.keys = origKeys;
  assert.equal(res, false, '删除应中止');
  const nn = store.project.nodes[0];
  assert.equal(nn.data.assetId, a.id, '新项目节点引用未被清扫');
  assert.equal(nn.data.needsRebind, undefined);
  const old = await storage.get(`project:${pid1}`);
  assert.ok(old.assets[a.id], '旧项目素材记录保留');
  assert.ok(await storage.getBlob(`blob:${a.id}`), 'blob 未删');
});

test('AST-02：历史项目共享 assetId → 删除保留共享 blob；重绑被阻止并提示另上传', async () => {
  const { assets, store, storage } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png', 64), 'a.png', 'image');
  // 模拟历史项目文档：其 assets 表持有同一 assetId（旧副本共享全局 blob 键）
  await storage.set('project:p_legacy', {
    id: 'p_legacy', name: '历史副本', createdAt: 1, updatedAt: 1, rev: 1,
    nodes: [], edges: [], assets: { [a.id]: { ...a } },
  });
  const rb = await assets.rebindFile(a.id, file('a2.png', 'image/png', 128));
  assert.equal(rb, null, '共享素材重绑被阻止');
  assert.equal((await storage.getBlob(`blob:${a.id}`)).size, 64, '共享 blob 未被覆盖');
  assert.equal(await assets.removeAsset(a.id), true);
  assert.equal(store.project.assets[a.id], undefined, '本项目记录已移除');
  assert.ok(await storage.getBlob(`blob:${a.id}`), '共享 blob 保留给其他项目');
  const legacy = await storage.get('project:p_legacy');
  assert.ok(legacy.assets[a.id], '其他项目素材记录未受影响');
});

test('AST-02：上传在飞时素材被 force 删除 → 结果作废，墓碑不被标上传成功', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('p');
  let resolveUp;
  const assets = createAssets({ store, storage, api: { uploadAsset: () => new Promise(r => resolveUp = r) } });
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  store.addNode('asset', 0, 0, { assetId: a.id });   // 引用 → force 后留墓碑
  const up = assets.upload(a.id);
  await tick();                                     // 让 upload 进入 api.uploadAsset
  assert.equal(await assets.removeAsset(a.id, { force: true }), true);
  assert.equal(store.project.assets[a.id].missing, true);
  resolveUp({ url: 'https://xingpan.site/reference-assets/x.png', expires_at: Math.floor(Date.now() / 1000) + 3600 });
  await assert.rejects(up, /已删除/);
  assert.equal(store.project.assets[a.id].remote, null, '墓碑不得写回 remote');
});

test('AST-03：上传响应必须绑定 https://xingpan.site，拒绝外域/凭据/hash', async () => {
  const { assets } = await boot();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const ok = assets.validateUploadResponse({ url: 'https://xingpan.site/reference-assets/a.png', expires_at: exp, content_type: 'image/png' }, 'image', 'fp');
  assert.equal(ok.url, 'https://xingpan.site/reference-assets/a.png');
  const withUserInfo = new URL(ok.url); withUserInfo.username = 'user'; withUserInfo.password = 'pw';
  for (const bad of [
    'https://evil.example/reference-assets/a.png',
    'https://xingpan.site.evil.example/reference-assets/a.png',
    'http://xingpan.site/reference-assets/a.png',
    withUserInfo.href,
    'https://xingpan.site/reference-assets/a.png#frag',
    'https://xingpan.site/other/a.png',
  ]) assert.throws(() => assets.validateUploadResponse({ url: bad, expires_at: exp }, 'image', 'fp'), /本站素材地址/, bad);
});

test('TLB-01：execute 作用域钉在发起项目/节点——中途切项目中止且不给新项目入库', async () => {
  const { tools, assets, store, storage } = await boot();
  const a = await assets.registerBlob(file('p.png', 'image/png'), 'p.png', 'image');
  const an = store.addNode('asset', 0, 0, { assetId: a.id });
  const n = store.addNode('utility', 0, 0, { tool: 'grid_split', params: { rows: 2, cols: 2 } });
  store.addEdge(an.id, 'out', n.id, 'refs', 'image');
  const pid1 = store.project.id;
  const origBlobOf = assets.blobOf;
  let release;
  assets.blobOf = () => new Promise(r => release = r);   // 让 IMPL 停在首个 await
  const pr = tools.execute(n);
  await tick();
  await store.newProject('新项目');
  release(new Blob(['x'], { type: 'image/png' }));
  await assert.rejects(pr, /项目已切换|已删除/);
  assets.blobOf = origBlobOf;
  assert.deepEqual(Object.keys(store.project.assets), [], '新项目素材库无孤儿产出');
  const doc1 = await storage.get(`project:${pid1}`);
  const un = doc1.nodes.find(x => x.id === n.id);
  assert.equal(un.data.outputText, undefined, '失败不写回草稿/输出');
  assert.equal(un.data.outputAssetIds, undefined);
});

test('TLB-01：registerBlob 可选 scope 参数——旧调用兼容，scope 失效即中止', async () => {
  const { assets, store } = await boot();
  const p1 = store.project;
  const rec = await assets.registerBlob(file('x.png', 'image/png'), 'x.png', 'image');   // 旧签名不变
  assert.ok(store.project.assets[rec.id]);
  await store.newProject('p2');
  await assert.rejects(
    assets.registerBlob(file('y.png', 'image/png'), 'y.png', 'image', {}, { project: p1 }),
    /项目已切换|已删除/);
  assert.deepEqual(Object.keys(store.project.assets), []);
  await assert.rejects(
    assets.registerBlob(file('z.png', 'image/png'), 'z.png', 'image', {}, { project: store.project, nodeId: 'n_gone' }),
    /已删除/);
});

test('TLB-02：json_parse 点号数字段/根数组/括号路径/原型污染防护', async () => {
  const { tools, store } = await boot();
  const wire = (srcText, path) => {
    const src = store.addNode('text', 0, 0, { text: srcText });
    const n = store.addNode('utility', 0, 0, { tool: 'json_parse', params: { path } });
    store.addEdge(src.id, 'out', n.id, 'refs', 'text');
    return n;
  };
  assert.equal((await tools.execute(wire('{"items":[7,8]}', 'items.0'))).text, '7');
  assert.equal((await tools.execute(wire('{"items":[7,8]}', 'items[1]'))).text, '8');
  assert.equal((await tools.execute(wire('[7,8]', '0'))).text, '7');
  assert.equal((await tools.execute(wire('[7,8]', '[1]'))).text, '8');
  assert.equal((await tools.execute(wire('{"a":{"0":{"b":5}}}', 'a.0.b'))).text, '5');
  await assert.rejects(tools.execute(wire('{"a":1}', '__proto__')), /受保护|不合法/);
  await assert.rejects(tools.execute(wire('{"a":1}', 'a.constructor')), /受保护|不合法/);
});

test('SB-01：versions.fields 随导出导入保留；缺 fields 的旧版本回滚报明确错误', async () => {
  const { sb, store } = await boot();
  const [s] = sb.fromScript('1. 原始描述');
  const before = s.description;   // 单段导入保留编号原文，以此真实值为往返基线
  sb.updateShot(s.id, { description: '改后', emotion: '紧张' });
  const text = await store.exportJSON();
  const p2 = await store.importJSON(text);
  const s2 = p2.studio.shots.find(x => x.id === s.id);
  assert.equal(s2.versions.length, 1);
  assert.equal(s2.versions[0].fields.description, before, 'fields 不得丢失');
  assert.equal(s2.versions[0].fields.emotion, '');
  sb.restoreVersion(s2.id, 0);
  assert.equal(sb.find(s2.id).description, before);
  sb.find(s2.id).versions.push({ at: Date.now() });   // 旧版导出缺 fields 的版本
  const idx = sb.find(s2.id).versions.length - 1;
  assert.throws(() => sb.restoreVersion(s2.id, idx), /字段内容|无法回滚/);
});

test('SB-02：批量生成遇死链节点整批阻止；preview 异常有反馈且无 unhandled rejection', async () => {
  const { sb, store, deps } = await boot();
  let previews = 0, starts = 0;
  deps.workflow = { preview: async () => { previews++; return { issues: [] }; }, start: async () => { starts++; return { ok: true }; } };
  const s = sb.addShot({ title: 'x' });
  const img = sb.ensureImageNode(s);
  store.removeNode(img.id);                       // 关联节点已删除
  const r = await sb.batchGenerate([s.id]);
  assert.equal(r, null);
  assert.equal(previews, 0, '不得对死链继续预检/收费');
  assert.equal(starts, 0);
  deps.workflow.preview = async () => { throw new Error('估价失败'); };
  const s2 = sb.addShot({ title: 'y' });
  sb.ensureImageNode(s2);
  const r2 = await sb.batchGenerate([s2.id]);     // 内部 catch → resolves null，无未处理拒绝
  assert.equal(r2, null);
});

test('SB-03：小数时长/区间不被误当镜头编号', async () => {
  const { sb } = await boot();
  const made = sb.fromScript('3.5秒的推镜\n第2镜 摇');
  assert.equal(made.length, 1, '「3.5秒」不得被当成编号切出幻影镜头');
  assert.equal(made[0].duration, 3.5, '3.5 秒保留原值，不静默取整');
  assert.equal(made[0].durationInvalid, true);
  assert.equal(made[0].durationRaw, '3.5秒');
  const m2 = sb.fromScript('3-4秒摇镜\n\n第2镜 推拉', { mode: 'replace' });
  assert.equal(m2.length, 2);
  assert.equal(m2[0].duration, 4, '「3-4秒」是区间时长而非编号');
  const m3 = sb.fromScript('1. 清晨\n2. 特写 8秒', { mode: 'replace' });
  assert.equal(m3.length, 2, '正常编号行仍然正确切分');
  assert.equal(m3[1].duration, 8);
});

test('UX-04：素材库「＋节点」落点随 view 缩放/平移换算，始终在视口内', async () => {
  const view = { x: -2000, y: 300, scale: 0.25 };
  const p1 = assetSpawnPos({ board: { view } });
  const p2 = assetSpawnPos({ board: { view } });
  assert.deepEqual(p1, p2, '落点确定，不用 Math.random');
  const left = -view.x / view.scale, top = -view.y / view.scale;
  assert.ok(Number.isFinite(p1.x) && Number.isFinite(p1.y));
  assert.ok(p1.x > left, `${p1.x} 须在可视区左边界 ${left} 右侧`);
  assert.ok(p1.y > top, `${p1.y} 须在可视区上边界 ${top} 下侧`);
  const sp = assetSpawnPos({ spawnPos: () => ({ x: 12, y: 34 }), board: { view } });
  assert.deepEqual(sp, { x: 12, y: 34 }, '优先复用 deps.spawnPos');
});

test('分镜 assetIds：updateShot 保留 null 缺失槽位与失效引用', async () => {
  const { sb, assets } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  const s = sb.addShot({ title: 's' });
  sb.updateShot(s.id, { assetIds: [a.id, null, 'a_ghost', a.id, null] });
  assert.deepEqual(sb.find(s.id).assetIds, [a.id, null, 'a_ghost', null], 'null 槽位与失效引用均为显式占位');
});

test('AI 拆分后新分镜不立即标「脚本已更新」', async () => {
  const { sb, deps } = await boot();
  deps.generators.generate = async n => { n.data.resultText = JSON.stringify({ shots: [{ title: 'AI镜', duration: 5, description: 'x' }] }); };
  const made = await sb.breakdownWithAI('一段剧本');
  assert.equal(made.length, 1);
  assert.equal(sb.scriptStale(made[0]), false);
});

test('AST-02：同大小同类型重绑仍使在飞上传作废（本地版本守卫，不靠 size/mime）', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('p');
  let resolveUp;
  const assets = createAssets({ store, storage, api: { uploadAsset: () => new Promise(r => resolveUp = r) } });
  const a = await assets.registerBlob(file('a.png', 'image/png', 64), 'a.png', 'image');
  const up = assets.upload(a.id);
  await tick();
  const rb = await assets.rebindFile(a.id, file('a2.png', 'image/png', 64));   // 同 size 同 mime
  assert.equal(rb?.id, a.id, '重绑本身成功');
  resolveUp({ url: 'https://xingpan.site/reference-assets/x.png', expires_at: Math.floor(Date.now() / 1000) + 3600 });
  await assert.rejects(up, /重绑|作废/);
  assert.equal(a.remote, null, '旧文件内容的 remote 不得绑到新文件上');
});

test('AST-02：rebindFile 写入期间素材被删除 → 结果作废，墓碑不复活且不留孤儿 blob', async () => {
  const { assets, store, storage } = await boot();
  const a = await assets.registerBlob(file('old.png', 'image/png', 32), 'old.png', 'image');
  store.addNode('asset', 0, 0, { assetId: a.id });   // 引用 → force 后留墓碑
  const origSet = storage.setBlob.bind(storage);
  storage.setBlob = async (k, v) => {
    const r = await origSet(k, v);
    await assets.removeAsset(a.id, { force: true });   // 写入落盘后、重绑核验前交错删除
    return r;
  };
  const r = await assets.rebindFile(a.id, file('new.png', 'image/png', 128));
  storage.setBlob = origSet;
  assert.equal(r, null, '删除交错的重绑不得生效');
  assert.equal(store.project.assets[a.id]?.missing, true, '墓碑保持，不被复活');
  assert.ok(store.project.assets[a.id].deletedAt > 0);
  assert.equal(await storage.getBlob(`blob:${a.id}`), undefined, '重绑写入不得残留孤儿 blob');
});

test('AST-02：ensureRemote 同 assetId 跨项目不复用在飞上传，结果各归其项目', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('p1');
  let calls = 0; const gates = [];
  const assets = createAssets({ store, storage, api: { uploadAsset: () => new Promise(r => { calls++; gates.push(r); }) } });
  const a = await assets.registerBlob(file('a.png', 'image/png', 64), 'a.png', 'image');
  const up1 = assets.ensureRemote(a.id);   // p1 在飞上传
  up1.catch(() => {});                      // 预期失败：防未处理拒绝干扰
  await tick();
  await store.newProject('p2');
  store.project.assets[a.id] = { ...a, remote: null };   // 旧副本共享同一 assetId
  const a2 = store.project.assets[a.id];
  const up2 = assets.ensureRemote(a.id);
  await tick();
  assert.equal(calls, 2, '新项目同 id 不得复用旧项目的在飞上传 Promise');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  gates[1]({ url: 'https://xingpan.site/reference-assets/b.png', expires_at: exp });
  const r2 = await up2;
  assert.equal(r2.url, 'https://xingpan.site/reference-assets/b.png');
  assert.equal(a2.remote?.url, 'https://xingpan.site/reference-assets/b.png', '结果写回新项目素材');
  gates[0]({ url: 'https://xingpan.site/reference-assets/a.png', expires_at: exp });
  await assert.rejects(up1, /已变更|已删除/);   // p1 上传在项目切换后作废
  assert.equal(a2.remote?.url, 'https://xingpan.site/reference-assets/b.png', '旧上传结果不得覆盖新项目 remote');
});

test('AST-02：removeAsset 遇 delBlob 失败 → 不假报成功，记录与引用保持可重试', async () => {
  const { assets, store, storage } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  const n = store.addNode('asset', 0, 0, { assetId: a.id });
  const origDel = storage.delBlob.bind(storage);
  storage.delBlob = async () => { throw new Error('IDB 不可用'); };
  assert.equal(await assets.removeAsset(a.id, { force: true }), false, '删除失败如实返回');
  storage.delBlob = origDel;
  assert.ok(store.project.assets[a.id], '素材记录保留可重试');
  assert.equal(store.node(n.id).data.assetId, a.id, '引用未被清扫');
  assert.equal(store.node(n.id).data.needsRebind, undefined);
  assert.ok(await storage.getBlob(`blob:${a.id}`), 'blob 未受影响');
  assert.equal(await assets.removeAsset(a.id, { force: true }), true, '存储恢复后可重试删除');
  assert.equal(store.project.assets[a.id]?.missing, true);
});

test('SB-02：所选分镜 id 找不到 → 整批取消，不静默过滤继续收费', async () => {
  const { sb, deps } = await boot();
  let previews = 0;
  deps.workflow = { preview: async () => { previews++; return { issues: [] }; }, start: async () => ({ ok: true }) };
  const s = sb.addShot({ title: 'x' });
  sb.ensureImageNode(s);
  const r = await sb.batchGenerate([s.id, 's_ghost']);
  assert.equal(r, null);
  assert.equal(previews, 0, '含失效所选 id 时不得继续估价/收费');
});

test('SB-02：preview 返回 issues 直接阻止创建，不进入确认与收费', async () => {
  const { sb, deps } = await boot();
  let starts = 0;
  deps.workflow = { preview: async () => ({ issues: ['节点缺参数'], estimatedYuan: 1 }), start: async () => { starts++; return { ok: true }; } };
  const s = sb.addShot({ title: 'x' });
  sb.ensureImageNode(s);
  const r = await sb.batchGenerate([s.id]);
  assert.equal(r, null);
  assert.equal(starts, 0);
});

test('SB-02：preview 期间切项目 → 整批中止，旧 targets 不提交新项目', async () => {
  const { sb, store, deps } = await boot();
  let release, starts = 0;
  deps.workflow = {
    preview: async () => { await new Promise(r => release = r); return { issues: [] }; },
    start: async () => { starts++; return { ok: true }; },
  };
  const s = sb.addShot({ title: 'x' });
  sb.ensureImageNode(s);
  const p = sb.batchGenerate([s.id]);
  await tick();
  await store.newProject('新项目');
  release();
  assert.equal(await p, null);
  assert.equal(starts, 0, '不得把旧 targets 提交到新项目');
});

test('SB-02：preview 期间分镜被删或关联变更 → 整批中止', async () => {
  const { sb, deps } = await boot();
  let release, starts = 0;
  deps.workflow = {
    preview: async () => { await new Promise(r => release = r); return { issues: [] }; },
    start: async () => { starts++; return { ok: true }; },
  };
  const s = sb.addShot({ title: 'x' });
  sb.ensureImageNode(s);
  const p = sb.batchGenerate([s.id]);
  await tick();
  sb.removeShot(s.id);
  release();
  assert.equal(await p, null);
  const s2 = sb.addShot({ title: 'y' });
  sb.ensureImageNode(s2);
  const p2 = sb.batchGenerate([s2.id]);
  await tick();
  s2.imageNodeId = 'n_other';   // 关联被改指
  release();
  assert.equal(await p2, null);
  assert.equal(starts, 0);
});
