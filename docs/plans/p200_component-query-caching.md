Status: draft | research — not-implemented
Category: ECS
Epic: https://trello.com/c/EQQXOyRL/105-ecs-entity-component-system

# Component Query Caching — Research & Recommendation

Investigates whether `getEntitiesWith`/`getStorage` queries are worth caching, in
particular for per-frame systems like `object3DSyncSystem`. Concludes a general
compound-query cache isn't warranted given the current and planned architecture, but
identifies and specs one small, concrete win: caching the "main camera" singleton-tag
lookup.

---

## 1. Goal

Determine whether ECS component queries — specifically `world.getEntitiesWith(type)`
and `world.getStorage(type)` (`ECS.ts:792-794`, `549-560`) — are a real performance cost
worth caching, using `object3DSyncSystem` as the motivating example, and whether the
answer changes for the planned engine-agnostic/worker-threaded Physics API. Along the
way, flag any other small, concrete caching opportunities found in the systems that use
these queries every frame.

## 2. Current state (grounded in the actual code)

### 2.1 The query API is already a direct, partitioned lookup — not a scan

`ECS.ts` partitions component data into one storage per `ComponentType` up front
(`private storages: Map<ComponentType, IComponentStorage<any>> = new Map();`,
`ECS.ts:235`, pre-populated for every type at construction, `ECS.ts:280-291`). Default
backing is a plain JS `Map<number, T>` (`ECS.ts:289`); `TRANSFORM` alone can use a
typed-array-backed `TypedArrayTransformStore` when `storageMode === 'TYPED_ARRAY'`
(`ECS.ts:283-288`).

```ts
// ECS.ts:792-794
public getEntitiesWith(type: ComponentType): IterableIterator<number> {
  return this.storages.get(type)!.keys();
}
```

```ts
// ECS.ts:549-560
public getStorage<K extends ComponentType>(type: K): IComponentStorage<ComponentData[K]> {
  let storage = this.storages.get(type);
  if (!storage) {
    storage = new Map();
    this.storages.set(type, storage);
  }
  return storage;
}
```

Neither method filters or scans anything beyond the one component type's own storage —
membership is storage presence, not a bitmask test over all entities. `Map.get/has/set`
are O(1); `Map.keys().next().value` (used by the singleton-tag lookups below) does not
walk the map, it returns the next entry directly. **There is no hidden linear cost here
to cache away.**

### 2.2 No system actually builds a multi-component intersection set today

Grepped every call site of `getEntitiesWith`/`getStorage` across `src/_engine`,
`src/toolkit`, `src/app` (none in `src/app`). Systems that care about more than one
component type do it like this:

```ts
// LightFrustumCullingSystem.ts:59-91 (abridged)
export const lightFrustumCullingSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.FRUSTUM_CULLING_ENABLED);
  if (storage.size === 0) return; // nothing opted in — skip entirely
  const camera = getMainCamera();
  if (!camera) return;
  for (const [entityId] of storage) {
    if (world.isDisabled(entityId)) continue;
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    // ...O(1) per-entity checks, not a second query...
  }
};
```

```ts
// _dbg__Symbols.ts:93-126 (abridged) — debugSymbolSyncSystem
const storage = w.getStorage(ComponentType.DEBUG_SYMBOL);
for (const [entityId, symbolComp] of storage) {
  const objComp = w.getComponent(entityId, ComponentType.OBJECT3D);
  const isLight = w.hasComponent(entityId, ComponentType.TAG_IS_LIGHT);
  // ...
}
```

Both iterate one (already small) component storage, then do O(1) `hasComponent`/
`getComponent` lookups per entity for the other conditions. This is already the cheap
path — a cached "intersection set" wouldn't remove any of this per-entity work (the
frustum test, the tint check, the transform copy are the actual cost, and must be
recomputed every frame regardless of how the entity set is obtained).

The only place two `getEntitiesWith` calls are combined is `autoAttachSymbols`
(`_dbg__Symbols.ts:56-59`), which unions `TAG_IS_LIGHT` and `TAG_IS_CAMERA` — and it's a
one-off run at plugin registration/scene setup, not a per-frame call.

`object3DSyncSystem` itself (`ECSCoreSystems.ts:136-172`) queries exactly one component
type (`OBJECT3D`) and already has its own dirty-tracking (typed-array `dirtyFlags` via
`TypedArrayTransformStore.isDirty`/`clearDirty`, or the `Transform.version`/
`objComp._lastVersion` fallback) to skip per-entity work for unchanged transforms. There
is nothing about its *query* to cache — the storage it iterates already contains exactly
the entities that match, nothing more.

### 2.3 Does the planned Physics API change this? No.

CLAUDE.md's Physics section describes a future engine-agnostic, optionally
worker-threaded Physics API, currently sketched as commented-out code
(`PhysicsAPI.ts`, entirely commented out; `src/_engine/workers/physicsWorker.ts` and
`src/_engine/workers/physics/*.ts`, disabled). Checked whether this future design would
need a multi-component compound-query cache:

- `PhysicsAPI.ts` (3651 lines, fully commented out) and the active
  `PhysicsRapier.ts` never query ECS component storages for bulk entity sets — both
  maintain their own separate `physicsObjects`/`currentScenePhysicsObjects` registries
  (`PhysicsAPI.ts:181-182`, `PhysicsRapier.ts:325,330`) and iterate those arrays
  directly. `PhysicsRapier.ts`'s only ECS touchpoints are a handful of lines inside
  `deletePhysicsObject` (`PhysicsRapier.ts:1231-1239`) that delete one specific entity
  by id — not a query.
- The one real per-frame ECS query in the physics-sync path,
  `physicsToTransformSystem` (`ECSCoreSystems.ts:178-203`), uses a single
  `getStorage(ComponentType.BODY_DYNAMIC_VISUAL)` call. It needs no AND with `TRANSFORM`
  because every entity gets `TRANSFORM` unconditionally in `createEntity`
  (`ECS.ts:449`).
- The commented-out `createPhysicsEntity` sketch (`ECSCoreComponents.ts:135-206`,
  bucket-sort at `:194-203`) deliberately assigns each physics entity to exactly one of
  three mutually-exclusive component buckets (`BODY_STATIC` / `BODY_DYNAMIC_VISUAL` /
  `BODY_DYNAMIC_HEADLESS`) specifically so downstream systems only ever need one
  `getStorage()` call, never an intersection.
- The worker RPC scaffolding (`physicsSwitchRigid.ts`, `physicsSwitchColl.ts`,
  `physicsSwitchWorld.ts`) is a per-object-id `postMessage`/`requestId` protocol
  (resolve one `rigidBodyId`/`colliderId`, call one method) — it never reads ECS
  storages at all, let alone more than one simultaneously.
- `docs/plans/_DONE_ecs-typed-arrays-feature.md:210-223` frames the future
  `SharedArrayBuffer` design purely around transferring transform *values* for
  already-known entities via the existing single-component `BODY_DYNAMIC_VISUAL`
  bucket — never around deriving/caching which entities satisfy a component
  conjunction. `docs/plans/_DONE_ecs-multiple-worlds.md:374` and
  `docs/plans/p050_spatial-index.md:14` (Rapier broadphase only knows entities with the
  single `TAG_IS_PHYSICS_OBJECT` tag) corroborate the same single-component-type
  pattern.

**Verdict: no current or planned system in this codebase needs a multi-component
compound-query cache.** Building one now would be speculative infrastructure with no
caller — explicitly against CLAUDE.md's "don't design for hypothetical future
requirements." This idea is dropped, not deferred as a spec — if a real multi-component
hot path appears later, design it against that system's actual shape rather than a
guess made here.

### 2.4 The one concrete win found: the main-camera singleton-tag lookup

`CameraManager.ts` re-derives "which entity is the main camera" from a live query, every
time it's asked, instead of caching it — even though `CameraManager.ts` already caches
an analogous pointer elsewhere:

```ts
// CameraManager.ts:21-22 — existing precedent for exactly this kind of cache
let activeCameraEntityId: number | null = null;
let activeCameraObject: THREE.Camera | null = null;
```

```ts
// CameraManager.ts:226-231
export const getMainCamera = (): THREE.Camera | undefined => {
  const world = getECSWorld();
  const mainCamId = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA).next().value;
  if (mainCamId === undefined) return undefined;
  return world.getComponent(mainCamId, ComponentType.OBJECT3D)?.value as THREE.Camera | undefined;
};
```

```ts
// CameraManager.ts:321-329 — getMainAppCameraId, same query pattern
```

`getMainCamera()` is called every frame from `lightFrustumCullingSystem`
(`LightFrustumCullingSystem.ts:66`, deliberately using `getMainCamera()` and not
`getActiveCamera()` so culling isn't affected by the debug fly-camera — see
`LightFrustumCullingSystem.ts:63-65`). Each call allocates a throwaway `Map` iterator
object just to read one value. This is a minor GC-pressure cost (not an algorithmic
one), but it's real, it's on a per-frame path, and it's essentially free to fix given
`TAG_IS_MAIN_CAMERA` already only ever changes in one place:

```ts
// CameraManager.ts:344-353 — the ONLY add/remove site for TAG_IS_MAIN_CAMERA
export const setMainCamera = (world: ECSWorld, newMainId: number) => {
  const mainCams = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA);
  for (const oldId of mainCams) {
    world.removeComponent(oldId, ComponentType.TAG_IS_MAIN_CAMERA);
  }
  world.addComponent(newMainId, ComponentType.TAG_IS_MAIN_CAMERA, true);
  if (!isDebugCameraActive()) setActiveCamera(newMainId);
};
```

Confirmed via `grep -rn "TAG_IS_MAIN_CAMERA" src` that `addComponent`/`removeComponent`
for this tag happen *only* at `CameraManager.ts:347` and `:349` — every camera-creation
path (`createCamera`, `CameraManager.ts:172-180`) routes through `setMainCamera` too, so
there is exactly one place that needs to update a cache.

## 3. Proposed design: cache the main-camera singleton lookup

Add a module-scope cache in `CameraManager.ts`, following the exact existing pattern of
`activeCameraEntityId`/`activeCameraObject`:

```ts
let mainCameraEntityId: number | null = null;
let mainCameraObject: THREE.Camera | null = null;
```

- **`setMainCamera`** sets `mainCameraEntityId = newMainId` and
  `mainCameraObject = world.getComponent(newMainId, ComponentType.OBJECT3D)?.value ?? null`
  directly, right after `world.addComponent(newMainId, ComponentType.TAG_IS_MAIN_CAMERA, true)`
  — guarded on `world === getECSWorld()` (see §7) so a non-default-world call doesn't
  clobber the default-world-scoped cache. This is the only "add" path, so this alone
  keeps the cache correct for every normal flow (initial camera creation,
  `setCurrentCamera`, explicit `active: true` cameras).
- **`getMainCamera()`** and **`getMainAppCameraId()`** read `mainCameraEntityId`/
  `mainCameraObject` directly instead of calling `getEntitiesWith(...).next().value`.
- **Deletion safety net:** register a component hook so a main camera entity deleted
  through any other path (e.g. `disposeCamera`, or scene teardown) still invalidates the
  cache, instead of leaving a dangling id:

  ```ts
  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_MAIN_CAMERA, {
    onDeleteEntity: (entityId, world) => {
      // Guard against cross-world id collisions: entity ids are only unique within
      // a single ECSWorld's packed-id space, and getMainCamera()/getMainAppCameraId()
      // only ever read the default world (see "Risks" below) — so only react to
      // deletions in that same world.
      if (world === getECSWorld() && entityId === mainCameraEntityId) {
        mainCameraEntityId = null;
        mainCameraObject = null;
      }
    },
  });
  ```

No config flag/toggle is added — invalidation is exact (driven directly by the single
mutation site plus the deletion hook), so there is no correctness scenario where
disabling the cache would help, and CLAUDE.md's "don't add config surface without a
reason" applies.

## 4. Files touched

- `src/_engine/core/CameraManager.ts` — add `mainCameraEntityId`/`mainCameraObject`
  module state; update `setMainCamera` to set them; update `getMainCamera`/
  `getMainAppCameraId` to read them; register the `onDeleteEntity` safety-net hook.

No other files change. No new component types, no new debug GUI, no schema changes.

## 5. Non-goals (explicitly out of scope)

- A general multi-component compound-query cache / `getEntitiesWithAll`-style API —
  investigated and dropped per §2.3/§2.4, not deferred as a spec (nothing currently
  justifies its shape).
- Any change to `object3DSyncSystem`, `getEntitiesWith`, or `getStorage` themselves —
  they're already optimal for what they do (§2.1).
- Extending the same singleton-cache treatment to `DEBUG_TAG_IS_DEBUG_CAMERA` or other
  tags — checked, and the only other `TAG_IS_MAIN_CAMERA`/debug-camera lookups
  (`_dbg__DebugCamera.ts:85`, `SceneLoader.ts:472`) are one-off (toggle/scene-load), not
  per-frame, so caching them has no measurable benefit.

## 6. Phased rollout

Small enough to be a single, non-breaking phase:

- **Phase 1 (only phase):** Add the `mainCameraEntityId`/`mainCameraObject` cache,
  update the three call sites, add the deletion-safety hook. Zero behavior change from
  the caller's perspective — `getMainCamera()`/`getMainAppCameraId()` return identical
  results, just without re-deriving them from a live query.
  - **Manual verification:** run the app with a scene that has multiple cameras
    (`?isDebug=true`), switch the main camera at runtime (e.g. via the camera debug GUI
    or `setCurrentCamera`), and confirm `getMainCamera()`-driven behavior (light frustum
    culling's camera-relative test, the main-camera indicator symbol in
    `_dbg__Symbols.ts:122-125`) still tracks the new main camera correctly. Also verify
    deleting the current main camera entity (via `disposeCamera` or scene teardown)
    doesn't leave `getMainCamera()` returning a stale/disposed camera.

## 7. Risks and open questions

| Risk / question | Notes |
|---|---|
| Cross-world entity id collision in the deletion hook | `ComponentHook`s are registered statically and fire for *every* `ECSWorld` (`ECS.ts:117-119`), but `getMainCamera()`/`getMainAppCameraId()` only ever read the default world (`getECSWorld()` with no id arg). Mitigated by the `world === getECSWorld()` guard in the hook (§3) — matches the existing implicit default-world-only limitation of these two functions, doesn't introduce a new one. |
| `setMainCamera` called for a non-default world | Already an existing asymmetry (`setMainCamera` takes an explicit `world` param; `getMainCamera`/`getMainAppCameraId` don't) — out of scope to fix here; the cache update in `setMainCamera` also guards on `world === getECSWorld()` so it doesn't cache a non-default world's camera under the default-world-scoped cache variables. |
| Value of this fix is small | This is a minor GC-pressure/micro-optimization, not an algorithmic win — flagged as such rather than oversold. Justified mainly because it was found while investigating the original ask and costs almost nothing to fix correctly. |

## 8. Recommendation

Do not build a general compound-query cache — nothing in the current or planned
architecture needs one, and the existing single-component-type storage design is
already close to optimal for every query pattern actually used. Ship the small
main-camera singleton-cache fix (§3) as the concrete, grounded outcome of this
investigation.
