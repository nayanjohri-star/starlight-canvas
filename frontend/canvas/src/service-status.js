// 本机服务状态与前后端版本匹配（纯逻辑，可在 node 中测试）。
//
// 导演台状态只有四种：checking（检测中）/ available（已确认可用）/ unavailable（服务确认缺资源）/
// failed（检测失败：超时、连接失败、响应异常或旧服务未报告所需字段）。只有 available 才允许创建或打开导演台；
// 其余状态一律说明原因并提供重试，绝不「未知即放行」。
//
// 版本匹配以运行中服务在 /health 报告的 apiLevel / version 为准（服务启动时确定，不读磁盘新文件冒充），
// 页面自身版本来自构建生成的 build-info.js（页面实际加载的代码）。

import { RUNTIME } from './runtime-config.js';

export const HOSTED_DIRECTOR_REASON = '3D 导演台为开发中功能，托管网页版暂不提供；已有工程中的导演台节点会原样保留';

// 托管就绪检查：只认同源固定路由返回的 { ok:true, apiLevel?, version? }；本机 /health 成功不代表托管可用；托管以 /canvas-api/features 为准
export function classifyHostedReady(ready, build) {
  // 托管适配层的功能探测（GET /canvas-api/features）：{ mode:'hosted', apiVersion:1, features:{…} }
  if (ready && ready.mode === 'hosted' && ready.apiVersion !== 1)
    return { compat: 'service-outdated', compatReason: `托管接口版本 ${ready.apiVersion} 与页面不兼容` };
  if (ready && ready.mode === 'hosted' && ready.apiVersion === 1) return { compat: 'ok', compatReason: null };
  if (!ready || typeof ready !== 'object' || ready.ok !== true)
    return { compat: 'unknown', compatReason: '托管服务未就绪或响应异常，生成与下载可能失败，请稍后刷新' };
  const required = Number.isInteger(build?.requiresServerApi) ? build.requiresServerApi : null;
  if (Number.isInteger(ready.apiLevel) && required != null && ready.apiLevel < required)
    return { compat: 'service-outdated', compatReason: `托管服务协议 ${ready.apiLevel} 低于页面 ${build?.version ?? '?'} 所需的 ${required}` };
  if (Number.isInteger(ready.apiLevel) && required != null && ready.apiLevel > required)
    return { compat: 'page-outdated', compatReason: `页面 ${build?.version ?? '?'} 比托管服务旧，请刷新页面` };
  return { compat: 'ok', compatReason: null };
}

export const DIRECTOR_STATES = Object.freeze(['checking', 'available', 'unavailable', 'failed']);

export function classifyHealth(health, build) {
  const out = { director: 'failed', directorReason: null, compat: 'ok', compatReason: null };
  if (!health || typeof health !== 'object' || health.ok !== true || health.service !== 'xingpan-canvas') {
    out.directorReason = '本机服务响应异常，无法确认导演台资源';
    out.compat = 'unknown'; out.compatReason = '本机服务响应异常';
    return out;
  }
  const required = Number.isInteger(build?.requiresServerApi) ? build.requiresServerApi : null;
  if (!Number.isInteger(health.apiLevel)) {
    out.compat = 'service-outdated';
    out.compatReason = `当前运行的本机服务版本较旧（${health.version ?? '未报告版本'}），与页面 ${build?.version ?? '?'} 不匹配`;
  } else if (required != null && health.apiLevel < required) {
    out.compat = 'service-outdated';
    out.compatReason = `当前运行的本机服务（${health.version ?? '?'}，协议 ${health.apiLevel}）低于页面 ${build?.version ?? '?'} 所需的协议 ${required}`;
  } else if (required != null && health.apiLevel > required) {
    out.compat = 'page-outdated';
    out.compatReason = `页面 ${build?.version ?? '?'} 比当前本机服务（${health.version ?? '?'}，协议 ${health.apiLevel}）旧，请刷新页面`;
  } else if (health.version && build?.version && build.version !== 'dev' && health.version !== build.version) {
    out.compat = 'version-differs';
    out.compatReason = `页面 ${build.version} 与本机服务 ${health.version} 版本号不同（协议一致，可以使用）`;
  }
  const d = health.director;
  if (!d || typeof d.available !== 'boolean') {
    out.director = 'failed';
    out.directorReason = '本机服务未报告导演台资源状态（服务版本较旧），请重启本机服务后重试';
  } else if (d.available) {
    out.director = 'available';
  } else {
    out.director = 'unavailable';
    out.directorReason = d.reason || '缺少导演台插件资源';
  }
  return out;
}

export function createServiceStatus({ fetchImpl = globalThis.fetch, build, timeoutMs = 4000, onChange, runtime = RUNTIME } = {}) {
  const st = { director: runtime.features?.hostedDirector ? 'available' : 'checking', directorReason: null, compat: 'unknown', compatReason: null, health: null, checkedAt: null };
  let inflight = null;
  async function checkHosted() {
    // 托管形态：绝不访问本机服务；导演台直接为不可用（有具体原因），不因检测失败/未知而创建空节点
    st.director = runtime.features?.hostedDirector ? 'available' : 'unavailable';
    st.directorReason = runtime.features?.hostedDirector ? null : HOSTED_DIRECTOR_REASON; st.health = null;
    if (!runtime.readyUrl) { st.compat = 'not-checked'; st.compatReason = null; st.checkedAt = Date.now(); onChange?.(st); return st; }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), timeoutMs);
    try {
      const r = await fetchImpl(runtime.readyUrl, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ctl?.signal });
      Object.assign(st, classifyHostedReady(r?.ok ? await r.json() : null, build));
    } catch { Object.assign(st, classifyHostedReady(null, build)); }
    finally { clearTimeout(timer); st.checkedAt = Date.now(); onChange?.(st); }
    return st;
  }
  async function check() {
    if (runtime.mode === 'hosted') return checkHosted();
    if (inflight) return inflight;
    st.director = runtime.features?.hostedDirector ? 'available' : 'checking'; st.directorReason = null;
    onChange?.(st);
    inflight = (async () => {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctl?.abort(), timeoutMs);
      try {
        const r = await fetchImpl('/health', { cache: 'no-store', signal: ctl?.signal });
        if (!r?.ok) throw Object.assign(new Error(`HTTP ${r?.status}`), { kind: 'http' });
        const health = await r.json();
        st.health = health;
        Object.assign(st, classifyHealth(health, build));
        if (runtime.features?.hostedDirector) { st.director = 'available'; st.directorReason = null; }
      } catch (e) {
        st.health = null;
        const reason = e?.name === 'AbortError' ? '检测本机服务超时' : e?.kind === 'http' ? `本机服务返回错误（${e.message}）` : '无法连接本机服务';
        st.director = runtime.features?.hostedDirector ? 'available' : 'failed';
        st.directorReason = runtime.features?.hostedDirector ? null : reason;
        st.compat = 'unknown'; st.compatReason = reason;
      } finally {
        clearTimeout(timer);
        st.checkedAt = Date.now();
        inflight = null;
        onChange?.(st);
      }
      return st;
    })();
    return inflight;
  }
  return { state: st, check };
}
