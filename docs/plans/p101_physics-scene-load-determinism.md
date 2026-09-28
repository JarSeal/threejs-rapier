Status: draft | not-implemented
Category: Physics, Bug
Related: \_DONE_p100_small-bug-fixes-and-tweaks.md (§5, where this was split out from), p500_restore-physics-snapshot.md

# Physics Scene-Load Determinism — Plan

Makes loading the same scene produce the same physics results every time, whether it is a fresh page load or a revisit (scene A → B → A), in all three physics setups (MAIN_THREAD, WORKER_THREAD with SharedArrayBuffer, WORKER_THREAD without it) and for every interpolation mode. The reported symptom is that after Gym → other scene → Gym, at least one Suzanne lands somewhere else than on the first load. The plan starts with a debug-only probe to measure this, then fixes the causes one phase at a time, so each phase's effect on the probe results can be seen.

---

## 1. Goal and non-goals

- **Goal: repeatable on the same machine.** The same scene with the same physics config gives identical body states after N fixed steps, independent of:
  - load timing (asset cache hits vs. network);
  - FPS / frame pacing;
  - interpolation mode;
  - whether the scene was visited before in the same session.
- **Goal:** MAIN_THREAD and WORKER_THREAD (± SAB) issue the same Rapier call sequence, and therefore produce the same results (see open question §6.3).
- **Non-goal: bit-identical results across platforms or browsers.** That would need `@dimforge/rapier3d-deterministic`. The current `@dimforge/rapier3d-compat` 0.19.3 runs the same WASM in both threads, so it is repeatable given the same call sequence. Revisit only if two fresh loads with the same config ever differ.
- **Non-goal: deterministic characters.** `src/toolkit/ecs/dynamicCharacter.ts` uses the wall clock (`getPhysGameTime()` at `:613, 616, 909, 932, 983`), `Math.random` (`:1242-1245`) and async shape-cast queries that resolve per frame. Step-clocked, seeded characters should get their own follow-up plan. The probe reports characters separately and they are excluded from the hash.

---

## 2. Verified causes (ranked)

### 2.1 Physics keeps stepping during async scene builds (all modes)

- `loadScene` calls `setIsLoadingScene(true)` (`src/_engine/core/SceneLoader.ts:489`), but nothing reads `loopState.isLoadingScene` (`src/_engine/core/MainLoop.ts:58, 453`).
- `stepPhysics` (`src/_engine/core/PhysicsAPI.ts:284-356`) only checks `physicsWorldEnabled`, `worldStepEnabled`, `masterPlay/appPlay` and window visibility.
- The Gym build (`src/app/scene_thirdPersonGym.ts`) spans many frames of awaited imports. Bodies created early are already falling when later ones are created. Example: the imported cube and `test_multi_box.glb` both spawn at (2,2,2), and where the multi box lands depends on how far the cube has fallen by then.
- **The first boot differs only by accident.** `InitApp.ts:118-122` awaits `appStartFn` (including the first `loadScene`) before `initMainLoop()`, so the first scene is fully built before step 0.
- `src/index.ts:71` boots `sceneTestECS`, so in the reported case both gym loads happened with the loop running. The first fetched the assets, the second hit the cache, so the step offsets differed.
- `accDelta` (`PhysicsAPI.ts:668`) carries over into the next scene. It is only reset on resume-from-pause (`:328`) and at the sub-step ceiling (`:351`).

### 2.2 The Rapier world is reused across scenes (all modes)

- `createPhysicsWorld()` runs once (`InitApp.ts:91-94`), and `EngineRapier.ts:198` returns early: `if (worldCreated) return physicsWorldAPI;`. Scene switches only call `deleteAllPhysicsEntities()`.
- Rapier's arenas (freed handle slots get reused), broadphase tree, narrow-phase contact graph and island sets keep their history. The solver is order-dependent, so even perfect timing would not reproduce a first load bit-for-bit.
- `deletePhysicsWorld()` exists (`PhysicsAPI.ts:844`) but has no callers, and it is incomplete:
  - it leaves the main-thread `rigidBodies`/`colliders`/`joints` maps, the worker event-callback maps and `transformBuffer` in place (also noted in `p500`);
  - `EngineRapier`'s world deletion drops `eventQueue` without calling `free()`, which leaks WASM memory;
  - `createPhysicsWorld` only resets `pendingEventPushes` in the SAB branch (`PhysicsAPI.ts:820-826`).

### 2.3 Stale pose without SAB (WORKER_THREAD, MESSAGE_BATCH)

- `RigidBodyProxyAPI.pos`/`rot` (`PhysicsAPI.ts:2155-2170`) read the last pushed copy of the transform buffer. The worker only pushes a copy after a STEP.
- `PhysicsTransformBuffer.freeSlot` (`src/_engine/core/Physics/PhysicsTransformBuffer.ts:124-129`) doesn't clear the slot, and freed slots are reused LIFO. A new body can read **a deleted body's pose** until the next push arrives.
- The gym helper `setImportedRigidBodyTranslationPartial` (`scene_thirdPersonGym.ts:57-67`) fills omitted axes from `body.pos`. The stairs (`:139`) and the big wall (`:146`) omit `z`, so they can shift, and Suzanne at (4,2,3) lands on the stairs.
- On a brand-new world before the first push, `pos`/`rot` read as origin / zero quaternion, and `createPhysicsEntity` writes that into `TRANSFORM` (`src/_engine/core/PhysicsManager.ts:216-217`).
- SAB mode writes the slot at creation (`src/_engine/workers/physics/physicsSwitchRigid.ts:35-43`), and MAIN_THREAD reads live values, so neither is affected.

### 2.4 Worker-only ordering races

- `createPhysicsEntity` awaits `createRigidBody` and then `createColliders` as two separate RPCs (`PhysicsManager.ts:181-205`). A STEP can be posted in between, so a dynamic body is stepped without colliders. The spinning box's `angvel` rotates it freely during that gap.
- Deletion is fire-and-forget (`PhysicsManager.ts:108-116`), and `disposePhysicsEntity` (`:270-275`) posts DELETE_COLLIDERS, then DELETE_RIGID_BODY only after the reply. So body deletions interleave with the next scene's creates, which changes handle reuse.
- The gym's five moving platforms are created fire-and-forget (`scene_thirdPersonGym.ts:414, 447, 487, 526, 565`).
- In MAIN_THREAD mode all of this is synchronous and runs in call order.

### 2.5 Not a cause: interpolation

`physicsInterpolationSystem` (`PhysicsManager.ts:552-775`) only writes `Object3D.position/quaternion`. No path feeds the Object3D pose back into physics. Interpolation settings can only change results indirectly, through frame timing, and that stops mattering once §2.1 is fixed. The probe confirms this empirically.

---

## 3. Phases

Each phase is non-breaking and can be committed on its own. Run the P0 probe matrix (§4) after each phase and record the results in this plan.

### P0: Determinism probe (debug only)

- New `src/_engine/core/Debug/_dbg__PhysicsDeterminism.ts`, lazy-loaded through `loadDebugModuleAsync`, following the `_dbg__` pattern.
- Arming: `?physicsProbe=N` in the URL, or a "Probe N steps" button in the Physics API debug tab (`_dbg__PhysicsAPI.ts`). It re-arms on every scene enter (`registerOnAllSceneEnterings`).
- `PhysicsAPI.ts`: `setPhysicsStepLimit(n | null)`, only active in `IS_DEBUG_ENV`. `stepPhysics` clamps `stepsTaken` to the steps remaining and zeroes `accDelta` while clamped, which freezes the simulation at exactly step N in both modes. In worker mode, wait until `getPhysicsSnapshotStepIndex() === N` before reading.
- Hash: every `BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS` body's translation, rotation, linvel and angvel.
  - Values are hashed as Float32 bits with FNV-1a. Rapier works in f32, so main-thread and worker-buffer values are directly comparable.
  - Bodies are keyed by `appId`, falling back to creation order within the scene.
  - Characters are listed separately and not hashed.
- Output:
  - one summary line, `scene | workerTarget/resolved transport | interpolationMode | N | hash`;
  - a `console.table` of the bodies;
  - a diff against the last stored run for the same scene and N (localStorage), naming the first body that differs and the largest position delta.
- Until P1 lands, count N from the step index at scene enter.

### P1: Hold physics during scene loads

- `PhysicsAPI.ts`: `holdPhysicsStepping()` / `releasePhysicsStepping()`, with a new `pauseReason` value `'SCENE_LOAD'` (`src/_engine/core/Physics/PhysicsAPITypes.ts`).
  - `stepPhysics` returns early while held.
  - Release reuses the existing resume path (discard the dt, `accDelta = 0`, `simClockEpoch++`). This also covers the first boot, where `stepPhysics` never sees the hold.
- Add a FLUSH round-trip RPC (the worker replies immediately) as an ordering barrier.
- `PhysicsManager.ts`:
  - track in-flight `createPhysicsEntity` promises;
  - add `settlePendingPhysicsEntities()`, which loops until the set is empty and then flushes. This catches fire-and-forget creates like the gym's platforms.
  - `disposePhysicsEntity`: when a body exists, send a single `deleteRigidBody` (Rapier removes its colliders, and the reply returns their ids). Deletes are then in order.
- `SceneLoader.ts`:
  - hold right after `setIsLoadingScene(true)` (`:489`);
  - release after `runOnAllSceneEnters()` (`:554`) and `await settlePendingPhysicsEntities()`, before `loadEndFn`;
  - wrap it in `try/finally` so the error path releases too.

### P2: Fresh physics world per scene load

- `PhysicsAPI.ts`:
  - `resetPhysicsWorld()`: flush → `deletePhysicsWorld()` → `createPhysicsWorld()`.
  - Fix `deletePhysicsWorld()` to clear the body/collider/joint maps, the event-callback maps, `pendingEventPushes`, `transformBuffer` and `accDelta`.
  - Make `deleteRigidBody`/`deleteColliders` a quiet no-op for unknown ids or when no world exists.
- `EngineRapier.ts`:
  - call `eventQueue?.free()` when the world is deleted;
  - document that the running body/collider id counters must never be reset, so a stale id from the old world can never hit a new body.
- `src/_engine/workers/physicsWorker.ts` (DELETE_WORLD): reset `transformBuffer`, `stepsExecuted` and the debug state buffer. CREATE_WORLD already reallocates the SAB.
- `SceneLoader.ts`: `await resetPhysicsWorld()` after `ecsWorld.clearNonPersistent()` (`:518`), inside the P1 hold.
- Settings: new worlds use the current `physicsState` (gravity, solver iterations, timestep), so debug-tab edits carry over.
- Cost: a few ms and about 106 KB of SAB per load.

### P3: Correct poses without SAB

- The CREATE_RIGID_BODY / CREATE_RIGID_BODIES replies (`physicsSwitchRigid.ts`) include the pose Rapier reports for the new body.
- The `RigidBodyProxyAPI` constructor seeds `pendingPos`/`pendingRot` from it, with `visibleAt = getWriteVisibleStep()`, so reads are correct before the first push.
- `PhysicsTransformBuffer.freeSlot` zeroes the slot.

### P4: Atomic body + collider creation in the worker

- New protocol message `CREATE_PHYSICS_ENTITY` (body + colliders in one message). The handler fills in `parentId` and returns the ids, the slot and the pose.
- It is posted synchronously when `createPhysicsEntity` is called, so worker creation order equals MAIN_THREAD order, and a STEP can never land between a body and its colliders. This also matters for runtime spawns outside loads.
- Files: `PhysicsAPITypes.ts`, `PhysicsAPI.ts`, `physicsSwitchRigid.ts`, `PhysicsManager.ts`.

### P5: Scene cleanup and docs

- Gym: `await` the `createMovingPlatform` calls. Add a local flag to disable the characters while probing.
- `.claude/CLAUDE.md` Physics section: document that stepping is held and the world is recreated on every scene load. Document the rule that physics writes go in `APP_PHYSICS_STEP` or during a load.
- Note the follow-up plan for step-clocked, seeded characters (§1).

---

## 4. Verification matrix

Configs (use the debug-tab boot overrides for worker target / SAB):

| Mode | Transport | Interpolation |
| --- | --- | --- |
| MAIN_THREAD | n/a | NONE, FIXED_PHYSICS |
| WORKER_THREAD | SAB | NONE, RENDERER |
| WORKER_THREAD | no SAB (`useSAB: false`) | NONE, RENDERER |

Plus one run with a maxFPS cap and one with a changed play speed. Neither may change the result.

For each config, compare a **fresh page load of the gym** (gym as the debug start scene) with a **revisit** (gym → another scene → gym). Probe at N = 300 and N = 1200.

Expected:
- Before P1: revisits differ.
- After P2: all hashes are equal within each mode.
- After P3 + P4: equal across all modes. The only exception is a character touching a body, which the per-body diff shows.

Drive the runs and collect the probe lines with the run-aekasha-js skill.

---

## 5. Risks

- **Persistent physics entities** (a body meant to survive scene switches) are incompatible with P2. None exist today (`deleteAllPhysicsEntities` removes everything). If one is ever needed, see the opt-out in §6.2.
- Debug undo entries or wireframe tracking may still point at old body ids after P2. They must fail harmlessly (no-op), not throw.
- P1 visibly freezes physics during `loadStartFn` (the loader fade-in). This is acceptable because the loader covers the scene.
- A stale RPC reaching the worker after its world was freed would log an error. The P1/P2 flush barrier prevents this.

## 6. Open questions

1. Release the hold before or after `loadEndFn` (loader fade-out)? Before means physics is already running when the scene becomes visible. The default proposal is before.
2. Add a `LoadSceneProps.keepPhysicsWorld` opt-out for future persistent physics entities, or wait until one exists?
3. Is identical output **across** MAIN_THREAD and WORKER_THREAD a goal (it needs P4), or is repeatability within one mode enough?
4. Should the probe also hash `TRANSFORM` (the ECS copy) to catch sync bugs, or only physics state?
