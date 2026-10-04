// 能力表一致性：恰好 13 个公开型号、字段齐全、价格与已核对生产报价一致、退役型号缺席。
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
  'wan-3.0': 0.45, 'wan-3.0-prime': 0.45,
};

test('恰好 13 个唯一公开型号，无退役/未开放型号', () => {
  const names = Object.keys(TABLE.models);
  assert.equal(names.length, 13);
  assert.equal(new Set(names).size, 13);
  assert.deepEqual([...names].sort(), Object.keys(PRICES).sort());
  for (const retired of ['minimax-h3-720p', 'minimax-h3-2k', 'seedance-2.5-discount-1080p'])
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

test('上传限制与请求字段白名单', () => {
  assert.equal(TABLE.upload_limits.image.max_mib, 30);
  assert.equal(TABLE.upload_limits.video.max_mib, 100);
  assert.equal(TABLE.upload_limits.audio.max_mib, 30);
  assert.equal(TABLE.upload_limits.concurrency, 3);
  assert.ok(TABLE.request_fields.metadata.includes('first_frame_url'));
  assert.ok(!TABLE.request_fields.metadata.includes('resolution'), '清晰度由型号决定，无 resolution 请求字段');
  assert.ok(TABLE.not_offered.items.length >= 8, '未开放项必须保留明示清单');
});
