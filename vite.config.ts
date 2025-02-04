import { defineConfig, loadEnv } from 'vite';
import wasm from 'vite-plugin-wasm';

const env = loadEnv('', process.cwd());

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
