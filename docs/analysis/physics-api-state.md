# Physics API — State of the System & Roadmap to a Working Build

Status: analysis — not a plan, no implementation performed
Category: Physics
Branch analyzed: `physics-api-finalization`
Date: 2026-09-17

## 1. Executive summary

There are currently **two parallel physics systems** in the engine:

1. **`PhysicsRapier.ts`** (`src/_engine/core/PhysicsRapier.ts`, ~2500 lines) — the old, working, Rapier-coupled implementation. It is what actually runs today: it's imported by `InitApp.ts`, `MainLoop.ts`, `Scene.ts`, `Character.ts`, `SceneLoader.ts`, `ImportModel.ts`, every app scene, and most `toolkit`/`utils` physics helpers (18 files total).
2. **The new agnostic Physics API** — `PhysicsAPI.ts` (facade) + `Physics/PhysicsAPITypes.ts` (engine-agnostic contract, ~2500 lines) + `Physics/EngineRapier.ts` (Rapier backend, ~1500 lines) + `Physics/ENGINES.ts` (engine registry) + `Physics/PhysicsUtils.ts` + `workers/physicsWorker.ts` + `workers/physics/physicsSwitch{World,Rigid,Coll}.ts` (worker-thread request/response protocol). This is the intended replacement described in `CLAUDE.md`. **Nothing in the codebase imports `PhysicsAPI.ts`.** It is currently dead code from the running application's point of view, and it does not even type-check (see §3.1).

The new API's *shape* is good and mostly complete: a large, well-thought-out engine-agnostic type contract (`PhysicsAPITypes.ts`), a clean engine-registry pattern for swapping backends (`ENGINES.ts`), and a fully-built worker-side request/response switchboard for every rigid-body/collider/world call. What's missing is the part that makes it a *running* physics system: **stepping the world, moving simulation results back into the render loop, events, and the ECS integration that turns a physics body into an entity.** Those four things are all stubbed, commented out, or structurally inconsistent with each other right now. There's also a mostly-finished but not-yet-wired ECS design (`BODY_DYNAMIC_VISUAL` / `BODY_DYNAMIC_HEADLESS` / `BODY_STATIC` / `COLLIDER` component buckets, a `physicsToTransformSystem` already registered in the core ECS plugin) that already anticipates a `PhysicsEntity`-style object — it just has no producer feeding it.

Multi-engine support (Jolt/Ammo) is the *easiest* part of this list once the above is solid, because the abstraction boundary (`EngineAPIType` + `ENGINES` registry) already exists and Rapier is the only thing that has to prove it out.

## 2. Current architecture

```
                        ┌─────────────────────────────┐
   RUNS TODAY  ────────▶│      PhysicsRapier.ts        │◀──── InitApp.ts, MainLoop.ts,
                        │  (mesh + RigidBody coupled)   │      Scene.ts, Character.ts,
                        │  stepPhysicsWorld()           │      SceneLoader.ts, ImportModel.ts,
                        │  renderPhysicsObjects()        │      app/scene*.ts, toolkit/*, ...
                        └─────────────────────────────┘      (18 importers)

                        ┌─────────────────────────────┐
  DOES NOT RUN ─────────▶│        PhysicsAPI.ts          │◀──── (0 importers)
  (unreachable,          │  facade: main-thread or       │
   doesn't compile)      │  worker-thread proxy           │
                        └───────────────┬─────────────┘
                                        │ uses
                        ┌───────────────▼─────────────┐
                        │   Physics/PhysicsAPITypes.ts  │  engine-agnostic contract
                        │   Physics/ENGINES.ts          │  { RAPIER: { init, engineAPI } }
                        │   Physics/PhysicsUtils.ts     │  shared engine-selection state
                        └───────────────┬─────────────┘
                                        │ implements contract for
                        ┌───────────────▼─────────────┐
                        │   Physics/EngineRapier.ts      │  Rapier-specific engine backend
                        │   (main-thread realization)     │  RigidBody/Collider "proxy" classes
                        └─────────────────────────────┘

                        ┌─────────────────────────────┐
                        │  workers/physicsWorker.ts       │  fully-built request/response
                        │  workers/physics/physicsSwitch* │  switchboard for worker-thread mode
                        └─────────────────────────────┘  (never actually started end-to-end)
```

Both systems reuse the same `PhysicsState` shape, the same main-loop hook points, and (per the ECS component types) are clearly meant to converge — the new one just isn't finished.

## 3. Detailed findings

### 3.1 It doesn't compile

Running `npx tsc --noEmit` on the current branch produces **76 errors**, 67 of them in `PhysicsAPI.ts` and 2 in `EngineRapier.ts`. This isn't a matter of a few loose ends — it indicates `PhysicsAPI.ts` is mid-rewrite and still contains large blocks of code copy-pasted from the old `PhysicsRapier.ts` that reference things the new type contract no longer has:

- `ScenePhysicsState` / `ScenePhysicsLooper` types referenced but never (re)defined in this file.
- Direct references to a global `RAPIER` and `eventQueue` that only exist in `EngineRapier.ts` now, not in `PhysicsAPI.ts`.
- `PhysicsState.scenes`, `WorldAPI.gravity`, `WorldAPI.numSolverIterations`/`numInternalPgsIterations`, `ColliderAPI.shape`, `RigidBodyAPI.userData`, `RigidBodyAPI.handle` — all read in `PhysicsAPI.ts` but none of them exist on the new types (the equivalents are `getGravity()/getGravitySync()`, `getNumSolverIterations()`, `getUserData()/uData`, `.id`, etc.).
- `PhysicsObject` is indexed with `physicsObjects[id]` in several places, but the type has no index signature (`TS7053`).

None of this is a deep design problem — it's leftover old-API code that needs to be deleted or rewritten against the new contract — but it means **the file cannot currently be exercised at all**, not even in main-thread mode, and `yarn build`/the Stop hook's type-check would fail if this file were reachable from any entry point. Given it currently has zero importers, `tsc` is the only thing catching this.

### 3.2 The world never steps

This is the central blocking issue — everything else downstream depends on it.

- `Physics/EngineRapier.ts:540` — `stepAPI()` is a literal empty stub:
  ```ts
  export const stepAPI = () => {
    // @CHORE: FINISH THIS
  };
  ```
  Rapier's actual `physicsWorld.step(eventQueue)` call is never invoked anywhere in the new code path. There is no code path in which the WASM simulation advances.
- `EngineAPIType` (the contract every engine backend must implement, `PhysicsAPITypes.ts:15`) **doesn't declare a `step` method at all.** Yet `PhysicsAPI.ts:540` calls `(engAPI as EngineAPIType).step()` — a call the interface doesn't support (confirmed by `tsc`: `Property 'step' does not exist on type 'EngineAPIType'`). The contract and the facade have drifted apart.
- `WorldAPI.step(...)` is present only as a **commented-out** signature in the type file (`PhysicsAPITypes.ts` ~line 1072), right next to a similarly commented-out `debugRender(...)`.
- `PhysicsProtocolType.STEP = 4` exists in the worker protocol enum, but:
  - `workers/physicsWorker.ts:24-27` has the case explicitly disabled: `// @CHORE: implement stepping`.
  - `PhysicsAPI.ts:289` (the main-thread worker message handler) has the receiving side commented out too: `// if (type === PhysicsProtocolType.STEP) { return; }`.
- For worker-thread mode specifically, `PhysicsAPI.ts:243` sets `stepperFn = () => null` unconditionally — worker-thread physics is a guaranteed no-op today, by explicit code, not just an unfinished detail.
- `debugRenderAPI()` in `EngineRapier.ts:536` is the same kind of empty stub, and the debug-stepper path in `PhysicsAPI.ts` (`stepperFnDebug`) calls `physicsWorld.debugRender()` — a method that doesn't exist on `WorldAPI` at all (confirmed by `tsc`).

**Net effect:** there is currently no path — main-thread or worker — by which calling into this new API advances the Rapier simulation by even one frame.

### 3.3 The "hot path" contract is declared but nothing produces it

`RigidBodyAPI` (`PhysicsAPITypes.ts:212`) declares four fields explicitly marked as the fast, allocation-free per-frame read path:

```ts
// --- Hot Path (Shared Memory / Sync Access) ---
pos: PhysVector;
rot: PhysRotation;
lvel: PhysVector;
avel: PhysVector;
```

The ECS side already assumes these are live. `ECSCoreSystems.ts`'s `physicsToTransformSystem` — which **is** registered unconditionally in the core ECS plugin at `APP_POST_PHYSICS` — reads them directly every frame:

```ts
// Direct SAB access from your Physics Proxy
transformStore.setPosition(slot, rb.pos.x, rb.pos.y, rb.pos.z);
transformStore.setQuaternion(slot, rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
```

But nothing ever writes to `.pos`/`.rot`/`.lvel`/`.avel` on any proxy:

- `EngineRigidBodyProxyAPI` (main-thread Rapier backend, `EngineRapier.ts`) never assigns these fields — the main-thread proxy instead exposes real `translation()`/`rotation()` methods that call into Rapier directly, which is fine for main-thread use but doesn't match the "hot path field" contract.
- `RigidBodyProxyAPI` (the worker-mode main-thread proxy in `PhysicsAPI.ts:2534`) initializes `pos`/`rot`/`lvel`/`avel` to zero and **never updates them after construction.** There is no `SharedArrayBuffer`, no `Atomics`, no per-step batch message anywhere in either `PhysicsAPI.ts` or `EngineRapier.ts` — the "Shared Memory" half of the "Hot Path (Shared Memory / Sync Access)" comment doesn't exist yet.

So today, if you actually wired `createPhysicsEntity` up (see §3.5) and spawned a dynamic body, `physicsToTransformSystem` would run every frame, find the `BODY_DYNAMIC_VISUAL` component, and copy `{0,0,0}`/`identity` into the transform forever — the entity would never move, silently, with no error. This is the single piece of plumbing that everything else (ECS sync, worker-thread physics, and by extension any performance work) is downstream of.

### 3.4 Physics events are fully commented out

`PhysicsAPI.ts`'s stepper (`mainThreadBaseStepper`, lines ~438-531) has two large commented-out blocks for `drainCollisionEvents` and `drainContactForceEvents`, each preceded by:

```ts
// @CHORE: eventQueue (Rapier) does not exist anymore in this context, make an agnostic events handler.
```

The old `PhysicsObject`-level callback fields (`collisionEventFn`, `contactForceEventFn`) still exist on the `PhysicsObject` type and on `ColliderParams` (`hasCollisionEventFn`, `enableCollisionActiveEvents`, etc. — these are correctly threaded through collider creation in `EngineRapier.ts`, which does set up `RAPIER.ActiveEvents` and lazily creates the Rapier `EventQueue`). What's missing is the *drain* step: nothing ever calls `eventQueue.drainCollisionEvents(...)`/`drainContactForceEvents(...)` and dispatches the results back to the right `ColliderAPI`/`PhysicsObject` pair, in either main-thread or worker mode. The worker protocol also has no message types for "a collision/contact-force event happened, forward it to the main thread" — `PhysicsProtocolType` has plenty of request/response pairs but no unsolicited/push event type at all, which a worker-thread event system will need (events aren't requested, they arise from `step()`).

### 3.5 `PhysicsObject` → `PhysicsEntity`: the design exists, nothing calls it

The user-facing request to replace `PhysicsObject` with an ECS-native `PhysicsEntity` is already half-designed:

- `ECSCoreComponents.ts` already has ECS component slots for it: `CoreType.COLLIDER` (`ColliderAPI[]`), `CoreType.BODY_DYNAMIC_VISUAL`, `CoreType.BODY_DYNAMIC_HEADLESS`, `CoreType.BODY_STATIC` (all `RigidBodyAPI`), plus `TAG_IS_PHYSICS_OBJECT`.
- `ECS.ts` already has helper methods checking these buckets (`getPhysicsBody`-style lookups combining the three body components, `hasDynamicBody`-style checks).
- `ECSCoreSystems.ts` already registers `physicsToTransformSystem` in `APP_POST_PHYSICS` (see §3.3) — the consumer side is wired.
- `ECSCoreComponents.ts` (lines 141-212) has a **fully-written but entirely commented-out** `createPhysicsEntity(colliderParams, rigidBodyParams?, object3D?, entityOpts?, ecsWorld?)` function. It already does the right thing conceptually: creates an ECS entity, creates the rigid body/colliders through the new API, seeds the ECS `Transform` from the physics state (or from the mesh if no rigid body), and bucket-sorts into `BODY_STATIC` vs `BODY_DYNAMIC_VISUAL` (has an `Object3D`) vs `BODY_DYNAMIC_HEADLESS` (no mesh, e.g. logic-only/server body) — which is exactly the "visual vs headless" split you'd want for cache-efficient iteration in `physicsToTransformSystem`.

This is a strong starting point: `PhysicsEntity` isn't really a new concept to invent, it's this commented-out `createPhysicsEntity` finished and turned on, plus deleting the old mesh-centric `PhysicsObject` type (`id`, `mesh?`, `meshes?`, `collider`, `rigidBody?`, `setTranslation`/`setRotation` closures) and every place that still constructs/consumes it (`collisionEventFn`/`contactForceEventFn` signatures on `PhysicsAPITypes.ts` still take `physObj1: PhysicsObject, physObj2: PhysicsObject` — those need to become entity ids or a lighter descriptor once events exist, see §3.4).

Note the comments on `createPhysicsEntity` itself: `// @CHORE: move this to PhysicsAPI` and `// @CHORE: refactor the object3D to just use an entityId` — the author already flagged both of these as not-final.

### 3.6 Bootstrap / main-loop wiring

The old system is invoked from two exact spots that the new one needs to take over:

- `InitApp.ts` calls `InitRapierPhysics(...)` from `PhysicsRapier.ts` during boot.
- `MainLoop.ts` calls `stepPhysicsWorld(loopState)` then `renderPhysicsObjects()` **between** `world.updateMainLoop(delta)` (MAIN stage) and `world.updateAppLoop(deltaApp)` (which runs `APP_PRE_PHYSICS → APP_POST_PHYSICS → APP_LOGIC → APP_RENDER_SYNC`) — i.e., physics stepping is intentionally sequenced *before* the ECS's `APP_POST_PHYSICS` stage runs, so that `physicsToTransformSystem` sees fresh data. This is the correct integration point and doesn't need to be re-designed — the new API's step/interpolate calls just need to be swapped in at the same two call sites, once §3.2 and §3.3 are solved.

Until `PhysicsAPI.ts` compiles and something actually calls `initPhysics()`/`stepPhysicsWorld()`-equivalents from it, none of the rest of the analysis is observable at runtime — this is a small mechanical step but it's the thing that turns "code exists" into "system runs."

### 3.7 Contract gaps beyond stepping

Comparing `PhysicsAPITypes.ts` against what `PhysicsRapier.ts` (and `Character.ts`) actually use today:

| Feature | Old system | New contract | Status |
|---|---|---|---|
| Rigid bodies, colliders (all shapes used today: cuboid, ball, capsule, cone, cylinder, trimesh, heightfield, convex hull, triangle) | ✅ | ✅ (`ColliderParams` covers all of these) | parity |
| Collision groups / solver groups, friction/restitution combine rules | ✅ | ✅ | parity |
| Snapshot / restore | ✅ | ✅ (typed, `@CHORE` about a richer return type) | parity, minor polish TODO |
| Ray casting, shape intersection queries | ✅ | ✅ (`castRay`, `castRayAndGetNormal`, `intersectionsWithRay`, `contactPairsWith`, `intersectionPairsWith`) | parity |
| Debug wireframe render (`physicsWorld.debugRender()`) | ✅ (used by the Tweakpane visualizer) | commented out of `WorldAPI`, `debugRenderAPI()` stub | **gap** |
| Collision / contact-force events | ✅ | declared on `ColliderParams`/`PhysicsObject` but never drained (§3.4) | **gap** |
| World step | ✅ | commented out of `WorldAPI`, missing from `EngineAPIType`, stub in `EngineRapier.ts` | **gap** (§3.2) |
| Joints (impulse/multibody) | not used by this app currently | fully commented out in `PhysicsAPITypes.ts` (~lines 1336-1432) | not started, not currently used elsewhere either — low priority unless a feature needs it |
| Character controller (Rapier's `KinematicCharacterController`) | not used — `Character.ts` implements its own controller on top of plain rigid bodies/colliders | commented out in the type file | not started, matches old system's approach (custom, not Rapier-native) — fine to defer |
| Multi-threaded / worker execution | not supported at all | protocol + switchboard fully built (`workers/physics/*`), but unreachable because stepping (§3.2) and the hot path (§3.3) aren't done | **the actual point of this rewrite, currently the least finished part** |
| Multiple engines (Jolt/Ammo) | N/A | registry pattern in place (`ENGINES.ts`), only `RAPIER` registered, no `@dimforge`-equivalent Jolt/Ammo dependency in `package.json` | not started, but low risk — see §5 |
| Server-authoritative physics | N/A | `PhysicsWorkerTarget` type has a code comment noting `'SERVER_AND_MAIN' | 'SERVER_AND_WORKER'` as a possible future value, but it's not a real union member and nothing else references a server target | explicitly not designed yet (matches what you said) |

### 3.8 Smaller inconsistencies worth fixing while doing the above

- `EngineRapier.ts` keeps its own **module-level copy** of `PhysicsState` defaults (lines 26-47) that is byte-for-byte duplicated in `PhysicsAPI.ts` (lines 142-163). Both are marked `// @CHORE: needs a setter function`. Any future default change has to happen in two places or they'll drift (they arguably already could, since nothing enforces they stay equal).
- `PhysicsUtils.ts`'s `isDynamicPhysicsObjectValid` has its real logic commented out (`// !po.rigidBody?.isSleeping() && ...`) with a note that these are "now promises" and need rechecking in the worker — worth resolving once the hot-path/sync-vs-async story (§3.3) is settled, since this same ambiguity (is a getter sync or does it need an await) runs through the whole file.
- `getColliderShapeName` (`PhysicsUtils.ts`) doesn't have a case for `ShapeType.Voxels = 18` (added to the enum but not the switch) — minor, but will silently fall through to `'[UNKNOWN]'`.
- The `EngineAPIType`/`WorldAPI` split currently has some overlapping/duplicated responsibility (e.g., both `createRigidBody` and `createRigidBodySync`, `getRigidBodyAPIWithId` living on `EngineAPIType` while equivalent lookups exist on `WorldAPI`) that's fine conceptually (`EngineAPIType` = engine/global-registry level, `WorldAPI` = per-world instance level) but should be explicitly documented so a second engine implementation doesn't guess wrong about which methods belong where.

## 4. Recommended path to "it works"

This isn't a plan (per `CLAUDE.md`, that belongs in `docs/plans/` and should be written up separately if/when you want to schedule the work), but here's the dependency order the findings above imply — each phase unblocks the next and is small enough to land independently:

1. **Make `PhysicsAPI.ts` compile.** Delete/rewrite the ~67 leftover references to old-API shapes (`ScenePhysicsState`, `ScenePhysicsLooper`, `.scenes`, `.gravity`/`.numSolverIterations` directly on `WorldAPI`, `.shape` on `ColliderAPI`, `.userData`/`.handle` on `RigidBodyAPI`, the `PhysicsObject` index-signature uses). This is prerequisite to everything else being testable at all.
2. **Implement stepping**, main-thread first:
   - Add `step(eventQueue?, hooks?)` to `WorldAPI` (uncomment + adapt) and add a matching method to `EngineAPIType` (or drop the `engAPI.step()` call in favor of `physicsWorldAPI.step()` — decide which layer owns it and make the two files agree).
   - Implement `EngineRapier.ts`'s `stepAPI()`/world-level step to actually call `physicsWorld.step(eventQueue)`.
   - Wire `InitApp.ts`/`MainLoop.ts` to the new `initPhysics`/`stepPhysicsWorld` (same two call sites the old system uses today, per §3.6).
3. **Wire the hot path**, main-thread first (no `SharedArrayBuffer` needed there): after each `step()`, populate `pos`/`rot`/`lvel`/`avel` on each live `RigidBodyAPI` from Rapier's `translation()`/`rotation()`/`linvel()`/`angvel()`, so `physicsToTransformSystem` gets real data. This alone makes main-thread mode functionally complete for transform sync.
4. **Turn on `createPhysicsEntity`** (uncomment, move to `PhysicsAPI.ts` per its own `@CHORE`, fix the entity-id-vs-Object3D coupling it already flags) and delete the old mesh-centric `PhysicsObject` type + its remaining call sites once nothing needs it. This is the actual `PhysicsObject` → `PhysicsEntity` migration.
5. **Implement events**: drain `collisionEvents`/`contactForceEvents` after `step()` and dispatch to whatever `PhysicsEntity`-shaped callback replaces the current `PhysicsObject`-based signatures. Decide the worker-mode event transport now (see §5) even if you implement main-thread first, since it changes the callback signature.
6. **Worker-thread mode**: implement the `STEP` message end-to-end (`physicsWorker.ts` case, `PhysicsAPI.ts` receiver), and replace per-property request/response for the hot path with a `SharedArrayBuffer`-backed transform buffer (see §5) — without this, worker mode will work correctness-wise but be far too slow to use for its actual purpose.
7. **Debug render**: implement `debugRenderAPI()`/`WorldAPI.debugRender()` — needed to restore the existing Tweakpane physics visualizer feature.
8. **Second engine (Jolt/Ammo)**: once the above is stable and the `EngineAPIType` contract has stopped moving, add `Physics/EngineJolt.ts` implementing the same exported function surface as `EngineRapier.ts`, and register it in `ENGINES.ts`. Do this last — building a second backend against a contract that's still shifting (steps 1-7 all touch `EngineAPIType`/`WorldAPI`) means rework twice.

## 5. Performance analysis (static — no profiling run)

This is necessarily an estimate based on reading the code, not a measured benchmark (per your ask, flagged as such).

**Main-thread mode.** Once §4 step 2-3 are done, main-thread mode should perform comparably to the current `PhysicsRapier.ts` — the new `EngineRigidBodyProxyAPI`/`EngineColliderProxyAPI` classes are thin wrappers directly calling the same Rapier WASM methods the old code calls, so there's no new overhead beyond a small amount of extra indirection (a proxy class method call before the real Rapier call). The `Map`-based id→handle lookups (`rigidBodies`, `colliders`, `rigidBodyAPIs`, `colliderAPIs` in `EngineRapier.ts`) add O(1) hash lookups per accessor call that the old code didn't need (it used Rapier handles/objects directly) — negligible per-call, but worth being aware of if some hot code path calls these thousands of times per frame (e.g., a large ray-cast loop). The existing interpolation code in `PhysicsAPI.ts` (`prevTransforms`/`currTransforms` Maps, lazily-allocated `THREE.Vector3`/`Quaternion` per rigid-body handle) is a reasonable, allocation-conscious pattern already and should be preserved as-is when this file is fixed up.

**Worker-thread mode — the actual risk.** This is where the design needs the most attention, because the current mechanism (per-call `postMessage` + `Promise` resolver keyed by `requestId`, implemented via `createNewResolver`/`resolveRequest`) is a **request/response RPC**, and every non-hot-path getter (`translation()`, `mass()`, `isSleeping()`, etc.) goes through it. That's fine for one-off queries (raycasts, "did the player get hit"), but it is not viable as the *per-frame, per-body* transform-sync mechanism: for N dynamic bodies, syncing transforms once per frame via individual RPCs is N `postMessage` round trips per frame (structured-clone serialization + a `MessageChannel` hop each way), which at even a modest N (a few hundred bodies) would dominate frame time and defeat the entire purpose of moving physics off the main thread. This is exactly why the type contract already carved out `pos`/`rot`/`lvel`/`avel` as a separate "Hot Path (Shared Memory / Sync Access)" concept distinct from the rest of the RPC surface — but as noted in §3.3, that path currently has no implementation.

Concretely, when you build step 6, the hot path should **not** be "one `postMessage` per body per frame" — it should be a single `SharedArrayBuffer` (a `Float32Array` view), laid out as a flat block per rigid-body slot (e.g. `[posX, posY, posZ, rotX, rotY, rotZ, rotW, linX, linY, linZ, angX, angY, angZ]` × `maxBodies`), written directly by the worker after each `step()` and read lock-free on the main thread by `physicsToTransformSystem` — zero messages per frame, regardless of body count. This requires:
- A stable slot-allocation scheme (the existing running `id` allocation in `EngineRapier.ts`/`rigidBodyAPIs` map is a fine index if you cap `maxBodies` and pool slots on delete).
- `crossOriginIsolated`/COOP-COEP headers for `SharedArrayBuffer` to be available at all in the browser — confirm the dev/prod server config (`vite.config.ts`, hosting) actually sets these; if it doesn't today (old system doesn't need it, so it may not be configured), that's a deployment prerequisite, not just a code change.
- A documented fallback for environments without cross-origin isolation (transferable `Float32Array` batch message once per frame is strictly better than one message per body, even without true shared memory, and is a reasonable fallback tier).

Everything that *isn't* the hot path (one-off queries, mutations like `setLinvel`, world queries) is fine to keep as RPC — those aren't called at 60fps × N bodies, so the existing `physicsSwitch{World,Rigid,Coll}.ts` switchboard doesn't need to change for that part, and its batch-oriented calls that already exist (`CREATE_RIGID_BODIES`, `DELETE_RIGID_BODIES`, `CREATE_COLLIDERS`, `DELETE_COLLIDERS`) are a good pattern to extend to anything else that's naturally bulk (e.g. a future bulk "set desired user-controlled kinematic body targets" message, if that ever becomes a hot per-frame path too).

**Events over the worker boundary.** Collision/contact-force events are inherently *push*, not request/response (they arise from `step()`, not from a call the main thread made) — the current `PhysicsProtocolType` enum is 100% request/response shaped. Worker-mode events will need either a dedicated unsolicited message type sent alongside/after the `STEP` response, or folded into the same per-frame `SharedArrayBuffer`/transferable payload as a small ring buffer of `(collider1, collider2, started)` triples, to avoid falling into the same per-event-message trap as above if collision counts get large (e.g., a big pile of dynamic debris).

**Bottom line:** main-thread mode's performance ceiling is basically "as good as the old system, once finished." Worker-thread mode's performance ceiling is entirely determined by whether the hot-path transform sync (and, secondarily, events) end up shared-memory-backed or message-based — get that one design decision right early (step 6 in §4) since it shapes the `RigidBodyAPI`/`ColliderAPI` proxy implementations on both sides of the worker boundary, and retrofitting it after `createPhysicsEntity` and app code depend on the proxy shape would be more disruptive.

## 6. File inventory (for reference)

| File | Lines | Role | State |
|---|---|---|---|
| `src/_engine/core/PhysicsRapier.ts` | ~2500 | Old, currently-running physics system | working, still wired to bootstrap/main loop |
| `src/_engine/core/PhysicsAPI.ts` | ~3650 | New facade (main-thread or worker-thread proxy) | does not compile (67 errors), zero importers |
| `src/_engine/core/Physics/PhysicsAPITypes.ts` | ~2490 | Engine-agnostic contract + worker protocol enum/types | mostly complete; step/debugRender/joints/character-controller commented out |
| `src/_engine/core/Physics/EngineRapier.ts` | ~1520 | Rapier backend implementing `EngineAPIType`/`WorldAPI`/`RigidBodyAPI`/`ColliderAPI` | CRUD complete; `stepAPI`/`debugRenderAPI` are empty stubs; 2 compile errors (unused vars) |
| `src/_engine/core/Physics/ENGINES.ts` | 25 | Engine registry (`{ RAPIER: {...} }`) | complete pattern, only one engine registered |
| `src/_engine/core/Physics/PhysicsUtils.ts` | 89 | Shared engine-selection state, id helpers | mostly fine, one stale comment/logic gap (`isDynamicPhysicsObjectValid`) |
| `src/_engine/workers/physicsWorker.ts` | 162 | Worker entry point, protocol dispatch | STEP case explicitly unimplemented; everything else dispatches correctly |
| `src/_engine/workers/physics/physicsSwitchWorld.ts` | 168 | World-level worker protocol handlers | complete |
| `src/_engine/workers/physics/physicsSwitchRigid.ts` | 368 | Rigid-body worker protocol handlers | complete |
| `src/_engine/workers/physics/physicsSwitchColl.ts` | 240 | Collider worker protocol handlers | complete |
| `src/_engine/core/ECS/ECSCoreComponents.ts` | — | ECS component types for physics (`COLLIDER`, `BODY_*`), commented-out `createPhysicsEntity` | design present, disabled |
| `src/_engine/core/ECS/ECSCoreSystems.ts` | — | `physicsToTransformSystem`, registered in core plugin | consumer side wired, waiting on producer (hot path) |
