// upgrade-tools：utility 工具节点真实执行。
// node 下覆盖纯逻辑路径（text_input/json_parse/index_selector/resource_merge/batch_table）
// 与媒体工具的输入校验/边界/守卫；Canvas/视频路径在浏览器侧产出真实结果，node 下验证守卫报错而非假数据。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { setCapabilities } from '../src/capabilities.js';
import { createAssets } from '../src/assets.js';
import { createTools } from '../src/tools.js';

setCapabilities({
  models: {},
  upload_limits: {
    image: { content_types: ['image/png'], max_mib: 8 },
    video: { content_types: ['video/mp4'], max_mib: 50 },
    audio: { content_types: ['audio/mpeg'], max_mib: 10 },
  },
});

async function boot() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('t');
  const assets = createAssets({ store, storage, api: {} });
  const tools = createTools({ store, storage, assets, onUpdate() {} });
  return { store, storage, assets, tools };
}
const textNode = (store, text) => store.addNode('text', 0, 0, { text });
const util = (store, tool, params = {}) => store.addNode('utility', 0, 0, { tool, params });
const mkAsset = async (store, assets, name = 'a.png', kind = 'image', mime = 'image/png') => {
  const rec = await assets.registerBlob(new Blob(['x'], { type: mime }), name, kind);
  return store.addNode('asset', 0, 0, { assetId: rec.id, title: name });
};
const wire = (store, src, dst, kind) => store.addEdge(src.id, 'out', dst.id, 'refs', kind);

test('text_input：输出文本并持久化', async () => {
  const { store, tools } = await boot();
  const n = util(store, 'text_input', { text: '你好分镜' });
  const r = await tools.execute(n);
  assert.equal(r.text, '你好分镜');
  assert.equal(store.node(n.id).data.outputText, '你好分镜');
  assert.equal(store.node(n.id).data.operation.state, 'completed');
  assert.deepEqual(r.assets, []);
});

test('json_parse：路径提取 / 非法 JSON / 缺失路径', async () => {
  const { store, tools } = await boot();
  const src = textNode(store, '{"a":{"b":[10,20]},"s":"str"}');
  const n = util(store, 'json_parse', { path: 'a.b[1]' });
  wire(store, src, n, 'text');
  assert.equal((await tools.execute(n)).text, '20');
  const bad = util(store, 'json_parse', {});
  wire(store, textNode(store, 'not json{'), bad, 'text');
  await assert.rejects(tools.execute(bad), /合法 JSON/);
  const miss = util(store, 'json_parse', { path: 'a.zzz' });
  wire(store, src, miss, 'text');
  await assert.rejects(tools.execute(miss), /路径不存在/);
});

test('index_selector：按连线顺序选第 N 项，越界报错', async () => {
  const { store, assets, tools } = await boot();
  const a1 = await mkAsset(store, assets, 'a1.png');
  const a2 = await mkAsset(store, assets, 'a2.png');
  const n = util(store, 'index_selector', { index: 1 });
  wire(store, a2, n, 'image');   // 先连 a2 → 第 1 项是 a2
  wire(store, a1, n, 'image');
  const r = await tools.execute(n);
  assert.equal(r.assets[0].name, 'a2.png');
  const out = util(store, 'index_selector', { index: 9 });
  wire(store, a1, out, 'image');
  await assert.rejects(tools.execute(out), /不存在/);
});

test('resource_merge：按序合并素材并拼接文本', async () => {
  const { store, assets, tools } = await boot();
  const a1 = await mkAsset(store, assets, 'a1.png');
  const a2 = await mkAsset(store, assets, 'a2.png');
  const t = textNode(store, '旁白一');
  const n = util(store, 'resource_merge', {});
  wire(store, a1, n, 'image'); wire(store, a2, n, 'image'); wire(store, t, n, 'text');
  const r = await tools.execute(n);
  assert.equal(r.assets.length, 2);
  assert.equal(store.node(n.id).data.outputAssetIds.length, 2);
  assert.equal(r.text, '旁白一');
});

test('batch_table：CSV 解析、模板渲染、表头/行数校验', async () => {
  const { store, tools } = await boot();
  const n = util(store, 'batch_table', { csv: 'name,city\n甲,北京\n乙,上海', template: '去{{city}}找{{name}}' });
  const r = await tools.execute(n);
  assert.deepEqual(JSON.parse(r.text), ['去北京找甲', '去上海找乙']);
  assert.equal(store.node(n.id).data.tableRows.length, 2);
  const dup = util(store, 'batch_table', { csv: 'a,a\n1,2' });
  await assert.rejects(tools.execute(dup), /表头/);
  const big = util(store, 'batch_table', { csv: 'h\n' + Array.from({ length: 101 }, (_, i) => i).join('\n') });
  await assert.rejects(tools.execute(big), /100/);
  const mis = util(store, 'batch_table', { csv: 'a,b\n1' });
  await assert.rejects(tools.execute(mis), /列数/);
});

test('媒体工具：输入类型/参数边界校验', async () => {
  const { store, assets, tools } = await boot();
  const img = await mkAsset(store, assets, 'p.png', 'image');
  const vid = await mkAsset(store, assets, 'v.mp4', 'video', 'video/mp4');
  const c1 = util(store, 'crop', { x: 0, y: 0, w: 10, h: 10 });
  wire(store, vid, c1, 'video');
  await assert.rejects(tools.execute(c1), /图片/);
  const c2 = util(store, 'crop', {});
  wire(store, img, c2, 'image');
  await assert.rejects(tools.execute(c2), /裁切参数/);
  const g = util(store, 'grid_split', { rows: 9, cols: 9 });
  wire(store, img, g, 'image');
  await assert.rejects(tools.execute(g), /超限/);
  const s1 = util(store, 'shot_extraction', { mode: 'bogus' });
  wire(store, vid, s1, 'video');
  await assert.rejects(tools.execute(s1), /未知抽帧方式/);
  const s2 = util(store, 'shot_extraction', {});
  wire(store, img, s2, 'image');
  await assert.rejects(tools.execute(s2), /视频/);
});

test('媒体工具：缺失引用明确报错，不静默丢弃', async () => {
  const { store, tools } = await boot();
  const dead = store.addNode('asset', 0, 0, { assetId: 'a_missing', title: 'x' });
  const n = util(store, 'crop', { x: 0, y: 0, w: 5, h: 5 });
  wire(store, dead, n, 'image');
  await assert.rejects(tools.execute(n), /缺失/);
});

test('媒体工具：合法输入在非浏览器环境给出明确原因而非假数据', async () => {
  const { store, assets, tools } = await boot();
  const img = await mkAsset(store, assets, 'p.png', 'image');
  const n = util(store, 'grid_split', { rows: 2, cols: 2 });
  wire(store, img, n, 'image');
  await assert.rejects(tools.execute(n), /浏览器环境/);
});

test('execute：非 utility / 未知工具 / 项目切换写守卫', async () => {
  const { store, tools } = await boot();
  await assert.rejects(tools.execute(store.addNode('note', 0, 0, {})), /工具节点/);
  await assert.rejects(tools.execute(util(store, 'nope')), /未知/);
  const n = util(store, 'text_input', { text: 'hi' });
  await store.newProject('p2');
  await assert.rejects(tools.execute(n), /项目已切换/);
});

test('缺失占位：空绑定素材节点与输出槽位 null 不被静默丢弃', async () => {
  const { store, assets, tools } = await boot();
  const dead = store.addNode('asset', 0, 0, { assetId: null, needsRebind: true });
  const m1 = util(store, 'resource_merge', {});
  wire(store, dead, m1, 'image');
  await assert.rejects(tools.execute(m1), /缺失/);
  const keep = await mkAsset(store, assets, 'k.png');
  const src = util(store, 'text_input', { text: 'x' });
  store.updateNodeData(src.id, { outputAssetIds: [keep.data.assetId, null] });
  const m2 = util(store, 'resource_merge', {});
  wire(store, src, m2, 'any');
  await assert.rejects(tools.execute(m2), /缺失/);
});
