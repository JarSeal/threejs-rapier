Status: draft | not-implemented
Category: Character, Debugger

# Character Debug Gizmos — Plan

Draws in-world 3D debug overlays per character: the vectors and the physics probes the character controller uses to decide its state. They make it possible to _see_ why a character is falling, sliding or stuck on a wall, instead of reading numbers. The toggles live in the header of the Character state window (p067).

---

## 1. Goal

Per-character, individually toggleable overlays, drawn while the character's state window is open, or after it closes when the window's "Pin" toggle is on (§3.5):

| Gizmo            | Drawn                                                                                                   | Source (`src/_engine/core/Character/DynamicCharacter.ts`)                               |
| ---------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Velocity         | Arrow from the anchor (§2.2), length = speed × vector scale                                             | `characterData.velocity` (written in the tick, `:1151`)                                 |
| Rel. velocity    | Same, only while `isOnMovingPlatform`                                                                   | `characterData.relVelocity`                                                             |
| Facing           | Horizontal arrow from the anchor, fixed length                                                          | `charRotation` (forward = `(cos yaw, 0, -sin yaw)`, `CharacterTypes.ts:7`)              |
| Ground normal    | Arrow from the floor ray's hit point; green when `groundIsWalkable`, red when not; hidden on a miss     | `characterData.groundNormal`/`groundIsWalkable`, from `refreshFloorNormal` (`:551-590`) |
| Floor ray        | Down from the cast's origin: solid to the hit with a cross, dashed beyond it (all dashed on a miss)     | The last floor ray (§3.1), its length the stance's `floorRayLength`                     |
| Floor sensor     | Wireframe ball at the sensor collider; lit when `isGrounded`, grey when not                             | The `FLOOR_SENSOR` collider's params (by role, §3.1)                                    |
| Wall cast        | The last cast's cylinder at its origin, its sweep, and the hit normal; solid on a hit, dashed on a miss | `refreshWallHit` (`:492-547`) and the last wall cast (§3.1)                             |
| Trail (optional) | Polyline of the anchor over the last ~2 s                                                               | The anchor, sampled                                                                     |

The probe sizes are the body plan's, for the stance the cast was fired in (`dims.standing`/`dims.crouching`: `floorRayLength`, `wallCastOffsetY`, `wallCastHalfHeight`, `wallCastRadius`). The gizmos draw those values, never re-derived formulas.

## 2. Decisions

### 2.1 Answered open questions

| Question                              | Decision                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Visible without the state window?     | Only with the window open, or after it closes when pinned (per character, §3.5). No global toggle.                                                                                                                                                                                                                                         |
| Through geometry or depth-tested?     | On top by default (`depthTest: false`, as the ray helpers default), with a "Depth" toggle in the window's gizmo row.                                                                                                                                                                                                                       |
| Persist settings in LS?               | Yes, per viewer, like p067 §3.9: one LS key shared by every character window, so the last used set is the next window's. Holds the gizmo toggles, depth and the vector scale. Pins are not saved (§3.5).                                                                                                                                   |
| Wall cast: every frame or only a hit? | The last fired cast, as it was fired: solid with the hit normal on a hit, dashed on a miss, hidden once older than `WALL_CAST_HOLD_MS` (300 ms). No cast fires unless the character is near a wall and moving (`:717-718`), so there is often nothing to draw (also while pushing straight into a wall: the body stops, so no cast fires). |

### 2.2 Other decisions (from reading the code)

- **Anchor = the visual, not `data.position`.** `data.position` is the raw physics pose of the last tick (`:1307`). The visual is interpolated (and one step late in `WORKER_THREAD` mode), so gizmos at `data.position` would jitter against the mesh whenever the render rate is above the physics rate. The per-frame gizmos start at the character entity's `OBJECT3D` world position, read every frame (never cached). The two casts are the exception: they draw at the origin they were fired from, since that is the query the controller used.
- **Collider-fixed gizmos follow the body.** The floor sensor ball is built once and parented to the character's Object3D, like `_dbg__PhysicsDebugDraw.ts` does for collider wireframes (built once, positioned by the scene graph), so it rotates with a tumbling body at no per-frame cost. Only its colour changes.
- **One line per colour.** A `LineObject` has one colour (`setColor`/`setColorStyle`) and one dash pattern (fixed dashability at creation). So each gizmo, and each solid/dashed part, is its own line: about 12 small lines per character. All are created once per gizmo set and refilled in place (`beginWrite`/`endWrite`, `growth: 'FIXED'`, capacities known up front). Dashed lines pin `backend: 'FAT'` (`LineTypes.ts:96-100`); the set calls `preloadFatLineBackend()` once.
- **The existing ray helpers stay.** `char_floor_<entityId>` and `char_wall_<entityId>` (`:957-958`) belong to the global physics ray helpers (on/off with them, fade and hold settings in the Ray cast tab). The gizmos don't reuse or suppress them: they are per character, follow this window and draw from the controller's own cached results, which the helpers can't (they show what was cast, not what the controller kept, eg. a wall hit rejected by `_wallNormalMaxY` at `:536`).
- **Freeze freezes the gizmos too.** A frozen state window (p067) skips refilling its gizmo lines, so they hold the same moment as the table. No snapshot copy is needed: the lines keep their last geometry.
- **Colours are constants for now** (a `GIZMO_COLORS` table in the module). Making them configurable is left for later.

## 3. Design

### 3.1 Exposing the probe state (engine)

The body plan, its dimensions, the role map and the wall-hit result are private to the controller's closure. `CharacterController` (`CharacterTypes.ts:145`) gets an optional read-only `probes`:

```ts
/** A cast's last result, as the controller used it. Mutated in place. */
export type CharacterCastRecord = {
  /** getPhysGameTime() when the result arrived, 0 = never cast */
  resolvedAt: number;
  /** The stance the cast was sized for */
  isCrouching: boolean;
  /** World origin of the cast (the body's center, plus the stance's offset for the wall cast) */
  origin: { x: number; y: number; z: number };
  /** Unit direction (floor ray: straight down; wall cast: the horizontal move direction) */
  dir: { x: number; y: number; z: number };
  /** The cast's length (floorRayLength or _wallCastDistance) */
  maxDistance: number;
  isHit: boolean;
  /** Distance to the hit along `dir` (valid when isHit) */
  distance: number;
  /** World hit point (valid when isHit). Wall cast: the hit's `witness1`; floor ray:
   * `origin + dir × distance` */
  point: { x: number; y: number; z: number };
  /** World hit normal (valid when isHit) */
  normal: { x: number; y: number; z: number };
};

/** What a controller's casts and colliders look like: read-only diagnostics (eg. debug gizmos). */
export type CharacterProbes = {
  body: CharacterBodyPlan;
  dims: CharacterDimensions;
  /** The body plan's collider roles, by index into the entity's COLLIDER array */
  colliderRoles: readonly string[];
  floorRay: CharacterCastRecord;
  wallCast: CharacterCastRecord;
};
```

`createDynamicCharacter` fills it:

- `body`, `dims` and `colliderRoles` (`bodyColliders.map((c) => c.role)`) once, at creation.
- `wallHit` (`:481`) stays as the controller's working value. The record is separate, because it also keeps rejected hits (`_wallNormalMaxY`) and misses, which `wallHit` collapses to `isValid: false`.
- Each cast's origin, direction, stance and length are captured into a private pending record when it fires (the `_castPos` scratch is shared by both casts) and copied into the public record with the result when it resolves. A drawn cast is always one consistent cast. A rejected `.catch` leaves the record as it was.
- Preallocated objects, written in place: no allocation per cast. Not debug-gated: a few number writes per cast.
- Rapier's `castShape` hit (checked against 0.19.3, also with a rotated wall): `witness1`/`normal1` are on the **hit collider, in world space** (`normal1` points out of it, toward the cast shape); `witness2`/`normal2` are on the cast shape, in its local space. The wall record takes `witness1` and `normal1` as they are. `PhysicsAPITypes.ts`'s `ShapeCastHitAPI` docs had the two the wrong way round and were fixed in Phase 1.
- The wall cast's cylinder (`wallCastRadius` = the wall sensor's radius) is wider than the body, so against a wall the body touches it starts overlapping: `distance` is then 0 and the sweep has no length.
- `wallCast.dir` is set on fire; the early return for a standing character (`:496-499`) fires nothing, so the record keeps its last cast (it goes stale and the gizmo hides it).

### 3.2 Module and lifecycle

New `src/_engine/core/Debug/Character/_dbg__CharacterGizmos.ts` (debug only, reached only from `_dbg__CharacterStateWindow.ts`, which is already dynamically imported):

- A **gizmo set** per character id (`Map<string, GizmoSet>`): its lines, a scene main late looper (`createSceneMainLooper(fn, sceneId, true)`: runs while the app is paused too), and its owners (the open window, the pin).
- `acquireGizmoSet(charId, owner)` / `releaseGizmoSet(charId, owner)`: the set is created by its first owner and disposed (lines, looper) when the last one releases it. The state window acquires on content build and releases in `disposeInstance` (`_dbg__CharacterStateWindow.ts:499`). That ties it to p067's actual lifecycle (the scene target resolver, §6 notes there): the window is torn down at a scene change and rebuilt in the new scene if the character id is there, and the set is rebuilt with it.
- Lines are `persistent: true` (the set owns their lifetime; a scene switch must not dispose them under it) and disposed by the set. Like the state window looper, the gizmo looper disposes the set (deferred with `queueMicrotask`) when the character is gone.
- The looper reads `getCharacterById(charId)`, its `controller?.probes` (a character without probes draws only the data-based gizmos) and the entity's `OBJECT3D`, then refills only the enabled gizmos' lines. Scratch vectors are module-level: no allocation per frame.

### 3.3 The header's gizmo row

A second header row in the state window, below the interval/flash/freeze row: compact checkbox labels (`winSmallLabel`, as the Flash toggle) that wrap on a narrow window:

`Gizmos: ☐ Vel ☐ Rel ☐ Face ☐ Normal ☐ Floor ray ☐ Sensor ☐ Wall ☐ Trail | ☐ Depth  Scale [0.25] | 📌`

- Each toggle sets its lines' `visible` and is saved to LS at once (§3.4). Off gizmos are not refilled.
- "Scale" is the velocity arrows' metres per m/s (default 0.25, so a 6 m/s run is a 1.5 m arrow).
- "Depth" flips every line's `depthTest`.
- The pin button (§3.5).
- Tooltips say which values are late: the ground normal, floor ray and wall cast come from async casts (p067's `LATE_KEYS` note).

### 3.4 Persistence

`AEK_charGizmos`: `{ enabled: Record<GizmoId, boolean>, depthTest: boolean, vectorScale: number }`, loaded and sanitised like `loadSettings` in `_dbg__CharacterStateWindow.ts:106`. Default: velocity, ground normal and floor sensor on, the rest off, depth off, scale 0.25. Shared by every window (per viewer, not per character).

### 3.5 Pin

The pin is a second owner of the character's gizmo set: pinned gizmos stay after the state window closes.

- Unpinning: the window's pin button, or a pin icon toggle on the character's row in the Characters tab (`debuggerListCMP`'s per-row `toggles`, `_dbg__DebuggerList.ts:25`), shown for every character and lit when pinned. That is the only way to unpin a character whose window is closed. Needs a new `pin` SVG icon (none exists in `core/UI/icons/svg/`).
- Scene change: a pin follows the same rule as the window. It is kept, and its set rebuilt in the new scene, when the next scene has a character with the same id; otherwise it is dropped.
- Not persisted (session only): restoring pins on a reload would need a hook on character creation just for this. Revisit if wanted.

### 3.6 Drawing details

- **Arrows:** a shaft plus a 4-segment head (two crossed "V"s in the planes through the shaft), written straight into the line writer. No allocation. A zero-length vector (below 1e-3) writes nothing.
- **Floor ray:** from `floorRay.origin` along `dir`: a solid line to `distance` with a small cross at the hit, a dashed line from there to `maxDistance` (the whole length on a miss).
- **Ground normal:** from `floorRay.point`, 0.5 m long; hidden on a miss (the controller then uses level ground, `:577-580`, which is worth seeing as "no arrow").
- **Floor sensor:** three great circles (XY, XZ, YZ, 24 segments each) with the radius and `translation` of the `FLOOR_SENSOR` collider's params, from `probes.body.getColliders(probes.dims, data)` called once at set creation. The look-up is by role, never by index. A plan whose `FLOOR_SENSOR` is not a `BALL` gets its bounding ball, with a one-time `lwarn`.
- **Wall cast:** at `wallCast.origin`: the cylinder (two 24-segment circles and 4 verticals, `wallCastHalfHeight`/`wallCastRadius` of the record's stance), the sweep (the centre line to `distance` on a hit, else to `maxDistance`), and on a hit the normal arrow from `wallCast.point`. Solid when hit, dashed when missed. Hidden when `getPhysGameTime() − resolvedAt > WALL_CAST_HOLD_MS`.
- **Trail:** a ring buffer of 64 anchor positions, sampled every 33 ms of `performance.now()` (about 2 s), drawn as a polyline. Fixed capacity.

## 4. Phases

Each phase is reviewable and committable on its own.

### Phase 1 — Probe state on the controller (engine, no visible change) — done

- Add `CharacterCastRecord`, `CharacterProbes` and `CharacterController.probes?` to `CharacterTypes.ts` (§3.1).
- Fill them in `createDynamicCharacter`: create once, capture on fire, publish on resolve.
- Fix the `ShapeCastHitAPI` witness/normal docs (§3.1).
- Check: lint and type-check pass; the gym's characters behave as before in both worker targets (the record writes don't touch the controller's logic or `wallHit`).
- (done) Verified in the gym in both worker targets with a headless probe: the floor ray record follows the stance (2.6 m standing, 2.32 m crouching), wall casts along the gym's walls record points on the wall faces with outward normals, and every recorded direction is horizontal and unit length.

### Phase 2 — Gizmo module, header row and the vector gizmos

- `_dbg__CharacterGizmos.ts`: gizmo sets, owners, the looper, LS settings (§3.2, §3.4).
- The state window: acquire/release, the gizmo row (all toggles shown; the probe ones disabled until Phase 3), freeze skips refills.
- Gizmos: velocity, relative velocity, facing, ground normal.
- Check: the arrows follow the mesh without jitter (also with a low physics rate), the relative velocity arrow shows only on the moving platform, closing the window or switching scenes leaves no line behind (`getAllLines()`).

### Phase 3 — The probe gizmos

- The floor ray, floor sensor ball and wall cast (§3.6). Enable their toggles.
- Check in both worker targets: crouching shortens the floor ray and moves the cast; a slope steeper than `_maxWalkableAngle` turns the normal red; walking into a wall shows a solid cylinder and normal; walking along open ground shows nothing or a dashed miss that fades out.

### Phase 4 — Pin, trail and release

- The pin (§3.5): the window's pin button, the Characters tab row toggle, the `pin` icon. The trail gizmo.
- Docs: `CLAUDE.md` (a short note under the debug system), `readme.md` (the "Character definitions and character debugging tools" roadmap line moves into the Debug suite features once p067 and p068 are both in). `CHANGELOG.md` and the version bump for this branch (engine minor for `CharacterController.probes`, unless the branch's bump already covers it).
