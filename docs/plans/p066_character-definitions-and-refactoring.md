Status: draft | not-implemented
Category: Character, Controls
Blocks: p067_character-state-debugger-window.md (and through it p068_character-debug-gizmos.md and p069_character-live-config-editing.md: this plan moves the files they cite and changes some of the data they read. Phase 2 updates their references.)

# Character Definitions and Refactoring — Plan

This plan makes characters first-class ECS entities with one registry and defines what a "character" is in Ækasha. A character is a **locomotion controller** (how the body is moved: physics model, gravity, input), plus a **body plan** (the shape and its dimensions: humanoid capsule now, quadruped later), plus an **intent** (what the player or the AI wants this sub-step).

It also answers where `dynamicCharacter` belongs and what it should be called. It then fixes the bugs and the per-sub-step costs found in `Character.ts` and `dynamicCharacter.ts`, and adds world-fixed 8-direction controls with auto-turn. It prepares extension points for the future animation-state and ragdoll systems.

Finally, it adds a top-down test scene: a large terrain with hills on one side, scattered static obstacles and dynamic props, and a sun whose shadow always covers the camera view.

The plan was originally requested as `p180`. It was renumbered to `p066` so that it lands before p067–p069, which build debug tooling on the character data this plan reshapes.

---

## 1. Context (grounded in code)

### 1.1 What exists

- **`src/_engine/core/Character.ts`**: the registry.
  - `createCharacter` resolves the mesh entity, adds physics through `createPhysicsEntity`, and registers key/mouse bindings.
  - It stores a `CharacterObject` in a module-level `characters` map keyed by string id (`:21`) and refreshes the debug GUI.
  - `deleteCharacter` removes the bindings and deletes the ECS entity.
  - `deleteAllCharacters` is called by `SceneLoader.ts` on scene change.
- **`src/_engine/utils/character/dynamicCharacter.ts`**: the only character type. `createDynamicCharacter` builds:
  - the `CharacterData` object (state / `_` config / `__` memory, `:22-83`);
  - four colliders on one DYNAMIC, rotation-locked body: walk capsule [0], crouch capsule [1], wall sensor [2], floor sensor [3] (`:639-778`);
  - `controlFns` (`rotate`, `move`, `jump`, `run`, `crouch`, `:407-631`);
  - eight hard-coded key bindings (`:794-876`);
  - a per-character tick closure (`:898-1207`: tumbling, getting up, falling, velocities, moving platforms, sliding), driven by one shared `APP_PHYSICS_STEP` system (`registerDynamicCharacterSystem`, `:229`, registered in `src/AppECSPlugins.ts:31`).
- **Callers:** `src/app/scene_thirdPersonGym.ts` is the only caller. It has one player character (`topDownChar`, tank controls) and one scripted dummy (`testDummyChar`) driven by a `dummyCharLooper` system that calls `controlFns.move`/`rotate`/`jump`.
- **Debug:** `src/_engine/core/Debug/_dbg__Character.ts` reads these `CharacterObject` fields: `id`, `name`, `entityId`, `meshId`, `keyControlIds`, `mouseControlIds` and `data`.

### 1.2 Structural problems

- **Two parallel registries.** `Character.ts:21` keeps one, and `dynamicCharacter.ts:193` keeps another, together with `activeCharacterTicks` (`:201`). The shared system checks `character.world !== world` and `world.isAlive(entityId)` for every character on every sub-step (`:212-222`), because nothing tells it when an entity dies.
- **No delete hook.** If the entity is deleted any way other than `deleteCharacter` (scene unload, the debug delete, `world.deleteEntity`), `Character.ts`'s map goes stale. `deleteCharacter` also throws on an unknown id.
- **Unused tag.** `TAG_IS_CHARACTER` exists (`ECSRegistry.ts:33`) but nothing adds it; `Character.ts:60` sets `mesh.userData.isCharacter` instead.
- **Characters are already entities.** The mesh entity gets the physics components. What's missing is a component that says "this entity is a character, and here is its state".

### 1.3 Bugs found

1. **Wrong capsule dimensions for anything except the defaults.** The walk capsule uses `halfHeight = _height / 5` (`:643`), the crouch capsule `_height / 10`, the wall cast the same pair (`:310-312`), and the floor ray length also derives from them (`:364`).
   - With the defaults (1.6 / 0.5) this happens to give a total height of 2 × 0.32 + 2 × 0.5 = 1.64.
   - With `_height: 2, _radius: 0.3` it gives 1.4 instead of 2.
   - The correct value is `max(0, _height / 2 - _radius)`. The gym's mesh already uses the correct formula (`scene_thirdPersonGym.ts:186-193`), so custom dimensions desync the mesh and the collider.
2. **Global key binding ids.** The ids `charRotateLeft`, `charMoveForward`, … are fixed strings (`:797-865`). `createKeyBinding` replaces any binding with the same id (`KeyboardInput.ts:235`), and `deleteKeyBinding` removes by id. A second input-mapped character therefore silently steals the first one's controls, and deleting either one removes both sets. This is hidden today only because the gym's dummy passes no `inputMappings`.
3. **`hasMoveInput` cleared too early.** A KEY_UP of _any_ move key sets it to `false` (`:831-841`), even while the other move key is still held. The landing and sliding logic reads it.
4. **Getting-up ease.** `ratio = now / (start + duration)` (`:931-934`) reaches 1 at the right time, but starts near `start / (start + duration)`, which is ≈ 0.98 a minute into a session. The ease-in torque ramp therefore never ramps. It should be `(now - start) / duration`.
5. **`CharacterObject.data` is always `{}`.** The `data: characterData` argument to `createCharacter` was dropped in `22a72a0` (see p067 §2.1). p067's Phase 1 fixes it; this plan does it instead, since it lands first.
6. **W+S held runs `move()` twice per sub-step.** Each call re-reads `linvel`, recomputes the whole slope/wall pipeline and fires another floor ray.

### 1.4 Per-sub-step costs found

- **`body.isMoving()` every tick** (`:974`). In `WORKER_THREAD` mode this is a full RPC round trip (`PhysicsAPI.ts:2759-2766`, posted immediately, not batched): one request/response pair per character per physics sub-step, only to fill the `isAwake` display field one tick late.
- **`refreshFloorNormal()`** has no in-flight guard (unlike `refreshWallHit`), so each `move()` call fires another RPC ray. It also runs only while there is move input, so `groundNormal`/`groundIsWalkable` go stale while idle or sliding.
- **Allocations every tick:**
  - `characterData.velocity`, `angularVelocity`, `__currentPlatformVelocity` and `__lastAppliedPlatformVelocity` are reassigned as new objects (`:999, :1013, :1020, :1119, :1168, :1190`).
  - `position = body.translation()` allocates in both modes (`:1205`).
  - `{x, y, z}` literals are passed to `setAngvel`/`setLinvel`.
  - `{ ...origin }`-style copies are made for the casts.
  - `linvel()` is read 2–4 times per sub-step, and allocates on the main thread.
- **`roundToDecimal`** runs on every velocity component on every tick (`:994-1017`, `:1129-1183`). This is display-only work in the hot path.

### 1.5 Dead config and magic numbers

- **Never read:** `_groundedRayMaxDistance`, `_tumblingAngDamping` and `__wasOnMovingPlatformLastFrame` (the last one has a `@TODO: remove`).
- **Hard-coded numbers with no config:**

  | Value  | What it is                      | Where   |
  | ------ | ------------------------------- | ------- |
  | 2.5    | tumble angular damping          | `:1239` |
  | 25     | getting-up angular damping      | `:930`  |
  | 2.0    | getting-up max angular velocity | `:946`  |
  | 0.2    | getting-up torque strength      | `:955`  |
  | 0.05   | wall micro-push                 | `:520`  |
  | 15     | slope slide speed               | `:592`  |
  | 100 ms | jump cooldown                   | `:613`  |
  | 0.7    | wall normal Y threshold         | `:343`  |
  | 0.2    | wall cast distance              | `:329`  |
  | 0.001  | platform-rotation epsilon       | `:1073` |

### 1.6 Engine facts this plan relies on

- **Input.**
  - `KEY_HELD` bindings fire once per fixed physics sub-step with the fixed delta, from `pollHeldKeyBindings` inside `runPhysicsSubStep` (`MainLoop.ts:126`). That is before `flushPhysicsEvents` and before `APP_PHYSICS_STEP`.
  - When physics is not stepping, they fire once per frame with the frame delta (`MainLoop.ts:137`).
  - `isChordHeld` (`KeyboardInput.ts:254`) exists, but it matches modifiers exactly and has no `ignoreModifiers` option.
  - There is no gamepad input (`GamepadInput.ts` is a stub).
- **Physics hot path.** `pos`, `rot`, `lvel`, `avel` and `readPoseInto` are synchronous in both modes. Everything with a `*Sync` twin (`isMoving`, `bodyType`, …) is an RPC in worker mode. Spatial queries (`castRay*`, `castShape`) are async, one RPC each, with no batching.
- **ECS.**
  - Component storage is one `Map<entityId, data>` per type.
  - `getStorage(type)` iterates `[id, data]` pairs.
  - `onDeleteEntity` hooks are static and global (`ECSWorld.registerComponentHooks`).
  - `deleteEntity` runs them per component the entity has; `onRemoveComponent` does _not_ fire on `deleteEntity`.
- **Lights.**
  - A directional light entity has `OBJECT3D` + `TRANSFORM` and a separate target entity linked through `TARGET_LINK` (`LightManager.ts:286-308`).
  - The shadow ortho frustum is fixed from JSON (`shadowCameraFrustum`).
  - Nothing fits the shadow camera to the view, and `CSMShadowNode` is unused.
  - `toolkit/ecs/effects/FollowTool.ts` moves lights by writing `TRANSFORM` at `APP_LOGIC`. `object3DSyncSystem` copies that into the Object3D at the next frame's `MAIN` stage, so the light is one frame late and follows the physics pose rather than the interpolated render pose.
  - In debug builds, `PropertyLoader.loadPersistentProps` can override JSON light props with stale values saved in localStorage.
- **Render-sync ordering.** `APP_RENDER_SYNC_ORDER` (`AppECSRegistry.ts:91-96`): higher runs earlier. `POSE_CONSUMERS` (-0.5; the follow camera rig) runs before `FRUSTUM_CULLING` (-1). A system that must see this frame's final camera, and must finish before culling, goes at about **-0.75**.
- **Terrain.**
  - `toolkit/geometry/generateTerrain.ts` builds a centered, indexed grid with noise over the whole extent and returns `getHeightAt`.
  - There is no `PLANE` geometry type, but `createMeshEntity` accepts a raw `BufferGeometry`.
  - The `HEIGHTFIELD` collider has a bug: `EngineRapier.ts:387-389` reads `nCols` from `params.nrows`. There's also a row-major vs. column-major heights trap. `TRIMESH` works.

---

## 2. Decisions

### 2.1 Should each character be an ECS entity? — Yes, with a `CHARACTER` component

Each character already is an entity: the mesh entity carries the physics components. This plan makes that explicit:

- **New core component `ComponentType.CHARACTER`.** Declared in `ECSRegistry.ts`, with the data type in `ECSCoreComponents.ts`. Its data is the `CharacterObject` (§3.1). The entity also gets `TAG_IS_CHARACTER`, the existing tag, now actually used. `mesh.userData.isCharacter` is dropped.
- **One registry.**
  - `Character.ts` keeps an `id → entityId` index for `getCharacterById(id)`. String ids stay the public handle, because the debug window ids (`characterEditorWindow_<id>`, `characterDataTrackerWindow_<id>`) and the scene code use them.
  - `getCharacters()` iterates the `CHARACTER` storage.
  - The map in `dynamicCharacter.ts` and `activeCharacterTicks` are removed.
- **An `onDeleteEntity` hook on `CHARACTER`.** It removes the character's bindings, its id-index entry and any controller resources, and refreshes the debug list. Every deletion path therefore cleans up the same way, including `world.deleteEntity` directly, scene unload and the debug delete button.
  - `deleteCharacter(id)` becomes `world.deleteEntity(entityId)` plus the hook.
  - It no longer throws on an unknown id; it returns `false`.
- **Per-world iteration.** The controller system iterates `world.getStorage(CHARACTER)`, which is per-world by construction, so the `world !== world` and `isAlive` checks go away.

A separate "CharacterEntity manager" is not needed. `Character.ts` _is_ that manager once the component exists, following the same pattern as `MeshManager.ts`, `CameraManager.ts` and `LightManager.ts`.

### 2.2 One creator for every character type, or one per type? — One per locomotion model

What differs between a humanoid, a horse and a bird is not the name of the animal. It's two separate things:

| Axis                                               | What changes                                                                                                 | How it is expressed                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **Locomotion model**: how the body is moved        | Physics body type, who applies gravity, whether movement is 2D ground or 3D air, how collisions are resolved | A **controller**, with its own creator function |
| **Body plan**: what the body looks like to physics | Collider shapes and dimensions, sensor placement, wall probe shape, turning constraints                      | A **body plan** parameter of the controller     |

With that split:

- **`createDynamicCharacter` keeps its name.** "Dynamic" is the right word, and it is the reason the name was chosen: a _dynamic rigid body_ moved by setting velocities, with the physics engine applying gravity and resolving contacts. A future `createKinematicCharacter` (Rapier's `KinematicCharacterController`, which applies its own gravity and sweep-and-slide) would sit beside it as a different controller, not as a different animal.
- **Humanoid and quadruped are body plans of the same dynamic controller.** A horse-like character can walk, run, jump, slide down slopes, ride platforms and tumble on the same controller. What it needs is different dimensions and some constraints:

  - a horizontal capsule or a compound collider instead of a vertical capsule;
  - sensors placed under the legs;
  - a wall probe shaped like the body and aligned to the facing;
  - a speed-dependent turn rate, since it can't turn on the spot.

  This plan implements only `HUMANOID_CAPSULE`, but it routes _every_ dimension-dependent number (colliders, crouch shape, sensors, wall-cast shape, floor ray length) through the body plan's derived dimensions, so adding a `QUADRUPED` plan is purely additive.

- **Flying (bird-like) needs its own controller** (`createFlyingCharacter`, future). Gravity becomes lift, the intent becomes 3D, and "grounded" becomes a landing state. It still reuses everything around the controller: the registry, the component, the intent, the input schemes, the locomotion-state events and the debug window.
- **`kind` is data, not a function name.** `CharacterObject.kind` is a string (`'HUMANOID'`, `'QUADRUPED'`, …) set by the body plan. Game code and the animation system can switch on it without the engine needing a separate call for each kind.

### 2.3 Where does it belong? — `src/_engine/core/Character/`

The repo already uses a facade-file-plus-folder idiom: `ECS.ts` + `ECS/`, `PostFX.ts` + `PostFX/`, `PhysicsAPI.ts` + `Physics/`. Characters follow it:

```
src/_engine/core/
  Character.ts                    ← registry / facade (stays here: createCharacter, deleteCharacter,
                                    getCharacterById, getCharacters, the CHARACTER hooks, debug entry points)
  Character/
    CharacterTypes.ts             ← CharacterObject, CharacterIntent, CharacterControlMode,
                                    LocomotionState, BodyPlan types
    CharacterBodyPlans.ts         ← HUMANOID_CAPSULE body plan + getBodyDimensions()
    CharacterIntent.ts            ← createIntent(), clearIntent(), intent helpers (setMoveDir, …)
    CharacterInputSchemes.ts      ← TANK / WORLD_FIXED / CAMERA_RELATIVE → binding lists that write the intent
    DynamicCharacter.ts           ← createDynamicCharacter + the controller system
                                    (moved from src/_engine/utils/character/dynamicCharacter.ts)
```

`src/_engine/utils/character/` is deleted. The code stays in `_engine` and does not go to `toolkit`: the p067–p069 debug tools are engine-level and target it, TypeDoc documents only `_engine/**`, and every game needs a character. `utils/` was the wrong home because this is a stateful manager with an ECS system, not a helper.

The camera rig (`utils/cameras/followObjectCameraRig.ts`) and the world helpers (`utils/world/*`) are out of scope and stay where they are.

### 2.4 Controls — a per-character movement intent

Today, input bindings call imperative `controlFns` (`move('FORWARD')`, `rotate('LEFT')`) that each do the full physics work. This plan puts a small **intent** object between input and physics:

```ts
type CharacterIntent = {
  /** World-space desired horizontal move direction, magnitude 0..1 (0 = no move input). */
  moveX: number;
  moveZ: number;
  /** Tank-style turn input, -1..1 (positive = left / counter-clockwise, matching today's 'LEFT'). */
  turn: number;
  /** Desired facing yaw (radians), or null to leave facing alone / derive it from the move direction. */
  faceYaw: number | null;
  /** Edge-triggered: set by a KEY_DOWN, consumed and cleared by the next tick. */
  jump: boolean;
  run: boolean;
  crouch: boolean;
};
```

- **Writers.** Input schemes, AI, cutscenes and network code all write the intent. The controller's tick is the only reader: it consumes the intent once per sub-step and then clears the per-sub-step fields (`moveX`, `moveZ`, `turn`, `jump`). This fixes bug 6, since W+S just sums to 0.
  - `run` and `crouch` are persistent. A scheme option decides whether they toggle (today's behaviour) or apply while held.
- **`hasMoveInput`** is derived in the tick from `moveX² + moveZ² > ε`. This fixes bug 3, and the KEY_UP binding goes away.
- **Bindings** are namespaced `${charId}:moveForward`, … (fixes bug 2), and `KEY_HELD` fns only add to the intent. That is cheap, and it matches the delivery order: all held-key callbacks for a sub-step run before `APP_PHYSICS_STEP`.
- **`controlFns.rotate/move/jump`** remain as thin wrappers that write the intent, so scripted callers keep working. The gym's dummy AI moves to writing the intent directly as the example.

**Control schemes** (`CharacterInputSchemes.ts`). Each one turns an `inputMappings` object into namespaced bindings:

| Scheme                                  | Keys → intent                                                                                                                             | Facing                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `TANK`                                  | A/D → `turn` ±1; W/S → move along the current facing ±1                                                                                   | Turns only from `turn`. This is today's behaviour and the gym default.                           |
| `WORLD_FIXED`                           | W → North (`-Z`), S → South (`+Z`), A → West (`-X`), D → East (`+X`); combinations are summed, then normalized (S+A → exactly South-West) | **Auto-turns toward the move direction**, along the shortest angle, at most `_rotateSpeed` rad/s |
| `CAMERA_RELATIVE` (optional in Phase 3) | Like `WORLD_FIXED`, but the basis is rotated by the given camera's yaw                                                                    | Auto-turn, as in `WORLD_FIXED`                                                                   |

- **Movement direction and facing are independent in `WORLD_FIXED`.** The body moves in the input direction immediately, while the facing turns toward it over time. A character facing North that is sent South therefore moves South at once and swings around to face South. An option `_turnToMoveDirection` (default `true` for world-fixed and camera-relative) lets a game keep a fixed facing instead (strafing, twin-stick aiming through `faceYaw`).
- **Yaw convention** (documented in `CharacterTypes.ts`). Forward is `(cos r, 0, -sin r)`, so `r = 0` faces `+X` (East) and `r = π/2` faces North (`-Z`). The target yaw for a direction is `atan2(-dz, dx)`. The shortest turn is `wrapToPi(target - current)`, clamped to `±_rotateSpeed · dt`.

**Vector move math.** `move()` currently clamps X and Z separately against a facing-aligned max (`:445-472`). That only works because the direction is always the facing. It becomes a vector operation:

- The desired horizontal velocity is `dir · maxVelo · |intent|`.
- The horizontal _relative_ velocity (relative to the platform, as today) moves toward it by at most `accel · dt`, where `accel = _accumulateVeloPerInterval` × the in-air and crouch multipliers, as today.
- This keeps the current semantics: when grounded, the speed is clamped to max; in the air, existing overspeed along the direction is not reduced.
- The wall-slide, unwalkable-slope and moving-platform corrections stay exactly as they are; they already work on the vector `vel`.
- `TANK` must feel identical to today (see §5).

### 2.5 Preparing for animation states and ragdoll (extension points only)

- **`locomotionState`.** A single derived enum (`IDLE | WALK | RUN | CROUCH | CROUCH_WALK | JUMP | FALL | SLIDE | TUMBLE | GET_UP`) is written at the end of each tick from the existing booleans, with `__locomotionStateStartTime`.
  - `onLocomotionStateChange(charId, cb)` fires on change, once per change, from the tick. That is what a future animation-state system subscribes to.
  - The booleans stay, because they are what the physics logic and p067's window read.
- **Separate visual root.** The controller never reads the mesh. The body is the single source of truth, and it already is for rotation (`:391-405`). The mesh is just the entity's `OBJECT3D`. A skinned mesh or a group can replace the capsule mesh with no controller changes.
  - `createDynamicCharacter` takes `visual: THREE.Object3D` (the renamed `charMesh`). `CharacterObject.meshId` becomes `visualId`.
- **`setControlMode(charId, 'CONTROLLED' | 'PHYSICS_ONLY')`.** In `PHYSICS_ONLY` the tick still updates the state and data but applies no velocities, torques or rotation locks. Tumbling becomes the documented hand-off point: a future ragdoll system switches the character to `PHYSICS_ONLY`, drives the joints (p250 multibody joints), and hands control back through the existing getting-up path.
- **Body plan hooks.** The body plan declares its colliders by role (`MAIN`, `CROUCH`, `WALL_SENSOR`, `FLOOR_SENSOR`) instead of by array index. The controller looks them up by role, so a plan can add colliders (legs, a head, a tail) without shifting indices. This also replaces the "[INDEX: n]" comments that p068 cites.

### 2.6 Sun that follows the player, and shadows that cover the camera view

The effect is a toolkit ECS effect, **`src/toolkit/ecs/effects/SunShadowFit.ts`**. It sits beside `FollowTool.ts`, is registered in `src/AppECSPlugins.ts`, and adds a `SUN_SHADOW_FIT` component to the directional light entity:

```ts
type SunShadowFitData = {
  /** Camera entity whose view the shadow must cover (default: the current main camera). */
  cameraEntityId?: number;
  /** Clip the covered view slice to this distance from the camera (world units). */
  maxDistance: number;
  /** Extra depth toward the sun so off-screen casters (tall walls, hills) still cast into the view. */
  casterExtension: number;
  /** Distance from the fitted center to the light along the sun direction. */
  lightDistance: number;
  /** Snap the fitted center to whole shadow-map texels in light space (prevents shimmering). Default true. */
  snapToTexels?: boolean;
  /** Fallback center when no camera is available (e.g. the player entity). */
  followEntityId?: number;
};
```

**Per frame** it runs at `APP_RENDER_SYNC`, order **-0.75**: after the follow camera rig has placed this frame's camera (`POSE_CONSUMERS`, -0.5) and before frustum culling (-1).

1. Take the main camera's frustum corners, clipped between `near` and `min(far, maxDistance)`.
2. Compute the bounding sphere of those corners. A sphere keeps the ortho extents the same size under camera rotation, so they only change on zoom, which avoids re-projecting every frame.
3. Keep the sun direction fixed: it comes from the light JSON's `position → targetPos`. Transform the sphere center into light space, and snap it to texel size `2r / mapSize` when `snapToTexels` is set.
4. Set the target position to the snapped center, and the light position to `center − dir · lightDistance`.
5. Set the ortho extents to `±r`, `near = lightDistance − r − casterExtension` and `far = lightDistance + r`. Call `shadow.camera.updateProjectionMatrix()` only when the extents change.
6. Write the Object3Ds directly, `light.position` and `light.target.position` (plus `updateMatrixWorld`), because a `TRANSFORM` write would reach them only next frame. Also write the two `TRANSFORM`s, so the ECS state and the debug tools agree and the next `object3DSyncSystem` pass doesn't snap them back.

The top-down camera follows the player, so fitting to the camera view _is_ following the player. `followEntityId` only matters when there's no camera. One cascade is enough for a fixed-pitch top-down view; CSM is a non-goal.

### 2.7 Terrain — plane plus a hills patch

- `generateTerrain` gets an optional `heightModifier?: (x: number, z: number, h: number) => number` in `TerrainOptions`. It is applied per vertex _before_ the geometry is built, so `getHeightAt` and the returned heights stay consistent (the scene uses them to scatter props on the hills). It is backwards-compatible, with no change for existing callers such as `largeWorld.ts`.
- The scene uses the approach from the request:
  - one large flat ground, a thin BOX with a BOX collider, the cheapest possible;
  - one hills patch on the East side, generated with a `heightModifier` mask. The mask is a smoothstep from 0 at the West edge of the patch to 1 further East. The patch edges sink slightly below the ground level (about −0.3), so no seam shows where the patch pokes out of the plane.
  - The patch gets a **TRIMESH** collider, built from the geometry's `position` and `index` arrays.
- HEIGHTFIELD is avoided (see §1.6). The bug is noted for `p100_small-bug-fixes-and-tweaks.md`, not fixed here.

---

## 3. Design details

### 3.1 `CharacterObject` (the `CHARACTER` component data)

```ts
export type CharacterObject = {
  id: string;
  name?: string;
  /** Body plan kind, e.g. 'HUMANOID'. Data, not a code path — switch on it in game code. */
  kind: string;
  entityId: number;
  /** App id of the visual root (was `meshId`). */
  visualId: string;
  /** Namespaced binding ids owned by this character (`${id}:…`). */
  keyBindingIds: string[];
  mouseBindingIds: string[];
  /** Live controller data. Keys follow the naming convention the debug window relies on:
   * no prefix = state, `_` = configuration, `__` = internal memory. Mutated in place every tick —
   * always re-read `data[key]`, never cache nested object references across ticks. */
  data: Record<string, unknown>;
  intent: CharacterIntent;
  controlMode: CharacterControlMode;
  /** Controller-owned tick; set by createDynamicCharacter (or a future controller). */
  controller?: { tick: (dt: number) => void; dispose?: () => void };
};
```

`keyControlIds`/`mouseControlIds` become `keyBindingIds`/`mouseBindingIds`, and `meshId` becomes `visualId`. `_dbg__Character.ts` is updated in the same phase.

### 3.2 `createDynamicCharacter` options (after Phase 4)

```ts
createDynamicCharacter({
  id: 'player',
  visual: characterMesh,                  // THREE.Object3D (entity with OBJECT3D)
  body: HUMANOID_CAPSULE,                 // default; carries kind + collider/sensor builders
  charData: { _height: 1.8, _radius: 0.4, _maxVelocity: 4.5 },
  input: {
    scheme: 'WORLD_FIXED',                // 'TANK' | 'WORLD_FIXED' | 'CAMERA_RELATIVE'
    mappings: { moveNorth: ['w'], moveSouth: ['s'], moveWest: ['a'], moveEast: ['d'],
                jump: [' '], run: ['Shift'], crouch: ['Control'] },
    runMode: 'TOGGLE',                    // 'TOGGLE' (today) | 'HOLD'
    // cameraEntityId for CAMERA_RELATIVE
  },
  onLocomotionStateChange: (next, prev) => { … },  // optional
});
```

- Each scheme has its own typed `mappings` shape: `TANK` keeps today's `rotateLeft`/`rotateRight`/`moveForward`/`moveBackward`/…
- Omitting `input` creates an AI/scripted character: no bindings, and the intent is written by code.
- It returns `{ character: CharacterObject, data, intent, controlFns }`. `data` is the same live object as `character.data`.

### 3.3 Derived dimensions

`HUMANOID_CAPSULE.getDimensions(data)` computes, once at creation (and again from p069's live-edit hook):

- `walkHalfHeight = max(0, _height / 2 − _radius)`
- the crouch capsule from the new `_crouchHeight` (default **1.32**, which reproduces today's crouch capsule exactly), with the Y offset that aligns its bottom with the walk capsule's bottom
- the wall-sensor, floor-sensor, wall-cast and floor-ray values

All call sites read these values instead of `_height / 5` and `_height / 10`. For the defaults (1.6 / 0.5) the walk half-height becomes 0.3 instead of 0.32: the capsule is 4 cm shorter (1.64 → 1.6) and now matches its own mesh. This is the only intended change to the default collider size, and it is called out in the Phase 1 commit.

### 3.4 Hot-path rules for the controller tick

- Read the pose once per tick with `body.readPoseInto(scratch)` (position, rotation, linear velocity, angular velocity). Never call `linvel()` or `translation()` more than once.
- Mutate `data.position`, `velocity`, `relVelocity`, `angularVelocity`, `groundNormal`, `__currentPlatformVelocity` and `__lastAppliedPlatformVelocity` in place. Pass module-level scratch objects to `setLinvel`/`setAngvel`/`applyImpulse`.
  - Worker safety: one-way commands are structured-cloned when the STEP message is posted, so the same scratch object can be reused within a sub-step as long as each call has read it before the next write. **Verify** this against `PhysicsAPI.ts`'s command capture. If the capture holds a reference instead of copying, keep a small ring of scratch objects.
- `isAwake` is derived locally: `velocity.length > ε || angularVelocity.length > ε`. The `isMoving()` RPC is removed.
- `refreshFloorNormal` runs from the tick (not from `move()`), guarded by a `floorCastInFlight` flag like `refreshWallHit`. So there is at most one floor RPC and one wall RPC in flight per character, and the ground normal also updates while idle.
- No rounding in the hot path. `_roundVelocitiesScalingFactor` is removed. Display formatting is p067's job (fixed-width numbers).

### 3.5 Config cleanup

- **Removed:** `_groundedRayMaxDistance`, `_tumblingAngDamping`, `__wasOnMovingPlatformLastFrame`, `_roundVelocitiesScalingFactor`.
- **Added**, each defaulting to today's hard-coded value so behaviour is unchanged:

  | New config key             | Default    |
  | -------------------------- | ---------- |
  | `_tumblingAngularDamping`  | 2.5        |
  | `_gettingUpAngularDamping` | 25         |
  | `_gettingUpMaxAngVelo`     | 2.0        |
  | `_gettingUpTorque`         | 0.2        |
  | `_wallMicroPush`           | 0.05       |
  | `_slopeSlideSpeed`         | 15         |
  | `_jumpCooldown`            | 100 (ms)   |
  | `_wallNormalMaxY`          | 0.7        |
  | `_wallCastDistance`        | 0.2        |
  | `_crouchHeight`            | 1.32       |
  | `_turnToMoveDirection`     | per scheme |

- Every `CharacterData` field gets a one-line JSDoc: this resolves the `@TODO: add comments for each` at `:19`, and p067/p069 can show it as a tooltip.

---

## 4. Phases

Each phase leaves the tree compiling (`yarn lint`, `yarn build`), keeps the gym scene working in both physics worker targets, and is committed on its own.

### Phase 1 — Bug fixes and performance, in place (no file moves)

- Fix bugs 1–6 (§1.3), including `data: characterData` → `createCharacter`.
- Implement the derived dimensions from §3.3 inside `dynamicCharacter.ts`, as a local function for now.
- Apply the hot-path rules from §3.4 and the config cleanup from §3.5.
- Namespace the binding ids. This part of bug 2's fix doesn't need the intent.
- Fix `hasMoveInput` by tracking a held-move-key count until the intent lands in Phase 3.
- **Verify:** the gym works in `MAIN_THREAD` and `WORKER_THREAD` (walk, run, crouch, jump, stairs, slopes, the slide obstacle, all moving platforms, tumble and get up). The worker RPC count per frame drops (Physics API stats tracker, `_DONE_p027`).

### Phase 2 — `CHARACTER` component, a single registry, and the move

- Add `ComponentType.CHARACTER` and its data type, and add `TAG_IS_CHARACTER` in `createCharacter`. Register the `onDeleteEntity` hook in `Character.ts`. Switch `Character.ts` to the `id → entityId` index plus storage iteration.
- Move `utils/character/dynamicCharacter.ts` to `core/Character/DynamicCharacter.ts`. Extract `CharacterTypes.ts`. The system iterates `getStorage(CHARACTER)` and calls `character.controller.tick(dt)`. Remove `activeCharacterTicks` and the second map.
- Apply the `CharacterObject` field renames (§3.1) and update `_dbg__Character.ts`, `SceneLoader.ts`, `InitApp.ts`, `DraggableWindow.ts`, `AppECSPlugins.ts` and `scene_thirdPersonGym.ts`.
- **Update the dependent plans:**
  - In p067, p068 and p069, update the file paths and line references, and the renamed fields.
  - p067 §2.3: data is now mutated in place (still re-read `data[key]`); §2.1: the data link is already restored, so its Phase 1 shrinks.
  - p068: colliders by role instead of index.
  - p069: the new and removed config keys; the dimensions now come from `getDimensions` (the derived-value hook).
  - Add `Blocked by: p066_character-definitions-and-refactoring.md` to p067's header.

### Phase 3 — Intent and control schemes

- Add `CharacterIntent.ts` and `CharacterInputSchemes.ts` (`TANK`, `WORLD_FIXED`; `CAMERA_RELATIVE` if it fits in the phase, otherwise a follow-up).
- The tick consumes the intent: vector move math (§2.4), auto-turn, and `hasMoveInput` derived from the intent.
- Turn `controlFns` into intent-writing wrappers. Switch the gym's `dummyCharLooper` to writing the intent.
- **Verify:** `TANK` in the gym feels identical to Phase 2 (§5). A second input-mapped test character in the gym, with different keys, works independently, and deleting it leaves the first one's controls intact.

### Phase 4 — Body plans, locomotion state, control mode

- Add `CharacterBodyPlans.ts` with `HUMANOID_CAPSULE`: colliders by role, `getDimensions`, and `kind: 'HUMANOID'`. `createDynamicCharacter` gets the final options shape (§3.2).
- Add `locomotionState` and `onLocomotionStateChange`, `setControlMode`, and the `visual` option.
- Add JSDoc to all public exports (they appear in `yarn docs`).

### Phase 5 — Toolkit additions

- Add the `generateTerrain` `heightModifier` option (§2.7).
- Add the `SunShadowFit` effect (§2.6), registered in `AppECSPlugins.ts` and added to `AppECSRegistry.ts`'s component types in the toolkit pattern (`HoverEffect.ts`/`FollowTool.ts`).

### Phase 6 — Top-down test scene

New files (the `topDownTest` id family, following the gym's `thirdPersonGym.scene.json` + `scene_thirdPersonGym.ts` pattern):

- `src/app/topDownTest.scene.json`: `id: "topDownTestScene"`, `sceneFile: "./scene_topDownTest.ts"`, the camera, the two lights, and optionally a skybox (reuse `emptyBlueSkyEquiRect`).
- `src/app/scene_topDownTest.ts`
- `src/app/cameras/topDownTestCamera.camera.json`
- `src/app/lights/topDownTestAmbient.light.json`
- `src/app/lights/topDownTestSun.light.json`: `castShadow`, `shadowPreset: "HIGH"`, a low-ish angle for readable shadows. Its initial frustum is overwritten at runtime by `SunShadowFit`.

Scene content:

- **Ground:** a 300 × 300 flat BOX (a BOX collider, `receiveShadow`) with a checkerboard material (`toolkit/materials/checkerBoard`, or the gym's UV grid), so motion and direction read clearly from above.
- **Hills:** a patch of about 120 × 300 on the East side, from `generateTerrain` with a smoothstep mask; peaks of about 12–15 units, 80–100 segments. It gets a TRIMESH collider, casts and receives shadows, and its edges sink below the ground.
- **Static obstacles:** about 15, placed by a seeded scatter (`toolkit/geometry/seededRandom.ts`) with a spawn-exclusion radius: wall segments, pillars (cylinders), a ramp, a low box to jump onto, and a few on the hills placed with `getHeightAt`. They are FIXED, with shadows.
- **Dynamic props:** about 25 boxes, balls, cylinders and capsules of mixed sizes and densities, lying around (DYNAMIC, with shadows).
- **Character:** a `WORLD_FIXED` player character (the same capsule and beak visual as the gym), spawned on the flat part.
- **Camera:** `createFollowObjectCameraRig` at offset `{ x: 0, y: 20, z: 8 }`: directly South of and above the player, so North (`-Z`) is screen-up and W moves straight up the screen.
- **Sun:** a `SUN_SHADOW_FIT` component on the sun entity, added in `registerOnSceneEnter`, because the JSON lights are created after the scene TS runs (`SceneLoader.ts:332-338`).
- **Cleanup:** `registerOnSceneExit` deletes the follow rig. The character, the bindings and the `SUN_SHADOW_FIT` component go with their entities through the hooks, with no manual cleanup, which exercises Phase 2.

---

## 5. Risks and mitigations

- **Drift in the tuned tank feel** from the vector move math. Mitigation: Phase 3 compares against Phase 2 in the gym at 60 Hz and 144 Hz (or with a throttled frame rate) for acceleration, top speed, air control and landing on moving platforms. The scalar-per-axis form is kept, behind the `TANK` scheme, if a difference can't be tuned away.
- **Shadow shimmering and swimming.** A fitted shadow camera shimmers unless its center is snapped to texels and its extents stay stable. Mitigation: a bounding sphere plus texel snapping, both on by default (§2.6).
- **Stale debug light overrides.** In debug builds, `loadPersistentProps` can merge old saved shadow values over the JSON. `SunShadowFit` owns the frustum at runtime, so this only affects the first frame. The debug Light GUI edits to that light's frustum are overwritten while the component is present; document this in the effect's JSDoc.
- **Scratch-object reuse in worker mode** (§3.4). Verify how one-way commands are captured before sharing scratch objects across calls.
- **The dependent plans (p067–p069)** were written against the current code. Phase 2 updates them in the same commit that invalidates them.
- **The 4 cm collider change** (§3.3) on the default capsule is intentional. Stairs and step-up behaviour must be re-checked in the gym.

## 6. Non-goals

- The animation state machine and ragdoll (only the extension points in §2.5).
- The `QUADRUPED` body plan and the flying controller (only the interfaces).
- A kinematic (Rapier KCC) controller.
- Characters or physics in the scene/asset JSON schema.
- CSM / multi-cascade shadows.
- The HEIGHTFIELD `nCols` fix (→ p100).
- Gamepad input.
- Moving `followObjectCameraRig.ts` or `utils/world/*`.

## 7. Verification

- `yarn lint` and `yarn build` after every phase. The Stop hook enforces both.
- **Gym (`thirdPersonGymScene`),** in `AppConfig.physics.workerTarget` `MAIN_THREAD` and `WORKER_THREAD`:
  - the player character with `TANK` controls walks, runs, crouches, jumps, climbs stairs, slides off steep slopes, rides every moving platform, tumbles and gets up;
  - the dummy AI behaves as before;
  - leaving and re-entering the scene leaves no stale systems, bindings or characters (check the debug Characters tab and the key-binding list).
- **Multiple characters:** a second input-mapped character with different keys works independently; deleting either one leaves the other's controls intact.
- **Performance:** the Physics API stats tracker shows the per-character `isMoving` RPCs gone, and at most one floor and one wall cast in flight per character. A heap timeline while walking shows no per-sub-step allocations from the controller.
- **Top-down scene (`topDownTestScene`):**
  - W moves exactly North (`-Z`, screen-up); S+A moves exactly South-West.
  - Turning North → South moves South immediately and turns the character to face South, along the shortest direction.
  - Running across the whole flat area and onto the hills keeps shadows under every visible object, up to every screen corner, with no shimmer.
  - Dynamic props can be pushed; static obstacles block and wall-slide correctly.
  - Switching scenes in and out works cleanly.
- Use the `run-aekasha-js` skill for screenshots and console/WebGPU error checks.

## 8. Versioning

The changes are breaking and no compatibility shims are kept: the module moves, `CharacterObject` fields are renamed, and the `createDynamicCharacter` options change shape. At merge to `main`:

- **Engine:** `engine_metadata.version` and `version` go from `1.2.0` to **`2.0.0`**, and the codename changes from "Sunrise" to **"Morning"**.
- **App:** `app_metadata.version` goes from `1.1.0` to **`1.2.0`** (the new test scene and the gym migration).
