Status: draft | not-implemented
Category: Physics
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Triple-Buffered Physics Transform Buffer — Plan

## Context

Follow-up to [\_DONE_p059_interpolation-optimization-and-fixes.md](./_DONE_p059_interpolation-optimization-and-fixes.md),
whose Phase 8 ("double-banked buffer, D9") was split out into this plan. p059 fixed render
interpolation without it; this plan fixes the one defect it left open.

**D9 — `SHARED_MEMORY` reads tear.** `PhysicsTransformBuffer` is a single bank. The worker's
`writeBackTransforms` (`physicsWorker.ts`) rewrites every slot in place and then calls
`markWritten(stepIndex)`, while the main thread reads the same `SharedArrayBuffer` concurrently
and at any point in its frame. Nothing stops the worker from writing between two main-thread
reads, so:

1. **Stamp vs. poses.** `readPhysicsSnapshotStamp()` can read step index N while the poses read
   right after it already belong to N+1. p059's probe measured the result: on `SHARED_MEMORY`
   roughly one run in three showed an isolated interpolation spike (2.4% velocity jitter, one
   frame 21% off, against the usual 0.31%), which never appeared on `MESSAGE_BATCH`. p059
   Phase 4's temporary stamp self-check also flagged 1-2 such mid-read writes per ~1400 reads.
2. **Across systems in one frame.** `physicsToTransformSystem` (`APP_POST_PHYSICS`),
   `APP_PHYSICS_STEP` gameplay code (e.g. `dynamicCharacter.ts` reading `rb.pos`/`lvel`),
   `physicsInterpolationSystem` and the debug wireframe (`APP_RENDER_SYNC`) can each see a
   different snapshot within the same frame — TRANSFORM and the rendered pose can disagree.
3. **Across bodies in one pass.** One loop over all bodies can read some from N and some from
   N+1.
4. **Within one body.** A 13-float record can be half old, half new (position from N, rotation
   from N+1).

`MESSAGE_BATCH` doesn't have the problem: each push is a private copy delivered by `onmessage`,
which never runs in the middle of a frame (the frame is one task).

Every case needs the same fix: **the main thread latches one complete, immutable snapshot at the
start of each frame and reads only that for the whole frame.**

### Correction to p059's expectation

p059 said double-banking would also "yield `prev`/`curr` for free". It doesn't need to, and with
the design below it doesn't. p059 Phase 3 gave render interpolation its own per-entity pose
history on the main thread, which is what it needs anyway: it keeps three poses and survives
dropped or bunched snapshots. The buffer only has to provide one consistent *current* snapshot.

## Design decisions

1. **Triple buffering, not double.** With two banks and a lock-free writer, the worker can *lap*
   the reader: it publishes bank B while the main thread is reading A, then, still inside the
   same main-thread frame, starts its next write-back into A. That happens whenever the main
   thread's frame outlasts two worker write-backs: a slow frame, a GC pause, a hitch, or several
   STEP messages queued behind one another. A third bank gives the standard lock-free
   triple buffer. The writer owns a *back* bank, the reader owns a *front* bank, and a shared
   *middle* bank is swapped atomically, so neither side ever waits or tears. Memory cost: 3 ×
   `maxBodies` × 13 × 4 B ≈ 320 KiB at the default 2048 bodies.

2. **One atomic control word.** A single `Int32` holds the middle bank's index plus a "fresh"
   bit. Worker, after writing its back bank and stamping it: `back = Atomics.exchange(control,
   0, back | FRESH) & INDEX_MASK`. Main thread, when latching: if the fresh bit is set,
   `front = Atomics.exchange(control, 0, front) & INDEX_MASK`, otherwise keep the current front.
   That's the whole protocol: no locks, no retry loops, and neither side can observe a bank the
   other is writing.

3. **Per-bank header.** Each bank carries its own `[writeCount, stepIndex]` header (the
   `PHYSICS_TRANSFORM_HEADER_INTS` pair from p059 Phase 4), written *before* the publishing
   exchange. The stamp is then part of the snapshot it describes, which fixes case 1 by
   construction. `getStepIndex()` and pending-write visibility (`isWritePending`) read the
   latched front bank, like every other read.

4. **Latch once, at the very start of the frame.** A new `latchPhysicsSnapshot()` in
   `PhysicsAPI.ts` is called by every `MainLoop.ts` loop variant (`mainLoopForDebug`,
   `mainLoopForProduction`, `mainLoopForProductionWithFPSLimiter`) right after `timer.update()`.
   That's before `MAIN`, before held-key polling and `APP_PHYSICS_STEP`, and before any event
   callback of that frame, so every reader in the frame sees the same snapshot (cases 2-4).
   A write-back that lands mid-frame waits for the next frame; see Risks.

5. **Banks only where they're needed.** `PhysicsTransformBuffer` gets a bank count: 3 for
   `SHARED_MEMORY`, 1 for `MESSAGE_BATCH` (already consistent, and a push copies the whole
   buffer, so three banks would triple that copy for nothing). With 1 bank, `latch` is a no-op
   and the layout is exactly today's. Slot allocation (`allocateSlot`/`freeSlot`, worker-side)
   stays per slot index and is the same in every bank.

6. **Reader API unchanged.** All main-thread reads already go through the module-level
   `transformBuffer` (the `RigidBodyProxyAPI` getters, `readPoseInto`, `getStepIndex`). They
   switch from "the one bank" to "the latched front bank" inside `PhysicsTransformBuffer`, via
   a base offset set at latch time. No call site outside the buffer and the worker's write-back
   changes.

## Phases

**Phase 1 — Bank-aware buffer, single bank everywhere (behaviour-neutral).**
Give `PhysicsTransformBuffer` a bank count, per-bank headers, a front-bank base offset, and the
write-side (`beginWrite()`/`publish(stepIndex)`) and read-side (`latch()`) API. Construct it with
1 bank in both transports and route the worker's `writeBackTransforms` and every reader through
the new API. Remove the now-unused `getWriteCount()` reader (it has had no caller since p059
Phase 4), or keep it bank-aware if the debug tab turns out to want it.
*Verify:* p059's headless probes (method in its implementation notes: the smoothness matrix,
teleport + two worlds, world recreation) give the same numbers as at the end of p059. `SHARED_MEMORY` still
shows its occasional spike, because nothing has changed yet.

**Phase 2 — Triple buffering on `SHARED_MEMORY`.**
Create the buffer with 3 banks plus the control word at `CREATE_WORLD` when the SAB transport
resolves. The worker writes into its back bank and publishes by exchange (DD2). Add
`latchPhysicsSnapshot()` and call it from all three loop variants (DD4). The main-thread wrapper
built from `CreateWorldResponse.buffer` learns the bank count from the response, not from an
assumption, so both sides agree on the layout.
*Verify:* see Verification. Confirm SAB still allocates when cross-origin isolated, and that
`MESSAGE_BATCH` is byte-for-byte unchanged.

**Phase 3 — Docs.**
Update the `PhysicsTransformBuffer` class doc, the Physics section of `.claude/CLAUDE.md` (the
hot-path buffer description), and the D9 entries of p059's done notes (so they point here).

## Non-goals

- Tearing in the *debug-state* buffer (`PhysicsDebugStateBuffer`, wireframe colour states) and
  the *step-stats* buffer (`PhysicsStepStatsBuffer`). Both are SAB-backed and can tear the same
  way, but they're debug-only, per-field, and self-correct on the next write. Same fix
  available later if they ever matter.
- Reducing `MESSAGE_BATCH`'s per-step buffer copy (transfer-and-return ping-pong). That's a
  protocol change with its own tradeoffs.
- Any change to render interpolation itself: it gets consistent input and nothing else.

## Risks / open questions

| Risk / question | Notes |
| --- | --- |
| Up to one extra frame of latency on `SHARED_MEMORY` | Today a write-back that lands mid-frame can already be read later in the same frame. After the latch it waits for the next frame. `RENDERER` absorbs this as steady-state lag, like the rest of the worker latency. The debug tab's lag readout should show roughly +½ frame on average. This is what consistency costs; measure it and set expectations, don't avoid it. |
| Slot reuse after a body is deleted | A reused slot in a bank latched before the new body's first write-back still holds the *deleted* body's pose. This exists today (single bank, until the next write-back) and triple buffering can stretch it by up to a frame. If it shows up, the fix belongs with body creation (treat creation-time `translation`/`rotation` as a pending write visible from the creation step), not with the buffer. |
| The writer can publish several snapshots between two latches | Fine. The middle bank always holds the newest one and older ones are dropped, which is exactly what `RENDERER`'s bunched-write-back handling (p059 Phase 3) expects. |
| Latch placement | It must precede *every* reader in the frame, including `APP_PHYSICS_STEP` callbacks that run inside `stepPhysics`. Latching at frame start guarantees that. A later latch point would reintroduce case 2. |
| Worker must not write before its bank indices exist | The control word and banks are created at `CREATE_WORLD` before the response, and no STEP is posted before that response resolves (`physicsWorldEnabled` gates `stepPhysics`). |

## Verification

- `tsc --noEmit` and `yarn lint` clean after every phase.
- **The tearing test (the one that matters).** Run p059's smoothness probe (method in its
  implementation notes) on `SHARED_MEMORY` at 25Hz physics 20 times. Before this plan, about one run in three shows a spike (max velocity error
  well above 1%). After, zero runs may, and jitter must stay at p059's ~0.31%. Re-add p059
  Phase 4's temporary stamp self-check: its "raced" count must be exactly 0.
- **Lapping stress test (the case double buffering gets wrong).** 2000 bodies with the main
  thread artificially slowed (a 40ms busy-wait in a `MAIN` system, so the worker completes
  several write-backs per main frame). For every frame, assert that the pose each body shows
  equals its pose in the stamped snapshot, e.g. by writing each body's own step index into an
  otherwise unused field of its record under a debug flag and checking it matches the bank
  stamp for every body.
- **Cross-system agreement.** In one frame, the pose `physicsToTransformSystem` wrote into
  TRANSFORM equals the newest pose `physicsInterpolationSystem` captured, for every body
  (a probe system at `APP_RENDER_SYNC` compares them).
- **No regressions.** The rest of p059's probes: teleport streaks 0, two worlds
  interpolate independently, D10 world recreation, `MESSAGE_BATCH` unchanged, allocation profile
  not worse.
