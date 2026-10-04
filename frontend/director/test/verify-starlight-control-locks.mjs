// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual shipped component handlers/native control attributes, with only React
// scheduling replaced. This CPU fixture is not native focus or browser evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom', plugins: [{
    name: 'actual-control-react-scheduling', enforce: 'pre', load(id) {
      if (/\/integration\/(camera|motion|proposal)-controls\.jsx$/.test(id)) return readFileSync(id, 'utf8')
        .replace(/import \{[^}]+\} from 'react';/, 'const useState = (...args) => globalThis.__controlHooks.useState(...args), useRef = (...args) => globalThis.__controlHooks.useRef(...args), useEffect = (...args) => globalThis.__controlHooks.useEffect(...args);');
    },
  }] });
let CameraControls, MotionControls, ProposalControls;
try {
  ({ CameraControls } = await server.ssrLoadModule('/integration/camera-controls.jsx'));
  ({ MotionControls } = await server.ssrLoadModule('/integration/motion-controls.jsx'));
  ({ ProposalControls } = await server.ssrLoadModule('/integration/proposal-controls.jsx'));
} finally { await server.close(); }

function fixture(Component, extra = {}) {
  const previous = globalThis.__controlHooks, cells = [], effects = [], cleanups = [], calls = [], resolutions = [], announcements = [];
  let cursor = 0, tree, disabled = false, hold = null;
  const cell = initial => { const index = cursor++; if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial }; return cells[index]; };
  globalThis.__controlHooks = {
    useState(initial) { const state = cell(initial); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
    useRef(initial) { return cell(() => ({ current: initial })).value; },
    useEffect(fn, deps) { const state = cell(null); if (!state.value || deps.some((value, index) => !Object.is(value, state.value[index]))) { state.value = deps; effects.push(fn); } },
  };
  const context = { live: { state: { activeCharacterId: 'actor-a', activeShotId: 'shot-a', timeline: { fps: 24, frameCount: 150 }, shots: [] } },
    bus: { async run(id, args) { calls.push({ id, args }); if (hold && id === hold.id) return hold.promise; return { ok: true }; } } };
  const ports = { outputResolution: 720, setOutputResolution(value) { resolutions.push(value); ports.outputResolution = value; },
    shotsDomain: { authoringDocument: () => ({ cameraLibrary: { activeCameraId: 'camera-a', cameras: [{ id: 'camera-a', name: 'A' }] } }), state: () => ({ camera: {} }) } };
  const render = () => { cursor = 0; tree = Component({ context, ports, disabled, announce: (...args) => announcements.push(args), ...extra });
    for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } return tree; };
  const walk = (value, out = [], inheritedDisabled = false, inHeader = false) => {
    if (Array.isArray(value)) { for (const item of value) walk(item, out, inheritedDisabled, inHeader); return out; }
    if (!value?.props) return out;
    const nativeDisabled = inheritedDisabled || !!value.props.disabled;
    out.push({ element: value, disabled: nativeDisabled, inHeader });
    walk(value.props.children, out, inheritedDisabled || (value.type === 'fieldset' && !!value.props.disabled), inHeader || value.type === 'header'); return out;
  };
  const nodes = () => walk(tree), find = predicate => { const found = nodes().find(predicate); assert.ok(found, 'actual component control exists'); return found.element; };
  render();
  return { context, ports, calls, resolutions, announcements, render,
    nodes, markup: () => renderToStaticMarkup(tree),
    byId: id => find(node => node.element.props['data-testid'] === id),
    byText: text => find(node => node.element.type === 'button' && node.element.props.children === text),
    open() { const result = find(node => node.element.type === 'button').props.onClick(); render(); return result; },
    disable(value = true) { disabled = value; render(); },
    authorControls() { return nodes().filter(node => ['button', 'select', 'input', 'textarea'].includes(node.element.type)
      && !node.inHeader && !String(node.element.props['data-testid'] ?? '').startsWith('hosted-director-')); },
    hold(id) { hold = { ...deferred(), id }; return hold; },
    unmount() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); },
    dispose() { this.unmount(); if (previous === undefined) delete globalThis.__controlHooks; else globalThis.__controlHooks = previous; },
  };
}

test('already open camera/motion panels natively disable every author control and keep close enabled', () => {
  for (const Component of [CameraControls, MotionControls]) {
    const f = fixture(Component);
    try {
      f.open(); const before = f.authorControls(); assert.ok(before.length >= 5); assert.ok(before.some(node => !node.disabled));
      f.disable(); assert.ok(f.authorControls().every(node => node.disabled), 'all native author inputs/actions are disabled');
      assert.equal(f.nodes().find(node => node.inHeader && node.element.type === 'button').disabled, false);
      f.byText('关闭').props.onClick(); f.render(); assert.doesNotMatch(f.markup(), /<section/);
    } finally { f.dispose(); }
  }
});

test('queued camera action and old resolution/focus handlers cannot mutate after output locks the panel', async () => {
  const f = fixture(CameraControls);
  try {
    f.open(); const resolution = f.byId('director-resolution'), focus = f.nodes().find(node => node.element.props.onBlur)?.element;
    const queued = f.byId('director-apply-duration').props.onClick(); f.disable();
    resolution.props.onChange({ target: { value: '1080' } }); focus.props.onBlur({ target: { value: '5' } });
    await queued; await turn(); assert.deepEqual(f.resolutions, []); assert.deepEqual(f.calls, []);
  } finally { f.dispose(); }
});

test('camera command pending state locks parameters and actions but closing remains possible', async () => {
  const f = fixture(CameraControls);
  try {
    f.open(); const hold = f.hold('shot.setDuration'), pending = f.byId('director-apply-duration').props.onClick(); await turn(); f.render();
    assert.equal(f.calls.length, 1); assert.ok(f.authorControls().every(node => node.disabled));
    assert.equal(f.nodes().find(node => node.inHeader && node.element.type === 'button').disabled, false);
    hold.resolve({ ok: true }); await pending; f.render(); assert.ok(f.authorControls().every(node => !node.disabled));
    f.byId('director-resolution').props.onChange({ target: { value: '1080' } }); assert.deepEqual(f.resolutions, [1080]);
  } finally { f.dispose(); }
});

test('motion file read is busy from selection and cannot submit after a later output lock', async () => {
  for (const binary of [false, true]) {
    const f = fixture(MotionControls), read = deferred();
    try {
      f.open(); const file = { name: binary ? 'motion.npz' : 'motion.bvh', size: 12,
        text: () => read.promise, arrayBuffer: () => read.promise };
      f.byId('motion-import-file').props.onChange({ target: { files: [file], value: 'selected' } }); f.render();
      assert.ok(f.authorControls().every(node => node.disabled), 'the read, not only bus submission, owns busy state');
      assert.equal(f.nodes().find(node => node.inHeader && node.element.type === 'button').disabled, false);
      f.disable(); read.resolve(binary ? new Uint8Array([1, 2, 3]).buffer : 'HIERARCHY'); await turn(); await turn(); f.render();
      assert.deepEqual(f.calls, [], 'late read cannot submit an author command during output');
      assert.match(f.announcements.flat().join(' '), /暂停|繁忙|导出/);
    } finally { read.resolve(binary ? new Uint8Array([1]).buffer : ''); await turn(); f.dispose(); }
  }
});

test('old motion input and preset handlers cannot submit while disabled, or after component cleanup', async () => {
  const f = fixture(MotionControls); let reads = 0;
  try {
    f.open(); const input = f.byId('motion-import-file'), preset = f.byId('motion-apply-preset'); f.disable();
    input.props.onChange({ target: { files: [{ name: 'a.bvh', size: 1, text: async () => { reads++; return ''; } }], value: 'a' } });
    preset.props.onClick(); await turn(); assert.equal(reads, 0); assert.deepEqual(f.calls, []);
    f.disable(false); const read = deferred();
    f.byId('motion-import-file').props.onChange({ target: { files: [{ name: 'a.bvh', size: 1, text: () => read.promise }], value: 'a' } });
    f.unmount(); read.resolve('HIERARCHY'); await turn(); await turn(); assert.deepEqual(f.calls, []);
  } finally { f.dispose(); }
});

test('a file spanning a completed output lock is refused rather than applying later to a different selection', async () => {
  const f = fixture(MotionControls), read = deferred();
  try {
    f.open(); f.byId('motion-import-file').props.onChange({ target: { files: [{ name: 'a.bvh', size: 12, text: () => read.promise }], value: 'a' } });
    f.disable(); f.disable(false); f.context.live.state.activeCharacterId = 'actor-b';
    read.resolve('HIERARCHY'); await turn(); await turn(); f.render();
    assert.deepEqual(f.calls, []); assert.match(f.markup(), /重新导入/);
  } finally { read.resolve(''); await turn(); f.dispose(); }
});

test('an enabled file keeps its selected character, fps and conversion inputs while read completes', async () => {
  const f = fixture(MotionControls), read = deferred();
  try {
    f.open(); f.byId('motion-import-file').props.onChange({ target: { files: [{ name: 'a.bvh', size: 12, text: () => read.promise }], value: 'a' } });
    f.render(); f.context.live.state.activeCharacterId = 'actor-b'; f.context.live.state.timeline.fps = 30;
    f.byText('关闭').props.onClick(); f.render(); read.resolve('HIERARCHY'); await turn(); await turn();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].id, 'motion.importAnimation');
    assert.deepEqual(f.calls[0].args, { characterId: 'actor-a', format: 'bvh', fps: 24, sourceUp: 'Y', unitScale: 1, source: 'HIERARCHY', encoding: 'text' });
  } finally { read.resolve(''); await turn(); f.dispose(); }
});

test('enabled motion preset retains its real job await and busy lock, then unlocks on completion', async () => {
  const f = fixture(MotionControls);
  try {
    f.open(); const start = f.hold('motion.applyPreset'); f.byId('motion-apply-preset').props.onClick(); await turn(); f.render();
    assert.ok(f.authorControls().every(node => node.disabled));
    start.resolve({ ok: true, status: 'started', jobId: 'actual-job' }); await turn(); await turn(); f.render();
    assert.deepEqual(f.calls.map(row => row.id), ['motion.applyPreset', 'job.await']);
    assert.deepEqual(f.calls[1].args, { jobId: 'actual-job', timeoutMs: 120000 });
    assert.ok(f.authorControls().every(node => !node.disabled)); assert.match(f.markup(), /动作已应用/);
  } finally { f.dispose(); }
});

function proposalFixture() {
  const requests = [], previewStates = [], transactions = [], persistence = [], holds = new Map(); let f;
  let documentEpoch = 1, mutateAfterPersist = false, contextReads = 0, savedChecks = 0;
  const proposal = { proposalId: 'proposal-1', reply: '提案', rawText: '{}', commands: [{ id: 'character.addWaypoint', args: { characterId: 'actor-a', frame: 0, position: { x: 1, z: 2 } } }] };
  const quote = { quoteId: 'quote-1', canRequest: true, price: { label: '测试报价' } };
  f = fixture(ProposalControls, {
    session: { textModels: [{ id: 'verified-text-model' }], client: { async request(method, args) { requests.push({ method, args });
      if (holds.has(method)) await holds.get(method).promise;
      if (method === 'proposal.quote') return quote;
      if (method === 'proposal.request') return proposal;
      return { proposal, canApply: true }; } } },
    async persist() {
      persistence.push(true); const savedEpoch = documentEpoch;
      if (holds.has('persist')) await holds.get('persist').promise;
      if (mutateAfterPersist) { mutateAfterPersist = false; queueMicrotask(() => { documentEpoch++; }); }
      return { record: { rev: 3 }, check() { savedChecks++; if (documentEpoch !== savedEpoch) throw new Error('saved_content_changed: 工程已有新修改'); } };
    },
    getContext: () => { contextReads++; return { selectedCharacterId: `actor-document-${documentEpoch}` }; }, checkpoint: () => 'actual-checkpoint',
    appContext: { bus: { beginPreview(commands) { const transaction = { commands, applied: 0, discarded: 0,
      apply() { this.applied++; }, discard() { this.discarded++; } }; transactions.push(transaction); return transaction; } } },
    onPreviewState(value) { previewStates.push(value); f.disable(value); },
  });
  return Object.assign(f, { requests, previewStates, transactions, persistence, quote,
    replaceDocument() { documentEpoch++; }, mutateAfterPersistReturn() { mutateAfterPersist = true; },
    contextReads: () => contextReads, savedChecks: () => savedChecks,
    holdRequest(method) { const value = deferred(); holds.set(method, value); return value; },
    instruction(value) { f.nodes().find(node => node.element.type === 'textarea').element.props.onChange({ target: { value } }); f.render(); },
  });
}

test('open proposal fields and quote/request/preview/discard callbacks obey an external busy lock', async () => {
  const f = proposalFixture();
  try {
    await f.open(); f.render(); f.instruction('保持人物'); const discard = f.byText('放弃提案');
    await f.byId('proposal-quote').props.onClick(); f.render();
    f.nodes().find(node => node.element.type === 'input').element.props.onChange({ target: { checked: true } }); f.render();
    const controls = [f.byId('proposal-quote'), f.byId('proposal-request'), discard];
    // Quote clears the old proposal; restore it through the actual opener/status.
    await f.byId('hosted-director-proposals').props.onClick(); f.render(); await f.open(); f.render();
    controls.push(f.byId('proposal-preview'));
    f.disable(); const count = f.requests.length;
    assert.ok(f.authorControls().every(node => node.disabled));
    for (const control of controls) await control.props.onClick();
    assert.equal(f.requests.length, count); assert.equal(f.transactions.length, 0);
    f.byText('关闭').props.onClick(); f.render();
    assert.deepEqual(f.previewStates, [], 'closing an ordinary panel cannot clear another owner output busy state');
  } finally { f.dispose(); }
});

test('persistCurrent continuation checks the saved document before reading context or sending a quote', async () => {
  const f = proposalFixture();
  try {
    await f.open(); f.render(); f.instruction('保持人物');
    const before = f.contextReads(); f.mutateAfterPersistReturn();
    await f.byId('proposal-quote').props.onClick(); f.render();
    assert.equal(f.contextReads(), before, 'do not combine an old saved revision and a new document context');
    assert.equal(f.requests.filter(row => row.method === 'proposal.quote').length, 0);
    assert.match(f.markup(), /saved_content_changed/);
  } finally { f.dispose(); }
});

test('late host status or quote is not installed after the saved document fence fails', async () => {
  for (const method of ['proposal.status', 'proposal.quote']) {
    const f = proposalFixture();
    try {
      let pending;
      if (method === 'proposal.status') { const hold = f.holdRequest(method); pending = f.open(); await turn(); f.replaceDocument(); hold.resolve(); }
      else {
        await f.open(); f.render(); f.instruction('原始要求'); const hold = f.holdRequest(method);
        pending = f.byId('proposal-quote').props.onClick(); await turn(); f.replaceDocument(); hold.resolve();
      }
      await pending; f.render();
      assert.match(f.markup(), /saved_content_changed/);
      if (method === 'proposal.status') assert.equal(f.nodes().some(node => node.element.props['data-testid'] === 'proposal-preview'), false);
      else assert.equal(f.nodes().some(node => node.element.props['data-testid'] === 'proposal-request'), false);
      assert.equal(f.transactions.length, 0); assert.equal(f.requests.filter(row => row.method === 'proposal.request').length, 0);
    } finally { f.dispose(); }
  }
});

test('positive proposal persistence contract carries revision 3 and rechecks before accepting host results', async () => {
  const f = proposalFixture();
  try {
    await f.open(); f.render(); f.instruction('保持人物'); await f.byId('proposal-quote').props.onClick(); f.render();
    assert.equal(f.requests[0].args.sceneRevision, 3); assert.equal(f.requests[1].args.sceneRevision, 3);
    assert.ok(f.savedChecks() >= 4, 'both prepare continuations and both host results recheck the same saved fence');
    assert.match(f.markup(), /测试报价/);
  } finally { f.dispose(); }
});

test('pending quote locks native fields and stale field handlers without issuing any model request', async () => {
  const f = proposalFixture();
  try {
    await f.open(); f.render(); f.instruction('原始要求');
    const textarea = f.nodes().find(node => node.element.type === 'textarea').element, hold = f.holdRequest('proposal.quote');
    const pending = f.byId('proposal-quote').props.onClick(); await turn(); f.render();
    assert.ok(f.authorControls().every(node => node.disabled));
    textarea.props.onChange({ target: { value: '中途新要求' } }); f.render(); assert.match(f.markup(), /原始要求/); assert.doesNotMatch(f.markup(), /中途新要求/);
    hold.resolve(); await pending; f.render(); assert.equal(f.requests.filter(row => row.method === 'proposal.request').length, 0);
  } finally { f.dispose(); }
});

test('proposal preview prepared before an external lock cannot begin a late scene transaction', async () => {
  const f = proposalFixture();
  try {
    await f.open(); f.render(); const hold = f.holdRequest('persist'), pending = f.byId('proposal-preview').props.onClick();
    await turn(); f.disable(); hold.resolve(); await pending; f.render();
    assert.equal(f.transactions.length, 0); assert.deepEqual(f.previewStates, []);
  } finally { f.dispose(); }
});

test('an owned preview keeps apply/discard/close usable under its own parent busy lock', async () => {
  for (const exit of ['proposal-apply', 'proposal-discard-preview', '关闭']) {
    const f = proposalFixture();
    try {
      await f.open(); f.render(); await f.byId('proposal-preview').props.onClick(); f.render();
      assert.deepEqual(f.previewStates, [true]); assert.equal(f.transactions.length, 1);
      const control = exit === '关闭' ? f.byText(exit) : f.byId(exit);
      assert.equal(f.nodes().find(node => node.element === control).disabled, false);
      await control.props.onClick(); f.render();
      assert.deepEqual(f.previewStates, [true, false]);
      assert.equal(f.transactions[0].applied, exit === 'proposal-apply' ? 1 : 0);
      assert.equal(f.transactions[0].discarded, exit === 'proposal-apply' ? 0 : 1);
      assert.equal(f.requests.filter(row => row.method === 'proposal.request').length, 0, 'UI lifecycle does not generate another paid proposal');
    } finally { f.dispose(); }
  }
});
