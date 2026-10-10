import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteDevServer } from 'vite';
import wasm from 'vite-plugin-wasm';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { visualizer } from 'rollup-plugin-visualizer';
// Gathers the scene data and runs the asset pipeline on file changes
import { sceneGathererPlugin } from './devTools/sceneGathererPlugin.ts';
// Ships only the asset pipeline outputs the production data loads
import { assetOutputsBuildPlugin } from './devTools/assetOutputsBuildPlugin.ts';
// Lets debug tooling write files into the repo (p342)
import { devFilesPlugin } from './devTools/devFilesPlugin.ts';
// Serves the Ækasha Hub at /hub/ and rebuilds it on save (p551)
import { hubPlugin } from './devTools/hubPlugin.ts';
import { getProjectMetadata } from './devTools/projectMetadata.ts';
// The public entries' import aliases (`aekasha`, `aekasha/*`, p606)
import { getViteAliases } from './devTools/aliases.ts';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

// Required for self.crossOriginIsolated/SharedArrayBuffer to be available at all in dev, so
// worker-thread physics can use the SHARED_MEMORY hot-path transport instead of automatically
// falling back to MESSAGE_BATCH (see PhysicsTransformBuffer.ts).
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Sets the headers on every response, 304s included: Vite's `server.headers` skips a 304, and
// Safari then blocks a revalidated worker script under COEP ("Worker load was blocked by
// Cross-Origin-Embedder-Policy"). Added before Vite's own middlewares, so they keep the headers.
const crossOriginIsolationPlugin = () => ({
  name: 'vite-plugin-cross-origin-isolation',
  configureServer(server: ViteDevServer) {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
        res.setHeader(name, value);
      }
      next();
    });
  },
});

// The versions, packages and build info: `__PROJECT_METADATA__` and index.html's placeholders
const meta = getProjectMetadata();

export default defineConfig({
  root: './src',
  // Workers resolve with these too
  resolve: { alias: getViteAliases(REPO_ROOT) },
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
  // ES module workers: an IIFE worker can't be code-split, and the assets worker loads the
  // meshopt simplifier on demand (docs/plans/_DONE_p347_lod-chain-generation.md, Phase 0). The dev server
  // loads workers as modules either way.
  worker: { format: 'es' },
  optimizeDeps: {
    // Deps only the assets worker imports: Vite's dep scan doesn't follow `?worker` imports, so
    // without these, the first dev run re-optimizes when the worker starts and reloads the page
    include: [
      'three/addons/loaders/HDRLoader.js',
      'three/addons/loaders/KTX2Loader.js',
      'three/addons/libs/meshopt_decoder.module.js',
      'meshoptimizer/simplifier',
      'meshoptimizer/encoder',
    ],
  },
  server: {
    // Only the repo is served through /@fs/: the dev server is on the LAN (`--host`)
    fs: {
      allow: [REPO_ROOT],
    },
  },
  plugins: [
    crossOriginIsolationPlugin(),
    wasm(),
    // `yarn dev:https`: a self-signed certificate, so a phone on the LAN gets a secure context
    // (WebGPU, SharedArrayBuffer); a plain http:// LAN address isn't one
    ...(process.env.AEK_DEV_HTTPS === 'true' ? [basicSsl()] : []),
    sceneGathererPlugin(),
    devFilesPlugin(),
    hubPlugin(),
    assetOutputsBuildPlugin(),
    {
      name: 'html-transform',
      transformIndexHtml(html) {
        return html.replace(/%(\w+)%/g, (match, key) => {
          // Flatten the metadata for easy replacement
          const flatMeta = {
            APP_NAME: meta.app.name,
            APP_FULL_NAME: meta.app.fullName,
            APP_VERSION: meta.app.version,
            APP_DESCRIPTION: meta.app.description,
            APP_AUTHOR: meta.app.author,
            APP_CODENAME: meta.app.codename,
            ENGINE_NAME: meta.engine.name,
            ENGINE_FULL_NAME: meta.engine.fullName,
            ENGINE_VERSION: meta.engine.version,
            ENGINE_CODENAME: meta.engine.codename,
            TOOLKIT_NAME: meta.toolkit.name,
            TOOLKIT_FULL_NAME: meta.toolkit.fullName,
            TOOLKIT_VERSION: meta.toolkit.version,
            TOOLKIT_CODENAME: meta.toolkit.codename,
            VERSION_CHECKSUM: meta.versionChecksum,
          };
          return flatMeta[key as keyof typeof flatMeta] || match;
        });
      },
    },
    visualizer({
      title: meta.app.name,
      filename: './dist-stats/bundle-stats.html',
      open: false,
      gzipSize: true,
      template: 'treemap',
      // exclude: [
      //   { file: '*/**/three.core.js' },
      //   { file: '*/**/rapier.mjs' },
      //   { file: '*/**/three.webgpu.js' },
      // ],
    }),
  ],
  define: {
    __PROJECT_METADATA__: meta,
  },
});
