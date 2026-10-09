/**
 * The baselines (`yarn verify:baselines`, p601 Phase 3): what a refactor must not change by
 * accident, as three committed JSON files in `devTools/verify/baselines/`, none of them machine
 * dependent, diffed against the current state.
 *
 *   yarn verify:baselines [--update] [--no-build]
 *
 * - `bundle.json`: every file in `dist/assets/` (name without its content hash, bytes and gzip),
 *   and the main chunk's modules summed per group (three, Rapier, each engine folder, toolkit,
 *   app; the visualizer's rendered and gzip sizes, before minification, as p600 §2.4 counts).
 * - `api.json`: every export of the documented API (the Hub's TypeDoc model: `src/_engine` and
 *   `src/toolkit` minus `_dbg__*`, `generatedApp*` and tests) by module, with its kind.
 * - `docs.json`: documented / total exports and class and interface members per folder (the
 *   Hub's coverage rule: re-exports don't count), as p600 §2.5 counts them.
 *
 * It exits 1 when something needs a look: a chunk whose gzip grew by more than 1 % or 2 kB (and at
 * least 100 B), a new chunk, an export added, removed, moved or of another kind, or a folder whose
 * documented share dropped. Shrinking and better coverage are reported and pass. `--update` writes
 * the current state as the baselines (commit them with the change that explains them).
 *
 * It runs the production build's steps first (decoders, the production gather, `vite build`, then
 * the dev gather again, as `yarn build` does, without `tsc` and the Hub); `--no-build` reuses
 * `dist/` and `dist-stats/` from the last build. The TypeDoc model is the Hub's, converted only
 * when its inputs changed (`.cache/hub/typedoc.json`).
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { ROOT } from '../assetPipeline/sources';
import { loadApiModel } from '../hub/api/extract';
import { getOwnMembers, indexApiModel, isDocumented, Kind } from '../hub/api/model';
import { out, PROGRESS_LOG_WATCH } from './progressLog';

/** Bump when a file's shape changes: an old one is then read as missing */
const FORMAT_VERSION = 1;
const BASELINES_DIR = path.join(ROOT, 'devTools/verify/baselines');
const DIST_ASSETS_DIR = path.join(ROOT, 'dist/assets');
const MANIFEST_FILE = path.join(ROOT, 'dist/.vite/manifest.json');
const VISUALIZER_FILE = path.join(ROOT, 'dist-stats/bundle-stats.html');

/** Gzip growth that needs a look: over 1 % or 2 kB, and never under 100 B */
const GROWTH_RATIO = 0.01;
const GROWTH_BYTES = 2048;
const GROWTH_MIN_BYTES = 100;

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

type Size = { bytes: number; gzip: number };
type GroupSize = { modules: number; rendered: number; gzip: number };
type BundleBaseline = {
  formatVersion: number;
  chunks: Record<string, Size>;
  main: { chunk: string; modules: number; rendered: number; gzip: number };
  mainGroups: Record<string, GroupSize>;
};
type ApiBaseline = {
  formatVersion: number;
  /** Source path → export name → kind (`Function`, `Class`, … several joined by `, `) */
  modules: Record<string, Record<string, string>>;
};
type Coverage = { documented: number; total: number };
type FolderCoverage = { exports: Coverage; members: Coverage };
type DocsBaseline = {
  formatVersion: number;
  total: FolderCoverage;
  subtrees: Record<string, FolderCoverage>;
  /** `engine/core/Physics`, `toolkit` (the subtree's own folder): its own modules, not below */
  folders: Record<string, FolderCoverage>;
};

/** A finding: `attention` ones make the run exit 1 */
type Finding = { line: string; attention: boolean };

const fail = (msg: string): never => {
  out(`${RED}${msg}${RESET}`, true);
  process.exit(2);
};

const parseArgs = (argv: string[]) => {
  const args = { update: false, build: true };
  for (const arg of argv) {
    if (arg === '--update') args.update = true;
    else if (arg === '--no-build') args.build = false;
    else fail(`Unknown argument: ${arg} (usage: yarn verify:baselines [--update] [--no-build])`);
  }
  return args;
};

const readJSON = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
};

const formatKB = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;
const formatSigned = (bytes: number) => `${bytes >= 0 ? '+' : '−'}${formatKB(Math.abs(bytes))}`;
const formatShare = (c: Coverage) =>
  `${c.documented} / ${c.total}${c.total ? ` (${Math.round((c.documented / c.total) * 100)} %)` : ''}`;

// --- Build ---

/** Runs `yarn <args>`, its output into the progress log */
const runYarn = (args: string[], env: Record<string, string> = {}) =>
  new Promise<void>((resolve, reject) => {
    out(
      `${DIM}$ ${Object.entries(env)
        .map(([k, v]) => `${k}=${v} `)
        .join('')}yarn ${args.join(' ')}${RESET}`
    );
    const child = spawn('yarn', ['-s', ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    const pipe = (stream: NodeJS.ReadableStream, isError: boolean) => {
      let pending = '';
      stream.on('data', (data: Buffer) => {
        const lines = (pending + data.toString()).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) out(`  ${line}`, isError);
      });
      stream.on('end', () => pending && out(`  ${pending}`, isError));
    };
    pipe(child.stdout, false);
    pipe(child.stderr, true);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`yarn ${args.join(' ')} exited with ${code}`))
    );
  });

/** `yarn build`'s bundle steps; the dev data is gathered again whatever happens */
const buildBundle = async () => {
  try {
    await runYarn(['copyDecoders']);
    await runYarn(['gatherAppData'], { NODE_ENV: 'production' });
    await runYarn(['vite', 'build']);
  } finally {
    await runYarn(['gatherAppData']);
  }
};

// --- bundle.json ---

type Manifest = Record<string, { file: string; src?: string; isEntry?: boolean }>;
type VisualizerData = {
  nodeParts: Record<string, { renderedLength: number; gzipLength: number }>;
  nodeMetas: Record<string, { id: string; moduleParts: Record<string, string> }>;
};

/** `assets/index-Hx4K2rfZ.js` → `assets/index.js` (Vite's 8-character content hash) */
const stripHash = (file: string) => file.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, '$1');

/** The main chunk's module groups: a package, an engine folder (core's subfolders apart), the
 * toolkit, or the app (`src/app/` and `src/`'s own files) */
const getModuleGroup = (id: string) => {
  if (id.startsWith('\0')) return 'vite';
  const pkg = id.match(/^\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (pkg) return pkg[1];
  const src = id.match(/^\/src\/([^?]*)/);
  if (!src) return 'other';
  const parts = src[1].split('/');
  if (parts[0] === '_engine') {
    if (parts.length <= 2) return '_engine';
    if (parts[1] === 'core' && parts.length > 3) return `_engine/core/${parts[2]}`;
    return `_engine/${parts[1]}`;
  }
  return parts[0] === 'toolkit' ? 'toolkit' : 'app';
};

const sortKeys = <T>(obj: Record<string, T>) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

const collectBundle = (): BundleBaseline => {
  const manifest = readJSON<Manifest>(MANIFEST_FILE);
  if (!manifest || !fs.existsSync(DIST_ASSETS_DIR)) {
    return fail('No dist/ build to measure: run without --no-build, or yarn build first');
  }
  const entry = Object.values(manifest).find((m) => m.isEntry);
  if (!entry) return fail(`${path.relative(ROOT, MANIFEST_FILE)} names no entry chunk`);

  const chunks: Record<string, Size> = {};
  for (const name of fs.readdirSync(DIST_ASSETS_DIR).sort()) {
    const data = fs.readFileSync(path.join(DIST_ASSETS_DIR, name));
    let key = stripHash(`assets/${name}`);
    for (let n = 2; chunks[key]; n++) key = `${stripHash(`assets/${name}`)}#${n}`;
    chunks[key] = { bytes: data.length, gzip: zlib.gzipSync(data, { level: 9 }).length };
  }

  const html = fs.existsSync(VISUALIZER_FILE) ? fs.readFileSync(VISUALIZER_FILE, 'utf-8') : '';
  const match = html.match(/const data = (\{.*?\});\n/s);
  if (!match) return fail(`No visualizer data in ${path.relative(ROOT, VISUALIZER_FILE)}`);
  const data = JSON.parse(match[1]) as VisualizerData;
  const groups: Record<string, GroupSize> = {};
  const main = { chunk: stripHash(entry.file), modules: 0, rendered: 0, gzip: 0 };
  for (const meta of Object.values(data.nodeMetas)) {
    const partId = meta.moduleParts[entry.file];
    if (!partId) continue;
    const part = data.nodeParts[partId];
    const group = (groups[getModuleGroup(meta.id)] ??= { modules: 0, rendered: 0, gzip: 0 });
    group.modules++;
    group.rendered += part.renderedLength;
    group.gzip += part.gzipLength;
    main.modules++;
    main.rendered += part.renderedLength;
    main.gzip += part.gzipLength;
  }
  if (!main.modules) {
    return fail(
      `The visualizer data has no modules in ${entry.file}: dist-stats/ is from another build`
    );
  }
  return { formatVersion: FORMAT_VERSION, chunks, main, mainGroups: sortKeys(groups) };
};

const isGrowthToFlag = (before: number, after: number) => {
  const growth = after - before;
  return growth >= GROWTH_MIN_BYTES && (growth > GROWTH_BYTES || growth > before * GROWTH_RATIO);
};

const diffBundle = (before: BundleBaseline, after: BundleBaseline): Finding[] => {
  const findings: Finding[] = [];
  for (const [name, size] of Object.entries(after.chunks)) {
    const old = before.chunks[name];
    if (!old) {
      findings.push({ line: `new ${name}: ${formatKB(size.gzip)} gzip`, attention: true });
    } else if (isGrowthToFlag(old.gzip, size.gzip)) {
      findings.push({
        line: `${name}: ${formatKB(old.gzip)} → ${formatKB(size.gzip)} gzip (${formatSigned(size.gzip - old.gzip)})`,
        attention: true,
      });
    } else if (isGrowthToFlag(size.gzip, old.gzip)) {
      findings.push({
        line: `${name}: ${formatKB(old.gzip)} → ${formatKB(size.gzip)} gzip (${formatSigned(size.gzip - old.gzip)})`,
        attention: false,
      });
    }
  }
  for (const name of Object.keys(before.chunks)) {
    if (!after.chunks[name]) findings.push({ line: `gone: ${name}`, attention: false });
  }
  // The main chunk's groups explain a change of it (details, never a reason on their own)
  for (const [group, size] of Object.entries(after.mainGroups)) {
    const old = before.mainGroups[group];
    const oldGzip = old?.gzip ?? 0;
    if (isGrowthToFlag(oldGzip, size.gzip) || isGrowthToFlag(size.gzip, oldGzip)) {
      findings.push({
        line: `  main ${group}: ${formatKB(oldGzip)} → ${formatKB(size.gzip)} gzip (${formatSigned(size.gzip - oldGzip)}, ${old?.modules ?? 0} → ${size.modules} modules)`,
        attention: false,
      });
    }
  }
  for (const group of Object.keys(before.mainGroups)) {
    if (!after.mainGroups[group]) {
      findings.push({ line: `  main ${group}: gone from the main chunk`, attention: false });
    }
  }
  return findings;
};

// --- api.json and docs.json ---

const KIND_NAMES = new Map<number, string>(Object.entries(Kind).map(([name, n]) => [n, name]));

const addTo = (into: Coverage, documented: boolean) => {
  into.total++;
  if (documented) into.documented++;
};
const emptyFolderCoverage = (): FolderCoverage => ({
  exports: { documented: 0, total: 0 },
  members: { documented: 0, total: 0 },
});

const collectApiAndDocs = async (): Promise<{ api: ApiBaseline; docs: DocsBaseline }> => {
  out(`${DIM}The TypeDoc model (converted only when its inputs changed)…${RESET}`);
  const result = await loadApiModel();
  if (!result.model) {
    for (const m of result.messages) out(`  ${m.message}`, true);
    return fail('The TypeDoc conversion failed');
  }
  out(
    `${DIM}  ${result.isCached ? 'cached' : 'converted'} in ${(result.durationMs / 1000).toFixed(1)} s${RESET}`
  );
  const index = indexApiModel(result.model.project);

  const modules: ApiBaseline['modules'] = {};
  const docs: DocsBaseline = {
    formatVersion: FORMAT_VERSION,
    total: emptyFolderCoverage(),
    subtrees: {},
    folders: {},
  };
  for (const module of index.modules) {
    const exports: Record<string, string[]> = {};
    for (const symbol of module.symbols) {
      (exports[symbol.name] ??= []).push(KIND_NAMES.get(symbol.kind) ?? String(symbol.kind));
    }
    modules[module.sourcePath] = sortKeys(
      Object.fromEntries(
        Object.entries(exports).map(([name, kinds]) => [name, kinds.sort().join(', ')])
      )
    );

    const dir = module.relPath.includes('/')
      ? module.relPath.slice(0, module.relPath.lastIndexOf('/'))
      : '';
    const folderKey = dir ? `${module.subtree}/${dir}` : module.subtree;
    const folder = (docs.folders[folderKey] ??= emptyFolderCoverage());
    const subtree = (docs.subtrees[module.subtree] ??= emptyFolderCoverage());
    for (const symbol of module.symbols) {
      if (symbol.kind === Kind.Reference) continue;
      const documented = isDocumented(symbol);
      for (const into of [folder, subtree, docs.total]) addTo(into.exports, documented);
      if (symbol.kind !== Kind.Class && symbol.kind !== Kind.Interface) continue;
      for (const member of getOwnMembers(symbol)) {
        const memberDocumented = isDocumented(member);
        for (const into of [folder, subtree, docs.total]) addTo(into.members, memberDocumented);
      }
    }
  }
  docs.subtrees = sortKeys(docs.subtrees);
  docs.folders = sortKeys(docs.folders);
  return { api: { formatVersion: FORMAT_VERSION, modules: sortKeys(modules) }, docs };
};

const diffApi = (before: ApiBaseline, after: ApiBaseline): Finding[] => {
  type Entry = { module: string; name: string; kind: string };
  const flatten = (api: ApiBaseline) =>
    Object.entries(api.modules).flatMap(([module, exports]) =>
      Object.entries(exports).map(([name, kind]): Entry => ({ module, name, kind }))
    );
  const key = (e: Entry) => `${e.module}#${e.name}`;
  const beforeMap = new Map(flatten(before).map((e) => [key(e), e]));
  const afterMap = new Map(flatten(after).map((e) => [key(e), e]));
  const removed = [...beforeMap.values()].filter((e) => !afterMap.has(key(e)));
  const added = [...afterMap.values()].filter((e) => !beforeMap.has(key(e)));

  const findings: Finding[] = [];
  // The same name and kind gone from one module and new in another is a move
  for (const gone of [...removed]) {
    const moved = added.find((e) => e.name === gone.name && e.kind === gone.kind);
    if (!moved) continue;
    removed.splice(removed.indexOf(gone), 1);
    added.splice(added.indexOf(moved), 1);
    findings.push({
      line: `moved ${gone.name} (${gone.kind}): ${gone.module} → ${moved.module}`,
      attention: true,
    });
  }
  for (const e of removed) {
    findings.push({ line: `removed ${e.name} (${e.kind}) from ${e.module}`, attention: true });
  }
  for (const e of added) {
    findings.push({ line: `added ${e.name} (${e.kind}) in ${e.module}`, attention: true });
  }
  for (const [k, e] of afterMap) {
    const old = beforeMap.get(k);
    if (old && old.kind !== e.kind) {
      findings.push({
        line: `${e.name} in ${e.module}: ${old.kind} → ${e.kind}`,
        attention: true,
      });
    }
  }
  return findings;
};

const share = (c: Coverage) => (c.total ? c.documented / c.total : 1);

const diffDocs = (before: DocsBaseline, after: DocsBaseline): Finding[] => {
  const findings: Finding[] = [];
  const compare = (label: string, old: FolderCoverage | undefined, now: FolderCoverage) => {
    for (const part of ['exports', 'members'] as const) {
      const a = old?.[part] ?? { documented: 0, total: 0 };
      const b = now[part];
      if (a.documented === b.documented && a.total === b.total) continue;
      const dropped = share(b) < share(a) - 1e-9;
      findings.push({
        line: `${label} ${part}: ${formatShare(a)} → ${formatShare(b)}`,
        attention: dropped,
      });
    }
  };
  for (const [folder, coverage] of Object.entries(after.folders)) {
    compare(folder, before.folders[folder], coverage);
  }
  for (const folder of Object.keys(before.folders)) {
    if (!after.folders[folder]) findings.push({ line: `${folder}: gone`, attention: false });
  }
  return findings;
};

// --- Main ---

const writeBaseline = (name: string, data: unknown) => {
  fs.mkdirSync(BASELINES_DIR, { recursive: true });
  fs.writeFileSync(path.join(BASELINES_DIR, name), `${JSON.stringify(data, null, 2)}\n`);
};

const readBaseline = <T extends { formatVersion: number }>(name: string) => {
  const data = readJSON<T>(path.join(BASELINES_DIR, name));
  return data?.formatVersion === FORMAT_VERSION ? data : null;
};

const report = <T extends { formatVersion: number }>(
  name: string,
  summary: string,
  current: T,
  diff: (before: T, after: T) => Finding[],
  isUpdate: boolean
) => {
  const before = readBaseline<T>(name);
  out(`\n${name}: ${summary}`);
  if (!before) {
    out(`  ${YELLOW}no baseline${isUpdate ? '' : ' (record one with --update)'}${RESET}`);
    return { attention: 0, changes: 1 };
  }
  const findings = diff(before, current);
  if (!findings.length) out(`  ${GREEN}unchanged${RESET}`);
  for (const f of findings) out(`  ${f.attention ? `${RED}✗` : `${DIM}·`} ${f.line}${RESET}`);
  return { attention: findings.filter((f) => f.attention).length, changes: findings.length };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  out(
    `Baselines (${path.relative(ROOT, BASELINES_DIR)}/)${args.update ? ', recording them' : ''}${args.build ? '' : ', reusing the last build'}`
  );
  out(`${DIM}Watch it: ${PROGRESS_LOG_WATCH}${RESET}\n`);
  const started = Date.now();

  if (args.build) await buildBundle();
  const bundle = collectBundle();
  const { api, docs } = await collectApiAndDocs();

  const exportCount = Object.values(api.modules).reduce((n, m) => n + Object.keys(m).length, 0);
  const results = [
    report(
      'bundle.json',
      `${Object.keys(bundle.chunks).length} files; main ${bundle.main.chunk} ${bundle.main.modules} modules, ${formatKB(bundle.main.rendered)} rendered, ${formatKB(bundle.main.gzip)} gzip`,
      bundle,
      diffBundle,
      args.update
    ),
    report(
      'api.json',
      `${exportCount} exports in ${Object.keys(api.modules).length} modules`,
      api,
      diffApi,
      args.update
    ),
    report(
      'docs.json',
      `exports ${formatShare(docs.total.exports)}, members ${formatShare(docs.total.members)} documented`,
      docs,
      diffDocs,
      args.update
    ),
  ];

  const attention = results.reduce((n, r) => n + r.attention, 0);
  const changes = results.reduce((n, r) => n + r.changes, 0);
  const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  if (args.update) {
    writeBaseline('bundle.json', bundle);
    writeBaseline('api.json', api);
    writeBaseline('docs.json', docs);
    out(`\n${GREEN}Recorded the baselines${RESET} in ${took}: commit them with the change.`);
    return;
  }
  if (attention) {
    out(
      `\n${RED}${attention} change(s) to look at${RESET} in ${took}. If they're intended, record them with --update and commit the baselines with the change.`
    );
    process.exit(1);
  }
  out(
    changes
      ? `\n${GREEN}Nothing to look at${RESET} in ${took}; ${changes} smaller change(s): --update records them.`
      : `\n${GREEN}All baselines unchanged${RESET} in ${took}.`
  );
};

main().catch((err: Error) => fail(`The baselines stopped: ${err.message}`));
