import fs from 'node:fs';
import path from 'node:path';
import type { JSONOutput, MinimalNode, MinimalSourceFile } from 'typedoc';
import { hashContent } from '../hash';
import { HUB_API_CACHE_FILE, PACKAGE_JSON_FILE, ROOT, TSCONFIG_FILE } from '../paths';

/**
 * The API model (p553 §2.1): TypeDoc's JSON for the engine and the toolkit, from the
 * `typedocOptions` in `tsconfig.json` (the entry points and the `_dbg__*` / `generatedApp*`
 * excludes `yarn docs` uses too). It's cached in `.cache/hub/typedoc.json` with a hash of its
 * inputs (the source files' paths, mtimes and sizes, the configs, the TypeDoc version), and kept
 * in memory, so an unchanged model costs a hash: the conversion takes seconds.
 *
 * TypeDoc is loaded only to convert, never on a cache hit (the dev plugin imports this). It runs
 * without type checking (`skipErrorChecking`: `tsc` checks the types, and a type error elsewhere
 * would stop the docs) and without git (`disableGit`: the Hub writes its own source links, so the
 * model doesn't change with the commit).
 */

/** Bump when the options below or the cache file's shape change */
const EXTRACT_VERSION = 2;

/** The folders the entry points are in; the engine also imports `src/`'s own files */
const SOURCE_DIRS = ['src/_engine', 'src/toolkit'].map((dir) => path.join(ROOT, dir));
const SRC_DIR = path.join(ROOT, 'src');
/** The type information comes from installed packages too */
const LOCK_FILE = path.join(ROOT, 'yarn.lock');
/** `typedocOptions.exclude`: they aren't in the model, so they aren't in its hash */
const EXCLUDED_FILE_REGEX = /^(_dbg__|generatedApp)/;

export type ApiExtractMessage = {
  level: 'error' | 'warning';
  message: string;
  /** Absolute, when TypeDoc named a source position or a reflection of a known module */
  file?: string;
  line?: number;
};

export type ApiModel = {
  /** The inputs' hash: an unchanged one is the same model */
  hash: string;
  project: JSONOutput.ProjectReflection;
  /** TypeDoc's warnings, kept with the model so a cache hit reports them too */
  messages: ApiExtractMessage[];
};

export type ApiExtractResult = {
  /** Null when the conversion failed (`messages` says why) */
  model: ApiModel | null;
  messages: ApiExtractMessage[];
  isCached: boolean;
  durationMs: number;
};

type CacheFile = ApiModel & { version: number };

const listSourceFiles = (dir: string, files: string[] = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(file, files);
    else if (entry.name.endsWith('.ts') && !EXCLUDED_FILE_REGEX.test(entry.name)) files.push(file);
  }
  return files;
};

const getTypedocVersion = () =>
  (
    JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules', 'typedoc', 'package.json'), 'utf-8')
    ) as { version: string }
  ).version;

/** The hash of everything the model is built from */
export const hashApiInputs = () => {
  const files = [
    ...SOURCE_DIRS.flatMap((dir) => (fs.existsSync(dir) ? listSourceFiles(dir) : [])),
    ...fs
      .readdirSync(SRC_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.join(SRC_DIR, name)),
    TSCONFIG_FILE,
    PACKAGE_JSON_FILE,
    LOCK_FILE,
  ].sort();
  const lines = files.map((file) => {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return `${path.relative(ROOT, file)}\0${stat?.mtimeMs ?? -1}\0${stat?.size ?? -1}`;
  });
  return hashContent(`${EXTRACT_VERSION}\n${getTypedocVersion()}\n${lines.join('\n')}`);
};

let memory: ApiModel | null = null;

const readCache = (hash: string): ApiModel | null => {
  if (memory?.hash === hash) return memory;
  try {
    const cache = JSON.parse(fs.readFileSync(HUB_API_CACHE_FILE, 'utf-8')) as CacheFile;
    if (cache.version !== EXTRACT_VERSION || cache.hash !== hash) return null;
    return (memory = { hash: cache.hash, project: cache.project, messages: cache.messages });
  } catch {
    return null; // None yet, or unreadable: converted again
  }
};

const writeCache = (model: ApiModel) => {
  const cache: CacheFile = { version: EXTRACT_VERSION, ...model };
  fs.mkdirSync(path.dirname(HUB_API_CACHE_FILE), { recursive: true });
  const temp = `${HUB_API_CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache));
  fs.renameSync(temp, HUB_API_CACHE_FILE);
};

/** `The signature _engine/core/SceneLoader.SceneLoader.loadFn…`: the module's file */
const findModuleFile = (message: string, project: JSONOutput.ProjectReflection) => {
  let best: JSONOutput.DeclarationReflection | null = null;
  for (const module of project.children ?? []) {
    if (!message.includes(`${module.name}.`)) continue;
    if (!best || module.name.length > best.name.length) best = module;
  }
  const fileName = best?.sources?.[0]?.fileName;
  return fileName ? path.join(ROOT, fileName) : undefined;
};

const convert = async (): Promise<{
  project: JSONOutput.ProjectReflection | null;
  messages: ApiExtractMessage[];
}> => {
  const { Application, Logger, LogLevel } = await import('typedoc');
  const messages: ApiExtractMessage[] = [];

  /** Keeps TypeDoc's warnings and errors, with the source position it names */
  class CapturingLogger extends Logger {
    private position: { file?: string; line?: number } = {};

    protected override addContext(
      message: string,
      _level: number,
      ...args: [MinimalNode?] | [number, MinimalSourceFile]
    ) {
      const [first, second] = args;
      let file: MinimalSourceFile | undefined;
      let pos = 0;
      if (typeof first === 'number' && second) {
        file = second;
        pos = first;
      } else if (first && typeof first === 'object') {
        file = first.getSourceFile();
        pos = first.getStart();
      }
      this.position = file
        ? {
            file: path.resolve(ROOT, file.fileName),
            line: file.getLineAndCharacterOfPosition(pos).line + 1,
          }
        : {};
      return message;
    }

    override log(message: string, level: number) {
      super.log(message, level);
      const position = this.position;
      this.position = {};
      if (level < LogLevel.Warn) return;
      // Comments in installed packages' declarations (three's) aren't ours to fix
      const nodeModules = `${path.sep}node_modules${path.sep}`;
      if (position.file?.includes(nodeModules) || message.includes('/node_modules/')) return;
      messages.push({ level: level >= LogLevel.Error ? 'error' : 'warning', message, ...position });
    }
  }

  const app = await Application.bootstrapWithPlugins({
    tsconfig: TSCONFIG_FILE,
    skipErrorChecking: true,
    disableGit: true,
    // Required with `disableGit`; the Hub builds its own links from the file and line
    sourceLinkTemplate: '{path}#L{line}',
    logLevel: 'Warn',
  });
  app.logger = new CapturingLogger();
  const project = await app.convert();
  if (!project) return { project: null, messages };
  const json = app.serializer.projectToObject(
    project,
    ROOT as Parameters<typeof app.serializer.projectToObject>[1]
  );
  for (const message of messages) message.file ??= findModuleFile(message.message, json);
  return { project: json, messages };
};

/**
 * The API model: from memory or the cache when its inputs haven't changed, else converted (and
 * cached). Never throws: a failed conversion is a null model with its messages.
 */
export const loadApiModel = async (): Promise<ApiExtractResult> => {
  const startTime = performance.now();
  const durationMs = () => performance.now() - startTime;
  const hash = hashApiInputs();
  const cached = readCache(hash);
  if (cached) {
    return { model: cached, messages: cached.messages, isCached: true, durationMs: durationMs() };
  }

  try {
    const { project, messages } = await convert();
    if (!project) {
      if (!messages.some((m) => m.level === 'error')) {
        messages.push({
          level: 'error',
          message: 'TypeDoc converted nothing',
          file: TSCONFIG_FILE,
        });
      }
      return { model: null, messages, isCached: false, durationMs: durationMs() };
    }
    memory = { hash, project, messages };
    writeCache(memory);
    return { model: memory, messages, isCached: false, durationMs: durationMs() };
  } catch (err) {
    const message = `TypeDoc failed: ${(err as Error).stack ?? String(err)}`;
    const messages: ApiExtractMessage[] = [{ level: 'error', message, file: TSCONFIG_FILE }];
    return { model: null, messages, isCached: false, durationMs: durationMs() };
  }
};
