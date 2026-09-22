import configFile from '../../CONFIG';
import { TCMP } from '../utils/CMP';
import {
  PhysicsBackgroundBehavior,
  PhysicsEngine,
  PhysicsInterpolationMode,
  PhysicsWorkerTarget,
} from './Physics/PhysicsAPITypes';
import { DraggableWindow } from './UI/DraggableWindow';
import { ECSStorageMode } from './ECS/ECSComponentStorage';
import { lsGetItem } from '../utils/LocalAndSessionStorage';

/** LS key for debug-only boot-time physics overrides (workerTarget/useSAB/maxBodies). Written by the Physics API debug tab, read once in loadConfig(). */
export const DEBUG_PHYSICS_API_BOOT_LS_KEY = 'AEK_debugPhysicsApiBoot';

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
   * fat-line path is available; see p025 Phase 6. */
  lineThickness?: number;
};

export type AppConfig = {
  debugKeys?: {
    enabled?: boolean; // Default is true
    id?: string;
    key?: string | string[];
    type?: 'KEY_UP' | 'KEY_DOWN'; // Default is 'KEY_UP'
    sceneId?: string;
    fn: (e: KeyboardEvent, pressedTime: number) => void;
  }[];
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
  };
  ecs?: {
    /** Build-time-selectable ECS component storage backend. Default 'MAP'. */
    storageMode?: ECSStorageMode;
    /** Fixed capacity for TYPED_ARRAY storage. Default 100_000, only relevant when storageMode is 'TYPED_ARRAY'. */
    maxEntities?: number;
  };
  /** Per-state colors and line thickness for the per-entity physics collider wireframes
   * (docs/plans/_DONE_p025_debug-drawing-in-physics-api.md). Debug-only: nothing reads this
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
  draggableWindows?: {
    [id: string]: Partial<DraggableWindow> & {
      contentFn?: (data?: { [key: string]: unknown }) => TCMP;
    };
  };
};

let curEnvironment: Environments = 'production';
let envVars: { [key: string]: unknown } = {};
let isProdTestQueryParam = false;
let isDebugQueryParam = false;
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
};

// Load url params
const urlParams = new URLSearchParams(window.location.search);
isProdTestQueryParam = urlParams.get('isProdTest') === 'true';
isDebugQueryParam = urlParams.get('isDebug') === 'true';

// Load ENV variables and get curEnvironment
envVars = import.meta.env;
if (
  envVars.VITE_APP_ENV === 'development' ||
  envVars.VITE_APP_ENV === 'test' ||
  envVars.VITE_APP_ENV === 'unitTest'
) {
  curEnvironment = envVars.VITE_APP_ENV;
} else {
  curEnvironment = 'production';
}

/**
 * Loads all environment variables and configurations. This should be the first thing called in a project.
 */
export const loadConfig = () => {
  // Load CONFIG file
  config = {
    ...config,
    ...configFile,
  };

  // Setup physics ENV configs
  if (!config.physics) config.physics = {};

  if (typeof envVars.VITE_PHYS_ENABLED === 'string') {
    const physicsEnabled = Boolean(envVars.VITE_PHYS_ENABLED);
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
    const useSAB = Boolean(envVars.VITE_PHYS_USE_SAB);
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

/** Whether the current environment is a debug environment or not. */
// @TODO: Replace the isDebugEnvironment with this
export const IS_DEBUG_ENV =
  (curEnvironment === 'development' || curEnvironment === 'test') && isDebugQueryParam;

/**
 * Checks whether the app is in production test mode or not.
 * This works only in 'development' and
 * 'test' (?isProdTest=true) environments.
 * Note: this is not the same as isProdEnvironment(),
 * the purpose of this is to leave some debug UI elems
 * on the screen when testing production.
 */
// @TODO: Replace the isProdTestMode with this
export const IS_PROD_TEST_MODE =
  (curEnvironment === 'development' || curEnvironment === 'test') && isProdTestQueryParam;

/**
 * Checks whether the current environment is a production environment.
 * @returns boolean
 */
export const isProductionEnvironment = () =>
  curEnvironment === 'production' || isProdTestQueryParam;

/** Whether the current environment is a production environment or not. */
// @TODO: Replace the isProductionEnvironment with this
export const IS_PROD_ENV = curEnvironment === 'production' || isProdTestQueryParam;

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
export const IS_PROD_TEST_ENV =
  (curEnvironment === 'development' || curEnvironment === 'test') && isProdTestQueryParam;

/**
 * Returns the current environment.
 * @returns one of the environments ({@link Environments})
 */
export const getCurrentEnvironment = () => curEnvironment;

/** Current environment */
// @TODO: Replace the getCurrentEnvironment with this
export const CUR_ENV = curEnvironment;

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
  /** Merged version number. This is a sum of each SemVar number (major.minor.patch). Example of calculation:
   *
   * App version: 1.3.23
   *
   * Engine version: 0.1.12
   *
   * Merge version: 1.3.23 + 0.1.12 = 1.4.37
   * */
  mergeVersion: string;
  /** package.json version number */
  pkgVersion: string;
  /** Version hash created from versionChecksumString. */
  versionChecksum: string;
  /** Version string created from all version data:
   *
   * "mergeVersion_appVersion-appCodename_engVersion-engCodename_pkgVersion"
   */
  versionChecksumString: string;
} = __PROJECT_METADATA__;
