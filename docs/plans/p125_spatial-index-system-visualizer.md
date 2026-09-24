# Spatial index system visualizer

Status: draft | not-implemented
Category: Debugger
Blocked by: [_DONE_p050_spatial-index.md](./_DONE_p050_spatial-index.md), [_DONE_p081_light-object-culling.md](./_DONE_p081_light-object-culling.md), [p058_line-rendering-system.md](./p058_line-rendering-system.md)

## Goal

Add a debug-mode toggle that visualizes the [spatial index grid](../../src/_engine/core/Spatial/SpatialGrid.ts)'s occupied cells as wireframe boxes in the 3D view, with a visibility checkbox and a color picker (default red), wired into the existing "Spatial index" debugger tab ([_dbg__SpatialGrid.ts](../../src/_engine/core/Debug/_dbg__SpatialGrid.ts)).

## Context

- The spatial index is a sparse, CSR-backed uniform grid (`SpatialGrid.ts`), one instance per `ECSWorld`, held in a `WeakMap` and rebuilt every frame from current member positions ([SpatialIndexSystem.ts](../../src/_engine/core/Spatial/SpatialIndexSystem.ts), registered as a plugin on `ECSSystemStage.APP_POST_PHYSICS`). It is **not bounded by a fixed world-space AABB** — cells are only allocated where members actually land, so there is no single fixed "grid boundary" to draw; the outer extent of the visualization is simply the union of currently-occupied cell wireframes.
- Members whose radius exceeds `cellSize * oversizedRadiusMultiplier` bypass the grid entirely (the "oversized tier", tracked in a separate `Set`). They have no cell to draw and are **out of scope** for this plan (see Non-goals).
- §9 of `_DONE_p050_spatial-index.md` planned an occupancy histogram, live cell-size tuning, and a brute-force oracle for debug tooling — all already implemented in `_dbg__SpatialGrid.ts`. A 3D wireframe visualizer was never part of that plan; this is new scope.
- The engine's established pattern for a toggleable 3D debug wireframe used to be the legacy physics collider debug mesh (`createPhysicsDebugMesh`/`stepperFnDebug` in [PhysicsRapier.ts:1465](../../src/_engine/core/PhysicsRapier.ts)): a single `LineSegments` created **once**, added to the scene, with its `BufferGeometry` position/color attributes **refilled every frame** while enabled; the toggle only flips a `visible` flag and an `enabled` state flag read by the per-frame refill — nothing is destroyed/recreated on toggle. **That pattern is superseded by the core Line rendering system** ([p058_line-rendering-system.md](./p058_line-rendering-system.md)), which owns exactly this shape: a pre-allocated segment buffer, an allocation-free `beginWrite()`/`endWrite()` refill that never re-wraps the attribute, `setColor()` as a uniform write, and `setVisible()`. This plan builds on that API rather than hand-rolling a third copy of it.

## Design decisions

1. **Create-once, not create/destroy-on-toggle.** The user's spec asks whether create/delete-per-toggle is necessary to avoid a memory footprint — it isn't, and it would be inconsistent with the codebase's own precedent. Since the grid rebuilds every frame, a wireframe that only existed while the checkbox was checked would still need per-frame geometry writes; recreating the `LineSegments`/`BufferGeometry`/`Material` object graph itself on every toggle only adds GC churn for no benefit. Instead: allocate the object once (hidden, `visible = false`) when the debug GUI module loads, toggle only `visible`, and gate the per-frame geometry refill on an `enabled` flag so it costs nothing while off.
2. **No separate "grid boundary" line.** Because the grid is dynamically sparse and unbounded, "grid boundaries" is interpreted as *the boundaries of each occupied cell*, per the user's own second sentence ("visualize the boundaries of the grid and each cell"). The union of per-cell wireframe boxes already conveys the occupied extent; no additional bounding box is drawn.
3. **Oversized members are not visualized** in this plan (no cell to draw for them). Flagged as a possible future extension, not required scope.
4. **Per-frame update via an ECS system, not a poll.** The existing stats/histogram readout in `_dbg__SpatialGrid.ts` refreshes via `setInterval(refreshStats, 500)`, which is fine for text but would make a moving wireframe visibly lag/pop for anything crossing cell boundaries within that window. Since `SpatialIndexSystem.ts` already wires the grid into the ECS via `ECSWorld.registerPlugin`, the visualizer refill is added the same way: a debug-only system registered on `ECSSystemStage.LATE_MAIN` (after the grid's own `APP_POST_PHYSICS` rebuild), no-op unless the visualizer is enabled for the active world.

## Engine-side gaps to close first

`SpatialGrid.ts` currently has no way to enumerate occupied cells' world-space bounds — required, new, additive API:

- A public getter for `cellSize` (currently a private field with no accessor).
- A method to enumerate occupied cells as world-space AABBs, e.g. `getOccupiedCellBoundsInto(out: Float32Array): number` — unpacks each key in the private `cellKeyToIndex` map back to `(cx, cy, cz)` (inverse of the existing `_packCellKey`), converts to a min corner via `cellSize`, and writes 6 floats (min + max) per cell into a caller-provided/grown `Float32Array`, returning the cell count. Caller-provided buffer avoids per-frame allocation, matching the typed-array style already used throughout `SpatialGrid.ts`.

## Phases

### Phase 1 — Engine API (additive, non-breaking)

- Add `SpatialGrid.cellSize` getter.
- Add `SpatialGrid.getOccupiedCellBoundsInto(out: Float32Array): number` (grows/replaces the caller's buffer reference if too small, same convention as `PhysicsRapier.ts`'s debug-mesh buffer growth).
- No behavior change to existing consumers. Verify manually via the existing "Live stats" panel (occupied cell count should match the number of AABBs returned).

### Phase 2 — Wireframe object + per-frame refill

- In `_dbg__SpatialGrid.ts`: one `createLines({ ... })` call (p058), `id: 'SPATIAL_GRID_DEBUG_VISUALIZER'`, created once and `visible: false` by default. Pre-size `capacity` to `expectedCells * 12` segments and use `growth: 'FIXED'` so a per-frame refill with a known ceiling never reallocates mid-frame. `frustumCulled` stays at its default `false`, which is what a refilled line needs.
- **Use the `THIN` backend** (`backend: 'THIN'`). Occupied-cell counts can run into the tens of thousands (see Risks); as instanced quads that would be 12N instances rather than 12N line primitives. Thickness is not worth that here.
- Add a debug-only ECS system registered on `ECSSystemStage.LATE_MAIN` (gated by `IS_DEBUG_ENV`, and internally no-op unless the visualizer is enabled for that world) that calls `getSpatialGrid(world).getOccupiedCellBoundsInto(...)` and refills via `beginWrite()` + `writeBox3Edges`/`writeBoxEdges` per AABB + `endWrite()`. p058's core system does **not** refill geometry for anyone — the refill cadence stays owned here.
- Color is `lines.setColor()`, a uniform write, so the color picker (Phase 3) updates live with no geometry rebuild. No material handling needed in this plan.

### Phase 3 — Tweakpane UI

- In the existing "Spatial index" tab, add a "Visualizer" folder with:
  - Checkbox "Show grid wireframe" (default off) → toggles `visible` + `enabled` state.
  - Color picker "Wireframe color" (`view: 'color'`, default `0xff0000`) → `lines.setColor(hex)`.
- Persist both under the existing `AEK_debugSpatialGrid` local-storage key (extend `LSData` to `{ cellSize, visualizerEnabled, visualizerColor }`), following the same `lsGetItem`/`lsSetItem` pattern already used for `cellSize`.

## Non-goals

- Visualizing oversized (grid-bypassing) members.
- Any change to grid rebuild behavior, cell sizing, or query semantics — this is read-only visualization of existing state.
- Worker-threaded physics/spatial concerns (unrelated, tracked separately per `CLAUDE.md`'s physics section).

## Risks / open questions

- **Cell count spikes**: a very small `cellSize` over a large occupied area could produce a large number of boxes (12 line segments each). Since this is debug-only and gated behind an explicit opt-in checkbox, no additional guardrail is planned, but worth watching for GPU/CPU cost if occupied-cell counts run into the tens of thousands. This is why Phase 2 pins the `THIN` backend.
- ~~Confirm the correct place to source the "root scene" reference~~ — resolved by p058's `attach: { to: 'ROOT_SCENE' }`, which is the default.
