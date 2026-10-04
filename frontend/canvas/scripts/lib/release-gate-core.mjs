// 严格发布门禁的判定逻辑（纯函数，可单测）。
// 必需层在以下任一情况都判定失败：环境缺失、未运行、测试文件缺失、退出码 77、非零退出、异常终止、
// 报告无法解析、报告不完整（缺汇总或计数对不上）、零测试、存在失败/取消/todo、清单中的文件没有任何用例、
// 未登记的跳过。跳过例外只按「文件 + 测试名 + 原因」精确登记，不接受「最多 N 个」之类的宽泛策略。

export const EXIT_ENV_MISSING = 77;

export function parseJsonlReport(text) {
  const tests = [], problems = [];
  let summary = null, lineNo = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { problems.push({ code: 'report_parse_error', detail: `第 ${lineNo} 行不是合法 JSON` }); continue; }
    if (obj?.kind === 'test') {
      if (typeof obj.name !== 'string' || !['pass', 'fail', 'skip', 'todo'].includes(obj.status)) {
        problems.push({ code: 'report_parse_error', detail: `第 ${lineNo} 行测试记录字段不完整` });
        continue;
      }
      tests.push(obj);
    } else if (obj?.kind === 'summary') {
      if (summary) problems.push({ code: 'report_parse_error', detail: '报告包含多个汇总行' });
      summary = obj;
    } else problems.push({ code: 'report_parse_error', detail: `第 ${lineNo} 行类型未知` });
  }
  return { tests, summary, problems };
}

const norm = p => String(p ?? '').replaceAll('\\', '/');
export function skipAllowed(test, allowlist) {
  return allowlist.find(a => norm(a.file) === norm(test.file) && a.test === test.name && a.reason === (test.skipReason ?? ''));
}

// layer: { name, required, requires:[capability], strictEvidence?:boolean }
// run:   { ran:boolean, status:number|null, signal:string|null, spawnError?:string }
// files: { listed:[path], missing:[path] }
export function evaluateLayer({ layer, env = {}, run, files = { listed: [], missing: [] }, reportText, allowlist = [] }) {
  const problems = [];
  let tests = [];
  const add = (code, detail) => problems.push({ code, detail });
  const unmet = (layer.requires ?? []).filter(cap => !env[cap]);
  if (unmet.length) add('env_missing', `缺少环境能力：${unmet.join(', ')}`);
  if (files.missing?.length) add('missing_required_files', `必需测试文件不存在：${files.missing.join(', ')}`);
  if (!files.listed?.length) add('no_test_files', '该层没有任何测试文件');
  if (!run?.ran) {
    add('not_run', run?.spawnError ? `未能启动：${run.spawnError}` : '该层未运行');
    return finish();
  }
  if (run.status === EXIT_ENV_MISSING) add('exit_77', '退出码 77（环境缺失）');
  else if (run.status == null || run.signal) add('abnormal_termination', `进程异常终止（status=${run.status}，signal=${run.signal ?? '无'}）`);
  else if (run.status !== 0) add('nonzero_exit', `退出码 ${run.status}`);

  const report = parseJsonlReport(reportText);
  problems.push(...report.problems);
  // 文件级「通过」条目表示该文件没有定义任何测试，不计为用例；文件级失败（加载崩溃）照常计为失败
  const strict = layer.strictEvidence === true;
  const counted = strict ? report.tests.filter(t => t.testType !== 'suite') : report.tests;
  const rawCount = counted.length;
  tests = report.tests.filter(t => !(t.fileLevel && t.status === 'pass') && (!strict || t.testType !== 'suite'));
  if (strict) {
    for (const t of report.tests) {
      if (!['test', 'suite'].includes(t.testType) || !t.name.trim() || typeof t.file !== 'string' || !t.file
        || !Number.isInteger(t.nesting) || t.nesting < 0 || typeof t.fileLevel !== 'boolean')
        add('invalid_test_record', `测试记录缺少真实用例元数据：${t.file}：${t.name}`);
    }
  }
  if (!report.summary) add('incomplete_report', '报告缺少汇总行（进程可能中途退出）');
  else {
    const c = report.summary.counts ?? {};
    if (!Number.isInteger(c.tests)) add('incomplete_report', '汇总缺少测试计数');
    else if (c.tests !== rawCount) add('incomplete_report', `汇总计数 ${c.tests} 与逐条记录 ${rawCount} 不一致`);
    if ((c.cancelled ?? 0) > 0) add('cancelled_tests', `${c.cancelled} 个测试被取消`);
    if (strict) {
      if (report.summary.success !== true) add('incomplete_report', '汇总没有明确确认测试成功');
      const expected = { tests: rawCount, passed: counted.filter(t => t.status === 'pass').length,
        failed: counted.filter(t => t.status === 'fail').length, skipped: counted.filter(t => t.status === 'skip').length,
        todo: counted.filter(t => t.status === 'todo').length, cancelled: 0,
        suites: report.tests.filter(t => t.testType === 'suite').length };
      for (const [key, value] of Object.entries(expected)) {
        if (!Number.isInteger(c[key]) || c[key] !== value)
          add('incomplete_report', `汇总 ${key}=${c[key]} 与逐条记录 ${value} 不一致`);
      }
    }
  }
  if (!tests.length) add('zero_tests', '该层没有运行任何测试');
  const failed = (strict ? report.tests : tests).filter(t => t.status === 'fail');
  if (failed.length) add('test_failures', failed.slice(0, 20).map(t => `${t.file}：${t.name}：${t.error ?? ''}`.slice(0, 300)).join('\n'));
  const todo = (strict ? report.tests : tests).filter(t => t.status === 'todo');
  if (todo.length) add('todo_tests', todo.map(t => `${t.file}：${t.name}`).join('\n'));
  const skips = (strict ? report.tests : tests).filter(t => t.status === 'skip');
  const unapproved = skips.filter(t => strict || !skipAllowed(t, allowlist));
  if (unapproved.length) add('unapproved_skip', unapproved.map(t => `${t.file}：${t.name}：${t.skipReason ?? ''}`).join('\n'));
  const seen = new Set(tests.map(t => norm(t.file)));
  const silent = (files.listed ?? []).filter(f => !seen.has(norm(f)));
  if (silent.length && (tests.length || strict)) add('file_without_tests', `以下文件没有产生任何测试记录：${silent.join(', ')}`);
  return finish();

  function finish() {
    const counts = {
      tests: tests?.length ?? 0,
      pass: tests?.filter(t => t.status === 'pass').length ?? 0,
      fail: tests?.filter(t => t.status === 'fail').length ?? 0,
      skip: tests?.filter(t => t.status === 'skip').length ?? 0,
      todo: tests?.filter(t => t.status === 'todo').length ?? 0,
    };
    const optionalUnmet = !layer.required && problems.length && problems.every(p => ['env_missing', 'not_run', 'exit_77'].includes(p.code));
    return {
      layer: layer.name, required: layer.required !== false,
      ok: problems.length === 0,
      outcome: problems.length === 0 ? 'passed' : optionalUnmet ? 'optional-not-accepted' : 'failed',
      problems, counts, tests: tests ?? [],
      skips: (tests ?? []).filter(t => t.status === 'skip').map(t => ({ file: t.file, test: t.name, reason: t.skipReason ?? '' })),
    };
  }
}

// 门禁总判定：任一必需层未通过即失败；可选层未满足只作为「未验收」如实列出
export function evaluateGate(layerResults, { artifact } = {}) {
  const blockers = [];
  for (const r of layerResults) if (r.required && !r.ok) blockers.push(`${r.layer}：${r.problems.map(p => p.code).join(', ')}`);
  if (artifact && artifact.before !== artifact.after) blockers.push(`构建产物在验证过程中被改变（${artifact.before?.slice(0, 12)} → ${artifact.after?.slice(0, 12)}）`);
  return {
    ok: blockers.length === 0,
    blockers,
    notAccepted: layerResults.filter(r => !r.required && !r.ok).map(r => `${r.layer}：${r.problems.map(p => p.detail).join('；')}`),
  };
}

// 跨层重叠：同一测试文件出现在多个层时如实列出；唯一用例按（文件, 测试名, 嵌套层级）去重计数
export function overlapReport(layerResults) {
  const byFile = new Map();
  for (const r of layerResults) for (const f of new Set(r.tests.map(t => norm(t.file)))) {
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(r.layer);
  }
  const overlapping = [...byFile].filter(([, ls]) => ls.length > 1).map(([file, layers]) => ({ file, layers }));
  const unique = new Set();
  for (const r of layerResults) for (const t of r.tests) unique.add(`${norm(t.file)}\u0000${t.nesting}\u0000${t.name}`);
  const summed = layerResults.reduce((n, r) => n + r.tests.length, 0);
  return { overlapping, uniqueTestCases: unique.size, summedAcrossLayers: summed };
}
