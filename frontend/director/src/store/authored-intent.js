// Store data is plain authored intent, never a rig, Map or three.js instance.
// Rejecting runtime containers also makes dev freeze meaningful: freezing a
// Map object alone would still allow Map.set to rewrite retained history.
export function copyAuthoredIntent(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || ancestors.has(value)) {
    throw new TypeError('Document slices require acyclic, plain authored intent.');
  }
  ancestors.add(value);
  const next = Array.isArray(value) ? value.map(item => copyAuthoredIntent(item, ancestors)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyAuthoredIntent(item, ancestors)]));
  ancestors.delete(value);
  return next;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
