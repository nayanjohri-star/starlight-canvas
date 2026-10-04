// 分镜成片按序入轨（C3，合同 §6.3 + 裁决15）：预览零请求、内容级判重、
// 冲突清单、计划签名过期、全或无应用、≤10 上限、导出序列正确。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createEditor } from '../src/editor.js';
import { studioState } from '../src/studio-schema.js';
import { createTimeline } from '../src/timeline.js';
import { laneClips, laneEnd, clipFromAsset, normalizeTimeline, toEDL } from '../src/export-project.js';

const storageOf = new WeakMap();

async function fixture() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('分镜入轨测试');
  storageOf.set(store, storage);
  const tl = createTimeline({ store, storage, editor: createEditor(store) });
  return { store, storage, tl };
}
// 0.5：入轨必须显式选择分镜（空选择不代表全部）——测试按分镜数组显式传入全部 id
const ids = store => studioState(store.project).shots.map(s => s.id);
// shot+gen节点+视频素材 三段装配；i 决定标题与素材 id
async function addShot(store, i, { duration = 5, withNode = true, withOutput = true, missingAsset = false } = {}) {
  const assetId = `av${i}`;
  const bytes = new Uint8Array(100 + i);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112]);
  await storageOf.get(store).setBlob(`blob:${assetId}`, new Blob([bytes], { type: 'video/mp4' }));
  store.project.assets[assetId] = {
    id: assetId, name: `镜头${i}.mp4`, kind: 'video', mime: 'video/mp4',
    size: 100 + i, addedAt: i, durationSeconds: duration,
    ...(missingAsset ? { missing: true } : {}),
  };
  let nodeId = null;
  if (withNode) {
    const n = store.addNode('gen', i * 100, 0, withOutput ? { outputAssetIds: [assetId] } : {});
    nodeId = n.id;
  }
  const shot = {
    id: `s${i}`, title: `镜头${i}`, duration,
    nodeId, imageNodeId: null, assetIds: [], versions: [],
    createdAt: i, updatedAt: i,
  };
  studioState(store.project).shots.push(shot);
  return shot;
}

test('preview：10 镜按分镜顺序解析成片/双时长/零冲突', async () => {
  const { store, tl } = await fixture();
  for (let i = 1; i <= 10; i++) await addShot(store, i, { duration: i });
  const r = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 10);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.total, 10);
  assert.deepEqual(r.items.map(x => x.shotId), ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
  assert.equal(r.items[0].assetId, 'av1');
  assert.equal(r.items[0].sourceDuration, 1);     // asset.durationSeconds
  assert.equal(r.items[0].expectedDuration, 1);   // shot.duration
  assert.equal(r.plan.dup, false);
  assert.ok(r.plan.sig);
});

test('apply：按序排列到 v1 轨尾、时长取素材、单次 mutate 可整体撤销', async () => {
  const { store, tl } = await fixture();
  for (let i = 1; i <= 3; i++) await addShot(store, i, { duration: i * 2 });
  const { plan } = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  const res = await tl.applyTimelinePlan(plan);
  assert.equal(res.ok, true);
  assert.equal(res.clips.length, 3);
  const v1 = laneClips(tl.clips(), 'v1');
  assert.deepEqual(v1.map(c => c.assetId), ['av1', 'av2', 'av3']);
  // 顺序首尾相接：c1.end === c2.start
  assert.equal(v1[0].end, v1[1].start);
  assert.equal(v1[1].end, v1[2].start);
  assert.equal(v1[0].start, 0);
  assert.equal(v1[2].end, 12);                    // 2+4+6
  assert.deepEqual(v1.map(c => c.sourceDuration), [2, 4, 6]);
});

test('冲突清单：无节点/无成片/素材缺失分别标注；默认整批阻止，显式「仅可用」才部分加入并列出略过项', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1, { withNode: false });              // 未关联视频节点
  await addShot(store, 2, { withOutput: false });            // 节点尚无成片
  await addShot(store, 3, { missingAsset: true });           // 素材 missing
  await addShot(store, 4, {});                               // 正常
  const r = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  assert.equal(r.ok, false, '部分镜头不可用 → 默认整批阻止');
  assert.equal(r.blocked, true);
  assert.equal(r.plan, undefined, '阻止时不签发计划');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].shotId, 's4');
  assert.equal(r.conflicts.length, 3);
  assert.match(r.conflicts[0].reason, /未关联视频节点/);
  assert.match(r.conflicts[1].reason, /尚无成片|缺失/);
  assert.match(r.conflicts[2].reason, /缺失|尚无成片/);
  const partial = await tl.previewShotsToTimeline({ shotIds: ids(store), allowPartial: true });
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.plan.omitted.map(o => o.shotId), ['s1', 's2', 's3'], '显式部分加入时列出略过清单');
  const applied = await tl.applyTimelinePlan(partial.plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.omitted.length, 3);
  assert.deepEqual(laneClips(tl.clips(), 'v1').map(c => c.assetId), ['av4']);
  // 全部冲突 → 不建
  studioState(store.project).shots.length = 0;
  await addShot(store, 9, { withNode: false });
  const r2 = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  assert.equal(r2.ok, false);
  assert.equal(r2.items.length, 0);
});

test('判重：轨尾同序列重复确认被拒绝；「再次插入」走新 plan 可重复', async () => {
  const { store, tl } = await fixture();
  for (let i = 1; i <= 3; i++) await addShot(store, i);
  const p1 = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  assert.equal((await tl.applyTimelinePlan(p1.plan)).ok, true);
  assert.equal(tl.clips().length, 3);
  // 同一预览再确认 → 计划已消费 → 拒绝
  const again = await tl.applyTimelinePlan(p1.plan);
  assert.equal(again.ok, false);
  assert.match(again.reason, /已经加入过/);
  // 新预览检测到轨尾同序列 → dup 标记 + apply 拒绝
  const p2 = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  assert.equal(p2.plan.dup, true);
  const r2 = await tl.applyTimelinePlan(p2.plan);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /重复|再次插入/);
  assert.equal(tl.clips().length, 3);            // 零新增
  // 显式「再次插入」→ allowDuplicate 新 plan → 应用成功且真重复
  const p3 = await tl.previewShotsToTimeline({ shotIds: ids(store), allowDuplicate: true });
  assert.equal(p3.plan.dup, true);
  assert.equal(p3.plan.allowDup, true);
  const r3 = await tl.applyTimelinePlan(p3.plan);
  assert.equal(r3.ok, true);
  assert.equal(tl.clips().length, 6);
  assert.deepEqual(laneClips(tl.clips(), 'v1').map(c => c.assetId),
    ['av1', 'av2', 'av3', 'av1', 'av2', 'av3']);
});

test('判重只锚定轨尾：尾部追加过其他片段后同序列可正常插入', async () => {
  const { store, tl } = await fixture();
  for (let i = 1; i <= 2; i++) await addShot(store, i);
  const p1 = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  await tl.applyTimelinePlan(p1.plan);
  // 用户在轨尾又手动加了一个别的片段 → 轨尾不再是同序列
  store.project.assets['other'] = { id: 'other', name: 'o.mp4', kind: 'video', mime: 'video/mp4', size: 1, durationSeconds: 3 };
  tl.clips().push(clipFromAsset(store.project.assets.other, 'v1', { start: laneEnd(tl.clips(), 'v1'), len: 3 }));
  const p2 = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  assert.equal(p2.plan.dup, false);
  assert.equal((await tl.applyTimelinePlan(p2.plan)).ok, true);
  assert.equal(laneClips(tl.clips(), 'v1').length, 5);
});

test('计划签名：预览后轨尾/项目变化 → 应用拒绝', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1);
  const { plan } = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  // 预览后用户往 v1 塞了别的片段 → 签名失配
  store.project.assets['x'] = { id: 'x', name: 'x.mp4', kind: 'video', mime: 'video/mp4', size: 1 };
  tl.clips().push(clipFromAsset(store.project.assets.x, 'v1', { start: 0, len: 2 }));
  const r = await tl.applyTimelinePlan(plan);
  assert.equal(r.ok, false);
  assert.match(r.reason, /过期/);
  assert.equal(tl.clips().length, 1);
});

test('全或无：预览后素材缺失 → 整批放弃不部分写入', async () => {
  const { store, tl } = await fixture();
  for (let i = 1; i <= 3; i++) await addShot(store, i);
  const { plan } = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  delete store.project.assets['av2'];             // 预览后素材没了
  // 素材指纹入 sig：删除即 'gone' → sig 失配按「过期」拒（逐项缺失检查仍作纵深保留）
  const r = await tl.applyTimelinePlan(plan);
  assert.equal(r.ok, false);
  assert.equal(tl.clips().length, 0);
});

test('≤10 上限：超过单批上限明确失败，不静默截断', async () => {
  const { store, tl } = await fixture();
  for (let i = 1; i <= 12; i++) await addShot(store, i);
  const r = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_many');
  assert.equal(r.items.length, 0);
  assert.equal(r.total, 12);
  assert.match(r.reason, /最多加入 10 个/);
});

test('shotIds 子集：顺序仍按分镜数组序而非传入序', async () => {
  const { store, tl } = await fixture();
  for (let i = 1; i <= 4; i++) await addShot(store, i);
  const r = await tl.previewShotsToTimeline({ shotIds: ['s3', 's1'] });
  assert.deepEqual(r.items.map(x => x.shotId), ['s1', 's3']);   // 分镜序优先
});

test('导出正确性：入轨片段过 normalizeTimeline 与 EDL 序列保持分镜序', async () => {
  const { store, tl } = await fixture();
  for (let i = 1; i <= 3; i++) await addShot(store, i, { duration: 4 });
  const { plan } = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  await tl.applyTimelinePlan(plan);
  const { clips: nc } = normalizeTimeline(tl.clips(), { assets: store.project.assets });
  const v1 = laneClips(nc, 'v1');
  assert.deepEqual(v1.map(c => c.assetId), ['av1', 'av2', 'av3']);
  assert.equal(v1[0].sourceDuration, 4);
  const edl = toEDL(nc, { title: 'T', fps: 30, assets: store.project.assets });
  const i1 = edl.indexOf('镜头1.mp4'), i2 = edl.indexOf('镜头2.mp4'), i3 = edl.indexOf('镜头3.mp4');
  assert.ok(i1 > -1 && i1 < i2 && i2 < i3, 'EDL 事件顺序与分镜一致');
});

test('空分镜 / 空选择：预览明确拒绝，不回落为「全部」', async () => {
  const { store, tl } = await fixture();
  const r = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'empty_selection');
  assert.equal(r.items.length, 0);
  await addShot(store, 1);
  for (const shotIds of [undefined, []]) {
    const e = await tl.previewShotsToTimeline({ shotIds });
    assert.equal(e.ok, false, '已有分镜时空选择也不代表全部');
    assert.equal(e.code, 'empty_selection');
  }
});

test('lane 校验（G3-M3）：非法 track 预览即拒；plan.lane 篡改后 apply 拒', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1);
  const r = await tl.previewShotsToTimeline({ track: 'bogus' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /非法目标轨/);
  assert.equal(r.items.length, 0);
  // 同对象改 lane → 非签发问题，lane 校验先于签发拦下
  const p = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  p.plan.lane = 'bogus';
  const rr = await tl.applyTimelinePlan(p.plan);
  assert.equal(rr.ok, false);
  assert.match(rr.reason, /非法目标轨/);
  assert.equal(tl.clips().length, 0);
});

test('计划过期（G3-M2）：改分镜字段/重绑节点/素材同 id 重绑 → apply 拒', async () => {
  { // F2a：shot.duration 变化
    const { store, tl } = await fixture();
    const s = await addShot(store, 1, { duration: 4 });
    const { plan } = await tl.previewShotsToTimeline({ shotIds: ids(store) });
    s.duration = 20;
    const r = await tl.applyTimelinePlan(plan);
    assert.equal(r.ok, false);
    assert.match(r.reason, /过期/);
    assert.equal(tl.clips().length, 0);
  }
  { // F2b：nodeId 重绑到输出另一素材的节点 → 不得插入旧素材
    const { store, tl } = await fixture();
    const s = await addShot(store, 1);
    const { plan } = await tl.previewShotsToTimeline({ shotIds: ids(store) });
    store.project.assets['avNEW'] = { id: 'avNEW', name: 'n.mp4', kind: 'video', mime: 'video/mp4', size: 1, durationSeconds: 9 };
    s.nodeId = store.addNode('gen', 999, 0, { outputAssetIds: ['avNEW'] }).id;
    const r = await tl.applyTimelinePlan(plan);
    assert.equal(r.ok, false);
    assert.match(r.reason, /过期/);
    assert.equal(tl.clips().length, 0);
  }
  { // F2c：同 id 素材重绑（时长/revision 变）→ 不得以陈旧时长入轨
    const { store, tl } = await fixture();
    await addShot(store, 1, { duration: 5 });
    const { plan } = await tl.previewShotsToTimeline({ shotIds: ids(store) });
    store.project.assets['av1'] = { id: 'av1', name: '镜头1.mp4', kind: 'video', mime: 'video/mp4',
      size: 1, durationSeconds: 12, contentRevision: 2 };
    const r = await tl.applyTimelinePlan(plan);
    assert.equal(r.ok, false);
    assert.match(r.reason, /过期/);
    assert.equal(tl.clips().length, 0);
  }
});

test('签发与篡改（G3-m1）：伪造 plan 对象拒；同对象改 items 字段拒', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1);
  const p = await tl.previewShotsToTimeline({ shotIds: ids(store) });
  // 复制对象改字段 → 非签发对象（WeakSet）
  const forged = { ...p.plan, items: p.plan.items.map(i => ({ ...i, sourceDuration: 99 })) };
  const r1 = await tl.applyTimelinePlan(forged);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /未经预览签发/);
  // 同对象改 items 字段 → 签发校验过但 sig 失配
  p.plan.items[0].sourceDuration = 99;
  const r2 = await tl.applyTimelinePlan(p.plan);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /过期/);
  assert.equal(tl.clips().length, 0);
});

test('接线静态断言：timeline.js 暴露 C3 接口与判重语义', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/timeline.js', import.meta.url), 'utf8');
  assert.match(src, /previewShotsToTimeline/);
  assert.match(src, /applyTimelinePlan/);
  assert.match(src, /shotSeqDuplicate/);
  assert.match(src, /再次插入/);
  assert.match(src, /SHOTS_TL_MAX = 10/);
});
