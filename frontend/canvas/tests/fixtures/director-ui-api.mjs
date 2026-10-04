// SPDX-License-Identifier: AGPL-3.0-or-later
// Only the synthetic supplier/data plane is changed. Browser tests still use
// Caddy, the actual hosted adapter and the product's authoring/persistence code.
import { createHash } from 'node:crypto';
import { syntheticNewApi } from '../hosted-topology.mjs';
import { MP4, MODELS_11 } from '../e2e-helpers.mjs';

export const TEXT_MODEL = 'gpt-f-independent-director';
export const VIDEO_MODEL = 'seedance-2.5-vip-720p';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (res, status, value) => {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const body = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); };
const observeBody = (req, done) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk));
  req.once('end', () => done(Buffer.concat(chunks)));
};
function contextFromRequest(request) {
  const text = request.messages.find(row => row.role === 'user')?.content;
  const start = text.indexOf('场景：') + 3, end = text.indexOf('\n用户要求：', start);
  if (start < 3 || end < start) throw new Error('synthetic proposal request lacks the actual scene context');
  return JSON.parse(text.slice(start, end));
}
function proposalFor(request) {
  const context = contextFromRequest(request), actor = context.characters[0], shot = context.shots[0];
  const camera = request.messages.find(row => row.role === 'user').content.includes('提案类型：camera');
  return { reply: '合成提案：保留原始角色描述，只修改用户主动要求的编辑数据。', commands: camera ? [
    { id: 'shot.rename', args: { shotId: shot.id, name: 'F用户确认的运镜镜头' } },
    { id: 'shot.setCamera', args: { shotId: shot.id, patch: { mode: 'keys', focusDistance: 3, fStop: 4, depthOfField: false } } },
  ] : [
    { id: 'character.addWaypoint', args: { characterId: actor.id, frame: 30, position: { x: -0.6, z: 0.8 } } },
    { id: 'ik.applyPose', args: { characterId: actor.id, frame: 0, pose: { bones: { lArm: [0, 0, 0.55] } } } },
    { id: 'character.setPromptBlocks', args: { characterId: actor.id, blocks: [
      { id: 'f-proposal-prompt', startFrame: 0, endFrame: context.frameCount, text: '用户主动指定角色甲抬左臂，保留合成角色甲的原始描述。' },
    ] } },
  ] };
}
export function directorUiApi() {
  const base = syntheticNewApi({ videoBytes: MP4, models: [...MODELS_11, TEXT_MODEL] });
  Object.assign(base.state, { chats: [], createAttempts: [], uploadDetails: [], failures: [], holdChat: false });
  let releaseChat;
  const handler = async (req, res) => {
    const path = new URL(req.url, 'http://synthetic').pathname;
    if (path === '/api/pricing') return json(res, 200, { success: true, pricing_version: 'F-synthetic-pricing-v1', group_ratio: { default: 1 }, data: [
      { model_name: TEXT_MODEL, billing_configured: true, quota_type: 0, model_ratio: 1, completion_ratio: 3, enable_groups: ['default'] },
    ] });
    if (path === '/v1/models') return json(res, 200, { data: [...MODELS_11.map(id => ({ id })),
      { id: TEXT_MODEL, endpoints: ['/v1/chat/completions'] }] });
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      if (!/^Bearer sk-synth-(?:alice(?:-2)?|bob)$/.test(req.headers.authorization ?? '')) return json(res, 401, { error: { code: 'synthetic_auth_required' } });
      const request = JSON.parse((await body(req)).toString('utf8'));
      base.state.chats.push(request);
      if (base.state.holdChat) { base.state.holdChat = false; await new Promise(resolve => { releaseChat = resolve; }); releaseChat = null; }
      return json(res, 200, { choices: [{ message: { content: JSON.stringify(proposalFor(request)) } }] });
    }
    if (path === '/reference-assets' && req.method === 'POST') {
      let details;
      observeBody(req, bytes => {
        details = { mime: String(req.headers['content-type']).split(';')[0], size: bytes.length, sha256: digest(bytes) };
        base.state.uploadDetails.push(details);
      });
      const end = res.end;
      res.end = function (value, ...args) {
        if (details && typeof value === 'string') {
          const reply = JSON.parse(value);
          if (details.mime === 'video/mp4' && reply.url) { reply.duration_seconds = 6.25; value = JSON.stringify(reply); }
          details.remoteUrl = reply.url;
        }
        return end.call(this, value, ...args);
      };
    }
    return base.handler(req, res);
  };
  const gatewayHandler = async (req, res) => {
    const path = new URL(req.url, 'http://synthetic').pathname;
    if (path === '/v1/videos' && req.method === 'POST') observeBody(req, bytes => {
      base.state.createAttempts.push({ key: req.headers['idempotency-key'], body: JSON.parse(bytes.toString('utf8')) });
    });
    res.once('finish', () => { if (res.statusCode >= 400) base.state.failures.push({ method: req.method, path, status: res.statusCode }); });
    return base.gatewayHandler(req, res);
  };
  return { ...base, handler, gatewayHandler, holdNextChat: () => { base.state.holdChat = true; },
    releaseChat: () => { releaseChat?.(); }, contextFromRequest };
}
