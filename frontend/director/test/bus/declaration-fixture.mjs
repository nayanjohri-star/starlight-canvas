import * as scene from '../../src/commands/scene.js';
export const declarations = scene.declarations.map(entry => entry.id === 'scene.rename'
  ? { ...entry, kind: 'mutation', undoDomain: 'scenes', description: 'Rename within the scenes history.' } : entry);
// The existing implementation still spreads the shared declaration. The
// module's exported declaration must win at the registration boundary.
export const register = scene.register;
