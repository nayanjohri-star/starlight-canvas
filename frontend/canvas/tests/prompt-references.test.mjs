import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../src/store.js';
import { createMemoryStorage } from '../src/storage.js';
import { createEditor } from '../src/editor.js';
import { setCapabilities, wiredOutputs, resolvePromptRefs } from '../src/capabilities.js';
import { mentionAt, referenceChoices, referencePresentation, attachPromptReference, replacePromptReference } from '../src/prompt-references.js';
setCapabilities(JSON.parse(readFileSync(new URL('../../../docs/星盘AI_视频模型能力表.json', import.meta.url), 'utf8')));
async function fixture(type = 'gen') {
  const store = createStore(createMemoryStorage()); await store.newProject('references');
  const node = store.addNode(type, 400, 100, type === 'gen' ? { draft: { model: 'minimax-h3-768p-full-slow', intent: 'text', prompt: '', seconds: 5, ratio: '16:9' } } : { prompt: '' });
  for (const [id, kind] of [['a', 'image'], ['b', 'image'], ['v', 'video']]) store.project.assets[id] = { id, kind, name: `${id}.${kind}`, mime: kind === 'image' ? 'image/png' : 'video/mp4', size: 100 };
  return { store, node, assets: { blobOf: async () => new Blob(['fixture']) } };
}
test('@ search follows the caret and excludes missing media', () => {
  assert.deepEqual(mentionAt('镜头参考 @视频', 8), { start: 5, end: 8, query: '视频' });
  assert.equal(mentionAt('ordinary text', 13), null);
  assert.deepEqual(referenceChoices({ assets: { a: { id: 'a', name: '角色', kind: 'image' }, b: { id: 'b', name: '角色', kind: 'video', missing: true } } }, { query: '角色' }).map(a => a.id), ['a']);
});

test('canvas references hide library history without deleting assets or merging distinct same-name images', () => {
  const project = { nodes: [{ id: 'n1', type: 'image', data: { title: '机甲远景', resultAssetId: 'new' } },
    { id: 'n2', type: 'asset', data: { assetId: 'upload' } }], assets: {
    old: { id: 'old', name: '生成图-图片生成-musj7gn.png', kind: 'image', category: 'gen', addedAt: 1000 },
    new: { id: 'new', name: '生成图-图片生成-musj7gn.png', kind: 'image', category: 'gen', addedAt: 3000 },
    upload: { id: 'upload', name: '机甲参考.png', kind: 'image', addedAt: 2000 },
  } };
  const before = JSON.stringify(project);
  assert.deepEqual(referenceChoices(project, { scope: 'canvas' }).map(a => a.id), ['new', 'upload']);
  assert.deepEqual(referenceChoices(project).map(a => a.id), ['new', 'upload', 'old']);
  assert.match(referencePresentation(project, project.assets.new).detail, /节点 1 · 机甲远景 · 当前结果/);
  assert.equal(referencePresentation(project, project.assets.new).title, '图片生成');
  assert.match(referencePresentation(project, project.assets.old).detail, /素材库/);
  assert.equal(referenceChoices(project, { query: '机甲远景' })[0].id, 'new');
  assert.equal(JSON.stringify(project), before);
});

test('connecting a generator reads only its output, and an alias of the same result is submitted once', async () => {
  const f = await fixture('image');
  await attachPromptReference({ ...f, assetId: 'a' });
  f.node.data.resultAssetId = 'b'; f.node.data.outputAssetIds = ['b'];
  const target = f.store.addNode('image', 800, 100, { prompt: '' });
  f.store.addEdge(f.node.id, 'out', target.id, 'refs', 'image');
  const alias = f.store.addNode('asset', 0, 0, { assetId: 'b' });
  f.store.addEdge(alias.id, 'out', target.id, 'refs', 'image');
  assert.deepEqual(wiredOutputs(f.store, target.id, 'refs').items.map(a => a.id), ['b']);
});

test('replace keeps @ identity and prompt, changes only this node reference, and supports undo', async () => {
  const f = await fixture('image');
  f.editor = createEditor(f.store);
  f.node.data.prompt = await attachPromptReference({ ...f, assetId: 'a' });
  const text = f.node.data.prompt;
  await replacePromptReference({ ...f, oldId: 'a', assetId: 'b' });
  assert.equal(f.node.data.prompt, text);
  assert.equal(f.node.data.bindings['image:1'], 'b');
  assert.deepEqual(wiredOutputs(f.store, f.node.id, 'refs').items.map(a => a.id), ['b']);
  assert.ok(f.store.project.assets.a);
  await assert.rejects(replacePromptReference({ ...f, oldId: 'b', assetId: 'v' }), /同类型/);
  f.editor.undo();
  assert.deepEqual(wiredOutputs(f.store, f.node.id, 'refs').items.map(a => a.id), ['a']);
});
test('pick image/video creates real graph references and switches text mode without generation', async () => {
  const f = await fixture(); const text = await attachPromptReference({ ...f, assetId: 'a' });
  assert.equal(text, '@图片1'); assert.equal(f.node.data.draft.intent, 'refs');
  f.node.data.draft.prompt = text;
  assert.equal(await attachPromptReference({ ...f, assetId: 'v' }), '@视频1');
  assert.deepEqual(wiredOutputs(f.store, f.node.id, 'refs').items.map(a => a.id), ['a', 'v']);
  assert.deepEqual(f.node.data.draft.bindings, { 'image:1': 'a', 'video:1': 'v' });
  const edges = f.store.project.edges.length; await attachPromptReference({ ...f, assetId: 'a' }); assert.equal(f.store.project.edges.length, edges);
});
test('deleting an earlier reference never rebinds its mention to a newly chosen image', async () => {
  const f = await fixture(); f.node.data.draft.prompt = await attachPromptReference({ ...f, assetId: 'a' });
  f.store.removeEdge(f.store.edgesInto(f.node.id, 'refs')[0].id);
  const token = await attachPromptReference({ ...f, assetId: 'b' }); assert.equal(token, '@图片2');
  const refs = wiredOutputs(f.store, f.node.id, 'refs').items;
  assert.deepEqual(resolvePromptRefs('@图片1', refs, f.node.data.draft.bindings).missing, ['@图片1']);
  assert.equal(resolvePromptRefs(token, refs, f.node.data.draft.bindings).normalized, '@1');
});
test('image nodes bind multiple references and reject non-image media', async () => {
  const f = await fixture('image'); assert.equal(await attachPromptReference({ ...f, assetId: 'a' }), '@图片1');
  assert.deepEqual(f.node.data.bindings, { 'image:1': 'a' });
  assert.equal(await attachPromptReference({ ...f, assetId: 'b' }), '@图片2');
  assert.deepEqual(f.node.data.bindings, { 'image:1': 'a', 'image:2': 'b' });
  const refs = wiredOutputs(f.store, f.node.id, 'refs').items;
  assert.equal(resolvePromptRefs('@图片1 + @图片2', [...refs].reverse(), f.node.data.bindings).normalized, '@2 + @1');
  await assert.rejects(attachPromptReference({ ...f, assetId: 'v' }), /只能引用图片/);
  for (let i = 3; i <= 8; i++) {
    f.store.project.assets[`a${i}`] = { id: `a${i}`, kind: 'image', name: `图${i}` };
    await attachPromptReference({ ...f, assetId: `a${i}` });
  }
  f.store.project.assets.excess = { id: 'excess', kind: 'image', name: '第九张' };
  await assert.rejects(attachPromptReference({ ...f, assetId: 'excess' }), /8 张/);
});
test('frame modes and unavailable files fail before graph mutation', async () => {
  const f = await fixture(); f.node.data.draft.intent = 'frames';
  await assert.rejects(attachPromptReference({ ...f, assetId: 'a' }), /首尾帧/);
  f.node.data.draft.intent = 'text'; f.assets.blobOf = async () => null;
  await assert.rejects(attachPromptReference({ ...f, assetId: 'a' }), /文件缺失/);
  assert.equal(f.store.project.edges.length, 0); assert.equal(f.store.project.nodes.length, 1);
});
test('switching projects during local media lookup writes no reference into either project', async () => {
  const f = await fixture(), original = f.store.project; let release;
  f.assets.blobOf = () => new Promise(r => { release = r; });
  const pending = attachPromptReference({ ...f, assetId: 'a' }); await f.store.newProject('other'); release(new Blob(['x']));
  await assert.rejects(pending, /项目或节点已切换/); assert.equal(original.edges.length, 0); assert.equal(f.store.project.edges.length, 0);
});
test('closing/rebuilding the picker during lookup does not add a dangling edge', async () => {
  const f = await fixture(); let release, alive = true;
  f.assets.blobOf = () => new Promise(r => { release = r; });
  const pending = attachPromptReference({ ...f, assetId: 'a', canAttach: () => alive }); alive = false; release(new Blob(['x']));
  await assert.rejects(pending, /项目或节点已切换/); assert.equal(f.store.project.edges.length, 0);
});
test('video and image picker bindings survive project export/import with remapped asset IDs', async () => {
  for (const type of ['gen', 'image']) {
    const f = await fixture(type), prompt = await attachPromptReference({ ...f, assetId: 'a' });
    if (type === 'gen') f.node.data.draft.prompt = prompt; else f.node.data.prompt = prompt;
    const exported = await f.store.exportJSON(), other = createStore(createMemoryStorage());
    await other.importJSON(exported);
    const node = other.project.nodes.find(n => n.type === type), source = other.project.nodes.find(n => n.type === 'asset');
    const bindings = type === 'gen' ? node.data.draft.bindings : node.data.bindings;
    assert.equal(bindings['image:1'], source.data.assetId); assert.notEqual(bindings['image:1'], 'a');
    assert.equal(other.project.edges[0].to.node, node.id);
  }
});
