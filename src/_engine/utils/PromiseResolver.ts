/* eslint-disable @typescript-eslint/no-explicit-any */
import { isDebugEnvironment } from '../core/Config';
import { lerror } from './Logger';

type PendingRequest = {
  resolve: (value: any) => void;
  reject?: (reason: unknown) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

/** Rejection reason of a request that was not resolved within its `timeoutMs`. */
export class RequestTimeoutError extends Error {
  constructor(requestId: number, timeoutMs: number) {
    super(`Request ${requestId} timed out after ${timeoutMs}ms.`);
    this.name = 'RequestTimeoutError';
  }
}

const pendingRequests = new Map<number, PendingRequest>();
let nextRequestId = 0;

/** Creates a new promise resolver and returns the requestId.
 * @param resolve the promise's resolve function
 * @param opts.reject the promise's reject function, needed for {@link rejectRequest} and `timeoutMs`
 * @param opts.timeoutMs rejects with a {@link RequestTimeoutError} when not settled in this time
 * (needs `reject`, ignored when 0 or not set) */
export const createNewResolver = (
  resolve: (value: any) => void,
  opts?: { reject?: (reason: unknown) => void; timeoutMs?: number }
) => {
  const requestId = nextRequestId;
  const request: PendingRequest = { resolve, reject: opts?.reject };
  const timeoutMs = opts?.timeoutMs;
  if (request.reject && timeoutMs && timeoutMs > 0) {
    request.timeoutId = setTimeout(() => {
      if (pendingRequests.get(requestId) !== request) return;
      pendingRequests.delete(requestId);
      request.reject?.(new RequestTimeoutError(requestId, timeoutMs));
    }, timeoutMs);
  }
  pendingRequests.set(requestId, request);
  nextRequestId += 1;
  return requestId;
};

/** Resolves a pending promise. The resolver is fetched with a requestId and is given a value to resolve.
 * Also optional errInfo can be provided. */
export const resolveRequest = <T>(resolveValue: T, requestId?: number, errInfo?: unknown) => {
  if (requestId === undefined) return resolveValue;
  const request = pendingRequests.get(requestId);
  if (request) {
    clearTimeout(request.timeoutId);
    request.resolve(resolveValue);
    return pendingRequests.delete(requestId);
  }
  if (isDebugEnvironment()) {
    lerror(
      `Error in resolveRequest, could not find 'resolve' in pendingRequests with requestId: ${requestId}${errInfo !== undefined ? `, addi ${errInfo}` : '.'}`
    );
  }
};

/** Rejects a pending promise that was created with a `reject` function. A request without one
 * (or an already settled one) is only removed. Returns whether the request was pending. */
export const rejectRequest = (requestId: number, reason: unknown) => {
  const request = pendingRequests.get(requestId);
  if (!request) return false;
  clearTimeout(request.timeoutId);
  pendingRequests.delete(requestId);
  request.reject?.(reason);
  return true;
};

/** Whether a request is still pending (not resolved, rejected or timed out). */
export const isRequestPending = (requestId: number) => pendingRequests.has(requestId);

/** Returns totalRequests and pendingRequests for debug purposes. */
export const getResolverStats = () => ({
  totalRequests: nextRequestId,
  pendingRequests: pendingRequests.size,
});
