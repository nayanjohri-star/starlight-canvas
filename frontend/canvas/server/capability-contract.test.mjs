// Compare the independent canvas snapshot with the site's actual contract,
// not a second copy of constants from the canvas implementation.
//
// 基准是画布自带的固定合同 contracts/site-video-capabilities.json（MANIFEST.json 记录版本与哈希）。
// 字段映射与仓库副本策略只在 scripts/lib/capability-contract.mjs 定义一次，构建与发布门禁复用同一实现。
// 仓库中的后端/Portal/网关副本：同版本必须相等；不同版本只有在 contracts/approved-copies.json
// 登记（路径 + 版本 + 哈希 + 原因）后才标记为历史副本并跳过，其余一律失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePromptRefs } from '../src/capabilities.js';
import {
  loadPinnedContract, loadApprovedCopies, compareTableToContract, classifyRepositoryCopy, readRepositoryCopy,
  REPOSITORY_COPY_PATHS, REPO_ROOT, compareContractVersions, parseContractVersion,
} from '../scripts/lib/capability-contract.mjs';

const project = new URL('../../../', import.meta.url);
const { manifest, contract: canonical, problems: pinProblems } = await loadPinnedContract();
const snapshot = JSON.parse((await readFile(new URL('docs/星盘AI_视频模型能力表.json', project), 'utf8')).replace(/^﻿/, ''));
const approved = await loadApprovedCopies();

test('pinned site contract matches its manifest (version and LF-normalized sha256)', () => {
  assert.deepEqual(pinProblems, []);
  assert.equal(canonical.version, manifest.version);
});

test('canvas capability version and every exposed field match the site contract', () => {
  assert.deepEqual(compareTableToContract(snapshot, canonical), []);
});

for (const path of REPOSITORY_COPY_PATHS) {
  test(`repository copy ${path} equals the pinned contract or is an approved historical copy`, async t => {
    const copy = await readRepositoryCopy(path, REPO_ROOT);
    const r = classifyRepositoryCopy({ path, copy, pinned: canonical, approved });
    if (r.status === 'fail') assert.fail(r.reason);
    if (r.status === 'approved-historical' || r.status === 'absent') return t.skip(r.reason);
    assert.equal(r.status, 'equal');
  });
}

test('contract versions compare by date and revision, never as strings', () => {
  assert.equal(compareContractVersions('2026-09-18.1', '2026-09-16.1'), 1);
  assert.equal(compareContractVersions('2026-09-18.10', '2026-09-18.9'), 1, '10 > 9（字符串比较会得出相反结果）');
  assert.equal(compareContractVersions('2026-10-01.1', '2026-09-30.7'), 1);
  assert.equal(compareContractVersions('2026-09-18.1', '2026-09-18.1'), 0);
  assert.equal(parseContractVersion('2026-13-01.1'), null);
  assert.equal(parseContractVersion('latest'), null);
  assert.throws(() => compareContractVersions('v2', '2026-09-18.1'), /无法比较/);
});

test('repository copy policy: same version must be identical; unknown, newer or unregistered versions fail', () => {
  const pinned = { version: '2026-09-18.1', models: { a: { billing_unit: 'second' } } };
  const old = Object.assign({ version: '2026-09-16.1', models: {} });
  Object.defineProperty(old, '__sha256_lf', { value: 'abc', enumerable: false });
  const reg = [{ path: 'x.json', version: '2026-09-16.1', sha256_lf: 'abc', reason: '登记原因' }];
  assert.equal(classifyRepositoryCopy({ path: 'x.json', copy: structuredClone(pinned), pinned, approved: [] }).status, 'equal');
  assert.equal(classifyRepositoryCopy({ path: 'x.json', copy: { version: '2026-09-18.1', models: {} }, pinned, approved: reg }).status, 'fail', '同版本不同内容');
  assert.equal(classifyRepositoryCopy({ path: 'x.json', copy: old, pinned, approved: reg }).status, 'approved-historical');
  assert.equal(classifyRepositoryCopy({ path: 'y.json', copy: old, pinned, approved: reg }).status, 'fail', '路径未登记');
  const tampered = { version: '2026-09-16.1', models: {} };
  Object.defineProperty(tampered, '__sha256_lf', { value: 'zzz', enumerable: false });
  assert.equal(classifyRepositoryCopy({ path: 'x.json', copy: tampered, pinned, approved: reg }).status, 'fail', '登记哈希不符');
  assert.equal(classifyRepositoryCopy({ path: 'x.json', copy: { version: '2026-09-20.1', models: {} }, pinned, approved: reg }).status, 'fail', '比固定合同新');
  assert.equal(classifyRepositoryCopy({ path: 'x.json', copy: { version: 'next', models: {} }, pinned, approved: reg }).status, 'fail', '未知版本');
});

test('canvas standard prices and model catalogue agree with the customer integration guide', async () => {
  const guide = await readFile(new URL('docs/星盘AI_视频模型接入指南.md', project), 'utf8');
  const prices = new Map();
  for (const line of guide.split(/\r?\n/)) {
    const match = line.match(/^\|[^|]+\|\s*`([^`]+)`\s*\|[^|]+\|[^|]+\|\s*¥([\d.]+)\/(秒|次)\s*\|/);
    if (match) prices.set(match[1], {value:Number(match[2]),unit:match[3]});
  }
  assert.deepEqual([...prices.keys()].sort(), Object.keys(snapshot.models).sort());
  for (const [id, price] of prices) assert.equal(snapshot.models[id][price.unit === "次" ? "price_cny_per_request" : "price_cny_per_second"], price.value, id);
});

test('canvas reference tokens match the existing Portal image/video/audio serialization', () => {
  // frontend/portal/src/lib/video-model.ts::normalizedReferencePrompt uses
  // @N for images and retains the Chinese media-type label for video/audio.
  const refs = [{ id: 'image_1', kind: 'image' }, { id: 'video_1', kind: 'video' }, { id: 'audio_1', kind: 'audio' }];
  assert.equal(resolvePromptRefs('构图用@图片1，运镜用@视频1，节奏用@音频1', refs).normalized,
    '构图用@1，运镜用@视频1，节奏用@音频1');
});
