import { getConfig, IS_DEBUG_ENV } from '../core/Config';
import { loadDebugModuleAsync } from '../utils/helpers';
import { getDebugToolsState } from './DebugToolsManager';
import type {
  DevDataGatheredEvent,
  DevFilesCommitBody,
  DevFilesErrorCode,
  DevFilesSaveData,
  DevFilesStatusBody,
} from './DevFilesProtocol';

export type {
  DevDataGatheredEvent,
  DevFilesCommitBody,
  DevFilesConflicts,
  DevFilesErrorCode,
  DevFilesSaveData,
  DevFilesSchemaIssues,
  DevFilesStatusBody,
  DevFilesWriteStatus,
} from './DevFilesProtocol';

/**
 * Dev files (p342): debug tooling writes files into the repo while `yarn dev` runs (an exported
 * impostor, a baked texture). The dev server's plugin (`devTools/devFilesPlugin.ts`) does the
 * writing; this is the browser side. Debug env only, and only with the dev server: in a build,
 * or with `AEK_DEV_FILES=false`, {@link getDevFilesStatus} reports it unavailable and
 * {@link writeDevFiles} rejects.
 *
 * Writes from this machine only, unless the server runs with `AEK_DEV_FILES_LAN=true`. Paths are
 * repo-relative and must be in `src/app/`, `src/toolkit/` or `src/public/` (not
 * `src/public/aek-assets/`), with a `.json`, `.png`, `.jpg`, `.jpeg` or `.webp` extension. A
 * write is an ordinary file event: the scene gatherer and the asset pipeline run as for an
 * editor save, and the page reloads after the gather ({@link onDevDataGathered} tells how it
 * went, before the reload).
 *
 * A debug override goes into an asset JSON's `__saveData` with a `saveData` write: the server
 * puts the entry first for its scene, stamps it with the engine, toolkit and app versions and
 * keeps {@link getDevFilesSaveHistorySize} entries for the scene.
 */

type DevFilesModule = typeof import('../core/Debug/_dbg__DevFiles');
let devFilesModule: Promise<DevFilesModule | null> | null = null;

/** Loads the implementation once; null outside the debug env */
const loadDevFiles = () => {
  devFilesModule ??= loadDebugModuleAsync(
    () => import('../core/Debug/_dbg__DevFiles'),
    false,
    'Dev files'
  ).then(
    (ref) => ref?.current ?? null,
    (err: unknown) => {
      devFilesModule = null;
      throw err;
    }
  );
  return devFilesModule;
};

const requireDevFiles = async () => {
  const module = await loadDevFiles();
  if (!module) throw new DevFilesError('UNAVAILABLE', 'Dev files work in the debug env only');
  return module;
};

/** The server's codes, plus the client's own: `UNAVAILABLE` (not the debug env, no dev server or
 * no token in the page) and `NETWORK` (the request failed, or the answer wasn't the server's). */
export type DevFilesClientErrorCode = DevFilesErrorCode | 'UNAVAILABLE' | 'NETWORK';

/** A refused or failed dev files request. `details` is the server's: `CONFLICT` has
 * {@link DevFilesConflicts}, `INVALID_SCHEMA` {@link DevFilesSchemaIssues}. */
export class DevFilesError extends Error {
  constructor(
    readonly code: DevFilesClientErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'DevFilesError';
  }
}

export type DevFilesUnavailableReason =
  /** Not the debug env (`?isDebug=true` in a development or test env) */
  | 'NOT_DEBUG_ENV'
  /** The page wasn't served by the dev server (a build) */
  | 'NO_DEV_SERVER'
  /** The status request failed or was refused (eg. the Host isn't in `server.allowedHosts`) */
  | 'UNREACHABLE'
  /** `AEK_DEV_FILES=false` */
  | 'NOT_ENABLED'
  /** This device isn't the server's machine, and the server doesn't take writes from the LAN */
  | 'NOT_LOCAL'
  /** The page has no token (it was served before the routes were turned on): reload it */
  | 'NO_TOKEN';

export type DevFilesStatus =
  | { available: true; server: DevFilesStatusBody }
  | {
      available: false;
      reason: DevFilesUnavailableReason;
      message: string;
      /** The server's status, when it answered */
      server: DevFilesStatusBody | null;
    };

/** One write of a {@link writeDevFiles} batch. */
export type DevFileWrite = {
  /** Repo-relative and `/`-separated, eg. `src/app/textures/rock.texture.json` */
  path: string;
  /** The `sha256` the tool read ({@link readDevFile}): the batch fails with `CONFLICT` when the
   * file has changed since. `null`: the file must not exist yet. Omitted: overwrite. */
  expectedHash?: string | null;
} & (
  | {
      /** A JSON value (not text): the server validates it against its gathered schema, if its
       * suffix has one, and formats it with Prettier. */
      json: unknown;
    }
  | {
      /** The file's bytes (eg. a PNG from {@link encodePNG}), uploaded as is */
      blob: Blob;
    }
  | {
      /**
       * A save entry for an existing gathered asset JSON with `__saveData` (not a texture array
       * or atlas): `entry` (the overrides, in the asset's overrides schema) goes first in
       * `__saveData[sceneId]`, the older entries after it, so the gatherer applies it in that
       * scene. The server stamps `entry.__meta` with `engineVersion`, `toolkitVersion`,
       * `appVersion` and, unless it has one, `date`, then validates and formats the file like a
       * `json` write. The scene keeps {@link getDevFilesSaveHistorySize} entries, the new one
       * included (the older ones are dropped); with 0 the batch fails with `SAVE_DATA_DISABLED`
       * before anything is sent. An entry equal to the scene's latest (its `__meta` aside) is
       * `unchanged`. A missing file fails with `NOT_FOUND`.
       */
      saveData: DevFilesSaveData;
    }
);

export type DevFileRead = {
  path: string;
  sha256: string;
  bytes: Uint8Array;
  /** The parsed file, for a `.json` path */
  json?: unknown;
};

/** An image {@link encodePNG} takes: canvas pixels, or tightly packed RGBA8 rows */
export type PNGSource =
  | ImageData
  | HTMLCanvasElement
  | OffscreenCanvas
  | { data: Uint8Array | Uint8ClampedArray; width: number; height: number };

export type EncodePNGOpts = {
  /** Writes the rows bottom-up (pixels read back with the first row at the bottom) */
  flipY?: boolean;
};

/** `AppConfig.devFiles.saveHistorySize`'s default */
export const DEFAULT_SAVE_HISTORY_SIZE = 20;

const toValidSaveHistorySize = (size: unknown) =>
  typeof size === 'number' && Number.isFinite(size) ? Math.max(-1, Math.round(size)) : null;

/**
 * How many `__saveData` entries a `saveData` write keeps per scene, the new one included: the
 * Debug tools tab's "File server" setting, which defaults to `AppConfig.devFiles.saveHistorySize`
 * (20). -1: all of them; 0: saving into `__saveData` is off (a tool should disable its save
 * button). Always 0 outside the debug env.
 */
export const getDevFilesSaveHistorySize = (): number => {
  if (!IS_DEBUG_ENV) return 0;
  return (
    toValidSaveHistorySize(getDebugToolsState().devFiles?.saveHistorySize) ??
    toValidSaveHistorySize(getConfig().devFiles?.saveHistorySize) ??
    DEFAULT_SAVE_HISTORY_SIZE
  );
};

/**
 * Whether this page can write dev files, and the server's settings. Never rejects.
 */
export const getDevFilesStatus = async (): Promise<DevFilesStatus> => {
  if (!IS_DEBUG_ENV) {
    return {
      available: false,
      reason: 'NOT_DEBUG_ENV',
      message: 'Dev files work in the debug env only',
      server: null,
    };
  }
  return (await requireDevFiles())._getDevFilesStatus();
};

/**
 * Writes a batch of files into the repo: every write lands or none does. A blob is uploaded
 * (staged) first, then the batch is committed.
 * @returns per file its `sha256` and whether it was `created`, `updated` or `unchanged` (an
 * unchanged file isn't written, so it sets off no gather: a batch of unchanged files gets no
 * {@link onDevDataGathered} event)
 * @throws {@link DevFilesError}
 */
export const writeDevFiles = async (writes: DevFileWrite[]): Promise<DevFilesCommitBody> =>
  (await requireDevFiles())._writeDevFiles(writes);

/**
 * Reads a file the dev files may write, with the `sha256` to pass as a write's `expectedHash`.
 * @returns null when the file doesn't exist
 * @throws {@link DevFilesError}
 */
export const readDevFile = async (path: string): Promise<DevFileRead | null> =>
  (await requireDevFiles())._readDevFile(path);

/**
 * Encodes an image as a PNG `Blob` (eg. pixels read back from a render target, for
 * {@link writeDevFiles}). `ImageData` and RGBA8 buffers are encoded byte for byte: the colour of
 * a fully transparent pixel is kept (a canvas would lose it, it stores premultiplied alpha).
 * Debug env only; it needs no dev server.
 * @throws {@link DevFilesError} `UNAVAILABLE` outside the debug env
 */
export const encodePNG = async (source: PNGSource, opts?: EncodePNGOpts): Promise<Blob> =>
  (await requireDevFiles())._encodePNG(source, opts);

/**
 * Calls `fn` after each gather the dev server runs (a dev files write, an editor save), with how
 * it went, the changed files and whether the page reloads next. A tool finds its own write by
 * one of the paths it wrote in `files`. The reload waits for a promise `fn` returns, up to 2 s
 * (eg. to save a note that survives it). Debug env with the dev server only, else a no-op.
 * @returns a function that removes the listener
 */
export const onDevDataGathered = (
  fn: (event: DevDataGatheredEvent) => void | Promise<void>
): (() => void) => {
  let isRemoved = false;
  let remove: (() => void) | null = null;
  loadDevFiles().then(
    (module) => {
      if (module && !isRemoved) remove = module._onDevDataGathered(fn);
    },
    () => undefined // loadDebugModuleAsync logged it
  );
  return () => {
    isRemoved = true;
    remove?.();
  };
};
