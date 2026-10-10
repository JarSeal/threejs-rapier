import type { TCMP } from '../utils/CMP';
import type {
  PhysicsBackgroundBehavior,
  PhysicsEngine,
  PhysicsInterpolationMode,
  PhysicsWorkerTarget,
} from './Physics/PhysicsAPITypes';
import type { AssetsWorkerTarget } from './Assets/AssetsAPITypes';
import type { DraggableWindow } from './UI/DraggableWindow';
import type { ECSStorageMode } from './ECS/ECSComponentStorage';
import { lsGetItem } from '../utils/LocalAndSessionStorage';
import type { DebugKeyBindingConfig } from './Input/DefaultDebugKeyBindings';

/** LS key for debug-only boot-time physics overrides (workerTarget/useSAB/maxBodies/stepStatsEnabled). Written by the Physics API debug tab, read once in loadConfig(). */
export const DEBUG_PHYSICS_API_BOOT_LS_KEY = 'AEK_debugPhysicsApiBoot';

/** LS key for debug-only boot-time assets overrides (workerTarget + per-kind overrides). Written by the Assets debug tab, read once in loadConfig(). */
export const DEBUG_ASSETS_BOOT_LS_KEY = 'AEK_debugAssetsBoot';

/** Engine default debug drawer tab order (tab ids, see `AppConfig.debugDrawer.tabOrder`). */
export const DEFAULT_DEBUG_DRAWER_TAB_ORDER = [
  'statsControls',
  'loopControls',
  'skyBoxControls',
  'debugToolsControls',
  'physicsApiControls',
  'rendererControls',
  'assetsControls',
  'postFxControls',
  'rayCastControls',
  'lightsControls',
  'camerasControls',
  'charactersControls',
  'ecsControls',
  'spatialGridControls',
  'lodControls',
];

export type Environments = 'development' | 'test' | 'unitTest' | 'production';

/**
 * Wireframe colors keyed by collider state, as 24-bit hex numbers (0xrrggbb) — the same
 * form Tweakpane's `view: 'color'` bindings and THREE.Color.setHex() use.
 *
 * At draw time exactly one state wins per collider, resolved highest-priority-first in
 * the order listed here: a disabled sensor reads as disabled, a sleeping sensor reads as
 * a sensor, and `awake` is the fallback when nothing else applies.
 */
export type PhysicsWireframeColors = {
  /** The body's physics simulation tier (p352) is `DISABLED`: the reason it's disabled. */
  tierDisabled?: number;
  /** The body's physics simulation tier (p352) is `STATIC`: a dynamic body frozen as `FIXED`,
   * told apart from a body created fixed. */
  tierStatic?: number;
  /** The collider, or its owning rigid body, is disabled. */
  disabled?: number;
  /** The collider is a sensor (reports overlaps, generates no contact response). */
  sensor?: number;
  /** The owning rigid body is asleep. */
  sleeping?: number;
  /** The owning rigid body is kinematic: driven programmatically, never sleeps, and
   * unaffected by forces. Bucketed alongside real dynamic bodies by
   * PhysicsManager.createPhysicsEntity, so it needs its own color to stay tellable apart. */
  kinematic?: number;
  /** The body is fixed (the BODY_STATIC bucket). Deliberately distinct from `disabled`
   * so a static collider doesn't read as something being wrong. */
  fixed?: number;
  /** The fallback: dynamic, enabled, awake, not a sensor. */
  awake?: number;
};

export type DebugPhysicsWireframeConfig = {
  colors?: PhysicsWireframeColors;
  /** Wireframe line width in pixels. Values above 1 only have a visible effect where the
   * fat-line path is available. */
  lineThickness?: number;
};

export type AppConfig = {
  /** Debug-only key bindings: overrides of the engine's default debug keys (same id) and/or
   * extra app debug keys. See {@link DebugKeyBindingConfig}. */
  debugKeys?: DebugKeyBindingConfig[];
  physics?: {
    enabled?: boolean;
    physicsEngine?: PhysicsEngine;
    workerTarget?: PhysicsWorkerTarget;
    worldStepEnabled?: boolean;
    visualizerEnabled?: boolean;
    gravity?: { x: number; y: number; z: number };
    timestep?: number;
    backgroundBehavior?: PhysicsBackgroundBehavior;
    /** Minimum delta time (seconds) substituted for the real elapsed time when
     * backgroundBehavior is 'KEEP_RUNNING_USE_MIN_DELTA' and the window is hidden.
     * 0 = not in use. Default 1/30. */
    minDeltaTime?: number;
    /** Upper bound (seconds) on how much elapsed time a single frame may feed into the
     * fixed-timestep accumulator, guarding against a huge delta after a stall or a
     * throttled background tab. 0 = not in use. Default 1/10. */
    maxDeltaTime?: number;
    /** Maximum fixed-timestep sub-steps stepPhysics() may run in a single frame; once hit,
     * any remaining accumulated time is dropped (not deferred) to prevent an ever-growing
     * backlog under sustained slowdowns. 0 = not in use. Default 60. */
    maxSubSteps?: number;
    solverIterations?: number;
    internalPgsIterations?: number;
    /** Render-time smoothing on top of the discrete physics-step pose. Default 'NONE'
     * (unchanged behavior). See PhysicsState.interpolationMode for the mode semantics. */
    interpolationMode?: PhysicsInterpolationMode;
    /** Intent to use SharedArrayBuffer for the worker-thread hot-path transform buffer.
     * Default true. Actual capability (cross-origin isolation) is resolved at runtime;
     * unavailable environments automatically fall back to a batched-message transport.
     */
    useSAB?: boolean;
    /** Fixed capacity for the worker-thread hot-path transform buffer. Default 2048. */
    maxBodies?: number;
    /** Measure how long the physics engine spends stepping the world each frame (and, in
     * WORKER_THREAD mode, the messaging overhead around it) and feed it to the debug "PHY"
     * panel. Opt-in and default false so the measurement itself costs nothing unless asked
     * for. The initial value: setPhysicsStepStatsEnabled() switches the measurement at runtime
     * (the profiler does while it shows it), but the PHY panel exists only when this is on. */
    stepStatsEnabled?: boolean;
  };
  /** Where asset files are loaded and decoded.
   * Whatever the target, the public loading API stays the same, and a failed worker request
   * transparently re-runs on the main thread (unless fallbackToMainThread is false). */
  assets?: {
    /** Shared default for all asset kinds. Default 'MAIN_THREAD'. The worker is only started
     * by the first worker-targeted request, never at boot. */
    workerTarget?: AssetsWorkerTarget;
    /** Per-kind overrides; fall back to workerTarget. */
    gltfWorkerTarget?: AssetsWorkerTarget;
    textureWorkerTarget?: AssetsWorkerTarget;
    /** Where LOD chains are generated (generateLodChain, core/Lod/LodChains.ts). Default
     * 'WORKER_THREAD', whatever workerTarget is: the main thread runs the simplifier inline, which
     * takes tens of ms for a large mesh. */
    simplifyWorkerTarget?: AssetsWorkerTarget;
    /** Max number of requests in flight in the assets worker at once. Default 8. */
    maxConcurrentLoads?: number;
    /** A worker request not answered in this time (ms) falls back to the main thread. Also
     * bounds the worker's start-up handshake. Default 30000. */
    requestTimeoutMs?: number;
    /** Re-run a failed worker request (start-up failure, missing capability, timeout, error
     * reply or crash) on the main thread, warning once per cause. When false, the request
     * fails instead. Default true. */
    fallbackToMainThread?: boolean;
    /** Build time only: read by the asset pipeline (gatherAppData, `yarn assets`), never by the
     * runtime, so a change needs a pipeline run. Off passes every asset through as it is
     * (copied, content-hashed, into src/public/aek-assets/). The env var
     * `AEK_ASSETS_OPTIMIZE=false` turns `enabled` off for one run. Asset profiles and rules
     * are in assets.config.json (p300). */
    optimization?: {
      /** Master switch. Default true. */
      enabled?: boolean;
      /** KTX2 texture encoding (standalone textures and a GLB's own). Default true. */
      textures?: boolean;
      /** GLB geometry: meshopt / Draco, quantization, simplification. Default true. */
      meshes?: boolean;
    };
  };
  /** LOD selection (Lod/LodSystem.ts, docs/plans/_DONE_p348_ecs-lod-selection.md). */
  lod?: {
    /** Global LOD bias: multiplies every entity's screen size, >1 keeps detail longer. The
     * initial value: setLodBias() changes it at runtime. Default 1. */
    bias?: number;
    /** How many LOD entities the selection reconsiders per frame and world, round-robin. Entities
     * that come into view or just got their LOD are selected at once, past the cap. The initial
     * value: setLodMaxSelectionsPerFrame() changes it at runtime. Default Infinity (no cap). */
    maxSelectionsPerFrame?: number;
    /** How long a LOD change (or hiding and showing) cross-fades, in seconds, unless the LOD's
     * own `fadeSeconds` says otherwise; 0 switches at once. The initial value:
     * setLodFadeSeconds() changes it at runtime. Default 0.25. */
    fadeSeconds?: number;
    /** Where the LOD tab's impostor Export writes a new impostor's files (its `*.impostor.json`,
     * `*.textureAtlas.json` and atlas PNGs), repo-relative: a dev files root (`src/app/`,
     * `src/toolkit/` or `src/public/`). A re-export writes where the impostor's files already are.
     * Default `src/app/impostors`. */
    impostorExportDir?: string;
  };
  ecs?: {
    /** Build-time-selectable ECS component storage backend. Default 'MAP'. */
    storageMode?: ECSStorageMode;
    /** Fixed capacity for TYPED_ARRAY storage. Default 100_000, only relevant when storageMode is 'TYPED_ARRAY'. */
    maxEntities?: number;
  };
  /** Per-state colors and line thickness for the per-entity physics collider wireframes
   * (Debug/_dbg__PhysicsDebugDraw.ts). Debug-only: nothing reads this
   * unless a wireframe is actually switched on, which can only happen in a debug or
   * prod-test environment. Every field is optional and falls back to the engine defaults
   * in `Debug/_dbg__PhysicsDebugDraw.ts`, so partial overrides are fine. */
  debugPhysicsWireframe?: DebugPhysicsWireframeConfig;
  /** Default params for the debug (orbit) camera, used the first time a scene is
   * visited (before any per-scene LS override exists at `AEK_debugCams`). */
  debugCamera?: {
    position?: { x: number; y: number; z: number };
    target?: { x: number; y: number; z: number };
    fov?: number;
    near?: number;
    far?: number;
    zoom?: number;
  };
  /** PostFX engine-level defaults (docs/plans/_DONE_p070_post-fx-system.md). Per-scene and
   * per-pass state lives in the scene / `*.postFx.json` files, not here. */
  postFx?: {
    /** Global master switch: when false, no scene's PostFX chain is ever rendered. A scene
     * still has to declare PostFX passes for anything to happen. Default true. */
    enabled?: boolean;
    /** Start the debug-only per-PostFX pass performance measuring at boot (it can also be
     * switched on and off live with setPostFxMeasureEnabled()). Default false. */
    measureEnabled?: boolean;
  };
  /** Debug drawer settings (debug-only, see `debug/DebuggerGUI.ts`). */
  debugDrawer?: {
    /** Tab ids in menu order. Replaces the engine default ({@link DEFAULT_DEBUG_DRAWER_TAB_ORDER})
     * whole, it is not merged. Tabs not listed go last, in registration order. A tab's own
     * `orderNr` overrides its place on this 0-based scale (eg. 1.5 = between the 2nd and 3rd tab). */
    tabOrder?: string[];
  };
  /** Debugger undo/redo history (debug-only, see `debug/UndoRedo.ts`). */
  undoRedo?: {
    /** Max number of history entries kept per scene bucket. Default 50. */
    historySize?: number;
  };
  /** The dev file server's writes from debug tools (debug env with `yarn dev` only, see
   * `debug/DevFiles.ts`). */
  devFiles?: {
    /** How many `__saveData` entries a save keeps per scene in an asset JSON, the new one
     * included (older ones are dropped): -1 = all, 0 = saving into `__saveData` is off. The
     * Debug tools tab's "File server" folder overrides it per browser. Always 0 outside the debug
     * env. Default 20. */
    saveHistorySize?: number;
  };
  /** Keyed by window kind (a window's id when it has no kind) */
  draggableWindows?: {
    [kind: string]: Partial<DraggableWindow> & {
      contentFn?: (data?: { [key: string]: unknown }) => TCMP;
    };
  };
};

// The environment: production until initEnvironment() reads it (InitEngine's first step)
let curEnvironment: Environments = 'production';
let envVars: { [key: string]: unknown } = {};
let isProdTestQueryParam = false;
let isDebugQueryParam = false;
let startSceneQueryParam: string | null = null;
let config: AppConfig = {
  // These are the default values (if the values are not found in ENV variables or CONFIG file)
  debugKeys: [],
  physics: {
    enabled: false,
    physicsEngine: 'RAPIER',
    workerTarget: 'WORKER_THREAD',
    worldStepEnabled: true,
    gravity: { x: 0, y: 0, z: 0 },
    timestep: 60,
    backgroundBehavior: 'PAUSE',
    minDeltaTime: 1 / 30,
    maxDeltaTime: 1 / 10,
    maxSubSteps: 60,
    interpolationMode: 'NONE',
    useSAB: true,
    maxBodies: 2048,
    stepStatsEnabled: false,
  },
  assets: {
    workerTarget: 'MAIN_THREAD',
    maxConcurrentLoads: 8,
    requestTimeoutMs: 30_000,
    fallbackToMainThread: true,
  },
  lod: {
    bias: 1,
    maxSelectionsPerFrame: Infinity,
    fadeSeconds: 0.25,
    impostorExportDir: 'src/app/impostors',
  },
  ecs: {
    storageMode: 'MAP',
    maxEntities: 100_000,
  },
  debugCamera: {
    position: { x: 3, y: 3, z: 1.5 },
    target: { x: 0, y: 0, z: 0 },
    fov: 60,
    near: 0.1,
    far: 1000,
    zoom: 1,
  },
  debugDrawer: {
    tabOrder: DEFAULT_DEBUG_DRAWER_TAB_ORDER,
  },
  undoRedo: {
    historySize: 50,
  },
  devFiles: {
    saveHistorySize: 20,
  },
  postFx: {
    enabled: true,
    measureEnabled: false,
  },
};

/**
 * Merges the app's configuration over the engine defaults (shallowly, per top-level key), then
 * applies the env var and the debug-only LS overrides. `InitEngine` calls it with its `config`,
 * after {@link initEnvironment}.
 * @param appConfig the app's configuration (`InitEngine`'s `config` option)
 */
export const loadConfig = (appConfig: AppConfig = {}) => {
  config = {
    ...config,
    ...appConfig,
  };

  // Setup physics ENV configs
  if (!config.physics) config.physics = {};

  if (typeof envVars.VITE_PHYS_ENABLED === 'string') {
    const physicsEnabled = envVars.VITE_PHYS_ENABLED === 'true';
    config.physics.enabled = physicsEnabled;
    envVars.VITE_PHYS_ENABLED = physicsEnabled;
  }

  if (typeof envVars.VITE_PHYS_GRAVITY === 'string') {
    const grRaw: (number | string)[] = envVars.VITE_PHYS_GRAVITY.split(',');
    const gr: number[] = [];
    for (let i = 0; i < 3; i++) {
      let num = Number(grRaw[i]);
      if (isNaN(num)) num = 0;
      gr.push(num);
    }
    config.physics.gravity = { x: gr[0], y: gr[1], z: gr[2] };
    envVars.VITE_PHYS_GRAVITY = config.physics.gravity;
  }

  if (typeof envVars.VITE_PHYS_USE_SAB === 'string') {
    const useSAB = envVars.VITE_PHYS_USE_SAB === 'true';
    config.physics.useSAB = useSAB;
    envVars.VITE_PHYS_USE_SAB = useSAB;
  }

  if (typeof envVars.VITE_PHYS_TIMESTEP === 'string') {
    const timestep = Number(envVars.VITE_PHYS_TIMESTEP);
    if (!isNaN(timestep)) {
      config.physics.timestep = timestep;
      envVars.VITE_PHYS_TIMESTEP = timestep;
    } else {
      envVars.VITE_PHYS_TIMESTEP = undefined;
    }
  }

  // Debug-only boot-time physics overrides (set by the Physics API debug tab, applied on next reload)
  if (isDebugEnvironment()) {
    const debugPhysicsBoot = lsGetItem(DEBUG_PHYSICS_API_BOOT_LS_KEY, {}) as {
      workerTarget?: PhysicsWorkerTarget;
      useSAB?: boolean;
      maxBodies?: number;
      stepStatsEnabled?: boolean;
    };
    if (debugPhysicsBoot.workerTarget) {
      config.physics.workerTarget = debugPhysicsBoot.workerTarget;
    }
    if (typeof debugPhysicsBoot.useSAB === 'boolean') {
      config.physics.useSAB = debugPhysicsBoot.useSAB;
    }
    if (typeof debugPhysicsBoot.maxBodies === 'number') {
      config.physics.maxBodies = debugPhysicsBoot.maxBodies;
    }
    if (typeof debugPhysicsBoot.stepStatsEnabled === 'boolean') {
      config.physics.stepStatsEnabled = debugPhysicsBoot.stepStatsEnabled;
    }
  }

  // Setup assets ENV configs
  if (!config.assets) config.assets = {};

  const assetsTargetEnvs = [
    ['VITE_ASSETS_WORKER_TARGET', 'workerTarget'],
    ['VITE_ASSETS_GLTF_WORKER_TARGET', 'gltfWorkerTarget'],
    ['VITE_ASSETS_TEXTURE_WORKER_TARGET', 'textureWorkerTarget'],
    ['VITE_ASSETS_SIMPLIFY_WORKER_TARGET', 'simplifyWorkerTarget'],
  ] as const;
  for (const [envKey, configKey] of assetsTargetEnvs) {
    const target = envVars[envKey];
    if (target === 'MAIN_THREAD' || target === 'WORKER_THREAD') {
      config.assets[configKey] = target;
    } else if (target !== undefined) {
      envVars[envKey] = undefined;
    }
  }

  const assetsNumberEnvs = [
    ['VITE_ASSETS_MAX_CONCURRENT_LOADS', 'maxConcurrentLoads'],
    ['VITE_ASSETS_REQUEST_TIMEOUT_MS', 'requestTimeoutMs'],
  ] as const;
  for (const [envKey, configKey] of assetsNumberEnvs) {
    if (typeof envVars[envKey] !== 'string') continue;
    const value = Number(envVars[envKey]);
    if (!isNaN(value)) {
      config.assets[configKey] = value;
      envVars[envKey] = value;
    } else {
      envVars[envKey] = undefined;
    }
  }

  if (typeof envVars.VITE_ASSETS_FALLBACK_TO_MAIN_THREAD === 'string') {
    const fallbackToMainThread = envVars.VITE_ASSETS_FALLBACK_TO_MAIN_THREAD !== 'false';
    config.assets.fallbackToMainThread = fallbackToMainThread;
    envVars.VITE_ASSETS_FALLBACK_TO_MAIN_THREAD = fallbackToMainThread;
  }

  // Debug-only boot-time assets overrides (set by the Assets debug tab, applied on next reload)
  if (isDebugEnvironment()) {
    const debugAssetsBoot = lsGetItem(DEBUG_ASSETS_BOOT_LS_KEY, {}) as {
      workerTarget?: AssetsWorkerTarget;
      gltfWorkerTarget?: AssetsWorkerTarget;
      textureWorkerTarget?: AssetsWorkerTarget;
      simplifyWorkerTarget?: AssetsWorkerTarget;
    };
    if (debugAssetsBoot.workerTarget) config.assets.workerTarget = debugAssetsBoot.workerTarget;
    if (debugAssetsBoot.gltfWorkerTarget) {
      config.assets.gltfWorkerTarget = debugAssetsBoot.gltfWorkerTarget;
    }
    if (debugAssetsBoot.textureWorkerTarget) {
      config.assets.textureWorkerTarget = debugAssetsBoot.textureWorkerTarget;
    }
    if (debugAssetsBoot.simplifyWorkerTarget) {
      config.assets.simplifyWorkerTarget = debugAssetsBoot.simplifyWorkerTarget;
    }
  }

  // Setup ecs ENV configs
  if (!config.ecs) config.ecs = {};

  if (typeof envVars.VITE_ECS_STORAGE_MODE === 'string') {
    const storageMode = envVars.VITE_ECS_STORAGE_MODE;
    if (storageMode === 'MAP' || storageMode === 'TYPED_ARRAY') {
      config.ecs.storageMode = storageMode;
      envVars.VITE_ECS_STORAGE_MODE = storageMode;
    }
  }

  if (typeof envVars.VITE_ECS_MAX_ENTITIES === 'string') {
    const maxEntities = Number(envVars.VITE_ECS_MAX_ENTITIES);
    if (!isNaN(maxEntities)) {
      config.ecs.maxEntities = maxEntities;
      envVars.VITE_ECS_MAX_ENTITIES = maxEntities;
    } else {
      envVars.VITE_ECS_MAX_ENTITIES = undefined;
    }
  }
};

/**
 * Returns all environment variables.
 */
export const getEnvs = () => envVars;

/**
 * Returns a specific environment variable with key.
 * @param key environment variable key
 * @returns unknown
 */
export const getEnv = <T>(key: string) => envVars[key] as T;

/**
 * Checks whether the provided environment is the current one.
 * @param environment {@link Environments}
 * @returns boolean
 */
export const isCurrentEnvironment = (environment: Environments) => environment === curEnvironment;

/**
 * Checks whether the provided environment is NOT the current one.
 * @param environment {@link Environments}
 * @returns boolean
 */
export const isNotCurrentEnvironment = (environment: Environments) =>
  environment !== curEnvironment;

/**
 * Checks whether the current environment is a debug environment.
 * @returns boolean
 */
export const isDebugEnvironment = () =>
  (curEnvironment === 'development' || curEnvironment === 'test') && isDebugQueryParam;

/** Whether the current environment is a debug environment or not. False until `InitEngine`
 * reads the environment (a live binding: read it when it's needed, never into a module-level
 * constant). */
// @TODO: Replace the isDebugEnvironment with this
export let IS_DEBUG_ENV = false;

/**
 * Checks whether the app is in production test mode or not.
 * This works only in 'development' and
 * 'test' (?isProdTest=true) environments.
 * Note: this is not the same as isProdEnvironment(),
 * the purpose of this is to leave some debug UI elems
 * on the screen when testing production.
 */
// @TODO: Replace the isProdTestMode with this
export let IS_PROD_TEST_MODE = false;

/**
 * The `?startScene=<sceneId>` URL parameter: the scene the first `loadScene` of a page load
 * loads instead of the one it was asked for (and instead of the Debug tools' start scene).
 * Read only in the debug env and prod test mode ('development' and 'test' environments), so a
 * production build never reads it.
 * @returns the scene id, or null when the param isn't set or isn't read in this mode
 */
export const getStartSceneQueryParam = () =>
  IS_DEBUG_ENV || IS_PROD_TEST_MODE ? startSceneQueryParam : null;

/**
 * Checks whether the current environment is a production environment.
 * @returns boolean
 */
export const isProductionEnvironment = () =>
  curEnvironment === 'production' || isProdTestQueryParam;

/** Whether the current environment is a production environment or not. True until `InitEngine`
 * reads the environment (a live binding, like {@link IS_DEBUG_ENV}). */
// @TODO: Replace the isProductionEnvironment with this
export let IS_PROD_ENV = true;

/**
 * Checks whether the app is in production test mode or not.
 * This works only in 'development' and
 * 'test' (?isProdTest=true) environments.
 * Note: this is not the same as isProdEnvironment(),
 * the purpose of this is to leave some debug UI elems
 * on the screen when testing production.
 * @returns boolean
 */
export const isProdTestMode = () =>
  (curEnvironment === 'development' || curEnvironment === 'test') && isProdTestQueryParam;

/**
 * Checks whether the app is in production test mode or not.
 * This works only in 'development' and
 * 'test' (?isProdTest=true) environments.
 * Note: this is not the same as isProdEnvironment(),
 * the purpose of this is to leave some debug UI elems
 * on the screen when testing production.
 * @returns boolean
 */
// @TODO: Replace the isProdTestMode with this
export let IS_PROD_TEST_ENV = false;

/**
 * Returns the current environment.
 * @returns one of the environments ({@link Environments})
 */
export const getCurrentEnvironment = () => curEnvironment;

/** Current environment: 'production' until `InitEngine` reads the environment (a live binding,
 * like {@link IS_DEBUG_ENV}). */
// @TODO: Replace the getCurrentEnvironment with this
export let CUR_ENV: Environments = 'production';

/** {@link initEnvironment}'s input: where the environment is read from. */
export type EnvironmentInput = {
  /** The URL query string (`?isDebug=true`, `?isProdTest=true`, `?startScene=<sceneId>`). Default:
   * `window.location.search` where there is a `window`, else none. */
  search?: string;
  /** The env vars (`VITE_APP_ENV`, `VITE_PHYS_*`, `VITE_ASSETS_*`, …). Default: `import.meta.env`
   * (copied: {@link loadConfig} writes the parsed values back). */
  env?: Record<string, unknown>;
};

/**
 * Reads the environment (the env vars and the URL params) and sets the environment flags
 * ({@link IS_DEBUG_ENV}, {@link IS_PROD_TEST_MODE}, …) from it. `InitEngine` calls it first; no
 * module reads the environment at load, so before that every flag reads as production. A later
 * call reads it again.
 * @param input where to read from (a headless runner or a test passes its own)
 */
export const initEnvironment = ({ search, env }: EnvironmentInput = {}) => {
  const urlParams = new URLSearchParams(
    search ?? (typeof window !== 'undefined' ? window.location.search : '')
  );
  isProdTestQueryParam = urlParams.get('isProdTest') === 'true';
  isDebugQueryParam = urlParams.get('isDebug') === 'true';
  startSceneQueryParam = urlParams.get('startScene') || null;

  envVars = { ...(env ?? (import.meta.env as Record<string, unknown> | undefined)) };
  if (
    envVars.VITE_APP_ENV === 'development' ||
    envVars.VITE_APP_ENV === 'test' ||
    envVars.VITE_APP_ENV === 'unitTest'
  ) {
    curEnvironment = envVars.VITE_APP_ENV;
  } else {
    curEnvironment = 'production';
  }

  const isDevOrTest = curEnvironment === 'development' || curEnvironment === 'test';
  IS_DEBUG_ENV = isDevOrTest && isDebugQueryParam;
  IS_PROD_TEST_MODE = isDevOrTest && isProdTestQueryParam;
  IS_PROD_TEST_ENV = IS_PROD_TEST_MODE;
  IS_PROD_ENV = curEnvironment === 'production' || isProdTestQueryParam;
  CUR_ENV = curEnvironment;
};

/**
 * Return app config
 * @returns config ({@link AppConfig})
 */
export const getConfig = () => config;

/** App configurations. */
// @TODO: Replace the getConfig with this
export const APP_CONFIG = config;

/** Project metadata. */
export const PROJECT_METADATA: {
  /** App specific metadata */
  app: {
    /** App version */
    version: string;
    /** App version codename */
    codename: string;
    /** App name */
    name: string;
    /** App full name */
    fullName: string;
    /** App description */
    description: string;
    /** App URL */
    url: string;
    /** App repository URL */
    repoUrl: string;
    /** App author */
    author: string;
  };
  /** Engine specific metadata */
  engine: {
    /** Engine version */
    version: string;
    /** Engine codename */
    codename: string;
    /** Engine name */
    name: string;
    /** Engine full name */
    fullName: string;
    /** Engine description */
    description: string;
    /** Engine URL */
    url: string;
    /** Engine repository URL */
    repoUrl: string;
    /** Engine author */
    author: string;
  };
  /** Toolkit (src/toolkit/) specific metadata. It ships with the engine but is versioned on its
   * own, so the repository and author default to the engine's. */
  toolkit: {
    /** Toolkit version */
    version: string;
    /** Toolkit codename */
    codename: string;
    /** Toolkit name */
    name: string;
    /** Toolkit full name */
    fullName: string;
    /** Toolkit description */
    description: string;
    /** Toolkit URL */
    url: string;
    /** Toolkit repository URL */
    repoUrl: string;
    /** Toolkit author */
    author: string;
  };
  /** package.json version number */
  pkgVersion: string;
  /** package.json license (SPDX id) */
  license: string;
  /** The runtime dependencies' versions from package.json (package name → version). */
  packages: Record<string, string>;
  /** The main build tools' versions from package.json (vite, typescript). */
  buildTools: Record<string, string>;
  /** This build: the short git commit ('' without git), whether tracked files had uncommitted
   * changes, and the build time (ISO; the dev server's start time in dev). */
  build: { commit: string; hasLocalChanges: boolean; time: string };
  /** Version hash created from versionChecksumString. */
  versionChecksum: string;
  /** Version string created from all version data:
   *
   * "appVersion-appCodename_engVersion-engCodename_toolkitVersion-toolkitCodename_pkgVersion"
   */
  versionChecksumString: string;
} = __PROJECT_METADATA__;
