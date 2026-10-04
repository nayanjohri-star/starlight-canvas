// SPDX-License-Identifier: AGPL-3.0-or-later
// Read once after a real main-view render, outside the timed benchmark windows.
// Self-contained for execution in the actual hosted iframe.
export function inspectDirectorSceneBudget(scene, renderer, camera) {
  if (!scene?.isScene || !camera?.isCamera || !renderer?.info?.render) throw Error('Actual scene/renderer/camera are required');
  if (renderer.info.autoReset !== true) throw Error('Per-render actual draw counters require renderer.info.autoReset');
  const geometries = new Map(), textures = new Map(), meshes = [];
  const dimensions = image => {
    const value = image?.image ?? image;
    const width = value?.videoWidth || value?.naturalWidth || value?.width;
    const height = value?.videoHeight || value?.naturalHeight || value?.height;
    return { width: Number.isSafeInteger(width) && width > 0 ? width : null,
      height: Number.isSafeInteger(height) && height > 0 ? height : null, sourceTypedArrayBytes: value?.data?.byteLength ?? null };
  };
  const texture = (value, role) => {
    if (!value?.isTexture) return;
    const found = textures.get(value.uuid); if (found) { if (!found.roles.includes(role)) found.roles.push(role); return; }
    const faces = (Array.isArray(value.image) ? value.image : [value.image]).map(dimensions);
    let baseBytes = 0, mipBytes = 0, known = true;
    for (const face of faces) {
      if (!face.width || !face.height) { known = false; continue; }
      baseBytes += face.width * face.height * 4;
      let width = face.width, height = face.height;
      do { mipBytes += width * height * 4; width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2)); }
      while (width > 1 || height > 1);
      if (face.width !== 1 || face.height !== 1) mipBytes += 4;
    }
    textures.set(value.uuid, { uuid: value.uuid, name: value.name, roles: [role], type: value.type, format: value.format,
      colorSpace: value.colorSpace, generateMipmaps: value.generateMipmaps, faces,
      rgba8BaseLevelEquivalentBytes: known ? baseBytes : null,
      rgba8FullMipChainEquivalentBytes: known ? mipBytes : null,
      sourceTypedArrayBytes: faces.every(face => face.sourceTypedArrayBytes !== null) ? faces.reduce((sum, face) => sum + face.sourceTypedArrayBytes, 0) : null });
  };
  const uniformTextures = (value, role, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object') return;
    if (value.isTexture) { texture(value, role); return; }
    if (seen.has(value)) return; seen.add(value);
    if (Array.isArray(value)) for (const item of value) uniformTextures(item, role, seen);
    else if (Object.getPrototypeOf(value) === Object.prototype) for (const item of Object.values(value)) uniformTextures(item, role, seen);
  };
  texture(scene.background, 'scene.background'); texture(scene.environment, 'scene.environment');
  const visit = node => {
    if (node.visible === false) return;
    if (node.isMesh && camera.layers.test(node.layers)) {
      const geometry = node.geometry, materials = Array.isArray(node.material) ? node.material : [node.material];
      const visibleMaterials = materials.filter(material => material && material.visible !== false);
      if (geometry && visibleMaterials.length) {
        const vertices = geometry.getAttribute('position')?.count ?? 0, indices = geometry.index?.count ?? 0;
        if (!geometries.has(geometry.uuid)) {
          const buffers = new Set();
          for (const attribute of [...Object.values(geometry.attributes), ...Object.values(geometry.morphAttributes).flat(), geometry.index]) {
            const array = attribute?.array ?? attribute?.data?.array; if (array?.buffer) buffers.add(array.buffer);
          }
          geometries.set(geometry.uuid, { uuid: geometry.uuid, type: geometry.type, vertices, indices,
            topologyTriangles: Math.floor((indices || vertices) / 3), cpuAttributeBufferBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) });
        }
        meshes.push({ uuid: node.uuid, name: node.name, type: node.type, geometryUuid: geometry.uuid,
          instances: node.isInstancedMesh ? node.count : 1, skinned: !!node.isSkinnedMesh,
          drawRange: { start: geometry.drawRange.start, count: Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : 'unbounded' },
          groups: geometry.groups.map(group => ({ ...group })), materialUuids: visibleMaterials.map(material => material.uuid),
          wireframe: visibleMaterials.some(material => material.wireframe === true) });
        for (const material of visibleMaterials) {
          for (const [key, value] of Object.entries(material)) if (value?.isTexture) texture(value, `material.${key}`);
          for (const [key, uniform] of Object.entries(material.uniforms ?? {})) uniformTextures(uniform.value, `uniform.${key}`);
        }
        texture(node.skeleton?.boneTexture, 'skeleton.boneTexture');
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(scene);
  const geometryRows = [...geometries.values()], textureRows = [...textures.values()];
  const render = renderer.info.render;
  for (const key of ['calls', 'triangles', 'points', 'lines']) if (!Number.isFinite(render[key]) || render[key] < 0) throw Error(`Invalid actual renderer.info.render.${key}`);
  return { scope: 'one actual main-camera scene.render callback; includes any shadow draws executed in that call; excludes later PiP/effect passes',
    cameraUuid: camera.uuid, cameraType: camera.type, sceneUuid: scene.uuid, rendererAutoReset: renderer.info.autoReset,
    actualDrawCounters: { frame: render.frame, calls: render.calls, triangles: render.triangles, points: render.points, lines: render.lines },
    rendererMemoryCounts: { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures },
    geometryInventoryScope: 'visible mesh/material candidates on main camera layers; not a frustum/draw-count substitute',
    visibleMeshCandidates: meshes.length, uniqueGeometries: geometryRows.length,
    uniqueTopologyTriangles: geometryRows.reduce((sum, row) => sum + row.topologyTriangles, 0),
    instancedTopologyTriangles: meshes.reduce((sum, row) => sum + geometries.get(row.geometryUuid).topologyTriangles * row.instances, 0),
    cpuGeometryBufferBytes: geometryRows.reduce((sum, row) => sum + row.cpuAttributeBufferBytes, 0),
    textureEstimateScope: 'RGBA8-equivalent base/full mip-chain bytes of unique scene-referenced textures, not measured GPU allocation; excludes unreferenced pipeline targets',
    uniqueTextures: textureRows.length, texturesWithUnknownDimensions: textureRows.filter(row => row.rgba8BaseLevelEquivalentBytes === null).length,
    rgba8BaseLevelEquivalentBytes: textureRows.reduce((sum, row) => sum + (row.rgba8BaseLevelEquivalentBytes ?? 0), 0),
    rgba8FullMipChainEquivalentBytes: textureRows.reduce((sum, row) => sum + (row.rgba8FullMipChainEquivalentBytes ?? 0), 0),
    geometries: geometryRows, textures: textureRows, meshes };
}
