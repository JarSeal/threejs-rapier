import { llog } from '../utils/Logger';

export type Environments = 'development' | 'test' | 'unitTest' | 'production';

let curEnvironment: Environments = 'production';
export let envVars: { [key: string]: unknown } = {};

export const loadConfig = () => {
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
  llog(`Current environment: ${getCurrentEnvironment()}`);
};

export const getEnvs = () => envVars;

export const getEnv = (key: string) => envVars[key];

export const isCurrentEnvironment = (environment: Environments) => environment === curEnvironment;
export const isNotCurrentEnvironment = (environment: Environments) =>
  environment !== curEnvironment;
export const isDebugEnvironment = () =>
  curEnvironment === 'development' || curEnvironment === 'test';

export const getCurrentEnvironment = () => curEnvironment;
