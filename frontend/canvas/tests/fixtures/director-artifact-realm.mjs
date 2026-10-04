// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { assertHostedMediaTarget } from '../../../director/test/fixtures/starlight-media-comparison.mjs';

// Node-side bindings survive page refresh without retaining an iframe realm.
// Reading build.json alone cannot prove which immutable graph Caddy served.
const bindings = new WeakMap();

export function assertHostedParentRealm({ artifact, hostUrl, parentUrl, parentRealmUrl, parentBaseURI }) {
  assert.equal(artifact.sourceDirty, false, 'the observed candidate is clean');
  assert.equal(artifact.mode, 'hosted'); assert.equal(artifact.basePath, '/canvas/');
  assert.match(artifact.assetPath, /^releases\/[a-f0-9]{64}\/$/);
  const host = new URL(hostUrl), parent = new URL(parentUrl), realm = new URL(parentRealmUrl);
  const base = new URL(parentBaseURI), expected = new URL(artifact.basePath + artifact.assetPath, host.origin);
  assert.equal(parent.origin, host.origin, 'parent uses the tested host');
  assert.ok(['/canvas/', '/canvas/index.html'].includes(parent.pathname), 'parent uses the actual hosted canvas route');
  assert.equal(realm.href, parent.href, 'parent evaluation belongs to the selected page');
  assert.equal(base.href, expected.href, 'parent baseURI pins the tested artifact module graph');
  return { parentUrl: parent.href, parentRealmUrl: realm.href, parentBaseURI: base.href };
}

export function assertHostedDirectorRealm(input) {
  const parent = assertHostedParentRealm(input);
  assert.equal(new URL(input.declaredFrameUrl, input.parentUrl).href, new URL(input.frameUrl).href,
    'the loaded iframe matches its declared source');
  return { ...parent, ...assertHostedMediaTarget(input) };
}

const parentObservation = async page => ({ parentUrl: page.url(),
  ...await page.evaluate(() => ({ parentRealmUrl: location.href, parentBaseURI: document.baseURI })) });

export async function bindHostedArtifact(page, { artifact, hostUrl, onObserved }) {
  const expected = { artifact: structuredClone(artifact), hostUrl };
  const parent = assertHostedParentRealm({ ...expected, ...await parentObservation(page) });
  const proof = { parent, frames: [] };
  bindings.set(page, { ...expected, proof, onObserved });
  return proof;
}

export async function observeHostedDirectorRealm(page, frame, declaredFrameUrl) {
  const binding = bindings.get(page);
  assert.ok(binding, 'the page must be bound to a tested artifact before opening a director');
  const [parent, child] = await Promise.all([parentObservation(page),
    frame.evaluate(() => ({ realmUrl: location.href, baseURI: document.baseURI }))]);
  const proof = assertHostedDirectorRealm({ ...binding, ...parent, ...child,
    frameUrl: frame.url(), declaredFrameUrl });
  binding.proof.frames.push(proof);
  binding.onObserved?.(proof);
  return proof;
}
