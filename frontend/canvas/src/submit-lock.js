// 提交互斥锁（R01）：让「持久化核查 → 写 pending/任务记录 → 发创建请求」在多标签页间保持原子。
//  · 浏览器优先走 Web Locks：同源所有标签页互斥，持有方崩溃自动释放
//  · 非浏览器环境（node 测试、同 realm 多 store 实例）退到本模块共享队列——同一 JS realm 内仍互斥
//  · 不支持 Web Locks 的浏览器一律拒绝（fail closed）：宁可阻止提交，也不退化成仅内存锁后发付费请求
// 仅 BroadcastChannel 通知/先读后写检查不构成互斥，均不使用。

const tails = new Map();   // name → 上一个持有者的 settle Promise（同 realm 内所有实例共享）

// realm 级互斥：不能跨标签页，仅作测试/同页兜底
function localRequest(name, fn) {
  const prev = tails.get(name) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => undefined, () => undefined);
  tails.set(name, tail);
  tail.then(() => { if (tails.get(name) === tail) tails.delete(name); });
  return run;
}

const inBrowser = () =>
  typeof window === 'object' && window !== null && typeof window.document === 'object' && window.document !== null;

// locks: 可注入锁实现（默认 navigator.locks）；force:'local' 强制本地队列（测试用）
export function createSubmitLock({ locks, force, namespace = '', assertActive } = {}) {
  if (typeof namespace !== 'string' || namespace.includes('\0')) throw new TypeError('锁命名空间无效');
  const wrap = request => (name, fn) => {
    assertActive?.();
    return request(namespace ? `${namespace}${name}` : name, () => {
      assertActive?.();
      return fn();
    });
  };
  if (force === 'local') return { request: wrap(localRequest), scope: 'local' };
  const impl = locks === undefined ? globalThis.navigator?.locks : locks;
  if (impl && typeof impl.request === 'function') {
    return {
      scope: 'cross-tab',
      request: wrap((name, fn) => impl.request(name, { mode: 'exclusive' }, fn)),
    };
  }
  if (inBrowser()) {
    return {
      scope: 'unsupported',
      request: () => Promise.reject(Object.assign(
        new Error('当前浏览器不支持 Web Locks，无法保证多标签页下不重复创建任务，已阻止本次提交'),
        { code: 'submit_lock_unsupported' })),
    };
  }
  return { request: wrap(localRequest), scope: 'local' };
}

export { localRequest };
