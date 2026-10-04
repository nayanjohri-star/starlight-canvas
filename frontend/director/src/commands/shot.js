// One semantic entry point for timeline, camera controls and agent framing.
import { createCameraBlock, updateCameraBlock, removeCameraRail } from '../camera-block.js';
import { addShotAtFrame, cutAtFrame, duplicateShot, removeShot, reorderShot, resizeShot, renameShot, moveCameraKey, removeCameraKey } from '../cuts.js';
import { createStableItemId, updateStableItem } from '../stable-items.js';
import { railFollowForNewGeometry } from '../camera-rail-schedule.js';
import { studioActionDeclaration } from '../studio-actions.js';
import { STUDIO_TOOL_SCHEMAS, StudioSchemas } from '../studio-agent-protocol.js';
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/shot.js';
import { changedIds, fail, shotLabel } from './shared.js';

const id = StudioSchemas.TargetGuard.properties.targetId;
const number = { type: 'number' };
const frame = { type: 'integer', minimum: 0 };
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const mutation = (id, label, schema) => ({ id, label, description: label, kind: 'mutation', undoDomain: 'shot', input: schema });
const existing = ['shot.create', 'shot.split', 'shot.duplicate', 'shot.remove', 'shot.setRange', 'shot.setCameraRail', 'shot.clearCameraRail', 'shot.reorder'].map(studioActionDeclaration);
const extra = [
  mutation('shot.set', 'Set shot fields', elementSetSchema('shot')),
  mutation('shot.rename', 'Rename shot', input({ shotId: id, name: { type: 'string', maxLength: 240 } })),
  mutation('shot.setCamera', 'Set camera block', input({ shotId: id, patch: { type: 'object', properties: {}, additionalProperties: true } })),
  mutation('shot.addKey', 'Add camera key', input({ shotId: id, frame })),
  mutation('shot.moveKey', 'Move camera key', input({ shotId: id, keyId: id, frame })),
  mutation('shot.removeKey', 'Remove camera key', input({ shotId: id, keyId: id })),
  mutation('shot.clearKeys', 'Clear camera keys', input({ shotId: id })),
  mutation('shot.setTimeline', 'Set shot timeline', input({ frameCount: { type: 'integer', minimum: 24, maximum: 36000 } })),
  mutation('shot.setFps', '切换时间轴帧率', input({ fps: { type: 'integer', enum: [24, 30] } })),
  mutation('shot.setDuration', '设置时长并显示帧取整', input({ seconds: { type: 'number', minimum: 1, maximum: 30 } })),
  mutation('shot.saveCamera', '保存独立机位', input({ cameraId: id, name: { type: 'string', minLength: 1, maxLength: 128 }, framing: { type: 'object', properties: {}, additionalProperties: true } }, ['name'])),
  mutation('shot.selectCamera', '切换机位取景', input({ cameraId: id })),
  mutation('shot.duplicateCamera', '复制机位', input({ cameraId: id, name: { type: 'string', maxLength: 128 } }, ['cameraId'])),
  mutation('shot.removeCamera', '删除机位并保留镜头取景', input({ cameraId: id })),
  mutation('shot.bindCamera', '将机位绑定镜头', input({ shotId: id, cameraId: id })),
  mutation('shot.setFocus', '设置对焦与景深', input({ focusDistance: { type: 'number', minimum: 0.05, maximum: 10000 }, fStop: { type: 'number', minimum: 0.7, maximum: 32 }, depthOfField: { type: 'boolean' },
    target: input({ x: number, y: number, z: number }) }, [])),
  mutation('shot.setLens', 'Set camera lens', input({ fovDeg: { ...number, minimum: 14, maximum: 90 } })),
  mutation('shot.frame', 'Frame the shot', { ...input({ ...STUDIO_TOOL_SCHEMAS.frame_shot.properties, preset: { type: 'string' } }, []), oneOf: [STUDIO_TOOL_SCHEMAS.frame_shot, input({ preset: { type: 'string' } })] }),
  { ...mutation('shot.replace', 'Replace shot authoring', input({ shots: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } } })), exposure: 'ui-only' },
  { ...mutation('shot.captureCamera', 'Capture camera framing', input({ shotId: id }, [])), exposure: 'ui-only' },
  { ...mutation('shot.placeCamera', 'Place camera', input(Object.fromEntries(['x', 'y', 'z', 'lookAtX', 'lookAtY', 'lookAtZ', 'focalMm'].map(key => [key, number])), [])), exposure: 'ui-only' },
];
export const declarations = Object.freeze([extra[0], ...existing, ...extra.slice(1).map(entry => entry.id === 'shot.frame' ? entry : { ...entry, exposure: 'ui-only' })]);

export function register(registry, ports) {
  const owner = () => ports.storeDomain('shot');
  const mounted = () => Boolean(ports.storeDomain?.('shot')) || 'The shots document owner is not mounted.';
  const shotOf = shotId => owner().read().find(shot => shot.id === shotId) ?? fail('STALE_TARGET', `Shot ${shotId} is not in this scene.`);
  const patchShot = (shotId, update) => { shotOf(shotId); owner().write(current => updateStableItem(current, shotId, update, 'shots')); };
  const methods = {
    'shot.create': () => owner().write(current => addShotAtFrame(current, ports.state().frame, owner().state().frameCount, owner().capture())),
    'shot.split': ({ shotId }) => {
      const shot = shotOf(shotId), { frame } = ports.state();
      if (frame <= shot.startFrame || frame > shot.endFrame) fail('TARGET_NOT_READY', `The playhead (frame ${frame}) is not inside ${shot.name} after its first frame.`);
      owner().write(current => cutAtFrame(current, shotId, frame, owner().capture()));
    },
    'shot.duplicate': ({ shotId }) => { shotOf(shotId); owner().write(current => duplicateShot(current, shotId, owner().state().frameCount)); },
    'shot.remove': ({ shotId }) => { shotOf(shotId); owner().write(current => removeShot(current, shotId)); },
    'shot.reorder': ({ shotId, startFrame }) => { shotOf(shotId); owner().write(current => reorderShot(current, shotId, startFrame, owner().state().frameCount)); },
    'shot.setRange': ({ shotId, range }) => {
      const shot = shotOf(shotId), startFrame = range.startFrame, endFrame = range.endFrameExclusive - 1;
      const edges = startFrame > shot.endFrame ? [['end', endFrame], ['start', startFrame]] : [['start', startFrame], ['end', endFrame]];
      owner().write(current => edges.reduce((rows, [edge, frame]) => resizeShot(rows, shotId, edge, frame, owner().state().frameCount), current));
    },
    'shot.setCameraRail': ({ shotId, points }) => patchShot(shotId, shot => ({ ...shot, camera: updateCameraBlock(shot.camera, {
      cameraRail: points, mode: 'rail', railFollow: railFollowForNewGeometry(shot.camera?.railFollow, shot.endFrame - shot.startFrame + 1),
    }) })),
    'shot.clearCameraRail': ({ shotId }) => {
      const shot = shotOf(shotId);
      if (!createCameraBlock(shot.camera).cameraRail) fail('TARGET_NOT_READY', `${shot.name || shotId} has no camera rail.`);
      patchShot(shotId, shot => ({ ...shot, camera: removeCameraRail(shot.camera) }));
    },
    'shot.rename': ({ shotId, name }) => { shotOf(shotId); owner().write(current => renameShot(current, shotId, name)); },
    'shot.setCamera': ({ shotId, patch }) => patchShot(shotId, shot => ({ ...shot, camera: updateCameraBlock(shot.camera, patch) })),
    'shot.addKey': ({ shotId, frame }) => {
      const shot = shotOf(shotId), target = Math.min(owner().state().frameCount - 1, frame);
      if (target < shot.startFrame || target > shot.endFrame) return;
      const framing = owner().capture();
      patchShot(shotId, shot => ({ ...shot, cameraKeys: [...shot.cameraKeys.filter(key => key.frame !== target),
        { id: shot.cameraKeys.find(key => key.frame === target)?.id ?? createStableItemId('camera-key'), frame: target, framing }].sort((a, b) => a.frame - b.frame) }));
    },
    'shot.moveKey': ({ shotId, keyId, frame }) => patchShot(shotId, shot => ({ ...shot,
      cameraKeys: moveCameraKey(shot.cameraKeys, keyId, Math.max(shot.startFrame, Math.min(shot.endFrame, frame))) })),
    'shot.removeKey': ({ shotId, keyId }) => patchShot(shotId, shot => ({ ...shot, cameraKeys: removeCameraKey(shot.cameraKeys, keyId) })),
    'shot.clearKeys': ({ shotId }) => patchShot(shotId, shot => ({ ...shot, cameraKeys: [] })),
    'shot.setTimeline': ({ frameCount }) => {
      const fps = owner().state().fps;
      if (frameCount < fps || frameCount > fps * 1200) fail('INVALID_ARGUMENT', '时间轴长度必须在 1 秒至 20 分钟内');
      return owner().writeState(before => ({ ...before, frameCount }));
    },
    'shot.setFps': ({ fps }) => owner().setFps(fps),
    'shot.setDuration': ({ seconds }) => owner().setDuration(seconds),
    'shot.saveCamera': args => owner().saveCamera(args),
    'shot.selectCamera': ({ cameraId }) => owner().selectCamera(cameraId),
    'shot.duplicateCamera': ({ cameraId, name }) => owner().duplicateCamera(cameraId, name),
    'shot.removeCamera': ({ cameraId }) => owner().deleteCamera(cameraId),
    'shot.bindCamera': ({ shotId, cameraId }) => owner().bindCamera(shotId, cameraId),
    'shot.setFocus': args => owner().setFocus(args),
    'shot.setLens': ({ fovDeg }) => owner().setLens(fovDeg),
    'shot.replace': ({ shots }) => owner().write(shots),
    'shot.captureCamera': args => owner().captureCamera(args.shotId),
    'shot.placeCamera': args => owner().placeCamera(args),
  };
  const hasShots = state => state.shots.length > 0 || 'There are no shots yet; add one with shot.create.';
  const availability = {
    'shot.create': state => addShotAtFrame(state.shots, state.frame, state.frameCount, null) !== state.shots || `There is no free room for a new shot at the playhead (frame ${state.frame}); move it with operate_studio { frame } or shorten a shot.`,
    'shot.split': state => state.shots.some(shot => state.frame > shot.startFrame && state.frame <= shot.endFrame) || `The playhead (frame ${state.frame}) is not inside a shot after its first frame; move it with operate_studio { frame }.`,
    'shot.clearCameraRail': state => state.shots.some(shot => createCameraBlock(shot.camera).cameraRail) || 'No shot has a camera rail; lay one with shot.setCameraRail.',
  };
  registerElementSet(registry, ports, extra[0]);
  for (const declaration of declarations.filter(row => row.id !== 'shot.set')) registry.register({ ...declaration,
    available: state => mounted() === true ? (availability[declaration.id] ?? (existing.includes(declaration) ? hasShots : () => true))(state) : mounted(),
    run(args) {
      if (declaration.id === 'shot.frame') {
        const plan = owner().frame(args);
        return { affectedIds: plan.affectedIds, summary: 'Framed the shot.' };
      }
      const before = owner().read(); const result = methods[declaration.id](args);
      const after = owner().read(), changed = changedIds(before, after);
      const affectedIds = changed.length ? changed : [args.shotId ?? ports.state().activeSceneId];
      return { affectedIds, summary: result?.message ?? (changed.length ? `${declaration.label}: ${changed.map(id => after.find(row => row.id === id)).filter(Boolean).map(shotLabel).join('; ')}.` : `${declaration.label}.`) };
    },
  });
  if (ports.storeDomain?.('shot')) registry.registerToolAlias('frame_shot', 'shot.frame');
}
