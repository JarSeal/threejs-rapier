Status: implemented
Category: Physics
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Interpolation Optimization and Fixes — Plan

## Context

Moving the player in the gym scene nudges/yanks under every `interpolationMode`, far worse
on Chrome/Windows (high refresh) than on a 60Hz MacBook Air, and it disappears when the
free debug camera replaces the third-person follow camera.

`_DONE_p024_interpolation-in-the-physics-api.md` shipped the modes, but its Phase 1
prerequisite — a double-buffered, producer-stamped transform buffer — was never built.
`prev`/`curr` are instead reconstructed on the main thread by observing when values change
at render time, and that shortcut is the origin of both interpolation defects.

**Direct answer to the question raised with this plan: the modes are not working
correctly.** `RENDERER` degenerates to something strictly worse than `NONE` at 60Hz, and
`FIXED_PHYSICS` is invalid under `WORKER_THREAD` — which is the shipped configuration
(`src/CONFIG.ts:12-20`). Separately, the follow camera reads the pose one stage too early,
which is why the debug camera looks better. There are also two genuine character-controller
bugs, though — importantly — neither is the main nudge source.

**Answering the wireframe observation:** the Rapier debug wireframe can no longer show the
interpolation offset. In `_dbg__PhysicsDebugDraw.ts:802-805` a wireframe for a body that
has an `OBJECT3D` (every `BODY_DYNAMIC_VISUAL`) is added as a *child of the mesh's
Object3D*, so it rides the interpolated pose; only `BODY_DYNAMIC_HEADLESS` bodies get the
raw stepped pose (`:1010-1013`). The legacy system drove it from the raw body transform,
which is exactly why it used to run ahead of the mesh while running and get caught up on
stop. Restored in Phase 6, where it doubles as the acceptance test.

### Frame order (verified — `ECS.ts:806-826`, `MainLoop.ts:128-186`)

```
MAIN              object3DSyncSystem: TRANSFORM -> Object3D (only when dirty)
APP_PRE_PHYSICS
stepPhysics()     accumulator; runs APP_PHYSICS_STEP 0..N times
APP_POST_PHYSICS  physicsToTransformSystem: rb.pos/rot -> TRANSFORM (hard snap)
APP_LOGIC         followObjectCameraRigSystem   <-- reads the mesh here
APP_RENDER_SYNC   physicsInterpolationSystem    <-- writes the mesh here
renderScene()
LATE_MAIN
```

`addSystem(stage, id, fn, order = 0)` sorts `b.order - a.order || a.seq - b.seq`
(`ECS.ts:313-329`): **higher `order` runs earlier**, ties break on registration sequence.

Because `object3DSyncSystem` (MAIN) runs *before* `physicsToTransformSystem`
(APP_POST_PHYSICS), it consumes the dirty flag only on the following frame. **`NONE` is
therefore already one render frame stale**, and the interpolated modes are one frame *less*
latent than `NONE`, not more. Latency budgets must be measured against this, not zero.

### Defect 1 — `RENDERER` discards its phase remainder every segment

`PhysicsManager.ts:381-402`. `state.currTime = now` is assigned on the frame a snapshot is
*noticed*, and `alpha = (now - currTime) / (currTime - prevTime)` — identically `0` on a
detection frame.

- **60Hz physics / 60Hz display** — every frame is a detection frame, so alpha ≡ 0. The
  mode is **bit-identical to `NONE` delayed by one snapshot**: strictly worse than `NONE`,
  never better. This is why no interpolation is visible on the Mac.
- **60Hz physics / 144Hz display** — within a segment progress runs 0 → ~0.42 → ~0.83 then
  hops to 1.0 (the next segment's alpha 0). Motion is always *forward* — no reversal — but
  velocity is uneven at the snapshot rate. Worse, `interval` is the gap between two
  *detection frames*, so it alternates 13.9ms / 20.8ms (2 or 3 render frames) against a
  true 16.67ms interval: a ±20% denominator error that flips period to period, adding a
  ~25Hz beat on top of the stutter.

Root cause: **the phase reference is "the wall-clock instant we noticed a snapshot", not a
continuously advancing clock.** The time between a snapshot becoming valid and the frame
that noticed it is discarded every segment.

### Defect 2 — `FIXED_PHYSICS` alpha is meaningless under `WORKER_THREAD` (the shipped default)

`alpha = accDelta / timestepRatio` (`PhysicsAPI.ts:694-697`) is the **main thread's**
accumulator, but `prev`/`curr` only advance when `getPhysicsSnapshotCount()` changes —
which in worker mode is `transformBuffer.getWriteCount()`, bumped **asynchronously** by the
worker after it writes the SAB. `stepPhysics`'s worker branch is explicitly fire-and-forget
(`PhysicsAPI.ts:392-401`).

On the frame the main thread consumes a step, `accDelta` drops a full timestep so alpha
resets to ≈0 — but the matching snapshot has not arrived, so the system renders `prev` of
the *old* pair, rewinding nearly a full step. One or two frames later the write lands,
`prev←curr`, alpha is already ~0.4, and the pose jumps forward. **Sawtooth once per physics
interval, amplitude up to one step of motion** (3.7 u/s ÷ 60 ≈ 0.062 units ≈ 3-4 px at the
gym's ~21-unit camera distance).

**This is a race, not a fixed offset**, which is worse. Under `SHARED_MEMORY` the worker
runs genuinely concurrently and may bump the counter while the main thread is still in
APP_LOGIC, so the slip lands in frame N on some frames and N+1 on others depending on load
and scheduler luck. (Under `MESSAGE_BATCH` it is deterministically ≥1 task late — ironically
better behaved.) At 60Hz render you sample the sawtooth once per interval so it reads as
constant lag; at 144Hz you sample it 2-3 times and see it. Windows-vs-Mac again.

Compounding: the worker writes back **once per `STEP` message regardless of `steps: N`**
(`physicsWorker.ts:293-310`), and `mainThreadSnapshotCount++` is likewise once per frame
(`PhysicsAPI.ts:374`). A *steady* N is harmless; the damage appears when **N alternates**
(1,2,1,2 — common at 72/90/100Hz against 60Hz physics), because segment length changes
while alpha's denominator stays `timestepRatio`, so the pose runs ahead by `(N-1)·alpha` on
long segments and pops at each transition.

`FIXED_PHYSICS` on `MAIN_THREAD` is correct today apart from that mixed-cadence case.
`p024:55-71` already defined `RENDERER` as the decoupled received-snapshot mode for the
worker case and `FIXED_PHYSICS` as the classic synchronous accumulator pattern —
**`FIXED_PHYSICS` + `WORKER_THREAD` is an unguarded invalid combination**, and the doc
comment at `PhysicsAPITypes.ts:113-116` ("more approximate under WORKER_THREAD latency")
badly understates it.

### Defect 3 — the follow camera reads the pose one stage too early

`followObjectCameraRig.ts:56-63` registers at `APP_LOGIC` and reads
`targetPos.copy(targetMesh.position)` (`:154`, `:198`). At `APP_LOGIC` that Object3D holds
what `object3DSyncSystem` wrote at MAIN — the **previous** frame's discrete snapshot;
`physicsInterpolationSystem` then overwrites it at `APP_RENDER_SYNC`. So the camera chases
a pose that is both stale *and on a different clock* than the thing it frames, and because
the character sits at screen centre that error maps ~1:1 to its on-screen position.
`camera.lookAt` (`:165`, `:236`) is unsmoothed, so it passes straight into rotation.

**Scoping correction:** this is a `RENDERER`/`FIXED_PHYSICS` bug only. In `NONE` the
interpolation system early-returns (`PhysicsManager.ts:356-357`), so the rig reads exactly
the Object3D the renderer draws — camera and character are consistent (both one frame
stale). Nudging in `NONE` is ordinary uninterpolated 60Hz-pose-on-144Hz-render judder plus
Defect 5, not this.

The rig's doc comment at `:50-55` claims it runs after "APP_POST_PHYSICS / APP_RENDER_SYNC,
both earlier in the same frame" — factually wrong; `APP_LOGIC` satisfies the letter of its
"after physics" intent while violating it.

**A naive stage swap will silently not fix this.** `registerFollowObjectCameraRigSystem`
runs from `AppECSPlugins.ts` at world construction, while `registerPhysicsManager` runs
later (`InitApp.ts:82`), so at the default `order: 0` the rig gets an *earlier* `seq` and
would still run first. The order must be explicit.

### Defect 4 — character acceleration scales with the render delta

`move()` (`dynamicCharacter.ts:433`) uses `transformAppSpeedValue(...)` =
`deltaApp * unitsPerSecond` (`MainLoop.ts:81`) inside a fixed sub-step, while its sibling
`rotate` correctly uses `getPhysicsState().timestepRatio` (`:403-409`).

**This is not a nudge source** — worth stating plainly, because it is the intuitive
suspect. At steady state `xAddition` is clamped to `xMaxVelo` whenever `isGrounded`
(`:444-463`), so `setLinvel` writes exactly the clamp value every sub-step regardless of
`veloAccu`: constant velocity, perfectly even motion. What it actually breaks is the
**acceleration ramp**: at 144Hz `veloAccu` is 30·(1/144) = 0.208 per sub-step vs 0.5 at
60Hz while sub-steps still occur 60×/s, so effective acceleration is ~2.4× lower on the
Windows machine (~0.3s to top speed instead of ~0.12s). Real, fix-worthy, and it will feel
different Windows-vs-Mac — but as "sluggish start", not nudging.

Related, in the same file: a **hardcoded `0.016`** at `:584-585` (unwalkable-slope slide
impulse) is a silent 60Hz assumption, correct today only because `timestep: 60`.

### Defect 5 — `turnCharacter` writes the mesh quaternion, causing yaw alternation in `NONE`

`turnCharacter` (`:393-400`) writes both `charMesh.quaternion.copy(yawQuat)` and
`characterBody.setRotation(...)`. The doc comment at `:389-392` claims the yaw "never
accumulates in `charMesh.quaternion`" — line 396 does precisely that.

Nothing "fights" in the interpolation modes (interpolation is the unconditional last writer
before render, so the direct write is simply discarded — consistent, hence lag not jitter).
The defect is in **`NONE` mode**: `object3DSyncSystem` rewrites the quaternion from
TRANSFORM every frame at MAIN, while `turnCharacter` writes the live yaw only on frames
that actually run a sub-step — ~42% of frames at 144Hz vs 60Hz physics. So rendered yaw
alternates frame-to-frame between live yaw and physics yaw. **Textbook rotational nudging,
only when render rate ≫ physics rate, invisible at 60Hz** — matching the Windows-vs-Mac
report.

### Further defects found during investigation

| # | Issue | Location |
| --- | --- | --- |
| D6 | `interpolationStates` is a module-level `Map` keyed by bare entity id, but `nextEntityId` is **per-world** (`ECS.ts:229`), so ids collide across worlds and the statically-registered `onDeleteEntity` hook deletes another world's state. `lastSnapshotCount` being global is the lesser half. | `PhysicsManager.ts:106`, `:341-342` |
| D7 | `RigidBodyProxyAPI.pos`/`.rot` return a **fresh object literal per read**. Each body is read twice per frame × pos+rot = **4 objects/body/frame** (~120k/s at 500 bodies). `MESSAGE_BATCH` also rebuilds a whole `PhysicsTransformBuffer` + 2 views per step. | `PhysicsAPI.ts:2085-2102`, `:530` |
| D8 | `rb.rot` returns `{0,0,0,0}` before the first snapshot. Today's code survives because it only `set()`s; any `normalize()`/`slerp()` work would propagate NaN into the matrix and silently vanish the mesh. | `PhysicsAPI.ts:2100` |
| D9 | SAB reads **tear** — single-banked, no seqlock. The worker can write between the `getWriteCount()` read and the pose reads, so the two consuming systems can see different snapshots in one frame. p024 DD2 called for double-buffering; never implemented. | `PhysicsTransformBuffer.ts` |
| D10 | `stepMessagesPosted = 0` is reset only in the `SHARED_MEMORY` branch, so in `MESSAGE_BATCH` a recreated world leaves `isWritePending()` permanently true and every `rb.pos` returns the stale pending write. | `PhysicsAPI.ts:759` |
| D11 | The gym never calls `deleteFollowObjectCameraRig`, so the rig keeps ticking against a deleted mesh after scene exit. | `scene_thirdPersonGym.ts:271-278` |
| — | `teleport`/`setTransform` do not reset interpolation history → a teleported body streaks across the jump. | `@CHORE` at `ECS.ts:678` |
| — | No `isDisabled` guard, unlike `object3DSyncSystem`. | `PhysicsManager.ts:366` vs `ECSCoreSystems.ts:157` |
| — | Per-frame allocs: `new THREE.Vector3().setFromSpherical(...)` ×2; `target.clone()` in `smoothDampVec3`. | `followObjectCameraRig.ts:141,195`; `helpers.ts:184` |
| — | `LERP` branch uses `smoothTime` directly as the per-frame alpha, no dt correction. | `followObjectCameraRig.ts:162` |
| — | `maxFPSInterval` is `1 / maxFPS` (seconds) but compared against a millisecond delta, so the FPS limiter never engages. | `MainLoop.ts:325` vs `:146` |
| — | The rig writes `camera.position`/`quaternion` directly, never into the camera's ECS `TRANSFORM`; survives only because `object3DSyncSystem` copies when dirty, so a debug-GUI edit or scene re-enter snaps the camera back. | `followObjectCameraRig.ts` |
| — | `FollowTool.ts:36-137` has the same class of bug in the *write* direction (writes the follower's TRANSFORM, which reaches its Object3D only at next frame's MAIN, so it trails the leader's interpolated pose). Unused by any app scene today. Note in the convention doc; do not fix here. | `FollowTool.ts` |

## `RENDERER` vs `FIXED_PHYSICS` — what each is for

(Answering the question raised with this plan. This is the **post-fix** semantics; today
the distinction is largely accidental.)

After the fix both modes run *identical* blend math. They differ only in **which clock
decides where between the two poses you are** — which is really open-loop vs closed-loop
control.

**`FIXED_PHYSICS` — open-loop, derived from the stepper.**
`renderSimTime = stepsIssued·ts + accDelta − D`. No servo, no state, no latency beyond the
mandatory one-interval delay. Exact and frame-reproducible — *provided the snapshot for
`stepsIssued` is visible in the frame it was issued*. That holds if and only if the producer
is synchronous, i.e. **`MAIN_THREAD`**. Under a worker, open-loop is structurally
impossible: you would need the worker's latency, and measuring it is by definition a closed
loop.

**`RENDERER` — closed-loop, servo'd to the arrival stream.**
A playback clock advanced by real dt and gently rate-corrected toward
`newestVisibleSimTime − D`. Because the target references **only snapshots already
visible**, worker latency is never estimated — it is absorbed as a constant steady-state
offset. You pay in latency and nothing else; only arrival *jitter* needs headroom.
Tolerates late, dropped or bunched write-backs by stretching the current segment rather
than stalling and snapping.

| | `FIXED_PHYSICS` | `RENDERER` |
| --- | --- | --- |
| producer | `MAIN_THREAD` | `WORKER_THREAD` (either transport) |
| latency | 1 interval (~16.7ms @60Hz) | 1 interval + worker latency + jitter margin (~25-40ms) |
| late snapshot | clamps to `curr`, freezes a frame | rides through it out of the jitter buffer |
| determinism | frame-exact, reproducible | timing-dependent |

**`NONE`** — no smoothing, already one render frame stale, and inherently judders whenever
render rate exceeds physics rate. Keep it as the honest baseline for verifying the others;
do not treat its judder as a bug.

Rule of thumb: **synchronous producer → `FIXED_PHYSICS`; threaded or jittery producer →
`RENDERER`.** Free regression test: on `MAIN_THREAD` the two modes must converge to
**bit-identical** output in steady state (the servo settles at lag zero and both pick the
same `D`).

## Design decisions

1. **One clock invariant.** Every rendered pose is the evaluation of a **monotone render
   clock measured in simulated time** against a segment whose endpoints carry
   **producer-supplied simulated-time stamps**:
   `alpha = (renderSimTime − prevSimTime) / (currSimTime − prevSimTime)`, clamped. Stamps
   are integer step indices (`simTime = stepIndex · timestepRatio`) so there is no float
   drift. Nothing may reference "the wall time we noticed something."

2. **The delay is one snapshot *interval*, not one step.** Measure it from the stamps
   (`(currIdx − prevIdx)·ts`), never assume `timestepRatio`. With a 2-steps-per-writeback
   cadence and `D = 1·ts`, alpha clamps at 1 for half of every frame pair
   (freeze-then-lurch); with `D = 1 interval = 2·ts`, alpha sweeps 0→1 exactly as `accDelta`
   sweeps 0→2·ts — continuous and uniform. In the ordinary 1-step case it reduces to today's
   `accDelta / ts`, so correct `MAIN_THREAD` behaviour is preserved bit-for-bit. **This
   fixes the multi-step half of Defect 2 by construction.** Because intervals alternate, use
   `D = max(recent intervals over ~0.5s)`, not a mean, so short intervals are merely
   extra-delayed rather than clamping on the long ones.

3. **Correct by time dilation, never displacement.** `renderSimTime` is only ever advanced
   by `dt · rate`, never assigned (outside explicit resets). That single rule kills Defect 1
   — the remainder lives in the clock variable and is never discarded at a boundary, so
   boundaries become pure bookkeeping and the pose function is continuous across them. Clamp
   `rate` to ~`[0.85, 1.15]`: a 15% velocity error on an already-moving object is
   imperceptible; a 2mm position jump is instantly visible. Take `dt` from the system's own
   argument — do **not** add a third `THREE.Timer` (there are already two, `MainLoop`'s and
   `PhysicsAPI.ts:667`); preferably have `stepPhysics` publish its dt so the clock and the
   accumulator advance on literally the same number.

4. **Hard-reset (snap, re-anchor, no servo)** on: world create/delete, snapshot restore,
   pause→resume, `maxSubSteps` overflow, debug-GUI mode change, and `|err| > 4·D`. The
   overflow case matters: `PhysicsAPI.ts:348` deliberately discards accumulated time, so the
   render clock **must** discard the same amount or it outruns the stream permanently. It
   coincides with an already-hitched frame, so snapping is honest — but clamp alpha ≥ 0 so
   the pose freezes rather than reversing.

5. **Ring of 3 snapshots per entity, not 2.** With `D` up to ~2 intervals under jitter,
   `renderSimTime` can legitimately fall before `prev`; two slots would clamp to alpha 0 and
   stall. Per entity one `Float32Array(3·7)` and one `Int32Array(3)`, allocated once and
   mutated in place, plus module-scope scratch for the blend. **One rule covers new,
   disabled, re-enabled, skipped and teleported entities**: if the global snapshot index
   advanced by more than `lastSeenSnapshotIndex + 1`, the history has a hole — snap to
   `curr`, reseed, skip interpolation this frame.

6. **Stamp snapshots at the producer.** A main-thread-only reconstruction (a ring of
   `cumulativeSteps` keyed by message index) is possible but rests on an invariant spanning
   three files and a thread boundary that is **already broken**: `writeBackTransforms`
   early-returns before `markWritten()` on one path; D10 breaks the message-index ↔
   write-count correspondence in `MESSAGE_BATCH` today; and `CREATE_WORLD`/`RESTORE_SNAPSHOT`
   restart the worker's counter while main-thread state keeps climbing. For 4 bytes and one
   `Atomics.store` per step the snapshot becomes self-describing instead. Add one trailing
   `Int32` (cumulative steps executed) written **before** `markWritten()` (the release
   fence), behind a named `PHYSICS_TRANSFORM_HEADER_INTS` constant rather than a hardcoded
   `+ 4`. Both transports already copy the whole buffer verbatim, so `MESSAGE_BATCH` needs no
   protocol change.

7. **Warn on the invalid pairing; do not silently substitute.** `FIXED_PHYSICS` +
   `WORKER_THREAD` gets a one-time `lwarn` in debug builds, and `src/CONFIG.ts` moves to
   `RENDERER`. A silent auto-fallback would make the debug dropdown lie about what is
   running.

8. **A render-pose ordering convention, expressed as named order constants.** The missing
   rule: *any system that reads or writes the **Object3D** render pose of a physics-driven
   entity must run after `physicsInterpolationSystem`.* `TRANSFORM`-domain systems stay put.
   Export constants beside the stage enum in `AppECSRegistry.ts`:
   `APP_RENDER_SYNC_ORDER.POSE_PRODUCERS = 0` (interpolation, `lookAtSystem`),
   `POSE_CONSUMERS = -0.5` (camera rigs), `CULLING = -1 / -2` (documenting what exists).
   **`-0.5` is deliberate and load-bearing:** it must be after every `order: 0` system
   regardless of registration sequence, *and* still before `objectFrustumCullingSystem`
   (`-1`), which calls `getMainCamera()` and `camera.updateMatrixWorld()`
   (`ObjectFrustumCullingSystem.ts:130-143`) — moving the rig after culling would trade this
   bug for one-frame-stale culling and edge popping. Add the rule as a doc comment on
   `ECSSystemStage.APP_LOGIC`. Do **not** reorder `lookAtSystem`; its current tie is fine and
   changing it would alter behaviour for any entity that is both a `TARGET_LINK` looker and a
   dynamic body.

9. **The character accelerates on the simulation clock.** Held-key callbacks already receive
   the poll's delta (`KeyboardInput.ts:39`, `:276`) and `runPhysicsSubStep` passes the fixed
   timestep (`MainLoop.ts:99`), so `move()` should use the delta it is already handed rather
   than `transformAppSpeedValue` — also correct in the physics-disabled fallback, where
   `MainLoop.ts:104-110` polls with the frame delta on purpose. Drop the now-unused import or
   lint fails. Fix the hardcoded `0.016` at `:584-585` in the same pass.

10. **`turnCharacter` stops writing the mesh quaternion.** The body rotation set on the next
    line is the single source of truth, as the existing doc comment already claims. Also
    switch `stopCharacterTumbling` (`:1254`) to read `body.rotation()` rather than
    `charMesh.quaternion`, which in interpolation modes is a slerped intermediate.

11. **Normalize quaternions at capture, not per frame.** Float32 round-trip error is ~1e-7
    and `Quaternion.slerp` assumes unit inputs — two `sqrt` per body per *snapshot*. Guard D8:
    skip the entity if `x²+y²+z²+w² < 1e-6`. No hemisphere flip needed (THREE's `slerp`
    already takes the short path), and normalizing the slerp *output* is unnecessary — the
    legacy belt-and-braces at `PhysicsRapier.ts:1848-1853` can be dropped.

12. **`NONE` untouched, `EXTRAPOLATION` still unimplemented.** Keep `NONE`'s early return at
    the very top so `object3DSyncSystem` remains the sole writer and behaviour is
    byte-identical. Give `EXTRAPOLATION` an explicit `case ...: return;` rather than relying
    on a negated condition.

13. **The debug wireframe shows the raw physics pose again.** Interpolation is a render-only
    overlay, so the tool for inspecting it must not ride it. Give `BODY_DYNAMIC_VISUAL`
    wireframes their own scene-root host driven from `rb.pos/rot`, as headless bodies have.

## Phases

**Phase 0 — Zero-code diagnostic (do this first).**
On the Windows/144Hz machine, flip `interpolationMode` live in the Physics API debug tab
(`_dbg__PhysicsAPI.ts:732-745`) across `NONE` / `RENDERER` / `FIXED_PHYSICS` × follow camera
/ debug camera; then set `workerTarget: 'MAIN_THREAD'` in `src/CONFIG.ts` and repeat
`FIXED_PHYSICS`. Expected if the model above is right: `FIXED_PHYSICS`+`WORKER_THREAD`+debug
camera **still nudges** (proves Defect 2 is camera-independent); `FIXED_PHYSICS`+`MAIN_THREAD`
+debug camera is clean; `RENDERER`+follow camera nudges while `RENDERER`+debug camera does
not (proves Defect 3). Ten minutes, and it tells you which fixes actually matter before
anything changes. Clear the localStorage-persisted mode first (`_dbg__PhysicsAPI.ts:127-152`)
or the mode under test may not be the configured one.

**Phase 1 — Invalid-pairing guard + camera ordering.** The two highest-impact changes.
Add the `FIXED_PHYSICS`+`WORKER_THREAD` warning and switch `src/CONFIG.ts` to `RENDERER`
(DD7). Re-register the rig at `APP_RENDER_SYNC` with `order: -0.5`, add the order constants
and stage doc comments (DD8), and rewrite the wrong comment at `followObjectCameraRig.ts:49-55`.
*Verify:* follow camera in `RENDERER` should now match the debug camera; frustum culling
still culls against the live camera with no edge popping.

**Phase 2 — Character controller fixes.** DD9 and DD10, kept separate so any "feels
different" is attributable. *Verify:* acceleration ramp is now identical at 60Hz and 144Hz;
turning in `NONE` at high refresh no longer alternates; exercise the full
tumble → getting-up → upright cycle, the only consumer of the removed mesh write.

**Phase 3 — The render clock, main-thread only.** Per-world state (D6), ring-of-3,
hole-detection snap, `isDisabled` guard, capture-time normalization + NaN guard (D8), reset
events, `stepsIssued`/`simClock`, both clock sources (DD1-5). Derive the snapshot step index
from a main-thread message-index ring for now. Fixes Defects 1 and 2 properly. Update the
mode docs (`PhysicsAPITypes.ts:106-119`) and dropdown labels; add live readouts for clock
lag, `rate`, `D` and measured interval — the jitter margin cannot be tuned without them. No
protocol or worker change.
*Verify:* the objective test below, plus a visual pass across all modes at native and
throttled framerates.

**Phase 4 — Producer-side step stamp.** DD6: header ints 1→2, `markWritten(stepIndex)`,
`getStepIndex()`; worker-side cumulative counter from `writeBackTransforms`
(`physicsWorker.ts:293`); mirror on the `MAIN_THREAD` path. Replaces Phase 3's ring and also
fixes D10. *Verify:* behaviour-neutral if Phase 3 is right — the two stamp sources must agree
exactly, which makes this its own self-check. Confirm SAB still allocates cross-origin-isolated
and `MESSAGE_BATCH` still works.

**Phase 5 — Teleport / transform-reset invalidation.** Closes the `@CHORE` at `ECS.ts:678`.
`PhysicsManager` imports `ECS`, so `ECS` cannot import back: use the existing hook idiom — a
static `ECSWorld.registerTransformResetListener(fn)` fired from `setTransform` whenever
`pos`/`rot` is given (`teleport` delegates to it, so needs nothing of its own). Do **not**
reseed from `rb.pos`: under `WORKER_THREAD` that is the *pending* value
(`PhysicsAPI.ts:2085`) and would stamp a pending pose with a simulated time it does not
belong to. Set a `snapUntilStepIndex` and write the authoritative pose straight to the
Object3D until a later-stamped snapshot arrives.
*Verify:* a teleported body must not streak; two ECS worlds with physics must both interpolate.

**Phase 6 — Debug wireframe raw pose.** DD13. Restores the legacy visual and acts as the
acceptance test for Phases 3-4. *Verify:* under `RENDERER`/`FIXED_PHYSICS` the wireframe
leads the mesh while running and converges on stop; under `NONE` they stay locked.

**Phase 7 — Allocation and hygiene pass.** `PhysicsTransformBuffer.readPoseInto(slot, out,
offset)` and a matching `readPoseInto` on `RigidBodyAPI` used by **both** consuming systems
(D7, −4 objects/body/frame). Then hoist the two `setFromSpherical` allocations, drop
`target.clone()` from `smoothDampVec3`, make the `LERP` branch dt-correct
(`1 - Math.exp(-dt / smoothTime)`), add the missing `deleteFollowObjectCameraRig` on gym
scene exit (D11), and fix the `maxFPSInterval` unit bug (`MainLoop.ts:325`).
*Verify:* a ~30s movement profile shows no per-frame GC sawtooth from these paths;
`VITE_MAX_FPS=30` actually caps.

**Phase 8 (separate plan: [p063_triple-buffered-physics-transform-buffer.md](./p063_triple-buffered-physics-transform-buffer.md)) — Double-banked buffer (D9).** Fixes tearing, lets the main thread
latch one bank per frame so both consuming systems agree, and yields `prev`/`curr` for free.
The right long-term shape, and genuinely not a prerequisite for correct alpha.

## Non-goals

- Implementing `EXTRAPOLATION` — still a feasibility study in `p024`.
- Double-banking the transform buffer (D9) — deferred to its own plan.
- Smoothing `camera.lookAt` — an amplifier, not a cause; once the rig reads the rendered
  pose its input is already smooth. Changing it alters camera feel (lag between where the
  camera points and where the player is), which is a design decision. Hold in reserve if
  residual jitter remains after Phase 1.
- Fixing `FollowTool`'s write-direction lag — same family, unused by any app scene today.
- Client-side prediction for character rotation (the honest answer if Phase 2's turn latency
  is unacceptable) — that is a project, not a fix.
- Touching legacy `PhysicsRapier.ts`; per-scene interpolation settings; netcode/rollback.

## Risks / open questions

| Risk / question | Notes |
| --- | --- |
| Phases 0-2 may resolve the reported symptom on their own | A good outcome. Phases 3-4 still fix a demonstrably wrong shipped default; re-assess scope with the user after Phase 1. |
| Changing the app default to `RENDERER` is user-visible | Justified — `FIXED_PHYSICS`+`WORKER_THREAD` cannot be correct open-loop. Warn rather than auto-substitute so the dropdown never lies. Confirm with the user. |
| Fractional `order: -0.5` is unprecedented here (all existing orders are integers) | Legal (`addSystem` sorts a plain number). The alternative is renumbering the two culling systems to `-10/-20`, touching two more files. Document the choice inline. |
| Phase 2 changes game feel | Acceleration becomes framerate-independent; values tuned on a high-refresh machine will accelerate faster. `_accumulateVeloPerInterval` (default 30, clearly tuned at 60Hz) is the knob. |
| Removing the mesh-quaternion write adds turn latency in worker mode | It makes rotation *consistent* with position, which already lags. Today position lags and rotation does not — its own artefact on a capsule with a direction beak. |
| Servo tuning (`K`, rate clamp, `jitterMargin`) is empirical | Start `jitterMargin` at `0.5 · maxRecentInterval` (~8ms at 60Hz): SAB write-back jitter is dominated by main-thread scheduling of the read, i.e. one rAF period, and half an interval covers the common case without pushing total latency past ~40ms where direct control feels mushy. Phase 3's readouts exist for this. |
| `NONE`-mode judder is inherent and will not be fixed | Set expectations if smoothness is being judged in `NONE`. |
| The MacBook at 60Hz is a poor regression gate | Several defects are high-refresh-only. Verify on the Windows machine. |
| Interpolation mode persists to localStorage | `_dbg__PhysicsAPI.ts:127-152` overrides `CONFIG.ts` in debug/prod-test builds. Clear or set explicitly before every verification run. |

## Verification

- `tsc --noEmit` and `yarn lint` clean after every phase (per the repo's Stop hook).
- Each phase's own manual check, above.
- **Objective regression test (the one that matters).** Drop a single body under constant
  gravity, log `(renderSimTime, obj3D.position.y)` every frame for ~5s, and assert the
  **second difference of `y` is constant to within fp error**. Every defect above — the
  alpha-0 reset, the phase race, the alternating-segment pop, the overflow re-anchor — shows
  up as a spike there. Eyeballing will not catch the intermittent ones. Run per mode × per
  `workerTarget`.
- **`MAIN_THREAD` mode-equivalence assertion:** in steady state `FIXED_PHYSICS` and
  `RENDERER` must produce bit-identical output.
- Cross-cutting matrix after Phase 6: gym × {`NONE`, `RENDERER`, `FIXED_PHYSICS`} ×
  {`MAIN_THREAD`, `WORKER_THREAD`} × {native, throttled}, walking and running, wireframe on.
  Neither interpolated mode should nudge; `NONE` should show its expected per-step snap.
- Confirm on both a high-refresh Windows display and a 60Hz panel.

## Implementation notes

Implemented in phases 1-7 (commits `54313f0`..`6aa611d`). Phase 8 became its own plan,
[p063_triple-buffered-physics-transform-buffer.md](./p063_triple-buffered-physics-transform-buffer.md).
Phase 0 (the manual diagnostic on the high-refresh Windows machine) was the user's to run; no
results are recorded here.

### How it was verified

No test runner exists, so every phase was checked with small headless Playwright scripts
(`playwright-core` from `.claude/skills/run-aekasha-js/`) against a dev server on a spare port.
They weren't committed; this is the method, for reuse (p063 needs it):

- **Driving the engine.** Vite serves source modules, so a script can `import()` engine
  modules in the page. Import the exact URLs the app loaded (from
  `performance.getEntriesByType('resource')`): after an HMR update Vite appends `?t=…`, and a
  bare path then gives a *second* module instance with its own state. Boot overrides go into
  `localStorage['AEK_debugPhysicsApiBoot']` (`workerTarget`, `useSAB`) via `addInitScript`.
- **Rendering isn't needed.** WebGPU can't render in headless Chrome under WSL2 (buffer-size
  errors). The ECS stages still run, so probes read the pose that would be drawn from a system
  at `APP_RENDER_SYNC` with order −100 (after every pose writer, before `renderScene()`).
- **Emulating high refresh.** Headless rAF is 60Hz. Setting physics to 25Hz
  (`state.timestep`, `timestepRatio`, `getPhysicsWorld().setTimestep`) gives the same
  render-to-physics ratio as 144Hz against 60Hz physics.
- **Smoothness metric.** A box created 5000 units up falls freely. Per frame: rendered
  velocity = Δy / Δ(`getPhysicsSimClock()`), fitted linearly. Jitter = RMS residual / mean
  velocity; also counted: reversals, stalls. The plan's "second difference of y is constant"
  test can't pass even when everything is correct, because blending straight lines between
  points on a parabola puts kinks in the velocity at every step boundary. The fit residual
  measures that floor instead (~0.31%).
- **Allocations.** CDP `HeapProfiler.startSampling` with `includeObjectsCollectedByMajorGC`/
  `MinorGC`, aggregated by function; 500 dynamic bodies for 10s.
- **Baselines** were run from a throwaway `git worktree` of the previous commit, with its own
  Vite `cacheDir` (a wrapper config). With a symlinked `node_modules`, the default cache is
  shared, and a second server rewriting it gives every other running dev server `504
  Outdated Optimize Dep` errors, the user's own `yarn dev` included.

### Results

| Check | Before | After |
| --- | --- | --- |
| `RENDERER` jitter, 25Hz physics, `MAIN_THREAD` / SAB / `MESSAGE_BATCH` | 54% with 15 stalls on each | 0.31-0.33% everywhere, no stalls |
| `FIXED_PHYSICS` + SAB worker, 25Hz | 237%, 75 reversals | ~55% (unsupported pairing, warned) |
| `MAIN_THREAD`: `RENDERER` vs. `FIXED_PHYSICS` | differed | identical: lag = `D`, servo error 0, same jitter |
| Teleport, frames rendered mid-streak | 2-3 | 0 |
| Producer stamp vs. main-thread count (Phase 4) | — | 0 disagreements in ~8,400 reads |
| Allocations on the physics/interpolation paths, 500 bodies (worker / main) | 15.4 / 17.5 MB/s | 1.1 / 4.4 MB/s |
| `VITE_MAX_FPS=30` on a 60Hz loop | 60 fps (never engaged) | 30.0 fps |
| Follow rig after leaving the gym | kept ticking | stops |

### Where the implementation departs from this plan

- **Phase 1.** The invalid-pairing warning lives in `physicsInterpolationSystem`, not at init, so
  it also catches a mode restored from localStorage or switched live. The order constants are
  also used by `lookAtSystem` and the two culling systems (same values, so no behaviour change).
- **Phase 2.** `rotate()` takes the delta too, like `move()`. The old `move()` also applied the
  play-speed multiplier twice, since `deltaApp` includes it and the accumulator adds sub-steps
  for it. `stopCharacterTumbling` did more than read the mesh: it used the mesh as scratch to
  build the upright rotation and then overwrote the body's rotation with it. It was rewritten
  to work from `body.rotation()` alone.
- **Phase 3 — the servo.** The `RENDERER` target is anchored on each newly visible snapshot at
  its step plus the accumulator *phase* its batch was issued at. On `MAIN_THREAD` that's
  exactly the `FIXED_PHYSICS` clock, which is why the two modes converge. The jitter margin is
  0 on `MAIN_THREAD`. `D` is rate-limited (at most 15% of each frame's advance) in *both*
  modes, so `FIXED_PHYSICS` isn't entirely stateless: without that, a single long interval
  would make it jump backwards. A single outlier interval (> 4·`D`) snaps the clock instead of
  inflating `D`; two in a row are adopted as a new cadence (render well below physics rate).
  Mode and timestep changes reset the tracking; the mode reset matters because nothing runs
  while in `NONE`, so the next interval would otherwise cover the whole gap. The per-entity
  `Int32Array(3)` of stamps became one stamp array per world (all entities capture on the
  same snapshots, and a reseeded history holds one pose in all slots). Two bugs the probes
  caught: the stale interval after `NONE`, and the servo comparing its target against the
  *previous* frame's clock (a one-frame bias that made it clamp).
- **Phase 3 — one regression.** `FIXED_PHYSICS` + worker at matched 60/60Hz went from 0.12% to
  ~17% jitter headless (the old code happened to benefit from just-in-time delivery). That
  pairing is unsupported and warned about, so it was left alone.
- **Phase 4.** The worker can't know the main thread's accumulator phase, so a small phase
  lookup keyed by step index remains; the step index itself comes from the producer.
  `getPhysicsSnapshotCount()` was replaced by `getPhysicsSnapshotStepIndex()`. Reads with no
  transform buffer yet now return the pending write instead of zeros (before `MESSAGE_BATCH`'s
  first push). The worker's step counter resets at `CREATE_WORLD` but not at
  `RESTORE_SNAPSHOT` (the main thread's doesn't either).
- **Phase 5.** The reset pose is taken from `TRANSFORM` after `setTransform` updated it. The
  Physics API tab's position editor for physics entities does not go through `setTransform`,
  so moving a body there can still streak once.
- **Phase 6 — `NONE` is not locked.** The expectation "under `NONE` they stay locked" is wrong:
  `object3DSyncSystem` copies TRANSFORM → Object3D at `MAIN`, before physics writes that frame's
  pose, so under `NONE` the mesh shows each new step one render frame late. Measured with the
  raw-pose wireframe: it leads the mesh by 16ms on average (a full step on frames with a new
  step, 0 otherwise). Left as is, per DD12 (`NONE` byte-identical).
- **Phase 6 — added.** A "Wireframe pose (moving bodies)" dropdown under the interpolation
  dropdown in the Physics API tab: *Physics* (raw stepped pose, default) or *Rendered* (the
  mesh's final pose). It's persisted with the other wireframe settings. The wireframe system
  now registers at `APP_RENDER_SYNC_ORDER.POSE_CONSUMERS`.
- **Phase 7.**
  - `physicsToTransformSystem` made 7 allocations per body per frame, not 4. Besides
    `readPoseInto`, the two physics loops iterate `keys()` + `get()`, because the storage's
    own iterator allocates a `[key, value]` array per entry.
  - The FPS limiter also dropped each frame's leftover time (a 30 cap gave ~24 fps on a 60Hz
    loop). It now carries the remainder and is one shared helper instead of two copies.
  - `registerOnSceneExit` keeps a single callback per scene, so the gym's rig cleanup shares
    the dummy character's callback.
  - `LERP` smoothing's `smoothingTime` is now a real time constant (slightly faster than
    before at 60Hz; the gym uses `SMOOTH_DAMP`).
  - What remains in the allocation profile (~20 bytes per body per frame, ~39 KiB/s in
    `smoothDampVec3`) isn't objects the code creates; it looks like V8 boxing number
    temporaries in not-yet-optimized code.

### Open follow-ups

- D9 tearing on `SHARED_MEMORY`: p063.
- `NONE`'s extra frame of lag (syncing the mesh after physics would remove it).
- The Physics API tab's position editor streaking once under interpolation.
- Unchanged non-goals: `FollowTool`'s write-direction lag, smoothing `camera.lookAt`,
  `EXTRAPOLATION`.
