import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readAr, readCpio, readTar, readXar, type ArchiveEntry } from './archives';

/**
 * Finds the KTX-Software `ktx` CLI (the KTX2 / Basis Universal encoder, p300 DD4), and sets up a
 * local copy when there is none: no system install, no sudo. Supported: Linux (incl. WSL2) and
 * macOS, on x64 and arm64. The pinned release is downloaded from GitHub, checked against the
 * SHA-256 pinned here and unpacked (with Node alone) into the gitignored `.tools/ktx-<version>/`:
 * `bin/ktx` plus the one library it loads from `../lib`.
 *
 * Lookup order: the `AEK_KTX` env var (path to a `ktx` binary; an error if it doesn't work), the
 * local copy, then a `ktx` on PATH. Any of them must be at least {@link MIN_KTX_VERSION}.
 */

export const KTX_VERSION = '4.4.2';
/** `ktx create` (the one-command encoder the pipeline uses) arrived in 4.3 */
export const MIN_KTX_VERSION = '4.3.0';
/** The prebuilt Linux binaries need this glibc (Ubuntu 22.04+, Debian 12+, Fedora 35+) */
const MIN_GLIBC_VERSION = '2.34';

const RELEASE_URL = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}`;

type Release = {
  file: string;
  sha256: string;
  format: 'deb' | 'pkg';
  /** The library name the `ktx` binary loads (its NEEDED / @rpath entry) */
  libName: string;
};

// Khronos publishes SHA-1 files for some assets only (none for the macOS packages): these are
// the SHA-256s of the v4.4.2 assets, taken when the version was pinned. Update them with it.
const RELEASES: Record<string, Release> = {
  'linux-x64': {
    file: `KTX-Software-${KTX_VERSION}-Linux-x86_64.deb`,
    sha256: 'ca635ed489d8bf54fac8d7687056c651193de0740830a7738cc034adc63e3027',
    format: 'deb',
    libName: 'libktx.so.4',
  },
  'linux-arm64': {
    file: `KTX-Software-${KTX_VERSION}-Linux-arm64.deb`,
    sha256: '654e9fb9323e1fe89255939952c4f4867692ab1f4e8f71df2b4e04de1802b113',
    format: 'deb',
    libName: 'libktx.so.4',
  },
  'darwin-arm64': {
    file: `KTX-Software-${KTX_VERSION}-Darwin-arm64.pkg`,
    sha256: '500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c',
    format: 'pkg',
    libName: 'libktx.4.dylib',
  },
  'darwin-x64': {
    file: `KTX-Software-${KTX_VERSION}-Darwin-x86_64.pkg`,
    sha256: 'efecc685ab891a6e119a9fdc8cbe038e135f9a367eb2f5d8a059553f947f1fea',
    format: 'pkg',
    libName: 'libktx.4.dylib',
  },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const KTX_TOOL_DIR = path.join(ROOT, '.tools', `ktx-${KTX_VERSION}`);
const LOCAL_KTX_PATH = path.join(KTX_TOOL_DIR, 'bin', 'ktx');

export type KtxTool = {
  /** Absolute path of the `ktx` binary (or `ktx` when it was found on PATH) */
  path: string;
  version: string;
  source: 'env' | 'local' | 'path';
};

type Log = (message: string) => void;

const compareVersions = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
};

/** Runs `<binary> --version`: returns the version, or the reason it couldn't. */
const probeKtx = (binary: string): { version: string } | { error: string } => {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf-8' });
  if (result.error) return { error: result.error.message };
  const output = `${result.stdout}${result.stderr}`;
  const version = output.match(/v?(\d+\.\d+\.\d+)/)?.[1];
  if (result.status !== 0 || !version) {
    return { error: output.trim() || `exited with code ${result.status}` };
  }
  return { version };
};

/** The release asset for this platform, or why there is none. */
const getRelease = (): Release | { error: string } => {
  const { platform, arch } = process;
  if (platform === 'win32') {
    return {
      error:
        'native Windows is not supported: run the project in WSL2 (or set AEK_KTX to a ktx binary).',
    };
  }
  const release = RELEASES[`${platform}-${arch}`];
  if (!release) {
    return {
      error: `no prebuilt KTX-Software for ${platform}-${arch}: install KTX-Software ≥ ${MIN_KTX_VERSION} and put ktx on PATH (or set AEK_KTX).`,
    };
  }
  if (platform === 'linux') {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
    const glibc = report?.header?.glibcVersionRuntime;
    if (!glibc) {
      return {
        error: `the prebuilt KTX-Software needs glibc (this Linux has none, eg. Alpine): install KTX-Software ≥ ${MIN_KTX_VERSION} and put ktx on PATH (or set AEK_KTX).`,
      };
    }
    if (compareVersions(glibc, MIN_GLIBC_VERSION) < 0) {
      return {
        error: `the prebuilt KTX-Software needs glibc ≥ ${MIN_GLIBC_VERSION} (this system has ${glibc}): install KTX-Software ≥ ${MIN_KTX_VERSION} and put ktx on PATH (or set AEK_KTX).`,
      };
    }
  }
  return release;
};

/**
 * Finds a working `ktx` ≥ {@link MIN_KTX_VERSION} without downloading anything, or returns
 * null. Throws when `AEK_KTX` is set but doesn't point to one.
 */
export const findKtx = (): KtxTool | null => {
  const envPath = process.env.AEK_KTX;
  if (envPath) {
    const probe = probeKtx(envPath);
    if ('error' in probe) throw new Error(`AEK_KTX="${envPath}" doesn't run: ${probe.error}`);
    if (compareVersions(probe.version, MIN_KTX_VERSION) < 0) {
      throw new Error(
        `AEK_KTX="${envPath}" is ktx ${probe.version}, the pipeline needs ≥ ${MIN_KTX_VERSION}.`
      );
    }
    return { path: envPath, version: probe.version, source: 'env' };
  }

  const candidates: [string, KtxTool['source']][] = [
    [LOCAL_KTX_PATH, 'local'],
    ['ktx', 'path'],
  ];
  for (const [binary, source] of candidates) {
    if (source === 'local' && !fs.existsSync(binary)) continue;
    const probe = probeKtx(binary);
    if ('version' in probe && compareVersions(probe.version, MIN_KTX_VERSION) >= 0) {
      return { path: binary, version: probe.version, source };
    }
  }
  return null;
};

const download = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
};

/** All files and symlinks in the release archive. */
const readReleaseEntries = (archive: Buffer, release: Release): ArchiveEntry[] => {
  if (release.format === 'deb') {
    const dataTar = readAr(archive).find(({ name }) => name.startsWith('data.tar'));
    if (!dataTar) throw new Error(`${release.file}: no data.tar member`);
    if (!dataTar.name.endsWith('.gz') && !dataTar.name.endsWith('.tar')) {
      throw new Error(`${release.file}: unsupported ${dataTar.name}`);
    }
    return readTar(dataTar.data);
  }
  return readXar(archive)
    .filter(({ name }) => name === 'Payload')
    .flatMap(({ data }) => readCpio(data));
};

/** The entry at `entryPath`, following symlinks inside the archive. */
const resolveEntry = (entries: ArchiveEntry[], entryPath: string, hops = 0): ArchiveEntry => {
  const entry = entries.find((e) => e.path === entryPath);
  if (!entry) throw new Error(`"${entryPath}" not found in the release archive`);
  if (entry.linkTarget === undefined) return entry;
  if (hops > 8) throw new Error(`Symlink loop at "${entryPath}"`);
  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(entryPath), entry.linkTarget)
  );
  return resolveEntry(entries, target, hops + 1);
};

/**
 * Downloads, verifies and unpacks the pinned KTX-Software into {@link KTX_TOOL_DIR} (replacing
 * what is there), then checks that the binary runs.
 */
export const installLocalKtx = async (log: Log = () => {}): Promise<KtxTool> => {
  const release = getRelease();
  if ('error' in release) throw new Error(`Can't set up KTX-Software: ${release.error}`);

  const url = `${RELEASE_URL}/${release.file}`;
  log(`Downloading ${url}`);
  const archive = await download(url);
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  if (sha256 !== release.sha256) {
    throw new Error(
      `${release.file}: SHA-256 mismatch (expected ${release.sha256}, got ${sha256}). Nothing was installed.`
    );
  }

  const entries = readReleaseEntries(archive, release);
  const binary = entries.find((e) => /(^|\/)bin\/ktx$/.test(e.path));
  const library = entries.find((e) => e.path.endsWith(`/lib/${release.libName}`));
  if (!binary || !library) {
    throw new Error(`${release.file}: bin/ktx or lib/${release.libName} not found in the archive`);
  }

  // Unpacked next to the final folder, then swapped in, so a failed run leaves no half install.
  // The library is written as a real file under the name the binary loads (no symlinks, which
  // a Windows-mounted WSL2 drive may not support).
  const tempDir = `${KTX_TOOL_DIR}.tmp-${process.pid}`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tempDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'bin', 'ktx'), resolveEntry(entries, binary.path).data, {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(tempDir, 'lib', release.libName),
    resolveEntry(entries, library.path).data,
    { mode: 0o644 }
  );
  fs.writeFileSync(
    path.join(tempDir, 'SOURCE.txt'),
    `KTX-Software ${KTX_VERSION} (Apache-2.0), from ${url}\nSHA-256 ${sha256}\nSet up by devTools/setupAssetTools.ts. Delete this folder to remove it.\n`
  );

  const probe = probeKtx(path.join(tempDir, 'bin', 'ktx'));
  if ('error' in probe) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`The downloaded ktx doesn't run on this system: ${probe.error}`);
  }
  fs.rmSync(KTX_TOOL_DIR, { recursive: true, force: true });
  fs.renameSync(tempDir, KTX_TOOL_DIR);
  log(`Installed ktx ${probe.version} into ${path.relative(ROOT, KTX_TOOL_DIR)}/`);
  return { path: LOCAL_KTX_PATH, version: probe.version, source: 'local' };
};

/**
 * Returns a working `ktx` (see the lookup order above), setting up the local copy when there
 * is none. Throws with an actionable message when that isn't possible.
 * @param opts.force reinstall the local copy even when a working `ktx` is found
 */
export const ensureKtx = async (opts: { force?: boolean; log?: Log } = {}) => {
  if (!opts.force) {
    const found = findKtx();
    if (found) return found;
  }
  return installLocalKtx(opts.log);
};

/**
 * The environment for child processes that spawn `ktx` themselves (the gltf-transform CLI's
 * `etc1s` / `uastc` commands look it up on PATH): PATH with the found binary's folder first.
 */
export const getKtxEnv = (tool: KtxTool): NodeJS.ProcessEnv => {
  if (tool.source === 'path') return process.env;
  return {
    ...process.env,
    PATH: `${path.dirname(path.resolve(tool.path))}${path.delimiter}${process.env.PATH || ''}`,
  };
};
