// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument, readProjectDocument, createWorkflowGraph, PROJECT_VERSION, WORKFLOW_VERSION } from '../src/project.js';
import { createSceneDocument } from '../src/scenes.js';

const graph = { version: WORKFLOW_VERSION, nodes: [{ id: 'original-node', type: 'Text', position: { x: 1, y: 2 }, data: { text: 'original synthetic work' } }], edges: [] };
const document = () => createProjectDocument({ name: 'Version fixture', scenesDocument: createSceneDocument('version-scene'), workflow: graph, savedAt: 1 });

test('current workflow nodes survive and missing legacy workflow fields remain compatible', () => {
  const current = document();
  assert.deepEqual(readProjectDocument(JSON.stringify(current)).project.workflow, graph);
  for (const version of [1, 2, 3, PROJECT_VERSION]) {
    const legacy = { ...current, version }; delete legacy.workflow;
    const missing = readProjectDocument(JSON.stringify(legacy));
    assert.equal(missing.ok, true); assert.deepEqual(missing.project.workflow, createWorkflowGraph());
    legacy.workflow = { nodes: graph.nodes, edges: graph.edges };
    const unversioned = readProjectDocument(JSON.stringify(legacy));
    assert.equal(unversioned.ok, true); assert.deepEqual(unversioned.project.workflow, graph);
  }
});

test('declared unsupported workflow versions fail without exposing a normalized project', () => {
  for (const version of [2, 99, 0, '2', null]) {
    const future = { ...document(), workflow: { ...structuredClone(graph), version, futureField: { keep: true } } };
    const raw = JSON.stringify(future);
    const result = readProjectDocument(raw);
    assert.deepEqual(result, { ok: false, reason: 'workflow-unsupported' });
    assert.equal('project' in result, false, 'the caller has no empty graph it could apply/save over the original');
    assert.equal(JSON.parse(raw).workflow.nodes[0].id, 'original-node');
  }
});

test('malformed current-version graphs retain their existing safe normalization', () => {
  const malformed = { ...document(), workflow: { version: WORKFLOW_VERSION, nodes: 'bad', edges: [] } };
  const result = readProjectDocument(JSON.stringify(malformed));
  assert.equal(result.ok, true); assert.deepEqual(result.project.workflow, createWorkflowGraph());
  const declaredFuture = { ...malformed, workflow: { ...malformed.workflow, version: 99 } };
  assert.deepEqual(readProjectDocument(JSON.stringify(declaredFuture)), { ok: false, reason: 'workflow-unsupported' });
});

test('project serialization cannot silently normalize an unsupported workflow version', () => {
  const workflow = { ...structuredClone(graph), version: 2, futureField: { keep: true } };
  const before = structuredClone(workflow);
  assert.throws(() => createProjectDocument({ scenesDocument: createSceneDocument('future-save'), workflow }), error => error.code === 'workflow-unsupported');
  assert.deepEqual(workflow, before, 'rejecting a save preserves the supplied future graph');
});

test('the real project.open owner rejects future workflow bytes before changing content or history', async () => {
  const { projectFixture, ok } = await import('./bus/project-fixture.mjs');
  const f = projectFixture({ singleScene: true });
  try {
    const rename = ok(await f.run('scene.rename', { sceneId: 'scene', name: 'Retained original scene' }));
    const before = f.project.collectProjectSnapshot('Heist');
    const identity = f.project.projectSaveIdentity();
    const snapshot = f.scope.projectSnapshotRef.current;
    const storage = [...f.storage]; let writes = 0;
    const handle = { createWritable: async () => { writes++; throw new Error('no file writes expected'); } };
    f.scope.projectHandleRef.current = handle;
    const future = { ...document(), workflow: { ...structuredClone(graph), version: 2 } };
    const receipt = await f.run('project.open', { serialized: JSON.stringify(future) });
    assert.equal(receipt.ok, false); assert.equal(receipt.code, 'INVALID_ARGUMENT');
    assert.match(receipt.message, /workflow-unsupported/);
    assert.equal(f.project.collectProjectSnapshot('Heist'), before);
    assert.deepEqual(f.project.projectSaveIdentity(), identity);
    assert.equal(f.scope.projectSnapshotRef.current, snapshot);
    assert.equal(f.scope.projectHandleRef.current, handle); assert.equal(writes, 0);
    assert.deepEqual([...f.storage], storage);
    assert.equal(f.project.documentStore.isRetained(rename.undo.historyEntryId), true);
  } finally { f.dispose(); }
});
