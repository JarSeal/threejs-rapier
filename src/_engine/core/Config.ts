import configFile from '../../CONFIG';
import { type DebugScene } from '../debug/debugScenes/debuggerSceneListing';

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
    worldStepEnabled?: boolean;
    visualizerEnabled?: boolean;
    gravity?: { x: number; y: number; z: number };
    timestep?: number;
  };
};

let curEnvironment: Environments = 'production';
let envVars: { [key: string]: unknown } = {};
let config: AppConfig = {
  // These are the default values (if the values are not found in ENV variables or CONFIG file)
  debugKeys: [],
  physics: {
    enabled: false,
    worldStepEnabled: true,
    gravity: { x: 0, y: 0, z: 0 },
    timestep: 60,
  },
};

/**
 * Loads all environment variables and configurations. This should be the first thing called in a project.
 */
export const loadConfig = () => {
  // Load config file

  // Load ENV variables
  envVars = import.meta.env;

  // Load CONFIG file
  config = {
    ...config,
    ...configFile,
  };

  if (
    envVars.VITE_APP_ENV === 'development' ||
    envVars.VITE_APP_ENV === 'test' ||
    envVars.VITE_APP_ENV === 'unitTest'
  ) {
    curEnvironment = envVars.VITE_APP_ENV;
  } else {
    curEnvironment = 'production';
  }

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
  curEnvironment === 'development' || curEnvironment === 'test';

/**
 * Checks whether the current environment is a production environment.
 * @returns boolean
 */
export const isProductionEnvironment = () => curEnvironment === 'production';

/**
 * Returns the current environment.
 * @returns one of the environments ({@link Environments})
 */
export const getCurrentEnvironment = () => curEnvironment;

/**
 * Return app config
 * @returns config ({@link AppConfig})
 */
export const getConfig = () => config;
