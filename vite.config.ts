import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import pkg from './package.json';

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
  define: {
    __ENGINE_VERSION__: JSON.stringify(pkg.version),
  },
});
