import { el, modal, toast } from './ui.js';
import { createSiteClient } from './api.js';
import * as keyvault from './keyvault.js';
import { getProvider, providerList, saveProvider } from './providers.js';
import { DEFAULT_PROVIDER, normalizeProvider, manualCatalog, isExternalProvider, providerContext } from './provider-config.js';
import { chatModelIdsFromCatalog, imageModelIds, modelIds } from './capabilities.js';

export function openProviderSettings({ runner, onChanged }) {
  const active = getProvider();
  const selector = el('select', { 'aria-label': 'API 服务商' }, providerList().map(p => el('option', { value: p.id, text: p.name, selected: p.id === active.id })));
  selector.append(el('option', { value: '__new', text: '添加服务商…' }));
  const name = el('input', { 'aria-label': '服务商名称', maxlength: 80 });
  const address = el('input', { 'aria-label': 'API 地址', type: 'url', placeholder: 'https://api.example.com/v1', autocomplete: 'off' });
  const protocol = el('select', { 'aria-label': '接口协议' },
    el('option', { value: 'openai', text: 'OpenAI 兼容（文本 / 图片）' }),
    el('option', { value: 'site', text: '画布兼容（Image 2.5 / 视频任务）' }));
  const text = el('textarea', { 'aria-label': '手动文本型号', rows: 2, placeholder: '每行一个型号，可留空自动读取' });
  const image = el('textarea', { 'aria-label': '手动图片型号', rows: 2, placeholder: '如 gpt-image-1，每行一个型号' });
  const video = el('input', { type: 'checkbox', 'aria-label': '启用兼容视频任务' });
  const key = el('input', { type: 'password', 'aria-label': 'API 密钥', autocomplete: 'off' });
  const info = el('div', { class: 'modal-body', role: 'status' });
  const apply = el('button', { type: 'button', class: 'primary', text: '校验并保存到内存' });
  const clear = el('button', { type: 'button', text: '清除密钥' });
  const videoRow = el('label', { class: 'hint' }, video, ' 启用兼容视频任务（接口须支持画布上传、查询、下载及幂等提交合同）');
  const field = (label, control) => el('div', { class: 'field' }, el('label', { text: label }), control);
  const content = el('div', {}, el('h3', { text: 'API 服务商' }),
    field('服务商', selector), field('名称', name), field('API 地址', address), field('协议', protocol),
    field('文本型号（可选）', text), field('图片型号（OpenAI 兼容）', image), videoRow, field('API 密钥', key),
    el('p', { class: 'hint', text: '地址和型号仅保存在当前浏览器；密钥仅存内存。校验只读取型号，不生成、不扣生成费。刷新后需重新输入密钥。' }),
    el('p', { class: 'hint', text: '切换接口后，原接口的任务暂停；使用原地址、协议和密钥可继续查询。外部 API 由对应服务商扣费。' }),
    info, el('div', { class: 'modal-actions' }, clear, apply));
  let id = active.id, alive = true;
  const { close } = modal(content, { onClose: () => { alive = false; key.value = ''; } });
  const protocolChanged = () => {
    videoRow.hidden = protocol.value !== 'site';
    if (protocol.value !== 'site') video.checked = false;
    image.disabled = protocol.value === 'site';
  };
  function fill() {
    const p = providerList().find(p => p.id === selector.value) ?? { id: crypto.randomUUID(), name: '', baseUrl: '', protocol: 'openai', textModels: [], imageModels: [], videoEnabled: false };
    id = p.id;
    const fixed = id === DEFAULT_PROVIDER.id;
    name.value = p.name; address.value = p.baseUrl; protocol.value = p.protocol;
    text.value = p.textModels.join('\n'); image.value = p.imageModels.join('\n'); video.checked = p.videoEnabled;
    name.disabled = address.disabled = protocol.disabled = video.disabled = fixed;
    text.disabled = fixed;
    key.placeholder = fixed ? '粘贴本站 API Key（仅存内存，不落地）' : '粘贴该服务商的 API Key';
    key.value = p.id === getProvider().id ? keyvault.getKey() ?? '' : '';
    info.replaceChildren(); protocolChanged();
  }
  selector.addEventListener('change', fill); protocol.addEventListener('change', protocolChanged); fill();
  apply.addEventListener('click', async () => {
    apply.disabled = selector.disabled = clear.disabled = true;
    const secret = key.value.trim();
    const fp = keyvault.getFingerprint(), context = providerContext(getProvider());
    try {
      const candidate = normalizeProvider({ id, name: name.value, baseUrl: address.value, protocol: protocol.value,
        textModels: text.value, imageModels: image.value, videoEnabled: video.checked });
      if (!secret || /\s/.test(secret)) throw new Error('请输入有效 API 密钥');
      const probe = createSiteClient({ getKey: () => secret, getProvider: () => candidate });
      let entries, manual = false;
      try {
        const res = await probe.listModels();
        if (!Array.isArray(res?.data)) throw new Error('型号目录响应无效');
        entries = res.data;
      } catch (e) {
        if (!isExternalProvider(candidate) || ![404, 405].includes(e.status) || !manualCatalog(candidate).length) throw e;
        entries = []; manual = true;
      }
      if (!alive) return;
      if (keyvault.getFingerprint() !== fp || context !== providerContext(getProvider())) throw new Error('当前密钥或服务商已变更，本次校验作废');
      const override = manualCatalog(candidate), ids = new Set(override.map(x => x.id));
      entries = [...entries.filter(x => !ids.has(typeof x === 'string' ? x : x?.id)), ...override];
      saveProvider(candidate);
      await keyvault.setKey(secret);
      if (!alive) { keyvault.clearKey(); return; }
      const availableIds = entries.map(x => typeof x === 'string' ? x : x?.id).filter(Boolean);
      keyvault.setModelCatalog(entries); keyvault.setAvailableModels(availableIds);
      keyvault.setSitePricing(null);
      info.replaceChildren(el('p', { class: 'hint', text: `${manual ? '目录接口不可用，已采用手动型号' : '连接校验通过'}。文本 ${chatModelIdsFromCatalog(entries).length} 个，图片 ${imageModelIds().filter(keyvault.isModelUsable).length} 个，视频 ${candidate.videoEnabled ? modelIds().filter(keyvault.isModelUsable).length : 0} 个。实际生成由服务商计费。` }));
      await onChanged?.(); await runner.resumeAll();
      setTimeout(() => { if (alive) close(); }, 1600);
    } catch (e) {
      info.replaceChildren(el('p', { class: 'err-text', text: `校验失败：${String(e.message).split(secret || '\u0000').join('[密钥已隐藏]')}` }));
    } finally { apply.disabled = selector.disabled = clear.disabled = false; }
  });
  clear.addEventListener('click', async () => {
    key.value = ''; keyvault.clearKey(); keyvault.setSitePricing(null);
    await onChanged?.(); await runner.resumeAll();
    toast('密钥已从内存清除；原任务保留，查询已暂停');
  });
}
