Status: in progress | Phases 1-2 implemented
Category: Architecture, Characters, Gameplay
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage A)
Blocks: p610_character-and-input-action-architecture.md, p420_npc-simulation-tiers.md (soft: its NPC entity and tiers use these contracts)
Related: p604_multiplayer-viability-study.md (the network brain and the determinism rules), p307_wet-and-dry-surface-states.md (consumes the weather state), the "Refactor dynamic character code" (p070) and "Key binding refactoring" (p770) prompts in `docs/templates/todo-plan-prompts.txt`

# Gameplay Architecture Contracts

Where characters with other controllers, IK and animation states, vehicles, NPCs and their AI,
missions, cutscenes on splines, story, weather and mood, randomness and remote players fit, and
which small set of contracts lets each be built later without reshaping the rest.

**This plan writes contracts and stub plans, not features** (decided for p600). The existing
character code is refactored into the contracts by p610; every new feature gets its own stub plan
outside p600.

---

## 1. Goal

- **One model for everything that acts in the world:** a player character, an NPC, a vehicle, a
  remote player and a cutscene actor differ in which controller moves them and which brain decides
  what they want, not in their base code.
- **Engine, toolkit, app split for gameplay:** generic contracts and one solid implementation of
  each in the engine; ready-made controllers, brains and effects in the toolkit; game logic in the
  app.
- **No speculative abstraction:** a contract is firm when it has two real implementations (or one
  and a named second one in a stub plan); otherwise it's recorded as a direction and waits.

## 2. Grounding (checked against the code, 2026-10-09)

- `core/Character.ts`: the `CHARACTER` component, bindings, `characterControllerSystem` at
  `APP_PHYSICS_STEP` (order -10) calling `controller.tick(dt)`, `setControlMode`,
  `onLocomotionStateChange` (a 10-state `LocomotionState`).
- `core/Character/CharacterTypes.ts`: `CharacterIntent` (`moveX` / `moveZ` / `moveForward` summed
  per sub-step, `turn`, `faceYaw`, edge-triggered `jump`, persistent `run` / `crouch`), documented
  as written "by its input scheme, AI, cutscene or network code and read only by its controller's
  tick". `CharacterController` (`tick`, `dispose?`, `probes?`, `config?`), `CharacterBodyPlan`
  (`HUMANOID_CAPSULE` only).
- `core/Character/DynamicCharacter.ts`: the only controller, a dynamic rigid body driven by
  velocities and torques; `createDynamicCharacter` is a ~970-line closure that also wires the
  keyboard input schemes (`CharacterInputSchemes.ts`: TANK, WORLD_FIXED, CAMERA_RELATIVE, a closed
  union). `CharacterData` mixes state, `_` config and `__` internals in one object, and the
  debug tools depend on the prefixes.
- Rapier's `KinematicCharacterController` is a commented-out signature in
  `core/Physics/PhysicsAPITypes.ts`.
- The gym (`app/scene_thirdPersonGym.ts`) already drives a "dummy" character from code: an AI
  brain in all but name.
- No animation system (no `AnimationMixer` use in the engine), no action layer above devices, a
  gamepad stub, no event bus, no splines, no weather state, `Math.random` in simulation code.

Rechecked in Phase 1 (corrections and what the list above missed):

- Two more character files: `CharacterIntent.ts` (`createIntent`, `clearIntentSubStep`,
  `addIntentMove`, `hasMoveIntent`, `yawFromDirection`, `wrapToPi`) and `CharacterBodyPlans.ts`
  (`HUMANOID_CAPSULE`, the one body plan).
- The controller's clock is `getPhysGameTime()`: `performance.now()` minus the pauses
  (`PhysicsAPI.ts:987`), so the wall clock, as stated.
- `Math.random` in engine simulation code is the dynamic character's tumble start only
  (`DynamicCharacter.ts:1497-1500`). `Spatial/SpatialIndexSystem.ts`'s calls are the debug
  oracle's, and `utils/ECSStressTest.ts` / `PhysicsStressTest.ts` are stress tools.
- A seeded RNG exists: `toolkit/geometry/seededRandom.ts` (`createSeededRandom`, mulberry32), used
  by the terrain, foliage, asteroid and scatter generators and by app scenes. It's a seeded
  function, not a service with named streams. It's in the toolkit, so engine code can't use it
  (p602 maps it to `toolkit/geometry/SeededRandom.ts`).
- `followObjectCameraRig` is engine code today (`utils/cameras/`); p602's move map puts it in the
  toolkit (`toolkit/ecs/FollowObjectCameraRig.ts`). `FollowTool` moves a light and its target
  after a leader; it's not a camera tool.
- Held keys are polled once per physics sub-step (`pollHeldKeyBindings(stepDelta)`,
  `MainLoop.ts:179`), right before `flushPhysicsEvents()` and the `APP_PHYSICS_STEP` systems
  (once per frame when physics is off). `KEY_DOWN` bindings run at DOM event time.
- `ECSWorld.addSystem` runs higher `order` first, so the character system (order -10) runs after
  the order-0 `APP_PHYSICS_STEP` systems, the gym's dummy looper among them, and after the tier
  systems (100, 110).
- Per-feature listeners exist, with no shared shape: `onLocomotionStateChange`, per-collider
  collision callbacks, `onSkyBoxChange`, `registerOnSceneExit`, `onDevDataGathered`,
  `onGeometryDeleted`.
- Time of day is owned by the sky box's day-night cycle (`ActiveSkyBox.time`,
  `setTimeOfDay` / `getTimeOfDay` in `SkyBox/SkyBox.ts`).

## 3. The contracts

TypeScript shapes are sketches; p610 and the stub plans write the real ones.

### C1. Actor (firm)

An actor is an ECS entity with an `ACTOR` component: `{ kind, controller, brain }`, where
`kind` is open (`'CHARACTER' | 'VEHICLE' | …`, extended by declaration merging, p602 / p606).
No class hierarchy: what an actor can do is the set of components it has.

- `controller` and `brain` are the instances (C2, C4), read directly by the systems: no lookup
  per actor per step.
- Controller and brain **kinds** are registered by name with a factory
  (`registerControllerKind`, `registerBrainKind`). A save or a network message records
  `{ kind, params }` and the factory rebuilds the instance; the actor's id names the instance.
- The body's own kind is `bodyKind` (`'HUMANOID'`, from the body plan): p610 renames
  `CharacterObject.kind` and `CharacterBodyPlan.kind` (an engine major).

Decided (Phase 2): **firm.** Characters are actors today in all but name; NPCs (p420) and
vehicles (S3) are the next kinds. Instances on the component and kinds in a registry, because
the systems need the object every step and only saves and messages need a name. `bodyKind`,
because `kind` beside an actor kind would mean two things.

As found (Phase 1):

- Fits: a character is already composition, not a class: the visual's entity gets the physics
  components, `CHARACTER` (`CharacterObject`) and `TAG_IS_CHARACTER` (`Character.ts:126`).
  `CHARACTER` is the actor record in all but name.
- Name clash: `CharacterObject.kind` is already taken by the **body** kind (`'HUMANOID'`, from the
  body plan) and documented as "switch on it in game code". C1's `kind` (`'CHARACTER' |
  'VEHICLE'`) needs another name, or the body kind does (`bodyKind`).
- `controllerId` / `brainId`: the controller is an object on the component
  (`CharacterObject.controller?`), with no controller registry; a brain has no slot at all. Ids
  only pay off with a registry (serialization, network, the debugger naming them).
- Input state lives on the actor record: `keyBindingIds` / `mouseBindingIds` are the input
  scheme's bindings, registered by `createCharacter` and deleted with the entity. Under C4 they
  belong to the player brain.
- Characters live in the default world only (`characterEntityIds`, an id → entity map; ids are
  global).

### C2. Controller (firm: dynamic today, kinematic next)

```ts
type ActorController<TIntent> = {
  kind: string;                         // 'DYNAMIC_CHARACTER', 'KINEMATIC_CHARACTER', 'RAYCAST_VEHICLE'
  tick: (dt: number, intent: TIntent, step: number) => void;  // at APP_PHYSICS_STEP
  attach?: (actorId: string) => void;   // a body comes with the controller (NPC tiers swap them)
  detach?: () => void;
  dispose?: () => void;
  probes?: unknown;                     // what the debug gizmos draw
  config?: ControllerConfig;            // live-editable values (today's applyConfigValues)
};
```

- Controllers move bodies only through the Physics API, so a backend's own controller (Jolt's
  `CharacterVirtual`) is another `kind` behind the same contract.
- **Only the tick writes the body.** Collision callbacks and other events record (flags, counts,
  a queued landing or tumble start), and the tick applies them in its sub-step.
- `step` is the step index (p604: simulation time is never the wall clock).
- The second implementation that makes it firm: a kinematic character controller on Rapier's KCC
  (stub plan S1), which is also what most engines use for NPCs (p420's open question).

As found (Phase 1):

- Fits: `CharacterController` (`CharacterTypes.ts`) is `{ tick(dt), dispose?, probes?, config? }`.
  `probes` (`CharacterProbes`: body plan, dims, collider roles, the last floor ray and wall cast)
  and `config` (`CharacterConfigHooks`: `bakedKeys`, `onChange`, with the data's `_` keys and
  `applySavedCharacterConfig`) are C2's as written.
- Missing: `kind`, and the `intent` and `step` arguments. The controller closes over its intent
  (the same object as `character.intent`); the system has the component, so passing it is
  trivial. `getPhysicsSubStepIndex()` exists for `step`, but the tick reads `getPhysGameTime()`
  (`DynamicCharacter.ts:1107`) for the jump cooldown, getting up, tumbling and the casts'
  `resolvedAt`.
- No `attach` / `detach`: the controller's factory creates the body (`createCharacter` →
  `createPhysicsEntity`) and both go with the entity. Swapping controllers on a live actor
  (p420's tiers) means the body plan's colliders and the rigid body need an owner other than the
  controller. The simulation tiers (`_DONE_p352`) leave characters out for this reason.
- "Only the tick touches the body" doesn't hold: the floor sensor's collision callback sets the
  landing velocity (`DynamicCharacter.ts:977`) and starts tumbling with an impulse (`:962`), and
  the wall sensor's starts tumbling in the `.then()` of an async `bodyType()` (`:905-918`). The
  floor's run at the sub-step's start (`flushPhysicsEvents`, a fixed order); the wall's resolves
  on a microtask, or after a worker round trip in `WORKER_THREAD` mode, so not at a fixed step.
  `setControlMode`'s doc claims the opposite. C2 should say it: events record, the tick writes.
- The player brain runs inside the tick: the tick calls `input?.beforeTick?.()` (the `HOLD` run /
  crouch latch, `:1133`), and the `_turnToMoveDirection` default comes from the input scheme
  (`SCHEME_TURNS_TO_MOVE_DIRECTION`): a brain's choice stored as controller config.
- Kinematic: Rapier's KCC is still only the commented-out signature
  (`PhysicsAPITypes.ts:1751-1757`).

Decided (Phase 2): **firm.** The dynamic controller exists and the kinematic one is S1.

- p610 moves the three body writes outside the tick (`DynamicCharacter.ts:905-918`, `:962`,
  `:977`) into it. The floor sensor's two run at the start of the same sub-step today, so moving
  them changes nothing visible; the wall sensor's tumble start moves from whenever its promise
  resolves to the next tick, which is the fix.
- `attach` / `detach` stay in the contract but unused until a controller is swapped on a live
  actor (S1, p420). Until then p610 keeps today's ownership: the controller's factory makes the
  body.
- The `HOLD` latch and the turn-to-move default belong to the player brain (C4), not the
  controller.

### C3. Intent schemas (firm for characters, direction for the rest)

- An intent is plain data, written by brains, read by one controller per step, cleared by the
  controller's rules (today's summed and edge-triggered fields). It is serializable, so a network
  brain or a replay can carry it.
- `CharacterIntent` stays as it is. A vehicle gets `VehicleIntent` (`throttle`, `brake`, `steer`,
  `handbrake`, `gear`) and a camera `CameraIntent` when their plans land.

As found (Phase 1):

- Fits exactly: `CharacterIntent`'s fields and rules are as described; plain numbers, booleans and
  `null`, so serializable. The tick reads it once and clears the per-sub-step fields right away
  (`clearIntentSubStep`).
- Already camera-free: `CAMERA_RELATIVE` turns the camera's ground forward into a world move
  (`addIntentMove`) in the binding, so the intent a network or replay carries needs no camera.
  The camera is read at the step from last frame's `matrixWorld`.
- Not all writes are per step: `jump` and the `TOGGLE` run / crouch are written by `KEY_DOWN`
  bindings at DOM event time, between steps. The intent can't be recorded per step until the
  action layer (C5) samples them at the step.
- `DynamicCharacter.controlFns` (`rotate`, `move`, `jump`, `run`, `crouch`) are intent writers
  for code: a script brain's API.
- `CameraIntent`: `createFollowObjectCameraRig`'s `getMouseMoveInput` callback is a look delta
  pulled from the app, and nothing in `src/` passes one.

Decided (Phase 2): **firm for `CharacterIntent`**, which input, code and the gym's dummy already
write; **direction for `VehicleIntent` and `CameraIntent`**, which have no writer or reader yet
(S3 and the camera rig's look input). One schema per actor kind (§7 risk 1).

### C4. Brain (firm: player and scripted exist today)

```ts
type ActorBrain<TIntent> = {
  kind: string;  // a registered name (C1): 'TANK', 'CAMERA_RELATIVE', 'NAVMESH_AI', 'NETWORK', …
  think: (intent: TIntent, step: number) => void;  // at APP_PHYSICS_STEP, before the controllers
};
```

- The player brain reads p610's action layer (C5), never a device. The input schemes
  (TANK, WORLD_FIXED, CAMERA_RELATIVE) become player brains, and new ones can be registered.
- An actor can switch brains at runtime (possession, cutscene takeover, a disconnected player
  handed to AI).

As found (Phase 1):

- No brain object. Three things play the part:
  - the input schemes (`createCharacterInput`, `CharacterInputSchemes.ts`): key bindings writing
    the intent, plus a `beforeTick` the controller runs; a closed union (`CharacterInputScheme`,
    `CharacterInputOpts`), fixed at creation;
  - the gym's dummy (`scene_thirdPersonGym.ts:218-246`): an `APP_PHYSICS_STEP` system
    (`dummyCharLooper`, order 0) writing the intent from a `dt` accumulator, which the scene
    removes by hand on load and on exit;
  - `controlFns`, for code.
- Placement fits: held-key bindings run in the sub-step before the `APP_PHYSICS_STEP` systems,
  and order-0 systems run before the character system (-10), so "think before the controllers"
  already holds. Nothing schedules it, though: a brain is wherever its author registered it.
- No brain switching: the scheme's bindings are made by `createDynamicCharacter` and owned by the
  character. A character without `input`, driven by code, is today's AI or script brain.
- A brain's lifetime has no owner: the dummy's system outlives its character unless the scene
  removes it (the gym's exit callback does).

Decided (Phase 2): **firm.** Player brains (the input schemes) and a scripted one (the gym's
dummy) exist today.

- `kind` is a registered name (C1), so `TANK`, `WORLD_FIXED` and `CAMERA_RELATIVE` are the
  engine's three built-in player brain kinds and the toolkit and the app add their own.
- One system runs every actor's `think` before the controllers, and the brain goes with its
  actor, so no scene removes a brain's system by hand.
- The player brain owns its bindings (today's `keyBindingIds` / `mouseBindingIds`), the `HOLD`
  latch and the turn-to-move default.

### C5. Actions above devices (firm: p610 builds it)

- Devices (keyboard, mouse, touch, gamepad) produce **actions** (`move` as a 2D axis, `jump` as a
  button, `look` as a delta) through **bindings per context** (on foot, in a vehicle, in a menu,
  the debugger). Brains and UI read actions, never keys.
- One model for the app's and the engine's key bindings, so the "key binding refactoring" prompt
  (p770) lands on it.
- Actions can be recorded per step (replays, determinism tests, network input).

As found (Phase 1):

- No action layer, as stated. Devices: `KeyboardInput.ts` (`KEY_UP` / `KEY_DOWN` / `KEY_HELD`
  bindings on chords, reserved chords, collision checks), `MouseInput.ts` (click, hover, wheel,
  double click, with raycast targets), `TouchInput.ts` (tap, drag, pinch), `GamepadInput.ts` (a
  TODO stub, imported by nothing), `InputState.ts` (the master switch and the editor views'
  app-input suspension).
- Contexts exist in a scattered form: a binding's `sceneId`, `enabledInDebugCam`, `isDebugKey`
  (runs in editor views) and `yieldToOtherBindings`. C5's contexts replace these flags.
- The per-step sampling point exists: `pollHeldKeyBindings` runs once per sub-step. `KEY_DOWN`,
  mouse and touch bindings run at DOM event time.
- The engine's keys (`DefaultDebugKeyBindings.ts`, rebindable through `AppConfig.debugKeys`, with
  a `category` for the shortcuts dialog) are already a binding set with metadata. p602 moves that
  file to `debug/`, not `kernel/input/`.
- No character uses mouse or touch input.

Decided (Phase 2): **firm.** p610 builds it, with two consumers from the start: the player
brains and the engine's debug keys (p770's key binding work lands on it). Edge-triggered actions
(jump, toggles) are sampled at the step, so the intent and the recording are per step.

### C6. Animation (direction: waits for the first animated character)

- Presentation side: an `ANIMATION` component with a state graph (states, transitions on the
  locomotion state and intents, blend spaces) driving three's `AnimationMixer`, then IK layers
  (foot placement on the floor ray, look-at, hand targets), at `APP_RENDER_SYNC`.
- It reads the simulation, never writes it. Root motion that moves the body is the open question:
  it would have to run in the simulation (deterministic, per step) instead.
- Ragdoll is a controller mode (`PHYSICS_ONLY` exists) plus jointed bodies (p250).

As found (Phase 1):

- No `AnimationMixer` anywhere in `src/`. The hook is there: `LocomotionState` is documented as
  "what a future animation-state system switches on", with `onLocomotionStateChange`. Its
  listeners run inside the sub-step (simulation side); an animation graph would read the state at
  `APP_RENDER_SYNC` instead.
- The visual can be any `Object3D` (the controller never reads it), a skinned mesh included.
- `APP_RENDER_SYNC_ORDER.POSE_CONSUMERS` is the slot after the interpolated pose is written (the
  follow camera rig and the character gizmos use it): where the animation and IK layers go.
- `CharacterControlMode` (`CONTROLLED` | `PHYSICS_ONLY`) exists, with the getting-up path back.

Decided (Phase 2): **direction.** No animated character exists to build it against; S2 decides
it with the first one, root motion included (§7 risk 2).

### C7. World systems (direction; randomness firm)

- **Game events:** a typed event bus in the simulation (`emitGameEvent`, delivered in a fixed order
  at a fixed stage), which missions, achievements, audio and UI subscribe to. Physics collision
  events already have a delivery point (`flushPhysicsEvents`) to start from.
- **Missions and objectives:** state machines over game events, with their state in save data.
- **Sequencer:** timelines that drive actors (through a `SCRIPT` brain), cameras and events; paths
  are splines (a spline asset type in the scene JSON, the editor drawing them).
- **Weather and mood:** one world state (wetness, snow, wind, fog, time of day, a mood or colour
  grade), owned by a weather system and read by the sky box, materials (p307), PostFX and audio.
  The world state owns the time-of-day clock, advanced by the step clock, and the sky box reads
  it. Until S7 builds that, the clock stays the sky box's day-night cycle and the world state
  reads it there.
- **Randomness:** a seeded RNG service with named streams (`getRng('loot')`), each seeded from
  the world seed and its name, so a stream's sequence doesn't depend on what other systems drew.
  The streams are re-seeded on a scene load (next to `resetPhysicsWorld`), so a scene draws the
  same numbers on every visit. Its generator is the toolkit's `createSeededRandom`, moved into the
  engine's `utils/`; the toolkit re-exports it, deprecated, until its next major (the
  `InstancedMeshPool` pattern), and its output doesn't change. Simulation code never calls
  `Math.random` (a lint rule for the simulation folders, p605).
- **Save games:** components marked serializable, saved and loaded by one service, which C7's
  mission state and p604's snapshots share.

As found (Phase 1):

- Events: no bus. The listener APIs are per feature with their own shapes (see §2's recheck).
  Collision events are delivered once per sub-step in a fixed order (`flushPhysicsEvents`, after
  the held keys and before `APP_PHYSICS_STEP`): the fixed stage the bus would deliver at.
- Missions, sequencer, splines, save games: nothing in the code. `__saveData` is the debug tools'
  per-scene asset overrides, not save games.
- Weather and mood: nothing, and the time of day isn't free to own: the sky box's day-night cycle
  owns it (`ActiveSkyBox.time`). Either the weather state reads it from the sky box, or ownership
  moves to the weather state and the sky box reads it.
- Randomness: `createSeededRandom` exists in the toolkit (a seeded function, no named streams);
  the engine has none, and §4 puts the service in the engine's `utils/`. The engine's only
  simulation `Math.random` is the tumble start.
- The step clock to follow exists: the simulation tiers' distance policy runs on
  `getPhysicsSubStepIndex()` and `addPhysicsStepGate` (`_DONE_p343`), and its hash is the same in
  all three physics targets.

Decided (Phase 2):

- **Randomness: firm.** The generator has users today (the toolkit's generators), and the engine
  needs it for the character's tumble start. p610 builds the service, as its first engine user.
- **Time of day: direction.** The clock leaves the sky box in S7: gameplay (NPC schedules,
  missions, saves) needs it without an active sky box, which today resets it on every
  activation, and it advances by frame time (`getElapsedTime()`), not by step. Moving it now
  would rewrite working code with no second reader.
- **Events, missions, sequencer and splines, weather and mood, save games: direction.** Nothing
  implements them; S5, S6 and S7 decide their shapes.

## 4. Where it lives (with p602's map)

| Piece | Engine | Toolkit | App |
| --- | --- | --- | --- |
| Actor, controller, brain, intent contracts | `features/actor/` (or `features/character/` grown) | | |
| Dynamic, kinematic character controllers | `features/character/controllers/` | | |
| Vehicle controller | `features/vehicle/` (when built) | | |
| Action layer, devices | `kernel/input/` | default binding sets | the game's bindings |
| Player brains (input schemes) | the three built-in ones | camera-relative variants, twin-stick | game-specific ones |
| AI brains, navmesh | the brain contract, navmesh queries | behaviour tree / utility AI | the game's AI |
| Animation graph, IK | `features/animation/` | ready-made graphs | the game's graphs |
| Events, missions, sequencer, splines | `features/gameplay/` | mission templates, camera rigs | the story |
| Weather and mood | `features/weather/` (and the time-of-day clock, from the sky box) | presets | the game's weather |
| RNG, save service | `utils/` (RNG, with `createSeededRandom` from the toolkit), `kernel/` (save) | a deprecated re-export of `createSeededRandom` | |

## 5. Stub plans this plan creates

Numbers in the 4xx gameplay range next to p420; each a stub (goal, the contract it implements,
dependencies, open questions):

- **S1 p421_kinematic-character-controller.md:** Rapier's KCC as the second character controller
  (step-up, slopes, moving platforms, push), the NPC default.
- **S2 p422_animation-state-graph-and-ik.md:** C6.
- **S3 p423_vehicles.md:** a raycast-wheel vehicle controller, `VehicleIntent`, enter / exit.
- **S4 p424_ai-brains-and-navigation.md:** the AI brain, navmesh generation and pathfinding
  (eg. recast-navigation-js), steering; p420's REDUCED tier uses it.
- **S5 p425_game-events-missions-and-save-games.md:** the event bus, missions, the save service.
- **S6 p426_sequencer-splines-and-cutscenes.md:** timelines, the spline asset type, camera rails.
- **S7 p427_weather-and-mood.md:** the world state and its consumers (with p307).

## 6. Phases

### Phase 1: check the contracts against the code — done

Go through `core/Character*`, `CharacterInputSchemes.ts`, the gym's dummy character, `core/Input/*`
and the toolkit's `FollowTool` / `followObjectCameraRig`, and record where each contract fits or
doesn't (an "As found" list per contract).

### Phase 2: confirm the contracts — done

Walk C1-C7 with the user; mark each firm or direction, with the reason.

### Phase 3: the stub plans

Create S1-S7 (`Status: stub — not-implemented`, `Related: p603…`); update p420 (its tiers in terms
of controllers and brains) and the p070 / p770 prompts' notes in `docs/templates/todo-plan-prompts.txt`
(where they land after p610).

### Phase 4: mark done

Documents only: no version bump. Mark the plan done; p610 builds C1-C5.

## 7. Risks and open questions

1. **The intent is humanoid today.** Generalizing it into one schema for every actor kind would be
   the over-abstraction p600 warns about; one schema per kind, with the brain and controller
   agreeing on it, is the recommendation.
2. **Root motion and determinism** (C6): animation-driven movement in a deterministic simulation
   means the animation graph runs in the simulation too. Most networked games keep root motion off
   for remote actors; decide in S2.
3. **Brains and controllers on different tick rates** (p420 wants cheap NPCs ticking every N
   steps): the contract passes `step`, so a brain or controller can skip steps itself; whether the
   system should schedule it is p420's question.
