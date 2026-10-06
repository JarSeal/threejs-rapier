Status: draft | not-implemented
Category: Physics
Blocks: p352_physics-simulation-tiers.md (its Phase 4: §5's policy gets this option before the phase is marked done)
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

### Phase 1 — Step plumbing

`getPhysicsSubStepIndex`, `addPhysicsStepGate`, `readBodyPositions` and `RIGID_READ_POSITIONS`
(protocol type, worker switch, facade `readBodyPositionsAtStep(ids)`: sync in `MAIN_THREAD`,
step-pinned request in `WORKER_THREAD`). Nothing uses them yet.

**Exit:** scripted checks in both targets: the index inside `APP_PHYSICS_STEP` matches the step
a kinematic body was moved on; positions read at step `k` are equal in both targets; a held gate
stops stepping at its step, and releasing it catches up the held time.

### Phase 2 — Cadence option

`cadence` and `interval` on the policy, the `STEPS` pass (§3), `focus(step)`, the probe's freeze
exemption, the demo scene on `STEPS`. Debug readouts with p352 §6.

**Exit:** the p352 Phase 4 policy checks pass in both cadences and all three targets
(`MAIN_THREAD`, `WORKER_THREAD` with and without SAB). `physicsTiers` with the policy running:
the probe hash (N=900 and N=3000, so it covers `REMOVED` round trips) is the same on every load
and across all three targets. A frame-timing stress (catch-up frames, a slowed worker) changes
the gate counts, not the hash.

## 8. Versioning

Lands on the `physics-simulation-tiers` branch, inside p352's engine minor bump. The demo scene
change is within that branch's app patch bump.

## 9. Open questions

1. Default cadence: `STEPS` (determinism is an engine-wide guarantee, p101) or `FRAMES` (no
   gate, no delay)? Recommended: `STEPS`.
2. Should the worker compute the rings itself and reply only the changes? Less to transfer for
   very large member counts, but the decision code would exist twice (engine and main thread).
   Not before a member count makes the 12 bytes per member matter.
