Status: implemented
Category: Rendering
Blocks: p125_spatial-index-system-visualizer.md

# Line Rendering System — Core Engine — Plan

> **Implemented (2026-09-26).** The design below is kept as written; where the code departs
> from it, and the measured bundle result, are in **Implementation notes** at the end — read
> those first. In particular: Design decision 10 does not hold on WebGPURenderer (lines are
> tone-mapped), Design decision 1's `colorNode` argument is obsolete on three r186, and the
> bundle is a net **increase**, not a saving.

A first-class engine system for drawing line segments — usable from gameplay code, not just
debug tooling. It owns the segment buffer, the thin/thick backends, colour (static **and**
GPU-driven pulsation between N colours), attachment and disposal. Its thick-line backend is a
**custom TSL node material written in-engine**, replacing the `three/examples` fat-line addons
that `_dbg__PhysicsDebugDraw.ts` uses today.

Ships with two consumers migrated onto it: the physics collider wireframes and the raycast debug
helpers. It does **not** implement object selection, hover highlighting, or bounding-box picking —
it implements the colour-pulsation and box-outline primitives those features will stand on.

## Context (grounded in code)

### The bundle problem, correctly diagnosed

- **`_DONE_p025_debug-drawing-in-physics-api.md:188-196` recorded an accepted cost of 12.7 KB raw
  / 3.7 KB gzipped** in the production bundle, caused by `new THREE.Line2NodeMaterial({ linewidth })`
  at `_dbg__PhysicsDebugDraw.ts:724`. The measured "after" figure, 3,593.68 kB, matches the current
  `dist/assets/index-*.js` on disk byte for byte (3,593,675 B), so the baseline is live and current.
- **The cause is module granularity, not tree-shaking.** `node_modules/three/package.json` maps
  `"./webgpu"` to `"./build/three.webgpu.js"` — a **single 2,016,388-byte ES module** with exactly
  two `import` statements. `class Line2NodeMaterial extends NodeMaterial` is at line 21903 *inside
  that one file*. `node_modules/three/src/materials/nodes/Line2NodeMaterial.js` is build-time input
  to it and is never resolved by Vite. Rollup assigns **whole modules** to chunks, so every
  statement it retains in `three.webgpu.js` emits in the main chunk.
- **Named imports do not help, and the current build proves it.** `dist/assets/LineSegments2-*.js`
  begins `import{bo as O,a3 as U,...}from"./index-*.js"` and then
  `class $ extends O{constructor(e=new J,o=new U({color:...}))}` — that is `LineSegments2.js:248`'s
  `new Line2NodeMaterial(...)`. A static named import, inside an async-only module, still resolving
  out of the main chunk. `grep -c isLine2NodeMaterial` on the main chunk returns **1**.
- **Statement-level shaking inside `three.webgpu.js` does work** — `isVolumeNodeMaterial` returns
  **0**. So the 60 files doing `import * as THREE from 'three/webgpu'` are *not* causing a namespace
  deopt. The only lever is: stop referencing the class.
- **Rejected on the record, because each will look plausible to a future reader:** a named static
  import in an async module (already the graph's state, zero effect); a deep import of
  `three/src/materials/nodes/Line2NodeMaterial.js` (its 15 relative imports resolve to *different*
  module objects than the ones inside `three.webgpu.js` — a duplicated node system, broken
  `instanceof`, and *more* bytes); a `manualChunks` entry (cannot split one module; only changes
  cache granularity).

### Everything a custom TSL material needs is already shipped, for free

- `node_modules/three/build/three.tsl.js:6` is `import { TSL } from 'three/webgpu'`, and 7 files in
  `src/` import from `three/tsl` (`core/Material.ts:7`, `core/SkyBox.ts:2`,
  `utils/materials/nestedGridPattern.ts`, …). That retains the whole frozen TSL namespace object in
  the main chunk — verified: `grep -c 'Object.freeze({__proto__:null,BRDF_GGX'` → 1.
- Spot-checked against the main chunk, all present: `materialLineWidth`, `varyingProperty`,
  `screenDPR`, `viewportSize`, `cameraProjectionMatrix`, `positionGeometry`, `instanceIndex`,
  `alphaToCoverage`. **Marginal import cost of a hand-written line material ≈ 0.**
- `LineBasicNodeMaterial` is also already unconditionally in the main chunk
  (`grep -c isLineBasicNodeMaterial` → 1) because `WebGPURenderer` registers it in the standard node
  library and converts every classic `LineBasicMaterial` through it at render time
  (`three.webgpu.js:54520-54541`). `Line2NodeMaterial` is conspicuously **not** in that library —
  which is exactly why it is the one class that costs 12.7 KB.
- **Therefore the thin backend should use `LineBasicNodeMaterial` directly**, not
  `THREE.LineBasicMaterial`. Zero extra bytes, `colorNode` is first-class rather than smuggled
  through a `for...in` conversion shim, and it removes a throwaway allocation per pipeline build.
  Today `_dbg__PhysicsDebugDraw.ts:741`, `PhysicsRapier.ts:1466` and `_dbg__Raycast.ts:105` all go
  through that shim silently.

### What `LineSegments2` / `Line2NodeMaterial` actually give us, and what we don't need

- `node_modules/three/examples/jsm/lines/webgpu/LineSegments2.js` is 411 lines, of which ~300 are
  `raycastWorldUnits`/`raycastScreenSpace`/`raycast` (:54-238, :316-407) plus `computeLineDistances`
  (:274) — machinery this system explicitly does not need. The render-only core is the constructor,
  `onBeforeRender` (:303) and bounds: ~40 lines. `LineSegmentsGeometry.js` (298 lines) reduces to the
  instanced-quad template + `setPositions` + bounds: ~90 lines.
- From `Line2NodeMaterial.js`: keep the `trimSegment` Fn (:142-163), the screen-space branch of
  `vertexNode` (:165-220, :276-313), and the round-endcap branch (:401-437). **Drop** `useDash`
  entirely, **drop** `useWorldUnits` entirely (the `closestLineToLine` Fn and its vertex branch,
  :230-270, :366-398), **drop** the `transparent` → `viewportOpaqueMipTexture()` output path. That
  leaves roughly a 250-line class.
- Two traps we inherit today and shed by owning the material: it hard-sets `blending = NoBlending`
  (so an advertised `opacity` would silently not work), and its endcap antialiasing is gated on
  `useAlphaToCoverage && renderer.currentSamples > 0` (so thick lines look different with MSAA off).
- **`Line2NodeMaterial.setup()` overwrites `this.colorNode` at line 342** and only reads
  `this.lineColorNode` (declared :75, consumed :431-435). Any pulsation built on `colorNode` would
  silently do nothing on the current fat path. Owning the material removes this hazard entirely.

### Refill-per-frame is a hard requirement, and the addon is hostile to it

`LineSegmentsGeometry.setPositions()` (`:97-125`) allocates a fresh `InstancedInterleavedBuffer` plus
two `InterleavedBufferAttribute`s **and** calls `computeBoundingBox()` + `computeBoundingSphere()` on
*every* call. `p125_spatial-index-system-visualizer.md:42` needs exactly the opposite — "create once,
hidden, toggle `visible`, gate the per-frame geometry refill on an `enabled` flag so it costs nothing
while off" — over potentially tens of thousands of cells (its own risk note, :61). The core API must
write into a retained array and flip `needsUpdate`, never re-wrap.

Draw range is free to vary per frame: `Renderer.js:3366` re-reads `geometry.drawRange` and
`RenderObject.js:571` re-reads `geometry.instanceCount` on every draw. No pipeline invalidation.

### Repo-side constraints

- No engine-wide elapsed-time provider exists. `MainLoop.ts` computes
  `delta = dt * playSpeedMultiplier` at `:135`, `:193` and `:231` (three loop variants); three's
  `Timer` is at `:24` but `getElapsed()` is never called. TSL's `time` node is renderer wall-clock —
  it ignores both `playSpeedMultiplier` and the `masterPlay` pause, so it cannot drive a pulse that
  freezes with the loop.
- `ECSRegistry.ts:1` forbids local imports in that file. Component payloads go in
  `ECSCoreComponents.ts`; storage auto-allocates from `ECS.ts:282-291`.
- TSL typings are locally patched in `src/_engine/types/three-node-material-helpers.d.ts` — the place
  for any augmentation this work needs.
- No TS path aliases; relative imports only. No test framework. The Stop hook runs `yarn lint` + `tsc`.

## Design decisions

1. **Write our own thick-line node material in `_engine`; drop the `three/examples` dependency.**
   Do not sell this on the bundle: net saving is ~9-10 KB raw / ~2.5-3 KB gz (12.7 KB out, ~3 KB of
   our own in) — noise on a 1.2 MB gzipped bundle. Sell it on the four things that actually matter:
   we own `colorNode` (which the pulsation requires and which `Line2NodeMaterial` refuses to yield);
   the lazy-import + try/catch + warn-once "the feature might not exist" degradation path at
   `_dbg__PhysicsDebugDraw.ts:656-691, 708-737` disappears, and a *core* system should not have a
   silently-absent mode; we shed the `NoBlending` and MSAA-dependent-antialiasing traps; and we stop
   shipping ~300 lines of raycasting machinery we never call.

2. **Two backends, both engine-owned, chosen at creation.**
   `THIN` = `THREE.LineSegments` + `LineBasicNodeMaterial` — free, already in the bundle, and the
   cheapest path for very large segment counts (p125's grid is 12 segments × N cells; as instanced
   quads that is 12N instances). `FAT` = our `LineNodeMaterial` + an instanced segment geometry + a
   minimal `Mesh` subclass. Selection is `AUTO` (THIN at width ≤ 1, FAT above), or pinned with
   `backend: 'THIN' | 'FAT'`.

3. **The FAT backend lives in its own module, dynamically imported.** Because we own it, it splits
   cleanly — it depends only on TSL symbols already in the main chunk. A thin-only app ships **zero**
   extra bytes. `preloadFatLineBackend(): Promise<boolean>` is the opt-in for callers that need
   width > 1 correct on the first rendered frame; otherwise a line starts THIN and upgrades when the
   import resolves. **Say this out loud in the API docs** — width can never be honoured synchronously
   without a static import, which would defeat this decision.

4. **One byte layout for both backends: a single `Float32Array`, 6 floats per segment, `xyzxyz`.**
   That is simultaneously what `LineSegmentsGeometry.setPositions()` wants, what a non-indexed
   `LineSegments` position attribute wants, and what `WireframeGeometry`/`EdgesGeometry` already
   produce. Builders, the refill path, and a backend swap (a pointer hand-over, no copy) are all
   backend-agnostic because of it.

5. **Refill is first-class and allocation-free.** `beginWrite()` returns a reusable cursor with its
   position reset; `endWrite()` flips `needsUpdate` and sets the draw range (`setDrawRange(0, n*2)`
   for THIN, `geometry.instanceCount = n` for FAT). Capacity is pre-allocated;
   `growth: 'GROW' | 'FIXED'` decides whether an overflow doubles the buffer (a startup-time
   reallocation) or is dropped with a one-time warning (what a per-frame refill with a known ceiling
   wants). Never shrinks.

6. **Colour is GPU-side, driven by one engine-owned time uniform.**
   `lineTimeUniform` is written **once per frame, globally** from a new `getElapsedTime()`. Per-object
   CPU cost of pulsation is therefore zero regardless of how many lines pulse — the property that
   justifies the GPU path over a per-object CPU lerp. Because the uniform is fed from
   `delta = dt * playSpeedMultiplier`, pulses scale with play speed and freeze on `masterPlay` pause
   for free; TSL's `time` node could not do either.

7. **Single colour authority.** `setColor(c)` is defined as *a pulse with one colour and speed 0* —
   it writes the same uniform set the pulse reads. There is never a second writer, so the physics
   wireframe's state-driven `setColor` and a future selection pulse cannot fight. This matters:
   `_dbg__PhysicsDebugDraw.ts:1016-1019` deliberately elides writes when the state is unchanged
   (`cw.lastState`, invalidated by `repaintAllWireframes` at :944-953), and a competing per-frame
   colour writer would have silently defeated that gate.

8. **Pulse blend maths.** For `N` colours, `speed` in cycles/sec, `phase` in [0,1):
   `t = phase + elapsed*speed`, `u = fract(t)*N`, `i = floor(u)`, `k = ease(u-i)`,
   `out = mix(colors[i], colors[(i+1) mod N], k)`. Easings: `LINEAR` (`k`), `SMOOTH`
   (`k*k*(3-2k)`, the default — C¹ across stops so the cycle reads continuous), `SINE`
   (`0.5-0.5*cos(k*PI)`). `mode: 'CYCLE'` (default, wraps N-1 → 0) or `'PING_PONG'`
   (`1-|1-2*fract(t/2)|` over N-1 arcs). `autoPhase: true` derives `phase` from a hash of the line's
   id, so a hundred boxes shimmer instead of strobing in unison.
   **v1 caps the palette at `LINE_PULSE_MAX_COLORS = 4`** — four colour uniforms plus a count, with a
   `select` chain, giving one pipeline shape for every N ≤ 4 and no texture binding. Raising the cap
   is a constant change; the general form (a 1×N `DataTexture` LUT with `RepeatWrapping` and linear
   filtering, sampled at the eased coordinate) is recorded as the extension path, not built.
   Blending is in the working colour space (linear-srgb) — not configurable in v1.
   STATIC and PULSE are separate node graphs, so a static line gets the trivial shader.

9. **Attachment policy stays with the caller.** The core exposes
   `{ to: 'ROOT_SCENE' | 'PARENT' | 'ENTITY' | 'NONE' }` and a local transform, and nothing more. The
   physics module keeps its own choice between parenting to the entity's `OBJECT3D` and creating a
   root-scene host (`_dbg__PhysicsDebugDraw.ts:802-811`), and **keeps `applyLocalTransforms`'
   parent-scale division** (:851-869) — that exists because `createPhysicsEntity` copies ECS scale
   onto the `Object3D` while collider dimensions are unscaled physics space. That is a physics fact,
   not a line fact; moving it into core would be wrong.

10. **`toneMapped = false` unconditionally, `frustumCulled = false` by default.** A line is an
    overlay primitive; tone-mapping it puts authored colours out of reach (both current backends
    already set it, `:725` and `:741`). Culling a refilled line whose bounds went stale at
    `endWrite()` makes it vanish at unpredictable camera angles — so culling is opt-in and pairs with
    an explicit `recomputeBounds`, which costs O(segments) per commit. Warn once if `frustumCulled`
    is set without it on a line that has been refilled.

11. **ECS is optional. `createLines(props)` returns a handle usable from any gameplay code**, with no
    world involved. `createLineEntity(props, entityOpts?, ecsWorld?)` mirrors
    `createMeshEntity`/`createGroupEntity` for callers that want entity lifetime and `setTransform`.
    The new `CORE_LINE` component stores **`{ lineId }`, not the object** — the same reasoning
    `ECSCoreComponents.ts:77-88` already records for `DEBUG_PHYSICS_WIREFRAME`: the FAT backend
    arrives via a dynamic import and swaps the underlying `Object3D`, so a component-held reference
    would go stale on every upgrade. **`lines.object3D` identity is not stable across a backend swap;
    always read the getter, never cache it.**

12. **A thick line is a `Mesh`, and that breaks the auto-tagger.** Our FAT class extends `Mesh`, as
    `LineSegments2` does. `OBJECT3D_TAGS` (`ECSCoreComponents.ts:101-119`, fired from
    `ECSCoreSystems.ts:79-95`) would stamp it `TAG_IS_MESH`, subscribing it to
    `MeshManager.ts:18-20`'s `onDeleteEntity: disposeMesh` — two owners running teardown on one
    object in unspecified order. Add a `{ prop: 'isLine', tag: TAG_IS_LINE }` rule (closing that
    file's own TODO at :113-118), and a private `retagBackend(entityId, world)` that removes
    `TAG_IS_MESH` and adds `TAG_IS_LINE`, called from `createLineEntity` **and** after every THIN→FAT
    swap. This is the single most error-prone part of the integration and will otherwise produce a
    "my line disposed itself" bug.

13. **The core system does not refill anyone's geometry.** The one core per-frame system writes
    `lineTimeUniform` and nothing else. Consumers own their refill cadence — p125 keeps its own
    `LATE_MAIN` system gated on its enabled flag, the physics wireframes stay on `APP_RENDER_SYNC` and
    never rewrite geometry at all. Those are two genuinely different profiles (build-once/transform-
    per-frame vs refill-per-frame) and the API names both rather than pretending there is one.

## Engine-side gaps to close first (Phase 0, additive/non-breaking)

`src/_engine/core/MainLoop.ts` — add an elapsed-time accumulator and
`export const getElapsedTime = () => elapsed;`. Accumulate `elapsed += delta` next to **all three**
`delta = dt * playSpeedMultiplier` sites (`:135`, `:193`, `:231`); missing one silently breaks pulses
in one build mode only. Frozen while `masterPlay` is false, because the loop stops re-arming rAF
(`:134-140`).

No behaviour change for any existing consumer — purely additive.

Manual verification: `yarn dev` `?isDebug=true`, log the value against the debug play-speed slider
and the pause toggle.

## Files touched

- `src/_engine/core/LineManager.ts` — **new**. Public facade: `registerLineManager`, `createLines`,
  `createLineEntity`, `bindLineToEntity`, `getLine`/`getLineForEntity`/`getAllLines`,
  `disposeAllLines`, `preloadFatLineBackend`, `isFatLineBackendAvailable`. Component hooks.
- `src/_engine/core/Lines/LineTypes.ts` — **new**. `LineProps`, `LineColorStyle`, `LineAttachment`,
  `LineLocalTransform`, `LineBackendKind`, easing/mode enums.
- `src/_engine/core/Lines/LineRegistry.ts` — **new**. `id → LineObject`, `entityId → id`.
- `src/_engine/core/Lines/LineObject.ts` — **new**. The handle: capacity, `beginWrite`/`endWrite`,
  `setSegments`, `ensureCapacity`, `setColor`/`setColorStyle`, `setWidth`, `setVisible`, `attach`,
  `setLocalTransform`, `dispose`.
- `src/_engine/core/Lines/LineWriter.ts` — **new**. Allocation-free cursor: `segment`, `vec`, `raw`.
- `src/_engine/core/Lines/LineBuilders.ts` — **new**. `writeBox3Edges`, `writeBoxEdges`,
  `writeGeometryEdges` (EdgesGeometry — flat-faced shapes, where triangle diagonals are noise),
  `writeGeometryWireframe` (WireframeGeometry — curved/tessellated shapes), `writePolyline`, plus
  one-shot `*ToSegments` forms, capacity helpers, and `flattenSegmentGeometry` — the last promoted
  verbatim from `_dbg__PhysicsDebugDraw.ts:693-709` (`toFlatSegmentPositions`).
- `src/_engine/core/Lines/LineBackend.ts` — **new**. The backend interface + selection policy.
  Imports no addons.
- `src/_engine/core/Lines/LineBackendThin.ts` — **new**. `LineSegments` + `LineBasicNodeMaterial`.
- `src/_engine/core/Lines/LineBackendFat.ts` — **new**, dynamically imported, the only module nothing
  statically references. Our `LineNodeMaterial`, the instanced segment geometry, the `Mesh` subclass.
- `src/_engine/core/Lines/LinePulse.ts` — **new**. `lineTimeUniform`, the TSL colour node factory,
  the blend maths.
- `src/_engine/core/Lines/LineSystem.ts` — **new**. One `registerCorePlugin` system on
  `ECSSystemStage.MAIN`, writing `lineTimeUniform` once per frame.
- `src/_engine/core/MainLoop.ts` — `getElapsedTime()` (Phase 0).
- `src/_engine/core/ECS/ECSRegistry.ts` — `LINE = 'CORE_LINE'`, `TAG_IS_LINE = 'CORE_TAG_IS_LINE'`.
- `src/_engine/core/ECS/ECSCoreComponents.ts` — payloads + the `isLine` entry in `OBJECT3D_TAGS`.
- `src/_engine/InitApp.ts` — side-effect import + `registerLineManager(ecsWorld)` beside
  `registerLightManager`.
- `src/_engine/core/Debug/_dbg__PhysicsDebugDraw.ts` — **delete :637-743 entirely** (107 lines:
  `FatLineDeps`, `fatLineDeps`/`fatLinePromise`/`warnedNoFatLines`, `loadFatLineDeps`,
  `toFlatSegmentPositions`, `createWireframeObject`, both warn-once blocks), **delete the
  `WireframeLines`/`WireframeMaterial` union types :280-283** and the two `import type` lines :2-3,
  then swap ~6 call sites. Everything else stays.
- `src/_engine/core/Debug/_dbg__Raycast.ts` — `:65-137` onto the core API.
- `docs/plans/p125_spatial-index-system-visualizer.md` — header + Phases 2-3 + Risks (docs only).
- `docs/plans/_DONE_p025_debug-drawing-in-physics-api.md` — amend the "Accepted cost" note
  (:188-196) with a pointer to this plan and the achieved figure.

Everything except the two `_dbg__` migrations, the three one-line registry/InitApp additions and the
doc edits is purely new-file additive.

## Phases

Each phase is independently reviewable and committable, and leaves the tree compiling and the app
rendering.

**Phase 0 — `getElapsedTime()`.** As in "Engine-side gaps" above.

**Phase 1 — Core buffer, builders, THIN backend, `createLines`.** Static colour only, via
`LineBasicNodeMaterial`. Nothing existing imports it yet.

Manual verification: from a scene main-looper, draw a `Box3` outline and a closed polyline; then a
second line pre-allocated to a fixed capacity and refilled every frame from `beginWrite`/`endWrite`.
Watch the frame time and confirm no GC sawtooth.

**Phase 2 — The custom thick-line material.** `LineNodeMaterial` + instanced segment geometry +
`Mesh` subclass, in `LineBackendFat.ts`, behind the dynamic import. `setWidth` as a **uniform write**
— non-negotiable, because the physics thickness slider drags live (see Risks).

Manual verification: visually compare width 1 / 4 / 8 against the current `LineSegments2` output side
by side before deleting anything; check endcaps with MSAA on and off; confirm `yarn build` emits a
separate chunk for `LineBackendFat` and that a THIN-only page never fetches it.

**Phase 3 — Pulsation.** `LinePulse.ts`, `lineTimeUniform`, `LineSystem.ts`, `registerLineManager`,
`InitApp` wiring. `setColor` reimplemented as the 1-colour/speed-0 case.

Manual verification: pulse 2, 3 and 4 colours on both backends; confirm it freezes on `masterPlay`
pause, keeps running while only the *app* loop is paused, and halves at play speed 0.5; confirm
`autoPhase` de-syncs a grid of boxes.

**Phase 4 — ECS integration.** `LINE` + `TAG_IS_LINE`, the `OBJECT3D_TAGS` entry, `createLineEntity`,
`bindLineToEntity`, hooks, and `retagBackend`.

Manual verification: delete an entity mid-pulse; upgrade an entity-bound line's width 1 → 4 and
confirm the `Object3D` swap re-points `CORE_OBJECT3D.value`, re-tags, and splices back at the same
child index; confirm no orphan left in the root scene and no `disposeMesh` double-run.

**Phase 5 — Migrate the physics wireframes.** Delete `:637-743`; swap
`ColliderWireframe.lines`/`.material` for the core handle; update `applyLineThickness` (:151),
`applyMasterVisibilityToEntry` (:340-345), `buildEntityWireframes` (:762 `await loadFatLineDeps`
removed, :773, :775-777), `disposeColliderWireframe` (:829-833) and `physicsWireframeSystem` (:1017).
Pin `backend: 'FAT'` so the 1-10px slider is always a uniform write and never crosses a backend
boundary. **No exported symbol changes** — the 18 symbols `_dbg__PhysicsAPI.ts:31-49` imports, the 2
in `_dbg__OnScreenTools.ts:35-36` and the 1 in `PhysicsManager.ts:91-96` all stay. Expect ~1,097 →
~980 lines.

Manual verification: `?isDebug=true`, Physics API tab. Wireframe on for a named and an unnamed
entity. Colour switches on state change (sleep a body, disable a collider, toggle a sensor); the
thickness slider 1→10 changes width live with no flicker; global override + per-entity override +
both Resets; reload persists the named entity's on-state (`AEK_debugPhysicsApiEntities`); scene switch
restores master visibility (`AEK_debugPhysicsWireframeMaster`); the on-screen-tools button toggles
all; a non-uniformly scaled mesh's wireframe still hugs its collider; a `BODY_DYNAMIC_HEADLESS` body's
wireframe still tracks per frame. Repeat under `?isProdTest=true` (must be absent — the module is
`IS_DEBUG_ENV` only, `PhysicsManager.ts:88-96`).

**Phase 6 — Migrate the raycast helpers.** `_dbg__Raycast.ts:65-137` onto `writePolyline` + refill.

Manual verification: `?isDebug=true`, raycast helper lines still draw and still follow the ray.

**Phase 7 — Measure, and update the sibling plans (docs).** Run the stash-and-rebuild diff below and
write the real numbers into this plan's own "Implementation notes". Amend
`_DONE_p025...md:188-196`. Update `p125`: add `Blocked by: p058_line-rendering-system.md`; rewrite the
Context bullet at :16 that cites `createPhysicsDebugMesh`/`PhysicsRapier.ts:1465` as "the engine's
established pattern" to cite this system instead; collapse Phase 2's hand-rolled `LineSegments` bullet
(:42) and its "mutable uniform/`color` property" bullet (:44) onto `createLines` + `setColor`; strike
the open question at :62 about sourcing the root scene. **p125's "Engine-side gaps" section is
unaffected** — `cellSize` and `getOccupiedCellBoundsInto` are real `SpatialGrid.ts` gaps that still
stand, and its Phase 1 is unchanged. Add a note that p125 should default to the **THIN** backend,
because its own cell-count risk (:61) gets worse under instanced quads.

### Bundle measurement procedure (Phase 7)

The metric is the size of `dist/assets/index-*.js`, not the total of `dist/`. Baseline on disk is
3,593,675 B, matching p025's recorded "after" figure exactly.

1. `git stash -u` (or check out the pre-change ref); `yarn build`; record
   `ls -l dist/assets/index-*.js`, Vite's own `… kB │ gzip: … kB` line (`reportCompressedSize` is on),
   and the sizes of `LineSegments2-*.js` / `LineSegmentsGeometry-*.js` / `_dbg__PhysicsDebugDraw-*.js`.
   Copy `dist-stats/bundle-stats.html` to a scratch path — it is regenerated every build.
2. Restore the change; `yarn build`; compare the same numbers.

Gate markers, run against the new main chunk:

| Marker | Baseline | Required after |
| --- | --- | --- |
| `grep -c isLine2NodeMaterial dist/assets/index-*.js` | 1 | **0** |
| `grep -c useDash dist/assets/index-*.js` | 1 | **0** |
| `grep -c worldUnits dist/assets/index-*.js` | 1 | **0** |
| `ls dist/assets/LineSegments2-*.js` | exists | **no such file** |
| `grep -c 'Object.freeze({__proto__:null,BRDF_GGX' dist/assets/index-*.js` | 1 | **1** (unchanged — if this moves, the delta is not attributable to lines) |

`isLine2NodeMaterial` is the only unforgeable marker; the others could legitimately reappear from our
own code, so name our `trimSegment` equivalent something distinct. **Report both halves of the delta**
(−12.7 KB for `Line2NodeMaterial`, +N KB for whatever of the core line module is statically reachable),
not just the net.

## Non-goals

- **Object selection, hover highlighting, and selection outlines.** This plan ships the pulsation and
  box-outline primitives they need, and stops there.
- **Dashed lines.** `dashSize`/`gapSize`/`computeLineDistances` need a per-segment distance attribute
  that complicates the refill path.
- **Per-vertex / per-segment colours and gradients along a line.** A second buffer and a separate
  feature. Note this is the one thing `PhysicsRapier.ts:1465-1481`'s legacy `debugRender()` mesh uses,
  which is why that file is deliberately left alone here — and the todo queue already has an entry to
  delete it outright.
- **Line picking / raycasting.** We drop `LineSegments2`'s raycast machinery on purpose.
- **Batching many small line objects into one draw call.** A real future optimisation; v1 is one draw
  call per `LineObject`.
- **World-units line width.** Screen-space pixels only.
- **JSON-authored lines.** No `lineSchema.ts`, no `sceneSchema` entry — code-only in v1.
- **Palettes above 4 colours, and a configurable blend colour space.** The LUT generalisation is
  recorded in Design decision 8, not built.
- **Shrinking capacity**, and **anything worker-thread**.

## Risks / open questions

| Risk / question | Notes |
| --- | --- |
| We now own a shader | The real cost of Design decision 1. TSL API drift across three releases (`viewportSize`, `screenDPR`, `varyingProperty`) becomes our problem, and `@types/three` no longer types the material for us. Mitigated by keeping the material minimal (no dash, no world-units, no transparent path) and by Phase 2's side-by-side visual comparison against `LineSegments2` before anything is deleted. |
| `setWidth` must be a uniform write | `_dbg__PhysicsAPI.ts:488-497` is a live 1-10px drag. If the custom material implements width as anything needing a geometry or pipeline rebuild, the slider stutters. Pinning the physics wireframes to `backend: 'FAT'` (Phase 5) also keeps the drag from crossing the THIN/FAT boundary at 1→2. |
| Colour-write elision desync | `_dbg__PhysicsDebugDraw.ts:1016-1019` only writes on state change, invalidated by nulling `lastState` (:944-953). If the core handle adds its *own* equal-value no-op, a palette edit that maps a different state to the same hex silently does nothing. Core `setColor` must be unconditional, or expose an invalidate. Verify: sleep a body, change the `sleeping` colour while asleep, Reset. |
| `object3D` identity across a backend swap | Design decision 11. Every consumer that caches the object breaks. `_dbg__PhysicsDebugDraw.ts:340-345` (master visibility) and :851-869 (local transforms) both hold it. Pinning FAT in Phase 5 means physics never swaps — but the hazard stays for other callers and must be documented loudly. |
| The `Mesh` auto-tagging trap | Design decision 12. Fails silently and confusingly if missed. |
| Async build race in `buildEntityWireframes` | `:795-800` discards work if the component vanished mid-`await`. Removing `await loadFatLineDeps()` (:762) shrinks the window, but the `await collider.*()` RPCs in worker mode keep it open. Do not "simplify away" the guard. |
| `frustumCulled = false` | Set at :777 with a comment. If the core constructs the `Object3D` internally it must default this to `false`; a regression here is intermittent and hard to spot. |
| Headless-body per-frame sync | `physicsWireframeSystem` (:1004-1008) writes `entry.host.position/quaternion` for `BODY_DYNAMIC_HEADLESS`. The host must stay a plain `Object3D` the physics module owns, not a core-owned wrapper. Explicitly walk a headless dynamic body. |
| Three LS keys must not move | `AEK_debugPhysicsApiEntities` (:168), `AEK_debugPhysicsWireframeMaster` (:335), `AEK_debugPhysicsApiWireframe` (`_dbg__PhysicsAPI.ts:56`). If the core system grows its own key it must not collide. Verify: diff all three in devtools before/after Phase 5. |
| Multi-world | Line objects are not per-world (standalone lines belong to no world at all), yet the only per-frame hook is an ECS system. With N worlds the system runs N times; since it writes one uniform from a monotonic clock this is idempotent, but it means lines do not animate with zero worlds. `InitApp.ts:65` always creates one, so this is theoretical — state it in a comment. |
| Should `PhysicsRapier.ts`'s legacy debug mesh migrate too? | Deliberately excluded. It is the only consumer needing per-vertex colours, and the todo queue already plans to delete the file. Revisit only if that deletion slips. |

## Verification

- `tsc --noEmit` and `yarn lint` clean after **every** phase — the repo's Stop hook enforces this.
- There is no test framework in this repo, so verification is `yarn dev` + `?isDebug=true` /
  `?isProdTest=true` walkthroughs (the `run-aekasha-js` skill drives this), per the per-phase
  "Manual verification" notes above.
- Phase 7's bundle diff is the plan's headline result: the grep table is the gate, the raw/gzip delta
  on `index-*.js` is the number.

## Implementation notes

Implemented in phases 0-7 (commits `e2cccdf`..`9e1f5ae` plus the Phase 7 docs).

### Bundle measurement (Phase 7)

Instead of `git stash -u` (which would have hot-reloaded a running dev server onto reverted
files), each state was built with the real `yarn build` in a throwaway git worktree:
`b3d258c` (before Phase 0), `HEAD` (`9e1f5ae`), and a *variant* of `HEAD` with the only two
static imports of the line core removed (`registerLineManager()` in `InitApp.ts`,
`disposeNonPersistentLines()` in `SceneLoader.ts`), which separates the two halves of the
delta. Main chunk (`dist/assets/index-*.js`), gzip at level 9:

| Build | Raw (B) | Gzip (B) |
| --- | --- | --- |
| before (`b3d258c`) | 3,555,833 | 1,207,236 |
| variant (`HEAD`, line core not statically imported) | 3,553,345 | 1,206,598 |
| after (`HEAD`) | 3,565,605 | 1,210,798 |

- **`Line2NodeMaterial` out: −2,488 B raw / −638 B gzip** (before → variant; this also
  includes the few bytes of `getElapsedTime` and the two new ECS component types).
- **Line core statically reachable: +12,260 B raw / +4,200 B gzip** (variant → after; the same
  code is a 12,091 B lazy `LineManager-*.js` chunk in the variant).
- **Net: +9,772 B raw / +3,562 B gzip.** Vite's own report: 3,555.83 → 3,565.61 kB,
  1,206.21 → 1,209.87 kB gzip.
- Lazy chunks: `LineSegments2` (3.79 kB) and `LineSegmentsGeometry` (2.62 kB) are gone;
  `LineBackendFat` is new at 4.21 kB (1.73 kB gzip); `_dbg__PhysicsDebugDraw` 11.26 → 9.86 kB;
  `_dbg__Raycast` 8.24 → 8.04 kB.
- The plan's baseline (3,593,675 B) was stale: `dist/` had been rebuilt from `b3d258c`
  (3,555,833 B, byte-identical to the "before" build here).

Gate table: `isLine2NodeMaterial` 1 → **0** ✓, `worldUnits` 1 → **0** ✓, `LineSegments2-*.js`
**gone** ✓, the TSL-namespace control 1 → **1** ✓, **`useDash` 1 → 1 ✗**.

**Why the removal only saved 2.5 kB, and why `useDash` stays.** In `three.webgpu.js`,
`Line2NodeMaterial`'s module-level TSL graphs — `trimSegmentAlpha`, `closestLineToLine`,
`mvpLine`, `alphaLine` (`Fn(...)`, `Fn(...)()`) and its four `varyingProperty(...)` varyings —
are **not** `/*@__PURE__*/`-annotated, so Rollup keeps them whether or not anything uses the
class; only the class and its `/*@__PURE__*/ new LineDashedMaterial()` defaults went. So the
Context section's "the only lever is: stop referencing the class" was only partly right, and
most of p025's recorded 12.7 kB was never removable this way. The *rest* of Design decision 1
still stands (owned blending, no silent 1px fallback, no raycast machinery), but its bundle
side is a net cost.

**Follow-up worth doing:** the +12.3 kB line core ships in production although this app draws
no lines outside its debug tooling. Registering the time system on the first `createLines`
and having the line manager hook itself into scene teardown (instead of `SceneLoader`
importing it) would make that cost ~0 for apps that don't draw lines — in line with "you only
bring into existence what you need". Not done here.

### Where the implementation departs from this plan

- **Phase 0 — pause.** The loop's `Timer` is never reset, so the first delta after a master
  pause spans the whole pause; `getElapsedTime()` discards it (as `stepPhysics` does). The
  pause is detected inside the loop, because the debug GUI writes `loopState.masterPlay`
  directly rather than calling `toggleMainPlay`.
- **Design decision 1 — `colorNode`.** Obsolete on three r186: `lineColorNode` is a
  deprecated alias of `colorNode` (`Line2NodeMaterial.js:548-558`) and nothing overwrites it.
  The line references into that file are stale.
- **Design decision 1 / Phase 2 — MSAA.** The MSAA gating is not a trap on this renderer: the
  canvas is `alpha: true`, so cap coverage written as alpha without MSAA or blending shows the
  page through. `LineNodeMaterial` branches at build time like three does (smooth caps with
  MSAA *or* when transparent, hard round caps otherwise); `opacity` works (normal blending).
- **Design decision 10 — rejected.** `WebGPURenderer` renders into a frame-buffer target and
  tone-maps the whole frame in its output pass; `material.toneMapped` is only read by
  `WebGLRenderer`. Lines are tone-mapped like the rest of the scene (`#3366cc` renders as
  `#0d53b8` with ACES at 0.7 exposure). Accepted; the dead `toneMapped = false` settings were
  removed. Exact line colours would need a post-output overlay pass — a separate plan.
- **Design decision 5 — "allocation-free".** Writing segments allocates nothing; each commit
  costs ~78 B because the renderer clears `updateRanges` after every upload and V8 regrows the
  array (a retained range object avoids a further 32 B). On FAT lines both instance attributes
  upload the shared buffer (three tracks versions per attribute), so a refill uploads the
  written range plus the full capacity; two buffers would halve that at double the memory.
- **Design decision 7 — colour ownership.** `LineObject` owns the colour uniforms and the
  colour graph and hands the same nodes to whichever backend draws it
  (`setColorNodes`/`setTransparent`), so `setColor` and pulses share one writer across swaps.
- **Design decision 8 — `autoPhase`.** Plain FNV-1a left ids differing only in their last
  character ~0.004 cycles apart (a grid still pulsed in unison); a murmur3 finaliser fixes it.
- **Design decision 11 / Files — ECS.** No `entityId → id` map: the `LINE` component is that
  map, per world. The ECS glue lives in `Lines/LineEntity.ts` (so `LineObject` can call it
  without an import cycle). `attach: { to: 'ENTITY' }` is placement only.
- **Design decision 12 — tagging.** The FAT object is marked `isFatLineSegments`, not
  `isLine`: the renderer reads `isLine` on a Mesh as "draw as a line strip". Entities are
  re-tagged after creation and after every swap, as planned.
- **Lifetime (not in the plan).** A scene switch runs `disposeNonPersistentLines()`: standalone
  lines are disposed unless created `persistent: true`; entity-bound lines follow their entity
  (`clearNonPersistent`). `disposeAllLines()` disposes everything.
- **Registration.** `registerLineManager()` takes no world (core plugins and component hooks
  are static) and there is no side-effect import (`SceneLoader` already imports the manager).
- **Raycasting.** Both backends' `raycast` is a no-op, so a line's pickability doesn't depend
  on its backend. Physics wireframes no longer intercept scene raycasts (`LineSegments2` did).
- **Phase 5.** `await preloadFatLineBackend()` replaces `await loadFatLineDeps()` rather than
  being removed: pinning `'FAT'` alone would still create each line THIN and swap it when the
  chunk arrives. Wireframe lines are `persistent` (their module owns their lifetime).
- **Phase 6.** `ad336bf` had removed the only caller of `cleanUpRayHelpers()`; helper id arrays
  grew on every draw, stale helpers stayed up until a scene switch, and the ray statistics
  stopped updating. `_dbg__Raycast.ts` now registers its own `LATE_MAIN` cleanup system.
- **Phase 7 — p125.** Its header, Context, Phase 2 and open question had already been updated
  when this plan was written; only the link and a `persistent: true` note were added.
- **Found along the way.** `_dbg__MainLoop.ts` tested `!isProdTestMode` (a function, always
  truthy); fixed to `IS_PROD_TEST_MODE`, so prod-test mode gets only the on-screen play tools.
