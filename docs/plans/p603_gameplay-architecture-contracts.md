Status: draft | study — not-implemented
Category: Architecture, Characters, Gameplay
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage A)
Blocked by: p602_architecture-and-target-structure.md (the folder map the contracts live in)
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

## 3. The contracts

TypeScript shapes are sketches; p610 and the stub plans write the real ones.

### C1. Actor (firm)

An actor is an ECS entity with an `ACTOR` component: `{ kind, controllerId, brainId }`, where
`kind` is open (`'CHARACTER' | 'VEHICLE' | …`, extended by declaration merging, p602 / p606).
No class hierarchy: what an actor can do is the set of components it has.

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
- `step` is the step index (p604: simulation time is never the wall clock).
- The second implementation that makes it firm: a kinematic character controller on Rapier's KCC
  (stub plan S1), which is also what most engines use for NPCs (p420's open question).

### C3. Intent schemas (firm for characters, direction for the rest)

- An intent is plain data, written by brains, read by one controller per step, cleared by the
  controller's rules (today's summed and edge-triggered fields). It is serializable, so a network
  brain or a replay can carry it.
- `CharacterIntent` stays as it is. A vehicle gets `VehicleIntent` (`throttle`, `brake`, `steer`,
  `handbrake`, `gear`) and a camera `CameraIntent` when their plans land.

### C4. Brain (firm: player and scripted exist today)

```ts
type ActorBrain<TIntent> = {
  kind: 'PLAYER' | 'AI' | 'NETWORK' | 'REPLAY' | 'SCRIPT' | string;
  think: (intent: TIntent, step: number) => void;  // at APP_PHYSICS_STEP, before the controllers
};
```

- The player brain reads p610's action layer (C5), never a device. The input schemes
  (TANK, WORLD_FIXED, CAMERA_RELATIVE) become player brains, and new ones can be registered.
- An actor can switch brains at runtime (possession, cutscene takeover, a disconnected player
  handed to AI).

### C5. Actions above devices (firm: p610 builds it)

- Devices (keyboard, mouse, touch, gamepad) produce **actions** (`move` as a 2D axis, `jump` as a
  button, `look` as a delta) through **bindings per context** (on foot, in a vehicle, in a menu,
  the debugger). Brains and UI read actions, never keys.
- One model for the app's and the engine's key bindings, so the "key binding refactoring" prompt
  (p770) lands on it.
- Actions can be recorded per step (replays, determinism tests, network input).

### C6. Animation (direction: waits for the first animated character)

- Presentation side: an `ANIMATION` component with a state graph (states, transitions on the
  locomotion state and intents, blend spaces) driving three's `AnimationMixer`, then IK layers
  (foot placement on the floor ray, look-at, hand targets), at `APP_RENDER_SYNC`.
- It reads the simulation, never writes it. Root motion that moves the body is the open question:
  it would have to run in the simulation (deterministic, per step) instead.
- Ragdoll is a controller mode (`PHYSICS_ONLY` exists) plus jointed bodies (p250).

### C7. World systems (direction)

- **Game events:** a typed event bus in the simulation (`emitGameEvent`, delivered in a fixed order
  at a fixed stage), which missions, achievements, audio and UI subscribe to. Physics collision
  events already have a delivery point (`flushPhysicsEvents`) to start from.
- **Missions and objectives:** state machines over game events, with their state in save data.
- **Sequencer:** timelines that drive actors (through a `SCRIPT` brain), cameras and events; paths
  are splines (a spline asset type in the scene JSON, the editor drawing them).
- **Weather and mood:** one world state (wetness, snow, wind, fog, time of day, a mood or colour
  grade), owned by a weather system and read by the sky box, materials (p307), PostFX and audio.
- **Randomness:** a seeded RNG service with named streams (`getRng('loot')`), so a stream's
  sequence doesn't depend on what other systems drew. Simulation code never calls `Math.random`
  (a lint rule for the simulation folders, p605).
- **Save games:** components marked serializable, saved and loaded by one service, which C7's
  mission state and p604's snapshots share.

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
| Weather and mood | `features/weather/` | presets | the game's weather |
| RNG, save service | `utils/` (RNG), `kernel/` (save) | | |

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

### Phase 1: check the contracts against the code

Go through `core/Character*`, `CharacterInputSchemes.ts`, the gym's dummy character, `core/Input/*`
and the toolkit's `FollowTool` / `followObjectCameraRig`, and record where each contract fits or
doesn't (an "As found" list per contract).

### Phase 2: confirm the contracts

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
