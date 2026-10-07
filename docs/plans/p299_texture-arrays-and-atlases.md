Status: in progress | Phases 0-2 implemented
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

As built (a spike scene, since turned into Phase 1's `textureArrays` scene; its files from
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
BC, ETC2 or ASTC; forced in the spike with a loader whose `workerConfig` was all false) fails for single textures as much as
arrays. WebGPU throws in `_copyCompressedBufferToTexture` (`_getBlockData` has no entry for
`rgba8unorm`), WebGL2 uploads (and counts) the bytes but samples black. Every KTX2 the engine loads
has this today; it needs its own issue.

Untested: a one-member array (three sets `isArrayTexture` from `image.depth > 1`, so it would bind
by `isCompressedArrayTexture` alone). Phase 1 tests it or requires two members.

### Phase 1 — Runtime arrays (D1) — done

`core/TextureArray.ts`, registry integration, ref counting, layer swap. **Exit:** an array of 4
KTX2 members renders identically to the 4 separate textures, with one binding.

As built (verified in the `textureArrays` debug scene on WebGPU and WebGL2: the 4-layer array,
drawn by one quad with one material, differs from the 4 single textures by at most 1/255):

1. API: `buildTextureArray({ id?, members, colorSpace?, texOpts?, swappable?, isPersistent?,
debugData? })`, `setTextureArrayLayer(id, layer, member)` (async; swaps of one array run in call
   order), `getTextureArray(id)`, `getTextureArrayInfo(texture)` (`userData.textureArray`: members
   per layer, kind, size, levels, bytes per layer, `swappable`, `cpuDataReleased`).
2. A member is a registered texture's id (read and left alone), a `*.texture.json` id or
   `TextureProps`. The last two are loaded for the array alone through `loadTextureFileAsync` and
   `resolveTextureUrl`, split out of `loadTextureAsync` (`core/Texture.ts`, which now uses them):
   never registered nor uploaded, their asset's `texOpts` applied as `loadTextureAsync` would, and
   dropped after assembly.
3. Ownership: an array holds a copy of its members' data, so it is self-contained: a registered
   texture owned by the scene that built it, released at that scene's exit like any texture
   (verified). "Members as dependencies for scene ownership" is only a JSON concern (p302 D6's
   closure, Phase 5); nothing ties a member's lifecycle to the array at runtime. Texture ref counts
   aren't used by the engine (release goes by owner and material use), so neither do arrays.
4. Ids: a non-swappable array without an id gets `arr:<hash>` of its members, colour space and
   texOpts, so two builds share one. A swappable one gets a unique id: a swap must never change an
   array someone else shares.
5. The CPU copy: kept for a swappable array, else dropped right after the first upload, in a
   microtask after `onUpdate` (three sizes a texture from its data after calling `onUpdate`).
   `buildTextureArray` uploads at once (`initTexture`), so the load pays for it. A dropped array
   can't be re-uploaded (`needsUpdate` would fail). The Assets tab sizes compressed textures from
   their mip data, so it shows no size for a dropped array (and an uncompressed array's size
   leaves out its layers): Phase 4's D6 fixes both. The GPU memory tab counts arrays right.
6. Uncompressed path: image members are drawn into an `OffscreenCanvas` (flipped when the texture
   has `flipY`), into a `DataArrayTexture` with GPU mipmaps. Its colour space comes from
   `colorSpace` or the members' asset `texOpts`. A mix of KTX2 and image members throws, and the
   message points at `yarn assets` (an asset without pipeline output loads its source image).
7. One-member arrays work on both backends (`isArrayTexture` is false for every
   `CompressedArrayTexture` in r186, since its depth is set after the base constructor; binding goes
   by `isCompressedArrayTexture`). No two-member rule.
8. Mismatches throw with the member, its layer and both values: format (codec), size, mip count,
   colour space, kind; an unknown member; a swap of a non-swappable array; a layer out of range.

### Phase 2 — Build-time arrays (D2) — done

Schema, gatherer suffix, pipeline step (resize + `--layers` encode), lock and budget, runtime
load. **Exit:** `yarn assets --only <array>` builds a 3-layer array from mixed-size sources; a
clone with `assets.lock.json` and no `ktx` loads it from the cache.

As built (exit verified: in a fresh clone, no `.tools/` and no `.cache/` store, `AEK_KTX` set to a
missing binary, the gather took every asset from the lock and gave `p299TestArray` its `__url`;
there, with the output deleted, `yarn assets --only p299TestArray` rebuilt it from its 2048² JPEG,
256² PNG and 2048² PNG layers byte-identical to the committed file). The sections' own lists
follow.

#### Section 1: Schema, gatherer suffix, layer resolution — done

`schemas/textureArraySchema.ts`, the `.textureArray.json` suffix in `gatherAppData.ts` (arrays
share the textures' registry and id space) and `devTools/assetPipeline/textureArrays.ts`'s
`resolveTextureArrayLayers`. Test asset: `src/app/textures/p299TestArray.textureArray.json`.

As built:

- `__layers` is an array of layer names in layer order (a texture's id, or a file's name without
  its extension), not D2's id → index map. Two layers with the same name fail the gather.
- A texture layer is its source (its file or pack recipe), never its output, its `optimize` or a
  scene's override of it.

#### Section 2: Pipeline step (resize + `--layers` encode, cache and lock) — done

A `textureArray` pipeline asset type with an `ArraySource` (`textureArrays.ts`), through
`collectPipelineAssets`, `processAsset`, the cache and the lock. `encodeKtx2Layers`
(`ktxEncode.ts`) writes one PNG per layer before reading the next, then runs
`ktx create --layers N`. Output: `aek-assets/<json path>.array.<hash>.ktx2`.

As built:

- Size: the JSON's `size`, else the layers' common size (they must agree), then fit to `maxSize`
  and multiples of 4 like a texture. Layers are stored flipped. A layer with alpha makes the whole
  array RGBA. Upscaled or stretched layers get a warning.
- Every layer is read in the array's colour space. Only a pack layer whose texture is in another
  colour space fails (its recipe decodes and multiplies in its own).
- `optimize.textures: false` is rejected by the schema; a slot resolving to codec `none` (eg.
  `data`) fails the gather and the build. An array whose textures side is off (a rule's
  `textures: false`, the project switches) is `skipped`: no output.
- `EncodedTexture.layers`: VRAM figures and the per-texture budget ceiling count every layer.
- The dev server also rebuilds an array when one of its layers' `*.texture.json` changes
  (`listAssetJsonFiles`).
- `ktx create --layers 1` writes `layerCount: 1`, which three's KTX2Loader loads as a plain
  `CompressedTexture` (it builds a `CompressedArrayTexture` only for `layerCount > 1`): section 4
  wraps it or requires two layers.

#### Section 3: Generated data and budgets — done

`__url`, `__bytes`, `__vramBytes` and `__codec` on the gathered array (`generated.ts`, keyed by
`getTextureArrayAssetKey`); the production gather's missing-output and budget checks for the
arrays shipped scenes use, including a `skipped` array (no output to ship);
`assetOutputsBuildPlugin.ts` ships its output.

As built (verified with the test array listed in a shipped scene for the run: a production gather
and `yarn build` ship it; over budget, `AEK_ASSETS_OPTIMIZE=false` and no `ktx` each fail the
build, naming the array):

- `getTextureArrayGeneratedFields` / `getTextureArrayResult` (`generated.ts`) share
  `getOutputFields` with the textures. The fields go on the registry entry (dev data) and reach
  the scene entry with it: an array has no scene entries. No `__sourceUrl`: no single file
  stands in for the layers.
- `isMissingOutput` counts a `skipped` array (its textures side off) as missing, unlike a
  texture's `skipped`, which ships as before the pipeline.
- `AEK_ASSETS_ALLOW_UNOPTIMIZED` leaves arrays out of its fallback (`command.ts`): they stay
  `encoderMissing`, and the gather says an array needs `ktx` even with it.
- `assetOutputsBuildPlugin.ts` needed no change: it keeps every `__url` in the bundled data.
- Fixed on the way (Phase 1): `TextureArray.ts` and `app/textureArrays.ts` read
  `getGeneratedAppData().textures`, which production data doesn't have, so `yarn build`'s `tsc`
  failed (the Stop hook type-checks dev data). At runtime, a member given by `*.texture.json` id
  now fails with its own error in production, not a `TypeError`. Such a member still resolves in
  dev data only, though: production data has no texture registry (settled in section 4).

#### Section 4: Runtime load and verification — done

`loadTextureAsync` loads the array's `__url` (a one-layer array too); the exit criteria in the
`textureArrays` scene on WebGPU and WebGL2; this phase's "As built" and the status line.

As built (verified in the `textureArrays` scene on WebGPU and WebGL2: each layer of the 3-layer
asset, and the one-layer asset, next to its source file differs by a mean of 1.2-2.7 / 255 over
the cell, the same on both backends, with the same orientation; GPU memory counts each array's mip
bytes exactly):

- `TextureProps.__layers` marks an array asset: `loadTextureAsync` hands it to
  `loadTextureArrayAssetAsync` (`core/Texture.ts`). The scene loader needed no change: an array's
  scene entry is already a texture entry. The texture gets a `TextureArrayInfo` on
  `userData.textureArray` with the new `origin: 'BUILD'` (runtime arrays: `'RUNTIME'`) and the
  layer names as `members`, so `getTextureArray` and `getTextureArrayInfo` cover both kinds.
- A one-layer file (KTX2Loader's plain `CompressedTexture`) is wrapped into a one-layer
  `CompressedArrayTexture` from the same mip data. A file whose layer count differs from
  `__layers` fails (stale generated data).
- No output (`__url` unset: the array has no source to fall back to) and a failed load log an
  error and return an unregistered black `DataArrayTexture` with as many layers, so a material
  that samples it with `.depth()` still binds an array; `throwOnError` throws instead. It used to
  return a plain empty texture without a word.
- `setTextureArrayLayer` on a `BUILD` array says its layers are in its file; a `BUILD` array as a
  `buildTextureArray` member fails like any array.
- Production members by texture asset id: the scene loader registers every texture a scene lists
  before its scene file runs, so such a member is borrowed as registered. A lookup through the
  scene entries would never run; the error tells production to list the asset in the scene's
  `textures` instead.
- The build-time array keeps its CPU mip data after the upload, like every loaded KTX2 texture
  (only a non-swappable runtime array drops it).
- Test asset: `src/app/textures/p299TestArray1.textureArray.json` (one 256² layer). The scene lists
  both assets in its `textures` (column 4 rows 2-4 and column 5); its results add
  `noOutputFallback` and `assetErrors`.

### Phase 3 — Atlases (D3)

Schema, packer, per-slot composition, cell table. **Exit:** a 2-slot atlas of 6 cells, mips
viewed at the smallest level the file has show no neighbour bleeding.

Decided before it started (D3 as written can't meet its exit):

- **A shortened mip chain.** No padding protects a full chain: at 1×1 every cell is averaged
  together. And `ktx create --generate-mipmap` filters with `lanczos4`, whose kernel reaches past
  the padding. So the pipeline computes the levels itself (`images.ts`'s exact 2×2 box) and
  passes them to `ktx create --levels N` (verified with 4.4.2: no `--generate-mipmap`, input files
  level-major, layers inner). The chain stops at level `L`, the last one the layout protects:
  every padded rect (and the atlas size) aligned to `2^L` and `padding ≥ 2^L`, so a level-`L` texel
  never straddles two cells and a bilinear tap at a cell's edge stays in its padding. three r186
  sizes the GPU texture from `mipmaps.length` on both backends (`Textures.getMipLevels`,
  `texStorage2D/3D`), so a short chain is a complete texture.
- **Slots are KTX2 only**, like arrays: a `codec: "none"` PNG would get a full chain generated
  at runtime. p309's `normalRough` (slot `data`) needs a codec set.
- **`maxSize`:** a slot drops its top levels until it fits (exact halving keeps the cells
  aligned), and warns when that leaves fewer levels than the layout protects.
- **`rect` includes the padding**; the cell's UV rect is the content inside it. UVs are three's
  (v up, the KTX2 stored flipped like every texture's).
- **Slot colour space** is the slot's `texOpts.colorSpace` (`"srgb"`), like textures and arrays.
- **Runtime ids** (asked): each slot is an ordinary registered texture, id `<atlasId>.<slot>`,
  with the cell table on `userData.textureAtlas` (like `userData.textureArray`). A scene lists
  `"<atlasId>"` in its `textures` (the gatherer expands it to every slot) or one slot by its id.
  No SceneLoader change.

#### Section 1: Schema, gatherer suffix, cell resolution, packer — done

`schemas/textureAtlasSchema.ts`, the `.textureAtlas.json` suffix in `gatherAppData.ts` (slots in
the textures' registry and id space) and `devTools/assetPipeline/textureAtlases.ts`: cell sources
resolved like array layers (a texture's source or pack, or a file), the layout (explicit rects and
a shelf packer, both aligned; the protected level count) and the cell table (`__atlas`). Source
sizes come from a synchronous header read (`readImageSizeSync`, PNG / JPEG / WebP), since the
gather is synchronous; another format needs the cell's `size` or `rect`. Test asset:
`src/app/textures/p299TestAtlas.textureAtlas.json` (2 slots, 6 cells: explicit rects and packed
ones, a texture asset source, a cell without a source in one slot).

As built:

- Each slot is a dev data `textures` entry `<atlasId>.<slot>` with `__atlas: { id, slot, size,
padding, levels, cells }`, a cell being `{ uv: [u0, v0, u1, v1], size: [w, h], data? }` (content
  px of the layout). The atlas id is taken in the textures' id space too. A slot entry gets the
  slot's `debugData` (else the atlas's), both `userData`s merged and the atlas's `throwOnError`.
- `padding` defaults to 8. The packer places the cells without a `rect` tallest first, each
  padded and rounded up to the grid `2^⌊log2 padding⌋` (at least 4). An explicit rect off the
  4 px grid is an error, not snapped (snapping would move the author's layout). A rect, or the
  atlas size, aligned to less than the padding protects shortens the chain, with a warning naming
  it.
- A cell needs a source in one slot or more; `rect` and `size` exclude each other. Slot names are
  letters, digits, `_` and `-` (they end the texture id after a dot). The slot schema is strict:
  the plan's `"colorSpace": "SRGB"` on a slot is an error (it is `texOpts.colorSpace`).
- The gather checks each slot's settings: codec `none` fails like an array's
  (`getTextureArraySlotSettings`, now with a `what` for the message).
- Shared with arrays (`textureArrays.ts`): `resolveTextureSourceRef` (a layer or cell source) and
  `readTextureSourceSizeSync`. `readImageSizeSync` (`images.ts`) matched sharp on 44 files (PNG,
  baseline and progressive JPEG, lossy / lossless / alpha WebP).
- `gatherAppData.ts`'s issue expansion also unwraps a record's "Invalid key in record" into the
  key's own message (any record-keyed schema).
- Not yet: the dev server doesn't watch an atlas's source images (section 2 adds them through the
  pipeline assets), and a scene can't list an atlas yet (section 3).
- Test sources (`src/app/textures/source/p299Atlas/`): saturated solid cells with a dark border
  and white diagonals, and greyscale masks, so a neighbour's hue shows where it bleeds.

#### Section 2: Composition and encode — done

Per slot: each source resized into its cell's content rect, edge-extended into its padding, the
rest of the atlas `fill`; then the box-filtered levels down to the protected one (less what
`maxSize` drops), encoded with `ktx create --levels N`. A `textureAtlas` pipeline asset per slot,
through `collectPipelineAssets`, `processAsset`, the cache and the lock. Output:
`aek-assets/<json path>.atlas.<slot>.<hash>.ktx2`.

As built (verified on the test atlas: both slots 512² with 5 levels down to 32², each level
extracted with `ktx extract` shows every cell in its own rect with its edge extended and no
neighbour's hue; a second run is all cache hits, a deleted output is restored from the store, and
the arrays' keys didn't change):

- `AtlasSlotSource` (`kind: 'atlas'`, `textureAtlases.ts`): the slot's name, the atlas id, the
  layout (size, padding, levels) and each cell's rects with this slot's source, or none (its
  fill). `collectPipelineAssets` reads `*.textureAtlas.json` (`readAssetJsons`) and adds one
  pipeline asset per slot, keyed `getTextureAtlasSlotAssetKey` (`textureAtlas:<json>:<slot>`), with
  the slot's texture id (`<atlasId>.<slot>`), its `optimize` and its colour space. Its settings
  resolve against the atlas JSON's path. An atlas whose cells don't resolve or fit gets none.
- The cache key (`getTextureAtlasKeyParams`) has the layout as this slot draws it (each cell's
  rects and what its source is: a file, a pack recipe or the fill), the JSON's `fill`, and the
  files this slot's cells read, in cell order. So an edit to another slot's sources only rebuilds
  that slot, unless it moves the layout.
- Channels: a slot is RGBA when one of its sources has alpha (from the headers,
  `probeTextureSource`), or its `fill` has 4 values with alpha below 1. The default fill
  `[0, 0, 0, 0]` is transparent black in an RGBA slot and black in an RGB one. A 3-value fill is
  opaque.
- Levels: composed at the layout's size, then `images.ts`'s `halve` (exported) per level, each
  flipped as stored and written one at a time (`encodeKtx2Levels` in `ktxEncode.ts`: the inputs
  are the levels, `getKtxCreateArgs`' new `generateMipmap: false`). `mipmaps: false` stores one
  level. `maxSize` drops the top levels with a warning; it fails when it leaves none of the
  protected levels, or when the new top level isn't a multiple of 4 (an atlas `size` aligned to
  less than `4 << dropped`).
- `EncodedTexture.levels` (new, in the lock entry): the stored level count, a shortened chain.
  `estimateVramBytes` takes it, so the run's VRAM figure (and section 3's `__vramBytes`) counts
  only those levels. An atlas slot's `source` is the layout's size and its unique source files'
  bytes; VRAM `in` is the layout as one RGBA8 image with a full chain.
- Warnings, cached with the output: a cell source that is upscaled or stretched into its cell,
  and `maxSize` dropping levels. The gather now warns for a slot no cell has a source in.
- Shared with arrays (`textureArrays.ts`): `readTextureSource` (the layer reader without the flip),
  `probeTextureSource`, `listTextureSourceFiles`, `getTextureSourceKeyParam`; `toChannels` moved
  to `images.ts`.
- Tooling: `yarn assets --only <atlasId>` builds every slot, `<atlasId>.<slot>` one. The run lists
  a slot with its cell count. Like arrays, an atlas slot is never passed through (`skipped` with
  its textures side off) and stays out of `AEK_ASSETS_ALLOW_UNOPTIMIZED`'s fallback. The dev server
  rebuilds a slot when the atlas JSON, a cell source's `*.texture.json` or a source image changes.
- The test atlas's mask slot warns three times (section 1's masks are stretched into cells of
  other shapes). The warnings are correct, so the asset is left as it is.

#### Section 3: Generated data, scenes and budgets — done

Per slot `__url`, `__bytes`, `__vramBytes`, `__codec`; a scene's `"<atlasId>"` expanded to its
slots; the production gather's missing-output and budget checks per slot.

As built (verified with the test atlas listed in a shipped scene for the run, as
`["p299TestAtlas.mask", "p299TestAtlas", "p299TestAtlas.albedo"]`: the scene got the mask and
albedo slots once each, without `debugData` or `__sourcePath` in production; `yarn build` with no
`ktx` took both from the lock and shipped both outputs to `dist/aek-assets/`; over budget,
`AEK_ASSETS_OPTIMIZE=false` and no `ktx` on a cache miss (also with `AEK_ASSETS_ALLOW_UNOPTIMIZED`)
each fail the production gather, naming the slot):

- `getTextureAtlasSlotGeneratedFields` / `getTextureAtlasSlotResult` (`generated.ts`) go through
  `getOutputFields` like the arrays' and look the result up by `getTextureAtlasSlotAssetKey`. The
  fields go on the slot's registry entry and reach the scene entry with it. `__vramBytes.out`
  counts the stored levels (the test atlas: 512² to 32², 349,184 B).
- A scene's `"<atlasId>"` becomes its slot ids in the JSON's `slots` order, where the id stood. A
  slot listed again, by its own id or the atlas's, is dropped, so the loader never registers it
  twice. Other duplicate texture ids are left as before. An atlas that failed the gather stays a
  raw string id, like any unknown id.
- A slot's scene entry is its registry entry less `__sourcePath`, with `__atlas` (the cell table
  is repeated in every slot entry, as section 1 decided). `debugData` is dropped in production.
- `isKtxOnlyAsset` (`generated.ts`: a texture array or an atlas slot) replaces the array-only
  checks: `isMissingOutput` counts a `skipped` slot as missing, the gather's hints say "a texture
  array or atlas slot", and `command.ts`'s `AEK_ASSETS_ALLOW_UNOPTIMIZED` fallback uses it too.
- Budgets needed no change: `getBudgetViolations` reads the slot's `EncodedTexture` (its `levels`
  in the VRAM figure, the full-chain ceiling at the profile's `maxSize`).
- `assetOutputsBuildPlugin.ts` needed no change (every `__url` in the bundled data).
- No scene lists an atlas yet: section 4's `textureAtlases` scene is the first, and the runtime
  side of a slot entry is untested until then.

#### Section 4: Runtime load and verification

`loadTextureAsync` gives a slot texture its `userData.textureAtlas`; a `textureAtlases` debug
scene showing each slot at each of its levels (`textureLod`) with the cell rects, on WebGPU and
WebGL2. This phase's "As built" and the status line.

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
