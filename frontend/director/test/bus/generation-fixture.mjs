import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSync } from 'rolldown/experimental';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
import { freeReferences } from './verify-domain-modules.mjs';
import { motionArraysToNpzMembers, writeNpz } from '../../tools/ardy/npz.mjs';
import { createStudioTools } from '../../bin/agent/studio-tools.mjs';

const stage = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../src/domains/motion.js', import.meta.url), 'utf8');
const ast = parseSync('stage.jsx', stage).program, names = new Map(), selected = new Set();
for (const node of ast.body) {
  const declaration = node.declaration ?? node;
  if (node.type === 'ImportDeclaration') for (const spec of node.specifiers) names.set(spec.local.name, node);
  if (declaration.type === 'FunctionDeclaration') names.set(declaration.id.name, node);
  if (declaration.type === 'VariableDeclaration') for (const entry of declaration.declarations) if (entry.id.type === 'Identifier') names.set(entry.id.name, node);
}
function include(name) {
  const node = names.get(name); if (!node || selected.has(node)) return;
  selected.add(node);
  if (node.type !== 'ImportDeclaration') for (const ref of freeReferences({ type: 'Program', body: [node] })) include(ref.node.name);
}
for (const node of parseSync('motion.js', source).program.body) if (node.type === 'ImportDeclaration' && node.source.value.endsWith('/app-stage.jsx')) for (const spec of node.specifiers) include(spec.imported.name);
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  plugins: [{ name: 'generation-ssr-state', enforce: 'pre', load(id) {
    if (id.endsWith('/src/app-stage.jsx')) return ast.body.filter(node => selected.has(node)).map(node => stage.slice(node.start, node.end)).join('\n');
    if (id.endsWith('/src/domains/motion.js')) return source.replace('useState, ', '') + '\nimport { useState } from "../../test/bus/generation-hooks.mjs";';
    if (id.endsWith('/src/motion-store.js')) return `export * from '../test/bus/motion-cache-fixture.mjs';`;
  } }] });
let useMotion, hooks;
try { ({ useMotion } = await server.ssrLoadModule('/src/domains/motion.js')); hooks = await server.ssrLoadModule('/test/bus/generation-hooks.mjs'); }
finally { await server.close(); }
const dir = mkdtempSync(join(tmpdir(), 'generation-npz-'));
export let motionBytes;
try { const path = join(dir, 'take.npz'); writeNpz(path, motionArraysToNpzMembers(seedMotion(96))); motionBytes = new Uint8Array(readFileSync(path)); }
finally { rmSync(dir, { recursive: true, force: true }); }

export function generationFixture() {
  const f = motionFixture(), scope = f.scope;
  Object.assign(scope, { genJobSeq: { current: 0 }, ardyAbortRef: { current: null }, ikFrames: [], waypointMode: true,
    waypoints: [], linePreviewUrl: null, PROMPT_BLOCK_MAX_FRAMES: 120 });
  hooks.begin(true);
  function render() {
    hooks.begin(); let motion;
    function Mount() { motion = useMotion(scope.appContext); return null; }
    renderToStaticMarkup(createElement(Mount)); Object.assign(scope, motion); f.motion = motion; return motion;
  }
  render(); f.motion.setBridge({ ok: true, routes: ['generate'], backend: 'kimodo' }); render();
  const admission = { host: f.host(), revision: f.binding.refresh().revision, commandId: () => crypto.randomUUID(),
    refresh: async () => { admission.revision = f.binding.refresh().revision; } };
  const tools = () => createStudioTools({ workspaceHandle: 'fixture', session: { admission, actionIndex: f.registry.list() },
    liveHub: { command: async (name, args) => {
      if (name === 'run_action') return f.binding.handlers.run_action(args);
      return f.binding.handlers[name](args);
    } } });
  const seen = new Set();
  const release = hooks.subscribe(value => {
    if (!Array.isArray(value)) return;
    for (const job of value.filter(row => row?.status === 'queued' && row.body && !seen.has(row.id))) {
      seen.add(job.id);
      // App's queue effect: subscribe before admission, execute the frozen job,
      // and resolve/reject its completion when the actual producer settles.
      queueMicrotask(async () => {
        try { await f.motion.executeMotionJob(job); job.commandCompletion?.resolve(); }
        catch (error) { f.executionError = error; job.commandCompletion?.reject(error); }
        finally { scope.generationPendingRef.current = false; }
      });
    }
  });
  const dispose = f.dispose;
  return Object.assign(f, { renderGeneration: render, tools, dispose() { release(); dispose(); } });
}
