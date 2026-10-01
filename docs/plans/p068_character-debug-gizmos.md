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
| World velocity arrow (length = speed)                                     | `characterData.velocity` (written in the tick, `:1151`)                                                                          |
| Relative velocity arrow (on moving platforms)                             | `characterData.relVelocity`                                                                                                      |
| Ground normal arrow + walkable colour (green / red by `groundIsWalkable`) | `characterData.groundNormal`, from `refreshFloorNormal` (`:551-590`)                                                             |
| Floor ray (down, walk/crouch length)                                      | `refreshFloorNormal`'s `castRayAndGetNormal` length (`:561`)                                                                     |
| Floor sensor sphere, lit when `isGrounded`                                | The floor sensor collider (role `FLOOR_SENSOR`, §2), sized by the derived dimensions (`floorSensorRadius`, `floorSensorOffsetY`) |
| Wall shape-cast cylinder + hit normal                                     | `refreshWallHit` (`:492-547`) and its per-character `wallHit` result                                                             |
| Facing direction                                                          | `charRotation`                                                                                                                   |
| Optional: short position trail (last ~2 s)                                | `characterData.position`                                                                                                         |

The floor ray's length is the body plan's `floorRayLength` for the current stance (`dims.standing` or `dims.crouching`; `HUMANOID_CAPSULE` makes it the active capsule's `halfHeight * 2 + _radius * 4`). The wall cast's cylinder is the same stance's `wallCastOffsetY`, `wallCastHalfHeight` and `wallCastRadius`. (p066 removed the unused `_groundedRayMaxDistance`.) The gizmo must draw those values, not re-derive them.

## 2. Notes

- **Renderer.**
  - The renderer is the engine line system (`LineManager.ts`, p058, implemented): `createLines` + `beginWrite`/`endWrite` for per-frame refill, `setColor`/`setColorStyle` for state colours, `width` for thickness. The FAT backend also has opt-in screen-space dashes per segment (added by p141 for the ray helpers), handy for inactive or cached-result gizmos.
  - The existing precedent is `src/_engine/core/Debug/_dbg__PhysicsDebugDraw.ts`, which draws physics wireframes on that system with colour states and a thickness setting.
- **Worker mode.** Shape-cast and ray results are async and one step late (`DynamicCharacter.ts:475-480`). The gizmo shows the _cached_ result the controller actually used, which is the honest thing to draw.
- **What p066 changed for this plan:**
  - **Colliders by role, not by index.** Since p066 Phase 4 the body plan (`CharacterBodyPlan.getColliders`, `HUMANOID_CAPSULE` in `core/Character/CharacterBodyPlans.ts`) declares them by role (`MAIN`, `CROUCH`, `WALL_SENSOR`, `FLOOR_SENSOR`), and a plan can add more. The controller maps role → index into the entity's `COLLIDER` array, which keeps the params' order (`colliderIndexes`, `DynamicCharacter.ts:906`). That map is private to the controller's closure: expose it (with the dimensions, below) or rebuild it from the plan. Look colliders up by role, never by index.
  - **Dimensions come from one place.** Every collider and probe size is derived from the data by the body plan's `getDimensions` (`HUMANOID_CAPSULE`'s at `CharacterBodyPlans.ts:56`, called once at creation, `DynamicCharacter.ts:449`). Draw from those values, not from re-derived formulas. Neither the body plan nor its result is kept on `CharacterObject` (only `kind` is), so this plan has to expose them (eg. a read-only `body`/`dims` on the controller).
  - **The wall-hit result is private.** `wallHit` lives in the controller's closure (`:481`), so this plan has to expose it (eg. a read-only accessor on the controller, or `__` fields in `data`).
  - **Existing ray helpers.** The floor ray and the wall cast already carry physics ray helper ids (`char_floor_<entityId>`, `char_wall_<entityId>`, `:957-958`), drawn while the physics helpers are on. Decide whether the gizmos reuse them or replace them for characters.
- **Implementation pattern.** Debug-only, in a `_dbg__` module under `src/_engine/core/Debug/Character/`. Gizmo objects are created once and updated in place in a late main looper (same lifecycle as p067 §3.8), with no per-frame allocation, and disposed on window close or scene change.

## 3. Open questions

- Should gizmos be visible without the state window open? (A global "character gizmos" toggle in the Characters tab?)
- Should they show through geometry (depthTest off) or be depth-tested?
- Should the settings (which gizmos, colours) persist in LS the same way as p067 §3.9?
- Wall hit: draw the cast volume every frame, or only when it hits?
