Status: stub — not-implemented
Category: Characters, AI
Related: p350_lod-system-research.md (§6 physics simulation tiers, §8 roadmap), \_DONE_p352_physics-simulation-tiers.md (generic rigid bodies; it refuses tier changes on characters and leaves them to this plan), p353_macro-streaming-grid.md (cells around the player), p351_impostor-billboard-lod.md (`CROWD` rendering), p102_physics-world-bounds.md

# NPC Simulation Tiers — Stub

**This is a stub.** It records the direction from a design discussion so the real plan can be
written later. Nothing here is a final design, and the numbers below are estimates from reading
the code, not measurements.

## Goal

Support a large world with many NPCs (hundreds to around a thousand), some of which carry on
with their own world tasks while the player is far away. Only the NPCs near the player should
cost what a full character costs today.

## Core idea: the NPC is data, the body is attached per tier

An NPC is an ECS data entity that holds its state, schedule, current task and coarse world
position. A body (a `DynamicCharacter` today) is something the NPC gets while it is near the
player and loses when it moves away.

AI writes the character's intent (`CharacterIntent`: `moveX`/`moveZ`, `moveForward`, `faceYaw`,
`jump`, ...) whichever body is attached. Because `CharacterObject.controller` is pluggable, a
cheaper mover can be another controller that reads the same intent.

| Tier | Where (rough) | Representation | Physics |
| --- | --- | --- | --- |
| `FULL` | near, ~0–50 m | `DynamicCharacter`: full controller, animation, later IK and ragdoll | dynamic body with 4 colliders |
| `REDUCED` | mid range | follows a navmesh and snaps to its height, ticks every N sub-steps, simpler animation, crowd avoidance instead of contacts | none, or a kinematic proxy |
| `CROWD` | far, visible | instanced mesh with vertex animation textures or impostors, moves along the navmesh or splines | none |
| `ABSTRACT` | off-screen or unloaded | data only: schedule, task and a node on a coarse world graph; the position is worked out from the time when the NPC is promoted | none |

Each tier needs:

- **Hysteresis**, so an NPC doesn't flicker between tiers (eg. promote at 60 m, demote at 80 m).
- **No popping** (p350 §3): a tier change that changes the representation (`FULL` / `REDUCED` to
  `CROWD`, `CROWD` to hidden) cross-fades with p351's dither, both representations drawn for
  `fadeSeconds` (0 = instant).
- **A hard budget**: when a tier is full, the least relevant NPC is demoted. Relevance should
  cover more than distance, eg. whether the player is in combat with or talking to the NPC.
- **Safe promotion**: snap to the ground with one ray, and spawn out of sight where possible.

## Rough current limits (to be measured in Phase 0)

- About 100–150 active `DynamicCharacter`s in `MAIN_THREAD` mode, and somewhat fewer in
  `WORKER_THREAD` mode. Animation and rendering likely limit you first, at around 50–100
  animated characters on screen.
- Hot spots in `core/Character/DynamicCharacter.ts`:
  - A floor ray every tick, also while idle (`refreshFloorNormal`).
  - A wall shape cast while near a wall (`refreshWallHit`).
  - In `WORKER_THREAD` mode each cast is its own `postMessage` round trip with a Promise
    (`messageWorkerAsync`, `core/PhysicsAPI.ts`). Casts don't travel in the frame's STEP message.
  - Captured sub-step commands (`setLinvel`, `setRotation`) are `structuredClone`d one by one
    (`messageWorker`).
  - Each wall-sensor contact start makes an async `bodyType()` call, which adds up in crowds where
    the sensors overlap.
- `core/Character.ts`'s character system ticks every character every sub-step. There is no way
  to tick a character less often.

## Rough phases (to be refined)

0. **Measure.** Build a stress scene with N characters (idle, walking, crowded), in both worker
   targets, with and without animation. Record main-thread, worker and GC cost per character.
1. **Make `FULL` cheaper.** Skip or throttle the floor ray while grounded and idle, batch the
   worker casts into the STEP message, and add a per-character tick-rate option. This is useful
   on its own, even without NPCs.
2. **NPC data entity and tier manager.** Add NPC component types and a tier-selection system
   (distance plus relevance, hysteresis, budgets). Attach and detach a `DynamicCharacter` on
   `FULL` promotion and demotion, while the NPC entity itself stays.
3. **`ABSTRACT` simulation.** Schedules and tasks on a coarse world graph, and "where should
   they be now?" worked out on promotion.
4. **`REDUCED` tier.** A navmesh mover as a second character controller. This needs navmesh
   generation and pathfinding (eg. recast-navigation-js); the engine has neither today.
5. **`CROWD` tier.** Instanced or impostor rendering. This overlaps p350's impostor work (p351).

## Dependencies and open questions

- **World streaming.** The physics world is per-scene and reset on every scene load, so an NPC
  out in the world can't rely on colliders existing under it. `FULL` NPCs need the streamed cells
  around the player (p353).
- **Runtime body migration in `WORKER_THREAD` mode** is an async round trip. It needs an explicit
  mid-transition state (p350 §6, p352), or an NPC can be double-created or operated on while it
  has no body.
- **`PhysicsTransformBuffer`'s fixed `maxBodies`.** Promotion churns slots, so a full buffer
  should refuse the promotion rather than throw (p350 §6).
- **Large-world float precision.** Rapier uses 32-bit floats, so positions start to jitter a few
  km from the origin. Is an origin rebase needed?
- **Kinematic or dynamic `FULL` bodies?** Most AAA engines move NPCs with kinematic sweep
  controllers and use a dynamic body only as a ragdoll. Should NPCs get a kinematic controller
  (Rapier's `KinematicCharacterController` is only a commented-out signature in `Physics/PhysicsAPITypes.ts`) and keep
  `DynamicCharacter` for the player and for tumbling?
- **Determinism.** Characters aren't deterministic yet (wall clock, `Math.random`, async casts).
  Does `ABSTRACT` simulation need to be deterministic or replayable, eg. for save games?
- **Save data.** `ABSTRACT` NPC state is game state. Where is it saved?

## Prior art

- **Unreal:** Significance Manager (tick budget by importance), animation Update Rate
  Optimization, and the Mass framework (City Sample: thousands of agents, where only the nearby
  ones become full actors with physics).
- **GTA V:** distant peds and vehicles become cheap "dummies" moved along road and path networks,
  then are despawned and regenerated statistically.
- **Skyrim / Oblivion:** off-screen NPCs follow their schedules on a coarse path graph between
  cells.
