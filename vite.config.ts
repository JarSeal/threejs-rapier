import { defineConfig, type ViteDevServer } from 'vite';
import wasm from 'vite-plugin-wasm';
import { visualizer } from 'rollup-plugin-visualizer';
import pkg from './package.json';
import {
  gatherSceneData,
  isFilePathValid,
  OUTPUT_FILE_DATA,
  OUTPUT_FILE_FN,
} from './devTools/gatherAppData.ts';

// --- Custom Vite Plugin for gathering scene data ---
const sceneGathererPlugin = () => ({
  name: 'vite-plugin-scene-gatherer',
  configureServer(server: ViteDevServer) {
    const handleFileEvent = (filePath: string) => {
      if (filePath === OUTPUT_FILE_DATA || filePath === OUTPUT_FILE_FN) return;

      if (isFilePathValid(filePath)) {
        const isSuccess = gatherSceneData();
        if (isSuccess) {
          server.hot.send({ type: 'full-reload' });
        } else {
          server.ws.send({
            type: 'error',
            err: {
              message: '[Scene Pipeline Error] Consolidation Failed',
              stack: 'Check your backend terminal terminal console for tracking logs.',
              plugin: 'vite-plugin-scene-gatherer',
            },
          });
        }
      }
    };
    server.watcher.on('add', handleFileEvent); // Catches: New files created or moved into src
    server.watcher.on('change', handleFileEvent); // Catches: Standard manual file saves
    server.watcher.on('unlink', handleFileEvent); // Catches: Files deleted or moved out/renamed
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

const createMergeVersion = (appVersion?: string, engineVersion?: string) => {
  const semverRegex = /(\d+)\.(\d+)\.(\d+)/;
  const parse = (v: unknown) => {
    const match = String(v).match(semverRegex);
    if (!match) return [0, 0, 0];
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  };
  const [aMajor, aMinor, aPatch] = parse(appVersion);
  const [eMajor, eMinor, ePatch] = parse(engineVersion);
  const mergedMajor = aMajor + eMajor;
  const mergedMinor = aMinor + eMinor;
  const mergedPatch = aPatch + ePatch;
  return `${mergedMajor}.${mergedMinor}.${mergedPatch}`;
};

const createVersionChecksumString = (m?: typeof meta) => {
  if (!m) return '';
  const mergeVersion = createMergeVersion(m.app?.version, m.engine?.version);
  const appVersion = m.app?.version;
  const appCodename = m.app?.codename;
  const engVersion = m.engine?.version;
  const engCodename = m.engine?.codename;
  const pkgVersion = m.pkgVersion;
  return `${mergeVersion}_${appVersion}-${appCodename}_${engVersion}-${engCodename}_${pkgVersion}`;
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
  pkgVersion: pkg.version || '',
  mergeVersion: createMergeVersion(appVersion, engineVersion),
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
  server: {
    fs: {
      strict: false,
    },
  },
  plugins: [
    wasm(),
    sceneGathererPlugin(),
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
            VERSION_CHECKSUM: meta.versionChecksum,
            MERGE_VERSION: meta.mergeVersion,
          };
          return flatMeta[key as keyof typeof flatMeta] || match;
        });
      },
    },
    visualizer({
      title: meta.app.name,
      filename: './dist-stats/bundle-stats.html',
      open: true,
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
