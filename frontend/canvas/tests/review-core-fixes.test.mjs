// 审查修复回归：F1 跨标签 CAS 写冲突与恢复、F2 版本恢复外部稿检测/快照、
// F3 批量启动首次落盘失败完整回滚、F4 同一 run 双端 resume 驱动互斥、
// F5 项目模板实例化身份/blob/导演台 KV 隔离、F7 导出密钥字段扫描口径统一、
// F8 导入连线校验（自环/端口类型/重复，合法扇入与缺失素材占位保留）。
// 全部内存 fake + 模拟执行器，无网络、无真实密钥。本文件由主控应用后独立运行验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/storage.js';
import { createStore } from '../src/store.js';
import { createProjectHub } from '../src/project-hub.js';
import { createWorkflow } from '../src/workflow.js';
import * as keys from '../src/keyvault.js';

const wfStub = (store, storage, over = {}) => ({
  store, storage, pollMs: 1, submitLock: async (n, f) => f(),
  runner: {
    async adoptDurable() { return false; }, async submit() {}, async recOf() { return null; },
    async download() { return true; }, async detach() { return true; },
    wired() { return { items: [], problems: [] }; },
  },
  generators: { quote: () => 0, generate: async node => { node.data.resultText = 'x'; node.data.operation = { state: 'completed' }; } },
  ...over,
});

test('F1：双标签写冲突——后写方被拒、前稿不被吞、被拒稿可另存副本并载入外部稿', async () => {
  const storage = createMemoryStorage();
  const A = createStore(storage), B = createStore(storage);
  await A.newProject('共享');
  const pid = A.project.id;
  await B.openProject(pid);
  A.addNode('note', 0, 0, { text: 'A的节点' });
  await A.flush();
  B.addNode('note', 0, 0, { text: 'B的节点' });
  await assert.rejects(B.flush(), /其他标签页|rev_conflict/);
  const c = B.getConflict(pid);
  assert.ok(c && c.blocking, '冲突应以结构化状态暴露给 UI');
  const doc = await storage.get(`project:${pid}`);
  assert.ok(doc.nodes.some(n => n.data.text === 'A的节点'), '先写方内容不被覆盖');
  assert.ok(!doc.nodes.some(n => n.data.text === 'B的节点'), '被拒写方不得静默盖过');
  const r = await B.resolveConflict(pid, 'saveCopy');
  assert.ok(r.copyId);
  const copyDoc = await storage.get(`project:${r.copyId}`);
  assert.ok(copyDoc.nodes.some(n => n.data.text === 'B的节点'), '被拒本地稿另存为独立项目');
  assert.equal(B.project.id, pid);
  assert.ok(B.project.nodes.some(n => n.data.text === 'A的节点'), '当前项目载入外部较新稿');
  B.touch(); await B.flush();   // 解除阻塞后正常保存恢复
});

test('F1：他标签页的回收站/重命名不被本窗口自动保存吞掉', async () => {
  const storage = createMemoryStorage();
  const A = createStore(storage), B = createStore(storage);
  await A.newProject('目标');
  const pid = A.project.id;
  await B.trashProject(pid);            // B 未打开该项目：CAS 读改写
  A.addNode('note', 0, 0, { text: 'A的编辑' });
  await assert.rejects(A.flush(), /其他标签页|rev_conflict/);
  const doc = await storage.get(`project:${pid}`);
  assert.equal(doc.trashed, true, '回收站标记不被 persist 吞掉');
  assert.ok(!doc.nodes.some(n => n.data.text === 'A的编辑'), '被拒的本地修改未覆盖存储');
  await B.untrashProject(pid);
  await B.renameProject(pid, '新名字');
  const doc2 = await storage.get(`project:${pid}`);
  assert.equal(doc2.name, '新名字');
  assert.equal(doc2.trashed, undefined);
});

test('F2：恢复版本先于 flush 检测外部稿——自动快照保存较新存储稿', async () => {
  const storage = createMemoryStorage();
  const A = createStore(storage), B = createStore(storage);
  await A.newProject('原名');
  const pid = A.project.id;
  const hubA = createProjectHub({ store: A, storage });
  const v = await hubA.saveVersion('v1');
  await B.openProject(pid);
  B.project.name = 'B改名';
  await B.flush();
  const r = await hubA.restoreVersion(v.id);
  assert.equal(r.externalChanges, true, '外部写入必须被检出而非恒 false');
  const versions = await hubA.listVersions(pid);
  const snaps = [];
  for (const sv of versions.filter(x => x.name.includes('自动快照')))
    snaps.push(await storage.get(`version:${pid}:${sv.id}`));
  assert.ok(snaps.some(s => s.doc.name === 'B改名'), '自动快照须包含外部较新稿内容');
  assert.equal(A.project.name, '原名', '随后按用户显式意图恢复到版本内容');
});

test('F3：批量启动首次落盘失败——克隆节点/边完整回滚，原工程不动', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('wf3');
  const rawIfRev = storage.setIfRev, rawSet = storage.set;
  const shouldFail = (k, v) => String(k).startsWith('project:') && String(JSON.stringify(v)).includes('"workflow"');
  storage.setIfRev = async (k, e, v) => { if (shouldFail(k, v)) throw new Error('模拟落盘失败'); return rawIfRev(k, e, v); };
  storage.set = async (k, v) => { if (shouldFail(k, v)) throw new Error('模拟落盘失败'); return rawSet(k, v); };
  const wf = createWorkflow(wfStub(store, storage));
  const a = store.addNode('text', 0, 0, { text: '你好{{角色}}' });
  const b = store.addNode('text', 0, 0, { text: '再见{{角色}}' });
  store.addEdge(a.id, 'out', b.id, 'prompt', 'text');
  const n0 = store.project.nodes.length, e0 = store.project.edges.length;
  await assert.rejects(wf.start({ targets: [b.id], rows: [{ 角色: '甲' }, { 角色: '乙' }], confirmed: true }), /落盘失败/);
  assert.equal(store.project.nodes.length, n0, '克隆节点完整回滚');
  assert.equal(store.project.edges.length, e0, '克隆连线完整回滚');
  assert.ok(!store.project.nodes.some(x => x.data?.batch), '不带 batch 孤儿节点');
  assert.equal(store.project.studio?.workflow ?? null, null, '未建成的运行不得残留');
});

test('F4：同一 paused run 两端同时 resume——只有一个驱动器接管', async t => {
  const storage = createMemoryStorage();
  const A = createStore(storage), B = createStore(storage);
  await A.newProject('wf4');
  const pid = A.project.id;
  await keys.setKey('mock-f4-key');
  t.after(() => keys.clearKey());
  const n = A.addNode('text', 0, 0, { model: 'm-x', text: 'hi' });
  A.project.studio = { version: 1, groups: [], shots: [], timeline: [], workflow: {
    id: 'run-1', projectId: pid, keyFp: keys.getFingerprint(), status: 'paused', driverId: 'drv-old',
    createdAt: 1, updatedAt: 1, budgetYuan: null, estimatedYuan: 1, estimatedSpendYuan: 0, spentYuan: 0,
    priceKind: 'standard', estimateVersion: 'cap-unset', originalAssetIds: [],
    inputByNode: { [n.id]: JSON.stringify({ type: n.type, data: n.data, edges: [], assets: [] }) },
    targets: [n.id], issues: [], cursor: { row: 0 },
    rows: [{ id: 'row-1', index: 0, fields: {}, status: 'pending', nodeIds: [n.id], error: null }],
    nodes: { [n.id]: { src: n.id, type: 'text', status: 'pending', cost: null, taskId: null, pendingKey: null, reason: null, error: null } },
  }};
  await A.flush();
  await B.openProject(pid);
  const calls = { a: 0, b: 0 };
  const gen = which => ({ quote: () => 1, generate: async node => { calls[which]++; node.data.resultText = 'ok'; node.data.operation = { state: 'completed' }; } });
  const runnerStub = { async adoptDurable() { return false; }, async submit() {}, async recOf() { return null; }, async download() { return true; }, async detach() { return true; }, wired() { return { items: [], problems: [] }; } };
  // lockForce:'local' → 同 realm 共享队列锁，两个 workflow 实例互斥
  const wfA = createWorkflow({ store: A, storage, pollMs: 1, lockForce: 'local', runner: runnerStub, generators: gen('a') });
  const wfB = createWorkflow({ store: B, storage, pollMs: 1, lockForce: 'local', runner: runnerStub, generators: gen('b') });
  await Promise.allSettled([wfA.resume(), wfB.resume()]);
  assert.equal(calls.a + calls.b, 1, '同一 run 的付费节点只被一个驱动器执行');
});

test('F5：项目模板实例化——节点/素材全换身份、blob 克隆、导演台 KV 重键，源项目不动', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('源');
  const srcPid = store.project.id;
  store.project.assets['a1'] = { id: 'a1', name: '图.png', kind: 'image', mime: 'image/png', size: 3, addedAt: 1 };
  await storage.setBlob('blob:a1', new Blob(['PNG'], { type: 'image/png' }));
  const an = store.addNode('asset', 0, 0, { assetId: 'a1' });
  const g = store.addNode('gen', 0, 0, { draft: { model: 'm', intent: 'text', prompt: 'x', seconds: 5, ratio: '16:9', switches: {}, bindings: { 'image:1': 'a1' } }, perModel: {} });
  const d = store.addNode('director', 0, 0, {});
  await storage.set(`dir:${d.id}:scene`, { bg: 'xp-asset://a1' });
  const hub = createProjectHub({ store, storage });
  const tpl = await hub.saveTemplate('带图模板', { kind: 'project' });
  await hub.applyTemplate(tpl.id);
  const p = store.project;
  assert.notEqual(p.id, srcPid);
  const an2 = p.nodes.find(n => n.type === 'asset');
  assert.notEqual(an2.id, an.id, '节点换新 id');
  assert.notEqual(an2.data.assetId, 'a1', '素材换新 id，不共享全局 blob 键');
  const g2 = p.nodes.find(n => n.type === 'gen');
  assert.equal(g2.data.draft.bindings['image:1'], an2.data.assetId, '草稿绑定重映射');
  assert.equal(await (await storage.getBlob(`blob:${an2.data.assetId}`)).text(), 'PNG', 'blob 克隆到新键');
  const d2 = p.nodes.find(n => n.type === 'director');
  assert.equal((await storage.get(`dir:${d2.id}:scene`)).bg, `xp-asset://${an2.data.assetId}`, '导演台 KV 重键且令牌换绑');
  await storage.setBlob(`blob:${an2.data.assetId}`, new Blob(['NEW'], { type: 'image/png' }));
  assert.equal(await (await storage.getBlob('blob:a1')).text(), 'PNG', '写副本 blob 不影响源素材');
  assert.equal((await storage.get(`project:${srcPid}`)).nodes.find(x => x.type === 'asset').data.assetId, 'a1', '源项目文档不动');
});

test('F7：当前项目导出与其他项目导出同一密钥字段扫描口径', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('sec');
  const d = store.addNode('director', 0, 0, {});
  await storage.set(`dir:${d.id}:cfg`, { apiKey: 'fake-test-key-not-real' });
  const hub = createProjectHub({ store, storage });
  await assert.rejects(() => store.exportJSON(), /疑似密钥/);
  await assert.rejects(() => hub.exportProject(), /疑似密钥|导出被阻止/);
  await assert.rejects(() => hub.exportProject(store.project.id), /疑似密钥|导出被阻止/);
});

test('F8：导入拒绝自环/端口类型错配/重复连线，合法扇入与缺失素材占位保留', async () => {
  const storage = createMemoryStorage();
  const store = createStore(storage);
  await store.newProject('src');
  const t1 = store.addNode('text', 0, 0, { text: 'a' });
  const t2 = store.addNode('text', 0, 0, { text: 'b' });
  const g = store.addNode('image', 0, 0, { model: 'm', prompt: 'p' });
  const good = JSON.parse(await store.exportJSON());
  const variant = edges => { const v = JSON.parse(JSON.stringify(good)); v.project.edges = edges; return JSON.stringify(v); };
  // text.out(text) → image.refs(image)：类型错配
  await assert.rejects(createStore(storage).importJSON(variant([
    { id: 'e1', from: { node: t1.id, port: 'out' }, to: { node: g.id, port: 'refs' }, order: 0 }])), /不兼容|端口/);
  // 自环
  await assert.rejects(createStore(storage).importJSON(variant([
    { id: 'e1', from: { node: t1.id, port: 'out' }, to: { node: t1.id, port: 'prompt' }, order: 0 }])), /自环/);
  // 重复连线（同 to.port 同 from.node，仅 order 不同）
  await assert.rejects(createStore(storage).importJSON(variant([
    { id: 'e1', from: { node: t1.id, port: 'out' }, to: { node: g.id, port: 'prompt' }, order: 0 },
    { id: 'e2', from: { node: t1.id, port: 'out' }, to: { node: g.id, port: 'prompt' }, order: 1 }])), /重复/);
  // 合法扇入：两个 text 节点同入 image.prompt
  const ok = await createStore(storage).importJSON(variant([
    { id: 'e1', from: { node: t1.id, port: 'out' }, to: { node: g.id, port: 'prompt' }, order: 0 },
    { id: 'e2', from: { node: t2.id, port: 'out' }, to: { node: g.id, port: 'prompt' }, order: 1 }]));
  assert.equal(ok.edges.length, 2, '合法扇入保留');
  // 缺失素材的媒体连线：可重绑占位放行（不丢线，运行时显式报缺）
  const withAsset = JSON.parse(JSON.stringify(good));
  withAsset.project.nodes.push({ id: 'an-x', type: 'asset', x: 0, y: 0, data: { assetId: 'ghost-a' } });
  withAsset.project.edges = [{ id: 'e9', from: { node: 'an-x', port: 'out' }, to: { node: g.id, port: 'refs' }, order: 0 }];
  const imported = await createStore(storage).importJSON(JSON.stringify(withAsset));
  assert.equal(imported.edges.length, 1, '缺失素材占位连线不被误拒');
});
