// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CameraControls } from './camera-controls.jsx';
import { ProposalControls } from './proposal-controls.jsx';
import { MotionControls } from './motion-controls.jsx';
import { createHostedSaveCoordinator, isProjectSaveShortcut } from './save-coordinator.js';

const noSubscription = () => () => {};
const noSaveState = () => null;

export function useHostedDirector(appContext, scenesDomain, ports) {
  const session = globalThis.__starlightDirectorSession;
  const latest = useRef({ appContext, scenesDomain, ports });
  latest.current = { appContext, scenesDomain, ports };
  const state = useRef({ busy: false, closed: false, reportedErrors: new WeakSet() });
  const [status, setStatus] = useState({ message: '正在恢复工程…', busy: false, error: false, rev: session?.record?.rev ?? null });
  const models = session?.videoModels ?? [];
  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationAssets, setGenerationAssets] = useState([]);
  const [selectedAssets, setSelectedAssets] = useState([]);
  const [generationModel, setGenerationModel] = useState(models.find(model => /seedance|sd25/i.test(model.id))?.id ?? models[0]?.id ?? '');
  const model = models.find(entry => entry.id === generationModel);
  const [generationIntent, setGenerationIntent] = useState('reference');
  const [generationSeconds, setGenerationSeconds] = useState(6);
  const [generationPrompt, setGenerationPrompt] = useState('');
  const [referenceBindings, setReferenceBindings] = useState(session?.record?.scene?.characterBindings ?? []);
  const bindingsRef = useRef(referenceBindings); bindingsRef.current = referenceBindings;
  const operations = useRef({}); operations.current = { createGenerationDraft };
  const idsRef = useRef(null);
  const coordinatorRef = useRef(null);
  function capture(includeResources = true) {
    const domain = latest.current.scenesDomain;
    const frozen = domain.captureProjectSave(domain.metadata().name ?? '导演工程', includeResources);
    idsRef.current = new Set(JSON.parse(frozen.snapshot).scenes.scenes.flatMap(scene => (scene.stage?.characters ?? []).map(character => character.id)));
    return frozen;
  }
  function metadata() {
    return { bindings: bindingsRef.current.filter(binding => !idsRef.current || idsRef.current.has(binding.characterId)),
      exportResolution: latest.current.ports.outputResolution };
  }
  if (session && !coordinatorRef.current) coordinatorRef.current = createHostedSaveCoordinator({ session,
    active: () => globalThis.__starlightDirectorSession === session,
    identity: () => latest.current.scenesDomain.projectSaveIdentity(),
    capture, extras: metadata,
    serialize: (frozen, check) => latest.current.scenesDomain.collectProjectSerialized(frozen.input.name, frozen, check),
  });
  const coordinator = coordinatorRef.current;
  const saveState = useSyncExternalStore(coordinator?.subscribe ?? noSubscription, coordinator?.getSnapshot ?? noSaveState, coordinator?.getSnapshot ?? noSaveState);
  const persistenceRef = useRef(null);
  if (session && !persistenceRef.current) persistenceRef.current = {
    getSnapshot: coordinator.getSnapshot,
    save: args => {
      if (args?.name && args.name !== latest.current.scenesDomain.metadata().name) throw new Error('请先重命名工程，再保存到画布');
      return operations.current.persist();
    },
    exportCopy: () => operations.current.downloadCopy(),
  };
  const persistence = persistenceRef.current;
  operations.current.persist = persist; operations.current.downloadCopy = downloadCopy;
  appContext.updateActionPorts({ projectPersistence: persistence });
  function announce(message, error = false) {
    if (!state.current.closed) setStatus({ message, error, busy: state.current.busy, rev: coordinator?.record?.rev ?? null });
  }
  function checkpoint() {
    return coordinator.checkpoint();
  }
  function proposalContext() {
    const current = latest.current;
    const project = JSON.parse(current.scenesDomain.collectProjectSnapshot(current.scenesDomain.projectName || '导演工程'));
    const scene = project.scenes.scenes.find(row => row.id === project.scenes.activeSceneId);
    const document = current.ports.shotsDomain.authoringDocument();
    return { sceneId: scene.id, fps: document.fps ?? 24, frameCount: document.frameCount,
      shots: document.shots, cameraLibrary: document.cameraLibrary,
      characters: scene.stage.characters.map(({ id, name, subject, x, z, rot, layer }) => ({ id, name, subject, x, z, rot, layer })),
      poses: project.poseLibrary };
  }
  async function persist() {
    if (state.current.preview) throw new Error('请先应用提案预览或返回原场景');
    if (!coordinator || state.current.closed) throw new Error('导演台会话已关闭');
    if (!state.current.busy) announce('');
    return coordinator.save();
  }
  async function persistCurrent() {
    const initialEpoch = latest.current.scenesDomain.projectSaveIdentity().documentEpoch;
    const record = await persist(), savedCheckpoint = checkpoint();
    const savedIdentity = latest.current.scenesDomain.projectSaveIdentity();
    const check = () => {
      const identity = latest.current.scenesDomain.projectSaveIdentity();
      if (identity.documentEpoch !== initialEpoch || identity.documentEpoch !== savedIdentity.documentEpoch
          || identity.clock !== savedIdentity.clock || checkpoint() !== savedCheckpoint || coordinator.getSnapshot().saveState !== 'saved'
          || coordinator.record?.rev !== record.rev)
        throw Object.assign(new Error('工程已有新修改，请保存后重新操作'), { code: 'saved_content_changed' });
    };
    check(); return { record, check };
  }
  async function publishBatch(entries, check = () => {}) {
    state.current.controller?.signal.throwIfAborted();
    check();
    state.current.committing = true;
    announce('正在原子保存输出，请等待确认…');
    return session.client.request('output.publishBatch', { entries });
  }
  async function publish(blob, name, kind, record, details = {}, check = () => {}) {
    if (state.current.closed) throw new Error('导演台会话已关闭');
    const bytes = await blob.arrayBuffer(); state.current.controller?.signal.throwIfAborted();
    return (await publishBatch([{ bytes, mime: blob.type,
      name, kind, completed: true, sceneRevision: record.rev, ...details }], check))[0];
  }
  async function output(kind, frame = null) {
    if (state.current.busy) throw new Error('已有导出正在执行');
    const controller = new AbortController(); state.current.controller = controller;
    state.current.busy = true; announce('正在准备输出…');
    const workspace = document.querySelector('.app'); if (workspace) workspace.inert = true;
    try {
      const { record, check: checkSaved } = await persistCurrent();
      controller.signal.throwIfAborted();
      const check = () => {
        controller.signal.throwIfAborted();
        checkSaved();
      };
      // The save ACK may legitimately refer to an older frozen document. Only
      // render and publish when the current authoring content still matches it.
      check();
      const { appContext: context, ports: current } = latest.current;
      const live = context.live.state;
      const shot = live.shots.find(entry => entry.id === live.activeShotId) ?? live.shots[0];
      const details = { shotId: shot?.id ?? null, fps: live.timeline.fps,
        frameIndex: frame ?? live.timeline.currentFrame, frameCount: 1 };
      let result;
      if (kind === 'png') {
        const url = current.captureFrame(details.frameIndex);
        if (!url) throw new Error('3D 场景尚未完成渲染');
        controller.signal.throwIfAborted();
        result = await publish(await (await fetch(url)).blob(), `导演台-帧${details.frameIndex}.png`, 'image', record,
          { ...details, role: details.frameIndex === shot?.startFrame ? 'first-frame' : details.frameIndex === shot?.endFrame ? 'last-frame' : 'still', objectId: shot?.id }, check);
      } else if (kind === 'video') {
        announce('正在逐帧编码…');
        const media = await current.exportVideo({ startFrame: shot?.startFrame ?? 0,
          endFrame: shot?.endFrame ?? live.timeline.frameCount - 1, download: false });
        controller.signal.throwIfAborted();
        check();
        if (!media?.blob?.size) throw new Error('导出未完成，未建立素材');
        result = await publish(media.blob, '导演台-参考视频.mp4', 'video', record, {
          ...details, role: 'reference-video', objectId: shot?.id,
          frameIndex: shot?.startFrame ?? 0, frameCount: media.frameCount, fps: media.fps ?? details.fps,
        }, check);
      } else {
        if (!shot) throw new Error('请先创建镜头');
        const index = live.shots.indexOf(shot);
        const pack = await current.exportPack(shot, index);
        controller.signal.throwIfAborted();
        check();
        if (!pack?.bytes?.length) throw new Error('参考包未完成');
        // Entries come from the same fixed render/codec job. Publish only
        // after the whole archive has completed successfully.
        const entries = [];
        for (const entry of pack.entries) {
          controller.signal.throwIfAborted();
          if (!/\.(png|mp4)$/i.test(entry.name)) continue;
          const video = entry.name.endsWith('.mp4');
          entries.push({ bytes: entry.data, mime: video ? 'video/mp4' : 'image/png',
            name: entry.name, kind: video ? 'video' : 'image', completed: true, sceneRevision: record.rev, ...details,
              role: video ? 'reference-video' : /last/i.test(entry.name) ? 'last-frame' : 'first-frame', objectId: shot.id,
              frameIndex: /last/i.test(entry.name) ? shot.endFrame : shot.startFrame,
              frameCount: video ? shot.endFrame - shot.startFrame + 1 : 1 });
        }
        entries.push({ bytes: pack.bytes, mime: 'application/zip', name: pack.name, kind: 'file',
          completed: true, sceneRevision: record.rev, ...details, role: 'reference-pack', objectId: shot.id,
          frameIndex: shot.startFrame, frameCount: shot.endFrame - shot.startFrame + 1 });
        result = (await publishBatch(entries, check)).at(-1);
      }
      announce('输出已回传当前画布项目');
      return result;
    } catch (error) {
      announce(error.name === 'AbortError' ? '导出已取消' : `导出失败：${error.message}`, true);
      if (error && typeof error === 'object') state.current.reportedErrors.add(error);
      throw error;
    } finally {
      state.current.busy = false;
      state.current.controller = null;
      state.current.committing = false;
      if (workspace) workspace.inert = false;
      if (!state.current.closed) setStatus(previous => ({ ...previous, busy: false }));
    }
  }
  async function downloadCopy() {
    const domain = latest.current.scenesDomain;
    const frozen = capture();
    const check = () => {
      if (state.current.closed || session.client.closed || globalThis.__starlightDirectorSession !== session) throw new Error('导演台会话已关闭');
      const current = domain.projectSaveIdentity();
      if (current.documentEpoch !== frozen.documentEpoch || current.clock !== frozen.clock) throw new Error('导出期间工程已更新，请重新导出副本');
    };
    check();
    const serialized = await domain.collectProjectSerialized(frozen.input.name, frozen, check);
    check();
    const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = '导演工程.cclayproject'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { fileName: '导演工程.cclayproject' };
  }
  function cancel() {
    if (state.current.preview) { announce('请在提案面板应用预览或返回原场景'); return false; }
    if (state.current.committing) { announce('输出正在原子保存，请等待成功或失败确认'); return false; }
    state.current.controller?.abort(); latest.current.ports.cancel(); announce('正在取消导出…'); return true;
  }
  async function openGeneration() {
    const { record, check } = await persistCurrent();
    const list = await session.client.request('asset.list');
    check();
    const current = record.rev;
    const candidates = list.filter(asset => ['image', 'video', 'audio'].includes(asset.kind));
    setGenerationAssets(candidates);
    setSelectedAssets(candidates.filter(asset => asset.incoming || asset.sceneRevision === current && asset.role === 'reference-video').map(asset => asset.assetId));
    setGenerationIntent(model?.intents.includes('refs') ? 'refs' : model?.intents.includes('reference') ? 'reference' : model?.intents[0] ?? 'text');
    setGenerationSeconds(model?.defaultSeconds ?? 6);
    setGenerationOpen(true);
  }
  async function createGenerationDraft() {
    const { record, check } = await persistCurrent();
    if (!model) throw new Error('当前账号没有可用的视频模型，请在画布确认模型目录');
    const framed = ['frames', 'last_frame'].includes(generationIntent);
    if (framed && selectedAssets.some(id => generationAssets.find(asset => asset.assetId === id)?.kind !== 'image'))
      throw new Error('首尾帧模式只接受图片，请调整所选素材');
    check();
    const result = await session.client.request('generation.createDraft', {
      model: model.id, intent: generationIntent, prompt: generationPrompt, seconds: Number(generationSeconds),
      sceneRevision: record.rev, shotId: latest.current.appContext.live.state.activeShotId,
      refAssetIds: framed ? [] : selectedAssets, frameAssetIds: framed ? selectedAssets : [],
    });
    announce('生成草稿已建立，请回到画布预览费用并主动提交');
    setGenerationOpen(false); return result;
  }
  async function useCharacterReference(asset) {
    const live = latest.current.appContext.live.state;
    if (asset.kind !== 'image' || !live.activeCharacterId) throw new Error('请先选择人物和一张参考图片');
    const characterId = live.activeCharacterId;
    const identity = latest.current.scenesDomain.projectSaveIdentity();
    const check = (beforeMutation = true) => {
      const current = latest.current.scenesDomain.projectSaveIdentity();
      if (state.current.closed || session.client.closed || globalThis.__starlightDirectorSession !== session)
        throw new Error('导演台会话已关闭');
      if (current.documentEpoch !== identity.documentEpoch || beforeMutation && current.clock !== identity.clock)
        throw Object.assign(new Error('工程已更新，请重新选择人物参考图'), { code: 'saved_content_changed' });
    };
    const resource = await session.client.request('asset.read', { assetId: asset.assetId, sha256: asset.sha256 });
    check();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([resource.bytes], { type: resource.mime }));
    });
    check();
    const receipt = await latest.current.appContext.bus.run('character.update', { characterId, patch: { identityImage: dataUrl } });
    if (!receipt.ok) throw new Error(receipt.message || receipt.code || '角色参考图未应用');
    check(false);
    const binding = { characterId, assetId: resource.assetId, ref: resource.ref, sha256: resource.sha256 };
    bindingsRef.current = [...bindingsRef.current.filter(row => row.characterId !== binding.characterId), binding];
    setReferenceBindings(bindingsRef.current);
    await persist(true); announce('已绑定所选人物的原始参考图');
  }
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    const restoreController = new AbortController();
    const owners = latest.current.appContext.storeDomains();
    let observedOwners = new Map();
    const rememberOwners = () => { observedOwners = new Map(owners.map(owner => [owner, owner.documentStore.getSnapshot()])); };
    const releaseProject = latest.current.scenesDomain.subscribeProject(({ snapshot }) => {
      idsRef.current = new Set(JSON.parse(snapshot).scenes.scenes.flatMap(scene => (scene.stage?.characters ?? []).map(character => character.id)));
      coordinator.observe(snapshot);
      rememberOwners();
    });
    // Some owner changes (IK keys and transactions in particular) do not
    // change App's old file-dirty effect dependencies. Coalesce their native
    // document notifications, never the renderer's frames, into one read.
    let readQueued = false;
    const releaseOwners = owners.map(owner => owner.documentStore.subscribe(() => {
      if (readQueued || stopped) return;
      readQueued = true;
      queueMicrotask(() => {
        readQueued = false;
        if (stopped || state.current.closed) return;
        if (owners.every(owner => observedOwners.get(owner) === owner.documentStore.getSnapshot())) return;
        const domain = latest.current.scenesDomain;
        const snapshot = domain.collectProjectSnapshot(domain.metadata().name ?? '导演工程');
        idsRef.current = new Set(JSON.parse(snapshot).scenes.scenes.flatMap(scene => (scene.stage?.characters ?? []).map(character => character.id)));
        coordinator.observe(snapshot);
        rememberOwners();
      });
    }));
    const onClose = session.client.onClose(() => {
      restoreController.abort();
      state.current.closed = true;
      coordinator.close();
      state.current.controller?.abort();
      latest.current.ports.cancel();
    });
    (async () => {
      let incoming = null;
      const beforeHydration = latest.current.scenesDomain.projectSaveIdentity();
      const beforeProjectSnapshot = capture(false).snapshot;
      const beforeMetadata = JSON.stringify(metadata());
      if (session.initialProject) {
        await latest.current.scenesDomain.rehydrateProjectAssets(session.initialProject);
        if (stopped || session.client.closed || globalThis.__starlightDirectorSession !== session) return;
        const current = latest.current.scenesDomain.projectSaveIdentity();
        if (current.documentEpoch !== beforeHydration.documentEpoch || current.clock !== beforeHydration.clock
            || capture(false).snapshot !== beforeProjectSnapshot || JSON.stringify(metadata()) !== beforeMetadata)
          throw new Error('恢复期间工程已有新修改，已停止覆盖。请导出当前副本后重新打开工程');
        incoming = latest.current.scenesDomain.applyProject(session.initialProject, true);
      }
      const resolution = session.record?.scene?.exportResolution;
      if (resolution != null && ![720, 1080].includes(resolution)) throw new Error('已保存工程的输出分辨率不受支持');
      if (resolution) latest.current.ports.setOutputResolution(resolution);
      if (incoming) idsRef.current = new Set(JSON.parse(incoming.snapshot).scenes.scenes.flatMap(scene => (scene.stage?.characters ?? []).map(character => character.id)));
      else capture(false);
      const ticket = coordinator.beginRestore({ ...metadata(), ...(resolution ? { exportResolution: resolution } : {}) }, incoming);
      if (incoming) {
        if (typeof incoming.whenProjected !== 'function') throw new Error('工程所有者未提供界面恢复完成信号');
        await incoming.whenProjected(restoreController.signal);
      }
      if (stopped || session.client.closed || globalThis.__starlightDirectorSession !== session) return;
      coordinator.finishRestore(ticket);
      announce(session.legacy?.unsupported?.length ? '旧导演工程已保留；部分格式需要显式迁移，可先导出原包。'
        : '');
    })().catch(error => { coordinator.reportError(error); announce(`恢复失败：${error.message}`, true); });
    const timer = setInterval(() => {
      const saved = coordinator.getSnapshot();
      if (saved.loaded && !saved.pending && saved.dirty && !state.current.busy && !state.current.closed && saved.saveState !== 'conflict')
        persist().catch(() => {});
    }, 1000);
    const onSaveKey = event => {
      if (!isProjectSaveShortcut(event)) return;
      event.preventDefault();
      Promise.resolve(latest.current.appContext.bus.run('project.save')).catch(error => announce(error.message, true));
    };
    window.addEventListener('keydown', onSaveKey);
    const api = window.__starlightDirector = {
      save: () => persist(true), exportPng: frame => output('png', frame),
      exportVideo: () => output('video'), exportPack: () => output('pack'),
      cancel,
      createGenerationDraft: () => operations.current.createGenerationDraft(),
      run: (id, args) => latest.current.appContext.bus.run(id, args),
      rpc: (...args) => session.client.request(...args),
      status: () => ({ ...coordinator.getSnapshot(), busy: state.current.busy }),
    };
    return () => {
      restoreController.abort();
      stopped = true; state.current.closed = true; coordinator.close();
      clearInterval(timer); releaseProject(); releaseOwners.forEach(release => release()); onClose(); window.removeEventListener('keydown', onSaveKey);
      latest.current.ports.cancel();
      if (window.__starlightDirector === api) delete window.__starlightDirector;
      if (latest.current.appContext.actionPorts.projectPersistence === persistence) latest.current.appContext.updateActionPorts({ projectPersistence: null });
    };
  }, []);
  useEffect(() => { coordinator?.observe(); }, [referenceBindings, ports.outputResolution]);
  if (!session) return { bar: null, saveState: null, persistence: null };
  function onPreviewState(active) {
    state.current.preview = active; state.current.busy = active;
    const workspace = document.querySelector('.app'); if (workspace) workspace.inert = active;
    if (!state.current.closed) setStatus(previous => ({ ...previous, busy: active }));
  }
  const run = action => () => action().catch(error => { if (!state.current.reportedErrors.has(error)) announce(error.message, true); });
  const portal = document.getElementById('hosted-director-bar');
  const barMessage = [saveState.message, status.message].filter(Boolean).join(' · ');
  const bar = portal ? createPortal(<div className="hosted-director-bar">
    <strong>星光导演台</strong><span data-testid="hosted-director-save-status" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={barMessage} role={status.error || ['error', 'conflict'].includes(saveState.saveState) ? 'alert' : 'status'}>{barMessage}</span>
    <button data-testid="hosted-director-save" disabled={status.busy || saveState.pending || !saveState.loaded} title="保存到当前画布项目 · Ctrl/Cmd+S" onClick={run(() => persist(true))}>保存</button>
    <button data-testid="hosted-director-export-png" disabled={status.busy} onClick={run(() => output('png'))}>PNG 回画布</button>
    <button data-testid="hosted-director-export-video" disabled={status.busy} onClick={run(() => output('video'))}>视频回画布</button>
    <button data-testid="hosted-director-export-pack" disabled={status.busy} onClick={run(() => output('pack'))}>镜头参考包</button>
    <button data-testid="hosted-director-export-copy" aria-label="导出工程副本到本机" title="导出工程副本到本机；画布保存状态保持不变" disabled={status.busy} onClick={run(downloadCopy)}>本机副本</button>
    <button data-testid="hosted-director-generation" disabled={status.busy} onClick={run(openGeneration)}>生成与参考图</button>
    <CameraControls context={appContext} ports={ports} announce={announce} disabled={status.busy} />
    <MotionControls context={appContext} announce={announce} disabled={status.busy} />
    <ProposalControls session={session} getContext={proposalContext} persist={persistCurrent} checkpoint={checkpoint} appContext={appContext} announce={announce} disabled={status.busy} onPreviewState={onPreviewState} />
    <button data-testid="hosted-director-cancel" disabled={!status.busy} onClick={cancel}>取消导出</button>
    {generationOpen && <section className="hosted-gen-panel" aria-label="模型生成草稿">
      <header><strong>模型生成草稿</strong><button onClick={() => setGenerationOpen(false)}>关闭</button></header>
      <p>建立草稿不收费。模型费用和最终参数将在画布提交前确认。</p>
      <label>模型<select disabled={status.busy} value={generationModel} onChange={event => {
        const next = models.find(entry => entry.id === event.target.value); setGenerationModel(next.id);
        setGenerationIntent(next.intents.includes('refs') ? 'refs' : next.intents.includes('reference') ? 'reference' : next.intents[0]); setGenerationSeconds(next.defaultSeconds);
      }}>{models.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
      <label>模式<select disabled={status.busy} value={generationIntent} onChange={event => setGenerationIntent(event.target.value)}>
        {(model?.intents ?? []).map(intent => <option key={intent} value={intent}>{({ text: '文字生成', first: '首帧', first_frame: '首帧', frames: '首尾帧', last_frame: '首尾帧', refs: '多素材参考', reference: '多素材参考' })[intent] ?? intent}</option>)}
      </select></label>
      <label>生成秒数<input disabled={status.busy} type="number" min={model?.seconds?.min ?? 1} max={model?.seconds?.max ?? 30} step="1" value={generationSeconds} onChange={event => setGenerationSeconds(event.target.value)} /></label>
      <label>提示词<textarea disabled={status.busy} value={generationPrompt} onChange={event => setGenerationPrompt(event.target.value)} placeholder="填写角色、动作和画面要求，保留你自己的描述" /></label>
      <p>素材按下列编号传入；选择人物后可把图片绑定为其原始参考图。</p>
      {generationAssets.map(asset => <div className="hosted-gen-asset" key={asset.assetId}>
        <label><input disabled={status.busy} type="checkbox" checked={selectedAssets.includes(asset.assetId)} onChange={event => setSelectedAssets(previous => event.target.checked ? [...previous, asset.assetId] : previous.filter(id => id !== asset.assetId))} />{asset.name}</label>
        {selectedAssets.includes(asset.assetId) && <span>引用 {selectedAssets.indexOf(asset.assetId) + 1}</span>}
        {asset.kind === 'image' && <button disabled={status.busy} onClick={run(() => useCharacterReference(asset))}>绑定所选人物</button>}
      </div>)}
      <button data-testid="hosted-director-create-generation" disabled={status.busy} onClick={run(createGenerationDraft)}>建立画布生成节点</button>
    </section>}
  </div>, portal) : null;
  return { bar, saveState, persistence };
}
