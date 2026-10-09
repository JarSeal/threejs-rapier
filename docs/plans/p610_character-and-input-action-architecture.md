Status: stub — not-implemented
Category: Characters, Input, Architecture
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage B, engine major)
Blocked by: p608_engine-folder-restructure.md
Blocks: p614_review-physics.md, p617_review-input-ui-hud.md
Related: \_DONE_p603_gameplay-architecture-contracts.md (the contracts C1-C5 this plan builds, and the stub plans p421-p427 that build on it), p604_multiplayer-viability-study.md (step-index time, seeded RNG), p420_npc-simulation-tiers.md, the "Refactor dynamic character code" (p070) and "Key binding refactoring" (p770) prompts (they build on this plan)

# Character and Input Action Architecture — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Refactor the character code into p603's contracts (C1-C5) and add the input action layer, so a
second controller, an AI or network brain and new input schemes plug in without touching the
dynamic character.

## Scope

- **The action layer** (p603 C5) in `kernel/input/`: actions, bindings per context, the devices
  feeding it (keyboard, mouse, touch, and the gamepad, a TODO stub in `GamepadInput.ts` today),
  per-step recording. The engine's debug keys and the app's bindings on one model.
- **Controllers and brains** (C2, C4): `CharacterController` grows into the controller contract;
  the input schemes (`CharacterInputSchemes.ts`: TANK, WORLD_FIXED, CAMERA_RELATIVE) become player
  brains reading actions, registered instead of a closed union; the gym's dummy character becomes an
  AI brain.
- **`createDynamicCharacter` split:** the ~970-line closure into the controller's modules (floor,
  wall, platform, jump, tumble, crouch), with `CharacterData`'s state, config (`_`) and internals
  (`__`) as separate objects (the debug tools follow).
- **Determinism** (p604 §4): step-index time instead of `getPhysGameTime()`, the seeded RNG instead
  of `Math.random` (`DynamicCharacter.ts:1497`); the async casts' one-step lag documented or fixed.
- Behaviour stays the same: the gym's characters move as before (recorded paths compared).

## Inputs

- p603's confirmed contracts, p604 §4, the p070 and p770 prompts (what they will need), p600 §2.6.

## Done when

- The dynamic character is one controller behind the contract; the input schemes are brains;
  actions replace direct key reads in gameplay code; the gamepad works through the action layer.
- p601's runner passes; a recorded input run of the gym gives the same character path before and
  after.
