// SPDX-License-Identifier: AGPL-3.0-or-later
import { DIRECTOR_DOCUMENT_FORMAT } from '../../canvas/src/director-protocol.js';
// Object field order is not authored content. Arrays and every scalar value
// remain exact; no omitted field, added field or differing value is tolerated.
function sameProjectSnapshot(left, right) {
  if (left === right) return true;
  function same(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  try { return same(JSON.parse(left), JSON.parse(right)); } catch { return false; }
}
// Runtime checkpoints and transport ordering only. The scene owners retain
// the sole authoring document and history; snapshots are frozen per save.
export function createHostedSaveCoordinator({ session, active, identity, capture, serialize, extras }) {
  const listeners = new Set();
  let closed = false, loaded = false, pending = 0, record = session.record ?? null;
  let acknowledged = null, current = null, project = null, error = null, conflict = null, queue = Promise.resolve();
  let version = 0, snapshot;
  const failure = (message, code = 'session_closed') => Object.assign(new Error(message), { code });
  function check(epoch) {
    if (closed || session.client.closed || !active()) throw failure('导演台会话已关闭');
    if (epoch !== undefined && epoch !== identity().documentEpoch) throw failure('工程已切换，旧保存已取消', 'document_changed');
  }
  const key = (value, metadata) => JSON.stringify({ project: value, bindings: metadata.bindings, exportResolution: metadata.exportResolution });
  function publish() {
    const dirty = acknowledged === null || current !== acknowledged;
    const saveState = closed ? 'closed' : conflict ? 'conflict' : error ? 'error' : !loaded ? 'loading' : pending ? 'saving' : dirty ? 'dirty' : 'saved';
    const message = saveState === 'loading' ? '正在恢复工程…' : saveState === 'closed' ? '导演台会话已关闭'
      : saveState === 'conflict' ? `保存冲突：${conflict.message}。当前修改保留，可导出工程副本。`
      : saveState === 'error' ? `保存失败：${error.message}。当前修改保留，可导出工程副本。`
      : saveState === 'saving' ? '正在保存完整工程…'
      : dirty ? record ? `修订 ${record.rev} 已保存，仍有新修改待保存` : '有新修改待保存到当前画布项目'
      : `已保存 · 修订 ${record.rev}`;
    const label = saveState === 'saved' ? message : ({ loading: '正在恢复…', closed: '会话已关闭', conflict: '保存冲突', error: '保存失败', saving: '正在保存…', dirty: '有未保存修改' })[saveState];
    const next = { loaded, dirty, pending: pending > 0, saveState, rev: record?.rev ?? null, message, label };
    if (snapshot && Object.keys(next).every(key => next[key] === snapshot[key])) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  }
  function observe(value = project) {
    if (closed || value === null) return;
    project = value;
    const next = key(project, extras());
    if (next !== current) { current = next; version++; }
    publish();
  }
  function beginRestore(metadata = extras(), incoming = null) {
    check();
    // The scene owner can supply the fixed normalized document it just loaded.
    // React may still expose outgoing cast/shot/workspace refs at this point.
    const baseline = incoming ?? capture(false);
    check(baseline.documentEpoch);
    return { documentEpoch: baseline.documentEpoch, clock: baseline.clock,
      metadata: JSON.stringify(metadata), projectSnapshot: baseline.snapshot };
  }
  function finishRestore(ticket) {
    check();
    const frozen = capture(false);
    observe(frozen.snapshot);
    // A projection may settle at the next render. An authored edit, document
    // replacement, or changed host metadata during restoration cannot become
    // the acknowledged baseline of an older record.
    if (record && ticket.documentEpoch === identity().documentEpoch && ticket.clock === identity().clock
        && ticket.metadata === JSON.stringify(extras()) && sameProjectSnapshot(ticket.projectSnapshot, frozen.snapshot)) acknowledged = current;
    loaded = true; publish();
  }
  function save() {
    check();
    if (!loaded) return Promise.reject(failure('工程尚未完成恢复', 'restore_pending'));
    pending++; publish();
    const job = async () => {
      check();
      if (conflict) throw conflict;
      error = null; publish();
      let frozen, metadata, serialized, capturedKey;
      for (let attempt = 0; ; attempt++) {
        check();
        frozen = capture(); metadata = structuredClone(extras());
        observe(frozen.snapshot); capturedKey = key(frozen.snapshot, metadata);
        if (record && capturedKey === acknowledged) return record;
        const stamp = version;
        const unchanged = () => {
          check(frozen.documentEpoch);
          if (identity().clock !== frozen.clock || version !== stamp) throw failure('保存内容已更新，请重新保存', 'save_content_changed');
        };
        try { serialized = await serialize(frozen, unchanged); unchanged(); break; }
        catch (cause) { if (cause.code !== 'save_content_changed' || attempt >= 2) throw cause; }
      }
      check(frozen.documentEpoch);
      const resource = await session.client.request('asset.write', {
        bytes: new TextEncoder().encode(serialized).buffer, mime: 'application/json',
        name: '导演工程.cclayproject', kind: 'file', role: 'project', objectId: 'project',
      });
      check(frozen.documentEpoch);
      const document = JSON.parse(serialized);
      const dependencies = [resource, ...(record?.dependencies ?? []).filter(entry => entry.role !== 'project')];
      const saved = await session.client.request('document.save', {
        expectedRevision: record?.rev ?? null,
        scene: { projectRef: resource.ref, projectSha256: resource.sha256,
          characterBindings: metadata.bindings, exportResolution: metadata.exportResolution,
          summary: { name: document.name, scenes: document.scenes.scenes.length,
            characters: document.scenes.scenes.flatMap(scene => scene.stage?.characters ?? []).length } },
        dependencies,
      });
      check();
      const completeDependencies = Array.isArray(saved?.dependencies) && dependencies.every(expected => saved.dependencies.some(actual =>
        actual?.ref === expected.ref && actual.sha256 === expected.sha256
          && actual.role === (typeof expected.role === 'string' ? expected.role.slice(0, 64) : 'asset')
          && (actual.objectId ?? null) === (typeof expected.objectId === 'string' ? expected.objectId.slice(0, 128) : null)
          && (expected.assetId == null || actual.assetId === expected.assetId)
          && (expected.mime == null || actual.mime === expected.mime)
          && (expected.size == null || actual.size === expected.size)));
      if (saved?.format !== DIRECTOR_DOCUMENT_FORMAT || !completeDependencies
          || !Number.isSafeInteger(saved?.rev) || saved.rev !== (record?.rev ?? 0) + 1
          || saved.projectId !== session.client.scope.projectId || saved.nodeId !== session.client.scope.nodeId
          || saved.scene?.projectRef !== resource.ref || saved.scene?.projectSha256 !== resource.sha256
          || JSON.stringify(saved.scene?.characterBindings ?? []) !== JSON.stringify(metadata.bindings)
          || saved.scene?.exportResolution !== metadata.exportResolution) throw failure('保存回执与提交工程不符', 'save_ack_invalid');
      // A project import may replace the author document while this session's
      // save commits. Its fully validated ACK still advances our transport CAS
      // baseline; it cannot acknowledge the incoming document's author state.
      record = saved;
      check(frozen.documentEpoch);
      acknowledged = capturedKey;
      // Re-read the author's snapshot once at completion, not on every render.
      // A queued React projection or edit during asset/write ACK stays dirty.
      observe(capture(false).snapshot);
      return record;
    };
    const result = queue.then(job);
    const settled = result.catch(cause => {
      if (closed || !active() || session.client.closed) return;
      if (cause.code === 'revision_conflict') conflict = cause;
      error = cause;
    }).finally(() => { pending--; publish(); });
    queue = settled;
    // Return after error/status bookkeeping, preserving the actual rejection.
    return result.then(async value => { await settled; return value; }, async cause => { await settled; throw cause; });
  }
  publish();
  return {
    observe, beginRestore, finishRestore, save,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    checkpoint: () => { check(); observe(capture(false).snapshot); return current; },
    reportError(cause) { if (!closed) { error = cause; publish(); } },
    get record() { return record; },
    close() { closed = true; publish(); listeners.clear(); },
  };
}

export function isProjectSaveShortcut(event) {
  return !event.defaultPrevented && !event.isComposing && !event.repeat && !event.altKey
    && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.code === 'KeyS';
}
