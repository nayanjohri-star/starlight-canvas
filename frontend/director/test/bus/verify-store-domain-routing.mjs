import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { createDocumentStore } from '../../src/document-store.js';
import { appFixture } from './app-fixture.mjs';

const source = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) if (key !== 'parent') {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else walk(value, visit);
  }
}
const ast = parseSync('App.jsx', source).program;
const names = new Set(['beginStudioAction', 'stepStudioHistory', 'isStudioHistoryRetained', 'publishStudioDomain', 'commitStudioDraft', 'canUndoStudioReceipt']);
let failures = 0;
function test(name, run) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
}
test('App history and binding ports do not select named domains', () => {
  const forbidden = new Set(['stage', 'shot', 'objects', 'cast', 'scenes', 'motion']);
  const violations = [];
  walk(ast, node => {
    const history = node.type === 'FunctionDeclaration' && names.has(node.id.name);
    const ports = node.type === 'CallExpression' && ['updatePorts', 'updateActionPorts'].includes(node.callee?.property?.name);
    if (history || ports) walk(node, child => {
      if (child.type === 'Literal' && forbidden.has(child.value)) violations.push(child.value);
    });
  });
  assert.deepEqual(violations, []);
});
test('a facade-registered fixture domain uses actual App history without an App edit', () => {
  const f = appFixture(), app = f.scope.appContext;
  const store = createDocumentStore({ owned: { fixture: { value: 0 } } });
  try {
    const handle = {
      documentStore: store,
      beginAction: () => store.beginAction('fixture'),
      canUndo: id => store.canUndo(id),
      stepHistory: redo => Boolean((redo ? store.redo : store.undo)()),
      publish: state => store.write('fixture', state.fixture),
      commitDraft: draft => store.write('fixture', draft),
      document: () => ({ fixture: store.read('fixture') }),
      read: () => store.read('fixture'), write: value => store.write('fixture', value),
    };
    const release = app.registerStoreDomain('fixture', handle);
    assert.equal(app.storeDomain('fixture'), handle);
    const action = f.actual.beginStudioAction('fixture');
    action.run(() => f.actual.publishStudioDomain('fixture', null, { fixture: { value: 1 } }));
    const receipt = { undo: action.commit() };
    assert.equal(f.actual.isStudioHistoryRetained(receipt), true);
    assert.equal(f.actual.canUndoStudioReceipt(receipt), true);
    assert.equal(f.actual.stepStudioHistory(false), true);
    assert.deepEqual(store.read('fixture'), { value: 0 });
    assert.equal(f.actual.isStudioHistoryRetained(receipt), true, 'redo retains its preimage');
    assert.equal(f.actual.canUndoStudioReceipt(receipt), false);
    assert.equal(f.actual.stepStudioHistory(true), true);
    const next = f.actual.commitStudioDraft({ domain: 'fixture', draft: { value: 2 } });
    assert.equal(store.canUndo(next.historyEntryId), true);
    assert.deepEqual(store.read('fixture'), { value: 2 });
    release();
    assert.equal(app.storeDomain('fixture'), undefined);
    assert.equal(f.actual.isStudioHistoryRetained({ undo: next }), false);
  } finally { store.dispose(); f.dispose(); }
});
assert.equal(failures, 0, `${failures} routing contracts failed`);
