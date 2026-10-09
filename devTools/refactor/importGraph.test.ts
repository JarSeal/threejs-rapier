import { describe, expect, it } from 'vitest';
import { buildImportGraph, parseModuleSource, resolveSpecifier } from './importGraph';
import { applyMoveRules, toModuleFileName, type MoveRule } from './moveRules';

describe('parseModuleSource', () => {
  it('reads import kinds and names', () => {
    const { imports } = parseModuleSource(
      'a.ts',
      [
        "import { a, type B } from './x';",
        "import type { C } from './y';",
        "import { type D } from './z';",
        "import * as ns from './ns';",
        "import def from './def';",
        "import './side';",
        "const lazy = () => import('./lazy');",
      ].join('\n')
    );
    const bySpec = Object.fromEntries(imports.map((i) => [i.specifier, i]));
    expect(bySpec['./x']).toMatchObject({ kind: 'runtime', names: ['a', 'B'], line: 1 });
    expect(bySpec['./y']).toMatchObject({ kind: 'type', names: ['C'] });
    expect(bySpec['./z']).toMatchObject({ kind: 'type', names: ['D'] });
    expect(bySpec['./ns']).toMatchObject({ kind: 'runtime', names: ['*'] });
    expect(bySpec['./def']).toMatchObject({ kind: 'runtime', names: ['default'] });
    expect(bySpec['./side']).toMatchObject({ kind: 'runtime', names: [] });
    expect(bySpec['./lazy']).toMatchObject({ kind: 'dynamic', names: ['*'], line: 7 });
  });

  it('reads local exports, re-exports and type-only declarations', () => {
    const { exports, imports } = parseModuleSource(
      'a.ts',
      [
        "import { moved } from './m';",
        'export const one = 1, { two } = { two: 2 };',
        'export function three() {}',
        'export type Four = number;',
        'export interface Five {}',
        'const six = 6;',
        'export { six as seven, moved };',
        "export { eight as nine } from './e';",
        "export type { Ten } from './t';",
        "export * from './star';",
        'export default three;',
      ].join('\n')
    );
    expect(exports.local.sort()).toEqual(
      ['Five', 'Four', 'default', 'one', 'seven', 'three', 'two'].sort()
    );
    expect(exports.types.sort()).toEqual(['Five', 'Four']);
    expect(exports.named).toEqual({
      moved: { specifier: './m', imported: 'moved' },
      nine: { specifier: './e', imported: 'eight' },
      Ten: { specifier: './t', imported: 'Ten' },
    });
    expect(exports.star).toEqual(['./star']);
    const reexports = imports.filter((i) => i.isReexport).map((i) => [i.specifier, i.kind]);
    expect(reexports).toEqual([
      ['./e', 'runtime'],
      ['./t', 'type'],
      ['./star', 'runtime'],
    ]);
  });
});

describe('resolveSpecifier', () => {
  const files = new Set(['src/a/b.ts', 'src/a/c/index.ts', 'src/w.ts', 'src/s.svg']);
  const exists = (f: string) => files.has(f);
  it('resolves relative paths, index files and queries', () => {
    expect(resolveSpecifier('src/a/x.ts', './b', exists)).toBe('src/a/b.ts');
    expect(resolveSpecifier('src/a/x.ts', './c', exists)).toBe('src/a/c/index.ts');
    expect(resolveSpecifier('src/a/x.ts', '../w?worker', exists)).toBe('src/w.ts');
    expect(resolveSpecifier('src/a/x.ts', '../s.svg?raw', exists)).toBe('src/s.svg');
    expect(resolveSpecifier('src/a/x.ts', 'three', exists)).toBeNull();
    expect(resolveSpecifier('src/a/x.ts', './missing', exists)).toBeUndefined();
  });
});

describe('buildImportGraph', () => {
  it('resolves a name through named and star re-exports', () => {
    const sources = new Map([
      ['src/entry.ts', "export * from './impl';\nexport { inner as outer } from './deep';"],
      ['src/impl.ts', 'export const a = 1;\nexport type T = string;'],
      ['src/deep.ts', 'export const inner = 2;'],
    ]);
    const graph = buildImportGraph(sources, (f) => sources.has(f));
    expect(graph.resolveExport('src/entry.ts', 'a')).toEqual({ file: 'src/impl.ts', name: 'a' });
    expect(graph.resolveExport('src/entry.ts', 'outer')).toEqual({
      file: 'src/deep.ts',
      name: 'inner',
    });
    expect([...graph.allExports('src/entry.ts')].sort()).toEqual(['T', 'a', 'outer']);
    expect(graph.isTypeExport('src/entry.ts', 'T')).toBe(true);
    expect(graph.isTypeExport('src/entry.ts', 'a')).toBe(false);
  });
});

describe('moveRules', () => {
  it('names modules in PascalCase, keeping asset-id files and entries', () => {
    expect(toModuleFileName('atmosphere.ts')).toBe('Atmosphere.ts');
    expect(toModuleFileName('deepMerge.test.ts')).toBe('DeepMerge.test.ts');
    expect(toModuleFileName('_helperSchemas.ts')).toBe('_HelperSchemas.ts');
    expect(toModuleFileName('_dbg__thing.ts')).toBe('_dbg__Thing.ts');
    expect(toModuleFileName('asteroid.tsl.ts')).toBe('asteroid.tsl.ts');
    expect(toModuleFileName('index.ts')).toBe('index.ts');
    expect(toModuleFileName('typings.d.ts')).toBe('typings.d.ts');
    expect(toModuleFileName('DropDown.scss')).toBe('DropDown.scss');
  });

  it('takes the longest matching rule', () => {
    const rules: MoveRule[] = [
      { from: 'src/_engine/core/', to: 'src/_engine/kernel/' },
      { from: 'src/_engine/core/Lod/', to: 'src/_engine/features/lod/' },
      { from: 'src/_engine/core/Lod/old.ts', action: 'delete' },
    ];
    expect(applyMoveRules(rules, 'src/_engine/core/Lod/layers/sun.ts')).toEqual({
      to: 'src/_engine/features/lod/layers/Sun.ts',
      action: 'move',
      plan: 'p608',
    });
    expect(applyMoveRules(rules, 'src/_engine/core/Lod/old.ts')).toMatchObject({
      to: null,
      action: 'delete',
    });
    expect(applyMoveRules(rules, 'src/other.ts')).toBeUndefined();
  });
});
