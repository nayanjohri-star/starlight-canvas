// upgrade-storyboard：分镜数据层 + 素材组织（storyboard.js / assets.js 扩展）。
// node 可跑：不触发浏览器 UI；toast 用最小 DOM 桩承接。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { setCapabilities } from '../src/capabilities.js';
import { createAssets } from '../src/assets.js';
import { createStoryboards, shotsToCSV, singleImagePlan } from '../src/storyboard.js';
import { parseCSV } from '../src/studio-schema.js';
import { setAvailableModels } from '../src/keyvault.js';

// 最小 DOM 桩：仅 toast-root 有元素（toast 可用）；asset-list 返回 null → renderLibrary 早退
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
    image: { content_types: ['image/png'], max_mib: 1 },
    video: { content_types: ['video/mp4'], max_mib: 10 },
    audio: { content_types: ['audio/mpeg'], max_mib: 5 },
  },
});

const file = (name, type, size = 64) => Object.assign(new Blob([new Uint8Array(size)], { type }), { name });

// 11 个视频型号能力夹具：覆盖 h3/sd25/wan 三个 family，时长范围各异。
const VM = (family, min, max, extra = {}) => ({
  family, seconds: { min, max }, ratios: { options: ['16:9', '9:16', '1:1'] },
  prompt_max_characters: 2000,
  reference_limits: { image: 9, video: 3, audio: 3, total: 9 },
  switches: { generate_audio: true, face_mode: true },
  price_cny_per_second: 0.2, ...extra,
});
const VIDEO_TABLE = {
  models: {
    'minimax-h3-768p-per-second': VM('h3', 1, 10),
    'minimax-h3-1080p': VM('h3', 1, 10),
    'hailuo-t2v-01': VM('h3', 3, 10),
    'hailuo-i2v-01': VM('h3', 3, 10),
    'sd-25-720p': VM('sd25', 1, 16, { switches: { generate_audio: false, face_mode: true } }),
    'sd-25-1080p': VM('sd25', 1, 16),
    'sd-25-plus': VM('sd25', 4, 16),
    'vidu-q1-refs': VM('sd25', 1, 16),
    'wan-21-480p': VM('wan', 3, 8, { switches: {} }),
    'wan-21-720p': VM('wan', 3, 8),
    'wan-22-1080p': VM('wan', 3, 8),
  },
  upload_limits: {
    image: { content_types: ['image/png'], max_mib: 1 },
    video: { content_types: ['video/mp4'], max_mib: 10 },
    audio: { content_types: ['audio/mpeg'], max_mib: 5 },
  },
};
const withVideoTable = () => setCapabilities(VIDEO_TABLE);

async function boot() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('测试项目');
  const assets = createAssets({ store, storage, api: { uploadAsset: async () => { throw new Error('未接入'); } } });
  const calls = [];
  const deps = {
    store, storage, assets,
    board: { select: (t, id) => calls.push(['select', t, id]) },
    generators: { generate: async () => { throw new Error('生成未接入'); } },
    workflow: null,
    onUpdate() {},
  };
  return { store, storage, assets, deps, calls, sb: createStoryboards(deps) };
}

test('fromScript：编号剧本文本拆为分镜，studio.shots 为权威', async () => {
  const { sb, store } = await boot();
  const made = sb.fromScript('1. 清晨街道全景\n2. 主角特写 8秒\n3. 夜景霓虹');
  assert.equal(made.length, 3);
  assert.equal(store.project.studio.shots.length, 3);
  assert.equal(made[0].title, '镜头 1');
  assert.match(made[0].description, /清晨街道/);
  assert.equal(made[1].duration, 8);
});

test('fromScript：空行分段回退', async () => {
  const { sb } = await boot();
  const made = sb.fromScript('开场航拍\n\n\n室内对白');
  assert.equal(made.length, 2);
});

test('fromScript：JSON 结构化导入严格校验', async () => {
  const { sb } = await boot();
  const [s] = sb.fromScript(JSON.stringify({ shots: [{ title: 'A', duration: 6, description: 'd', imagePrompt: 'p' }] }));
  assert.equal(s.title, 'A'); assert.equal(s.duration, 6); assert.equal(s.imagePrompt, 'p');
  assert.throws(() => sb.fromScript('[{"title":"x","duration":"abc"}]'), /duration 须为数字/);
  assert.throws(() => sb.fromScript('[{"title":"x","bogus":1}]'), /未知字段/);
  assert.throws(() => sb.fromScript('{"foo":1}'), /shots/);
  assert.throws(() => sb.fromScript('[{"title":123}]'), /须为字符串/);
});

test('fromScript：replace 替换 + 数量上限', async () => {
  const { sb } = await boot();
  sb.fromScript('1. a\n2. b');
  const made = sb.fromScript('[{"title":"only"}]', { mode: 'replace' });
  assert.equal(made.length, 1);
  assert.equal(sb.list().length, 1);
  const many = JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ title: `s${i}` })));
  assert.throws(() => sb.fromScript(many), /超限/);
});

test('updateShot：版本快照与回滚', async () => {
  const { sb } = await boot();
  const [s] = sb.fromScript('1. 原始描述');
  sb.updateShot(s.id, { description: '改后', emotion: '紧张' });
  assert.equal(sb.find(s.id).description, '改后');
  assert.equal(sb.find(s.id).versions.length, 1);
  assert.match(sb.find(s.id).versions[0].fields.description, /原始描述/);
  sb.restoreVersion(s.id, 0);
  assert.match(sb.find(s.id).description, /原始描述/);
});

test('moveShot / reorderShot / removeShot（节点保留）', async () => {
  const { sb, store } = await boot();
  const g = sb.createGrid(4);
  const [s0, s1] = g.shots;
  sb.moveShot(s1.id, -1);
  assert.equal(sb.list()[0].id, s1.id);
  sb.reorderShot(s1.id, 3);
  assert.equal(sb.list()[3].id, s1.id);
  const nodeId = g.shots[2].imageNodeId;
  sb.removeShot(g.shots[2].id);
  assert.equal(sb.list().length, 3);
  assert.ok(store.node(nodeId), '删除分镜不删画布节点');
});

test('createGrid：只接受 2/4/9/12/25，每镜独立图片节点', async () => {
  const { sb, store } = await boot();
  assert.throws(() => sb.createGrid(3), /网格数/);
  const { shots, nodes } = sb.createGrid(9);
  assert.equal(shots.length, 9);
  assert.equal(nodes.length, 9);
  for (const s of shots) {
    const n = store.node(s.imageNodeId);
    assert.equal(n.type, 'image');
    assert.equal(n.data.params.shotId, s.id);
  }
});

test('ensureVideoNode：建 gen 节点并把图片节点接入首帧', async () => {
  const { sb, store } = await boot();
  const { shots } = sb.createGrid(4);
  const s = shots[0];
  const gen = sb.ensureVideoNode(s);
  assert.equal(gen.type, 'gen');
  const edge = store.project.edges.find(e => e.to.node === gen.id && e.to.port === 'frames');
  assert.equal(edge?.from.node, s.imageNodeId);
  assert.equal(sb.ensureVideoNode(s).id, gen.id, '重复调用不重建');
});

test('行↔节点提示词分歧与双向同步', async () => {
  const { sb, store } = await boot();
  const { shots } = sb.createGrid(4);
  const s = shots[0];
  sb.updateShot(s.id, { imagePrompt: '雨夜霓虹街景', videoPrompt: '雨滴滑落镜头' });
  assert.equal(sb.divergence(s).image, true);
  assert.equal(sb.syncShotToNodes(s.id), 1);
  assert.equal(store.node(s.imageNodeId).data.prompt, '雨夜霓虹街景');
  assert.equal(sb.divergence(s).image, false);
  store.updateNodeData(s.imageNodeId, { prompt: '新图提示' });
  sb.syncShotFromNodes(s.id);
  assert.equal(sb.find(s.id).imagePrompt, '新图提示');
});

test('脚本修改脏提示', async () => {
  const { sb } = await boot();
  const now = Date.now; let tick = now(); Date.now = () => ++tick;
  try {
    const [s] = sb.fromScript('1. 场景一');
    assert.equal(sb.scriptStale(s), false, '生成镜头与更新脚本跨毫秒也不误标过期');
    sb.setScript('1. 场景一（改）');
    assert.equal(sb.scriptStale(s), true);
    assert.equal(sb.scriptDirty(), true);
  } finally { Date.now = now; }
});

test('AI 拆分经 generators 文本节点（无本地伪实现），失败如实报错', async () => {
  const { sb, store, deps } = await boot();
  deps.generators.generate = async node => {
    node.data.resultText = JSON.stringify({ shots: [{ title: 'AI镜1', duration: 5, description: 'x' }] });
  };
  const made = await sb.breakdownWithAI('一段剧本');
  assert.equal(made.length, 1);
  assert.equal(made[0].title, 'AI镜1');
  const tn = store.project.nodes.find(n => n.type === 'text');
  assert.ok(tn?.data.system.includes('JSON'));
  deps.generators.generate = async () => { throw new Error('无密钥'); };
  await assert.rejects(sb.breakdownWithAI('x'), /AI 拆分失败/);
});

test('focusShot：返回分镜并定位画布节点', async () => {
  const { sb, calls } = await boot();
  const { shots } = sb.createGrid(4);
  const s = sb.focusShot(shots[1].id);
  assert.equal(s.id, shots[1].id);
  assert.deepEqual(calls.at(-1), ['select', 'node', shots[1].imageNodeId]);
});

test('shotsToCSV：12 字段转义并可被 parseCSV 回读', async () => {
  const { sb } = await boot();
  const [s] = sb.fromScript('[{"title":"含,逗号","duration":5,"description":"多行\\n描\\"述\\""}]');
  sb.updateShot(s.id, { dialogue: '说："你好"' });
  const rows = parseCSV(shotsToCSV(sb.list()));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['镜头'], '含,逗号');
  assert.equal(rows[0]['对白'], '说："你好"');
  assert.equal(rows[0]['时长'], '5');
});

test('素材：分类/标签/收藏/检索', async () => {
  const { assets } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  const b = await assets.registerBlob(file('b.png', 'image/png'), 'b.png', 'image');
  assets.setCategory(a.id, 'character');
  assets.setTags(a.id, '主角, 雨夜');
  assets.setFavorite(a.id, true);
  assets.setCategory(b.id, 'scene');
  assert.equal(assets.queryAssets({ category: 'character' }).length, 1);
  assert.equal(assets.queryAssets({ favorite: true })[0].id, a.id);
  assert.equal(assets.queryAssets({ tag: '雨夜' })[0].id, a.id);
  assert.equal(assets.queryAssets({ text: 'b.png' })[0].id, b.id);
  assert.equal(assets.setCategory(a.id, 'bad'), null);
  assert.deepEqual(assets.tagList(a), ['主角', '雨夜']);
});

test('素材：合集成员归属，删合集不删素材', async () => {
  const { assets, store } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  const c = assets.createCollection('第一集');
  assets.setAssetCollection(a.id, c.id);
  assert.equal(assets.collectionOf(a.id).id, c.id);
  assert.equal(assets.queryAssets({ collectionId: c.id }).length, 1);
  assets.deleteCollection(c.id);
  assert.equal(assets.queryAssets({ collectionId: c.id }).length, 0);
  assert.ok(store.project.assets[a.id]);
});

test('素材：被引用时拒绝删除；force 转墓碑清 blob，无引用后彻底移除', async () => {
  const { assets, store, storage } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  const n = store.addNode('asset', 0, 0, { assetId: a.id });
  assert.equal((await assets.assetRefs(a.id)).length, 1);
  assert.equal(await assets.removeAsset(a.id), false);
  assert.ok(await storage.getBlob(`blob:${a.id}`), '被引用时 blob 不得删除');
  assert.equal(await assets.removeAsset(a.id, { force: true }), true);
  assert.equal(store.node(n.id).data.assetId, null);
  assert.equal(store.node(n.id).data.needsRebind, true);
  assert.equal(await storage.getBlob(`blob:${a.id}`), undefined);
  assert.equal(store.project.assets[a.id]?.missing, true);   // 有引用 → 墓碑保留，可重绑恢复
  store.removeNode(n.id);
  assert.equal(await assets.removeAsset(a.id), true);        // 引用清除 → 彻底移除
  assert.equal(store.project.assets[a.id], undefined);
  const b = await assets.registerBlob(file('b.png', 'image/png'), 'b.png', 'image');
  assert.equal(await assets.removeAsset(b.id), true);
  assert.equal(store.project.assets[b.id], undefined);
});

test('素材：重绑校验类型与大小', async () => {
  const { assets } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  a.missing = true;
  assert.match(assets.validateRebind(a, file('v.mp4', 'video/mp4')), /类型不符/);
  assert.match(assets.validateRebind(a, file('big.png', 'image/png', 2 * 1024 * 1024)), /上限/);
  assert.equal(await assets.rebindFile(a.id, file('v.mp4', 'video/mp4')), null);
  const ok = await assets.rebindFile(a.id, file('new.png', 'image/png', 128));
  assert.equal(ok.id, a.id);
  assert.equal(a.missing, false);
  assert.equal(a.size, 128);
});

test('addFiles：保持原有批量入库合同', async () => {
  const { assets } = await boot();
  assert.deepEqual(await assets.addFiles([file('x.bin', 'application/x-bin')]), []);
  const out = await assets.addFiles([file('p.png', 'image/png', 32), file('v.mp4', 'video/mp4', 64)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'image');
});

test('时长解析：中文秒/英文 s 无词边界可识别，编号与光圈值不误读', async () => {
  const { sb } = await boot();
  const made = sb.fromScript('1. 全景 8秒\n2. 特写 12 秒。\n3. 推拉 6s,\n4. 空镜 20S\n5. 夜景');
  assert.equal(made[0].duration, 8);
  assert.equal(made[1].duration, 12);
  assert.equal(made[2].duration, 6);
  assert.equal(made[3].duration, 20);
  assert.equal(made[4].duration, 5);
  const [x] = sb.fromScript('总时长10秒的镜头');
  assert.equal(x.duration, 10);
  const [y] = sb.fromScript('1.5秒快闪');
  assert.equal(y.duration, 1.5);   // 小数时长保留原值，不取整
  assert.equal(y.durationInvalid, true);
  assert.equal(y.durationRaw, '1.5秒');
  const [a, b, c] = sb.fromScript('开场 f1.8s 光圈\n\n8shot 连拍\n\n镜头3\n街道空镜');
  assert.equal(a.duration, 5);   // f1.8s 光圈值不是时长
  assert.equal(b.duration, 5);   // 8shot 词内 s 不是时长
  assert.equal(c.duration, 5);   // 「镜头3」编号不是时长
});

test('超限整批拒绝：fromScript 追加与 createGrid 均不残留半批', async () => {
  const { sb, store } = await boot();
  for (let i = 0; i < 199; i++) sb.addShot({ title: `s${i}` });
  const before = JSON.stringify({ shots: store.project.studio.shots, nodes: store.project.nodes });
  assert.throws(() => sb.fromScript('[{"title":"A"},{"title":"B"}]'), /超限/);
  assert.throws(() => sb.fromScript('1. x\n2. y'), /超限/);
  assert.throws(() => sb.createGrid(4), /超限/);
  assert.throws(() => sb.fromScript('[{"title":"A"}]', { mode: 'bogus' }), /未知导入模式/);
  assert.equal(JSON.stringify({ shots: store.project.studio.shots, nodes: store.project.nodes }), before);
});

test('breakdownWithAI：await 期间切项目，结果不写入新项目', async () => {
  const { store, deps, sb } = await boot();
  let release;
  const gate = new Promise(r => release = r);
  deps.generators.generate = async n => { await gate; n.data.resultText = JSON.stringify({ shots: [{ title: '旧项目镜头' }] }); };
  const pending = sb.breakdownWithAI('剧本');
  await store.newProject('另一个项目');
  release();
  await assert.rejects(pending, /AI 拆分失败：项目已切换/);
  assert.equal(store.project.studio?.shots?.length ?? 0, 0);
});

test('型号助手：文本/图片/视频型号取自 generators，可用性为空时显式拒绝', async () => {
  withVideoTable();
  const { sb, store, deps } = await boot();
  deps.generators.imageModels = () => [{ id: 'img-a', usable: true }, { id: 'img-b', usable: false }];
  deps.generators.videoModels = () => [{ id: 'wan-22-1080p', usable: true }];
  deps.generators.textModels = () => [{ id: 'txt-a', usable: true }];
  deps.generators.generate = async n => { n.data.resultText = JSON.stringify({ shots: [{ title: 'AI' }] }); };
  const { nodes } = sb.createGrid(4);
  assert.equal(nodes[0].data.model, 'img-a');
  const gen = sb.ensureVideoNode(sb.list()[0]);
  assert.equal(gen.data.draft.model, 'wan-22-1080p');
  assert.equal(gen.data.draft.intent, 'i2v');
  await sb.breakdownWithAI('剧本');
  const tn = store.project.nodes.find(n => n.type === 'text');
  assert.equal(tn.data.model, 'txt-a');
  deps.generators.textModels = () => [{ id: 'txt-b', usable: false }];
  await assert.rejects(sb.breakdownWithAI('x'), /无可用文本模型/);
});

test('ensureVideoNode：11 个视频型号逐一单图接入——模式/端口/时长与能力一致', async () => {
  withVideoTable();
  const { sb, store } = await boot();
  try {
    for (const id of Object.keys(VIDEO_TABLE.models)) {
      setAvailableModels([id]);
      const s = sb.addShot({ title: `m-${id}`, duration: 5 });
      const img = sb.ensureImageNode(s);
      const gen = sb.ensureVideoNode(s);
      assert.equal(gen.data.draft.model, id);
      assert.equal(gen.data.draft.seconds, 5, `${id} 输出时长须等于分镜时长，不得静默改秒数`);
      const fam = VIDEO_TABLE.models[id].family;
      assert.equal(gen.data.draft.intent, fam === 'h3' ? 'frames' : fam === 'wan' ? 'i2v' : 'refs', `${id}(${fam}) 单图意图`);
      const edge = store.project.edges.find(e => e.to.node === gen.id && e.from.node === img.id);
      assert.equal(edge?.to.port, fam === 'h3' ? 'frames' : 'refs', `${id}(${fam}) 锚点端口`);
      for (const k of Object.keys(gen.data.draft.switches ?? {}))
        assert.ok(VIDEO_TABLE.models[id].switches[k], `${id} 不得携带能力外开关 ${k}`);
      assert.equal(gen.data.params.shotId, s.id);
    }
    assert.equal(Object.keys(VIDEO_TABLE.models).length, 11);
  } finally { setAvailableModels(null); }
});

test('ensureVideoNode：时长驱动选型；无兼容型号在建节点前显式失败', async () => {
  withVideoTable();
  const { sb, store } = await boot();
  try {
    // 默认 H3(1-10s) 不在可用集；duration 12 只能由 SD(1-16) 承接
    setAvailableModels(['sd-25-1080p', 'wan-21-720p']);
    const s = sb.addShot({ title: '长镜', duration: 12 });
    const gen = sb.ensureVideoNode(s);
    assert.equal(gen.data.draft.model, 'sd-25-1080p');
    assert.equal(gen.data.draft.seconds, 12);
    // duration 20：可用集内无任何型号覆盖 → 显式失败且不留节点
    const s2 = sb.addShot({ title: '超长', duration: 20 });
    assert.throws(() => sb.ensureVideoNode(s2), /范围|时长/);
    assert.equal(s2.nodeId, null);
    assert.equal(store.project.nodes.filter(n => n.type === 'gen').length, 1, '失败不得残留 gen 节点');
    // 密钥只列 Wan：单图锚点必须走 i2v/refs，而不是默认 H3 frames
    setAvailableModels(['wan-21-720p']);
    const s3 = sb.addShot({ title: 'w', duration: 5 });
    const img3 = sb.ensureImageNode(s3);
    const g3 = sb.ensureVideoNode(s3);
    assert.equal(g3.data.draft.model, 'wan-21-720p');
    assert.equal(g3.data.draft.intent, 'i2v');
    assert.equal(store.project.edges.find(e => e.to.node === g3.id && e.from.node === img3.id)?.to.port, 'refs');
  } finally { setAvailableModels(null); }
});

test('ensureVideoNode：videoModels 助手清单优先，不可用与能力缺失项如实拒绝', async () => {
  withVideoTable();
  const { sb, deps } = await boot();
  deps.generators.videoModels = () => [{ id: 'sd-25-1080p', usable: false }, { id: 'wan-22-1080p', usable: true }];
  const s = sb.addShot({ title: 'h', duration: 5 });
  sb.ensureImageNode(s);
  const gen = sb.ensureVideoNode(s);
  assert.equal(gen.data.draft.model, 'wan-22-1080p', '跳过声明不可用项');
  assert.equal(gen.data.draft.intent, 'i2v');
  deps.generators.videoModels = () => [];
  const s2 = sb.addShot({ title: 'h2', duration: 5 });
  assert.throws(() => sb.ensureVideoNode(s2), /无可用视频型号/);
  deps.generators.videoModels = () => ['ghost-model'];
  const s3 = sb.addShot({ title: 'h3', duration: 5 });
  assert.throws(() => sb.ensureVideoNode(s3), /能力信息缺失|未验证/);
});

test('wireShotAssets：单图模式只允许 1 张；frames 锚点外仅余 1 位', async () => {
  withVideoTable();
  const { sb, store, assets } = await boot();
  try {
    setAvailableModels(['wan-21-720p']);   // i2v：refs 口已被锚点占满
    const s = sb.addShot({ title: 'wan', duration: 5 });
    sb.ensureImageNode(s); sb.ensureVideoNode(s);
    const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
    sb.updateShot(s.id, { assetIds: [a.id] });
    const r = sb.wireShotAssets(s.id);
    assert.equal(r.wired, 0);
    assert.ok(r.problems.some(p => /容量|上限|恰好/.test(p)), JSON.stringify(r.problems));
    assert.equal(store.project.edges.filter(e => e.to.node === s.nodeId).length, 1, '不得新增第二条输入边');
    // h3 frames：锚点占 1，余 1 位；两图整批拒绝
    setAvailableModels(['minimax-h3-768p-per-second']);
    const s2 = sb.addShot({ title: 'h3', duration: 5 });
    sb.ensureImageNode(s2); sb.ensureVideoNode(s2);
    const f1 = await assets.registerBlob(file('f1.png', 'image/png'), 'f1.png', 'image');
    const f2 = await assets.registerBlob(file('f2.png', 'image/png'), 'f2.png', 'image');
    sb.updateShot(s2.id, { assetIds: [f1.id, f2.id] });
    const r2 = sb.wireShotAssets(s2.id);
    assert.equal(r2.wired, 0, '超 frames 容量 → 整批拒绝');
    assert.equal(store.project.edges.filter(e => e.to.node === s2.nodeId && e.to.port === 'frames').length, 1);
    sb.updateShot(s2.id, { assetIds: [f1.id] });
    assert.equal(sb.wireShotAssets(s2.id).wired, 1);
    assert.equal(store.project.edges.filter(e => e.to.node === s2.nodeId && e.to.port === 'frames').length, 2);
  } finally { setAvailableModels(null); }
});

test('wireShotAssets：非法类型/缺失引用/重复连线显式处理，整批原子', async () => {
  withVideoTable();
  const { sb, store, assets } = await boot();
  try {
    setAvailableModels(['sd-25-1080p']);   // sd25 + 锚点 → intent refs
    const s = sb.addShot({ title: 'sd', duration: 6 });
    sb.ensureImageNode(s); sb.ensureVideoNode(s);
    const v = await assets.registerBlob(file('v.mp4', 'video/mp4'), 'v.mp4', 'video');
    const au = await assets.registerBlob(new Blob(['x'], { type: 'audio/mpeg' }), 'm.mp3', 'audio');
    const i1 = await assets.registerBlob(file('i1.png', 'image/png'), 'i1.png', 'image');
    const bad = await assets.registerBlob(new Blob(['x']), 'd.bin', 'file');
    sb.updateShot(s.id, { assetIds: [i1.id, v.id, au.id, bad.id] });
    const r0 = sb.wireShotAssets(s.id);
    assert.equal(r0.wired, 0, '含 file 类素材 → 整批拒绝，不留半批');
    assert.ok(r0.problems.some(p => /d\.bin/.test(p) && /不能接入/.test(p)));
    assert.equal(store.project.edges.filter(e => e.to.node === s.nodeId && e.to.port === 'refs').length, 1, '只剩锚点边');
    sb.updateShot(s.id, { assetIds: [i1.id, v.id, au.id] });
    const r1 = sb.wireShotAssets(s.id);
    assert.equal(r1.wired, 3);
    assert.deepEqual(r1.problems, []);
    const r2 = sb.wireShotAssets(s.id);
    assert.equal(r2.wired, 0);
    assert.equal(r2.duplicates, 3, '重复接线显式计数，不重复建边');
    // 缺失/失效引用显式报错（含导入残留的空槽位），同样整批拒绝
    const s2 = sb.addShot({ title: 'sd2', duration: 6 });
    sb.ensureImageNode(s2); sb.ensureVideoNode(s2);
    const i2 = await assets.registerBlob(file('i2.png', 'image/png'), 'i2.png', 'image');
    sb.updateShot(s2.id, { assetIds: [i2.id] });
    sb.find(s2.id).assetIds.push('a_ghost', null);
    const r3 = sb.wireShotAssets(s2.id);
    assert.equal(r3.wired, 0);
    assert.equal(r3.problems.length, 2);
    assert.ok(r3.problems.every(p => /不存在|缺失/.test(p)));
  } finally { setAvailableModels(null); }
});

test('wireShotAssets：图片节点目标只接受图片', async () => {
  withVideoTable();
  const { sb, assets } = await boot();
  const s = sb.addShot({ title: 'img-only', duration: 5 });
  sb.ensureImageNode(s);
  const v = await assets.registerBlob(file('v.mp4', 'video/mp4'), 'v.mp4', 'video');
  const i = await assets.registerBlob(file('i.png', 'image/png'), 'i.png', 'image');
  sb.updateShot(s.id, { assetIds: [i.id, v.id] });
  const r = sb.wireShotAssets(s.id);
  assert.equal(r.wired, 0);
  assert.ok(r.problems.some(p => /v\.mp4/.test(p)));
  sb.updateShot(s.id, { assetIds: [i.id] });
  assert.equal(sb.wireShotAssets(s.id).wired, 1);
});

test('同步与版本恢复不抹掉 params.shotId；healShotLinks 回填导入丢失', async () => {
  const { sb, store } = await boot();
  const { shots } = sb.createGrid(4);
  const s = shots[0];
  const gen = sb.ensureVideoNode(s);
  assert.equal(store.node(s.imageNodeId).data.params.shotId, s.id);
  assert.equal(gen.data.params.shotId, s.id);
  sb.updateShot(s.id, { imagePrompt: 'P', videoPrompt: 'V', description: 'd1' });
  sb.syncShotToNodes(s.id);
  assert.equal(store.node(s.imageNodeId).data.params.shotId, s.id);
  assert.equal(gen.data.params.shotId, s.id);
  store.updateNodeData(s.imageNodeId, { prompt: 'Q' });
  sb.syncShotFromNodes(s.id);
  assert.equal(store.node(s.imageNodeId).data.params.shotId, s.id);
  sb.updateShot(s.id, { description: 'd2' });
  sb.restoreVersion(s.id, 0);
  assert.equal(store.node(s.imageNodeId).data.params.shotId, s.id);
  assert.equal(gen.data.params.shotId, s.id);
  delete store.node(s.imageNodeId).data.params.shotId;
  delete gen.data.params.shotId;
  assert.equal(sb.healShotLinks(), 2);
  assert.equal(store.node(s.imageNodeId).data.params.shotId, s.id);
  assert.equal(gen.data.params.shotId, s.id);
});

test('跨项目导入后分镜↔节点链接保持（shot.id 稳定 + shotId 可回填）', async () => {
  const { sb, store } = await boot();
  const { shots } = sb.createGrid(4);
  const s = shots[0];
  sb.ensureVideoNode(s);
  const text = await store.exportJSON();
  const p2 = await store.importJSON(text);
  const s2 = p2.studio.shots.find(x => x.id === s.id);
  assert.ok(s2, '分镜 id 导入后保持稳定');
  const img2 = p2.nodes.find(n => n.id === s2.imageNodeId);
  assert.equal(img2?.data?.params?.shotId, s2.id, '图片节点 params.shotId 随导入保留');
  sb.healShotLinks();   // core 暂丢 gen params.shotId → 分镜侧按权威链接回填
  const gen2 = p2.nodes.find(n => n.id === s2.nodeId);
  assert.equal(gen2?.data?.params?.shotId, s2.id);
});

test('素材：导演台 KV 内嵌资源与任务快照计入引用扫描', async () => {
  const { assets, store, storage } = await boot();
  const dir = store.addNode('director', 0, 0, { title: '导演台' });
  const glb = await assets.registerBlob(new Blob(['g'], { type: 'model/gltf-binary' }), 's.glb', 'file', { fromDirector: dir.id });
  assert.ok((await assets.assetRefs(glb.id)).some(r => r.type === 'director'), 'fromDirector 来源节点在 → 保守视为场景引用');
  assert.equal(await assets.removeAsset(glb.id), false);
  const tex = await assets.registerBlob(new Blob(['t'], { type: 'image/png' }), 'tex.png', 'image');
  await storage.set(`dir:${dir.id}:scene`, { layers: [{ src: `xp-asset://${tex.id}` }] });
  assert.equal(await assets.removeAsset(tex.id), false, 'KV 内 xp-asset 引用阻断删除');
  const ref = await assets.registerBlob(new Blob(['c'], { type: 'image/png' }), 'ref.png', 'image');
  await store.savePendingCreate({ idempotencyKey: 'k1', model: 'm', snapshot: { refIds: [ref.id] } });
  assert.ok((await assets.assetRefs(ref.id)).some(r => r.type === 'pending'));
  assert.equal(await assets.removeAsset(ref.id), false);
});

test('素材：force 墓碑保留显式缺失引用，可重绑恢复、再删彻底移除', async () => {
  const { assets, store, storage, sb } = await boot();
  const a = await assets.registerBlob(file('a.png', 'image/png'), 'a.png', 'image');
  const gen = store.addNode('gen', 0, 0, { draft: { model: 'm', prompt: '@图片1', intent: 'refs', seconds: 5, ratio: '16:9', switches: {}, bindings: { 'image:1': a.id } }, perModel: {} });
  const shot = sb.addShot({ title: 's1' });
  sb.updateShot(shot.id, { assetIds: [a.id] });
  assert.equal(await assets.removeAsset(a.id, { force: true }), true);
  const tomb = store.project.assets[a.id];
  assert.equal(tomb.missing, true);
  assert.ok(tomb.deletedAt > 0);
  assert.equal(store.node(gen.id).data.draft.bindings['image:1'], a.id, '绑定保留原 id 成为显式失效引用，不静默改指');
  assert.deepEqual(sb.find(shot.id).assetIds, [a.id], '分镜引用槽位保留为显式缺失');
  assert.equal(await storage.getBlob(`blob:${a.id}`), undefined);
  const rb = await assets.rebindFile(a.id, file('a2.png', 'image/png', 16));
  assert.equal(rb?.id, a.id);
  assert.equal(store.project.assets[a.id].missing, false);
  assert.equal(store.project.assets[a.id].deletedAt, undefined);
  assert.equal(await assets.removeAsset(a.id, { force: true }), true);   // 仍被引用 → 回到墓碑
  assert.equal(store.project.assets[a.id]?.missing, true);
  assert.equal(await assets.removeAsset(a.id, { force: true }), true);   // 墓碑上再删 → 彻底移除
  assert.equal(store.project.assets[a.id], undefined);
  assert.equal(store.node(gen.id).data.draft.bindings['image:1'], a.id, '彻底移除后绑定仍指原 id=显式缺失');
  assert.deepEqual(sb.find(shot.id).assetIds, [a.id]);
});

test('rebindFile：写入期间切项目 → 回滚原 blob 不污染同名素材', async () => {
  const { assets, store, storage } = await boot();
  const a = await assets.registerBlob(file('old.png', 'image/png', 32), 'old.png', 'image');
  const origSet = storage.setBlob.bind(storage);
  let switched = false;
  storage.setBlob = async (k, v) => {
    if (!switched) { switched = true; await store.newProject('另一项目'); }
    return origSet(k, v);
  };
  const r = await assets.rebindFile(a.id, file('new.png', 'image/png', 128));
  storage.setBlob = origSet;
  assert.equal(r, null);
  const blob = await storage.getBlob(`blob:${a.id}`);
  assert.equal(blob.size, 32, '项目切换后原 blob 已回滚');
});

// ---- WO-B4a：导入时长保真（不静默取整/夹逼；非法值带标记，修正前不能建视频节点）----

test('时长保真：文本/JSON 非法时长保留原值并打标记，合法时长无标记', async () => {
  const { sb } = await boot();
  const [a, b, c] = sb.fromScript('1. 空镜 45秒\n2. 快闪 3.5秒\n3. 正常 8秒');
  assert.equal(a.duration, 45);
  assert.equal(a.durationInvalid, true);
  assert.equal(a.durationRaw, '45秒');
  assert.equal(b.duration, 3.5);
  assert.equal(b.durationInvalid, true);
  assert.equal(b.durationRaw, '3.5秒');
  assert.equal(c.duration, 8);
  assert.equal(c.durationInvalid, undefined);
  assert.equal(c.durationRaw, undefined);
  const [j] = sb.fromScript('[{"title":"x","duration":3.5},{"title":"y","duration":45},{"title":"z","duration":10}]');
  assert.equal(j.duration, 3.5);
  assert.equal(j.durationInvalid, true);
  assert.equal(j.durationRaw, 3.5);
});

test('时长保真：addShot/updateShot 拒绝非法时长而非改写；修正后清除标记', async () => {
  const { sb } = await boot();
  assert.throws(() => sb.addShot({ title: 'bad', duration: 45 }), /整数秒/);
  assert.throws(() => sb.addShot({ title: 'bad2', duration: 3.5 }), /整数秒/);
  const s = sb.addShot({ title: 'ok', duration: 5 });
  assert.throws(() => sb.updateShot(s.id, { duration: 45 }), /整数秒/);
  assert.equal(sb.find(s.id).duration, 5, '被拒的写入不得改动原值');
  // 导入路径：显式携带标记则保留原值
  const s2 = sb.addShot({ title: 'imp', duration: 45, durationInvalid: true, durationRaw: '45秒' });
  assert.equal(sb.find(s2.id).duration, 45);
  assert.equal(sb.find(s2.id).durationInvalid, true);
  sb.updateShot(s2.id, { duration: 8 });
  assert.equal(sb.find(s2.id).duration, 8);
  assert.equal(sb.find(s2.id).durationInvalid, undefined, '合法修正后标记清除');
  assert.equal(sb.find(s2.id).durationRaw, undefined);
});

test('时长保真：非法时长分镜建视频节点显式失败，不留节点', async () => {
  withVideoTable();
  const { sb, store } = await boot();
  try {
    setAvailableModels(['sd-25-1080p']);
    const [s] = sb.fromScript('1. 空镜 45秒');
    assert.throws(() => sb.ensureVideoNode(s), /时长.*无效|整数秒/);
    assert.equal(s.nodeId, null);
    assert.equal(store.project.nodes.filter(n => n.type === 'gen').length, 0, '失败不得残留 gen 节点');
    sb.updateShot(s.id, { duration: 8 });
    const gen = sb.ensureVideoNode(s);
    assert.equal(gen.data.draft.seconds, 8);
  } finally { setAvailableModels(null); }
});

test('时长保真：导出→导入往返保留原值与标记；合法分镜不带标记', async () => {
  const { sb, store } = await boot();
  const [a] = sb.fromScript('1. 空镜 45秒');
  const [b] = sb.fromScript('2. 正常 8秒');
  const text = await store.exportJSON();
  const p2 = await store.importJSON(text);
  const a2 = p2.studio.shots.find(x => x.id === a.id);
  const b2 = p2.studio.shots.find(x => x.id === b.id);
  assert.equal(a2.duration, 45, '非法时长不被导入夹逼');
  assert.equal(a2.durationInvalid, true);
  assert.equal(a2.durationRaw, '45秒');
  assert.equal(b2.duration, 8);
  assert.equal(b2.durationInvalid, undefined);
});
