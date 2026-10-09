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

/** Per page load: the scene's load, then the probe */
export const READY_TIMEOUT_MS = 180_000;
export const PROBE_TIMEOUT_MS = 120_000;

/** An error that doesn't fail a run, matched against the console line or page error message */
export type AllowedError = { pattern: RegExp; reason: string };

/** Allowed in every scene and configuration */
export const GLOBAL_ALLOWED_ERRORS: AllowedError[] = [];

export type SceneVerifyConfig = {
  /** Fixed steps before the probe freezes physics (default {@link DEFAULT_PROBE_STEPS}) */
  probeSteps?: number;
  /** Not loaded at all, or not in these configurations */
  skip?: { reason: string; configs?: VerifyConfigName[] };
  allowedErrors?: AllowedError[];
  /** A changed hash only warns (eg. characters: not hashed, but they push bodies around) */
  unstableHash?: { reason: string };
  /** No snapshot comparison, or a looser tolerance (eg. TSL `time` animation the freeze can't stop) */
  snapshot?:
    | { skip: true; reason: string }
    | { tolerance: Partial<SnapshotTolerance>; reason: string };
};

/** By scene id. A scene that isn't listed runs with the defaults */
export const SCENE_VERIFY_CONFIG: Record<string, SceneVerifyConfig> = {};
