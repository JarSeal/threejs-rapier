Status: draft | not-implemented

# ECS Component Storage: Maps vs TypedArrays — Plan

A build-time-selectable storage backend for ECS component data — `Map`-based (today's default) or `TypedArray`-based — starting with `Transform`, the one component every visual entity has and the hottest per-frame data in the engine.

---

## 1. Goal

`ECSWorld` currently stores every component type in a JS `Map<entityId, data>` (`src/_engine/core/ECS.ts`, `storages: Map<ComponentType, Map<number, any>>`). That's simple and flexible, but for `Transform` specifically it means, per entity: one `Transform` class instance + one `THREE.Vector3` (position) + one `THREE.Quaternion` + one `THREE.Vector3` (scale) — four heap objects, scattered in memory, inside a hash map. At high entity counts this costs GC pressure and cache locality.

The goal is an opt-in `TypedArray`-backed storage path for `Transform` that keeps data as flat, contiguous `Float32Array`s indexed by a dense entity slot, selected once at build/boot time via a setting (dev-toggleable from the new ECS debug tab, authoritative default in `CONFIG.ts`). Not dynamic — per the request, switching requires a page refresh, and a given running build only ever uses one backend.

**Non-goals for this plan** (scoped out per discussion — see §8): rewiring physics→ECS transform sync, extending TypedArray storage to other component types, implementing the worker-threaded Physics API, or using `SharedArrayBuffer` in the first phase. These are called out explicitly so the design doesn't paint itself into a corner, but none of them are being built now.

---

## 2. Current state (grounded in the actual code)

### 2.1 Entity IDs are packed, not raw array indices

`src/_engine/core/ECS.ts` (`ECSWorld`) packs each entity id as `(generation << 20) | index`, with a 20-bit index (~1,048,576 slots) and 12-bit generation:

```ts
private readonly INDEX_MASK = 0xfffff;
private readonly GEN_SHIFT = 20;
private generations = new Uint32Array(1048576);

private _getIndex(id: number): number { return id & this.INDEX_MASK; }
private _getGeneration(id: number): number { return id >>> this.GEN_SHIFT; }
private _pack(index: number, gen: number): number { return ((gen & 0xfff) << this.GEN_SHIFT) | (index & this.INDEX_MASK); }
```

The **index** portion is dense, stable, and reused via a free-list (`freeIds`) on `deleteEntity` — exactly what a TypedArray offset needs. The **packed id** (what every public API actually passes around) is not usable as an array offset directly. `_getIndex`/`_getGeneration`/`_pack` are `private` today; a TypedArray storage needs the index, so it needs one of these exposed (see §5.1).

### 2.2 Component storage today

```ts
// Storage: Map<Type, Map<EntityID, Data>>
private storages: Map<ComponentType, Map<number, any>> = new Map();
```

Built in the constructor by iterating every `ComponentType` (34 core types in `src/_engine/core/ECS/ECSRegistry.ts`, plus whatever `src/AppECSRegistry.ts`'s `AppComponentType` adds) and creating an empty `Map` for each. CRUD is:

```ts
addComponent<K>(entityId, type, data) { storage.set(entityId, data); /* + hooks */ }
removeComponent(entityId, type)      { storage.delete(entityId); /* + hooks */ }
getComponent<K>(entityId, type)      { return storage.get(entityId); }
hasComponent(entityId, type)         { return storage.has(entityId); }
getStorage<K>(type)                  { return storage; } // raw Map, for iteration
```

There's no archetype/bitmask query system — systems iterate a single storage's `Map` via `getStorage(type)` and call `getComponent`/`hasComponent` again per additional required component. That matters here: it means a new storage backend only has to satisfy `get`/`set`/`delete`/`has`/iteration for the handful of call sites that touch it directly, not some larger query engine.

### 2.3 `Transform` shape (`src/_engine/core/ECS/ECSCoreComponents.ts`)

```ts
export class Transform {
  readonly position = new THREE.Vector3(0, 0, 0);
  readonly quaternion = new THREE.Quaternion(0, 0, 0, 1);
  readonly scale = new THREE.Vector3(1, 1, 1);
  version = 0;
  setDirty() {
    this.version++;
  }
  copy(other: Transform) {
    /* copies + setDirty */
  }
}
```

10 floats (3+4+3) per entity, spread across 4 objects, with a manual `version` counter used as the dirty flag by the sync systems below. This dirty-flag pattern must be preserved by any replacement.

### 2.4 Where Transform is read/written today

Four systems touch it, all registered in `src/_engine/core/ECS/ECSCoreSystems.ts`:

- **`object3DSyncSystem`** (`MAIN` stage) — iterates the `OBJECT3D` storage, reads each entity's `TRANSFORM`, and if `transform.version !== objComp._lastVersion`, copies position/quaternion/scale into the `Object3D`. This is the real ECS→mesh sync path, dirty-gated.
- **`lookAtSystem`** (`APP_RENDER_SYNC`) — reads two `TRANSFORM`s (self + `TARGET_LINK.targetId`), writes into `Object3D.quaternion` and back into the entity's own `Transform.quaternion`, calls `setDirty()`.
- **`physicsToTransformSystem`** (`APP_POST_PHYSICS`) — reads `BODY_DYNAMIC_VISUAL` (typed as `RigidBodyAPI`, with a hot-path `pos`/`rot`) and writes into `TRANSFORM`. **This system is currently dead code**: `BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS`/`BODY_STATIC` are never populated anywhere active — the only writer is a fully commented-out `createPhysicsEntity` function in the same file. It runs every frame over an always-empty `Map`.
- `ECSWorld`'s own transform-setter code (`ECS.ts`, ~L342-358) — has a `// Update Physics (Worker or Main thread)` comment next to where it calls `rb.setTranslation/setRotation` on whatever `getRigidBody(entityId)` returns — same "typed for a future that isn't wired up yet" status.

**The live physics→mesh path bypasses ECS entirely.** `src/_engine/core/PhysicsRapier.ts` maintains its own `currentScenePhysicsObjects: PhysicsObject[]` array plus two side-table `Map<rigidBodyHandle, {pos: THREE.Vector3, rot: THREE.Quaternion}>` caches (`prevTransforms`/`currTransforms`) for interpolation, and `renderPhysicsObjects()` writes straight into `mesh.position`/`mesh.quaternion` — never touching `TRANSFORM` or `OBJECT3D`. This is the file's own doc-comment on `stepPhysicsWorld`: _"sets mesh positions and rotations in the current scene."_

So today, TypedArray `Transform` storage would benefit `object3DSyncSystem`/`lookAtSystem` (non-physics, kinematic, or scripted entities) immediately. It would _not_ automatically speed up physics-driven objects, because those don't go through ECS `Transform` at all right now — reconciling that is explicitly out of scope here (§8) and belongs to the future Physics API work CLAUDE.md already earmarks as a separate initiative.

### 2.5 No existing precedent

Confirmed by grep: zero uses of `TypedArray`/`Float32Array`-as-component-storage, `SharedArrayBuffer`, `ArrayBuffer`, or `Proxy` anywhere in `src/_engine/` today (the `Float32Array` hits that do exist are physics geometry buffers and Three.js shader attributes, unrelated). This is a greenfield addition, not an extension of a partial implementation — despite a few comments (`AppECSRegistry.ts`: `// physicsToTransform (Syncing SAB to ECS)`, `ECSCoreSystems.ts`: `// Direct SAB access from your Physics Proxy`) that make clear a `SharedArrayBuffer`-backed design was _intended_ for the physics integration, just never built.

---

## 3. Key decision: proxying vs. direct access

Two ways to back `Transform` with a `Float32Array` while keeping some kind of per-entity "object" ergonomics:

- **Proxy-per-entity**: `new Proxy({}, handler)` where `get`/`set` traps translate `.x`/`.y`/`.z` into indexed reads/writes on the backing array.
- **Direct/flat access**: systems operate on `(store, index)` pairs via plain functions/methods — no per-entity object at all for the hot path.

**Recommendation: direct/flat access, no `Proxy`.** Reasons:

1. **Performance.** V8's `Proxy` trap dispatch is meaningfully slower than direct property or indexed-array access — it defeats a large fraction of what a `Float32Array` is bought for. Iterating thousands of entities through a `Proxy` per field access reintroduces the exact overhead this feature exists to remove.
2. **Allocation.** A fresh `Proxy` wrapper per `getComponent` call still allocates an object, which undercuts the GC-pressure win unless the wrapper is pooled/cached — and a pooled/reused wrapper is itself extra bookkeeping for no benefit over just calling a function with an index.
3. **Not shareable across threads.** This matters because of the planned worker-based Physics API (§7): a `Proxy` object cannot cross a `postMessage`/`SharedArrayBuffer` boundary — only the underlying buffer can. Each realm (main thread, worker) would need to reconstruct its own `Proxy` locally anyway, so a `Proxy` provides zero cross-thread benefit and only adds main-thread cost.
4. **Existing systems already do explicit method calls** (`transform.position.copy(...)`, `.setDirty()`), not casual property chains — so there's little ergonomic loss moving to `TransformStore.copyPositionTo(index, out)`-style helpers instead of `.position.x` access. The rewrite surface is small and enumerable (§6).

Concretely: the `TypedArray` `Transform` store exposes a small set of index-based helper functions (`setPosition(idx, x, y, z)`, `copyPositionTo(idx, THREE.Vector3)`, `copyQuaternionToObject3D(idx, object3D)`, etc.) rather than per-entity wrapper objects, and the handful of hot systems in `ECSCoreSystems.ts`/`ECS.ts` that touch `Transform` are updated to call them directly when `TYPED_ARRAY` mode is active.

For **cold paths** — app/toolkit code, debug tooling, anything that isn't a per-frame system — `getComponent(entityId, TRANSFORM)` still returns a materialized, `Transform`-shaped compatibility object (real `THREE.Vector3`/`Quaternion`, built by copying out of the flat arrays on that call). This keeps the existing public `ECSWorld` API working unchanged for casual/app-level callers, at the cost of an allocation per call — acceptable off the hot path, explicitly documented as such so nobody mistakes it for the fast path.

---

## 4. Key decision: is keeping `Map` as an option actually worth it?

**Yes — `Map` should stay the default, with `TypedArray` as an explicit opt-in.** Reasons:

1. **Most component types can't be TypedArray-backed at all.** Of the 34 core `ComponentType`s, most hold non-numeric or heterogeneous data — `Object3D` refs, tag/boolean markers, `Record<string, unknown>` user data, debug metadata. `Map` remains mandatory for these regardless of the ECS-wide "mode" setting; there's no world where everything becomes a flat array.
2. **`Map` needs no capacity planning.** `TypedArray`s require a fixed, pre-allocated entity budget (§5.2) decided up front. For prototyping, small/medium scenes, and most app-level custom components a developer adds via `AppComponentType`, that rigidity buys nothing.
3. **`Map` is objectively simpler to work with** for anyone writing app/toolkit code who isn't hand-optimizing a hot loop — `.position.copy(...)` beats index arithmetic for casual use, and V8's `Map` is already quite fast for small-to-medium entity counts.
4. **The `TypedArray` path adds real, ongoing complexity**: sparse-set bookkeeping, a capacity ceiling, a second API surface (index-based helpers) alongside the compatibility object, and later cross-thread/`SharedArrayBuffer` nuances. That's only worth carrying once entity counts are large enough that GC pressure or cache misses are a _measured_ bottleneck — this is squarely a "make the ceiling higher" feature, not a "make everything faster by default" one.

So the answer to "is there no point in keeping Map" is: there's a clear point — it's the right choice for most component types and most project sizes, and should stay the default. `TypedArray` is for projects that specifically need to push entity counts higher than `Map`-based `Transform` storage comfortably allows.

---

## 5. Architecture

### 5.1 Storage abstraction

Introduce a minimal shared interface so `ECSWorld`'s `addComponent`/`getComponent`/`removeComponent`/`hasComponent`/`getStorage` keep working unchanged regardless of backend:

```ts
// src/_engine/core/ECS/ComponentStorage.ts (new)
export interface IComponentStorage<T> {
  get(entityId: number): T | undefined;
  set(entityId: number, value: T): void;
  delete(entityId: number): boolean;
  has(entityId: number): boolean;
  keys(): IterableIterator<number>;
  entries(): IterableIterator<[number, T]>;
}
```

A plain `Map<number, T>` already satisfies this shape (no changes needed there). `storages` in `ECS.ts` becomes `Map<ComponentType, IComponentStorage<any>>`; `getStorage<K>`'s return type changes from `Map<number, ComponentData[K]>` to `IComponentStorage<ComponentData[K]>` — the one real typing change existing call sites need to accommodate (e.g. `object3DSyncSystem`'s `for (const [entityId, objComp] of storage)` — `entries()` covers this; direct `for...of` on the interface itself also works since it's iterable via `entries`).

`ECSWorld`'s constructor needs `_getIndex` exposed for storage implementations to use — add a narrow, documented method (e.g. `getEntityIndex(entityId: number): number`) rather than making the private helper public outright, keeping the packed-id abstraction otherwise opaque to external code.

### 5.2 `TypedArrayTransformStore` — a sparse set over flat `Float32Array`s

Because entity indices are reused (generation-based free-list) and not every entity has a `Transform`, a flat array alone can't answer "does this entity have this component" or iterate cleanly — the standard solution is a **sparse set**, the same technique used by high-performance JS/C++ ECS implementations:

```
sparse: Int32Array(maxEntities)   // sparse[entityIndex] -> dense slot, or -1 if absent
dense:  Uint32Array(maxEntities)  // dense[denseSlot]     -> entityIndex
posX/posY/posZ, qx/qy/qz/qw, scaleX/scaleY/scaleZ: Float32Array(maxEntities)  // indexed by dense slot
dirty:  Uint8Array(maxEntities)   // parallel dirty flags, replaces Transform.version per-entity
count:  number                    // live entry count
```

- **Insert** (`set`): `denseSlot = count++`; `sparse[entityIndex] = denseSlot`; `dense[denseSlot] = entityIndex`; write fields at `denseSlot`.
- **Remove** (`delete`): swap-remove — move the last dense entry into the removed slot, update `sparse` for the moved entity, decrement `count`. No gaps, `O(1)`.
- **Lookup** (`get`/`has`): `entityIndex = getEntityIndex(entityId)`; `denseSlot = sparse[entityIndex]`; `-1` means absent.
- **Iteration**: `for (let i = 0; i < count; i++) { const entityIndex = dense[i]; /* fields at i */ }` — fully dense, cache-friendly, no skipped slots.

This directly replaces the object-per-entity `Transform`/`Vector3`/`Quaternion` allocation with flat numeric storage, and the swap-remove sparse set means iteration cost scales with _live_ entity count, not allocated capacity.

**Dirty tracking**: replace `Transform.version`/`objComp._lastVersion` with the `dirty: Uint8Array` above, set on any write, cleared by `object3DSyncSystem` after syncing into the `Object3D`. Same semantics, array-backed instead of a counter on a class instance.

**Buffer layout**: allocate one contiguous `ArrayBuffer` sized `maxEntities * strideFloats * 4` bytes and carve the `Float32Array` views out of it with offsets, rather than separate independent `Float32Array` allocations — this is what makes the `ArrayBuffer → SharedArrayBuffer` swap in §7 a one-line change later (same layout, different buffer constructor).

### 5.3 Capacity

`maxEntities` is a **fixed, pre-allocated capacity** — required because `TypedArray`s can't grow. Default **100,000**, configurable via `CONFIG.ecs.maxEntities` (see §6) — chosen well below the existing 1,048,576-slot index ceiling (`ECS.ts`'s `generations` table) to keep the default memory footprint reasonable (100,000 × 10 floats × 4 bytes ≈ 4 MB for `Transform`, vs. ~40 MB+ at the full index ceiling) while still comfortably covering "large number of entities" scenes.

Exceeding `maxEntities`: **throw a clear error** by default (`"TransformStore capacity (N) exceeded — raise CONFIG.ecs.maxEntities"`), forcing an explicit config bump rather than silently degrading or stalling a frame on a resize. A grow-and-copy fallback is a plausible later refinement but adds real complexity (a mid-frame reallocation + copy is itself a perf cliff) — noted as an open question (§11), not built now.

---

## 6. Settings: where the mode is decided

Two layers, mirroring two patterns that already exist in this codebase:

1. **Authoritative default — `CONFIG.ts`.** Add to `AppConfig` (`src/_engine/core/Config.ts`), alongside the existing `physics` sub-object:

   ```ts
   ecs?: {
     storageMode?: 'MAP' | 'TYPED_ARRAY'; // default 'MAP'
     maxEntities?: number;                // default 100_000, only relevant in TYPED_ARRAY mode
   };
   ```

   Plus `VITE_ECS_STORAGE_MODE`/`VITE_ECS_MAX_ENTITIES` env var overrides in `loadConfig()`, following the exact pattern already used for `VITE_PHYS_ENABLED`/`VITE_PHYS_TIMESTEP` (string → typed value, assigned onto `config.ecs`). This is what actually ships in production — it's source-controlled, present in prod builds, and read once at boot.

2. **Local dev override — the ECS debug tab.** `IS_DEBUG_ENV`-only, for a developer to flip modes locally without editing `CONFIG.ts`, exactly like the existing Stats tab's `trackGPU`/`horizontal`/etc. toggles (`src/_engine/core/Debug/_dbg__Stats.ts`, `AEK_debugStats` key, `.on('change', () => { lsSetItem(...); location.reload(); })`). Concretely:

   - Upgrade `src/_engine/core/Debug/_dbg__ECS.ts` (currently a bare `createNewDebuggerContainer` + "Hello world" text — see the skeleton added earlier this session) from a plain container to `createNewDebuggerPane` (which returns `{ container, debugGUI: Pane }`, same as Stats).
   - Add a `LS_KEY = 'AEK_ecsStorageMode'`, a Tweakpane `'list'` binding offering `MAP`/`TYPED_ARRAY`, and (in `TYPED_ARRAY` mode) a numeric binding for a local `maxEntities` override. Both call `lsSetItem` + `location.reload()` on change, in a folder titled to signal the reload the same way Stats does ("...(reloads the app)").
   - Also a good place for read-only live stats once the store exists (current `count` vs `maxEntities`) — noted as a natural follow-up, not required for the mode-selection mechanism itself.

   Read order at boot, before `initECSWorld()` is called in `InitApp.ts`: env var override → `CONFIG.ts` default → (only if `IS_DEBUG_ENV`) localStorage override on top. `initECSWorld()` (`src/_engine/core/ECS.ts`) changes from `new ECSWorld()` to `new ECSWorld(storageMode, maxEntities)`, threading the resolved choice into the constructor so it can decide, per `ComponentType`, whether `TRANSFORM` gets a `Map` or a `TypedArrayTransformStore` — every other `ComponentType` stays `Map` regardless (§4, §8).

   Note the asymmetry this creates on purpose: the debug-tab toggle only exists in debug builds (tree-shaken out of production per the dual-layer pattern), so it can only ever override what a developer sees _locally_ while testing — the value that actually ships is whatever `CONFIG.ts`/env vars resolve to. That's intentional: this is a build-wide, non-dynamic decision per the original request, and `CONFIG.ts` is the source-controlled place that decision belongs.

---

## 7. Forward-compatibility: the planned worker-based Physics API

CLAUDE.md documents a separate, future initiative: an engine-agnostic Physics API (Rapier/Jolt/Ammo, selectable) that can run main-threaded or in a worker, at which point physics objects become real ECS components. Comments already in the codebase (`AppECSRegistry.ts`: `// physicsToTransform (Syncing SAB to ECS)`; `ECSCoreSystems.ts`: `// Direct SAB access from your Physics Proxy`; `PhysicsAPITypes.ts`'s `RigidBodyAPI` "Hot Path (Shared Memory / Sync Access)" fields) make clear `SharedArrayBuffer` was the intended mechanism for that — never implemented (`PhysicsAPI.ts` is fully commented out, and its actual worker RPC prior art is a `postMessage` + `requestId` request/response protocol, not SAB/`Atomics`).

This plan doesn't implement any of that, but the `Transform` store is designed so it isn't in the way later:

- **Phase 1 uses a plain `ArrayBuffer`**, not `SharedArrayBuffer` — there's no second thread yet, so SAB buys nothing except the extra hosting requirement (below) for zero benefit.
- Because the buffer is allocated as one contiguous block with fields carved out by offset (§5.2), switching the allocation from `new ArrayBuffer(...)` to `new SharedArrayBuffer(...)` later is a one-line change behind a small factory function (`createTransformBuffer(maxEntities, useSAB)`) — the `Float32Array` views, sparse-set logic, and helper API are unaffected.
- **`SharedArrayBuffer` requires cross-origin isolation** — `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` response headers, checkable at runtime via `self.crossOriginIsolated`. Without them, `SharedArrayBuffer` is unavailable in the browser (Spectre mitigation). This is a _hosting/dev-server_ concern (`vite.config.ts` `server.headers` for dev, and whatever serves the production build) that the future worker-physics feature will need to set up — flagged here so it doesn't come as a surprise, not something this plan configures now.
- Whether cross-thread writes need `Atomics.wait`/`notify` or can rely on a `postMessage`-based "step complete" handshake (the existing `initWorker()` helper in `src/_engine/utils/helpers.ts` already does ready-handshake-based worker setup) is a design question for that future Physics API plan, not this one — the buffer layout proposed here is compatible with either.

---

## 8. Non-goals (explicitly out of scope for this plan)

- Rewiring `physicsToTransformSystem`/`BODY_DYNAMIC_VISUAL` or `PhysicsRapier.ts`'s direct-mesh interpolation path to use ECS `Transform` storage. Both stay exactly as they are; the `TypedArrayTransformStore` is designed to be a sensible target for that _future_ work, not a trigger to do it now.
- Extending `TypedArray` storage to any `ComponentType` other than `TRANSFORM`. The storage-strategy interface (§5.1) makes this straightforward to add later per-type if it's ever measured to help (candidates: numeric tag/flag components, `LIFETIME`), but nothing beyond `Transform` is implemented in phase 1.
- Implementing the worker-threaded Physics API itself, or `SharedArrayBuffer` usage.
- Any COOP/COEP hosting configuration.

---

## 9. Files touched (once implemented)

- `src/_engine/core/ECS.ts` — `ECSWorld` constructor gains `(storageMode, maxEntities)` params; `storages` retyped to `Map<ComponentType, IComponentStorage<any>>`; `TRANSFORM`'s storage constructed conditionally; expose `getEntityIndex(entityId)`; `initECSWorld()` reads the resolved mode/capacity and passes it through.
- `src/_engine/core/ECS/ComponentStorage.ts` (new) — the `IComponentStorage<T>` interface.
- `src/_engine/core/ECS/TypedArrayTransformStore.ts` (new) — sparse set + flat `Float32Array`s + index-based helper functions + the `Transform`-shaped materialization used for cold-path `getComponent` compatibility.
- `src/_engine/core/ECS/ECSCoreComponents.ts` — `Transform` class stays as the compatibility shape; add stride/field-offset constants shared with the new store.
- `src/_engine/core/ECS/ECSCoreSystems.ts` — `object3DSyncSystem`, `lookAtSystem`, `physicsToTransformSystem` updated to use the direct index-based API when `TYPED_ARRAY` mode is active (this is required to actually realize the perf win — leaving them on the compatibility `getComponent` path would materialize an object every call and defeat the purpose).
- `src/_engine/core/Config.ts` — `AppConfig.ecs` (`storageMode`, `maxEntities`) + `VITE_ECS_*` env overrides, following the `physics`/`VITE_PHYS_*` pattern exactly.
- `src/_engine/core/Debug/_dbg__ECS.ts` — upgraded from the current "Hello world" skeleton to a Tweakpane pane with the mode/capacity toggle (`createNewDebuggerPane` instead of `createNewDebuggerContainer`), `AEK_ecsStorageMode` localStorage key, reload-on-change.
- `src/_engine/InitApp.ts` — resolve the storage mode/capacity before `initECSWorld()` and pass it through.

---

## 10. Phased rollout

### Phase 1 — Storage abstraction + `Map` parity (no behavior change)

Introduce `IComponentStorage<T>`, retype `storages`, confirm existing systems/tests still pass with `Map` as the only implementation. Zero risk, pure refactor — validates the interface is actually sufficient for every current call site before building a second implementation against it.

### Phase 2 — `TypedArrayTransformStore` + settings

Build the sparse-set store, `CONFIG.ecs` settings + env overrides, thread the mode into `ECSWorld`'s constructor, upgrade the debug tab. Update `object3DSyncSystem`/`lookAtSystem`/`physicsToTransformSystem` to the direct API under `TYPED_ARRAY` mode.

Exit criteria: toggling the debug-tab setting and reloading visibly switches backends with no functional regression in either mode — a scene with only non-physics/kinematic entities (object3DSyncSystem/lookAtSystem paths) renders identically under both.

### Phase 3 — Measure

Benchmark `Map` vs `TypedArray` at representative entity counts (the actual point of this feature): frame time, GC pause frequency/duration, memory footprint. This is what answers "did it help" and informs whether extending `TypedArray` to other component types (explicitly out of scope here) is worth doing later.

---

## 11. Risks and gotchas

| Risk                                                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TypedArray` mode adds a capacity ceiling `Map` never had                                                                                                | Configurable `maxEntities`, clear throw-on-exceed error naming the config to raise                                                                                                                                                                                                                                             |
| Hot systems must be rewritten for the perf win to materialize                                                                                            | Rewrite surface is small and enumerable (§9) — four systems/call sites, not a sprawling migration                                                                                                                                                                                                                              |
| Cold-path `getComponent` compatibility shim allocates per call                                                                                           | Explicitly documented as compat-only, never used by the engine's own per-frame systems                                                                                                                                                                                                                                         |
| `getStorage()`'s return type change (`Map` → `IComponentStorage`) could break external code assuming a real `Map` (e.g. `.size`, `Map`-specific methods) | Grep all `getStorage` call sites during Phase 1 before retyping; add any genuinely-needed `Map`-only method to the interface rather than leaving it a silent breakage                                                                                                                                                          |
| Sparse-set swap-remove reorders iteration order                                                                                                          | Nothing in the current codebase depends on `Transform` iteration order (confirmed: no direct iteration over `TRANSFORM` storage exists today — it's always looked up via `getComponent` from another storage's iteration, but of course if this plan is implemented at a later date, this could change so please double check) |
| Premature `SharedArrayBuffer` adoption forces COOP/COEP hosting requirements for no benefit                                                              | Explicitly deferred to the future worker-physics phase (§7); phase 1/2/3 here use plain `ArrayBuffer` only                                                                                                                                                                                                                     |

---

## 12. Open questions

1. **Grow-and-copy fallback for exceeded capacity** — worth building now as an opt-in, or strictly throw-and-reconfigure until there's a concrete case for it? Leaning throw-only for simplicity (§5.3), but flagging since it changes the store's public API surface if added later (an explicit "growable" flag).
2. **Env var naming** — confirm `VITE_ECS_STORAGE_MODE`/`VITE_ECS_MAX_ENTITIES` fit the project's naming conventions before Phase 2, alongside `CONFIG.ts`'s `ecs` key name (vs. e.g. `ecsStorage`).
3. **Debug tab live stats** (current entity count vs. capacity, per §6) — nice-to-have once the store exists; not required for the mode-selection mechanism, but worth scoping into Phase 2 or deferring explicitly.
4. **Benchmark methodology for Phase 3** — which scenes/entity counts count as "representative" for this project specifically? Needs an actual test scene with a configurable, large, non-physics entity count to be useful.
