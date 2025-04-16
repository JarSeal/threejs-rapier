import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  root: './src',
  build: {
    emptyOutDir: true,
    outDir: './../dist',
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    manifest: true,
    minify: true,
    reportCompressedSize: true,
  },
  server: {
    fs: {
      strict: false,
    },
  },
  plugins: [wasm()],
});
