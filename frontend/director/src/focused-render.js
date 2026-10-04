// SPDX-License-Identifier: AGPL-3.0-or-later
import { WebGLRenderTarget, HalfFloatType, Vector4, Color, GLSL3, NoToneMapping, LinearSRGBColorSpace } from 'three';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { applyFocusToPass, normalizeFocus } from './camera-focus.js';
import { withCleanSceneMaterials } from './clean-scene.js';

function createStableOutputPass() {
  const output = new OutputPass();
  // Input and output have the same pixel dimensions. Integer texel addressing
  // avoids a sub-pixel UV interpolation mixing neighboring half-float colors.
  output.material.glslVersion = GLSL3;
  output.material.vertexShader = output.material.vertexShader.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out');
  output.material.fragmentShader = output.material.fragmentShader
    .replace(/\bvarying\b/g, 'in').replace(/\bgl_FragColor\b/g, 'directorColor')
    .replace('precision highp float;', 'precision highp float; out highp vec4 directorColor;')
    .replace('uniform sampler2D tDiffuse;', 'uniform highp sampler2D tDiffuse;')
    .replace('texture2D( tDiffuse, vUv )',
      'texelFetch(tDiffuse, ivec2(clamp(floor(vUv * vec2(textureSize(tDiffuse, 0))), vec2(0.0), vec2(textureSize(tDiffuse, 0)) - 1.0)), 0)');
  // Keep sub-byte shader rounding from choosing different sides of an RGBA8
  // boundary between codec yields. This fixed 16-bit grid changes a channel by
  // at most 1/131072 (less than 0.002 of one delivery byte).
  output.material.fragmentShader = output.material.fragmentShader.replace(/}\s*$/,
    'directorColor.rgb = floor(clamp(directorColor.rgb, 0.0, 1.0) * 65536.0 + 0.5) / 65536.0; }');
  return output;
}

/** One depth based renderer used by both the shot monitor and fixed-frame output. */
export function createFocusedRenderer() {
  let pipeline = null, disposed = false;
  return {
    render({ renderer, scene, camera, target = null, width, height }) {
      if (disposed) throw new Error('景深渲染器已释放');
      return withCleanSceneMaterials(scene, () => {
      const dataPass = scene.overrideMaterial != null;
      const focus = normalizeFocus(dataPass ? { depthOfField: false } : camera.userData.focus);
      if (!focus.depthOfField && target === null) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      if (!pipeline) {
        const color = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: 4 });
        pipeline = { color, output: createStableOutputPass() };
      }
      if (focus.depthOfField && !pipeline.bokeh) Object.assign(pipeline, {
        blurred: new WebGLRenderTarget(width, height, { type: HalfFloatType }),
        bokeh: new BokehPass(scene, camera, { maxblur: 0.015 }) });
      const { color, blurred, bokeh, output } = pipeline;
      color.setSize(width, height);
      if (focus.depthOfField) {
        blurred.setSize(width, height); bokeh.setSize(width, height);
        bokeh.scene = scene; bokeh.camera = camera;
        applyFocusToPass(bokeh, focus, camera.getFocalLength?.() ?? 50);
      }
      const previous = renderer.getRenderTarget(), scissor = renderer.getScissor(new Vector4());
      const scissorTest = renderer.getScissorTest(), viewport = renderer.getViewport(new Vector4());
      const override = scene.overrideMaterial, autoClear = renderer.autoClear;
      const toneMapping = renderer.toneMapping, outputColorSpace = renderer.outputColorSpace;
      const clearColor = renderer.getClearColor(new Color()), clearAlpha = renderer.getClearAlpha();
      try {
        renderer.setScissorTest(false); renderer.setRenderTarget(color); renderer.render(scene, camera);
        if (focus.depthOfField) bokeh.render(renderer, blurred, color);
        renderer.setScissor(scissor); renderer.setViewport(viewport); renderer.setScissorTest(scissorTest);
        // Depth and normal plates encode geometry, so retain their values
        // rather than applying the display look or lens blur to their channels.
        if (dataPass) { renderer.toneMapping = NoToneMapping; renderer.outputColorSpace = LinearSRGBColorSpace; }
        output.renderToScreen = target === null;
        // Three.js r185 renders ordinary targets in linear working space.
        // Every captured plate needs exactly one final tone/color conversion,
        // including plates without DOF, matching direct canvas shot previews.
        output.render(renderer, target, focus.depthOfField ? blurred : color);
      } finally {
        scene.overrideMaterial = override; renderer.autoClear = autoClear;
        renderer.toneMapping = toneMapping; renderer.outputColorSpace = outputColorSpace;
        renderer.setClearColor(clearColor, clearAlpha);
        renderer.setRenderTarget(previous); renderer.setScissor(scissor); renderer.setViewport(viewport); renderer.setScissorTest(scissorTest);
      }
      });
    },
    dispose() {
      if (disposed) return; disposed = true;
      if (pipeline) { for (const resource of Object.values(pipeline)) resource.dispose(); pipeline = null; }
    },
  };
}
