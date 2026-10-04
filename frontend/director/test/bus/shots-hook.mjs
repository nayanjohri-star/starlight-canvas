import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Load the shipped hook without mounting renderer hardware. Constants and aim
// math remain the shipped source; no shot editing or history is substituted.
const stage = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8');
const controls = readFileSync(new URL('../../src/controls.jsx', import.meta.url), 'utf8');
const constants = ['DEFAULT_ENVIRONMENT', 'DEFAULT_DURATION_S', 'TIMELINE_FPS'].map(name => stage.match(new RegExp(`export const ${name} = [^;]+;`))[0]).join('\n');
const presets = stage.slice(stage.indexOf('export const PRESETS ='), stage.indexOf('\n};', stage.indexOf('export const PRESETS =')) + 3);
const aim = controls.slice(controls.indexOf('export function aimAt('), controls.indexOf('\n}', controls.indexOf('export function aimAt(')) + 2);
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  plugins: [{ name: 'shots-without-renderer', enforce: 'pre', load(id) {
    if (id.endsWith('/src/app-stage.jsx')) return `const ko = en => en;\n${constants}\n${presets}`;
    if (id.endsWith('/src/controls.jsx')) return aim;
  } }],
});
let useShots;
try { ({ useShots } = await server.ssrLoadModule('/src/domains/shots.js')); }
finally { await server.close(); }
export function mountShots(context) {
  let shots;
  function Mount() { shots = useShots(context); return null; }
  renderToStaticMarkup(createElement(Mount));
  return shots;
}
