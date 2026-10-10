Status: implemented (Phases 1-2 and 4; Phase 3 dropped)
Category: Architecture, Networking, Physics
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage A)
Blocks: p606_layering-inversion-and-public-entry.md (soft: the headless-core rules), \_DONE_p605_coding-standards-and-documentation-tooling.md (soft: the simulation rules)
Related: p500_restore-physics-snapshot.md (the prerequisite for prediction and rollback), \_DONE_p603_gameplay-architecture-contracts.md (the network brain), \_DONE_p063_triple-buffered-physics-transform-buffer.md (the worker transport), \_DONE_p352_physics-simulation-tiers.md and \_DONE_p343_deterministic-physics-tier-policy.md (determinism at the step clock), \_DONE_p346_spatial-domains.md (interest management)

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

- **Step clock:** `stepPhysics` (`core/PhysicsAPI.ts:355`) is a fixed-step accumulator (60 Hz
  default, `maxSubSteps`, overflow dropped with a `simClockEpoch` bump);
  `getPhysicsSubStepIndex()` (`:1184`) is the absolute step index, usable as a network tick.
  `APP_PHYSICS_STEP` runs once per sub-step; `addPhysicsStepGate` makes stepping wait for something.
- **Determinism today:** scene loads reset the physics world and hold stepping until every body
  exists (p101); the tier policy's `STEPS` cadence is deterministic; the probe (`?physicsProbe=N`)
  hashes every dynamic body by its stable `appId`. **Not deterministic:** characters
  (`Math.random` at `DynamicCharacter.ts:1497`, the wall-clock `getPhysGameTime()` at
  `PhysicsAPI.ts:987`, async casts answering a step late in `WORKER_THREAD` mode), and
  `MutualGravity` in the worker targets (it reads the last synced poses, p601). The Rapier build
  is `@dimforge/rapier3d-compat` 0.19.3, not the one Rapier guarantees deterministic across
  platforms; in Phase 1 it reproduced across browsers and machines all the same.
- **Identity:** entity ids are index + generation per world (`core/ECS.ts:233`). `appId`
  (`CoreEntityOpts`) becomes the `APP_ID` component; without one a UUID is generated.
  `getEntityIdByAppId` (`ECS.ts:894`) scans linearly.
- **State:** `takePhysicsSnapshot` / `restorePhysicsSnapshot` exist (`PhysicsAPI.ts:1428`) but don't
  rebind the cached proxies (p500 repairs it; its non-goals are ECS rewind and character state).
  No ECS serializer. `TypedArrayTransformStore` keeps transforms in flat typed arrays (cheap bulk
  copies).
- **Input:** `CharacterIntent` is device-free and per sub-step; there is no action layer (p603 C5).
- **Headless:** the physics side already is (`EngineRapier.ts` imports only Rapier,
  `physicsWorker.ts` uses no DOM or three; Phase 1 ran it in Node), though only because esbuild
  drops three type-only imports of `LoopState` from `MainLoop` written without `import type`
  (`EngineRapier.ts:39`, `physicsWorker.ts:3`, `PhysicsAPITypes.ts:2`). The rest isn't: `Config.ts:304` reads
  `window.location` and `import.meta.env` at load, `PhysicsAPI.ts:10` imports
  `physicsWorker?worker`, `MainLoop.ts` needs `requestAnimationFrame` and a renderer, `InitEngine`
  builds the HUD and imports SCSS, `ECS.ts` imports `three/webgpu`.
- **Protocol:** `PhysicsUpProtocol` / `PhysicsDownProtocol` (`PhysicsAPITypes.ts:2144`, `:2609`)
  are discriminated unions; `STEP` carries the steps and the per-sub-step commands, replies match
  by `requestId`, poses come back through `SHARED_MEMORY` or `MESSAGE_BATCH`. `worker.postMessage`
  is called directly (`PhysicsAPI.ts:842`).
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

### 3.1 Verdict (Phase 2, from Phase 1's measurements)

**Design for the first two models; lockstep and rollback stay possible and cost less than this
plan assumed.**

1. **Authoritative server + interpolation: go, after the structural stage.**
   - The physics half already runs headless: the engine's worker code ran in Node unchanged and
     reproduced the browser bit for bit (Phase 1.2). Its protocol carried the whole simulation
     as plain, structured-clone-safe data (2,580 messages, no class instance among them).
   - The gameplay half doesn't yet: the `APP_PHYSICS_STEP` systems (the tier policy, the
     plough, characters) live in the main thread's ECS, which needs the headless core (§4.6,
     p606, p608) before a server can run it.
   - Server cost: `physicsTiers` steps in 0.29 ms on average in Node (687 bodies, 1,200
     steps), so one core runs many such worlds at 60 Hz.
   - Bandwidth: 45 kbit/s mean, 62 kbit/s p95 per client for 687 bodies (only the changed
     bodies, quantized to 12 B, at 20 Hz), and an 8 kB join. Full snapshots (4-18 Mbit/s at
     60 Hz) are not an option: replication rides on the simulation tiers and on interest
     management (spatial domains).
   - Needs: the headless core, the transport interface, replicated identity, serializable
     components, snapshot encoding and interest management. None costs anything in the hot paths.
2. **+ client prediction and reconciliation: go, staged.**
   - Blocked by p500 (restore that rebinds the proxies) and p610 (deterministic characters,
     the input action layer).
   - Rapier snapshots are cheap to take and restore: 0.25 / 0.54 ms with 256 awake bodies,
     3.0 / 4.0 ms with 4,000 (Node, mid-collapse, 0.4-7.4 MB).
   - Re-simulation is the cost, and Rapier only re-simulates the whole world: one step with
     4,000 awake bodies is ~12 ms, so 6-10 steps per correction only fit a small active world.
     Predict the local character with a kinematic controller against the world (p421) and
     correct it alone; whole-world rewind is for small worlds and for rollback.
3. **Deterministic lockstep: possible later; not a reason to shape the engine now.**
   - Rapier's compat build (the one we ship) reproduced bit for bit across Chromium, Firefox,
     Node and an Android phone, on x86-64 and ARM (Phase 1.1). The deterministic build did too,
     costs 0-9 % in step time and +12 kB gzip, and gives different results from compat. Rapier
     only guarantees cross-platform determinism for the deterministic build, so a lockstep game
     switches to it then, at that measured cost.
   - The blockers are ours: non-deterministic characters (§2), JS `Math` functions in simulation
     code (not specified to be exact across engines; matching here was luck, not a guarantee),
     every peer on the same code and Rapier build, and iOS / Safari untested.
   - §4's rules are most of what lockstep needs anyway; the rest (a fixed-point or
     engine-independent `Math` for simulation code, input ordering) waits for a game that needs it.
4. **Rollback (GGPO-style): possible later, for small worlds.** Lockstep's needs, plus a
   snapshot and N-step re-simulation per misprediction. Snapshots fit a frame (above);
   re-simulation does only with a small active world (a fighting game, a few players).

## 4. What the refactoring adopts now (confirmed at Phase 2)

These go into p600 §3.4 (the simulation / presentation split), p605's standards, p606 and p610:

1. **Simulation time is the step index.** No `performance.now()`, `Date` or frame delta in
   simulation code; `getPhysGameTime()`'s wall clock is replaced in the character code (p610).
2. **A seeded RNG service** (p603 C7), and a lint rule against `Math.random` in simulation folders.
3. **Intents are the only input to the simulation** (p603 C4, C5): a network brain is a brain.
4. **Replicated identity:** a stable id per networked entity (today's `appId`, required for them)
   with an id → entity map instead of the linear scan.
5. **A transport interface** in front of `postMessage`: `send(message, transfer?)`,
   `onMessage(fn)`, so the physics worker, a WebSocket and a WebTransport channel are three
   implementations of one shape. Protocol messages stay plain data (no class instances, no
   functions): all 2,580 messages of Phase 1's recording were, which is what let a recording, a
   replay in Node and a network carry them.
6. **A headless-capable core:** no `window`, `document`, `import.meta.env` or Vite `?worker` at
   module load in kernel and simulation modules (p606); the renderer, HUD and styles installed by
   `InitEngine`, not imported by the kernel. Type-only imports across the simulation boundary are
   written `import type` and a lint rule keeps them so (`consistent-type-imports`, or
   `verbatimModuleSyntax`): today the worker stays free of three only because esbuild drops three
   such imports (§2). A server's stand-in for the worker global is the real global object
   (Rapier's WASM reads `performance` through `self`).
7. **Serializable simulation components:** data, not closures; a component marks itself
   serializable (the save service in p603 C7 and network replication share it).
8. **The simulation reads its own state at the step,** never the presentation's: not the synced
   `TRANSFORM`s, interpolated poses or `Object3D`s, which lag a frame behind the worker. Physics
   state is read through step-stamped reads (the tier policy's `readBodyPositionsAtStep`).
   `MutualGravity` breaks this today, which is why `space` isn't deterministic in the worker
   targets (p601).
9. **One Rapier build for every peer.** The compat and the deterministic build give different
   results (Phase 1), so the build is part of the simulation's version: a switch is deliberate and
   changes every stored probe hash once. We stay on the compat build until a lockstep or rollback
   game needs the deterministic one (§3.1).

**Cost:** none in the hot paths. The transport is one indirection per message, the RNG a function
call, the id map a `Map` lookup instead of a scan, `import type` nothing at runtime.

## 5. Phases

### Phase 1: measurements — done

1. **Rapier's deterministic build** (`@dimforge/rapier3d-deterministic-compat`, the same version):
   bundle size, step time on `largeWorld` and `physicsTiers` against the compat build, and whether
   the probe hash matches across two machines and two browsers.
2. **The physics engine headless in Node:** run `EngineRapier` with a scene's bodies from a script
   (no browser), step it, and compare the probe hash with the browser's.
3. **Snapshot size:** the bytes per step for `physicsTiers`' bodies as positions and rotations
   (quantized and not), as a bandwidth estimate per client.

As built (2026-10-09):

- **Method: record and replay.** The worker is a pure function of its message stream
  (`EngineRapier.step()` reads no clock and no random), so one recording drives every comparison.
  A Playwright page (an init script, no engine change) loads `physicsTiers` in the `workerMsg`
  configuration with the test clock and the probe, wraps `Worker.prototype.postMessage`, records
  every message to the physics worker and a hash of every `TRANSFORMS_PUSH`, and after the probe's
  freeze asks the worker for a Rapier snapshot. Node bundles `workers/physicsWorker.ts` with
  esbuild (optionally aliased to the deterministic build) and feeds it the recording. Compared:
  every step's transform push (poses and velocities of every slotted body) and the snapshot's bytes
  (the whole world: sleeping, contacts, islands). That's a stronger check than the probe hash, which
  matched wherever these did. The tooling is throwaway, in the gitignored `.cache/p604/`.
- **`largeWorld` has no physics bodies** (its props are render-only, and `scenes.config.ts` says
  so), so the step time was measured on `physicsTiers` (686 crates, a kinematic plough, tier
  changes) and on synthetic box stacks in plain Rapier (256, 1,568 and 4,000 bodies, 600-1,200
  steps).
- **1.2, headless in Node:** the engine's own worker code runs in Node unchanged. Its bundle has 15
  inputs and no three, `MainLoop`, `Config` or `PhysicsAPI`. A replay of a 1,200-step recording
  matches the browser **bit for bit at every step**, and the 153 KB snapshots are byte-identical.
  Two findings for §4.6:
  - The worker is DOM-free only through elided type imports: `EngineRapier.ts:39`,
    `physicsWorker.ts:3` and `PhysicsAPITypes.ts:2` import the type `LoopState` from `MainLoop`
    without `import type`. `isolatedModules` without `verbatimModuleSyntax` lets esbuild drop
    them; one value import would pull `MainLoop`, three and the renderer into the worker.
  - Rapier's WASM reads `performance.now()` from `self` (wasm-bindgen looks up the global object
    through `self` first). A server's stand-in for the worker global must be the real global
    object: a plain object panics the WASM (`unreachable`) on the first step.
- **1.1, the deterministic build:**
  - Size: 846 kB gzip against compat's 834 kB, minified (+12 kB, +1.4 %; WASM 1.60 against
    1.57 MB). Both builds inline their WASM as base64, so that isn't a difference. Rapier ships
    twice today (the main chunk and the worker, p600 §2.4): +24 kB gzip until p607 drops the
    main-chunk copy.
  - Step time, pure `step()`, Node on x86-64, median of 5 or 3 runs: `physicsTiers`, 1,200 steps,
    each build replaying its own recording: compat 349 ms, deterministic 338 ms (no measurable
    cost). Box stacks: +2 to +9 % (4,000 bodies: 11.1 against 11.8 s over 600 steps). A first
    +45 % on `physicsTiers` was an artifact: the deterministic build replaying compat's stream
    drifts from step 55 and simulates another world.
  - **Same machine, two browsers:** Chromium 153 and Firefox 155 (x86-64 Linux) give identical
    message streams, pushes and snapshots with **either** build.
  - **Two machines:** an Android phone (Chrome 154, LAN, `yarn dev:https`-style server) gives
    identical message streams, pushes and snapshots to the desktop with **either** build (compat
    `0fbdd103`, deterministic `80c06412` at 1,200 steps), and Node replays its recordings bit for
    bit. The main thread's own JavaScript (the plough's path, the tier policy's decisions) came out
    identical too.
  - The two builds don't agree with each other: on `physicsTiers` they part at step 55 (the box
    stacks stayed identical). Every peer must run the same build, and switching builds changes
    every stored probe hash once.
  - What this covers: boxes, a kinematic ball, tier changes (fixed, disabled, removed and back),
    1,200 steps, three JS engines on two CPU architectures. Not covered: characters (not
    deterministic, §2), joints, trimesh and convex colliders, CCD, scene queries feeding the
    simulation, iOS / Safari, and other x86 or ARM machines. JS `Math` functions aren't specified to
    be exact across engines; this scene's main-thread inputs happened to match.
- **1.3, snapshot size** (`physicsTiers`, 1,200 steps, 687 bodies; payload only, a 6 B packet
  header included, the transport's ~50 B not):

  | Encoding (per body) | Rate | Bodies per packet | Payload, mean / p95 |
  | --- | --- | --- | --- |
  | Full, raw pose (30 B) | 60 Hz | 687 | 9.9 / 9.9 Mbit/s |
  | Full, raw pose + velocities (54 B) | 60 Hz | 687 | 17.8 / 17.8 Mbit/s |
  | Full, quantized (12 B: 16-bit position at 1/64 m, smallest-three rotation in 32 bits) | 60 Hz | 687 | 4.0 / 4.0 Mbit/s |
  | Changed only, quantized 12 B | 60 Hz | 21 | 125 / 176 kbit/s |
  | Changed only, quantized 12 B | 20 Hz | 23 | 45 / 62 kbit/s |
  | Changed only, quantized 17 B (1 mm in ±8 km, 15-bit rotation) | 20 Hz | 23 | 63 / 88 kbit/s |
  | Changed only, raw + velocities (54 B) | 20 Hz | 23 | 199 / 277 kbit/s |

  A client joining gets the full state once (8 kB quantized). Only ~3 % of the bodies change per
  step here, because the tier policy freezes and removes the far ones: replication rides on the
  same tiers and on interest management, never on full snapshots.

### Phase 2: the verdict and the rules — done

Record the verdict per model (§3), confirm §4 with the user, and update p600 §7 and the plans
§4 points at (p605, p606, p610).

As built (2026-10-09):

- The verdict is §3.1. Snapshot take and restore cost (plain Rapier in Node, box stacks 60 steps
  into their collapse) was measured for it: 256 bodies 0.25 / 0.54 ms (444 kB), 1,568 bodies
  0.89 / 1.33 ms (2.9 MB), 4,000 bodies 3.0 / 4.0 ms (7.4 MB); one step after a restore 0.8, 4.5
  and 11.7 ms.
- §4 confirmed with two amendments (5: protocol messages stay plain data; 6: `import type` across
  the simulation boundary, the real global object on a server) and two new rules (8: the
  simulation reads its own state at the step; 9: one Rapier build for every peer, the compat build
  for now). §2's line references are updated to the code.
- Decided: Rapier stays on the compat build (no package change); a cross-browser determinism run
  (`yarn verify:scenes --browser firefox`) goes into p605's tooling.
- Updated: p600 §2.6 (line references, the Rapier blocker), §3.4 (rule 8), §7 (the verdict), the
  roadmap row and risk 6; p605 (the simulation lint rules, the Firefox run, done criteria); p606
  (the headless boundary by construction); p610 (rule 8 and the unstable-hash aim for the gym).

### Phase 3: optional spike (decided at Phase 2) — dropped

A throwaway branch: a Node server running a scene's simulation headless, two browser clients on a
WebSocket sending character intents and rendering interpolated snapshots. Measured: latency
hidden by interpolation, bandwidth, server step time. Kept as findings in this plan, not merged.

Dropped at Phase 2: Phase 1 measured the server's step time and the bandwidth, and ran the physics
headless. What's left (how much latency interpolation hides) needs the gameplay half running
headless, which waits for p606 and p608; before them a spike would mostly work around `Config` and
three. It becomes the first phase of `p510_headless-simulation-runtime.md` (Phase 4).

### Phase 4: stub plans and mark done — done

If the verdict is go: stubs for the network work in the free 51x range, eg.
`p510_headless-simulation-runtime.md`, `p511_network-transport-and-replication.md`,
`p512_client-prediction-and-reconciliation.md` (blocked by p500 and p610). Documents only, no
version bump; mark the plan done.

As built (2026-10-09):

- `p510_headless-simulation-runtime.md` (blocked by p606 and p608; its Phase 1 is the dropped
  spike), `p511_network-transport-and-replication.md` (blocked by p510 and by p614, which builds
  the transport interface) and `p512_client-prediction-and-reconciliation.md` (blocked by p500,
  p610 and p511; it predicts the local player with p421's kinematic controller). The blocking
  plans' `Blocks` lines name them.
- The §4 rules already have owners in the refactoring: p605 (the lint rules, the Firefox run),
  p606 (the headless core), p610 (deterministic characters, rule 8), p612 (the `appId` map),
  p614 (the transport interface) and p425 (serializable components, with save games).
- `CHANGELOG.md`: a Project bullet in the branch's entry, no version bump.

## 6. Risks and open questions

1. **Cross-platform float determinism** is the hard part of lockstep and rollback, and it depends on
   the browsers' WASM float behaviour as well as Rapier's build. Phase 1 measured: both builds
   reproduced bit for bit across Chromium, Firefox, Node and an Android phone on one scene, which
   is evidence, not a guarantee (iOS / Safari, characters, joints and other shapes untested). The
   recommendation doesn't depend on it; the Firefox run in the scene runner (p605) watches it.
2. **The server runtime:** Node with Rapier's compat build works without a DOM; whether the server
   should also run three (for raycasts against render meshes, or animation-driven hitboxes) is open.
   The recommendation is no: the server uses physics colliders only.
3. **Rendering assumptions in simulation code:** some simulation reads `Object3D`s today (the
   frustum and LOD systems are presentation, but the character reads the main camera for
   `CAMERA_RELATIVE`). p610 moves camera-relative input into the player brain, which runs on the
   client.
