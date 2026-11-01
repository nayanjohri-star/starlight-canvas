// 能力表一致性：恰好 26 个公开型号、字段齐全、价格与已核对生产报价一致、退役型号缺席。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TABLE = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/星盘AI_视频模型能力表.json'), 'utf8'));

const PRICES = {
 'minimax-h3-768p-limited':1.5,'minimax-h3-768p-full-slow':0.1,
  'minimax-h3-768p-per-second': 0.15, 'minimax-h3-2k-per-second': 0.20,
  'seedance-2.5-vip-480p': 0.55, 'seedance-2.5-vip-720p': 1.18, 'seedance-2.5-vip-1080p': 4.38,
  'seedance-2.5-discount-480p': 0.44, 'seedance-2.5-discount-720p': 0.66,
  'seedance-2.5-special-480p': 0.63, 'seedance-2.5-special-720p': 0.88,
  'seedance-2.5-discount-1080p': 1.00,
  'seedance-2.0-480p': 0.21, 'seedance-2.0-720p': 0.53, 'seedance-2.0-discount-720p': 0.36,
  'seedance-2.0-fast-720p': 0.36, 'seedance-2.0-mini-720p': 0.33,
  'kling-v4-720p': 0.53, 'kling-v4-1080p': 0.80, 'kling-omni-4-720p': 0.47, 'muse-720p': 0.13,
  'wan-3.0': 0.53, 'wan-3.0-prime': 0.53,
  'wan-3.0-480p': 0.21, 'wan-3.0-720p': 0.51, 'wan-3.0-discount-720p': 0.31,
};
const NEW_SEEDANCE_SHAPED = ['seedance-2.0-480p', 'seedance-2.0-720p', 'seedance-2.0-discount-720p', 'seedance-2.0-fast-720p',
  'seedance-2.0-mini-720p', 'kling-v4-720p', 'kling-v4-1080p', 'kling-omni-4-720p', 'muse-720p', 'seedance-2.5-discount-1080p'];
const WAN = ['wan-3.0', 'wan-3.0-prime', 'wan-3.0-480p', 'wan-3.0-720p', 'wan-3.0-discount-720p'];

test('恰好 26 个唯一公开型号，无退役/未开放型号', () => {
  const names = Object.keys(TABLE.models);
  assert.equal(names.length, 26);
  assert.equal(new Set(names).size, 26);
  assert.deepEqual([...names].sort(), Object.keys(PRICES).sort());
  for (const retired of ['minimax-h3-720p', 'minimax-h3-2k'])
    assert.ok(!TABLE.models[retired], `退役/未开放型号不得出现：${retired}`);
});

test('每个型号字段齐全且与生产报价/能力源一致', () => {
  for (const [id, price] of Object.entries(PRICES)) {
    const m = TABLE.models[id];
    assert.equal(m.billing_unit==='request'?m.price_cny_per_request:m.price_cny_per_second, price, `${id} 单价`);
    assert.ok(m.display_name && m.family && m.resolution, id);
    assert.ok(Number.isInteger(m.seconds.min) && m.seconds.min <= m.seconds.default && m.seconds.default <= m.seconds.max, `${id} 时长`);
    assert.ok(m.ratios.options.includes(m.ratios.default), `${id} 默认比例在白名单`);
    assert.ok(m.reference_limits.image >= 0 && m.reference_limits.total > 0, `${id} 素材上限`);
    assert.ok(Array.isArray(m.request_modes) && m.request_modes.length, `${id} request_modes`);
    assert.ok(m.prompt_max_characters > 0, `${id} prompt 上限`);
  }
});

test('分组与开关边界', () => {
  for (const id of ['minimax-h3-768p-per-second', 'minimax-h3-2k-per-second'])
    assert.deepEqual(TABLE.models[id].groups, ['视频专线'], 'H3 仅视频专线');
  for (const id of ['seedance-2.5-special-480p', 'seedance-2.5-special-720p'])
    assert.deepEqual(TABLE.models[id].switches, { generate_audio: false, face_mode: false }, 'SD特殊无开关');
  assert.equal(TABLE.models['wan-3.0'].switches.face_mode, false);
  assert.ok(!TABLE.models['wan-3.0'].request_modes.includes('frames'), 'Wan 无首尾帧');
  assert.ok(!TABLE.models['minimax-h3-768p-per-second'].ratios.options.includes('21:9'), 'H3 无 21:9');
});

test('新型号族：SD 2.0、可灵、Muse 走 references，Wan 按新合同', () => {
  for (const id of NEW_SEEDANCE_SHAPED) {
    const m = TABLE.models[id];
    assert.ok(['sd25', 'sd20', 'kling', 'muse'].includes(m.family), id);
    assert.deepEqual(m.request_modes, ['references'], `${id} 无首尾帧`);
    assert.ok(!m.capability_modes.includes('first_last_frame'), id);
    assert.equal(m.switches.face_mode, false, `${id} 无人脸开关`);
    assert.deepEqual(m.groups, ['视频专线'], id);
  }
  assert.deepEqual(TABLE.models['seedance-2.0-720p'].seconds, { min: 4, max: 15, default: 4 });
  assert.equal(TABLE.models['seedance-2.0-720p'].reference_limits.audio, 0, 'SD 2.0 不收参考音频');
  assert.ok(TABLE.models['seedance-2.0-mini-720p'].ratios.options.includes('auto'));
  assert.deepEqual(TABLE.models['kling-v4-720p'].seconds, { min: 3, max: 30, default: 5 });
  assert.equal(TABLE.models['kling-v4-720p'].switches.generate_audio, true);
  for (const id of ['seedance-2.0-mini-720p', 'kling-omni-4-720p', 'muse-720p']) assert.equal(TABLE.models[id].switches.generate_audio, false, `${id} 无声音开关`);
  assert.deepEqual(TABLE.models['muse-720p'].reference_limits, { image: 7, video: 0, audio: 0, total: 7 });
  for (const id of WAN) {
    const m = TABLE.models[id];
    assert.equal(m.family, 'wan', id);
    assert.deepEqual(m.switches, { generate_audio: false, face_mode: false }, `${id} 声音不能关闭，不开放开关`);
    assert.ok(!m.request_modes.includes('frames'), `${id} 无首尾帧`);
  }
  for (const id of ['wan-3.0', 'wan-3.0-prime']) {
    assert.deepEqual(TABLE.models[id].seconds, { min: 4, max: 30, default: 5 }, `${id} 新合同 4–30 秒`);
    assert.ok(TABLE.models[id].ratios.options.includes('21:9'), `${id} 新合同加 21:9`);
    assert.ok(TABLE.models[id].reference_rules.some(r => r.includes('15 秒')), `${id} 带参考视频最多 15 秒`);
  }
  assert.deepEqual(TABLE.models['wan-3.0-480p'].seconds, { min: 5, max: 30, default: 5 });
  assert.equal(TABLE.models['wan-3.0-480p'].reference_limits.video, 0);
});

test('上传限制与请求字段白名单', () => {
  assert.equal(TABLE.upload_limits.image.max_mib, 30);
  assert.equal(TABLE.upload_limits.video.max_mib, 100);
  assert.equal(TABLE.upload_limits.audio.max_mib, 30);
  assert.equal(TABLE.upload_limits.concurrency, 3);
  assert.ok(TABLE.request_fields.metadata.includes('first_frame_url'));
  assert.ok(!TABLE.request_fields.metadata.includes('resolution'), '清晰度由型号决定，无 resolution 请求字段');
  assert.ok(TABLE.not_offered.items.length >= 8, '未开放项必须保留明示清单');
});
