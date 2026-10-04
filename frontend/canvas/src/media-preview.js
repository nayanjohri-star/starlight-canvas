import { el, modal, toast, fmtBytes } from './ui.js';
import { getFingerprint } from './keyvault.js';

export async function openMediaPreview({ store, assets, assetId }) {
  const project = store.project, asset = project?.assets?.[assetId], fp = getFingerprint();
  const current = () => store.project === project && project.assets[assetId] === asset &&
    !asset.missing && !asset.deletedAt && getFingerprint() === fp;
  if (!asset || !current()) return;
  let blob;
  try { blob = await assets.blobOf(assetId); }
  catch { if (current()) toast('本地素材读取失败，请重试', 'err'); return; }
  if (!current()) return;
  if (!blob) { toast('本地文件缺失，请重新绑定素材', 'err'); return; }
  const url = URL.createObjectURL(blob);
  const tag = { image: 'img', video: 'video', audio: 'audio' }[asset.kind] || 'p';
  const media = el(tag,
    { src: url, alt: asset.name, ...(asset.kind !== 'image' ? { controls: true, playsinline: true } : {}) });
  const stage = el('div', { class: 'media-preview-stage', tabindex: '0', 'aria-label': '素材大图，可滚动查看放大后的内容' }, media);
  const info = el('span', { class: 'hint', text: fmtBytes(asset.size) });
  const zoom = el('span', { class: 'media-preview-zoom', 'aria-live': 'polite' });
  let scale = 1, width = 0, height = 0, fit = true, closed = false;
  function render() {
    if (!width || !height) return;
    if (fit) scale = Math.min(1, (stage.clientWidth - 24) / width, (stage.clientHeight - 24) / height);
    media.style.width = `${Math.max(1, width * scale)}px`;
    media.style.height = `${Math.max(1, height * scale)}px`;
    zoom.textContent = `${Math.round(scale * 100)}%`;
    info.textContent = `${width} × ${height} · ${fmtBytes(asset.size)}`;
  }
  const button = (label, action) => el('button', { type: 'button', text: label, onclick: action });
  const change = factor => { fit = false; scale = Math.max(.02, Math.min(8, scale * factor)); render(); };
  const toolbar = el('div', { class: 'media-preview-toolbar' },
    button('缩小', () => change(1 / 1.5)), zoom, button('放大', () => change(1.5)),
    button('适应窗口', () => { fit = true; render(); }), button('原始大小', () => { fit = false; scale = 1; render(); }), info);
  if (!['image', 'video'].includes(asset.kind)) toolbar.hidden = true;
  if (tag === 'p') media.textContent = `${asset.name} · ${fmtBytes(asset.size)}（此格式不支持媒体预览）`;
  let off = () => {}, observer, removed;
  const dialog = modal(el('div', { class: 'media-preview' }, el('h3', { text: asset.name }), toolbar, stage), {
    wide: true, onClose: () => {
      closed = true; off(); observer?.disconnect(); removed?.disconnect();
      media.pause?.(); media.removeAttribute('src'); media.load?.(); URL.revokeObjectURL(url);
    },
  });
  dialog.box.classList.add('media-preview-dialog');
  const ready = () => { if (closed) return; width = media.naturalWidth || media.videoWidth; height = media.naturalHeight || media.videoHeight; render(); };
  media.addEventListener(asset.kind === 'image' ? 'load' : 'loadedmetadata', ready);
  media.addEventListener('error', () => { if (!closed) info.textContent = '素材无法解码，请检查原文件'; });
  if (media.complete) ready();
  off = store.onChange(() => { if (!current()) dialog.close(); });
  observer = new ResizeObserver(() => { if (!current()) dialog.close(); else render(); }); observer.observe(stage);
  removed = new MutationObserver(() => { if (!dialog.box.isConnected) dialog.close(); });
  removed.observe(document.getElementById('overlay-root'), { childList: true });
  return dialog;
}
