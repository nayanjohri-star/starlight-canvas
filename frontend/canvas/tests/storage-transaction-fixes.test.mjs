import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';

test('存储替身遵守结构化克隆，拒绝不能持久化的数据', async () => {
  const db = createMemoryStorage(), input = { value: 1 };
  await db.set('existing', input); input.value = 2;
  assert.deepEqual(await db.get('existing'), { value: 1 });
  const read = await db.get('existing'); read.value = 3;
  assert.deepEqual(await db.get('existing'), { value: 1 });
  await assert.rejects(db.set('invalid', () => {}));
  assert.equal(await db.get('invalid'), undefined);
});

test('批量存储中途克隆失败，已有数据和第一条写入均不改变', async () => {
  const db = createMemoryStorage(); await db.set('existing', 'original');
  await assert.rejects(db.batch([['existing', 'changed'], ['new', { value: 1 }], ['invalid', () => {}]]));
  assert.equal(await db.get('existing'), 'original');
  assert.equal(await db.get('new'), undefined);
  assert.equal(await db.get('invalid'), undefined);
});
