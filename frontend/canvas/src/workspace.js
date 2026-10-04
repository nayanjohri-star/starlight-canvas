// 云端工作区客户端：账户登录状态 / 云端项目库 / 修订冲突显式处理 / 邀请与成员 / 在线提示与远端变更轮询。
//
// 密钥纪律：只经 getKey() 从内存密钥库取；仅放进 Authorization 头，只发向同源固定 /workspace/* 路由；
// 不写进 URL/请求体/日志/存储，不跟随重定向，不 fetch 响应里的任何不透明 URL。
// 身份纪律：subject 完全由服务端经固定账户接口验证返回——客户端不构造/不信任任何调用方 userId。
// 可用性纪律：账户接口未部署/验证失败时如实报告"云端不可用"；本地项目功能完全不受影响，绝不回退匿名云端。
// 安全边界：拉取一律经 store.importJSON/importProjectPackage（新 id + 任务保护重建），
// 云端快照不会覆盖本地项目；同步/撤销/分享/兑换都不会自动运行付费任务。

import { el, toast, modal, confirmDialog, fmtTime, fmtBytes } from './ui.js';
import { getKey as vaultGetKey, getFingerprint as vaultGetFp } from './keyvault.js';
import { buildProjectPackage, importProjectPackage } from './export-project.js';

export class WorkspaceError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const enc = encodeURIComponent;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseClaimToken(text) {
  const s = String(text ?? '').trim();
  const m = /[#?&]ws-claim=([A-Za-z0-9_-]{16,200})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{16,200}$/.test(s) ? s : null;
}

// 面板远端轮询助手（纯逻辑，独立可测）：定时器只负责到点触发，每拍都重新解析
// 当时的项目 / 云端链接 / 密钥——闭包绝不持有旧 link。
//  · 自己 push 后链接 head 已前进，不会把自家修订误报成「远端已更新」；
//  · 任一 await 之后发现项目切换 / 密钥变更 / 面板关闭（alive=false）→ 本拍作废：
//    不写 remoteNotice、不渲染、不发 presence；
//  · 轮询飞行中链接被改写（推送/换绑/断开）→ 结果作废，下一拍按新链接评估。
// 返回 {tick, tickPeers, stop, stopped}；onNotice(r, ctx)/onPeers(peers, ctx) 收到本拍上下文。
export function createRemoteWatch({ alive, getProjectId, getLink, getKey, checkRemote, isDirty, beat, onNotice, onPeers } = {}) {
  let stopped = false;
  const isAlive = typeof alive === 'function' ? alive : () => true;
  const live = () => !stopped && isAlive() !== false;
  async function snapshot() {
    if (!live()) return null;
    const pid = getProjectId?.() ?? null;
    const key = getKey?.() ?? null;
    if (!pid || !key) return null;
    const l = await getLink(pid);
    if (!l || !live()) return null;
    const ctx = {
      pid, key, l,
      fresh: () => live() && (getProjectId?.() ?? null) === pid && (getKey?.() ?? null) === key,
    };
    ctx.linkFresh = async () => {
      if (!ctx.fresh()) return false;
      const cur = await getLink(pid);
      // 二次读链接的 await 期间项目切换/密钥更换/面板关闭都可能发生——结果回来必须重查身份，
      // 否则旧拍会按过期身份把已作废的轮询结果继续发布出去
      if (!ctx.fresh()) return false;
      return !!cur && cur.id === l.id && cur.owner === l.owner && cur.head === l.head;
    };
    return ctx;
  }
  async function tick() {
    const s = await snapshot();
    if (!s?.fresh()) return;
    const r = await checkRemote(s.l);
    if (!s.fresh() || !(await s.linkFresh())) return;
    if (r?.changed) onNotice?.(r, s);
  }
  async function tickPeers() {
    const s = await snapshot();
    if (!s?.fresh()) return;
    const dirty = await isDirty();
    // 写 presence 前最后一道闸：isDirty 的 await 期间身份/链接任一漂移都不能 beat——
    // 尤其链接已换绑或已推进时，向旧链接写 presence 会污染远端在线名单
    if (!s.fresh() || !(await s.linkFresh())) return;
    const r = await beat(s.l, dirty);
    if (!s.fresh() || !(await s.linkFresh())) return;
    onPeers?.(r?.peers ?? [], s);
  }
  return { tick, tickPeers, stop: () => { stopped = true; }, get stopped() { return stopped; } };
}

export function createWorkspace(deps = {}) {
  const { store, storage } = deps;
  const fetchImpl = deps.fetch ?? globalThis.fetch?.bind(globalThis);
  const getKey = deps.getKey ?? vaultGetKey;
  const getFp = deps.getFingerprint ?? vaultGetFp;
  const sessionClient = `c_${Math.random().toString(36).slice(2, 10)}`;
  const linkKey = localPid => `ws:link:${localPid}`;
  const pendKey = localPid => `ws:pending:${localPid}`;   // create 已发出但响应/结果未落地时的对账记录

  function requireKey() {
    const k = getKey?.();
    if (!k) throw new WorkspaceError('no_key', '请先在画布中输入本站 API Key');
    return k;
  }
  async function api(path, { method = 'GET', json, rawBody, ifMatch, ifNoneMatch, key } = {}) {
    const k = key ?? requireKey();
    const headers = { Authorization: `Bearer ${k}`, Accept: 'application/json' };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (ifMatch != null) headers['If-Match'] = `r${ifMatch}`;
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    let res;
    try {
      res = await fetchImpl(`/workspace${path}`, {
        method, headers, credentials: 'omit', redirect: 'manual',
        body: json !== undefined ? JSON.stringify(json) : rawBody,
      });
    } catch (e) { throw new WorkspaceError('network_error', '无法连接本地工作区服务', { cause: e }); }
    if (res.status === 304) return { notModified: true, status: 304 };
    let payload = null;
    try { payload = await res.json(); } catch { /* 二进制/空响应 */ }
    if (!res.ok) {
      const er = payload?.error ?? {};
      throw new WorkspaceError(typeof er.code === 'string' ? er.code : `http_${res.status}`,
        typeof er.message === 'string' ? er.message : `请求失败（${res.status}）`,
        { status: res.status, head: er.head, base: er.base });
    }
    return payload;
  }
  async function apiBuffer(path, { key } = {}) {
    const k = key ?? requireKey();
    let res;
    try { res = await fetchImpl(`/workspace${path}`, { method: 'GET', headers: { Authorization: `Bearer ${k}`, Accept: 'application/octet-stream' }, credentials: 'omit', redirect: 'manual' }); }
    catch (e) { throw new WorkspaceError('network_error', '无法连接本地工作区服务', { cause: e }); }
    if (!res.ok) {
      let er = {};
      try { er = (await res.json())?.error ?? {}; } catch { /* noop */ }
      throw new WorkspaceError(er.code ?? `http_${res.status}`, er.message ?? `请求失败（${res.status}）`, { status: res.status, head: er.head, base: er.base });
    }
    const buf = await res.arrayBuffer();
    const rev = Number(res.headers?.get?.('x-workspace-rev')) || null;
    return { buf: new Uint8Array(buf), rev, etag: res.headers?.get?.('etag') ?? null };
  }

  // ---------- 状态 / 链接 ----------
  async function status() {
    if (!getKey?.()) return { state: 'no_key' };
    try {
      const r = await api('/identity');
      return { state: 'ok', subject: r.subject, displayName: r.displayName ?? null };
    } catch (e) {
      if (e.code === 'no_key') return { state: 'no_key' };
      if (e.code === 'key_rejected' || e.code === 'key_required') return { state: 'key_rejected' };
      return { state: 'unavailable', reason: e.code, message: e.message };
    }
  }
  const getLink = localPid => storage.get(linkKey(localPid));
  const setLink = (localPid, info) => storage.set(linkKey(localPid), info);
  const link = async () => store.project ? getLink(store.project.id) : null;
  const unlink = async () => { if (store.project) await storage.del(linkKey(store.project.id)); };
  const isDirty = async () => {
    const p = store.project; if (!p) return false;
    const l = await getLink(p.id);
    return !!l && (p.rev ?? 0) !== l.localRev;
  };
  // 进行中任务守卫：节点存在已受理/未决提交即视为"有在飞任务"——远端更新绝不自动应用
  const hasInflightTasks = p => (p?.nodes ?? []).some(n => n.data?.run && (n.data.run.taskId || n.data.run.pendingKey));

  // ---------- 打包 / 推送 / 拉取 ----------
  async function buildLocalPackage(project) {
    // 冻结素材清单（深拷贝）：打包期间的重绑/增删不改清单身份；blob 字节与清单 size 不符即中止，
    // 否则可能产出“文档新/媒体旧”的混包。时间线取自导出文档自身——与 project.json 严格一致。
    const frozenAssets = JSON.parse(JSON.stringify(project.assets ?? {}));
    const projectJson = await store.exportJSON();            // 内含 flush（rev 可能 +1）
    let st = {};
    try { const doc = JSON.parse(projectJson); if (isObj(doc?.project?.studio)) st = doc.project.studio; } catch { /* 导出文档由 store 保证合法 */ }
    const blobOf = async id => {
      const want = frozenAssets[id];
      const b = await storage.getBlob(`blob:${id}`);
      if (b && want && Number.isFinite(want.size) && b.size !== want.size)
        throw new WorkspaceError('package_changed', `素材「${want.name ?? id}」在打包期间被修改，未上传`);
      return b;
    };
    return buildProjectPackage({ projectJson, clips: st.timeline ?? [], meta: st.timelineMeta, blobOf, assets: frozenAssets });
  }
  const build = deps.buildPackage ?? buildLocalPackage;

  async function pushTo(ref, pkg, baseRev, key) {
    return api(`/projects/${enc(ref.owner)}/${ref.id}`, { method: 'PUT', rawBody: pkg, ifMatch: baseRev, key });
  }
  async function createCloud(name, key, clientRequestId) {
    const r = await api('/projects', { method: 'POST', json: { name, clientRequestId }, key });
    return r.project;
  }
  async function saveAsNewCloudCopy(name, pkg, key, localId, localRev, subject, guard) {
    const pk = pendKey(localId);
    let pend = await storage.get(pk);
    guard();
    if (pend && pend.subject !== subject) throw new WorkspaceError('account_changed', '待确认创建属于另一账户，请切回原账户核对');
    if (pend && !pend.clientRequestId) throw new WorkspaceError('creation_uncertain', '旧创建结果待核对，请从工作区列表打开对应项目；不会按同名覆盖其他工程');
    if (!pend) {
      pend = { name, subject, clientRequestId: crypto.randomUUID(), at: Date.now() };
      await storage.set(pk, pend); guard();
    }
    let created = pend.created;
    if (!created) {
      created = await createCloud(pend.name, key, pend.clientRequestId);
      guard();
      pend.created = created;
      await storage.set(pk, pend); guard();
    }
    // 只允许首次写入 r0。响应丢失后绝不按名字认领或覆盖已存在的修订。
    if (created.head > 0) throw new WorkspaceError('creation_already_saved', '项目已保存，请从工作区列表拉取核对；本次未覆盖现有内容', { ref: created });
    const pushed = await pushTo(created, pkg, 0, key);
    guard();
    await setLink(localId, { owner: created.owner, id: created.id, head: pushed.head, localRev, subject, role: 'owner' });
    guard();
    await storage.del(pk);
    return { created: true, reconciled: created.reconciled === true, id: created.id, owner: created.owner, rev: pushed.head };
  }

  // 推送当前项目到云端。冲突（409）不静默覆盖：交回结构化 conflict 或经 onConflict 走显式选择。
  async function backup({ name, onConflict } = {}) {
    const key = requireKey();
    const project = store.project;
    if (!project) throw new WorkspaceError('no_project', '没有打开的项目');
    const localId = project.id;
    const guard = () => {   // 每次 await 后复核：项目被切换或密钥更换 → 中止，防止把错的项目绑到错的身份
      if (store.project !== project) throw new WorkspaceError('project_changed', '操作期间当前项目已切换，未继续');
      if (getKey?.() !== key) throw new WorkspaceError('key_changed', '密钥在操作期间变更，未继续');
    };
    const me = await api('/identity', { key });
    guard();
    const existing = await getLink(localId);
    guard();
    if (existing && existing.subject !== me.subject)
      throw new WorkspaceError('account_changed', '云端链接由其他账户创建，未推送（可在面板中断开链接后重传）');
    await store.flush();
    guard();
    // 冻结文档签名（rev/updatedAt 除外——exportJSON 的 flush 合法 +1）：
    // 打包期间任何节点/边/素材/草稿改动 → 签名不符 → 中止，不产出一半新一半旧的混包
    const frozen = JSON.stringify({ ...project, rev: 0, updatedAt: 0 });
    const pkg = await build(project);
    guard();
    if (JSON.stringify({ ...project, rev: 0, updatedAt: 0 }) !== frozen)
      throw new WorkspaceError('project_changed', '打包期间项目内容发生变化，未上传');
    const localRev = project.rev ?? 0;
    if (!existing) return saveAsNewCloudCopy(name ?? project.name, pkg, key, localId, localRev, me.subject, guard);
    try {
      const pushed = await pushTo(existing, pkg, existing.head, key);
      guard();
      await setLink(localId, { ...existing, head: pushed.head, localRev, subject: me.subject, role: existing.role ?? 'owner' });
      return { created: false, id: existing.id, owner: existing.owner, rev: pushed.head };
    } catch (e) {
      if (e.code === 'revision_conflict') {
        const conflict = { owner: existing.owner, id: existing.id, head: e.head, base: existing.head };
        if (onConflict) {
          const choice = await onConflict(conflict);
          guard();   // 用户在对话框思考期间项目/密钥可能已变——变了就丢弃选择
          if (choice === 'pull_copy') return { resolved: 'pull_copy', pulled: await pull(existing) };
          if (choice === 'new_copy') return { resolved: 'new_copy', ...(await saveAsNewCloudCopy(`${project.name}（冲突副本）`, pkg, key, localId, localRev, me.subject, guard)) };
          return { cancelled: true };
        }
        e.conflict = conflict;
      }
      throw e;
    }
  }

  // 拉取云端项目为本地新项目（importProjectPackage 全量消毒 + 新 id + 任务保护；当前项目不被覆盖）
  async function pull(ref, { rev, version } = {}) {
    const key = requireKey();
    const projectAtStart = store.project;   // 拉取期间项目被切换 → 中止：晚到的导入不得劫持新项目上下文
    const assertCurrent = () => {
      if (getKey?.() !== key) throw new WorkspaceError('key_changed', '密钥在拉取期间变更，已中止');
      if (store.project !== projectAtStart) throw new WorkspaceError('project_changed', '拉取期间当前项目已切换，已中止（远端内容未导入）');
    };
    const me = await api('/identity', { key });
    assertCurrent();
    const qs = version != null ? `?version=${enc(version)}` : rev != null ? `?rev=${rev}` : '';
    const { buf, rev: gotRev } = await apiBuffer(`/projects/${enc(ref.owner)}/${ref.id}/package${qs}`, { key });
    assertCurrent();
    const result = await importProjectPackage({ store, storage, assets: deps.assets, assertCurrent }, buf);
    if (getKey?.() !== key) throw new WorkspaceError('key_changed', '密钥在导入期间变更，链接未写入');
    if (store.project !== result.project) throw new WorkspaceError('project_changed', '导入后项目已切换，链接未写入');
    await setLink(result.project.id, { owner: ref.owner, id: ref.id, head: gotRev ?? ref.head ?? 0, localRev: result.project.rev ?? 0, subject: me.subject, role: ref.role ?? null });
    return { ...result, rev: gotRev };
  }
  const pullVersion = (ref, version) => pull(ref, { version });
  async function fork(ref, { name, rev } = {}) {
    requireKey();
    const r = await api(`/projects/${enc(ref.owner)}/${ref.id}/fork`, { method: 'POST', json: { name, rev } });
    return r.project;
  }

  // ---------- 列表 / 修订 / 版本 ----------
  const cloudList = async () => (await api('/projects')).projects ?? [];
  const cloudMeta = ref => api(`/projects/${enc(ref.owner)}/${ref.id}`);
  const cloudRevisions = ref => api(`/projects/${enc(ref.owner)}/${ref.id}/revisions`);
  const createVersion = (ref, name, rev) => api(`/projects/${enc(ref.owner)}/${ref.id}/versions`, { method: 'POST', json: { name, rev } });
  const cloudRename = (ref, name) => api(`/projects/${enc(ref.owner)}/${ref.id}/rename`, { method: 'POST', json: { name } });

  // ---------- 成员 / 邀请（均服务端 ACL，UI 只做展示） ----------
  const members = ref => api(`/projects/${enc(ref.owner)}/${ref.id}/members`);
  const setMember = (ref, subject, role) => api(`/projects/${enc(ref.owner)}/${ref.id}/members/${enc(subject)}`, { method: 'PUT', json: { role } });
  const removeMember = (ref, subject) => api(`/projects/${enc(ref.owner)}/${ref.id}/members/${enc(subject)}`, { method: 'DELETE' });
  const createShare = async (ref, { role = 'viewer', expiresInHours } = {}) => {
    const r = await api(`/projects/${enc(ref.owner)}/${ref.id}/shares`, { method: 'POST', json: { role, expiresInHours } });
    const origin = typeof location !== 'undefined' ? location.origin : '';
    return { ...r, url: origin + '/' + r.invite.fragment };
  };
  const revokeShare = (ref, sid) => api(`/projects/${enc(ref.owner)}/${ref.id}/shares/${enc(sid)}`, { method: 'DELETE' });
  async function claim(input) {
    const key = requireKey();
    const token = parseClaimToken(input);
    if (!token) throw new WorkspaceError('invite_invalid', '邀请链接/令牌格式不合法');
    const r = await api('/claim', { method: 'POST', json: { token }, key });
    if (getKey?.() !== key) throw new WorkspaceError('key_changed', '密钥在兑换期间变更，请以新密钥重新确认成员状态');
    // 兑换成功后从地址栏剥离片段——令牌不应停留在 history/分享里
    if (typeof location !== 'undefined' && typeof history !== 'undefined' && location.hash.includes('ws-claim'))
      history.replaceState(null, '', location.pathname + location.search);
    return r;
  }

  // ---------- 远端轮询 + 在线提示 ----------
  async function checkRemote(l) {
    try {
      const r = await api(`/projects/${enc(l.owner)}/${l.id}`, { ifNoneMatch: `"r${l.head}"` });
      if (r.notModified) return { changed: false, head: l.head };
      const head = r.project?.head ?? l.head;
      return { changed: head !== l.head, head, meta: r };
    } catch (e) { return { changed: false, error: e.code }; }
  }
  const beat = (ref, editing) => api(`/projects/${enc(ref.owner)}/${ref.id}/presence`, { method: 'POST', json: { clientId: `${getFp?.() ?? 'nofp'}:${sessionClient}`, editing: !!editing } });
  const peers = ref => api(`/projects/${enc(ref.owner)}/${ref.id}/presence`);

  // ---------- 冲突对话框：拉取审阅 / 另存新副本 / 取消——永不静默覆盖 ----------
  function conflictDialog({ head, base }) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; close(); resolve(v); } };
      const pull = el('button', { class: 'primary', type: 'button', text: '拉取远端为本地副本' });
      const copy = el('button', { type: 'button', text: '另存为新的云端项目' });
      const cancel = el('button', { type: 'button', text: '取消' });
      const { close } = modal(el('div', {},
        el('h3', { text: '远端已有更新，发生冲突' }),
        el('div', { class: 'modal-body' },
          el('p', { text: `云端已到 r${head}，你的基线是 r${base}。为避免覆盖他人改动，本次推送未生效。` }),
          el('p', { class: 'hint', text: '本地草稿完全保留。可先拉取远端副本审阅差异，或把当前内容另存为新的云端项目。' })),
        el('div', { class: 'modal-actions' }, cancel, copy, pull)), { onClose: () => finish('cancel') });
      pull.addEventListener('click', () => finish('pull_copy'));
      copy.addEventListener('click', () => finish('new_copy'));
      cancel.addEventListener('click', () => finish('cancel'));
    });
  }

  // ---------- 面板 ----------
  function open() {
    if (typeof document === 'undefined' || !document.getElementById) return null;
    const box = el('div', {});
    let disposed = false;
    const timers = [];
    const state = { st: null, list: [], sel: null, detail: null, memberInfo: null, remoteNotice: null, peerList: [], peerProjectId: null, invite: null };
    const rerender = () => render().catch(e => box.replaceChildren(el('p', { class: 'err-text', text: e.message })));
    // 远端轮询/心跳走同一个 watch：每拍重读「当时的」项目 + 链接 + 密钥（见 createRemoteWatch），
    // 闭包不钉旧 head——自己 push、切项目、换 key、关面板都不会留下误报或向旧项目写 presence。
    const watch = createRemoteWatch({
      alive: () => !disposed,
      getProjectId: () => store.project?.id ?? null,
      getLink, getKey, checkRemote, isDirty, beat,
      onNotice: (r, s) => {
        if (state.remoteNotice && state.remoteNotice.id === s.l.id && state.remoteNotice.head === r.head) return;
        state.remoteNotice = { head: r.head, id: s.l.id, owner: s.l.owner, projectId: s.pid };
        rerender();
      },
      onPeers: (list, s) => { state.peerList = list; state.peerProjectId = s.pid; rerender(); },
    });
    const { close } = modal(el('div', {}, el('h3', { text: '云端工作区' }), box), { wide: true, onClose: () => { disposed = true; watch.stop(); timers.forEach(clearInterval); state.invite = null; } });
    const run = (b, fn) => async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'err', 5000); } finally { b.disabled = false; } rerender(); };
    const btn = (text, fn, cls = 'mini') => { const b = el('button', { class: cls, type: 'button', text }); b.addEventListener('click', run(b, fn)); return b; };

    function startWatch() {
      if (timers.length) return;
      const kick = fn => () => fn().catch(() => {});   // 轮询内部失败不冒泡成未处理拒绝
      timers.push(setInterval(kick(watch.tick), 15_000));
      timers.push(setInterval(kick(watch.tickPeers), 20_000));
    }

    async function render() {
      state.st = await status();
      const st = state.st;
      // 邀请链接只活在面板内存态：连接断开 / 账户或密钥指纹变化一律丢弃（不写存储、不进剪贴板）
      if (state.invite && (st.state !== 'ok' || st.subject !== state.invite.subject || (getFp?.() ?? null) !== state.invite.fp)) state.invite = null;
      if (st.state !== 'ok') {
        const reasons = {
          no_key: ['需要 API Key', '云端工作区用本站 API Key 验证账户。请先在画布顶部输入密钥——本地项目不受任何影响。'],
          key_rejected: ['密钥未通过验证', '账户接口拒绝了当前 API Key。请检查密钥后重试；本地项目完全不受影响。'],
          unavailable: ['云端暂不可用', '账户验证接口尚未部署或暂时不可用，云端工作区未启用。本地项目、导入导出与素材全部照常可用——云端不会退化为匿名共享。'],
        };
        const [title, desc] = reasons[st.state] ?? reasons.unavailable;
        box.replaceChildren(
          el('div', { class: 'task-item' },
            el('div', { class: 'row' }, el('b', { text: title }), el('span', { class: 'badge warn', text: '未连接' })),
            el('p', { class: 'hint', text: desc })));
        return;
      }
      const p = store.project;
      const l = p ? await getLink(p.id) : null;
      state.list = await cloudList();
      const dirty = await isDirty();
      if (l) {
        startWatch();
        try {
          const r = await peers(l);
          if (!disposed && store.project?.id === p.id) { state.peerList = r.peers ?? []; state.peerProjectId = p.id; }
        } catch { state.peerList = []; state.peerProjectId = null; }
      }

      const head = el('div', { class: 'row' },
        el('b', { text: st.displayName ? `${st.displayName}（${st.subject}）` : st.subject }),
        el('span', { class: 'badge ok', text: '本机服务已连接' }),
        el('span', { class: 'muted', text: `云端项目 ${state.list.length}` }));
      const scope = el('p', { class: 'hint', text: '存储范围：本机工作区服务（数据保存在此设备上的本地服务目录，不等同托管云端/多设备同步）；账户身份由本站接口验证。' });

      // 当前项目卡片
      const cur = el('div', { class: 'task-item' });
      if (!p) cur.append(el('p', { class: 'hint', text: '没有打开的本地项目' }));
      else if (!l) {
        cur.append(
          el('div', { class: 'row' }, el('b', { text: p.name }), el('span', { class: 'muted', text: '未上传到云端' })),
          el('div', { class: 'row actions' }, btn('上传到云端（项目+本地素材）', async () => {
            const r = await backup({});
            toast(`已上传：r${r.rev}`, 'ok');
          })),
          el('p', { class: 'hint', text: '仅上传项目结构与本地已有素材文件；缺失素材不会被伪造。' }));
      } else {
        // 提示与在线名单按当时绑定归属校验——旧项目/旧链接的提示绝不挂到当前项目上
        const notice = state.remoteNotice && state.remoteNotice.projectId === p.id && state.remoteNotice.id === l.id && state.remoteNotice.head > l.head ? state.remoteNotice : null;
        const shownPeers = state.peerProjectId === p.id ? state.peerList : [];
        const peerText = shownPeers.length ? ` · 在线 ${shownPeers.map(x => x.self ? '我' : x.subject).join('、')}` : '';
        cur.append(
          el('div', { class: 'row' },
            el('b', { text: p.name }),
            el('span', { class: 'badge ok', text: `已链接 r${l.head}` }),
            dirty ? el('span', { class: 'badge warn', text: '有未推送改动' }) : null,
            el('span', { class: 'muted', text: `${l.owner}/${l.id}${peerText}` })),
          notice ? el('div', { class: 'row' },
            el('span', { class: 'badge warn', text: `远端已更新到 r${notice.head}` }),
            hasInflightTasks(p)
              ? el('span', { class: 'hint', text: '存在进行中任务，远端更新不会自动应用' })
              : dirty
                ? el('span', { class: 'hint', text: '本地有未推送改动，拉取将存为新副本' })
                : el('span', { class: 'hint', text: '本地无改动，可安全拉取' })) : null,
          el('div', { class: 'row actions' },
            l.role !== 'viewer' ? btn('推送更新', async () => {
              const r = await backup({ onConflict: conflictDialog });
              if (r?.cancelled) toast('已取消，本地草稿保持不变', 'info');
              else if (r?.resolved === 'new_copy') toast(`已另存新云端项目 r${r.rev}`, 'ok');
              else if (r?.resolved === 'pull_copy') toast('已拉取远端副本为新项目', 'ok');
              else if (r) toast(`已推送 r${r.rev}`, 'ok');
              else toast('已推送', 'ok');
              state.remoteNotice = null;
            }) : null,
            btn('拉取远端为本地副本', async () => {
              const r = await pull(l);
              state.remoteNotice = null;
              toast(`已拉取 r${r.rev ?? ''} 为本地项目${r.missing?.length ? `（${r.missing.length} 个媒体缺失）` : ''}`, 'ok', 5000);
              deps.onUpdate?.();
            }),
            btn('断开云端链接', async () => { if (await confirmDialog('断开链接？', el('p', { text: '只解除本地与云端的对应关系，不删除任何本地或云端数据。' }))) await unlink(); })));
      }

      // 云端项目列表
      const list = el('div', {}, el('h4', { text: '云端项目' }));
      for (const c of state.list) {
        const ref = { owner: c.owner, id: c.id, head: c.head, role: c.role };
        list.append(el('div', { class: 'task-item' },
          el('div', { class: 'row' },
            el('b', { text: c.name }),
            el('span', { class: `badge ${c.role === 'owner' ? 'ok' : c.role === 'editor' ? 'info' : ''}`, text: { owner: '所有者', editor: '可编辑', viewer: '只读' }[c.role] ?? c.role }),
            el('span', { class: 'muted', text: `r${c.head} · ${fmtTime(c.updatedAt)} · ${fmtBytes(c.bytes ?? 0)}${c.mine ? '' : ` · 属 ${c.owner}`}` })),
          el('div', { class: 'row actions' },
            btn('拉取为本地副本', async () => { const r = await pull(ref); toast(`已拉取为新本地项目${r.missing?.length ? `（${r.missing.length} 个媒体缺失）` : ''}`, 'ok', 5000); deps.onUpdate?.(); }),
            btn('版本/成员', async () => { if (state.sel?.id !== c.id || state.sel?.owner !== c.owner) state.invite = null; state.sel = c; state.detail = await cloudRevisions(ref); state.memberInfo = c.role === 'owner' ? await members(ref) : null; }),
            c.role === 'owner' ? btn('创建邀请链接', async () => { if (state.sel?.id !== c.id || state.sel?.owner !== c.owner) state.invite = null; state.sel = c; state.detail = await cloudRevisions(ref); state.memberInfo = await members(ref); }) : null,
            btn('分叉为我的项目', async () => { const f = await fork(ref, {}); toast(`已分叉：${f.name}`, 'ok'); }))));
      }
      if (!state.list.length) list.append(el('p', { class: 'hint', text: '云端还没有项目' }));

      // 选中项目详情：版本 + 成员/邀请
      const detail = el('div', {});
      if (state.sel && state.detail) {
        const ref = { owner: state.sel.owner, id: state.sel.id };
        const vbox = el('div', {}, el('h4', { text: `版本 — ${state.sel.name}` }));
        if (state.sel.role !== 'viewer') vbox.append(btn('保存当前云端 r' + state.sel.head + ' 为命名版本', async () => {
          const v = await createVersion(ref, `v-${new Date().toLocaleString('zh-CN', { hour12: false })}`);
          toast(`已保存版本：${v.name}`, 'ok');
          state.detail = await cloudRevisions(ref);
        }));
        for (const v of state.detail.versions ?? []) {
          vbox.append(el('div', { class: 'row' },
            el('span', { text: v.name }), el('span', { class: 'muted', text: `r${v.rev} · ${fmtTime(v.at)}` }),
            btn('拉取此版本', async () => { const r = await pullVersion(ref, v.id); toast(`已拉取版本「${v.name}」为新项目`, 'ok'); deps.onUpdate?.(); }),
            btn('分叉此版本', async () => { const f = await fork(ref, { rev: v.rev }); toast(`已分叉：${f.name}`, 'ok'); })));
        }
        const revs = (state.detail.revisions ?? []).slice(-8).reverse();
        if (revs.length) vbox.append(el('p', { class: 'hint', text: '最近修订：' + revs.map(r => `r${r.rev}(${r.kind})`).join(' · ') }));
        detail.append(vbox);

        if (state.memberInfo) {
          const mbox = el('div', {}, el('h4', { text: '成员与邀请（仅所有者）' }));
          for (const m of state.memberInfo.members ?? []) {
            const sel = el('select', { class: 'mini' },
              el('option', { value: 'viewer', text: '只读', selected: m.role === 'viewer' }),
              el('option', { value: 'editor', text: '可编辑', selected: m.role === 'editor' }));
            sel.addEventListener('change', run(sel, async () => { await setMember(ref, m.subject, sel.value); state.memberInfo = await members(ref); }));
            mbox.append(el('div', { class: 'row' },
              el('span', { text: m.subject }), el('span', { class: 'muted', text: m.via?.startsWith('share:') ? '邀请加入' : '直接授权' }), sel,
              btn('移除', async () => { if (await confirmDialog('移除成员？', el('p', { text: `撤销 ${m.subject} 的访问权限。` }))) { await removeMember(ref, m.subject); state.memberInfo = await members(ref); } }, 'mini danger')));
          }
          if (!(state.memberInfo.members ?? []).length) mbox.append(el('p', { class: 'hint', text: '暂无成员' }));
          const roleSel = el('select', { class: 'mini' }, el('option', { value: 'viewer', text: '只读邀请' }), el('option', { value: 'editor', text: '可编辑邀请' }));
          const hrs = el('input', { class: 'mini', type: 'number', value: 72, min: 1, max: 720, style: 'width:64px' });
          mbox.append(el('div', { class: 'row actions' }, roleSel, hrs, el('span', { class: 'muted', text: '小时有效' }),
            btn('生成邀请链接', async () => {
              // 请求发出前捕获身份与选中上下文：await 期间密钥轮换（指纹/密钥漂移）或改选云端项目，
              // 迟到的旧响应不得归到新连接/新选中项目上——直接丢弃不显示
              const fp0 = getFp?.() ?? null, key0 = getKey?.() ?? null, sel0 = state.sel;
              const r = await createShare(ref, { role: roleSel.value, expiresInHours: Number(hrs.value) || 72 });
              if (disposed || state.sel !== sel0 || (getFp?.() ?? null) !== fp0 || (getKey?.() ?? null) !== key0) return;
              // 链接存进面板内存态——run() 随后的整树重绘按 state 重建显示，不再附着于将被丢弃的旧 mbox；
              // 限定当前项目 + 账户身份 + 连接指纹；绝不写 storage/地址栏，不自动复制剪贴板；重复生成只替换为新链接
              state.invite = { owner: ref.owner, id: ref.id, sid: r.share.id, subject: st.subject, fp: fp0, url: r.url, role: r.share.role, expiresAt: r.share.expiresAt };
              // 成员列表刷新失败不丢弃已生成的唯一链接——下一轮重绘仍按 state 恢复显示
              try {
                const info = await members(ref);
                if (!disposed && state.sel === sel0 && (getFp?.() ?? null) === fp0 && (getKey?.() ?? null) === key0) state.memberInfo = info;
              } catch { /* 保留邀请链接，成员列表稍后重试 */ }
            })));
          // 重绘恢复显示：仅限本会话生成、未撤销、且仍属当前选中项目的邀请；已撤销的不展示死链
          if (state.invite && (state.invite.id !== ref.id || state.invite.owner !== ref.owner
            || (state.memberInfo.shares ?? []).find(x => x.id === state.invite.sid)?.revoked)) state.invite = null;
          if (state.invite) {
            const ta = el('input', { class: 'mini', type: 'text', value: state.invite.url, readonly: true, 'aria-label': '本次生成的邀请链接', style: 'width:100%' });
            ta.addEventListener('focus', () => { try { ta.select?.(); } catch { /* 选中失败不阻塞 */ } });
            mbox.append(
              el('p', { class: 'hint', text: '本次生成的邀请链接只保留在本面板内存中——关闭面板、切换项目或更换账户即清除；令牌在 # 片段中不经过服务器日志，不会写入剪贴板或本地存储；兑换后即绑定对方账户。' }),
              ta);
          }
          for (const s of state.memberInfo.shares ?? []) {
            mbox.append(el('div', { class: 'row' },
              el('span', { class: 'muted', text: `${s.id} · ${s.role === 'editor' ? '可编辑' : '只读'} · ${s.revoked ? (s.memberRemoved ? '已撤销（成员已移除）' : '已撤销') : s.claimed ? `已兑换${s.claimedBy ? `（${s.claimedBy}）` : ''}` : `有效至 ${fmtTime(s.expiresAt)}`}` }),
              !s.revoked ? btn('撤销', async () => { await revokeShare(ref, s.id); state.memberInfo = await members(ref); }, 'mini danger') : null));
          }
          detail.append(mbox);
        }
      }

      // 兑换邀请
      const claimBox = el('div', {}, el('h4', { text: '兑换邀请' }));
      const inp = el('input', { class: 'mini', type: 'text', placeholder: '粘贴邀请链接（#ws-claim=…）', style: 'width:60%' });
      claimBox.append(el('div', { class: 'row' }, inp, btn('兑换', async () => {
        const r = await claim(inp.value);
        toast(r.already ? '你已是该项目成员' : `已加入「${r.project.name}」（${r.role === 'editor' ? '可编辑' : '只读'}）`, 'ok');
        inp.value = '';
      })));

      box.replaceChildren(head, scope, cur, list, detail, claimBox,
        el('p', { class: 'hint', text: '说明：云端是账户级备份与协作层。拉取总是生成新本地项目（经导入消毒、任务保护重建）；云端快照/邀请/撤销都不会自动运行付费任务。' }));
    }

    // 进入面板时若地址栏带 ws-claim 片段 → 直接兑换并剥离
    if (typeof location !== 'undefined' && location.hash.includes('ws-claim')) {
      const t = parseClaimToken(location.hash);
      if (t) claim(t).then(r => toast(r.already ? '你已是该项目成员' : `已加入「${r.project.name}」`, 'ok')).catch(e => toast(e.message, 'err', 5000)).finally(rerender);
    }
    rerender();
    return { close };
  }

  return {
    open, status,
    list: cloudList, meta: cloudMeta, revisions: cloudRevisions, createVersion, rename: cloudRename,
    backup, pull, pullVersion, fork,
    members, setMember, removeMember, createShare, revokeShare, claim,
    checkRemote, beat, peers,
    link, unlink, isDirty, hasInflightTasks,
  };
}
