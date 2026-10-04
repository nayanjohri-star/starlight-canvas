// IndexedDB event seam only: the production asset normalizer, importer and
// put/get functions still run. Publication waits on transaction completion.
export const records = new Map();
let gate;
export function holdNextWrite() {
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  gate = { entered, ready };
  return { arrived, release };
}
export const db = {
  close() {},
  transaction() {
    const tx = { objectStore: () => ({
      put(record) {
        const current = gate; gate = null;
        Promise.resolve().then(async () => {
          current?.entered();
          if (current) await current.ready;
          records.set(record.id, structuredClone(record));
          tx.oncomplete();
        }).catch(error => { tx.error = error; tx.onerror(); });
      },
      get(id) {
        const request = {};
        queueMicrotask(() => { request.result = records.get(id); request.onsuccess(); });
        return request;
      },
    }) };
    return tx;
  },
};
