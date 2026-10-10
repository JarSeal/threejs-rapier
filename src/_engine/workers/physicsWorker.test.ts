import path from 'node:path';
import { build, type Metafile } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';

// The headless boundary (p604 §4.6, p606 §4.7): the physics worker runs without the DOM, three or
// the renderer, which is what let p604 replay it in Node bit for bit. It holds only while nothing
// the worker imports at runtime reaches the main thread's modules, so a value import where a type
// import belongs (or a new dependency) fails here, not in a server months later.

const WORKER = path.resolve(__dirname, 'physicsWorker.ts');

/** The packages the worker may load: the physics backend, nothing else. */
const ALLOWED_PACKAGES = ['@dimforge/rapier3d-compat'];

/** Main-thread modules that pull the renderer, the loop or the config into the worker. */
const FORBIDDEN_MODULES = ['core/MainLoop.ts', 'core/Config.ts', 'core/PhysicsAPI.ts'];

let metafile: Metafile;

beforeAll(async () => {
  // Packages stay external, so the bundle is only our modules and the packages are the externals
  // they import (no 2 MB of Rapier to parse). So do Vite-only imports (styles, `?raw`, `?worker`),
  // which esbuild can't load: a regression then fails the checks below by name, not the build.
  const result = await build({
    entryPoints: [WORKER],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    packages: 'external',
    logLevel: 'silent',
    plugins: [
      {
        name: 'vite-only-imports',
        setup: (b) =>
          b.onResolve({ filter: /\?|\.s?css$/ }, (args) => ({ external: true, path: args.path })),
      },
    ],
  });
  metafile = result.metafile;
});

describe('the physics worker bundle', () => {
  test('imports no main-thread module', () => {
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.length).toBeGreaterThan(1);
    const forbidden = inputs.filter((input) => FORBIDDEN_MODULES.some((m) => input.endsWith(m)));
    expect(forbidden).toEqual([]);
  });

  test('loads no package but the physics backend (no three)', () => {
    const packages = new Set<string>();
    for (const input of Object.values(metafile.inputs)) {
      for (const imported of input.imports) {
        if (imported.external && !imported.path.startsWith('.')) packages.add(imported.path);
      }
    }
    expect([...packages].filter((p) => !ALLOWED_PACKAGES.includes(p))).toEqual([]);
  });
});
