// SPDX-License-Identifier: AGPL-3.0-or-later
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export function normalizeFocus(value = {}) {
  return { focusDistance: Number.isFinite(value.focusDistance) ? clamp(value.focusDistance, 0.05, 10000) : 5,
    fStop: Number.isFinite(value.fStop) ? clamp(value.fStop, 0.7, 32) : 5.6, depthOfField: value.depthOfField === true };
}
export function focusDistanceToPoint(position, target) {
  return Math.max(0.05, Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z));
}
export function focusAtKeys(keys, frame, fallback = {}) {
  const list = (keys ?? []).filter(key => Number.isFinite(key.frame) && Number.isFinite(key.framing?.focusDistance)).sort((a, b) => a.frame - b.frame);
  if (!list.length) return normalizeFocus(fallback);
  let a = list[0], b = list.at(-1);
  if (frame <= a.frame) return normalizeFocus({ ...fallback, ...a.framing });
  if (frame >= b.frame) return normalizeFocus({ ...fallback, ...b.framing });
  for (let i = 1; i < list.length; i++) if (frame <= list[i].frame) { a = list[i - 1]; b = list[i]; break; }
  const t = (frame - a.frame) / (b.frame - a.frame), first = normalizeFocus({ ...fallback, ...a.framing }), last = normalizeFocus({ ...fallback, ...b.framing });
  return { focusDistance: first.focusDistance + (last.focusDistance - first.focusDistance) * t,
    fStop: first.fStop + (last.fStop - first.fStop) * t, depthOfField: first.depthOfField };
}
export function applyFocusToPass(pass, focus, focalMm = 50) {
  const normalized = normalizeFocus(focus);
  if (!pass?.uniforms?.focus || !pass.uniforms.aperture) throw new Error('景深渲染通道不可用');
  pass.enabled = normalized.depthOfField;
  pass.uniforms.focus.value = normalized.focusDistance;
  // BokehPass expects aperture in world units; focal length is supplied in mm.
  pass.uniforms.aperture.value = (focalMm / 1000) / normalized.fStop;
  return normalized;
}
/** A real depth-texture based Three.js pass, shared by preview/export composers.
 * This factory creates the pass; the caller must insert it before overlays and
 * actually render its composer. Plain metadata does not enable visible DOF. */
export async function createDepthOfFieldPass({ scene, camera, width, height, focus = {}, focalMm = 50 }) {
  const { BokehPass } = await import('three/addons/postprocessing/BokehPass.js');
  const pass = new BokehPass(scene, camera, { focus: 5, aperture: 0.01, maxblur: 0.015 });
  pass.setSize(width, height); applyFocusToPass(pass, focus, focalMm);
  return pass;
}
