Status: stub — not-implemented
Category: Networking, Architecture, Physics
Blocked by: p606_layering-inversion-and-public-entry.md (no module-load DOM or Vite reads), p608_engine-folder-restructure.md (the kernel / feature split a headless build picks from)
Blocks: p511_network-transport-and-replication.md, p512_client-prediction-and-reconciliation.md
Related: \_DONE_p604_multiplayer-viability-study.md (§3.1 the verdict, §4 the rules, Phase 1 the measurements; its dropped spike is this plan's Phase 1), p614_review-physics.md (the transport interface), \_DONE_p603_gameplay-architecture-contracts.md (C4: a network brain is a brain)

# Headless Simulation Runtime — Stub

**This is a stub.** It records the goal, what p604 measured and the open questions so the real
plan can be written after p606 and p608. Nothing here is a final design.

## Goal

The simulation half of the engine runs without a browser: the kernel's ECS, the `APP_PHYSICS_STEP`
systems, physics and a scene's gameplay code, in Node (an authoritative server) or a worker,
stepped by the step clock, with no renderer, DOM, styles or Vite. It's the base of p604's first
network model (an authoritative server with interpolating clients) and a useful tool without a
network: simulation tests and recorded replays in CI.

## Grounding (2026-10-09, from p604)

- **The physics half already runs headless.** p604 bundled `workers/physicsWorker.ts` for Node with
  esbuild (15 inputs, no three, `MainLoop`, `Config` or `PhysicsAPI`) and fed it a message stream
  recorded in the browser: 1,200 steps of `physicsTiers` came out bit-identical to Chromium,
  Firefox and an Android phone, snapshot bytes included. `physicsTiers` steps in 0.29 ms on average
  there (687 bodies).
- Two traps it hit: the worker stays free of three only because esbuild drops type-only imports of
  `LoopState` written without `import type` (p606 fixes them); and Rapier's WASM reads
  `performance.now()` through `self`, so a stand-in for the worker global must be the real global
  object.
- **The gameplay half doesn't run headless yet:** the `APP_PHYSICS_STEP` systems (the tier policy,
  kinematic movers, characters) live in the main thread's ECS. `Config.ts` reads `window.location`
  and `import.meta.env` at load, `PhysicsAPI.ts` imports `physicsWorker?worker`, `MainLoop.ts`
  needs `requestAnimationFrame` and a renderer, `InitEngine` builds the HUD and imports SCSS, and
  `ECS.ts` imports `three/webgpu` (p600 §2.6). p606 and p608 remove those from the kernel.
- **Scene code mixes both halves:** a scene file creates meshes, materials and physics entities
  in one function (`physicsTiers.ts` creates each crate's mesh and body together), and physics
  objects are created in code, not in the scene JSON yet.

## Phase 1 (from p604's dropped spike)

A throwaway branch once the kernel is headless: a Node process running `physicsTiers`' simulation,
two browser clients on a WebSocket sending intents and rendering interpolated snapshots. Measured:
how much latency interpolation hides, bandwidth against p604's estimate (45-62 kbit/s per client
for the changed bodies, quantized, at 20 Hz), server step time. The findings shape the phases
below.

## Open questions

1. **The entry point:** `InitEngine({ headless: true })`, or a separate `initSimulation()` that a
   browser's `InitEngine` builds on.
2. **Physics placement on a server:** in-process (the `MAIN_THREAD` path), a `worker_threads`
   worker behind p614's transport interface, or both.
3. **The server's clock:** a fixed-step loop on `setImmediate` / timers driving `stepPhysics`
   (no `requestAnimationFrame`), and what a missed deadline does (p604: never skip steps silently).
4. **Scene code:** how a scene's simulation part runs without its presentation part: a split in
   the scene file (a simulation function and a presentation function), physics objects in the scene
   JSON (the readme's roadmap item), or both.
5. **Components that hold three objects** (`OBJECT3D`, meshes): absent on a server, or present as
   bare transforms; which systems are presentation and don't run (p600 §3.4 decides the rule).
6. **The runtime:** Node only, or Deno and Bun too.
