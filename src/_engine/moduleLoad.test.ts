import { expect, test } from 'vitest';

// No module reads the environment or the browser at load (p604 §4.6, p606 Phase 5): the
// environment is read by InitEngine (initEnvironment), the window's listeners are added there, and
// a module's top level only declares and registers. So every engine module, the debug ones
// included, loads in Node without a `window`, `document` or `localStorage`, and a new top-level
// read fails here with the module's name instead of in a headless runner later.

// The worker entries set `self.onmessage` at load: that's their job (the physics worker's own
// boundary test is workers/physicsWorker.test.ts)
const modules = import.meta.glob([
  './**/*.ts',
  '!./**/*.test.ts',
  '!./**/*.d.ts',
  '!./workers/physicsWorker.ts',
  '!./workers/assetsWorker.ts',
]);

test('every engine module loads in Node without the browser, and leaves the flags at production', async () => {
  // A test environment with a DOM (jsdom, happy-dom) would make this pass for nothing
  expect(typeof window).toBe('undefined');
  expect(typeof document).toBe('undefined');

  // A module that fails takes its importers with it (the same error), so each failure names where
  // it was thrown: the first stack frame in src/
  const failures: string[] = [];
  for (const [path, load] of Object.entries(modules)) {
    try {
      await load();
    } catch (err) {
      const message = String((err as Error)?.message ?? err).split('\n')[0];
      const thrownAt = (err as Error)?.stack?.match(/src\/[^\s():]+:\d+/)?.[0] ?? '?';
      failures.push(`${path}: ${message} (at ${thrownAt})`);
    }
  }
  expect(failures).toEqual([]);
  expect(Object.keys(modules).length).toBeGreaterThan(300);

  // No module called initEnvironment at load
  const { IS_DEBUG_ENV, IS_PROD_TEST_MODE, CUR_ENV } = await import('./core/Config');
  expect([IS_DEBUG_ENV, IS_PROD_TEST_MODE, CUR_ENV]).toEqual([false, false, 'production']);
}, 60_000);
