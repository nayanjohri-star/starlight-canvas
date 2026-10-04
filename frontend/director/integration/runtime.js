// SPDX-License-Identifier: AGPL-3.0-or-later
// Upstream uses synchronous localStorage as its editing cache. Inside this
// iframe it is memory only; the canvas owns all durable document writes.
export function installDirectorRuntime(win, scope) {
  const values = new Map();
  const memory = {
    getItem: key => values.get(String(key)) ?? null,
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem: key => values.delete(String(key)),
    clear: () => values.clear(), key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  Object.defineProperty(win, 'localStorage', { configurable: true, value: memory });
  Object.defineProperty(win, 'sessionStorage', { configurable: true, value: memory });
  const nativeIdb = win.indexedDB;
  const databases = new Set();
  const prefix = `starlight-director:${scope}:`;
  Object.defineProperty(win, 'indexedDB', { configurable: true, value: {
    open(name, version) {
      const request = nativeIdb.open(prefix + name, version);
      request.addEventListener('success', () => databases.add(request.result));
      return request;
    },
    deleteDatabase: name => nativeIdb.deleteDatabase(prefix + name),
    cmp: nativeIdb.cmp.bind(nativeIdb),
  } });
  const objectUrls = new Set();
  const createUrl = win.URL.createObjectURL.bind(win.URL);
  const revokeUrl = win.URL.revokeObjectURL.bind(win.URL);
  win.URL.createObjectURL = blob => { const url = createUrl(blob); objectUrls.add(url); return url; };
  win.URL.revokeObjectURL = url => { objectUrls.delete(url); revokeUrl(url); };
  const workers = new Set();
  const NativeWorker = win.Worker;
  win.Worker = class DirectorWorker extends NativeWorker {
    constructor(...args) { super(...args); workers.add(this); }
    terminate() { workers.delete(this); super.terminate(); }
  };
  const nativeFetch = win.fetch.bind(win);
  win.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url, win.location.href);
    if (url.origin === win.location.origin && url.pathname === '/ardy/health')
      return Response.json({ ok: false, backend: 'none', reason: '本站使用手动动作编辑；GPU 动作服务未启用', capabilities: { lineEdit: false } });
    if (url.origin === win.location.origin && url.pathname === '/ardy/bases') return Response.json({ bases: [] });
    if (!['blob:', 'data:'].includes(url.protocol)) {
      if (url.origin !== win.location.origin || /^\/(ardy\/(?!cskel27-rest)|agent\/|oauth\/|v1\/)/.test(url.pathname))
        return Response.json({ error: '该外部服务未接入本站。请从画布主动发起模型调用。' }, { status: 503 });
      if (/^\/(fonts|scenes|ardy)\//.test(url.pathname))
        return nativeFetch(new URL(url.pathname.slice(1), win.location.href), options);
    }
    return nativeFetch(input, options);
  };
  // No upstream telemetry, service worker, OAuth, or localhost live server.
  win.__STARLIGHT_DIRECTOR_HOSTED__ = true;
  return {
    storage: memory,
    dispose() {
      for (const worker of workers) worker.terminate();
      for (const url of objectUrls) revokeUrl(url);
      for (const database of databases) database.close();
      workers.clear(); objectUrls.clear(); databases.clear(); values.clear();
    },
  };
}
