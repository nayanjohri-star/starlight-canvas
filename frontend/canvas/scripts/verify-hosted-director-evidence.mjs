// Capture before testing, seal the actual process result afterwards, then re-verify in the release verdict.
// node scripts/verify-hosted-director-evidence.mjs --capture --evidence DIR --dist DIST --candidate SHA
// node scripts/verify-hosted-director-evidence.mjs --seal --evidence DIR --dist DIST --candidate SHA --exit-code N
// node scripts/verify-hosted-director-evidence.mjs --evidence DIR --candidate SHA --candidate-build PATH
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distContentHash } from './build.mjs';
import { HOSTED_DIRECTOR_REQUIRED_FILES, HOSTED_DIRECTOR_EVIDENCE_KIND, evidenceSha256,
  assertHostedDirectorBuild, evaluateHostedDirectorEvidence } from './lib/hosted-director-evidence.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export async function verifyHostedDirectorCLI(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--capture', '--seal', '--evidence', '--dist', '--candidate', '--exit-code', '--candidate-build'].includes(key)
      || options.has(key)) throw new Error(`unknown or duplicate argument: ${key}`);
    const flag = key === '--capture' || key === '--seal';
    const value = flag ? true : args[++i];
    if (value === undefined || (!flag && value.startsWith('--'))) throw new Error(`missing argument: ${key}`);
    options.set(key, value);
  }
  if (!options.has('--evidence') || !options.has('--candidate')) throw new Error('--evidence and --candidate are required');
  const dir = resolve(options.get('--evidence')), candidate = options.get('--candidate');
  const capture = options.has('--capture'), seal = options.has('--seal');
  if (capture && seal) throw new Error('capture and seal must be separate operations');
  if ((capture || seal) && !options.has('--dist')) throw new Error('--dist is required to hash the tested artifact');
  if (seal && (!/^(0|[1-9]\d{0,2})$/.test(options.get('--exit-code') ?? '') || Number(options.get('--exit-code')) > 255))
    throw new Error('seal requires the real --exit-code');
  if (capture && (options.has('--exit-code') || options.has('--candidate-build'))) throw new Error('capture accepts only the candidate and tested dist');
  if (seal && options.has('--candidate-build')) throw new Error('seal validates the tested dist; candidate package belongs to the verdict');
  if (!capture && !seal && !options.has('--candidate-build')) throw new Error('verdict requires --candidate-build from the verified release archive');
  if (!capture && !seal && (options.has('--dist') || options.has('--exit-code'))) throw new Error('verdict requires an already sealed process result');
  const buildPath = join(dir, 'build.json'), identityPath = join(dir, 'director-run.json');
  if (capture) {
    if (existsSync(identityPath) || existsSync(buildPath)) throw new Error('refusing to replace an existing captured run');
    const dist = resolve(options.get('--dist')), buildText = readFileSync(join(dist, 'build.json'), 'utf8');
    const build = JSON.parse(buildText);
    assertHostedDirectorBuild(build, candidate);
    const before = await distContentHash(dist);
    if (before !== build.contentHash) throw new Error('artifact bytes differ from build.json before execution');
    mkdirSync(dir, { recursive: true });
    writeFileSync(buildPath, buildText);
    writeFileSync(identityPath, JSON.stringify({ kind: HOSTED_DIRECTOR_EVIDENCE_KIND, candidate,
      contentHash: before, buildSha256: evidenceSha256(buildText), before, after: null, run: null, reportSha256: null }, null, 2) + '\n');
    return { captured: true, candidate, contentHash: before };
  }
  const buildText = readFileSync(buildPath, 'utf8'), identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  const reportText = readFileSync(join(dir, 'director.jsonl'), 'utf8');
  if (seal) {
    if (identity.run !== null || identity.after !== null || identity.reportSha256 !== null) throw new Error('refusing to reseal a completed run');
    const dist = resolve(options.get('--dist'));
    if (readFileSync(join(dist, 'build.json'), 'utf8') !== buildText) throw new Error('build.json changed during execution');
    identity.after = await distContentHash(dist);
    identity.run = { ran: true, status: Number(options.get('--exit-code')), signal: null };
    identity.reportSha256 = evidenceSha256(reportText);
    writeFileSync(identityPath, JSON.stringify(identity, null, 2) + '\n');
  }
  let candidateBuild;
  if (options.has('--candidate-build')) {
    const candidatePath = resolve(options.get('--candidate-build'));
    candidateBuild = JSON.parse(readFileSync(candidatePath, 'utf8'));
    if (await distContentHash(dirname(candidatePath)) !== candidateBuild.contentHash)
      throw new Error('candidate package bytes differ from its build.json');
  }
  const result = evaluateHostedDirectorEvidence({ reportText, buildText, identity, candidate, candidateBuild,
    missingFiles: HOSTED_DIRECTOR_REQUIRED_FILES.filter(f => !existsSync(join(ROOT, f))) });
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) throw new Error(result.problems.map(p => `${p.code}: ${p.detail}`).join('\n'));
  return { verified: true, candidate, contentHash: result.contentHash, counts: result.counts, files: result.files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyHostedDirectorCLI(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`hosted director evidence rejected: ${error.message}`); process.exitCode = 1; }
}
