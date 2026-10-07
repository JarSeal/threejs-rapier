Status: draft | epic — not-implemented
Category: Terrain, Materials, Assets
Blocks: p302_material-and-texture-system-refactor.md, p303_texture-sets-and-terrain-texture-library.md, p304_procedural-texture-baker.md, p305_terrain-material-generator.md, p306_terrain-blocks-and-procedural-terrain-meshes.md, p307_wet-and-dry-surface-states.md, p308_terrain-scatter.md, p309_terrain-decals.md, p310_terrain-preview-scenes.md
Related: p299_texture-arrays-and-atlases.md (the array/atlas core p303 and p309 build on), p370_static-mesh-merging-and-texture-atlas-systems.md (mesh merging; new terrain processes in its §10)

# Terrain Texturing — Epic

Large-surface texturing for Ækasha: terrain (sand, mud, rocks, cliffs, snow, ice, grass ground) and large structures (concrete). It covers imported texture sets and procedural textures, splatting, anti-tiling, triplanar mapping, wet/dry states, scatter and decals. It ships with:

- a texture library in the toolkit;
- a terrain material generator in the toolkit;
- Blender templates;
- a technique handbook in `docs/techniques/`;
- two preview scenes in the app.

This file is the epic: shared decisions, conventions, the plan map and the technique catalogue. The work happens in p302–p310. Each child plan is phased so it can be reviewed and committed in chunks.

**Out of scope:**

- **Stitching terrain blocks into one large streamed world.** It has no plan yet. Every decision below keeps it possible; see §7.
- Grass blades and foliage. The grass layers here are the ground the blades will stand on.
- Terrain LOD (p350 lists it as a known gap).
- Water surfaces. Puddles are a material effect (p307), not a water body.

---

## 1. Goals

1. **Fast by default.** Every technique states its per-pixel texture fetch count and VRAM cost. Features compile out when unused ("only bring into existence what you need"). Wherever it has a choice, the generator picks the cheaper option.
2. **One generator, many techniques.** `createTerrainMaterial(config)` (p305) covers single-layer tiling, anti-tiling, macro variation, vertex-colour splat, splat maps, procedural rules, triplanar/biplanar, colour map + detail, wet/dry, and structures, all from one config.
3. **Swappable maps.** Geometry, texture maps and materials are separate assets. A block's maps can be changed in the engine without re-exporting its GLB. Texture sets are referenced by id.
4. **A documented artist workflow.** Each technique has a handbook page: Blender → export → import → set up, with variations, performance cost, and which art styles and game types it suits.
5. **Comparable in practice.** The `terrainGallery` scene shows every material and technique side by side, with GPU timing and camera presets per game type (first-person, third-person, top-down, RTS, side view).

---

## 2. Answers to the epic's design questions

**Imported textures or procedural materials?**

- **Both, each for what it's good at.**
  - High-frequency surface detail comes from tiled, imported (or baked) texture sets (p303), compressed as KTX2 (p300).
  - Low-frequency variation (macro tint, blend noise, rules) is procedural but cheap: a small noise texture sampled at large scale, or a few ALU ops.
- **Heavy procedural looks** (FBM, domain warping, Voronoi) are baked once into textures by the procedural baker (p304) and then cost the same as imported ones.
- Baked textures are uncompressed in VRAM; runtime GPU compression isn't practical in the browser. Use them where download size or per-seed variety matters, and imported KTX2 elsewhere.

**Where do the assets live?**

| Asset                                                                     | Folder                                     | Why                                          |
| ------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| Texture sets (maps + set JSON)                                            | `src/toolkit/terrain/textureSets/<setId>/` | Reusable across apps, ships with the toolkit |
| Shared generated textures (macro noise, ripple atlas, procedural decals)  | `src/toolkit/terrain/textures/`            | Reusable                                     |
| Material generator, TSL nodes                                             | `src/toolkit/terrain/`                     | Toolkit module                               |
| Block geometry (GLB), splat maps, colour maps, block meshes, scatter data | `src/app/terrain/blocks/<blockId>/`        | Specific to one world                        |
| Terrain materials for a world (layer choice, tuning)                      | `src/app/terrain/materials/`               | App-specific tuning of toolkit sets          |
| Preview scenes                                                            | `src/app/terrain*.scene.json` + `.ts`      | App                                          |
| Blender templates                                                         | `src/toolkit/terrain/blender/`             | See below                                    |

- Optimized binaries are generated into `src/public/aek-assets/` (p300 DD3). Sources sit next to their JSON.
- The CC0 texture sources aren't committed. `yarn fetchTextureSources` re-downloads them from `source.json` manifests into gitignored `source/` folders (p303).

**Should the Blender files be in the toolkit?**

- **Yes, one template per technique, under these rules.** There is precedent: `src/_engine/3dModels/customPropTemplates.blend`, `characterObstacles.blend`.
  - Save with **Compress** on, and **never pack images**. Images use relative paths into the fetched `source/` folders, so a template is ~1–3 MB and opens with textures after `yarn fetchTextureSources`.
  - Gitignore `*.blend1`. The repo currently tracks two `.blend1` backups in `src/_engine/3dModels/`; remove them in p306's docs phase.
  - The handbook page is the source of truth. The template is its worked example, so a template that drifts from its doc is a bug.
  - Git LFS isn't set up (not installed here). About 10 templates at ~2 MB is acceptable without it, but each re-save adds its full size to history. Re-save templates only when a doc changes; adopt LFS if binary churn becomes a problem (Open questions).
  - A small Blender Python add-on (`src/toolkit/terrain/blender/aekasha_terrain_tools.py`, p306) does the error-prone parts: export settings, the grid check, the AO-into-vertex-colour bake, JSON stubs. The templates aren't the only way to get those steps right.

---

## 3. Plan map

```
p300 asset pipeline (KTX2, meshopt, packing)
  ├─ p299 texture arrays & atlases (engine; p370 epic) ──► p303 D4, p309 D1
  └─ p302 material & texture system refactor (engine)
       └─ p303 texture sets + terrain texture library (engine asset type, toolkit sets, gallery skeleton)
            ├─ p304 procedural texture baker (engine core + toolkit generators)
            └─ p305 terrain material generator (toolkit) ◄─ p304 (macro noise, optional)
                 └─ p306 terrain blocks + procedural terrain meshes (Blender + engine)
                      ├─ p307 wet & dry surface states (engine state + material)
                      ├─ p308 terrain scatter
                      └─ p309 terrain decals
                           └─ p310 preview scenes (gallery complete + showcase, Blender builds)
```

| Plan | Delivers                                                                                                                                                                 | Main parts             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| p302 | Engine prerequisites: texture JSON gaps, multi-socket TSL `setup` entry, a material input resolver registry, scene dependency closure, two bug fixes                     | Engine                 |
| p303 | `*.textureSet.json` asset type, `FULL`/`LITE`/`MINIMAL` packings, layer array assembly, 16 CC0 texture sets with a fetch script, `terrainGallery` skeleton               | Engine + Toolkit + App |
| p304 | `bakeTexture()` (TSL node → mipmapped texture, 2D/array), procedural surface generators, macro noise, ripple atlas                                                       | Engine + Toolkit       |
| p305 | `createTerrainMaterial` and the `terrain` TSL material: every texturing technique, quality variants, debug views                                                         | Toolkit                |
| p306 | Block conventions, the Blender block workflow and add-on, `spawnTerrainBlock`, robust heightfield extraction, `generateTerrain` v2 (vertex splat, CPU AO, world offsets) | Engine + Toolkit       |
| p307 | Surface conditions state (wetness, puddles, rain), wet/dry response per layer, snow coverage                                                                             | Engine + Toolkit       |
| p308 | Instanced scatter: Blender GPU instances import, mask-driven procedural scatter, static instanced chunks, rock assets                                                    | Engine + Toolkit       |
| p309 | Mesh decals (Blender) with an atlas material, runtime projected decals, procedural decals                                                                                | Toolkit                |
| p310 | Complete `terrainGallery` with measurements, `terrainShowcase` (3 Blender blocks + 1 procedural + a structure), final handbook pass                                      | App + Docs             |

p304 can be implemented in parallel with p305 Phase 1. p308 and p309 are independent of each other.

p299 (texture arrays and atlases) is outside this epic but runs before p303: p303's layer arrays and p309's decal atlases are built on it. The mesh merging plans (p370 epic, p371–p376) run after the LOD plans; nothing here is blocked by them, but they add the modular kit and tile-chunk processes (§5) and lower the draw count of a block's static dressing (§7).

---

## 4. Shared conventions

These are binding for every child plan.

### 4.1 Units and space

- 1 unit = 1 metre, Y up. Blender's Z up is converted by the glTF exporter (+Y Up).
- **World-space tiling is the default** (`uv: 'WORLD'`): layers tile on `positionWorld.xz` (or the triplanar projections). Mesh UVs are reserved for block-local data (splat maps, colour maps). This makes tiling seamless across blocks for free.
- Tangent frames for world-XZ tiling are analytic (T = +X, B = +Z, then Gram–Schmidt against the normal). Terrain GLBs need no tangent attribute.

### 4.2 Texel density

- A texture set declares its **physical size** in metres (`physicalSize: [w, h]`): the real-world area one tile covers. Tiling uses it, so layers with different scans line up in scale.
- Target near-camera density:

| Camera         | Target density | Example                  |
| -------------- | -------------- | ------------------------ |
| First person   | 256–512 px/m   | a 1K set over 2–4 m      |
| Third person   | ~256 px/m      |                          |
| Top-down / RTS | ~64–128 px/m   | then a 512 set is enough |

- Ship 1K by default (KTX2, `terrainLayer` profile). Ship 2K only for cliffs and hero sets.

### 4.3 Texture-set packings (defined in p303)

| Packing   | Textures | Channels                                                                                                      | Use                                                      |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `FULL`    | 3        | `albedoHeight` (RGB albedo sRGB, A height), `normal` (RGB, OpenGL +Y), `orm` (R AO, G roughness, B metalness) | Best quality, all features                               |
| `LITE`    | 2        | `albedoRough` (RGB albedo × AO, A roughness), `normalHeight` (RG normal XY, B height; Z reconstructed)        | Default for terrain: height blend and wet/dry still work |
| `MINIMAL` | 1        | `albedoHeight` (RGB albedo × AO, A height); normal from height derivatives or flat                            | Stylized, top-down, low-end                              |

AO baked into albedo is the standard trade-off on these surfaces. It removes a fetch per layer per tap. The cost: AO then darkens direct light too, which is physically wrong but invisible at pebble scale. It also stacks with GTAO, so lower the per-material AO influence. p303 documents this in detail.

### 4.4 Blocks (defined in p306)

- Square blocks with a power-of-two edge (64 m for previews; 128/256 m for worlds).
- A regular grid of `2^n + 1` vertices per side; the origin is at the block centre; heights are absolute world Y.
- Neighbouring blocks share their edge vertices exactly.
- Block metadata: `{ gridX, gridZ, size, resolution, heightRange }`, stored in the block's JSON and Blender custom props.
- **Vertex colour convention** (`COLOR_0`): `RGB_AO` (R, G, B weights for layers 1–3, A = baked AO; layer 0 = remainder) or `RGBA` (4 weights + base layer). Custom attributes (`_NAME`) only for extras.

### 4.5 Naming

- Texture set ids: `<material><nn>`, e.g. `sand01`, `cliffs02`.
- Texture ids: `<setId>_<slot>`, e.g. `sand01_albedoHeight`.
- Block ids: `<world>_<gridX>_<gridZ>` or descriptive names for previews (`showcaseCoast`).
- Terrain material ids: `terrain<Name>` (`terrainCoast`).

### 4.6 Quality tiers

- The terrain config and texture sets use the `LOW | MEDIUM | HIGH | ULTRA` scale proposed by p240 (and used by the shadow presets).
- p305 provides one variant per tier through `getMaterialVariant` with `staticDefines` overrides.
- Choosing the tier stays with the app; recommendations are advisory, as in p240 §1.3.

---

## 5. Technique catalogue and handbook

Each technique gets a page in `docs/techniques/`. The plan that implements it writes it, in its last phase, together with the Blender template. One exception: for p305's pages, the Blender, Export and Import sections and the templates are finished by p306, which owns the block workflow. p303 creates `docs/techniques/README.md` (index, decision matrix, page template), and p310 fills in the measured numbers.

| Page                            | Technique                                                                                                  | Owner plan                               | Blender template                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| `README.md`                     | Index; "which technique for my game" matrix; page template                                                 | p303 (created), p310 (measurements)      | —                                |
| `asset-optimization.md`         | KTX2/meshopt pipeline, profiles, codec cheat sheet                                                         | p300                                     | —                                |
| `texture-sets.md`               | Maps (required/optional), packings, AO-into-albedo, height, texel density, sources, sizes, KTX2 settings   | p303                                     | —                                |
| `procedural-textures.md`        | Live vs baked procedural, the baker, seeds, VRAM trade-off                                                 | p304                                     | —                                |
| `terrain-single-layer.md`       | One tiled layer + anti-tiling (dual-scale, hex) + macro variation                                          | p305 (Blender sections + template: p306) | `terrain_singleLayer.blend`      |
| `terrain-vertex-color-splat.md` | Up to 5 layers painted as vertex colours, height blend                                                     | p305 (Blender sections + template: p306) | `terrain_vertexColorSplat.blend` |
| `terrain-splat-map.md`          | Painted splat textures (4/8 layers), resolution-independent borders                                        | p305 (Blender sections + template: p306) | `terrain_splatMap.blend`         |
| `terrain-procedural-rules.md`   | Slope/height/noise rules, no painting; also for generated meshes                                           | p305                                     | — (engine only)                  |
| `terrain-triplanar-cliffs.md`   | Triplanar / biplanar / slope-gated projection for steep faces                                              | p305 (Blender sections + template: p306) | `terrain_triplanarCliff.blend`   |
| `terrain-colormap-detail.md`    | Unique baked colour map + tiled grayscale detail; also as far-distance mode                                | p305 (Blender sections + template: p306) | `terrain_colormapDetail.blend`   |
| `structure-materials.md`        | Concrete and large structures: world-space/triplanar, macro, edge wear, decals                             | p305 (Blender sections + template: p306) | `structure_concrete.blend`       |
| `terrain-blocks-blender.md`     | The common block workflow: grid, shaping, normals, custom props, export, import                            | p306                                     | `terrain_blockTemplate.blend`    |
| `terrain-procedural-meshes.md`  | Engine-generated terrain: noise, rules → vertex splat, CPU AO, colliders                                   | p306                                     | —                                |
| `wet-dry-surfaces.md`           | Wetness, puddles, rain ripples, drying, shoreline, snow coverage                                           | p307                                     | (uses the splat template)        |
| `terrain-scatter.md`            | GPU-instanced rocks and details from Blender and procedural masks                                          | p308                                     | `terrain_scatter.blend`          |
| `terrain-decals.md`             | Mesh decals with an atlas, projected decals, procedural decals                                             | p309                                     | `terrain_decals.blend`           |
| `terrain-modular-kits.md`       | Terrain from kit modules (cliffs, ledges, caves) and tile-chunk worlds (hex/square tiles), merged per cell | p372 (array-material variation: p374)    | — (decided in p372)              |

**Page template** (every technique page has these sections, in this order):

1. **What it is.** Two or three sentences, plus a diagram when it helps.
2. **Best for:**
   - art style (photoreal / stylized PBR / painterly / low-poly flat);
   - game type and camera (first-person, third-person, top-down, isometric/RTS, side-view platformer, racing/flight);
   - world size.
     A "poor fit" row is mandatory.
3. **Performance:**
   - fetches per pixel (formula and worked example);
   - ALU notes;
   - VRAM;
   - draw calls;
   - quality tier;
   - **measured** GPU ms from the gallery (p310).
4. **Maps:** required/optional table with packing, colour space, codec and size.
5. **Blender, step by step.**
6. **Export** (exact exporter settings).
7. **Import into Ækasha** (files to create, with JSON examples).
8. **Set-up and parameters** (table).
9. **Variations**, each with what to do, why, and the performance effect. For example AO into albedo, vertex AO vs texture AO, or LITE packing.
10. **Pitfalls and checklist.**
11. **Template file and example asset ids.**

---

## 6. Performance model (shared by all pages)

Fetches per pixel ≈ `P × L × A × T + S + M + W`, where:

| Term | Meaning                      | Values                                                                  |
| ---- | ---------------------------- | ----------------------------------------------------------------------- |
| `P`  | Textures per layer (packing) | FULL 3, LITE 2, MINIMAL 1                                               |
| `L`  | Layers actually sampled      | All layers, or top-K with sparse sampling, p305 Phase 5                 |
| `A`  | Anti-tiling taps             | none 1, dual-scale 2, hex 3                                             |
| `T`  | Projection                   | UV/world 1, biplanar 2, triplanar 3 (slope-gated: only on steep pixels) |
| `S`  | Splat fetches                | 0 for vertex colour/rules, 1 per 4 layers for splat maps                |
| `M`  | Macro variation              | 1                                                                       |
| `W`  | Wet effects                  | 0–2 (ripple atlas)                                                      |

Draw calls are outside this formula: a block is one draw per material (plus the shadow passes), and its scatter and decals add theirs (p308, p309). Merging a block's static dressing into one draw per material (p372, p370 §10) is the lever there.

Examples:

- LITE, 4 layers, dual-scale, world UV, splat map, macro = 2·4·2·1 + 1 + 1 = **18**. This is a good default.
- FULL, 4 layers, hex, always-triplanar = 3·4·3·3 + 2 = **110**. Don't. p305's mitigations (slope-gated triplanar, hex on the dominant layer only, top-2 sparse sampling) bring it below 30.

Binding budget:

- WebGPU's default `maxSampledTexturesPerShaderStage` is 16, and shadow maps and the environment PMREM count against it.
- With separate textures, a terrain material may bind at most ~10. That is 3 FULL or 4 LITE layers plus splat and macro.
- Beyond that, the **layer array path** (p303/p305) binds one array per slot (2–3 bindings for up to 16 layers).

---

## 7. Keeping the future large world possible

These are not built here, but nothing may block them:

- **Continuity.** Tiling, macro noise, rules noise and procedural block noise all run in world space. Nothing that must be continuous across blocks runs in block-local space.
- **Per-block data.** Splat maps, colour maps, AO and scatter are per-block assets, referenced through material variants (`matOverrides`), so a streamer can load and unload a block as one unit.
- **Determinism.** Procedural seeds derive from `(worldSeed, gridX, gridZ)`, never from load order.
- **Shared materials.** One terrain material per biome. Blocks differ only in variant inputs (textures), so the program and pipeline are shared.
- **Colliders** are per block (HEIGHTFIELD), centred on the block origin.
- **Merged dressing.** A block's static props and cutout mesh decals can be merged per block and material (p372 groups that never cross a block or streaming cell), and a far block can become one simplified proxy (p376 HLOD). Keep block-owned statics as entities so they can be merged later.
- **Material LOD hook.** p305's `quality` variants, together with the colour-map far mode, are what a future block LOD (p350) would switch between. That switch cross-fades like every LOD change (p351 Phase 2, `fadeSeconds: 0` = instant), and a block's switch between chain levels is a plain-mesh LOD fade.

---

## 8. Research references

- Sébastien Lagarde, "Water drop 2a/2b — Dynamic rain and its effects" / "Wet surfaces" (2012–2013): porosity darkening, roughness and puddle model.
- Andrey Mishkinis, "Advanced Terrain Texture Splatting" (2013): height-based blending.
- Eric Heitz & Fabrice Neyret, "High-Performance By-Example Noise using a Histogram-Preserving Blending Operator" (2018), and Morten S. Mikkelsen, "Practical Real-Time Hex-Tiling" (JCGT 2022): stochastic/hex anti-tiling.
- Inigo Quilez, "Biplanar mapping" (2020).
- Ben Golus, "Normal Mapping for a Triplanar Shader" (2017): whiteout/UDN/RNM blends.
- Mattias Widmark, "Terrain in Battlefield 3" (GDC 2012): procedural shader splatting, virtual texturing.
- Stephen McAuley, "Terrain Rendering in Far Cry 5" (GDC 2018): biome rules, splat.
- Unreal Engine Runtime Virtual Texturing docs: the colour map + detail / far-distance idea.
- In-repo: `docs/analysis/ambient-occlusion-options.md` (AO composition rules: AO should hit indirect light only; combine baked AO and GTAO with `min()`).

## 9. Open questions

1. **Git LFS for `.blend` templates and app GLBs?** Not now (§2). Revisit if binary churn grows.
2. **Concrete in the texture library.** Included as 2 optional sets (`concrete01`, `concrete02`) for the structures technique. Drop them if the toolkit should stay terrain-only.
3. **Toolkit version scale.** The epic adds several toolkit features (minor bumps). p302/p303/p304/p306/p307 add engine features (engine minor bumps). Nothing is planned to break, so no major bumps.
