import path from 'node:path';
import type { JSONOutput, ReflectionKind } from 'typedoc';
import { ROOT } from '../paths';

/**
 * The API model indexed for the pages (p553 §2.2): every module (a source file) with its page
 * path, the folders above them, each symbol's page and anchor, and the doc coverage.
 *
 * Two subtrees, `engine/` (`src/_engine/`) and `toolkit/` (`src/toolkit/`), each a folder tree
 * under `documentation/`. A module's page is its file's path without `.ts`
 * (`documentation/engine/core/SceneLoader/`), and a folder's page its path. A module next to a
 * folder of the same name (`core/ECS.ts`, `core/ECS/`) has the folder's URL: its page is both,
 * the module's symbols and the folder's list.
 */

export type DeclarationReflection = JSONOutput.DeclarationReflection;
export type SignatureReflection = JSONOutput.SignatureReflection;
export type SomeType = JSONOutput.SomeType;
export type Comment = JSONOutput.Comment;

/**
 * TypeDoc 0.28's reflection kinds (`ReflectionKind`), as numbers: importing the enum would load
 * TypeDoc wherever the Hub builds. `satisfies` checks them against it, so an upgrade that renumbers
 * a kind fails `tsc` (p550 §7.1).
 */
export const Kind = {
  Module: 2,
  Namespace: 4,
  Enum: 8,
  EnumMember: 16,
  Variable: 32,
  Function: 64,
  Class: 128,
  Interface: 256,
  Constructor: 512,
  Property: 1024,
  Method: 2048,
  CallSignature: 4096,
  IndexSignature: 8192,
  ConstructorSignature: 16384,
  Parameter: 32768,
  TypeLiteral: 65536,
  TypeParameter: 131072,
  Accessor: 262144,
  GetSignature: 524288,
  SetSignature: 1048576,
  TypeAlias: 2097152,
  Reference: 4194304,
} as const satisfies { [K in keyof typeof ReflectionKind]?: (typeof ReflectionKind)[K] };

export const API_SECTION_PATH = 'documentation/';

export type ApiSubtree = 'engine' | 'toolkit';

export const API_SUBTREES: { id: ApiSubtree; sourceDir: string; title: string }[] = [
  { id: 'engine', sourceDir: 'src/_engine', title: 'Engine' },
  { id: 'toolkit', sourceDir: 'src/toolkit', title: 'Toolkit' },
];

/** Documented or not: a comment on it, or on one of its signatures */
export type Coverage = { documented: number; total: number };

export type ApiModule = {
  reflection: DeclarationReflection;
  subtree: ApiSubtree;
  /** From its subtree's folder, without `.ts`: `core/SceneLoader` */
  relPath: string;
  /** From the repo root: `src/_engine/core/SceneLoader.ts` */
  sourcePath: string;
  /** Absolute: its page's diagnostics point here */
  file: string;
  pagePath: string;
  /** Its exports, references (re-exports) included */
  symbols: DeclarationReflection[];
  /** References don't count: their target does, where it's declared */
  coverage: Coverage;
};

export type ApiFolder = {
  subtree: ApiSubtree;
  /** From its subtree's folder: `core/Physics`, '' for the subtree's own */
  relPath: string;
  /** From the repo root: `src/_engine/core/Physics` */
  sourcePath: string;
  pagePath: string;
  folders: ApiFolder[];
  modules: ApiModule[];
  /** The module with this folder's URL (`core/ECS.ts` for `core/ECS/`): its page is the folder's */
  module: ApiModule | null;
  /** Its own modules', for the landing page's groups */
  coverage: Coverage;
  /** With its subfolders' */
  totalCoverage: Coverage;
};

/** Where a reflection is shown: its module's page and its anchor there */
export type ApiTarget = { module: ApiModule; anchor: string };

export type ApiIndex = {
  project: JSONOutput.ProjectReflection;
  modules: ApiModule[];
  roots: Record<ApiSubtree, ApiFolder>;
  /** Every page's folder, by page path */
  folders: Map<string, ApiFolder>;
  /** Symbols and their members (a class's methods) by reflection id */
  targets: Map<number, ApiTarget>;
  reflections: Map<number, DeclarationReflection>;
  coverage: Record<ApiSubtree, Coverage>;
};

const hasComment = (comment: Comment | undefined) =>
  !!comment && (comment.summary.length > 0 || (comment.blockTags?.length ?? 0) > 0);

export const isDocumented = (reflection: DeclarationReflection) =>
  hasComment(reflection.comment) ||
  !!reflection.signatures?.some((signature) => hasComment(signature.comment)) ||
  hasComment(reflection.getSignature?.comment) ||
  hasComment(reflection.setSignature?.comment);

const addCoverage = (into: Coverage, from: Coverage) => {
  into.documented += from.documented;
  into.total += from.total;
};

/** Members that get an anchor of their own: what a class or an interface declares itself */
export const getOwnMembers = (symbol: DeclarationReflection) =>
  (symbol.children ?? []).filter((child) => !child.inheritedFrom);

const createFolder = (subtree: ApiSubtree, relPath: string): ApiFolder => {
  const { sourceDir } = API_SUBTREES.find((s) => s.id === subtree)!;
  return {
    subtree,
    relPath,
    sourcePath: relPath ? `${sourceDir}/${relPath}` : sourceDir,
    pagePath: `${API_SECTION_PATH}${subtree}/${relPath ? `${relPath}/` : ''}`,
    folders: [],
    modules: [],
    module: null,
    coverage: { documented: 0, total: 0 },
    totalCoverage: { documented: 0, total: 0 },
  };
};

/** `src/_engine/core/SceneLoader.ts` → its subtree and `core/SceneLoader` */
const locateModule = (sourcePath: string) => {
  for (const { id, sourceDir } of API_SUBTREES) {
    if (sourcePath.startsWith(`${sourceDir}/`)) {
      return {
        subtree: id,
        relPath: sourcePath.slice(sourceDir.length + 1).replace(/(\.d)?\.ts$/, ''),
      };
    }
  }
  return null;
};

export const indexApiModel = (project: JSONOutput.ProjectReflection): ApiIndex => {
  const roots = {
    engine: createFolder('engine', ''),
    toolkit: createFolder('toolkit', ''),
  };
  const folders = new Map<string, ApiFolder>(
    Object.values(roots).map((folder) => [folder.pagePath, folder])
  );
  const getFolder = (subtree: ApiSubtree, relPath: string): ApiFolder => {
    const pagePath = createFolder(subtree, relPath).pagePath;
    const existing = folders.get(pagePath);
    if (existing) return existing;
    const folder = createFolder(subtree, relPath);
    folders.set(pagePath, folder);
    const parentRel = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    getFolder(subtree, parentRel).folders.push(folder);
    return folder;
  };

  const modules: ApiModule[] = [];
  const targets = new Map<number, ApiTarget>();
  const reflections = new Map<number, DeclarationReflection>();
  for (const reflection of project.children ?? []) {
    const sourcePath = reflection.sources?.[0]?.fileName;
    const location = sourcePath ? locateModule(sourcePath) : null;
    if (!sourcePath || !location) continue;
    const symbols = reflection.children ?? [];
    const counted = symbols.filter((symbol) => symbol.kind !== Kind.Reference);
    const module: ApiModule = {
      reflection,
      ...location,
      sourcePath,
      file: path.join(ROOT, sourcePath),
      pagePath: `${API_SECTION_PATH}${location.subtree}/${location.relPath}/`,
      symbols,
      coverage: { documented: counted.filter(isDocumented).length, total: counted.length },
    };
    modules.push(module);
    const dir = location.relPath.includes('/')
      ? location.relPath.slice(0, location.relPath.lastIndexOf('/'))
      : '';
    getFolder(location.subtree, dir).modules.push(module);

    // Anchors: the symbol's name (`#loadScene`), a member's after it (`#ECSWorld.addSystem`).
    // The same name twice in a module (a value and a type) gets `-2`.
    const anchors = new Set<string>();
    const unique = (base: string) => {
      let anchor = base;
      for (let n = 2; anchors.has(anchor); n++) anchor = `${base}-${n}`;
      anchors.add(anchor);
      return anchor;
    };
    for (const symbol of symbols) {
      const anchor = unique(symbol.name);
      targets.set(symbol.id, { module, anchor });
      reflections.set(symbol.id, symbol);
      if (symbol.kind !== Kind.Class && symbol.kind !== Kind.Interface) continue;
      for (const member of getOwnMembers(symbol)) {
        targets.set(member.id, { module, anchor: unique(`${anchor}.${member.name}`) });
        reflections.set(member.id, member);
      }
    }
  }

  // A module with a folder's URL is that folder's page
  for (const module of modules) {
    const folder = folders.get(module.pagePath);
    if (folder) folder.module = module;
  }

  const sumFolder = (folder: ApiFolder): Coverage => {
    for (const module of folder.modules) addCoverage(folder.coverage, module.coverage);
    addCoverage(folder.totalCoverage, folder.coverage);
    for (const child of folder.folders) addCoverage(folder.totalCoverage, sumFolder(child));
    folder.folders.sort((a, b) => a.relPath.localeCompare(b.relPath));
    folder.modules.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return folder.totalCoverage;
  };
  const coverage = { engine: sumFolder(roots.engine), toolkit: sumFolder(roots.toolkit) };
  modules.sort((a, b) => a.pagePath.localeCompare(b.pagePath));

  return { project, modules, roots, folders, targets, reflections, coverage };
};

/** The folders under a subtree, depth first, the subtree's own first */
export const listFolders = (folder: ApiFolder): ApiFolder[] => [
  folder,
  ...folder.folders.flatMap(listFolders),
];
