// node:test 自定义报告器：每个测试结果一行 JSON，结尾写入 summary 行。
// 发布门禁据此统计每层的真实测试清单；没有 summary 行即视为报告不完整。
import { relative, resolve } from 'node:path';

const rel = file => (file ? relative(process.cwd(), file).replaceAll('\\', '/') : null);
const reasonOf = v => (typeof v === 'string' ? v : v === true ? '' : null);

export default async function* jsonlReporter(source) {
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      // 仅记录真实测试用例（type='test'），不记录文件级包装（type 为 suite 或无测试名的文件节点）
      const skip = reasonOf(d.skip), todo = reasonOf(d.todo);
      yield JSON.stringify({
        kind: 'test',
        status: event.type === 'test:fail' ? 'fail' : skip != null ? 'skip' : todo != null ? 'todo' : 'pass',
        name: d.name, file: rel(d.file), nesting: d.nesting ?? 0,
        testType: d.details?.type ?? null,
        // 文件级条目：node 对「没有定义任何测试」或「加载即崩溃」的文件以文件路径为名报告一条结果
        fileLevel: Boolean(d.file) && typeof d.name === 'string' && resolve(d.name) === resolve(d.file),
        skipReason: skip, todoReason: todo,
        durationMs: d.details?.duration_ms ?? null,
        error: event.type === 'test:fail' ? String(d.details?.error?.cause?.message ?? d.details?.error?.message ?? 'failed').slice(0, 2000) : undefined,
      }) + '\n';
    } else if (event.type === 'test:summary' && d.file == null) {
      // 全局汇总（无 file 字段）；各文件级 summary 忽略
      yield JSON.stringify({ kind: 'summary', counts: d.counts ?? null, success: d.success ?? null, durationMs: d.duration_ms ?? null }) + '\n';
    }
  }
}
