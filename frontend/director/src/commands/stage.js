import { elementSetSchema, registerElementSet } from './elements.js';
export { STAGE_FIELDS, normalizeStage } from './elements/stage.js';

const input = elementSetSchema('stage');
const declaration = (id, properties = input.properties) => ({ id, label: 'Set stage', kind: 'mutation', undoDomain: 'stage',
  description: 'Update authored stage fields, normalized by scene persistence.',
  input: { ...input, properties } });
export const declarations = Object.freeze([
  declaration('stage.set'),
  declaration('stage.setKeyLight', { keyLight: input.properties.keyLight }),
  declaration('stage.setEnvironment', Object.fromEntries(['environment', 'environmentImage', 'hasEnvSheet'].map(key => [key, input.properties[key]]))),
  declaration('stage.setStyle', { style: input.properties.style }),
  declaration('stage.setFilmback', Object.fromEntries(['shotAspect', 'cameraPresetId', 'sensorId'].filter(key => input.properties[key]).map(key => [key, input.properties[key]]))),
]);
export function register(registry, ports) {
  for (const declaration of declarations) registerElementSet(registry, ports, declaration);
}
