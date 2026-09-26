Status: implemented
Category: Physics
Blocked by: _DONE_p022_physics-debugger-tab.md
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Debug Drawing in Physics API — Plan

## Context

The old `PhysicsRapier.ts` debug renderer (`createPhysicsDebugMesh`/`stepperFnDebug`, ~lines 1465–1799) works by pulling Rapier's native `World.debugRender()` output — a flat line-list (`vertices: Float32Array`, `colors: Float32Array`, 2 points per line, RGBA per vertex) for the **entire world** — into one persistent `THREE.LineSegments`, re-copied wholesale into its `BufferGeometry` every debug-enabled frame. This does not scale for the new engine-agnostic Physics API: in `WORKER_THREAD` mode `World.debugRender()` requires a full-world round trip through the worker every frame for data the user only wants for a handful of objects at a time, and a single world-spanning line-soup mesh is exactly what the user has asked to avoid ("Turning the debug drawer on/off for the whole physics world should not be implemented as it would choke everything in a larger scene/world").

The new API already has a `debugRender()` hook in its interface (`WorldAPI.debugRender()`, `Physics/PhysicsAPITypes.ts:1008`; implemented only for `MAIN_THREAD` in `EngineRapier.ts:534,597`; `WorldProxyAPI.debugRender()` in `PhysicsAPI.ts:1007` currently throws for `WORKER_THREAD`). This plan does **not** wire that method up — it is the same "whole-world line soup" shape as the old system and isn't the right primitive for a per-entity, opt-in visualizer. Instead this plan builds per-collider wireframes from data the API can already mostly provide.

Two facts about the existing `ColliderAPI`/`RigidBodyAPI` surface (`Physics/PhysicsAPITypes.ts:402-482`, `~221-370`) drive the design:

1. **Primitive shapes need no new data channel at all.** `ColliderAPI.shapeTypeSync()/shapeType()`, `.radiusSync()/.radius()`, `.halfExtentsSync()/.halfExtents()`, `.halfHeightSync()/.halfHeight()` already exist (sync on `MAIN_THREAD`, async RPC on `WORKER_THREAD`) and fully describe every non-mesh Rapier shape (`Ball`, `Cuboid`, `Capsule`, `Cylinder`, `Cone`, `RoundCuboid`, `RoundCylinder`, `RoundCone`, `HalfSpace`). Three.js already ships parametric geometries for every one of these (`SphereGeometry`, `BoxGeometry`, `CapsuleGeometry`, `CylinderGeometry`, `ConeGeometry`, `PlaneGeometry` for `HalfSpace`), so wireframes for the overwhelming majority of colliders in practice can be built purely client-side from data already fetchable today.
2. **Mesh-type shapes are a real gap.** `TriMesh`, `ConvexPolyhedron`, `Polyline`, `HeightField`, `Voxels` have no vertex/index/height accessor anywhere on `ColliderAPI` — the raw data only exists inside the live Rapier shape object (`this.coll.shape` in `EngineRapier.ts`'s `EngineColliderProxyAPI`, e.g. `radiusSync()`/`halfExtentsSync()` read `(this.coll.shape as any).radius` today, `~1487-1517`). This is genuinely new, additive API surface.

There's also a live-state problem the user's own phrasing points at ("awake/active = red, sleeping = dark red…") that's harder than it looks in `WORKER_THREAD` mode: `RigidBodyAPI.isSleepingSync()/isFixedSync()/isKinematicSync()/isEnabledSync()` (`PhysicsAPITypes.ts` ~line 516-610) are implemented for `MAIN_THREAD` but **throw** on the worker-mode proxy (`RigidBodyProxyAPI` in `PhysicsAPI.ts`, confirmed by reading the class body — every one of these `*Sync` methods throws `'... not supported in Worker thread mode'`; only the async RPC versions work). Polling that per-frame per debug-enabled entity via `messageWorkerAsync` would reintroduce exactly the per-object round-trip cost this plan exists to avoid. The engine already solved this same problem once for position/rotation: `Physics/PhysicsTransformBuffer.ts` is a hot-path typed-array buffer, either a real `SharedArrayBuffer` (zero-copy, always current) or, as a fallback, one batched `Transferable` `ArrayBuffer` pushed per step (`PhysicsProtocolType.TRANSFORMS_PUSH = 102`, `physicsWorker.ts`'s `writeBackTransforms()`). This plan reuses that exact blueprint for sleep/kinematic/enabled state — but as a **separate, lazily-created buffer**, not by growing the existing transform buffer, because `p024_interpolation-in-the-physics-api.md` (draft, not-implemented) is independently planning to double-buffer that same struct; coupling a debug-only feature into its field layout would create unnecessary cross-plan contention.

Finally, `p022_physics-debugger-tab.md` (draft, not-implemented, this plan's blocker) already designs the physics-object entity list and per-entity edit window (`createEditPhysObjContent`-style draggable window, resolved by ECS entity id) that this plan's "show wireframe" toggle and per-entity color overrides hang off of, and explicitly lists "wiring a real 3D visualizer for `debugRender()`" as **out of scope** for itself — this plan is that deferred follow-up, done the scalable way instead of by finishing the `debugRender()` wiring.

## Design decisions

1. **Per-entity opt-in, not a world toggle.** No global physics-visualizer switch is added anywhere (CONFIG, tab, or otherwise). Visibility is a new ECS component, `CoreType.DEBUG_PHYSICS_WIREFRAME` (added in `ECSRegistry.ts`/`ECSCoreComponents.ts`, alongside the existing `DEBUG_LIGHT_HELPER`/`DEBUG_SYMBOL` precedent), default absent (= off) on every physics entity. Adding/removing this component is the toggle — driven from the entity edit window's new "Show wireframe" checkbox (p022's window), or programmatically.
2. **One wireframe `LineSegments` per collider, built once, not rebuilt per frame.** Collider shape/size essentially never changes after creation. On `DEBUG_PHYSICS_WIREFRAME` add (via `ECSWorld.registerComponentHooks`, mirroring the Light debug hook pattern), for each `ColliderAPI` on the entity: fetch shape type + dimensions (existing sync/async getters; for mesh-type shapes, the new accessors from Design decision 3) once, build a `THREE.BufferGeometry` with the matching parametric Three.js geometry (or straight from vertex/index data for mesh shapes), wrap it in `THREE.EdgesGeometry`/`THREE.WireframeGeometry` → `THREE.LineSegments`, cache it. On component removal, dispose geometry/material and remove from scene. No per-frame geometry rebuilds, ever.
3. **New additive `ColliderAPI` accessors for mesh-type shapes only.** Add `verticesSync()/vertices()`, `indicesSync()/indices()` (`TriMesh`/`ConvexPolyhedron`/`Polyline`), `heightsSync()/heights()` (`HeightField`) to the `ColliderAPI` interface (`PhysicsAPITypes.ts`), implemented in `EngineRapier.ts`'s `EngineColliderProxyAPI` by reading `this.coll.shape.vertices`/`.indices`/`.heights` off the live WASM shape (same pattern already used for `radiusSync`/`halfExtentsSync`), and as new `COLL_VERTICES`/`COLL_INDICES`/`COLL_HEIGHTS` messages appended to the existing `COLLIDER` protocol range (600–799) for `WORKER_THREAD` mode, handled in `physicsSwitchColl.ts` alongside the existing `COLL_SHAPE_TYPE`/`COLL_HALF_EXTENTS` cases. These arrays are sent as `Transferable` typed arrays (unlike the current RPC responses, which rely on structured clone) since mesh data can be large — but this only happens once per collider, on-demand, the moment its wireframe is first requested; never per-frame.
4. **Per-frame *state* (sleeping/kinematic/enabled), not per-frame *geometry*, is what needs a live channel — and only when at least one entity is being visualized.** Add a small, separate `PhysicsDebugStateBuffer` (own module, mirroring `PhysicsTransformBuffer.ts`'s structure: one packed float of bitflags per rigid-body slot — bit 0 sleeping, bit 1 enabled, bit 2 kinematic — plus per-collider enabled/sensor flags, indexed the same way the transform buffer indexes bodies). It is **not allocated or written at all until the first `DEBUG_PHYSICS_WIREFRAME` component is added** (a new one-shot protocol message tells the worker to start/stop populating it, e.g. appended to the `WORLD` range after `WORLD_SET_CCD_SUBSTEPS`), and stops being written once the last one is removed. Transport mirrors the transform buffer exactly: real `SharedArrayBuffer` when available, otherwise one batched `Transferable` push per step (new unsolicited protocol type alongside `TRANSFORMS_PUSH`, e.g. `DEBUG_STATE_PUSH`). On `MAIN_THREAD`, this buffer isn't needed at all — the existing `*Sync` state getters are already free — so the buffer/protocol only exists for `WORKER_THREAD` mode. This keeps the "always-on" cost of the feature at exactly zero when no entity is being visualized, and O(1) reads per visualized entity per frame otherwise (no RPC).
5. **Attach wireframes to the Three.js scene graph wherever possible; only sync manually where there's no `Object3D` to piggyback on.** For `BODY_DYNAMIC_VISUAL` entities, the wireframe `LineSegments` is added as a child of the entity's existing `Object3D`, offset by the collider's local `translationWrtParent`/`rotationWrtParent` (fetched once, same as shape). Three.js's own scene graph then keeps it positioned every frame for free — no engine code needed. For `BODY_STATIC` (never moves — set the transform once at creation, done) and `BODY_DYNAMIC_HEADLESS` (has no `Object3D`, but can move), a small debug-only Three.js `Object3D` is created to host the wireframe and added directly to the root scene; only the `BODY_DYNAMIC_HEADLESS` case needs a per-frame sync, done by a new debug-only ECS system (mirroring `PhysicsManager.ts`'s `physicsToTransformSystem`, but iterating only the — by construction small — `DEBUG_PHYSICS_WIREFRAME` storage, registered on `ECSSystemStage.APP_RENDER_SYNC`, gated behind `IS_DEBUG_ENV` and a no-op when the storage is empty).
6. **Color state, resolved client-side per collider, not read from Rapier's own debug colors.** Since this plan doesn't use `debugRender()`, Rapier's internal color choices are irrelevant — colors are computed by this plan's own state → color mapping, evaluated once per state change (not per frame; the update system only touches `material.color` when the packed state actually differs from the cached last-seen value for that collider). Priority order, highest wins, matching the user's four named states plus two additions:
   - **disabled** (dark grey) — collider `isEnabled() === false` OR its owning rigid body `isEnabled() === false`.
   - **sensor** (dark yellow) — `collider.isSensor() === true`. Checked before sleep state since sensor is a shape property, not a simulation state, and is usually the most important thing to notice at a glance.
   - **sleeping** (dark red) — owning rigid body `isSleeping() === true`. Only meaningful for dynamic bodies.
   - **kinematic** (new — suggest blue) — owning rigid body `isKinematic() === true`. `PhysicsManager.createPhysicsEntity` buckets any non-`FIXED` rigid body (including kinematic ones) into `BODY_DYNAMIC_VISUAL`/`HEADLESS` alongside real dynamic bodies, so without a distinct color, kinematic (programmatically driven, never sleeps, unaffected by forces) bodies would be visually indistinguishable from awake dynamic ones — a real debugging foot-gun this plan can close for free.
   - **fixed / static** (new — suggest light grey/white) — `BODY_STATIC` bucket. Distinct from "disabled" (dark grey) so a deliberately-static collider doesn't read as "something's wrong with this."
   - **awake / active** (red) — default: dynamic, enabled, not sleeping, not a sensor.
7. **Colors and line thickness are configurable in three places, per the user's spec.** (a) `CONFIG.ts` defaults, new `physics.debug.wireframe: { colors: {...}, lineThickness: number }` nested under the existing `physics` section (mirroring `Config.ts`'s existing flat-optional-field convention, e.g. alongside `useSAB`/`maxBodies`). (b) A "Wireframe" folder inside p022's planned Physics API debugger tab (`_dbg__PhysicsAPI.ts`) with one color picker per state + a "Reset" button underneath each (exact pattern already established by `_dbg__SkyBox.ts:156-188`: plain proxy object for the Tweakpane `view: 'color'` binding, `.on('change', ...)` writes through + persists to a dedicated LS key, `addButton({ title: 'Reset' })` writes the `CONFIG.ts` default back and calls `pane.refresh()`), plus a thickness slider with its own reset button. (c) Per-entity color overrides in the edit window (extending p022's planned `createEditPhysObjContent`): one color picker per state, empty/unset by default (falls back to the global tab value), with its own "Reset to default" button per picker that clears the per-entity override.
8. **Configurable line thickness — feasibility-gated.** `THREE.LineBasicMaterial.linewidth` is ignored by essentially every modern graphics backend (a GL/D3D/Metal/Vulkan-level limitation, not WebGL-specific), including this project's `THREE.WebGPURenderer` (`Renderer.ts:56`). Three.js's "fat lines" module (`LineSegments2`/`LineSegmentsGeometry`/`LineMaterial`, currently unused anywhere in this repo) is the standard workaround and is expected to work with `WebGPURenderer` on this project's `three@0.183.2`, but this needs a small feasibility spike before being relied on — see Phase 6. If it doesn't pan out cleanly, thickness silently falls back to a fixed 1px `LineBasicMaterial` and the config/UI field is kept (for forward-compat) but a one-time console warning notes it has no visible effect.
9. **Per-entity persistence is best-effort.** Debug wireframe visibility/color overrides persist to LS keyed by the entity's `appId` (`CoreEntityOpts.appId`) when the app gave the entity one at creation; physics entities created without an explicit `appId` get an auto-generated UUID (`ECS.ts:446-447`) that is **not** stable across reloads, so their per-entity debug settings are session-only. This is an accepted, documented limitation (physics entities aren't scene-JSON-authored yet, per `CLAUDE.md`), not something this plan fixes.

## Engine-side gaps to close first (Phase 1, additive/non-breaking)

- `Physics/PhysicsAPITypes.ts`: add `verticesSync()/vertices()`, `indicesSync()/indices()`, `heightsSync()/heights()` to `ColliderAPI`; new `COLL_VERTICES`/`COLL_INDICES`/`COLL_HEIGHTS` entries in `PhysicsProtocolType`; new `WORLD_*` pair to enable/disable debug-state tracking; new unsolicited `DEBUG_STATE_PUSH` push type alongside `TRANSFORMS_PUSH`.
- `Physics/EngineRapier.ts`: implement the three new sync getters on `EngineColliderProxyAPI` by reading `this.coll.shape.vertices`/`.indices`/`.heights`.
- New `Physics/PhysicsDebugStateBuffer.ts`: packed-bitflag buffer, same SAB/`Transferable`-fallback resolution as `PhysicsTransformBuffer.ts`, allocated lazily on first enable.
- `workers/physicsWorker.ts` / `workers/physics/physicsSwitchColl.ts`: wire the new message handlers; extend `writeBackTransforms()` (or a sibling function) to also populate the debug-state buffer per step, but only while tracking is enabled.
- `PhysicsAPI.ts`: `ColliderProxyAPI` async wrappers for the three new getters (`WORKER_THREAD`); module-level tracking of the debug-state buffer, mirroring the existing `transformBuffer` variable/`onWorkerMessage` handling for `TRANSFORMS_PUSH`.
- No behavior change for any existing consumer — purely additive; zero cost unless a debug wireframe is actually toggled on.

Manual verification: from the browser console (`?isDebug=true`), create a `TriMesh`/`ConvexPolyhedron` collider and confirm `collider.vertices()`/`.indices()` return sane typed arrays in both `MAIN_THREAD` and `WORKER_THREAD` configs; call the new enable/disable debug-state-tracking messages directly and confirm the buffer populates only while enabled and `writeBackTransforms()`'s per-step cost is otherwise unaffected (no allocation, no extra postMessage) while disabled.

## Phases

**Phase 1 — Engine API additions.** Per "Engine-side gaps to close first" above. No rendering, no UI yet.

**Phase 2 — CONFIG.ts + AppConfig wireframe defaults.** Add `physics.debug.wireframe: { colors, lineThickness }` to `Config.ts`'s `AppConfig` type and default `config` object, and to `CONFIG.ts`. Manual verification: `tsc --noEmit` clean; confirm the new defaults are readable via the existing config-loading path.

**Phase 3 — Wireframe build/attach module.** New `src/_engine/core/Debug/_dbg__PhysicsDebugDraw.ts` (+ thin wrapper if any public entry point is needed, though this is expected to be driven entirely by ECS component hooks rather than direct calls): shape → `THREE.BufferGeometry` builders for every `ShapeType` (parametric Three.js geometries for primitives per Design decision 1/2; vertex/index/height-driven geometry for mesh types using Phase 1's new accessors); `DEBUG_PHYSICS_WIREFRAME` component type + `ECSWorld.registerComponentHooks` (create wireframe(s) + attach per Design decision 5 on add, dispose + detach on remove); color-state resolution (Design decision 6) driven by a per-frame system reading `RigidBodyAPI`/`ColliderAPI` state directly on `MAIN_THREAD`, or the new `PhysicsDebugStateBuffer` on `WORKER_THREAD` (enabling/disabling tracking as the `DEBUG_PHYSICS_WIREFRAME` storage goes from empty ↔ non-empty); the headless-body transform-sync system (Design decision 5). Entirely lazy-loaded/tree-shaken via the `_dbg__` + `IS_DEBUG_ENV` pattern — verify with a `yarn build` bundle-stats check that none of this ships in a production bundle. Manual verification: toggle the `DEBUG_PHYSICS_WIREFRAME` component directly (console) on a few entities covering `BODY_STATIC`/`BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS` and a couple of shape types including at least one mesh-type collider; confirm correct wireframe shape/position/color and correct color transitions on sleep/wake and enable/disable, in both `MAIN_THREAD` and `WORKER_THREAD` configs.

**Phase 4 — Global "Wireframe" tab section.** Inside p022's planned `_dbg__PhysicsAPI.ts` tab, add a "Wireframe" folder: one color picker + Reset button per state (Design decision 7b), a line-thickness field + Reset button, persisted to a dedicated LS key. Manual verification: change each color/thickness, confirm it live-updates any currently-visible wireframes; confirm each Reset button restores the `CONFIG.ts` default and refreshes the pane.

**Phase 5 — Per-entity edit window additions.** Extend p022's planned entity edit window: "Show wireframe" checkbox (adds/removes `DEBUG_PHYSICS_WIREFRAME`), per-state color override pickers (unset by default, falls back to the Phase 4 global value) with individual "Reset to default" buttons, persisted per Design decision 9. Manual verification: toggle visibility and per-entity color overrides from the edit window on a couple of entities, confirm they don't affect other entities' colors, confirm reload behavior matches Design decision 9 (survives reload only for entities created with an explicit `appId`).

**Phase 6 — Fat-line thickness (feasibility-gated).** Spike `LineSegments2`/`LineSegmentsGeometry`/`LineMaterial` against this project's `THREE.WebGPURenderer` setup. If it works cleanly: swap the wireframe material from `LineBasicMaterial` to `LineMaterial` and wire the Phase 4 thickness field to it. If not: keep `LineBasicMaterial`, make the thickness field a documented no-op with a one-time console warning (Design decision 8). Manual verification: visually confirm line thickness changes (or confirm the graceful fallback + warning) in both `?isDebug=true` and `?isProdTest=true`.

## Non-goals

- **Wiring `WorldAPI.debugRender()` / a whole-world line-soup mesh.** Deliberately not used — see Context. `visualizerEnabled` (already present in `PhysicsState` for parity, per p022) remains a no-op; this plan does not touch it.
- **A global physics-debug-visualizer on/off switch.** Explicitly ruled out by the user; visibility is always per-entity.
- **Physics entities gaining scene-JSON authoring / stable `appId`s.** Out of scope; Design decision 9's persistence limitation is accepted as-is.
- **Any change to simulation behavior.** This is a read-only visualization layer; no `ColliderAPI`/`RigidBodyAPI` setter is added or changed.
- **Touching the legacy `PhysicsRapier.ts` debug renderer.** Continues to coexist untouched, same as p022's stance on the legacy tab.

## Risks / open questions

| Risk / question | Notes |
|---|---|
| `LineSegments2`/`LineMaterial` compatibility with `THREE.WebGPURenderer` on `three@0.183.2` is unverified | Phase 6 is explicitly feasibility-gated with a graceful 1px fallback; does not block Phases 1–5. |
| Mesh-type shape wireframes (`TriMesh`/`ConvexPolyhedron`) can be large (thousands of edges) | Built once per collider on opt-in, not per frame, and it's an explicit user action per entity — no automatic/bulk enabling is provided, so cost stays bounded by how many the user turns on. |
| `PhysicsDebugStateBuffer` add/remove-driven enable/disable could thrash if a user rapidly toggles wireframes on/off across many entities | Debounce the enable/disable protocol message (e.g. only (re)send when the "any wireframe visible" boolean actually flips), not per individual component add/remove. |
| Per-entity color-override persistence is unreliable for entities without an explicit `appId` | Accepted limitation (Design decision 9), consistent with the rest of the debug tooling's current entity-identity constraints. |
| This plan is blocked by p022, which is itself not yet implemented | Phases 1–3 (engine gaps + geometry/attach module) have no UI dependency on p022 and could be implemented first if useful, but Phases 4–5 need p022's tab/edit-window shells to exist. |

## Verification

- `tsc --noEmit` and `yarn lint` clean after every phase (per the repo's Stop hook).
- Phase 1: console-level checks per its own manual verification above.
- Phase 2: type-check only.
- Phase 3: visual + cross-thread-mode wireframe correctness walkthrough (the bulk of the feature's real verification).
- Phase 4/5: Tweakpane UI walkthrough, including all Reset buttons.
- Phase 6: visual thickness check or confirmed graceful fallback.
- Throughout: a plain `yarn build` bundle-stats diff confirming none of `_dbg__PhysicsDebugDraw.ts` (or its color/geometry logic) appears in the production chunk.


## Implementation notes (what actually shipped)

The Context/Design sections above are the record of what was *planned*; this section
records where the implementation diverged, so anyone reading this as reference for a
follow-up plan doesn't inherit the wrong assumptions.

### Corrections to the design above

- **Design decision 1 is wrong about primitives being fully described by the existing
  getters.** `HalfSpace` needs `.normal` (a plane with no orientation is undrawable) and
  the `Round*` shapes need `.borderRadius`; neither had an accessor. Both were added in
  Phase 1 alongside the three the plan listed.
- **`heights()` returns a `HeightFieldData` object, not a raw array.** A bare
  `Float32Array` can't reconstruct the surface — Rapier stores `nrows`/`ncols`/`scale`
  separately.
- **`vertices()` also covers `Segment`/`Triangle`/`RoundTriangle`.** Rapier's JS layer
  rebuilds those as separate `a`/`b`/`c` Vector fields rather than a vertex buffer;
  `EngineColliderProxyAPI.verticesSync()` flattens them so one accessor serves every
  vertex-based shape. These three weren't mentioned in the plan at all.
- **`ConvexPolyhedron` built from an auto-computed hull *does* get an index buffer back**
  (`Shape.fromRaw` reads `coIndices` off WASM regardless), so the "no indices" fallback
  the plan worried about never triggers in practice.
- **`Voxels` is the only unsupported shape.** Its `data`/`voxelSize` fit none of the
  accessors; the builder skips it with a one-time console warning naming the shape type.
- **`p024` did not double-buffer `PhysicsTransformBuffer`** (it put interpolation in
  `physicsInterpolationSystem` on the main thread instead), so the plan's stated reason
  for a separate debug buffer no longer held. A separate buffer was still the right call,
  for its lazy allocation.

### Protocol / buffer design

- `SET_DEBUG_STATE_TRACKING = 5` lives in the **ENGINE** range, not the `WORLD` range the
  plan suggested: `physicsSwitchWorld` receives only `physicsWorldAPI` + `sendMessage`, so
  a `WORLD_*` number would route somewhere with no access to `engAPI` or the buffers.
  `DEBUG_STATE_PUSH = 104` sits beside `TRANSFORMS_PUSH`/`EVENTS_PUSH`;
  `COLL_VERTICES`/`INDICES`/`HEIGHTS`/`NORMAL`/`BORDER_RADIUS` are `637`-`641`.
- **Tracking is an explicit id set, not "all bodies".** The main thread sends exactly the
  `{rigidBodyIds, colliderIds}` it's visualizing and **array position is the slot**, which
  needs no allocator on either side (the plan's "indexed the same way the transform buffer
  indexes bodies" doesn't work — colliders have no transform slot). Flushes are coalesced
  to once per frame in the render system, which is what resolves the "toggle thrash" risk.
- A `VALID` bit gates every read, so the frame between a tracking change and the worker's
  next write leaves colors untouched instead of painting a wrong one.
- The worker **copies mesh arrays before transferring** them — the getters return the live
  Rapier shape's buffers, and transferring those would neuter the running simulation.

### Config and persistence

- Config lives at **`AppConfig.debugPhysicsWireframe`** (top level, beside the existing
  `debugKeys`/`debugCamera`), not nested under `physics`. `initPhysics()` spreads
  `AppConfig.physics` into `PhysicsState` and posts it to the worker, so anything under
  `physics` would cross the worker boundary.
- `Config.ts` declares the **types only** — the default color values live in
  `_dbg__PhysicsDebugDraw.ts` so no color table ships in a production bundle. Resolution
  is per-key, because `loadConfig()` merges shallowly and a partial app override would
  otherwise leave the rest undefined.
- Three LS keys, deliberately separate: `AEK_debugPhysicsApiWireframe` (global palette),
  `AEK_debugPhysicsApiEntities` (per-entity), `AEK_debugPhysicsApiUI` (folder open/closed
  state — kept apart so "Reset all wireframe settings" doesn't collapse the folder you're
  working in). "Clear tab LS" clears all of them plus `AEK_debugPhysicsApi`.
- **Per-entity color overrides live in a module map, not on the component.** The component
  *is* the visibility toggle, so reading overrides off it would discard them every time a
  wireframe was hidden. The component's `colorOverrides` field seeds the map on add.
- Design decision 9's persistence test is **`APP_ID.isFixed`** (`ECS.ts` sets it to
  `Boolean(opts?.appId)`), which is an exact signal rather than a heuristic. Entities
  without a stable id now say so in the edit window ("Session only (entity has no appId)")
  instead of silently not saving. `src/app/physicsTest.ts`'s sensor entity was given an
  explicit `appId` for this reason.

### Rendering

- Three attach cases, not the plan's two: has an `OBJECT3D` -> child of it (covers both
  dynamic-visual and static-with-mesh); `BODY_DYNAMIC_HEADLESS` -> root-scene host synced
  per frame; static with no `OBJECT3D` -> root-scene host with the collider's world pose
  baked in once.
- **Parent scale is divided out** of both the wireframe's offset and its size, re-applied
  each frame. `createPhysicsEntity` copies the ECS transform's scale onto the `Object3D`,
  but collider dimensions are unscaled physics space, so a scaled mesh would otherwise
  stretch its own collider wireframe.
- Flat-faced shapes use `EdgesGeometry` (face diagonals are noise); curved ones use
  `WireframeGeometry` on deliberately low-segment geometry.

### Phase 6 outcome: fat lines work

Three ships a **WebGPU-native** fat-line variant —
`three/examples/jsm/lines/webgpu/LineSegments2.js` backed by `Line2NodeMaterial`, typed by
`@types/three`. Unlike the WebGL `LineMaterial` this plan anticipated, it derives
screen-space width from the viewport directly, so there is **no `resolution` uniform to
keep in sync with canvas resizes**. Thickness changes are a uniform write: no geometry
rebuild, no shader recompile. The modules are dynamically imported on first use and both
the import and the construction are guarded, so the 1px `LineBasicMaterial` fallback plus
one-time console warning happens automatically rather than being a manual decision.

**Accepted cost:** this adds **12.7 KB raw / 3.7 KB gzipped** to the production bundle
(3,580.95 -> 3,593.68 kB; 1,201.06 -> 1,204.82 kB gzipped), confirmed by a stash-and-rebuild
diff. `Line2NodeMaterial` lives inside `three/webgpu`, which is in the always-shipped
shared chunk, so referencing it from anywhere — even a lazily-imported debug-only chunk —
stops Rollup tree-shaking it and its TSL node graph out. This is the one exception to the
Verification section's "nothing from this feature in the production chunk" rule, signed off
by the user. Everything else honours it: `_dbg__PhysicsDebugDraw.ts` (10.74 kB) and the two
fat-line addon modules all split into lazy chunks, and the production chunk has zero hits
for any wireframe logic.

> **Amended by [_DONE_p058_line-rendering-system.md](./_DONE_p058_line-rendering-system.md)
> (2026-09-26):** the wireframes now draw with the engine's own line system and nothing
> references `Line2NodeMaterial` any more — but that removed only **2.5 kB raw / 0.6 kB gzip**
> of this cost. Its module-level TSL graphs (`mvpLine`, `alphaLine`, …) are not
> `/*@__PURE__*/`-annotated inside `three.webgpu.js`, so they stay in the main chunk
> regardless; "referencing it stops Rollup tree-shaking its TSL node graph out" above is
> therefore only true of the class itself. See p058's Implementation notes for the numbers.
