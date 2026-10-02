Status: draft | not-implemented
Category: Terrain, Assets, Physics, Toolkit
Blocked by: p305_terrain-material-generator.md
Blocks: p307_wet-and-dry-surface-states.md, p308_terrain-scatter.md, p309_terrain-decals.md, p310_terrain-preview-scenes.md
Epic: p301_terrain-texturing-epic.md

# Terrain Blocks & Procedural Terrain Meshes

The geometry side of the epic. It covers:

- **Block conventions** that make each terrain block a self-contained, streamable unit. Stitching blocks into a world is a future plan; this one keeps it possible.
- **`*.terrainBlock.json`**: an engine asset type tying together geometry (imported or generated), terrain material plus per-block inputs (splat map, colour map), collider, scatter (p308) and decals (p309).
- **`spawnTerrainBlock`**, plus **robust heightfield extraction**. This fixes the known importer mismatch from p990.
- **`generateTerrain` v2** (toolkit):
  - world-continuous noise and edge-correct normals;
  - CPU rules → vertex-colour splat;
  - CPU horizon AO;
  - collider params for generated terrain.
- **The Blender workflow:** an add-on (`aekasha_terrain_tools.py`), the block template, and the technique templates.
- **Handbook:** `terrain-blocks-blender.md` and `terrain-procedural-meshes.md`, plus the Blender / Export / Import sections of p305's pages.

---

## Context (grounded)

- **`toolkit/geometry/generateTerrain.ts`:**
  - `generateTerrain({ width, depth, widthSegments, depthSegments, maxHeight, noiseOctaves?, seed? })` builds a centred, indexed grid. Vertex (row, col) sits at `x = col/wS·width − width/2`, `z = row/dS·depth − depth/2` (`:81-99`).
  - Seeded `SimplexNoise` sampled in **block-local** coordinates.
  - Attributes: `position`, `uv` (0..1), `normal` from `computeVertexNormals()`. No colour, no tangents.
  - Returns `{ geometry, getHeightAt, heights (row-major, X fastest) }`.
  - Used by `app/largeWorld.ts:39-55`: 200 × 200, 150 segments, flat PHONG material, **no collider** (`:23-31`).
  - p066 (current branch) proposes a `heightModifier` option (§2.7). Reuse it if it has landed by the time this plan runs.
- **Imports:**
  - `importAssetAsync` registers one geometry per primitive as `${id}/${nodeName}` and returns a manifest of node transforms and parsed Blender custom props (`core/Import/CustomProps.ts`).
  - `spawnImportedAsset(manifest, { material, meshProps, physicsParams, filter, entityOpts })` (`SpawnImported.ts:236-292`) creates mesh entities and physics from custom props. A `material` string resolves to a registered material.
  - `GeometryTransfer.ts` keeps every attribute (`color`, extra UVs, `_CUSTOM`) through the worker hop.
- **Custom props** (`CustomProps.ts`): `isPhysObj`, `rigidType`, `colliderType` (including `HEIGHTFIELD` with `nCols`/`nRows`, `TRIMESH`, `CONVEXHULL`), `keepMesh`, `index`, friction etc. Template: `src/_engine/3dModels/customPropTemplates.blend`.
- **Heightfield extraction** (`core/Import/MeshColliderGeometry.ts:74-129`):
  - `mergeVertices`;
  - assumes a square grid when `nrows`/`ncols` are absent;
  - indexes `heights[i*sizeZ + j] = posY[(sizeZ−1−j)*sizeX + i]` (column-major, Z flipped), i.e. **by vertex order**;
  - `scale = {bboxX, scale.y, bboxZ}`;
  - refuses Draco.
  - **Known bug (from p990):** the collider is centred on the node origin, but a mesh whose bbox isn't centred sits ~0.5 units off. Up to ~190 heights near one edge differ from the mesh by ≤ 0.22 units, probably from the vertex order after `mergeVertices`.
- **Physics:** `createPhysicsEntity({ type: 'HEIGHTFIELD', nrows, ncols, heights, scale }, { rigidType: 'FIXED' }, target)`. Rapier's `HeightFieldData` is column-major (`EngineRapier.ts:396-419`, `:515`).
- **Scene loads hold physics stepping** until every `createPhysicsEntity` settles (p101), so blocks spawned in `scene()` are deterministic.

---

## Design

### D1 — Block conventions (binding; p301 §4.4 in detail)

| Property        | Rule                                                                                                                                         | Why                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Shape           | Square, edge `size` = 32 / 64 / 128 / 256 m                                                                                                  | Power-of-two grids line up with LOD and streaming later                                 |
| Grid            | `resolution = 2^n + 1` vertices per side (65, 129, 257); a regular grid in X/Z, vertices move only in Y                                      | Heightfield colliders; shared edge vertices                                             |
| Spacing         | `size / (resolution − 1)`; 0.5 m (64/129) for close-up, 1 m (128/129 or 256/257) for worlds                                                  | Vertex-colour splat resolution = spacing                                                |
| Origin          | Block centre in X/Z, Y = 0; heights are absolute world Y                                                                                     | Rapier heightfields are centred on the body; blocks stack in a grid by translation only |
| World placement | `position = (gridX · size, 0, gridZ · size)`                                                                                                 | Grid coordinates are the streaming key                                                  |
| Edges           | Neighbours share edge vertex positions exactly; normals at edges come from the continuous surface (D4, D5)                                   | No cracks, no lighting seams                                                            |
| UV0             | Top-down 0..1 over the block, U along +X, V along +Z (world)                                                                                 | Splat / colour maps (block-local data)                                                  |
| `COLOR_0`       | `RGB_AO` or `RGBA` (p305 D4), Byte Color, vertex domain                                                                                      | Splat weights + vertex AO                                                               |
| Extras          | Custom attributes prefixed `_` (glTF rule), e.g. `_WETNESS` (p307 regional wetness)                                                          | Optional                                                                                |
| Tangents        | None                                                                                                                                         | World-space tiling has an analytic frame (p301 §4.1)                                    |
| Materials       | Not exported; the engine assigns the terrain material                                                                                        | Swappable maps (p301 goal 3)                                                            |
| Custom props    | `colliderType: "HEIGHTFIELD"`, `nCols`, `nRows`, `isPhysObj: 1`, `rigidType: "FIXED"`, `aekBlockSize`, `aekBlockRes`, `aekGridX`, `aekGridZ` | Collider and metadata travel with the GLB                                               |

### D2 — `*.terrainBlock.json` (engine asset type)

**Why an engine asset type, not just a mesh JSON plus code:**

- A block is the unit a future world streamer loads and unloads. Today it's 3–6 files (GLB, imported asset, splat, colour map, scatter, decals) plus a material variant and a collider. Without a manifest, that unit only exists in scene code.
- **Alternative considered:** a `*.mesh.json` with `matOverrides` plus custom-prop colliders spawned through `spawnImportedAsset`. It works today but has no single manifest and no generated-geometry path. Rejected for the reasons above.
- The engine spawner stays generic: generated geometry goes through a generator **registry** that the toolkit fills. The engine never imports toolkit code.

```json
{
  "$schema": "../../../../.schemas/terrainBlock.schema.json",
  "id": "showcaseCoast",
  "geometry": { "importedAsset": "showcaseCoast", "node": "TerrainBlock" },
  "material": "terrainCoast",
  "materialInputs": { "splatMap": "showcaseCoast_splat" },
  "grid": { "x": 0, "z": 0, "size": 64, "resolution": 129 },
  "collider": { "type": "HEIGHTFIELD", "friction": 1.2 },
  "shadows": { "cast": true, "receive": true },
  "scatter": ["showcaseCoast_rocks"],
  "decals": ["showcaseCoast_decals"]
}
```

- **Generated geometry:** `"geometry": { "generator": "noiseTerrain", "params": { "maxHeight": 6, "octaves": [[0.02, 1], [0.08, 0.3]] }, "seed": 11 }`. The generator is looked up in `registerTerrainGenerator(id, fn)`; the toolkit registers `noiseTerrain` and `rulesTerrain`. Seeds combine with `grid.x`/`grid.z` (p301 §7).
- **`materialInputs`** become a material variant (`getMaterialVariant(material, { inputs })`, p302 D2). Blocks of one biome share a pipeline (p302 Phase 3 verifies).
- **`collider.type`:**
  - `HEIGHTFIELD` (default; from geometry, D3);
  - `TRIMESH` (overhangs, caves; costlier);
  - `NONE` (background blocks).
- **`scatter` / `decals`** are ids of p308/p309 assets, spawned with the block and owned by it.
- **Loading:** the scene schema gets `terrainBlocks: string[]` (asset preloading: geometry, textures through p302's dependency closure). **Spawning stays in scene code** (`await spawnTerrainBlock(id, opts?)`) so this plan doesn't anticipate "physics objects in scene JSON" (a roadmap item). That plan can later make `SceneLoader` spawn listed blocks automatically.
- **`spawnTerrainBlock`** returns `{ meshEntityId, physicsEntityId?, scatterIds, decalIds, dispose() }`. Everything is deleted on scene exit like any non-persistent entity.

### D3 — Robust heightfield extraction (`core/Import/MeshColliderGeometry.ts`)

- **Index by position, not vertex order.**
  - After `mergeVertices`, compute the bbox and spacing (`dx = sizeX / (ncols − 1)`).
  - Bucket each vertex by `col = round((x − minX) / dx)`, `row = round((z − minZ) / dz)`.
  - Fill `heights` in Rapier's column-major layout with the same Z flip as today.
  - Validate that every cell got exactly one vertex. Otherwise error with the first offending cell ("not a regular grid: was a vertex moved in X/Z?").
- **Centre offset:** offset the collider by the bbox centre relative to the node origin (rigid body translation), instead of assuming a centred mesh. Warn when the offset is non-zero for a `terrainBlock` (the convention says centred).
- **Generated terrain:** `toHeightfieldColliderParams(generated)` converts `generateTerrain`'s row-major heights. The mapping proposed by the p301 survey (`nrows = depthSegments`, `ncols = widthSegments`, transposed, `scale = {width, 1, depth}`) is **unverified**. Verify it with the Physics API tab's collider wireframe over a strongly asymmetric test terrain (a single spike near one corner).
- **Fixes the former p990 item** "Heightfield importer mismatches" (p125), which moved here on 2026-10-02. Its full text is in the Context section above. Re-check the Gym terrains (`terrainSpiked`, `terrainSmooth`) with the wireframe.

### D4 — `generateTerrain` v2 (toolkit, backwards compatible)

New optional fields on `TerrainOptions`:

| Option                                                                                     | Effect                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `center?: [x, z]`                                                                          | Noise is sampled at **world** coordinates `center + local`, so neighbouring blocks continue each other. Default `[0, 0]` reproduces today's output exactly                                                                                   |
| `heightFn?: (x, z) => number`                                                              | Replaces the octave noise (custom shapes, heightmaps)                                                                                                                                                                                        |
| `heightModifier?`                                                                          | p066's option, if not yet present                                                                                                                                                                                                            |
| `normals?: 'GEOMETRY' \| 'HEIGHT_FN'`                                                      | `HEIGHT_FN`: central differences of the height function, including samples beyond the block edge. The result is seamless normals across blocks                                                                                               |
| `vertexColors?: { layout: 'RGB_AO' \| 'RGBA'; rules?: TerrainRule[]; ao?: HorizonAOOpts }` | CPU evaluation of p305's rules into `COLOR_0` (same `TerrainRule` type and math; one shared pure-TS implementation, `evaluateTerrainRulesCPU`, unit-tested against the TSL output on the gallery's rules block). AO goes into A for `RGB_AO` |
| `ao?: { directions: 8; radius: number; strength: number }`                                 | Horizon-based AO on the height grid (max elevation angle per direction, averaged). Large-scale occlusion (valleys, under cliffs), the part a tiling layer can't carry                                                                        |
| `collider?: boolean`                                                                       | Also returns `heightfield: ColliderParams` (D3)                                                                                                                                                                                              |
| `skirt?: number`                                                                           | Optional skirt depth (hides cracks between blocks of different resolution later; off by default)                                                                                                                                             |

- **Cost** on the main thread, to be measured in Phase 3: a 257² block with 3 octaves takes ~10–30 ms; horizon AO (8 directions × 16 steps) is ~50–150 ms.
- **Threaded option:** if a block exceeds 16 ms, Phase 4 moves generation into the asset worker as a new `runAssetTask('TERRAIN_GENERATE', …)` task returning transferable buffers. Rule closures (`heightFn`) can't cross into the worker, so worker generation supports the declarative options only.
- **Heightmap import (Phase 4, optional):** `terrainFromHeightmap({ url, format: 'R16' | 'R32F', size, heightRange })` for heightmaps from Gaea, World Machine or World Creator, as a Blender-less path.
  - Raw little-endian files, fetched as an `ArrayBuffer`.
  - 16-bit PNGs aren't used: browsers decode them to 8 bits through `ImageBitmap`.

### D5 — Blender add-on (`src/toolkit/terrain/blender/aekasha_terrain_tools.py`)

A single-file add-on (Blender ≥ 4.2; installable with _Edit → Preferences → Add-ons → Install from Disk_; check against the current LTS at implementation time). It adds an "Ækasha" sidebar tab with these operators:

| Operator                  | What it does                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add Terrain Block**     | Grid of `size` × `resolution` (exact vertex count), origin at centre, UV projected top-down with the engine's orientation, `Splat` colour attribute (vertex, byte, black), custom props pre-filled (D1), the "AEK Terrain Preview" material assigned |
| **Validate Block**        | Regular X/Z grid (no vertex moved off its column/row), vertex count, origin, applied transforms, no loose geometry, splat sums ≤ 1, and edge heights equal to any neighbouring block in the file                                                     |
| **Normalize Splat**       | Rescales RGB(A) so the sum is ≤ 1 (fixes over-painting)                                                                                                                                                                                              |
| **Bake AO → Splat Alpha** | Cycles AO bake into a temporary colour attribute (samples, distance), then copies R into `Splat`.A                                                                                                                                                   |
| **Bake Colour Map**       | Bakes the preview material's diffuse colour (and optionally AO) to an image (p305 D7, the Blender path)                                                                                                                                              |
| **Split Into Blocks**     | Cuts a large terrain into N × N blocks with shared edges; custom normals transferred from the unsplit mesh (Data Transfer: Face Corner Data → Custom Normals); grid props set. Prepares the future world plan; used now only for a 2 × 2 test        |
| **Export Block**          | Exports glTF with locked settings (below) to the block folder, saves the splat/colour images, and writes `<id>.importedAsset.json` and `<id>.terrainBlock.json` stubs if missing                                                                     |

**Locked export settings** (also documented for manual export):

- Format: glb.
- Include: Selected Objects, Custom Properties ✓.
- Transform: +Y Up ✓.
- Mesh: Apply Modifiers ✓, UVs ✓, Normals ✓, Tangents ✗, Vertex Colors: Active (Blender 4.2+ naming), Attributes ✓ (`_`-prefixed), Loose Edges/Points ✗.
- Materials: No export. Images: None.
- Compression ✗: p300 applies meshopt without quantization; Draco breaks colliders.
- Animation ✗.

**"AEK Terrain Preview" node group:** a Blender shader approximation of p305 (up to 5 layers, height blend via Math nodes, world-space tiling from the Object/Geometry position, colour-attribute weights). Artists see roughly the engine result while painting. It's documented as an approximation.

### D6 — Templates (`src/toolkit/terrain/blender/`)

| File                             | Content                                                                                                   | Doc                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `terrain_blockTemplate.blend`    | Empty 64 m / 129 block, preview material, custom props, export preset, a README text block                | `terrain-blocks-blender.md`     |
| `terrain_singleLayer.blend`      | A shaped block, single layer, world tiling                                                                | `terrain-single-layer.md`       |
| `terrain_vertexColorSplat.blend` | 5-layer painted vertex splat + baked vertex AO                                                            | `terrain-vertex-color-splat.md` |
| `terrain_splatMap.blend`         | 1K splat image painted in Texture Paint, 5 layers                                                         | `terrain-splat-map.md`          |
| `terrain_triplanarCliff.blend`   | Block with a steep cliff band (heightfield-safe: steep, not overhanging); trimesh variant for an overhang | `terrain-triplanar-cliffs.md`   |
| `terrain_colormapDetail.blend`   | Splat block + colour map bake set-up                                                                      | `terrain-colormap-detail.md`    |
| `structure_concrete.blend`       | Wall + bunker pieces, wear vertex colours                                                                 | `structure-materials.md`        |

- **Rules for all templates** (p301 §2):
  - compressed save;
  - no packed images;
  - relative image paths into `src/toolkit/terrain/textureSets/*/source/raw/` (fetched by `yarn fetchTextureSources`);
  - a README text block mirroring the handbook page;
  - ~1–3 MB each.
- **Repo hygiene:** add `*.blend1` to `.gitignore`, and remove the two tracked backups (`src/_engine/3dModels/3DSymbols.blend1`, `characterObstacles.blend1`) in this plan's last phase.

---

## Handbook content

### `docs/techniques/terrain-blocks-blender.md` (the common workflow every technique page links)

1. **Set-up:** Blender version; Units (Metric, scale 1.0, metres); clip end 1000 m; install the add-on; run `yarn fetchTextureSources` so templates find their images.
2. **Create a block:** with the add-on (size, resolution, grid position), or manually.
   - Manual: _Add → Mesh → Grid_, size 64, subdivisions until the Statistics overlay shows 16 641 vertices (129²). Name it, origin to the world origin, then apply rotation and scale.
3. **Shape it, heightfield-safe:**
   - **Displace modifier:** Texture Coordinates _Global_, so neighbouring blocks continue each other; Direction Z; Midlevel 0.
   - **Sculpting:** in the Symmetry popover, **lock X and Y**, so vertices only move vertically.
   - **A.N.T. Landscape** (extension): set its grid to the block resolution.
   - No overhangs on HEIGHTFIELD blocks; use TRIMESH (and say why) when you need one.
   - Apply the modifiers.
4. **UVs:** done by the add-on, or top view → _UV → Project from View (Bounds)_. Check orientation with the corner-marker image (top-left red, top-right green) against the gallery's orientation block.
5. **Paint** (per technique page): vertex colours or splat image, with the preview material.
6. **Bake AO** (optional): _Bake AO → Splat Alpha_. Why: valley-scale AO, applied to indirect light only in the engine, at zero cost.
7. **Custom props:** collider and block metadata (D1 table); copy from `customPropTemplates.blend`.
8. **Validate, then Export Block** (or manual export with the locked settings).
9. **Into Ækasha:**
   - the files written, and what to fill in `terrainBlock.json`;
   - the scene: `terrainBlocks` list plus `await spawnTerrainBlock(id)`;
   - checking the collider with the Physics API tab's wireframe.
10. **Multi-block preparation:** shared edges, normal transfer, _Split Into Blocks_, grid coordinates. A preview of the future world workflow.
11. **Pitfalls:**
    - moved X/Z vertices (validator);
    - Blender's Y vs glTF −Z (UV orientation);
    - forgotten Apply Scale;
    - Draco on;
    - Float Color (doubles the size for no gain);
    - painting over 1 (normalize);
    - `.blend1` files.

### `docs/techniques/terrain-procedural-meshes.md`

- `generateTerrain` v2 options with examples: a single block, a 3 × 3 continuous patch (`center`), `HEIGHT_FN` normals.
- **Rules on the CPU (vertex colours) vs in the shader:**
  - CPU: zero per-pixel ALU, resolution = vertex spacing, can't change at runtime without regenerating.
  - Shader: per-pixel crisp, reacts to uniforms (e.g. snow line moving with p307's snow coverage), ALU cost.
  - Measured in the gallery.
- CPU horizon AO: why, cost, settings.
- Colliders for generated terrain (`collider: true`).
- Seeds and determinism (`worldSeed`, grid).
- Worker generation (if Phase 4 lands) and heightmap import.
- "Best for": procedural/sandbox/survival worlds, roguelites, prototypes, infinite runners. Poor fit: art-directed hero areas (use Blender or the splat combo).

### Completing p305's pages

Add sections 5–7 (Blender, Export, Import) to the seven p305 pages, each referencing its template and the common workflow, plus that technique's specific steps:

- **Vertex splat:** channel-by-channel painting with pure-colour brushes; why Mix blending keeps sums ≤ 1.
- **Splat map:** image size per block size, Non-Color, painting single channels, saving 8-bit PNG; orientation check.
- **Triplanar cliffs:** cliff bands under heightfield rules; when to switch to TRIMESH; no UV care needed for cliffs (world triplanar).
- **Colour map + detail:** _Bake Colour Map_, image size (2K per 64–128 m), what not to bake (direct sun with day-night).
- **Structures:** UV-free triplanar, wear painted as vertex colours, scale and origin rules for object-space mode.

---

## Phases

### Phase 1 — Heightfield extraction (D3)

1. Position-bucketed extraction, centre offset, regular-grid validation, `toHeightfieldColliderParams` with the asymmetric-spike check.
2. Re-check the Gym terrains (the item was already moved out of p990 into this plan).

**Exit:** collider wireframe coincides with the mesh (≤ 1 mm) on the Gym terrains and on a generated asymmetric terrain.

### Phase 2 — Terrain block asset (D2)

1. Schema, suffix, generated section, scene `terrainBlocks`.
2. Generator registry, `spawnTerrainBlock` (imported and generated geometry, material variant inputs, collider, shadows).
3. p308/p309 hooks stay empty until those plans.

**Exit:** a JSON-only block (imported Gym terrain re-used as a test) and a generated block spawn, collide and are released on scene exit.

### Phase 3 — `generateTerrain` v2 (D4)

1. Options, CPU rules, horizon AO, collider params.
2. `noiseTerrain` and `rulesTerrain` generators registered from the toolkit (`AppECSPlugins.ts` or a toolkit init import).
3. Gallery isolated blocks become `terrainBlock` JSONs with generated geometry.
4. `largeWorld.ts` stays byte-identical (default options); optionally give it a collider in a separate commit.

**Exit:** a 3 × 3 generated patch has no visible seams in geometry or lighting, and CPU-rule colours match the shader rules on the same block.

### Phase 4 (optional) — Worker generation, heightmap import (D4)

**Exit:** a 257² block with AO generates without a frame over 16 ms.

### Phase 5 — Blender add-on (D5)

**Exit:** _Add → paint → bake AO → Validate → Export_ produces a block that spawns correctly, with the splat orientation matching the gallery's orientation block.

### Phase 6 — Templates, handbook, hygiene, versioning

1. The 7 templates (D6).
2. The two new pages, plus sections 5–7 of p305's pages.
3. `*.blend1` in `.gitignore`; remove the two tracked backups.
4. **Repo docs:**
   - `readme.md` Features: terrain blocks (engine) and procedural terrain v2 (toolkit); a new asset JSON type (`*.terrainBlock.json`); commands if any.
   - `CLAUDE.md`'s data pipeline suffix list.
5. Versions: engine minor, toolkit minor, app minor; `CHANGELOG.md`.

---

## Risks

| Risk                                                                  | Mitigation                                                                                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blender exporter option names change between versions                 | The add-on owns export (one place to fix); the docs name the Blender version they were checked with                                                  |
| A vertex-colour export option exports the wrong attribute             | The add-on sets the active colour attribute before export; the validator checks for `COLOR_0` in the written GLB (gltf-transform inspect in Phase 5) |
| Heightfield extraction rejects real-world sculpted meshes (X/Z drift) | Clear error naming the cell; the add-on's validator catches it in Blender first; TRIMESH as an explicit opt-out                                      |
| CPU rules drift from TSL rules                                        | One shared spec; a gallery A/B block                                                                                                                 |
| Generated blocks hitch the main thread                                | Measured; worker path (Phase 4)                                                                                                                      |
