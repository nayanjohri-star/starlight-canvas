import { useCallback, useSyncExternalStore } from 'react';

// The document snapshot contains only owned slices and revision metadata.
export function useDocumentStore(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

// A legacy port's read must return its current React/live-ref value (stable
// until that value changes), and subscribe must notify external React writes.
// There is intentionally no legacy snapshot cache in the document store.
export function useDocumentDomain(store, domain) {
  const read = useCallback(() => store.read(domain), [store, domain]);
  return useSyncExternalStore(store.subscribe, read, read);
}
