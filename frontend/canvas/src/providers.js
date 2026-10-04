import { isHosted } from './runtime-config.js';
import { DEFAULT_PROVIDER, normalizeProvider } from './provider-config.js';

// Browser-local, non-secret configuration, independent of exported projects.
const STORAGE_KEY = 'xp-api-providers-v1';
let profiles = [{ ...DEFAULT_PROVIDER }], activeId = DEFAULT_PROVIDER.id;
export function initProviders(storage = globalThis.localStorage) {
  if (isHosted()) return;
  profiles = [{ ...DEFAULT_PROVIDER }]; activeId = DEFAULT_PROVIDER.id;
  try {
    const data = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (!data || !Array.isArray(data.profiles)) return;
    const parsed = data.profiles.filter(p => p?.id !== DEFAULT_PROVIDER.id).slice(0, 30).map(normalizeProvider);
    profiles = [{ ...DEFAULT_PROVIDER }, ...parsed];
    activeId = profiles.some(p => p.id === data.activeId) ? data.activeId : DEFAULT_PROVIDER.id;
  } catch { /* Invalid browser configuration never grants API access. */ }
}
export function getProvider() { return isHosted() ? DEFAULT_PROVIDER : profiles.find(p => p.id === activeId) ?? DEFAULT_PROVIDER; }
export function providerList() { return profiles.map(p => structuredClone(p)); }
export function saveProvider(value, storage = globalThis.localStorage) {
  if (isHosted()) throw new Error('托管版使用本站渠道');
  const p = normalizeProvider(value);
  const next = profiles.filter(x => x.id !== p.id);
  if (next.length >= 30) throw new Error('最多保存 30 个服务商');
  next.push(p);
  // Save before replacing active state: a quota error must not switch requests.
  storage?.setItem(STORAGE_KEY, JSON.stringify({ profiles: next, activeId: p.id }));
  profiles = next; activeId = p.id;
  return p;
}
export function selectProvider(id, storage = globalThis.localStorage) {
  if (isHosted() || !profiles.some(p => p.id === id)) throw new Error('服务商不可用');
  storage?.setItem(STORAGE_KEY, JSON.stringify({ profiles, activeId: id })); activeId = id;
}
