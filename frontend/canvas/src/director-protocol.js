// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared by the canvas host and its lazily loaded CozyClay editor.
export const DIRECTOR_NAMESPACE = 'starlight-director';
export const DIRECTOR_PROTOCOL_VERSION = 1;
export const DIRECTOR_DOCUMENT_FORMAT = 'starlight-director@1';
export const DIRECTOR_METHODS = Object.freeze([
  'ready', 'document.load', 'document.save', 'asset.list', 'asset.read',
  'asset.write', 'output.publish', 'output.publishBatch', 'generation.createDraft',
  'proposal.quote', 'proposal.request', 'proposal.status', 'session.close',
]);

export function directorEnvelope(scope, requestId, method, payload, kind = 'request') {
  return { namespace: DIRECTOR_NAMESPACE, version: DIRECTOR_PROTOCOL_VERSION,
    sessionId: scope.sessionId, projectId: scope.projectId, nodeId: scope.nodeId,
    requestId, kind, method, payload };
}

export function matchesDirectorEnvelope(data, scope, kind) {
  return !!data && data.namespace === DIRECTOR_NAMESPACE &&
    data.version === DIRECTOR_PROTOCOL_VERSION && data.sessionId === scope.sessionId &&
    data.projectId === scope.projectId && data.nodeId === scope.nodeId &&
    typeof data.requestId === 'string' && data.requestId.length > 0 && data.requestId.length <= 128 &&
    data.kind === kind && DIRECTOR_METHODS.includes(data.method);
}

export function directorDocumentKey(projectId, nodeId) {
  // The legacy dir:<node>: prefix is also the canvas package's collection boundary.
  return `dir:${nodeId}:hosted-document:${projectId}`;
}
