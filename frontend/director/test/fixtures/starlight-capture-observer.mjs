// SPDX-License-Identifier: AGPL-3.0-or-later
// Self-contained for installation in the actual browser realm through CDP.
// Reads real production HalfFloat/MSAA4 draws; never changes targets, shaders,
// geometry, renderer settings, frame data or the capture factory lifecycle.
export function installCaptureObserver({ scene, renderer, width, height, fps, frameCount, authoredSha256, retainPixels = false, kind = 'video', expectedVisibility = null }) {
  const require = (condition, message) => { if (!condition) throw new Error(`Media observer: ${message}`); };
  require(scene?.isScene && typeof renderer?.setRenderTarget === 'function', 'real scene/renderer required');
  require([24, 30].includes(fps) && Number.isSafeInteger(frameCount) && frameCount > 0, 'valid integer clock required');
  require(kind === 'video' || kind === 'pack', 'unsupported observation scope');
  require(expectedVisibility === null || ['visible', 'hidden'].includes(expectedVisibility), 'invalid required visibility');
  const checkVisibility = () => {
    const visibility = globalThis.document?.visibilityState ?? 'cpu-only';
    if (expectedVisibility !== null) require(visibility === expectedVisibility, `actual visibility ${visibility}, expected ${expectedVisibility}`);
    return visibility;
  };
  const originalSetTarget = renderer.setRenderTarget, originalAfter = scene.onAfterRender;
  const pending = [], frames = [], endpoints = [], jobs = [];
  let ownedColor = null, deliveryTarget = null, activeOwnedDraw = false, disposed = false, captures = 0, fault = null;
  const bits = values => {
    require(Array.from(values).every(value => typeof value === 'number' && Number.isFinite(value)), 'non-finite numeric render state');
    const doubles = Float64Array.from(values), bytes = new Uint8Array(doubles.buffer);
    let text = ''; for (const value of bytes) text += value.toString(16).padStart(2, '0');
    return text;
  };
  const vector = value => value?.toArray ? (value.isEuler ? { angles: bits(value.toArray().slice(0, 3)), order: value.order } : bits(value.toArray())) : null;
  const texture = value => value?.isTexture ? { uuid: value.uuid, version: value.version, type: value.type, colorSpace: value.colorSpace, matrix: vector(value.matrix), wrapS: value.wrapS, wrapT: value.wrapT, minFilter: value.minFilter, magFilter: value.magFilter, flipY: value.flipY } : null;
  const scalar = value => typeof value === 'number' ? bits([value]) : value;
  const uniformValue = value => {
    if (value == null || ['string', 'boolean', 'number'].includes(typeof value)) return scalar(value);
    if (value.isTexture) return texture(value);
    if (value.toArray) return vector(value);
    if (ArrayBuffer.isView(value)) return { arrayType: value.constructor.name, values: bits(value) };
    if (Array.isArray(value)) return value.map(uniformValue);
    require(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'unsupported uniform type ' + value.constructor?.name);
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, uniformValue(item)]));
  };
  const material = value => {
    if (Array.isArray(value)) return value.map(material);
    if (!value) return null;
    const data = { uuid: value.uuid, type: value.type, version: value.version, defines: structuredClone(value.defines ?? null), onBeforeCompile: value.onBeforeCompile?.toString() ?? null };
    for (const key of ['color', 'emissive', 'opacity', 'transparent', 'roughness', 'metalness', 'emissiveIntensity', 'normalScale', 'bumpScale', 'displacementScale', 'displacementBias', 'aoMapIntensity', 'lightMapIntensity', 'envMapIntensity', 'ior', 'reflectivity', 'refractionRatio', 'clearcoat', 'clearcoatRoughness', 'sheen', 'sheenColor', 'sheenRoughness', 'transmission', 'thickness', 'attenuationColor', 'side', 'blending', 'depthTest', 'depthWrite', 'alphaTest', 'alphaHash', 'wireframe', 'toneMapped', 'flatShading', 'vertexColors', 'visible', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'fragmentShader', 'vertexShader', 'glslVersion']) {
      if (value[key] !== undefined) data[key] = value[key]?.toArray ? vector(value[key]) : scalar(value[key]);
    }
    for (const key of ['map', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap', 'bumpMap', 'displacementMap', 'envMap']) data[key] = texture(value[key]);
    if (value.uniforms) data.uniforms = Object.fromEntries(Object.entries(value.uniforms).sort(([a], [b]) => a.localeCompare(b)).map(([key, uniform]) => {
      return [key, uniformValue(uniform.value)];
    }));
    return data;
  };
  function snapshot(camera) {
    const gl = renderer.getContext();
    const nativeContext = typeof globalThis.WebGL2RenderingContext === 'function' && gl instanceof globalThis.WebGL2RenderingContext;
    require(typeof globalThis.window === 'undefined' || nativeContext, 'formal browser requires a real WebGL2 context');
    // Queries only: never bind, resolve, reconfigure or replace a framebuffer.
    const actualFramebuffer = { observedIn: nativeContext ? 'webgl2' : 'cpu-stub', samples: gl.getParameter(gl.SAMPLES), status: gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER),
      componentType: gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE),
      channelBits: ['RED', 'GREEN', 'BLUE', 'ALPHA'].map(channel => gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl[`FRAMEBUFFER_ATTACHMENT_${channel}_SIZE`])),
      attachmentObjectType: gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) };
    require(actualFramebuffer.samples === 4 && actualFramebuffer.status === gl.FRAMEBUFFER_COMPLETE && actualFramebuffer.componentType === gl.FLOAT && actualFramebuffer.channelBits.every(bits => bits === 16), 'actual framebuffer is not complete float16/MSAA4');
    const objects = [], lights = [];
    function walk(node, visible) {
      visible &&= node.visible !== false;
      if (!visible) return;
      if (node.isLight) lights.push({ uuid: node.uuid, type: node.type, matrixWorld: vector(node.matrixWorld), color: vector(node.color), intensity: scalar(node.intensity), castShadow: node.castShadow,
        distance: scalar(node.distance), angle: scalar(node.angle), penumbra: scalar(node.penumbra), decay: scalar(node.decay),
        target: vector(node.target?.matrixWorld), shadow: node.shadow ? { matrix: vector(node.shadow.matrix), bias: scalar(node.shadow.bias), normalBias: scalar(node.shadow.normalBias), radius: scalar(node.shadow.radius), mapSize: vector(node.shadow.mapSize), camera: vector(node.shadow.camera?.projectionMatrix), cameraWorld: vector(node.shadow.camera?.matrixWorld), cameraWorldInverse: vector(node.shadow.camera?.matrixWorldInverse) } : null });
      if ((node.isMesh || node.isLine || node.isPoints) && (node.layers.mask & camera.layers.mask)) {
        const geometry = node.geometry;
        objects.push({ uuid: node.uuid, name: node.name, type: node.type, matrixWorld: vector(node.matrixWorld), layers: node.layers.mask, renderOrder: node.renderOrder, castShadow: node.castShadow, receiveShadow: node.receiveShadow,
          geometry: geometry ? { uuid: geometry.uuid, drawRange: { ...geometry.drawRange, count: String(geometry.drawRange.count) }, indexVersion: geometry.index?.version ?? null,
            attributes: Object.fromEntries(Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([name, attribute]) => [name, { version: attribute.version, itemSize: attribute.itemSize, count: attribute.count, normalized: attribute.normalized, arrayType: attribute.array?.constructor.name }])) } : null,
          material: material(node.material), morph: node.morphTargetInfluences ? bits(node.morphTargetInfluences) : null,
          skeleton: node.skeleton ? { bones: node.skeleton.bones.map(bone => ({ uuid: bone.uuid, name: bone.name, matrixWorld: vector(bone.matrixWorld) })), boneMatrices: bits(node.skeleton.boneMatrices), bindMatrix: vector(node.bindMatrix), bindMatrixInverse: vector(node.bindMatrixInverse) } : null });
      }
      for (const child of node.children ?? []) walk(child, visible);
    }
    walk(scene, true);
    require(objects.some(object => object.skeleton?.bones.length), 'actual posed rig not present in owned capture');
    return { camera: { type: camera.type, matrixWorld: vector(camera.matrixWorld), matrixWorldInverse: vector(camera.matrixWorldInverse), projection: vector(camera.projectionMatrix), projectionInverse: vector(camera.projectionMatrixInverse), layers: camera.layers.mask, aspect: scalar(camera.aspect), fov: scalar(camera.fov), near: scalar(camera.near), far: scalar(camera.far), zoom: scalar(camera.zoom), focus: structuredClone(camera.userData?.focus ?? null) },
      objects, lights, background: scene.background?.toArray ? vector(scene.background) : texture(scene.background), backgroundIntensity: scalar(scene.backgroundIntensity), backgroundBlurriness: scalar(scene.backgroundBlurriness), backgroundRotation: vector(scene.backgroundRotation),
      environment: texture(scene.environment), environmentIntensity: scalar(scene.environmentIntensity), environmentRotation: vector(scene.environmentRotation), fog: scene.fog ? { color: vector(scene.fog.color), near: scalar(scene.fog.near), far: scalar(scene.fog.far) } : null,
      renderer: { toneMapping: renderer.toneMapping, toneMappingExposure: scalar(renderer.toneMappingExposure), outputColorSpace: renderer.outputColorSpace, shadowType: renderer.shadowMap?.type },
      productionTarget: { type: ownedColor.texture.type, samples: ownedColor.samples, width: ownedColor.width, height: ownedColor.height }, actualFramebuffer };
  }
  renderer.setRenderTarget = function observedSetTarget(target, ...args) {
    const previous = this.getRenderTarget();
    // Production createOffscreenCapture selects its final RGBA8/no-depth target
    // BEFORE focused-render selects HalfFloat/MSAA4. Live/PiP render starts from
    // null/viewport, so equal dimensions alone do not identify an owned capture.
    if (previous?.texture?.type === 1009 && previous.samples === 0 && previous.depthBuffer === false && previous.width === width && previous.height === height
        && target?.texture?.type === 1016 && target.samples === 4 && target.width === width && target.height === height) { deliveryTarget = previous; ownedColor = target; activeOwnedDraw = true; }
    // Three's shadow pass and Bokeh temporarily visit OTHER non-null targets.
    // Their round-trip does not retire the actual delivery->color scope.
    // Returning to its delivery target (or null) ends the color phase. A later
    // live/null->same old color has no token and cannot supply a frame state.
    else if (target === deliveryTarget || target === null) activeOwnedDraw = false;
    return originalSetTarget.call(this, target, ...args);
  };
  scene.onAfterRender = function observedAfterRender(actualRenderer, actualScene, camera) {
    // Three r185 has THREE arguments. Read the actual target from the renderer.
    // Latch BEFORE delegating callbacks; a callback may restore live values.
    try {
      if (actualRenderer === renderer && actualScene === scene && activeOwnedDraw && ownedColor && renderer.getRenderTarget() === ownedColor && scene.overrideMaterial == null) {
        try { checkVisibility(); pending.push(snapshot(camera)); captures++; } catch (error) { fault = error; throw error; }
      }
    } finally {
      originalAfter?.call(this, actualRenderer, actualScene, camera);
    }
  };
  function frame(data, options) {
    if (fault) throw fault;
    require(!disposed, 'observation disposed');
    const index = frames.length;
    require(index < frameCount, 'too many native VideoFrame inputs');
    if (kind === 'pack' && index === 0) {
      require(pending.length === 3, `pack endpoints + first video draw require exactly 3 owned states; got ${pending.length}`);
      endpoints.push({ frameIndex: 0, renderState: pending.shift() }, { frameIndex: frameCount - 1, renderState: pending.shift() });
    }
    require(pending.length === 1, `VideoFrame ${index} requires exactly one owned color draw; got ${pending.length}`);
    const timestamp = Math.round(index * 1_000_000 / fps), duration = Math.round((index + 1) * 1_000_000 / fps) - timestamp;
    require(options.format === 'RGBA' && options.codedWidth === width && options.codedHeight === height, 'actual VideoFrame dimensions/format changed');
    require(options.timestamp === timestamp && options.duration === duration, `wrong addressed timestamp/duration at frame ${index}`);
    require(ArrayBuffer.isView(data) && data.byteLength === width * height * 4, 'incomplete real VideoFrame RGBA');
    const entry = { frameIndex: index, fps, timestamp, duration, width, height, authoredSha256, visibility: checkVisibility(), renderState: pending.shift() };
    frames.push(entry);
    if (retainPixels) {
      const copy = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
      // Lossless storage only. No shader/pixel change or extra codec pacing.
      jobs.push(new Response(new Blob([copy]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer().then(bytes => { entry.compressedRgba = new Uint8Array(bytes); }));
    }
  }
  async function finish() {
    if (fault) throw fault;
    require(frames.length === frameCount, `missing native inputs: ${frames.length}/${frameCount}`);
    require(pending.length === 0, 'unconsumed or extra owned capture draw');
    require(captures === frameCount + (kind === 'pack' ? 2 : 0), 'capture/video cardinality changed');
    await Promise.all(jobs);
    return { frameCount, captures, endpoints, frames };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setRenderTarget = originalSetTarget; scene.onAfterRender = originalAfter;
  }
  return { frame, finish, dispose };
}
