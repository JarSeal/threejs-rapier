import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { getProjectMetadata } from './devTools/projectMetadata.ts';
import { getViteAliases } from './devTools/aliases.ts';

// Unit tests (docs/plans/_DONE_p601_refactoring-safety-net-tests-and-baselines.md): pure logic in Node,
// no GPU and no DOM. Not merged with vite.config.ts: its plugins (the gatherer, the Hub, the dev
// files, the visualizer) must not run under a test. The entries' aliases are the one setting shared.
export default defineConfig({
  resolve: { alias: getViteAliases(fileURLToPath(new URL('.', import.meta.url))) },
  // The build-time constants vite.config.ts defines (core/Config.ts reads it at load)
  define: {
    __PROJECT_METADATA__: getProjectMetadata(),
  },
  test: {
    include: ['src/**/*.test.ts', 'devTools/**/*.test.ts'],
    environment: 'node',
  },
});
