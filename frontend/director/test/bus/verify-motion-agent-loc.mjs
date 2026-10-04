import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';

test('#452.4: no agent-only payload publisher remains in the shared motion owner', () => {
  const source = readFileSync(new URL('../../src/domains/motion.js', import.meta.url), 'utf8');
  const ast = parseSync('motion.js', source); assert.deepEqual(ast.errors, []);
  let agentOnlyLines = 0;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id.name === 'installPayload') agentOnlyLines += source.slice(node.start, node.end).split('\n').length;
    for (const [key, value] of Object.entries(node)) if (key !== 'parent') Array.isArray(value) ? value.forEach(visit) : typeof value === 'object' && visit(value);
  };
  visit(ast.program);
  assert.equal(agentOnlyLines, 0, 'agent-only publication LOC must be zero, not a disconnected legacy installer');
});
