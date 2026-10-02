Status: draft | not-implemented
Category: Terrain, Rendering, Materials
Blocked by: p306_terrain-blocks-and-procedural-terrain-meshes.md, p304_procedural-texture-baker.md (procedural decals), p307_wet-and-dry-surface-states.md (soft: wet decals)
Blocks: p310_terrain-preview-scenes.md
Epic: p301_terrain-texturing-epic.md

# Terrain Decals

Decals add unique, non-repeating detail where it matters: tyre tracks, cracks, stains, leaks, footprints, scorch marks, wet patches. They break up tiling more cheaply than any shader technique, because they cost only where they're placed.

This plan delivers:

- **Decal atlases**: imported CC0 decals plus procedural ones exported from p304's baker, with build tooling and a `DECAL` packing.
- **A decal material**: alpha-blended or alpha-tested, polygon offset, render order, wet-aware, with an optional puddle-mask channel (ruts that fill with water).
- **Mesh decals** authored in Blender (`*.decalSet.json`, owned by terrain blocks).
- **Runtime decals** projected onto terrain blocks and meshes: footprints, impacts, tyre ribbons. One `BatchedMesh` per atlas, with fade-out.

---

## Context (grounded)

- **No decal support exists** (no `DecalGeometry` usage; p301 survey).
- **`MeshProps`** (`core/MeshManager.ts:38`) has no `renderOrder`.
  - `polygonOffset`, `polygonOffsetFactor`/`Units`, `transparent`, `depthWrite`, `alphaTest` and `alphaToCoverage` are material params, so the material JSON can already set them through `params`.
- **The forward renderer** (`WebGPURenderer`) has no G-buffer. Screen-space/deferred decals would need the depth prepass that today lives only inside the PostFX chain (`PostFX.ts:172-178`, not reachable from materials). **Mesh decals are the fit.**
- **Terrain blocks** (p306) are regular grids with `getHeightAt` for generated geometry, or the extracted heightfield (p306 D3) for imported geometry. A small grid patch around a point is cheap to build, so runtime decals never need to clip the whole block.
- **ambientCG decal and atlas assets** (checked via the API, 2026-10-02):

| Asset                                                 | Maps                                        | Use                                         |
| ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| `TireTracks001` (Decal)                               | colour, normal, roughness, AO, displacement | Tyre tracks                                 |
| `AsphaltDamage001` (Decal)                            | + opacity                                   | Cracks and damage                           |
| `AsphaltDamageSet001` (Atlas)                         |                                             | Crack set                                   |
| `Leaking012A` / `Leaking017B` / `Leaking019A` (Decal) | colour, normal, roughness, metalness        | Streaks on concrete and cliffs              |
| `LeafSet024` (Atlas)                                  |                                             | Leaf litter; p308 uses it for scatter cards |

Searches for footprint, crack and stain decals found nothing, so those come from procedural generators (D5).

---

## Design

### D1 — Decal atlas and packing

- **`DECAL` packing** (2 textures, same channels for imported and procedural):
  - `albedoAlpha`: RGB albedo (sRGB), A opacity;
  - `normalRough`: RG normal XY, B roughness, A **puddle mask** (where water collects, e.g. tyre ruts; 0 for most decals).
- **The atlas JSON** (`*.decalAtlas.json`, a toolkit data file read by the build script) lists cells, each with:
  - `id`;
  - source maps (an imported asset's maps, or an exported procedural PNG);
  - a rect in the atlas grid;
  - `physicalSize`;
  - `tileAlong: 'U' | 'NONE'` (tyre tracks tile along their length);
  - an `opacitySource` (an opacity map, or derived from height/colour with a threshold where the asset has none).
- **`devTools/buildDecalAtlas.ts`:**
  - composes cells into 2K source PNGs with `sharp` (padding/bleed per cell against mip bleeding);
  - writes the atlas texture JSONs and a generated cell table (`<atlas>.cells.json`: id → uv rect);
  - p300 encodes them (UASTC).
  - Fetching uses p303's `source.json` + `yarn fetchTextureSources`.
- **Toolkit atlases:**
  - `decalsGround` (2K, 4 × 4 cells of 512): tyre tracks, cracks ×2, mud splatter, wet patch, stains ×2, footprints ×4 (boot, bare, paw, snow-boot), scorch, leaf patch, ice crack.
  - `decalsStructure` (2K): leaks ×4, cracks ×2, stains ×2, form-work marks.

### D2 — Decal material (toolkit: `src/toolkit/terrain/decals/decal.tsl.ts`, `setup` entry)

- **Sampling:** the atlas cell is sampled with the mesh's UV. Blender decals are UV'd straight into atlas space; runtime decals get UVs computed into their cell's rect.
- **Opacity:** opacity × an edge fade (a UV border falloff, so hard quad edges never show) × a per-instance fade (runtime pool).
- **Two modes:**

| Mode              | Settings                                                                                               | Use                         | Cost                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------- |
| `BLEND` (default) | `transparent`, `depthWrite: false`, `polygonOffset` (factor −1, units −4), `renderOrder` after terrain | Soft decals: stains, tracks | Sorted with other transparents; overdraw where decals overlap |
| `CUTOUT`          | `alphaTest` + `alphaToCoverage` when MSAA is on                                                        | Footprints, cracks, leaves  | Cheaper: opaque pass, no sorting                              |

- **Lighting:** the decal's normal and roughness replace the surface's inside its opacity, which is correct for a forward mesh decal.
- **Wetness:** `applySurfaceWetness` (p307) with the decal's own response. The **puddle mask** channel raises local puddle level, so ruts fill first.
- **Shadows:** decals don't cast; they receive.
- **Engine addition:** `renderOrder` in `MeshProps` and `meshSchema` (small, generic).

### D3 — Mesh decals from Blender (`*.decalSet.json`, engine asset type)

```json
{
  "id": "showcaseMud_decals",
  "importedAsset": "showcaseMud_decals",
  "material": "decalsGround_blend",
  "renderOrder": 10
}
```

- Spawned with the owning terrain block (p306's `decals` ids) or by `spawnDecalSet(id)`.
- **Engine-level, but tiny:** a typed wrapper around `spawnImportedAsset` with material, render order and no physics. It exists so a terrain block's manifest can list decals as data.
- **Blender workflow** (`terrain_decals.blend`):
  - **Quad decals:** a plane UV'd onto an atlas cell. The template has one pre-UV'd quad per cell, so you duplicate the cell you want.
  - **Strip decals** (tyre tracks): a plane with Array + Curve modifiers along a path curve, UV'd along the length (`tileAlong: 'U'`).
  - **Conforming:** subdivide to about the terrain grid spacing, then _Shrinkwrap_ (Target: block, Wrap Method: Project along −Z / Nearest Surface Point, Offset 0.01–0.02 m), then apply.
  - **Export:** a separate GLB per block (geometry only, same locked settings as blocks, no colliders), into the block folder.

### D4 — Runtime decals (toolkit: `src/toolkit/terrain/decals/runtimeDecals.ts`)

- **`createDecalPool({ atlas, mode, maxDecals = 128 })`:**
  - one `BatchedMesh` per pool (one draw call), geometry slots reused FIFO;
  - per-instance colour alpha for fades (`setColorAt`);
  - owned per scene.
- **`spawnDecal(pool, { target, position, normal, size, rotation, cell, lifetimeSec?, fadeSec? })`:**
  - **On a terrain block:** build a conforming patch from the block's grid (heights in a size-bounded window; spacing = block spacing, or half of it for small decals) and offset it along the normal. O(cells under the decal), not O(block).
  - **On other meshes:** three's `DecalGeometry` (addons) clipped against the target mesh. Costly on big meshes, fine on props. Documented.
- **`spawnRibbonDecal(pool, { target, points[], width, cell })`:** a strip conformed along a path. Use it for tyre tracks behind a vehicle, appended in segments.
- **Wet footprints:** the footprint cells' puddle mask × wetness gives wet prints in mud, and snow-boot cells (height-only normal) give prints in snow. This is the "T15" item of p307.
- **Determinism:** runtime decals are visual only and never touch physics.

### D5 — Procedural decals (toolkit, p304 generators)

| Generator          | Output                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `decalCracks`      | Worley F2−F1 edges with radial falloff and branching noise; dark albedo, normal from edges                                  |
| `decalStain`       | fbm blotch, darkening, roughness change                                                                                     |
| `decalScorch`      | Radial burn with soot noise                                                                                                 |
| `decalMudSplatter` | Splat-drop SDFs + fbm                                                                                                       |
| `decalFootprint`   | Boot, bare, paw and snow-boot shapes as SDFs + tread pattern; height-driven normal; puddle mask in the heel/toe depressions |
| `decalWetPatch`    | Soft fbm mask, darkening + low roughness + puddle mask                                                                      |
| `decalIceCrack`    | Thin, bright crack lines + subsurface-looking halo                                                                          |

- **Exported** through p304 D5 into the atlas sources (committed, since they aren't re-downloadable).
- **Optional runtime path:** bake per-seed variants into an array (`bakeTexture` layers) for endless unique footprints. The decal material then has an `ARRAY` source mode. Only if the gallery shows repetition matters.

---

## Handbook content (`docs/techniques/terrain-decals.md`)

1. **What it is:** mesh decals in a forward renderer, and why not screen-space here.
2. **"Best for":**
   - every camera type;
   - first- and third-person benefit most (close-up unique detail);
   - top-down/RTS use them for roads, scorch and tracks (very visible from above);
   - stylized: hand-painted decal atlases.
   - **Poor fit:** thousands of overlapping blend decals in one spot (overdraw). Use CUTOUT or bake them into a colour map (p305 D7) instead.
3. **Performance:**
   - BLEND vs CUTOUT;
   - draw calls (one per decal set or pool);
   - overdraw;
   - runtime spawn cost (patch vs `DecalGeometry`);
   - atlas VRAM (2K UASTC ≈ 5.6 MB for 2 maps with mips);
   - gallery numbers.
4. **Maps:** the `DECAL` packing table; opacity sources; the puddle mask, and why.
5. **Blender, step by step:** atlas cell quads, strips along curves, Shrinkwrap settings, apply, UV check, export.
6. **Import and set-up:** `*.decalSet.json`, block `decals`, materials (BLEND and CUTOUT variants).
7. **Runtime:** pools, `spawnDecal`, ribbons, lifetimes, wet footprints.
8. **Variations, each with why and cost:**
   - baking static decals into a colour map (zero runtime cost, no lighting response);
   - CUTOUT instead of BLEND;
   - procedural arrays for variety.
9. **Making your own decals:** from photos (opacity from a mask painted in Krita/GIMP), from the baker, and from Blender (bake a sculpted crack to a plane: colour, normal, height → opacity).
10. **Pitfalls:**
    - z-fighting (offset and polygon offset);
    - mip bleeding (atlas padding);
    - decals floating on steep slopes (subdivide);
    - sorting with other transparents.

---

## Phases

### Phase 1 — Atlas tooling (D1)

**Exit:** `decalsGround` and `decalsStructure` built from the ambientCG sources (procedural cells still placeholders), encoded, with cell tables generated.

### Phase 2 — Decal material (D2)

1. BLEND, CUTOUT, edge fade, wet response, puddle mask; `renderOrder` in `MeshProps`.

**Exit:** decal quads on a gallery block show no z-fighting at 200 m, no visible quad edges, and get wet.

### Phase 3 — Mesh decals from Blender (D3)

1. `*.decalSet.json`, the block hook, the template.

**Exit:** tyre tracks along a curve on a showcase block conform without floating or clipping.

### Phase 4 — Runtime decals (D4)

1. Pool (`BatchedMesh`), terrain patch projection, `DecalGeometry` for meshes, ribbons, fades.

**Exit:** 128 footprints spawned while walking stay at one draw call and fade FIFO; ribbon tracks follow a moving point.

### Phase 5 — Procedural decals (D5)

**Exit:** the procedural cells replace the placeholders, and wet footprints in mud fill with water during a rain shower.

### Phase 6 — Handbook, template, versioning

1. `terrain-decals.md`, `terrain_decals.blend`.
2. `readme.md` Features (toolkit: decals; engine: `*.decalSet.json`, `renderOrder`).
3. Versions: engine minor, toolkit minor, app minor; `CHANGELOG.md`.

---

## Risks

| Risk                                                                                             | Mitigation                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `BatchedMesh` behaviour on the WebGPU backend in r186 (per-instance colour, geometry slot reuse) | Spike in Phase 4; fallback: a fixed pool of individual meshes (more draw calls, documented)            |
| Transparent sorting conflicts with other transparents (water later, particles)                   | `renderOrder` bands documented: terrain 0, decals 10, scatter cards (CUTOUT) opaque, transparents ≥ 20 |
| Polygon offset differs between depth ranges or backends                                          | Offsets in the material are tunable; the gallery checks at 1, 50 and 200 m                             |
| Atlas mip bleeding                                                                               | Cell padding (≥ 16 px at 2K) with edge extension; mips are generated per atlas, so padding scales      |
