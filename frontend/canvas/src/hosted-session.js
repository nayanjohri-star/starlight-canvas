// 托管网页版的登录门与账户控件（界面层）。身份、账户存储与 API 会话全部来自核心的 openHostedCanvasSession：
// 这里不自行判断账户、不从密钥或页面字段推断身份，只负责界面状态与错误说明。
// 纪律：密钥只在内存（keyvault）；不写入地址、存储、日志或导出；切换账户 = 按核心顺序停止旧会话后重新加载页面，
// 旧账户的任务预览、对象 URL 与进行中的请求不可能带入新账户。
import { el } from './ui.js';
import * as keyvault from './keyvault.js';
import { openHostedCanvasSession } from './api.js';

export const STORAGE_NOTICE = '项目和已下载的成片只保存在当前浏览器与设备中：清除浏览器数据会删除它们，也不会同步到其他设备。请用“导出工程包”备份或迁移；本机版的旧项目需要先导出工程包，再在这里导入。按账户分开显示项目只是界面隔离：能使用同一台电脑同一浏览器配置的人仍可能读取这些本地数据，公共或共用电脑上用完请退出并清除浏览器数据。';

export function explainSignInError(e) {
  const code = e?.code ?? '';
  if (code === 'key_required') return '无法确认账号登录状态，请重新登录用户站。';
  if (['auth_required', 'forbidden', 'invalid_key', 'http_401', 'http_403'].includes(code) || e?.status === 401 || e?.status === 403)
    return '用户站登录已失效，或账户当前不可用。请重新登录账号；账户被停用时请联系管理员。';
  if (code === 'identity_unavailable' || e?.status === 503) return '账号服务暂时不可用，请稍后重新连接。';
  if (code === 'unsupported_hosted_api' || code === 'bad_identity') return '托管服务版本与页面不兼容，请稍后刷新页面。';
  if (code === 'identity_changed') return '登录期间账号发生了变化，请重新登录用户站。';
  if (e?.name === 'TypeError') return '无法连接托管服务，请检查网络后重试。';
  return `登录失败：${e?.message ?? '未知错误'}`;
}

// 会话失效分类（hosted-api-contract.md 错误码）：只有“认证已失效”与“身份已变更”使会话失效。
//   401（auth_required 等）→ 失效；403 identity_forbidden（New API 身份核验确认撤权）→ 失效；409 identity_changed → 失效。
//   普通 403 forbidden（某任务无权访问）、其他 409（如 model_billing_unverified 计费门控）、503（身份服务暂不可用）、
//   网络错误——都不是会话失效，不登出。
export function classifySessionResponse(status, code) {
  if (status === 401) return 'auth_invalid';
  if (status === 403 && code === 'identity_forbidden') return 'identity_forbidden';
  if (status === 409 && code === 'identity_changed') return 'identity_changed';
  return null;
}

// 会话守卫：包装 fetch，只观察 401/409 且只读取响应的克隆（调用方拿到的原响应体不被消费）。
// 守卫绑定到单一会话：失效之后，本会话的新请求在本地直接得到 409 identity_changed（不发出、不计费），
// 已发出请求的迟到响应由核心 API 客户端按会话存活检查丢弃。
export function createSessionGuard({ fetchImpl, onInvalid } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  let session = null, invalid = null;
  const refuse = () => new Response(JSON.stringify({ error: { code: 'identity_changed', message: '登录已失效，本会话不再发送请求' } }),
    { status: 409, headers: { 'content-type': 'application/json' } });
  const guard = {
    get invalid() { return invalid; },
    bind(s) { session = s; },
    async fetch(url, opts) {
      if (invalid) return refuse();
      const bound = session;
      const res = await doFetch(url, opts);
      if (!bound || bound !== session || invalid) return res;       // 登录过程中、或迟到到换会话之后：不作判断
      if (res.status !== 401 && res.status !== 403 && res.status !== 409) return res;
      let code = null;
      if (res.status !== 401) { try { code = (await res.clone().json())?.error?.code ?? null; } catch { code = null; } }
      const kind = classifySessionResponse(res.status, code);
      if (kind && bound === session && !invalid) { invalid = { kind, at: Date.now(), url: String(url).replace(/\?.*$/, '') }; onInvalid?.(invalid, bound); }
      return res;
    },
  };
  return guard;
}

// 登录门：未通过服务器核验前不启动画布；成功后返回 { identity, features, storage, api, invalidate, guard }
export function signInGate({ rawStorage, base, fetchImpl, onSessionInvalid }) {
  return new Promise(resolve => {
    const status = el('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const retry = el('button', { class: 'primary', type: 'button', text: '重新连接', hidden: true });
    const login = el('a', { href: '/login?canvas=1', text: '使用账号登录', hidden: true });
    const card = el('section', { class: 'hosted-gate' },
      el('h2', { text: '星光智能画布' }),
      el('p', { text: '使用星盘账号直接进入画布，无需额外设置。' }),
      status, el('div', { class: 'modal-actions' }, retry, login),
      el('p', { class: 'hint hosted-storage-notice', text: STORAGE_NOTICE }));
    const overlay = document.getElementById('hosted-bootstrap') ?? el('div', { id: 'hosted-bootstrap', class: 'hosted-gate-mask' });
    overlay.replaceChildren(card);
    if (!overlay.isConnected) document.body.append(overlay);
    document.body.setAttribute('data-session-pending', '');
    let attempt = 0;
    async function connect(mine, portalBinding) {
      const guard = createSessionGuard({ fetchImpl, onInvalid: (info, bound) => onSessionInvalid?.(info, bound) });
      const session = await openHostedCanvasSession({ storage: rawStorage, getKey: keyvault.getKey, fetchImpl: (u, o) => guard.fetch(u, o), base });
      if (mine !== attempt) { session.invalidate(); return; }
      if (portalBinding && session.identity.subject !== portalBinding.subject) {
        session.invalidate(); throw Object.assign(new Error('用户站账户已切换'), { code: 'identity_changed' });
      }
      session.portalBound = !!portalBinding;
      session.guard = guard; guard.bind(session);
      status.textContent = '登录已确认，正在打开画布…'; resolve(session);
    }
    // This read-only bootstrap never refreshes or writes a login cookie, and
    // is never retried after a bound session changes accounts.
    async function bootstrap() {
      const mine = ++attempt;
      retry.hidden = true; retry.disabled = true; login.hidden = true;
      status.className = 'hint'; status.textContent = '正在确认账号登录…';
      try {
        const response = await (fetchImpl ?? globalThis.fetch.bind(globalThis))(`${base ?? '/canvas-api'}/session`, {
          method: 'GET', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000),
        });
        if (mine !== attempt) return;
        if (response.status === 401) {
          keyvault.clearKey(); status.textContent = '正在前往账号登录…';
          location.replace('/login?canvas=1'); return;
        }
        if (!response.ok) throw Object.assign(new Error('暂时无法核验用户站登录'), { status: response.status });
        const binding = await response.json();
        if (mine !== attempt) return;
        if (!/^cs1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(binding?.credential) || !/^[a-f0-9]{16}$/.test(binding?.fingerprint) || !/^u[1-9][0-9]*$/.test(binding?.subject))
          throw new Error('用户站登录响应无效');
        await keyvault.setKey(binding.credential, { verifiedFingerprint: binding.fingerprint });
        await connect(mine, binding);
      } catch (err) {
        if (mine !== attempt) return;
        keyvault.clearKey(); status.className = 'err-text'; status.textContent = explainSignInError(err);
        retry.hidden = false; login.hidden = false;
      } finally { if (mine === attempt) retry.disabled = false; }
    }
    retry.addEventListener('click', () => { void bootstrap(); });
    void bootstrap();
  });
}

export function finishHostedStartup() {
  document.getElementById('hosted-bootstrap')?.remove();
  document.body.removeAttribute('data-session-pending');
}

// 账户切换/退出：按核心合同顺序停止旧会话（工作流 → 任务运行器 → 尽力落盘 → 使会话失效），再清除内存密钥并重新加载页面。
// 调用方负责在此之前向用户说明尚未写入本机的任务状态（重新登录后会按原任务号重新查询，不会重新生成）。
export async function endHostedSession({ session, runner, workflow, store }) {
  await workflow?.stopForIdentityChange?.();
  const stopped = runner?.stopForIdentityChange?.() ?? {};
  try { await store?.flushForSwitch?.(); } catch { /* 尽力保存 */ }
  session?.invalidate?.();
  keyvault.clearKey();
  if (session?.portalBound) location.assign('/console');
  else location.reload();
  return stopped;
}
