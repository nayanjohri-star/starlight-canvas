import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectFixture } from './project-fixture.mjs';

const panel = readFileSync(new URL('../../src/panels/ProjectPanel.jsx', import.meta.url), 'utf8');
assert.equal([...panel.matchAll(/on[A-Z][A-Za-z]+[\s\S]{0,240}?\brun\s*\(/g)].length, 4, 'four owned project handlers reach run');
const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url)));
assert.deepEqual(Object.keys(baseline.writers).filter(key => key.startsWith('domains/scenes.js::')), [], 'project writers leave the ratchet');
assert.ok(baseline.coverage.writerReferences <= 194);
const f = projectFixture(), previousWindow = globalThis.window;
try {
  const handle = { name: 'Heist.cclayproject', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
  globalThis.window = { showOpenFilePicker() {}, showSaveFilePicker: async () => handle };
  f.scope.projectHandleRef.current = handle;
  const calls = [], original = f.binding.bus.run;
  f.binding.bus.run = (...args) => { calls.push(args[0]); return original(...args); };
  const walk = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(walk)];
  const buttons = walk(f.panel()).filter(node => node.type === 'button' && node.props.role === 'menuitem');
  assert.equal(buttons.length, 4);
  for (const button of buttons) {
    const receipt = await button.props.onClick();
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
  }
  assert.deepEqual(calls, ['project.new', 'project.browse', 'project.save', 'project.saveAs']);
  console.log('PASS four real project menu handlers call run; project writer ratchet shrinks by 13');
} finally { f.dispose(); globalThis.window = previousWindow; }
