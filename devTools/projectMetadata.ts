import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The project's metadata: the engine, toolkit and app versions and codenames, the packages, and
 * the build's commit and time. `vite.config.ts` defines it as `__PROJECT_METADATA__` (the About
 * dialog) and fills `index.html`'s placeholders with it; the Hub generator puts its versions and
 * build into `hub-data.js` and the Version page.
 */

type PackageJson = typeof import('../package.json');

const PACKAGE_JSON_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../package.json'
);

const createVersionHash = (inputString: string) => {
  let hash = 5381; // Starting seed
  let i = inputString.length;
  while (i) {
    hash = (hash * 33) ^ inputString.charCodeAt(--i);
  }
  return (hash >>> 0).toString(16).toUpperCase();
};

const createVersionChecksumString = (m?: ProjectMetadata) => {
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

/** A git command's output, or '' when git or the repo isn't there. */
export const readGit = (args: string) => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
};

const buildProjectMetadata = (pkg: PackageJson) => {
  const appVersion = pkg.app_metadata?.version || (pkg.version ? `${pkg.version}-pkg` : '');
  const engineVersion = pkg.engine_metadata?.version || (pkg.version ? `${pkg.version}-pkg` : '');
  return {
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
    license: pkg.license || '',
    // The About dialog's package list: the runtime dependencies and the main build tools
    packages: { ...pkg.dependencies } as Record<string, string>,
    buildTools: {
      vite: pkg.devDependencies.vite,
      typescript: pkg.devDependencies.typescript,
    } as Record<string, string>,
    // The commit and time of this build (the dev server's start in dev)
    build: {
      commit: readGit('rev-parse --short HEAD'),
      hasLocalChanges: readGit('status --porcelain --untracked-files=no') !== '',
      time: new Date().toISOString(),
    },
    versionChecksum: '',
    versionChecksumString: '',
  };
};

export type ProjectMetadata = ReturnType<typeof buildProjectMetadata>;

/**
 * The metadata from `package.json` as it is on disk now (read on every call, so a long-running
 * process like the dev server sees a version bump), with the git state at the time of the call.
 */
export const getProjectMetadata = (): ProjectMetadata => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_FILE, 'utf-8')) as PackageJson;
  const meta = buildProjectMetadata(pkg);
  const checksumString = createVersionChecksumString(meta);
  meta.versionChecksumString = checksumString;
  meta.versionChecksum = createVersionHash(checksumString);
  return meta;
};
