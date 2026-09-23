Status: draft | not-implemented
Category: Physics
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Refactor Old Physics Objects to ECS Physics Entities — Plan

Migrates every legacy physics call site off `src/_engine/core/PhysicsRapier.ts` (mesh-coupled,
always main-thread) onto the engine-agnostic ECS Physics API (`PhysicsAPI.ts` +
`Physics/EngineRapier.ts` + `PhysicsManager.ts`'s `createPhysicsEntity`), closes the one real
capability gap the migration exposes (shape-casting), and deletes `PhysicsRapier.ts` entirely in
the final phase. Along the way, the legacy scenes this migration touches (`scene01`, `scene01_v2`,
`scene_thirdPersonGym`) gain a `*.scene.json` so they appear in the debugger's scene listing like
every other scene already does.

## Context (grounded in code)

- **18 files import `PhysicsRapier.ts`** (confirmed by repo-wide grep; `Physics/EngineRapier.ts`,
  `PhysicsAPI.ts`, `toolkit/geometry/generateTerrain.ts` only *mention* it in comments), grouped by
  what they need from it:
  - **Bootstrap/loop/lifecycle (9)**: `InitApp.ts` (`InitRapierPhysics`), `MainLoop.ts`
    (`stepPhysicsWorld`/`renderPhysicsObjects` every frame), `Scene.ts`/`SceneLoader.ts` (teardown:
    `deletePhysicsObjectsBySceneId`/`deleteAllPhysicsObjects`/`deleteAllScenePhysicsLoopers`),
    `ImportModel.ts` (`createPhysicsObjectWithMesh`/`WithoutMesh` — the GLB→physics pipeline),
    `Debug/_dbg__MainLoop.ts`, `Debug/_dbg__OnScreenTools.ts`, `Debug/_dbg__Character.ts`,
    `utils/PhysicsStressTest.ts`.
  - **Character controller (4)**: `Character.ts` (scaffolding), `utils/character/dynamicCharacter.ts`
    (the complex one, see below), `utils/world/characterTestObjects.ts` /
    `characterTestObstacles.ts` (FIXED-body obstacle-course pieces).
  - **World objects (2)**: `utils/world/movingPlatform.ts` (kinematic POS_BASED, keyframed paths),
    `utils/cameras/followObjectCameraRig.ts` (ties camera smoothing to the physics tick via
    `addScenePhysicsLooper`, owns no body itself).
  - **App scenes (3)**: `app/scene01.ts`, `app/scene01_v2.ts` (basic FIXED/DYNAMIC/TRIMESH+CCD demos),
    `app/scene_thirdPersonGym.ts` (the flagship legacy scene — two custom characters, ~15 imported
    GLBs including compound/TRIMESH/HEIGHTFIELD/CONVEXHULL variants, 6 keyframed moving platforms,
    the stress-test spawner).
- **The new API already covers everything except shape-casting.** Verified directly against the
  code, not assumed:
  - Multi-collider ("compound") bodies are already first-class:
    `PhysicsManager.createPhysicsEntity(colliderParams: ColliderParams | ColliderParams[], ...)`
    (`PhysicsManager.ts:61-62`) accepts an array and parents every collider to the same rigid body
    (`:92-93`). No new engine work needed for compound objects.
  - `createPhysicsEntity`'s `target` param (`PhysicsManager.ts:71`, `number` overload) attaches
    physics components to an **already-existing** entity instead of creating a new one — this is
    exactly what `ImportModel.ts`'s pipeline needs (one GLB import already creates one mesh entity;
    physics should attach to it, not spawn a second entity).
  - The legacy `switchPhysicsCollider(id, newIndex)` (`PhysicsRapier.ts:1157-1181`, used by
    `dynamicCharacter.ts:448` for its crouch swap) works by calling
    `obj.collider[currentIndex].setEnabled(false)` / `newCollider.setEnabled(true)` — and
    `ColliderAPI.setEnabled`/`isEnabled`/`isEnabledSync` are **already fully implemented** in the new
    API, both engine-side (`EngineRapier.ts:1719-1720`) and facade-side (`PhysicsAPI.ts:2725`,
    protocol `COLL_IS_ENABLED`). No new engine work needed for the crouch-swap either.
  - Sensors + collision events (`dynamicCharacter.ts:496,552`'s `collisionEventFn` on wall/floor
    sensor colliders) are fully implemented (`_DONE_p023_physics-api-events.md`).
  - **Shape-casting is the one real gap.** `dynamicCharacter.ts:1149` calls raw
    `RAPIER.World.castShape(...)` directly (bypassing `PhysicsRapier.ts`'s own exports) for wall-hit
    (`getWallHitFromShapeCast`, line 314) and is the only mechanism used for wall/floor normal
    detection. The new API has `castRay`/`castRaySync` fully implemented
    (`Physics/PhysicsAPITypes.ts:1438-1461`, filter-flags/groups/exclude/predicate signature) but
    `castShape`/`intersectionsWithShape` are commented-out TODOs (`PhysicsAPI.ts:1684,1768,1777,1791`)
    — never implemented in the facade, backend, protocol, or worker switchboard.
  - Collider shapes used today (CUBOID, BALL, CAPSULE, CONE, CYLINDER, TRIMESH, HEIGHTFIELD,
    CONVEXHULL, TRIANGLE) are all already supported by `ColliderParams`.
- **`ImportModel.ts`'s physics pipeline** (`ImportModel.ts:256,849`) reads Blender custom properties
  off imported GLBs into a `ColliderParams[]`/`RigidBodyParams` shape, sets
  `physParamsObj.isCompoundObject = true` when more than one collider prop is present (`:822`), and
  has a `HEIGHTFIELD` branch (`:720`) that infers `nrows`/`ncols` from a square root of vertex count
  and remaps Three.js Y-up ordering into Rapier's grid layout — fragile, geometry-dependent logic
  that must be ported verbatim, not rewritten.
- **The debugger scene listing has no allowlist.** `Scene.ts:722`'s `registerScenesFromGeneratedData()`
  and both the old (`Debug/_dbg__DebugTools.ts:186-211`) and on-screen
  (`Debug/_dbg__OnScreenTools.ts:213-249`) scene dropdowns are populated purely from
  `getGeneratedAppData().scenes`, itself built from every `*.scene.json` under `src/app/` at build
  time (`vite.config.ts`'s `sceneGathererPlugin` → `devTools/gatherAppData.ts`). `scene01.ts`,
  `scene01_v2.ts`, and `scene_thirdPersonGym.ts` have **no matching `.scene.json`** today, which is
  why none of them show up in either listing. The exact template to replicate already exists:
  `physicsTest.scene.json` pairs a thin JSON file (`id`, `sceneFile: "./physicsTest.ts"`, `name`,
  `description`, `cameras`, `lights`) with the existing imperative `.ts` scene-builder function — no
  JSON re-authoring of meshes/physics is needed, the `.ts` file keeps doing the real work.
- **`docs/analysis/physics-api-state.md`** (dated 2026-09-17, before the `_DONE_p020`–`p026` plans
  landed) is now stale for everything it flagged as unfinished — stepping, the hot path, events,
  `createPhysicsEntity`, joints, and debug drawing are all implemented and working per the current
  git history and the two explore passes behind this plan. It's still useful for the architecture
  diagram and file inventory in its §2/§6, but treat its §3/§4 gap list as historical, not current.
- **`docs/plans/p050_input-system-refactoring.md`** independently flags `dynamicCharacter.ts`'s
  per-tick movement — applied synchronously inside `addScenePhysicsLooper`, coupled to
  `getPhysicsState().timestepRatio` — as the highest-risk piece to migrate off the legacy system.
  This plan's Phase 6 is where that risk lands.
- **Debug editor UI is an accepted, explicit drop, not a gap to close.** `PhysicsRapier.ts`'s
  `buildPhysicsDebugGUI`/`createEditPhysObjContent` (a live Tweakpane property editor per physics
  object) has no new-API equivalent and none is being built — the already-implemented physics
  debugger tab (`_DONE_p022_physics-debugger-tab.md`) and per-entity wireframe visualizer
  (`_DONE_p025_debug-drawing-in-physics-api.md`) are the intended replacement. Confirmed with the
  user.

## Design decisions

1. **Phase order follows the dependency graph, not the importer list order.** Close the
   shape-casting gap first (nothing downstream needs anything else new); port the two simple demo
   scenes next to prove the basic create/list pattern cheaply; port `ImportModel.ts` before anything
   that imports GLBs with physics, since it's the shared pipeline every subsequent phase's assets
   flow through; port world objects and the character controller (now unblocked) before the one
   scene that assembles all of them; clean up bootstrap/debug call sites once nothing else needs the
   legacy world; delete `PhysicsRapier.ts` last.
2. **`castShape`/`castShapeSync` are added to `WorldAPI` following `castRay`'s exact pattern** —
   same facade/backend/protocol/worker-switchboard shape (`PhysicsAPI.ts` → `EngineRapier.ts` →
   `Physics/PhysicsAPITypes.ts` protocol enum → `workers/physics/physicsSwitchWorld.ts`), same
   filter-flags/groups/exclude/predicate parameters, returning normal + time-of-impact +
   hit-collider-id. This is additive only; nothing existing changes shape.
3. **`addScenePhysicsLooper` is replaced by ordinary ECS systems, not a ported looper-list
   mechanism.** CLAUDE.md is explicit that new manager-like code should favor ECS patterns over
   reintroducing non-ECS managers. `movingPlatform.ts`'s keyframe-driven kinematic movement becomes
   an `APP_PRE_PHYSICS` system (write target pose before the step); `followObjectCameraRig.ts`'s
   camera-follow becomes an `APP_POST_PHYSICS`-or-later system (read the fresh transform after the
   step); `dynamicCharacter.ts`'s per-tick movement application becomes the same shape. Scene-scoping
   falls out for free: physics entities are already deleted on scene exit via the existing
   `TAG_IS_PHYSICS_OBJECT.onDeleteEntity` hook (`PhysicsManager.ts:39-48`), so a system that queries
   "entities with this component" naturally stops finding anything once the scene's entities are
   gone — no per-scene registration/deregistration bookkeeping to port.
   **Amended:** per-frame `APP_PRE_PHYSICS` turned out to be the wrong cadence for the platform and
   character systems (legacy loopers ran once per fixed sub-step; per-frame ticks jittered platforms
   and over/under-turned riders at refresh rates ≠ the physics rate). Both now run in the dedicated
   per-sub-step `APP_PHYSICS_STEP` stage instead; the camera rig stays per-frame post-physics.
4. **`ImportModel.ts` attaches physics to the entity it already creates for the mesh**, via
   `createPhysicsEntity(colliderParams, rigidBodyParams, existingEntityId)` — preserving "one GLB
   import = one ECS entity" rather than the two-object (mesh + separate `PhysicsObject`) shape the
   legacy system used.
5. **Legacy scenes get a `*.scene.json` at the point each is ported**, not as a separate pass —
   `scene01`/`scene01_v2` in Phase 1, `scene_thirdPersonGym` in Phase 7 — copying
   `physicsTest.scene.json`'s `sceneFile`-pointer shape exactly. This is what satisfies "old scenes
   should be made available to the debugger scene listing."
6. **Both physics worlds coexist until Phase 9.** Every phase before the last leaves
   `PhysicsRapier.ts` importable and the tree compiling (per CLAUDE.md's Workflow: "Leave the tree
   compiling"); each phase fully cuts its object(s) over to the new world rather than leaving one
   foot in each — mixing a raycast/character check against the old world with a body that now lives
   in the new world would be a silent bug, not a compile error.

## Phases

Each phase compiles clean and is separately reviewable/committable.

**Phase 0 — Shape-casting in the Physics API.** Add `castShape`/`castShapeSync` to `WorldAPI`
(`Physics/PhysicsAPITypes.ts`, next to `castRay`/`castRaySync`), implement in `EngineRapier.ts`
(thin wrapper over `RAPIER.World.castShape`, converting the id-based `filterExcludeRigidBody`/
`filterExcludeCollider` params the same way `castRay` already does), add the protocol message pair
and `physicsSwitchWorld.ts` handler, and wire both `MAIN_THREAD`/`WORKER_THREAD` branches in
`PhysicsAPI.ts`'s `WorldProxyAPI`. Add one worked example to `physicsTest.ts` (a shape-cast against
the existing test scene's ground box) so the feature is exercised and visually verifiable, matching
the precedent set by `_DONE_p026`'s joint examples.

Manual verification: in `physicsTest.ts` (`?isDebug=true`), confirm the shape-cast example reports a
hit with a sane normal/TOI against the ground box, and reports no hit when cast away from it. Both
`workerTarget` modes.

**Phase 1 — Port `scene01.ts` and `scene01_v2.ts`.** Replace `createPhysicsObjectWithMesh`/
`WithoutMesh` calls with `createPhysicsEntity`, covering FIXED ground, DYNAMIC box/sphere/cylinder,
and the TRIMESH-with-CCD dynamic body. Add `scene01.scene.json`/`scene01_v2.scene.json` following
`physicsTest.scene.json`'s template so both appear in the debugger scene listing.

Manual verification: load each scene from the debugger's scene dropdown, confirm bodies fall/settle
identically to the legacy behavior (visually), no console errors, `tsc`/`lint` clean.

**Phase 2 — Port `utils/PhysicsStressTest.ts`.** Replace its `createPhysicsObjectWithMesh` box
spawner with `createPhysicsEntity`. Small and mechanical; also functions as a bulk-creation
smoke test ahead of the busier gym scene.

Manual verification: run the stress test from `scene_thirdPersonGym.ts` (still legacy at this
point — call it standalone or from a temporary hook) and confirm box count/behavior matches the
legacy spawner, no frame-time cliff.

**Phase 3 — Port `ImportModel.ts`'s physics pipeline.** Replace `createPhysicsObjectWithMesh`
(`:256,849`) with `createPhysicsEntity(colliderParams, rigidBodyParams, meshEntityId)` per design
decision 4, preserving: the `isCompoundObject`/multi-collider-prop path (now just a
`ColliderParams[]`, no special-casing needed per context), the TRIMESH/CONVEXHULL paths, and the
HEIGHTFIELD row/col-derivation branch ported verbatim (per design decision on fragility). Remove the
now-dead `PhysicsParams`/`isCompoundObject` legacy-shape plumbing once nothing constructs it.

Manual verification: re-import each physics-tagged GLB type used in the gym scene (plain TRIMESH
stairs, "Compound" multi-collider stairs, terrain HEIGHTFIELD, CONVEXHULL Suzanne) into a scratch
scene one at a time; confirm collision shape matches the mesh visually (toggle the new per-entity
debug wireframe) and physics behaves the same as the legacy import for each.

**Phase 4 — Port `utils/world/movingPlatform.ts` and `utils/cameras/followObjectCameraRig.ts`.**
Per design decision 3: kinematic POS_BASED bodies via `createPhysicsEntity`, keyframe-path movement
and camera-follow smoothing each become an ECS system (`APP_PRE_PHYSICS` / post-physics
respectively) registered once, not per scene.

Manual verification: a scratch scene with one of each of the gym's 6 platform variants (slider,
elevator, 3 carousels, ferris-wheel loop) moves along its original keyframe path; a camera rig
follows a moving test body smoothly with no per-frame jitter.

**Phase 5 — Port `Character.ts`, `utils/world/characterTestObjects.ts`, `characterTestObstacles.ts`.**
The scaffolding and FIXED-body obstacle-course pieces (stairs/wall/ramp) — straightforward
`createPhysicsEntity` ports, no new capability needed.

Manual verification: obstacle-course pieces present and collidable in a scratch scene.

**Phase 6 — Port `utils/character/dynamicCharacter.ts`.** The highest-risk phase (p050's
assessment). Compound rigid body via `createPhysicsEntity(ColliderParams[])`: walk capsule, crouch
capsule, wall-sensor capsule, floor-sensor ball. Crouch swap via `ColliderAPI.setEnabled`. Wall/floor
normal detection via Phase 0's `castShape`. Sensor collision handling via the existing events API.
Per-tick movement (`setLinvel`/rotation) moves from `addScenePhysicsLooper` into an `APP_PRE_PHYSICS`
ECS system per design decision 3 — this is the piece most likely to need iteration to match feel,
since it changes exactly where in the frame the movement gets applied relative to the physics step.

Manual verification: walk, run, jump, crouch (and un-crouch), collide with a wall (confirm
`isNearWall`/tumbling-state trigger still fires at the same relative-velocity threshold), and land on
ground/platforms — compare feel directly against the legacy character in the still-legacy gym scene
before Phase 7 cuts it over. Both `workerTarget` modes.

**Phase 7 — Port `app/scene_thirdPersonGym.ts`.** Wires together Phases 2–6: ~15 imported GLBs
(Phase 3), 6 moving platforms (Phase 4), two dynamic characters — one player-controlled, one
scripted (Phase 6), the stress-test spawner (Phase 2). Add `thirdPersonGym.scene.json` (`sceneFile`
pointer, per design decision 5) so it appears in the debugger listing — this is the concrete
deliverable for "old scenes should be made available to the debugger scene listing."

Manual verification: full playthrough — walk the whole gym, ride every platform variant, cross every
imported-mesh surface (plain vs. compound stairs, spiral stairs, spiked/smooth terrain, obstacles
pack, both Suzanne variants), trigger the stress test, confirm the scripted character's
jump/move/rotate script still runs. Compare against the legacy scene side-by-side if both are still
reachable at this point (they won't be after Phase 9 removes the legacy import, but Phases 1-7 keep
both compiling).

**Phase 8 — Cut over bootstrap/debug-tooling call sites.** `InitApp.ts` (remove
`InitRapierPhysics()` — the new system's own boot path already coexists), `MainLoop.ts` (remove
`stepPhysicsWorld`/`renderPhysicsObjects`), `Scene.ts`/`SceneLoader.ts` (remove
`deletePhysicsObjectsBySceneId`/`deleteAllPhysicsObjects`/`deleteAllScenePhysicsLoopers` — physics
entity cleanup on scene exit already happens via ECS entity deletion +
`TAG_IS_PHYSICS_OBJECT.onDeleteEntity`), `Debug/_dbg__MainLoop.ts`, `Debug/_dbg__OnScreenTools.ts`,
`Debug/_dbg__Character.ts` (swap `getPhysicsState`/`getPhysicsObject` calls for the new API's/ECS
equivalents).

Manual verification: full app boot, scene switching, and debug-drawer frame-stepping all work with
zero references to `PhysicsRapier.ts` left outside the file itself (confirm via grep).

**Phase 9 — Delete `PhysicsRapier.ts`.** Remove the file and any now-dead legacy-only types it was
the sole consumer/producer of (`PhysicsObject`, `ScenePhysicsLooper`, etc., confirmed dead via grep
first). Repo-wide grep for `PhysicsRapier` returns zero hits outside git history.

Manual verification: `yarn build` succeeds end to end; full manual pass through every scene touched
by this plan one more time.

## Non-goals

- **Rebuilding the legacy live physics-object property-editor UI.** Explicitly dropped in favor of
  the already-implemented debugger tab (`_DONE_p022`) and per-entity wireframe visualizer
  (`_DONE_p025`). Confirmed with the user.
- **Multibody joints, snapshot/restore, round/compound-primitive/polyline collider shapes.** None of
  these are used by any of the 18 legacy importers today (confirmed by grep), so this migration
  doesn't need them. Tracked separately (`p250_physics-api-support-for-multibody-joints.md`,
  `p500_restore-physics-snapshot.md`) if ever needed.
- **A native Rapier `KinematicCharacterController`.** The legacy system never used one either —
  `Character.ts`/`dynamicCharacter.ts` implement a custom controller on plain rigid bodies/colliders,
  and this plan ports that same approach, not a switch to Rapier's built-in one.
- **Consolidating `scene01.ts`/`scene01_v2.ts`**, or any other scene-content cleanup beyond swapping
  the physics calls and adding a `.scene.json`. Out of scope for a physics migration.
- **Worker-mode classic `debugRender()` line buffers** (still throws in `WORKER_THREAD` mode per
  `PhysicsAPI.ts:1397-1399`). Not needed — the per-entity wireframe system already covers debug
  visualization in both thread modes.

## Risks / open questions

| Risk / question | Notes |
|---|---|
| `dynamicCharacter.ts`'s movement-timing migration (Phase 6) is the piece most likely to need iteration, per `p050_input-system-refactoring.md`'s own risk assessment. | Verify feel side-by-side against the still-legacy character before Phase 7 cuts the gym scene over, not just after. |
| HEIGHTFIELD import logic (Phase 3) is fragile (inferred grid dimensions, Y-up remapping). | Port verbatim, don't refactor; verify against the exact terrain GLBs already in the gym scene, not synthetic ones. |
| Two physics worlds run in parallel through Phase 8; a half-migrated object (body in new world, some check still against the old world) would be a silent behavioral bug, not a compile error. | Each phase must fully cut its object(s) over — no partial migrations left dangling between phases. |
| No test suite exists in this repo. | Accepted — every phase is manually verified via `?isDebug=true` and the affected scene(s), per repo convention (see `_DONE_p026`, `p500`). |
| `castShape`'s exact Rapier parameter surface (target distance, stop-at-penetration, shape velocity) needs to cover what `dynamicCharacter.ts:1149-1161` actually passes, not just a generic subset. | Phase 0 should be written against that exact call site's needs, then generalized — not designed in the abstract first. |

## Verification

- `tsc --noEmit` and `yarn lint` clean at every phase boundary (the repo's Stop hook runs both;
  there is no standalone typecheck script — `tsc` runs as part of `yarn build`).
- Every phase touching worker-reachable code is verified in both `workerTarget` modes
  (`MAIN_THREAD`/`WORKER_THREAD`); Phase 0 and Phase 6/7 additionally get a pass under both
  `useSAB: true` and `useSAB: false`.
- Phase-by-phase functional verification as described per phase above — no test suite exists and
  none should be added as part of this work.
- Final check (Phase 9): repo-wide grep for `PhysicsRapier` returns zero hits outside git history;
  `yarn build` succeeds; full manual playthrough of every scene this plan touched
  (`physicsTest`, `scene01`, `scene01_v2`, `thirdPersonGym`).
