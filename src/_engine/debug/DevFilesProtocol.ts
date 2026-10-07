/**
 * The dev file server's routes (p342), under `/__aek/files/`: what the server
 * (`devTools/devFilesPlugin.ts`) and the browser client (`debug/DevFiles.ts`) share.
 * No imports: the dev server (Node) imports this too.
 */

export const DEV_FILES_ROUTE_BASE = '/__aek/files/';
/** The request header every route but `status` needs */
export const DEV_FILES_TOKEN_HEADER = 'x-aek-dev-token';
/** The `<meta name>` the token is injected into `index.html` with */
export const DEV_FILES_TOKEN_META = 'aek-dev-files';
/** The `read` route's response header with the file's hash */
export const DEV_FILES_HASH_HEADER = 'x-aek-sha256';

export type DevFilesErrorCode =
  | 'NOT_ENABLED'
  | 'BAD_TOKEN'
  | 'BAD_ORIGIN'
  | 'BAD_HOST'
  | 'NOT_LOCAL'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN_PATH'
  | 'TOO_LARGE'
  | 'CONFLICT'
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA'
  | 'STAGE_EXPIRED'
  | 'WRITE_FAILED';

export type DevFilesErrorBody = {
  error: { code: DevFilesErrorCode; message: string; details?: unknown };
};

/** `GET status` */
export type DevFilesStatusBody = {
  enabled: boolean;
  /** `AEK_DEV_FILES_LAN=true`: the other routes take requests from the LAN too */
  writesFromLAN: boolean;
  /** This request's device may use the other routes (it's local, or the LAN is allowed) */
  canWrite: boolean;
  /** The folders a path must be in (repo-relative, `/`-terminated) */
  roots: string[];
  /** The folders inside them a path must not be in */
  deniedRoots: string[];
  extensions: string[];
  maxFileBytes: number;
  maxBatchBytes: number;
};

/** `PUT stage` */
export type DevFilesStageBody = { stageId: string; bytes: number; sha256: string };

/** One write of a `POST commit` batch */
export type DevFilesWrite = {
  /** Repo-relative, `/`-separated */
  path: string;
  /** The hash the tool read; null: the file must not exist yet; omitted: overwrite */
  expectedHash?: string | null;
} & ({ json: unknown } | { stageId: string });

export type DevFilesCommitRequest = { writes: DevFilesWrite[] };

export type DevFilesWriteStatus = 'created' | 'updated' | 'unchanged';

/** `POST commit` */
export type DevFilesCommitBody = {
  results: { path: string; sha256: string; status: DevFilesWriteStatus }[];
};

/** `INVALID_SCHEMA`'s details: the issues per file, as the gatherer lists them */
export type DevFilesSchemaIssues = { path: string; issues: { path: string; message: string }[] }[];

/** `CONFLICT`'s details: the hashes on disk now (null: no file) */
export type DevFilesConflicts = { path: string; currentHash: string | null }[];
