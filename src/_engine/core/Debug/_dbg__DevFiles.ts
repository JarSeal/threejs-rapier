import {
  DevFilesError,
  getDevFilesSaveHistorySize,
  type DevFileRead,
  type DevFilesStatus,
  type DevFileWrite,
  type EncodePNGOpts,
  type PNGSource,
} from '../../debug/DevFiles';
import {
  AEK_GATHER_EVENT,
  DEV_FILES_HASH_HEADER,
  DEV_FILES_ROUTE_BASE,
  DEV_FILES_TOKEN_HEADER,
  DEV_FILES_TOKEN_META,
  type DevFilesCommitBody,
  type DevDataGatheredEvent,
  type DevFilesCommitRequest,
  type DevFilesErrorBody,
  type DevFilesStageBody,
  type DevFilesStatusBody,
} from '../../debug/DevFilesProtocol';
import { lerror } from '../../utils/Logger';
import { encodeRGBA8PNG } from './_dbg__PNGEncoder';

/** The dev files' browser side (p342 §2.4); the public API is `debug/DevFiles.ts`. */

const getToken = () =>
  document.querySelector<HTMLMetaElement>(`meta[name="${DEV_FILES_TOKEN_META}"]`)?.content || null;

const isErrorBody = (body: unknown): body is DevFilesErrorBody =>
  !!body &&
  typeof body === 'object' &&
  'error' in body &&
  typeof (body as DevFilesErrorBody).error?.code === 'string';

/** A route's response; a refusal rejects with the server's code */
const request = async (route: string, init: RequestInit = {}, withToken = true) => {
  const headers = new Headers(init.headers);
  if (withToken) {
    if (!import.meta.hot) {
      throw new DevFilesError('UNAVAILABLE', "The page wasn't served by the dev server");
    }
    const token = getToken();
    if (!token) {
      throw new DevFilesError(
        'UNAVAILABLE',
        'The page has no dev files token (AEK_DEV_FILES=false, or reload the page)'
      );
    }
    headers.set(DEV_FILES_TOKEN_HEADER, token);
  }
  let response: Response;
  try {
    response = await fetch(`${DEV_FILES_ROUTE_BASE}${route}`, {
      ...init,
      headers,
      cache: 'no-store',
    });
  } catch (err) {
    throw new DevFilesError('NETWORK', `Dev files ${route}: ${(err as Error).message}`);
  }
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => null);
  if (isErrorBody(body)) {
    throw new DevFilesError(body.error.code, body.error.message, body.error.details);
  }
  throw new DevFilesError('NETWORK', `Dev files ${route}: HTTP ${response.status}`);
};

const readJson = async <T>(response: Response, route: string) => {
  try {
    return (await response.json()) as T;
  } catch {
    throw new DevFilesError('NETWORK', `Dev files ${route}: the answer isn't JSON`);
  }
};

export const _getDevFilesStatus = async (): Promise<DevFilesStatus> => {
  if (!import.meta.hot) {
    return {
      available: false,
      reason: 'NO_DEV_SERVER',
      message: "The page wasn't served by the dev server",
      server: null,
    };
  }
  let server: DevFilesStatusBody;
  try {
    server = await readJson<DevFilesStatusBody>(await request('status', {}, false), 'status');
  } catch (err) {
    return {
      available: false,
      reason: 'UNREACHABLE',
      message: (err as Error).message,
      server: null,
    };
  }
  if (!server.enabled) {
    return {
      available: false,
      reason: 'NOT_ENABLED',
      message: 'The dev file routes are off (AEK_DEV_FILES=false)',
      server,
    };
  }
  if (!server.canWrite) {
    return {
      available: false,
      reason: 'NOT_LOCAL',
      message: 'Writes from the server’s machine only (AEK_DEV_FILES_LAN=true allows the LAN)',
      server,
    };
  }
  if (!getToken()) {
    return {
      available: false,
      reason: 'NO_TOKEN',
      message: 'The page has no dev files token: reload it',
      server,
    };
  }
  return { available: true, server };
};

const stageBlob = async (blob: Blob) => {
  const response = await request('stage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  return (await readJson<DevFilesStageBody>(response, 'stage')).stageId;
};

export const _writeDevFiles = async (writes: DevFileWrite[]): Promise<DevFilesCommitBody> => {
  if (!Array.isArray(writes) || !writes.length) {
    throw new DevFilesError('BAD_REQUEST', 'writeDevFiles needs at least one write');
  }
  const historySize = getDevFilesSaveHistorySize();
  if (!historySize && writes.some((write) => 'saveData' in write)) {
    throw new DevFilesError(
      'SAVE_DATA_DISABLED',
      'Saving into __saveData is off (save history size 0, Debug tools → File server)'
    );
  }
  const body: DevFilesCommitRequest = {
    writes: await Promise.all(
      writes.map(async (write) => {
        const expectedHash =
          write.expectedHash !== undefined ? { expectedHash: write.expectedHash } : {};
        if ('blob' in write) {
          return { path: write.path, ...expectedHash, stageId: await stageBlob(write.blob) };
        }
        if ('saveData' in write) {
          return {
            path: write.path,
            ...expectedHash,
            saveData: { ...write.saveData, historySize },
          };
        }
        return { path: write.path, ...expectedHash, json: write.json };
      })
    ),
  };
  const response = await request('commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson<DevFilesCommitBody>(response, 'commit');
};

export const _readDevFile = async (path: string): Promise<DevFileRead | null> => {
  let response: Response;
  try {
    response = await request(`read?path=${encodeURIComponent(path)}`);
  } catch (err) {
    if (err instanceof DevFilesError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
  const sha256 = response.headers.get(DEV_FILES_HASH_HEADER) ?? '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!path.toLowerCase().endsWith('.json')) return { path, sha256, bytes };
  try {
    return { path, sha256, bytes, json: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (err) {
    throw new DevFilesError('INVALID_JSON', `${path} isn't JSON: ${(err as Error).message}`);
  }
};

const isCanvas = (source: PNGSource): source is HTMLCanvasElement | OffscreenCanvas =>
  (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) ||
  (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas);

/** A canvas through its own encoder (its pixels are premultiplied anyway) */
const encodeCanvasPNG = async (source: HTMLCanvasElement | OffscreenCanvas, flipY: boolean) => {
  let canvas = source;
  if (flipY) {
    canvas = new OffscreenCanvas(source.width, source.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new DevFilesError('BAD_REQUEST', 'encodePNG: no 2D context to flip with');
    ctx.translate(0, source.height);
    ctx.scale(1, -1);
    ctx.drawImage(source, 0, 0);
  }
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: 'image/png' });
  const htmlCanvas = canvas;
  return new Promise<Blob>((resolve, reject) =>
    htmlCanvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new DevFilesError('BAD_REQUEST', 'encodePNG: empty canvas')),
      'image/png'
    )
  );
};

export const _encodePNG = async (source: PNGSource, opts?: EncodePNGOpts) => {
  const flipY = !!opts?.flipY;
  if (isCanvas(source)) return encodeCanvasPNG(source, flipY);
  const { data, width, height } = source;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new DevFilesError('BAD_REQUEST', `encodePNG: bad size ${width}×${height}`);
  }
  if (data.length !== width * height * 4) {
    throw new DevFilesError(
      'BAD_REQUEST',
      `encodePNG: ${data.length} bytes isn't ${width}×${height} RGBA8 (${width * height * 4})`
    );
  }
  return encodeRGBA8PNG(data, width, height, flipY);
};

// The gatherer's event (§2.5)

/** How long the reload after a gather waits for the listeners' promises */
const GATHER_LISTENERS_TIMEOUT_MS = 2000;

const gatherListeners = new Set<(event: DevDataGatheredEvent) => unknown>();

/** Vite's client handles the next message (the `full-reload`) once this settles */
const dispatchGatherEvent = async (event: DevDataGatheredEvent) => {
  const settled = Promise.all(
    [...gatherListeners].map(async (fn) => {
      try {
        await fn(event);
      } catch (err) {
        lerror('A dev data gathered listener failed', err);
      }
    })
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, GATHER_LISTENERS_TIMEOUT_MS);
  });
  await Promise.race([settled, timeout]);
  clearTimeout(timer);
};

import.meta.hot?.on(AEK_GATHER_EVENT, dispatchGatherEvent);

export const _onDevDataGathered = (fn: (event: DevDataGatheredEvent) => unknown) => {
  gatherListeners.add(fn);
  return () => {
    gatherListeners.delete(fn);
  };
};
