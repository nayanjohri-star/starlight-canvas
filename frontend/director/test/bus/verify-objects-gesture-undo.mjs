import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { objectsFixture } from './objects-fixture.mjs';
const source = readFileSync(new URL('../../src/object-gizmo.jsx', import.meta.url), 'utf8');
let handler;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && node.id.name === 'onKeyDown') handler = source.slice(node.init.start, node.init.end);
  for (const [key, value] of Object.entries(node)) if (key !== 'parent') Array.isArray(value) ? value.forEach(walk) : walk(value);
}
walk(parseSync('gizmo.jsx', source).program);
const f = objectsFixture();
try {
  let ended = 0;
  const before = structuredClone(f.objects.read());
  const token = f.objects.beginSceneTransaction({ owner: 'gizmo', cancel: () => { ended++; } });
  f.objects.changeSceneObject('cube', { x: 5 }, token);
  f.actual.undoScene();
  assert.deepEqual(f.objects.read(), before);
  assert.equal(ended, 1);
  assert.deepEqual(f.objects.store.depths(), { past: 0, future: 1 });
  f.actual.redoScene();
  assert.equal(f.objects.read()[0].x, 5);
  const calls = [], keydown = new Function('dragRef', 'endDrag', `return ${handler};`)({ current: {} }, commit => calls.push(commit));
  keydown({ code: 'KeyZ', key: 'z', ctrlKey: true });
  assert.deepEqual(calls, [true], 'the real gizmo capture handler settles before App chooses a history owner');
  console.log('PASS mid-drag Undo commits once, tears down the producer, restores exactly and leaves one redo entry');
} finally { f.dispose(); }
