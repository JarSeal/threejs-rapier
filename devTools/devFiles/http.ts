import type { IncomingMessage, ServerResponse } from 'http';
import type { DevFilesErrorBody, DevFilesErrorCode } from './protocol';

const STATUS_BY_CODE: Record<DevFilesErrorCode, number> = {
  NOT_ENABLED: 404,
  BAD_TOKEN: 403,
  BAD_ORIGIN: 403,
  BAD_HOST: 403,
  NOT_LOCAL: 403,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  FORBIDDEN_PATH: 403,
  TOO_LARGE: 413,
  CONFLICT: 409,
  INVALID_JSON: 400,
  INVALID_SCHEMA: 422,
  STAGE_EXPIRED: 410,
  WRITE_FAILED: 500,
};

/** A refusal: the route answers with its code */
export class DevFilesError extends Error {
  constructor(
    readonly code: DevFilesErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

export const sendError = (res: ServerResponse, error: DevFilesError) => {
  const body: DevFilesErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
  sendJson(res, STATUS_BY_CODE[error.code], body);
};

/**
 * The request's body. Over `maxBytes` it rejects with TOO_LARGE once the body has been read (the
 * rest is discarded), so the client gets the answer instead of a broken pipe.
 */
export const readBody = (req: IncomingMessage, maxBytes: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > maxBytes) {
        reject(new DevFilesError('TOO_LARGE', `The body is over ${maxBytes} bytes`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', reject);
  });
