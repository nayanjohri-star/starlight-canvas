import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanTree } from './verify-bus-coverage.mjs';

const references = scanTree(fileURLToPath(new URL('../../src/', import.meta.url)));
assert.ok(references.length < 174, `writer references must shrink from 174, measured ${references.length}`);
const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url)));
assert.ok(baseline.coverage.writerReferences < 174);
for (const retired of ['setShowB', 'removeCharacter', 'saveCurrentPose', 'savePose', 'posePhotoFile', 'removePose', 'addPromptClip', 'removePromptClip', 'switchActiveCharacterLayer', 'toggleCharacterHidden']) {
  assert.equal(baseline.writers[`domains/cast.js::${retired}`], undefined);
}
const panels = ['SubjectsPanel', 'CharacterTransformPanel', 'RigPanel', 'PosePanel', 'PromptBlocksPanel'];
const sites = panels.reduce((count, name) => count + [...readFileSync(new URL(`../../src/panels/${name}.jsx`, import.meta.url), 'utf8').matchAll(/on[A-Z][A-Za-z]+[\s\S]{0,240}?\brun\s*\(/g)].length, 0);
assert.ok(sites >= 14, `measured cast panel handler sites ${sites}`);
assert.deepEqual(JSON.parse(readFileSync(new URL('./parity-pending/cast.json', import.meta.url))).pending, []);
console.log(`PASS cast ratchet: ${references.length} writer references; ${sites} owned panel run sites; real parity off pending`);
