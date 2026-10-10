import { describe, expect, test } from 'vitest';

// No window stub: Config.ts reads the environment only in initEnvironment() (p606 Phase 5)
import {
  CUR_ENV,
  getConfig,
  getEnv,
  getStartSceneQueryParam,
  initEnvironment,
  IS_DEBUG_ENV,
  IS_PROD_ENV,
  IS_PROD_TEST_MODE,
  isDebugEnvironment,
  loadConfig,
} from './Config';

describe('initEnvironment', () => {
  // First in the file: nothing has called initEnvironment yet
  test('before it runs, the flags read as production', () => {
    expect(CUR_ENV).toBe('production');
    expect(IS_DEBUG_ENV).toBe(false);
    expect(IS_PROD_TEST_MODE).toBe(false);
    expect(IS_PROD_ENV).toBe(true);
    expect(getStartSceneQueryParam()).toBe(null);
  });

  test('?isDebug=true turns the debug env on in development, and the flags are live', () => {
    initEnvironment({
      search: '?isDebug=true&startScene=physicsTiers',
      env: { VITE_APP_ENV: 'development' },
    });
    expect(CUR_ENV).toBe('development');
    expect(IS_DEBUG_ENV).toBe(true);
    expect(isDebugEnvironment()).toBe(true);
    expect(IS_PROD_TEST_MODE).toBe(false);
    expect(IS_PROD_ENV).toBe(false);
    expect(getStartSceneQueryParam()).toBe('physicsTiers');
  });

  test('?isProdTest=true turns prod test mode on in test', () => {
    initEnvironment({ search: '?isProdTest=true', env: { VITE_APP_ENV: 'test' } });
    expect(CUR_ENV).toBe('test');
    expect(IS_DEBUG_ENV).toBe(false);
    expect(IS_PROD_TEST_MODE).toBe(true);
    expect(IS_PROD_ENV).toBe(true);
  });

  test('a production build ignores the URL params', () => {
    initEnvironment({ search: '?isDebug=true&isProdTest=true&startScene=physicsTiers', env: {} });
    expect(CUR_ENV).toBe('production');
    expect(IS_DEBUG_ENV).toBe(false);
    expect(IS_PROD_TEST_MODE).toBe(false);
    expect(getStartSceneQueryParam()).toBe(null);
  });
});

describe('loadConfig', () => {
  test('merges the app config per top-level key and parses the env vars into a copy', () => {
    const env = { VITE_PHYS_GRAVITY: '0,-3,x' };
    initEnvironment({ search: '', env });
    loadConfig({ physics: { enabled: true }, undoRedo: { historySize: 7 } });

    const config = getConfig();
    expect(config.physics?.enabled).toBe(true);
    // Shallow: the app's `physics` replaces the defaults' whole
    expect(config.physics?.workerTarget).toBeUndefined();
    expect(config.physics?.gravity).toEqual({ x: 0, y: -3, z: 0 });
    expect(config.undoRedo?.historySize).toBe(7);
    expect(config.ecs?.storageMode).toBe('MAP');
    expect(getEnv('VITE_PHYS_GRAVITY')).toEqual({ x: 0, y: -3, z: 0 });
    expect(env.VITE_PHYS_GRAVITY).toBe('0,-3,x');
  });
});
