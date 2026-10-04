// 内存密钥库：API Key 只存在于本模块作用域，不落盘、不进导出、不进日志。
// 指纹用 SHA-256 前 16 hex，仅用于任务与密钥的身份对应校验。

import { getProvider } from './providers.js';
import { providerContext } from './provider-config.js';

let currentKey = null;
let currentFp = null;
let currentContext = '';

export async function sha256Fingerprint(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function setKey(key, { verifiedFingerprint } = {}) {
  const trimmed = String(key || '').trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error('密钥不能为空或包含空白字符');
  if (verifiedFingerprint !== undefined && (!trimmed.startsWith('cs1.') || !/^[a-f0-9]{16}$/.test(verifiedFingerprint)))
    throw new Error('用户站凭证指纹无效');
  const context = providerContext(getProvider());
  const fp = verifiedFingerprint ?? await sha256Fingerprint(context ? `${context}\n${trimmed}` : trimmed);
  if (context !== providerContext(getProvider())) throw new Error('服务商已切换，请重新设置密钥');
  const changed = currentFp !== fp;            // 实际身份变化：换密钥必须清掉上一密钥的目录与可用范围
  currentKey = trimmed;
  currentFp = fp;
  currentContext = context;
  if (changed) { available = null; catalog = null; }   // 同键重设保留已验证目录
  return fp;
}

export function getKey() { return currentContext === providerContext(getProvider()) ? currentKey : null; }
export function getFingerprint() { return getKey() ? currentFp : null; }
export function hasKey() { return getKey() !== null; }
export function clearKey() { currentKey = null; currentFp = null; available = null; catalog = null; }
// 校验某个任务/待创建记录是否属于当前密钥
export function matchesFingerprint(fp) { return !!fp && fp === getFingerprint(); }

// 当前密钥可用型号（/v1/models 解析 data[].id 后与 11 型号求交）
let available = null;
// keyFp：发起 /v1/models 前先取 getFingerprint() 并在应用响应时回传；密钥已切换则拒绝应用陈旧响应（返回 false）
export function setAvailableModels(ids, { keyFp } = {}) {
  if (keyFp !== undefined && keyFp !== currentFp) return false;
  available = ids ? new Set(ids) : null;
  return true;
}
export function getAvailableModels() { return available; }
// null = 未校验过（不设卡）；有集合时型号必须在交集中
export function isModelUsable(modelId) { return available == null ? true : available.has(modelId); }

// /v1/models 原始目录（仅元数据：id/endpoints/tags 等）：仅用于探测文本/图片型号可用性，
// 绝不反向补写视频能力表——这些条目的元数据可能不完整，不能当作能力声明。
let catalog = null;
export function setModelCatalog(entries, { keyFp } = {}) {
  if (keyFp !== undefined && keyFp !== currentFp) return false;   // 过期的 /v1/models 响应不得覆盖新密钥目录
  catalog = Array.isArray(entries)
    ? entries.filter(e => typeof e === 'string' || (e && typeof e.id === 'string')).slice(0, 2000)
    : null;
  return true;
}
export function getModelCatalog() { return catalog; }

// 站点公开价目（/api/pricing，无凭据公开数据）：仅作「标准价」参考展示，
// 绝不当作实际分组价或扣费上限。与密钥身份无关，换钥不清理。
let sitePricing = null;
export function setSitePricing(p) { sitePricing = p && typeof p === 'object' && !Array.isArray(p) ? p : null; }
export function getSitePricing() { return sitePricing; }
