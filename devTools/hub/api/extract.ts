import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DeclarationReflection,
  JSONOutput,
  MinimalNode,
  MinimalSourceFile,
  ProjectReflection,
  Reflection,
  SignatureReflection,
} from 'typedoc';
import { hashContent } from '../hash';
import { HUB_API_CACHE_FILE, PACKAGE_JSON_FILE, ROOT, toRepoPath, TSCONFIG_FILE } from '../paths';

/**
 * The API model (p553 §2.1): TypeDoc's JSON for the engine and the toolkit, from the
 * `typedocOptions` in `tsconfig.json` (the entry points and the `_dbg__*` / `*.test.ts` /
 * `index.ts` excludes `yarn docs` uses too). It's cached in `.cache/hub/typedoc.json` with a hash of its
 * inputs (the source files' paths, mtimes and sizes, the configs, the TypeDoc version), and kept
 * in memory, so an unchanged model costs a hash: the conversion takes seconds.
 *
 * TypeDoc is loaded only to convert, never on a cache hit (the dev plugin imports this). It runs
 * without type checking (`skipErrorChecking`: `tsc` checks the types, and a type error elsewhere
 * would stop the docs) and without git (`disableGit`: the Hub writes its own source links, so the
 * model doesn't change with the commit).
 *
 * The dev plugin never converts in its own process (§2.5): a conversion blocks the event loop for
 * seconds at a time (the app's requests too) and keeps hundreds of MB. Its builds take the last
 * good model whatever its inputs (`getLastApiModel`), and its rebuilds convert in a child process
 * (`extractApiModelInChildProcess`), which writes the cache file this process then reads.
 *
 * After the conversion it runs TypeDoc's validation (p605 S5; `convert()` alone runs none):
 * `notExported` (a public signature naming a type the API doesn't export), never `notDocumented`
 * (the docs ratchet in `yarn verify:baselines` gates presence). A warning about a member inherited
 * from another class is dropped: it's the base class's comment (three's, mostly). The model has
 * `typedoc-plugin-zod` (`typedocOptions.plugin`): a `z.infer` / `z.input` alias shows its fields.
 */

/** Bump when the options below, the validation or the cache file's shape change */
const EXTRACT_VERSION = 3;

/** The folders the entry points are in; the engine also imports `src/`'s own files */
const SOURCE_DIRS = ['src/_engine', 'src/toolkit'].map((dir) => path.join(ROOT, dir));
const SRC_DIR = path.join(ROOT, 'src');
/** The type information comes from installed packages too */
const LOCK_FILE = path.join(ROOT, 'yarn.lock');
/**
 * `typedocOptions.exclude`: they aren't in the model, so they aren't in its hash. The entries
 * (`index.ts`, p606) only re-export: TypeDoc documents the source files until p619.
 */
const EXCLUDED_FILE_REGEX = /^(_dbg__|index\.ts$)|\.test\.ts$/;
/** The child process's entry, run through tsx */
const CHILD_PROCESS_ENTRY = path.join(ROOT, 'devTools', 'hub', 'api', 'extractProcess.ts');

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

/** What the child process (`extractProcess.ts`) sends back: the cached model's hash, or null */
export type ApiChildProcessReply = Omit<ApiExtractResult, 'model'> & { hash: string | null };

type CacheFile = ApiModel & { version: number };

const isSourceFileName = (name: string) => name.endsWith('.ts') && !EXCLUDED_FILE_REGEX.test(name);

const listSourceFiles = (dir: string, files: string[] = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(file, files);
    else if (isSourceFileName(entry.name)) files.push(file);
  }
  return files;
};

/** Whether `file` (absolute) is one of `hashApiInputs`' inputs: the dev plugin's stale check */
export const isApiInputFile = (file: string) => {
  if (file === TSCONFIG_FILE || file === PACKAGE_JSON_FILE || file === LOCK_FILE) return true;
  if (!isSourceFileName(path.basename(file))) return false;
  return (
    path.dirname(file) === SRC_DIR || SOURCE_DIRS.some((dir) => file.startsWith(dir + path.sep))
  );
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

/** The last good model in this process */
let memory: ApiModel | null = null;
/** The last conversion's messages when it failed (the dev plugin's builds keep `memory` then) */
let failure: ApiExtractMessage[] | null = null;

const readCacheFile = (): CacheFile | null => {
  try {
    const cache = JSON.parse(fs.readFileSync(HUB_API_CACHE_FILE, 'utf-8')) as CacheFile;
    return cache.version === EXTRACT_VERSION ? cache : null;
  } catch {
    return null; // None yet, or unreadable: converted again
  }
};

const toModel = ({ hash, project, messages }: CacheFile): ApiModel => ({ hash, project, messages });

const readCache = (hash: string): ApiModel | null => {
  if (memory?.hash === hash) return memory;
  const cache = readCacheFile();
  return cache?.hash === hash ? (memory = toModel(cache)) : null;
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

/** The reflection a validation warning is about, by its friendly name (TypeDoc 0.28's messages) */
const VALIDATION_OWNER_REGEXES = [
  /^Failed to resolve link to .+? in comment for (.+?)(?:\. You may have wanted .*)?$/s,
  /^The comment for (.+?) links to "/,
  /, is referenced by (.+?) but not included in the documentation/,
];

/**
 * Validation warnings name their reflection but carry no position: this finds it, drops the
 * warnings about inherited members (or their parameters) and adds the file and line
 */
const locateValidationMessages = (project: ProjectReflection, messages: ApiExtractMessage[]) => {
  const byName = new Map<string, Reflection>();
  for (const reflection of Object.values(project.reflections)) {
    // A signature has its declaration's name: the declaration is the one to find
    const name = reflection.getFriendlyFullName();
    if (!byName.has(name) || reflection.isDeclaration()) byName.set(name, reflection);
  }
  const find = (name: string) => {
    for (let n = name; n; n = n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : '') {
      const reflection = byName.get(n);
      if (reflection) return reflection;
    }
    return undefined;
  };
  return messages.filter((message) => {
    const owner = VALIDATION_OWNER_REGEXES.map((regex) => message.message.match(regex)?.[1]).find(
      Boolean
    );
    const reflection = owner ? find(owner) : undefined;
    const chain: Reflection[] = [];
    for (let r = reflection; r; r = r.parent) chain.push(r);
    const declarations = chain.filter(
      (r): r is DeclarationReflection | SignatureReflection => r.isDeclaration() || r.isSignature()
    );
    if (declarations.some((r) => r.inheritedFrom)) return false;
    const source = declarations.find((r) => r.sources?.length)?.sources?.[0];
    if (source) {
      message.file = source.fullFileName;
      message.line = source.line;
    }
    return true;
  });
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
    // `invalidLink` is off: the Hub's renderer reports every `{@link}` that links nowhere already
    // (`comments.ts`), and TypeDoc's would repeat each one
    validation: { notExported: true, invalidLink: false, notDocumented: false },
  });
  app.logger = new CapturingLogger();
  const project = await app.convert();
  if (!project) return { project: null, messages };
  const converted = messages.splice(0);
  app.validate(project);
  messages.unshift(...converted, ...locateValidationMessages(project, messages.splice(0)));
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
    failure = null;
    writeCache(memory);
    return { model: memory, messages, isCached: false, durationMs: durationMs() };
  } catch (err) {
    const message = `TypeDoc failed: ${(err as Error).stack ?? String(err)}`;
    const messages: ApiExtractMessage[] = [{ level: 'error', message, file: TSCONFIG_FILE }];
    return { model: null, messages, isCached: false, durationMs: durationMs() };
  }
};

/**
 * The dev plugin's model (§2.5): the last good one whatever its inputs (from memory, else the
 * cache file), with the last conversion's messages: a failed one's errors land on the API pages
 * while every other page keeps the last good `api:` links. `isStale` when it was read from a cache
 * file older than its inputs, or there's none and no conversion has run.
 */
export const getLastApiModel = (): ApiExtractResult & { isStale: boolean } => {
  const startTime = performance.now();
  let isStale = false;
  if (!memory && !failure) {
    const cache = readCacheFile();
    if (cache) memory = toModel(cache);
    isStale = !cache || cache.hash !== hashApiInputs();
  }
  return {
    model: memory,
    messages: failure ?? memory?.messages ?? [],
    isCached: true,
    isStale,
    durationMs: performance.now() - startTime,
  };
};

/**
 * Converts in a child process (`extractProcess.ts`, through tsx), which writes the cache file, and
 * then reads it into this process: `getLastApiModel` returns it from then on. A failure keeps the
 * last good model, and its messages are the next builds' (`getLastApiModel`). Never rejects.
 */
export const extractApiModelInChildProcess = () =>
  new Promise<{ isOk: boolean; isCached: boolean; durationMs: number }>((resolve) => {
    const startTime = performance.now();
    let reply: ApiChildProcessReply | null = null;
    let isSettled = false;
    const settle = (isOk: boolean, isCached = false) => {
      if (isSettled) return;
      isSettled = true;
      resolve({ isOk, isCached, durationMs: performance.now() - startTime });
    };
    const fail = (message: string) => {
      failure = [{ level: 'error', message, file: TSCONFIG_FILE }];
      settle(false);
    };

    const child = fork(CHILD_PROCESS_ENTRY, [], {
      cwd: ROOT,
      execArgv: ['--import', 'tsx'],
      // Its stderr reaches the terminal: a crash's stack
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (message) => (reply = message as ApiChildProcessReply));
    child.on('error', (err) => fail(`The API extraction process failed: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (!reply) {
        fail(`The API extraction process exited (${signal ?? `code ${code}`}) without a model`);
      } else if (!reply.hash) {
        failure = reply.messages;
        settle(false);
      } else if (readCache(reply.hash)) {
        failure = null;
        settle(true, reply.isCached);
      } else {
        fail(`The API extraction process wrote no ${toRepoPath(HUB_API_CACHE_FILE)}`);
      }
    });
  });
