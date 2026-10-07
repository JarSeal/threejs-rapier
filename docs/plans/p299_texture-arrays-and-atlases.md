Status: in progress | Phase 0 implemented
Category: Assets, Textures, Texture atlas
Epic: p370_static-mesh-merging-and-texture-atlas-systems.md (Tier 0)
Blocked by: p302_material-and-texture-system-refactor.md (soft: only Phase 5's JSON binding)
Blocks: p303_texture-sets-and-terrain-texture-library.md (D4 layer arrays build on D1), p309_terrain-decals.md (D1 decal atlases build on D3), p374_multi-material-merging.md
Related: \_DONE_p300_asset-optimization-pipeline-plan.md (the pipeline this extends), p351_impostor-billboard-lod.md (its exported atlases use D3's cell table), p308_terrain-scatter.md (leaf-card atlases), \_DONE_p345_gpu-memory-and-draw-call-debugger.md

# Texture Arrays & Atlases

Two engine tools for packing many textures into few bindings, usable on their own and by the
merge materials of p374:

- **Texture arrays**: many same-sized textures as the layers of one array texture. Each layer
  wraps and mips on its own, so tiling textures work. Assembled at runtime from KTX2 members, or
  encoded at build time as one KTX2 array.
- **2D atlases**: many textures of any size packed into one image with a cell table. For content
  that doesn't tile: decals, scatter cards, sprites, impostors, UI.

Every map type (albedo, normal, ORM, emissive, …) gets its own array or atlas, all linked by one
layout. This plan runs **before the terrain plans** (p370 §9): p303's layer arrays and p309's decal
atlases are built on it instead of each shipping their own tool.

---

## 1. Grounding

- **No array textures yet**: nothing uses `DataArrayTexture` or `CompressedArrayTexture`.
- **Textures** (`core/Texture.ts`): a ref-counted registry. `loadTextureAsync(props)` (`:447`)
  loads `.ktx2` through `loadKTX2Texture` (`core/Import/KTX2.ts:45`, a shared `KTX2Loader`); the
  URL comes from `resolveAssetUrl` (the pipeline's `__url`). `saveTexture` (`:605`) registers a
  texture built in code.
- **Texture JSON** (`schemas/textureSchema.ts`): `id`, `fileName`, `texOpts`, plus build-time
  `optimize` and `pack`. `pack` combines channels of several images into one texture; it is not a
  spatial atlas.
- **Pipeline** (`devTools/assetPipeline/`): `images.ts` reads and resizes, `pack.ts` packs
  channels, `ktxEncode.ts` / `ktxTool.ts` run the pinned `ktx` 4.4.2, `budgets.ts` checks budgets,
  outputs go to `src/public/aek-assets/` and `assets.lock.json`. Per-asset `optimize` is in
  `schemas/assetsConfigSchema.ts:139-174`.
- **`ktx create --layers N`** exists in the pinned 4.4.2 ("If set the texture will be an array
  texture").
- **Gathering a new suffix** needs a schema in `src/_engine/schemas/`, an entry in
  `gatherAppData.ts`'s suffix table, a `generatedAppData` section and JSON Schema compilation
  (p303 Context).
- **Binding budget:** WebGPU's default `maxSampledTexturesPerShaderStage` is 16, and shadow maps
  and the environment PMREM count against it (p301 §6).
- **Material inputs:** texture ids in `params` or TSL `nodes` become `texture(tex)`
  (`Material.ts:223-237`, `:342-461`). An array needs a layer index and a cell needs a UV rect,
  which plain ids can't say; p302 D4's input resolver registry is the hook (D5).

## 2. Design

### D1 — Runtime array assembly (`core/TextureArray.ts`)

**`buildTextureArray({ id?, members: string[], colorSpace?, texOpts? }): Promise<ArrayTexture>`**

- Members are registered texture ids. Layer `i` = `members[i]`.
- **Requirements:** same resolution, mip count and transcoded format (holds when every member was
  encoded with the same codec, so one codec per slot). A mismatch throws, naming the member and
  the value.
- **KTX2:** each member's `CompressedTexture.mipmaps[level].data` is concatenated per level into a
  `CompressedArrayTexture`, uploaded once. Members are never uploaded on their own; their CPU mip
  data is kept only until assembly.
- **Uncompressed fallback** (a PNG source while the pipeline can't encode): a `DataArrayTexture`
  from `ImageBitmap`s through an `OffscreenCanvas`, mipmaps generated on the GPU.
- **Ids** are derived from the member list (`arr:<hash>`) unless given, so two users of the same
  palette share one array. Arrays are registered in the texture registry and ref counted like any
  texture, with their members as dependencies for scene ownership.
- **Swapping a layer** (`setTextureArrayLayer(id, i, memberId)`): re-fetches that member and
  re-uploads that layer, with a layer update range if r186 supports one (Phase 0), else a full
  re-upload.
- **Optional:** GPU assembly with `renderer.copyTextureToTexture` per layer and mip (WebGPU only).
  Phase 0 measures it; adopt only on a measurable win.

This is p303 D4's assembly, generalized: p303's `buildTextureSetArray` becomes a thin layer that
maps texture sets and packings to member lists, one `buildTextureArray` per slot.

### D2 — Build-time arrays (`*.textureArray.json`, engine asset type)

For members that don't share a size or come from raw sources, the pipeline builds the array:

```json
{
  "id": "kitRocks_albedo",
  "layers": ["rockA_albedo", "rockB_albedo", "./source/moss.png"],
  "size": [1024, 1024],
  "colorSpace": "SRGB",
  "texOpts": { "wrapS": "REPEAT", "wrapT": "REPEAT", "anisotropy": "MAX" },
  "optimize": { "profile": "prop", "slot": "baseColor" }
}
```

- A layer is a texture id (its source image, after its own `pack` recipe) or a source path.
- Each layer is resized to `size` (`images.ts`), then all are encoded as one KTX2 array with
  `ktx create --layers N`. The output gets a `__url`, a lock entry and `__vramBytes` like any
  texture, and the `optimize` block and budgets (`budgets.ts`) apply unchanged.
- Runtime: `loadTextureAsync` sees an array KTX2; `KTX2Loader` returns a `CompressedArrayTexture`
  (Phase 0 confirms on both backends).
- `"layers"` order is the layer index; `generatedAppData` emits `__layers` (id → index) for D4/D5.

### D3 — 2D atlases (`*.textureAtlas.json`, engine asset type)

One layout, one output per map slot:

```json
{
  "id": "decalsGround",
  "size": [2048, 2048],
  "padding": 16,
  "slots": {
    "albedoAlpha": { "colorSpace": "SRGB", "optimize": { "slot": "baseColor" } },
    "normalRough": { "optimize": { "slot": "data" } }
  },
  "cells": [
    {
      "id": "tyreTracks",
      "rect": [0, 0, 1024, 512],
      "sources": { "albedoAlpha": "./source/tyre_color.png", "normalRough": "./source/tyre_nr.png" }
    },
    { "id": "crackA", "sources": { "albedoAlpha": "crackA_albedo", "normalRough": "crackA_nr" } }
  ]
}
```

- **Packing:** cells with a `rect` are placed there; the rest by a shelf packer. Rects snap to the
  4×4 block grid (KTX2 block compression), plus `padding` with edge extension against mip
  bleeding. A cell that doesn't fit fails the build, naming it.
- **Outputs:** one composed image per slot, encoded by the existing texture path (its own
  `optimize`, `__url`, budget), and a generated cell table (`__cells`: id → `[u0, v0, u1, v1]`
  plus the cell's pixel size) in `generatedAppData`.
- A slot a cell has no source for gets the slot's neutral fill (`fill` per slot, default
  transparent black).
- p309's `DECAL` packing becomes a recipe of this: its `*.decalAtlas.json` and
  `devTools/buildDecalAtlas.ts` are replaced by a `*.textureAtlas.json` with the `albedoAlpha` /
  `normalRough` slots and extra per-cell data (`physicalSize`, `tileAlong`, `opacitySource`) in
  a free-form `data` field the gatherer passes through.
- p351's exported impostor atlases (its Phase 4) use the same cell table format.

### D4 — Helpers

- **Geometry:** `remapUVsToAtlasCell(geometry, atlasId, cellId, { attribute = 'uv' })` rewrites
  UVs from 0..1 into the cell rect (returns a new registered geometry, or in place with
  `inPlace: true`). For Blender assets UV'd straight into atlas space, nothing is needed.
- **TSL:** `sampleArrayLayer(arrayTex, uv, layer)` and `sampleAtlasCell(atlasTex, uv, rect,
{ clampToCell = true })` (clamps half a texel inside the rect, so bilinear filtering never
  reads the neighbour). Exported from `core/TextureArray.ts` / `core/TextureAtlas.ts` (the
  engine has no shared TSL node folder yet).
- **Runtime lookups:** `getAtlasCell(atlasId, cellId)`, `getArrayLayerIndex(arrayId, memberId)`.

### D5 — Material binding from JSON (after p302 D4)

Two input resolvers (p302's `registerMaterialInputResolver`):

- `{ "textureArray": "kitRocks_albedo", "layer": "rockB_albedo" }` (or a number) → a node sampling
  that layer with the mesh UV.
- `{ "atlas": "decalsGround", "slot": "albedoAlpha", "cell": "crackA" }` → a node sampling the
  cell with the mesh UV remapped into its rect (no geometry change needed).

Their `dependencies` list the array or atlas texture, so p302 D6's scene dependency closure
loads them. Until p302 lands, arrays and atlases are used from TSL code (D4).

### D6 — Debug

- **Assets tab** (`core/Debug/_dbg__Assets.ts`): arrays list their layers (thumbnails per layer
  and mip), atlases their cells (a padding/rect overlay on the slot image, cell ids on hover).
- GPU memory: arrays and atlases are registered textures, so the GPU memory tab's "By owner"
  already counts them; three r186 counts a compressed array's mip bytes through
  `installCompressedTextureSizer` (verify the array case in Phase 0).

## 3. Phases

### Phase 0 — Spike (half a day) — done

1. A two-layer `ktx create --layers` file through `KTX2Loader` on WebGPU and WebGL2: a
   `CompressedArrayTexture` sampled with `texture(arr, uv).depth(layer)`.
2. Runtime concatenation of two single KTX2s into a `CompressedArrayTexture` (the D1 path).
3. Does r186 have a layer update range? Does `copyTextureToTexture` assembly beat CPU
   concatenation for 16 × 1K layers?
4. Does the GPU memory tab count the array's bytes correctly?

**Exit:** a test scene samples layer 0 and 1 of both kinds of array on both backends.

As built (the `textureArraySpike` debug scene, its files from
`devTools/assetPipeline/p299ArraySpike.ts` in `src/public/debugger/assets/testOptimized/p299/`;
measured in Chrome on an Apple GPU, where ETC1S transcodes to ETC2 and UASTC to ASTC 4×4 on both
backends):

1. `ktx create --layers 2 a.png b.png out.ktx2` works with the pinned 4.4.2 (both codecs, full mip
   chain). `loadTextureAsync` already returns a `CompressedArrayTexture` (`image.depth` 2, colour
   space from the file) with no engine change, and `texture(arr, uv).depth(layer)` samples it on
   WebGPU and WebGL2. D2's runtime side is free.
2. Runtime concatenation (each level's member data appended in layer order, the layout KTX2Loader
   and both backends use) renders identically to the `--layers` file and to the single textures, on
   both backends.
3. Layer updates: r186 has them on both backends (`addLayerUpdate(i)` + `needsUpdate`, consumed by
   the upload; it writes layer `i` of every level from the array's own `mipmaps[level].data`). So
   `setTextureArrayLayer` copies the member into the array's CPU levels and flags the layer, which
   means **the array keeps its CPU mip data** while it can be swapped (Phase 1: an option, or drop
   it after the first upload when not swappable). GPU assembly is rejected: 16 × 1K UASTC (1.4 MB
   per layer) took 2.4 ms concat + 12.7 ms upload = 15.1 ms by CPU, 22.2 ms by uploading every
   member plus a zero-filled array and 176 `copyTextureToTexture` calls (medians of 7, WebGPU;
   WebGL2: 2.7 + 14.3 ms). It also uploads every member, which D1 avoids.
4. GPU memory: `installCompressedTextureSizer` counts an array's bytes exactly (counted = CPU mip
   bytes, both kinds, both backends). Nothing to add for D6.

Found on the way, not this plan's: a Basis file transcoded to uncompressed RGBA32 (a GPU with no
BC, ETC2 or ASTC; forced with the scene's `?p299Rgba=true`) fails for single textures as much as
arrays. WebGPU throws in `_copyCompressedBufferToTexture` (`_getBlockData` has no entry for
`rgba8unorm`), WebGL2 uploads (and counts) the bytes but samples black. Every KTX2 the engine loads
has this today; it needs its own issue.

Untested: a one-member array (three sets `isArrayTexture` from `image.depth > 1`, so it would bind
by `isCompressedArrayTexture` alone). Phase 1 tests it or requires two members.

### Phase 1 — Runtime arrays (D1)

`core/TextureArray.ts`, registry integration, ref counting, layer swap. **Exit:** an array of 4
KTX2 members renders identically to the 4 separate textures, with one binding.

### Phase 2 — Build-time arrays (D2)

Schema, gatherer suffix, pipeline step (resize + `--layers` encode), lock and budget, runtime
load. **Exit:** `yarn assets --only <array>` builds a 3-layer array from mixed-size sources; a
clone with `assets.lock.json` and no `ktx` loads it from the cache.

### Phase 3 — Atlases (D3)

Schema, packer, per-slot composition, cell table. **Exit:** a 2-slot atlas of 6 cells, mips
viewed at the smallest level show no neighbour bleeding.

### Phase 4 — Helpers and debug (D4, D6)

**Exit:** a mesh remapped into an atlas cell and a mesh sampling an array layer render in
`debugScene`; the Assets tab shows layers and cells.

### Phase 5 — JSON binding (D5, after p302 D4)

**Exit:** a material JSON samples an array layer and an atlas cell without TSL code.

### Phase 6 — Docs and versioning

1. A "Texture arrays and atlases" section in `docs/techniques/asset-optimization.md` (when to
   use which, sizes, padding, codec per slot, budgets).
2. `CLAUDE.md`: the new asset suffixes in the data pipeline section, `readme.md` Features and
   asset types.
3. Update p303 D4 and p309 D1 if anything they rely on changed.
4. Engine minor; `CHANGELOG.md`.

## 4. Versioning

Engine minor (two asset types, runtime arrays, helpers, resolvers). No toolkit or app change.

## 5. Risks

| Risk                                                                                                           | Mitigation                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| UASTC transcodes to different GPU formats on different devices, so runtime-assembled members could mix formats | One codec per slot, validated at assembly (D1); build-time arrays (D2) can't mix                   |
| `KTX2Loader` or the WebGL2 backend mishandles compressed arrays in r186                                        | Phase 0 spike before anything else; fallback: runtime assembly only                                |
| Atlas mip bleeding                                                                                             | Padding with edge extension, cells snapped to 4×4 blocks; `sampleAtlasCell` clamps inside the rect |
| Upscaling small layers to the slot size wastes VRAM                                                            | `size` is per array; budgets (`budgets.ts`) flag it; the handbook says to group layers by size     |
| p303 and p309 are written against their own tools                                                              | Update their D4 / D1 text now (done with this plan)                                                |

## 6. Open questions

1. Should texture sets (p303) be built as D2 build-time arrays instead of runtime assembly? Runtime
   assembly keeps members swappable (the gallery needs that); build-time arrays download as one
   file. p303 decides per use.
2. Sparse or virtual texturing is out of scope.
