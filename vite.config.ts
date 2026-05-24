import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import pkg from './package.json';
// @ts-expect-error - Standalone JS script lacks type declarations
import { gatherSceneData, OUTPUT_FILE_DATA, OUTPUT_FILE_FN } from './devTools/gatherSceneData.js';

// --- Custom Vite Plugin for gathering scene data ---
const sceneGathererPlugin = () => ({
  name: 'vite-plugin-scene-gatherer',

  // Fires on dev mode whenever ANY file is saved
  handleHotUpdate({ file }: { file: string }) {
    // CRITICAL SAFEGUARD: Do not re-run if the file that changed is our own output file.
    // Otherwise, writing the file will trigger an infinite compilation loop.
    if (file === OUTPUT_FILE_DATA || file === OUTPUT_FILE_FN) return;

    // Re-gather data on any file modification
    gatherSceneData();
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
  ],
  define: {
    __PROJECT_METADATA__: meta,
  },
});
