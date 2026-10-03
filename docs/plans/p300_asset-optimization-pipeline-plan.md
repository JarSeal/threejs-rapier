Status: draft | not-implemented
Category: Assets
Blocks: p301_terrain-texturing-epic.md (and through it p302–p310: the terrain texture library ships as KTX2, terrain blocks as meshopt GLBs), p347_lod-chain-generation.md (soft: only its build-time Phase 3, which adds a LOD-chain step to this pipeline)

# Asset Optimization Pipeline (KTX2 + meshopt) — Plan

A build-time pipeline that turns the source textures and GLB/glTF files the asset JSONs point at into GPU-compressed, runtime-ready files: KTX2 (Basis Universal) textures and meshopt-compressed meshes. It also adds the runtime decoders the engine lacks today.

Updated 2026-10-02 to match the engine (three r186, `WebGPURenderer`, asset worker, JSON asset pipeline). The original version assumed a generic three.js app with a separate asset manifest. This version hooks into the existing `*.texture.json` / `*.importedAsset.json` files and `gatherAppData` instead.

---

## 1. Goal

Reduce both **download size** and **GPU memory**. Each asset's settings are data in the asset's own JSON, not ad-hoc runs of a web tool.

Published figures for this class of optimization:

|                                               | File size | VRAM   |
| --------------------------------------------- | --------- | ------ |
| Raw export                                    | 39 MB     | 342 MB |
| Size-only optimization (typical online tools) | 4.26 MB   | 22 MB  |
| KTX2 + mesh compression                       | 0.68 MB   | 6 MB   |

Ordinary "compress my GLB" tools only fix the file-size column, not VRAM. PNG/JPEG/WebP textures are decoded to raw RGBA in VRAM, so a 2048² texture costs ~16 MB whatever its file size, plus ~33% for mips. KTX2/Basis textures stay block-compressed on the GPU: they are transcoded at load into whatever the device supports (BC7, ASTC, ETC2).

This plan is a hard prerequisite of the terrain texturing epic (p301). A terrain material samples 6–36 textures per pixel across up to 8 layers. Uncompressed, a 16-set terrain library at 1K costs ~260 MB of VRAM; as KTX2 it costs ~40–65 MB.

---

## 2. Current engine state (grounded, 2026-10-02)

- **No compressed texture path.** There is no `KTX2Loader`, `CompressedTexture`, `CompressedArrayTexture`, `DataArrayTexture` or Basis transcoder anywhere in `src`. Nothing exists for gltf-transform, meshoptimizer, KTX-Software or sharp in `package.json` either.
- **Textures** (`core/Texture.ts`, `schemas/textureSchema.ts`):
  - `loadTextureAsync` (`Texture.ts:412-488`) picks a loader by type:
    - `HDRLoader` when `useHDRLoader` is set;
    - `CubeTextureLoader` for a 6-entry file name array (main thread);
    - otherwise `TextureLoader`, or the asset worker's `createImageBitmap` (`workers/assets/assetsSwitchTexture.ts`), chosen by `assets.textureWorkerTarget` (`Config.ts:126`).
  - Paths resolve as `new URL((path || './') + fileName, document.baseURI)` (`Texture.ts:61-62`). In practice `fileName` is a root-absolute URL served from `src/public`.
  - The schema has no `repeat`, `offset`, `rotation`, `flipY`, `generateMipmaps`, `format` or `isPersistent`. p302 adds them.
- **Imported assets** (`core/Import/*`, `schemas/importedAssetSchema.ts`):
  - `GLTFLoader` is set up with Draco only, in `GLTFSource.ts:12-18` and in the worker (`workers/assets/assetsSwitchGLTF.ts:25-39`). There is no `setMeshoptDecoder` or `setKTX2Loader`.
  - glTF materials are always discarded. `importTextures` registers slot textures as `${id}/${name}` (`GLTFTextures.ts:50-121`). So embedded textures only matter when `importTextures` is on.
  - Draco decoders are copied from `node_modules/three/examples/jsm/libs/draco/gltf` into the gitignored `src/public/draco/gltf/` by `devTools/copyDracoDecoders.ts`, which runs before `dev`/`build`.
  - `MeshColliderGeometry.ts:239-244` refuses Draco-compressed geometry for HEIGHTFIELD/TRIMESH colliders.
- **Where binaries live:** `vite.config.ts` has `root: './src'` and no `publicDir`, so the public dir is `src/public`, served at `/`.
  - `src/public/debugger/assets/` is 287 MB of git-tracked test textures and models (8K HDRs, 8K PNGs, 24 GLBs).
  - There is no `.gitattributes` and Git LFS isn't installed or configured.
  - `gatherAppData` computes `__fileSize` against `src/public` (`gatherAppData.ts:107-123`).
- **Data pipeline:** `devTools/gatherAppData.ts` gathers 10 JSON suffixes into `src/_engine/generatedAppData.json`. It is re-run by the `sceneGathererPlugin` Vite plugin on file change.

---

## 3. Key decisions

### DD1 — Encode at build time, never at load

- Basis/KTX2 **encoding** is seconds to minutes per texture; **transcoding** (what the client does) is milliseconds.
- Encoding at load would mean shipping the uncompressed source, which throws away the download win.
- The encoder is a large WASM payload.
- User-uploaded models would need a client-side encoder. That is out of scope (Open questions).
- Dev ergonomics come from the existing gatherer plugin: a changed source re-encodes only that asset, through the cache (§7).

### DD2 — Settings live in the asset JSONs; profiles live in one config

- **No separate asset list.** `*.texture.json` and `*.importedAsset.json` gain an optional `optimize` key: a profile name plus per-slot overrides.
- **Profiles and defaults** live in `assets.config.json` at the repo root, validated by a Zod schema that compiles to `.schemas/assetsConfig.schema.json` like the other schemas.
- **A glob rule list** in the config covers binaries that have no JSON (e.g. the debugger test models), so they can be optimized without adding JSONs.
- Rationale: the engine is data-driven by its asset JSONs, and the gatherer already walks them. A second manifest listing the same files would drift.

### DD3 — Sources sit next to their JSON; outputs are generated into the public dir

- **New rule:** `fileName` may be **relative to the JSON file** (`"fileName": "./source/sand01_albedoHeight.png"`). A root-absolute `fileName` keeps working unchanged (legacy, `src/public`).
- **Outputs** are written to `src/public/aek-assets/<logical path>.<contentHash>.<ext>`:
  - `.ktx2` for textures;
  - `.glb` for models, with `EXT_meshopt_compression` and `KHR_texture_basisu`.
- **Resolution:** `gatherAppData` writes the resolved output URL into the generated data (`__url`, plus `__bytes` and `__vramBytes`). The runtime loads `__url ?? (path + fileName)`.
- **Recommended for this repo: commit `src/public/aek-assets/`.** This is the open question from the original plan, resolved for a template repo: someone who clones Ækasha can run it without installing KTX-Software. The encoder is only needed by whoever changes an asset.
  - Sources that can be re-downloaded (the CC0 terrain textures, p303) are fetched by script into gitignored `source/` folders.
  - Small app sources (Blender-exported GLBs, painted splat maps) are committed.
  - Override this if CI is preferred. The cache (§7) makes CI builds cheap.

### DD4 — Standalone textures are first class, not just GLB-embedded ones

- The terrain library (p303) is standalone texture files, not GLBs.
- The pipeline therefore encodes `*.texture.json` sources directly with the `ktx` CLI (KTX-Software ≥ 4.3, `ktx create`).
- GLBs go through gltf-transform, which shells out to the same binary.

### DD5 — Channel packing is a pipeline step

- A texture JSON may have a `pack` source instead of a single file: per output channel, a source file plus a channel, or a constant, with optional ops (`invert`, `multiply` by another channel, `remap`).
- Example: build the ORM map from `ao.png:R`, `roughness.png:R` and constant `0`, or put `height.png:R` in the albedo's alpha.
- This is generic glTF ORM packing that every PBR asset benefits from. p303 defines the terrain packings (`FULL` / `LITE` / `MINIMAL`) on top of it.
- Image I/O uses `sharp` (dev dependency, prebuilt binaries). 16-bit sources (height maps) are read at 16 bits and quantized once, at the end.

### DD6 — Meshopt over Draco by default

- Meshopt decodes faster than Draco, and its quantization also shrinks vertex buffers in memory. Draco only shrinks the download.
- Draco stays available per asset.
- **Collider sources** (anything with `colliderType` custom props) default to `mesh.quantize: false`. Both the heightfield extraction (`MeshColliderGeometry.ts`) and the trimesh path read positions directly. With `KHR_mesh_quantization`, positions become normalized integers and the dequantization moves into the node transform, which the collider builder doesn't apply. Meshopt without quantization is lossless and safe. See risks.

### DD7 — KTX2 textures load on the main thread, through `KTX2Loader`'s own workers

- `KTX2Loader` already transcodes in its own worker pool, so threading is preserved.
- `KTX2Loader.detectSupport(renderer)` needs the renderer, which the asset worker doesn't have.
- GLBs that carry `KHR_texture_basisu` textures need a KTX2 loader inside the asset worker's `GLTFLoader`. Phase 0 spikes passing the main thread's detected `workerConfig` (`astcSupported`, `bptcSupported`, `etc2Supported`, …) into the worker. If that fails, such GLBs load on the main thread.

---

## 4. Configuration

`assets.config.json` (repo root):

```json
{
  "$schema": "./.schemas/assetsConfig.schema.json",
  "defaults": {
    "mesh": { "codec": "meshopt", "quantize": true, "simplify": null },
    "textures": {
      "default": { "codec": "etc1s", "maxSize": 1024, "quality": 200, "mipmaps": true }
    }
  },
  "profiles": {
    "hero": {
      "textures": {
        "baseColor": { "codec": "uastc", "maxSize": 2048, "level": 4, "rdo": 4, "zstd": 18 },
        "normal": { "codec": "uastc", "maxSize": 2048, "normalMode": true },
        "orm": { "codec": "uastc", "maxSize": 1024 },
        "default": { "codec": "etc1s", "maxSize": 1024 }
      }
    },
    "prop": {
      "textures": { "default": { "codec": "etc1s", "maxSize": 512 } },
      "mesh": { "simplify": 0.6 }
    },
    "terrainLayer": {
      "textures": {
        "baseColor": { "codec": "uastc", "maxSize": 1024, "rdo": 2, "zstd": 18 },
        "normal": { "codec": "uastc", "maxSize": 1024, "normalMode": true, "zstd": 18 },
        "orm": { "codec": "uastc", "maxSize": 1024, "zstd": 18 }
      }
    },
    "terrainBlock": { "mesh": { "codec": "meshopt", "quantize": false } },
    "data": { "textures": { "default": { "codec": "none" } } }
  },
  "rules": [{ "glob": "src/public/debugger/assets/testModels/**/*.glb", "profile": "prop" }]
}
```

Per asset (in a `*.texture.json`):

```json
{
  "id": "sand01_albedoHeight",
  "fileName": "./source/sand01_albedoHeight.png",
  "optimize": { "profile": "terrainLayer", "slot": "baseColor" }
}
```

- **Resolution order:** `defaults` → rule (glob) → profile → the JSON's `optimize` overrides, deep-merged, later wins.
- **Slot keys:**
  - glTF slots: `baseColor`, `normal`, `metallicRoughness`, `occlusion`, `emissive`;
  - `orm` (packed occlusion/roughness/metalness);
  - `data` (splat maps, masks, LUTs, height);
  - `default`.
- A standalone texture names its slot. A GLB's embedded textures are classified by the material slot that references them.
- **Codec guidance:**
  - **ETC1S**: small and fast. Fine for base colour and emissive. Destroys normal maps and packed ORM.
  - **UASTC** (with RDO + Zstd supercompression): the default for normal, ORM and terrain layers. Terrain layers are tiled many times across the screen, so artifacts repeat and show.
  - **none**: data textures, LUTs, splat maps that must stay exact, anything read back on the CPU.
- **Block-compressed sizes must be multiples of 4.** The resize step enforces it and warns when that changes the aspect ratio.

---

## 5. Generated data

`gatherAppData` merges the pipeline results into `generatedAppData.json`. There is no separate runtime manifest file.

```json
"textures": {
  "sand01_albedoHeight": {
    "id": "sand01_albedoHeight",
    "__url": "/aek-assets/toolkit/terrain/textureSets/sand01/sand01_albedoHeight.3fa9c21b.ktx2",
    "__bytes": { "in": 5872311, "out": 1043220 },
    "__vramBytes": { "in": 5592405, "out": 1398101 },
    "__codec": "uastc"
  }
}
```

- `__vramBytes` is an estimate from dimensions, format block size and the mip chain. It's for catching regressions and for the profiler window (`_DONE_p344`), not a measurement.
- A stats summary is also written to `.cache/asset-pipeline/last-run.json` and printed per run: totals in/out, cache hit rate, slowest assets.

---

## 6. Runtime

- **Decoders:**
  - Generalize `devTools/copyDracoDecoders.ts` → `copyDecoders.ts`, which also copies `three/examples/jsm/libs/basis/basis_transcoder.{js,wasm}` to `src/public/basis/` (gitignored, like Draco).
  - The meshopt decoder (`three/examples/jsm/libs/meshopt_decoder.module.js`, ~20 kB) is imported dynamically, only when an asset uses `EXT_meshopt_compression`, so apps without meshopt don't ship it.
- **`core/Import/KTX2.ts`** (new): a lazily created, shared `KTX2Loader` with `setTranscoderPath(`${BASE_URL}basis/`)` and `detectSupport(renderer)`, run after `renderer.init()`. Check the r186 API (`detectSupport` vs `detectSupportAsync`) for `WebGPURenderer`. Disposed on renderer teardown.
- **Textures:** `loadTextureAsync` routes `.ktx2` (by the resolved URL's extension) to the shared KTX2 loader on the main thread (DD7).
  - The result is a `CompressedTexture`, or a `CompressedArrayTexture` for KTX2 arrays.
  - `flipY` cannot be applied to compressed textures. Encode them flipped instead: the pipeline flips by default for textures whose JSON doesn't set `flipY: false`, matching the `createImageBitmap(flipY)` path's orientation. Phase 1 verifies this visually against the PNG path.
  - Compressed textures can't generate mipmaps at runtime, so the pipeline always writes the full mip chain unless `mipmaps: false`.
- **GLTF:**
  - `GLTFSource.ts` and `assetsSwitchGLTF.ts` get `setMeshoptDecoder` and `setKTX2Loader` (DD7 for the worker).
  - `MeshColliderGeometry.ts` keeps refusing Draco and also refuses quantized positions (a normalized integer position attribute), with an actionable error ("set `optimize.mesh.quantize: false` for collider sources").
- **Caching headers:** hashed file names can be served with long-lived cache headers. The dev server needs nothing.

---

## 7. Caching

Without a cache, a full encode pass slows builds enough that people skip it.

- **Cache key** = hash of:
  1. the source bytes (all sources, for packed textures);
  2. the resolved settings (post-merge, canonically serialized);
  3. the pipeline version plus the pinned `ktx` and gltf-transform versions.
- On a hit, copy from `.cache/asset-pipeline/<key>` (gitignored) and skip encoding.
- On a miss, encode, write to the cache, then copy to the output.
- Stale outputs (hashes no longer referenced) are deleted from `src/public/aek-assets/` at the end of a full run, never during a watch-triggered single-asset run.

---

## 8. Tooling

- **gltf-transform JS API** (`@gltf-transform/core`, `/functions`, `/extensions`) for GLBs: meshopt, Draco, quantize, resize, per-slot KTX2 through `ktx`.
- **`ktx` CLI** (KTX-Software ≥ 4.3) for standalone textures and texture arrays (`ktx create --layers N`, used by p303 if runtime array assembly proves unworkable).
  - It's a system dependency, not an npm package. Pin the version in the docs/CI and fail with a clear message if it's missing or too old.
  - Without `ktx`, the pipeline still runs: cached and committed outputs are used, and assets that need encoding report "encoder missing" and fall back to their source file at runtime (dev only, warned).
- **`sharp`** for channel packing and resizing (DD5).
- **Alternative considered: gltfpack.** It's a single binary, `-tc`/`-cc`, but much coarser per-slot control and no standalone texture packing. It's the fallback if KTX-Software proves painful.
- **Commands:**
  - `yarn assets` runs the full pipeline.
  - `yarn assets --only <id|glob>` runs part of it.
  - `yarn gatherAppData` runs the cached pipeline first, so `dev`/`build` stay one command.

---

## 9. Phases

### Phase 0 — Runtime decoders (no build tooling yet) (~1 day)

1. `copyDecoders.ts` (Basis transcoder), `core/Import/KTX2.ts`, meshopt decoder wiring in `GLTFSource.ts`.
2. `.ktx2` route in `loadTextureAsync` (main thread, DD7).
3. Spike: GLB with `KHR_texture_basisu` in the asset worker, with the main thread's `workerConfig` passed in. Record the outcome in this plan.
4. Hand-encode two textures and one GLB (gltf-transform CLI or `gltf-optimizer.simondev.io`) and load them in `debugScene`.

**Exit:** hand-optimized assets load on WebGPU and on the WebGL2 fallback (`forceWebGL`), with the PNG orientation (flip check) and no console errors.

### Phase 1 — Validate settings (~half a day)

1. Pick 3 representative assets: one terrain layer set (from p303's candidates), one prop GLB, and one problem case (a normal map, or an ORM with sharp channel edges).
2. Baseline: file size, `renderer.info.memory`, and a browser GPU memory capture.
3. A/B the visuals at on-screen resolution, not zoomed in, including a tiled terrain layer at grazing angles.
4. Test on the weakest target device, including iOS Safari.
5. Record the settings that worked as the first profiles.

**Exit:** a measured VRAM reduction with no visual regression anyone notices.

### Phase 2 — Pipeline (~2–3 days)

1. Config schema plus resolver (DD2), compiled to `.schemas/`.
2. `optimize` and relative `fileName` in `textureSchema` / `importedAssetSchema`.
3. Packing step (DD5).
4. Texture encoder (`ktx`) and GLB pipeline (gltf-transform).
5. Content-hash cache (§7).
6. Generated-data integration (§5).
7. `yarn assets`.

**Exit:** Phase 1 results reproduced by one command, and a second run is all cache hits.

### Phase 3 — Integrate (~1 day)

1. `gatherAppData` runs the cached pipeline, and the gatherer plugin re-encodes a changed source.
2. The runtime resolves `__url`.
3. Wire into `yarn build`.

### Phase 4 — Harden

1. Budgets: fail the build if an asset exceeds a size or VRAM threshold set per profile.
2. A missing or too-old `ktx` gives a clear error and a working fallback (§8).
3. Write the docs: a section in `readme.md`'s asset section, plus `docs/techniques/asset-optimization.md` (how to add an asset and pick a profile; codec cheat sheet).
4. Versioning: an engine minor bump (new runtime decoders and schema keys), plus Project tooling in `CHANGELOG.md`.

---

## 10. Risks and gotchas

| Risk                                                                         | Mitigation                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ETC1S ruins normal / ORM maps                                                | Per-slot codecs; UASTC is the default for those slots and for terrain layers                                                              |
| Quantized positions break colliders (HEIGHTFIELD/TRIMESH read raw positions) | `quantize: false` for collider sources (`terrainBlock` profile); the runtime refuses quantized collider geometry with an actionable error |
| `flipY` can't apply to compressed textures                                   | Encode flipped; Phase 0 visual check against the PNG path                                                                                 |
| `KTX2Loader` support detection in the asset worker                           | Main-thread fallback (DD7), Phase 0 spike                                                                                                 |
| Transcode stalls on load                                                     | `KTX2Loader` already uses its own workers; measure on a min-spec device; stagger big batches                                              |
| KTX-Software missing or old                                                  | Committed outputs plus source fallback in dev; clear error; pinned version                                                                |
| Encode times grow                                                            | Content-hash cache; slowest-asset report                                                                                                  |
| Compressed textures can't be read back on the CPU                            | `codec: "none"` per slot; CPU-side data (e.g. height for colliders) comes from geometry, never from textures                              |
| Asset licensing                                                              | The pipeline doesn't change licenses; terrain sources record theirs in `source.json` (p303)                                               |

---

## 11. Open questions

1. **Commit outputs or build in CI?** Recommended: commit (DD3). Confirm before Phase 2.
2. **User-uploaded models?** Would need a client-side encode path for that flow. Not planned.
3. **Minimum target device?** Sets the quality bar and the VRAM budgets (Phase 4). p240 (device capability sniffer) would make this measurable.
4. **Should the 287 MB of debugger test assets be optimized and re-pointed, or left as raw test inputs?** They are useful as "raw import" tests. Suggested: leave them as is, and add optimized copies only where a test needs one.
