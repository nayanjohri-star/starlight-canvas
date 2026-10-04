// Manual surface gate: node test/bus/motion-browser-smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { motionArraysToNpzMembers, writeNpz } from '../../tools/ardy/npz.mjs';
import { CSKEL27_NEUTRAL } from '../../src/ardy/cskel27-neutral.js';
const profile = mkdtempSync(join(tmpdir(), 'motion-browser-'));
const frames = 48, rotMats = new Float32Array(frames * 243), rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 81);
for (let f = 0; f < frames; f++) for (let j = 0; j < 27; j++) {
  rotMats.set([1,0,0,0,1,0,0,0,1], (f * 27 + j) * 9);
  const p = CSKEL27_NEUTRAL[j]; posedJoints.set([p[0], p[1] + 1.3544128 - 0.05, p[2]], (f * 27 + j) * 3);
  if (j === 0) rootPos.set(posedJoints.subarray(f * 81, f * 81 + 3), f * 3);
}
const npz = join(profile, 'take.npz'); writeNpz(npz, motionArraysToNpzMembers({ frames, fps: 24, rotMats, rootPos, posedJoints }));
const bytes = readFileSync(npz);
process.env.COZYCLAY_LIVE_PORT = '5742';
const server = await createServer({ server: { host: '127.0.0.1', port: 5222, strictPort: true, hmr: false }, plugins: [{ name: 'qa-motion-resource', configureServer(server) {
  server.middlewares.use('/__motion-qa.npz', (_req, res) => { res.setHeader('Content-Type', 'application/octet-stream'); res.end(bytes); });
} }] });
let chrome, ws, sequence = 0, sessionId;
const pending = new Map(), pageErrors = [];
function bounded(promise, label, ms = 30000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: ${pageErrors.join('; ')}`)), ms); })]).finally(() => clearTimeout(timer));
}
const send = (method, params = {}, browser = false) => bounded(new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(!browser && sessionId ? { sessionId } : {}) }));
}), method);
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
// Subscribe to the exact React DOM / QA-state publication before the gesture.
async function transition(condition, action = '') {
  return evaluate(`new Promise((resolve,reject) => {
    let timer; const cleanup = () => { observer.disconnect(); window.removeEventListener('motion-qa-state', check); clearTimeout(timer); };
    const check = () => { if (${condition}) { cleanup(); resolve(true); } };
    const observer = new MutationObserver(check); observer.observe(document, { childList:true, subtree:true, attributes:true, characterData:true });
    window.addEventListener('motion-qa-state', check);
    timer = setTimeout(() => { cleanup(); reject(new Error('Surface transition deadline: ' + ${JSON.stringify(condition)})); }, 20000);
    ${action}; check();
  })`);
}
try {
  await server.listen();
  chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1600,1100', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await bounded(new Promise((resolve, reject) => {
    let output = ''; chrome.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); });
    chrome.once('error', reject); chrome.once('exit', code => reject(new Error(`Chrome exited ${code}`)));
  }), 'Chrome ready');
  ws = new WebSocket(endpoint);
  await bounded(new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); }), 'CDP connected');
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') { const error = message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text; pageErrors.push(error); console.error(error); }
    const result = pending.get(message.id); if (!result) return; pending.delete(message.id);
    if (message.error) result.reject(new Error(JSON.stringify(message.error))); else result.resolve(message.result);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, true);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, true));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({name:'Motion QA',updatedAt:Date.now()})); localStorage.setItem('cozyclay.camera-tutorial-terminal.v1',JSON.stringify({completed:true})); let qa; Object.defineProperty(window, '__cozyclay', {configurable:true,get:()=>qa,set:value=>{qa=value;window.dispatchEvent(new Event('motion-qa-state'));}});` });
  const loaded = bounded(new Promise(resolve => {
    const listener = event => { const message = JSON.parse(event.data); if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) { ws.removeEventListener('message', listener); resolve(); } }; ws.addEventListener('message', listener);
  }), 'Page load');
  await send('Page.navigate', { url: 'http://127.0.0.1:5222/app/?motion=/__motion-qa.npz' }); await loaded;
  await transition(`window.__cozyclay?.motion?.frames === 48 && document.querySelector('.tl-btn.clear')`);
  console.log('PASS browser motion: real NPZ loaded into the owned take and timeline');
  await transition(`!window.__cozyclay.motion && !document.querySelector('.tl-btn.clear')`, `document.querySelector('.tl-btn.clear').click()`);
  console.log('PASS browser motion: timeline Clear removes the take');
  await transition(`window.__cozyclay.motion?.frames === 48`, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true}))`);
  console.log('PASS browser motion: one keyboard undo restores the take');
  const before = await evaluate(`Array.from(window.__cozyclay.motion.rootPos)`);
  await transition(`!!window.__cozyclay.trail.edit`, `window.__cozyclay.trailEditApply(12,{x:0.2,y:0,z:0})`);
  assert.notDeepEqual(await evaluate(`Array.from(window.__cozyclay.motion.rootPos)`), before);
  await transition(`JSON.stringify(Array.from(window.__cozyclay.motion.rootPos)) === ${JSON.stringify(JSON.stringify(before))}`, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true}))`);
  console.log('PASS browser motion: real trail drag and one keyboard undo restore the take arrays');
  await transition(`document.querySelector('[data-testid="physics-analyse"]') && !document.querySelector('[data-testid="physics-panel"]').closest('[hidden]')`, `document.querySelector('[data-node-id="characterA.rig"] .hierarchy-row').click()`);
  await evaluate(`window.__motionPose = () => { const values=[]; window.__cozyclay.rigA.traverse(bone=>{if(bone.isBone)values.push(...bone.position.toArray(),...bone.quaternion.toArray());}); return values; }`);
  const pose = await evaluate('window.__motionPose()');
  await transition(`!!window.__cozyclay.physics.preview && !window.__cozyclay.physics.running`, `document.querySelector('[data-testid="physics-analyse"]').click()`);
  assert.equal(await evaluate('window.__cozyclay.ik.keys.size'), 0);
  assert.equal(await evaluate('document.querySelector("[data-testid=physics-apply]").disabled'), false);
  await transition(`window.__cozyclay.ik.keys.size > 0 && !window.__cozyclay.physics.preview`, `document.querySelector('[data-testid="physics-apply"]').click()`);
  await transition(`window.__cozyclay.ik.keys.size === 0 && window.__motionPose().every((n,i)=>Math.abs(n-${JSON.stringify(pose)}[i])<1e-7)`, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true}))`);
  console.log('PASS browser motion: AutoPhysics preview is non-authored; Apply and one undo restore keys and rig');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync('/tmp/448-motion-browser.png', Buffer.from(screenshot.data, 'base64'));
  assert.deepEqual(pageErrors, []);
  console.log('PASS browser motion smoke: no runtime exceptions; screenshot /tmp/448-motion-browser.png');
} catch (error) {
  if (sessionId) { const screenshot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync('/tmp/448-motion-browser-failure.png', Buffer.from(screenshot.data, 'base64')); }
  throw error;
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill('SIGTERM'); await bounded(exited, 'Chrome cleanup'); }
  await server.close(); rmSync(profile, { recursive: true, force: true });
}
