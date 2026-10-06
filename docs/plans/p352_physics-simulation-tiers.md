Status: in progress | Phases 1-2 implemented
Category: Physics
Epic: p350_lod-system-research.md (Tier 1.2, §6)
Blocks: p353_macro-streaming-grid.md (its physics phase)
Related: p420_npc-simulation-tiers.md (characters and NPCs: their tiers, kinematic movers and crowds live there, not here), p102_physics-world-bounds.md (its `DISABLE` action is this plan's `DISABLED` tier), p500_restore-physics-snapshot.md (body snapshots share a format), _DONE_p063_triple-buffered-physics-transform-buffer.md (slot allocation), p101 scene-load determinism (implemented; CLAUDE.md Physics section)

# Physics Simulation Tiers

A large world can't keep every body in the simulation. This plan gives generic rigid bodies
**simulation tiers**: full simulation, frozen in place but collidable, disabled, and removed from
the physics world with their state kept. Changing tier is safe in both worker targets: no entity is
ever operated on while it is half-created or half-removed.

It starts with fixes that matter before any tier exists: static bodies stop costing a slot and a
sync every frame, and a full transform buffer refuses a body instead of throwing.

Characters and NPCs are out of scope: p420 owns their tiers. This plan refuses tier changes on
`TAG_IS_CHARACTER` entities.

---

## 1. Grounding

- **Buckets** (`PhysicsManager.ts` `createPhysicsEntityNow`): `BODY_STATIC` (no body or `FIXED`),
  `BODY_DYNAMIC_VISUAL` (with `OBJECT3D`), `BODY_DYNAMIC_HEADLESS`. `COLLIDER` holds the collider
  list; `TAG_IS_PHYSICS_OBJECT` has the delete hook. `createPhysicsEntity` is async and tracked
  for `settlePendingPhysicsEntities` (p101).
- **Transform buffer slots:** in `WORKER_THREAD` mode every rigid body gets a slot,
  `FIXED` included (`workers/physics/physicsSwitchRigid.ts:21-29`, `allocateBodySlot`).
  `PhysicsTransformBuffer.allocateSlot` **throws** past `maxBodies` (default 2048, `Config.ts:208`).
  `freeSlot` exists and runs on body delete.
- **Per-frame sync** (`physicsToTransformSystem`, `PhysicsManager.ts:348-389`): syncs
  `BODY_DYNAMIC_VISUAL` _and_ `BODY_STATIC` every frame, on purpose (a static body repositioned
  after creation must reach its mesh; the comment calls the cost "negligible" for a handful). Every
  synced transform gets `setDirty()`, so `object3DSyncSystem` re-copies it, sleeping or not.
- **Body control already in the API:** `setEnabled` (`world.setDisabled` uses it,
  `ECS.ts:758-797`), `setBodyType` (`RIGID_SET_BODY_TYPE` in the worker switch), poses,
  velocities.
- **Write-back audit: clean.** No system writes ECS transforms into physics every frame.
  `world.setTransform` writes on call; character controllers write every sub-step by design.
  Bodies are not kept awake by the engine.
- **Determinism (p101):** physics writes belong in `APP_PHYSICS_STEP` systems or scene-load code.
  In `WORKER_THREAD` mode `APP_PHYSICS_STEP` commands are captured per sub-step and replayed
  before their own sub-step.

## 2. Tiers

| Tier       | In the physics world         | Collides | Simulated | Transform-buffer slot | Main-thread cost |
| ---------- | ---------------------------- | -------- | --------- | --------------------- | ---------------- |
| `FULL`     | yes, as created              | yes      | yes       | yes (non-fixed)       | sync per frame   |
| `STATIC`   | yes, body type `FIXED`       | yes      | no        | no                    | none             |
| `DISABLED` | yes, `setEnabled(false)`     | no       | no        | kept                  | none             |
| `REMOVED`  | no, state kept in a snapshot | no       | no        | freed                 | none             |

- `STATIC` is p350's "colliders exist (player can't fall through), nothing dynamic": a distant
  pile of crates the player might still walk into. Unlike a sleeping dynamic body, it can't be
  woken into simulation by a touch.
- `DISABLED` is instant and exact (the body keeps its full state), but the body is invisible to
  everything else, so only safe beyond any possible interaction. It's what p102's `DISABLE` exit
  action does; both use the same path.
- `REMOVED` frees the body, its colliders and its slot. The entity and its visual stay, and a
  `BodySnapshot` (§4) keeps what's needed to re-create the body exactly.
- The draft's `KINEMATIC_PROXY` is dropped here: a generic rigid body has no scripted motion to
  follow. Representation switching to kinematic movers is p420's `REDUCED` tier.

Only dynamic bodies have tiers. A `FIXED` body is already as cheap as `STATIC` after Phase 1, and
can go to `REMOVED` only through p353's cell unload (which deletes it with the cell).

## 3. Phase 1 fixes (no tiers yet)

### 3.1 Static bodies without slots or per-frame sync

- `allocateBodySlot` skips `FIXED` bodies (`slot = -1`). `setBodyType` allocates a slot when a body
  becomes non-fixed and frees it when it becomes fixed, worker side.
- `physicsToTransformSystem` stops iterating `BODY_STATIC`. Instead, `world.setTransform` on a
  `BODY_STATIC` entity writes the new pose into `TRANSFORM` directly (it already writes the body).
  That covers the case the current comment protects (an imported level piece snapped into place
  once) without a per-frame cost.
- The body API (`RigidBodyAPI`) doesn't know its entity, so a direct
  `getRigidBody(id).setTranslation(...)` on a fixed body would move the collider but not the mesh.
  That path becomes documented as "use `world.setTransform` for fixed bodies", with a debug-env
  warning from the body proxy when `setTranslation` / `setRotation` is called on a `FIXED` body (the
  proxy knows its body type). Today's app code only calls it on character bodies.
- `syncStaticBodies(world)` stays available as an explicit one-off resync for anything else.

### 3.2 Unchanged poses don't dirty transforms

`physicsToTransformSystem` compares the read pose with the transform's current value and skips
`setDirty()` when it's unchanged. A sleeping body then costs one pose read and one compare per
frame, and no `object3DSyncSystem` copy or spatial-grid churn.

### 3.3 Capacity refuses instead of throwing

`allocateSlot` returns `-1` when full. The create then fails cleanly: `createPhysicsEntity` rejects
with a `PhysicsCapacityError` naming `maxBodies`, after deleting the half-created body worker side,
and the Physics API debug tab shows "slots used / max" and a refused count. Promotions (§4) that
hit the cap stay in their current tier and report the same error.

### 3.4 Sleep visibility

The step stats (`stepStatsEnabled`) gain awake and sleeping dynamic body counts, counted engine
side after each step (in the worker in `WORKER_THREAD` mode, so it costs no message). That makes
"a body is kept awake" visible instead of a guess.

## 4. Tier transitions

### 4.1 API and state

```ts
requestPhysicsTier(entityId, tier, world): void;
getPhysicsTier(entityId, world): { tier, pending: PhysicsTier | null };
```

Component `PHYSICS_SIM_TIER { tier, target, inFlight: boolean, snapshot?: BodySnapshot }`, added
on the first request (an entity without it is `FULL`).

- A request sets `target`. The transition starts in the next `APP_PHYSICS_STEP` (CLAUDE.md: physics
  writes go there), so tier changes land on a fixed step, not on frame timing.
- **One transition at a time.** While `inFlight`, a new request only updates `target`. When the
  transition finishes, the system compares `tier` with `target` and starts the next one if they
  differ. Rapid flip-flops collapse into the latest target; an entity is never double-created.
- While in `REMOVED` or `inFlight` toward/from it, the entity has **no `BODY_*` component**, so
  `world.getRigidBody` returns undefined and every existing caller treats it as "no body", which
  they already handle.

### 4.2 Transitions

- `FULL ↔ STATIC`: `setBodyType` (`FIXED` ↔ the original type, kept in the component), slot
  freed/allocated, bucket component moved (`BODY_DYNAMIC_*` ↔ `BODY_STATIC`). One-way commands, so
  in `WORKER_THREAD` mode they ride in the step message like any `APP_PHYSICS_STEP` command. Not
  in flight.
- `FULL ↔ DISABLED`: `setEnabled`, the same path as `world.setDisabled`'s physics part (without
  `DISABLED`'s visibility meaning: the visual stays). Not in flight.
- `→ REMOVED`: a new engine command `SNAPSHOT_AND_DELETE_BODY` reads the body's state (pose,
  linear and angular velocity, sleep state, enabled state, body type, additional mass, locks,
  gravity scale) **on the step it runs**, deletes the body and colliders, frees the slot and
  returns the snapshot. Main thread: the bucket component is removed immediately; the snapshot is
  stored when the reply arrives; `inFlight` until then.
- `REMOVED →`: the body and colliders are re-created from the snapshot plus the entity's original
  collider params (kept in the component at the first `REMOVED` transition), through the same
  creation path as `createPhysicsEntity`. `inFlight` until it resolves; then the bucket component
  is added back. Render interpolation is reset for the entity so it doesn't blend from a stale
  pose.
- A `REMOVED` entity deleted by the app just deletes (no body to free).

### 4.3 Joints

A body connected by impulse joints changes tier with its whole joint group, or not at all: a
request on one member is applied to every member of the group, in one step. `REMOVED` with joints is
refused in this plan (dev warning): re-creating joints from a snapshot is p500's problem, and that
format should be shared rather than invented twice.

### 4.4 Determinism

Transitions run on fixed steps, and the snapshot is taken on the step the command runs, so a
`REMOVED → FULL` round trip restores exactly the state the body had when removed. A scene whose
tier changes are driven by the player's position is still only as deterministic as the player's
input. The determinism probe runs with the tier policy (§5) frozen, and the probe's hash includes
each entity's tier.

## 5. Distance policy

```ts
setPhysicsTierPolicy(world, {
  focus: () => Vector3 | entityId, // default: the main camera
  rings: [
    { tier: 'FULL', within: 60 },
    { tier: 'STATIC', within: 150 },
    { tier: 'DISABLED', within: 400 },
    { tier: 'REMOVED' }, // beyond
  ],
  hysteresis: 0.15, // demote at within × (1 + hysteresis)
  everyNFrames: 10,
});
```

- `physicsTierPolicySystem` at `APP_LOGIC`, every N frames, over entities with
  `PHYSICS_TIER_POLICY` (opt-in per entity; `createPhysicsEntity` gets a `tierPolicy` entity
  option). It only calls `requestPhysicsTier`.
- The `DISABLED` ring must start beyond anything that could reach the body within one policy
  interval (a thrown object, a vehicle). The policy validates `within` against the ring order
  only; the margin is the author's call, documented with this warning.
- p353 drives tiers per cell instead: a cell's state sets the tier of every body it owns (its
  Phase 4). Entities with both a policy and a cell owner follow the cell.

## 6. Debug

Physics API tab: slots used/max, refused count, awake/sleeping (§3.4), per-tier counts, in-flight
count. A tier column in the physics wireframe colouring (`_dbg__PhysicsDebugDraw.ts`), in the same
priority list as its existing states. A "freeze tier policy" toggle.

## 7. Phases

### Phase 1 — Fixes (§3) — done

Slot-less static bodies, no static sync, no dirtying of unchanged poses, refuse on capacity,
sleep counts.

**Exit:** `physicsTest` and `thirdPersonGym` behave the same in both worker targets; the
determinism probe stays green; a scene with 3,000 static colliders and 2048 `maxBodies` loads
(before Phase 1 the worker threw, and the create never settled, so the scene load hung).

As built (differs from §3):

- **A moved fixed body syncs itself; no warning.** `setTranslation` / `setRotation` on a
  `FIXED` body tells `setFixedBodyMovedListener` (`PhysicsAPI.ts`): the worker proxy calls it,
  and on `MAIN_THREAD` the engine's `setFixedBodyMovedObserver`. `PhysicsManager.ts` maps the
  body to its entity (`staticBodyOwners`), and `physicsToTransformSystem` syncs only the moved
  ones. Direct moves keep working with no per-frame cost (the gym moves its imported stairs and
  wall this way), and `syncStaticBodies` was never needed.
- **A slot-less proxy keeps its own pose.** Without a slot, the worker proxy returned the origin
  once its creation pose expired. It now keeps its creation pose, updated by every
  `setTranslation` / `setRotation` (`staticPose`). The slot decision is the worker's
  (`rb.isFixedSync()` at creation); the main thread only sees `slot === -1`.
- **`setBodyType` doesn't move slots.** It's one-way, and the proxy's slot is fixed at
  creation, so the main thread could never learn a new slot. Switching a body created `FIXED`
  to another type logs a debug warning (`EngineRapier.ts`). Phase 2's `FULL ↔ STATIC` should
  therefore keep the slot (open question 2), which keeps that transition one-way.
- **Capacity:** a refused create gets a normal reply with `capacityExceeded` (= `maxBodies`),
  not an `ERROR`; the worker deletes the half-made body first, and `CREATE_RIGID_BODIES` is all
  or nothing. `createPhysicsEntity` removes the entity it created (or the tag it added to the
  `target`) and rethrows the `PhysicsCapacityError`. Other worker errors still only log, and
  their promise never settles: making every request reject is a separate change.
- **Debug and stats:** `getPhysicsBodyCapacity()` (slots used, max, refused; worker only) and
  `getLastPhysicsBodyActivity()` (awake and sleeping dynamic bodies, measured with the step
  stats: two more fields in the stats buffer and on `TRANSFORMS_PUSH`), shown in the Physics API
  tab's "Bodies (live)" folder.
- Verified headless (WebGL2/SwiftShader): the gym and `physicsTest` in both worker targets, with
  every static body's transform and mesh at its body's pose; the probe's `physicsTest` hash
  (N=120) is the same as on `main` in both targets; 3,000 `FIXED` bodies take no slot, and
  dynamic creates fill exactly 2048 slots, then reject.

### Phase 2 — `STATIC` and `DISABLED` — done

Component, `requestPhysicsTier`, one-transition-at-a-time state machine, the two in-place
transitions, joint groups.

As built (differs from §4):

- **Module:** `core/PhysicsTiers.ts` registers itself on import (`ECSWorld.registerPlugin`), so an
  app that never requests a tier pays nothing. Types in `core/Physics/PhysicsTierTypes.ts`.
  `requestPhysicsTier(entityId, tier, world?)` returns `false` (with a debug-env warning) when it
  refuses, instead of `void`. `PhysicsTier` is `'FULL' | 'STATIC' | 'DISABLED'`; Phase 3 adds
  `'REMOVED'`.
- **Component:** `PHYSICS_SIM_TIER { tier, target, bucket }`, `bucket` being the dynamic bucket
  `FULL` restores. No `inFlight` / `snapshot` yet: both Phase 2 transitions are one-way commands
  applied in one sub-step, so nothing is ever in flight. Phase 3 adds them. Pending entities are
  a per-world set; the system (`APP_PHYSICS_STEP`, order 100, first in the stage) walks only them.
  A request whose target equals the current tier drops the pending entry (flip-flops collapse).
- **Each tier is a body state:** `FULL` = dynamic + enabled, `STATIC` = `FIXED` + enabled,
  `DISABLED` = dynamic + disabled; a transition writes the difference, so `STATIC ↔ DISABLED` is
  direct. "Enabled" also needs the entity not to be world-disabled: `ECSWorld.setDisabled` keeps
  a `DISABLED`-tier body disabled, and a tier change keeps a world-disabled body disabled.
- **Buckets:** `STATIC` and `DISABLED` both move the entity to `BODY_STATIC` (no per-frame read,
  compare or interpolation); `FULL` moves it back and its interpolation history reseeds. On
  demotion the transform is marked dirty (the mesh showed the interpolated pose) and the entity
  is synced every frame until a snapshot stamped at or after the transition is visible
  (`queueStaticBodySync`, `PhysicsManager.ts`): in `WORKER_THREAD` mode the frame's snapshot can
  predate the freeze. Phase 1's moved-body sync uses the same queue. `ECS.ts`'s `setTransform`,
  `setVelocity` and `setDisabled` treat a tiered entity as dynamic for their velocity resets.
- **No slot changes:** both tiers keep the body's slot (Phase 1's as built), which answers open
  question 2 for Phase 2.
- **`STATIC` resumes from rest:** Rapier zeroes a body's velocities when it becomes `FIXED`, and
  they aren't restored (decided in review; Phase 3's snapshot is the exact path). `DISABLED`
  keeps pose and velocities exactly.
- **Moved-body listener generalized:** `setFixedBodyMovedListener` / `setFixedBodyMovedObserver`
  are now `setBodyMovedListener` / `setBodyMovedObserver`, called for every
  `setTranslation` / `setRotation` in both targets. `staticBodyOwners` is now `bodyOwners`
  (every `createPhysicsEntity` body with its created `rigidType`, `getPhysicsBodyOwner`), and
  only an entity in `BODY_STATIC` is queued. So a direct move of a tier-frozen body (which keeps
  its slot, so the worker proxy didn't report it before) reaches its mesh too.
- **Phase 1's `setBodyType` warning** fires only for bodies created `FIXED`
  (`EngineRigidBodyProxyAPI.isCreatedFixed`), not on every `STATIC → FULL`.
- **Joint groups:** `JointProxyAPI` keeps its body ids from the create params, so
  `body1IdSync` / `body2IdSync` work in `WORKER_THREAD` mode too (`forEachJointBodyPair`,
  `hasJoints` in `PhysicsAPI.ts`). A group is resolved when the request is made, linked only
  through tier-able bodies: `FIXED`, kinematic and bare-API bodies end a group without joining
  it (two chains on one fixed anchor are two groups). Refused when the entity or a member is a
  character, has no body yet, or wasn't created `DYNAMIC` by `createPhysicsEntity`.
- **Probe:** collects tiered `BODY_STATIC` entities too and appends a tier index to the values of
  entities that have the component, so scenes without tiers keep their hashes (§4.4's first half;
  the frozen policy is Phase 4).
- Verified headless (WebGL2/SwiftShader), both worker targets: 33 scripted checks on
  `physicsTest` (buckets, body type / enabled state, frozen pose, `world.setTransform` and
  direct `setTranslation` on a frozen body, velocity through `DISABLED`, `setDisabled`
  interplay, a two-body chain on a fixed anchor beside a second chain, refusals, flip-flop,
  delete while pending). The probe's `physicsTest` hash (N=120) without tiers equals Phase 1's
  in both targets (`d5c1562a`); a fixed tier sequence driven from `APP_PHYSICS_STEP` gives the
  same hash on every run and in both targets (N=120 and N=60, with bodies still frozen).
  `thirdPersonGym`: every static body's transform at its body's pose, no errors.

### Phase 3 — `REMOVED`

`SNAPSHOT_AND_DELETE_BODY` in `EngineRapier.ts` and the worker switch, snapshot storage, re-create
from snapshot, interpolation reset.

**Exit:** a stack of 200 boxes demoted to `REMOVED` and promoted back resumes from the same
state in both worker targets (the probe's hash of the stack matches a run without the round trip).

### Phase 4 — Distance policy and debug

§5 and §6.

### Phase 5 — Cell driving (with p353)

## 8. Versioning

Engine minor (new API and component; Phase 1's capacity change turns a throw into a rejected
promise, which is a fix). App patch if a test scene adopts the policy.

## 9. Open questions

1. ~~Does Rapier's `setEnabled(false)` take the body's colliders out of the broad phase?~~
   Answered in Phase 2 (`@dimforge/rapier3d-compat` 0.19.3, Node): yes. A disabled body has no
   contact pairs and rays miss it; 3,000 resting balls step in 0.026 ms disabled vs 0.15 ms
   sleeping or `FIXED`, and 300 overlapping ones in 0.003 ms vs 0.78 ms `FIXED`. `STATIC`
   costs the same per step as a sleeping body: what it buys is that nothing wakes it. Disabling
   one body of a jointed pair lets the joint drag the other (why groups change tier together).
2. Should `STATIC` keep the body's slot so promotion back to `FULL` needs no allocation? Only if
   Phase 2 shows allocation churn; slots are cheap.
3. Snapshot format: align with p500 before Phase 3.
