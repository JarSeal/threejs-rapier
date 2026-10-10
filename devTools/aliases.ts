/**
 * The public entry points (p606, p602 D1, D3) and their import aliases: the one list
 * `vite.config.ts` and `vitest.config.ts` read, and `tsconfig.json`'s `paths` repeat (a JSON file
 * can't import it: `aliases.test.ts` checks the two agree). TypeDoc and `tsx` read the `paths`.
 *
 * Each alias is matched exactly: `aekasha` doesn't resolve `aekasha/physics`, and an entry missing
 * here is an unresolved import, not a deep path. An entry re-exports by name from today's paths;
 * p608 moves the code under it and rewrites only those paths.
 */
import path from 'path';

/** Entry → its file, from the repo root */
export const ENTRY_FILES = {
  aekasha: 'src/_engine/index.ts',
  'aekasha/character': 'src/_engine/features/character/index.ts',
  'aekasha/instancing': 'src/_engine/features/instancing/index.ts',
  'aekasha/lines': 'src/_engine/features/lines/index.ts',
  'aekasha/lod': 'src/_engine/features/lod/index.ts',
  'aekasha/physics': 'src/_engine/features/physics/index.ts',
  'aekasha/postfx': 'src/_engine/features/postfx/index.ts',
  'aekasha/skybox': 'src/_engine/features/skybox/index.ts',
  'aekasha/spatial': 'src/_engine/features/spatial/index.ts',
  'aekasha/viewports': 'src/_engine/features/viewports/index.ts',
  'aekasha/ui': 'src/_engine/ui/index.ts',
  'aekasha/debug': 'src/_engine/debug/index.ts',
  'aekasha/schemas': 'src/_engine/schemas/index.ts',
  'aekasha/toolkit/ecs': 'src/toolkit/ecs/index.ts',
  'aekasha/toolkit/geometry': 'src/toolkit/geometry/index.ts',
  'aekasha/toolkit/materials': 'src/toolkit/materials/index.ts',
} as const;

export type EntryName = keyof typeof ENTRY_FILES;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Vite's (and Vitest's) `resolve.alias`, workers included: one exact match per entry */
export const getViteAliases = (root: string) =>
  Object.entries(ENTRY_FILES).map(([entry, file]) => ({
    find: new RegExp(`^${escapeRegExp(entry)}$`),
    replacement: path.join(root, file),
  }));

/** `tsconfig.json`'s `compilerOptions.paths`, relative to the root config */
export const getTsconfigPaths = (): Record<string, string[]> =>
  Object.fromEntries(Object.entries(ENTRY_FILES).map(([entry, file]) => [entry, [`./${file}`]]));
