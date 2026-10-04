import { defineConfig, type ViteDevServer } from 'vite';
import wasm from 'vite-plugin-wasm';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { visualizer } from 'rollup-plugin-visualizer';
import pkg from './package.json';
// Gathers the scene data and runs the asset pipeline on file changes
import { sceneGathererPlugin } from './devTools/sceneGathererPlugin.ts';
// Ships only the asset pipeline outputs the production data loads
import { assetOutputsBuildPlugin } from './devTools/assetOutputsBuildPlugin.ts';

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

const createVersionHash = (inputString: string) => {
  let hash = 5381; // Starting seed
  let i = inputString.length;
  while (i) {
    hash = (hash * 33) ^ inputString.charCodeAt(--i);
  }
  return (hash >>> 0).toString(16).toUpperCase();
};

const createVersionChecksumString = (m?: typeof meta) => {
  if (!m) return '';
  const appVersion = m.app?.version;
  const appCodename = m.app?.codename;
  const engVersion = m.engine?.version;
  const engCodename = m.engine?.codename;
  const tkVersion = m.toolkit?.version;
  const tkCodename = m.toolkit?.codename;
  const pkgVersion = m.pkgVersion;
  return `${appVersion}-${appCodename}_${engVersion}-${engCodename}_${tkVersion}-${tkCodename}_${pkgVersion}`;
};

const appVersion = pkg.app_metadata?.version || (pkg.version ? `${pkg.version}-pkg` : '');
const engineVersion = pkg.engine_metadata?.version || (pkg.version ? `${pkg.version}-pkg` : '');
const meta = {
  app: {
    version: appVersion,
    codename: pkg?.app_metadata?.codename || '',
    name: pkg?.app_metadata?.name || pkg?.name || '',
    fullName: pkg?.app_metadata.fullName || '',
    description: pkg?.app_metadata?.description || pkg?.description || '',
    url: pkg.app_metadata?.url || '',
    repoUrl: pkg.repository || '',
    author: pkg.author || '',
  },
  engine: {
    version: engineVersion,
    codename: pkg.engine_metadata?.codename || '',
    name: pkg.engine_metadata?.name || pkg.name || '',
    fullName: pkg?.engine_metadata.fullName || '',
    description: pkg?.engine_metadata?.description || pkg?.description || '',
    url: pkg.engine_metadata?.url || '',
    repoUrl: pkg.engine_metadata?.repository || pkg.repository || '',
    author: pkg.engine_metadata?.author || '',
  },
  // Ships with the engine, so the repo and author default to the engine's
  toolkit: {
    version: pkg.toolkit_metadata?.version || '',
    codename: pkg.toolkit_metadata?.codename || '',
    name: pkg.toolkit_metadata?.name || '',
    fullName: pkg.toolkit_metadata?.fullName || '',
    description: pkg.toolkit_metadata?.description || '',
    url: pkg.toolkit_metadata?.url || '',
    repoUrl: pkg.engine_metadata?.repository || pkg.repository || '',
    author: pkg.engine_metadata?.author || '',
  },
  pkgVersion: pkg.version || '',
  versionChecksum: '',
  versionChecksumString: '',
};
const checksumString = createVersionChecksumString(meta);
meta.versionChecksumString = checksumString;
meta.versionChecksum = createVersionHash(checksumString);

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
  optimizeDeps: {
    // Deps only the assets worker imports: Vite's dep scan doesn't follow `?worker` imports, so
    // without these, the first dev run re-optimizes when the worker starts and reloads the page
    include: [
      'three/addons/loaders/HDRLoader.js',
      'three/addons/loaders/KTX2Loader.js',
      'three/addons/libs/meshopt_decoder.module.js',
    ],
  },
  server: {
    fs: {
      strict: false,
    },
  },
  plugins: [
    crossOriginIsolationPlugin(),
    wasm(),
    // `yarn dev:https`: a self-signed certificate, so a phone on the LAN gets a secure context
    // (WebGPU, SharedArrayBuffer); a plain http:// LAN address isn't one
    ...(process.env.AEK_DEV_HTTPS === 'true' ? [basicSsl()] : []),
    sceneGathererPlugin(),
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
