Status: implemented
Category: Physics
Blocked by: p022_physics-debugger-tab.md
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Interpolation in the Physics API — Plan

## Context

The legacy `PhysicsRapier.ts` already has working interpolation: a fixed-timestep
accumulator (`baseStepper`, ~line 1568) advances the Rapier world in discrete steps
independent of render framerate, snapshotting per-body `prevTransforms`/`currTransforms`
before each `world.step()`, and `renderPhysicsObjects()` (~line 1821) lerp/slerps between
them at render time using `alpha = accDelta / timestepRatio`, gated by a boolean
`interpolationEnabled` Tweakpane toggle.

The new engine-agnostic Physics API (`PhysicsAPI.ts` / `EngineRapier.ts` /
`PhysicsManager.ts` / `workers/physicsWorker.ts`) has none of this. `stepPhysics()`
calls `world.step()` exactly once per render frame, using a fixed `timestep` value
that is never scaled against the real elapsed frame time — so today, if framerate
drifts from the configured physics Hz, simulated motion silently speeds up or slows
down with it. `PhysicsTransformBuffer.ts` is single-buffered (7 floats/body: position +
quaternion only — `PHYSICS_TRANSFORM_FIELD_COUNT`), and `PhysicsManager.ts`'s
`physicsToTransformSystem` (`APP_POST_PHYSICS`) does a hard snap into the ECS
`TRANSFORM` component every frame. A `interpolationEnabled` field already exists on
`PhysicsState`/`AppConfig.physics` (`Config.ts`, `PhysicsAPI.ts`, `EngineRapier.ts`) but
is dead scaffolding — it is never read. `p022` (this plan's blocker) only plans to
surface that field in a debug tab as-is; it implements no behavior for it.

This plan replaces that dead boolean with a real `interpolationMode` enum backed by
actual physics-timing infrastructure, covering four modes: no interpolation (today's
behavior), renderer interpolation, fixed-physics interpolation, and (feasibility-gated)
lead-edge extrapolation.

## Design decisions

1. **Replace the boolean with an enum.** `interpolationEnabled?: boolean` becomes
   `interpolationMode?: PhysicsInterpolationMode` (`'NONE' | 'RENDERER' | 'FIXED_PHYSICS' | 'EXTRAPOLATION'`)
   across `PhysicsAPITypes.ts`'s `PhysicsState` and `Config.ts`'s `AppConfig.physics`.
   Default `'NONE'` — matches current actual behavior exactly, so this is a
   non-breaking default. `p022`'s debug-tab plan will need its field-shape note
   updated from boolean to enum once this lands (coordinate, don't duplicate).

2. **Phase 1 prerequisite: a real fixed-timestep accumulator, decoupled from render dt.**
   Mirror legacy's `baseStepper` pattern, adapted to the new API/worker split: accumulate
   the actual elapsed frame `dt` and run `world.step()` 0–N times per render frame,
   bounded by `minSubSteps`/`maxSubSteps` (these already exist as defaults inside
   `PhysicsAPI.ts`'s internal `physicsState` object — promote them into the
   `AppConfig.physics` type properly). Double-buffer `PhysicsTransformBuffer` (prev +
   curr, 7→14 floats/body) so a leftover `alpha = accDelta / timestep` is always
   available. Required regardless of how Design Decision 3 resolves — both readings of
   "renderer" vs. "fixed physics" interpolation need decoupled stepping to be
   meaningfully different from a plain snap.

3. **Open question, deliberately unresolved here — settle at Phase 2 kickoff.** What
   distinguishes "Renderer interpolation" from "Fixed physics interpolation" is not yet
   decided. Two candidate readings to choose between when Phase 2 starts:

   - (a) _Decoupled-from-physics-rate reading_: "Renderer interpolation" smooths
     between the last two received transform snapshots regardless of physics cadence
     (useful when the worker updates less often than render — lower physics Hz, or a
     stalled worker frame); "Fixed physics interpolation" is the classic accumulator
     pattern where physics runs at a fixed Hz and render interpolates using the
     accumulator's leftover alpha between two known fixed states (this is what legacy
     already does).
   - (b) _Same mechanism, different owner reading_: "Renderer interpolation" = the
     lerp/slerp logic lives in the render/`APP_RENDER_SYNC` stage and can run even
     without full accumulator decoupling (cheaper, approximate); "Fixed physics
     interpolation" = the same math but driven strictly off the physics-owned
     accumulator state from Design Decision 2.
     Do not implement either mode's specifics until this is picked with the user.

4. **Interpolated/extrapolated pose never overwrites the authoritative ECS `TRANSFORM`.**
   `physicsToTransformSystem` keeps writing the latest discrete physics-step transform
   as ground truth for gameplay/logic systems (collision queries, AI, etc.).
   Interpolation output is a render-only overlay: a new pass — either a dedicated ECS
   stage or a hook late in `APP_RENDER_SYNC` — computes the blended pose per
   physics-driven entity and writes it only into the Object3D's render-facing world
   transform. Reuse scratch `Vector3`/`Quaternion` objects; no per-frame allocation,
   consistent with `PhysicsTransformBuffer`'s existing zero-alloc hot path.

5. **Mode behaviors:**
   - `NONE`: unchanged current behavior (default).
   - `RENDERER`: cheapest smoothing; exact semantics per Design Decision 3.
   - `FIXED_PHYSICS`: accumulator-alpha lerp/slerp between the Phase 1 double-buffered
     prev/curr states, equivalent in spirit to legacy's `renderPhysicsObjects()`.
   - `EXTRAPOLATION` ("Lead-Edge"): forward-predicts pose using `pos + linVel * dt` and
     quaternion integration from `angVel * dt`; gated entirely behind the Phase 4
     feasibility study below.

## Phases

**Phase 1 — Fixed-timestep accumulator + double-buffered transforms (prerequisite, no
interpolation behavior yet).**
Add a real accumulator to the new API's step call (`PhysicsAPI.ts`'s `stepPhysics()` or
its caller in `MainLoop.ts`), fed by actual frame `dt`, bounded by `minSubSteps`/
`maxSubSteps` (promote these + `minDeltaTime`/`maxDeltaTime` from `PhysicsAPI.ts`'s
internal defaults into the `AppConfig.physics` type). Double-buffer
`PhysicsTransformBuffer` (prev + curr, 14 floats/body) — update
`PHYSICS_TRANSFORM_FIELD_COUNT`-dependent code in `physicsWorker.ts`, `EngineRapier.ts`,
`PhysicsManager.ts`. `physicsToTransformSystem` keeps consuming only "curr", unchanged.
Manual verification: throttle CPU/framerate (e.g. Chrome DevTools) and confirm physics
motion speed no longer drifts with framerate, unlike today's 1:1-step behavior; `tsc`/
lint clean.

**Phase 2 — `RENDERER` and `FIXED_PHYSICS` modes.**
Resolve Design Decision 3 with the user before writing mode-specific logic. Add the
`PhysicsInterpolationMode` enum and wire `AppConfig.physics.interpolationMode` through
`PhysicsAPITypes.ts`, `PhysicsAPI.ts`, `EngineRapier.ts`, `Config.ts`, replacing the dead
`interpolationEnabled` field. Add the render-facing blend pass (Design Decision 4).
Manual verification: visually compare a fast-moving body's smoothness under `NONE` vs.
`RENDERER` vs. `FIXED_PHYSICS`, at both native and throttled framerates; confirm
gameplay code reading ECS `TRANSFORM` still sees only the discrete, non-interpolated
pose.

**Phase 3 — Debugger tab wiring.**
Update `p022`'s planned `_dbg__PhysicsAPI.ts` field from a boolean to a list/enum
control bound to `interpolationMode`.
Manual verification: toggle each mode live from the debugger tab; visual result matches
Phase 2's manual checks.

**Phase 4 — Lead-Edge extrapolation: feasibility study, then implementation if viable.**
Study first, implement only if the study doesn't surface a blocker:

- Buffer layout growth (7→13 floats/body) and its effect on SAB byte size
  (`maxBodies * 13 * 4` bytes at the default `maxBodies: 2048`) and on `MESSAGE_BATCH`
  fallback payload size.
- Whether Rapier's `RigidBodyAPI` already exposes cheap linear/angular velocity reads,
  or a new getter/worker message is needed.
- Visibility of misprediction "pop" corrections under realistic gameplay (fast direction
  changes, collisions).
  If viable: implement `EXTRAPOLATION` per Design Decision 5. If not: record why in the
  Risks table below and treat it as a non-goal instead.
  Manual verification (if implemented): compare `FIXED_PHYSICS` vs. `EXTRAPOLATION`
  responsiveness on a fast-moving/rotating body; specifically look for pop artifacts
  around collisions.

## Non-goals

- Touching the legacy `PhysicsRapier.ts` interpolation implementation — it already
  works and is out of scope.
- Per-scene interpolation settings — the new `PhysicsState` is global, matching `p022`'s
  precedent.
- Networked/rollback-style prediction — extrapolation here is local single-player render
  smoothing only, not netcode.

## Risks / open questions

| Risk / question                                                                                   | Notes                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Exact distinction between "Renderer interpolation" and "Fixed physics interpolation" is undecided | Deliberately left open per the user; resolve at Phase 2 kickoff (Design Decision 3). Both readings need Phase 1's accumulator regardless. |
| Accumulator work is a bigger change than a debugger toggle                                        | Confirmed with the user to keep in-scope as this plan's Phase 1 rather than splitting into a separate blocking plan.                      |
| Double-buffering doubles `PhysicsTransformBuffer` size (7→14 floats/body)                         | Modest fixed allocation at default `maxBodies: 2048` (~114KB); confirm SAB allocation still succeeds cross-origin-isolated.               |
| Extrapolation buffer growth (7→13 floats/body) affects SAB size and `MESSAGE_BATCH` bandwidth     | Gated behind Phase 4's feasibility study; not committed to implementation.                                                                |
| Misprediction "pop" correction under extrapolation                                                | User's own hedge ("if possible and feasible") — studied in Phase 4 before any implementation commitment.                                  |
| `p022` currently plans to expose `interpolationEnabled` as a boolean                              | Update that plan's field-shape note to the new enum once this plan's Phase 2 lands.                                                       |

## Verification

- `tsc --noEmit` and `yarn lint` clean after every phase (per the repo's Stop hook).
- Phase 1: frame-rate-throttled manual check confirming physics speed is now
  framerate-independent.
- Phase 2: visual smoothness comparison across all three non-extrapolation modes;
  confirm ECS `TRANSFORM` stays un-interpolated for gameplay systems.
- Phase 3: debugger-tab live-toggle walkthrough.
- Phase 4: feasibility write-up, then (if implemented) a pop-correction visual check.
