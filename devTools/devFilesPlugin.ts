/* eslint-disable no-console */
import type { IncomingMessage, ServerResponse } from 'http';
import type { Plugin } from 'vite';
import { commitDevFiles, MAX_BATCH_BYTES, MAX_FILE_BYTES, readDevFile } from './devFiles/commit';
import { DevFilesError, readBody, sendError, sendJson } from './devFiles/http';
import { DEV_FILES_DENIED_ROOTS, DEV_FILES_EXTENSIONS, DEV_FILES_ROOTS } from './devFiles/paths';
import {
  DEV_FILES_HASH_HEADER,
  DEV_FILES_ROUTE_BASE,
  DEV_FILES_TOKEN_META,
  type DevFilesStatusBody,
} from './devFiles/protocol';
import {
  checkDeviceAndToken,
  checkHostAndOrigin,
  createDevFilesToken,
  isLocalRequest,
} from './devFiles/security';
import { createStage } from './devFiles/stage';

/**
 * The dev file server (p342): lets debug tooling in the browser write files into the repo while
 * `yarn dev` runs (an exported impostor, a baked texture). Dev server only, never in a build.
 * Routes under `/__aek/files/` (`devFiles/protocol.ts`):
 * - `GET status`: whether the routes are on and take this device's requests (no token needed);
 * - `GET read?path=`: the file's bytes, its hash in the `x-aek-sha256` header;
 * - `PUT stage`: a raw body (a PNG) staged for a commit, `{ stageId, bytes, sha256 }`;
 * - `POST commit`: `{ writes: [{ path, json | stageId, expectedHash? }] }`, all or nothing.
 * The checks are in `devFiles/security.ts`, the path policy in `devFiles/paths.ts`. A write is
 * an ordinary file event: the scene gatherer runs as it does for an editor save.
 *
 * `AEK_DEV_FILES=false` turns the routes off; `AEK_DEV_FILES_LAN=true` lets other devices on the
 * LAN use them (a phone under `yarn dev:https`). `AEK_DEV_FILES_FAULTS=true` makes a commit honour
 * the self-check's `x-aek-dev-fault: rename:<n>` header (`devFiles/selfCheck.ts`).
 */

const FAULT_HEADER = 'x-aek-dev-fault';
/** The bodies besides the files: JSON's own syntax and the batch's paths */
const COMMIT_BODY_SLACK_BYTES = 1024 * 1024;

const getRoute = (req: IncomingMessage) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(DEV_FILES_ROUTE_BASE)) return null;
  return { name: url.pathname.slice(DEV_FILES_ROUTE_BASE.length), url };
};

const parseFaults = (req: IncomingMessage) => {
  const match = /^rename:(\d+)$/.exec(String(req.headers[FAULT_HEADER] ?? ''));
  return match ? { failRenameAt: Number(match[1]) } : {};
};

const parseJsonBody = (body: Buffer) => {
  try {
    return JSON.parse(body.toString('utf-8')) as unknown;
  } catch (err) {
    throw new DevFilesError('INVALID_JSON', `The body isn't JSON: ${(err as Error).message}`);
  }
};

export const devFilesPlugin = (): Plugin => {
  const isEnabled = process.env.AEK_DEV_FILES !== 'false';
  const isLANAllowed = process.env.AEK_DEV_FILES_LAN === 'true';
  const areFaultsOn = process.env.AEK_DEV_FILES_FAULTS === 'true';
  const token = createDevFilesToken();

  return {
    name: 'vite-plugin-aek-dev-files',
    apply: 'serve',
    configureServer(server) {
      const stage = isEnabled ? createStage() : null;
      server.httpServer?.once('close', () => stage?.dispose());
      const checkOpts = {
        allowedHosts: server.config.server.allowedHosts,
        isHttps: !!server.config.server.https,
      };

      const getStatus = (req: IncomingMessage): DevFilesStatusBody => ({
        enabled: isEnabled,
        writesFromLAN: isLANAllowed,
        canWrite: isEnabled && (isLANAllowed || isLocalRequest(req)),
        roots: DEV_FILES_ROOTS,
        deniedRoots: DEV_FILES_DENIED_ROOTS,
        extensions: DEV_FILES_EXTENSIONS,
        maxFileBytes: MAX_FILE_BYTES,
        maxBatchBytes: MAX_BATCH_BYTES,
      });

      const handle = async (
        req: IncomingMessage,
        res: ServerResponse,
        route: { name: string; url: URL }
      ) => {
        checkHostAndOrigin(req, checkOpts);
        const method = req.method ?? 'GET';
        if (route.name === 'status' && method === 'GET') {
          sendJson(res, 200, getStatus(req));
          return;
        }
        if (!isEnabled || !stage) {
          throw new DevFilesError('NOT_ENABLED', 'The dev file routes are off (AEK_DEV_FILES)');
        }
        checkDeviceAndToken(req, { token, isLANAllowed });

        if (route.name === 'read' && method === 'GET') {
          const { target, data, sha256 } = await readDevFile(route.url.searchParams.get('path'));
          res.statusCode = 200;
          res.setHeader(
            'Content-Type',
            target.isJson ? 'application/json; charset=utf-8' : 'application/octet-stream'
          );
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader(DEV_FILES_HASH_HEADER, sha256);
          res.end(data);
        } else if (route.name === 'stage' && method === 'PUT') {
          const body = await readBody(req, MAX_FILE_BYTES);
          sendJson(res, 200, await stage.add(body));
        } else if (route.name === 'commit' && method === 'POST') {
          const body = await readBody(req, MAX_BATCH_BYTES + COMMIT_BODY_SLACK_BYTES);
          const result = await commitDevFiles(parseJsonBody(body), {
            stage,
            faults: areFaultsOn ? parseFaults(req) : undefined,
          });
          console.log(
            `\x1b[36m[Dev files]\x1b[0m commit: ${result.results.map((write) => `${write.status} ${write.path}`).join(', ')}`
          );
          sendJson(res, 200, result);
        } else {
          throw new DevFilesError('NOT_FOUND', `No route ${method} ${route.name}`);
        }
      };

      server.middlewares.use((req, res, next) => {
        const route = getRoute(req);
        if (!route) {
          next();
          return;
        }
        handle(req, res, route).catch((err: unknown) => {
          if (err instanceof DevFilesError) {
            if (req.url?.includes('commit')) {
              console.log(`\x1b[33m[Dev files]\x1b[0m commit refused: ${err.code} ${err.message}`);
            }
            sendError(res, err);
            return;
          }
          console.error('\x1b[31m✗ [Dev files]\x1b[0m', err);
          sendError(res, new DevFilesError('WRITE_FAILED', (err as Error).message));
        });
      });
    },
    transformIndexHtml() {
      if (!isEnabled) return [];
      return [
        {
          tag: 'meta',
          attrs: { name: DEV_FILES_TOKEN_META, content: token },
          injectTo: 'head',
        },
      ];
    },
  };
};
