// SPDX-License-Identifier: AGPL-3.0-or-later
import { createStableItemId } from './stable-items.js';
import { normalizeFocus, focusAtKeys } from './camera-focus.js';
import { sampleAt } from './sample-at.js';
const finite = Number.isFinite;
export function normalizeFraming(value) {
  if (!value?.pos || !['x', 'y', 'z'].every(key => finite(value.pos[key])) ||
      !['yaw', 'pitch', 'fovDeg'].every(key => finite(value[key]))) throw new TypeError('机位必须包含有效位置、朝向与视场角');
  if (value.fovDeg < 14 || value.fovDeg > 90) throw new RangeError('机位视场角必须在 14 至 90 度内');
  return { pos: { ...value.pos }, yaw: value.yaw, pitch: value.pitch, fovDeg: value.fovDeg,
    ...normalizeFocus(value) };
}
export function defaultCameraLibrary() {
  return { version: 1, activeCameraId: 'camera-master', cameras: [
    { id: 'camera-master', name: '主机位', framing: normalizeFraming({ pos: { x: 0, y: 1.6, z: 5 }, yaw: 0, pitch: 0, fovDeg: 45 }) },
    { id: 'camera-side', name: '侧机位', framing: normalizeFraming({ pos: { x: 5, y: 1.6, z: 0 }, yaw: Math.PI / 2, pitch: 0, fovDeg: 45 }) },
    { id: 'camera-overhead', name: '俯视机位', framing: normalizeFraming({ pos: { x: 0, y: 8, z: 0.01 }, yaw: 0, pitch: -Math.PI / 2 + 0.01, fovDeg: 50 }) },
  ] };
}
export function normalizeCameraLibrary(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.cameras)) throw new TypeError('机位库版本或结构不受支持');
  const ids = new Set();
  const cameras = value.cameras.map(row => {
    if (typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.name !== 'string' || !row.name.trim()) throw new TypeError('机位标识和名称必须有效且唯一');
    ids.add(row.id); return { id: row.id, name: row.name.trim().slice(0, 128), framing: normalizeFraming(row.framing) };
  });
  return { version: 1, cameras, activeCameraId: ids.has(value.activeCameraId) ? value.activeCameraId : cameras[0]?.id ?? null };
}
export function saveLibraryCamera(library, name, framing, cameraId = null) {
  const current = normalizeCameraLibrary(library), id = cameraId ?? createStableItemId('camera');
  if (cameraId && !current.cameras.some(row => row.id === cameraId)) throw new RangeError('机位已删除');
  const row = { id, name: String(name || '机位').trim().slice(0, 128), framing: normalizeFraming(framing) };
  return normalizeCameraLibrary({ ...current, activeCameraId: id,
    cameras: cameraId ? current.cameras.map(value => value.id === id ? row : value) : [...current.cameras, row] });
}
export function duplicateLibraryCamera(library, cameraId, name) {
  const source = normalizeCameraLibrary(library).cameras.find(row => row.id === cameraId);
  if (!source) throw new RangeError('机位已删除');
  return saveLibraryCamera(library, name || `${source.name} 副本`, source.framing);
}
export function removeLibraryCamera(library, cameraId) {
  const current = normalizeCameraLibrary(library);
  if (!current.cameras.some(row => row.id === cameraId)) throw new RangeError('机位已删除');
  return normalizeCameraLibrary({ ...current, cameras: current.cameras.filter(row => row.id !== cameraId) });
}
export function sampleCameraWithFocus(scene, shot, frame) {
  const camera = sampleAt(scene, shot, frame).camera;
  return camera ? { ...camera, ...focusAtKeys(shot.cameraKeys, frame, shot.camera) } : null;
}
