import { createDocumentStore } from '../document-store.js';

// A scene-load boundary replaces the history owner, not an authored write.
// The stable external-store port keeps React subscribers attached across rooms.
export function createSceneStageStore(stage, options) {
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  let store = createDocumentStore({ ...options, owned: { stage } });
  let release = store.subscribe(notify);
  return {
    ...Object.fromEntries(Object.keys(store).map(name => [name, (...args) => store[name](...args)])),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    load(stage) {
      release(); store.dispose();
      store = createDocumentStore({ ...options, owned: { stage } });
      release = store.subscribe(notify);
      notify();
    },
    dispose() { release(); store.dispose(); listeners.clear(); },
  };
}
