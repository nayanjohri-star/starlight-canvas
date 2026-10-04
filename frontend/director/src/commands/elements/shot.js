import { createShotAuthoringDocument } from '../../shot-authoring.js';
import { STUDIO_ELEMENTS } from '../../studio-elements.js';
import { registerElementKind } from '../elements.js';

export function normalizeShot(record) {
  return createShotAuthoringDocument({ shots: [record], frameCount: Math.max(24, record.endFrame + 1) }).shots[0];
}
registerElementKind('shot', { collection: true, documentKey: 'shots',
  elements: STUDIO_ELEMENTS.filter(row => row.path.startsWith('shot.')), normalize: normalizeShot });
