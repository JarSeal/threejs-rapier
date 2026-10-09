import type { JSONOutput } from 'typedoc';
import { getOwnMembers, Kind, type ApiIndex, type ApiTarget } from './model';

/**
 * Links into the API pages (p553 §2.3):
 * - by reflection id: a `{@link}` TypeDoc resolved, a type in a signature. A reflection without
 *   an anchor of its own (a type alias's property, a parameter, a signature) links to its nearest
 *   owner that has one;
 * - by name: `api:` links (`api:loadScene`, `api:SceneLoader.loadScene`,
 *   `api:ECSWorld.addSystem`), and a `{@link}` TypeDoc only resolved to a name in this package.
 *
 * The index is built once per model (`getApiLinks`): it walks the whole model for the owners.
 */

export type ApiNameResult =
  | { isOk: true; target: ApiTarget }
  | { isOk: false; message: string; candidates: string[] };

/**
 * A `{@link}` TypeDoc didn't resolve to a reflection: no target, or another package's symbol
 * (three's), or a name in this package that has none (not exported). With the reflection whose
 * comment has it, and the nearest source position.
 */
export type NamedApiLink = {
  part: JSONOutput.InlineTagDisplayPart;
  ownerId: number;
  /** From the repo root */
  fileName?: string;
  line?: number;
};

export type ApiLinks = {
  /** A reflection's page and anchor: its own, else its nearest owner's */
  resolveId: (id: number) => ApiTarget | undefined;
  /** An `api:` link's name; ambiguous and unknown names say why, with candidates */
  resolveName: (ref: string) => ApiNameResult;
  /** The `{@link}`s without a reflection id */
  namedLinks: NamedApiLink[];
};

type NameEntry = {
  target: ApiTarget;
  /** The symbol's name, or the member's */
  name: string;
  /** Its names from the shortest (`loadScene`) to the longest (`engine/core/SceneLoader.loadScene`) */
  keys: string[];
};

const MAX_SUGGESTIONS = 5;

const isReflection = (value: object): value is { id: number; variant: string } =>
  typeof (value as { id?: unknown }).id === 'number' &&
  typeof (value as { variant?: unknown }).variant === 'string';

type WalkState = { ownerId: number; source?: JSONOutput.SourceReference };

/**
 * Every reflection's owner (the reflection it's nested in: a member's class, a parameter's
 * signature, an object literal type's declaring property), and the `{@link}`s without a
 * reflection id
 */
const walkModel = (project: JSONOutput.ProjectReflection) => {
  const owners = new Map<number, number>();
  const namedLinks: NamedApiLink[] = [];
  const walk = (value: unknown, state: WalkState) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, state);
      return;
    }
    let next = state;
    if (isReflection(value)) {
      if (value.id !== state.ownerId) owners.set(value.id, state.ownerId);
      const sources = (value as { sources?: JSONOutput.SourceReference[] }).sources;
      next = { ownerId: value.id, source: sources?.[0] ?? state.source };
    }
    const part = value as JSONOutput.InlineTagDisplayPart;
    if (part.kind === 'inline-tag') {
      if (part.tag.startsWith('@link') && typeof part.target !== 'number') {
        const { fileName, line } = next.source ?? {};
        namedLinks.push({ part, ownerId: next.ownerId, fileName, line });
      }
      return;
    }
    for (const key in value) walk((value as Record<string, unknown>)[key], next);
  };
  walk(project, { ownerId: project.id });
  return { owners, namedLinks };
};

/** `engine/core/SceneLoader` → `SceneLoader`, `core/SceneLoader`, `engine/core/SceneLoader` */
const modulePathSuffixes = (subtree: string, relPath: string) => {
  const parts = [subtree, ...relPath.split('/')];
  return parts.map((_part, i) => parts.slice(parts.length - 1 - i).join('/'));
};

const buildNameTable = (index: ApiIndex) => {
  const byKey = new Map<string, NameEntry[]>();
  const entries: NameEntry[] = [];
  const add = (target: ApiTarget, name: string, keys: string[]) => {
    const entry: NameEntry = { target, name, keys };
    entries.push(entry);
    for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  };
  for (const module of index.modules) {
    const suffixes = modulePathSuffixes(module.subtree, module.relPath);
    for (const symbol of module.symbols) {
      // A re-export is its original's: its own name would only make that ambiguous
      if (symbol.kind === Kind.Reference) continue;
      const target = index.targets.get(symbol.id);
      if (!target) continue;
      add(target, symbol.name, [
        symbol.name,
        ...suffixes.map((suffix) => `${suffix}.${symbol.name}`),
      ]);
      if (symbol.kind !== Kind.Class && symbol.kind !== Kind.Interface) continue;
      // A member needs its owner's name: `addSystem` alone would match every class's
      for (const member of getOwnMembers(symbol)) {
        const memberTarget = index.targets.get(member.id);
        if (!memberTarget) continue;
        const own = `${symbol.name}.${member.name}`;
        add(memberTarget, member.name, [own, ...suffixes.map((suffix) => `${suffix}.${own}`)]);
      }
    }
  }
  return { byKey, entries };
};

/** The entry's shortest name that names only it */
const shortestKey = (entry: NameEntry, byKey: Map<string, NameEntry[]>) =>
  entry.keys.find((key) => byKey.get(key)?.length === 1) ?? entry.keys[entry.keys.length - 1];

/** Edit distance, capped: anything over `max` is `max + 1` */
const distance = (a: string, b: string, max: number) => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
};

const createLinks = (index: ApiIndex): ApiLinks => {
  const { owners, namedLinks } = walkModel(index.project);
  const { byKey, entries } = buildNameTable(index);

  const resolveId = (id: number) => {
    for (let at: number | undefined = id; at !== undefined; at = owners.get(at)) {
      const target = index.targets.get(at);
      if (target) return target;
    }
    return undefined;
  };

  /** The closest names for an unknown one: same letters in another case, a typo, or a part */
  const suggest = (ref: string) => {
    const name = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
    const max = Math.max(1, Math.floor(name.length / 4));
    return entries
      .map((entry) => {
        const candidate = entry.name.toLowerCase();
        const d = distance(name, candidate, max);
        const score = d <= max ? d : candidate.includes(name) ? max + 1 : Infinity;
        return { entry, score };
      })
      .filter(({ score }) => score < Infinity)
      .sort((a, b) => a.score - b.score || a.entry.name.length - b.entry.name.length)
      .slice(0, MAX_SUGGESTIONS)
      .map(({ entry }) => `api:${shortestKey(entry, byKey)}`);
  };

  const resolveName = (ref: string): ApiNameResult => {
    const found = byKey.get(ref) ?? [];
    if (found.length === 1) return { isOk: true, target: found[0].target };
    if (!found.length) {
      const candidates = suggest(ref);
      return {
        isOk: false,
        message: `Unknown api:${ref}${candidates.length ? ` (did you mean ${candidates.join(', ')}?)` : ': no symbol of that name'}`,
        candidates,
      };
    }
    // A value and a type of the same name in one module (`ComponentType`): the one whose anchor
    // is the bare name
    const [first] = found;
    if (found.every((entry) => entry.target.module === first.target.module)) {
      return { isOk: true, target: first.target };
    }
    const candidates = found.map((entry) => `api:${shortestKey(entry, byKey)}`);
    return {
      isOk: false,
      message: `Ambiguous api:${ref}: ${candidates.join(', ')}`,
      candidates,
    };
  };

  return { resolveId, resolveName, namedLinks };
};

const cache = new WeakMap<ApiIndex, ApiLinks>();

/** The links of an index, built on its first use */
export const getApiLinks = (index: ApiIndex) => {
  let links = cache.get(index);
  if (!links) cache.set(index, (links = createLinks(index)));
  return links;
};
