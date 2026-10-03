import { _getStatsSources, type StatsSource } from '../../../debug/Profiler';
import { lerror } from '../../../utils/Logger';

/**
 * The stats source refcounts (§2.5). The sources themselves are registered in the public
 * `debug/Profiler.ts`, so engine and toolkit code can register one before the profiler loads.
 *
 * A source is acquired while it has holders and is available. Availability is re-checked on every
 * acquire, release and read, so a source that becomes available later (eg. once the renderer
 * exists) is acquired on the next read, and one that stops being available is released.
 */

type AnySource = StatsSource<unknown>;

type SourceState = {
  holders: number;
  /** The source whose `acquire` ran, null while not acquired. */
  acquired: AnySource | null;
};

const states = new Map<string, SourceState>();

const getAvailability = (source: AnySource): true | string => {
  try {
    return source.availability?.() ?? true;
  } catch (err) {
    lerror(`Stats source "${source.id}" availability check failed`, err);
    return 'error';
  }
};

const deactivate = (state: SourceState) => {
  const source = state.acquired;
  if (!source) return;
  state.acquired = null;
  try {
    source.release?.();
  } catch (err) {
    lerror(`Stats source "${source.id}" release failed`, err);
  }
};

/** Acquires or releases the source to match its holders, its availability and the registry. */
const syncState = (id: string, state: SourceState) => {
  const source = _getStatsSources().get(id);
  // Replaced or removed since it was acquired
  if (state.acquired && state.acquired !== source) deactivate(state);
  if (!state.holders || !source || getAvailability(source) !== true) {
    deactivate(state);
    return;
  }
  if (state.acquired) return;
  state.acquired = source;
  try {
    source.acquire?.();
  } catch (err) {
    lerror(`Stats source "${source.id}" acquire failed`, err);
  }
};

/**
 * Takes a hold on a source: the first holder acquires it (when it is available). Pair every call
 * with {@link _releaseStatsSource}. An id that isn't registered yet is held, and acquired once it
 * is registered and read.
 * @param id (string) source id
 */
export const _acquireStatsSource = (id: string) => {
  let state = states.get(id);
  if (!state) {
    state = { holders: 0, acquired: null };
    states.set(id, state);
  }
  state.holders++;
  syncState(id, state);
};

/**
 * Releases a hold; the last holder releases the source.
 * @param id (string) source id
 */
export const _releaseStatsSource = (id: string) => {
  const state = states.get(id);
  if (!state || state.holders === 0) return;
  state.holders--;
  syncState(id, state);
  if (state.holders === 0) states.delete(id);
};

export type StatsReading<T> = { value: T | null; na?: undefined } | { value: null; na: string };

/**
 * Reads a source (at the update rate, never per frame). A held source is acquired first if it
 * has become available. A source without `acquire` (eg. a plain getter) can be read unheld.
 * @param id (string) source id
 * @returns the value (null = no value yet), or why the source is n/a
 */
export const _readStatsSource = <T>(id: string): StatsReading<T> => {
  const source = _getStatsSources().get(id);
  if (!source) return { value: null, na: 'no source' };
  const state = states.get(id);
  if (state) syncState(id, state);
  const availability = getAvailability(source);
  if (availability !== true) return { value: null, na: availability };
  try {
    return { value: source.read() as T | null };
  } catch (err) {
    lerror(`Stats source "${id}" read failed`, err);
    return { value: null, na: 'read failed' };
  }
};

/** Re-checks every held source's availability (eg. after a setting it depends on changed). */
export const _syncStatsSources = () => {
  for (const [id, state] of states) syncState(id, state);
};

/** A source was replaced or removed: a held one moves its hold to the registered one, if any. */
export const _onStatsSourceReplaced = (prev: AnySource) => {
  const state = states.get(prev.id);
  if (state) syncState(prev.id, state);
};

/** Whether a source is acquired now (it has holders and is available). */
export const _isStatsSourceAcquired = (id: string) => Boolean(states.get(id)?.acquired);

/**
 * A set of holds one view keeps (eg. the sources of the Overview's visible rows): `set` acquires
 * the new ids and releases the dropped ones.
 */
export const createStatsSourceHolder = () => {
  const held = new Set<string>();
  const set = (ids: Iterable<string>) => {
    const next = new Set(ids);
    for (const id of held) {
      if (next.has(id)) continue;
      held.delete(id);
      _releaseStatsSource(id);
    }
    for (const id of next) {
      if (held.has(id)) continue;
      held.add(id);
      _acquireStatsSource(id);
    }
  };
  return { set, releaseAll: () => set([]) };
};
