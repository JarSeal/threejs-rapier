Status: draft | not-implemented
Category: Physics
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Restore Physics Snapshot — Plan

Makes snapshot capture/restore a working part of the engine-agnostic Physics API, in both
`MAIN_THREAD` and `WORKER_THREAD` modes, targeted at deterministic rewind/replay. A partial
skeleton for this already exists in the codebase and is dead, duplicated and incorrect — this
plan is mostly **repair**, not greenfield. The core problem is not the byte array (Rapier hands
that over in one call) but what happens to the API's own object graph afterwards: Rapier's
`World.restoreSnapshot()` returns a *brand new* `World`, so every cached WASM wrapper the engine
holds becomes stale, and the set of bodies in the restored world may no longer match the set the
API and the ECS still believe in.

## Context (grounded in code)

- **A dead, broken skeleton already exists, and nothing outside the physics files touches it.**
  `PhysicsProtocolType.TAKE_SNAPSHOT = 2` / `RESTORE_SNAPSHOT = 3`
  (`src/_engine/core/Physics/PhysicsAPITypes.ts:2705-2706`, ENGINE band 0–104);
  `takePhysicsSnapshot()` (`src/_engine/core/PhysicsAPI.ts:579-595`) and
  `restorePhysicsSnapshot()` (`:597-616`), both already branching on `workerTarget` and both
  carrying the `@TODO`s this plan closes; worker cases at
  `src/_engine/workers/physicsWorker.ts:114-121`. Because none of it is reachable from app code,
  **every signature named in this plan can be changed freely** — none is public surface yet.
- **There are two competing engine-side implementations.** Module-level `restoreSnapshot`
  (`Physics/EngineRapier.ts:737-743`) uses the static default import `Rapier` (`:1`) and returns a
  *new* `EngineWorldProxyAPI`; `EngineWorldProxyAPI.restoreSnapshotSync` (`:860-870`) uses the
  runtime-initialised `RAPIER` (`:81`, assigned `:165`) and returns `this`. Only the module-level
  one is actually reachable, via `EngineAPIType.restoreSnapshot` (`PhysicsAPITypes.ts:43`). Same
  duplication for `takeSnapshot` (`:735` and `:853-858`).
- **The type-level gap was already flagged.** Four `@CHORE: change the type to have the rb and
  coll data` markers sit on the `WorldAPI` snapshot methods (`PhysicsAPITypes.ts:1257, 1258, 1264,
  1265`). Design decision 5 resolves them.

### Rapier behaviour — verified against the shipped sources

All of the following was read out of the original TypeScript embedded in
`node_modules/@dimforge/rapier3d-compat/rapier.mjs.map` (version `0.19.3`, pinned exactly in
`package.json`), not inferred from documentation.

- **`World.restoreSnapshot()` can return `null`.** It delegates to
  `new SerializationPipeline().deserializeAll(data)` → `World.fromRaw(...)`, and `fromRaw` opens
  with `if (!raw) return null;` (`gen3d/pipeline/world.ts`). Neither current implementation guards
  this — both would assign `null` straight into the module-level `physicsWorld` and take the whole
  engine down on a corrupt or version-mismatched byte array. This is a real bug in the skeleton.
- **Handles are stable across a restore, but the JS-side lookup silently discards the
  generation.** `RigidBodySet`/`ColliderSet`/`ImpulseJointSet` constructors rebuild their `Coarena`
  from `raw.forEach*Handle((handle) => ... new Wrapper(..., handle))`, and the Rust arena's
  index+generation survives serde — so the numeric handle values in
  `EngineRapier.ts`'s id→handle maps stay valid and **need no remapping**. However,
  `Coarena.index()` (`gen3d/coarena.ts`) extracts only the **low 32 bits** of the handle; its own
  source comment reads *"`this.uconv[1]` then contains the generation number … which we don't
  really need."* Consequently `Coarena.get(staleHandle)` will **silently alias** onto whatever now
  occupies that arena index rather than returning null. The generation *is* still carried on the
  returned wrapper's own `handle` field, which gives an exact, O(1) staleness test:
  **`wrapper.handle === storedHandle`**. The entire delta computation in this plan hangs off that
  one comparison.
- **JS wrapper identity is not preserved.** The set constructors build `new RigidBody(raw, null,
  handle)` / `new Collider(this, handle, null)` / `ImpulseJoint.newTyped(...)` per handle. So the
  cached `private rb` / `private coll` / `private joint` fields on the three engine proxy classes
  (`EngineRapier.ts:1203` + ctor `1229-1234`; `:1620` + ctor `1631-1635`; `:1923` + ctor
  `1936-1939`) point at freed WASM memory immediately after a restore. These are captured once at
  construction and refreshed nowhere.
- **Gravity and `integrationParameters` ARE serialized** (`takeSnapshot` passes both into
  `serializeAll`). So timestep, `numSolverIterations`, `numInternalPgsIterations` and gravity can
  silently change out from under `WorldProxyAPI._cache` (`PhysicsAPI.ts:1325-1332`) and under
  `physicsState`.
- **`fromRaw` passes 9 of the constructor's 13 raw arguments.** `ccdSolver`, `physicsPipeline`,
  `serializationPipeline` and `debugRenderPipeline` are freshly allocated (so `step()` and
  `debugRender()` still work on the restored world), while `characterControllers`,
  `pidControllers` and `vehicleControllers` become new empty Sets. The new API exposes none of
  those — they are commented out at `PhysicsAPITypes.ts:1563-1605` — so this costs nothing here.
- **Rapier-side `userData` is write-only in the new API.** It is written at
  `EngineRapier.ts:281-292` (including the `lockRotationsX/Y/Z` mirror) and `:292`, and read
  **nowhere** in `core/Physics/`, `core/PhysicsAPI.ts` or `workers/` — every other `.userData` hit
  in those files is the proxy's own `this.uData` field or a constructor pass-through. The only
  readers in the repo are legacy `core/PhysicsRapier.ts` and
  `utils/character/dynamicCharacter.ts`, both of which run against the *legacy* world, not this
  one. Rapier does not serialize `userData` — but because nothing reads it back, **no userData
  sidecar inside the snapshot is required.** The API-level `uData` lives on the engine proxy
  objects and therefore survives re-pointing for free. (This is worth stating explicitly because
  the sidecar is the obvious-looking design, and it is unnecessary here.)
- **`RigidBody.isValid()` → `rawSet.contains(handle)`**, which *does* check the generation
  Rust-side — useful as a belt-and-braces post-sweep check where the cheap handle comparison is
  not enough.

### Repo-side constraints

- **The engine's bookkeeping is id-keyed, with only two reverse maps.**
  `EngineRapier.ts:62-78` holds `rigidBodies`/`colliders`/`joints` (running id → handle),
  `rigidBodyAPIs`/`colliderAPIs`/`jointAPIs` (id → API), and `handleToColliderId`/
  `handleToJointId`. There is deliberately **no** `handleToRigidBodyId`, and this plan does not add
  one (Design decision 4).
- **Re-pointing is cheap because the proxy constructors already resolve the way the refresh pass
  needs to.** They call `getRigidBody(id)` / `getCollider(id)` / `getJoint(id)`
  (`EngineRapier.ts:106-135`), which go id → handle → `physicsWorld.getX(handle)`. After the world
  reference is swapped, those same resolvers return the new wrappers.
- **The main-thread facade keeps its own parallel state.** `PhysicsAPI.ts:181-183` id→API maps;
  `:191-192` worker event-callback registries; `:172` `transformBuffer`. `RigidBodyProxyAPI`
  (`:1787-1801`) bakes in `id` and `slot` at construction and reads pose from the transform buffer
  by slot — neither of which a restore disturbs.
- **Transform slots are allocated in the worker**, keyed by running id
  (`workers/physics/physicsSwitchRigid.ts:38-55`, freed at `:59-63`). Surviving bodies keep their
  slot for free; reaped ones must have it explicitly freed or the slot leaks and silently caps
  `maxBodies`.
- **ECS stores live API object references, not ids.** `PhysicsManager.ts:124-135`:
  `BODY_STATIC`/`BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS` hold the `RigidBodyAPI` itself,
  `COLLIDER` holds the `ColliderAPI[]`. `physicsToTransformSystem` (`:152-177`) reads `rb.pos`/
  `rb.rot` off those stored objects every frame. **This is why Design decision 1 matters so much:
  if the proxy objects survive, the ECS needs no reconciliation at all for survivors.**
- **`PhysicsManager.ts:129-134` is the only code in the repo that writes a `BODY_*` component**
  (confirmed by repo-wide grep; the only other hits are the commented-out block at
  `ECS/ECSCoreComponents.ts:216-220` and read-only call sites). It wires from *creation params*, so
  reconciliation that needs to wire ECS from an already-existing `RigidBodyAPI` has no existing
  path to reuse. Two pieces that *are* reusable: the body-bucket array already enumerated at
  `core/Debug/_dbg__PhysicsAPI.ts:70-72`, and `ECSWorld.getRigidBody(entityId)`
  (`core/ECS.ts:776-782`), which already resolves "whichever of the three buckets this entity is
  in".
- **`interpolationStates` (`PhysicsManager.ts:195`) is module-private with no exported clear.** Its
  value-comparison change detection would read a restore as one enormous step and lerp across it.
- **`messageWorkerAsync` resolves with the entire down-message object**
  (`PhysicsAPI.ts:411` → `utils/PromiseResolver.ts:18-30`). That is why `initPhysics`'s
  `messageWorkerAsync<boolean>` + `if (worldCreated)` (`PhysicsAPI.ts:221-232`) is a latent
  always-truthy bug — the object is truthy regardless. Harmless today; **do not copy the shape.**
- **Transferables are already supported worker→main but not main→worker.**
  `physicsWorker.ts:187-201`'s `sendMessage` takes an optional `transfer?: Transferable[]`, and
  `physicsSwitchColl.ts:215-221` (`COLL_VERTICES`) is the canonical copy-then-transfer template.
  `messageWorker`/`messageWorkerAsync` (`PhysicsAPI.ts:328, 333`) have no transfer parameter — and
  per Design decision 9 they deliberately still won't.

### Pre-existing bugs this plan folds in

- **Neither `restoreSnapshot` frees the world it replaces** — a whole `Rapier.World` leaks per
  restore.
- **`deletePhysicsWorld()` (`PhysicsAPI.ts:554-577`) never clears the main-thread maps.** It resets
  `physicsWorldEnabled` and `physicsWorld` but leaves `rigidBodies`/`colliders`/`joints`
  (`:181-183`) and the event registries (`:191-192`) populated, so a delete→create cycle
  resurrects stale proxies.

## Design decisions

1. **Restore re-points the existing proxy objects; it never recreates them.** Because handles are
   stable, every surviving object keeps its running id, its engine proxy instance, its main-thread
   proxy instance, its transform-buffer slot, its event registrations, and therefore its ECS
   component reference. The only thing that must change is the cached WASM wrapper inside the three
   engine proxy classes. Verified hop by hop: `PhysicsAPI.ts:641` stores the identical
   `EngineRigidBodyProxyAPI` instance the ECS component holds in `MAIN_THREAD` mode, and
   `RigidBodyProxyAPI` in `WORKER_THREAD` mode stores only `id` + `slot`, neither of which a restore
   touches. **ECS reconciliation for survivors is therefore zero work**, which is what keeps the
   rewind/replay path cheap.
2. **Rebinding is exposed as one `/** @internal */ _rebind(raw)` method per proxy class, not by
   relaxing `private`.** `_rebind(rb: Rapier.RigidBody)` on `EngineRigidBodyProxyAPI`,
   `_rebind(coll: Rapier.Collider)` on `EngineColliderProxyAPI`, `_rebind(joint:
   Rapier.ImpulseJoint)` on `EngineJointProxyAPI`. These are not added to the public
   `RigidBodyAPI`/`ColliderAPI`/`JointAPI` interfaces — they are engine-internal and called only by
   the refresh pass in the same module. Keeps the fields private and the public surface unchanged.
3. **Restore has *intersection* semantics, and that is the contract.** After a restore the world
   contains exactly `{objects alive at snapshot time} ∩ {objects the API still knows about}`:
   - **Survivors** (in both) — rebound. Exact, and free.
   - **Reaped** (known to the API, absent from the snapshot — i.e. created after it) — removed from
     every engine map and every main-thread map, transform slot freed, ECS entity deleted.
   - **Orphans** (present in the snapshot, no longer known to the API — i.e. deleted since) —
     removed from the restored world by default (`orphanPolicy: 'DELETE'`). Keeping them would
     produce invisible bodies that collide with the live scene and are unreachable from any API
     handle. `orphanPolicy: 'KEEP'` exists as the escape hatch for a future resurrection feature.

   This is the only semantics that is exact and free in the common case (membership unchanged),
   never leaves a dangling reference or an invisible collider, and requires no data Rapier does not
   already provide.
4. **No sidecar manifest, and no fourth reverse map.** This falls out of the generation test above.
   The delta is computed entirely from the restored world plus the existing id→handle maps, in one
   O(n) walk per restore:

   ```
   for each [id, handle] of rigidBodies:
     const w = newWorld.getRigidBody(handle);
     (w && w.handle === handle) ? survivor → api._rebind(w) : reaped
     claimed.add(handle)
   then: newWorld.bodies.forEach(rb => if (!claimed.has(rb.handle)) → orphan)
   ```

   The `claimed` set is local to the function and thrown away — cheaper and less error-prone than
   maintaining a persistent `handleToRigidBodyId`.
5. **`takeSnapshot()` returns a `PhysicsSnapshot` object, not a bare `Uint8Array`.** This is exactly
   what the four existing `@CHORE`s ask for, and it is free because nothing outside the physics
   files calls these methods:

   ```ts
   export type PhysicsSnapshot = {
     /** Rapier's own serialized world state. */
     bytes: Uint8Array;
     /** Which world instance produced this. Restoring into a different world is rejected. */
     worldEpoch: number;
     /** Capture timestamp, for debug UI and ordering. */
     takenAt: number;
   };
   ```

   `worldEpoch` is a module-level counter in `EngineRapier.ts`, incremented in `createWorld`
   (`:183-206`) and `deleteWorld` (`:704-733`); restore throws on a mismatch. **Without this guard,
   restoring a snapshot taken before a `deletePhysicsWorld()`/`createPhysicsWorld()` cycle would
   reap every live body and silently wipe the scene** — the hardest failure mode in this feature to
   diagnose after the fact.
6. **Rapier-side `userData` gets a cheap private mirror on the rigid-body proxy, re-applied by
   `_rebind()`.** Add `private rapierUserData?: Record<string, unknown>` to
   `EngineRigidBodyProxyAPI`, populated where `createRigidBody` already writes `rigidBody.userData`
   (`EngineRapier.ts:281-292`, including the `lockRotations*` keys). This is belt-and-braces, **not
   load-bearing** — per the Context section nothing in the new API reads it back — and it is about
   six lines. Colliders and joints need nothing: `createCollider` (`:467`) and `createJoint`
   (`:555`) only pass userData to the proxy's `uData`, never to Rapier.
7. **Cached world parameters are refreshed from the restored world, not assumed unchanged.**
   Because gravity and integration parameters are serialized, `RestoreSnapshotDelta` carries
   gravity/timestep/solver iterations read back off the restored world, and the facade writes them
   into `WorldProxyAPI._cache` (`PhysicsAPI.ts:1325-1332`) and `physicsState`. In `WORKER_THREAD`
   mode, **keep the existing `WorldProxyAPI` instance and refresh its cache** — do not
   `new WorldProxyAPI()` as `PhysicsAPI.ts:613` does today, which throws the cache away.
8. **There is exactly one engine-side implementation.** Keep the exported module-level
   `restoreSnapshot()` (it is what `EngineAPIType.restoreSnapshot` and the worker call) as the
   single implementation; `EngineWorldProxyAPI.restoreSnapshotSync` (`:860-870`) becomes a one-line
   delegation to it. Same for `takeSnapshot` (`:735`, `:853-858`). Standardise on `RAPIER`, the
   runtime-initialised namespace.
9. **Snapshot bytes are structured-cloned main→worker, and transferred worker→main.** This reverses
   the intuitive choice, so it is recorded as a decision: transferring main→worker would **neuter
   the caller's copy**, which breaks the primary use case of restoring the *same* snapshot
   repeatedly (rollback, reset-to-checkpoint, replay scrubbing). So `messageWorker`/
   `messageWorkerAsync` stay untouched — no new transfer parameter, no new pattern, no
   main→worker transferables introduced anywhere. Worker→main (`TAKE_SNAPSHOT` response) uses the
   existing `sendMessage(msg, data, false, [bytes.buffer])` support, following the `COLL_VERTICES`
   template. Snapshots are megabyte-scale, but the operation is rare rather than per-frame.
10. **The old `Rapier.World` is freed, in this exact order:** capture `old` → assign
    `physicsWorld = newWorld` → run the full rebind and orphan sweep against `newWorld` →
    `old.free()`. Freeing last keeps the failure mode benign if the sweep throws. Note one
    unavoidable upstream leak: Rapier never frees the temporary `SerializationPipeline` it
    allocates inside `World.restoreSnapshot` (a few hundred bytes per call). Document it; do not
    reimplement `restoreSnapshot` to work around it.
11. **"Coherent restore requires the ECS scene to be at the same point" is an explicit constraint,
    not a bug.** Restoring is *exact* only when no physics entity was created or deleted since the
    snapshot. Otherwise decision 3's pruning runs, which is safe and deterministic but is not a
    rewind: entities created since are destroyed, and entities deleted since do not come back. Full
    scene rewind is a non-goal (see below). In debug builds, a restore that produces a non-empty
    reaped or orphan set emits an `lwarn` naming the counts, so this never happens silently.
12. **`interpolationStates` is cleared on restore**, via a new exported
    `clearPhysicsInterpolationStates()` from `PhysicsManager.ts`. Clearing rather than patching is
    correct because `physicsInterpolationSystem` re-seeds `prev == curr` from the restored pose on
    first sight of an entity, so the restored frame renders with zero smear.
13. **The worker writes transforms back immediately at the end of the restore handler.** Otherwise
    `RigidBodyProxyAPI.pos`/`rot` keep serving pre-restore poses out of the transform buffer until
    the next `STEP` — which in a paused world is forever. The `RESTORE_SNAPSHOT` case calls the
    existing `writeBackTransforms()` and `writeBackDebugState()` (`physicsWorker.ts:205-262`) before
    replying. In `MESSAGE_BATCH` mode this also pushes the fresh buffer, which is what makes
    `useSAB: false` behave identically to `useSAB: true`.
14. **The debug-state tracked-id arrays are NOT mutated on restore.**
    `debugTrackedRigidBodyIds`/`debugTrackedColliderIds` (`physicsWorker.ts:36-37`) are positional —
    index *is* slot — so removing reaped ids would shift every subsequent slot and mis-colour the
    wireframes. `writeBackDebugState` already zeroes the flags for an id whose API is gone, which is
    the correct rendering for a reaped object, and the debug layer re-declares the full set on its
    own cadence via `setPhysicsDebugStateTracking`.
15. **Restore is announced through a registration hook, not a direct import.** `PhysicsManager.ts`
    imports `PhysicsAPI.ts`, so the reverse call has to be inverted. Add
    `registerOnPhysicsRestore(name, fn)` plus the dispatch in `PhysicsAPI.ts`, mirroring the
    existing `addVisibilityChangeFn` pattern (`PhysicsAPI.ts:524`, used at `:528`) and
    `registerOnAllSceneEnterings` (`PhysicsManager.ts:33`). `registerPhysicsManager` registers its
    reconciler there.
16. **Determinism is documented, not guaranteed.** Two separate caveats, and neither should be
    overstated in either direction:
    - *Restoring state is not the same as reproducing a run.* A snapshot restores physics state
      only. Replaying forward from a restored point reproduces the original trajectory **only if
      the caller also replays its own per-frame inputs** — applied forces and impulses, body
      creation and deletion, parameter changes — in identical order. That is the consumer's
      responsibility, and it is the most likely way a rewind feature silently "doesn't work".
    - *Cross-build/cross-platform determinism is an open question, not a settled fact.* Rapier's
      reproducibility guarantees are at best same-binary/same-platform, and whether this npm build
      enables Rust-side enhanced determinism **could not be confirmed from the
      `@dimforge/rapier3d-compat` 0.19.3 package** — it ships no Rust source, no feature manifest,
      and no mention of determinism in its typings. Phase 1 therefore includes a cheap empirical
      check rather than an assumption either way, and this stays in the risks table as an open
      question rather than being asserted as a fact anywhere.

## New / changed types (`Physics/PhysicsAPITypes.ts`)

```ts
export type PhysicsSnapshot = { bytes: Uint8Array; worldEpoch: number; takenAt: number };

export type RestoreSnapshotOpts = {
  /** What to do with objects that existed at snapshot time but are no longer known to the
   *  API (deleted since). 'DELETE' (default) removes them from the restored world. */
  orphanPolicy?: 'DELETE' | 'KEEP';
};

/** Everything the caller needs to reconcile after a restore. Identical in both thread modes. */
export type RestoreSnapshotDelta = {
  /** Known to the API but absent from the snapshot — created after it. Now destroyed. */
  reapedRigidBodyIds: number[];
  reapedColliderIds: number[];
  reapedJointIds: number[];
  /** Present in the snapshot but unclaimed — deleted since. Removed unless orphanPolicy: 'KEEP'. */
  orphanCounts: { rigidBodies: number; colliders: number; joints: number };
  /** Read back off the restored world — Rapier restores these. */
  gravity: PhysVector;
  timestep: number;
  solverIterations: number;
  internalPgsIterations: number;
};

export type RestoreSnapshotResult = RestoreSnapshotDelta & { world: WorldAPI };
```

Signature changes:

- `EngineAPIType.takeSnapshot` (`:42`) → `() => PhysicsSnapshot | undefined`
- `EngineAPIType.restoreSnapshot` (`:43`) → `(snapshot: PhysicsSnapshot, opts?: RestoreSnapshotOpts) => RestoreSnapshotResult`
- `WorldAPI.takeSnapshot`/`takeSnapshotSync` (`:1257-1258`) → `Promise<PhysicsSnapshot | undefined>` / `PhysicsSnapshot | undefined`
- `WorldAPI.restoreSnapshot`/`restoreSnapshotSync` (`:1264-1265`) → `(snapshot, opts?) => Promise<RestoreSnapshotResult>` / `RestoreSnapshotResult`
- Protocol UP `RESTORE_SNAPSHOT` (`:1962-1965`) → `{ type; snapshot: PhysicsSnapshot; opts?: RestoreSnapshotOpts }`
- Protocol DOWN `TAKE_SNAPSHOT` (`:2383-2386`) → `snapshot: PhysicsSnapshot | undefined`
- Protocol DOWN `RESTORE_SNAPSHOT` (`:2387-2390`) → `{ type; worldCreated: boolean } & RestoreSnapshotDelta`

All four `@CHORE` comments at `:1257-1265` are deleted as resolved.

## Phases

Each phase compiles clean, leaves the repo working, and is separately reviewable/committable.

**Phase 0 — Reconcile the duplicates and fix the two pre-existing bugs.** Small and
self-contained, no new feature. In `EngineRapier.ts`: collapse to one implementation per design
decision 8, add the `physicsWorld.free()` of the replaced world per decision 10, and add the
`if (!newWorld) throw` guard for the `null` return. In `PhysicsAPI.ts`: make `deletePhysicsWorld()`
(`:554-577`) clear `rigidBodies`/`colliders`/`joints` (`:181-183`), the two worker event registries
(`:191-192`), and reset `transformBuffer`/`debugStateBuffer`/`resolvedTransportMode`.

Manual verification: `physicsTest.ts` behaves exactly as before. From the console, run
`deletePhysicsWorld()` then `createPhysicsWorld()` and confirm the physics debugger tab's entity
list shows no stale entries. Both `workerTarget` modes.

**Phase 1 — Engine-side capture/restore and the rebind pass, `MAIN_THREAD` end to end.** Add the
new types (but not yet the protocol union members). In `EngineRapier.ts`: add `worldEpoch` next to
`worldCreated` (`:79`) and bump it in `createWorld`/`deleteWorld`; implement `takeSnapshot()`
returning the envelope; implement `restoreSnapshot(snapshot, opts)` as — epoch guard → restore and
null-check → swap the world reference → the decision-4 rebind/claim walk over rigid bodies, then
colliders, then joints → reaped bookkeeping mirroring what `deleteRigidBody` (`:571-613`) already
does, including `cleanupColliderEventRegistrations` (`:631-637`) → orphan sweep in the order bodies,
colliders, joints → `isValid()` safety net promoting anything that went invalid into the reaped sets
→ `eventQueue?.clear()` (the queue at `:82` may hold pre-restore handles) → `old.free()` → return
the delta with world params read off the restored world. Add `_rebind()` to the three proxy classes
and `rapierUserData` to the rigid-body one. In `PhysicsAPI.ts`: rewrite `takePhysicsSnapshot`/
`restorePhysicsSnapshot` around a single private `applyRestoreDelta(delta)` that runs identically
in both modes (prune the three maps, call the existing `cleanupWorkerColliderEventFns` per reaped
collider, write world params into `physicsState`, fire the decision-15 hooks); wire the
`MAIN_THREAD` branch only; add `registerOnPhysicsRestore` and an `isRestoringSnapshot` guard that
makes `stepPhysics` (`:292`) early-return and reset its accumulator while a restore is in flight.

Manual verification (`?isDebug=true`, `physicsTest.ts`, `MAIN_THREAD`): take a snapshot, let the
bodies fall, restore → everything snaps back and the meshes follow; delta is all-empty. Then create
a new physics entity and restore → it shows up in `reapedRigidBodyIds` and its collider in
`reapedColliderIds`. Then delete an entity and restore → `orphanCounts.rigidBodies === 1` and a
raycast where it was hits nothing. Restore twice from the same snapshot → identical result both
times (this is what proves decision 9's no-transfer stance and the `old.free()` ordering).
**Also run the decision-16 determinism check here**: capture, step N, record poses; restore, step N
again, compare. Record the outcome in this document.

**Phase 2 — Worker protocol.** Add the three protocol union changes. In `physicsWorker.ts`:
`TAKE_SNAPSHOT` replies with the transfer list per decision 9; `RESTORE_SNAPSHOT` calls
`engAPI.restoreSnapshot(data.snapshot, data.opts)`, then calls `transformBuffer?.freeSlot(id)` for
every reaped rigid body — the identical call `physicsSwitchRigid.ts:59` makes on
`DELETE_RIGID_BODY`, and **the single easiest thing to forget here, because a leaked slot fails
silently by capping `maxBodies`** — leaves `debugTracked*Ids` alone per decision 14, then calls
`writeBackTransforms()`/`writeBackDebugState()` per decision 13 before replying, and keeps
`physicsWorldAPI` pointing at `result.world`. In `PhysicsAPI.ts`: wire both `WORKER_THREAD`
branches through `applyRestoreDelta`, keep the existing `WorldProxyAPI` and refresh its cache per
decision 7, and delete the two stale `@TODO` blocks. Type the generic as the response object, never
`<boolean>`.

Manual verification: flip `CONFIG.physics.workerTarget` to `'WORKER_THREAD'` and repeat every Phase
1 check, once with `useSAB: true` and once with `useSAB: false` (the latter exercises
`TRANSFORMS_PUSH`, where decision 13's immediate write-back is what makes the restored pose visible
without stepping). Confirm pending resolver requests return to zero after each restore. Confirm slot
reuse: create → restore (reaps it) → create again, and check the new body reuses the freed slot.

**Phase 3 — ECS reconciliation (`PhysicsManager.ts`).** Export
`clearPhysicsInterpolationStates()`. Add `reconcilePhysicsEntitiesAfterRestore(delta, world?)`:
walk `world.getStorage(ComponentType.TAG_IS_PHYSICS_OBJECT)`, resolve each entity's body via
`ECSWorld.getRigidBody(entityId)` (`ECS.ts:776-782`), and if its id is in `reapedRigidBodyIds`
call `world.deleteEntity(entityId)` — the same call the debugger's delete button makes. For an
entity whose body survived but some of whose `COLLIDER` entries were reaped, filter that array in
place rather than deleting the entity. Register both via `registerOnPhysicsRestore`.
**Ordering constraint to preserve:** the facade's maps are pruned *before* the hooks fire, so when
`deleteEntity` triggers the `TAG_IS_PHYSICS_OBJECT.onDeleteEntity` hook → `disposePhysicsEntity` →
`deleteColliders`/`deleteRigidBody`, those run against already-removed ids. Confirm during
implementation that this is a benign no-op and not a throw — `EngineRapier.deleteRigidBody`'s
missing-handle path (`:575-581`) returns the same id, so `PhysicsAPI.ts`'s `deletedId !== id`
assertion is not reached. If the worker path diverges, add an `opts.skipEngineDispose` to
`disposePhysicsEntity` rather than loosening that assertion. Iterate a materialized array of entity
ids, never the live storage.

Manual verification: snapshot → `createPhysicsEntity(...)` a new body → restore → its ECS entity is
gone, its mesh is out of the scene, no console errors, and the debugger tab's entity list matches
the ECS entity count. Both thread modes, both `useSAB` settings.

**Phase 4 — Debugger tab affordance (`core/Debug/_dbg__PhysicsAPI.ts`).** A "Snapshot" folder with
`Take snapshot` / `Restore snapshot` / `Clear snapshot` buttons following the existing `addButton`
pattern (`:313`, `:320`, `:490`), holding the last `PhysicsSnapshot` in a module-local, plus a
readout of `bytes.byteLength`, `takenAt`, and the last restore's reaped/orphan counts. This is the
primary manual-verification surface for every other phase and should not be skipped — pull it
earlier if any phase proves fiddly.

Manual verification: take/restore/clear from the tab in all four configurations (`MAIN_THREAD`;
`WORKER_THREAD` × `useSAB` true/false).

## Non-goals

- **Full scene rewind / resurrecting deleted bodies.** Design decision 11. A Rapier snapshot
  contains no `RigidBodyParams`, no `Object3D` and no ECS entity, so resurrection at the physics
  layer alone would produce invisible, entity-less bodies — strictly worse than deleting them.
  `orphanPolicy: 'KEEP'` plus a creation-params sidecar inside `PhysicsSnapshot` is the door this
  plan deliberately leaves open for a follow-up.
- **Snapshots that outlive their world.** The `worldEpoch` guard rejects them. No serialization to
  disk or localStorage, no cross-reload restore, no cross-session replay.
- **Multibody joints.** Serialized by Rapier but not exposed by the new API; tracked in
  `p250_physics-api-support-for-multibody-joints.md`. When they land they will need a fourth rebind
  pass — note it there.
- **Character-controller / PID-controller / vehicle-controller state.** Not restored by
  `World.fromRaw` and not exposed by the new API (`PhysicsAPITypes.ts:1563-1605`).
- **Legacy `core/PhysicsRapier.ts`.** Owns a separate world; untouched by this plan.
- **Adding a transfer list to `messageWorker`/`messageWorkerAsync`.** Design decision 9. No
  main→worker transferables are introduced.
- **Snapshot compression, ring buffers, or a replay timeline data structure.** The consumer's
  concern, not the API's.

## Risks / open questions

| Risk / question | Notes |
|---|---|
| **The generation test is the whole design.** If `wrapper.handle` from a deserialized set ever stopped carrying the generation in its high 32 bits, reaped bodies would silently alias onto unrelated restored bodies — corruption, not a crash. | Mitigate with a debug-build assertion in the rebind pass cross-checking `isValid()` (which *is* generation-checked Rust-side) against the handle comparison. `@dimforge/rapier3d-compat` is already pinned exactly at `0.19.3`; re-verify this on any version bump. |
| **`old.free()` after rebinding.** If any code path still holds a wrapper from the old world (e.g. a `ColliderAPI` handed to a raycast callback that outlived the call), `free()` turns it into a use-after-free surfacing as a WASM trap far from the cause. | Gated by the `isRestoringSnapshot` guard and the post-sweep `isValid()` check. If a trap shows up in manual testing, the fallback is to not free the old world in v1 and accept the leak — strictly less dangerous. |
| **`deleteEntity` re-entrancy during Phase 3.** Deleting entities while iterating an ECS storage, with the delete hook firing async physics disposal. | Iterate a materialized array of entity ids, never the live storage. Gated by Phase 3's ordering constraint above. |
| **Determinism (decision 16) is unresolved and gates the rewind/replay consumer.** Restoring state is not the same as reproducing a run, and whether this Rapier build is deterministic enough cannot be answered from the npm package. | Phase 1's empirical check answers the same-machine half. If it fails, the rewind consumer needs rethinking — but the snapshot API itself would still be correct and useful for reset-to-checkpoint. |
| **Upstream leak in `World.restoreSnapshot`.** Rapier never frees the temporary `SerializationPipeline` it allocates. | Unavoidable without reimplementing `restoreSnapshot`; a few hundred bytes per call. Documented, not worked around. |
| **`useSAB: false` visibility window.** Between the restore reply and the `TRANSFORMS_PUSH` it triggers, the main thread reads stale poses. | Decision 13 puts both inside the same handler, so the window is one message hop. Confirm visually with `useSAB: false`. |
| **Snapshot cost per capture is O(world size)** and allocates a fresh `Uint8Array` out of WASM every time. | Measure in Phase 4's readout before any per-frame rewind consumer is built on top of it. |
| **No test suite exists in this repo.** | Accepted. Every phase is verified manually via `?isDebug=true`, Phase 4's tab and `physicsTest.ts`. Phase 4 is worth pulling earlier if needed. |

## Verification

- `tsc --noEmit` and `yarn lint` clean at every phase boundary (the repo's Stop hook runs both).
  Note there is no standalone typecheck script — `tsc` runs as part of `yarn build`.
- Every phase's functional verification runs in **both `workerTarget` modes**, and under
  `WORKER_THREAD` in **both `useSAB: true` and `useSAB: false`**.
- Phase 0: no behavioral change; delete→create leaves no stale proxies.
- Phase 1: the survivor / reaped / orphan matrix above, plus restore-twice-from-one-snapshot, plus
  the determinism check.
- Phase 2: the same matrix through the worker, plus resolver-pending returns to zero and transform
  slot reuse after a reap.
- Phase 3: ECS entity count and scene contents match after a restore that reaps.
- Phase 4: take/restore/clear from the debugger tab in all four configurations.
- No test suite exists in this repo and none should be added as part of this work.
