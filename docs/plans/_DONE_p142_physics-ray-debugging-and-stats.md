Status: implemented
Category: Physics, Debugger, Bug fix
Blocks: \_DONE_p143_ray-cast-tester-windows.md
Related: \_DONE_p027_physics-api-stats-tracker.md (same opt-in stats philosophy), p068_character-debug-gizmos.md (lists a "character floor ray gizmo"), \_DONE_p100_small-bug-fixes-and-tweaks.md (was considered as a home for Phase 1; it shipped without it)

# Physics Ray Debugging and Stats — Plan

> Implemented in engine 2.2.0. §8 lists where the code differs from the design below. The file
> references in §2 are from before the implementation.

Part of the ray casting plan set (index: `_DONE_p140_refactor-ray-casting.md` §1.1). Physics queries
(`castRay`, `castRayAndGetNormal`, `intersectionsWithRay`, `castShape`) have no statistics and no
visual helpers, and two of them are broken in `WORKER_THREAD` mode. This plan:
- fixes those bugs;
- adds an engine-agnostic **query observer** owned by the Physics API;
- feeds physics-ray **statistics**, through the shared `IntervalCounterStats` from p140;
- feeds physics-ray **thick-line helpers**, through the shared renderer from p141 with kind
  `'PHYSICS'` and its own colors;
- shows both in a "Physics rays" section of the Ray Cast Controls tab.

**Ownership:** physics owns this instrumentation (rationale in p140 §1.2). The Ray Cast Controls tab
only reads it through public getters.

---

## 1. Goal

- `castRayAndGetNormal` and `intersectionsWithRay` work identically in both `workerTarget` modes.
- Every physics query can be counted (per rendered frame, with interval min/max/average windows) and
  optionally drawn as a helper line with a hit marker. This covers async worker results that arrive
  after the frame that issued them.
- Physics ray stats are a public API (`getPhysicsRayStats()`) for the p220 profiler.
- Physics-ray settings, stats and colors are visible and editable in the Ray Cast Controls tab,
  separate from the Three.js rays.
- Near-zero cost when disabled: one boolean check per query. There is no worker-side change beyond
  the bug fix.

---

## 2. Current state (grounded in the actual code)

### 2.1 Query APIs

- **Engine** (`src/_engine/core/Physics/EngineRapier.ts:1032-1295`):
  - Every query has a `*Sync` form and an `async` form. On MAIN_THREAD the async form returns the
    sync result.
  - Hits are `RayColliderHitAPI {collider, timeOfImpact}`, `RayColliderIntersectionAPI {…, normal,
    featureType, featureId}` or `ShapeCastHitAPI {…, witness1/2, normal1/2}`.
  - There is **no hit point**; it is `origin + dir × timeOfImpact`.
- **MAIN_THREAD:** `physicsWorld` *is* the EngineRapier world object (`PhysicsAPI.ts:239`, `:802`).
- **WORKER_THREAD:** `WorldProxyAPI` (`PhysicsAPI.ts:1619`, queries at `:1897-2040`):
  - Each query is one `messageWorkerAsync` → `postMessage` with a `requestId`. The worker echoes it
    (`physicsWorker.ts:272-285`), and `resolveRequest` resolves with the whole response message.
  - `*Sync` methods throw.
  - Queries skip the sub-step capture, so a query issued in `APP_PHYSICS_STEP` reaches the worker
    before that frame's STEP and resolves ≥1 frame later.
- There is no batching of queries.
- `filterPredicate` is declared in the types (`PhysicsAPITypes.ts:1490-1509`) but never passed by
  EngineRapier. It is silently ignored.

### 2.2 Live bugs (WORKER_THREAD only)

1. **`WorldProxyAPI.castRayAndGetNormal`** (`PhysicsAPI.ts:1979-1994`):
   - It returns the **raw response** `{type, intersection, requestId}` instead of `.intersection`.
   - It never maps the collider id back to a `ColliderAPI` (compare `castRay` at `:1897-1928`).
   - It doesn't accept or forward `filterExcludeCollider`/`filterExcludeRigidBody`, although the
     protocol carries them (`PhysicsAPITypes.ts:2163-2164`) and the worker applies them
     (`physicsSwitchWorld.ts:114-131`).

   Effect: `dynamicCharacter.ts:359-380` `refreshFloorNormal` reads `hit?.normal` → always
   `undefined` → it always falls back to `(0,1,0)`. Ground slope walkability is never evaluated in
   worker mode, and the floor ray doesn't exclude the character's own body.
2. **`WorldProxyAPI.intersectionsWithRay`** (`PhysicsAPI.ts:2001-2030`) reads `.intersections`, as
   typed in `PhysicsAPITypes.ts:2563`. But the worker sends `{ type, hits }`
   (`physicsSwitchWorld.ts:154`), so `intersections.length` throws.

### 2.3 Gameplay users

- Only `src/_engine/utils/character/dynamicCharacter.ts` uses physics queries:
  - the wall check `castShape` (`:294-330`, cylinder, excluding its body);
  - the floor check `castRayAndGetNormal` (`:359`).

  Both are fire-and-forget. They are issued from `move()` (KEY_HELD bindings polled per sub-step
  in `MainLoop.ts:125-129`).
- `src/app/physicsTest.ts:161-190` is an async `castShape` demo.

### 2.4 Existing physics debug tooling

- The Physics API tab is `_dbg__PhysicsAPI.ts:677` (`physicsApiControls`, orderNr 6).
- Collider wireframes are in `_dbg__PhysicsDebugDraw.ts`.
- Step stats (p027) are opt-in via a boot flag and exposed as raw last-frame values
  (`getLastPhysicsStepDuration`, `PhysicsAPI.ts:446`).
- There are no query stats anywhere.

---

## 3. Design

### 3.1 Phase 1 bug fixes (standalone)

- `castRayAndGetNormal`:
  - accept and forward the two exclude filters, using the existing `getCollOrRigidId` helper;
  - return `response.intersection`;
  - remap `collider` through `colliders.get(id)`, returning `null` if it is unknown, like `castRay`.
- `intersectionsWithRay`: make the **worker** send `intersections` (matching the typed down protocol)
  instead of `hits`.
- Check why `tsc` didn't catch the `hits` mismatch (`sendMessage` payload typing) and tighten it if
  cheap. Otherwise add a comment.
- Add TypeDoc to the `filterPredicate` type: "not supported yet (ignored)".
- Verify `castShape`'s proxy and worker paths the same way, since it is the third query with a remap.

### 3.2 Query observer (engine-agnostic hook)

In `Physics/PhysicsAPITypes.ts`:

```ts
export type PhysicsQueryKind = 'CAST_RAY' | 'CAST_RAY_AND_GET_NORMAL' | 'INTERSECTIONS_WITH_RAY' | 'CAST_SHAPE';
export type PhysicsQueryObserver = {
  /** Called when a query is issued (main thread). Returns a token for onResult. */
  onQuery(kind: PhysicsQueryKind, origin: PhysVector, dir: PhysVector, maxToi: number,
          debug: RayDebugOpts | undefined): number;
  /** Called when the query result is known (sync: immediately; worker: on resolve). */
  onResult(token: number, firstHitToi: number | null, hitCount: number): void;
};
```

- **MAIN_THREAD:** the engine backend gets `setQueryObserver(observer | null)`. `EngineRapier`'s
  query methods call it, sync and async alike, behind one `if (queryObserver)`.
  - The observer is only ever set on the main thread. The worker's EngineRapier instance never has
    one, so worker-side cost is zero.
  - The `async` wrappers must not double-count when they delegate to `*Sync`: only the sync
    implementation reports.
- **WORKER_THREAD:** `WorldProxyAPI`'s query methods call the same observer. They call `onQuery`
  before `messageWorkerAsync`, and `onResult` in the resolve path.
- **For `castShape`:** origin = `shapePos`, dir = normalized `shapeVel`, maxToi = `maxToi`. It is
  counted separately as a shape cast, and drawn as the sweep line.
- **Optional trailing `debug?: RayDebugOpts` parameter** on the four async methods and their sync
  counterparts, in `WorldAPI`, `EngineRapier` and `WorldProxyAPI`. It is appended last, so existing
  positional calls are unaffected.
  - It **never crosses to the worker**: it stays in the main-thread proxy and is handed to the
    observer.
  - A trailing param was chosen over an options object to avoid breaking the Rapier-shaped
    positional API.
- `PhysicsAPI.ts` owns the observer instance. It installs it when either physics-ray stats or
  physics-ray helpers are enabled, and removes it when both are off. Disabled cost is the single
  `if`.

### 3.3 Physics ray stats API (core, in `PhysicsAPI.ts`)

```ts
export const setPhysicsRayStatsEnabled = (enabled: boolean) => { … };
export const isPhysicsRayStatsEnabled = () => …;
/** Rays = CAST_RAY + CAST_RAY_AND_GET_NORMAL + INTERSECTIONS_WITH_RAY; shape casts separate. */
export const getPhysicsRayStats = () => ({ rays: raysStats.snapshot(), shapeCasts: shapeStats.snapshot() });
export const resetPhysicsRayStats = () => { … };
```

- Two `IntervalCounterStats` instances (p140) with the same default windows as the Three.js rays.
- The returned wrapper object is pre-allocated and reused, like the snapshots.
- They are **counted at issue time** (`onQuery`), so the per-frame count is the number of queries
  the frame issued. That includes every sub-step, because queries issued in `APP_PHYSICS_STEP` run
  0–N times per frame.
- `endFrame` runs in the same LATE_MAIN pass as the Three.js stats.
- Reset on scene enter, next to `resetRayCastStats()` (`SceneLoader.ts:561`).
- An optional extra counter is `pendingQueries` (worker mode: issued − resolved). It is cheap and
  useful for spotting query pile-ups, and is shown in the tab.

### 3.4 Physics ray helpers

- The observer forwards to `useDebug(rayHelpers)?._drawRay('PHYSICS', origin, dir, maxToi, null,
  debug, now)` at issue time. That is p141's renderer, loaded through the same debug module pattern.
- **The ray line appears on the frame it is issued, even in worker mode.** `onResult` calls
  `_updateRayHit(token, toi)` to shorten the line to the hit and add the hit marker when the result
  arrives, ≥1 frame later in worker mode and immediately on the main thread.
- A result for a helper that has already been recycled is ignored. The token encodes the pool slot
  plus a generation.
- Physics helpers use the `'PHYSICS'` kind settings and colors (defaults `#30d5ff` / `#1f5f73`, from
  p141 §3.4), so they are distinguishable from Three.js rays.
- **Character rays:** `dynamicCharacter.ts` passes `debug: { id: 'char_floor_<entityId>' }` and
  `{ id: 'char_wall_<entityId>' }`. Nothing is drawn unless physics helpers are enabled. This gives
  p068 its "character floor ray gizmo" for free.

### 3.5 Ray Cast Controls tab: "Physics rays" section

- It is added next to p141's "Three.js rays" folder, with the same settings: show helpers, show rays
  without an id, active/inactive colors, width, hold, fade, dash/gap, force kind colors.
- Plus:
  - an "Enable physics ray statistics" toggle;
  - a stats block with rays and shape casts, current / min / max / average windows, and pending
    queries in worker mode. It is built with p140's cached-DOM view and `createPercentagePie`.
- It is stored in the same flat `debugRayCast` state (`physics*` keys).
- If physics isn't initialised (`isPhysicsWorldEnabled()` false), the section shows a
  "No physics world" note and keeps its settings.

---

## 4. Phases (each non-breaking and committable on its own)

### Phase 1: worker-mode query bug fixes (not blocked; can be cherry-picked early or moved to p100)

- §3.1 fixes for `castRayAndGetNormal` and `intersectionsWithRay`, plus a `castShape` check.
- Verify `dynamicCharacter` ground-slope walkability in WORKER mode.

### Phase 2: query observer and stats API

- Add the observer types, `setQueryObserver` on the engine, the proxy calls, and the trailing
  `debug` param.
- Add the stats API (`get/set/is/resetPhysicsRayStats`). There is no UI yet; check it via the
  console.

### Phase 3: physics helpers and tab section

- Wire the observer to p141's renderer (`'PHYSICS'` kind, `_updateRayHit`).
- Add the "Physics rays" tab section with settings and stats.
- Add debug ids to `dynamicCharacter.ts`'s queries.

---

## 5. Risks, notes, out of scope

- **Async result timing.** In worker mode the helper line exists before its hit is known. For about
  1 frame it is drawn to `maxToi`, then snaps to the hit. This is acceptable and documented. The
  alternative (drawing only on resolve) would make one-frame queries show up late *and* short-lived.
- **Double counting.** The async wrappers on the main thread delegate to sync. Only the sync
  implementation reports (§3.2). Covering this in the Phase 2 console check is essential.
- **Callback-style `intersectionsWithRay`.** `onResult` gets the smallest toi and the hit count after
  the iteration finishes. Every hit's point is not drawn (out of scope).
- **Engine surface.**
  - A trailing optional param on public `WorldAPI` methods is additive, so the bump is **minor**.
  - The Phase 1 fixes are **patch** level but change behaviour: the character now really evaluates
    slopes in worker mode. This should be called out in the PR.
- **Future backends** (Jolt/Ammo) implement `setQueryObserver` the same way. The observer knows
  nothing about Rapier.
- **Out of scope:** `filterPredicate` support, the commented-out point-projection queries
  (`PhysicsAPITypes.ts:1770-1920`), batched query messages (they would help p143's future multi-ray
  fire; noted there), and shape outlines for shape casts (only the sweep line is drawn).

---

## 6. Verification

- `yarn lint` and `yarn build` are clean.
- **Phase 1:**
  - With `workerTarget: 'WORKER_THREAD'`, walk the character onto a slope steeper than its walkable
    limit. It must now be treated as non-walkable, as it already is in `MAIN_THREAD`.
  - A temporary `intersectionsWithRay` call from `physicsTest.ts` must return hits in both modes
    without throwing.
- **Phase 2:** in both modes, enable the stats from the console. `getPhysicsRayStats().rays.lastFrame`
  equals the number of character floor queries per frame. Confirm there is no double count on the
  main thread.
- **Phase 3:**
  - `?isDebug=true` → Ray Cast Controls → Physics rays: enable the helpers. The character's floor
    ray and wall sweep show in the physics colors, clearly different from the Three.js picking rays.
  - One-frame queries hold, then fade dashed.
  - In worker mode the line snaps to the hit about 1 frame after appearing.
  - The pending-queries count stays near 0.
- With everything disabled, the DevTools profile shows no observer work.

---

## 7. Follow-up plans

- p143 physics ray tester (uses the fixed queries and the `'PHYSICS'` helpers).
- p220 profiler reads `getPhysicsRayStats()`.
- A possible `WORLD_QUERY_BATCH` protocol message if the multi-ray tester or gameplay needs many
  queries per frame.

---

## 8. Implementation notes (where the code differs from the design)

- **The code had moved before implementation, cosmetically.** The worker files are in
  `src/_engine/workers/`, not `core/workers/`, `RayDebugOpts` is in `core/RayDebugTypes.ts`, and
  the §2 line numbers had shifted. No design change came from it.
- **`sendMessage` typing is tightened in the World switch only.** `physicsSwitchWorld.ts` types its
  `sendMessage` against `PhysicsDownProtocol`, and every reply uses its case's narrowed `data.type`.
  With it, `tsc` reports the `hits`/`intersections` mismatch, and nothing else. The Rigid, Coll and
  Joint switches still take `any`: typing them the same way gives 55 errors, because they reply
  with a widened `const type = data.type`.
- **The observer gets `dir`, `maxToi` and every toi as the query was issued, never normalized.**
  Rapier's toi is in units of `|dir|`, and a shape cast's `shapeVel` is rarely unit length, so the
  planned "normalized `shapeVel` + raw `maxToi`" would draw wrong lengths. The helpers get the raw
  `dir` too, with lengths in toi units: `origin + dir * toi` is the exact hit point for any `|dir|`,
  with no conversion or per-token state. Only the renderer's `maxHelperLength` cap on misses is then
  in `|dir|` units.
- **Worker-mode `intersectionsWithRay` now stops when the callback returns `false`.** The worker
  collects every hit and the proxy used to deliver all of them. Found while adding the observer; not
  in §2.2.
- **The implementations declare a `_filterPredicate` placeholder**, so the trailing `debug`
  parameter lands in the right position (they omitted `filterPredicate` before).
- **The engine-backend observer is module state in `EngineRapier.ts`** behind a `setQueryObserver`
  export, which `EngineAPIType` requires. A future backend has to provide it.
- **`pendingQueries` is a field of `getPhysicsRayStats()`** and never goes below 0: a reply to a
  query issued before a reset has nothing to subtract from. A worker query that errors is only
  logged and never resolved, so it stays counted. Surfacing that is the point of the counter.
- **Physics helpers are switched by `setPhysicsRayHelpersEnabled(enabled)`**, a new public (debug
  only) function the tab calls with the physics "Show helpers" setting. `PhysicsAPI.ts` loads its
  own reference to `_dbg__RayHelpers.ts`, which is the same module instance `Raycast.ts` uses.
- **The stats frame ends in a LATE_MAIN system in `PhysicsManager.ts`** (order -1000, like
  `rayCastFrameEndSystem`), not inside Raycast's system, so `Raycast.ts` doesn't import physics.
- **One stats window config.** `RAY_STATS_WINDOWS` (`core/RayDebugTypes.ts`) is shared by the
  Three.js ray stats and both physics counters.
- **Tab layout.** The physics folder and its stats toggle are in their own pane, below the Three.js
  stats, with the physics stats blocks (rays, shape casts, and "Pending queries" in
  `WORKER_THREAD` mode only) after it. The Three.js stats heading became "Three.js ray stats:". The
  "No physics world" check runs when the tab mounts.
- **The character's debug objects are created once per character**, with their ids
  (`char_floor_<entityId>`, `char_wall_<entityId>`) set after the entity exists, so no query
  allocates one.
- **Added after review: a "Respect depth" setting per kind** (`RayHelperKindSettings.depthTest`, off
  by default), in both the Three.js and the physics folders. `RayDebugOpts.depthTest` now defaults
  to it instead of `false`, so a per-ray value still wins.
- **Verified in both `workerTarget` modes** (gym and physicsTest scenes): the fixed queries return
  the same results, the summed per-frame stats equal the query calls (no double count), the pending
  count returns to 0, and helpers with a non-unit `dir` end on the physics hit (with the hit cross in
  worker mode too). The DevTools profile of the disabled path was not recorded: it is one null check
  per query by construction.
