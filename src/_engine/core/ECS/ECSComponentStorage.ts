/**
 * Build-time-selectable backend for `ECSWorld`'s per-component-type
 * storages. `MAP` (the default) uses a plain `Map`; `TYPED_ARRAY` currently
 * only applies to the TRANSFORM component (see TypedArrayTransformStore) —
 * every other component type stays `Map`-backed regardless of this setting.
 * Selected once at boot; not dynamic (see docs/plans/ecs-typed-arrays-feature.md).
 */
export type ECSStorageMode = 'MAP' | 'TYPED_ARRAY';

export interface ECSStorageLSOverride {
  storageMode?: ECSStorageMode;
  maxEntities?: number;
}

/** LocalStorage key for ECS debug-tab dev-only overrides (IS_DEBUG_ENV only, reload-on-change). */
export const ECS_LS_KEY = 'AEK_ecs';

/**
 * Minimal storage-backend contract for `ECSWorld`'s per-component-type
 * storages. A plain `Map<number, T>` already satisfies this shape natively
 * (get/set/delete/has/clear/size/keys/entries/Symbol.iterator), so today's
 * `Map`-based storages require no wrapper to conform. Other backends (e.g.
 * a TypedArray-backed sparse set) can implement this interface directly.
 */
export interface IComponentStorage<T> extends Iterable<[number, T]> {
  get(entityId: number): T | undefined;
  set(entityId: number, value: T): void;
  delete(entityId: number): boolean;
  has(entityId: number): boolean;
  clear(): void;
  readonly size: number;
  keys(): IterableIterator<number>;
  entries(): IterableIterator<[number, T]>;
}
