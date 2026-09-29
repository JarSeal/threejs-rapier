# Changelog

One entry per branch merged to `main`, newest first, written in that branch's PR next to its version bumps (see "Versioning" in `.claude/CLAUDE.md`). Each entry has a section per part that changed: **Engine** (`src/_engine/`), **Toolkit** (`src/toolkit/`) and **App** (`src/app/` and the app-level files in `src/`). **Project** covers repo tooling that belongs to none of them. A part without a section kept its version.

Earlier releases are only recorded in the git history.

## 2026-09-29 — ray-casting-refactoring

### Engine 2.2.0 (Morning)

**Added**

- `castRayFromDirection(objects, origin, direction, opts?)` (what `castRayFromPoints` used to do).
- `RayCastOpts` (exported): `near`, `far`, `target`, `perIntersect` (return `false` to stop), `countInStats` and `debug` (`RayDebugOpts`: `id`, plus optional `color`, `inactiveColor`, `width`, `holdMs`, `fadeOutMs`, `showHit` and `depthTest`).
- Opt-in screen-space dashes for thick lines: `LineProps.dash` (`{ dashPx, gapPx }`, fixed at creation, FAT backend only) and `LineObject.setDash(dashPx, gapPx)`, a uniform write where a gap of 0 draws solid. The pattern restarts at each segment. Lines without `dash` keep their exact shader.
- Ray cast controls tab: a "Three.js rays" folder with the helper settings (show, show rays without an id, force kind colors, active and inactive color, width, hold, fade out, dash and gap), applied live and persisted.
- Ray cast statistics API, now in the core (it used to live in the debug module): `setRayCastStatsEnabled`, `isRayCastStatsEnabled`, `getRayCastStats` (one reused snapshot object, rays per rendered frame) and `resetRayCastStats`.
- `IntervalCounterStats` (`utils/stats/`): an allocation-free per-frame counter with rolling min/max and average windows.
- `createPercentagePie()`: a pie CMP updated with `set(percentage)`.
- Physics query statistics (`PhysicsAPI.ts`): `setPhysicsRayStatsEnabled`, `isPhysicsRayStatsEnabled`, `getPhysicsRayStats` (one reused `PhysicsRayStats` object: rays and shape casts per rendered frame, counted when issued, plus `pendingQueries` waiting for a worker reply) and `resetPhysicsRayStats`, reset on every scene enter.
- Physics queries can be drawn as `'PHYSICS'` ray helpers (debug only, `setPhysicsRayHelpersEnabled`). The line appears when the query is issued and gets its hit when the result arrives, about a frame later in `WORKER_THREAD` mode.
- An optional trailing `debug?: RayDebugOpts` parameter on `castRay`, `castRayAndGetNormal`, `intersectionsWithRay` and `castShape` (and their `*Sync` forms). It stays on the main thread.
- `PhysicsQueryObserver`/`PhysicsQueryKind`, and `EngineAPIType.setQueryObserver`, which a physics backend must now implement. With nothing observing, a query costs one null check, and the worker's engine never observes.
- Ray cast controls tab: a "Physics rays" folder with the same helper settings, an "Enable physics ray statistics" toggle and the physics stats (rays, shape casts and, in `WORKER_THREAD` mode, pending queries), persisted.
- `RAY_STATS_WINDOWS`: the stats windows shared by the Three.js and physics ray counters.
- A "Respect depth" helper setting per ray kind (Three.js and physics folders, persisted): geometry in front then hides the helpers. Off by default, so they still draw on top. A ray's `debug.depthTest` overrides it.
- `dynamicCharacter`'s floor ray and wall cast carry helper ids (`char_floor_<entityId>`, `char_wall_<entityId>`).

**Changed**

- `castRayFromPoints(objects, from, to)` is point-to-point: `to` is the end point (it was treated as a direction), and hits beyond it are left out.
- `near`/`far` (and the deprecated `startLength`/`endLength`) are applied by the raycaster, so they filter the returned hits too, not only the per-hit callback. A passed `target` array is cleared before it is filled.
- The ray cast statistics count rays per rendered frame (frames skipped by the FPS limiter are no longer counted as frames).
- The Ray cast controls tab updates its statistics from cached elements five times a second while the tab is visible, instead of re-rendering the block every frame. The max and min rows are merged into one "max / min" row per window.
- `PercentagePieHtml` renders one element (a CSS conic gradient) instead of seven nested ones.
- `castRayFromAngle` no longer allocates a vector per cast.
- The Ray cast controls tab's Three.js stats heading is "Three.js ray stats:".
- `filterPredicate` on the physics query methods is documented as not supported yet (it was always ignored).
- Ray debug helpers are pooled thick lines with a hit cross, drawn by a shared renderer (`core/Debug/_dbg__RayHelpers.ts`, ready for physics rays). A helper stays solid for a hold time after its last cast, then turns dashed in the inactive color and fades out, instead of being disposed the first frame its ray isn't cast. Rays without an id can be shown too. `deleteAllRayHelpers()` hides and recycles them. The persisted `showAllRayDebugHelpers` toggle is migrated to the new `threeShow` setting.

**Deprecated**

- The `RayCastOpts` aliases `helperId`, `helperColor`, `startLength`, `endLength`, `perIntersectFn` and `optionalTargetArr` (use `debug.id`, `debug.color`, `near`, `far`, `perIntersect` and `target`).
- `PercentagePieHtml`'s `size` option (it has no effect).

**Removed**

- `countRayCastFrames` and `cleanUpRayHelpers` (internal plumbing).

**Fixed**

- `PercentagePieHtml` joined extra classes with a comma.
- The ray helper cleanup ran once per ECS world each frame instead of once.
- `castRayAndGetNormal` in `WORKER_THREAD` mode returned the raw worker message instead of the hit, with an unmapped collider id, and dropped the exclude filters. **Behavior change:** the character controller now really evaluates ground slopes in worker mode (its floor normal was always read as flat) and its floor ray no longer hits its own body.
- `intersectionsWithRay` threw in `WORKER_THREAD` mode (the worker replied with `hits` instead of `intersections`), and it ignored a callback returning `false`.

## 2026-09-29 — spatial-index-system-visualizer

### Engine 2.1.0 (Morning)

**Added**

- Spatial index visualizer in the "Spatial index" debugger tab: wireframe boxes for the occupied grid cells and, separately, for the oversized tier's members, each with its own checkbox and color picker (persisted).
- `SpatialGrid.cellSize`, `SpatialGrid.getOccupiedCellBoundsInto(out)` and `SpatialGrid.getOversizedBoundsInto(out)`.
- `PROJECT_METADATA.toolkit`, the `x-toolkit` meta tag, the `%TOOLKIT_*%` HTML placeholders and a toolkit line in the boot console log.
- Optional `engineVersion`/`toolkitVersion`/`appVersion` in save data `__meta`. `gatherAppData` warns when an applied save entry was stamped under another major version.

**Changed**

- The version checksum also covers the toolkit version and codename, and no longer includes the merge version (existing checksum values change once).
- The boot log no longer writes versions into `#engineVersion`/`#appVersion` DOM elements (they no longer exist).

**Deprecated**

- `PROJECT_METADATA.mergeVersion`, to be removed in the next major version. The `x-merge-version` meta tag is removed.

**Fixed**

- The physics debug wireframe of heightfield colliders was drawn with the wrong layout (sheared and transposed).
- A heightfield collider's column count was read from `nrows`, which broke non-square heightfields.

### Toolkit 1.0.0 (Crescent)

**Added**

- Versioned on its own for the first time (`toolkit_metadata` in `package.json`; it was previously covered by the engine version). Its codenames follow the moon's phases.
- Included in the `yarn docs` TypeDoc output.

### Project

**Added**

- `yarn checkVersions` checks the versioning rules; `--against main` also checks each part's bump. The Stop hook runs the base check whenever `package.json` changes.
- `yarn tagRelease` tags a merge on `main` per part (`engine-v…`, `toolkit-v…`, `app-v…`).
- This changelog.
