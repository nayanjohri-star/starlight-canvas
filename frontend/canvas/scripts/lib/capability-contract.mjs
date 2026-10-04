// 画布能力合同的唯一比对实现：构建（scripts/build.mjs）、发布门禁与合同测试共用，
// 不再在各处散落字段映射常量。
//
// 基准：contracts/site-video-capabilities.json（生产发布原样副本，MANIFEST.json 记录版本与 LF 归一 SHA-256）。
// 哈希只证明副本完整，不证明与当前线上一致。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANVAS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = resolve(CANVAS_ROOT, '..', '..');

// 版本号方案：YYYY-MM-DD.N（日期 + 当日修订号）。比较按 [年,月,日,修订] 数值逐项进行，
// 不做字符串比较；不符合方案的版本一律视为无法比较（调用方必须显式处理）。
const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/;
export function parseContractVersion(v) {
  const m = typeof v === 'string' ? v.match(VERSION_RE) : null;
  if (!m) return null;
  const [y, mo, d, r] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return [y, mo, d, r];
}
export function compareContractVersions(a, b) {
  const pa = parseContractVersion(a), pb = parseContractVersion(b);
  if (!pa || !pb) throw new Error(`无法比较的合同版本：${a} / ${b}（需要 YYYY-MM-DD.N）`);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export const lfSha256 = text => createHash('sha256').update(String(text).replace(/\r\n?/g, '\n')).digest('hex');
const stripBom = t => t.replace(/^﻿/, '');

export async function loadPinnedContract(canvasRoot = CANVAS_ROOT) {
  const manifest = JSON.parse(stripBom(await readFile(join(canvasRoot, 'contracts', 'MANIFEST.json'), 'utf8')));
  const text = stripBom(await readFile(join(canvasRoot, 'contracts', manifest.file), 'utf8'));
  const contract = JSON.parse(text);
  const problems = [];
  if (contract.version !== manifest.version) problems.push(`固定合同版本 ${contract.version} 与 MANIFEST ${manifest.version} 不一致`);
  if (lfSha256(text) !== manifest.sha256_lf) problems.push('固定合同内容哈希与 MANIFEST 不一致（副本被改动）');
  if (!parseContractVersion(manifest.version)) problems.push(`MANIFEST 版本 ${manifest.version} 不符合 YYYY-MM-DD.N`);
  return { manifest, contract, text, problems };
}

// 画布公开的型号 = 合同中按秒计费的型号 + 两个独立按次/按秒的 H3 型号（与站点目录一致）
export function exposedModels(contract) {
  return Object.entries(contract.models ?? {})
    .filter(([id, m]) => m.billing_unit === 'second' || /^minimax-h3-768p-(limited|full-slow)$/.test(id));
}

// 画布能力表的一个型号映射回合同字段（字段映射只在此定义一次）
export function tableModelAsContract(table, target) {
  return {
    family: target.family,
    resolution: String(target.resolution).toLowerCase(),
    min_seconds: target.seconds?.min,
    max_seconds: target.seconds?.max,
    default_seconds: target.seconds?.default,
    ratios: target.ratios?.options,
    default_ratio: target.ratios?.default,
    modes: target.capability_modes,
    max_reference_images: target.reference_limits?.image,
    max_reference_videos: target.reference_limits?.video,
    max_reference_audios: target.reference_limits?.audio,
    max_reference_media: target.reference_limits?.total,
    supports_generate_audio: target.switches?.generate_audio,
    supports_face_mode: target.switches?.face_mode,
    prompt_max_characters: target.prompt_max_characters,
    billing_unit: target.billing_unit ?? table.billing_unit,
    ...Object.fromEntries(['allowed_seconds', 'supports_audio_only', 'supports_last_frame_only', 'media_max_bytes', 'media_content_types']
      .filter(k => target[k] !== undefined).map(k => [k, target[k]])),
  };
}

const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));

// 返回不一致清单（空数组 = 一致）
export function compareTableToContract(table, contract) {
  const problems = [];
  if (table.version !== contract.version) problems.push(`能力表版本 ${table.version} ≠ 合同 ${contract.version}`);
  const active = exposedModels(contract);
  const want = active.map(([id]) => id).sort(), have = Object.keys(table.models ?? {}).sort();
  if (stable(want) !== stable(have)) problems.push(`型号集合不同：合同 [${want.join(', ')}]，能力表 [${have.join(', ')}]`);
  for (const [id, source] of active) {
    const target = table.models?.[id];
    if (!target) continue;
    const mapped = tableModelAsContract(table, target);
    for (const key of new Set([...Object.keys(source), ...Object.keys(mapped)]))
      if (stable(mapped[key]) !== stable(source[key])) problems.push(`${id}.${key}：能力表 ${stable(mapped[key])} ≠ 合同 ${stable(source[key])}`);
  }
  return problems;
}

// 仓库中其他合同副本（后端 / Portal / 网关）的处理策略：
//  · 与固定合同同版本 → 必须逐项相等，否则失败；
//  · 版本不同 → 只有在 contracts/approved-copies.json 中登记了「路径 + 版本 + 原因」的历史副本才可跳过；
//  · 未登记、未知或比固定合同更新的版本 → 失败，要求显式处理（更新固定合同或登记）。
export async function loadApprovedCopies(canvasRoot = CANVAS_ROOT) {
  const raw = JSON.parse(stripBom(await readFile(join(canvasRoot, 'contracts', 'approved-copies.json'), 'utf8')));
  return Array.isArray(raw.copies) ? raw.copies : [];
}
export function classifyRepositoryCopy({ path, copy, pinned, approved }) {
  if (!copy) return { status: 'absent', reason: `${path} 不在此检出中` };
  if (copy.version === pinned.version) {
    return stable(copy) === stable(pinned)
      ? { status: 'equal' }
      : { status: 'fail', reason: `${path} 与固定合同同为 ${pinned.version}，但内容不同` };
  }
  let order;
  try { order = compareContractVersions(copy.version, pinned.version); }
  catch (e) { return { status: 'fail', reason: `${path}：${e.message}` }; }
  if (order > 0) return { status: 'fail', reason: `${path} 为 ${copy.version}，比固定合同 ${pinned.version} 更新：须先更新固定合同` };
  const entry = approved.find(a => a.path === path && a.version === copy.version);
  if (!entry) return { status: 'fail', reason: `${path} 为旧版本 ${copy.version}，未在 contracts/approved-copies.json 登记` };
  if (entry.sha256_lf && entry.sha256_lf !== copy.__sha256_lf)
    return { status: 'fail', reason: `${path} 已登记的 ${copy.version} 副本哈希不符` };
  return { status: 'approved-historical', reason: `${path} 为已登记的历史副本 ${copy.version}：${entry.reason}` };
}

export async function readRepositoryCopy(path, repoRoot = REPO_ROOT) {
  let text;
  try { text = stripBom(await readFile(join(repoRoot, path), 'utf8')); }
  catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
  const copy = JSON.parse(text);
  Object.defineProperty(copy, '__sha256_lf', { value: lfSha256(text), enumerable: false });
  return copy;
}

export const REPOSITORY_COPY_PATHS = [
  'src/new-api/setting/video_capability/profiles.json',
  'frontend/portal/src/lib/video-capabilities.json',
  'deploy/task-error-gateway/video-capabilities.json',
];
