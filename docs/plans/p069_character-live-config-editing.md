Status: draft | not-implemented (stub)
Category: Character, Debugger
Blocked by: p067_character-state-debugger-window.md

# Character Live Config Editing — Plan

Makes the **Properties** (`_`-prefixed) values in the Character state window (p067) editable at runtime, so movement can be tuned (speed, jump, slopes, tumbling thresholds) without code edits and reloads. Tuned values can be exported as a `charData` override. This is a stub: scope, constraints and open questions only, to be expanded before implementation.

---

## 1. Goal (draft)

- Each Properties row in the p067 window gets an inline number input (click-to-edit or always-on, to be decided) that writes straight to `CharacterObject.data[key]`. That is the same live `characterData` object the controller reads every tick (`src/_engine/utils/character/dynamicCharacter.ts:252`).
- A "reset to default" action per row and for the whole group, using `DEFAULT_CHARACTER_DATA` merged with the character's creation-time `charData` override.
- A "Copy as `charData` override" button that copies only the changed values as a TS/JSON snippet, ready to paste into e.g. `src/app/scene_thirdPersonGym.ts`'s `createDynamicCharacter({ charData: … })`.
- Optional: persist tuned values in localStorage per scene and character id, following the Camera/Light debug-override pattern (`src/_engine/core/PropertyLoader.ts`, `AEK_debugCams`/`AEK_debugLights`).

## 2. Constraints found so far

The `_` values fall into four kinds:

| Kind                                            | Fields                                                                                                                                                                                                                                                                                                                                                                        | Handling                                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read live every tick**, safe to edit directly | e.g. `_maxVelocity`, `_jumpAmount`, `_rotateSpeed`, `_runningMultiplier`, `_crouchingMultiplier`, `_inTheAirDiminisher`, `_accumulateVeloPerInterval`, `_isFallingThreshold`, `_minSlidingVelocity`, `_tumbling*` thresholds and times (except `_tumblingAngDamping`), `_gettingUpDuration`, `_keepMovingAfterJumpThreshold`, `_moveYOffset`, `_roundVelocitiesScalingFactor` | Write the value; it takes effect on the next tick. Verify each one when expanding this plan.                                                                               |
| **Derived at creation**                         | `_maxWalkableAngle` → `__maxWalkableAngleCos` (`dynamicCharacter.ts:256`)                                                                                                                                                                                                                                                                                                     | Recompute the derived `__` value on edit, through a small derived-value hook map.                                                                                          |
| **Baked into colliders at creation**            | `_height`, `_radius`, `_skinThickness`, `_groundDetectorOffset`, `_groundDetectorRadius` (`dynamicCharacter.ts:625-693`; also the mesh `CapsuleGeometry`)                                                                                                                                                                                                                     | Either read-only with a lock icon and tooltip, or "apply = recreate the character's colliders" (needs a collider-rebuild path through the Physics API; the riskiest part). |
| **Declared but unused**                         | `_groundedRayMaxDistance`, `_tumblingAngDamping` (never read in `src/`)                                                                                                                                                                                                                                                                                                       | Read-only, marked "unused". Or clean them up in the controller first.                                                                                                      |

- **Undo.** Edits here are real data changes, so they should record undo actions once `p060`/`p061` (the debugger undo engine and action recording) exist. The p061 table currently lists the tracker button as navigation-only.

## 3. Open questions

- Should edits persist across reloads (LS), or stay session-only with copy-out being the persistence path?
- For collider-baked values: read-only for now, or tackle collider rebuild in this plan?
- Is `State` group editing (e.g. teleporting `position`, forcing `isTumbling`) in scope, or left to the edit window's existing position/rotation controls?
