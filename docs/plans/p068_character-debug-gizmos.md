Status: draft | not-implemented (stub)
Category: Character, Debugger
Blocked by: p067_character-state-debugger-window.md

# Character Debug Gizmos — Plan

Draws in-world 3D debug overlays per character: the vectors and the physics probes the character controller uses to decide its state. They make it possible to _see_ why a character is falling, sliding or stuck on a wall, instead of reading numbers. The toggles live in the header of the Character state window (p067). This is a stub: scope and open questions only, to be expanded before implementation.

---

## 1. Goal (draft)

Per-character, individually toggleable overlays, drawn only while the character's state window is open (or through a "pin gizmos" toggle):

| Gizmo                                                                     | Source (`src/_engine/utils/character/dynamicCharacter.ts`)                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| World velocity arrow (length = speed)                                     | `characterData.velocity` (`:990`)                                                             |
| Relative velocity arrow (on moving platforms)                             | `characterData.relVelocity`                                                                   |
| Ground normal arrow + walkable colour (green / red by `groundIsWalkable`) | `characterData.groundNormal`, from `refreshFloorNormal` (`:356-372`)                          |
| Floor ray (down, walk/crouch length)                                      | `refreshFloorNormal`'s `castRayAndGetNormal` length                                           |
| Floor sensor sphere, lit when `isGrounded`                                | Floor sensor collider [INDEX 3] (`:686-693`, `_groundDetectorRadius`/`_groundDetectorOffset`) |
| Wall shape-cast cylinder + hit normal                                     | `refreshWallHit` (`:291-340`, `cachedWallHit`)                                                |
| Facing direction                                                          | `charRotation`                                                                                |
| Optional: short position trail (last ~2 s)                                | `characterData.position`                                                                      |

The grounded ray does **not** use `_groundedRayMaxDistance` (that field is never read). The gizmo must mirror the real ray length expression.

## 2. Notes

- **Renderer.**
  - The preferred renderer is the engine line system from `p058_line-rendering-system.md`, if it lands first.
  - The existing precedent is `src/_engine/core/Debug/_dbg__PhysicsDebugDraw.ts`, which already draws physics wireframes with fat lines, colour states and thickness settings.
  - Decide between waiting for p058 and a minimal `THREE.ArrowHelper`/`LineSegments` version.
- **Worker mode.** Shape-cast and ray results are async and one step late (`dynamicCharacter.ts:278-284`). The gizmo shows the _cached_ result the controller actually used, which is the honest thing to draw.
- **Implementation pattern.** Debug-only, in a `_dbg__` module under `src/_engine/core/Debug/Character/`. Gizmo objects are created once and updated in place in a late main looper (same lifecycle as p067 §3.8), with no per-frame allocation, and disposed on window close or scene change.

## 3. Open questions

- Should gizmos be visible without the state window open? (A global "character gizmos" toggle in the Characters tab?)
- Should they show through geometry (depthTest off) or be depth-tested?
- Should the settings (which gizmos, colours) persist in LS the same way as p067 §3.9?
- Wall hit: draw the cast volume every frame, or only when it hits?
