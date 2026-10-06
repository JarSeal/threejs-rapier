Status: implemented (Phases 1-2)
Category: Physics
Blocks: p352_physics-simulation-tiers.md (its Phase 4: §5's policy got this option before the phase was marked done)
Related: p101 scene-load determinism (implemented; CLAUDE.md Physics section), \_DONE_p063_triple-buffered-physics-transform-buffer.md (snapshot stamps), p353_macro-streaming-grid.md (cell-driven tiers, its Phase 4), p500_restore-physics-snapshot.md

# Deterministic Physics Tier Policy

p352's distance policy (`core/PhysicsTierPolicy.ts`, §5, built on the `physics-simulation-tiers`
branch) runs every N **frames** at `APP_LOGIC`, and its requests apply on the next physics step.
Which step that is depends on frame timing, so a scene driven by it plays out differently on
every load, also with a deterministic focus. This plan adds a `cadence` option: `STEPS` measures
and applies on fixed physics steps, and gives the same result on every load and in both worker
targets; `FRAMES` keeps today's behaviour.

---

## 1. Grounding

- **The policy today** (`PhysicsTierPolicy.ts`): `physicsTierPolicySystem` at `APP_LOGIC`, every
  `everyNFrames` frames, reads each member's `TRANSFORM` position and the focus (`focus()` →
  position or entity id, default the world's main camera), picks a ring (hysteresis, joint
  groups, `refusedTier`) and calls `requestPhysicsTier`. `PhysicsTiers.ts` applies requests in
  its `APP_PHYSICS_STEP` system (order 100, first in the stage), on the next sub-step.
- **Measured:** the `physicsTiers` demo scene with the policy frozen hashes the same on every
  load and in both targets (probe N=900: `36d80379` ×4). With the policy running, the piles end
  differently on every reload: a crate frozen to `STATIC` one step earlier or later stops with
  other velocities. The only non-deterministic input is the frame cadence (the focus, the plough,
  is moved in `APP_PHYSICS_STEP`).
- **Stepping** (`PhysicsAPI.ts` `stepPhysics`): a frame's sub-steps run `onBeforeStep` (the
  `APP_PHYSICS_STEP` stage) once each. `stepsIssued` (per world, reset with it in
  `resetSimClock`) is bumped only after the whole batch (`stampStepBatch`), so nothing tells a
  system which sub-step it is in. `maxSubSteps` defaults to 60.
- **Worker:** `messageWorkerAtStep` captures a request into the current sub-step; the worker
  replays it right before that sub-step (`physicsWorker.ts` STEP loop) and replies from there.
  `RIGID_DETACH` / `RIGID_REATTACH` already use it. Replies arrive a frame or more later.
- **Step limit:** `setPhysicsStepLimit` (debug only, the determinism probe) stops `stepPhysics`
  at an absolute step and drops the accumulated time there.
- **Probe:** `_dbg__PhysicsDeterminism.ts` freezes every policy while armed (freeze source
  `DETERMINISM_PROBE`), and hashes non-`FULL` tiers.

## 2. API

```ts
setPhysicsTierPolicy({
  rings: [...],
  cadence: 'STEPS', // default; 'FRAMES' = today's behaviour
  interval: 10, // steps (STEPS) or frames (FRAMES) between passes; replaces everyNFrames
  focus: (step) => ploughId, // STEPS passes the measured step index, FRAMES passes undefined
});
```

- `everyNFrames` is replaced by `interval` (the policy is unreleased: no deprecation).
- `cadence` default `STEPS` (open question 1).
- Everything else (rings, hysteresis, first placement, joint groups, refusals, `sceneId`,
  members, freezing) is shared by both cadences.

## 3. `STEPS`

A pass **measures** at step `k` and **applies** at step `k + interval`. Both are fixed steps of
the world, so with a deterministic focus every decision lands on the same step in every run and
in both targets.

### 3.1 Sub-step index

`getPhysicsSubStepIndex()` (`PhysicsAPI.ts`): inside `onBeforeStep`, the index of the sub-step
about to run (`stepsIssued + i`, both targets); `-1` outside the sub-step loop. Engine API, used
by the policy and available to other `APP_PHYSICS_STEP` systems that need a step clock.

### 3.2 Schedule

- Measure at sub-steps whose index is a multiple of `interval` (`k % interval === 0`). The phase
  is the world's, so it restarts with every new world (scene load) and doesn't depend on when the
  policy was set.
- Apply at `k + interval`, in the policy's own `APP_PHYSICS_STEP` system, ordered before
  `physicsTierSystem` (eg. 110), so its requests apply in that same sub-step.
- At apply time the decision is computed from the positions measured at `k` and the members' tier
  state at `k + interval` (hysteresis, `refusedTier`). Both are fixed by then, so when the
  measurement reply arrived doesn't matter.
- Only members measured at `k` are decided at `k + interval`; one added in between waits for the
  next measurement, one deleted or taken out of the policy is skipped.

### 3.3 Measurement

- Engine side, `readBodyPositions(ids, out: Float32Array)` (`EngineRapier.ts`): each body's
  translation, also for a detached body (`detachedBodies`, the `REMOVED` tier); NaN for an
  unknown id. Rapier stores f32, so the values are exact in a Float32Array.
- `MAIN_THREAD`: called synchronously in sub-step `k`, before the step runs.
- `WORKER_THREAD`: a new request `RIGID_READ_POSITIONS { ids }` through `messageWorkerAtStep`,
  so the worker reads before step `k` too; the reply transfers the Float32Array. For the demo's
  686 crates: 8 KB per pass.
- Both targets compute the decision from the same f32 values with the same main-thread code, so
  their decisions are identical.
- The member list (entity → body id, in storage order) and the focus are captured at `k` and kept
  with the pending measurement.

### 3.4 Focus

- An entity with a body: its position is read with the members (deterministic).
- An entity without a body: its `TRANSFORM` at capture, deterministic only if it's moved on steps.
- A position callback: called at capture with `k`, deterministic if it's a function of `k`.
- Default (main camera): read at capture; as deterministic as the camera (p352 §4.4).

### 3.5 Step gate

`WORKER_THREAD` only: the decision at `k + interval` needs the reply to the measurement at `k`.

- A production step gate, `addPhysicsStepGate(step) → release` (`PhysicsAPI.ts`):
  `stepPhysics` never issues a sub-step with an index `>= step` while the gate is held. The
  policy adds one at capture and releases it with the reply. Several gates: the lowest wins. The
  debug step limit stays separate.
- Unlike the debug limit, a gate keeps the accumulated time (still bounded by `maxDeltaTime` and
  `maxSubSteps`'s drop), so a short wait catches up on the next frame instead of losing time.
- Normally a reply arrives within 2-4 steps against an `interval` of 10, and the gate never
  engages. It does when one frame's batch spans both `k` and `k + interval` (a catch-up frame:
  up to `maxSubSteps` = 60 steps), or when the worker falls behind: the batch is cut at
  `k + interval - 1` and the rest runs once the reply is in. That shows as a hitch, never as
  divergence.
- Counted for the debug tab (§5): waits and time held.

### 3.6 Lifecycle

- **New world** (scene load, `resetPhysicsWorld`): pending measurements and their gates are
  dropped (the step index restarts), and the schedule starts over at step 0.
- **Policy replaced or removed:** its pending measurements and gates are dropped.
- **Paused, scene load hold, editor view:** no sub-steps run, so nothing advances; a reply that
  arrives meanwhile waits for its step.
- **Frozen** (`setPhysicsTierPolicyFrozen`): no measurements; pending ones still apply. The
  probe's `DETERMINISM_PROBE` source doesn't freeze a `STEPS` policy, so the probe tests it.
- **Known non-determinism left:** a return from `REMOVED` refused by a full transform buffer
  (`WORKER_THREAD`, p352 Phase 3) sets the entity's tier when the reply arrives. Rare, and
  unrelated to the cadence.

## 4. `FRAMES`

Today's code path unchanged: `APP_LOGIC`, every `interval` frames, `TRANSFORM` positions,
requests on the next sub-step, no gate. For focuses that can't be deterministic anyway and want
the lowest latency. The probe keeps freezing it.

## 5. Debug

Folds into p352 §6's Physics API tab readouts: the policy's cadence and interval, last measured
step, pending applications, gate waits (count, total ms). Nothing persisted.

## 6. Demo scene

`physicsTiers.ts` uses `STEPS` (the default) with its plough focus. A reload gives the same piles,
and the probe stops freezing its policy.

## 7. Phases

### Phase 1 — Step plumbing — done

`getPhysicsSubStepIndex`, `addPhysicsStepGate`, `readBodyPositions` and `RIGID_READ_POSITIONS`
(protocol type, worker switch, facade `readBodyPositionsAtStep(ids)`: sync in `MAIN_THREAD`,
step-pinned request in `WORKER_THREAD`). Nothing uses them yet.

**Exit:** scripted checks in both targets: the index inside `APP_PHYSICS_STEP` matches the step
a kinematic body was moved on; positions read at step `k` are equal in both targets; a held gate
stops stepping at its step, and releasing it catches up the held time.

As built (`PhysicsAPI.ts` unless named; differs from §3):

- **Sub-step index:** `getPhysicsSubStepIndex()` is `stepsIssued + i` while `stepPhysics` runs
  sub-step `i`'s `onBeforeStep` (and, `MAIN_THREAD`, its step), `-1` otherwise (reset in a
  `finally`). A write made in step `k` is in the snapshot stamped `k + 1` and after.
- **Positions:** `readBodyPositions(ids, out)` (`EngineRapier.ts`, on `EngineAPIType`) reads a
  live body or a detached one's snapshot translation, NaN for an unknown id. The facade follows
  `detachRigidBody`'s pair: `readBodyPositionsAtStep(ids): Promise<Float32Array>` in both targets
  (`MAIN_THREAD` reads at the call; `WORKER_THREAD` through `messageWorkerAtStep`, so before the
  frame's first step when called outside a sub-step), and `readBodyPositionsSync(ids, out)`,
  `MAIN_THREAD` only. The worker replies with a transferred Float32Array; the rigid switch's
  `sendMessage` type now takes the transfer list, as the collider switch's does.
- **Gate:** `addPhysicsStepGate(step) → release`, several held at once (lowest wins). While a
  gate cuts a frame's steps, the backlog stays in the accumulator, capped at `maxSubSteps` steps
  (a clock epoch bump, as the ceiling's drop is), so the clock and the catch-up stay bounded
  however long it holds; the ceiling's drop still wins when both cut the same frame. A gate at a
  step already issued holds from the next one. **A new world drops every gate** (in
  `resetSimClock`; their release functions do nothing then), so a forgotten gate can't hold a
  later scene: §3.6's "dropped with the world" is the engine's, not only the policy's. Without a
  gate the loop costs one `Map.size` check per frame.
- **Gate stats:** `getPhysicsStepGateStats()` → `{ waits, heldMs }` since boot (a wait = a hold
  that started; it ends at the first frame that steps without being cut), for §5's readouts.
- Verified headless (WebGPU, macOS Chrome), `MAIN_THREAD`, `WORKER_THREAD` with SAB and without,
  on `physicsTest` (10 checks each): the index is -1 outside a sub-step; a kinematic body moved
  to `x = index` in every sub-step reads `x = stamp - 1` in every frame's snapshot (~148 frames,
  no mismatch); positions read at step 200 (9 dynamic bodies, one of them `REMOVED` at step 100,
  plus an unknown id → NaN) hash the same in all three (`90856586`); a gate set at step `k` for
  `k + 10` holds at `k + 9` for 1 s, its release runs 52-54 steps in the next frame, and its
  stats count one wait of ~850-880 ms; a gate left held is dropped by the next scene load. The
  probe's `physicsTest` hash (N=120) is unchanged in all three (`d5c1562a`).

### Phase 2 — Cadence option — done

`cadence` and `interval` on the policy, the `STEPS` pass (§3), `focus(step)`, the probe's freeze
exemption, the demo scene on `STEPS`. Debug readouts with p352 §6.

**Exit:** the p352 Phase 4 policy checks pass in both cadences and all three targets
(`MAIN_THREAD`, `WORKER_THREAD` with and without SAB). `physicsTiers` with the policy running:
the probe hash (N=900 and N=3000, so it covers `REMOVED` round trips) is the same on every load
and across all three targets. A frame-timing stress (catch-up frames, a slowed worker) changes
the gate counts, not the hash.

As built (`core/PhysicsTierPolicy.ts` unless named; differs from §2-§5):

- **Phase 1 fix: a gate cuts its own batch.** `stepPhysics` fixed a frame's step count before
  running its sub-steps, so a gate added by an `APP_PHYSICS_STEP` system (the policy adds its
  gate on the measured step) didn't cut the batch it was added in: a catch-up frame spanning `k`
  and `k + interval` would reach the decision step without the reply. Every sub-step now checks
  the gates first (`isSubStepGated`, both targets); the rest of the batch goes back to the
  accumulator. With the default `maxDeltaTime` (1/10 s, at most ~6 steps a frame) and
  `interval` 10, only a slow worker could have hit it.
- **Two systems,** registered per world: `physicsTierPolicyFrameSystem` (`APP_LOGIC`, the
  `FRAMES` pass, unchanged) and `physicsTierPolicyStepSystem` (`APP_PHYSICS_STEP`, order 110,
  before `physicsTierSystem`). Each returns at once for the other cadence. One ring decision
  (`decide`) serves both, fed `TRANSFORM` positions (`FRAMES`) or the measured ones (`STEPS`).
- **Step system, per sub-step `k`:** first the decisions due (`applyAt === k`; a missed one
  warns in the debug env and is dropped), then a measurement when `k % interval === 0` and the
  policy isn't frozen. So a decision's requests and the next measurement share a step, and
  in both targets the read comes before that step's tier changes.
- **Measurement:** the members in entity id order (so a decision's requests go out in the same
  order on every load), each one's body (a member without one is skipped), plus the focus' body
  when the focus is an entity with one. `MAIN_THREAD` reads with `readBodyPositionsSync`;
  `WORKER_THREAD` with `readBodyPositionsAtStep` and a gate at `k + interval`, released by the
  reply. At the decision, a member taken out of the policy or with another body since is skipped.
- **A new physics world** (`getPhysicsSimHistoryEpoch` changed) drops the pending measurements;
  so do replacing or removing the policy (also scene-scoped removal and a deleted ECS world). A
  late reply of a dropped measurement is ignored.
- **Freezing:** `DETERMINISM_PROBE_FREEZE_SOURCE` (exported; the probe imports it) doesn't hold
  a `STEPS` policy. `isPhysicsTierPolicyFrozen(world)` and `getPhysicsTierPolicyFreezeSources`
  report the sources that hold it (the probe's left out for `STEPS`); with a `source`,
  `isPhysicsTierPolicyFrozen` reports that source as set.
- **API:** `cadence` (`PhysicsTierPolicyCadence`, default `DEFAULT_TIER_POLICY_CADENCE`),
  `interval` (default `DEFAULT_TIER_POLICY_INTERVAL` 10; `everyNFrames` and
  `DEFAULT_EVERY_N_FRAMES` are gone), `focus(step?)`, and `getPhysicsTierPolicyStatus(world?)`
  (cadence, interval, last measured step, pending measurements) for the readouts.
- **`STEPS` reads bodies, `FRAMES` transforms.** A `REMOVED` member moved by
  `world.setTransform` (only its visual moves, p352 Phase 3) is measured where its body is, so
  `STEPS` doesn't bring it back because its visual moved. `FRAMES` measures the visual, as before.
- **Debug** (`_dbg__PhysicsAPI.ts`'s "Simulation tiers" folder): the policy line shows the
  cadence and interval ("STEPS, every 10 steps, running" / "…, frozen by …"), plus "Last measured
  step", "Measurements waiting for their step" and "Step gate waits" (count and ms, from
  `getPhysicsStepGateStats`: the policy is the gates' only user).
- **Demo:** `physicsTiers.ts` drops `everyNFrames` for `interval: 10` and runs on the default
  `STEPS`, with the plough (a kinematic body) as its focus.
- Verified headless (WebGPU, macOS Chrome), `MAIN_THREAD`, `WORKER_THREAD` with SAB and without:
  - Policy checks on `physicsTest`, both cadences (22 `STEPS` / 21 `FRAMES`): validation
    (`interval`, `cadence`), status, ring placement, `REMOVED` without a body, hysteresis
    holding and leaving, moving in without margin, `REMOVED → FULL`, a joint group taking its
    nearest member's tier and refused `REMOVED` once, first placement, member off, freezing
    (`APP`), the probe's source freezing `FRAMES` only, camera focus, scene-scoped removal, the
    demo on `STEPS`. `STEPS` makes requests only on multiples of the interval, and `FRAMES` on
    other steps too.
  - `physicsTiers` with the policy running: the probe hash is `fff8395c` at N=900 (two loads per
    target) and `82c78afd` at N=3000, in all three targets (the frozen-policy hash at N=900 is
    `36d80379`, so the policy did run).
  - Stress, N=3000: the main thread stalled 250 ms every 0.7 s, CPU ×4, and `maxDeltaTime`
    0.5 s (catch-up frames of up to 30 steps): still `82c78afd` in all three; the gate held 33
    (SAB) and 42 (message batch) times, 0.42-0.54 s in all. A slowed worker wasn't emulated
    (CDP throttles the page's main thread), but it needs the same hold, which the stalls cover.
  - Phase 1's checks pass again after the fix (`90856586`), and the probe's `physicsTest` hash
    stays `d5c1562a`.
- Not changed: `getPhysicsWorld().createJoint` on `MAIN_THREAD` goes to the engine directly and
  skips the facade's joint registry, so tier code (`hasJoints`, joint groups, the `REMOVED`
  refusal) doesn't see such a joint (the engine still refuses the detach, and the entity then
  stays `REMOVED` without having left). `createJoint` (`PhysicsAPI.ts`) registers it. That was
  there before p343; a fix is p352's or a joint plan's.

## 8. Versioning

Lands on the `physics-simulation-tiers` branch, inside p352's engine minor bump. The demo scene
change is within that branch's app patch bump.

## 9. Open questions

1. ~~Default cadence: `STEPS` (determinism is an engine-wide guarantee, p101) or `FRAMES` (no
   gate, no delay)?~~ Decided before Phase 1: `STEPS`.
2. Should the worker compute the rings itself and reply only the changes? Less to transfer for
   very large member counts, but the decision code would exist twice (engine and main thread).
   Not before a member count makes the 12 bytes per member matter.
