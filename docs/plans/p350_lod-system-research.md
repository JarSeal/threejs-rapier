Status: research done — epic, not-implemented
Category: Rendering, LOD
Blocks: \_DONE_p345_gpu-memory-and-draw-call-debugger.md, \_DONE_p346_spatial-domains.md, p347_lod-chain-generation.md, p348_ecs-lod-selection.md, p351_impostor-billboard-lod.md, p352_physics-simulation-tiers.md, p353_macro-streaming-grid.md, p354_gpu-driven-culling.md
Related: p300_asset-optimization-pipeline-plan.md (LOD chains reuse its pipeline), p308_terrain-scatter.md (its static instance cells are the static case of p348), p306_terrain-blocks-and-procedural-terrain-meshes.md (block sizes line up with p353's cells), p420_npc-simulation-tiers.md (characters' side of p352), p240_client-device-capability-sniffer.md (device level as a LOD budget input), \_DONE_p050_spatial-index.md (p346 builds its Phase 4)

# LOD System — Research & Epic

How Ækasha does level of detail for large worlds. The research is done: this file holds the
findings and decisions, and the work is split into the child plans listed in §8. The original
rough draft was checked against the code on 2026-10-02; what changed is recorded in §4.

The short version: `THREE.LOD` is the wrong foundation. LOD is a _selection decision made by an
ECS system_ that feeds the instancing/batching layer. Large worlds also need several spatial
grids (one per domain), a streaming layer that is not a member grid, and physics simulation
tiers, which are a stability ceiling rather than a frame-rate one.

---

## 1. Goal

Decide how Ækasha does LOD, given what is already true of the engine:

1. The target is **large worlds**, so per-object per-frame CPU work does not scale.
2. The renderer is `THREE.WebGPURenderer` (`core/Renderer.ts:56`, three `0.186.1`), with a WebGL2
   fallback (`forceWebGL`). Some off-the-shelf options are WebGL-only (§7.1), and anything
   GPU-driven needs a CPU fallback for the WebGL2 backend.
3. A `SpatialGrid` (`core/Spatial/SpatialGrid.ts`) and an `InstancedMeshPool`
   (`toolkit/ecs/InstancedMeshPool.ts`) exist and are reused, not paralleled.

Secondary goal: decide whether "physics LOD" is worth building (§6). It is.

## 2. Why not `THREE.LOD`

`THREE.LOD` is an `Object3D` with a list of `{ object, distance, hysteresis }` levels. Its
`update(camera)` measures the distance to the camera and toggles `.visible` on one child. That is
all: no batching, no streaming, no fading, no screen-space metric.

- **Per-instance object-graph work.** Ten thousand trees are ten thousand `Object3D`s with ~40k
  children, traversed every frame on the main thread.
- **It defeats batching.** Levels are owned per instance, so ten thousand distant trees can't
  collapse into one draw.
- **It duplicates ECS state.** Position lives in `TRANSFORM`, and visibility is already reconciled
  from three independent reasons (`DISABLED`, `TAG_FRUSTUM_CULLED`, `TAG_OBJECT_CULLED`) by
  `reconcileObject3DVisibility` (`ECS/ECSCoreSystems.ts:22`). A parallel `.visible` toggle fights
  it.

**Decision:** LOD selection is an ECS system writing per-entity level state, and the rendering
layer applies it (p348). `THREE.LOD` is not used.

## 3. Architecture decisions

| Decision                                                                   | Plan |
| -------------------------------------------------------------------------- | ---- |
| Measure GPU memory and draw calls before optimizing anything               | p345 |
| Several named spatial grids per world, each with its own tuning and policy | p346 |
| LOD chains are generated (meshoptimizer), not hand-authored per asset      | p347 |
| Selection by projected screen size, with hysteresis, in an ECS system      | p348 |
| Distant vegetation: cross-quads first, octahedral impostors after          | p351 |
| Physics bodies have simulation tiers, with explicit transition states      | p352 |
| Streaming is a cell state machine plus a build-time manifest               | p353 |
| GPU-driven culling and per-instance LOD selection are the end state        | p354 |

### 3.1 Multiple spatial grids, and why streaming isn't one of them

`_DONE_p050_spatial-index.md` §5.1 already prescribed "a separate grid instance per domain …
selected at opt-in", and its Phase 4 reminder names the trigger: "a second consumer needing very
different cell-size tuning". That trigger is here: light culling (20 m cells), NPC perception
(~5 m, p420), static scatter cells (p308), entity ownership per streaming cell (p353). p346 turns
the one-grid-per-world into named domains with their own cell size, capacity and update policy.

The original draft proposed the streaming layer as "a second `SpatialGrid` with a large
`cellSize`". That doesn't fit: `SpatialGrid` indexes _existing entities_, and an unloaded cell
has none. Streaming needs the cell coordinate and key maths (shared with the grid, extracted in
p346), a build-time cell manifest, and a per-cell residency state machine (p353). A spatial
domain is still useful _inside_ streaming: it answers "which live entities are in this cell" when
a cell unloads.

## 4. Findings checked against the code (2026-10-02)

Corrections to the original draft:

- three is `0.186.1`, not `0.183.2`. The asset type is `*.importedAsset.json`, not
  `*.importedMesh.json`. `TAG_FRUSTUM_CULLED` is at `ECS/ECSRegistry.ts:41`. The
  `InstancedMesh` bounding-sphere caveat is at `InstancedMeshPool.ts:140-147`.
- `LightFrustumCullingSystem` no longer exists. It was generalized into
  `ECS/ObjectFrustumCullingSystem.ts`.
- **`ObjectFrustumCullingSystem` does not use the spatial grid.** It loops over every
  `FRUSTUM_CULLING_ENABLED` entity. Only `LightObjectCullingSystem` queries the grid.
- **The bounding radius is not free.** `SpatialGrid` stores a radius per slot, but has no getter.
  The radius is computed once when the entity is added (`computeSpatialRadius`), so it goes stale
  on a scale change. Pool instances are not in the grid at all: `InstancedMeshPool.spawn` creates
  them with `world.createEntity`, not through `MeshManager`, so largeWorld's 3,500 trees and bushes
  aren't indexed (p346 fixes all three).
- **Stage placement.** `APP_RENDER_SYNC` has an order table now (`APP_RENDER_SYNC_ORDER`,
  `AppECSRegistry.ts:101`). LOD selection needs the final camera (after `POSE_CONSUMERS` and
  `SHADOW_FIT`) and this frame's frustum result (after `FRUSTUM_CULLING`). It gets its own slot
  (p348).
- **`InstancedMeshPool` has no despawn or slot recycling.** Moving an instance between per-level
  batches needs it (p348).
- **Streaming vs scene determinism.** p101 resets the physics world on every scene load to make
  loads deterministic. Streaming bodies in and out _during_ a scene is outside that guarantee
  (p353 §6).
- **p300's `mesh.simplify` is a single ratio** applied to the shipped mesh. A LOD chain is a new
  output of the same pipeline (p347).
- **Every rigid body takes a transform-buffer slot**, `FIXED` ones included
  (`workers/physics/physicsSwitchRigid.ts:21`), and `physicsToTransformSystem` syncs
  `BODY_STATIC` every frame on purpose (`PhysicsManager.ts:379-388`), marking every synced
  transform dirty, sleeping or not. Fine for a handful of bodies; a large world pays for every
  static body every frame and hits `maxBodies` (2048) early (p352 Phase 1).
- **Physics write-back audit (§6 of the draft): clean.** No system writes ECS transforms into
  physics every frame. Writes are explicit (`world.setTransform`, `world.setDisabled`,
  character controllers).

Questions the original draft marked `[UNVERIFIED]`, now answered:

- **Texture priming on WebGPU.** r186's `Renderer` has a synchronous `initTexture(texture)` (after
  `await renderer.init()`; `initTextureAsync` is deprecated since r181) and `compileAsync`, which
  the engine already uses (`MeshManager.ts:157`, `Geometry.ts:134`). The upload still happens on
  the call, so priming means spreading `initTexture` calls over frames under a budget, not a
  different API. No spike needed before p353; p353 measures the per-texture cost in its Phase 0.
- **Indirect draws.** The WebGPU backend supports `geometry.indirect` (`drawIndirect`,
  `renderers/common/Geometries.js:286`) and indirect compute dispatch. three is no blocker for
  p354. The engine has no compute passes yet.
- **Memory instrumentation.** r186's `renderer.info.memory` tracks counts _and byte sizes_ per
  category (textures, attributes, index attributes, storage, uniforms, programs, render targets)
  plus `total`, and `info.render` has per-frame `drawCalls` and `triangles`. The Assets debug tab
  already lists per-asset byte sizes (`_dbg__AssetStats.ts`). p345 is mostly wiring.

Still open: whether `@three.ez/batched-mesh-extensions`' LOD path works under `WebGPURenderer`
(§7.1). It is a spike inside p348, and p348 does not depend on it: its baseline is one
`InstancedMesh` per asset and level.

## 5. Texture and memory findings

### 5.1 LOD levels simplify materials, not just textures

Mipmapping already samples a smaller mip for a small on-screen object, per texture, for free. A
separate half-res texture per LOD level mostly duplicates that.

What a level should change is **shader cost and channel count**: LOD0 full PBR (albedo, normal,
ORM), a far level without the normal map on a simpler node material, an impostor sampling an
atlas. On a GPU-bound scene this matters more than texture bytes. p348's level definitions
therefore carry an optional material, not just a geometry.

Lower-res textures do pay off for _residency_ (uploading only the small mips of distant assets),
but that is mip streaming, which three doesn't provide. Out of scope.

### 5.2 Upload hitches

three uploads a texture lazily, on first use in a render, and keeps it until `.dispose()`. A
never-visible level costs no VRAM, but the frame it becomes visible pays a synchronous upload
(and, for a new material, a pipeline compile). With streaming that is "player rounds a corner, 40
assets appear, 200 ms stall", the most likely visible hitch in the whole system. Mitigation:
prime during streaming-in with budgeted `initTexture`/`compileAsync` calls (§4; p353 §5), and
pre-warm every LOD level's material at creation (p348).

### 5.3 Memory is the ceiling, not triangles

A browser tab gets a fraction of VRAM, and WebGPU drops the device rather than swapping. In rough
order of impact:

1. **GPU-compressed textures** (KTX2: BC7/ASTC/ETC2 via Basis): 4–6× smaller resident than RGBA8.
   That is p300.
2. **Atlasing / array textures**, so distant levels share one material and one batch (p351).
3. **Disposal on cell unload**, driven by the streaming state machine (p353).
4. **A budget tracker** (p345). Build it first: without it every later optimization is
   unmeasured.

## 6. Physics "LOD": simulation tiers

**Free wins first.** Rapier sleeps bodies below a velocity threshold and solves by island, so
sleeping bodies cost almost nothing in the solver. The engine doesn't keep bodies awake (§4 audit).
But the main thread still pays per body per frame (§4: static sync, dirty marking), and broad
phase and memory scale with body count. `PhysicsTransformBuffer`'s fixed `maxBodies` (default 2048) is a hard cap, and `allocateSlot` throws when it's full.

**Prior art:**

- **Unreal:** distance-gated simulation; the Significance Manager ranks objects and tiers down
  tick, physics and animation; World Partition streams physics with cells; Chaos can run async at
  a fixed rate.
- **Unity:** no built-in physics LOD. In practice `sleepThreshold` tuning, switching to kinematic
  beyond a distance, and disabling colliders through streamed subscenes. `LODGroup` is
  rendering-only.
- **GTA V:** _representation switching_. The map has an HD/LOD/SLOD hierarchy with bounds streamed
  per cell. Distant vehicles become "dummies" without real suspension, moved kinematically along
  the road network, and become full physics again on approach. Pedestrians likewise, then
  despawned and regenerated statistically.

Ækasha splits this in two. **p352** covers generic rigid bodies: tiers `FULL`, `STATIC`,
`DISABLED`, `REMOVED`, with explicit transition states (a `WORKER_THREAD` round trip must never
leave an entity half-created). **p420** covers characters and NPCs, where the "dummy"
representation (kinematic navmesh movers, crowds) lives. The draft's `KINEMATIC_PROXY` tier moves
to p420: a generic rigid body has no scripted motion to follow.

## 7. Nanite-class virtualized geometry

Nanite splits meshes into ~128-triangle clusters (meshlets) in a DAG of simplified groups. A
compute pass picks the coarsest clusters under a screen-space error threshold, culls per cluster
and draws indirectly, with software rasterization for sub-pixel triangles and geometry streaming.

**In a browser:** `Scthe/nanite-webgpu` implements the meshlet hierarchy, a software rasterizer,
billboard impostors, and per-instance and per-meshlet frustum and occlusion culling. WebGPU has no
`atomic<u64>`, so its software rasterizer packs depth into 32 bits. Its README is a good analysis
of Nanite.

**Assessment:** the full system is a multi-year subsystem, and software rasterization is the part
WebGPU makes painful. Per-instance LOD on the GPU (p354) gets most of the benefit for an outdoor
world. Cluster-level LOD stays research (§8, Tier 4).

### 7.1 Tooling

- **`meshoptimizer`** (WASM, npm): `simplify` with an error bound, plus vertex/overdraw
  optimization. The workhorse for LOD chains (p347). It runs in Node (build time) and in a browser
  worker (runtime), from the same package.
- **`@three.ez/simplify-geometry`**: wraps meshoptimizer for three.js. Small enough that p347 calls
  meshoptimizer directly.
- **`@three.ez/batched-mesh-extensions`**: `addGeometryLOD(geometryId, geometry, distance)` on
  `BatchedMesh`, plus BVH frustum culling and raycasting (threejs.org `webgl_batch_lod_bvh`:
  500k instances, 5 LODs each). Two flags: its per-instance uniforms are documented as
  `WebGLRenderer`-only, and its LODs must share one vertex array. p347's chains share the vertex
  buffer by design (meshoptimizer only writes new indices), which keeps the option open. Spike in
  p348.

## 8. Roadmap

Child plans, in the order they should run. Each is independently useful.

| Tier | Plan                                           | What it delivers                                                                                                  | Depends on                               |
| ---- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 0    | `_DONE_p345_gpu-memory-and-draw-call-debugger` | GPU memory by category and owner, draw calls, high-water marks, snapshot diff                                     | —                                        |
| 0    | `_DONE_p346_spatial-domains`                   | Named spatial grids per world; shared cell maths; radius fixes; pool instances indexable                          | —                                        |
| 1    | `p347_lod-chain-generation`                    | meshoptimizer LOD chains: runtime (worker) for procedural geometry, build time for GLBs                           | p300 Phase 2 (build-time part only)      |
| 1    | `p352_physics-simulation-tiers`                | Slot-less static bodies, no throw on capacity, then `STATIC`/`DISABLED`/`REMOVED` tiers                           | — (Phase 5: p353)                        |
| 1    | `p348_ecs-lod-selection`                       | Screen-size selection with hysteresis; apply to meshes, instanced pools, static cells                             | p347 (for generated chains), p346 (soft) |
| 2    | `p353_macro-streaming-grid`                    | Cell residency state machine, per-cell asset ownership, build-time manifest, priming                              | p346 Phase 1; p352 for its physics phase |
| 2    | `p351_impostor-billboard-lod`                  | Cross-quads, dithered cross-fade, octahedral impostors                                                            | p348 Phase 3                             |
| 3    | `p354_gpu-driven-culling` (stub)               | Compute frustum culling, indirect draws, per-instance LOD on the GPU                                              | p348, p346                               |
| 4    | — (research only)                              | Cluster (meshlet) LOD, §7: a timeboxed spike whose output is a recommendation, only if huge single meshes need it | p354                                     |

Physics tiers (p352) rank high because they are a stability ceiling (`maxBodies`, no runtime
bucket migration), and designing the async transition before there are many call sites is far
cheaper than retrofitting.

## 9. Open questions and known gaps

1. **Shadow LOD.** Shadow passes draw whatever level the main view selected. A separate shadow
   level (or no shadow casting for far levels) is a per-level `castShadow` in p348; a real
   shadow-specific selection is not planned.
2. **Terrain LOD** (clipmaps, quadtree, CDLOD) is a separate problem with its own literature. p306's
   power-of-two blocks keep it possible; p348 can switch whole blocks between generated chain
   levels, but crack-free stitching between neighbouring blocks is unplanned.
3. **Large-world float precision.** Rapier and the transform buffer use 32-bit floats: positions
   jitter a few km from the origin. Origin rebasing would be its own plan (p353 §8, p420).
4. **Mip streaming** (§5.1) is out of scope.
