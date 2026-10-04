// SPDX-License-Identifier: AGPL-3.0-or-later
// CPU URL/realm boundaries only; these stubs do not claim browser execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHostedParentRealm, assertHostedDirectorRealm, bindHostedArtifact,
  observeHostedDirectorRealm } from './fixtures/director-artifact-realm.mjs';

const hash = 'a'.repeat(64), oldHash = 'b'.repeat(64);
const host = 'http://127.0.0.1:34080', parent = `${host}/canvas/`;
const directory = `${parent}releases/${hash}/`, entry = `${directory}director/index.html?sessionId=f-synthetic&projectId=p&nodeId=n`;
const fixture = () => ({ artifact: { sourceDirty: false, mode: 'hosted', basePath: '/canvas/', assetPath: `releases/${hash}/` },
  hostUrl: parent, parentUrl: parent, parentRealmUrl: parent, parentBaseURI: directory,
  declaredFrameUrl: entry, frameUrl: entry, realmUrl: entry, baseURI: entry });

test('actual hosted parent and selected immutable director realm accept the pinned graph', () => {
  const input = fixture(), proof = assertHostedDirectorRealm(input);
  assert.equal(proof.parentBaseURI, directory); assert.equal(proof.immutableEntry, entry.split('?')[0]);
  assert.doesNotThrow(() => assertHostedDirectorRealm({ ...input, parentUrl: parent + 'index.html',
    parentRealmUrl: parent + 'index.html', declaredFrameUrl: `releases/${hash}/director/index.html?sessionId=f-synthetic&projectId=p&nodeId=n`,
    baseURI: directory + 'director/' }));
});

test('old parent with a new Node build identity is rejected even when the child uses the new graph', () => {
  const input = fixture();
  for (const bad of [{ parentBaseURI: directory.replace(hash, oldHash) }, { parentBaseURI: parent },
    { parentRealmUrl: parent + '#a-different-page' }, { parentUrl: directory + 'index.html' },
    { parentBaseURI: directory.replace('127.0.0.1', 'localhost') },
    { artifact: { ...input.artifact, sourceDirty: true } }])
    assert.throws(() => assertHostedParentRealm({ ...input, ...bad }));
});

test('old frame, redirected source, another evaluation realm and foreign resource base cannot reuse a proof', () => {
  const input = fixture();
  for (const bad of [{ frameUrl: entry.replace(hash, oldHash), realmUrl: entry.replace(hash, oldHash),
    declaredFrameUrl: entry.replace(hash, oldHash), baseURI: entry.replace(hash, oldHash) },
    { declaredFrameUrl: entry.replace('f-synthetic', 'other-session') },
    { realmUrl: entry.replace('f-synthetic', 'another-context') },
    { baseURI: directory.replace(hash, oldHash) + 'director/' },
    { frameUrl: entry.replace(host, 'https://foreign.example') }])
    assert.throws(() => assertHostedDirectorRealm({ ...input, ...bad }));
});

function cpuPage(input) {
  return { url: () => input.parentUrl, evaluate: async () => ({ parentRealmUrl: input.parentRealmUrl, parentBaseURI: input.parentBaseURI }) };
}
function cpuFrame(input) {
  return { url: () => input.frameUrl, evaluate: async () => ({ realmUrl: input.realmUrl, baseURI: input.baseURI }) };
}

test('the read-only observation binds once and rechecks parent plus child after every refresh/open', async () => {
  const input = fixture(), page = cpuPage(input), frame = cpuFrame(input), observed = [];
  const proof = await bindHostedArtifact(page, { artifact: input.artifact, hostUrl: input.hostUrl, onObserved: row => observed.push(row) });
  input.artifact.assetPath = `releases/${oldHash}/`; // Binding keeps the original candidate, not later disk metadata.
  await observeHostedDirectorRealm(page, frame, input.declaredFrameUrl);
  input.frameUrl = input.realmUrl = input.baseURI = input.declaredFrameUrl = entry.replace('f-synthetic', 'f-second');
  await observeHostedDirectorRealm(page, frame, input.declaredFrameUrl);
  assert.equal(proof.frames.length, 2); assert.equal(observed.length, 2);
  assert.equal(proof.frames[1].frameUrl, input.frameUrl);
  input.parentBaseURI = directory.replace(hash, oldHash);
  await assert.rejects(observeHostedDirectorRealm(page, frame, input.declaredFrameUrl), /parent baseURI/);
  assert.equal(proof.frames.length, 2, 'failed observations never enter the accepted evidence');
});

test('an unbound page and an evaluation error fail instead of reading fresh metadata or hiding errors', async () => {
  const input = fixture(), page = cpuPage(input), frame = cpuFrame(input);
  await assert.rejects(observeHostedDirectorRealm(page, frame, entry), /bound to a tested artifact/);
  await bindHostedArtifact(page, { artifact: input.artifact, hostUrl: input.hostUrl });
  frame.evaluate = async () => { throw new Error('F CPU destroyed realm'); };
  await assert.rejects(observeHostedDirectorRealm(page, frame, entry), /destroyed realm/);
});
