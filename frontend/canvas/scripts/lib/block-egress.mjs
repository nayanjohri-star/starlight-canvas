// 发布门禁预加载（node --import）：测试进程内主动阻断一切非本机网络连接。
// 业务流程测试只允许访问本机模拟上游；误连真实生成接口时立即抛错，而不是事后记录。
// 仅在门禁运行时通过 NODE_OPTIONS 注入；安装依赖阶段不加载。
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const isLoopback = host => host == null || LOOPBACK.has(String(host).replace(/^\[|\]$/g, '').toLowerCase());
export class EgressBlockedError extends Error {
  constructor(target) { super(`EGRESS_BLOCKED：发布门禁禁止测试进程访问非本机地址 ${target}`); this.code = 'EGRESS_BLOCKED'; }
}
const hostOf = args => {
  const a = args[0];
  if (a && typeof a === 'object') return a.host ?? a.hostname ?? (a.path ? null : 'localhost');
  if (typeof a === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
  return null;   // IPC 路径（字符串）
};
for (const [mod, name] of [[net, 'connect'], [net, 'createConnection'], [tls, 'connect']]) {
  const orig = mod[name];
  mod[name] = function guarded(...args) {
    const host = hostOf(args);
    if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) return orig.apply(this, args);   // 本地管道
    if (!isLoopback(host)) throw new EgressBlockedError(host);
    return orig.apply(this, args);
  };
}
const origLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (!isLoopback(hostname)) {
    const cb = rest.find(x => typeof x === 'function');
    const err = new EgressBlockedError(hostname);
    if (cb) { process.nextTick(cb, err); return; }
    throw err;
  }
  return origLookup.call(this, hostname, ...rest);
};
const origFetch = globalThis.fetch;
if (typeof origFetch === 'function') {
  globalThis.fetch = async function guardedFetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!isLoopback(url.hostname)) throw new EgressBlockedError(url.host);
    return origFetch.call(this, input, init);
  };
}
globalThis.__CANVAS_EGRESS_BLOCKED__ = true;
