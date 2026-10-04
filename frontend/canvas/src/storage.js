// IndexedDB 极简封装 + 内存回退（测试用）。stores: kv / blobs。
// 密钥永远不进这里；可写：项目文档、素材元数据+文件 blob、待创建幂等记录、任务记录、导演台场景。

const DB_NAME = 'xingpan-canvas';
const KV = 'kv', BLOBS = 'blobs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(KV); req.result.createObjectStore(BLOBS); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('事务中止'));
    try { out = fn(s); }
    catch (error) {
      // put() 也可能同步抛 DataCloneError；只拒绝 Promise 不会撤回已排入的写入。
      try { t.abort(); } catch { /* 事务已经结束 */ }
      reject(error);
    }
  });
}

export async function createIdbStorage() {
  const db = await open();
  return {
    get: key => tx(db, KV, 'readonly', s => s.get(key)),
    set: (key, value) => tx(db, KV, 'readwrite', s => s.put(value, key)),
    // 条件写（CAS）：单事务内 读→比较修订号→写；任一端并发推进修订即拒写，绝不丢对方数据。
    // expectedRev=null 表示「仅当键不存在才写」（新命名空间）。返回 {ok:true} | {ok:false, storedRev}。
    setIfRev: (key, expectedRev, value) => new Promise((resolve, reject) => {
      const t = db.transaction(KV, 'readwrite');
      const s = t.objectStore(KV);
      let out = { ok: false, storedRev: null };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('事务中止'));
      const g = s.get(key);
      g.onerror = () => { try { t.abort(); } catch { /* 事务可能已结束 */ } };
      g.onsuccess = () => {
        const cur = g.result;
        const curRev = cur !== null && typeof cur === 'object' ? (cur.rev ?? 0) : null;
        if (curRev !== expectedRev) { out = { ok: false, storedRev: curRev }; return; }
        try { s.put(value, key); out = { ok: true }; }
        catch (e) { try { t.abort(); } catch { /* 事务可能已结束 */ } reject(e); }
      };
    }),
    del: key => tx(db, KV, 'readwrite', s => s.delete(key)),
    // Check every owner revision and publish the complete output batch in one
    // transaction. A scene changed in another tab cannot admit stale outputs.
    setIfRevs: (checks, entries) => new Promise((resolve, reject) => {
      const t = db.transaction(KV, 'readwrite'), s = t.objectStore(KV);
      let remaining = checks.length, out = { ok: true };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('事务中止'));
      const finish = () => {
        if (--remaining || !out.ok) return;
        try { for (const [key, value] of entries) s.put(value, key); }
        catch (error) { t.abort(); reject(error); }
      };
      for (const [key, expected] of checks) {
        const g = s.get(key);
        g.onsuccess = () => {
          const rev = g.result && typeof g.result === 'object' ? (g.result.rev ?? 0) : null;
          if (rev !== expected) out = { ok: false, key, storedRev: rev };
          finish();
        };
        g.onerror = () => t.abort();
      }
    }),
    // 原子批量写 KV：单事务内全部 put，任一失败整批回滚（导入等项目级写入用）
    batch: entries => tx(db, KV, 'readwrite', s => { for (const [k, v] of entries) s.put(v, k); }),
    keys: () => new Promise((resolve, reject) => {
      const t = db.transaction(KV, 'readonly'); const s = t.objectStore(KV);
      const req = s.getAllKeys(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    }),
    getBlob: key => tx(db, BLOBS, 'readonly', s => s.get(key)),
    setBlob: (key, blob) => tx(db, BLOBS, 'readwrite', s => s.put(blob, key)),
    delBlob: key => tx(db, BLOBS, 'readwrite', s => s.delete(key)),
  };
}

// 模拟 IDB 结构化克隆语义：读写都克隆，外部改动不会“隔空”影响已入库数据，反之亦然
const clone = v => structuredClone(v);

export function createMemoryStorage() {
  const kv = new Map(), blobs = new Map();
  const casTails = new Map();
  const api = {
    get: async k => clone(kv.get(k)), set: async (k, v) => void kv.set(k, clone(v)), del: async k => void kv.delete(k),
    keys: async () => [...kv.keys()],
    batch: async entries => {
      const staged = entries.map(([k, v]) => [k, clone(v)]);
      for (const [k, v] of staged) kv.set(k, v);
    },
    setIfRevs: async (checks, entries) => {
      for (const [key, expected] of checks) {
        const value = kv.get(key), rev = value && typeof value === 'object' ? (value.rev ?? 0) : null;
        if (rev !== expected) return { ok: false, key, storedRev: rev };
      }
      // Clone every value before committing any of them, as IndexedDB does.
      const staged = entries.map(([key, value]) => [key, clone(value)]);
      for (const [key, value] of staged) kv.set(key, value);
      return { ok: true };
    },
    // 与 IDB 版同一 CAS 语义：同 realm 单线程内 读→比较→写 原子；写经 api.set 保持测试可拦截
    setIfRev: (k, expectedRev, v) => {
      const value = clone(v);
      const result = (casTails.get(k) ?? Promise.resolve()).then(async () => {
        const cur = kv.get(k);
        const curRev = cur !== null && typeof cur === 'object' ? (cur.rev ?? 0) : null;
        if (curRev !== expectedRev) return { ok: false, storedRev: curRev };
        await api.set(k, value);
        return { ok: true };
      });
      const tail = result.then(() => {}, () => {});
      casTails.set(k, tail);
      tail.then(() => { if (casTails.get(k) === tail) casTails.delete(k); });
      return result;
    },
    getBlob: async k => clone(blobs.get(k)), setBlob: async (k, v) => void blobs.set(k, clone(v)), delBlob: async k => void blobs.delete(k),
  };
  return api;
}

// Hosted mode keeps the existing IDB schema and CAS implementation while
// separating every KV/blob key by a server-verified account subject. Guest
// drafts have their own namespace; unscoped local-runtime data is never read.
export function createAccountScopedStorage(storage, { subject, guest = false } = {}) {
  if (guest ? subject != null : !/^u[1-9][0-9]*$/.test(subject ?? ''))
    throw new Error('托管存储需要已核验的账户 subject，访客草稿须显式选择 guest');
  const prefix = guest ? 'guest:v1:' : `hosted:v1:${subject}:`;
  let active = true;
  const epoch = crypto.randomUUID();
  const stale = () => Object.assign(new Error('账户已切换，旧存储会话已失效'), { code: 'identity_changed' });
  const assertActive = () => { if (!active) throw stale(); };
  const scoped = key => {
    assertActive();
    if (typeof key !== 'string') throw new TypeError('存储键必须是字符串');
    return prefix + key;
  };
  const checked = async operation => {
    assertActive();
    const result = await operation();
    assertActive();
    return result;
  };
  return {
    subject: guest ? null : subject,
    mode: guest ? 'guest' : 'hosted',
    lockNamespace: prefix,
    epoch,
    get active() { return active; },
    assertActive,
    invalidate() { active = false; },
    get: key => checked(() => storage.get(scoped(key))),
    set: (key, value) => checked(() => storage.set(scoped(key), value)),
    setIfRev: (key, expectedRev, value) => checked(() => storage.setIfRev(scoped(key), expectedRev, value)),
    setIfRevs: (checks, entries) => {
      assertActive();
      // A committed old-account transaction is retained in that namespace if
      // the user switches accounts while awaiting it; never roll it back by
      // deleting bytes now referenced by its project document.
      return storage.setIfRevs(checks.map(([key, rev]) => [scoped(key), rev]), entries.map(([key, value]) => [scoped(key), value]));
    },
    del: key => checked(() => storage.del(scoped(key))),
    batch: entries => checked(() => storage.batch(entries.map(([key, value]) => [scoped(key), value]))),
    keys: () => checked(async () => (await storage.keys()).filter(key => typeof key === 'string' && key.startsWith(prefix))
      .map(key => key.slice(prefix.length))),
    getBlob: key => checked(() => storage.getBlob(scoped(key))),
    setBlob: (key, blob) => checked(() => storage.setBlob(scoped(key), blob)),
    delBlob: key => checked(() => storage.delBlob(scoped(key))),
  };
}
