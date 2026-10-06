Status: draft | not-implemented
Category: Materials, Terrain, Toolkit
Blocked by: p302_material-and-texture-system-refactor.md, p303_texture-sets-and-terrain-texture-library.md, p304_procedural-texture-baker.md (soft: Phase 2 macro noise, Phase 7 colour-map bake, Phase 8 live layers)
Blocks: p306_terrain-blocks-and-procedural-terrain-meshes.md, p307_wet-and-dry-surface-states.md, p310_terrain-preview-scenes.md
Epic: p301_terrain-texturing-epic.md

# Terrain Material Generator

One toolkit module, `createTerrainMaterial(config)`, plus a JSON route (`terrain.tsl.ts` `setup` entry), that builds a single `MeshStandardNodeMaterial` from a declarative config. It implements every texturing technique of the epic:

- single tiled layer;
- anti-tiling (dual-scale, hex);
- macro variation and distance fade;
- vertex-colour splat;
- splat maps;
- procedural rules (slope / height / noise / aspect);
- height blending;
- planar, biplanar, triplanar and slope-gated projection;
- sparse top-K sampling;
- colour map + detail (with an in-engine colour-map bake);
- structure mode (concrete, object space);
- live procedural layers;
- quality variants;
- debug views.

**Only what the config enables is compiled.** Every feature is a build-time branch on the config, never a runtime uniform switch, so a single-layer material costs what a single-layer material should.

Wet/dry hooks are reserved here and implemented in p307. The Blender sides of the techniques (templates and the "Blender / Export / Import" sections of the handbook pages) are finished in p306, which owns the block workflow.

---

## Context (grounded)

- **After p302:**
  - `setup(inputs, material, staticDefines)` sets several sockets from one graph;
  - `registerTslMaterial(id, fns)` registers code graphs;
  - input resolvers produce bundles;
  - variants override `inputs` / `staticDefines` (shallow merge).
- **After p303:**
  - texture sets (`physicalSize`, `heightScale`, `surface`, packings FULL/LITE/MINIMAL);
  - `buildTextureSetArray` and the `textureSetArray` resolver;
  - `sampleTextureSet(bundle, uv, { packing, grad })`;
  - the `textureSetSurface` baseline;
  - the `terrainGallery` skeleton.
- **After p304:** `macroNoise` and `rippleAtlas`, `bakeTexture`, surface generators with a live mode.
- **Projection code:** `toolkit/materials/triplanarProjection.ts` has `triplanarProjection` (`positionWorld` + `normalWorldGeometry`; `alignToObject`, `fitToBounds`, `dominantAxis`), `blendProjections` and `blendProjectionGradients`. Reuse and extend it rather than writing a second triplanar.
- **Normal space:** socket functions return a **view-space** normal for `normalNode` (`triplanarGrid.tsl.ts:247-248`: `normalView.sub(tangentGradient).normalize()`). The generator computes in world space and converts once at the end (`transformNormalToView` or `cameraViewMatrix` multiplication; check the r186 TSL helper name).
- **`aoNode`** on node materials applies to indirect light only, which is the composition rule of `docs/analysis/ambient-occlusion-options.md`. Texture AO (FULL) and vertex AO go there. AO baked into albedo (LITE/MINIMAL) can't, so the generator lowers `aoNode`'s influence for those layers.
- **The GTAO PostFX pass** (`app/postFx/ambientOcclusion.tsl.ts`) multiplies the final colour, not indirect light. Baked AO and GTAO therefore stack; the handbook notes it.
- **Binding budget:** the WebGPU default is 16 sampled textures per stage, shared with shadow maps and the environment (p301 §6). `renderer.backend.device.limits` gives the real limits on WebGPU.
- **Quality scale:** `LOW | MEDIUM | HIGH | ULTRA` (p240 proposal, shadow presets).

---

## Design

### D1 — Config (`src/toolkit/terrain/terrainMaterialConfig.ts`, Zod + types)

```ts
type TerrainMaterialConfig = {
  id: string;
  layers: TerrainLayer[]; // 1..16
  packing?: 'FULL' | 'LITE' | 'MINIMAL'; // shared by all layers; default: the sets' defaultPacking (must agree)
  storage?: 'AUTO' | 'SEPARATE' | 'ARRAY'; // AUTO: ARRAY when separate bindings exceed the budget (D9)
  space?: 'WORLD' | 'OBJECT'; // OBJECT for structures that move (D8)
  uv?: 'WORLD' | 'MESH_UV'; // tiling coordinates (MESH_UV needs authored UVs; tangents from derivatives)
  blend?: {
    source:
      | 'SINGLE'
      | 'VERTEX_COLOR'
      | 'SPLAT_MAP'
      | 'RULES'
      | 'VERTEX_COLOR_AND_RULES'
      | 'SPLAT_MAP_AND_RULES';
    vertexColor?: { layout: 'RGB_AO' | 'RGBA' }; // p301 §4.4
    splatMaps?: 1 | 2; // 1 = layers 1-4 (+ base), 2 = layers 1-8 (+ base)
    rules?: TerrainRule[];
    mode?: 'LINEAR' | 'HEIGHT'; // default HEIGHT when the packing has height
    heightBlendDepth?: number; // 0.02..0.5, transition softness in height units
    sparse?: { maxLayers: 2 | 3 | 4 }; // ARRAY only (D6)
  };
  antiTiling?: {
    mode: 'NONE' | 'DUAL_SCALE' | 'HEX';
    farScale?: number;
    distance?: [number, number];
    hexContrast?: number;
    apply?: 'ALL' | 'DOMINANT';
  };
  projection?: {
    mode: 'PLANAR' | 'BIPLANAR' | 'TRIPLANAR';
    slopeGate?: [number, number];
    sharpness?: number;
    normalBlend?: 'WHITEOUT' | 'UDN' | 'RNM';
  };
  macro?: { texture: string; scale: number; brightness?: number; hue?: number; roughness?: number };
  colorMap?: { texture: string; mode: 'DETAIL' | 'FAR_ONLY'; detailDistance?: [number, number] };
  distance?: { fade: [number, number]; far: 'AVERAGE_COLOR' | 'COLOR_MAP' | 'NONE' };
  ao?: { vertex?: boolean; textureInfluence?: number; bakedAlbedoInfluence?: number };
  wet?: WetConfig; // reserved, p307
  quality?: Partial<Record<'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA', TerrainQualityOverrides>>;
  debugView?: TerrainDebugView; // debug env only (D10)
};

type TerrainLayer = {
  set: string; // texture set id (imported or procedural)
  source?: 'TEXTURE' | 'PROCEDURAL_LIVE'; // PROCEDURAL_LIVE = p304 generator evaluated per pixel
  tiling?: number; // multiplier on the set's physicalSize
  rotation?: number; // degrees, breaks alignment between layers
  tint?: string;
  normalStrength?: number;
  roughnessScale?: number;
  heightContrast?: number;
  heightOffset?: number;
  antiTiling?: TerrainMaterialConfig['antiTiling'];
  projection?: TerrainMaterialConfig['projection']; // eg. TRIPLANAR on cliffs only
};

type TerrainRule = {
  layer: number;
  slope?: [number, number]; // degrees, with softness
  height?: [number, number]; // world Y metres
  aspect?: { direction: [number, number]; range: number }; // eg. north-facing snow
  noise?: { scale: number; amount: number; channel?: 'R' | 'G' | 'B' | 'A' }; // macroNoise channel
  softness?: number;
  strength?: number; // 0..1
};
```

- **Static config** goes in `staticDefines.terrain` (JSON route) or the `createTerrainMaterial` argument (code route). It's build time: the graph branches on it.
- **Per-layer tunables** (tint, normal strength, roughness scale, height contrast and offset, tiling) become **uniforms**, registered in `mat.userData.uniforms` as `terrain_l<i>_<name>`. The gallery tab and p085's material editor can live-edit them without rebuilding.
- **Textures** (layer arrays, splat maps, macro, colour map) are **inputs**, so material variants swap them per block (p306) without a new graph.

### D2 — Graph outline (`src/toolkit/terrain/terrain.tsl.ts` `setup`, nodes in `src/toolkit/terrain/nodes/`)

```
coords      = space/uv → worldPos, worldNormal(geometry), slope, height, viewDistance
weights     = blend source (vertexColor | splat | rules | combos) → w[0..N)        (weights.ts, rules.ts)
weights     = HEIGHT ? heightBlend(w, layerHeights) : w                         (heightBlend.ts)
selection   = sparse ? topK(weights) : all non-zero layers                         (sparse.ts)
for each selected layer:
  proj      = PLANAR | BIPLANAR | TRIPLANAR (slope-gated)                         (projection.ts)
  sample    = antiTiling(NONE | DUAL_SCALE | HEX) of sampleTextureSet(...)        (antiTiling.ts)
  accumulate albedo, normal(world), roughness, ao, height by weight
surface     = macro(…) → colorMap(…) → distance fade/far mode → wet(…) [p307]      (macro.ts, colorMap.ts, distance.ts)
outputs     → colorNode, normalNode (world → view once), roughnessNode, metalnessNode = 0, aoNode
```

- **Height blending** (Mishkinis): `w'_i = max(h_i + w_i − (max_j(h_j + w_j) − depth), 0)`, normalized.
  - `h_i` is the layer's height × `heightContrast` + `heightOffset`.
  - With HEX or TRIPLANAR, `h_i` is the layer's blended height across taps.
  - With `sparse`, the heights of the selected layers only.
- **Normals:**
  - Planar world tiling uses an analytic frame (T = +X, B = +Z, then Gram–Schmidt against the geometry normal).
  - Biplanar and triplanar use Golus's whiteout (default), UDN or RNM per projection.
  - The per-layer normals are blended by weight in world space, renormalized, and converted to view space once.
  - `MESH_UV` uses derivative-based TBN (no tangent attribute).
- **The shadow pass** uses only the position graph. The generator never touches `positionNode`, so shadows cost nothing extra.

### D3 — Anti-tiling (`nodes/antiTiling.ts`)

| Mode         | Taps | How                                                                                                                                                                                                                  | Best for                                                                                     |
| ------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `NONE`       | 1    | plain tiling                                                                                                                                                                                                         | Top-down/RTS at height, low tier, stylized flat textures                                     |
| `DUAL_SCALE` | 2    | Sample at `uv` and `uv × farScale` (≈ 0.23, non-integer, rotated 37°); mix by distance (`distance` range) and by `macroNoise.B` patches                                                                              | Default for everything; also kills repetition at distance                                    |
| `HEX`        | 3    | Mikkelsen's practical hex tiling: 3 hex-lattice taps with random offsets and rotations, gradients via `texture().grad()` (no mip seams), contrast-preserving weights (`hexContrast`); normals rotated with their tap | First- and third-person close-ups of strongly patterned layers (rocks, cliffs, grass ground) |

- `apply: 'DOMINANT'` runs HEX only on the highest-weight layer and DUAL_SCALE on the rest. That cuts the cost from 3·L to 3 + 2·(L−1) taps per slot.

### D4 — Blend sources (`nodes/weights.ts`, `nodes/rules.ts`)

- **`VERTEX_COLOR`:** reads `COLOR_0` (TSL vertex colour attribute).
  - `RGB_AO`: layers 1–3 from RGB; layer 0 = `max(0, 1 − (r + g + b))`; A = AO, which goes to `aoNode` when `ao.vertex`.
  - `RGBA`: layers 1–4; no vertex AO.
- **`SPLAT_MAP`:** 1 or 2 RGBA textures in mesh UV (block-local, set per block through variants). Base layer = remainder.
  - Splat maps are `data` slot textures: `codec: none` or UASTC (p300).
  - Filtering is linear. A 1K splat on a 64 m block = 6.25 cm per texel, and the height blend sharpens the transitions far below that.
- **`RULES`:** each rule computes a mask:
  - smoothstep ranges on slope (degrees from `normalWorldGeometry.y`), height (`positionWorld.y`) and aspect (the horizontal normal's direction);
  - optionally perturbed by a `macroNoise` channel;
  - multiplied by `strength`.
  - Rules composite **over** the incoming weights in order: `w = mix(w, onehot(layer), mask)`. So "snow above 40 m on slopes under 30°" can sit on top of painted splat weights.
- **Combos:** `VERTEX_COLOR_AND_RULES` and `SPLAT_MAP_AND_RULES` = painted base + rules on top. This is what a large world wants: rules everywhere, paint only where it matters.
- **Generated meshes:** the same rules can be evaluated **on the CPU at mesh generation** into vertex colours (p306 `generateTerrain` v2), which trades per-pixel ALU for a vertex attribute. The handbook compares both.

### D5 — Projection (`nodes/projection.ts`, extends `toolkit/materials/triplanarProjection.ts`)

- **`PLANAR`:** world XZ; 1 tap per set sample.
- **`BIPLANAR`:** Quilez: the two most significant axes, with gradients; 2 taps. Its seams are less visible than a slope-gated planar, at 2/3 of triplanar's cost.
- **`TRIPLANAR`:** 3 taps, weights `pow(|n|, sharpness)` normalized.
- **`slopeGate: [a, b]`:** below `a` degrees, PLANAR; above `b`, the configured mode; in between, blended.
  - It's implemented with a dynamic `If` on the slope, so flat pixels never pay for the extra taps.
  - Divergence happens only along the band.
  - Remember the TSL trap from the sky box notes: a TSL `If` must not be the first to build a node that other branches share, so build the shared coordinates before the branch.
- **Per layer:** `projection` overrides the material's, so typically only the cliff layer is TRIPLANAR.

### D6 — Sparse top-K (`nodes/sparse.ts`, ARRAY storage only)

- For L ≤ 16 weights, a fixed compare-exchange network keeps the top `maxLayers` (2–4) indices and weights.
- Only those are sampled from the arrays (dynamic layer index into the array textures), and the kept weights are renormalized.
- Most terrain pixels have 1–2 non-trivial layers, so 8-layer terrains cost about what 2–3 layers would.
- Artifacts: popping where a third layer crosses the cut-off. The height blend hides most of it; `maxLayers: 3` hides the rest.

### D7 — Macro, distance, colour map (`nodes/macro.ts`, `distance.ts`, `colorMap.ts`)

- **Macro:** `macroNoise` sampled at `positionWorld.xz / scale` (large scales, 1 fetch for all layers) modulates brightness, hue (a small rotation in YIQ) and roughness. Continuous across blocks (p301 §7).
- **Distance:**
  - Beyond `fade[0]`, detail normals fade toward the geometry normal.
  - Beyond `fade[1]`, per-layer sampling stops (`If` on view distance) and the colour comes from:
    - `AVERAGE_COLOR`: Σ wᵢ · averageColorᵢ, zero layer fetches; each set's `averageColor` comes from p303 D1 (computed by the encode step);
    - or `COLOR_MAP`: 1 fetch.
  - Far terrain then costs the weights plus 0–1 fetches.
  - **No popping line** (p350 §3): a `farBlend` band (metres past `fade[1]`, default 4) samples both and mixes them, so the switch to the far colour has no visible edge moving with the camera; 0 = a hard switch. Only pixels in the band pay for both.
- **Colour map + detail** (`colorMap.mode: 'DETAIL'`):
  - A unique per-block colour map (mesh UV) supplies the albedo.
  - Layers supply **detail** only: albedo divided by its set's `averageColor` (≈ 1 on average), normal and roughness.
  - That gives unique large-scale colour (painted paths, burn marks, baked large-scale AO) plus close-up detail.
  - `FAR_ONLY` uses the colour map only beyond `distance.fade[1]` (a far LOD for any technique).
- **In-engine colour-map bake:** `bakeTerrainColorMap(blockMesh, material, size)`.
  - It renders the block's terrain material top-down (orthographic, albedo output only through an MRT variant of the material) into a texture with p304's baker.
  - Large-scale AO from the vertex AO can be multiplied in.
  - Exportable through p304 D5, then committed and KTX2-encoded per block.
  - Blender's bake path is documented in p306.

### D8 — Structure mode

- **For concrete walls, bunkers, rock faces and other large structures:** `space: 'OBJECT'` (the texture sticks to a moving or instanced object; `triplanarProjection`'s `alignToObject`) or `'WORLD'` (static, seamless across pieces).
- **Defaults:** `TRIPLANAR` projection and `DUAL_SCALE` anti-tiling, macro on.
- **`blend.source: 'VERTEX_COLOR'`** with the `RGBA` layout can drive wear layers: clean / stained / damaged concrete.
- **Decals** (p309) add unique detail.
- **Helper:** `createStructureMaterial(setId | layers, opts)` is a thin preset over `createTerrainMaterial`.

### D9 — Storage and the binding budget

- **`SEPARATE`:** each layer's packing textures are bound individually (`textureSet` resolver bundles).
- **`ARRAY`:** one array per packing slot (`textureSetArray`), plus splat/macro/colour map.
- **`AUTO`** computes the bindings and picks `ARRAY` when `SEPARATE` would exceed `budget = deviceLimit − reserved`.
  - `reserved` defaults to 6: shadow maps, environment, PostFX-irrelevant extras. Configurable.
  - WebGL2 uses its texture unit limit (also 16).
- Over budget even with arrays: a clear error listing what is bound.
- **Mixed sources:** procedural (baked, uncompressed) and imported (compressed) sets can't share an array (p304 D3), so AUTO splits them into two arrays and says so in a dev log.

### D10 — Quality variants and debug views

- **Quality:** `quality.LOW` etc. are config overrides. `getTerrainMaterialVariant(id, level)` returns them through `getMaterialVariant` with a `staticDefines` override, so each tier is its own pipeline.
- **Suggested defaults** (tuned in Phase 6 from gallery measurements):

| Tier   | Anti-tiling                      | Projection                          | Sparse | Macro | Far mode                |
| ------ | -------------------------------- | ----------------------------------- | ------ | ----- | ----------------------- |
| LOW    | NONE (or DUAL_SCALE beyond 20 m) | PLANAR; cliffs BIPLANAR slope-gated | top-2  | on    | AVERAGE_COLOR from 60 m |
| MEDIUM | DUAL_SCALE                       | cliffs TRIPLANAR slope-gated        | top-3  | on    | from 120 m              |
| HIGH   | DUAL_SCALE; HEX on DOMINANT      | cliffs TRIPLANAR slope-gated        | top-3  | on    | from 200 m              |
| ULTRA  | HEX on ALL                       | cliffs TRIPLANAR                    | top-4  | on    | none                    |

- **Debug views** (`debugView`, compiled only when `IS_DEBUG_ENV`). Their node code lives in `nodes/_dbg__debugViews.ts` and is imported dynamically by `createTerrainMaterial`; the JSON route uses it once the gallery tab has preloaded it:
  - `WEIGHTS`: false colour per layer;
  - `LAYER_COUNT`: how many layers a pixel sampled (sparse check);
  - `TEXEL_DENSITY`: a 1 m checker with px/m colour bands;
  - `MIP`: the mip level the GPU picked;
  - `PROJECTION`: triplanar weights, plus the slope-gate band;
  - `NORMALS`;
  - `HEIGHT`;
  - `TAPS`: the estimated texture fetches for that pixel, heat-mapped, which makes the p301 §6 formula visible;
  - `WETNESS` (p307).

---

## Phases

Each phase adds a gallery row (or extends one) so it can be checked and measured.

### Phase 1 — Scaffold and single layer

1. Config schema/types, `createTerrainMaterial`, `registerTslMaterial('aek.terrain', { setup })`, JSON route (`toolkit/terrain/materials/terrain.tsl.ts`).
2. `SINGLE` source, PLANAR world tiling, all three packings, surface uniforms, AO routing (D2 rules), world→view normal.
3. Quality variant mechanism; debug view framework with `TEXEL_DENSITY` and `NORMALS`.

**Exit:** gallery blocks switch from `textureSetSurface` to the terrain material with identical looks, a JSON material and a code-created one render the same, and the shader only contains enabled features (inspect the WGSL).

### Phase 2 — Anti-tiling, macro, distance (D3, D7 minus colour map)

**Gallery row "Anti-tiling":** three 48 × 48 m flat blocks of `grass01` with NONE / DUAL_SCALE / HEX, plus macro on/off.

**Exit:** HEX shows no mip seams at grazing angles, and DUAL_SCALE hides repetition from a 30 m camera height.

### Phase 3 — Blending (D4 minus rules, D9)

1. `VERTEX_COLOR` (both layouts), `SPLAT_MAP` (1–2), LINEAR/HEIGHT blend.
2. SEPARATE and ARRAY storage, AUTO with budget errors.
3. `WEIGHTS` debug view.
4. Test meshes get procedural vertex colours and splat `DataTexture`s generated in code. Blender versions come in p306.

**Gallery row "Splatting":**

- 5-layer vertex-colour block;
- 5-layer splat-map block;
- the same with LINEAR vs HEIGHT;
- a 9-layer ARRAY block.

### Phase 4 — Rules (D4 rules and combos)

**Gallery row "Rules":** a 64 m generated block with grass → rocks by slope → snow by height and aspect → cliffs on steep faces, plus the same block with a painted splat + rules combo.

### Phase 5 — Projection (D5)

**Gallery row "Cliffs":** one block with PLANAR / BIPLANAR / TRIPLANAR / slope-gated, plus `PROJECTION` and `TAPS` views.

### Phase 6 — Sparse sampling and the performance pass (D6, D10 tiers)

1. Sparse top-K; `LAYER_COUNT` view.
2. Measure every gallery row per tier (p310 defines the measurement method; use a temporary fixed-camera GPU-ms readout here).
3. Set the default tier table.

**Exit:** an 8-layer HIGH-tier terrain stays under the agreed budget (proposal: ≤ 3 ms GPU at 1080p on the reference machine; record the machine).

### Phase 7 — Colour map + detail, far modes, structures (D7, D8)

1. `colorMap` DETAIL / FAR_ONLY, `distance.far` (using p303's `averageColor`), `bakeTerrainColorMap`.
2. Structure mode, `createStructureMaterial`, `concrete01` / `concrete02` on a wall and bunker piece.

**Gallery rows "Colour map" and "Structures".**

### Phase 8 — Live procedural layers

1. `source: 'PROCEDURAL_LIVE'` using p304's live mode.

**Gallery:** the "Procedural" row gains a live toggle inside a blended terrain.

### Phase 9 — Handbook pages and versioning

1. **Pages:** write `terrain-single-layer.md`, `terrain-vertex-color-splat.md`, `terrain-splat-map.md`, `terrain-procedural-rules.md`, `terrain-triplanar-cliffs.md`, `terrain-colormap-detail.md` and `structure-materials.md`, following the page template (p301 §5), with measured numbers from Phase 6.
   - Their sections 5–7 (Blender, Export, Import) get a placeholder linking `terrain-blocks-blender.md`, completed in p306.
2. **Content each page must carry:**
   - **Single layer:** "Best for" small arenas, stylized, top-down; poor fit for open worlds without macro. Variations: tiling multiplier, rotation per layer, DUAL_SCALE vs HEX (why, cost), macro (why it beats bigger textures).
   - **Vertex-colour splat:**
     - Mesh density sets the border resolution (≈ vertex spacing); the height blend hides it.
     - Layouts `RGB_AO` vs `RGBA`.
     - Variation: vertex AO (why: large-scale AO for free, indirect-only and correct) vs texture AO.
     - Best for: Blender-authored blocks, third-person and RTS; poor fit for sharp painted paths on coarse meshes.
   - **Splat map:** resolution-independent borders, 4 vs 8 layers (2 maps), memory per block, `data` codec choice; best for first-person hero areas and roads/paths.
   - **Procedural rules:** zero authoring, works on generated meshes; CPU-baked rules into vertex colours vs per-pixel rules (cost table); best for procedural worlds, survival/sandbox, prototypes; poor fit for art-directed hero spots without a painted combo.
   - **Triplanar cliffs:** planar stretching explained; triplanar vs biplanar vs slope-gated (taps and seams); normal blend options; best for mountain/canyon worlds, first and third person; top-down rarely needs it.
   - **Colour map + detail:**
     - Unique colour without unique-texture VRAM.
     - Bake in engine or in Blender.
     - Variation: AO and large-scale lighting baked into the colour map. Why: one fetch for all large-scale shading. Cost: static lighting assumptions; don't bake direct sunlight if day-night runs.
     - Best for: top-down/RTS/isometric, flight/racing (fast, far views), far LOD.
   - **Structures:** world vs object space, triplanar defaults, wear via vertex colours, decals; concrete examples; best for brutalist/industrial levels and large architecture.
3. **Repo docs:**
   - `readme.md` Features (toolkit: terrain material generator) and a short example.
   - `CLAUDE.md` gets a "Terrain materials" section: config, JSON route, budget, tiers, debug views.
4. **Versions:** toolkit minor; app minor (gallery rows); `CHANGELOG.md`.

---

## Risks

| Risk                                                                    | Mitigation                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shader permutations explode (config × tiers × variants)                 | Permutations are only created on use; the gallery is the worst case; `compileAsync` at load; document "one material per biome" (p301 §7)                                       |
| Dynamic array indexing (sparse) is slow or unsupported on a backend     | It's WGSL-legal and GLSL ES 3.0-legal for `sampler2DArray` layer coordinates. If it measures slow, fall back to fixed-count sampling of all layers with zero-weight early-outs |
| HEX `grad` sampling with compressed arrays shows artifacts on some GPUs | Gallery check on both backends; `apply: 'DOMINANT'` default; LOW tier avoids HEX                                                                                               |
| Height blend needs height in all layers                                 | MINIMAL and LITE carry height; procedural sets always do; LINEAR is chosen automatically when a set lacks it (warning)                                                         |
| `If` branches in TSL build shared nodes inside a branch (sky box trap)  | Build shared coordinates and weights before any `If`; covered in the code comments                                                                                             |
| Splat textures per block multiply pipelines                             | p302 Phase 3 verifies that variants differing only in textures share a pipeline                                                                                                |
