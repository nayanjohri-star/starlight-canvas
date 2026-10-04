import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localOnlyFontResolver } from './tools/local-font-resolver.mjs';

// This build contains the editor only. Every asset stays relative to the
// immutable canvas release directory, including workers and decoder WASM.
export default defineConfig({
  base: './',
  plugins: [{ name: 'starlight-html-line-endings', transformIndexHtml: {
    // Run before Vite removes module scripts: CRLF can otherwise leave an
    // extra CR behind. Preserve author whitespace and never rewrite the input.
    order: 'pre', handler: html => html.replace(/\r\n?/g, '\n'),
  } }, { name: 'starlight-local-only-fonts', enforce: 'pre', transform(source, id) {
    // Troika's package.module bundles this factory into dist; its standalone
    // libs entry is also used by the resolver verification and alternate imports.
    if (/\/troika-three-text\/(?:libs\/unicode-font-resolver-client\.factory\.js|dist\/troika-three-text\.esm\.js)$/.test(id.replaceAll('\\', '/')))
      return { code: localOnlyFontResolver(source), map: null };
  } }, react()],
  define: {
    'import.meta.env.VITE_SOURCE_CODE_URL': JSON.stringify('./source.zip'),
    'import.meta.env.VITE_DEMO_PROMPT_MAX_CHARS': JSON.stringify('4000'),
    'import.meta.env.VITE_COZYCLAY_LIVE_PORT': JSON.stringify('0'),
  },
  build: { rollupOptions: { input: 'index.html' } },
});
