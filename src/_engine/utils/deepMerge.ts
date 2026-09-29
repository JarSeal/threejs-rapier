// No imports: the data pipeline (devTools/gatherAppData.ts, run in Node) uses this too.

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Returns `target` with `source` merged over it, without mutating either. Plain objects merge
 * key by key (and are copied); anything else, including arrays and class instances such as
 * textures, replaces the target's value as is. `undefined` values in `source` are skipped.
 */
export const deepMerge = <T>(target: T, source: unknown): T => {
  if (source === undefined) return (isPlainObject(target) ? deepMerge(target, {}) : target) as T;
  if (!isPlainObject(source)) return source as T;
  const result: Record<string, unknown> = {};
  if (isPlainObject(target)) {
    for (const key of Object.keys(target)) result[key] = deepMerge(target[key], undefined);
  }
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) result[key] = deepMerge(result[key], source[key]);
  }
  return result as T;
};
