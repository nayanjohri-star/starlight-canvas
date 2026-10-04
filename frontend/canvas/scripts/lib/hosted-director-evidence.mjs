// Hosted director evidence uses the same case/summary rules in the runner and the release verdict.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { evaluateLayer } from './release-gate-core.mjs';

export const HOSTED_DIRECTOR_REQUIRED_FILES = Object.freeze([
  'tests/hosted-director-client.test.mjs',
  'tests/hosted-director.test.mjs',
  'tests/director-proposals.test.mjs',
  'tests/hosted-director-acceptance.test.mjs',
  'tests/hosted-director-operations-ui.test.mjs',
  'tests/hosted-director-generation-ui.test.mjs',
  'tests/hosted-director-proposal-ui.test.mjs',
]);
export const HOSTED_DIRECTOR_EVIDENCE_KIND = 'hosted-director-evidence@1';
export const evidenceSha256 = text => createHash('sha256').update(text).digest('hex');

export function assertHostedDirectorBuild(build, candidate) {
  if (!/^[a-f0-9]{40}$/.test(candidate ?? '') || build?.sourceCommit !== candidate
    || build.sourceDirty !== false || build.mode !== 'hosted' || !/^[a-f0-9]{64}$/.test(build.contentHash ?? '')
    || build.basePath !== '/canvas/' || build.apiBase !== '/canvas-api')
    throw new Error('hosted build must belong to the clean candidate commit, content hash and hosted runtime');
}

export function evaluateHostedDirectorEvidence({ reportText, buildText, identity, candidate, candidateBuild,
  missingFiles = [] }) {
  const result = evaluateLayer({ layer: { name: 'hosted-director', required: true, strictEvidence: true },
    run: identity?.run, files: { listed: [...HOSTED_DIRECTOR_REQUIRED_FILES], missing: missingFiles },
    reportText, allowlist: [] });
  const add = (code, detail) => result.problems.push({ code, detail });
  let build;
  try { build = JSON.parse(buildText); assertHostedDirectorBuild(build, candidate); }
  catch (error) { add('build_identity_mismatch', error.message); }
  if (identity?.kind !== HOSTED_DIRECTOR_EVIDENCE_KIND || identity.candidate !== candidate
    || identity.buildSha256 !== evidenceSha256(buildText ?? '')
    || identity.contentHash !== build?.contentHash || identity.before !== build?.contentHash
    || identity.after !== build?.contentHash || !/^[a-f0-9]{64}$/.test(identity?.contentHash ?? ''))
    add('build_identity_mismatch', 'captured build and before/after content hashes do not match this candidate');
  if (identity?.reportSha256 !== evidenceSha256(reportText ?? ''))
    add('report_identity_mismatch', 'JSONL bytes do not match the report sealed after execution');
  if (candidateBuild !== undefined) {
    try {
      assertHostedDirectorBuild(candidateBuild, candidate);
      if (!isDeepStrictEqual(candidateBuild, build)) throw new Error('tested build differs from the candidate package build');
    } catch (error) { add('candidate_build_mismatch', error.message); }
  }
  // Extra files must not stand in for a silent mandatory file; only this explicit layer is accepted.
  for (const t of result.tests) if (!HOSTED_DIRECTOR_REQUIRED_FILES.includes(typeof t.file === 'string' ? t.file.replaceAll('\\', '/') : null))
    add('unexpected_test_file', `unexpected file in director evidence: ${t.file}`);
  result.ok = result.problems.length === 0;
  result.outcome = result.ok ? 'passed' : 'failed';
  result.candidate = candidate;
  result.contentHash = build?.contentHash ?? null;
  result.files = [...HOSTED_DIRECTOR_REQUIRED_FILES];
  return result;
}
