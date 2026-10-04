// SPDX-License-Identifier: AGPL-3.0-or-later
export const TIMELINE_FRAME_RATES = Object.freeze([24, 30]);
export const DEFAULT_TIMELINE_FPS = 24;
export const MAX_REFERENCE_SECONDS = 30;
export function requireTimelineFps(fps) {
  if (!TIMELINE_FRAME_RATES.includes(fps)) throw new RangeError('时间轴仅支持 24 或 30 fps');
  return fps;
}
const sourceFps = fps => {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError('源帧率必须为正数');
  return fps;
};
export function quantizeDuration(seconds, fps = DEFAULT_TIMELINE_FPS, { minSeconds = 1, maxSeconds = MAX_REFERENCE_SECONDS } = {}) {
  requireTimelineFps(fps);
  if (!Number.isFinite(seconds) || seconds < minSeconds || seconds > maxSeconds) throw new RangeError(`时长必须在 ${minSeconds} 至 ${maxSeconds} 秒内`);
  const exactFrames = seconds * fps, frameCount = Math.round(exactFrames);
  const actualSeconds = frameCount / fps, rounded = Math.abs(exactFrames - frameCount) > 1e-8;
  return { fps, requestedSeconds: seconds, frameCount, lastFrame: frameCount - 1, actualSeconds,
    rounded, deltaSeconds: actualSeconds - seconds,
    message: rounded ? `${seconds} 秒在 ${fps} fps 下取整为 ${frameCount} 帧，实际 ${actualSeconds.toFixed(6)} 秒`
      : `${seconds} 秒 = ${frameCount} 帧（${fps} fps，末帧 ${frameCount - 1}）` };
}
export function frameTime(frame, fps) { return frame / requireTimelineFps(fps); }
export function timelineToSourceFrame(frame, timelineFps, nativeFps) {
  return frame * sourceFps(nativeFps) / requireTimelineFps(timelineFps);
}
export function referenceFrameRange(startFrame, endFrame, fps) {
  requireTimelineFps(fps);
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < 0 || endFrame < startFrame)
    throw new RangeError('镜头范围必须是有序的整数帧');
  const frameCount = endFrame - startFrame + 1;
  if (frameCount > fps * MAX_REFERENCE_SECONDS) throw new RangeError('单段参考视频最长 30 秒，请分镜头导出');
  return { startFrame, endFrame, frameCount, fps, durationSeconds: frameCount / fps };
}

const FRAME_FIELDS = new Set(['frame', 'startFrame', 'endFrame', 'endFrameExclusive', 'frameCount', 'currentFrame',
  'durationFrames', 'periodFrames', 'offsetFrames', 'blendFrames', 'anchorFrame']);
// Clip samples, source edit segments and imported take provenance keep their
// native clock. Only authored timeline keys/ranges are remapped.
const SOURCE_FIELDS = new Set(['take', 'fullTake', 'sourceTake', 'sourceMotion', 'sessionMotion', 'motionRef',
  'takeRecipe', 'takeVersions', 'editSegments', 'rotMats', 'rootPos', 'posedJoints']);
const KEY_MAP_FIELDS = new Set(['poseEdits', 'rootEdits', 'physicsKeys', 'frameKeys', 'fkKeys', 'keyMap']);

/** Immutable timeline remapping. Prompt blocks are half-open, shots/rail ranges
 * inclusive. Native motion buffers remain unchanged; playback uses the explicit
 * timelineToSourceFrame boundary. Colliding authored keys are rejected, never
 * silently erased by the domain's ordinary normalization. */
export function rescaleFrames(value, fromFps, toFps) {
  sourceFps(fromFps); requireTimelineFps(toFps);
  const factor = toFps / fromFps, collisions = [];
  const index = frame => Math.max(0, Math.round(frame * factor));
  function walk(v, path = [], parent = '') {
    if (v == null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return structuredClone(v);
    if (Array.isArray(v)) {
      const next = v.map((row, i) => walk(row, [...path, String(i)], parent));
      for (const field of ['frame', ...(parent === 'shots' ? ['startFrame'] : [])]) {
        const seen = new Map();
        for (let i = 0; i < next.length; i++) if (Number.isFinite(next[i]?.[field])) {
          const previous = seen.get(next[i][field]);
          if (previous != null && v[previous][field] !== v[i][field]) collisions.push({ path: path.join('.'), field, frames: [v[previous][field], v[i][field]], mappedFrame: next[i][field] });
          seen.set(next[i][field], i);
        }
      }
      return next;
    }
    const result = {};
    for (const [key, entry] of Object.entries(v)) {
      if (SOURCE_FIELDS.has(key)) result[key] = structuredClone(entry);
      else if (FRAME_FIELDS.has(key) && Number.isFinite(entry)) {
        const halfOpen = parent === 'promptClips';
        result[key] = key === 'endFrame' && !halfOpen ? Math.max(0, index(entry + 1) - 1) : index(entry);
      } else if (KEY_MAP_FIELDS.has(key) && entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const map = {};
        for (const [frame, keys] of Object.entries(entry)) {
          const mapped = /^\d+$/.test(frame) ? String(index(Number(frame))) : frame;
          if (Object.hasOwn(map, mapped)) collisions.push({ path: [...path, key].join('.'), frames: [frame], mappedFrame: mapped });
          map[mapped] = walk(keys, [...path, key, mapped], key);
        }
        result[key] = map;
      } else result[key] = walk(entry, [...path, key], key);
    }
    return result;
  }
  const result = walk(value);
  if (collisions.length) {
    const e = new RangeError(`帧率转换使 ${collisions.length} 组关键帧重合，原轨道已保留；请先调整这些关键帧`);
    e.code = 'FRAME_COLLISION'; e.collisions = collisions; throw e;
  }
  return result;
}
