// 严格发布门禁自身的测试：判定逻辑逐项覆盖规范列出的失败情形，并用夹具配置真实运行门禁脚本。
// 缺浏览器 / 缺 FFmpeg / 缺必需文件 / 必需层未运行 / 非零退出 / 退出码 77 / 异常终止 /
// 报告无法解析 / 报告不完整 / 零测试 / 未登记跳过 / 文件无用例 / 可选层 / 产物被改。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateLayer, evaluateGate, overlapReport, parseJsonlReport } from '../scripts/lib/release-gate-core.mjs';
import { HOSTED_API_EVIDENCE_FILES, verifyNodeEvidence } from '../scripts/verify-backend-evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = (name, status = 'pass', extra = {}) => JSON.stringify({ kind: 'test', status, name, file: 'tests/a.test.mjs', nesting: 0, ...extra });
const S = (n, extra = {}) => JSON.stringify({ kind: 'summary', counts: { tests: n, cancelled: 0, ...extra }, success: true });
const layer = { name: 'x', required: true, requires: [] };
const files = { listed: ['tests/a.test.mjs'], missing: [] };
const okRun = { ran: true, status: 0, signal: null };
const codes = r => r.problems.map(p => p.code);

test('hosted backend evidence rejects omitted stream lifecycle and image deadline tests', async () => {
  const passes = HOSTED_API_EVIDENCE_FILES.map(file => ({ kind: 'test', status: 'pass', file,
    name: `actual ${file}`, fileLevel: false }));
  const summary = tests => ({ kind: 'summary', success: true, counts: { tests, cancelled: 0 } });
  verifyNodeEvidence([...passes, summary(passes.length)], HOSTED_API_EVIDENCE_FILES);
  for (const omitted of ['stream-lifecycle.test.mjs', 'image-deadline.test.mjs']) {
    const incomplete = passes.filter(row => row.file !== omitted);
    assert.throws(() => verifyNodeEvidence([...incomplete, summary(incomplete.length)], HOSTED_API_EVIDENCE_FILES), /file_without_tests/);
  }
  const { LAYERS } = await import('../scripts/release-gate.config.mjs');
  assert.deepEqual(LAYERS.find(layer => layer.name === 'hosted-api').requiredFiles.map(file => file.split('/').at(-1)), HOSTED_API_EVIDENCE_FILES);
});

test('基线：全部通过的层判定为 passed', () => {
  const r = evaluateLayer({ layer, run: okRun, files, reportText: [T('a'), T('b'), S(2)].join('\n') });
  assert.equal(r.ok, true); assert.equal(r.outcome, 'passed'); assert.deepEqual(r.counts, { tests: 2, pass: 2, fail: 0, skip: 0, todo: 0 });
});

test('缺浏览器 / 缺 FFmpeg：必需层失败（不按 77 跳过）', () => {
  const need = { ...layer, requires: ['browser', 'ffmpeg'] };
  const r1 = evaluateLayer({ layer: need, env: { browser: false, ffmpeg: true }, run: { ran: false, spawnError: '环境缺失' }, files, reportText: '' });
  assert.equal(r1.ok, false); assert.ok(codes(r1).includes('env_missing')); assert.match(r1.problems[0].detail, /browser/);
  const r2 = evaluateLayer({ layer: need, env: { browser: true, ffmpeg: false }, run: { ran: false }, files, reportText: '' });
  assert.ok(codes(r2).includes('env_missing')); assert.match(r2.problems[0].detail, /ffmpeg/);
});

test('缺必需测试文件 / 层没有文件：失败', () => {
  const r = evaluateLayer({ layer, run: okRun, files: { listed: ['tests/a.test.mjs'], missing: ['tests/gone.test.mjs'] }, reportText: [T('a'), S(1)].join('\n') });
  assert.ok(codes(r).includes('missing_required_files'));
  const r2 = evaluateLayer({ layer, run: { ran: false }, files: { listed: [], missing: [] }, reportText: '' });
  assert.ok(codes(r2).includes('no_test_files'));
});

test('必需层未运行：失败', () => {
  const r = evaluateLayer({ layer, run: { ran: false }, files, reportText: '' });
  assert.equal(r.ok, false); assert.ok(codes(r).includes('not_run'));
});

test('非零退出 / 退出码 77 / 异常终止：失败', () => {
  assert.ok(codes(evaluateLayer({ layer, run: { ran: true, status: 1 }, files, reportText: [T('a'), S(1)].join('\n') })).includes('nonzero_exit'));
  assert.ok(codes(evaluateLayer({ layer, run: { ran: true, status: 77 }, files, reportText: [T('a'), S(1)].join('\n') })).includes('exit_77'));
  assert.ok(codes(evaluateLayer({ layer, run: { ran: true, status: null, signal: 'SIGKILL' }, files, reportText: [T('a')].join('\n') })).includes('abnormal_termination'));
});

test('报告无法解析 / 报告不完整：失败', () => {
  assert.ok(codes(evaluateLayer({ layer, run: okRun, files, reportText: [T('a'), '{not json', S(1)].join('\n') })).includes('report_parse_error'));
  assert.ok(codes(evaluateLayer({ layer, run: okRun, files, reportText: [T('a'), JSON.stringify({ kind: 'test', name: 'x' }), S(1)].join('\n') })).includes('report_parse_error'));
  assert.ok(codes(evaluateLayer({ layer, run: okRun, files, reportText: T('a') })).includes('incomplete_report'), '缺汇总');
  assert.ok(codes(evaluateLayer({ layer, run: okRun, files, reportText: [T('a'), S(3)].join('\n') })).includes('incomplete_report'), '计数不一致');
  assert.ok(codes(evaluateLayer({ layer, run: okRun, files, reportText: [T('a'), S(1, { cancelled: 1 })].join('\n') })).includes('cancelled_tests'));
});

test('零测试、失败、todo：失败', () => {
  assert.ok(codes(evaluateLayer({ layer, run: okRun, files, reportText: S(0) })).includes('zero_tests'));
  assert.ok(codes(evaluateLayer({ layer, run: okRun, files, reportText: [T('a', 'fail', { error: 'boom' }), S(1)].join('\n') })).includes('test_failures'));
  assert.ok(codes(evaluateLayer({ layer, run: okRun, files, reportText: [T('a', 'todo'), S(1)].join('\n') })).includes('todo_tests'));
});

test('跳过：只有精确命中（文件 + 测试名 + 原因）的登记才放行', () => {
  const allow = [{ file: 'tests/a.test.mjs', test: 'a', reason: '登记原因' }];
  const ok = evaluateLayer({ layer, run: okRun, files, allowlist: allow, reportText: [T('a', 'skip', { skipReason: '登记原因' }), S(1)].join('\n') });
  assert.equal(ok.ok, true);
  for (const bad of [T('a', 'skip', { skipReason: '别的原因' }), T('b', 'skip', { skipReason: '登记原因' }), T('a', 'skip', { skipReason: '登记原因', file: 'tests/other.test.mjs' })]) {
    const r = evaluateLayer({ layer, run: okRun, files: { listed: ['tests/a.test.mjs', 'tests/other.test.mjs'], missing: [] }, allowlist: allow, reportText: [bad, T('z', 'pass', { file: 'tests/other.test.mjs' }), S(2)].join('\n') });
    assert.ok(codes(r).includes('unapproved_skip'), bad);
  }
});

test('清单中的文件没有产生任何用例：失败（防止文件被静默丢弃）', () => {
  const r = evaluateLayer({ layer, run: okRun, files: { listed: ['tests/a.test.mjs', 'tests/b.test.mjs'], missing: [] }, reportText: [T('a'), S(1)].join('\n') });
  assert.ok(codes(r).includes('file_without_tests'));
});

test('可选层（导演台）缺资源：标记为未验收，不阻断；但有失败时仍是失败', () => {
  const opt = { name: 'director', required: false, requires: ['director'] };
  const r = evaluateLayer({ layer: opt, env: { director: false }, run: { ran: false }, files, reportText: '' });
  assert.equal(r.outcome, 'optional-not-accepted');
  const g = evaluateGate([r]);
  assert.equal(g.ok, true); assert.equal(g.notAccepted.length, 1);
  const bad = evaluateLayer({ layer: opt, env: { director: true }, run: { ran: true, status: 1 }, files, reportText: [T('a', 'fail'), S(1)].join('\n') });
  assert.equal(bad.outcome, 'failed');
});

test('总判定：任一必需层未通过或产物在验证中被改 → 失败；重叠如实计数', () => {
  const pass = evaluateLayer({ layer, run: okRun, files, reportText: [T('a'), S(1)].join('\n') });
  const fail = evaluateLayer({ layer: { ...layer, name: 'y' }, run: { ran: false }, files, reportText: '' });
  assert.equal(evaluateGate([pass]).ok, true);
  assert.equal(evaluateGate([pass, fail]).ok, false);
  assert.equal(evaluateGate([pass], { artifact: { before: 'a', after: 'b' } }).ok, false);
  const ov = overlapReport([pass, { ...pass, layer: 'z' }]);
  assert.equal(ov.summedAcrossLayers, 2); assert.equal(ov.uniqueTestCases, 1); assert.equal(ov.overlapping.length, 1);
  assert.equal(parseJsonlReport('').summary, null);
});

// ---------- 夹具配置真实运行门禁脚本 ----------
test('门禁脚本端到端：夹具层逐项得到预期判定', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r05-gate-'));
  const candidateFiles = ['dist/build.json', 'dist/index.html', 'dist-hosted/build.json', 'dist-hosted/index.html'];
  const snapshotCandidate = () => Promise.all(candidateFiles.map(async file => {
    try { const info = await stat(join(ROOT, file)); return { file, bytes: await readFile(join(ROOT, file)), mtimeMs: info.mtimeMs }; }
    catch (error) { if (error.code === 'ENOENT') return { file, absent: true }; throw error; }
  }));
  const original = await snapshotCandidate();
  try {
    await mkdir(join(dir, 'tests'), { recursive: true });
    const w = (f, body) => writeFile(join(dir, 'tests', f), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`);
    await w('ok.test.mjs', "test('ok', () => {});");
    await w('fail.test.mjs', "test('fails', () => { assert.equal(1, 2); });");
    await w('skip.test.mjs', "test('skipped', t => t.skip('未登记的原因'));");
    await w('hang.test.mjs', "test('hangs', () => new Promise(() => setTimeout(() => {}, 600000)));");
    await w('egress.test.mjs', "test('real network is blocked', async () => { await assert.rejects(fetch('https://xingpan.site/v1/videos'), /EGRESS_BLOCKED/); });");
    await writeFile(join(dir, 'tests', 'empty.test.mjs'), '// 没有任何测试\n');
    const cfg = join(dir, 'gate.config.mjs');
    await writeFile(cfg, `
      export const TEST_ROOT = ${JSON.stringify(dir)};
      export const LAYERS = [
        { name: 'ok', required: true, requires: [], requiredFiles: ['tests/ok.test.mjs'] },
        { name: 'fails', required: true, requires: [], requiredFiles: ['tests/fail.test.mjs'] },
        { name: 'badskip', required: true, requires: [], requiredFiles: ['tests/skip.test.mjs'] },
        { name: 'missing', required: true, requires: [], requiredFiles: ['tests/ok.test.mjs', 'tests/not-here.test.mjs'] },
        { name: 'needsbrowser', required: true, requires: ['browser'], requiredFiles: ['tests/ok.test.mjs'] },
        { name: 'needsffmpeg', required: true, requires: ['ffmpeg'], requiredFiles: ['tests/ok.test.mjs'] },
        { name: 'zero', required: true, requires: [], requiredFiles: ['tests/empty.test.mjs'] },
        { name: 'killed', required: true, requires: [], requiredFiles: ['tests/hang.test.mjs'], timeoutMin: 0.05 },
        { name: 'egress', required: true, requires: [], requiredFiles: ['tests/egress.test.mjs'] },
        { name: 'optional', required: false, requires: ['director'], requiredFiles: ['tests/ok.test.mjs'] },
      ];
      export const SKIP_ALLOWLIST = [];
    `);
    const out = join(dir, 'evidence');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release-gate.mjs'), '--config', cfg, '--out', out, '--allow-dirty',
      '--env-override', 'browser=0,ffmpeg=0,director=0'], { cwd: ROOT, encoding: 'utf8', timeout: 170000 });
    assert.equal(r.status, 1, '含失败层的门禁必须以非零退出');
    const rep = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.deepEqual(await snapshotCandidate(), original, 'self-test preserves the real candidate bytes, timestamps and absent files');
    assert.ok(rep.artifact.before && rep.artifact.before === rep.artifact.after, 'self-test actually built and checked its own local artifact');
    assert.ok(rep.hostedArtifact.before && rep.hostedArtifact.before === rep.hostedArtifact.after, 'self-test actually built and checked its own hosted artifact');
    assert.equal(JSON.parse(await readFile(join(out, 'artifacts/dist-hosted/build.json'), 'utf8')).contentHash, rep.hostedArtifact.before);
    const L = Object.fromEntries(rep.layers.map(l => [l.layer, l]));
    const has = (n, c) => assert.ok(L[n].problems.some(p => p.code === c), `${n} 应含 ${c}：${JSON.stringify(L[n].problems.map(p => p.code))}`);
    assert.equal(L.ok.outcome, 'passed', 'ok 层：' + JSON.stringify(L.ok.problems));
    has('fails', 'test_failures'); has('fails', 'nonzero_exit');
    has('badskip', 'unapproved_skip');
    has('missing', 'missing_required_files');
    has('needsbrowser', 'env_missing'); has('needsbrowser', 'not_run');
    has('needsffmpeg', 'env_missing');
    has('zero', 'zero_tests');
    has('killed', 'abnormal_termination');
    assert.equal(L.egress.outcome, 'passed', '测试进程内真实外网请求被主动阻断：' + JSON.stringify(L.egress.problems));
    assert.equal(L.optional.outcome, 'optional-not-accepted', 'optional：' + JSON.stringify(L.optional.problems));
    assert.equal(rep.gate.ok, false);
    assert.ok(rep.gate.blockers.some(b => /环境覆盖/.test(b)), '使用环境覆盖的报告不可作为发布证据');
    assert.ok(rep.layers.every(l => Array.isArray(l.tests)), '报告记录逐条用例');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('层级划分：凡启动浏览器的测试文件都不进入单元层（单元层高并发，混入会重复运行并可能挂起）', async () => {
  const { BROWSER_FILE } = await import('../scripts/release-gate.config.mjs');
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = dirname(fileURLToPath(import.meta.url));
  const offenders = readdirSync(dir).filter(f => f.endsWith('.test.mjs'))
    .filter(f => /e2e-helpers\.mjs|chromium\.launch|launchBrowser\(/.test(readFileSync(join(dir, f), 'utf8')))
    .filter(f => !BROWSER_FILE(f));
  assert.deepEqual(offenders, [], `这些浏览器测试会被单元层发现：${offenders.join(', ')}`);
  assert.equal(BROWSER_FILE('e2e.test.mjs'), true);
  assert.equal(BROWSER_FILE('release-package.test.mjs'), true);
  assert.equal(BROWSER_FILE('task-status.test.mjs'), false);
  const list = tier => {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/run-tests.mjs'), tier, '--list'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\r?\n/);
  };
  assert.ok(list('unit').every(file => !BROWSER_FILE(file.split('/').at(-1))), 'CLI unit classification matches the strict gate');
  assert.ok(list('package').includes('tests/release-package.test.mjs'), 'moving package acceptance out of unit keeps it mandatory in package');
});
