Status: rough draft | research — not-implemented
Category: Rendering, LOD
Blocked by: p300_asset-optimization-pipeline-plan.md (soft — see §7.1)
Blocks: p351_impostor-billboard-lod.md, p352_physics-simulation-tiers.md, p353_macro-streaming-grid.md, p354_gpu-driven-culling.md (none of which exist yet)

# LOD System — Research & Prioritized Roadmap

Feasibility study for a level-of-detail system aimed at large worlds. Concludes that
`THREE.LOD` is the wrong foundation to extend and that LOD should instead be a _selection
decision made by an ECS system_, feeding the existing instancing/batching layer. Identifies
five separable workstreams, ranks them by value-to-effort, and marks which are safe to plan
now versus which need a spike first.

**This is a rough draft.** Unlike the physics plans, it is not grounded in a finished design —
several load-bearing claims in §5 and §8 are marked `[UNVERIFIED]` and need a measurement or a
spike before anything here is committed to. Do not treat any phase breakdown below as final.

---

## 1. Goal

Decide how Ækasha should do LOD, given three constraints that are already true of the engine:

1. Target is **large worlds**, so per-object per-frame CPU work does not scale.
2. The renderer is `THREE.WebGPURenderer` (`core/Renderer.ts:56`, `three@0.183.2`), not
   `WebGLRenderer` — which rules out or gates some off-the-shelf options (§5.2).
3. A `SpatialGrid` (`core/Spatial/SpatialGrid.ts`) and an `InstancedMeshPool`
   (`toolkit/ecs/InstancedMeshPool.ts`) already exist and should be reused rather than
   paralleled.

Secondary goal: answer whether "physics LOD" is a real concept worth building (§6), since a
large world cannot simulate every body every frame.

## 2. Why not just extend `THREE.LOD`

`THREE.LOD` is an `Object3D` holding a list of `{ object, distance, hysteresis }` levels. On
`update(camera)` it computes distance from camera to the LOD's world position and toggles
`.visible` on exactly one child. That is the entire feature: no texture management, no
batching, no streaming, no fading, no screen-space error metric.

Three concrete problems with extending it here:

- **It is per-instance object-graph work.** Each LOD instance is an `Object3D` with N child
  `Object3D`s, and selection is a main-thread distance check per instance per frame. Ten
  thousand trees means ten thousand `Object3D`s with ~40k children, traversed every frame.
  This is exactly the shape of cost the engine has been moving _away_ from (cf.
  `ObjectFrustumCullingSystem` replacing per-object frustum tests with a spatial query).
- **It defeats batching.** Each level is a distinct `Object3D` with its own draw call. The
  whole point of a distant-tree LOD is that ten thousand of them collapse into _one_ draw,
  which `THREE.LOD` cannot express because levels are owned per-instance, not shared.
- **It duplicates state the ECS already owns.** Position lives in `TRANSFORM`; visibility
  gating already exists as `TAG_FRUSTUM_CULLED` (`ECS/ECSRegistry.ts:35`, runtime-only). A
  parallel `THREE.LOD` distance/visibility state is a second source of truth.

**Recommendation:** LOD selection becomes an ECS system (`lodSelectionSystem`) that writes a
`CORE_LOD_LEVEL` component, and the _rendering_ layer decides what to do with that level.
`THREE.LOD` may still be useful as a convenience wrapper for a handful of hero/unique objects
where per-instance cost is irrelevant, but it is not the foundation.

## 3. Proposed shape (ECS-native)

New core component types (`ECS/ECSRegistry.ts` + `ECSCoreComponents.ts`), following the
existing opt-in/runtime-only split established by `FRUSTUM_CULLING_ENABLED` (opt-in,
user-authored) versus `TAG_FRUSTUM_CULLED` (runtime-only, current state):

| Component               | Kind                  | Data                                                            |
| ----------------------- | --------------------- | --------------------------------------------------------------- |
| `LOD_ENABLED`           | opt-in, user-authored | `{ levels: LodLevelDef[], hysteresis?: number, bias?: number }` |
| `LOD_LEVEL`             | runtime-only          | `number` — currently selected level index, `-1` = culled        |
| `TAG_LOD_TRANSITIONING` | runtime-only          | set while a cross-fade is in flight (§8.3)                      |

`LodLevelDef` is roughly `{ geometryId, materialId, maxDistance, screenErrorThreshold? }` —
authored in the asset JSON (`*.mesh.json` / `*.importedMesh.json`) so it flows through
`devTools/gatherAppData.ts` → Zod schema → `generatedAppData.json` like everything else, and
gets `.schemas/` autocomplete for free.

Systems and their stages (stage order is fixed: `MAIN → APP_PRE_PHYSICS → APP_POST_PHYSICS →
APP_LOGIC → APP_RENDER_SYNC → LATE_MAIN`):

- `lodSelectionSystem` — `APP_RENDER_SYNC`, immediately before the existing object3D sync.
  Iterates only the `LOD_ENABLED` storage (early-out when `storage.size === 0`, matching the
  `LightFrustumCullingSystem` pattern), reads camera position once, writes `LOD_LEVEL`. Skips
  entities already carrying `TAG_FRUSTUM_CULLED`.
- `lodApplySystem` — same stage, after selection. Only touches entities whose `LOD_LEVEL`
  actually changed this frame (version-diff, mirroring `instancedMeshPoolSyncSystem`'s
  `_lastVersion` check), swapping geometry/material or moving the instance between batches.

**Selection metric.** Prefer projected screen-space size over raw distance:
`screenRadius ≈ (boundingRadius / distance) * (viewportHeight / (2 * tan(fov/2)))`. This makes
LOD resolution-independent and FOV-correct, which raw distance is not (a zoomed-in sniper
scope should _not_ drop to LOD3). Costs one extra multiply per entity. The bounding radius is
already computed for the spatial index, so this is close to free.

**Hysteresis is mandatory, not optional.** Switch up at `threshold`, switch back down at
`threshold * (1 + hysteresis)`. Without asymmetric thresholds an entity sitting exactly on a
boundary flips every frame. `THREE.LOD` has this; do not lose it.

## 4. Relationship to the spatial grid — two grids, not one

The existing `SpatialGrid` is tuned for per-frame range queries (`getSpatialGrid(world)`,
`setSpatialGridCellSize(world, cellSize)` in `Spatial/SpatialIndexSystem.ts`, one grid per
world via `cellSizeByWorld` WeakMap, rebuilt by `spatialIndexRebuildSystem`). Cell size is
small enough that frustum/light queries touch few members per cell.

Streaming wants the opposite: **large cells, few of them, and a state machine per cell rather
than a per-frame query.** Recommended shape — a _second_ `SpatialGrid` instance with a much
larger `cellSize`, driving a per-cell residency state machine:

| State      | Ring                                | Geometry                   | Textures     | Physics (see §6) |
| ---------- | ----------------------------------- | -------------------------- | ------------ | ---------------- |
| `RESIDENT` | current cell + immediate neighbours | all LODs                   | full mips    | `FULL`           |
| `NEARBY`   | next ring                           | LOD1+ only                 | reduced mips | `STATIC_ONLY`    |
| `FAR`      | beyond                              | impostor / SLOD proxy only | atlas only   | `NONE`           |
| `UNLOADED` | —                                   | nothing (manifest known)   | nothing      | `NONE`           |

Two things that will bite if skipped:

- **Asymmetric load/unload thresholds.** Load at distance X, unload at X + margin. A player
  standing on a cell boundary otherwise thrashes load/unload every frame — periodic hitching
  that is genuinely painful to diagnose after the fact.
- **A uniform grid is fine for streaming, poor for LOD selection of large objects.** A terrain
  chunk or a large building spans many cells. `SpatialGrid` already has an "oversized" tier
  (members whose radius exceeds `cellSize * oversizedRadiusMultiplier`, default 2) which is
  the right escape hatch — but confirm oversized members are handled sanely by the streaming
  state machine rather than silently pinned `RESIDENT` forever.

Build-time support: `gatherAppData.ts` could emit a `cellId → assetIds[]` manifest into
`generatedAppData.json`, so a cell's load set is a lookup rather than a runtime spatial query.
This is cheap to add and makes the streaming system much simpler.

## 5. Texture and memory findings

### 5.1 LOD levels should simplify _materials_, not just downscale textures

Mipmapping already solves "object is small on screen, sample a smaller mip", per-texture, for
free. Authoring a separate half-res texture per LOD level largely duplicates what mips do.

What LOD levels should actually change is **shader cost and channel count**: LOD0 full PBR
(albedo + normal + roughness/metal/AO), LOD2 drops the normal map and uses a simpler node
material, impostor uses a baked atlas with AO/lighting partly pre-baked. On a GPU-bound scene
this matters more than texture bytes.

Separate lower-res textures _do_ pay off for residency (only upload mips 4+ for distant
assets), but that is mip streaming, which is a different feature and not one three.js provides.
Treat it as out of scope for the first pass.

### 5.2 Three.js upload behaviour — the hitch risk

Three.js uploads a texture to the GPU lazily, on first use in a render, and keeps it resident
until `.dispose()`. Consequences:

- A never-yet-visible LOD level costs zero VRAM. Good.
- The frame it _becomes_ visible, you pay a synchronous upload. With a streaming world this
  means "player rounds a corner, 40 assets become visible, 200ms stall." This is the single
  most likely source of user-visible hitching in the whole system.

Mitigation is a warm-up/priming pass during streaming-in, before the asset is actually needed.
`[UNVERIFIED]` — `WebGLRenderer` has `initTexture()`/`initObject()`; confirm what the r183
`WebGPURenderer` equivalent is (likely `renderer.init()`-adjacent or an explicit
`renderer.compileAsync()`), and whether a 1×1 offscreen render is needed as a portable
fallback. **This is a 30-minute spike and should happen before p353 is planned.**

### 5.3 Memory is the real ceiling, not triangles

A browser tab gets a fraction of VRAM and WebGPU will drop the device rather than swap. In
rough order of impact:

1. **GPU-compressed textures** (`KTX2Loader`, BC7/ASTC/ETC2 via Basis/UASTC) — roughly 4–6×
   smaller resident than RGBA8. Biggest single win, and it belongs in
   `p300_asset-optimization-pipeline-plan.md`, not here.
2. **Atlasing / array textures** so distant LODs share one material and one batch.
3. **Aggressive `dispose()` on cell unload**, driven by the streaming state machine.
4. **A budget tracker.** Suggest a `_dbg__GPUMemory.ts` debugger tab (estimated bytes by
   asset/category, high-water mark, per-cell attribution). This is cheap to build, follows the
   established `_dbg__` + `IS_DEBUG_ENV` dynamic-import pattern, and will pay for itself
   repeatedly. Arguably it should be built _first_, before any LOD work, since without it
   every subsequent optimization is unmeasured.

## 6. Physics "LOD" — simulation tiers

Physics LOD is a real concept, though engines call it different things. Findings:

**Free win already available.** Rapier auto-sleeps bodies below a velocity threshold and solves
by island, so sleeping bodies cost near-nothing. In a mostly-static world the majority of
bodies are asleep at any moment. Before building anything, verify the engine is not
accidentally keeping bodies awake — the classic cause is writing transforms back into physics
every frame from ECS. `physicsToTransformSystem` (`PhysicsManager.ts`, `APP_POST_PHYSICS`)
reads physics → ECS, which is the correct direction; audit for anything going the other way.

Sleeping is not sufficient on its own, because broad-phase and **memory** still scale with body
count — and `PhysicsTransformBuffer`'s fixed `maxBodies` (default 2048, `Config.ts`) is a hard
cap that a large world will hit.

**Prior art:**

- **Unreal** — distance-gated simulation, plus a _Significance Manager_ plugin whose purpose is
  ranking objects by importance and tiering down their tick/physics/animation budget. World
  Partition streams physics state with cells. Chaos can run async at a fixed rate.
- **Unity** — no built-in physics LOD. In practice: `sleepThreshold` tuning, swap to kinematic
  beyond a distance, disable colliders via streamed subscenes/Addressables. `LODGroup` is
  rendering-only.
- **GTA V** — the most instructive. Solves it by _representation switching_, not disabling.
  The map format has an explicit HD/LOD/SLOD hierarchy with bounds streamed per cell. Vehicles
  beyond a radius become "dummy" vehicles: no real suspension/wheel simulation, cheap
  kinematic movement along the road network, converted back to full physics on approach.
  Pedestrians similar, then despawned and regenerated statistically.

**Proposed for Ækasha** — a `PHYSICS_SIM_TIER` component with tiers:

| Tier              | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `FULL`            | dynamic body, real collider, in the solver                         |
| `KINEMATIC_PROXY` | cheap scripted motion, no solver participation                     |
| `STATIC_ONLY`     | colliders exist (player can't fall through), nothing dynamic       |
| `NONE`            | removed from the physics world, state serialized to a plain struct |

This maps unusually well onto what already exists: `createPhysicsEntity` already buckets into
`BODY_DYNAMIC_VISUAL` / `BODY_DYNAMIC_HEADLESS` / `BODY_STATIC`, `TAG_IS_PHYSICS_OBJECT`
already has an `onDeleteEntity` hook, and `PhysicsTransformBuffer` already has `freeSlot()`.

**The gap is runtime migration between buckets**, which nothing currently does. Two hazards:

1. In `WORKER_THREAD` mode, dropping to `NONE` and back is an **async round trip**. There must
   be an explicit "mid-transition" state or entities will be double-created / operated on
   while absent. Design this before there are many call sites.
2. `PhysicsTransformBuffer` throws on capacity exceeded. A streaming world churns slots
   constantly; slot recycling needs to be airtight and the failure mode probably wants to
   become "log + refuse the promotion" rather than "throw".

This is large enough to be its own plan (`p352`), and is arguably **higher priority than
visual LOD** — it is a correctness/stability ceiling, not just a frame-rate one.

## 7. Nanite-class virtualized geometry — feasibility

The Unreal feature is **Nanite**. It partitions meshes into clusters of ~128 triangles
("meshlets"), letting different parts of one mesh render at different detail, scaled by draw
distance and screen resolution, with automatically generated LODs stitched so no cracks appear
at cluster boundaries. Mechanically: a DAG of meshlet groups, a compute pass walking it to pick
the coarsest clusters under a screen-space error threshold, per-cluster culling, indirect draw,
plus software rasterization for sub-pixel triangles and geometry streaming.

**Has it been done in a browser?** Yes — `Scthe/nanite-webgpu` implements the meshlet LOD
hierarchy, a software rasterizer, billboard impostors, and per-instance _and_ per-meshlet
frustum + occlusion culling. Its README doubles as a good analysis of Nanite. One instructive
limitation: WebGPU has no `atomic<u64>`, so their software rasterizer packs depth into 32 bits
(u16 depth + octahedron-encoded normals). Read this before deciding anything.

**Assessment:** the full system is a multi-year subsystem and the software-raster half is the
part WebGPU makes genuinely painful. The _LOD_ half without software rasterization is far more
tractable and is where most of the benefit lives for an outdoor world. Recommendation: pursue
steps 1–3 of §8, treat cluster-level LOD (§8.5) as a research spike, not a plan.

### 7.1 Existing tooling worth evaluating

- **`meshoptimizer`** (WASM) — `simplify()` with error bounds. The workhorse for automatic LOD
  chain generation. Belongs in the asset pipeline, hence the soft `Blocked by` on p300.
- **`@three.ez/simplify-geometry`** — wraps the above for three.js
  (`simplifyGeometriesByErrorLOD`, `performanceRangeLOD`).
- **`@three.ez/batched-mesh-extensions`** — adds `addGeometryLOD(geometryId, geometry, distance)`
  to `BatchedMesh`, plus BVH-accelerated frustum culling and raycasting. There is now a
  `webgl_batch_lod_bvh` example on threejs.org demonstrating a `BatchedMesh` with 10 geometries
  and 500k instances, each with 5 LODs (4 meshoptimizer-generated), with TLAS/BLAS BVHs.
  Close to the target architecture and worth studying even if reimplemented.

  **`[UNVERIFIED]` — two flags before relying on this:** its per-instance uniforms feature is
  documented as `WebGLRenderer` only, and this project is WebGPU. It is unclear whether the LOD
  path carries the same restriction. Its docs also note that currently only LODs sharing the
  same geometry vertex array can be added. **Spike required.**

## 8. Prioritized roadmap

Ordered by value-to-effort, not by dependency. Each tier is independently useful and shippable.

### Tier 0 — Measure first (do before anything else)

**0.1 GPU memory / draw-call debugger tab.** §5.3. Small, follows an established pattern, and
every item below is unmeasurable without it. Also add per-cell attribution hooks early even if
streaming doesn't exist yet.

**0.2 Two spikes, half a day each:** (a) WebGPU texture priming API, §5.2; (b) does
`@three.ez/batched-mesh-extensions` LOD work under `WebGPURenderer`, §7.1. Both gate real
design decisions and both are cheap to answer.

### Tier 1 — Highest value

**1.1 Automatic LOD chain generation in the asset pipeline** (extends p300). meshoptimizer
`simplify()` with error bounds, emitting LOD geometries + `LodLevelDef` metadata into the
existing `gatherAppData.ts` → Zod → `generatedAppData.json` flow. Highest value-to-effort item
in this document: it is offline work, breaks nothing at runtime, and every other tier consumes
its output.

**1.2 Physics simulation tiers** (`p352`). §6. Ranked this high because it is a stability
ceiling (fixed `maxBodies`, no runtime bucket migration), not merely a performance one, and
because designing the async-transition story _before_ there are many `createPhysicsEntity`
call sites is far cheaper than retrofitting.

**1.3 ECS LOD selection + apply systems.** §3. The core of the feature. Screen-space-error
metric, hysteresis, version-diffed apply. Deliberately _after_ 1.1, because without generated
LOD chains there is nothing to select between.

### Tier 2 — Large-world enablers

**2.1 Macro streaming grid** (`p353`). §4. Second `SpatialGrid` instance, per-cell residency
state machine, asymmetric thresholds, build-time cell manifest. Consumes 1.2's tiers for the
physics column of the residency table.

**2.2 Impostor / billboard LOD** (`p351`). Octahedral impostor atlas (albedo + normal + depth),
generated in the asset pipeline, rendered as one `InstancedMesh`/`BatchedMesh` per asset type
via the existing `InstancedMeshPool`. Note the `InstancedMesh` bounding-sphere caveat already
documented in `InstancedMeshPool.ts:145-148` — it applies directly here.

**Cheaper alternative worth costing first:** for vegetation specifically, mesh → **cross-quads**
(2–3 intersecting alpha-cut planes) reads as volumetric from most angles and needs no
octahedral atlas at all. Possibly sufficient, and a fraction of the work. Suggest prototyping
cross-quads before committing to full impostors.

### Tier 3 — GPU-driven

**3.1 Compute-based frustum culling + indirect draw** (`p354`). Move `ObjectFrustumCullingSystem`
into a TSL compute pass writing an indirect draw buffer. Where the culling systems want to end
up anyway for large worlds, and a hard prerequisite for 3.2.

**3.2 Per-instance LOD selection on GPU.** Same compute pass picks a LOD index per instance and
bins into per-LOD indirect draws. This is "Nanite-lite": near-continuous LOD, one dispatch,
zero CPU per-object work. Realistic end state for this engine.

### Tier 4 — Research only, not a plan

**4.1 Cluster-level (meshlet) LOD.** §7. Only worth it if there are genuinely huge _individual_
meshes where per-object LOD is too coarse (terrain chunks, large architecture). The crack-free
DAG construction and error metric are the expensive parts. Treat as a timeboxed spike whose
output is a recommendation, not an implementation.

## 9. Open questions

1. Should `LOD_LEVEL` be stored in `TYPED_ARRAY` storage when `ecs.storageMode` allows it? It
   is a single `int` per entity and read every frame — a good candidate, but adds a second
   typed-array-capable component type alongside `TRANSFORM`, which may or may not be worth the
   generalization.
2. Cross-fade between levels (§3) — dithered/stochastic, or alpha-blend with depth-write off?
   Interacts with whatever post-processing exists. Deferred to `p351`.
3. Does `TAG_FRUSTUM_CULLED` short-circuit LOD selection, or does LOD selection need to run for
   culled entities anyway (e.g. to keep shadow-caster LODs correct)? Shadow LOD is unaddressed
   in this document and may deserve its own section.
4. Terrain is not covered here at all. Terrain LOD (clipmaps / quadtree / CDLOD) is a separate
   problem with a separate literature; `toolkit/geometry/generateTerrain.ts` exists but is
   currently a `PhysicsRapier.ts` consumer. Flagging as a known gap.
5. Numbering: `p350` places this after the asset pipeline (`p300`) on the assumption that LOD
   generation belongs there. If physics tiers (§6, Tier 1.2) are pulled forward as their own
   plan, they arguably want a `p0xx` number to sit with the physics epic instead.
