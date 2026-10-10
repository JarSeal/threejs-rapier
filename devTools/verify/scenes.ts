/**
 * The scene runner (`yarn verify:scenes`, p601): loads every scene of the generated data in every
 * configuration of `scenes.config.ts`, through the dev-only test bridge (`window.__AEK_TEST__`,
 * `src/_engine/debug/TestBridge.ts`), and fails on console or page errors that aren't allowed, a
 * probe hash that differs from the baseline, or a snapshot that differs beyond the tolerance.
 *
 *   yarn verify:scenes [--only <sceneId|glob>[,…]] [--config <name|set>[,…]] [--update]
 *                      [--url <url>] [--webgl] [--headed] [--browser chromium|firefox]
 *
 * Baselines are local (`.cache/verify/scenes/<backend>/`): snapshots depend on the GPU, the driver
 * and the backend. `--update` compares nothing with the baseline and records every run without
 * errors or timeouts as the new one (merged: `--only` updates only those scenes). The workflow is
 * "update on `main`, then run on the branch".
 *
 * It starts its own dev server (port 8092 or the next free one) unless `--url` points at one.
 * Headless WebGPU can't render on WSL2, so there (and with `--webgl`) the page gets no
 * `navigator.gpu` and the engine renders on WebGL2 (SwiftShader): WebGPU-only regressions need a
 * `--headed` run on a real GPU.
 *
 * `--browser firefox` (Playwright's Firefox, `npx playwright-core install firefox`) is the
 * cross-browser determinism run: the debug configurations only, always on WebGL2, and only their
 * probe hashes, compared with Chromium's baseline for the same scene, configuration and steps
 * (the `webgl` file's entry, else the `webgpu` one's: the hash doesn't depend on the backend). No
 * snapshots (another rasterizer), no baseline of its own, so no `--update`. Its last run is in
 * `.cache/verify/scenes/firefox/`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from 'playwright-core';
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
  VERIFY_BROWSERS,
  VERIFY_CONFIG_SETS,
  VERIFY_CONFIGS,
  type VerifyBrowser,
  type VerifyConfigDef,
  type VerifyConfigName,
} from './scenes.config';
import { out, PROGRESS_LOG_WATCH } from './progressLog';
import { compareSnapshots } from './snapshotDiff';

/** Bump when the baseline file's shape changes: an old one is then ignored */
const BASELINE_FORMAT_VERSION = 1;
const CACHE_DIR = path.join(ROOT, '.cache/verify/scenes');
const GENERATED_DATA = path.join(ROOT, 'src/generated/generatedAppData.json');
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
/** A folder under `.cache/verify/scenes/`: Chromium's per backend, Firefox's for its last run */
type ResultDir = Backend | 'firefox';

type Args = {
  only: string[];
  configs: VerifyConfigName[];
  update: boolean;
  url: string | null;
  webgl: boolean;
  headed: boolean;
  browser: VerifyBrowser;
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
  out(`${RED}${msg}${RESET}`, true);
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
    browser: 'chromium',
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
    else if (arg === '--browser') {
      const browser = value();
      if (!VERIFY_BROWSERS.includes(browser as VerifyBrowser)) {
        fail(`Unknown browser "${browser}" (${VERIFY_BROWSERS.join(', ')})`);
      }
      args.browser = browser as VerifyBrowser;
    } else fail(`Unknown argument: ${arg}`);
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
  if (args.browser === 'firefox') {
    if (args.update) {
      fail(
        "--browser firefox has no baseline of its own: it compares with Chromium's (no --update)"
      );
    }
    const skipped = args.configs.filter((name) => VERIFY_CONFIGS[name].mode !== 'DEBUG');
    args.configs = args.configs.filter((name) => VERIFY_CONFIGS[name].mode === 'DEBUG');
    if (!args.configs.length) {
      fail(`--browser firefox runs the debug configurations only (not ${skipped.join(', ')})`);
    }
  }
  return args;
};

/** Whether a config entry (`skip`, `unstableHash`, an allowed error) applies to this run */
const appliesTo = (
  filter: { configs?: VerifyConfigName[]; browsers?: VerifyBrowser[] },
  config: VerifyConfigName | null,
  browser: VerifyBrowser
) =>
  (!filter.configs || (config !== null && filter.configs.includes(config))) &&
  (!filter.browsers || filter.browsers.includes(browser));

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

const launchBrowser = async (browser: VerifyBrowser, useWebGL: boolean, headed: boolean) => {
  if (browser === 'firefox') {
    try {
      // Playwright's own build: a system Firefox has no remote protocol Playwright can drive
      return await firefox.launch({ headless: !headed });
    } catch (err) {
      return fail(
        `Firefox didn't launch: ${(err as Error).message}\n` +
          "Install Playwright's Firefox once: npx playwright-core install firefox"
      );
    }
  }
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

const getPaths = (resultDir: ResultDir) => {
  const dir = path.join(CACHE_DIR, resultDir);
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

// --- One page load ---

const isAllowed = (sceneId: string, message: string, browser: VerifyBrowser) =>
  [...GLOBAL_ALLOWED_ERRORS, ...(SCENE_VERIFY_CONFIG[sceneId]?.allowedErrors ?? [])].some(
    (a) => appliesTo(a, null, browser) && a.pattern.test(message)
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
  browserName: VerifyBrowser;
  baseUrl: string;
  useWebGL: boolean;
  /** `--update`: nothing is compared with the baseline, so a run that passes the other checks
   * (errors, timeouts, the probe config) is recorded even where the baseline differs */
  isRecording: boolean;
  /** Read on first use, per backend */
  baselines: Map<Backend, BaselineFile>;
  /** What the first page rendered on (WebGPU falls back to WebGL2 where it isn't available) */
  backend: Backend | null;
};

type BaselineContext = Pick<LoadContext, 'baselines'>;

const getBaseline = (ctx: BaselineContext, backend: Backend) => {
  let baseline = ctx.baselines.get(backend);
  if (!baseline) {
    baseline = readBaseline(backend);
    ctx.baselines.set(backend, baseline);
  }
  return baseline;
};

/** What Firefox compares with: Chromium's entry with a hash, the `webgl` file's first */
const getChromiumEntry = (ctx: BaselineContext, key: string) => {
  for (const backend of ['webgl', 'webgpu'] as const) {
    const entry = getBaseline(ctx, backend).entries[key];
    if (entry?.hash) return { entry, backend };
  }
  return null;
};

/** The runs both Chromium baselines hashed, at the same steps, with different hashes. Any means
 * the hash depends on the render backend, and Firefox (WebGL2) should compare with `webgl` only */
const findBackendHashMismatches = (ctx: BaselineContext) => {
  const webgpu = getBaseline(ctx, 'webgpu').entries;
  const mismatches: string[] = [];
  let shared = 0;
  for (const [key, gl] of Object.entries(getBaseline(ctx, 'webgl').entries)) {
    const gpu = webgpu[key];
    if (!gl.hash || !gpu?.hash || gl.steps !== gpu.steps) continue;
    shared++;
    if (gl.hash !== gpu.hash) mismatches.push(`${key} webgl ${gl.hash}, webgpu ${gpu.hash}`);
  }
  return { shared, mismatches };
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

  if (sceneConfig.skip && appliesTo(sceneConfig.skip, config, ctx.browserName)) {
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
        (timeoutMs) => window.__AEK_TEST__!.whenProbeDone({ timeoutMs, freeze: true }),
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
        if (ctx.browserName === 'firefox') {
          const chromium = getChromiumEntry(ctx, runKey(sceneId, config));
          compareHash(
            chromium?.entry,
            result,
            ctx.browserName,
            `Chromium ${chromium?.backend ?? ''}`
          );
        } else if (!ctx.isRecording) {
          compareHash(baseline.entries[runKey(sceneId, config)], result, ctx.browserName);
        }
        if (probe.characterCount && !sceneConfig.unstableHash) {
          result.notes.push(`${probe.characterCount} character(s), not hashed`);
        }

        if (ctx.browserName === 'firefox') {
          // Hashes only: Firefox rasterizes differently, and has no baseline of its own
        } else if (sceneConfig.snapshot && 'skip' in sceneConfig.snapshot) {
          result.notes.push(`snapshot skipped: ${sceneConfig.snapshot.reason}`);
        } else {
          const shot: TestBridgeSnapshot = await page.evaluate(
            (size) => window.__AEK_TEST__!.snapshot(size),
            SNAPSHOT_SIZE
          );
          await handleSnapshot(
            backend,
            ctx.isRecording ? null : baseline,
            result,
            Buffer.from(shot.pngBase64, 'base64')
          );
        }
      }
    }

    result.warnings.push(...[...warnings].map((w) => `[console.warn] ${w}`));
    const unallowed = result.errors.filter((e) => !isAllowed(sceneId, e, ctx.browserName));
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

/** `source` names whose baseline it is in the messages (Firefox compares with Chromium's) */
const compareHash = (
  entry: BaselineEntry | undefined,
  result: RunResult,
  browser: VerifyBrowser,
  source?: string
) => {
  const sceneConfig = SCENE_VERIFY_CONFIG[result.sceneId] ?? {};
  const of = source ? ` (${source.trim()})` : '';
  if (!entry?.hash) {
    result.notes.push(`no baseline hash${of}`);
    return;
  }
  if (entry.steps !== result.steps) {
    result.notes.push(`no baseline hash at ${result.steps} steps${of} (baseline: ${entry.steps})`);
    return;
  }
  if (entry.hash === result.hash) return;
  const msg = `probe hash ${result.hash}, baseline ${entry.hash} (${source ? `${source}, ` : ''}${entry.commit})`;
  const unstable = sceneConfig.unstableHash;
  if (unstable && appliesTo(unstable, result.config, browser)) {
    result.warnings.push(`${msg}: ${unstable.reason}`);
  } else {
    result.failures.push(msg);
  }
};

const handleSnapshot = async (
  backend: Backend,
  baseline: BaselineFile | null,
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
  if (!baseline) return; // Recording: the image only

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

const printResult = (r: RunResult, browser: VerifyBrowser) => {
  const colour = { PASS: GREEN, UPDATED: GREEN, NEW: YELLOW, SKIPPED: DIM, FAIL: RED }[r.status];
  const hash = r.hash ? ` ${DIM}${r.hash}${RESET}` : '';
  out(
    `${colour}${r.status.padEnd(7)}${RESET} ${r.sceneId} ${DIM}${r.config}${RESET}${hash} ${DIM}(${formatDuration(r.durationMs)})${RESET}`
  );
  for (const f of r.failures) out(`        ${RED}✗ ${f}${RESET}`);
  if (r.status === 'FAIL' || r.errors.length) {
    for (const e of r.errors) {
      const allowed = isAllowed(r.sceneId, e, browser);
      out(`        ${allowed ? DIM : RED}${allowed ? '(allowed) ' : ''}${e.slice(0, 400)}${RESET}`);
    }
  }
  for (const w of r.warnings.filter((w) => !w.startsWith('[console.warn]'))) {
    out(`        ${YELLOW}! ${w}${RESET}`);
  }
  for (const n of r.notes) out(`        ${DIM}${n}${RESET}`);
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

/** Firefox: fails without a Chromium baseline to compare with, and warns when the two Chromium
 * baselines hash a run differently (Firefox then compares with the `webgl` one, its own backend) */
const checkChromiumBaselines = (ctx: BaselineContext) => {
  const hashed = (backend: Backend) =>
    Object.values(getBaseline(ctx, backend).entries).filter((e) => e.hash).length;
  const counts = { webgl: hashed('webgl'), webgpu: hashed('webgpu') };
  if (!counts.webgl && !counts.webgpu) {
    fail(
      "--browser firefox compares with Chromium's baseline, and there's none: record one first " +
        '(yarn verify:scenes --update, on the same commit)'
    );
  }
  out(`Chromium baseline: ${counts.webgl} webgl and ${counts.webgpu} webgpu hash(es)`);
  const { shared, mismatches } = findBackendHashMismatches(ctx);
  if (mismatches.length) {
    out(
      `${YELLOW}! the webgl and webgpu baselines hash ${mismatches.length} of ${shared} shared run(s) ` +
        `differently, so the hash depends on the backend: Firefox's webgpu fallbacks aren't valid\n` +
        mismatches.map((m) => `    ${m}`).join('\n') +
        RESET
    );
  } else if (shared) {
    out(`${DIM}The webgl and webgpu baselines agree on all ${shared} run(s) both hashed${RESET}`);
  }
};

// --- Main ---

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const generated = readJSON<{ scenes: Record<string, unknown> }>(GENERATED_DATA);
  if (!generated) fail(`Can't read ${path.relative(ROOT, GENERATED_DATA)}: run yarn gatherAppData`);
  const sceneIds = selectScenes(Object.keys(generated!.scenes), args.only);

  const isFirefox = args.browser === 'firefox';
  const useWebGL = isFirefox || args.webgl || (isWSL() && !args.headed);
  const requested: Backend = useWebGL ? 'webgl' : 'webgpu';
  const baselines = new Map<Backend, BaselineFile>();
  if (isFirefox) checkChromiumBaselines({ baselines });
  const own = args.url ? null : await startOwnServer();
  const baseUrl = own ? own.url : args.url!;
  const browser = await launchBrowser(args.browser, useWebGL, args.headed);
  const commit = getCommit();

  const close = async () => {
    await browser.close().catch(() => undefined);
    await own?.server.close();
  };
  process.once('SIGINT', () => {
    void close().then(() => process.exit(130));
  });

  const renderer = isFirefox
    ? `Firefox ${browser.version()}, WebGL2, hashes against Chromium's baseline`
    : requested === 'webgl'
      ? `WebGL2 (SwiftShader${args.webgl ? '' : ', WSL2'})`
      : 'WebGPU';
  out(
    `Scene runner against ${baseUrl}: ${sceneIds.length} scene(s) × ${args.configs.join(', ')}, ` +
      `${renderer}${args.update ? ', recording baselines' : ''}`
  );
  out(`${DIM}Watch it: ${PROGRESS_LOG_WATCH}${RESET}\n`);

  const ctx: LoadContext = {
    browser,
    browserName: args.browser,
    baseUrl,
    useWebGL,
    isRecording: args.update,
    baselines,
    backend: null,
  };
  const results: RunResult[] = [];
  const started = Date.now();
  try {
    for (const sceneId of sceneIds) {
      const sceneResults: RunResult[] = [];
      for (const config of args.configs) {
        const isFirstPage = !ctx.backend;
        const r = await runOne(ctx, sceneId, config);
        if (isFirstPage && ctx.backend && ctx.backend !== requested) {
          out(
            `${YELLOW}No WebGPU here: the engine fell back to WebGL2 (the webgl baseline)${RESET}`
          );
        }
        sceneResults.push(r);
        printResult(r, args.browser);
      }
      const mismatch = checkCrossTargetHashes(sceneResults);
      if (mismatch)
        out(`        ${YELLOW}! the physics targets hash differently: ${mismatch}${RESET}`);
      results.push(...sceneResults);
    }
  } finally {
    await close();
  }

  const backend = ctx.backend ?? requested;
  if (args.update) recordBaseline(backend, getBaseline(ctx, backend), results, commit);
  const paths = getPaths(isFirefox ? 'firefox' : backend);
  fs.mkdirSync(path.dirname(paths.lastRunFile), { recursive: true });
  fs.writeFileSync(
    paths.lastRunFile,
    `${JSON.stringify({ commit, at: new Date().toISOString(), baseUrl, browser: args.browser, backend, results }, null, 2)}\n`
  );

  const count = (status: RunStatus) => results.filter((r) => r.status === status).length;
  const failed = count('FAIL');
  out(
    `\n${count('PASS')} passed, ${failed} failed, ${count('NEW')} new, ${count('UPDATED')} recorded, ` +
      `${count('SKIPPED')} skipped in ${formatDuration(Date.now() - started)} ` +
      `${DIM}(${path.relative(ROOT, paths.lastRunFile)})${RESET}`
  );
  process.exit(failed ? 1 : 0);
};

void main();
