import { llog } from '../utils/Logger';

export type Environments = 'development' | 'test' | 'unitTest' | 'production';

let curEnvironment: Environments = 'production';
let envVars: { [key: string]: unknown } = {};

/**
 * Loads all environment variables and configurations. This should be the first thing called in a project.
 */
export const loadConfig = () => {
  // Load config file
  // @TODO: load the config file from the root

  // Load ENV variables
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

  if (typeof envVars.VITE_GRAVITY === 'string') {
    const gr: (number | string)[] = envVars.VITE_GRAVITY.split(',');
    gr.forEach((value, index) => {
      let num = Number(value);
      if (isNaN(num)) num = 0;
      gr[index] = num;
    });
    envVars.VITE_GRAVITY = { x: gr[0], y: gr[1], z: gr[2] };
  }

  llog(`Current environment: ${getCurrentEnvironment()}`);
  console.log('envVars', envVars);
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
 * Returns the current environment.
 * @returns one of the environments ({@link Environments})
 */
export const getCurrentEnvironment = () => curEnvironment;

export const getConfig = () => {};
