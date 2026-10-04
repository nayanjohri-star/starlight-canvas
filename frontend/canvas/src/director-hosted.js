// SPDX-License-Identifier: AGPL-3.0-or-later
// The same-origin editor is a lifecycle boundary; the parent owns account,
// project persistence, stable assets and generation drafts.
import { el, modal } from './ui.js';
import { uid, containsSecret } from './store.js';
import { fileKind, getModel, intentsFor, modelIds } from './capabilities.js';
import { getAvailableModels, getFingerprint, setAvailableModels, setModelCatalog, isModelUsable } from './keyvault.js';
import { directorEnvelope, matchesDirectorEnvelope, directorDocumentKey, DIRECTOR_DOCUMENT_FORMAT } from './director-protocol.js';
import { createDirectorProposals } from './director-proposals.js';

const MiB = 1024 * 1024;
const LIMITS = { image: 30 * MiB, video: 100 * MiB, file: 100 * MiB };
const SHA = /^[a-f0-9]{64}$/;
const REF = /^xp-asset:\/\/([A-Za-z0-9_-]+)$/;
const EXPORT_RESOLUTIONS = new Set([720, 1080]);
const error = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
  .map(v => v.toString(16).padStart(2, '0')).join('');
const descriptor = a => ({ assetId: a.id, ref: `xp-asset://${a.id}`, sha256: a.sha256,
  mime: a.mime, size: a.size, name: a.name, kind: a.kind, role: a.directorRole ?? null,
  objectId: a.directorObjectId ?? null, sceneRevision: a.directorOutput?.sceneRevision ?? null,
  frameIndex: a.directorOutput?.frameIndex ?? null });
const toBlob = (bytes, mime) => bytes instanceof Blob ? new Blob([bytes], { type: mime || bytes.type })
  : bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes) ? new Blob([bytes], { type: mime }) : null;

export function hostedDirectorURL(scope, baseURI = document.baseURI) {
  const url = new URL('director/index.html', baseURI);
  for (const key of ['sessionId', 'projectId', 'nodeId']) url.searchParams.set(key, scope[key]);
  return url.href;
}

export function createHostedDirectorHost({ store, storage, assets, api, spawnPosition, helloTimeoutMs = 25000 } = {}) {
  const sessions = new Map();
  let disposed = false;
  function live(s) {
    if (disposed || s.closed || sessions.get(s.nodeId) !== s) throw error('session_closed', '导演台会话已关闭');
    storage.assertActive?.();
    if (storage.active === false || storage.epoch !== s.epoch) throw error('identity_changed', '账户已切换，导演台操作已取消');
    if (store.project !== s.project || store.project.id !== s.projectId) throw error('project_changed', '项目已切换，导演台操作已取消');
    if (store.node(s.nodeId) !== s.node || s.node.type !== 'director') throw error('node_removed', '导演台节点已删除');
  }
  async function checked(s, promise) { live(s); const value = await promise; live(s); return value; }
  function addDraftNode(s, type, data) {
    live(s);
    // The real canvas supplies its measured, viewport-aware free-space search.
    // A host without DOM layout still places each new card beyond every existing
    // card's right edge, including cards added earlier in the same draft request.
    const position = typeof spawnPosition === 'function' ? spawnPosition(type) : {
      x: Math.max(s.node.x + 540, ...s.project.nodes.map(node => node.x + 360 + 28)), y: s.node.y,
    };
    live(s);
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y))
      throw error('generation_position_invalid', '画布没有可用的节点落点，请稍后重试');
    return store.addNode(type, position.x, position.y, data);
  }
  async function recordOf(s) {
    const record = await checked(s, storage.get(directorDocumentKey(s.projectId, s.nodeId)));
    if (record == null) return null;
    if (record.format !== DIRECTOR_DOCUMENT_FORMAT || !Number.isSafeInteger(record.rev) || record.rev < 1)
      throw error('document_version_unsupported', '导演工程版本不受支持，原档已保留');
    if (record.projectId !== s.projectId || record.nodeId !== s.nodeId)
      throw error('document_scope_mismatch', '导演工程与当前项目或节点不匹配，原档已保留');
    if (record.scene?.exportResolution !== undefined && !EXPORT_RESOLUTIONS.has(record.scene.exportResolution))
      throw error('document_invalid', '导演工程输出分辨率不受支持，原档已保留');
    return record;
  }
  async function readAsset(s, { assetId, ref, sha256 } = {}, includeBytes = true) {
    live(s);
    const id = assetId ?? (typeof ref === 'string' ? REF.exec(ref)?.[1] : null);
    const a = s.project.assets[id];
    if (!a || a.missing || a.deletedAt) throw error('asset_missing', `导演素材不可用：${id ?? '未指定'}`, { assetId: id });
    const version = { ...a };
    const assertVersion = () => {
      if (s.project.assets[id] !== a || a.missing || a.deletedAt || a.contentRevision !== version.contentRevision ||
        a.sha256 !== version.sha256 || a.size !== version.size || a.mime !== version.mime)
        throw error('asset_changed', '导演素材在读取期间已更改');
    };
    const blob = await checked(s, assets.blobOf(id));
    assertVersion();
    if (!blob || !blob.size) throw error('asset_missing', `导演素材缺少文件：${a.name}`, { assetId: id });
    const digest = await checked(s, hash(blob));
    assertVersion();
    if ((sha256 != null && (!SHA.test(sha256) || sha256 !== digest)) || (a.sha256 && a.sha256 !== digest))
      throw error('asset_digest_mismatch', `导演素材摘要不符：${a.name}`, { assetId: id });
    const result = descriptor({ ...version, sha256: digest });
    if (includeBytes) { result.bytes = await checked(s, blob.arrayBuffer()); assertVersion(); }
    return result;
  }
  async function projectOf(s, record) {
    const root = await readAsset(s, { ref: record.scene.projectRef, sha256: record.scene.projectSha256 });
    try { return JSON.parse(new TextDecoder().decode(root.bytes)); }
    catch { throw error('project_invalid', '导演工程素材不是有效 JSON'); }
  }
  const proposals = createDirectorProposals({ storage, api, assertCurrent: live, recordOf, projectOf });
  async function writeAsset(s, payload, output = false) {
    live(s);
    const mime = typeof payload.mime === 'string' ? payload.mime : '';
    const blob = toBlob(payload.bytes, mime);
    if (!blob || !blob.size) throw error('asset_invalid', '素材必须提供完整非空字节');
    const kind = mime === 'application/json' ? 'file' : fileKind({ type: mime }) ?? 'file';
    if (blob.size > (LIMITS[kind] ?? LIMITS.file)) throw error('asset_too_large', '导演素材超过大小上限');
    if (output && !['image', 'video', 'file'].includes(kind)) throw error('output_invalid', '不支持该导演输出类型');
    const sha256 = await checked(s, hash(blob));
    if (payload.sha256 != null && payload.sha256 !== sha256) throw error('asset_digest_mismatch', '素材字节与所报摘要不一致');
    if (mime === 'application/json') {
      let json; try { json = JSON.parse(await checked(s, blob.text())); } catch (e) {
        live(s); throw error('project_invalid', '导演工程文件不是有效 JSON');
      }
      if (!object(json) || containsSecret(json)) throw error('project_invalid', '导演工程无效或含疑似秘密字段');
    }
    // Content identity is immutable: an autosave of identical bytes reuses its
    // project asset. Never overwrite a blob shared by another document.
    for (const a of Object.values(s.project.assets)) {
      if (!a.missing && a.sha256 === sha256 && a.mime === mime && a.fromDirector === s.nodeId &&
          (a.directorRole ?? null) === (payload.role ?? null) && (a.directorObjectId ?? null) === (payload.objectId ?? null) &&
          (!output || a.directorOutput?.sceneRevision === payload.sceneRevision)) {
        await readAsset(s, { assetId: a.id, sha256 }, false);
        return { a, created: false };
      }
    }
    const metadata = { fromDirector: s.nodeId, category: 'director', sha256,
      directorObjectId: typeof payload.objectId === 'string' ? payload.objectId.slice(0, 128) : null,
      directorRole: typeof payload.role === 'string' ? payload.role.slice(0, 64) : null };
    if (output) metadata.directorOutput = { sceneRevision: payload.sceneRevision,
      shotId: typeof payload.shotId === 'string' ? payload.shotId.slice(0, 128) : null,
      frameIndex: payload.frameIndex ?? null, fps: payload.fps ?? null, frameCount: payload.frameCount ?? null };
    const a = await checked(s, assets.registerBlob(blob, String(payload.name || '导演素材').slice(0, 200), kind,
      metadata, { project: s.project, nodeId: s.nodeId, assertCurrent: () => live(s), stageOnly: output }));
    if (!output) await checked(s, store.flush());
    return { a, created: true };
  }
  async function validateDocument(s, scene, dependencies) {
    if (!object(scene) || typeof scene.projectRef !== 'string' || !REF.test(scene.projectRef) || !SHA.test(scene.projectSha256 ?? ''))
      throw error('document_invalid', '导演工程必须引用完整工程素材及 SHA-256 摘要');
    if (scene.exportResolution !== undefined && !EXPORT_RESOLUTIONS.has(scene.exportResolution))
      throw error('document_invalid', '导演工程输出分辨率须为 720p 或 1080p');
    if (!Array.isArray(dependencies) || dependencies.length > 2000) throw error('document_invalid', '导演工程依赖清单无效');
    const clean = [];
    for (const dep of dependencies) {
      if (!object(dep) || !REF.test(dep.ref ?? '') || !SHA.test(dep.sha256 ?? '')) throw error('document_invalid', '导演依赖引用或摘要无效');
      const id = REF.exec(dep.ref)[1];
      if (dep.assetId != null && dep.assetId !== id) throw error('document_invalid', '导演依赖引用与素材身份不一致');
      const a = await readAsset(s, { assetId: id, sha256: dep.sha256 }, false);
      if (dep.mime != null && dep.mime !== a.mime || dep.size != null && dep.size !== a.size)
        throw error('document_invalid', '导演依赖类型或大小不一致');
      clean.push({ ...descriptor({ id, ...a }), role: typeof dep.role === 'string' ? dep.role.slice(0, 64) : 'asset',
        objectId: typeof dep.objectId === 'string' ? dep.objectId.slice(0, 128) : null });
    }
    const root = clean.find(dep => dep.ref === scene.projectRef && dep.sha256 === scene.projectSha256);
    if (!root || root.mime !== 'application/json') throw error('document_invalid', '依赖清单缺少完整导演工程 JSON');
    const characterBindings = [];
    if (scene.characterBindings != null) {
      if (!Array.isArray(scene.characterBindings) || scene.characterBindings.length > 64) throw error('document_invalid', '角色参考绑定无效');
      const project = await projectOf(s, { scene });
      const characterIds = new Set((project.scenes?.scenes ?? []).flatMap(row => row.stage?.characters ?? []).map(row => row.id));
      for (const binding of scene.characterBindings) {
        if (!object(binding) || typeof binding.characterId !== 'string' || !characterIds.has(binding.characterId) ||
            characterBindings.some(row => row.characterId === binding.characterId) || !REF.test(binding.ref ?? '') ||
            binding.assetId !== REF.exec(binding.ref)[1] || !SHA.test(binding.sha256 ?? '')) throw error('document_invalid', '角色参考身份或素材摘要无效');
        const asset = await readAsset(s, binding, false);
        if (asset.kind !== 'image') throw error('document_invalid', '角色参考必须是原始图片');
        characterBindings.push({ characterId: binding.characterId, assetId: asset.assetId, ref: asset.ref, sha256: asset.sha256 });
        if (!clean.some(dep => dep.assetId === asset.assetId)) clean.push({ ...asset, role: 'character-reference', objectId: binding.characterId });
      }
    }
    const summary = typeof scene.summary === 'string' ? scene.summary.slice(0, 2000) : object(scene.summary)
      ? { name: typeof scene.summary.name === 'string' ? scene.summary.name.slice(0, 200) : '导演工程',
        scenes: Number.isSafeInteger(scene.summary.scenes) ? Math.max(0, scene.summary.scenes) : 0,
        characters: Number.isSafeInteger(scene.summary.characters) ? Math.max(0, scene.summary.characters) : 0 } : '';
    return { scene: { projectRef: scene.projectRef, projectSha256: scene.projectSha256, summary,
      ...(scene.characterBindings != null ? { characterBindings } : {}),
      ...(scene.exportResolution !== undefined ? { exportResolution: scene.exportResolution } : {}) }, dependencies: clean };
  }
  async function saveDocument(s, payload) {
    await recordOf(s); // Unknown versions and foreign bindings are never overwritten by CAS.
    const expected = payload.expectedRevision;
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) throw error('revision_invalid', '保存必须指定预期修订号');
    const validated = await validateDocument(s, payload.scene, payload.dependencies);
    live(s);
    const record = { format: DIRECTOR_DOCUMENT_FORMAT, rev: (expected ?? 0) + 1,
      projectId: s.projectId, nodeId: s.nodeId, ...validated, updatedAt: Date.now() };
    const key = directorDocumentKey(s.projectId, s.nodeId);
    if (typeof storage.setIfRev !== 'function') throw error('atomic_storage_required', '导演工程存储不支持原子修订保存');
    const result = await checked(s, storage.setIfRev(key, expected, record));
    if (!result.ok) {
      const conflictId = uid('conflict');
      await checked(s, storage.set(`dir:${s.nodeId}:hosted-conflict:${s.projectId}:${conflictId}`, { ...record, conflictId, expectedRevision: expected }));
      throw error('revision_conflict', '其他窗口已有新修订，本次草稿已另存，未覆盖原工程', { storedRevision: result.storedRev, conflictId });
    }
    return record;
  }
  async function createDraft(s, payload) {
    live(s);
    const model = getModel(payload.model);
    if (!model || !isModelUsable(payload.model) || !intentsFor(payload.model).some(item => item.intent === payload.intent)) throw error('generation_invalid', '模型或生成模式不可用');
    const refs = Array.isArray(payload.refAssetIds) ? payload.refAssetIds : [];
    const frames = Array.isArray(payload.frameAssetIds) ? payload.frameAssetIds : [];
    const framed = ['frames', 'first_frame', 'first_last_frame', 'last_frame'].includes(payload.intent);
    if (refs.length > 12 || frames.length > 2 || refs.length && frames.length || (framed ? refs.length > 0 : frames.length > 0))
      throw error('generation_invalid', '素材参考和首尾帧模式须分别组装');
    for (const id of [...refs, ...frames]) {
      const a = s.project.assets[id];
      if (!a || a.missing || !['image', 'video', 'audio'].includes(a.kind) || frames.includes(id) && a.kind !== 'image')
        throw error('asset_missing', `生成素材不可用：${id}`);
      await readAsset(s, { assetId: id }, false);
    }
    const sourceRecord = await recordOf(s);
    if (payload.sceneRevision !== sourceRecord?.rev) throw error('revision_conflict', '场景已更改，请重新准备生成素材');
    const characterBindings = [];
    for (const binding of sourceRecord.scene.characterBindings ?? []) {
      const asset = await readAsset(s, binding, false);
      if (asset.kind !== 'image') throw error('generation_invalid', '角色参考图片已不可用');
      characterBindings.push({ characterId: binding.characterId, assetId: asset.assetId, ref: asset.ref, sha256: asset.sha256 });
    }
    if ((await recordOf(s))?.rev !== sourceRecord.rev) throw error('revision_conflict', '场景已更改，请重新准备生成素材');
    const seconds = Number.isInteger(payload.seconds) ? payload.seconds : model.seconds?.default ?? 5;
    if (model.seconds && (seconds < model.seconds.min || seconds > model.seconds.max)) throw error('generation_invalid', '生成时长不在模型支持范围内');
    const draft = { model: payload.model, intent: payload.intent, prompt: typeof payload.prompt === 'string' ? payload.prompt.slice(0, 200000) : '',
      seconds, ratio: typeof payload.ratio === 'string' ? payload.ratio.slice(0, 16) : model.ratios?.default ?? '16:9', switches: {}, bindings: {} };
    if (model.ratios?.options && !model.ratios.options.includes(draft.ratio)) throw error('generation_invalid', '画幅不在模型支持范围内');
    const created = [];
    const node = addDraftNode(s, 'gen', { draft, perModel: {},
      directorSource: { nodeId: s.nodeId, sceneRevision: sourceRecord.rev, shotId: payload.shotId ?? null, characterBindings } });
    try {
      for (const id of [...refs, ...frames]) {
        let source = s.project.nodes.find(n => n.type === 'asset' && n.data.assetId === id &&
          !store.edgesInto(node.id, framed ? 'frames' : 'refs').some(e => e.from.node === n.id));
        if (!source) { source = addDraftNode(s, 'asset', { assetId: id, title: s.project.assets[id].name }); created.push(source.id); }
        if (!store.addEdge(source.id, 'out', node.id, framed ? 'frames' : 'refs', s.project.assets[id].kind)) throw error('generation_invalid', '生成素材连线失败');
      }
      await checked(s, store.flush());
      return { nodeId: node.id, draft, refAssetIds: refs, frameAssetIds: frames };
    } catch (e) {
      if (store.project === s.project) { store.removeNode(node.id); for (const id of created) store.removeNode(id); }
      throw e;
    }
  }
  async function publishOutputs(s, entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 16) throw error('output_invalid', '输出批次无效');
    const record = await recordOf(s), staged = [];
    let committed = false;
    try {
      for (const payload of entries) {
        if (payload.completed !== true) throw error('output_incomplete', '输出尚未完整成功，不创建素材');
        if (!record || payload.sceneRevision !== record.rev) throw error('revision_conflict', '场景修订已更改，输出未发布');
        if (payload.fps != null && ![24, 30].includes(payload.fps) || payload.frameCount != null && (!Number.isInteger(payload.frameCount) || payload.frameCount < 1 || payload.frameCount > (payload.fps ?? 30) * 30) ||
          payload.frameIndex != null && (!Number.isInteger(payload.frameIndex) || payload.frameIndex < 0 || payload.frameIndex > 36000))
          throw error('output_invalid', '输出帧率或帧数无效');
        staged.push(await writeAsset(s, payload, true));
      }
      if ((await recordOf(s))?.rev !== record.rev) throw error('revision_conflict', '输出期间场景已更改，未创建素材');
      live(s);
      const nodes = await store.publishAssetBatch(staged, s.node.x + 280, s.node.y + 40,
        { checkKey: directorDocumentKey(s.projectId, s.nodeId), checkRev: record.rev, assertCurrent: () => live(s) });
      committed = true;
      if (store.project === s.project && storage.active !== false) {
        try { assets.renderLibrary(); } catch { /* durable batch remains successful; the next UI render can recover */ }
      }
      return staged.map(({ a }, index) => ({ ...descriptor(a), assetNodeId: nodes[index].id }));
    } catch (failure) {
      if (!committed) for (const { a, created } of staged) if (created) { try { await storage.delBlob(`blob:${a.id}`); } catch {} }
      throw failure;
    }
  }
  async function handle(s, method, payload = {}) {
    live(s);
    switch (method) {
      case 'ready': {
        const document = await recordOf(s);
        const records = {};
        for (const [k, v] of Object.entries(await checked(s, store.directorKV(s.nodeId))))
          if (!k.includes(':hosted-document:') && !k.includes(':hosted-conflict:')) records[k] = v;
        s.ready = true; clearTimeout(s.timer); if (s.status) s.status.textContent = '已就绪';
        if (getAvailableModels() == null && api?.listModels) {
          const fp = getFingerprint();
          try {
            const catalog = await checked(s, api.listModels());
            const ids = (Array.isArray(catalog?.data) ? catalog.data : []).map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string');
            setAvailableModels(ids, { keyFp: fp });
            setModelCatalog(catalog?.data, { keyFp: fp });
          } catch { live(s); /* Editing remains available when model discovery fails. */ }
        }
        const verified = getAvailableModels() != null;
        const videoModels = (verified || storage.mode !== 'hosted' ? modelIds().filter(isModelUsable) : []).map(id => {
          const model = getModel(id);
          return { id, name: model.display_name ?? id, intents: intentsFor(id).map(item => item.intent),
            defaultSeconds: model.seconds?.default ?? 5, seconds: model.seconds ?? null, ratios: model.ratios?.options ?? ['16:9'] };
        });
        return { accountScope: storage.subject ?? 'local', document,
          legacy: Object.keys(records).length ? { records, unsupported: ['旧 MiniMax 场景保留原档，须显式迁移后编辑'] } : null,
          videoModels, modelCatalogVerified: verified, textModels: await proposals.models(s) };
      }
      case 'document.load': return recordOf(s);
      case 'document.save': return saveDocument(s, payload);
      case 'asset.list': {
        const record = await recordOf(s);
        const incoming = store.edgesInto(s.nodeId, 'refs').map(edge => store.node(edge.from.node)?.data.assetId).filter(Boolean);
        const outputs = Object.values(s.project.assets).filter(a => a.fromDirector === s.nodeId && a.directorOutput?.sceneRevision === record?.rev)
          .sort((a, b) => a.addedAt - b.addedAt).map(a => a.id);
        const ids = [...new Set([...incoming, ...outputs, ...Object.keys(s.project.assets)])];
        return ids.map(id => s.project.assets[id]).filter(a => a && !a.missing && !a.deletedAt)
          .map(a => ({ ...descriptor(a), incoming: incoming.includes(a.id) }));
      }
      case 'asset.read': return readAsset(s, payload);
      case 'asset.write': return descriptor((await writeAsset(s, payload)).a);
      case 'output.publish': return (await publishOutputs(s, [payload]))[0];
      case 'output.publishBatch': return publishOutputs(s, payload.entries);
      case 'generation.createDraft': return createDraft(s, payload);
      case 'proposal.quote': return proposals.quote(s, payload);
      case 'proposal.request': return proposals.request(s, payload);
      case 'proposal.status': return proposals.status(s, payload);
      case 'session.close': setTimeout(() => cleanup(s, '导演台已关闭'), 0); return true;
      default: throw error('method_unsupported', '导演台方法不可用');
    }
  }
  function cleanup(s, reason = '导演台已关闭') {
    if (!s || s.closed) return;
    // Notify while the exact old window is still attached. The child cancels
    // workers/media and releases URLs before the parent removes its iframe.
    s.win?.postMessage(directorEnvelope(s, uid('close'), 'session.close', { reason }, 'event'), s.origin);
    s.closed = true; proposals.cancel(s); clearTimeout(s.timer);
    if (sessions.get(s.nodeId) === s) sessions.delete(s.nodeId);
    try { s.frame.src = 'about:blank'; } catch { /* frame may already be detached */ }
    s.frame?.remove(); s.win = null; s.modal?.close();
  }
  function closeAll(reason) { for (const s of [...sessions.values()]) cleanup(s, reason); }
  function openEditor(node) {
    if (disposed) throw error('session_closed', '导演台宿主已销毁');
    storage.assertActive?.();
    if (node?.type !== 'director' || store.node(node.id) !== node) throw error('node_removed', '导演台节点不存在');
    const existing = sessions.get(node.id); if (existing && !existing.closed) return existing;
    const s = { sessionId: uid('session'), projectId: store.project.id, nodeId: node.id,
      project: store.project, node, epoch: storage.epoch, closed: false, ready: false, win: null, requests: new Map() };
    const frame = el('iframe', { class: 'director-frame', src: hostedDirectorURL(s),
      title: '星光导演台', sandbox: 'allow-scripts allow-same-origin allow-downloads', allow: 'autoplay' });
    s.frame = frame; s.origin = new URL(frame.getAttribute('src')).origin;
    const status = el('span', { class: 'muted', text: '正在加载导演台…' }); s.status = status;
    const retry = el('button', { type: 'button', text: '重新加载' });
    const close = el('button', { type: 'button', text: '关闭' });
    const wrap = el('div', { style: 'display:flex;flex-direction:column;height:100%' },
      el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px' }, el('b', { text: '星光导演台' }), status, retry, close), frame);
    s.modal = modal(wrap, { wide: true, onClose: () => cleanup(s) });
    sessions.set(node.id, s);
    frame.addEventListener('load', () => { if (!s.closed) s.win = frame.contentWindow; });
    frame.addEventListener('error', () => { if (!s.closed) status.textContent = '加载失败，请重新加载'; });
    retry.addEventListener('click', () => { const n = s.node; cleanup(s, '正在重新加载'); if (store.node(n.id) === n) openEditor(n); });
    close.addEventListener('click', () => cleanup(s));
    s.timer = setTimeout(() => { if (!s.closed && !s.ready) status.textContent = '导演台未响应，请重新加载'; }, helloTimeoutMs);
    s.timer?.unref?.();
    return s;
  }
  async function onMessage(event) {
    if (disposed) return;
    const data = event.data;
    const s = sessions.get(data?.nodeId);
    if (!s || s.closed || !matchesDirectorEnvelope(data, s, 'request') || event.origin !== s.origin ||
      event.source !== (s.win ?? s.frame.contentWindow)) return;
    s.win ??= event.source;
    // Capture the sender, scope and request bytes; retry creates another
    // session object, so an old operation cannot reply to the new editor.
    const target = event.source;
    let request = s.requests.get(data.requestId);
    if (request && request.method !== data.method) return;
    if (!request) {
      request = { method: data.method, result: Promise.resolve().then(() => handle(s, data.method, data.payload)) };
      s.requests.set(data.requestId, request);
      // Reads may contain a 100 MiB project buffer: never retain them in the
      // replay cache. Mutations keep their small result to prevent duplicate
      // nodes if the response was lost and the same request ID is retried.
      if (['ready', 'document.load', 'asset.list', 'asset.read'].includes(data.method))
        request.result.then(() => s.requests.delete(data.requestId), () => s.requests.delete(data.requestId));
    }
    let response;
    try { response = { ok: true, result: await request.result }; }
    catch (e) { response = { ok: false, error: { code: e.code ?? 'director_failed', message: e.message ?? String(e),
      ...(e.storedRevision !== undefined ? { storedRevision: e.storedRevision } : {}), ...(e.conflictId ? { conflictId: e.conflictId } : {}) } }; }
    try { live(s); } catch { return; }
    if (s.win !== target) return;
    target.postMessage(directorEnvelope(s, data.requestId, data.method, response, 'response'), s.origin);
  }
  window.addEventListener('message', onMessage);
  const off = store.onChange(reason => {
    if (reason?.type === 'project') closeAll('项目已切换');
    else if (reason?.type === 'structure') for (const s of [...sessions.values()]) if (store.node(s.nodeId) !== s.node) cleanup(s, '导演台节点已删除');
  });
  return { openEditor, closeEditor: id => cleanup(sessions.get(id)), closeAll,
    isOpen: id => !!sessions.get(id) && !sessions.get(id).closed, sessionOf: id => sessions.get(id) ?? null,
    onMessage, notifyIncoming() {},
    async sceneInfo(node) {
      const project = store.project; const epoch = storage.epoch;
      storage.assertActive?.();
      const record = await storage.get(directorDocumentKey(project.id, node.id));
      storage.assertActive?.();
      if (store.project !== project || store.node(node.id) !== node || storage.epoch !== epoch) return null;
      if (record?.format !== DIRECTOR_DOCUMENT_FORMAT || record.projectId !== project.id || record.nodeId !== node.id) return null;
      const summary = record.scene?.summary;
      return { saved: true, summaryText: summary && typeof summary === 'object'
        ? `${summary.name || '导演工程'} · ${summary.characters ?? 0} 个人物 · 修订 ${record.rev}`
        : typeof summary === 'string' ? summary : `修订 ${record.rev}`, revision: record.rev };
    },
    invokeAgent: () => Promise.reject(error('method_unsupported', '托管导演台请在编辑器中操作')),
    dispose() { if (disposed) return; closeAll('宿主已销毁'); disposed = true; off(); window.removeEventListener('message', onMessage); } };
}
