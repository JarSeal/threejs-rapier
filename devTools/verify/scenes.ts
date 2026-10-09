/* eslint-disable no-console */
/**
 * The scene runner (`yarn verify:scenes`, p601): loads every scene of the generated data in every
 * configuration of `scenes.config.ts`, through the dev-only test bridge (`window.__AEK_TEST__`,
 * `src/_engine/debug/TestBridge.ts`), and fails on console or page errors that aren't allowed, a
 * probe hash that differs from the baseline, or a snapshot that differs beyond the tolerance.
 *
 *   yarn verify:scenes [--only <sceneId|glob>[,…]] [--config <name|set>[,…]] [--update]
 *                      [--url <url>] [--webgl] [--headed]
 *
 * Baselines are local (`.cache/verify/scenes/<backend>/`): snapshots depend on the GPU, the driver
 * and the backend. `--update` records the runs without errors as the baseline (merged: `--only`
 * updates only those scenes). The workflow is "update on `main`, then run on the branch".
 *
 * It starts its own dev server (port 8092 or the next free one) unless `--url` points at one.
 * Headless WebGPU can't render on WSL2, so there (and with `--webgl`) the page gets no
 * `navigator.gpu` and the engine renders on WebGL2 (SwiftShader): WebGPU-only regressions need a
 * `--headed` run on a real GPU.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import sharp from 'sharp';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ROOT } from '../assetPipeline/sources';
import type {
  TestBridgeProbeResult,
  TestBridgeSceneReady,
  TestBridgeSnapshot,
} from '../../src/_engine/debug/TestBridge';
import {
  DEFAULT_CONFIG_SET,
  DEFAULT_PROBE_STEPS,
  DEFAULT_SNAPSHOT_TOLERANCE,
  GLOBAL_ALLOWED_ERRORS,
  PROBE_TIMEOUT_MS,
  PROD_TEST_SETTLE_MS,
  READY_TIMEOUT_MS,
  SCENE_VERIFY_CONFIG,
  SNAPSHOT_SIZE,
  VERIFY_CONFIG_SETS,
  VERIFY_CONFIGS,
  type SnapshotTolerance,
  type VerifyConfigDef,
  type VerifyConfigName,
} from './scenes.config';

/** Bump when the baseline file's shape changes: an old one is then ignored */
const BASELINE_FORMAT_VERSION = 1;
const CACHE_DIR = path.join(ROOT, '.cache/verify/scenes');
const GENERATED_DATA = path.join(ROOT, 'src/_engine/generatedAppData.json');
/** `DEBUG_PHYSICS_API_BOOT_LS_KEY` (core/Config.ts, which reads `window` at load: not importable here) */
const PHYSICS_BOOT_LS_KEY = 'AEK_debugPhysicsApiBoot';
const VIEWPORT = { width: 1024, height: 576 };
const BRIDGE_INSTALL_TIMEOUT_MS = 120_000;

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

type Backend = 'webgpu' | 'webgl';

type Args = {
  only: string[];
  configs: VerifyConfigName[];
  update: boolean;
  url: string | null;
  webgl: boolean;
  headed: boolean;
};

type BaselineEntry = {
  hash?: string;
  steps?: number;
  probeConfig?: string;
  /** File name in the baseline folder */
  snapshot?: string;
  recordedAt: string;
  commit: string;
};

type BaselineFile = {
  formatVersion: number;
  entries: Record<string, BaselineEntry>;
};

type RunStatus = 'PASS' | 'FAIL' | 'NEW' | 'UPDATED' | 'SKIPPED';

type RunResult = {
  sceneId: string;
  config: VerifyConfigName;
  status: RunStatus;
  failures: string[];
  warnings: string[];
  notes: string[];
  errors: string[];
  hash?: string;
  steps?: number;
  probeConfig?: string;
  snapshotFile?: string;
  durationMs: number;
};

// --- Arguments ---

const fail = (msg: string): never => {
  console.error(`${RED}${msg}${RESET}`);
  process.exit(2);
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    only: [],
    configs: [],
    update: false,
    url: null,
    webgl: false,
    headed: false,
  };
  let configArg = DEFAULT_CONFIG_SET;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    if (arg === '--only') args.only.push(...value().split(','));
    else if (arg === '--config') configArg = value();
    else if (arg === '--url') args.url = value();
    else if (arg === '--update') args.update = true;
    else if (arg === '--webgl') args.webgl = true;
    else if (arg === '--headed') args.headed = true;
    else fail(`Unknown argument: ${arg}`);
  }
  const names = new Set<VerifyConfigName>();
  for (const name of configArg.split(',')) {
    if (VERIFY_CONFIG_SETS[name]) VERIFY_CONFIG_SETS[name].forEach((n) => names.add(n));
    else if (name in VERIFY_CONFIGS) names.add(name as VerifyConfigName);
    else {
      const known = [...Object.keys(VERIFY_CONFIG_SETS), ...Object.keys(VERIFY_CONFIGS)];
      fail(`Unknown configuration or set "${name}" (${known.join(', ')})`);
    }
  }
  args.configs = [...names];
  return args;
};

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

const selectScenes = (allIds: string[], only: string[]) => {
  if (!only.length) return allIds;
  const selected = new Set<string>();
  for (const pattern of only) {
    const re = globToRegExp(pattern);
    const matches = allIds.filter((id) => re.test(id));
    if (!matches.length) fail(`--only "${pattern}" matches no scene (${allIds.join(', ')})`);
    matches.forEach((id) => selected.add(id));
  }
  return allIds.filter((id) => selected.has(id));
};

// --- Environment ---

const isWSL = () => os.release().toLowerCase().includes('microsoft');

const getCommit = () => {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
};

/** A system Chrome / Chromium / Edge (the skill driver's list), else playwright-core's own */
const findBrowserExecutable = () => {
  const candidates: string[] = [];
  const platform = os.platform();
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    );
  } else {
    // Linux and WSL2 (a Windows Chrome under /mnt/c can't be driven from WSL2: the debugging
    // pipe doesn't cross the boundary)
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    );
  }
  return candidates.find((p) => fs.existsSync(p));
};

const launchBrowser = async (useWebGL: boolean, headed: boolean) => {
  const executablePath = findBrowserExecutable();
  const launchArgs = useWebGL
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    : ['--enable-unsafe-webgpu', '--enable-features=Vulkan'];
  try {
    return await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: !headed,
      args: launchArgs,
    });
  } catch (err) {
    const hint = executablePath
      ? ''
      : '\nNo system Chrome found: install one, or run `npx playwright-core install chromium` once.';
    return fail(`The browser didn't launch: ${(err as Error).message}${hint}`);
  }
};

const startOwnServer = async () => {
  process.env.VITE_APP_ENV ??= 'development';
  delete process.env.AEK_DEV_HTTPS;
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { port: 8092, host: true },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('The server has no port');
  return { server, url: `http://localhost:${address.port}` };
};

// --- Baselines ---

const readJSON = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
};

const getPaths = (backend: Backend) => {
  const dir = path.join(CACHE_DIR, backend);
  return {
    baselineFile: path.join(dir, 'baseline.json'),
    baselineDir: path.join(dir, 'baseline'),
    lastRunFile: path.join(dir, 'last-run.json'),
    lastRunDir: path.join(dir, 'last-run'),
  };
};

const readBaseline = (backend: Backend): BaselineFile => {
  const file = readJSON<BaselineFile>(getPaths(backend).baselineFile);
  if (!file || file.formatVersion !== BASELINE_FORMAT_VERSION) {
    return { formatVersion: BASELINE_FORMAT_VERSION, entries: {} };
  }
  return file;
};

const runKey = (sceneId: string, config: VerifyConfigName) => `${sceneId}|${config}`;
const snapshotFileName = (sceneId: string, config: VerifyConfigName) => `${sceneId}.${config}.png`;

// --- Snapshot comparison ---

const readRGBA = async (png: Buffer | string) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

type SnapshotDiff = { meanDelta: number; changedRatio: number; maxDelta: number };

/** Compares two RGBA8 images over RGB; when they differ beyond the tolerance, writes `diffFile`
 * (the current image dimmed, the changed pixels red) */
const compareSnapshots = async (
  currentPng: Buffer,
  baselineFile: string,
  tolerance: SnapshotTolerance,
  diffFile: string
): Promise<SnapshotDiff | { sizeMismatch: string }> => {
  const current = await readRGBA(currentPng);
  const baseline = await readRGBA(baselineFile);
  if (current.width !== baseline.width || current.height !== baseline.height) {
    return {
      sizeMismatch: `${current.width} × ${current.height}, baseline ${baseline.width} × ${baseline.height}`,
    };
  }
  const pixels = current.width * current.height;
  const diff = Buffer.alloc(pixels * 4);
  let sum = 0;
  let changed = 0;
  let maxDelta = 0;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(current.data[i + c] - baseline.data[i + c]);
      sum += d;
      if (d > pixelMax) pixelMax = d;
    }
    if (pixelMax > maxDelta) maxDelta = pixelMax;
    const isChanged = pixelMax > tolerance.pixelThreshold;
    if (isChanged) changed++;
    const grey = (current.data[i] + current.data[i + 1] + current.data[i + 2]) / 12;
    diff[i] = isChanged ? 255 : grey;
    diff[i + 1] = isChanged ? 0 : grey;
    diff[i + 2] = isChanged ? 0 : grey;
    diff[i + 3] = 255;
  }
  const result = { meanDelta: sum / (pixels * 3), changedRatio: changed / pixels, maxDelta };
  if (
    result.meanDelta > tolerance.maxMeanDelta ||
    result.changedRatio > tolerance.maxChangedRatio
  ) {
    await sharp(diff, { raw: { width: current.width, height: current.height, channels: 4 } })
      .png()
      .toFile(diffFile);
  }
  return result;
};

// --- One page load ---

const isAllowed = (sceneId: string, message: string) =>
  [...GLOBAL_ALLOWED_ERRORS, ...(SCENE_VERIFY_CONFIG[sceneId]?.allowedErrors ?? [])].some((a) =>
    a.pattern.test(message)
  );

const buildUrl = (baseUrl: string, sceneId: string, def: VerifyConfigDef, steps: number) => {
  const params = new URLSearchParams();
  params.set(def.mode === 'DEBUG' ? 'isDebug' : 'isProdTest', 'true');
  params.set('aekTest', 'true');
  params.set('startScene', sceneId);
  if (def.mode === 'DEBUG') params.set('physicsProbe', String(steps));
  return `${baseUrl.replace(/\/$/, '')}/?${params}`;
};

type LoadContext = {
  browser: Browser;
  baseUrl: string;
  useWebGL: boolean;
  /** Read on first use, per backend */
  baselines: Map<Backend, BaselineFile>;
  /** What the first page rendered on (WebGPU falls back to WebGL2 where it isn't available) */
  backend: Backend | null;
};

const getBaseline = (ctx: LoadContext, backend: Backend) => {
  let baseline = ctx.baselines.get(backend);
  if (!baseline) {
    baseline = readBaseline(backend);
    ctx.baselines.set(backend, baseline);
  }
  return baseline;
};

const runOne = async (
  ctx: LoadContext,
  sceneId: string,
  config: VerifyConfigName
): Promise<RunResult> => {
  const started = Date.now();
  const def: VerifyConfigDef = VERIFY_CONFIGS[config];
  const sceneConfig = SCENE_VERIFY_CONFIG[sceneId] ?? {};
  const steps = sceneConfig.probeSteps ?? DEFAULT_PROBE_STEPS;
  const result: RunResult = {
    sceneId,
    config,
    status: 'PASS',
    failures: [],
    warnings: [],
    notes: [],
    errors: [],
    durationMs: 0,
  };
  const finish = () => {
    result.durationMs = Date.now() - started;
    if (result.failures.length) result.status = 'FAIL';
    else if (result.notes.some((n) => n.startsWith('no baseline'))) result.status = 'NEW';
    return result;
  };

  if (
    sceneConfig.skip &&
    (!sceneConfig.skip.configs || sceneConfig.skip.configs.includes(config))
  ) {
    result.status = 'SKIPPED';
    result.notes.push(sceneConfig.skip.reason);
    return finish();
  }

  let context: BrowserContext | null = null;
  try {
    context = await ctx.browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript(
      ({ hideGPU, bootKey, boot }) => {
        if (hideGPU) delete (Object.getPrototypeOf(navigator) as { gpu?: unknown }).gpu;
        if (boot) localStorage.setItem(bootKey, JSON.stringify(boot));
      },
      { hideGPU: ctx.useWebGL, bootKey: PHYSICS_BOOT_LS_KEY, boot: def.physicsBoot ?? null }
    );
    const page: Page = await context.newPage();
    const warnings = new Set<string>();
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') result.errors.push(`[console.error] ${text}`);
      else if (msg.type() === 'warning') warnings.add(text.slice(0, 300));
    });
    page.on('pageerror', (err) => result.errors.push(`[pageerror] ${err.message}`));

    await page.goto(buildUrl(ctx.baseUrl, sceneId, def, steps), { waitUntil: 'domcontentloaded' });
    const hasBridge = await page
      .waitForFunction(() => Boolean(window.__AEK_TEST__), null, {
        timeout: BRIDGE_INSTALL_TIMEOUT_MS,
      })
      .then(() => true)
      .catch(() => false);
    if (!hasBridge) {
      result.failures.push("the test bridge never installed (the engine didn't boot)");
      return finish();
    }

    const ready: TestBridgeSceneReady = await page.evaluate(
      (timeoutMs) => window.__AEK_TEST__!.whenSceneReady({ timeoutMs }),
      READY_TIMEOUT_MS
    );
    if (ready.status !== 'READY') {
      result.failures.push(`the scene didn't finish loading in ${READY_TIMEOUT_MS / 1000} s`);
      return finish();
    }
    if (ready.sceneId !== sceneId) {
      result.failures.push(`loaded "${ready.sceneId}" instead (startScene fell back)`);
      return finish();
    }
    const backend: Backend = ready.backend === 'WEBGPU' ? 'webgpu' : 'webgl';
    ctx.backend ??= backend;
    if (backend !== ctx.backend) {
      result.failures.push(`rendered on ${backend}, the run's other pages on ${ctx.backend}`);
      return finish();
    }
    const baseline = getBaseline(ctx, backend);

    if (def.mode === 'PROD_TEST') {
      await page.waitForTimeout(PROD_TEST_SETTLE_MS);
    } else {
      const probe: TestBridgeProbeResult = await page.evaluate(
        (timeoutMs) => window.__AEK_TEST__!.whenProbeDone({ timeoutMs }),
        PROBE_TIMEOUT_MS
      );
      if (probe.status !== 'DONE') {
        result.failures.push(
          probe.status === 'NOT_ARMED'
            ? 'the physics probe is not armed'
            : `the physics probe didn't reach step ${steps} in ${PROBE_TIMEOUT_MS / 1000} s`
        );
      } else {
        result.hash = probe.hash;
        result.steps = probe.steps;
        result.probeConfig = probe.config;
        if (def.expectProbeConfig && !probe.config.startsWith(def.expectProbeConfig)) {
          result.failures.push(
            `ran as "${probe.config}", expected "${def.expectProbeConfig}…" (the configuration didn't apply)`
          );
        }
        compareHash(baseline.entries[runKey(sceneId, config)], result);
        if (probe.characterCount && !sceneConfig.unstableHash) {
          result.notes.push(`${probe.characterCount} character(s), not hashed`);
        }

        await page.evaluate(() => window.__AEK_TEST__!.freeze());
        if (sceneConfig.snapshot && 'skip' in sceneConfig.snapshot) {
          result.notes.push(`snapshot skipped: ${sceneConfig.snapshot.reason}`);
        } else {
          const shot: TestBridgeSnapshot = await page.evaluate(
            (size) => window.__AEK_TEST__!.snapshot(size),
            SNAPSHOT_SIZE
          );
          await handleSnapshot(backend, baseline, result, Buffer.from(shot.pngBase64, 'base64'));
        }
      }
    }

    result.warnings.push(...[...warnings].map((w) => `[console.warn] ${w}`));
    const unallowed = result.errors.filter((e) => !isAllowed(sceneId, e));
    if (unallowed.length) {
      result.failures.push(`${unallowed.length} error(s) not allowed in scenes.config.ts`);
    }
  } catch (err) {
    result.failures.push(`the runner stopped: ${(err as Error).message.split('\n')[0]}`);
  } finally {
    await context?.close().catch(() => undefined);
  }
  return finish();
};

const compareHash = (entry: BaselineEntry | undefined, result: RunResult) => {
  const sceneConfig = SCENE_VERIFY_CONFIG[result.sceneId] ?? {};
  if (!entry?.hash) {
    result.notes.push('no baseline hash');
    return;
  }
  if (entry.steps !== result.steps) {
    result.notes.push(`no baseline hash at ${result.steps} steps (baseline: ${entry.steps})`);
    return;
  }
  if (entry.hash === result.hash) return;
  const msg = `probe hash ${result.hash}, baseline ${entry.hash} (${entry.commit})`;
  if (sceneConfig.unstableHash) result.warnings.push(`${msg}: ${sceneConfig.unstableHash.reason}`);
  else result.failures.push(msg);
};

const handleSnapshot = async (
  backend: Backend,
  baseline: BaselineFile,
  result: RunResult,
  png: Buffer
) => {
  const paths = getPaths(backend);
  const fileName = snapshotFileName(result.sceneId, result.config);
  fs.mkdirSync(paths.lastRunDir, { recursive: true });
  const currentFile = path.join(paths.lastRunDir, fileName);
  const diffFile = currentFile.replace(/\.png$/, '.diff.png');
  fs.writeFileSync(currentFile, png);
  fs.rmSync(diffFile, { force: true });
  result.snapshotFile = fileName;

  const entry = baseline.entries[runKey(result.sceneId, result.config)];
  const baselineFile = entry?.snapshot ? path.join(paths.baselineDir, entry.snapshot) : null;
  if (!baselineFile || !fs.existsSync(baselineFile)) {
    result.notes.push('no baseline snapshot');
    return;
  }
  const sceneSnapshot = SCENE_VERIFY_CONFIG[result.sceneId]?.snapshot;
  const tolerance = {
    ...DEFAULT_SNAPSHOT_TOLERANCE,
    ...(sceneSnapshot && 'tolerance' in sceneSnapshot ? sceneSnapshot.tolerance : {}),
  };
  const diff = await compareSnapshots(png, baselineFile, tolerance, diffFile);
  if ('sizeMismatch' in diff) {
    result.failures.push(`snapshot size ${diff.sizeMismatch}`);
    return;
  }
  const summary = `mean ${diff.meanDelta.toFixed(3)}, changed ${(diff.changedRatio * 100).toFixed(2)} %, max ${diff.maxDelta}`;
  if (diff.meanDelta > tolerance.maxMeanDelta || diff.changedRatio > tolerance.maxChangedRatio) {
    result.failures.push(`snapshot differs (${summary}): ${path.relative(ROOT, diffFile)}`);
  } else if (diff.maxDelta > 0) {
    result.notes.push(`snapshot within tolerance (${summary})`);
  }
};

// --- Report ---

const formatDuration = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const printResult = (r: RunResult) => {
  const colour = { PASS: GREEN, UPDATED: GREEN, NEW: YELLOW, SKIPPED: DIM, FAIL: RED }[r.status];
  const hash = r.hash ? ` ${DIM}${r.hash}${RESET}` : '';
  console.log(
    `${colour}${r.status.padEnd(7)}${RESET} ${r.sceneId} ${DIM}${r.config}${RESET}${hash} ${DIM}(${formatDuration(r.durationMs)})${RESET}`
  );
  for (const f of r.failures) console.log(`        ${RED}✗ ${f}${RESET}`);
  if (r.status === 'FAIL' || r.errors.length) {
    for (const e of r.errors) {
      const allowed = isAllowed(r.sceneId, e);
      console.log(
        `        ${allowed ? DIM : RED}${allowed ? '(allowed) ' : ''}${e.slice(0, 400)}${RESET}`
      );
    }
  }
  for (const w of r.warnings.filter((w) => !w.startsWith('[console.warn]'))) {
    console.log(`        ${YELLOW}! ${w}${RESET}`);
  }
  for (const n of r.notes) console.log(`        ${DIM}${n}${RESET}`);
};

/** Debug configurations of one scene should hash alike (p101: deterministic in every target) */
const checkCrossTargetHashes = (results: RunResult[]) => {
  const hashes = new Map<string, string>();
  for (const r of results) if (r.hash) hashes.set(r.config, r.hash);
  if (new Set(hashes.values()).size <= 1) return null;
  return [...hashes].map(([config, hash]) => `${config} ${hash}`).join(', ');
};

const recordBaseline = (
  backend: Backend,
  baseline: BaselineFile,
  results: RunResult[],
  commit: string
) => {
  const paths = getPaths(backend);
  fs.mkdirSync(paths.baselineDir, { recursive: true });
  const now = new Date().toISOString();
  for (const r of results) {
    if (r.status !== 'PASS' && r.status !== 'NEW') continue;
    const entry: BaselineEntry = { recordedAt: now, commit };
    if (r.hash) Object.assign(entry, { hash: r.hash, steps: r.steps, probeConfig: r.probeConfig });
    if (r.snapshotFile) {
      fs.copyFileSync(
        path.join(paths.lastRunDir, r.snapshotFile),
        path.join(paths.baselineDir, r.snapshotFile)
      );
      entry.snapshot = r.snapshotFile;
    }
    baseline.entries[runKey(r.sceneId, r.config)] = entry;
    r.status = 'UPDATED';
  }
  fs.writeFileSync(paths.baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
};

// --- Main ---

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const generated = readJSON<{ scenes: Record<string, unknown> }>(GENERATED_DATA);
  if (!generated) fail(`Can't read ${path.relative(ROOT, GENERATED_DATA)}: run yarn gatherAppData`);
  const sceneIds = selectScenes(Object.keys(generated!.scenes), args.only);

  const useWebGL = args.webgl || (isWSL() && !args.headed);
  const requested: Backend = useWebGL ? 'webgl' : 'webgpu';
  const own = args.url ? null : await startOwnServer();
  const baseUrl = own ? own.url : args.url!;
  const browser = await launchBrowser(useWebGL, args.headed);
  const commit = getCommit();

  const close = async () => {
    await browser.close().catch(() => undefined);
    await own?.server.close();
  };
  process.once('SIGINT', () => {
    void close().then(() => process.exit(130));
  });

  console.log(
    `Scene runner against ${baseUrl}: ${sceneIds.length} scene(s) × ${args.configs.join(', ')}, ` +
      `${requested === 'webgl' ? `WebGL2 (SwiftShader${args.webgl ? '' : ', WSL2'})` : 'WebGPU'}` +
      `${args.update ? ', recording baselines' : ''}\n`
  );

  const ctx: LoadContext = { browser, baseUrl, useWebGL, baselines: new Map(), backend: null };
  const results: RunResult[] = [];
  const started = Date.now();
  try {
    for (const sceneId of sceneIds) {
      const sceneResults: RunResult[] = [];
      for (const config of args.configs) {
        const isFirstPage = !ctx.backend;
        const r = await runOne(ctx, sceneId, config);
        if (isFirstPage && ctx.backend && ctx.backend !== requested) {
          console.log(
            `${YELLOW}No WebGPU here: the engine fell back to WebGL2 (the webgl baseline)${RESET}`
          );
        }
        sceneResults.push(r);
        printResult(r);
      }
      const mismatch = checkCrossTargetHashes(sceneResults);
      if (mismatch)
        console.log(`        ${YELLOW}! the physics targets hash differently: ${mismatch}${RESET}`);
      results.push(...sceneResults);
    }
  } finally {
    await close();
  }

  const backend = ctx.backend ?? requested;
  if (args.update) recordBaseline(backend, getBaseline(ctx, backend), results, commit);
  const paths = getPaths(backend);
  fs.mkdirSync(path.dirname(paths.lastRunFile), { recursive: true });
  fs.writeFileSync(
    paths.lastRunFile,
    `${JSON.stringify({ commit, at: new Date().toISOString(), baseUrl, backend, results }, null, 2)}\n`
  );

  const count = (status: RunStatus) => results.filter((r) => r.status === status).length;
  const failed = count('FAIL');
  console.log(
    `\n${count('PASS')} passed, ${failed} failed, ${count('NEW')} new, ${count('UPDATED')} recorded, ` +
      `${count('SKIPPED')} skipped in ${formatDuration(Date.now() - started)} ` +
      `${DIM}(${path.relative(ROOT, paths.lastRunFile)})${RESET}`
  );
  process.exit(failed ? 1 : 0);
};

void main();
