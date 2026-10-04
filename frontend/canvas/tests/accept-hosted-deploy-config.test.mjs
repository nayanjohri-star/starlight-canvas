// 托管部署配置一致性：发布的模板、适配层读取的环境变量、生产 Caddy 的既有视频路由与 CI 拓扑使用同一套上游定义。
// 最终视频路由（hosted-api-contract.md）：身份/所有权/型号/价目/图文/历史 task_ → NEW_API_URL；
// 视频新建与 vjob_ → VIDEO_API_URL（task-error-gateway，与 NEW_API_URL 不同）；参考素材 → REFERENCE_ASSETS_URL。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = p => readFileSync(join(REPO, p), 'utf8').replace(/\r\n/g, '\n');
const compose = read('deploy/canvas-web/compose.canvas-web.yaml');
const envExample = read('deploy/canvas-web/canvas-web.env.example');
const snippet = read('deploy/canvas-web/primary-site.caddy');
const adapter = read('deploy/canvas-hosted-api/server.mjs');
const production = read('deploy/production/Caddyfile');
const workflow = read('.github/workflows/canvas-05-strict-gate.yml');

test('compose 中适配层的三个上游分别来自独立的必填变量，并与适配层读取的环境变量一致', () => {
  const svc = compose.slice(compose.indexOf('  canvas-hosted-api:'), compose.indexOf('\n  caddy:'));
  const env = Object.fromEntries([...svc.matchAll(/^\s{6}([A-Z_]+):\s*(.+)$/gm)].map(m => [m[1], m[2]]));
  assert.match(env.NEW_API_URL, /\$\{CANVAS_NEW_API_URL:\?/);
  assert.match(env.VIDEO_API_URL, /\$\{CANVAS_VIDEO_API_URL:\?/);
  assert.match(env.REFERENCE_ASSETS_URL, /\$\{CANVAS_REFERENCE_ASSETS_URL:\?/);
  assert.match(env.PUBLIC_ORIGIN, /^https:\/\/\$\{PRIMARY_DOMAIN/);
  for (const v of ['NEW_API_URL', 'VIDEO_API_URL', 'REFERENCE_ASSETS_URL', 'PUBLIC_ORIGIN'])
    assert.ok(adapter.includes(`process.env.${v}`), `适配层读取 ${v}`);
  assert.match(adapter, /video === api\) throw new Error/, '适配层拒绝把视频上游配置成 New API');
});

test('环境示例：视频上游指向生产 Caddy 已在使用的 task-error-gateway，三个上游互不相同', () => {
  const val = k => new RegExp(`^${k}=(\\S+)$`, 'm').exec(envExample)?.[1];
  const api = val('CANVAS_NEW_API_URL'), video = val('CANVAS_VIDEO_API_URL'), assets = val('CANVAS_REFERENCE_ASSETS_URL');
  assert.ok(api && video && assets);
  assert.equal(new Set([api, video, assets]).size, 3);
  const prodVideo = /@video_task_api[\s\S]*?reverse_proxy (\S+)/.exec(production)?.[1];
  assert.equal(new URL(video).host, prodVideo, '与生产 /v1/videos 的上游一致');
  assert.equal(new URL(api).host, /@new_api[\s\S]*?reverse_proxy (\S+)/.exec(production)?.[1]);
});

test('主站片段只开放 /canvas 与 /canvas-api；/canvas-api 只转给适配层', () => {
  const matchers = [...snippet.matchAll(/^\s*@(\w+) path (.+)$/gm)].map(m => [m[1], m[2].trim()]);
  assert.deepEqual(matchers, [['canvas_bare', '/canvas'], ['canvas_internal', '/internal/canvas/*'], ['canvas', '/canvas/*'], ['canvas_api', '/canvas-api /canvas-api/*']]);
  assert.match(snippet, /handle @canvas_internal\s*\{\s*respond "not found" 404/);
  assert.match(snippet, /reverse_proxy canvas-hosted-api:3238/);
  assert.match(adapter, /process\.env\.PORT \?\? 3238/);
});

test('CI 真实拓扑按同样的变量名启动适配层，并把视频上游指向独立的合成网关', () => {
  const job = workflow.slice(workflow.indexOf('  hosted-topology:'), workflow.indexOf('\n  hosted-backend-tests:'));
  assert.match(job, /NEW_API_URL="http:\/\/127\.0\.0\.1:\$\{BACKEND_PORT\}"/);
  assert.match(job, /VIDEO_API_URL="http:\/\/127\.0\.0\.1:\$\{GATEWAY_PORT\}"/);
  assert.match(job, /CANVAS_HOSTED_GATEWAY_PORT/);
});
