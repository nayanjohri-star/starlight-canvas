// Only a color preference is persisted; project data and API keys are untouched.
(() => {
  const storageKey = 'xingpan-canvas-theme';
  const normalize = value => value === 'light' ? 'light' : 'dark';
  function apply(value) {
    const theme = normalize(value);
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-option]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeOption === theme));
    });
  }
  let saved;
  try { saved = localStorage.getItem(storageKey); } catch { /* This visit still supports switching. */ }
  apply(saved);
  function bind() {
    apply(document.documentElement.dataset.theme);
    document.querySelectorAll('[data-theme-option]').forEach(button => {
      button.addEventListener('click', () => {
        const theme = normalize(button.dataset.themeOption);
        apply(theme);
        try { localStorage.setItem(storageKey, theme); } catch { /* Storage may be unavailable. */ }
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) apply(event.newValue);
  });
})();
