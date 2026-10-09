Status: stub — not-implemented
Category: AI, Characters
Blocked by: p610_character-and-input-action-architecture.md (the brain contract in code)
Blocks: p420_npc-simulation-tiers.md (soft: its `REDUCED` tier moves on the navmesh)
Related: \_DONE_p603_gameplay-architecture-contracts.md (C4: the AI brain), p421_kinematic-character-controller.md (the NPC default controller), p425_game-events-missions-and-save-games.md (AI reacting to game events), \_DONE_p604_multiplayer-viability-study.md (step-index time, the seeded RNG)

# AI Brains and Navigation — Stub

**This is a stub.** It records the goal, the contract and the open questions so the real plan can
be written after p610.

## Goal

The AI brain, navmesh generation and pathfinding, and steering:

- **Engine:** the brain contract (p610) and navmesh queries (find a path, the nearest point on the
  mesh, a raycast along it).
- **Toolkit:** ready-made AI (a behaviour tree or utility AI runner, patrol, follow, flee) as brain
  kinds.
- **App:** the game's AI.

## The contract it implements (p603 C4)

- An AI brain is a brain kind (`registerBrainKind`), its `think(intent, step)` run by the one brain
  system before the controllers. It writes `CharacterIntent` (or a vehicle's `VehicleIntent`) and
  never touches a body or a device.
- It reads the world through queries (navmesh, spatial domains, raycasts), never by holding a
  controller's internals.
- A brain that skips steps (thinking every N steps for cheap NPCs) reads `step` itself (p603 §7
  risk 3); whether the brain system schedules it is p420's question.

## Grounding (2026-10-09)

- The gym's dummy character (`app/scene_thirdPersonGym.ts`, `dummyCharLooper`) is today's scripted
  brain: an `APP_PHYSICS_STEP` system writing the intent from a `dt` accumulator. p610 turns it into
  a brain; this plan's first AI brain replaces its script with a goal.
- No navmesh or pathfinding dependency (`package.json` has no recast, yuka or similar).
- Spatial domains (`registerSpatialDomain`, `_DONE_p346`) give neighbour queries for perception and
  crowd avoidance.

## Open questions

1. **Navmesh generation:** recast-navigation-js (WASM, runs in a worker) at build time from the
   scene's colliders, at load time, or both (tiles regenerated for moving obstacles).
2. **Where pathfinding runs:** the assets worker, a navigation worker, or the physics worker next to
   the colliders it was built from; queries answering a step late are the async-cast problem again.
3. **Crowd steering:** Detour's crowd, our own RVO on spatial domains, or none until p420.
4. **Behaviour authoring:** code-first behaviour trees, utility AI, or data assets; which the toolkit
   ships first.
5. **Determinism:** pathfinding results and random choices through the seeded RNG streams (p603 C7),
   so an AI scene probes the same hash every load.
6. **Debug tools:** a navmesh overlay, the selected NPC's path and current task in its character
   state window.
