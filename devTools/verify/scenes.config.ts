/**
 * The scene runner's settings (`yarn verify:scenes`, `devTools/verify/scenes.ts`, p601): the
 * configurations every scene loads in, the snapshot tolerance, and per scene what to skip or
 * allow. Every exception carries its reason, so a later reader can tell whether it still holds.
 */

/** One page load of a scene: the mode and, in the debug env, the physics target */
export type VerifyConfigDef = {
  /** `?isDebug=true` (probe hash and snapshot) or `?isProdTest=true` (errors only: prod test mode
   * has no probe and no step freeze, so its snapshot would catch physics at any step) */
  mode: 'DEBUG' | 'PROD_TEST';
  /** The physics boot overrides (debug env only), written to localStorage before the page loads */
  physicsBoot?: { workerTarget: 'MAIN_THREAD' | 'WORKER_THREAD'; useSAB?: boolean };
  /** The probe's config string must start with this, or the configuration didn't apply (eg. the
   * dev server sent no COOP/COEP headers and SAB fell back to messages) */
  expectProbeConfig?: string;
};

export const VERIFY_CONFIGS = {
  workerSab: {
    mode: 'DEBUG',
    physicsBoot: { workerTarget: 'WORKER_THREAD', useSAB: true },
    expectProbeConfig: 'WORKER_THREAD/SHARED_MEMORY',
  },
  workerMsg: {
    mode: 'DEBUG',
    physicsBoot: { workerTarget: 'WORKER_THREAD', useSAB: false },
    expectProbeConfig: 'WORKER_THREAD/MESSAGE_BATCH',
  },
  mainThread: {
    mode: 'DEBUG',
    physicsBoot: { workerTarget: 'MAIN_THREAD' },
    expectProbeConfig: 'MAIN_THREAD/',
  },
  prodTest: { mode: 'PROD_TEST' },
} satisfies Record<string, VerifyConfigDef>;

export type VerifyConfigName = keyof typeof VERIFY_CONFIGS;

/** Named sets for `--config`; a single configuration's name works too */
export const VERIFY_CONFIG_SETS: Record<string, VerifyConfigName[]> = {
  all: ['workerSab', 'workerMsg', 'mainThread', 'prodTest'],
  /** The inner loop: one physics target, debug only */
  quick: ['workerSab'],
};

export const DEFAULT_CONFIG_SET = 'all';

/**
 * `--browser`: Chromium runs every configuration against its own baselines; Firefox runs the debug
 * configurations on WebGL2 and compares only their probe hashes, against Chromium's baseline (a
 * difference means the simulation depends on the JS engine)
 */
export type VerifyBrowser = 'chromium' | 'firefox';

export const VERIFY_BROWSERS: VerifyBrowser[] = ['chromium', 'firefox'];

/** The snapshot's size (16:9) */
export const SNAPSHOT_SIZE = { width: 512, height: 288 };

/**
 * A snapshot matches its baseline when both hold:
 * - `maxMeanDelta`: the mean absolute channel difference (0-255) over every RGB channel;
 * - `maxChangedRatio`: the share of pixels whose largest channel difference is over
 *   `pixelThreshold` (an edge that moved, not a gradient that shifted by a step).
 */
export type SnapshotTolerance = {
  maxMeanDelta: number;
  maxChangedRatio: number;
  pixelThreshold: number;
};

export const DEFAULT_SNAPSHOT_TOLERANCE: SnapshotTolerance = {
  maxMeanDelta: 0.5,
  maxChangedRatio: 0.002,
  pixelThreshold: 24,
};

/** Fixed steps the probe runs before it freezes physics (2 s at 60 Hz) */
export const DEFAULT_PROBE_STEPS = 120;

/** How long prod test mode runs after the scene is ready, to catch errors of its first frames */
export const PROD_TEST_SETTLE_MS = 3000;

/** Per page load: the scene's load, then the probe. The test clock runs one physics step per
 * rendered frame, so the probe takes its steps in frames: a heavy scene on SwiftShader (about 1 s a
 * frame) needs minutes. The limit only catches a page that never gets there. */
export const READY_TIMEOUT_MS = 180_000;
export const PROBE_TIMEOUT_MS = 300_000;

/** An error that doesn't fail a run, matched against the console line or page error message, in
 * every browser or only in `browsers` */
export type AllowedError = { pattern: RegExp; reason: string; browsers?: VerifyBrowser[] };

/** Allowed in every scene and configuration */
export const GLOBAL_ALLOWED_ERRORS: AllowedError[] = [];

export type SceneVerifyConfig = {
  /** Fixed steps before the probe freezes physics (default {@link DEFAULT_PROBE_STEPS}) */
  probeSteps?: number;
  /** Not loaded at all, or not in these configurations / browsers */
  skip?: { reason: string; configs?: VerifyConfigName[]; browsers?: VerifyBrowser[] };
  allowedErrors?: AllowedError[];
  /** A changed hash only warns (eg. characters: not hashed, but they push bodies around), in every
   * configuration and browser or only in these. In Firefox, "changed" is against Chromium's
   * baseline: a Firefox-only entry is a finding (the simulation depends on the JS engine), so its
   * reason names its issue file */
  unstableHash?: { reason: string; configs?: VerifyConfigName[]; browsers?: VerifyBrowser[] };
  /** No snapshot comparison, or a looser tolerance (eg. characters, which aren't deterministic) */
  snapshot?:
    | { skip: true; reason: string }
    | { tolerance: Partial<SnapshotTolerance>; reason: string };
};

/** By scene id. A scene that isn't listed runs with the defaults */
export const SCENE_VERIFY_CONFIG: Record<string, SceneVerifyConfig> = {
  // No physics bodies (an empty hash): the steps only set the frames before the snapshot, and
  // its frames take about 1 s each on SwiftShader
  largeWorld: { probeSteps: 30 },
  space: {
    unstableHash: {
      reason:
        "MutualGravity reads the worker's last synced poses, up to a frame stale, so the worker targets aren't deterministic (its JSDoc); MAIN_THREAD is",
      configs: ['workerSab', 'workerMsg'],
    },
  },
  thirdPersonGymScene: {
    unstableHash: {
      reason:
        "its characters aren't deterministic yet (wall clock, Math.random, async shape casts in the worker: CLAUDE.md, Physics) and push the hashed bodies around",
    },
  },
  textureArrays: {
    allowedErrors: [
      {
        pattern:
          /^\[console\.error\] Could not load texture array "textureArrays\/(noOutputFallback|noOutput|layerCountMismatch)"/,
        reason:
          'The scene tests how loadTextureAsync fails for a texture array asset (it logs "Expected: the next 3 errors" first)',
      },
    ],
  },
  textureAtlases: {
    allowedErrors: [
      {
        pattern:
          /^\[console\.error\] Could not load texture atlas slot "textureAtlases\/(noOutputFallback|noOutput|tooManyLevels|droppedPlusStored|sizeMismatch|fullChainAsProtected)"/,
        reason:
          'The scene tests how loadTextureAsync fails for an atlas slot (it logs "Expected: the next 6 errors" first)',
      },
    ],
  },
};
