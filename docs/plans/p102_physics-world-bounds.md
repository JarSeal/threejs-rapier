Status: draft | not-implemented
Category: Physics
Related: \_DONE_p101_physics-scene-load-determinism.md (exits must happen on a fixed step, and the determinism probe must stay green), p500_restore-physics-snapshot.md (bounds are configuration, not simulation state, see §8), \_DONE_p058_line-rendering-system.md (Phase 3 draws the bounds with it)

# Physics World Bounds (Kill Volume) — Plan

Dynamic physics bodies that leave a defined region of the world are taken out of the simulation and handled: deleted by default, or disabled, or handed to a callback. A body that tunnels through a thin floor, gets launched by a bad impulse or rolls off the edge of a level currently falls forever: it keeps stepping, keeps syncing its transform, keeps a slot in the transform buffer (`maxBodies`) and never goes away until the scene is switched.

The feature has two layers:

- **Global bounds**: one region for the whole physics world. `AppConfig.physics.worldBounds` is the app-wide default, and each scene can register its own, which replaces the default while that scene is active.
- **Per-entity bounds**: an optional override on a single physics entity. It replaces the global region for that entity (it is not intersected with it), can exempt the entity completely (`ignore: true`) and chooses what happens on exit (`action`, `onExit`).

Off by default: with no bounds configured anywhere, nothing is checked and every existing scene behaves exactly as today. All phases are non-breaking.

---

## 1. Scope decisions

### 1.1 Which bodies are checked

Only **dynamic** rigid bodies (`BODY_DYNAMIC_VISUAL` and `BODY_DYNAMIC_HEADLESS`).

- Only the simulation can move a body somewhere unintended. Fixed bodies never move under simulation, and kinematic bodies are moved by app code, which already knows where it puts them.
- A per-entity bounds override on a fixed or kinematic body is ignored with a dev warning (`lwarn`, debug env only).
- Non-physics entities are out of scope for Phases 1–4. Phase 5 is an optional opt-in for them, only if a real use case shows up.

### 1.2 What "outside" means

- The test is the rigid body's **translation** (its origin) against an axis-aligned box. Not the collider AABB: cheaper, no shape dependency, and for a kill volume the difference does not matter.
- Every side of the box is optional. A missing side is open (±Infinity). The most common setup is a single kill height: `{ min: { y: -50 } }`.
- Because the outside of the box is unbounded, there is no tunnelling problem: a body that is outside after a step is caught on that step, however fast it moved.

### 1.3 What happens on exit

The engine side **always** does the same thing: it disables the body (`setEnabled(false)`) on the exact fixed step where it was found outside, and records an exit. The _action_ is main-thread ECS policy, applied when the record is delivered:

| `action`             | Main-thread result                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `'DELETE'` (default) | `world.deleteEntity(entityId)`. The existing `TAG_IS_PHYSICS_OBJECT` delete hook removes the (already disabled) body and colliders.    |
| `'DISABLE'`          | The entity stays. The body stays disabled, and its `OBJECT3D` (if any) is hidden. App code can re-enable it later.                     |
| `'CALLBACK'`         | `onExit(event)` is called. The body stays disabled; the callback decides (eg. teleport the player back to a checkpoint and re-enable). |

Splitting it this way keeps the engine side free of ECS and app concepts: it only knows geometry and body ids.

---

## 2. Why the check runs engine-side, per fixed step

p101 made scene loads deterministic, in both worker targets. A main-thread check in `APP_POST_PHYSICS` would break that: `APP_POST_PHYSICS` runs once per frame after 0–N sub-steps, so the step on which a body is removed would depend on frame timing, and the determinism probe's hash would differ between runs.

So the check runs right after each `engAPI.step()`, inside the engine module (`Physics/EngineRapier.ts`), in whichever thread the simulation runs:

- The body is disabled on the same fixed step in every run and in both worker targets, so the simulation itself stays deterministic.
- The **delivery** of the exit record to the main thread uses the existing event path (`flushPhysicsEvents`, at the start of the next sub-step, before `APP_PHYSICS_STEP`), with the same timing contract as collision events. That is already documented in CLAUDE.md, and gameplay code already relies on it.
- Headless bodies never sync to `TRANSFORM`. An engine-side check reads the real body pose, so it does not care.

### 2.1 Cost

- Global bounds unset and no per-body overrides: the check is skipped with one boolean test per step.
- Otherwise: `physicsWorld.forEachActiveRigidBody` (available in the pinned `@dimforge/rapier3d-compat` 0.19.3 — verify the exact signature before building). Sleeping bodies cannot move, so iterating only the active set is both correct and cheap. Per body: one map lookup for an override, then six float compares.
- Edge case: a body **created** asleep (`sleeping: true`) outside the bounds is never active, so it is never caught. Also run the check once when a dynamic body is created (engine-side, in the create path), which covers it.

---

## 3. API sketch

Types live in `Physics/PhysicsAPITypes.ts` (engine-agnostic protocol) and `PhysicsManager.ts` (ECS side).

```ts
/** A missing side (or a missing min/max) is open. */
export type WorldBoundsBox = {
  min?: { x?: number; y?: number; z?: number };
  max?: { x?: number; y?: number; z?: number };
};

export type WorldBoundsAction = 'DELETE' | 'DISABLE' | 'CALLBACK';

/** Global (config / per-scene) bounds. */
export type WorldBoundsDef = WorldBoundsBox & {
  /** Default 'DELETE'. Applies to every body without its own action. */
  action?: WorldBoundsAction;
};

/** Per-entity override: replaces the global bounds for this entity. */
export type EntityWorldBounds = WorldBoundsBox & {
  /** Exempt this entity completely (eg. the player, handled by its own respawn logic). */
  ignore?: boolean;
  action?: WorldBoundsAction;
  /** Required when action is 'CALLBACK'. Main thread only, never crosses the worker boundary. */
  onExit?: (e: WorldBoundsExitEvent) => void;
};

export type WorldBoundsExitEvent = {
  entityId: number;
  bodyId: number;
  /** The fixed step index the body was disabled on (getPhysicsSnapshotStepIndex scale). */
  step: number;
  /** Body translation on that step. */
  position: { x: number; y: number; z: number };
  source: 'GLOBAL' | 'ENTITY';
};
```

Public functions:

- `setSceneWorldBounds(def: WorldBoundsDef | null, sceneId?: string)` (`PhysicsManager.ts`): per-scene registration. Default target is the loading scene, else the current one — the same rule as `registerSkyBox`. `null` explicitly turns bounds off for that scene even if `AppConfig` has a default.
- `setEntityWorldBounds(entityId: number, bounds: EntityWorldBounds | null, ecsWorld?)` (`PhysicsManager.ts`): adds, replaces or removes the override.
- `createPhysicsEntity(..., entityOpts)`: `entityOpts.worldBounds?: EntityWorldBounds` as a shorthand for calling `setEntityWorldBounds` right after creation, applied before the creation promise resolves (so it is in place before the scene-load hold is released).
- `getWorldBoundsStats()`: exit count for the current scene, last N exits. Used by the debug tab (Phase 3).

---

## 4. Engine side (`Physics/EngineRapier.ts`)

State, all plain numbers so it is identical in both threads:

- `globalBounds: Float64Array(6) | null` — `[minX, minY, minZ, maxX, maxY, maxZ]`, open sides as ±Infinity.
- `bodyBounds: Map<bodyId, Float64Array(6) | IGNORE>` — per-body overrides. `IGNORE` is a shared sentinel.
- `pendingOutOfBoundsRecords: OutOfBoundsRecord[]` — `{ bodyId, step, x, y, z, source }`.

`step()` becomes: `physicsWorld.step(...)`, `drainAndDispatchEvents()`, then `checkWorldBounds(stepIndex)`. For every active dynamic body that is outside its effective box: `setEnabled(false)`, push a record. Disabled bodies are not active, so a body is reported once.

`resetPhysicsWorld` / world deletion clears `globalBounds`, `bodyBounds` and the pending records. Deleting a body removes its `bodyBounds` entry.

Engine functions, exposed through the same `EngineAPIType` surface as the rest: `setWorldBounds(box | null)`, `setBodyWorldBounds(bodyId, box | 'IGNORE' | null)`, `drainPendingOutOfBoundsRecords()`.

### 4.1 Protocol (`PhysicsAPITypes.ts`, worker switchboards)

- `WORLD_SET_BOUNDS` in the 200 range (`physicsSwitchWorld.ts`), `RIGID_SET_BOUNDS` in the 400 range (`physicsSwitchRigid.ts`). Both one-way, like the other setters.
- `EVENTS_PUSH` gets an `outOfBounds: OutOfBoundsRecord[]` field. `physicsWorker.ts`'s `pushPendingEvents` includes it and its "nothing to send" gate checks it too.

### 4.2 Main-thread delivery (`PhysicsAPI.ts`)

`PhysicsAPI.ts` stays ECS-free. It gets `registerOutOfBoundsHandler(fn)`, and `flushPhysicsEvents` hands the records to it — MAIN_THREAD straight from the engine, WORKER_THREAD from the queued `EVENTS_PUSH` messages — after collision/contact-force dispatch, in record order. `PhysicsManager.ts` registers the handler at module load.

---

## 5. ECS side (`PhysicsManager.ts`)

- **Body id → entity id map.** There is none today (storages are keyed by entity id). Maintain `bodyIdToEntityId` from the `onAddComponent` / `onRemoveComponent` hooks of `BODY_DYNAMIC_VISUAL` and `BODY_DYNAMIC_HEADLESS`.
- **`WORLD_BOUNDS` component** (core type in `ECS/ECSRegistry.ts` + `ECSCoreComponents.ts`) holding the `EntityWorldBounds`. Sparse: only entities with an override have it. Its add/remove hooks send `RIGID_SET_BOUNDS` (with `onExit` stripped — same pattern as `collisionEventFn`), and `onDeleteEntity` needs nothing extra because the body deletion clears the engine entry.
- **Out-of-bounds handler:** resolve `bodyId → entityId` (skip quietly if the entity is gone — same rule as stale collider events), pick the action (entity override, else the active global def, else `'DELETE'`), apply it per §1.3. Deletions are collected and run after the loop over the records.
- **Scene lifecycle:** `SceneLoader.ts` applies the scene's bounds (registered def, else `AppConfig.physics.worldBounds`, else none) right after `resetPhysicsWorld()`, before any `createPhysicsEntity` call, so the very first step of the scene already uses them. Registered scene defs are kept across visits (like sky boxes); per-entity overrides die with their entities.

---

## 6. Determinism probe (`Debug/_dbg__PhysicsDeterminism.ts`)

The body is disabled on a fixed step, but its ECS entity is deleted when the record is delivered, which in `WORKER_THREAD` mode can be a frame later. If the probe freezes on or just after an exit step, one run may still see the entity and another may not.

Fix: the probe excludes every body with an exit record whose `step` is ≤ its target step, whether or not the ECS deletion has happened yet. PhysicsManager keeps the exit steps for the current scene (they are needed for the stats in Phase 3 anyway). Verify with `?physicsProbe=N` on a scene where bodies fall out on purpose, in both worker targets, with N set to just before, on and just after an exit.

---

## 7. Debug environment

- In debug env, each exit logs one `lwarn` with the entity's name/appId, position and step. An exit is usually a bug signal (a collider that is smaller than its mesh, a body spawned inside another), and today nothing tells you it happened.
- Phase 3 adds the visual and the tab section (§9).

---

## 8. Interaction with other systems

- **Characters** (`Character.ts`, `utils/character/dynamicCharacter.ts`) are created through `createPhysicsEntity`, so they are covered. A player character usually wants `action: 'CALLBACK'` (respawn) or `ignore: true`. Deleting a character entity behind `Character.ts`'s back would leave its registry stale, so `createCharacter` should default characters to `'CALLBACK'` with an `onExit` that calls `deleteCharacter(id)`. Decide in Phase 2.
- **Joints:** deleting a body that has joints goes through the existing body deletion path; nothing new. `'DISABLE'` leaves the joint in place with a disabled body on one end: document it.
- **Snapshots (p500):** bounds are configuration, not simulation state, so a Rapier snapshot does not contain them. When p500 is implemented, a restore must re-send the current global and per-body bounds (the ECS side is the source of truth). Add a line to p500 when this lands.
- **`maxBodies` / transform buffer:** deleting exited bodies frees their slots, which is a real benefit in long-running scenes with spawners.

---

## 9. Phases

Each phase compiles, lints and can merge on its own.

### Phase 1 — Global bounds, delete only

- Engine side (§4): `globalBounds`, `checkWorldBounds`, the create-time check, records, `WORLD_SET_BOUNDS`, `EVENTS_PUSH.outOfBounds`.
- `PhysicsAPI.ts` delivery (§4.2).
- `PhysicsManager.ts`: `bodyIdToEntityId`, the handler with `'DELETE'` only, `setSceneWorldBounds`.
- `AppConfig.physics.worldBounds?: WorldBoundsDef | null` (default `null` in `core/Config.ts`).
- `SceneLoader.ts` wiring (§5).
- Debug log (§7) and the probe fix (§6).
- App: set a kill-Y in the third-person gym scene as the first consumer.

### Phase 2 — Per-entity overrides and actions

- `WORLD_BOUNDS` component, `setEntityWorldBounds`, `entityOpts.worldBounds`, `RIGID_SET_BOUNDS`, `IGNORE`.
- `'DISABLE'` and `'CALLBACK'` actions.
- Dev warning for overrides on fixed/kinematic bodies.
- Character default (§8).

### Phase 3 — Debug tooling

- Physics API debug tab: a "World bounds" folder (declarative pane, per `_DONE_p105`) with the active global box (read-only, source: config / scene / none), the exit count for the current scene and a list of the last exits (`debuggerListCMP`, clicking a row logs the entity).
- A toggle that draws the global box with the line system (`createLines`), open sides clipped to a large finite size, and per-entity boxes for selected entities. Implementation in a `_dbg__` file, dynamically imported.
- Optional: live editing of the scene's global box, stored as a debug override with an undo action (`_DONE_p061` pattern). Skip if it isn't needed.

### Phase 4 — Scene JSON

- Optional `worldBounds` key in `schemas/sceneSchema.ts` (same shape as `WorldBoundsDef`, without callbacks).
- `gatherAppData` passes it through; scene registration calls `setSceneWorldBounds`. The JSON Schema for editor autocomplete updates automatically.

### Phase 5 — Optional: non-physics entities

Only if a real use case appears. A main-thread system in `APP_LOGIC` for entities with `WORLD_BOUNDS` + `TRANSFORM` and no rigid body. Not deterministic-relevant, since those entities are not simulated.

---

## 10. Versioning

- Phases 1–4: engine **minor** bump each (new feature, non-breaking). Adding a field to `EVENTS_PUSH` is internal protocol, not public API.
- Phase 1 app change (gym kill-Y): app **minor** bump.
- Toolkit: unchanged.
- One `CHANGELOG.md` entry per merged branch, as usual.

---

## 11. Open questions

1. Should `'DISABLE'` also remove the entity from the spatial index (`SPATIAL_INDEXED`) while disabled, or is hiding the `OBJECT3D` enough?
2. Should the global default action be configurable per scene only, or also globally in `AppConfig` (the sketch allows both, via `WorldBoundsDef.action`)?
3. Is a body's translation always the right test point, or does a very large body (eg. a long plank) need a `margin`? Suggestion: leave it out until someone needs it.
