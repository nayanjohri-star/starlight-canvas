// R05 独立验收：分镜 → 时间线的计划保护（从业务不变量出发编写，不照抄实现）。
//  1. 选择：空选择不代表全部；未知/已删除 id 明确失败，不静默过滤；
//  2. 时长：只用可信实测时长；探测失败列为可重试问题；手动时长须显式提供并二次确认，且不冒充实测；
//  3. 不可用镜头默认整批阻止；显式部分加入须列出略过清单；
//  4. 同一预览计划只能消费一次（含 allowDuplicate）；「再次插入」必须是新计划；
//  5. 预览后分镜内容、素材内容、节点关联、轨道或项目变化 → 旧计划失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createEditor } from '../src/editor.js';
import { studioState } from '../src/studio-schema.js';
import { createTimeline } from '../src/timeline.js';
import { laneClips, clipFromAsset } from '../src/export-project.js';

const storageOf = new WeakMap();

async function fixture() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('R05 入轨');
  storageOf.set(store, storage);
  const tl = createTimeline({ store, storage, editor: createEditor(store) });
  return { store, tl, storage };
}
async function addShot(store, i, { durationSeconds = 4, untrusted = false, shotDuration = 6 } = {}) {
  const id = `av${i}`;
  const bytes = new Uint8Array(100 + i);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112]);
  await storageOf.get(store).setBlob(`blob:${id}`, new Blob([bytes], { type: 'video/mp4' }));
  store.project.assets[id] = { id, name: `镜头${i}.mp4`, kind: 'video', mime: 'video/mp4', size: 100 + i, addedAt: i,
    durationSeconds, ...(untrusted ? { durationUntrusted: true } : {}) };
  const n = store.addNode('gen', i * 100, 0, { outputAssetIds: [id] });
  const s = { id: `s${i}`, title: `镜头${i}`, prompt: `提示${i}`, duration: shotDuration, nodeId: n.id, imageNodeId: null, assetIds: [], versions: [], createdAt: i, updatedAt: i };
  studioState(store.project).shots.push(s);
  return s;
}
const v1 = tl => laneClips(tl.clips(), 'v1');

test('选择：未知或已删除的分镜 id 明确失败，不静默过滤其余', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1); await addShot(store, 2);
  const r = await tl.previewShotsToTimeline({ shotIds: ['s1', 'ghost', 's2'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_shots');
  assert.deepEqual(r.unknownIds, ['ghost']);
  assert.equal(r.plan, undefined);
  studioState(store.project).shots.splice(1, 1);   // 删除 s2
  const r2 = await tl.previewShotsToTimeline({ shotIds: ['s1', 's2'] });
  assert.equal(r2.code, 'unknown_shots');
  assert.equal(v1(tl).length, 0);
});

test('选择：重复 id 被拒；空选择不代表全部', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1);
  assert.equal((await tl.previewShotsToTimeline({ shotIds: ['s1', 's1'] })).code, 'duplicate_ids');
  assert.equal((await tl.previewShotsToTimeline({})).code, 'empty_selection');
  assert.equal((await tl.previewShotsToTimeline({ shotIds: [] })).code, 'empty_selection');
});

test('时长：未标可信的 durationSeconds 不采用；探测失败列为可重试问题，不回落剧本时长或 5 秒', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1, { durationSeconds: 4 });
  await addShot(store, 2, { durationSeconds: 9, untrusted: true, shotDuration: 7 });   // 不可信
  await addShot(store, 3, { durationSeconds: null, shotDuration: 5 });                 // 无实测
  const r = await tl.previewShotsToTimeline({ shotIds: ['s1', 's2', 's3'] });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  const byId = Object.fromEntries(r.conflicts.map(c => [c.shotId, c]));
  assert.equal(byId.s2?.code, 'duration_probe_failed');
  assert.equal(byId.s3?.code, 'duration_probe_failed');
  assert.equal(byId.s2.retryable, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].duration, 4);
  assert.equal(r.items[0].durationSource, 'measured');
  // 「重新探测」：素材随后得到可信实测 → 新预览正常
  store.project.assets.av2.durationUntrusted = false;
  store.project.assets.av3.durationSeconds = 3;
  const again = await tl.previewShotsToTimeline({ shotIds: ['s1', 's2', 's3'] });
  assert.equal(again.ok, true);
  assert.deepEqual(again.items.map(i => i.duration), [4, 9, 3]);
});

test('素材元数据仍在但本机成片缺失时不签发计划；预览后删除文件也不能入轨', async () => {
  const { store, tl, storage } = await fixture();
  await addShot(store, 1, { durationSeconds: 4 });
  const original = await storage.getBlob('blob:av1');
  await storage.delBlob('blob:av1');
  const unavailable = await tl.previewShotsToTimeline({ shotIds: ['s1'] });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.conflicts[0]?.code, 'local_file_missing');
  assert.equal(unavailable.plan, undefined);
  await storage.setBlob('blob:av1', original);
  const ready = await tl.previewShotsToTimeline({ shotIds: ['s1'] });
  assert.equal(ready.ok, true);
  await storage.delBlob('blob:av1');
  const applied = await tl.applyTimelinePlan(ready.plan);
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'local_file_missing');
  assert.equal(v1(tl).length, 0);
});

test('手动时长：须显式提供并在应用时二次确认；片段标记为手动，不写 sourceDuration', async () => {
  const { store, tl, storage } = await fixture();
  await addShot(store, 1, { durationSeconds: null, shotDuration: 5 });
  const r = await tl.previewShotsToTimeline({ shotIds: ['s1'], manualDurations: { s1: 4.5 } });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].durationSource, 'manual');
  assert.equal(r.items[0].sourceDuration, null, '手动时长不冒充实测');
  assert.equal(r.plan.needsManualConfirm, true);
  const unconfirmed = await tl.applyTimelinePlan(r.plan);
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, 'manual_unconfirmed');
  assert.equal(v1(tl).length, 0);
  const ok = await tl.applyTimelinePlan(r.plan, { confirmManual: true });
  assert.equal(ok.ok, true);
  const [c] = v1(tl);
  assert.equal(c.end - c.start, 4.5);
  // 手动时长不得冒充实测：片段不带 sourceDuration，但保留「手动」来源标记（R05-CORE-1 已由核心 74e5682 修复）
  assert.equal(c.sourceDuration, undefined);
  assert.equal(c.durationManual, true);
  // 保存并在另一个 store 中重新打开：来源标记与时长都保留
  await store.flush();
  const reopened = createStore(storage);
  await reopened.openProject(store.project.id);
  const [rc] = laneClips(studioState(reopened.project).timeline, 'v1');
  assert.equal(rc.durationManual, true, '保存/重开后仍可识别手动时长');
  assert.equal(rc.sourceDuration, undefined);
  assert.equal(rc.end - rc.start, 4.5);
  // 非法手动值不被接受
  const bad = await tl.previewShotsToTimeline({ shotIds: ['s1'], manualDurations: { s1: -1 } });
  assert.equal(bad.ok, false);
});

test('单次消费：allowDuplicate 计划在轨尾不变时也不能应用第二次；再次插入须新计划', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1); await addShot(store, 2);
  const p1 = await tl.previewShotsToTimeline({ shotIds: ['s1', 's2'] });
  assert.equal((await tl.applyTimelinePlan(p1.plan)).ok, true);
  // 轨尾已是同一序列 → 显式再次插入的计划
  const dupPlan = await tl.previewShotsToTimeline({ shotIds: ['s1', 's2'], allowDuplicate: true });
  assert.equal(dupPlan.plan.dup, true);
  assert.equal((await tl.applyTimelinePlan(dupPlan.plan)).ok, true);
  assert.equal(v1(tl).length, 4);
  // 此时轨尾仍是同一 assetId 序列——旧实现下签名可能仍然匹配；必须因「已消费」被拒
  const second = await tl.applyTimelinePlan(dupPlan.plan);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'consumed');
  assert.equal(v1(tl).length, 4, '同一确认不得产生第二组片段');
  const p3 = await tl.previewShotsToTimeline({ shotIds: ['s1', 's2'], allowDuplicate: true });
  assert.notEqual(p3.plan, dupPlan.plan);
  assert.equal((await tl.applyTimelinePlan(p3.plan)).ok, true, '新的预览与确认才可再次插入');
  assert.equal(v1(tl).length, 6);
});

test('计划失效：分镜标题/提示词、节点产出、轨道任意片段或项目变化后拒绝应用', async () => {
  for (const [label, mutate] of [
    ['分镜标题', ({ s }) => { s.title = '改名'; }],
    ['分镜提示词', ({ s }) => { s.prompt = '新提示'; }],
    ['节点产出', ({ store, s }) => { store.node(s.nodeId).data.outputAssetIds = []; }],
    ['轨道中部片段', ({ store, tl }) => {
      store.project.assets.x = { id: 'x', name: 'x.mp4', kind: 'video', mime: 'video/mp4', size: 1, durationSeconds: 2 };
      tl.clips().unshift(clipFromAsset(store.project.assets.x, 'v1', { start: 100, len: 2 }));
    }],
  ]) {
    const { store, tl } = await fixture();
    const s = await addShot(store, 1);
    const r = await tl.previewShotsToTimeline({ shotIds: ['s1'] });
    mutate({ store, tl, s });
    const res = await tl.applyTimelinePlan(r.plan);
    assert.equal(res.ok, false, `${label}变化后应拒绝`);
  }
  const { store, tl } = await fixture();
  await addShot(store, 1);
  const r = await tl.previewShotsToTimeline({ shotIds: ['s1'] });
  await store.newProject('另一个项目');
  assert.equal((await tl.applyTimelinePlan(r.plan)).ok, false, '项目切换后拒绝');
});

test('并发确认：同一计划被同时应用两次（双击确认）只加入一组片段——普通计划与“再次插入”计划都一样', async () => {
  const { store, tl } = await fixture();
  await addShot(store, 1); await addShot(store, 2);
  const p1 = await tl.previewShotsToTimeline({ shotIds: ['s1', 's2'] });
  const r1 = await Promise.all([tl.applyTimelinePlan(p1.plan), tl.applyTimelinePlan(p1.plan)]);
  assert.equal(r1.filter(r => r.ok).length, 1, `普通计划只能成功一次：${JSON.stringify(r1.map(r => r.code ?? 'ok'))}`);
  assert.equal(v1(tl).length, 2);
  const dup = await tl.previewShotsToTimeline({ shotIds: ['s1', 's2'], allowDuplicate: true });
  const r2 = await Promise.all([tl.applyTimelinePlan(dup.plan), tl.applyTimelinePlan(dup.plan)]);
  assert.equal(r2.filter(r => r.ok).length, 1, `再次插入计划只能成功一次：${JSON.stringify(r2.map(r => r.code ?? 'ok'))}`);
  assert.equal(v1(tl).length, 4, '同一确认不得产生第二组片段');
});
