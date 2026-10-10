/* eslint-disable no-console */
/**
 * The move map and its checks (p602 Phase 2):
 *
 *   npx tsx devTools/refactor/moveMap.ts [--check]
 *
 * - `moveMap.json`: every tracked file of `src/_engine/` and `src/toolkit/`, and the app files
 *   that move, with its target (`moveRules.ts`). p608's codemod reads it; regenerate it on a fresh
 *   `main` before applying it. It fails on a file no rule maps, two files with one target (also
 *   by case) and a module name that isn't PascalCase (p602 D7).
 * - `layoutReport.md`: the import graph checked against the target layout: kernel code importing a
 *   feature, cycles between features, the engine importing the app, static `_dbg__` imports
 *   outside debug code, and the `utils/` / `ui/` / `schemas/` boundaries. What p606 must fix
 *   before the boundary lint (p602 D10) can be an error.
 * - `entryExports.json`: every export of the documented API (p601's `api.json`) under the entry
 *   point its module lands in (p602 D3), with who imports it today: `public` (the app, the
 *   toolkit, a Hub `api:` link or the devTools), `crossEntry` (only engine code of another entry),
 *   `internal` (only its own entry) or `unreferenced`. p606 writes the entries from it.
 *
 * `--check` writes nothing and exits 1 when one of the three files would change.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ROOT } from '../assetPipeline/sources';
import { buildImportGraph, type ImportKind } from './importGraph';
import { applyMoveRules, getMoveRules, isPascalModuleName, type MoveEntry } from './moveRules';

const FORMAT_VERSION = 1;
const OUT_DIR = path.join(ROOT, 'devTools/refactor');
const MOVE_MAP_FILE = path.join(OUT_DIR, 'moveMap.json');
const REPORT_FILE = path.join(OUT_DIR, 'layoutReport.md');
const ENTRY_EXPORTS_FILE = path.join(OUT_DIR, 'entryExports.json');
const API_BASELINE_FILE = path.join(ROOT, 'devTools/verify/baselines/api.json');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const isCheck = process.argv.includes('--check');

const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim();
const allTracked = new Set(git('ls-files').split('\n').filter(Boolean));
const trackedFiles = [...allTracked].filter((f) => /^(src|devTools|hub\/pages)\//.test(f));
const tracked = allTracked;

// The move map

const rules = getMoveRules(ROOT, trackedFiles);
const moveMap: Record<string, MoveEntry> = {};
const errors: string[] = [];
for (const file of trackedFiles) {
  if (!file.startsWith('src/')) continue;
  const entry = applyMoveRules(rules, file);
  if (entry) moveMap[file] = entry;
  else if (file.startsWith('src/_engine/') || file.startsWith('src/toolkit/')) {
    errors.push(`No rule maps ${file}`);
  }
}

const targetOwners = new Map<string, string>();
for (const [from, entry] of Object.entries(moveMap)) {
  if (!entry.to || entry.action === 'merge' || entry.action === 'split') continue;
  const key = entry.to.toLowerCase();
  const other = targetOwners.get(key);
  if (other) errors.push(`${from} and ${other} both move to ${entry.to}`);
  targetOwners.set(key, from);
  if (entry.to !== from && tracked.has(entry.to) && !moveMap[entry.to]) {
    errors.push(`${from} moves onto ${entry.to}, which stays`);
  }
  const inScope = entry.to.startsWith('src/_engine/') || entry.to.startsWith('src/toolkit/');
  if (inScope && !isPascalModuleName(path.posix.basename(entry.to))) {
    errors.push(`${entry.to} isn't PascalCase (p602 D7)`);
  }
}

// Zones of the target layout

type Layer =
  | 'kernel'
  | 'feature'
  | 'ui'
  | 'debug'
  | 'utils'
  | 'schemas'
  | 'types'
  | 'engine'
  | 'generated'
  | 'toolkit'
  | 'app'
  | 'devTools';
type Zone = { layer: Layer; area?: string; isDebug: boolean };

const zoneOf = (target: string): Zone => {
  let m = /^src\/_engine\/kernel\/([^/]+)\/(debug\/)?/.exec(target);
  if (m) return { layer: 'kernel', area: m[1], isDebug: !!m[2] };
  m = /^src\/_engine\/features\/([^/]+)\/(debug\/)?/.exec(target);
  if (m) return { layer: 'feature', area: m[1], isDebug: !!m[2] };
  const top = /^src\/_engine\/([^/]+)\//.exec(target)?.[1];
  if (top === 'ui' || top === 'utils' || top === 'schemas' || top === 'types') {
    return { layer: top, isDebug: false };
  }
  if (top === 'debug') return { layer: 'debug', isDebug: true };
  if (target.startsWith('src/_engine/')) return { layer: 'engine', isDebug: false };
  if (target.startsWith('src/generated/')) return { layer: 'generated', isDebug: false };
  m = /^src\/toolkit\/([^/]+)\//.exec(target);
  if (m) return { layer: 'toolkit', area: m[1], isDebug: false };
  if (target.startsWith('devTools/')) return { layer: 'devTools', isDebug: false };
  return { layer: 'app', isDebug: false };
};

const entryOf = (target: string): string | null => {
  const z = zoneOf(target);
  switch (z.layer) {
    case 'kernel':
    case 'utils':
    case 'engine':
      return 'aekasha';
    case 'feature':
      return `aekasha/${z.area}`;
    case 'ui':
    case 'debug':
    case 'schemas':
      return `aekasha/${z.layer}`;
    case 'toolkit':
      return `aekasha/toolkit/${z.area}`;
    default:
      return null;
  }
};

const isDbgModule = (file: string) => path.posix.basename(file).startsWith('_dbg__');
const isEngineLayer = (l: Layer) =>
  ['kernel', 'feature', 'ui', 'debug', 'utils', 'schemas', 'types', 'engine'].includes(l);

/** A file's target, per imported name for a split file; `null` when it's deleted */
const targetOf = (file: string, name?: string): string | null => {
  const entry = moveMap[file];
  if (!entry) return file;
  if (entry.action === 'split') return (name && entry.split?.[name]) || file;
  return entry.to;
};

// The import graph

const sources = new Map<string, string>();
for (const file of trackedFiles) {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
  if (!file.startsWith('src/') && !file.startsWith('devTools/')) continue;
  if (file.startsWith('devTools/refactor/')) continue;
  sources.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
}
const graph = buildImportGraph(sources, (f) => tracked.has(f));

type Edge = {
  from: string;
  to: string;
  fromTarget: string;
  toTarget: string;
  kind: ImportKind;
  names: string[];
  line: number;
};
const violations = new Map<string, Edge[]>();
const featureEdges: Edge[] = [];
const deletedImports: Edge[] = [];
const splitFileImports: Edge[] = [];
const unresolved: string[] = [];
const utilsPackages: { from: string; specifier: string; line: number }[] = [];

const addViolation = (category: string, edge: Edge) => {
  const list = violations.get(category) ?? [];
  list.push(edge);
  violations.set(category, list);
};

const checkEdge = (fz: Zone, tz: Zone, edge: Edge): string | null => {
  if (fz.layer === 'toolkit')
    return tz.layer === 'app' || tz.layer === 'generated' ? 'Toolkit → app' : null;
  if (!isEngineLayer(fz.layer)) return null;
  if (tz.layer === 'app') return 'Engine → app';
  if (tz.layer === 'generated') return 'Engine → generated data';
  if (tz.layer === 'toolkit') return 'Engine → toolkit';
  if (edge.kind !== 'dynamic' && isDbgModule(edge.toTarget) && !fz.isDebug) {
    return 'Static `_dbg__` imports outside debug code';
  }
  if (fz.isDebug) return null;
  switch (fz.layer) {
    case 'utils':
      return tz.layer === 'utils' ? null : `utils → ${tz.layer}`;
    case 'schemas':
      return tz.layer === 'schemas' || tz.layer === 'utils' ? null : `schemas → ${tz.layer}`;
    case 'ui':
      return ['ui', 'utils', 'types'].includes(tz.layer) ? null : `ui → ${tz.layer}`;
    case 'kernel':
      return tz.layer === 'feature' ? 'Kernel → feature' : null;
    default:
      return null;
  }
};

for (const imp of graph.imports) {
  if (imp.resolved === undefined) {
    unresolved.push(`${imp.from}:${imp.line} '${imp.specifier}'`);
    continue;
  }
  const fromEntry = moveMap[imp.from];
  if (imp.resolved === null) {
    const fromTarget = targetOf(imp.from);
    const isTest = imp.from.endsWith('.test.ts');
    if (
      fromTarget &&
      !isTest &&
      fromEntry?.action !== 'split' &&
      zoneOf(fromTarget).layer === 'utils'
    ) {
      utilsPackages.push({ from: imp.from, specifier: imp.specifier, line: imp.line });
    }
    continue;
  }
  const fromTarget = targetOf(imp.from);
  if (!fromTarget) continue; // a deleted file's own imports
  // An import of names that are all types emits nothing, with or without `type`
  const resolvedFile = imp.resolved;
  const kind: ImportKind =
    imp.kind === 'runtime' &&
    imp.names.length > 0 &&
    imp.names.every((n) => n !== '*' && graph.isTypeExport(resolvedFile, n))
      ? 'type'
      : imp.kind;
  const base = { from: imp.from, to: imp.resolved, fromTarget, kind, line: imp.line };
  if (fromEntry?.action === 'split') continue; // checked per part when it's split

  // A split file's names go to their own targets
  const toEntry = moveMap[imp.resolved];
  const groups = new Map<string | null, string[]>();
  if (toEntry?.action === 'split' && !imp.names.includes('*')) {
    for (const name of imp.names) {
      const t = targetOf(imp.resolved, name);
      groups.set(t, [...(groups.get(t) ?? []), name]);
    }
  } else groups.set(targetOf(imp.resolved), imp.names);

  for (const [toTarget, names] of groups) {
    if (toTarget === null) {
      deletedImports.push({ ...base, toTarget: '(deleted)', names });
      continue;
    }
    const edge: Edge = { ...base, toTarget, names };
    if (toEntry?.action === 'split' && toTarget === imp.resolved) {
      splitFileImports.push(edge);
      continue;
    }
    if (toEntry?.action === 'merge') deletedImports.push(edge);
    const fz = zoneOf(fromTarget);
    const tz = zoneOf(toTarget);
    const category = checkEdge(fz, tz, edge);
    if (category) addViolation(category, edge);
    if (fz.layer === 'feature' && tz.layer === 'feature' && fz.area !== tz.area && !fz.isDebug) {
      featureEdges.push(edge);
    }
  }
}

// Every export of a split file has a target, and the targets follow the naming rule
for (const [file, entry] of Object.entries(moveMap)) {
  if (entry.action !== 'split') continue;
  for (const name of graph.allExports(file)) {
    if (!entry.split?.[name]) errors.push(`${file}'s split has no target for ${name}`);
  }
  for (const to of new Set(Object.values(entry.split ?? {}))) {
    if (!isPascalModuleName(path.posix.basename(to)))
      errors.push(`${to} isn't PascalCase (p602 D7)`);
  }
}

// Cycles between features (runtime and dynamic imports from non-debug feature code)

const featureOf = (target: string) => zoneOf(target).area as string;
const featureGraph = new Map<string, Set<string>>();
for (const e of featureEdges) {
  if (e.kind === 'type') continue;
  const a = featureOf(e.fromTarget);
  const b = featureOf(e.toTarget);
  if (!featureGraph.has(a)) featureGraph.set(a, new Set());
  featureGraph.get(a)?.add(b);
}
const findCycles = (g: Map<string, Set<string>>): string[][] => {
  let index = 0;
  const stack: string[] = [];
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const out: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of g.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) out.push(scc.sort());
    }
  };
  for (const v of g.keys()) if (!idx.has(v)) strong(v);
  return out;
};
const featureCycles = findCycles(featureGraph);

// Entry exports

type Usage = 'public' | 'crossEntry' | 'internal' | 'unreferenced';
type ExportUsage = { kind: string; usage: Usage; by?: string[] };

const hubApiNames = new Set<string>();
for (const file of trackedFiles) {
  if (!file.startsWith('hub/pages/') || !/\.(md|html)$/.test(file)) continue;
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of text.matchAll(/api:([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    hubApiNames.add(m[1]);
    if (m[2]) hubApiNames.add(m[2]);
  }
}

const consumers = new Map<string, Set<string>>();
const addConsumer = (decl: { file: string; name: string } | undefined, consumer: string) => {
  if (!decl || decl.name === '*') return;
  const key = `${decl.file}#${decl.name}`;
  if (!consumers.has(key)) consumers.set(key, new Set());
  consumers.get(key)?.add(consumer);
};
for (const imp of graph.imports) {
  if (!imp.resolved || imp.isReexport) continue;
  for (const name of imp.names) {
    if (name === '*') {
      for (const n of graph.allExports(imp.resolved)) {
        addConsumer(graph.resolveExport(imp.resolved, n), imp.from);
      }
    } else addConsumer(graph.resolveExport(imp.resolved, name), imp.from);
  }
}

const apiBaseline = JSON.parse(fs.readFileSync(API_BASELINE_FILE, 'utf8')) as {
  modules: Record<string, Record<string, string>>;
};
const entryExports: Record<string, Record<string, Record<string, ExportUsage>>> = {};
const usageCounts: Record<string, Record<Usage, number>> = {};
for (const [module, names] of Object.entries(apiBaseline.modules)) {
  for (const [name, kind] of Object.entries(names)) {
    if (kind === 'Reference') continue; // counted where it's declared
    const target = targetOf(module, name);
    if (!target) continue;
    const entry = entryOf(target);
    if (!entry) continue;
    const by = new Set<string>();
    let usage: Usage = 'unreferenced';
    const rank: Record<Usage, number> = { unreferenced: 0, internal: 1, crossEntry: 2, public: 3 };
    const raise = (u: Usage) => {
      if (rank[u] > rank[usage]) usage = u;
    };
    if (hubApiNames.has(name)) {
      by.add('hub');
      raise('public');
    }
    for (const consumer of consumers.get(`${module}#${name}`) ?? []) {
      const consumerTarget = targetOf(consumer) ?? consumer;
      const z = zoneOf(consumerTarget);
      const consumerEntry = entryOf(consumerTarget);
      if (z.layer === 'app' || z.layer === 'generated' || z.layer === 'devTools') {
        by.add(z.layer === 'devTools' ? 'devTools' : 'app');
        raise('public');
      } else if (z.layer === 'toolkit' && consumerEntry !== entry) {
        by.add('toolkit');
        raise('public');
      } else if (consumerEntry && consumerEntry !== entry) {
        by.add(consumerEntry);
        raise('crossEntry');
      } else raise('internal');
    }
    entryExports[entry] ??= {};
    entryExports[entry][target] ??= {};
    entryExports[entry][target][name] = { kind, usage, ...(by.size ? { by: [...by].sort() } : {}) };
    usageCounts[entry] ??= { public: 0, crossEntry: 0, internal: 0, unreferenced: 0 };
    usageCounts[entry][usage]++;
  }
}

// Output

const sortKeys = <T>(obj: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

const moveMapJson =
  JSON.stringify(
    {
      formatVersion: FORMAT_VERSION,
      note: 'Generated by devTools/refactor/moveMap.ts from moveRules.ts: change the rules, not this file.',
      files: sortKeys(moveMap),
    },
    null,
    2
  ) + '\n';

const sortedEntries = sortKeys(
  Object.fromEntries(
    Object.entries(entryExports).map(([e, mods]) => [
      e,
      sortKeys(Object.fromEntries(Object.entries(mods).map(([m, n]) => [m, sortKeys(n)]))),
    ])
  )
);
const entryExportsJson =
  JSON.stringify(
    {
      formatVersion: FORMAT_VERSION,
      note: 'Generated by devTools/refactor/moveMap.ts: who imports each documented export today, under the entry point its module lands in.',
      summary: sortKeys(usageCounts),
      entries: sortedEntries,
    },
    null,
    2
  ) + '\n';

const code = (s: string) => `\`${s}\``;
const short = (file: string) => file.replace(/^src\/_engine\//, '').replace(/^src\//, '');
const namesCell = (names: string[]) => {
  const shown = names.slice(0, 6).join(', ');
  return names.length > 6 ? `${shown}, … (${names.length})` : shown || '(side effect)';
};
const edgeRow = (e: Edge) =>
  `| ${code(`${short(e.from)}:${e.line}`)} | ${code(short(e.to))} | ${code(short(e.toTarget))} | ${e.kind} | ${namesCell(e.names)} |`;
const EDGE_HEADER =
  '| Importer (today) | Imports (today) | Target | Kind | Names |\n| --- | --- | --- | --- | --- |';

const lines: string[] = [];
const out = (s = '') => lines.push(s);
out('# Target layout report');
out();
out(
  `Generated by ${code('devTools/refactor/moveMap.ts')} (p602 Phase 2) from the tracked tree: don't edit it. Paths are relative to ${code('src/_engine/')} (or ${code('src/')}); "Target" is where the imported file lands in the move map.`
);
out();
out('## Summary');
out();
const actionCounts: Record<string, number> = {};
const planCounts: Record<string, number> = {};
for (const e of Object.values(moveMap)) {
  actionCounts[e.action] = (actionCounts[e.action] ?? 0) + 1;
  planCounts[e.plan] = (planCounts[e.plan] ?? 0) + 1;
}
out(
  `- **Move map:** ${Object.keys(moveMap).length} files (${Object.entries(actionCounts)
    .map(([a, n]) => `${a} ${n}`)
    .join(', ')}); by plan: ${Object.entries(planCounts)
    .map(([p, n]) => `${p} ${n}`)
    .join(', ')}.`
);
out(`- **Imports checked:** ${graph.imports.length} in ${sources.size} modules.`);
out("- **Boundary violations** (imports the target layout doesn't allow):");
out();
out('| Category | Runtime | Type only | Dynamic | Files |');
out('| --- | --- | --- | --- | --- |');
const sortedViolations = [...violations.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [category, edges] of sortedViolations) {
  const n = (k: ImportKind) => edges.filter((e) => e.kind === k).length;
  const files = new Set(edges.map((e) => e.from)).size;
  out(`| ${category} | ${n('runtime')} | ${n('type')} | ${n('dynamic')} | ${files} |`);
}
out();
out(
  `- **Feature cycles** (runtime and dynamic imports, debug code left out): ${
    featureCycles.length ? featureCycles.map((c) => c.join(' ↔ ')).join('; ') : 'none'
  }.`
);
out('- **Entry exports** (the documented API by its target entry and who imports it today):');
out();
out('| Entry | Public | Cross-entry | Internal | Unreferenced |');
out('| --- | --- | --- | --- | --- |');
for (const [entry, c] of Object.entries(sortKeys(usageCounts))) {
  out(`| ${code(entry)} | ${c.public} | ${c.crossEntry} | ${c.internal} | ${c.unreferenced} |`);
}
out();
out(
  `Public: the app, the toolkit, a Hub ${code('api:')} link or the devTools import it. Cross-entry: only engine code of another entry does (each is either exported from its entry or a seam p606 designs). Internal: only its own entry (an ${code('@internal')} candidate). Unreferenced: nothing imports it; some are API the example app doesn't use. The full list is ${code('entryExports.json')}.`
);
out();

out('## Feature dependencies');
out();
const pairCounts = new Map<string, Record<ImportKind, number>>();
for (const e of featureEdges) {
  const key = `${featureOf(e.fromTarget)} → ${featureOf(e.toTarget)}`;
  const c = pairCounts.get(key) ?? { runtime: 0, type: 0, dynamic: 0 };
  c[e.kind]++;
  pairCounts.set(key, c);
}
out('| Feature → feature | Runtime | Type only | Dynamic |');
out('| --- | --- | --- | --- |');
for (const [pair, c] of [...pairCounts.entries()].sort()) {
  out(`| ${pair} | ${c.runtime} | ${c.type} | ${c.dynamic} |`);
}
out();

for (const [category, edges] of sortedViolations) {
  out(`## ${category}`);
  out();
  if (category === 'Kernel → feature') {
    const byFeature = new Map<string, Edge[]>();
    for (const e of edges) {
      const f = featureOf(e.toTarget);
      byFeature.set(f, [...(byFeature.get(f) ?? []), e]);
    }
    for (const [feature, list] of [...byFeature.entries()].sort()) {
      out(`### ${feature}`);
      out();
      out(EDGE_HEADER);
      for (const e of list) out(edgeRow(e));
      out();
    }
    continue;
  }
  if (category === 'Engine → app') {
    const byTarget = new Map<string, Set<string>>();
    for (const e of edges) {
      byTarget.set(e.to, (byTarget.get(e.to) ?? new Set()).add(e.from));
    }
    out('| Imported (today) | Engine importers |');
    out('| --- | --- |');
    for (const [to, froms] of [...byTarget.entries()].sort((a, b) => b[1].size - a[1].size)) {
      out(`| ${code(short(to))} | ${froms.size} |`);
    }
    out();
    continue;
  }
  out(EDGE_HEADER);
  for (const e of edges) out(edgeRow(e));
  out();
}

if (utilsPackages.length) {
  out('## Packages imported by utils');
  out();
  out(`p602 D6: ${code('utils/')} is pure (no three, DOM or ECS).`);
  out();
  for (const u of utilsPackages)
    out(`- ${code(`${short(u.from)}:${u.line}`)} ${code(u.specifier)}`);
  out();
}

out('## Imports of split, merged and deleted files');
out();
out(
  `The codemod rewrites these. ${code('utils/helpers.ts')} imports with a namespace (or names its split doesn't list) are below with the file as their target.`
);
out();
out(EDGE_HEADER);
for (const e of [...splitFileImports, ...deletedImports]) out(edgeRow(e));
out();

// Paths outside the import graph: docs, CLAUDE.md files, Hub pages, configs and devTools strings
const movedPaths = Object.entries(moveMap)
  .filter(([from, e]) => e.to !== from)
  .map(([from]) => from)
  .sort((a, b) => b.length - a.length);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathPattern = new RegExp(
  `(?<![\\w/.-])(${movedPaths
    .flatMap((p) => [p, p.replace(/^src\/_engine\//, '')])
    .map(escape)
    .join('|')})(?![\\w/.-])`,
  'g'
);
const docFiles = [...allTracked].filter(
  (f) =>
    /^(hub\/pages\/.*\.(md|html)|docs\/(techniques|issues)\/.*\.md|devTools\/(?!refactor\/).*\.ts)$/.test(
      f
    ) ||
    path.posix.basename(f) === 'CLAUDE.md' ||
    [
      'readme.md',
      'vite.config.ts',
      'vitest.config.ts',
      'tsconfig.json',
      'eslint.config.js',
      'package.json',
    ].includes(f)
);
const pathRefs: { file: string; count: number; paths: Set<string> }[] = [];
for (const file of docFiles) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const found = [...text.matchAll(pathPattern)].map((m) => m[1]);
  if (found.length) pathRefs.push({ file, count: found.length, paths: new Set(found) });
}
out('## Paths outside the import graph');
out();
out(
  `Mentions of a moving file's path (from the repo root, or from ${code('src/_engine/')}) in the Hub pages (${code('<<<')} includes, ${code('repo:')} links), the docs, the CLAUDE.md files, the readme, the configs and the devTools: the codemod rewrites the exact ones, the rest are fixed by hand. ${code('yarn hub:build')} fails on a stale include or link.`
);
out();
out('| File | Mentions | Distinct paths |');
out('| --- | --- | --- |');
for (const r of pathRefs.sort((a, b) => b.count - a.count)) {
  out(`| ${code(r.file)} | ${r.count} | ${r.paths.size} |`);
}
out();

if (unresolved.length) {
  out('## Unresolved relative imports');
  out();
  for (const u of unresolved) out(`- ${code(u)}`);
  out();
}

const report = lines.join('\n');

// Write or check

const outputs: [string, string][] = [
  [MOVE_MAP_FILE, moveMapJson],
  [REPORT_FILE, report],
  [ENTRY_EXPORTS_FILE, entryExportsJson],
];

for (const e of errors) console.log(`${RED}✖ ${e}${RESET}`);
if (unresolved.length)
  console.log(`${YELLOW}! ${unresolved.length} unresolved relative imports${RESET}`);

if (isCheck) {
  const stale = outputs.filter(
    ([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text
  );
  for (const [file] of stale)
    console.log(`${RED}✖ ${path.relative(ROOT, file)} is out of date${RESET}`);
  if (errors.length || stale.length) process.exit(1);
  console.log(`${GREEN}✔ The move map and its reports are up to date${RESET}`);
} else {
  if (errors.length) process.exit(1);
  for (const [file, text] of outputs) fs.writeFileSync(file, text);
  console.log(
    `${GREEN}✔ ${Object.keys(moveMap).length} files mapped; ${[...violations.values()].reduce((n, l) => n + l.length, 0)} boundary violations; ${featureCycles.length} feature cycles${RESET}`
  );
  for (const [file] of outputs) console.log(`  ${path.relative(ROOT, file)}`);
}
