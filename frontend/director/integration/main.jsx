// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRoot } from 'react-dom/client';
import { createDirectorClient } from './client.js';
import { installDirectorRuntime } from './runtime.js';
import { configureTextBuilder } from 'troika-three-text';
import './hosted.css';
let releaseBoot = () => {};

async function boot() {
  const query = new URLSearchParams(location.search);
  const scope = Object.fromEntries(['sessionId', 'projectId', 'nodeId'].map(key => [key, query.get(key)]));
  if (parent === window || Object.values(scope).some(value => !value))
    throw new Error('请登录星光画布，并从导演场景打开导演台。');
  const client = createDirectorClient({ scope });
  releaseBoot = () => client.dispose();
  const ready = await client.request('ready');
  const runtime = installDirectorRuntime(window, `${ready.accountScope}:${scope.projectId}:${scope.nodeId}`);
  configureTextBuilder({
    defaultFontURL: new URL('./fonts/unicode-local/font-files/noto-sc/sans-serif.normal.400.woff', location.href).href,
    unicodeFontsURL: new URL('./fonts/unicode-local', location.href).href,
  });
  const root = createRoot(document.getElementById('root'));
  releaseBoot = () => { client.dispose(); root.unmount(); runtime.dispose(); };
  client.onClose(() => { root.unmount(); runtime.dispose(); });
  window.addEventListener('pagehide', () => { client.dispose(); runtime.dispose(); }, { once: true });
  let initialProject = null;
  if (ready.document) {
    const { projectRef, projectSha256 } = ready.document.scene ?? {};
    if (!projectRef?.startsWith('xp-asset://')) throw new Error('工程格式不受支持。原工程已保留，请导出原包后再迁移。');
    const asset = await client.request('asset.read', { assetId: projectRef.slice(11), sha256: projectSha256 });
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', asset.bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== projectSha256) throw new Error('工程素材摘要不符，已停止加载并保留上一次存档。');
    const { readProjectDocument } = await import('../src/project.js');
    const result = readProjectDocument(new TextDecoder().decode(asset.bytes));
    if (!result.ok || result.problems?.length) throw new Error(`工程无法完整恢复：${result.reason || result.problems.map(item => `${item.id}: ${item.code}`).join('；')}`);
    initialProject = result.project;
  }
  runtime.storage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: '导演工程' }));
  runtime.storage.setItem('cozyclay.locale', 'zh-CN');
  window.__starlightDirectorSession = { client, record: ready.document, initialProject, legacy: ready.legacy,
    videoModels: ready.videoModels ?? [], modelCatalogVerified: ready.modelCatalogVerified === true };
  window.__starlightDirectorSession.textModels = ready.textModels ?? [];
  const [{ default: App }, { default: ErrorBoundary }] = await Promise.all([import('../src/App.jsx'), import('../src/error-boundary.jsx'), import('../src/styles.css')]);
  document.documentElement.lang = 'zh-CN';
  document.documentElement.classList.add('starlight-hosted');
  root.render(<><div id="hosted-director-bar" /><ErrorBoundary><App /></ErrorBoundary></>);
}

boot().catch(error => {
  releaseBoot();
  const container = document.getElementById('root');
  container.replaceChildren();
  const message = document.createElement('p');
  message.setAttribute('role', 'alert'); message.textContent = error.message;
  container.append(message);
});
