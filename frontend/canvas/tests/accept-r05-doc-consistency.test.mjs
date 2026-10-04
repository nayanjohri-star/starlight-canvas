// R05-D 文档一致性：面向开发者的接入指南与旧适配规范不得与画布固定合同的计费单位/型号集合矛盾。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'contracts', 'site-video-capabilities.json'), 'utf8'));
const models = contract.models;
const guide = readFileSync(join(REPO, 'docs', '星盘AI_视频模型接入指南.md'), 'utf8');
const spec = readFileSync(join(REPO, 'docs', '星盘AI_画布视频适配规范.md'), 'utf8');

// 指南价目表行：| 名称 | `model` | 档位 | 时长 | ¥x/秒 或 ¥x/次 |
const guideRows = new Map([...guide.matchAll(/^\|[^|\n]*\|\s*`([a-z0-9.-]+)`\s*\|[^|\n]*\|[^|\n]*\|\s*¥[\d.]+\/(秒|次)\s*\|/gm)].map(m => [m[1], m[2]]));

test('接入指南价目表的计费单位与固定合同一致（逐型号）', () => {
  assert.ok(guideRows.size >= 10, `解析到的指南价目行过少：${guideRows.size}`);
  const mismatched = [];
  for (const [id, unit] of guideRows) {
    const m = models[id];
    if (!m) continue;
    const want = m.billing_unit === 'request' ? '次' : '秒';
    if (unit !== want) mismatched.push(`${id}: 指南 /${unit}，合同 ${m.billing_unit}`);
  }
  assert.deepEqual(mismatched, []);
});

test('旧适配规范不再把按秒计费的型号写成统一按次，并带有计费口径更正说明', () => {
  assert.match(spec, /计费口径更正/);
  assert.ok(!/新增两档均¥1\.50\/次/.test(spec), '旧的“两档均按次”表述应已更正');
  assert.ok(!/两档都显示¥1\.50\/次/.test(spec));
  for (const [id, m] of Object.entries(models)) {
    if (m.billing_unit !== 'second') continue;
    // 规范中出现该 API 型号名的行，不得同时声称“改变秒数不改变费用”
    for (const line of spec.split(/\r?\n/).filter(l => l.includes(id)))
      assert.ok(!/改变秒数不改变/.test(line), `${id} 按秒计费，规范行不得声称秒数不影响费用：${line.slice(0, 80)}`);
  }
});
