import test from 'node:test';
import assert from 'node:assert/strict';
import { waitUiCondition } from './director-ui-wait.mjs';

test('browser wait awaits false Promise results and later committed state with the same argument', async () => {
  const revisions = [0, 1, 2], argumentsSeen = [];
  const target = { evaluate: async (_predicate, arg) => {
    argumentsSeen.push(arg); await Promise.resolve(); return revisions.shift() >= arg.requiredRevision;
  } };
  const arg = { requiredRevision: 2 };
  assert.equal(await waitUiCondition(target, () => {}, arg, { interval: 1, timeout: 1000 }), true);
  assert.deepEqual(argumentsSeen, [arg, arg, arg]);
});

test('browser wait keeps one deadline for false values and a suspended evaluation', async () => {
  await assert.rejects(waitUiCondition({ evaluate: async () => false }, () => {}, null,
    { interval: 1, timeout: 20, description: 'saved document' }), /saved document did not become true within 20ms/);
  await assert.rejects(waitUiCondition({ evaluate: () => new Promise(() => {}) }, () => {}, null,
    { timeout: 20, description: 'local media' }), /local media did not become true within 20ms/);
});

test('browser wait propagates predicate failures without retrying or suppressing them', async () => {
  const failure = new Error('native project export failed'); let calls = 0;
  await assert.rejects(waitUiCondition({ evaluate: async () => { calls++; throw failure; } }, () => {}),
    error => error === failure);
  assert.equal(calls, 1);
});
