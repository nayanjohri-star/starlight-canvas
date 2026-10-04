// IndexedDB boundary for the SSR hook. Keep asynchronous publication and
// content-addressed records; the motion owner and encoder are not replaced.
export const records = new Map();
const listeners = new Set();
export const openMotionDb = async () => ({ close() {} });
export const getMotion = async (_db, id) => records.get(id) ?? null;
export async function putMotion(_db, record) {
  records.set(record.motionId, record);
  for (const listener of listeners) listener(record);
  return record;
}
export function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
