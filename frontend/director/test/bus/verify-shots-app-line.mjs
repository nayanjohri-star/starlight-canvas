import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../src/', import.meta.url);
const matches = readdirSync(root, { recursive: true }).filter(path => /\.(js|jsx)$/.test(path)).flatMap(path => {
  const source = readFileSync(new URL(path, root), 'utf8');
  return source.split('\n').flatMap((line, index) => line.includes('recordShotUndo') ? [`${path}:${index + 1}: ${line.trim()}`] : []);
});
assert.deepEqual(matches, [], 'acceptance 6: no legacy shot-undo reference remains in src');
console.log('PASS no legacy shot-undo references');
