// WO-B2 分镜预览建图（§6.3）：previewShotWorkflow/applyShotWorkflow。
// 验收面：三模板计划形态、复用既有链接、conflicts 只列不改、durationInvalid 拦截、
// sig 失效（改分镜/切项目/改素材）、全或无应用、重复 apply 幂等、预览零副作用。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { setCapabilities } from '../src/capabilities.js';
import { createAssets } from '../src/assets.js';
import { createStoryboards } from '../src/storyboard.js';
import { setAvailableModels } from '../src/keyvault.js';

const VM = (family, min, max, extra = {}) => ({
  family, seconds: { min, max }, ratios: { options: ['16:9', '9:16', '1:1'] },
  prompt_max_characters: 2000,
  reference_limits: { image: 9, video: 3, audio: 3, total: 9 },
  switches: { generate_audio: true, face_mode: true },
  price_cny_per_second: 0.2, ...extra,
});
const TABLE = {
  models: {
    'minimax-h3-768p-per-second': VM('h3', 1, 10),
    'sd-25-1080p': VM('sd25', 1, 16),
    'wan-21-720p': VM('wan', 3, 8),
  },
  upload_limits: {
    image: { content_types: ['image/png'], max_mib: 1 },
    video: { content_types: ['video/mp4'], max_mib: 10 },
    audio: { content_types: ['audio/mpeg'], max_mib: 5 },
  },
};

async function boot() {
  setCapabilities(TABLE);
  setAvailableModels(null);
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('建图验收');
  const assets = createAssets({ store, storage, api: { uploadAsset: async () => { throw new Error('未接入'); } } });
  const genCalls = [];
  const deps = {
    store, storage, assets,
    board: { select: () => {} },
    generators: {
      generate: async n => { genCalls.push(n.id); },
      videoModels: () => Object.keys(TABLE.models).map(id => ({ id, usable: true })),
      imageModels: () => [{ id: 'img-1', usable: true }],
      textModels: () => [{ id: 't-1', usable: true }],
    },
    workflow: null,
    onUpdate() {},
  };
  return { store, storage, assets, deps, genCalls, sb: createStoryboards(deps) };
}
const addAsset = (store, id, kind, extra = {}) => {
  store.project.assets[id] = { id, kind, name: `${id}.${kind}`, size: 64, ...extra };
  return store.project.assets[id];
};
const nodeCount = store => store.project.nodes.length;

test('t2v：预览只规划不建图（零副作用零生成），应用后按 spec 建纯文字 gen', async () => {
  const { sb, store, genCalls } = await boot();
  const shots = sb.fromScript('1. 空镜 5秒\n2. 特写 8秒\n3. 远景 6秒');
  const before = nodeCount(store);
  const r = sb.previewShotWorkflow({ shotIds: shots.map(s => s.id), template: 't2v' });
  assert.equal(nodeCount(store), before, '预览不得改动画布');
  assert.equal(genCalls.length, 0, '预览不得发起生成');
  assert.equal(r.ok, true);
  assert.equal(r.plan.creates.length, 3);
  assert.equal(r.plan.edges.length, 0);
  assert.equal(r.plan.reuses.length, 0);
  assert.equal(r.plan.conflicts.length, 0);
  assert.equal(typeof r.sig, 'string');
  const res = sb.applyShotWorkflow(r.plan);
  assert.equal(res.nodes.length, 3);
  const gens = store.project.nodes.filter(n => n.type === 'gen');
  assert.equal(gens.length, 3);
  for (const s of shots) {
    const g = store.node(s.nodeId);
    assert.ok(g, '分镜应链接到新建 gen');
    assert.equal(g.data.draft.intent, 'text');
    assert.equal(g.data.draft.seconds, s.duration);
  }
  assert.equal(genCalls.length, 0, '应用建图不得发起生成');
  await store.flush();
});

test('i2v：建图片+视频节点并按 family 端口连线；复用既有分镜节点不复制', async () => {
  const { sb, store } = await boot();
  const [s1, s2] = sb.fromScript('1. 空镜 5秒\n2. 特写 8秒');
  // s2 预置既有图片/视频节点 → 复用不复制
  sb.ensureImageNode(s2);
  const existingImg = s2.imageNodeId;
  const existingVid = sb.ensureVideoNode(s2).id;
  const r = sb.previewShotWorkflow({ shotIds: [s1.id, s2.id], template: 'i2v' });
  assert.equal(r.ok, true);
  // s1：video+image 各一；s2：video 复用（image 也复用）→ creates 只有 s1 的两个
  assert.equal(r.plan.creates.length, 2);
  assert.deepEqual(r.plan.creates.map(c => c.role).sort(), ['image', 'video']);
  assert.ok(r.plan.reuses.some(x => x.nodeId === existingVid && x.role === 'video'));
  assert.ok(r.plan.reuses.some(x => x.nodeId === existingImg && x.role === 'image'));
  assert.equal(r.plan.edges.length, 2, '两个分镜各一条锚点连线');
  const res = sb.applyShotWorkflow(r.plan);
  const g1 = store.node(s1.nodeId), i1 = store.node(s1.imageNodeId);
  assert.ok(g1 && i1);
  assert.equal(g1.data.draft.intent, 'frames', 'H3 单图方案接首帧');
  assert.ok(store.project.edges.some(e => e.from.node === i1.id && e.to.node === g1.id && e.to.port === 'frames'));
  // s2 复用节点：只补缺失连线，不复制节点
  assert.equal(s2.nodeId, existingVid);
  assert.equal(s2.imageNodeId, existingImg);
  await store.flush();
});

test('ref：素材节点→refs 连线；未绑定素材/素材缺失 → conflicts 不建', async () => {
  const { sb, store } = await boot();
  const a = addAsset(store, 'a1', 'image');
  const [s1, s2] = sb.fromScript('1. 空镜 5秒\n2. 特写 8秒');
  sb.updateShot(s1.id, { assetIds: ['a1'] });
  const r = sb.previewShotWorkflow({ shotIds: [s1.id, s2.id], template: 'ref' });
  assert.equal(r.ok, false, 's2 无素材 → 冲突');
  assert.ok(r.plan.conflicts.some(c => c.shotId === s2.id && /素材参考模板需要/.test(c.reason)));
  // 修正 s2 绑定后重预览
  sb.updateShot(s2.id, { assetIds: ['a1'] });
  const r2 = sb.previewShotWorkflow({ shotIds: [s1.id, s2.id], template: 'ref' });
  assert.equal(r2.ok, true);
  // 同一素材被两个分镜引用 → 只计划一个素材节点
  assert.equal(r2.plan.creates.filter(c => c.role === 'asset').length, 1);
  assert.equal(r2.plan.edges.filter(e => e.fromAssetId === 'a1').length, 2);
  const res = sb.applyShotWorkflow(r2.plan);
  const assetNodes = store.project.nodes.filter(n => n.type === 'asset' && n.data.assetId === 'a1');
  assert.equal(assetNodes.length, 1, '共享素材只建一个素材节点');
  for (const s of [s1, s2]) {
    const g = store.node(s.nodeId);
    assert.equal(g.data.draft.intent, 'refs');
    assert.ok(store.project.edges.some(e => e.from.node === assetNodes[0].id && e.to.node === g.id && e.to.port === 'refs'));
  }
  await store.flush();
});

test('全或无：durationInvalid 分镜列 conflicts，apply 拒绝且零节点残留', async () => {
  const { sb, store } = await boot();
  const [bad, good] = sb.fromScript('1. 空镜 45秒\n2. 特写 8秒');
  assert.equal(bad.durationInvalid, true);
  const r = sb.previewShotWorkflow({ shotIds: [bad.id, good.id], template: 't2v' });
  assert.equal(r.ok, false);
  assert.ok(r.plan.conflicts.some(c => c.shotId === bad.id && /时长无效/.test(c.reason)));
  assert.equal(r.plan.creates.length, 1, '合法分镜仍在计划中列出');
  const before = nodeCount(store);
  assert.throws(() => sb.applyShotWorkflow(r.plan), /冲突|未创建/);
  assert.equal(nodeCount(store), before, '任一冲突 → 全部不建');
  assert.equal(good.nodeId, null, '合法分镜也不得半建');
  await store.flush();
});

test('sig 失效：改分镜/改素材引用/素材缺失/切项目 → apply 逐项拒绝', async () => {
  const { sb, store } = await boot();
  const [s] = sb.fromScript('1. 空镜 5秒');
  // 1) 分镜字段变更 → 失效
  let r = sb.previewShotWorkflow({ shotIds: [s.id], template: 't2v' });
  sb.updateShot(s.id, { description: '改了' });
  assert.throws(() => sb.applyShotWorkflow(r.plan), /已变更|重新预览/);
  // 2) 素材引用变更 → 失效
  addAsset(store, 'a1', 'image');
  sb.updateShot(s.id, { assetIds: ['a1'] });
  r = sb.previewShotWorkflow({ shotIds: [s.id], template: 'ref' });
  sb.updateShot(s.id, { assetIds: [] });
  assert.throws(() => sb.applyShotWorkflow(r.plan), /已变更|重新预览/);
  // 3) 素材状态变更（missing）→ 失效
  sb.updateShot(s.id, { assetIds: ['a1'] });
  r = sb.previewShotWorkflow({ shotIds: [s.id], template: 'ref' });
  store.project.assets.a1.missing = true;
  assert.throws(() => sb.applyShotWorkflow(r.plan), /已变更|重新预览/);
  // 4) 切项目 → 拒绝
  store.project.assets.a1.missing = false;
  r = sb.previewShotWorkflow({ shotIds: [s.id], template: 'ref' });
  await store.newProject('另一个项目');
  assert.throws(() => sb.applyShotWorkflow(r.plan), /项目已切换/);
  await store.flush();
});

test('重复 apply 幂等：已建链接不再重复建节点或连线', async () => {
  const { sb, store } = await boot();
  const [s] = sb.fromScript('1. 空镜 5秒');
  const r = sb.previewShotWorkflow({ shotIds: [s.id], template: 'i2v' });
  sb.applyShotWorkflow(r.plan);
  const n1 = nodeCount(store), e1 = store.project.edges.length;
  const again = sb.applyShotWorkflow(r.plan);
  assert.equal(again.nodes.length, 0, '二次应用不得重建节点');
  assert.equal(again.edges.length, 0, '二次应用不得重复连线');
  assert.equal(nodeCount(store), n1);
  assert.equal(store.project.edges.length, e1);
  await store.flush();
});

test('应用失败回滚：连线被拒时本批节点全部撤销且分镜链接还原', async () => {
  const { sb, store } = await boot();
  const [s] = sb.fromScript('1. 空镜 5秒');
  const r = sb.previewShotWorkflow({ shotIds: [s.id], template: 'i2v' });
  // m1 后 plan.edges 为调用方快照、apply 只信签发副本——制造应用期失败须拦截 addEdge
  const origAddEdge = store.addEdge.bind(store);
  store.addEdge = () => null;             // 连线必拒 → 触发回滚
  const before = nodeCount(store);
  try {
    assert.throws(() => sb.applyShotWorkflow(r.plan), /被拒|未应用/);
  } finally { store.addEdge = origAddEdge; }
  assert.equal(nodeCount(store), before, '失败不得残留节点');
  assert.equal(s.nodeId, null);
  assert.equal(s.imageNodeId, null);
  await store.flush();
});

test('conflicts 只列不改：既有节点型号/模式与计划不符 → 列出而非换建', async () => {
  const { sb, store } = await boot();
  const [s] = sb.fromScript('1. 空镜 5秒');
  const gen = sb.ensureVideoNode(s);   // 自动选型 → 列表首个可用 h3
  const chosen = gen.data.draft.model;
  const other = chosen === 'sd-25-1080p' ? 'wan-21-720p' : 'sd-25-1080p';
  const r = sb.previewShotWorkflow({ shotIds: [s.id], template: 't2v', modelId: other });
  assert.equal(r.ok, false);
  assert.ok(r.plan.conflicts.some(c => /不一致/.test(c.reason)), '型号不符只列不换');
  assert.equal(store.node(s.nodeId).data.draft.model, chosen, '既有节点型号不得被改');
  await store.flush();
});

test('入参校验：非法模板/超 20/空选/重复 → 显式拒绝', async () => {
  const { sb } = await boot();
  const shots = sb.fromScript(Array.from({ length: 21 }, (_, i) => `${i + 1}. 镜 ${i + 1} 5秒`).join('\n'));
  const ids = shots.map(s => s.id);
  assert.throws(() => sb.previewShotWorkflow({ shotIds: ids.slice(0, 3), template: 'bad' }), /未知建图模板/);
  assert.throws(() => sb.previewShotWorkflow({ shotIds: ids, template: 't2v' }), /最多 20/);
  assert.throws(() => sb.previewShotWorkflow({ shotIds: [], template: 't2v' }), /请先选择/);
  assert.throws(() => sb.previewShotWorkflow({ shotIds: [ids[0], ids[0]], template: 't2v' }), /重复/);
  const r = sb.previewShotWorkflow({ shotIds: ids.slice(0, 20), template: 't2v' });
  assert.equal(r.ok, true, '20 个分镜恰好在限内');
  const r2 = sb.previewShotWorkflow({ shotIds: [ids[0], 'ghost-id'], template: 't2v' });
  assert.equal(r2.ok, false);
  assert.ok(r2.plan.conflicts.some(c => c.shotId === 'ghost-id' && /不存在/.test(c.reason)));
  await sb.list().length;   // noop keep async
});

// ---------- G3 审查回归（A 审 B）----------

test('签发快照隔离：清空 conflicts/篡改 edges/注入 creates 均不影响签发内容（m1 回归）', async () => {
  const { sb, store } = await boot();
  // a) 调用方清空 conflicts → 签发记录仍在，apply 仍按冲突整体拒绝
  const [bad] = sb.fromScript('1. 空镜 45秒');
  const r0 = sb.previewShotWorkflow({ shotIds: [bad.id], template: 't2v' });
  assert.equal(r0.ok, false);
  r0.plan.conflicts.length = 0;
  assert.throws(() => sb.applyShotWorkflow(r0.plan), /冲突|未创建/);
  assert.equal(bad.nodeId, null);
  // b) 调用方篡改 edges 端口 → 签发快照不受影响，按原计划正常建成
  const [s] = sb.fromScript('1. 特写 8秒');
  const r = sb.previewShotWorkflow({ shotIds: [s.id], template: 'i2v' });
  r.plan.edges[0].port = 'bogus-port';
  const res = sb.applyShotWorkflow(r.plan);
  assert.equal(res.edges.length, 1, '篡改 plan.edges 不生效，按签发内容连线');
  assert.ok(store.node(s.nodeId) && store.node(s.imageNodeId));
  // c) 调用方注入伪造 creates → 只建签发节点，注入被忽略
  const [s2] = sb.fromScript('1. 远景 6秒');
  const r2 = sb.previewShotWorkflow({ shotIds: [s2.id], template: 't2v' });
  const n0 = nodeCount(store);
  r2.plan.creates.push({ shotId: s2.id, role: 'video', nodeSpec: { type: 'gen', x: 0, y: 0, data: { title: '注入' } } });
  sb.applyShotWorkflow(r2.plan);
  assert.equal(nodeCount(store), n0 + 1, '只建签发的一个节点，注入 creates 被忽略');
  await store.flush();
});

test('复用节点既有连线入签名：预览后向复用节点加线 → 计划失效拒绝（m3 回归）', async () => {
  const { sb, store } = await boot();
  const [s] = sb.fromScript('1. 空镜 5秒');
  sb.ensureImageNode(s); sb.ensureVideoNode(s);   // 两节点均复用
  const r = sb.previewShotWorkflow({ shotIds: [s.id], template: 'i2v' });
  assert.equal(r.ok, true);
  // 预览后向复用视频节点的锚点端口再加一条线（占用容量）→ sig 必须失效
  const extra = store.addNode('image', 0, 0, { title: '占位图' });
  store.addEdge(extra.id, 'out', s.nodeId, 'frames', 'image');
  assert.throws(() => sb.applyShotWorkflow(r.plan), /已变更|重新预览/);
  await store.flush();
});
