// 构建期运行形态：生成 dist 中的 runtime-config.js。托管形态的每个值都经过校验，
// 不能把请求指向其他主机、协议相对地址或开发服务器。

export const SUPPORTED_HOSTED_API = '/canvas-api';
export const HOSTED_DEFAULTS = Object.freeze({
  basePath: '/canvas/',
  // 托管 API 路由：hosted-api-contract.md —— 同源专用适配层 /canvas-api（每次请求由服务端核验用户 Key 的账户）
  apiBase: '/canvas-api',
  readyUrl: '/canvas-api/features',
  blockedModels: {},
});

const SITE_PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]*$/;
export function validateSitePath(name, value, { allowEmpty = false, trailingSlash = false } = {}) {
  if (value === '' && allowEmpty) return value;
  if (typeof value !== 'string' || !SITE_PATH.test(value) || value.includes('..') || value.includes('\\'))
    throw new Error(`${name} 必须是以单个 / 开头的站内路径（不能是其他主机或协议相对地址）：${JSON.stringify(value)}`);
  if (trailingSlash && !value.endsWith('/')) throw new Error(`${name} 必须以 / 结尾：${value}`);
  if (!trailingSlash && value.length > 1 && value.endsWith('/')) throw new Error(`${name} 不能以 / 结尾：${value}`);
  return value;
}

export function resolveRuntime({ mode = 'local', basePath, apiBase, readyUrl } = {}) {
  if (mode === 'local') {
    return { mode, basePath: '/', apiBase: '/site', readyUrl: '/health',
      features: { localService: true, serverRender: true, workspace: true, director: true, hostedDirector: true }, blockedModels: {} };
  }
  if (mode !== 'hosted') throw new Error(`未知构建形态：${mode}（只能是 local 或 hosted）`);
  // 托管 API 根只支持合同的固定同源路径 /canvas-api（核心客户端 hostedBase() 只接受它）；
  // 就绪检查必须是同一根下的功能探测。空值、其他路径、其他主机或协议相对地址一律在构建期拒绝。
  const api = validateSitePath('apiBase', apiBase ?? HOSTED_DEFAULTS.apiBase);
  if (api !== SUPPORTED_HOSTED_API) throw new Error(`apiBase 只支持 ${SUPPORTED_HOSTED_API}（托管 API 合同），收到：${JSON.stringify(api)}`);
  const ready = validateSitePath('readyUrl', readyUrl ?? HOSTED_DEFAULTS.readyUrl);
  if (ready !== `${api}/features`) throw new Error(`readyUrl 必须是 ${api}/features（与 API 根一致），收到：${JSON.stringify(ready)}`);
  return {
    mode,
    basePath: validateSitePath('basePath', basePath ?? HOSTED_DEFAULTS.basePath, { trailingSlash: true }),
    apiBase: api,
    readyUrl: ready,
    features: { localService: false, serverRender: false, workspace: false, director: true, hostedDirector: true },
    blockedModels: { ...HOSTED_DEFAULTS.blockedModels },
  };
}

export function runtimeModuleSource(rt) {
  const freeze = v => (v && typeof v === 'object' ? `Object.freeze(${JSON.stringify(v)})` : JSON.stringify(v));
  return '// 由 scripts/build.mjs 生成：本产物的运行形态（见 src/runtime-config.js 的说明）。\n' +
    'export const RUNTIME = Object.freeze({\n' +
    `  mode: ${JSON.stringify(rt.mode)},\n  basePath: ${JSON.stringify(rt.basePath)},\n  apiBase: ${JSON.stringify(rt.apiBase)},\n  readyUrl: ${JSON.stringify(rt.readyUrl)},\n` +
    `  features: ${freeze(rt.features)},\n  blockedModels: ${freeze(rt.blockedModels)},\n});\n\n` +
    "export const isHosted = () => RUNTIME.mode === 'hosted';\n" +
    'export const feature = name => RUNTIME.features?.[name] === true;\n' +
    'export const newGenerationBlock = modelId => RUNTIME.blockedModels?.[modelId] ?? null;\n';
}
