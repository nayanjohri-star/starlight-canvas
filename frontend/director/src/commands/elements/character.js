import { createCharacterEntry } from '../../scenes.js';
import { STUDIO_ELEMENTS } from '../../studio-elements.js';
import { registerElementKind } from '../elements.js';

const elements = STUDIO_ELEMENTS.filter(row => row.path.startsWith('character.')).map(row => {
  const { min, max, gizmo, ...element } = row;
  if (row.path === 'character.position') return { ...element, documentPath: { x: 'x', y: 'y', z: 'z' } };
  if (row.path === 'character.promptBlocks') return { ...element, documentPath: 'layer.promptClips' };
  if (row.path === 'character.pose') return { ...element, readback: item => ({ text: item?.pose?.id ?? null }) };
  return element;
});
registerElementKind('character', { collection: true, documentKey: 'characters', elements, normalize: createCharacterEntry });
registerElementKind('poseLibrary', { collection: true, documentKey: 'customPoses', elements: [], normalize: value => value });
