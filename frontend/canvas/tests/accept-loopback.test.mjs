// WO-D0-6 loopback 守门（D 独立验收，单元级）：
// 1) 服务端 upstreamFetch 注入点是唯一出网口——/site/* 只转发到固定 SITE_ORIGIN 合同路径；
//    非 /site 请求绝不触达上游；任意上游调用只允许白名单路由形态。
// 2) src/ 静态守门：浏览器侧不得出现直连外网的 fetch/XHR/WS 目标——一切请求走本机同源服务。
// e2e 层的 page.route 零非 loopback 断言由 e2e-helpers.watchEgress() 提供，随浏览器用例启用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvasServer, SITE_ORIGIN } from '../server/app.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

async function serve(opts) {
  const server = createCanvasServer(opts);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

test('loopback：/site 转发只打固定上游与合同路由；非 /site 请求零上游调用', async t => {
  const calls = [];
  const upstream = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return Response.json({ data: [] });
  };
  const staticDir = await mkdtemp(join(tmpdir(), 'xp-loopback-'));
  const directorDir = await mkdtemp(join(tmpdir(), 'xp-director-'));
  t.after(async () => { await rm(staticDir, { recursive: true, force: true }); await rm(directorDir, { recursive: true, force: true }); });
  await writeFile(join(staticDir, 'index.html'), '<html></html>');
  const { base, close } = await serve({ staticDir, directorDir, upstreamFetch: upstream });
  t.after(close);

  // 无凭据合同路由 → 本地鉴权闸拒绝，绝不触达上游
  await fetch(`${base}/site/v1/models`);
  assert.equal(calls.length, 0, '无 Bearer 凭据的请求不得转发上游');

  // 合同路由（需 Bearer 鉴权头才过本地闸）→ 一次上游调用，且目标只能是 SITE_ORIGIN 下的合同路径
  await fetch(`${base}/site/v1/models`, { headers: { Authorization: 'Bearer sk-loopback-test' } });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin, SITE_ORIGIN, '上游目标必须固定为本站 origin');
  assert.equal(u.pathname, '/v1/models');

  // 非合同路由 → 路由层拒绝，绝不转发
  await fetch(`${base}/site/v1/admin/users`);
  await fetch(`${base}/site/v1/videos/../../etc`);
  assert.equal(calls.length, 1, '非合同路由不得产生上游调用');

  // 静态/本机路径 → 零上游
  await fetch(`${base}/`);
  await fetch(`${base}/missing.js`);
  await fetch(`${base}/media/capabilities`).catch(() => {});
  assert.equal(calls.length, 1, '非 /site 路径不得触达上游');
});

test('loopback：src/ 浏览器侧无直连外网请求目标（一切经本机同源服务）', async () => {
  const offenders = [];
  for (const f of await readdir(SRC)) {
    if (!f.endsWith('.js')) continue;
    const code = await readFile(join(SRC, f), 'utf8');
    // fetch/XHR/WS/sendBeacon 的字符串字面量第一参数：只允许同源相对路径（/、./、变量）
    for (const m of code.matchAll(/(?:fetch|open|sendBeacon)\s*\(\s*(['"`])(https?:\/\/[^'"`]+)\1/g))
      offenders.push(`${f}: ${m[2]}`);
    for (const m of code.matchAll(/new\s+(XMLHttpRequest|WebSocket|EventSource)\s*\(\s*(['"`])?(https?:|wss?:)?/g))
      offenders.push(`${f}: new ${m[1]}(${m[3] ?? ''}`);
    // importScripts/动态 import 外网脚本同属越界
    for (const m of code.matchAll(/import\s*\(\s*(['"`])https?:\/\//g))
      offenders.push(`${f}: dynamic import(${m[0].slice(-30)})`);
  }
  assert.deepEqual(offenders, [], 'src/ 出现直连外网请求目标——浏览器侧只许调用本机同源服务');
});
