/* eslint-disable @typescript-eslint/no-explicit-any */
import { isDebugEnvironment } from '../core/Config';
import { lerror } from './Logger';

const pendingRequests = new Map<number, (value: any) => void>();
let nextRequestId = 0;

/** Creates a new promise resolver and returns the requestId. */
export const createNewResolver = (resolve: (value: any) => void) => {
  const requestId = nextRequestId;
  pendingRequests.set(requestId, resolve);
  nextRequestId += 1;
  return requestId;
};

/** Resolves a pending promise. The resolver is fetched with a requestId and is given a value to resolve.
 * Also optional errInfo can be provided. */
export const resolveRequest = <T>(resolveValue: T, requestId?: number, errInfo?: unknown) => {
  if (!requestId) return resolveValue;
  const resolve = pendingRequests.get(requestId);
  if (resolve) {
    resolve(resolveValue);
    return pendingRequests.delete(requestId);
  }
  if (isDebugEnvironment()) {
    lerror(
      `Error in resolveRequest, could not find 'resolve' in pendingRequests with requestId: ${requestId}${errInfo !== undefined ? `, addi ${errInfo}` : '.'}`
    );
  }
};

/** Returns totalRequests and pendingRequests for debug purposes. */
export const getResolverStats = () => ({
  totalRequests: nextRequestId,
  pendingRequests: pendingRequests.size,
});
