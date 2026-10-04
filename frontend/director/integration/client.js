// SPDX-License-Identifier: AGPL-3.0-or-later
import { directorEnvelope, matchesDirectorEnvelope } from '../../canvas/src/director-protocol.js';

export function createDirectorClient({ window: win = window, scope, timeout = 30000 }) {
  const pending = new Map();
  const closeListeners = new Set();
  let closed = false;
  const origin = win.location.origin;
  function dispose(reason = '导演台会话已关闭') {
    if (closed) return;
    closed = true;
    win.removeEventListener('message', onMessage);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
    for (const listener of closeListeners) listener();
    closeListeners.clear();
  }
  function onMessage(event) {
    if (closed || event.source !== win.parent || event.origin !== origin) return;
    const message = event.data;
    if (matchesDirectorEnvelope(message, scope, 'event') && message.method === 'session.close') {
      dispose(); return;
    }
    if (!matchesDirectorEnvelope(message, scope, 'response')) return;
    const request = pending.get(message.requestId);
    if (!request || request.method !== message.method) return;
    pending.delete(message.requestId);
    clearTimeout(request.timer);
    if (message.payload?.ok === true) request.resolve(message.payload.result);
    else request.reject(Object.assign(new Error(message.payload?.error?.message || '导演台请求失败'), message.payload?.error));
  }
  win.addEventListener('message', onMessage);
  return {
    scope,
    get closed() { return closed; },
    request(method, payload = {}) {
      if (closed) return Promise.reject(new Error('导演台会话已关闭'));
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId); reject(new Error('导演台请求超时，当前修改仍保留在编辑器中'));
        }, timeout);
        pending.set(requestId, { method, resolve, reject, timer });
        win.parent.postMessage(directorEnvelope(scope, requestId, method, payload), origin);
      });
    },
    onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
    dispose,
  };
}
