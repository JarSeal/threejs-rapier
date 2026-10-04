import path from 'path';
import { pathToFileURL } from 'url';
import type { AppConfig } from '../../src/_engine/core/Config';
import { SRC_DIR } from './sources';

/**
 * The project switches (p300 DD8 level 1): `AppConfig.assets.optimization` in src/CONFIG.ts,
 * plus the env var `AEK_ASSETS_OPTIMIZE`, which overrides `enabled` for one run. They win over
 * every profile, rule and asset JSON.
 */

export type OptimizationConfig = NonNullable<NonNullable<AppConfig['assets']>['optimization']>;

/** Why each side is off for the whole project; an absent key means it's on. */
export type ProjectOptOut = { textures?: string; mesh?: string };

export const CONFIG_FILE = path.join(SRC_DIR, 'CONFIG.ts');
export const ENV_KEY = 'AEK_ASSETS_OPTIMIZE';
/**
 * A production build fails when an asset a shipped scene uses has no output (Phase 3 step 4).
 * This env var ships the ones `ktx` couldn't build unoptimized instead, for one build.
 */
export const ALLOW_UNOPTIMIZED_ENV_KEY = 'AEK_ASSETS_ALLOW_UNOPTIMIZED';

type Env = Record<string, string | undefined>;

/** true / false / 1 / 0; undefined when unset or empty. Throws for anything else. */
const readEnvBoolean = (key: string, env: Env) => {
  const value = env[key];
  if (value === undefined || value === '') return undefined;
  if (!['true', 'false', '1', '0'].includes(value)) {
    throw new Error(`${key}="${value}" is invalid (true, false, 1 or 0)`);
  }
  return value === 'true' || value === '1';
};

/** Throws for an `AEK_ASSETS_ALLOW_UNOPTIMIZED` that isn't true / false / 1 / 0. */
export const isUnoptimizedAllowed = (env: Env = process.env) =>
  readEnvBoolean(ALLOW_UNOPTIMIZED_ENV_KEY, env) ?? false;

/** Throws for an `AEK_ASSETS_OPTIMIZE` that isn't true / false / 1 / 0. */
export const resolveProjectOptOut = (
  optimization: OptimizationConfig = {},
  env: Env = process.env
): ProjectOptOut => {
  const isEnabled = readEnvBoolean(ENV_KEY, env);
  if (isEnabled !== undefined) {
    const envValue = env[ENV_KEY];
    if (!isEnabled) {
      const reason = `${ENV_KEY}=${envValue}`;
      return { textures: reason, mesh: reason };
    }
    // An env var that turns it on overrides `enabled` only, not the per-side switches
    optimization = { ...optimization, enabled: true };
  }
  if (optimization.enabled === false) {
    const reason = 'assets.optimization.enabled: false in src/CONFIG.ts';
    return { textures: reason, mesh: reason };
  }
  return {
    ...(optimization.textures === false
      ? { textures: 'assets.optimization.textures: false in src/CONFIG.ts' }
      : {}),
    ...(optimization.meshes === false
      ? { mesh: 'assets.optimization.meshes: false in src/CONFIG.ts' }
      : {}),
  };
};

/**
 * Reads the switches from src/CONFIG.ts when called, for the command line (tsx). Not for the Vite
 * config's process: a static import there would make every CONFIG.ts edit restart the dev server,
 * and Node can't import .ts by itself. The dev server loads CONFIG.ts through Vite instead and
 * passes its `assets.optimization` to `resolveProjectOptOut`.
 */
export const loadProjectOptOut = async (env?: Env) => {
  const module = (await import(pathToFileURL(CONFIG_FILE).href)) as { default: AppConfig };
  return resolveProjectOptOut(module.default.assets?.optimization, env);
};
