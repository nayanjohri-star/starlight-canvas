import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('CPU hook condition did not complete');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

// Run the shipped hook with only React scheduling and the host transport as
// seams. No browser, renderer, or replacement saving implementation is used.
export async function hostedSaveFixture({ delayHydration = false, delayProjection = false, restoredCharacterId = 'actor-a', savedResolution = 720, portal = false, videoModels = [] } = {}) {
  const previous = Object.fromEntries(['window', 'document', '__starlightDirectorSession', '__hostedSaveHooks'].map(key => [key, globalThis[key]]));
  const cells = [], effects = [], cleanups = [], listeners = new Set(), closeListeners = new Set();
  let cursor = 0, clock = 0, epoch = 'document-1', closed = false, source, bar, facade;
  let holdSerialize = null, holdSave = null, holdAsset = null, failure = null, incomingProjection = null, projectionTimer;
  const projected = deferred();
  const calls = [], writes = [], payloads = [], keys = [], downloads = [];
  const keyListeners = new Set();
  const hydration = delayHydration ? deferred() : null;
  const input = subject => ({ name: '导演工程', scenes: { scenes: [{ id: 'scene', stage: { characters: [{ id: 'actor-a', subject }] } }] }, poseLibrary: [], workspace: { hierarchyWidth: 280 } });
  source = input('before');
  const cell = initial => {
    const index = cursor++;
    if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial };
    return cells[index];
  };
  globalThis.__hostedSaveHooks = {
    useRef(initial) { const ref = cell(() => ({ current: initial })); return ref.value; },
    useState(initial) { const state = cell(initial); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
    useEffect(fn, deps) { const effect = cell(null); if (!effect.value || deps?.some((value, index) => !Object.is(value, effect.value[index]))) { effect.value = deps; effects.push(fn); } },
    useSyncExternalStore(subscribe, read) { const state = cell(null); if (!state.value) { state.value = true; effects.push(() => subscribe(() => {})); } return read(); },
  };
  globalThis.document = { getElementById: () => portal ? { nodeType: 1 } : null, querySelector: () => null, createElement: () => ({ click() { downloads.push(this.download); } }) };
  globalThis.window = { addEventListener(type, handler) { if (type === 'keydown') keyListeners.add(handler); }, removeEventListener(type, handler) { if (type === 'keydown') keyListeners.delete(handler); } };
  const client = {
    scope: { sessionId: 'session-1', projectId: 'canvas-1', nodeId: 'director-1' },
    get closed() { return closed; },
    onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
    async request(method, payload) {
      if (closed) throw new Error('closed');
      calls.push(method);
      if (method === 'asset.write') { writes.push(JSON.parse(new TextDecoder().decode(payload.bytes))); if (holdAsset) await holdAsset.promise; return { ref: 'xp-asset://saved', sha256: 'a'.repeat(64), role: 'project' }; }
      if (method !== 'document.save') throw new Error(`Unexpected transport ${method}`);
      const frozen = structuredClone(payload);
      payloads.push(frozen);
      if (holdSave) await holdSave.promise;
      if (failure) throw failure;
      return { format: 'starlight-director@1', projectId: client.scope.projectId, nodeId: client.scope.nodeId, rev: (payload.expectedRevision ?? 0) + 1, scene: frozen.scene, dependencies: frozen.dependencies };
    },
  };
  const domain = {
    projectName: '导演工程', metadata: () => ({ name: '导演工程' }),
    collectProjectSnapshot: () => JSON.stringify(source),
    projectSaveIdentity: () => ({ documentEpoch: epoch, clock }),
    captureProjectSave: () => ({ snapshot: JSON.stringify(source), input: structuredClone(source), documentEpoch: epoch, clock }),
    async collectProjectSerialized(_name, capture, check = () => {}) {
      const frozen = structuredClone(capture?.input ?? source);
      if (holdSerialize) await holdSerialize.promise;
      check(); return JSON.stringify(frozen);
    },
    subscribeProject(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async rehydrateProjectAssets() { if (hydration) await hydration.promise; },
    applyProject(project) {
      const incoming = structuredClone(project); epoch = 'restored-1';
      if (delayProjection) incomingProjection = incoming;
      else source = incoming;
      notify();
      // The owner has loaded its incoming document before React publishes it.
      if (!delayProjection) projectionTimer = setTimeout(() => projected.resolve(), 100);
      return { ...domain.projectSaveIdentity(), snapshot: JSON.stringify(incoming), whenProjected(signal) {
        return new Promise((resolve, reject) => {
          const abort = () => { cleanup(); reject(signal.reason); };
          const cleanup = () => signal.removeEventListener('abort', abort);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) return abort();
          projected.promise.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
        });
      } };
    },
  };
  function notify() {
    if (epoch !== 'document-1' && epoch !== 'restored-1') projected.reject(Object.assign(new Error('工程已切换，旧恢复已取消'), { code: 'document_changed' }));
    for (const listener of listeners) listener({ snapshot: JSON.stringify(source), ...domain.projectSaveIdentity() });
  }
  const ports = { outputResolution: 1080, setOutputResolution(value) { ports.outputResolution = value; }, cancel() {}, shotsDomain: {} };
  const appContext = { get undoClock() { return clock; }, actionPorts: {}, updateActionPorts(next) { Object.assign(this.actionPorts, next); }, storeDomains: () => [], bus: { run(id) { keys.push(id); } } };
  const initialProject = input(delayProjection ? 'restored owner' : 'before');
  initialProject.scenes.scenes[0].stage.characters[0].id = restoredCharacterId;
  const session = { client, videoModels, record: { rev: 2, scene: { characterBindings: [{ characterId: restoredCharacterId, assetId: 'before', ref: 'xp-asset://before', sha256: 'b'.repeat(64) }], exportResolution: savedResolution }, dependencies: [] }, initialProject };
  globalThis.__starlightDirectorSession = session;
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom', plugins: [{
    name: 'hosted-save-react-scheduling', enforce: 'pre', load(id) {
      if (id.endsWith('/integration/use-hosted-director.jsx')) return readFileSync(id, 'utf8').replace(/import \{[^}]+\} from 'react';/, 'const { useEffect, useRef, useState, useSyncExternalStore } = globalThis.__hostedSaveHooks;');
    },
  }] });
  let hook;
  try { ({ useHostedDirector: hook } = await server.ssrLoadModule('/integration/use-hosted-director.jsx')); }
  finally { await server.close(); }
  function render() {
    cursor = 0; facade = hook(appContext, domain, ports); bar = facade?.bar ?? facade;
    for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    return facade;
  }
  // Match main.jsx: the root unmount listener is registered before the hook.
  client.onClose(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
  render();
  return {
    domain, ports, session, appContext, calls, writes, payloads, keys, downloads, render,
    status: () => window.__starlightDirector?.status(),
    message: () => render()?.saveState?.message ?? cells.map(cell => cell.value?.message).find(Boolean),
    save: () => window.__starlightDirector.save(),
    edit(subject = 'after') { source = input(subject); if (incomingProjection) incomingProjection = structuredClone(source); clock++; notify(); render(); },
    setLayout(width) { source.workspace.hierarchyWidth = width; if (incomingProjection) incomingProjection.workspace.hierarchyWidth = width; notify(); render(); },
    setBindings() { const state = cells.find(cell => Array.isArray(cell.value) && cell.value[0]?.characterId); state.value = [{ characterId: 'actor-a', assetId: 'after', ref: 'xp-asset://after', sha256: 'c'.repeat(64) }]; render(); },
    setResolution(value) { ports.outputResolution = value; render(); },
    holdSerialization() { return (holdSerialize = deferred()); },
    releaseSerialization() { holdSerialize?.resolve(); holdSerialize = null; },
    holdAck() { return (holdSave = deferred()); },
    holdAssetWrite() { return (holdAsset = deferred()); },
    releaseHydration() { hydration?.resolve(); },
    settleProjection() { if (incomingProjection) { source = incomingProjection; incomingProjection = null; notify(); render(); } projected.resolve(); },
    key(event) { for (const handler of keyListeners) handler(event); },
    replaceDocument() { epoch = 'document-2'; source = input('new document'); clock++; notify(); render(); },
    reopenSameDocument() { epoch = 'document-2'; notify(); render(); },
    fail(error) { failure = error; },
    close() { closed = true; for (const listener of closeListeners) listener(); closeListeners.clear(); },
    async ready() { await until(() => this.status()?.loaded); },
    async dispose() {
      clearTimeout(projectionTimer); projected.resolve();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    },
  };
}
