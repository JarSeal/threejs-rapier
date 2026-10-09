Status: draft | study — not-implemented
Category: Architecture, Networking, Physics
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage A)
Blocked by: p602_architecture-and-target-structure.md
Blocks: p606_layering-inversion-and-public-entry.md (soft: the headless-core rules), p605_coding-standards-and-documentation-tooling.md (soft: the simulation rules)
Related: p500_restore-physics-snapshot.md (the prerequisite for prediction and rollback), p603_gameplay-architecture-contracts.md (the network brain), \_DONE_p063_triple-buffered-physics-transform-buffer.md (the worker transport), \_DONE_p352_physics-simulation-tiers.md and \_DONE_p343_deterministic-physics-tier-policy.md (determinism at the step clock), \_DONE_p346_spatial-domains.md (interest management)

# Multiplayer Viability Study

Does a future multiplayer backend fit this engine, what does it cost in structure and
performance, and which rules must the p600 refactoring adopt now so it stays possible?

**The preliminary answer (p600 §7): viable, with a staged path.** An authoritative server with
interpolating clients fits the existing step clock and worker protocol after the structural
stage. Prediction and rollback need deterministic characters and a working physics snapshot
restore. This plan confirms or corrects that with measurements and an optional spike, and turns it
into rules for the refactoring.

---

## 1. Goal

- **A verdict per network model**, with what each needs from the engine and what it costs.
- **The constraints the refactoring adopts now**, written into p600 §3.4, p605's standards and
  p606's headless core, so no structural plan closes the door.
- **Stub plans** for the network work itself, if the verdict is go. Nothing networked is built
  in p600.

## 2. Grounding (checked against the code, 2026-10-09)

- **Step clock:** `stepPhysics` (`core/PhysicsAPI.ts:349`) is a fixed-step accumulator (60 Hz
  default, `maxSubSteps`, overflow dropped with a `simClockEpoch` bump);
  `getPhysicsSubStepIndex()` (`:1167`) is the absolute step index, usable as a network tick.
  `APP_PHYSICS_STEP` runs once per sub-step; `addPhysicsStepGate` makes stepping wait for something.
- **Determinism today:** scene loads reset the physics world and hold stepping until every body
  exists (p101); the tier policy's `STEPS` cadence is deterministic; the probe (`?physicsProbe=N`)
  hashes every dynamic body by its stable `appId`. **Not deterministic:** characters
  (`Math.random` at `DynamicCharacter.ts:1497`, the wall-clock `getPhysGameTime()` at
  `PhysicsAPI.ts:977`, async casts answering a step late in `WORKER_THREAD` mode), and the Rapier
  build (`@dimforge/rapier3d-compat` 0.19.3, not the cross-platform deterministic build).
- **Identity:** entity ids are index + generation per world (`core/ECS.ts:233`). `appId`
  (`CoreEntityOpts`) becomes the `APP_ID` component; without one a UUID is generated.
  `getEntityIdByAppId` (`ECS.ts:889`) scans linearly.
- **State:** `takePhysicsSnapshot` / `restorePhysicsSnapshot` exist (`PhysicsAPI.ts:1420`) but don't
  rebind the cached proxies (p500 repairs it; its non-goals are ECS rewind and character state).
  No ECS serializer. `TypedArrayTransformStore` keeps transforms in flat typed arrays (cheap bulk
  copies).
- **Input:** `CharacterIntent` is device-free and per sub-step; there is no action layer (p603 C5).
- **Headless:** the physics side already is (`EngineRapier.ts` imports only Rapier,
  `physicsWorker.ts` uses no DOM or three). The rest isn't: `Config.ts:304` reads
  `window.location` and `import.meta.env` at load, `PhysicsAPI.ts:10` imports
  `physicsWorker?worker`, `MainLoop.ts` needs `requestAnimationFrame` and a renderer, `InitEngine`
  builds the HUD and imports SCSS, `ECS.ts` imports `three/webgpu`.
- **Protocol:** `PhysicsUpProtocol` / `PhysicsDownProtocol` (`PhysicsAPITypes.ts:2144`, `:2609`)
  are discriminated unions; `STEP` carries the steps and the per-sub-step commands, replies match
  by `requestId`, poses come back through `SHARED_MEMORY` or `MESSAGE_BATCH`. `worker.postMessage`
  is called directly (`PhysicsAPI.ts:826`).
- **Interest management** has a base: spatial domains (`registerSpatialDomain`,
  `core/Spatial/SpatialIndexSystem.ts:325`) give per-domain grids a server could query per client.

## 3. Network models

| Model | How it works | Fits | Needs from the engine |
| --- | --- | --- | --- |
| **Authoritative server + interpolation** | The server simulates; clients send intents per tick and render snapshots interpolated a little in the past | Co-op, MMO-lite, social spaces, slower games | Headless simulation, intents, replicated components, snapshot encoding, interest management |
| **+ client prediction and reconciliation** | The local player is simulated ahead on the client and corrected from the server | Action games, shooters, third-person characters | All of the above, plus deterministic characters, physics snapshot restore (p500) and re-simulation of N steps per correction |
| **Deterministic lockstep** | Every peer simulates; only inputs are exchanged | RTS, physics puzzles | Bit-exact determinism across machines: Rapier's deterministic build, no float differences in our own code, ordered everything |
| **Rollback (GGPO-style)** | Lockstep that predicts remote inputs and rolls back on a mismatch | Fighting games, small-player-count action | Lockstep's determinism plus cheap snapshot and restore every frame |

**Recommendation to confirm:** design for the first two. Lockstep and rollback over Rapier's
deterministic build are possible later, but they constrain every simulation file and cost
simulation speed; they aren't a reason to shape the engine now.

## 4. What the refactoring adopts now

These go into p600 §3.4 (the simulation / presentation split), p605's standards and p606:

1. **Simulation time is the step index.** No `performance.now()`, `Date` or frame delta in
   simulation code; `getPhysGameTime()`'s wall clock is replaced in the character code (p610).
2. **A seeded RNG service** (p603 C7), and a lint rule against `Math.random` in simulation folders.
3. **Intents are the only input to the simulation** (p603 C4, C5): a network brain is a brain.
4. **Replicated identity:** a stable id per networked entity (today's `appId`, required for them)
   with an id → entity map instead of the linear scan.
5. **A transport interface** in front of `postMessage`: `send(message, transfer?)`,
   `onMessage(fn)`, so the physics worker, a WebSocket and a WebTransport channel are three
   implementations of one shape.
6. **A headless-capable core:** no `window`, `document`, `import.meta.env` or Vite `?worker` at
   module load in kernel and simulation modules (p606); the renderer, HUD and styles installed by
   `InitEngine`, not imported by the kernel.
7. **Serializable simulation components:** data, not closures; a component marks itself
   serializable (the save service in p603 C7 and network replication share it).

**Cost:** none in the hot paths. The transport is one indirection per message, the RNG a function
call, the id map a `Map` lookup instead of a scan.

## 5. Phases

### Phase 1: measurements

1. **Rapier's deterministic build** (`@dimforge/rapier3d-deterministic-compat`, the same version):
   bundle size, step time on `largeWorld` and `physicsTiers` against the compat build, and whether
   the probe hash matches across two machines and two browsers.
2. **The physics engine headless in Node:** run `EngineRapier` with a scene's bodies from a script
   (no browser), step it, and compare the probe hash with the browser's.
3. **Snapshot size:** the bytes per step for `physicsTiers`' bodies as positions and rotations
   (quantized and not), as a bandwidth estimate per client.

### Phase 2: the verdict and the rules

Record the verdict per model (§3), confirm §4 with the user, and update p600 §7 and the plans
§4 points at (p605, p606, p610).

### Phase 3: optional spike (decided at Phase 2)

A throwaway branch: a Node server running a scene's simulation headless, two browser clients on a
WebSocket sending character intents and rendering interpolated snapshots. Measured: latency
hidden by interpolation, bandwidth, server step time. Kept as findings in this plan, not merged.

### Phase 4: stub plans and mark done

If the verdict is go: stubs for the network work in the free 51x range, eg.
`p510_headless-simulation-runtime.md`, `p511_network-transport-and-replication.md`,
`p512_client-prediction-and-reconciliation.md` (blocked by p500 and p610). Documents only, no
version bump; mark the plan done.

## 6. Risks and open questions

1. **Cross-platform float determinism** is the hard part of lockstep and rollback, and it depends on
   the browsers' WASM float behaviour as well as Rapier's build. Phase 1 measures; the
   recommendation doesn't depend on it.
2. **The server runtime:** Node with Rapier's compat build works without a DOM; whether the server
   should also run three (for raycasts against render meshes, or animation-driven hitboxes) is open.
   The recommendation is no: the server uses physics colliders only.
3. **Rendering assumptions in simulation code:** some simulation reads `Object3D`s today (the
   frustum and LOD systems are presentation, but the character reads the main camera for
   `CAMERA_RELATIVE`). p610 moves camera-relative input into the player brain, which runs on the
   client.
