import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createNewResolver,
  isRequestPending,
  rejectRequest,
  RequestTimeoutError,
  resolveRequest,
} from './PromiseResolver';

afterEach(() => {
  vi.useRealTimers();
});

describe('PromiseResolver', () => {
  test('resolveRequest resolves a pending request once and says whether it was pending', async () => {
    let requestId = -1;
    const promise = new Promise<string>((resolve) => (requestId = createNewResolver(resolve)));

    expect(isRequestPending(requestId)).toBe(true);
    expect(resolveRequest(requestId, 'done')).toBe(true);
    expect(isRequestPending(requestId)).toBe(false);
    expect(resolveRequest(requestId, 'again')).toBe(false);
    await expect(promise).resolves.toBe('done');
  });

  test('rejectRequest rejects, and a request past its timeoutMs rejects with RequestTimeoutError', async () => {
    vi.useFakeTimers();
    let rejectedId = -1;
    let timedOutId = -1;
    const rejected = new Promise(
      (resolve, reject) => (rejectedId = createNewResolver(resolve, { reject }))
    );
    const timedOut = new Promise(
      (resolve, reject) => (timedOutId = createNewResolver(resolve, { reject, timeoutMs: 100 }))
    );

    expect(rejectRequest(rejectedId, new Error('no'))).toBe(true);
    await expect(rejected).rejects.toThrow('no');

    vi.advanceTimersByTime(100);
    await expect(timedOut).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(resolveRequest(timedOutId, 'late')).toBe(false);
  });
});
