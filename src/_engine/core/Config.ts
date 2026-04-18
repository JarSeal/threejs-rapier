import configFile from '../../CONFIG';
import { type DebugScene } from '../debug/debugScenes/debuggerSceneListing';
import { TCMP } from '../utils/CMP';
import {
  PhysicsBackgroundBehavior,
  PhysicsEngine,
  PhysicsWorkerTarget,
} from './Physics/PhysicsAPITypes';
import { DraggableWindow } from './UI/DraggableWindow';

export type Environments = 'development' | 'test' | 'unitTest' | 'production';

export type AppConfig = {
  debugKeys?: {
    enabled?: boolean; // Default is true
    id?: string;
    key?: string | string[];
    type?: 'KEY_UP' | 'KEY_DOWN'; // Default is 'KEY_UP'
    sceneId?: string;
    fn: (e: KeyboardEvent, pressedTime: number) => void;
  }[];
  debugScenes?: DebugScene[];
  physics?: {
    enabled?: boolean;
    physicsEngine?: PhysicsEngine;
    workerTarget?: PhysicsWorkerTarget;
    worldStepEnabled?: boolean;
    visualizerEnabled?: boolean;
    gravity?: { x: number; y: number; z: number };
    timestep?: number;
    backgroundBehavior?: PhysicsBackgroundBehavior;
    solverIterations?: number;
    internalPgsIterations?: number;
    interpolationEnabled?: boolean;
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
    workerTarget: 'MAIN_THREAD',
    worldStepEnabled: true,
    gravity: { x: 0, y: 0, z: 0 },
    timestep: 60,
    backgroundBehavior: 'PAUSE',
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

  if (typeof envVars.VITE_PHYS_TIMESTEP === 'string') {
    const timestep = Number(envVars.VITE_PHYS_TIMESTEP);
    if (!isNaN(timestep)) {
      config.physics.timestep = timestep;
      envVars.VITE_PHYS_TIMESTEP = timestep;
    } else {
      envVars.VITE_PHYS_TIMESTEP = undefined;
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
