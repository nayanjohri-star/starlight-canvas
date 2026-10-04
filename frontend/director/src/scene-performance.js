// SPDX-License-Identifier: AGPL-3.0-or-later
import { CUTOUT_KIND, MESH_KIND, isEffectivelyHidden, objectLibraryEntry } from './scene-objects.js';

// These describe the measured scene, never an import or editing limit. Read
// only current scene references: unused shelf files impose no scene workload.
export function scenePerformanceStatus({ characters = [], objects = [], environmentImage = null } = {}) {
  const visibleCharacters = characters.filter(character => character && character.hidden !== true).length;
  const visibleObjects = objects.filter(object => object && objectLibraryEntry(object.renderer)
    && !isEffectivelyHidden(object, objects, characters));
  const customMeshes = visibleObjects.filter(object => object.renderer === MESH_KIND).length;
  const imageCutouts = visibleObjects.filter(object => object.renderer === CUTOUT_KIND).length;
  const environmentTexture = typeof environmentImage === 'string' && environmentImage.length > 0;
  return { visibleCharacters, visibleProps: visibleObjects.length, customMeshes, imageCutouts, environmentTexture,
    beyondTested: visibleCharacters > 2 || visibleObjects.length > 20 || customMeshes > 0 || imageCutouts > 0 || environmentTexture };
}
