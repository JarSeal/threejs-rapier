import { defineConfig } from 'vitest/config';
import { getProjectMetadata } from './devTools/projectMetadata.ts';

// Unit tests (docs/plans/p601_refactoring-safety-net-tests-and-baselines.md): pure logic in Node,
// no GPU and no DOM. Not merged with vite.config.ts: it has no resolve settings to share, and its
// plugins (the gatherer, the Hub, the dev files, the visualizer) must not run under a test.
export default defineConfig({
  // The build-time constants vite.config.ts defines (core/Config.ts reads it at load)
  define: {
    __PROJECT_METADATA__: getProjectMetadata(),
  },
  test: {
    include: ['src/**/*.test.ts', 'devTools/**/*.test.ts'],
    environment: 'node',
  },
});
