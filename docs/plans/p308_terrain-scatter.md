Status: draft | not-implemented
Category: Terrain, Rendering, Assets
Blocked by: p306_terrain-blocks-and-procedural-terrain-meshes.md
Blocks: p310_terrain-preview-scenes.md
Epic: p301_terrain-texturing-epic.md
Related: p350_lod-system-research.md (instancing/batching layer, LOD selection), p307_wet-and-dry-surface-states.md (scatter gets wet too)

# Terrain Scatter (rocks, pebbles, ground details)

GPU-instanced detail on terrain blocks: pebbles, rocks, boulders and leaf-litter cards. Grass blades are out of scope (p301).

Instances come from two sources:

- **Blender**: Geometry Nodes, exported as GPU instances (`EXT_mesh_gpu_instancing`), which the importer doesn't handle yet.
- **The engine**: mask-driven procedural scatter from the block's splat weights and rules, seeded per block.

Static scatter renders as **cell-chunked instanced meshes without per-instance entities**. Scatter assets are owned by their terrain block (p306), so they stream with it later.

---

## Context (grounded)

- **`toolkit/geometry/scatterOnSurface.ts`:**
  - `scatterOnSurface({ surface: Mesh, count, seed?, minSpacing?, maxAttemptsPerPoint?, scaleRange?, alignToNormal?, randomYRotation? })` → `ScatterPlacement[]` (`{ position, normal, quaternion, scale }`). Area-weighted `MeshSurfaceSampler`, seeded.
  - `minSpacing` is **O(n²) rejection** (`:78`).
  - `bakeScatterToInstancedMesh(mesh, placements, startIndex)` (`:153`), `spawnScatterAsMeshEntities` (`:174/:189`, one entity per placement).
- **`toolkit/ecs/InstancedMeshPool.ts`:**
  - Every instance is an ECS entity with a `Transform` and a slot component.
  - `instancedMeshPoolSyncSystem` re-bakes changed instances at `APP_RENDER_SYNC`.
  - The pool mesh must be added to the scene by the caller.
  - Right for dynamic instances (largeWorld's trees); wasteful for 10 000 static pebbles.
- **`app/largeWorld.ts:69-121`** scatters trees and bushes into pools, with frustum culling through the ECS (`ObjectFrustumCullingSystem`, `core/Spatial/SpatialGrid.ts`).
- **Import:**
  - `EXT_mesh_gpu_instancing` is **not handled**, and extraction only walks `isMesh` nodes (`GLTFExtract.ts:49-127`). three's `GLTFLoader` turns that extension into `InstancedMesh`; we'd register its geometry and lose the instance matrices.
  - `GeometryTransfer.ts` serializes geometry attributes generically, but has no instance-matrix path.
- **Rocks:** `toolkit/geometry/generateAsteroid.ts` builds seeded displaced icospheres (positions and normals only, non-indexed by default), a base for procedural rocks.
- **p350:** LOD should be an ECS selection feeding the instancing/batching layer, not `THREE.LOD`. This plan's cell chunks are designed to be that layer's static case.

---

## Design

### D1 — Static instance chunks (engine: `core/StaticInstances.ts`)

- **`createStaticInstances({ id, geometry, material, placements | matrices, cellSize = 16, castShadow, receiveShadow, instanceColors?, maxDistance? })`** splits instances into a grid of cells.
  - Each cell is one `InstancedMesh` with its own `boundingSphere` (computed from its instances), so three's per-object frustum culling skips whole cells.
  - Each cell is an entity with `OBJECT3D` + `TAG_IS_MESH`, and disposal follows the normal mesh path. A block's cells are owned by the block (p306's `spawnTerrainBlock` handle).
- **`maxDistance`** hides cells beyond the distance, with hysteresis. It's evaluated by a system every N frames on cell centres (cheap; a few hundred cells). This is the only LOD here; p350 can replace it with real level selection (cell → level).
- **No per-instance entities, no per-frame sync.** Matrices are uploaded once.
- **`instanceColors`** (tint variation) use `InstancedMesh.instanceColor`.
- **Ownership:** registered geometries and materials are ref counted like other meshes (`createMeshEntity` path), so a shared rock material is released when the last cell goes.

### D2 — `*.scatter.json` (engine asset type)

```json
{
  "id": "showcaseCoast_rocks",
  "items": [
    { "geometry": "rockSmall_a", "material": "rockWet_rocks01", "weight": 3 },
    { "geometry": "rockSmall_b", "material": "rockWet_rocks01", "weight": 2 },
    {
      "geometry": "boulder_a",
      "material": "rockWet_cliffs01",
      "weight": 0.2,
      "collider": "CONVEXHULL",
      "castShadow": true
    }
  ],
  "source": {
    "type": "PROCEDURAL",
    "generator": "terrainScatter",
    "params": {
      "density": 0.6,
      "minSpacing": 0.4,
      "mask": { "layers": { "rocks01": 1, "sand01": 0.1 }, "slope": [0, 35] },
      "scale": [0.6, 1.4],
      "alignToNormal": 0.7,
      "sink": 0.15,
      "tint": 0.08
    },
    "seed": 3
  },
  "cellSize": 16,
  "maxDistance": 120
}
```

- **`source.type`:**
  - `PROCEDURAL`: a generator from `registerScatterGenerator(id, fn)`; the toolkit registers `terrainScatter`.
  - `IMPORTED`: `{ "importedAsset": "showcaseCoast_scatter", "nodes": ["Rocks*"] }`, the Blender GPU instances (D3).
  - `PLACEMENTS`: inline or file list, for hand placement or tools.
- **Items:** an item picks a geometry and material and may have a collider (`CONVEXHULL` / `BALL` / `NONE`).
  - Collider items become FIXED physics entities, one per instance. Use them only for large pieces; a lint warns above 200 colliders per block.
- **Ownership and seeding:** spawned by `spawnTerrainBlock` (p306's `scatter` ids) or on their own (`spawnScatter(id, { target })`). The seed is combined with the block's grid coordinates (p301 §7).

### D3 — Blender GPU instances import (engine: `core/Import/*`)

- **Extraction:** for nodes that three turned into `InstancedMesh` (`EXT_mesh_gpu_instancing`), store `instanceMatrices: Float32Array` (and `instanceColors` if present) in the manifest per node. Transfer them through the asset worker as transferable buffers (`GeometryTransfer.ts` gets an instance path).
- **Spawn:** `spawnImportedAsset` and the `IMPORTED` scatter source spawn such nodes through `createStaticInstances` (D1), with the node's custom props for item settings (`aekScatterCollider`, `aekCastShadow`).
- **Fallback when an exporter version mangles GPU instances:** a **point-cloud** mesh.
  - The points' positions are the instance positions.
  - Custom attributes `_ROT` (quaternion as vec4) and `_SCALE` (vec3) carry the rest, and `_ITEM` (int) picks the item.
  - The importer turns any node with custom prop `aekScatterPoints: 1` into placements.
  - It's documented as the robust path. Geometry Nodes writes those attributes with _Store Named Attribute_.

### D4 — Procedural scatter v2 (toolkit: `src/toolkit/terrain/scatter/terrainScatter.ts`)

- **Poisson-disk sampling** (Bridson, grid-accelerated, O(n)) over the block's XZ area, replacing the O(n²) rejection for this path. `scatterOnSurface` stays as is for arbitrary meshes.
- **Density mask** per candidate point, all CPU-readable:
  - **layer weights** from the block's vertex colours (bilinear on the grid) or from CPU rules (p306 `evaluateTerrainRulesCPU`);
  - a splat map only if its source is CPU-readable: an uncompressed PNG kept with `codec: none` and a CPU copy. KTX2 can't be read back (p300);
  - slope and height ranges;
  - `macroNoise`-equivalent CPU noise for clustering. The same periodic noise as p304 isn't available on the CPU, so a seeded simplex is used instead, documented as such.
- **Placement:**
  - height from `getHeightAt` (generated) or a downward ray against the block mesh (imported; `castRayFromDirection`, main-thread Three.js raycast, `core/Raycast.ts`);
  - normal from the height grid;
  - yaw random; tilt = slerp(up, normal, `alignToNormal`); `sink` buries a fraction of the bounding height; scale range; per-instance tint.
- **Determinism:** seed = hash(`worldSeed`, `gridX`, `gridZ`, scatter id). Scatter on a block never depends on load order.
- **Cost:** 5–20k candidates per 64 m block runs in a few ms. Measure it; the worker path is the same as p306 Phase 4 if it's needed.

### D5 — Scatter assets

- **Procedural rocks** (toolkit `generateRock`, wrapping `generateAsteroid`):
  - flattening and squash options, seeded variants;
  - indexed with smooth normals;
  - budgets: pebble ≤ 80 tris, rock ≤ 400, boulder ≤ 1500.
  - Registered geometries `rockPebble_a..c`, `rockSmall_a..c`, `boulder_a..b`.
- **Rock material** (toolkit `rockScatter.tsl.ts`, a `setup` material):
  - triplanar in object space, sampling **the same texture set as the terrain layer it sits on** (`rocks01`, `cliffs01`, …), so rocks match the ground and cost **no extra texture memory**;
  - dual-scale anti-tiling;
  - macro tint by world position, so neighbouring rocks differ;
  - `applySurfaceWetness` (p307), so rocks get wet with the ground;
  - a slight top-down "dust/moss" blend toward the ground layer's average colour (`averageColor`) to seat rocks into the terrain.
- **Imported rocks** (optional realism set, Poly Haven, CC0):
  - candidates verified to exist (2026-10-02): `rock_moss_set_01`, `namaqualand_stones_01`, `sand_rocks_small_01`, `boulder_01`;
  - download the **glTF at 1K** textures;
  - decimate in Blender to the budgets above (Decimate modifier, Collapse, then check silhouettes);
  - export geometry with its own 1K texture set (p300 `prop` profile);
  - stored in `src/toolkit/terrain/scatter/models/` with `source.json` records like p303.
- **Leaf litter cards:**
  - ambientCG `LeafSet024` (an Atlas asset with colour, normal, roughness and opacity; download 1K-PNG);
  - small flat quads with random atlas cells, alpha-tested (`alphaTest` + `alphaToCoverage` when MSAA is on);
  - for `grass02` and `mud02`; no shadows.
- **Shadows:** pebbles and cards don't cast; rocks and boulders do. Shadow-casting cells double their draw calls in the shadow pass.

---

## Handbook content (`docs/techniques/terrain-scatter.md`)

1. **What it is:** instanced detail, why instancing, cells, and why it isn't one entity per pebble.
2. **"Best for":**
   - **Always useful.** Scatter does more to break up terrain repetition than any texture trick.
   - First- and third-person: dense pebbles and rocks near the camera with `maxDistance`.
   - Top-down/RTS: fewer and bigger rocks, often with colliders for pathing.
   - Stylized: low-poly procedural rocks with flat-shaded variants.
   - **Poor fit:** huge counts of unique hero meshes; use regular meshes for those.
3. **Performance:**
   - draw calls = mesh types × visible cells (+ the shadow pass);
   - vertex cost = instances × triangles;
   - card overdraw;
   - colliders (count limits);
   - measured gallery numbers;
   - the `cellSize` / `maxDistance` trade-off.
4. **Blender, step by step** (`terrain_scatter.blend`):
   - a collection of rock variants, applied scale, origin at the bottom centre;
   - a Geometry Nodes modifier on the terrain block:
     - _Distribute Points on Faces_ (Poisson Disk, distance min, density);
     - density from the `Splat` colour attribute through _Named Attribute_ (the layer channel × factor);
     - _Instance on Points_ with the collection (Pick Instance, random index);
     - _Random Value_ rotation (Z) and scale;
     - _Align Euler to Vector_ on the normal with a factor;
     - _Translate Instances_ down for sinking;
   - **don't** realize instances;
   - export with _GPU Instances_ on (the exporter's scene-graph option), or the point-cloud fallback (D3: _Store Named Attribute_ `_ROT`, `_SCALE`, `_ITEM` on the points, then _Mesh to Points_ and export) when GPU instances don't come through;
   - pitfalls: unapplied rock scale, instances under the terrain, realize by accident (huge GLB).
5. **Procedural in the engine:** a `*.scatter.json` example per material (pebbles on sand, boulders at cliff bases with a slope mask, leaf cards on forest floor), tuning density and spacing, deterministic seeds.
6. **Variations, each with why and cost:**
   - rocks sharing the terrain texture set (zero VRAM) vs their own textures (realism);
   - colliders only on boulders;
   - tint variation vs more meshes;
   - cards vs meshes for litter.
7. **Pitfalls and checklist.**

---

## Phases

### Phase 1 — Static instance chunks and the scatter asset (D1, D2)

**Exit:** 20k pebbles on a 64 m block in 16 cells, culled per cell, released on scene exit; `PLACEMENTS` source works.

### Phase 2 — GPU instances import and the point-cloud fallback (D3)

**Exit:** a Blender GN scatter exported both ways spawns identically, and the worker and main-thread import paths agree.

### Phase 3 — Procedural scatter v2 (D4)

**Exit:** density follows the painted layers on a showcase block; the same seed and grid always give the same placements; boulder colliders work (p101 determinism holds; the probe is unchanged by scatter without colliders).

### Phase 4 — Assets (D5)

1. `generateRock`, the rock material (with wet), the optional Poly Haven set, leaf cards.

**Exit:** the gallery "Scatter" row shows procedural vs imported rocks on the same block, wet and dry.

### Phase 5 — Handbook, template, versioning

1. The `terrain-scatter.md` page and the `terrain_scatter.blend` template.
2. `readme.md` Features (engine: static instances, GPU instancing import, `*.scatter.json`; toolkit: terrain scatter, rocks).
3. Versions: engine minor, toolkit minor, app minor; `CHANGELOG.md`.

---

## Risks

| Risk                                                                     | Mitigation                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Blender's GPU-instances export option changes or drops custom attributes | Point-cloud fallback (D3); the add-on (p306) can gain an "Export Scatter" operator if needed                       |
| Too many cells means too many draw calls                                 | `cellSize` per scatter; merge item types into one geometry with groups later (BatchedMesh is a p350 topic)         |
| Per-instance colliders hurt physics                                      | Colliders only on flagged items; lint threshold; FIXED bodies only                                                 |
| Raycast placement on imported blocks is slow for large counts            | Use the grid height from the heightfield extraction (p306 D3) instead of raycasts when the block is a regular grid |
