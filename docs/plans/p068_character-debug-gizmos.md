Status: draft | not-implemented (stub)
Category: Character, Debugger
Blocked by: p067_character-state-debugger-window.md

# Character Debug Gizmos — Plan

Draws in-world 3D debug overlays per character: the vectors and the physics probes the character controller uses to decide its state. They make it possible to _see_ why a character is falling, sliding or stuck on a wall, instead of reading numbers. The toggles live in the header of the Character state window (p067). This is a stub: scope and open questions only, to be expanded before implementation.

---

## 1. Goal (draft)

Per-character, individually toggleable overlays, drawn only while the character's state window is open (or through a "pin gizmos" toggle):

| Gizmo                                                                     | Source (`src/_engine/core/Character/DynamicCharacter.ts`)                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| World velocity arrow (length = speed)                                     | `characterData.velocity` (written in the tick, `:1085`)                                                                          |
| Relative velocity arrow (on moving platforms)                             | `characterData.relVelocity`                                                                                                      |
| Ground normal arrow + walkable colour (green / red by `groundIsWalkable`) | `characterData.groundNormal`, from `refreshFloorNormal` (`:450-491`)                                                             |
| Floor ray (down, walk/crouch length)                                      | `refreshFloorNormal`'s `castRayAndGetNormal` length (`:462`)                                                                     |
| Floor sensor sphere, lit when `isGrounded`                                | The floor sensor collider (role `FLOOR_SENSOR`, §2), sized by the derived dimensions (`floorSensorRadius`, `floorSensorOffsetY`) |
| Wall shape-cast cylinder + hit normal                                     | `refreshWallHit` (`:389-446`) and its per-character `wallHit` result                                                             |
| Facing direction                                                          | `charRotation`                                                                                                                   |
| Optional: short position trail (last ~2 s)                                | `characterData.position`                                                                                                         |

The floor ray's length is `activeHalfHeight * 2 + _radius * 4`, where `activeHalfHeight` is the walk or crouch capsule's from the derived dimensions. (p066 removed the unused `_groundedRayMaxDistance`.) The gizmo must mirror the real ray length expression.

## 2. Notes

- **Renderer.**
  - The renderer is the engine line system (`LineManager.ts`, p058, implemented): `createLines` + `beginWrite`/`endWrite` for per-frame refill, `setColor`/`setColorStyle` for state colours, `width` for thickness. The FAT backend also has opt-in screen-space dashes per segment (added by p141 for the ray helpers), handy for inactive or cached-result gizmos.
  - The existing precedent is `src/_engine/core/Debug/_dbg__PhysicsDebugDraw.ts`, which draws physics wireframes on that system with colour states and a thickness setting.
- **Worker mode.** Shape-cast and ray results are async and one step late (`DynamicCharacter.ts:372-377`). The gizmo shows the _cached_ result the controller actually used, which is the honest thing to draw.
- **What p066 changed for this plan:**
  - **Colliders by role, not by index.** The colliders are still an array today (walk capsule, crouch capsule, wall sensor, floor sensor: the `[INDEX: n]` comments at `:721-858`). p066 Phase 4 (`HUMANOID_CAPSULE` body plan, §2.5) declares them by role (`MAIN`, `CROUCH`, `WALL_SENSOR`, `FLOOR_SENSOR`), and a plan can add more. Look them up by role, never by index.
  - **Dimensions come from one place.** Every collider and probe size is derived from the data by `getCharacterDimensions` (`:279-293`), which becomes the body plan's `getDimensions` in p066 Phase 4. Draw from those values, not from re-derived formulas.
  - **The wall-hit result is private.** `wallHit` lives in the controller's closure (`:378`), so this plan has to expose it (eg. a read-only accessor on the controller, or `__` fields in `data`).
  - **Existing ray helpers.** The floor ray and the wall cast already carry physics ray helper ids (`char_floor_<entityId>`, `char_wall_<entityId>`, `:951-952`), drawn while the physics helpers are on. Decide whether the gizmos reuse them or replace them for characters.
- **Implementation pattern.** Debug-only, in a `_dbg__` module under `src/_engine/core/Debug/Character/`. Gizmo objects are created once and updated in place in a late main looper (same lifecycle as p067 §3.8), with no per-frame allocation, and disposed on window close or scene change.

## 3. Open questions

- Should gizmos be visible without the state window open? (A global "character gizmos" toggle in the Characters tab?)
- Should they show through geometry (depthTest off) or be depth-tested?
- Should the settings (which gizmos, colours) persist in LS the same way as p067 §3.9?
- Wall hit: draw the cast volume every frame, or only when it hits?
