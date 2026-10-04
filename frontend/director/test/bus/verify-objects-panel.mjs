import assert from 'node:assert/strict';
import { objectsFixture } from './objects-fixture.mjs';
const elements = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)] : [];
const f = objectsFixture();
try {
  const tree = f.panel('ObjectTransformPanel', { ...f.objects, selectedSceneObject: f.objects.read()[0],
    matteEditorRef: f.scope.matteEditorRef, hierarchyReparent: { onDrop: f.objects.reparentSceneObject }, setToast: f.scope.setToast });
  const nodes = elements(tree), before = structuredClone(f.objects.read());
  const name = nodes.find(node => node.type === 'input' && node.props.type === 'text' && !node.props.className);
  for (const value of ['R', 'Ro', 'Room']) name.props.onChange({ target: { value } });
  assert.equal(f.objects.read()[0].name, 'Room');
  assert.equal(f.objects.store.depths().past, 0, 'typing previews stay in one open transaction');
  name.props.onBlur();
  assert.equal(f.objects.store.depths().past, 1);
  f.actual.undoScene(); assert.deepEqual(f.objects.read(), before);
  const position = nodes.find(node => node.props?.fields)?.props.fields[0];
  const token = position.onScrubStart({ owner: 'inspector', cancel: () => {} });
  for (const value of [1, 2, 3]) position.onChange(value, token);
  assert.equal(f.objects.store.depths().past, 0);
  position.onScrubEnd(token, { commit: true });
  assert.equal(f.objects.store.depths().past, 1);
  const parent = nodes.find(node => node.type === 'select');
  parent.props.onChange({ target: { value: 'sphere' } });
  assert.equal(f.objects.read()[0].parent, 'sphere');
  const hex = nodes.find(node => node.props?.className === 'object-color-hex');
  for (const value of ['#123', '#123456']) hex.props.onChange({ target: { value } });
  const depth = f.objects.store.depths().past;
  hex.props.onBlur();
  assert.equal(f.objects.store.depths().past, depth + 1);
  assert.equal(f.objects.read()[0].color, '#123456');
  console.log('PASS actual object Inspector: typing, scrubbing, grouping and colour sessions use bus transactions');
} finally { f.dispose(); }
