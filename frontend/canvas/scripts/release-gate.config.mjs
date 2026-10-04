import { availableParallelism } from 'node:os';
import { loadApprovedCopies, classifyRepositoryCopy } from './lib/capability-contract.mjs';
import { HOSTED_DIRECTOR_REQUIRED_FILES } from './lib/hosted-director-evidence.mjs';
import { HOSTED_API_EVIDENCE_FILES } from './verify-backend-evidence.mjs';
// 严格发布门禁的层级定义。每层 = 显式必需文件清单（缺失即失败，不做 existsSync 过滤）
// + 按规则自动发现的同类文件（只增不减）。跨层重叠在报告中如实列出，不把重叠用例相加冒充独立计数。
//
// requires：该层需要的环境能力（browser = playwright-core + 可执行浏览器；ffmpeg = ffmpeg + ffprobe；
// director = 真实导演台资源完整）。必需层缺环境即失败，不以 77 跳过。

// 需要浏览器/媒体的文件只属于各自的浏览器层；单元层并发高，混入会与浏览器层重复并可能互相拖垮
export const BROWSER_FILE = f => /^(e2e|accept)[-.]/.test(f) || f === 'release-package.test.mjs' || f === 'hosted-director-acceptance.test.mjs'
  || ['hosted-director-v04.test.mjs', 'hosted-director-native-performance.test.mjs', 'hosted-director-operations-ui.test.mjs',
    'hosted-director-generation-ui.test.mjs', 'hosted-director-proposal-ui.test.mjs'].includes(f);
const E2E_EXCLUDE = f => /^e2e-director/.test(f) || /^e2e-r05-(media|perf)-/.test(f) || PERFORMANCE.includes(f);
const PERFORMANCE = ['e2e-drag-performance.test.mjs', 'e2e-large-canvas.test.mjs', 'e2e-perf-large.test.mjs', 'e2e-r05-perf-media.test.mjs'];

export const LAYERS = [
  {
    name: 'unit', required: true, requires: [],
    // 单元与服务端全集：除浏览器/验收类外的全部测试文件（与 contract、recovery、package 层存在重叠，报告中列明）
    discover: [{ dir: 'tests', match: f => !BROWSER_FILE(f) }, { dir: 'server', match: () => true }],
    requiredFiles: ['tests/release-gate.test.mjs', 'server/capability-contract.test.mjs', 'server/app.test.mjs'],
  },
  {
    // 托管 API 适配层（Sol，deploy/canvas-hosted-api）：真实 HTTP 路由白名单、A/B 账户、计费门控、幂等、上传限额
    name: 'hosted-api', required: true, requires: [],
    // 视频路由测试：适配层 → 真实 task-error-gateway HTTP（需先安装网关锁定依赖）
    requiredFiles: HOSTED_API_EVIDENCE_FILES.map(file => `../../deploy/canvas-hosted-api/${file}`),
  },
  {
    name: 'contract', required: true, requires: [],
    requiredFiles: [
      'server/capability-contract.test.mjs', 'tests/api.test.mjs', 'tests/capabilities.test.mjs',
      'tests/h3-compat-controls.test.mjs', 'tests/h3-compat-payload.test.mjs', 'tests/h3-v2-runner.test.mjs', 'tests/payload.test.mjs',
    ],
  },
  {
    name: 'recovery', required: true, requires: [],
    discover: [{ dir: 'tests', match: f => /^upgrade-/.test(f) }, { dir: 'server', match: f => /^upgrade-/.test(f) }],
    requiredFiles: [
      'tests/runner-resume.test.mjs', 'tests/storage-transaction-fixes.test.mjs', 'tests/import-integrity-fixes.test.mjs',
      'tests/review-result-durability.test.mjs', 'tests/review-project-integrity.test.mjs',
      // 规范要求恢复层不得遗漏：任务导入、保存冲突、终态持久化/恢复相关
      'tests/import-task-fields.test.mjs', 'tests/review-save-conflict.test.mjs', 'tests/package-recovery.test.mjs',
      'tests/cross-tab-safety.test.mjs', 'tests/task-attribution.test.mjs', 'tests/store-safety-fixes.test.mjs',
      'tests/review-store-resolution-races.test.mjs',
      // 0.5 核心（Sol）交付的故障与恢复测试：404/CAS/首次终态落盘/跨标签/过期本地/导入版本，以及工作流付费保护
      'tests/r05-core-reliability.test.mjs', 'tests/r05-core-workflow.test.mjs', 'tests/r05-core-timeline-provenance.test.mjs',
      // 托管核心（Sol）：账户分区、访客隔离、迟到响应、导入原任务、换 Key 同键重试、工作流与锁
      'tests/hosted-core.test.mjs',
    ],
  },
  {
    name: 'accept', required: true, requires: [],
    discover: [{ dir: 'tests', match: f => /^accept-/.test(f) }],
    requiredFiles: ['tests/accept-r05-service-status.test.mjs', 'tests/accept-r05-timeline-plan.test.mjs', 'tests/accept-fault.test.mjs',
      'tests/accept-r05-task-center.test.mjs', 'tests/accept-r05-core-requests.test.mjs', 'tests/accept-r05-local-security.test.mjs', 'tests/accept-r05-doc-consistency.test.mjs',
      'tests/accept-hosted-base-path.test.mjs', 'tests/accept-hosted-package.test.mjs', 'tests/accept-hosted-session.test.mjs',
      'tests/accept-hosted-deploy-config.test.mjs', 'tests/accept-hosted-evidence.test.mjs', 'tests/accept-hosted-rollout.test.mjs'],
  },
  {
    // 并发浏览器数不超过机器核数（标准 2 核运行器上为 2）：只调度，不改超时或断言
    name: 'e2e', required: true, requires: ['browser', 'ffmpeg'], concurrency: Math.max(1, Math.min(4, availableParallelism())),
    discover: [{ dir: 'tests', match: f => /^e2e-/.test(f) && !E2E_EXCLUDE(f) }, { dir: 'tests', match: f => f === 'e2e.test.mjs' }],
    requiredFiles: ['tests/e2e.test.mjs', 'tests/e2e-accept.test.mjs', 'tests/e2e-chain-recovery.test.mjs', 'tests/e2e-r05-service-version.test.mjs', 'tests/e2e-r05-business.test.mjs', 'tests/e2e-hosted-routing.test.mjs', 'tests/e2e-hosted-business.test.mjs',
      'tests/e2e-under-development.test.mjs', 'tests/e2e-safety-fixes.test.mjs', 'tests/e2e-script-import.test.mjs'],
  },
  {
    // 性能层单独串行运行，不与其他浏览器/编码负载竞争
    name: 'performance', required: true, requires: ['browser'], concurrency: 1,
    requiredFiles: PERFORMANCE.map(f => `tests/${f}`),
  },
  {
    name: 'package', required: true, requires: ['browser'],   // release-package 在干净目录跑主流程（浏览器）
    requiredFiles: ['tests/upgrade-independent-package.test.mjs', 'tests/release-package.test.mjs'],
    postVerify: ['scripts/verify-package.mjs'],
  },
  {
    // 所声明的每种导出能力都需真实媒体验证（本机 FFmpeg MP4 各预设 + 浏览器导出）
    name: 'media', required: true, requires: ['browser', 'ffmpeg'], concurrency: 1,
    requiredFiles: ['tests/e2e-r05-media-export.test.mjs'],
  },
  {
    name: 'hosted-director', required: true, requires: ['browser', 'ffmpeg'], concurrency: 1, strictEvidence: true,
    requiredFiles: [...HOSTED_DIRECTOR_REQUIRED_FILES],
  },
  {
    // 导演台为开发中功能：真实插件资源不随仓库分发。缺资源是登记的可选例外，报告标注「未验收」，
    // 绝不据此宣称导演台已完整验收。资源存在时照常运行且必须通过。
    name: 'director', required: false, requires: ['browser', 'director'], concurrency: 1,
    requiredFiles: ['tests/e2e-director.test.mjs'], env: { E2E_DIRECTOR: '1' },
  },
];

// 跳过例外：只按「文件 + 测试名 + 原因」精确登记。
// 仓库合同副本的跳过由 contracts/approved-copies.json 的登记项逐条生成（与合同测试产生的原因文本完全一致），
// 不存在「最多 N 个跳过」之类的宽泛策略；新增任何跳过都须在此显式登记。
export async function loadSkipAllowlist() {
  const approved = await loadApprovedCopies();
  return approved.map(a => {
    const copy = { version: a.version };
    Object.defineProperty(copy, '__sha256_lf', { value: a.sha256_lf, enumerable: false });
    const r = classifyRepositoryCopy({ path: a.path, copy, pinned: { version: '9999-12-31.1' }, approved: [a] });
    return {
      file: 'server/capability-contract.test.mjs',
      test: `repository copy ${a.path} equals the pinned contract or is an approved historical copy`,
      reason: r.reason,
      why: '已登记历史副本策略（contracts/approved-copies.json）',
    };
  });
}
