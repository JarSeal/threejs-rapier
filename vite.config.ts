import { defineConfig } from 'vite';

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
});
