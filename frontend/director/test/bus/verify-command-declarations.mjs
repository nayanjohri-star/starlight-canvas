// Command modules load in plain Node and own the effective data declarations.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { STUDIO_ACTION_IDS } from '../../src/studio-actions.js';
import { COMMAND_MODULES, commandDeclarations, createStudioAppActions } from '../../src/commands/index.js';

export function verifyDeclarations(modules = COMMAND_MODULES, registry = createStudioAppActions({ state: () => ({}) }, modules)) {
  const all = commandDeclarations(modules);
  for (const [name, module] of Object.entries(modules)) {
    assert.ok(Array.isArray(module.declarations) && module.declarations.length > 0, `${name}.js declares its actions`);
    assert.deepEqual(JSON.parse(JSON.stringify(module.declarations)), module.declarations, `${name}.js declarations are plain data`);
  }
  assert.equal(new Set(all.map(entry => entry.id)).size, all.length, 'no action is declared twice');
  for (const declaration of all) {
    const effective = registry.get(declaration.id);
    assert.deepEqual(Object.fromEntries(Object.keys(declaration).map(key => [key, effective[key]])), declaration, `${declaration.id} uses its effective declaration`);
  }
  assert.deepEqual(registry.ids().sort(), all.map(entry => entry.id).sort(), 'every implementation has a module declaration');
  for (const id of STUDIO_ACTION_IDS) assert.ok(all.some(entry => entry.id === id), `${id} retains a module owner`);
  console.log(`PASS effective declarations: ${all.length} actions across ${Object.keys(modules).length} command modules`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) verifyDeclarations();
