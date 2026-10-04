// asset-reuse 行为验收：append 保留顺序与空槽、整批拒绝（超限/缺失素材/预览后变更/
// 项目切换）、名称无关（同名按 id 区分、改名不影响）、幂等、replace、未知 id 显式拒绝。
// 全部内存存储，无网络与付费路径。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createStoryboards } from '../src/storyboard.js';
import { previewAssetReuse, planAssetReuse, applyAssetReuse, REUSE_MAX_REFS } from '../src/asset-reuse.js';

async function fixture() {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('素材复用');
  const storyboards = createStoryboards({ store, storage });
  const deps = { store, storyboards };
  const mkAsset = (id, extra = {}) =>
    ((store.project.assets ??= {})[id] =
      { id, name: id, kind: 'image', mime: 'image/png', size: 128, addedAt: 1, ...extra });
  const refs = id => storyboards.find(id).assetIds;
  return { store, storyboards, deps, mkAsset, refs };
}

test('预览/应用：append 保留现有顺序与 null 缺失槽，为整批建立一次撤销点', async () => {
  const { store, storyboards, deps, mkAsset, refs } = await fixture();
  mkAsset('a1'); mkAsset('a2'); mkAsset('a3');
  const s = storyboards.addShot({ title: '镜1' });
  storyboards.updateShot(s.id, { assetIds: ['a1', null, 'gone'] });
  const plan = previewAssetReuse(store.project, { assetIds: ['a3', 'a2'], shotIds: [s.id] });
  assert.equal(plan.ok, true);
  const row = plan.shots[0];
  assert.equal(row.current, 3);
  assert.equal(row.missing, 2);                  // null 槽 + 失效 id 都算缺失槽
  assert.deepEqual(row.additions, ['a3', 'a2']); // 按选择顺序追加
  let checkpoints = 0;
  deps.editor = { checkpoint() { checkpoints++; } };
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, true);
  assert.equal(res.wrote, 1);
  assert.equal(res.added, 2);
  assert.deepEqual(refs(s.id), ['a1', null, 'gone', 'a3', 'a2']);
  assert.equal(checkpoints, 1);
});

test('写入中途异常会回滚所有分镜内容和版本记录', async () => {
 const {store,storyboards,deps,mkAsset}=await fixture();mkAsset('a');
 const a=storyboards.addShot({title:'甲'}),b=storyboards.addShot({title:'乙'});
 const before=structuredClone(store.project.studio.shots);
 const plan=previewAssetReuse(store.project,{assetIds:['a'],shotIds:[a.id,b.id]});
 const original=storyboards.updateShot;let count=0;
 storyboards.updateShot=(...args)=>{if(++count===2)throw new Error('simulated write failure');return original(...args);};
 assert.equal(applyAssetReuse(deps,plan).applied,false);
 assert.deepEqual(store.project.studio.shots,before);
});

test('整批拒绝：缺失素材被选中时一条不写', async () => {
  const { store, storyboards, deps, mkAsset, refs } = await fixture();
  mkAsset('fine'); mkAsset('lost', { missing: true });
  const s1 = storyboards.addShot({ title: '甲' });
  const s2 = storyboards.addShot({ title: '乙' });
  const plan = previewAssetReuse(store.project, { assetIds: ['fine', 'lost'], shotIds: [s1.id, s2.id] });
  assert.equal(plan.ok, false);
  assert.ok(plan.problems.some(p => p.includes('缺失')));
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, false);
  assert.deepEqual(refs(s1.id), []);
  assert.deepEqual(refs(s2.id), []);
});

test('整批拒绝：任一目标分镜结果超 50 引用，其他分镜也不写', async () => {
  const { store, storyboards, deps, mkAsset, refs } = await fixture();
  mkAsset('new1');
  const full = storyboards.addShot({ title: '满' });
  storyboards.updateShot(full.id, { assetIds: Array.from({ length: REUSE_MAX_REFS }, (_, i) => `x${i}`) });
  const free = storyboards.addShot({ title: '空' });
  const plan = previewAssetReuse(store.project, { assetIds: ['new1'], shotIds: [full.id, free.id] });
  assert.equal(plan.ok, false);
  assert.ok(plan.problems.some(p => p.includes('上限')));
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, false);
  assert.equal(refs(free.id).length, 0);
  assert.equal(refs(full.id).length, REUSE_MAX_REFS);
});

test('整批拒绝：预览后分镜引用被外部改动 → 不写，外部改动保留', async () => {
  const { store, storyboards, deps, mkAsset, refs } = await fixture();
  mkAsset('a1'); mkAsset('a9');
  const s1 = storyboards.addShot({ title: '一' });
  const s2 = storyboards.addShot({ title: '二' });
  const plan = previewAssetReuse(store.project, { assetIds: ['a1'], shotIds: [s1.id, s2.id] });
  assert.equal(plan.ok, true);
  storyboards.updateShot(s2.id, { assetIds: ['a9'] });   // 预览后并发改动
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, false);
  assert.ok(res.problems.some(p => p.includes('变更')));
  assert.deepEqual(refs(s1.id), []);                    // s1 也未写
  assert.deepEqual(refs(s2.id), ['a9']);
});

test('整批拒绝：应用时项目已切换 → 不写且新项目零污染', async () => {
  const { store, storyboards, deps, mkAsset } = await fixture();
  mkAsset('a1');
  const s = storyboards.addShot({ title: '旧项目' });
  const plan = previewAssetReuse(store.project, { assetIds: ['a1'], shotIds: [s.id] });
  assert.equal(plan.ok, true);
  await store.newProject('新项目');
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, false);
  assert.equal(store.project.studio?.shots?.length ?? 0, 0);
});

test('名称无关：同名素材按 id 各自保留；预览后改名不影响应用', async () => {
  const { store, storyboards, deps, mkAsset, refs } = await fixture();
  mkAsset('a1', { name: '女主.png' });
  mkAsset('a2', { name: '女主.png' });
  const s = storyboards.addShot({ title: '镜' });
  const plan = previewAssetReuse(store.project, { assetIds: ['a1', 'a2'], shotIds: [s.id] });
  assert.equal(plan.ok, true);
  assert.equal(plan.shots[0].additions.length, 2);      // 同名不合并
  store.project.assets.a1.name = '女主-定稿.png';        // id 不变，名称漂移
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, true);
  assert.deepEqual(refs(s.id), ['a1', 'a2']);
});

test('幂等：已在分镜中的引用不重复追加、不落写', async () => {
  const { store, storyboards, deps, mkAsset, refs } = await fixture();
  mkAsset('a1');
  const s = storyboards.addShot({ title: '镜' });
  storyboards.updateShot(s.id, { assetIds: ['a1'] });
  const plan = previewAssetReuse(store.project, { assetIds: ['a1'], shotIds: [s.id] });
  assert.equal(plan.ok, true);
  assert.equal(plan.added, 0);
  assert.equal(plan.dirty, false);
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, true);
  assert.equal(res.wrote, 0);
  assert.deepEqual(refs(s.id), ['a1']);
});

test('replace 模式：以所选素材整体替换分镜引用', async () => {
  const { store, storyboards, deps, mkAsset, refs } = await fixture();
  mkAsset('a1'); mkAsset('a2'); mkAsset('a3');
  const s = storyboards.addShot({ title: '镜' });
  storyboards.updateShot(s.id, { assetIds: ['a1', null] });
  const plan = previewAssetReuse(store.project, { assetIds: ['a2', 'a3'], shotIds: [s.id], mode: 'replace' });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.shots[0].next, ['a2', 'a3']);
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, true);
  assert.deepEqual(refs(s.id), ['a2', 'a3']);
});

test('未知素材/分镜 id → 显式问题且不写', async () => {
  const { store, storyboards, deps, mkAsset, refs } = await fixture();
  mkAsset('a1');
  const s = storyboards.addShot({ title: '镜' });
  const plan = previewAssetReuse(store.project, { assetIds: ['a1', 'nope'], shotIds: [s.id, 'ghost'] });
  assert.equal(plan.ok, false);
  assert.ok(plan.problems.some(p => p.includes('nope')));
  assert.ok(plan.problems.some(p => p.includes('ghost')));
  const res = applyAssetReuse(deps, plan);
  assert.equal(res.applied, false);
  assert.deepEqual(refs(s.id), []);
});

test('别名一致：planAssetReuse 即 previewAssetReuse', () => {
  assert.equal(planAssetReuse, previewAssetReuse);
});
