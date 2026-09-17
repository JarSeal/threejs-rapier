Status: implemented
Category: Physics, ECS
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Main Thread Physics API MVP — Plan

Make the engine-agnostic `PhysicsAPI.ts` / `EngineRapier.ts` / `PhysicsAPITypes.ts` stack actually work end-to-end in main-thread mode: strip the dead `PhysicsObject`-shaped code copy-pasted from `PhysicsRapier.ts` that was never finished/adapted, implement the missing `step()`/hot-path wiring, build a `PhysicsManager.ts` create/delete entity ecosystem mirroring `MeshManager.ts`/`CameraManager.ts`/`LightManager.ts`, and validate all of it with a new test scene (static ground box + a falling ball + a falling box). This is an **additive, parallel system**: `PhysicsRapier.ts` and its 17 existing importers (`scene01.ts`, `Character.ts`, `MainLoop.ts`'s old step/render calls, etc.) are explicitly untouched and keep running the current app exactly as today — confirmed with the user as the intended scope. Migrating those importers to the new API is deliberately deferred to a future plan (§6).

Related context: `docs/plans/_DONE_p090_large-ecs-test-world-scene.md` flags that `PhysicsRapier.ts` is expected to be replaced "soon (a separate upcoming plan)" — this is that plan. `docs/plans/p200_component-query-caching.md` §2.3 already analyzed the commented-out `createPhysicsEntity` sketch this plan finishes, and concluded no compound-query cache is needed under this design — no conflict.

---

## 1. Goal

Get a **main-thread-only**, engine-agnostic physics pipeline actually running: init → create world → create ECS physics entities (ground/ball/box) → step every frame → see the ball and box fall onto the ground and come to rest, in the running app — while `PhysicsRapier.ts` keeps powering all currently-working scenes unchanged. Worker-thread mode, SharedArrayBuffer, events, debug visualization, and joints are all deliberately deferred (§6).

## 2. Current state (grounded in code)

**`src/_engine/core/PhysicsAPI.ts`** (3649 lines, 0 importers, does not compile — 67 `tsc` errors): really two unfinished systems glued into one file.

- Lines 142–1494: **legacy block**, copy-pasted near-verbatim from `PhysicsRapier.ts`, referencing types/globals that don't exist on this file's contract — this is what the user means by "remove all old `PhysicsObject` mentions and legacy code":
  - Module state: `physicsObjects` (181), `currentScenePhysicsObjects` (182), `scenePhysicsLoopers`/`scenePhysicsAfterStepLoopers` (188–189), a `ScenePhysicsState`-typed default (166) — `ScenePhysicsState`/`ScenePhysicsLooper` are undefined here (they only exist privately inside `PhysicsRapier.ts:233,249`, which has its own separate copy of everything below — not shared).
  - `mainThreadBaseStepper` (367–551): fixed-timestep accumulator + interpolation bookkeeping + a commented-out `eventQueue?.drainCollisionEvents(...)` block (Rapier-specific global that only exists in `EngineRapier.ts`) + `(engAPI as EngineAPIType).step()` (540) which doesn't type-check because `EngineAPIType` has no `step` member. Reads `po.rigidBody`/`rb.handle` — the old `PhysicsObject` shape, not the new `RigidBodyAPI`.
  - `stepperFnDebug` (557–623): calls `physicsWorld.debugRender()` (566), which doesn't exist on `WorldAPI` (only a commented-out signature at `PhysicsAPITypes.ts:1046–1063`).
  - Debug GUI / physics-object-list / edit-window code (760–1178: `createPhysicsDebugMesh`, `buildPhysicsDebugGUI`, `createEditPhysObjContent`, `updatePhysObjectDebuggerGUI`, etc.), all keyed on the string-id `PhysicsObject` map.
  - `deletePhysicsObject`/`getPhysicsObject(s)`/`setCurrentScenePhysicsObjects`/`switchPhysicsMesh`/`switchPhysicsCollider` (1249–1493) — the latter also references undefined globals `RAPIER`/`eventQueue` directly (1409, 1416).
- Line 1495: `/** NEW STUFF (@CHORE: delete this line when everything is diamonds!!!) */` banner.
- Lines 1497–2117: the real id-based API — `createPhysicsWorld`, `createRigidBody(Sync)`, `createCollider(Sync)`, plural + delete variants, snapshot take/restore. Each has a working `MAIN_THREAD` branch and a `WORKER_THREAD` branch that isn't in scope for this MVP.
- Lines 2119–3649: `WorldProxyAPI`/`RigidBodyProxyAPI`/`ColliderProxyAPI` — worker-thread-only proxy classes doing `messageWorkerAsync` round-trips. **Not legacy, leave entirely alone** — simply not exercised by main-thread mode.

**`src/_engine/core/Physics/EngineRapier.ts`** (1516 lines): CRUD is complete and correct (`createRigidBody` 170, `createCollider` 250, `createRigidBodies`/`createColliders` ~422–426, delete variants 428–503, `getRigidBodyAPIWithId`/`getColliderAPIWithId` 98–102) — confirmed by reading in full, no changes needed there. Two empty, unwired stubs:

```ts
// 536
export const debugRenderAPI = () => {
  // @CHORE: FINISH THIS
};
// 540
export const stepAPI = () => {
  // @CHORE: FINISH THIS
};
```

`EngineRigidBodyProxyAPI` (881–1284) declares hot-path fields `pos`/`rot`/`lvel`/`avel` (884–887) but only zero-initializes them in the constructor; `translation()`/`rotation()`/`linvel()`/`angvel()` (974–1044) bypass them entirely and call `this.rb.translation()` etc. directly — the fields are dead weight today.

`EngineRapier.ts` has **no explicit `EngineAPIType` object literal** — `Physics/ENGINES.ts:3,23` consumes it as a wildcard namespace import assigned directly to the `engineAPI` field:

```ts
import * as RapierAPI from './EngineRapier';
...
RAPIER: { init: async () => {...}, engineAPI: RapierAPI }
```

This means `EngineAPIType`'s member names must match `EngineRapier.ts`'s **export names exactly** — there is no object-literal remap step. Since every other `EngineAPIType` member uses a plain verb name (`createRigidBody`, not `createRigidBodyAPI`; `deleteWorld`, not `deleteWorldAPI`), the two new interface members should be named `step`/`debugRender`, which means **`stepAPI`/`debugRenderAPI` must be renamed to `step`/`debugRender`** when implemented (not left as-is with new wrapper exports) — both for naming consistency and because the namespace-import structural typing requires the literal name match.

**`src/_engine/core/Physics/PhysicsAPITypes.ts`** (2486 lines):

- `EngineAPIType` (15–43): no `step`/`debugRender` member at all.
- `WorldAPI` (1009–~1330): both present only as commented-out signatures (`debugRender` 1046–1063, `step` 1064–1072).
- `RigidBodyAPI` (212–363): declares the hot-path fields (216–220) nothing populates yet.
- `PhysicsObject` (793–814) + its two callback-signature aliases `CollisionEventFn`/`ContactForceEventFn` (779–791) — this file's own (unused) legacy type. Confirmed via repo-wide grep: every other `PhysicsObject` reference (`movingPlatform.ts`, `ImportModel.ts`, `dynamicCharacter.ts`, `characterTestObjects.ts`, `scene_thirdPersonGym.ts`, `Character.ts`, `_dbg__Character.ts`) imports a **separate, locally-defined** `PhysicsObject` from `PhysicsRapier.ts` itself — deleting this file's copy touches nothing under `PhysicsRapier.ts`. It's referenced from: `PhysicsAPI.ts`'s legacy block (being deleted, §3.3), `ColliderParams.collisionEventFn`/`contactForceEventFn` (975–991, real/active fields — signature needs a type-only fix, not deletion), and `PhysicsUtils.ts:70`'s `isDynamicPhysicsObjectValid` (confirmed dead — its only caller is the deleted `mainThreadBaseStepper`).

**`src/_engine/core/ECS/ECSCoreComponents.ts`**: component data types already declared (41–45: `COLLIDER: ColliderAPI[]`, `BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS`/`BODY_STATIC: RigidBodyAPI`; 58: `TAG_IS_PHYSICS_OBJECT: boolean`) — `ECSRegistry.ts` already registers these component-type keys, no registry changes needed. A fully-written but commented-out `createPhysicsEntity` (141–212) already does correct bucket-sorting and initial-transform-seeding, with one real bug: it `await`s `createRigidBody`/`createColliders` (159, 169) as if async — the real `EngineRapier.ts` functions are synchronous (confirmed, no `await` anywhere in their bodies).

**`src/_engine/core/ECS/ECSCoreSystems.ts`**: `physicsToTransformSystem` (200–225, verified by direct read) reads `rb.pos.x/y/z`/`rb.rot.x/y/z/w` as **plain field access** every frame — handles both the typed `transformStore` path and the plain-`Transform` fallback correctly already. Registered unconditionally in `registerCorePlugin` (132–150, verified by direct read) at `ECSSystemStage.APP_POST_PHYSICS`, with an explicit `// @CHORE: register this system in the PhysicsAPI` comment (142) — signals its registration should move into the new physics module. The other two systems in that same `registerCorePlugin` block (`object3DSyncSystem` at `MAIN`, `entityLifetimeSystem` at `LATE_MAIN`, `lookAtSystem` at `APP_RENDER_SYNC`) run at different stages and don't read/write physics components — no ordering dependency on `physicsToTransformSystem`.

**`src/_engine/core/ECS.ts`**: `getRigidBody` (765–771), `isEntityDynamic` (773–778), `setTransform`/`teleport` (616–669), `setVelocity` (675–687), `setDisabled` (725–763) are already written against the exact target shape (calling `rb.setTranslation`/`rb.setLinvel`/`rb.setEnabled` etc. on whichever of `BODY_STATIC`/`BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS` is present). **These need zero changes.** The plan's real remaining work is narrowly the create/delete side.

**Manager pattern precedent**: `MeshManager.ts` registers its `onDeleteEntity` hook at bare module-load time (18–20: `ECSWorld.registerComponentHooks(ComponentType.TAG_IS_MESH, { onDeleteEntity: (id, w) => disposeMesh(id, w) })`). `CameraManager.ts`/`LightManager.ts` instead expose an explicit `registerCameraManager()`/`registerLightManager(world)` init function (`LightManager.ts:20-40`) because they need more setup than just the hook. Physics needs the explicit-function style too, since entity creation depends on the physics world already existing.

**Bootstrap** (`src/_engine/InitApp.ts`, verified by direct read): `registerCameraManager()`/`registerLightManager(ecsWorld)` at lines 64–65 (after `initECSWorld()` at 53), `initDebugCamera(ecsWorld)` at 68, `await InitRapierPhysics();` (old system) at line 70, then the `IS_DEBUG_ENV` block at 72.

**Main loop** (`src/_engine/core/MainLoop.ts`, verified by direct read): import at line 17 — `import { getPhysicsState, renderPhysicsObjects, stepPhysicsWorld } from './PhysicsRapier';`. Three call sites, always `stepPhysicsWorld(loopState)` immediately followed by `renderPhysicsObjects()`, immediately before `for (const world of getAllECSWorlds()) world.updateAppLoop(deltaApp)` (which runs `APP_POST_PHYSICS`, i.e. `physicsToTransformSystem`):

- `mainLoopForDebug`: lines 143/146.
- `mainLoopForProduction`: lines 201/204.
- `mainLoopForProductionWithFPSLimiter`: lines 256/261, with an early `if (skipFrame) return;` inserted between step and render (258) to skip rendering-but-not-stepping on throttled frames.
- A 4th, unrelated stray call exists at line 362 — a one-time warm-up `setTimeout(() => requestAnimationFrame(() => stepPhysicsWorld(loopState)), 100)` outside all three loop functions. **Left untouched** — a one-time warm-up has no equivalent need for the new system in this MVP.
  This file is otherwise unmodified — only the 3 loop-function call sites gain one additive, guarded line each.

**Double Rapier WASM-init — confirmed unguarded, real risk**: both `Physics/ENGINES.ts:16-21` (`init: async () => { const mod = await import('@dimforge/rapier3d-compat'); await mod.default.init(); ... }`) and `PhysicsRapier.ts`'s local `initRapier` (2420–2425) call `await RAPIER.init()` **unconditionally, with no cached promise or "already initialized" flag anywhere** in either file or in `PhysicsUtils.ts`. Once this MVP's bootstrap wiring (§3.6) makes both call paths execute in the same page session, whether calling `@dimforge/rapier3d-compat`'s `init()` twice is safe (idempotent/no-op) or throws/reinitializes is **unverified** — flagged as a must-check-manually risk in Phase 4, with a concrete fallback (§8) if it isn't safe.

**Scene/asset pipeline**: physics is not part of the JSON schema pipeline (no `physicsSchema.ts`; two dead commented placeholders in `meshSchema.ts`/`importedMeshSchema.ts`). `scene01.ts` (verified by direct read) authors meshes via `createGeometry`/`createMaterial`/`createMeshEntity` (JSON-schema-adjacent helpers, real names confirmed) then attaches physics imperatively via `createPhysicsObjectWithMesh` from `PhysicsRapier.ts`. The new test scene follows the same convention: JSON for meshes/camera/light, imperative `.ts` calling the new `createPhysicsEntity`.

## 3. Design

### 3.1 Hot-path fields: lazy getters, not write-after-step

`EngineRigidBodyProxyAPI.pos`/`.rot`/`.lvel`/`.avel` become **getters** calling `this.rb.translation()`/`.rotation()`/`.linvel()`/`.angvel()` on read, replacing the dead stored fields. Rationale: main-thread mode has no `SharedArrayBuffer` to populate, so there's no real "hot path" to optimize yet; a getter needs no per-step full-body-list write-back loop, satisfies `RigidBodyAPI`'s field-shaped interface unmodified (JS getters read exactly like fields, so `physicsToTransformSystem`'s `rb.pos.x` keeps working as-is), and is always fresh. Revisit once worker-thread mode exists (§6) — a getter can't cross a worker boundary, so that path will need genuine write-after-step into shared memory.

### 3.2 Create/delete stays synchronous

`EngineRapier.ts`'s `createRigidBody`/`createCollider`/`createRigidBodies`/`createColliders` are and remain synchronous. The new `PhysicsManager.createPhysicsEntity` (§3.5) is **not** `async` and does not `await` them — fixing the bug in the commented-out draft in `ECSCoreComponents.ts` (which incorrectly awaits these). Revisit only if/when worker-thread mode routes `PhysicsManager` through the async proxy classes (§6).

### 3.3 What gets deleted vs. kept

**`src/_engine/core/PhysicsAPI.ts`**:

- Delete lines 142–1494 in full (legacy block described in §2).
- Rewrite `initPhysics` as a small, main-thread-only init function (§3.4) — legitimate infrastructure, just currently entangled with the deleted block's state (`stepperFn`, debug-persistence keys, the `WORKER_THREAD` branch).
- Keep lines 1497–3649 untouched except whatever type fixes fall out of adding `step`/`debugRender` to `EngineAPIType` (§3.4 — expected to be none, since this range doesn't call `.step()`/`.debugRender()`).
- Remove now-dead imports (the `PhysicsObject` import and any debug-GUI/DraggableWindow/Tweakpane imports that only the deleted block used — confirm each via `tsc`'s unused-import diagnostics in Phase 1, don't delete blind).
- Add `export const stepPhysics = (loopState: LoopState) => { ... }` (§3.4), deliberately named differently from `PhysicsRapier.ts`'s `stepPhysicsWorld` so the two are never confused at a shared import site.

**`src/_engine/core/Physics/PhysicsAPITypes.ts`**:

- Delete `PhysicsObject`/`CollisionEventFn`/`ContactForceEventFn` (779–814).
- In `ColliderParams` (~893–1001): change `collisionEventFn`/`contactForceEventFn` signatures (~975–991) to drop the `physObj1`/`physObj2: PhysicsObject` parameters, keeping `(collider1: ColliderAPI, collider2: ColliderAPI, started: boolean)` / `(e: TempContactForceEvent)`. The boolean config fields (`hasCollisionEventFn`, `enableCollisionActiveEvents`, etc.) are untouched — `EngineRapier.ts`'s `createCollider` already only reads the booleans to configure Rapier's `ActiveEvents`; the callback fields stay declared-but-undrained until events are implemented (§6), so this is a type-only fix, zero behavior change. Grep for any speculative caller of these two fields before deleting the params, in case something unexpectedly already relies on the old signature.
- Uncomment `WorldAPI.step` (1064–1072) and `WorldAPI.debugRender` (1046–1063) as-is.
- Add to `EngineAPIType` (15–43):
  ```ts
  step: (eventQueue?: unknown, hooks?: unknown) => void;
  debugRender: () => { vertices: Float32Array; colors: Float32Array } | undefined;
  ```
  Typed loosely here (not `Rapier.EventQueue`) to keep `EngineAPIType` itself engine-agnostic.

**`src/_engine/core/Physics/EngineRapier.ts`**:

- Rename `stepAPI` → `step` and implement: `physicsWorld.step(eventQueue)` — Rapier's own `step` already accepts an optional event queue; no other bookkeeping is needed since the hot-path fields are now getters (§3.1), so there's nothing to write back after stepping.
- Rename `debugRenderAPI` → `debugRender` and implement: call Rapier's real `physicsWorld.debugRender()` and return `{ vertices, colors }`. Export it but **do not** wire it into any UI/visualizer (§6 — out of scope); this closes the "@CHORE: FINISH THIS" stub without inventing out-of-scope UI.
- `EngineRigidBodyProxyAPI` (881–1284): replace the four field declarations (884–887) with getters per §3.1.
- No changes needed anywhere else in this file (CRUD confirmed complete).
- Because `Physics/ENGINES.ts` consumes this file via `import * as RapierAPI from './EngineRapier'` assigned directly as `engineAPI` (no object-literal remap — confirmed, §2), renaming to `step`/`debugRender` and having them satisfy the new `EngineAPIType` members is sufficient; no edits needed in `ENGINES.ts` itself.

**`src/_engine/core/Physics/PhysicsUtils.ts`** (one unavoidable ripple outside the 3 named Physics API files, since it imports the type being deleted):

- Remove `isDynamicPhysicsObjectValid` (line 70) and its `PhysicsObject` import (line 5) — confirmed dead, its only caller (`mainThreadBaseStepper`) is deleted in the same change. Pure deletion, no behavior change.

### 3.4 New `initPhysics`/`stepPhysics` in `PhysicsAPI.ts` (MVP-scoped, deliberately simple)

```ts
export const initPhysics = async (doNotCreateWorld?: boolean) => {
  const physicsConfig = getConfig().physics;
  if (!physicsConfig?.enabled) return;
  physicsState.timestepRatio = 1 / (physicsState.timestep || 60);
  const { engineAPI } = await initPhysicsEngine(physicsState.physicsEngine);
  engAPI = engineAPI;
  const worldOrUndefined = engAPI.init(
    physicsState,
    isDebugEnvironment(),
    getReadOnlyLoopState(),
    doNotCreateWorld
  );
  if (worldOrUndefined) physicsWorld = worldOrUndefined;
};

export const stepPhysics = (loopState: LoopState) => {
  if (!physicsWorldEnabled || !loopState.appPlay) return;
  engAPI?.step();
};
```

No accumulator, no interpolation, no background-pause handling — Rapier's own fixed internal `timestep` (set once via `createWorld`) governs stepping. `PhysicsRapier.ts`'s accumulator/interpolation richness is intentionally **not** ported (§6) — "two objects fall and rest" is the MVP bar, not frame-perfect interpolation.

`getConfig().physics.enabled` (`Config.ts:22-34`, default `false`, overridable via `VITE_PHYS_ENABLED`) is the **same** flag `InitRapierPhysics()` already reads. Both systems tolerate it being on harmlessly; the actual guard against two live `Rapier.World`s is that `createPhysicsWorld()` (the new system's world constructor) is **only called from the new test scene's own `.ts` file**, never at boot — so at boot only the WASM module gets initialized for the new system, no `World` is created, and `stepPhysics` is a true no-op everywhere except when the physics test scene is active.

### 3.5 `src/_engine/core/PhysicsManager.ts` (new file) — the physics entity ecosystem

Mirrors `MeshManager.ts`/`LightManager.ts`:

```ts
export const registerPhysicsManager = (world: ECSWorld) => {
  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_PHYSICS_OBJECT, {
    onDeleteEntity: (entityId, w) => disposePhysicsEntity(entityId, w),
  });
  world.addSystem(
    ECSSystemStage.APP_POST_PHYSICS,
    'physicsToTransformSystem',
    physicsToTransformSystem
  );
};

export const createPhysicsEntity = (
  colliderParams: ColliderParams | ColliderParams[],
  rigidBodyParams?: RigidBodyParams,
  object3D?: THREE.Object3D,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): number => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in createPhysicsEntity.');
  const entityId = world.createEntity(entityOpts);
  world.addComponent(entityId, ComponentType.TAG_IS_PHYSICS_OBJECT, true);

  let rb: RigidBodyAPI | undefined;
  if (rigidBodyParams) rb = createRigidBody(rigidBodyParams); // sync, from PhysicsAPI.ts (§3.2)

  const paramsArray = Array.isArray(colliderParams) ? colliderParams : [colliderParams];
  if (rb) for (const p of paramsArray) p.parentId = rb.id;
  const colls = paramsArray.length ? createColliders(paramsArray) : [];

  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (rb) {
    transform?.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
    transform?.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
  } else if (object3D) {
    transform?.position.copy(object3D.position);
    transform?.quaternion.copy(object3D.quaternion);
    transform?.scale.copy(object3D.scale);
  }

  if (object3D) {
    if (transform) {
      object3D.position.copy(transform.position);
      object3D.quaternion.copy(transform.quaternion);
      object3D.scale.copy(transform.scale);
      object3D.userData._lastVersion = transform.version;
    }
    world.addComponent(entityId, ComponentType.OBJECT3D, { value: object3D, _lastVersion: -1 });
  }

  world.addComponent(entityId, ComponentType.COLLIDER, colls);

  const isStatic = !rb || rigidBodyParams?.rigidType === 'FIXED';
  if (isStatic) {
    if (rb) world.addComponent(entityId, ComponentType.BODY_STATIC, rb);
  } else {
    const bucket = object3D
      ? ComponentType.BODY_DYNAMIC_VISUAL
      : ComponentType.BODY_DYNAMIC_HEADLESS;
    world.addComponent(entityId, bucket, rb!);
  }

  return entityId;
};

export const disposePhysicsEntity = (entityId: number, world: ECSWorld) => {
  const rb = world.getRigidBody(entityId);
  const colls = world.getComponent(entityId, ComponentType.COLLIDER);
  if (colls) deleteColliders(colls.map((c) => c.id));
  if (rb) deleteRigidBody(rb.id);
};

export const getPhysicsEntityByAppId = (appId: string) => getEntityIdByAppId(appId);
```

This is the "physics entity ecosystem" (create/delete, like Mesh/Camera/Light). Decision: the manager sets `TAG_IS_PHYSICS_OBJECT` explicitly itself, rather than relying on `ECSCoreSystems.ts`'s `obj.userData.isPhysicsObject`-sniffing hook (79–95) — simpler and explicit, doesn't require callers to remember to stamp `userData` beforehand.

Also **move** `physicsToTransformSystem` (currently `ECSCoreSystems.ts:200-225`) into `PhysicsManager.ts` verbatim, and remove its registration from `ECSCoreSystems.ts`'s `registerCorePlugin` block (132-150) — `registerPhysicsManager(world)` now owns registering it, called per-world like `LightManager.ts`'s `registerLightManager(world)`. `ECSCoreSystems.ts` keeps its other two systems (`object3DSyncSystem`, `entityLifetimeSystem`, `lookAtSystem`) unchanged.

### 3.6 Bootstrap wiring — additive, guarded, non-breaking

`InitApp.ts`: add, after line 70 (`await InitRapierPhysics();`):

```ts
registerPhysicsManager(ecsWorld);
await initNewPhysics(); // aliased import of PhysicsAPI.ts's initPhysics; no-op if getConfig().physics?.enabled is false
```

`MainLoop.ts`: add one line at each of the three loop-function call sites (143/146, 201/204, 256/261 — not the stray warm-up at 362), alongside (not replacing) the existing calls:

```ts
stepPhysics(loopState); // new engine-agnostic system — no-op until createPhysicsWorld() has been called (§3.4)
```

No `renderPhysicsObjects()`-equivalent is needed for the new system — `physicsToTransformSystem` (now in `PhysicsManager.ts`, run via `ECSSystemStage.APP_POST_PHYSICS` inside `world.updateAppLoop(deltaApp)`, which already runs immediately after these lines) does that job.

### 3.7 Test scene: `src/app/physicsTest.scene.json` + companions + `src/app/physicsTest.ts`

Following `scene01.ts`'s real, confirmed convention (JSON for structural pieces, imperative `.ts` for physics):

- `src/app/physicsTest.scene.json` — `id: "physicsTest"`, `sceneFile: "./physicsTest.ts"`, references a camera and a light, following `debugScene.scene.json`'s shape.
- `src/app/cameras/physicsTestCamera.camera.json` — perspective camera positioned to see the ground plane and drop zone, `active: true`.
- `src/app/lights/physicsTestAmbient.light.json` — simple ambient light.
- `src/app/physicsTest.ts` — mirrors `scene01.ts`'s real pattern (`createGeometry`/`createMaterial`/`createMeshEntity`/`getMeshByAppId`, confirmed real helper names and call shape):

  ```ts
  export const scene = async () => {
    createPhysicsWorld();

    const groundGeo = createGeometry({
      id: 'physicsTestGround',
      type: 'BOX',
      params: { width: 10, height: 0.5, depth: 10 },
    });
    const groundMat = createMaterial({
      id: 'physicsTestGround',
      type: 'BASIC',
      params: { color: 0x666666 },
    });
    createMeshEntity({
      appId: 'physicsTestGroundMesh',
      geo: groundGeo,
      mat: groundMat,
      position: { x: 0, y: 0, z: 0 },
    });
    const groundMesh = getMeshByAppId('physicsTestGroundMesh')!;
    createPhysicsEntity(
      { type: 'BOX', hx: 5, hy: 0.25, hz: 5 },
      { rigidType: 'FIXED', translation: { x: 0, y: 0, z: 0 } },
      groundMesh
    );

    const ballGeo = createGeometry({
      id: 'physicsTestBall',
      type: 'SPHERE',
      params: { radius: 0.5 },
    });
    const ballMat = createMaterial({
      id: 'physicsTestBall',
      type: 'BASIC',
      params: { color: 0xff4444 },
    });
    createMeshEntity({
      appId: 'physicsTestBallMesh',
      geo: ballGeo,
      mat: ballMat,
      position: { x: -1, y: 5, z: 0 },
    });
    const ballMesh = getMeshByAppId('physicsTestBallMesh')!;
    createPhysicsEntity(
      { type: 'BALL', radius: 0.5 },
      { rigidType: 'DYNAMIC', translation: { x: -1, y: 5, z: 0 } },
      ballMesh
    );

    const boxGeo = createGeometry({
      id: 'physicsTestBox',
      type: 'BOX',
      params: { width: 1, height: 1, depth: 1 },
    });
    const boxMat = createMaterial({
      id: 'physicsTestBox',
      type: 'BASIC',
      params: { color: 0x4488ff },
    });
    createMeshEntity({
      appId: 'physicsTestBoxMesh',
      geo: boxGeo,
      mat: boxMat,
      position: { x: 1, y: 7, z: 0 },
    });
    const boxMesh = getMeshByAppId('physicsTestBoxMesh')!;
    createPhysicsEntity(
      { type: 'BOX', hx: 0.5, hy: 0.5, hz: 0.5 },
      { rigidType: 'DYNAMIC', translation: { x: 1, y: 7, z: 0 } },
      boxMesh
    );
  };
  ```

  Using `createMeshEntity`/`getMeshByAppId` (matching `scene01.ts` exactly) rather than raw `new THREE.Mesh`, so the test scene is a faithful precedent for how a real future scene would combine `MeshManager` + `PhysicsManager`. Exact `createGeometry`/`createMaterial`/`createMeshEntity` parameter shapes to be double-checked against their real signatures during implementation (they're confirmed real names and roughly this call shape per `scene01.ts:42-56`, but full param types weren't exhaustively re-verified here).

## 4. Files touched

| File                                            | Change                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/_engine/core/PhysicsAPI.ts`                | Delete legacy block 142–1494; rewrite `initPhysics`; add `stepPhysics`; remove dead imports                                                                                                 |
| `src/_engine/core/Physics/PhysicsAPITypes.ts`   | Delete `PhysicsObject`/`CollisionEventFn`/`ContactForceEventFn` (779–814); fix `ColliderParams` callback signatures; uncomment + add `step`/`debugRender` to `WorldAPI` and `EngineAPIType` |
| `src/_engine/core/Physics/EngineRapier.ts`      | Rename+implement `stepAPI`→`step`, `debugRenderAPI`→`debugRender` (536–542); `pos`/`rot`/`lvel`/`avel` (884–887) → getters                                                                  |
| `src/_engine/core/Physics/PhysicsUtils.ts`      | Remove dead `isDynamicPhysicsObjectValid` (line 70) + its `PhysicsObject` import (line 5)                                                                                                   |
| `src/_engine/core/PhysicsManager.ts`            | **New file**: `createPhysicsEntity`, `disposePhysicsEntity`, `registerPhysicsManager`, `getPhysicsEntityByAppId`, moved `physicsToTransformSystem`                                          |
| `src/_engine/core/ECS/ECSCoreSystems.ts`        | Remove `physicsToTransformSystem` body + its `registerCorePlugin` add-call (132–150, 196–225) — moved to `PhysicsManager.ts`                                                                |
| `src/_engine/InitApp.ts`                        | Add `registerPhysicsManager(ecsWorld)` + `await initNewPhysics()` after line 70                                                                                                             |
| `src/_engine/core/MainLoop.ts`                  | Add `stepPhysics(loopState)` at the 3 loop-function call sites (143/146, 201/204, 256/261)                                                                                                  |
| `src/app/physicsTest.scene.json`                | **New**                                                                                                                                                                                     |
| `src/app/cameras/physicsTestCamera.camera.json` | **New**                                                                                                                                                                                     |
| `src/app/lights/physicsTestAmbient.light.json`  | **New**                                                                                                                                                                                     |
| `src/app/physicsTest.ts`                        | **New**                                                                                                                                                                                     |

## 5. Explicitly out of scope / non-goals

- Worker-thread mode and the `WorldProxyAPI`/`RigidBodyProxyAPI`/`ColliderProxyAPI` classes (`PhysicsAPI.ts:2119-3649`) — untouched, not exercised.
- SharedArrayBuffer-backed hot path — the getter approach (§3.1) is main-thread-only; revisit when worker mode lands.
- Collision/contact-force event dispatch (`eventQueue.drainCollisionEvents`/`drainContactForceEvents`) — `ActiveEvents` flags can still be set on colliders (harmless), nothing drains or calls back yet.
- `debugRender` wired into an actual Tweakpane/line-mesh visualizer, or any physics-object debugger GUI/edit-window — the function is implemented and correct but not called from any UI.
- Joints (`PhysicsAPITypes.ts` ~1380-1432) and the character-controller section (~1331-1342) — stay commented; `Character.ts` keeps its own controller on plain rigid bodies via `PhysicsRapier.ts`.
- A second physics engine (Jolt/Ammo/etc.) — `ENGINES.ts` stays single-entry (`RAPIER`).
- **Migrating any of `PhysicsRapier.ts`'s 17 importers to the new API** — confirmed with the user as a separate future plan; this MVP does not touch `PhysicsRapier.ts`, `scene01.ts`, `scene01_v2.ts`, `scene_thirdPersonGym.ts`, `Character.ts`, `Scene.ts`, `SceneLoader.ts`, `ImportModel.ts`, or any toolkit/utils physics helper.
- Physics in the JSON schema pipeline (`physicsSchema.ts`) — the test scene attaches physics imperatively in its `.ts`, matching `scene01.ts`'s existing convention for the old system.
- Porting `mainThreadBaseStepper`'s fixed-timestep accumulator, background-pause handling, and position/rotation interpolation — `stepPhysics` (§3.4) is a deliberately simpler MVP stepper; revisit if the test scene shows visible jitter.
- Snapshot-restore correctness with live id-map reconciliation (`EngineRapier.ts:528-534`'s own `@TODO`) — untouched, not exercised by the test scene.

## 6. Follow-up work (post-MVP)

1. Worker-thread mode: spin up `physicsWorker.ts` end-to-end, exercise `WorldProxyAPI`/`RigidBodyProxyAPI`/`ColliderProxyAPI`, design the `SharedArrayBuffer` transform-sync path.
2. Re-evaluate the hot-path field strategy (getter vs. write-after-step vs. SAB) once worker mode exists.
3. Collision/contact-force event system: an agnostic (non-Rapier-typed) drain + dispatch, replacing the commented-out blocks removed in this MVP.
4. `debugRender` → a real Tweakpane/line visualizer + physics-object debugger GUI, replacing the deleted 760-1178 block with an equivalent built against the new id-based shape.
5. Fixed-timestep accumulator + background-pause + interpolation in `stepPhysics`, ported/adapted from the deleted `mainThreadBaseStepper`.
6. Joints and character-controller support (currently commented out in `PhysicsAPITypes.ts`).
7. A second engine backend (Jolt/Ammo) exercising `ENGINES.ts`'s multi-entry design.
8. Physics-in-JSON-schema (`physicsSchema.ts`) so scenes can author physics declaratively.
9. **Migrate `PhysicsRapier.ts`'s 17 importers to the new API and retire `PhysicsRapier.ts`** — the actual "replace the old system" work this MVP is a prerequisite for.
10. `createPhysicsEntity` accepting an existing mesh-entity id directly (not just an `Object3D`) for cleaner composition with `MeshManager.createMeshEntity`.

## 7. Phased rollout

**Phase 1 — Strip legacy code, get `PhysicsAPI.ts`/`PhysicsAPITypes.ts`/`PhysicsUtils.ts` compiling. No behavior change (0 real importers today).** Delete `PhysicsAPI.ts:142-1494`, rewrite `initPhysics`, add a stub `stepPhysics` (guarded no-op is fine at this phase), remove dead imports. Delete `PhysicsObject`/`CollisionEventFn`/`ContactForceEventFn` from `PhysicsAPITypes.ts`, fix `ColliderParams` callback signatures. Remove `isDynamicPhysicsObjectValid` from `PhysicsUtils.ts`. Manual verification: `tsc --noEmit` shows 0 errors in these 3 files and no new errors elsewhere; `yarn lint` passes; `git diff` confirms `PhysicsRapier.ts` and its importers are untouched.

**Phase 2 — Implement `step()`/`debugRender()` end-to-end. Still 0 real importers, still safe.** Add `step`/`debugRender` to `WorldAPI` (uncomment) and `EngineAPIType` (new). Rename+implement `stepAPI`→`step`, `debugRenderAPI`→`debugRender` in `EngineRapier.ts`. Convert `EngineRigidBodyProxyAPI.pos`/`.rot`/`.lvel`/`.avel` to getters. Wire the real `stepPhysics` body in `PhysicsAPI.ts` calling `engAPI.step()`. Manual verification: `tsc --noEmit` clean; via the browser console (using the `run-aekasha-js` skill to get the dev server running), manually call `createPhysicsWorld()` → `createRigidBody(...)` → `stepPhysics(...)` a few times and confirm `getRigidBodyAPIWithId(id).pos` changes frame to frame under gravity — the first real functional proof of the whole stack, before any ECS/scene work exists.

**Phase 3 — Build `PhysicsManager.ts`, move `physicsToTransformSystem`.** New file per §3.5. Remove `physicsToTransformSystem` + its registration from `ECSCoreSystems.ts`. Manual verification: `tsc --noEmit` clean; run the app (`run-aekasha-js` skill) with an old-system scene (e.g. `scene01.ts`) loaded and confirm nothing regresses (meshes, lights, cameras, old physics all behave identically) — this phase touches a shared core file so it needs a broad regression check even though `registerPhysicsManager` isn't called from anywhere yet.

**Phase 4 — Bootstrap wiring: `InitApp.ts` + `MainLoop.ts`, additive/opt-in.** Add `registerPhysicsManager(ecsWorld)` + `await initNewPhysics()` to `InitApp.ts`. Add the guarded `stepPhysics(loopState)` call at the 3 `MainLoop.ts` call sites. Manual verification: run the app with the current default/debug scene active, confirm the console shows no new errors on boot — in particular **watch specifically for a double-WASM-init error/hang**, since this is the first point where both `RAPIER.init()` call paths execute in the same session (§8 risk); confirm the currently-active old-system scene still behaves identically (`stepPhysics` should be a true no-op since no `createPhysicsWorld()` has been called yet).

**Phase 5 — Build and wire in the test scene.** Add `physicsTest.scene.json` + camera/light companions + `physicsTest.ts` (§3.7). Manual verification: switch to the new scene (via the debug scene switcher in `IS_DEBUG_ENV`, or the `run-aekasha-js` skill), confirm `createPhysicsWorld()` now actually runs and ground/ball/box meshes render at their authored initial positions.

**Phase 6 — End-to-end manual verification (the actual MVP bar).** With the physics test scene active: watch the ball and box fall under gravity and come to rest on the ground plane without falling through it or jittering forever; confirm no console errors/warnings during stepping; confirm switching away to an old-system scene and back doesn't crash or duplicate physics objects; run `tsc --noEmit` and `yarn lint` clean across the whole repo one final time.

## 8. Risks and open questions

| Risk / question                                                                                                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double Rapier WASM init — confirmed unguarded (§2): both `ENGINES.ts:16-21` and `PhysicsRapier.ts:2420-2425` call `await RAPIER.init()` unconditionally, no cache/flag exists anywhere | Must be checked manually in Phase 4 (first point both paths run together). If it throws or misbehaves, the fallback is a small shared init-promise cache (e.g. a new tiny module the new system's `ENGINES.ts` init routes through) so a second call awaits the same promise instead of calling `RAPIER.init()` again — do not modify `PhysicsRapier.ts` itself for this if avoidable, per the out-of-scope decision (§5), but a non-invasive shared-cache addition may be unavoidable if the risk materializes. |
| Two live `Rapier.World` instances (old system's + new system's, once the test scene is active) both stepping every frame                                                               | By design (§3.6) the new world is only created when the physics test scene is entered; the old system's world keeps stepping regardless of which scene is active. Wasteful but should be harmless — confirm via Phase 6 manual check there's no visible cross-talk.                                                                                                                                                                                                                                              |
| Sync vs. async `createPhysicsEntity`/`createRigidBody` (§3.2)                                                                                                                          | Decided: synchronous for MVP, matching the real underlying implementation. Revisit only when worker-thread mode needs `PhysicsManager` to route through the async proxy classes.                                                                                                                                                                                                                                                                                                                                 |
| Moving `physicsToTransformSystem`'s registration out of `ECSCoreSystems.ts`                                                                                                            | Confirmed no ordering dependency on the other systems in that `registerCorePlugin` block (§2). `registerPhysicsManager(world)` must be called for every `ECSWorld` that needs physics-driven transform sync (mirroring `LightManager.ts`'s per-world registration) — a future second `ECSWorld` created without this call would silently not sync physics transforms. Worth a code comment at the call site.                                                                                                     |
| `ColliderParams.collisionEventFn`/`contactForceEventFn` signature change                                                                                                               | These fields are unused end-to-end both before and after this MVP (no drain exists either side, §6.3) — the signature change is type-only. Grep for any speculative/future usage before deleting the `PhysicsObject`-typed params, in case something already relies on the old shape.                                                                                                                                                                                                                            |
| `PhysicsUtils.ts` touched despite being outside the named 3-file scope                                                                                                                 | Unavoidable — it imports the `PhysicsObject` type being deleted. Confirmed its one function (`isDynamicPhysicsObjectValid`) is dead once the legacy stepper is deleted; pure deletion, no behavior change.                                                                                                                                                                                                                                                                                                       |
| `createPhysicsEntity`'s `object3D` parameter vs. `MeshManager.createMeshEntity`'s entity-id return                                                                                     | `createMeshEntity` returns an entity id, not an `Object3D`; the test scene calls `getMeshByAppId(...)` after `createMeshEntity(...)` to get the actual mesh object to pass in (§3.7) — slightly more roundabout than ideal, noted as follow-up polish (§6.10).                                                                                                                                                                                                                                                   |
| `getEngineAPI()`/`engAPI` module-state duplication between `PhysicsAPI.ts` and `PhysicsUtils.ts`                                                                                       | Both files maintain their own "current engine" reference. Not a bug (both get set from the same `initPhysicsEngine()` call), but a smell — not fixed in this MVP, not blocking.                                                                                                                                                                                                                                                                                                                                  |

## 9. Verification

Manual, since there is no test runner in this repo:

1. `tsc --noEmit` — 0 errors, run after every phase.
2. `yarn lint` — 0 errors/new warnings, run after every phase.
3. Use the `run-aekasha-js` skill to start the dev server and drive the app in a real browser:
   - After Phase 4: load the app's default scene, confirm no new console errors on boot (specifically watch for a Rapier WASM double-init error from `initNewPhysics()` running alongside `InitRapierPhysics()`).
   - After Phase 5: switch to the `physicsTest` scene, confirm ground/ball/box meshes appear at their authored starting positions before physics has stepped.
   - After Phase 6: watch the ball and box fall and settle on the ground plane (screenshot before/mid-fall/settled to confirm visually), confirm no console errors during stepping, switch back to an old-system scene (e.g. `scene01.ts`) and confirm it still behaves exactly as before.
