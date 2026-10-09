Status: stub — not-implemented
Category: Characters, Physics
Blocked by: p610_character-and-input-action-architecture.md (the controller contract in code)
Blocks: p420_npc-simulation-tiers.md (soft: the NPC default controller)
Related: \_DONE_p603_gameplay-architecture-contracts.md (C2: this is the second implementation that makes the controller contract firm), \_DONE_p604_multiplayer-viability-study.md (step-index time, no async casts in the tick), p512_client-prediction-and-reconciliation.md (predicts the local player with this controller), the "Refactor dynamic character code" (p070) prompt in `docs/templates/todo-plan-prompts.txt` (crouch shape, grace time and air control apply here too)

# Kinematic Character Controller — Stub

**This is a stub.** It records the goal, the contract and the open questions so the real plan can
be written after p610. Nothing here is a final design.

## Goal

A second character controller on Rapier's `KinematicCharacterController` (KCC): a kinematic body
moved by sweeps, with step-up, slope limits, snap to ground, moving platforms and pushing dynamic
bodies. It's the controller most engines give NPCs, and the one p420's `FULL` and `REDUCED` tiers
can use; `DynamicCharacter` stays for the player who wants physical movement and for tumbling.

## The contract it implements (p603 C2)

- `kind: 'KINEMATIC_CHARACTER'`, registered with `registerControllerKind` (C1).
- `tick(dt, intent, step)` reads the same `CharacterIntent` (C3) the dynamic controller reads, so
  any brain drives either one.
- Only the tick writes the body; the step index is its clock.
- The first controller that uses `attach` / `detach` (C2): swapping it with the dynamic controller
  on a live actor (ragdoll and back, p420's tiers) means the body plan's colliders get an owner other
  than the controller.

## Grounding (2026-10-09)

- Rapier's KCC is a commented-out signature in `core/Physics/PhysicsAPITypes.ts`
  (`createCharacterController` / `removeCharacterController`, ~l.1751). The Physics API exposes
  nothing of it; the worker switchboard (`workers/physics/`) has no KCC commands.
- The KCC's `computeColliderMovement` is a synchronous query against the world. In `WORKER_THREAD`
  mode it has to run in the worker, inside the step, or the tick gets a reply a step late (today's
  async casts, p604 §2).
- The body plans (`HUMANOID_CAPSULE`, `CharacterBodyPlans.ts`) are built for the dynamic body
  (floor and wall sensors, four colliders). A KCC needs one collider and no sensors.

## Open questions

1. **Where the KCC runs in `WORKER_THREAD` mode:** a controller half in the worker (the tick's
   intent sent in the STEP message, the result back with the poses) or a synchronous main-thread
   world copy. The first keeps determinism and costs a protocol addition.
2. **Body plans:** one plan with per-controller collider sets, or a plan per controller kind.
3. **Interaction with dynamic bodies:** the KCC pushes nothing by itself; how much push and how
   much a dynamic body pushes back (Rapier's `computedCollisions` plus impulses applied by the tick).
4. **Locomotion states:** which of the ten `LocomotionState`s it reports (no tumbling), so an
   animation graph (p422) works with both controllers.
5. **Debug tools:** the Characters tab and the state window read `CharacterData`'s prefixes today;
   p610 splits them, and this controller's `probes` and `config` plug into the same windows.
