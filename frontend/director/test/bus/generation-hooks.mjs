// Retain only the motion hook's local useState cells across deterministic SSR
// renders. React still mounts its real subscriptions; all document owners,
// commands, queue payloads, generation client and NPZ publication stay real.
let cells = [], cursor = 0;
const listeners = new Set();
export function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function begin(reset = false) { cursor = 0; if (reset) cells = []; }
export function useState(initial) {
  const index = cursor++;
  if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
  return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; for (const listener of listeners) listener(cells[index]); }];
}
