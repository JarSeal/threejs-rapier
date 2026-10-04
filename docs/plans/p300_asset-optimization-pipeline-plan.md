Status: in progress | Phases 0-1 implemented
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
  - Draco decoders are copied from `node_modules/three/examples/jsm/libs/draco/gltf` into the gitignored `src/public/draco/gltf/` by `devTools/copyDracoDecoders.ts` (`copyDecoders.ts` since Phase 0), which runs before `dev`/`build`.
  - `MeshColliderGeometry.ts:75` refuses Draco-compressed geometry for HEIGHTFIELD colliders only. TRIMESH reads positions through the attribute getters, which already de-normalize quantized positions (`:50`).
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
- **Decided (2026-10-04): commit `src/public/aek-assets/`** (§11 question 1). For a template repo, someone who clones Ækasha can run it without installing KTX-Software. The encoder is only needed by whoever changes an asset.
  - Sources that can be re-downloaded (the CC0 terrain textures, p303) are fetched by script into gitignored `source/` folders.
  - Small app sources (Blender-exported GLBs, painted splat maps) are committed.
  - An app built on the template can build them in CI instead. The cache (§7) makes CI builds cheap.

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
- **Collider sources** (anything with `colliderType` custom props) default to `mesh.quantize: false`, which means lossless meshopt: `EXT_meshopt_compression` alone, with no quantization, vertex reorder or filters. Measured in Phase 1 (1c, 1d's collider check):
  - gltf-transform's `quantize()` moves the dequantization into the collider node's own transform, and the body and the shape derivation apply it. TRIMESH and BOX come out right, within 2.4 mm.
  - CONVEXHULL is built from the raw Int16 values, so it ends up 32.7 km off. HEIGHTFIELD throws: GLTFLoader loads a quantized position as an `InterleavedBufferAttribute`, which `mergeVertices` rejects. Phase 3 step 5 fixes the first and turns the second into a clear refusal.
  - gltf-transform's `meshopt()` always reorders vertices as well as quantizing them. The quantized HEIGHTFIELD throws before the reorder can be checked, but a reorder scrambles its grid the way Draco does. That is why lossless also means no reorder.
  - Lossless meshopt is exact for all four shapes, heights included. It still shrinks the download (terrain 461 → 265 KB), but not the vertex buffers.
  - The pre-Phase 1 worry, that the collider builder skips the node's translation, came from gltfpack's output and doesn't hold for gltf-transform's.

### DD7 — KTX2 textures load on the main thread, through `KTX2Loader`'s own workers

- `KTX2Loader` already transcodes in its own worker pool, so threading is preserved.
- `KTX2Loader.detectSupport(renderer)` needs the renderer, which the asset worker doesn't have.
- GLBs that carry `KHR_texture_basisu` textures need a KTX2 loader inside the asset worker's `GLTFLoader`. Phase 0 spikes passing the main thread's detected `workerConfig` (`astcSupported`, `bptcSupported`, `etc2Supported`, …) into the worker. If that fails, such GLBs load on the main thread.

### DD8 — Optimization is opt-out, at three levels

On by default, never required. An app that doesn't want it (no encoder, source files as they are) turns it off in one place.

1. **Project (build time)**: switches in `src/CONFIG.ts`, the app's one settings file:

   ```ts
   assets: {
     optimization: {
       enabled: true, // master switch
       textures: true, // KTX2 encoding
       meshes: true, // meshopt / Draco, quantize, simplify
     },
   },
   ```

   - Off means no encoding and no `ktx`. Every affected asset is **passed through**: its source is copied unchanged (content-hashed) into `aek-assets/`, and `__url` points to the copy. So the runtime has one resolution path either way, and relative-path sources (DD3) still reach the production build.
   - Packing (DD5) still runs: a `pack` texture has no single source file. Its output is written as PNG.
   - `gatherAppData` reads the switches by importing `src/CONFIG.ts`, which therefore must stay importable in Node. It is today: it imports only a type (checked 2026-10-04 with tsx). Keep it that way.
   - The env var `AEK_ASSETS_OPTIMIZE=false` overrides `enabled` for one run (eg. a quick CI build), like the `VITE_*` overrides in `Config.ts`.
   - Profiles and rules stay in `assets.config.json` (DD2): they are asset data, the switches are app settings.
   - Nothing to switch off at runtime: the decoders load only when a KTX2 or meshopt file is loaded (Phase 0).

2. **Per asset**: `"optimize": false` in the asset's JSON, or `{ "glob": "…", "optimize": false }` as a config rule, passes it through. A GLB can keep only one side as is: `"optimize": { "textures": false }` or `{ "mesh": false }`.

3. **Runtime A/B (dev / test only)**: a boot-time override in the Assets debug tab ("Load source files", in `AEK_debugAssetsBoot` like the worker targets) loads `__sourceUrl` instead of `__url`.
   - It works where sources are served: the dev server serves `src/` (the Vite root), so a relative-path source loads.
   - A production build ships no sources, so the override is ignored there, with a warning.
   - A packed texture has no source file and stays optimized (logged).

---

## 4. Configuration

`assets.config.json` (repo root):

```json
{
  "$schema": "./.schemas/assetsConfig.schema.json",
  "defaults": {
    "mesh": { "codec": "meshopt", "quantize": true, "simplify": null },
    "textures": {
      "default": {
        "codec": "uastc",
        "maxSize": 1024,
        "level": 2,
        "rdo": 2,
        "zstd": 18,
        "mipmaps": true
      },
      "normal": { "rdo": 1 },
      "orm": { "rdo": 1 },
      "metallicRoughness": { "rdo": 1 },
      "occlusion": { "rdo": 1 },
      "data": { "codec": "none" }
    }
  },
  "profiles": {
    "hero": { "textures": { "default": { "maxSize": 2048 } } },
    "prop": { "textures": { "default": { "maxSize": 1024 } } },
    "compact": {
      "textures": {
        "baseColor": { "codec": "etc1s", "quality": 255 },
        "emissive": { "codec": "etc1s", "quality": 255 }
      }
    },
    "terrainLayer": { "textures": { "data": { "codec": "uastc", "rdo": 1 } } },
    "terrainBlock": { "mesh": { "codec": "meshopt", "quantize": false } },
    "data": { "textures": { "default": { "codec": "none" } } }
  },
  "rules": [{ "glob": "src/public/debugger/assets/testModels/**/*.glb", "profile": "prop" }]
}
```

The profiles are Phase 1's results (1c–1e, see below):

- **UASTC everywhere by default, Zstd 18, `level` 2** (`--uastc-quality`). Phase 1 never tried level 4, which is several times slower to encode.
- **RDO λ 2 for colour, λ 1 for normal, ORM and data.** On screen, λ 0 and λ 2 differ by ≤ 0.8 dB in every region. Per texture, λ 2 costs the hard-edged ORM's roughness 13.5 dB and adds 1–2° to the normals' p99 angle error. λ 1 keeps most of that for a smaller saving (the table below). λ 4 loses 3 dB on screen.
  - `orm`, `metallicRoughness` and `occlusion` share settings on purpose: a glTF's ARM image is referenced by more than one slot (the Poly Haven toolbox's fills both roughness and metalness), so the classification can't make them disagree.
- **`normalMode` is in no profile.** A normal-mode texture needs the material to unpack it (1c), and the engine has no flag for that yet. It's not worth adding one either: with UASTC it gains 0.1–0.4 dB at the same VRAM, and with ETC1S on ETC2 devices it doubles the VRAM (RGBA ETC2 instead of RGB). The key stays in the schema.
- **`compact`** is ETC1S q255 for the colour slots only: a 2.5–4× smaller download than UASTC λ 2, and half the VRAM on ETC2 devices (mobile) for maps without alpha. On desktop (BC7) its VRAM is the same as UASTC's. ETC1S failed the visual bar where it was tried on every slot (terrain, the prop; 1e). Phase 1 never tried it on colour alone, so `compact` is for distant or background assets, and for mobile VRAM budgets.
- **`prop`** dropped the pre-Phase 1 `simplify: 0.6`: Phase 1 didn't test simplification, and p347 owns the LOD ratios.
- **`terrainLayer`** is the defaults plus UASTC for the `data` slot, which p303's LITE `normalHeight` uses (the `data` default is `none`).
- **`terrainBlock`** is the collider default (DD6). A collider source gets it without naming the profile.

Phase 1 results, headless WebGL2 (SwiftShader: ETC1S → ETC2, UASTC → ASTC 4×4; full table in 1e). Each slot holds the four 1K standalone textures and the prop's three 2K maps. VRAM is three's figure, with 1b's compressed sizes.

| Variant      | Download (textures + prop GLB) | VRAM    | PSNR vs PNG on screen | Verdict                       |
| ------------ | ------------------------------ | ------- | --------------------- | ----------------------------- |
| PNG / JPG    | 18.9 MB                        | 85.3 MB | —                     | baseline                      |
| `etc1s_q255` | 3.3 MB                         | 11.3 MB | 28.7 dB               | fails (near ground, the dial) |
| `uastc`      | 17.3 MB                        | 21.3 MB | 38.7 dB               | passes                        |
| `uastc_rdo2` | 13.9 MB                        | 21.3 MB | 38.4 dB               | passes, the pick              |

So UASTC + RDO cuts VRAM by 75% with no visible difference at screen resolution, and its download is a quarter smaller than the source's. Per texture (1c, size / error against the encoder input), the basis for the per-slot λ:

| Slot (texture)                  | Error measure        | λ 0                 | λ 1                 | λ 2                 | λ 4                 |
| ------------------------------- | -------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `baseColor` (toolbox diff, 2K)  | RGB PSNR             | 4354 KB, 47.4       | 3641 KB, 44.3       | 3095 KB, 40.9       | 2654 KB, 37.7       |
| `baseColor` (rocks01, 1K)       | RGB PSNR             | 1232 KB, 37.3       | 1230 KB, 37.2       | 1197 KB, 35.4       | 1055 KB, 30.2       |
| `normal` (toolbox, 2K)          | angle mean / p99 (°) | 3666 KB, 0.55 / 4.6 | 2457 KB, 0.93 / 5.4 | 2315 KB, 1.11 / 6.8 | 2173 KB, 1.40 / 9.5 |
| `normal` (MetalRust, 1K)        | angle mean / p99 (°) | 1190 KB, 1.90 / 5.0 | 1183 KB, 1.90 / 5.0 | 1114 KB, 1.97 / 5.9 | 976 KB, 2.78 / 15.0 |
| `orm` (toolbox ARM, 2K)         | roughness PSNR       | 4873 KB, 38.6       | 4775 KB, 38.2       | 4537 KB, 36.5       | 3992 KB, 32.8       |
| `orm` (MetalRust, 1K)           | roughness PSNR       | 975 KB, 49.9        | 793 KB, 41.6        | 594 KB, 36.4        | 478 KB, 33.9        |
| `data` (rocks01 `normalHeight`) | angle mean (°)       | 1275 KB, 3.76       | 1258 KB, 3.77       | 1248 KB, 3.89       | 1166 KB, 5.06       |

The device runs (1e, an M2 MacBook Air with WebGPU in Chrome and Safari) uploaded every texture in the same format and at the same VRAM as SwiftShader, and looked the same as the PNG on screen. Desktop BC7 (Windows), iOS and a weak device weren't measured (1e).

Per asset (in a `*.texture.json`):

```json
{
  "id": "sand01_albedoHeight",
  "fileName": "./source/sand01_albedoHeight.png",
  "optimize": { "profile": "terrainLayer", "slot": "baseColor" }
}
```

- **Resolution order:** `defaults` → rule (glob) → profile → the JSON's `optimize` overrides, deep-merged, later wins. Within each level, a texture slot's entry merges over that level's `textures.default`. So a profile's `default.maxSize` reaches every slot, and the defaults' `normal: { rdo: 1 }` changes only the λ. An `optimize: false` (rule or JSON) and the project switches in `src/CONFIG.ts` (DD8) win over all of it.
- **Slot keys:**
  - glTF slots: `baseColor`, `normal`, `metallicRoughness`, `occlusion`, `emissive`;
  - `orm` (packed occlusion/roughness/metalness);
  - `data` (splat maps, masks, LUTs, height);
  - `default`.
- A standalone texture names its slot. A GLB's embedded textures are classified by the material slot that references them.
- **Codec keys** apply only to their own codec: `level`, `rdo` and `zstd` to UASTC, `quality` to ETC1S. So `compact` inherits the defaults' `zstd` without breaking: `ktx` rejects Zstd with ETC1S (1c), so the encoder drops the key there.
- **Codec guidance:**
  - **UASTC** (with RDO + Zstd supercompression): the default for every slot. 1 B/px in VRAM on every device (BC7 or ASTC 4×4). Terrain layers are tiled many times across the screen, so artifacts repeat and show.
  - **ETC1S**: the smallest download. Its VRAM matches UASTC's on desktop (BC7) and is half on ETC2 devices, for maps without alpha. Visibly worse on terrain and detailed props (1e). Destroys normal maps (2–4× UASTC's angle error, up to 6° mean on MetalRust) and packed ORM. Colour slots only (`compact`).
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
  - `MeshColliderGeometry.ts` keeps refusing Draco and also refuses quantized positions (a normalized integer position attribute) for HEIGHTFIELD, with an actionable error ("set `optimize.mesh.quantize: false` for collider sources"). TRIMESH and the primitives already handle quantized positions, and CONVEXHULL will once it reads them through the getters (Phase 3 step 5).
- **Caching headers:** hashed file names can be served with long-lived cache headers. The dev server needs nothing.

---

## 7. Caching

Without a cache, a full encode pass slows builds enough that people skip it.

- **Cache key** = hash of:
  1. the source bytes (all sources, for packed textures);
  2. the resolved settings (post-merge, canonically serialized);
  3. the pipeline version plus the pinned `ktx` and gltf-transform versions.
- **The committed index** `assets.lock.json` (repo root, decided 2026-10-04, Phase 2 step 6) maps each key to its output URL and the result's metadata. A hit is the entry plus its file in `aek-assets/`, so a clone without `.cache/` or `ktx` uses the committed outputs (DD3, §8).
- When the output is missing (e.g. removed by the stale cleanup), it is copied back from `.cache/asset-pipeline/store/<key>` (gitignored) and nothing is encoded.
- On a miss, encode, write the output, then record it in the lock and the store.
- Stale outputs (hashes no longer referenced) are deleted from `src/public/aek-assets/` at the end of a full run, never during a watch-triggered single-asset run.

---

## 8. Tooling

- **gltf-transform JS API** (`@gltf-transform/core`, `/functions`, `/extensions`) for GLBs: meshopt, Draco, quantize, resize, per-slot KTX2 through `ktx`.
- **`ktx` CLI** (KTX-Software ≥ 4.3) for standalone textures and texture arrays (`ktx create --layers N`, used by p303 if runtime array assembly proves unworkable).
  - It's a native binary, not an npm package, but nobody installs it by hand: `yarn setupAssetTools` (`devTools/assetPipeline/ktxTool.ts`, Phase 1) downloads the pinned release into the gitignored `.tools/`. The pipeline calls `ensureKtx()` itself before its first encode (Phase 2), so the script is only the explicit way.
  - Without `ktx`, the pipeline still runs: cached and committed outputs are used, and assets that need encoding report "encoder missing" and fall back to their source file at runtime (dev only, warned).
- **`sharp`** for channel packing and resizing (DD5).
- **Alternative considered: gltfpack.** It's a single binary, `-tc`/`-cc`, but much coarser per-slot control and no standalone texture packing. It's the fallback if KTX-Software proves painful.
- **Commands:**
  - `yarn assets` runs the full pipeline.
  - `yarn assets --only <id|glob>` runs part of it.
  - `yarn gatherAppData` runs the cached pipeline first, so `dev`/`build` stay one command.

---

## 9. Phases

### Phase 0 — Runtime decoders (no build tooling yet) (~1 day) — done

1. `copyDecoders.ts` (Basis transcoder), `core/Import/KTX2.ts`, meshopt decoder wiring in `GLTFSource.ts`.
2. `.ktx2` route in `loadTextureAsync` (main thread, DD7).
3. Spike: GLB with `KHR_texture_basisu` in the asset worker, with the main thread's `workerConfig` passed in. Record the outcome in this plan.
4. Hand-encode two textures and one GLB (gltf-transform CLI or `gltf-optimizer.simondev.io`) and load them in `debugScene`.

**Exit:** hand-optimized assets load on WebGPU and on the WebGL2 fallback (`forceWebGL`), with the PNG orientation (flip check) and no console errors.

**Spike outcome (step 3):** works. The worker's own `KTX2Loader` takes the main thread's transcoder path and detected `workerConfig` (`KTX2WorkerSettings` in the LOAD_GLTF request) and starts its nested transcoder workers. Passing the config was not enough on its own: `TextureTransfer.ts` only carried `ImageBitmap`s, so it now also carries a `CompressedTexture`'s mip levels (transferred, rebuilt as a `CompressedTexture` on the main thread). Verified on WebGL2 (SwiftShader) with both the GLTF and texture worker targets on: no fallback.

**As built:**

- Verified headless on WebGL2 (main thread and worker targets, flip check against the sRGB PNG, `yarn build`) and by hand on WebGPU (WSL2's headless Chromium can't render WebGPU).
- Open: WebGPU logs "Calling [RenderPassEncoder (unlabeled)].Draw with a vertex count of 0 is unusual" in `testDebugScene`. A warning, not an error, and not traced to this phase: no visible root-scene object ever has 0 vertices there, and the phase adds no non-indexed draw, so it comes from a private scene or pass. three r186 skips only 0-instance draws, so any visible empty non-indexed geometry triggers it (eg. an empty thin line: created with `setDrawRange(0, 0)` and `frustumCulled: false` by default). Still to check: whether it also shows in other scenes or on `main`.
- Hand encoding used the native gltfpack 1.3 binary (`-c -tc`, `-tu normal`, `-tfy` for standalone textures). The npm `gltfpack` has no BasisU. gltfpack only reads glTF, so a standalone texture was wrapped in a one-triangle glTF and cut back out. The test files are in `src/public/debugger/assets/testOptimized/`; the test scene is `debugScene.scene.ts` (`testDebugScene`): the PNG/KTX2 texture pairs, then `box01Textured.glb` with its meshopt + KTX2 and quantized copies, and `box01.glb` with its meshopt copy.
- `KTX2.ts` imports `KTX2Loader` on first use (like the meshopt decoder, `MeshoptDecoder.ts`), so apps without KTX2 never download it. The worker imports both statically: the assets worker is an IIFE bundle and can't be code-split.
- The decoders are set per file from its `extensionsUsed` (`GLTFExtensions.ts`), read from the bytes before GLTFLoader parses.
- There's no renderer teardown hook, so the KTX2 loader isn't disposed on `deleteRenderer()`: `getKTX2Loader()` replaces it when the renderer has changed, and `disposeKTX2Loader()` is exported.
- `loadTexture` (sync) and `loadTextures` (batch) refuse `.ktx2` with an error pointing to `loadTextureAsync`: KTX2Loader has no synchronous placeholder.
- A KTX2 texture's colour space comes from its file (sRGB for colour slots). A PNG loaded without `texOpts.colorSpace` has none, so the two only match with the PNG set to sRGB.

### Phase 1 — Validate settings (~half a day) — done

1. Pick 3 representative assets: one terrain layer set (from p303's candidates), one prop GLB, and one problem case (a normal map, or an ORM with sharp channel edges).
2. Baseline: file size, `renderer.info.memory`, and a browser GPU memory capture.
3. A/B the visuals at on-screen resolution, not zoomed in, including a tiled terrain layer at grazing angles.
4. Test on the weakest target device, including iOS Safari.
5. Record the settings that worked as the first profiles.

**Exit:** a measured VRAM reduction with no visual regression anyone notices.

Found when Phase 1 started (2026-10-04), and the sections it was split into:

- **`renderer.info.memory` can't measure KTX2:** three r186 counts every compressed texture as 1 B (`Info.js` `_getTextureMemorySize`). A compressed texture's `mipmaps[i].data` is exactly what is uploaded, so the GPU memory tab can count it.
- **ETC1S saves no VRAM over UASTC on desktop:** without ETC2, KTX2Loader transcodes ETC1S to BC7 (priority 3, before BC1), 1 B/px like UASTC; ETC1S wins there on download only. On ETC2 devices (iOS, Android) ETC1S becomes ETC2 RGB at 0.5 B/px (without alpha). So `__vramBytes` (§5) depends on the device's format family.
- **iOS can't use the dev server:** it serves HTTP, and WebGPU and `SharedArrayBuffer` need a secure context (a LAN `http://` address isn't one). (Corrected in 1e: it already listens on every interface, and WSL2's mirrored networking needs no port forwarding.)
- **DD6's quantized collider test** was not in the step list; it is now (1c).
- WebGPU in r186 requests every adapter feature, so BC / ASTC / ETC2 are available to KTX2Loader.

Sections:

- **1a — Tooling — done.** `yarn setupAssetTools`, `sharp`, `@gltf-transform/cli`.
- **1b — Measuring — done.** Count compressed textures' real bytes in the GPU memory tab.
- **1c — Assets and encoding — done.** Terrain layer `rocks01` (ambientCG `Ground079S`, LITE), a CC0 Poly Haven prop GLB at 2K (with an ARM map), the Poliigon MetalRust set as the problem case (ORM with hard metal / rust edges, and its normal map), a quantized copy of `stairsStraightTrimesh.glb` for the collider test. Variants: ETC1S q128 / q255, UASTC without RDO, UASTC + RDO λ 1 / 2 / 4 (all Zstd 18), normal mode on / off. Downloaded sources go in a gitignored folder; the outputs are committed, like Phase 0's.
- **1d — Comparison scene — done.** A tiled ground plane at grazing angles (REPEAT, max anisotropy), the prop, the MetalRust ORM on a sphere; a scene-scoped debug tab that swaps variants in place (a key) and shows each one's file size and VRAM.
- **1e — Measurements — done.** File sizes, three's estimate, headless WebGL2 screenshots; a checklist for WebGPU on a real GPU, Chrome's GPU memory, the weak device and iOS (HTTPS on the LAN: `yarn dev:https`).
- **1f — Record — done.** The results table and profiles in §4, the collider outcome in DD6.

**1a as built:**

- `yarn setupAssetTools [--force]` (`devTools/setupAssetTools.ts`) → `ensureKtx()` in `devTools/assetPipeline/ktxTool.ts`. Lookup order: `AEK_KTX` (an error if it doesn't run), `.tools/ktx-4.4.2/bin/ktx`, `ktx` on PATH; ≥ 4.3 each. When none works, it downloads the pinned KTX-Software 4.4.2 asset from GitHub, checks it against the SHA-256 pinned in the script (Khronos publishes SHA-1s for some assets only, none for the macOS packages) and writes `bin/ktx` plus the one library it loads to `.tools/ktx-4.4.2/{bin,lib}/` (temp folder, swapped in after `ktx --version` runs).
- No install step on any platform: the binaries find their library through `$ORIGIN/../lib` (Linux RUNPATH) and `@executable_path/../lib` (macOS rpath). The Linux `.deb` (`ar` → `data.tar.gz`) and the macOS `.pkg` (`xar` → gzipped `cpio` Payloads) are unpacked by `devTools/assetPipeline/archives.ts` in plain Node: no `tar`, `bzip2` or `pkgutil`. The library is written as a real file under the name the binary loads (no symlinks, for Windows-mounted WSL2 drives).
- Platforms: Linux and WSL2 x64 / arm64 (glibc ≥ 2.34: Ubuntu 22.04+, Debian 12+, Fedora 35+; checked first, with a message), macOS arm64 / x64. Native Windows exits with "use WSL2". Verified: Linux x64 on WSL2 (installs in ~1 s, second run is a no-op, `ktx create` UASTC + Zstd encodes); the macOS arm64 / x64 and Linux arm64 archives unpack to the expected files (byte-identical to a reference unpack for macOS arm64). Not run on a Mac yet.
- No `postinstall`: only whoever encodes assets needs `ktx` (DD3), so `yarn install` stays download-free.
- `getKtxEnv(tool)` puts the found binary first on PATH for child processes: gltf-transform's CLI `uastc` / `etc1s` find it there (verified, with no system `ktx`).
- `@gltf-transform/cli` depends on `@donmccurdy/caporal`, which lists `@types/wrap-ansi@^8.0.1`; yarn 1 installs `8.1.0`, a deprecated stub with no typings. With an explicit `typeRoots` (ours), tsc fails on it (TS2688); with the default it skips it. `tsconfig.json` now lists `"types": ["node"]` (everything else was already imported explicitly). Upstream report: `docs/issues/gltf-transform-cli-types-wrap-ansi-stub.md`.

**1b as built:**

- Fixed at the source, not as a side estimate like the cube gap: `installCompressedTextureSizer` (`_dbg__GPUMemoryOwners.ts`) replaces `_getTextureMemorySize` on the renderer's `info` instance (`onRendererCreated`, before `init()`, next to the allocation tracker). A compressed texture is sized by `getCompressedTextureByteSize` (`_dbg__AssetStats.ts`): the sum of its levels' `data.byteLength`, per face for a `CompressedCubeTexture` (its `image` holds the faces), layers included for an array (KTX2Loader concatenates a level's layers). Everything else still goes to three's sizer.
- So `info.memory`, `info.memoryMap` and everything read from them count KTX2 at its real size with no other change: the totals, "By owner", untracked, snapshot diffs, the allocation tracker, peaks, the budget toast and the profiler Overview's GPU memory figure. three frees what `memoryMap` holds, so a destroy subtracts the same bytes. Only where the profiler loads (debug env, prodTest with the profiler on); nothing reads `info.memory` elsewhere.
- The bytes are the transcoded data, so they follow the device's format family (the Phase 1 finding on ETC1S): no per-format table to maintain. `getUncountedCubeBytes` now skips compressed cubes (counted in full).
- The Assets tab's info window (`getTextureByteSize`) shows the same figure for compressed textures instead of "—".
- Verified on WebGL2 (SwiftShader) in `testDebugScene`: every KTX2 texture's `memoryMap` entry equals its levels' bytes, where three's sizer gives 1; PNGs are unchanged. SwiftShader transcodes ETC1S to ETC2 RGB and UASTC to ASTC 4×4: `uvChecker` 1024² PNG 5.59 MB → ETC1S 699 KB (0.5 B/px + mips), `normal` UASTC 1024² 1.40 MB (1 B/px + mips; the PNG is 2048², 22.4 MB), the GLB's 256² maps 349 KB (PNG) → 44 KB (ETC1S) / 87 KB (UASTC normal). Not run: WebGPU (expected BC7 on desktop, 1 B/px for both codecs) and a compressed cube (no KTX2 cube asset yet; the per-face path is from KTX2Loader's code).

**1c as built:**

- `devTools/assetPipeline/phase1Variants.ts` (`npx tsx devTools/assetPipeline/phase1Variants.ts [--only rocks01|metalRust|metalToolbox|colliders] [--force]`; not a yarn script, Phase 2's pipeline replaces it) downloads, packs, encodes and measures everything below into `src/public/debugger/assets/testOptimized/phase1/<group>/`.
  - `report.json` lists every output: bytes, encode time, the `ktx create` options, estimated VRAM (RGBA8, BC7 / ASTC 4×4, ETC2) and the errors. It also records each source's provider and licence.
  - Downloads go to `.cache/p300-phase1/`; `.cache/` is now gitignored (§7).
  - A full run takes ~3.5 min; a second run skips the existing outputs (under 1 s).
  - `ktx` encodes are byte-reproducible: UASTC + RDO and ETC1S outputs rebuild to identical hashes.
- Packing and resizing run in plain JS on floats; sharp only reads and writes the files.
  - sRGB channels are linearized, then halved by a 2:1 box filter (normals renormalized).
  - The result is written as an 8-bit PNG: the uncompressed baseline (`<name>.png`, loaded with flipY). A flipped copy is the encoder input.
  - A 16-bit source needs `toColourspace('grey16' | 'rgb16')`, or sharp returns 8-bit sRGB.
- Dependencies: `@gltf-transform/core`, `/functions`, `/extensions` 4.5.1 and `meshoptimizer` 1.1.1 are now declared directly; before, they were only installed through the CLI. The ambientCG zip is unpacked with three's bundled `fflate`.
- Assets:
  - `rocks01`: ambientCG `Ground079S` 2K-JPG, packed as LITE at 1K. `albedoRough` is albedo × AO (strength 0.8, p303 D3's example) with roughness in A. `normalHeight` is the NormalGL XY plus the height remapped to 0..1.
  - `metalRust`: the Poliigon set already committed in `testTextures/` (no download), 2K → 1K. `orm` is packed from the AO / Roughness / Metallic maps; `normal` is also encoded with `--normal-mode`.
  - `metalToolbox`: Poly Haven `metal_toolbox` (CC0; one material, 14k triangles, painted metal with detailed 2K maps, ARM = glTF ORM). `source.glb` keeps its JPGs. Each codec gets one GLB: meshopt (`high`) geometry plus all three maps in that codec.
  - `colliders`: `stairsStraightTrimesh` (TRIMESH), `obstacles` (BOX + CONVEXHULL) and `terrainSmooth` (HEIGHTFIELD + TRIMESH), three copies each:
    - `_quantized`: `quantize()` only;
    - `_meshopt`: gltf-transform's `meshopt()`, which reorders, quantizes and filters;
    - `_meshoptLossless`: `EXT_meshopt_compression` alone, with no reorder, quantization or filters.
- Variants:
  - ETC1S q128 / q255; UASTC level 2 without RDO; UASTC + RDO λ 1 / 2 / 4.
  - Zstd 18 applies to UASTC only: ETC1S has its own BasisLZ supercompression, and `ktx` rejects Zstd there.
  - Mipmaps are generated by `ktx` (lanczos4); normal maps get `--normalize`.
- Errors are measured by the script, not by `ktx`. It transcodes each base level back to RGBA8 (`ktx extract --transcode rgba8`) and compares it with the encoder input: PSNR and max error per channel group, plus the angle error (mean / p99 / max) for normals. `ktx create --compare-psnr/-ssim` doesn't work for the normal-mode A/B: it compares the X/X/X/Y layout against XYZ.
- Findings for 1d–1f:
  - **Normal mode needs material support.**
    - Both codecs store two channels (ETC1S `RRR` + `GGG` slices, UASTC `RRRG`), and KTX2Loader transcodes them with alpha: X in RGB, Y in A.
    - three r186 has `NormalGAPacking` (`NormalMapNode.unpackNormalMode`), but sets an unpack mode on its own only for RG formats (`MaterialNode.js:240`). So a normal-mode texture used as a plain `normalMap` renders wrong.
    - 1d sets the material's `normalNode` itself. A profile can use `normalMode` only once the engine has a texture or material flag for it.
  - **gltf-transform's `toktx` drops RDO for any `*normal*` slot without a warning** (both codecs), and has no normal mode. So Phase 2 encodes a GLB's textures with its own `ktx create` call, as this script does: decode the embedded image, encode it, then `setImage` and `KHR_texture_basisu`.
  - **Quantization moves the dequantization into the collider node's own transform** (gltf-transform `transformMeshParents`, for a leaf node without animation). For example, the stairs go from translation `[-12, 1.55, 30.55]` to `[-12, 1.8, 32]` with scale 6, and the terrain HEIGHTFIELD gets +10.8 in Y with scale 50.
    - The body is placed at the node's position and the shape derivation applies the node's scale, so TRIMESH, BOX and HEIGHTFIELD should come out right. DD6's "translation not applied" was about gltfpack's output; it doesn't hold for gltf-transform's.
    - Two expected failures, to confirm in 1d. CONVEXHULL runs `applyMatrix4` on what would be a normalized Int16 attribute, then reads `position.array` raw (`MeshColliderGeometry.ts:68-74`). gltf-transform's `meshopt()` always reorders vertices, which scrambles a HEIGHTFIELD's grid the way Draco does.
    - A node with children or animation is handled differently: the mesh moves to a new unnamed child, which has no extras. None of the test models has one.
  - Download vs VRAM: the UASTC prop GLBs (8.9–13 MB) are bigger than the JPG source (9.9 MB); the ETC1S ones are 1.5–2.2 MB. RDO + Zstd barely shrinks normal maps (MetalRust normal 1190 → 976 KB at λ 4).
  - For p303's LITE packing:
    - UASTC keeps the noisy roughness alpha of `albedoRough` worse than ETC1S q255 does (33.8 vs 36.4 dB).
    - The packed `normalHeight` has twice the normal error of a plain normal map (UASTC 3.8° vs 1.9° mean).
- Outputs total 90 MB: rocks01 17, metalRust 17, metalToolbox 56 (43 of it the four UASTC GLBs), colliders 1.
  - Committed: the script, `report.json`, the PNG baselines, the standalone KTX2s and the collider copies (34 MB).
  - Gitignored: `metalToolbox/`, all seven prop GLBs. A clone rebuilds them with `--only metalToolbox` (~2 min; needs `ktx` and the Poly Haven download), so the 1d scene skips a missing variant with a message instead of failing.
  - The variants only matter until 1f picks the profiles. Then the losing ones are deleted, or the whole `phase1/` folder: `report.json` and this plan keep the numbers, and the script rebuilds any variant identically.

**1d as built:**

- The `assetCompare` scene (`src/app/assetCompare.ts`, `assetCompare.scene.json`, debug scene) with a scene tab, "Asset compare" (`src/app/_dbg__assetCompare.ts`). Its sky box (`skyboxes/assetCompare.skybox.json`) is DAY_SKY with the sun at 20° and no clouds: raking light for the normal maps, a sky for the metals to reflect.
- Two slots, A and B, each build the whole set at the same spots, one variant each (`png` = the uncompressed baselines and the toolbox's JPG `source.glb`). V (a scene key binding) or the tab switches which one is visible (`Object3D.visible`), so a switch is instant: both stay resident, and no shader is rebuilt. Changing a slot's variant rebuilds that slot only: its entities, materials and textures are deleted, and its prop import released.
  - The slot settings persist in `appDebugAssetCompare` (the tab's `persistKeys`). The scene creates the tab before it builds, so the builds read the saved settings.
- Ground: a 120 m plane, `rocks01` tiled every 2 m, REPEAT, the renderer's max anisotropy. The LITE material is TSL: colour from `albedoRough.rgb`, roughness from `.a`, and the normal from `normalHeight`'s XY with `NormalRGPacking` (Z reconstructed, height unused).
- Sphere: MetalRust with the committed base colour JPG (one texture, the same in every variant), the ORM in `aoNode` / `roughnessNode` / `metalnessNode`, and the normal map. A normal-mode variant gets `NormalGAPacking`, and it renders like the PNG (WebGL2).
- Prop: each variant's `metalToolbox` GLB, imported with its textures and given a STANDARD material from its slots. **The Poly Haven glTF has no `occlusionTexture`:** the ARM map fills `roughnessMap` and `metalnessMap` only, unlike 1c's note.
  - A GLB that isn't built is skipped with a message in the tab: the dev server answers a missing file with `200 text/html`, so the scene checks with a HEAD request.
- The tab lists each slot's textures: the VRAM three counts (`renderer.info.memoryMap`, with 1b's compressed sizes, "not drawn" until first drawn), the file size, the RGBA8 size, and the 1c errors (PSNR, normal angle) from `report.json`. Prop textures are matched to the report by kind: the importer names them after the glTF texture, the report after the image file.
- One camera only: every camera other than the active one shows its debug symbol, which stood in this view. For close-ups, use the debug camera (F1). In a fresh browser, the engine's own debug camera symbol still stands in the default view.
- The engine's `three/tsl` type shim (`_engine/types/three-node-material-helpers.d.ts`) types `texture` and `uv` loosely, and its nodes don't fit the material's node slots. The scene re-types the two with the real `Node` type (`sampleTexture`, `meshUv`).
- Smoke figures, WebGL2 on SwiftShader (ETC1S → ETC2, UASTC → ASTC 4×4), slot totals: `png` 85.3 MB (the four 1K textures at 5.33 MB each, the prop's three 2K maps at 21.3 MB each), `uastc` 21.3 MB, `etc1s_q128` 11.3 MB (683 KB per 1K ETC2 RGB texture, 1.33 MB for `albedoRough`, which has alpha). The real measurements are 1e's.
- **Collider check (DD6)**, the tab's "Run collider check". It imports the source and the three copies of each collider model, derives every collider with `deriveColliderFromGeometry` (as `spawnImportedAsset` does), and compares each one's world AABB (and a HEIGHTFIELD's heights) with the source's. Tolerance: 1 cm.

  | Collider                  | `quantized` | `meshopt`  | `meshoptLossless` |
  | ------------------------- | ----------- | ---------- | ----------------- |
  | TRIMESH (stairs, terrain) | ✓ ≤ 2.4 mm  | ✓ ≤ 2.4 mm | ✓ 0               |
  | BOX (obstacles)           | ✓ 0.2 mm    | ✓ 0.2 mm   | ✓ 0               |
  | CONVEXHULL (obstacles)    | ✗ 32.7 km   | ✗ 32.7 km  | ✓ 0               |
  | HEIGHTFIELD (terrain)     | ✗ throws    | ✗ throws   | ✓ 0 (heights too) |

  - CONVEXHULL fails as 1c expected: the raw Int16 values become the hull's vertices.
  - HEIGHTFIELD fails earlier than expected: `mergeVertices` throws on an `InterleavedBufferAttribute`. GLTFLoader loads a quantized position (Int16 vec3, 6 bytes padded to an 8-byte stride) as interleaved. So `spawnImportedAsset` would reject, not just build a wrong shape, and the meshopt reorder can't be checked behind it.
  - For 1f: a collider source takes meshopt without quantization (`meshoptLossless`), which is exact for all four shapes. §6's runtime refusal of quantized positions has to run before the HEIGHTFIELD and CONVEXHULL derivations.
  - Not p300's, found on the way: the source CONVEXHULLs already sit 57.8 mm off their meshes. The derivation centres the hull's vertices (`geoClone.center()`), but the body stays at the node's origin.

- Not run: WebGPU, and Chrome's GPU memory (1e's checklist).

**1e as built:**

- The plan was out of date on the dev server: `yarn dev` has passed `--host` since the first commit, so it was never localhost-only. This machine's WSL2 runs mirrored networking (`networkingMode=mirrored`), so the server is on the Windows host's own LAN address with no port forwarding. Only HTTP was in the way.
- **"Measure all variants"** (Asset compare tab, `measureAllVariants` in `_dbg__assetCompare.ts`) makes every device report the same thing.
  - It builds 13 runs in slot B: `png`, then each KTX2 variant with normal mode off and on. Each one stays shown until all its textures were drawn.
  - Per texture, it records the format three uploaded it as (eg. `RGBA_BPTC_Format`), three's VRAM figure (1b) and the file size. Per run: the build time (load, transcode, import) and the time to first draw. Per device: backend, adapter, user agent, DPR. Slot B and the shown slot are restored at the end.
  - "Copy results" puts the JSON on the clipboard. It's a separate button because Safari refuses the clipboard once the async run has lost the click's activation.
  - One file per device goes in `phase1/measurements/`. The first is `webgl2-swiftshader.json`.
- **`yarn dev:https`**: `AEK_DEV_HTTPS=true` adds `@vitejs/plugin-basic-ssl` (2.3.0, a self-signed certificate) on port 8443, so `yarn dev` is unchanged. Verified headless over the LAN address with the certificate warning bypassed: `isSecureContext`, `crossOriginIsolated` and `SharedArrayBuffer` all hold, and the boot shows no errors.
- **Headless WebGL2** (SwiftShader, 1280×720, the scene's grazing camera): SwiftShader transcodes ETC1S to ETC2 and UASTC to ASTC 4×4. VRAM is three's figure (all 7 textures of a slot). The four standalone textures are 1K; the prop's three are 2K. PSNR compares each screenshot with the `png` one, per region.

  | Variant      | Texture files | Prop GLB | VRAM    | PSNR frame | Near ground | Far ground | Sphere | Prop |
  | ------------ | ------------- | -------- | ------- | ---------- | ----------- | ---------- | ------ | ---- |
  | `png`        | 9.26 MB       | 9.65 MB  | 85.3 MB | —          | —           | —          | —      | —    |
  | `etc1s_q128` | 0.67 MB       | 1.50 MB  | 11.3 MB | 27.5       | 21.8        | 34.2       | 38.9   | 30.9 |
  | `etc1s_q255` | 1.13 MB       | 2.19 MB  | 11.3 MB | 28.7       | 22.9        | 35.7       | 40.2   | 32.1 |
  | `uastc`      | 4.56 MB       | 12.71 MB | 21.3 MB | 38.7       | 33.5        | 41.9       | 47.7   | 41.4 |
  | `uastc_rdo1` | 4.36 MB       | 10.74 MB | 21.3 MB | 38.7       | 33.5        | 41.9       | 47.6   | 41.1 |
  | `uastc_rdo2` | 4.06 MB       | 9.83 MB  | 21.3 MB | 38.4       | 33.2        | 41.8       | 47.1   | 40.6 |
  | `uastc_rdo4` | 3.59 MB       | 8.73 MB  | 21.3 MB | 35.5       | 30.2        | 39.9       | 45.0   | 38.1 |

  - **ETC1S fails the visual bar for terrain and props.** In a 2× crop, it smears the near ground's pebbles (flatter normals, blocky albedo) and softens the toolbox's dial. The UASTC variants can't be told from the PNG at this resolution; λ 4 is slightly softer.
  - **RDO λ 2 looks like the sweet spot:** −0.3 dB against λ 0 for an 11% smaller download (prop GLB 12.7 → 9.8 MB, about the JPG source's size at a quarter of its VRAM). λ 4 costs 3 dB more.
  - **Normal mode:** sphere +0.1–0.4 dB. On ETC2 devices it costs VRAM with ETC1S: the Y channel in alpha makes it `RGBA_ETC2_EAC`, 1 B/px instead of 0.5. With UASTC (ASTC 4×4, 1 B/px) it costs nothing.
  - **three's estimate:** 1c's `vramBytes` per format family equals three's measured bytes for every KTX2 texture (`albedoRough` and the ETC1S normal-mode files included, as RGBA ETC2). The PNGs differ by 1,397 B (three's mip rounding). So `__vramBytes` (§5) can use the same estimate.
  - The render is deterministic: regions with the same textures in two runs (eg. the ground in `uastc` and `uastc_nm`) match to 0.01 dB. Build times (0.1–0.5 s KTX2, 1.3 s `png`) are SwiftShader on localhost, a single run: not a performance figure.
  - Console: no errors, one deprecation warning from a dependency's init.
  - The screenshots and 2× crop strips are in `.cache/p300-phase1/screenshots/` (gitignored).
    - They were made by a throwaway Playwright script that isn't committed. It imports the dev server's modules in the page (`import('/app/assetCompare.ts')` gets the app's own module instances).
    - It hides every DOM element except the renderer's canvas, and every root-scene child except the slots' objects and the lights (the debug camera and light symbols stood in the view).

- **Checklist** (by hand; save each device's "Copy results" as `phase1/measurements/<device>.json`):

  1. **Desktop WebGPU, real GPU.**
     - Open `http://localhost:8080/?isDebug=true` in Windows Chrome: WSL2 forwards localhost, and localhost is a secure context.
     - Switch to "Asset compare" (P), then run "Measure all variants". Expected: `RGBA_BPTC` (BC7) for both codecs, 1 B/px, so ETC1S saves no VRAM there.
     - Then V between `png` and `uastc_rdo2`, and between `png` and `etc1s_q255`, full screen. Move the debug camera (F1) over the far ground to look for shimmer.
     - Note whether Phase 0's "Draw with a vertex count of 0" warning shows in this scene.
  2. **Chrome's GPU memory.** Chrome's Task Manager (Shift+Esc) has a "GPU memory" column on the GPU Process row.
     - Both slots stay resident, so set A = B = `png`, reload, enter the scene and note the figure. Then do the same with A = B = `uastc_rdo2`.
     - three's figures predict a difference of 2 × (85.3 − 21.3) = 128 MB.
  3. **The weak device** (§11 question 3 picks it). Run "Measure all variants": its build and first-draw times are the transcode cost. With the profiler (F8), compare frame times with `png` and with `uastc_rdo2` shown.
  4. **iOS Safari** (WebGPU needs iOS 26).
     - On the Windows host, as admin, allow inbound 8443 through the Hyper-V firewall, which mirrored mode uses: `New-NetFirewallHyperVRule -Name AekDevHttps -DisplayName "Aekasha dev HTTPS" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 8443 -Action Allow`.
     - Run `yarn dev:https`, then open `https://<host LAN IP>:8443/?isDebug=true` on the phone. Accept the certificate (Show Details → visit this website).
     - The drawer and the scene switch have on-screen buttons. Use the tab's "Toggle A / B" button in place of V.
     - Expected: ASTC 4×4 for UASTC and ETC2 for ETC1S (no BC on A-series GPUs), like SwiftShader. Also check that the KTX2 transcoder's workers and WASM load with the self-signed certificate.
     - Fallback if they don't: a tunnel with a real certificate (eg. `cloudflared tunnel --url https://localhost:8443 --no-tls-verify`). That needs the tunnel's host in Vite's `server.allowedHosts`, and it exposes the dev server publicly while it runs.

- **Device results** (2026-10-04): an M2 MacBook Air with WebGPU, in Chrome 139 and Safari 26.5, over `yarn dev:https` on the LAN (`measurements/webgpu-macbook-air-m2-{chrome,safari}.json`).
  - **Formats and VRAM:** identical to SwiftShader's in all 13 runs in both browsers. UASTC loads as ASTC 4×4 (1 B/px), and ETC1S as ETC2 RGB (0.5 B/px), or RGBA ETC2 with alpha or normal mode. So Apple GPUs get ETC1S's VRAM saving. Slot totals: `png` 85.3 MB, UASTC 21.3 MB, ETC1S 11.3 MB.
  - **Visuals:** checked full screen at DPR 2. Toggling showed no difference, in both browsers and, by eye, on the Windows PC. Only the near ground's pebbles change slightly up close, without looking worse.
    - A shimmer while the debug camera moves comes from the shadows (it stops with them off) and shows in every variant, so it isn't p300's.
  - **Load:** an ETC1S run builds in 0.13–0.27 s, the download and the transcode of all seven textures included. A UASTC run takes 0.5–0.9 s, mostly its 15–18 MB download over Wi-Fi. The first draw follows within ~30 ms, with one ~230 ms outlier per browser. No transcode stall.
  - **Frame time:** 16.7 ms with `png` and with `uastc_rdo2` shown (Chrome, the 60 Hz vsync cap), so no measurable difference.
  - **Chrome's GPU memory figure isn't usable on this Mac.** Its Task Manager tab row showed 124 MB with two `png` slots, which hold ~170 MB of textures by three's count, and the figure changed with the visible slot. three's figure, which equals 1c's estimate on all three backends, stays the VRAM measure.
  - **Console:** nothing from p300 (a favicon 404 and an unrelated Tweakpane error). Phase 0's "vertex count of 0" warning wasn't checked.
  - **Safari with Web Inspector open blocked the physics worker** ("Worker load was blocked by Cross-Origin-Embedder-Policy"), so the engine didn't start.
    - Cause: Vite's `server.headers` skips 304 responses, and Safari revalidates the worker script there.
    - Fix: `crossOriginIsolationPlugin` (`vite.config.ts`) sets COOP / COEP on every dev-server response and replaces `server.headers`. Verified with curl on a 304; not re-checked in Safari. A Project tooling change for `CHANGELOG.md`.
  - **Not run:**
    - Desktop BC7 (no Windows JSON). The claim that ETC1S saves no VRAM there rests on KTX2Loader's format priorities.
    - iOS.
    - The weak device. §11 question 3 now sets a temporary minimum target. Phase 1 ran only on an M2, well above it.

**1f as built:**

- Written from the headless data, then checked against the device runs (1e's "Device results"). They change no profile.
- §4: the example config is now the measured profiles, with the reasons and both results tables under it. Two rules the profiles rely on are new in §4, for Phase 2's resolver:
  - A slot's entry merges over its level's `textures.default`.
  - Codec keys apply only to their own codec.
- DD6: the measured collider outcome replaces the pre-Phase 1 reasoning. The risks table (§10) follows it.
- The per-slot λ (2 for colour, 1 for the rest) comes from 1c's per-texture errors. Phase 1 never rendered that mix as one variant, since every 1d variant uses one λ for all slots. On screen, the λ 1 and λ 2 runs differed by ≤ 0.5 dB in every region, so the mix sits between them.
- Lossless meshopt, for Phase 2: gltf-transform's `meshopt()` can't do it, because it always reorders and quantizes. 1c's script writes it as the `EXTMeshoptCompression` extension alone, with `EncoderMethod.QUANTIZE` (meaning "no filters": it doesn't quantize by itself) and no `reorder()` / `quantize()` transforms.
- Not changed, for p303's own review: its LITE estimate of "≈ 0.6–1.2 MB per map" is at the top of what `rocks01` measures with `terrainLayer` (`albedoRough` 1.17 MB at λ 2, `normalHeight` 1.23 MB at λ 1). Rocks are a noisy material, so smoother sets should come in lower.
- The variants stay until Phase 2's exit, which deletes them (or the whole `phase1/` folder). `ktx` encodes are byte-reproducible (1c), so Phase 2 can check that it reproduces Phase 1 by comparing its outputs with these files, eg. `orm_uastc_rdo1.ktx2` for the default `orm` slot.

### Phase 2 — Pipeline (~2–3 days)

1. Config schema plus resolver (DD2), compiled to `.schemas/`.
2. `optimize` (incl. `optimize: false`) and relative `fileName` in `textureSchema` / `importedAssetSchema`.
3. Opting out (DD8 levels 1–2): `AppConfig.assets.optimization` and `AEK_ASSETS_OPTIMIZE`, `optimize: false` in asset JSONs and rules, and the pass-through copy.
4. Packing step (DD5).
5. Texture encoder (`ktx`, through `ensureKtx()`) and GLB pipeline (gltf-transform).
6. Content-hash cache (§7).
7. Generated-data integration (§5), with `__sourceUrl` next to `__url`.
8. `yarn assets`.

**Exit:** Phase 1 results reproduced by one command (byte-identical to the `phase1/` variant files with the same settings; then delete those), and a second run is all cache hits. With `optimization.enabled: false`, a run needs no `ktx` and the app looks and loads as it did before p300.

**Step 1 as built:**

- Schemas in `src/_engine/schemas/assetsConfigSchema.ts`: `AssetsConfigSchema` (compiled to `.schemas/assetsConfig.schema.json` by `gatherAppData`) and `AssetOptimizeSchema`, the asset JSONs' `optimize` (wired into their schemas in step 2). Strict objects with descriptions, so a misspelt key is an error and the IDE explains each key.
- The resolver is `createSettingsResolver(config)` in `devTools/assetPipeline/settings.ts`; `loadAssetsConfig()` reads `assets.config.json` (a missing file is an empty config).
  - Its first level is `BUILTIN_DEFAULTS`, the §4 defaults. The config's `defaults` merges over it, so it's optional. The built-ins also fill in what §4 leaves out: `quality: 128` (ktx's default) and `normalMode: false`.
  - It returns every slot's settings (a GLB's textures are classified later), plus the standalone texture's `slot`, the `profile`, the matched rules and the pass-through reasons.
  - It prunes each slot to the keys its codec reads (`none` keeps only `maxSize`), so equal encodes hash equally (§7).
- Rules: `{ glob, optimize?: false, profile?, slot?, textures?, mesh? }`, all that match apply in order. The profile is the JSON's, else the last matching rule's; the same goes for `slot`. Globs are matched against the source path relative to the repo root by `devTools/assetPipeline/glob.ts` (`**`, `*`, `?`, `{a,b}`): Node 22's `path.matchesGlob` is still experimental and warns.
- **Rules apply only to assets that a JSON references.** DD2's "binaries that have no JSON" would get an output that nothing points to (no `__url`). So `assets.config.json` ships with `rules: []`, without §4's `testModels` rule (§11 question 4: leave them raw).
- The collider default (DD6, `mesh.quantize: false`) is applied after the profile, not at the defaults, so a profile can't quantize a collider source. Only the asset's own JSON can.
- Not yet: the project switches (DD8 level 1), which are step 3.

**Step 2 as built:**

- `optimize` is a key of the asset itself, not of its per-scene save entries: an encode is per source file. Each JSON type has its own variant (`assetsConfigSchema.ts`): `TextureOptimizeSchema` has no `mesh`, and `ImportedAssetOptimizeSchema` has no `slot`, because a GLB's textures are classified by their material slot.
- `fileName` (`AssetFileNameSchema`) can be relative to the JSON: `./` or `../`, nothing else, because a bare `rock.png` already means `path` + `rock.png` in `src/public`. `devTools/assetPipeline/sources.ts` resolves a `fileName` to one of three kinds, which later steps reuse:
  - `relative`: must exist, must stay inside `src/` (the Vite root, so DD8 level 3 can serve it), and can't be combined with `path`.
  - `public`: resolved the way the runtime's loaders do (`new URL((path || './') + fileName)` at the site root). A missing file is no error, as before.
  - `remote`: never optimized, so an `optimize` object on one is an error.
- `gatherAppData` checks each texture and imported asset JSON: its source, each scene's latest save entry that changes `fileName` / `path` (relative to the same JSON), and its `optimize` through the step 1 resolver, so an unknown profile fails the gather. An invalid `assets.config.json` fails it too. `__fileSize` now comes from the resolved source, relative ones included.
- The scene entries in the generated data drop `optimize`, because the runtime never reads it. The dev-only registries keep it, like `__sourcePath`.
- Scene-inline textures and a scene's `backgroundTexture` (`InlineTextureSchema`, `InlineTextureOverridesSchema`) take no `./` file name: the pipeline reads only `*.texture.json` / `*.importedAsset.json`. Inline imported assets are an unvalidated record, so they aren't checked.
- Zod reports a mistake inside `optimize` as the union's "Invalid input". The gatherer's `logValidationError` now shows the issues of the one branch that got past its type check (eg. `[optimize.textures.default]: Unrecognized key: "maxsize"`). This applies to every schema's unions.
- **A relative `fileName` doesn't load at runtime yet.** It reaches the generated data as written, and nothing resolves it until step 3's pass-through copy, step 7's `__url` and Phase 3 step 2. No asset uses one yet.
- Open for steps 5–7: a scene's save entry can point a texture at another file. That file needs its own output (and `__url`), with the asset's one `optimize`.
  - Decided (2026-10-04): it's optimized like the asset's own file, with the asset's `optimize`. The list of sources is what `checkAssetSources` already walks: the asset's file plus each scene's latest entry. Two scenes that share a file share one encode (the cache), and step 6's stale-output cleanup must count these files as in use.

**Step 3 as built:**

- **The project switches are build time only** (decided 2026-10-04). `AppConfig.assets.optimization` (`enabled`, `textures`, `meshes`, each default true) is in `src/CONFIG.ts`, with a doc comment saying the runtime never reads it.
  - `CONFIG.ts` now imports `AppConfig` with `import type`. It only worked in Node before because tsx and esbuild drop imports used only as types.
  - `CONFIG.ts` had no `assets` block yet. `loadConfig` merges the app config shallowly, so the new block replaces the engine's default `assets` object. Nothing changes: `initAssets` falls back to the same values (`DEFAULT_ASSETS_STATE`) for every key.
- `devTools/assetPipeline/switches.ts`:
  - `resolveProjectOptOut(optimization, env)` returns why each side is off (`{ textures?, mesh? }`).
  - `AEK_ASSETS_OPTIMIZE` (`true` / `false` / `1` / `0`; anything else throws, empty is ignored) overrides `enabled` only. `=true` on a project with `meshes: false` keeps the meshes off.
  - `loadProjectOptOut()` imports `CONFIG.ts` when it's called, for the command line (tsx).
  - **Not a static import from anything `vite.config.ts` loads:** that would make `CONFIG.ts` part of the Vite config, which restarts the dev server on every edit. Node 22 can't import `.ts` by itself, so Phase 3 step 1 loads it with `server.ssrLoadModule` and passes `assets.optimization` in. Phase 3 step 1 also re-runs the pipeline when `CONFIG.ts` changes.
- `createSettingsResolver(config, projectOptOut)` puts the project's reasons first, ahead of rules and the JSON. The gatherer's step 2 validation passes none (all on); the switches don't change what's valid.
- **Every pass-through reason names its side** (eg. `textures: false in the rule "…"`, `assets.optimization.meshes: false in src/CONFIG.ts`). A GLB with both sides off joins them with `; `.
- `devTools/assetPipeline/outputs.ts`:
  - `writeOutput` writes `src/public/aek-assets/<logical path>.<hash>.<ext>`. The hash is the first 8 hex digits of the content's SHA-256. The file is written once (an existing name has the same content), through a temp file and a rename.
  - The logical path is the source's path under `src/`, or under `src/public/` for a public source, without its extension (eg. `app/textures/source/rock`). It differs from §5's example, which drops the `source/` folder. This form is unique per source file, which a scene's save entry with its own file needs. A packed texture has no single source file, so step 4 gives it the JSON's path.
- `passThroughSource`:
  - A relative source is copied, because the production build doesn't ship `src/`.
  - A public source is already served, so its own URL is the output (no copy, no duplicate in `dist/`). Like the gatherer, it doesn't require the file to exist.
  - A relative `.gltf` with external buffers or images is refused, since a copy would lose them: export a `.glb`, or optimize it (gltf-transform reads the external files).
- `devTools/assetPipeline/pipeline.ts`, `processAsset(asset, resolveSettings)`, is the per-asset unit that steps 5–7 extend:
  - `skipped` for a remote file.
  - `passThrough` (with its reason and output) when the asset's side is off. A GLB passes through only when both sides are off; with one off it still goes through gltf-transform for the other.
  - An HDR texture source (`.hdr`, `.exr`) always passes through: UASTC and ETC1S are LDR formats.
  - Otherwise `pending`, until step 5's encoder.
- Verified with a scratch script on throwaway fixtures (removed): every switch and env combination, JSON / rule / project opt-outs, public and `path` sources, HDR, remote, GLB sides, and both `.gltf` kinds. The copy is byte-identical, its hash is the source's, and a second run doesn't rewrite it.

**Step 4 as built:**

- **The shape is p303 D3's sketch**, not a new one: `pack: { size?, channels: { <target>: … } }` in `*.texture.json` (`TexturePackSchema`, `assetsConfigSchema.ts`), in place of `fileName`. It is build time only, like `optimize`: not per scene, and dropped from the scene entries.
  - Targets: `r`, `g`, `b`, `a`, `rg`, `rgb`, `rgba`. Together they must cover r, rg, rgb or rgba, with no overlap (the schema's refinement names the gap or the clash). Two channels are written as RGB with B = 0, because a PNG's two-channel form is grey + alpha.
  - A target is a constant, or `{ src, channel?, colorSpace?, normal?, remap?, invert?, multiply? }`:
    - `src` is relative to the JSON, or a `src/public` URL path. It must exist; remote files aren't read.
    - `channel` defaults to the target's own letters. A greyscale image has its grey in r, g and b. Alpha from an image without alpha is an error, not a silent 1.
    - `colorSpace` defaults to sRGB for the colour channels of an sRGB texture (`texOpts.colorSpace: "srgb"`), else linear. Alpha is always linear. So p303's albedo needs no flag, and its AO and roughness stay linear.
    - `remap` is `[min, max]` or `auto` (the full range of the channels taken, Phase 1's height). Then `invert`, then `multiply`: a constant, or `{ src, channel = r, strength = 1 }` as `value × (1 + (factor − 1) × strength)` (Phase 1's AO into albedo).
- **Order of work** (`devTools/assetPipeline/pack.ts`), chosen to reproduce Phase 1 exactly:
  - Every channel is computed at the pack size (`size`, else the sources' common size; different sizes without `size` are an error) and then resized to the output size. So AO is multiplied and height remapped at source resolution, before downscaling.
  - A `normal: true` source is resized on its own, as unit vectors, straight to the output size, and its channels are taken from that. Packing it first would lose the Z the renormalization needs (LITE's `normalHeight` keeps X and Y only). It takes `invert` only.
- **The resize is in this step** (`devTools/assetPipeline/images.ts`), because the pack can't be built without it. Step 5 reuses it for single-file textures.
  - `getOutputSize` fits `maxSize` (never up) and rounds to multiples of 4 for a block-compressed codec (§4). It returns the aspect `stretch` for step 5's warning.
  - `resizeImage` does exact 2:1 box steps while both sides can halve (Phase 1's filter), then an area filter for any other ratio. Normals are renormalized at each step.
  - Images are read at their own bit depth. sRGB is decoded from the integer samples, as Phase 1 did. Output is an 8-bit PNG. sharp is imported on first use, so the gatherer (and through it the Vite config) doesn't load the native module.
- **Pass-through** (`processAsset`, now async): a pack is built at its pack size, unflipped (the runtime loads it like any PNG), and written as `aek-assets/<JSON path>.pack.<hash>.png`, eg. `app/textures/rock.pack.284666a2.png`. The `.pack` suffix keeps it apart from a source file next to the JSON with the same name. With optimization on, it's `pending` until step 5. Rules match a pack by its JSON's path, since it has no single source file.
- **Gatherer:** a pack can't be combined with `fileName`, `path` or `useHDRLoader`, and each source must exist. The `optimize` profile is resolved against the JSON's path.
- **Verified:**
  - Phase 1's three packed baselines were rebuilt from `pack` recipes at `maxSize` 1024 and compared with the committed `phase1/` PNGs: `rocks01/albedoRough`, `rocks01/normalHeight` and `metalRust/orm` are **pixel-identical** (0 differing samples). So step 5's encodes of them can be byte-identical.
  - Also checked with a scratch script and throwaway fixtures (removed): every schema error, alpha from a JPG, a constants-only pack, mixed sizes with and without `size`, odd output sizes, the area filter (mean kept, normals unit length within 1e-7), and the pass-through (written once, same URL on a second run; `optimize: false` and `AEK_ASSETS_OPTIMIZE=false` pass it through, all on is `pending`). The gatherer reports each invalid JSON with its reason.
- Not done here:
  - A **16-bit output**: packs are always written at 8 bits (DD5's "quantized once, at the end").
  - p303's cavity AO from height and `__averageColor`: they are p303's pack options, on top of this step.
- **A packed texture doesn't load at runtime yet**: it has no `fileName` until step 7's `__url`.

**Step 5 as built:**

- `processAsset` (`pipeline.ts`) now optimizes what it doesn't pass through. New statuses:
  - `optimized`: the output, the encoded `textures` (slot, codec, stored and source size, alpha, bytes; step 7 derives `__bytes` / `__vramBytes` from them), a GLB's `geometryBytes` before and after, and `warnings`.
  - `encoderMissing` (§8): the asset needs `ktx` and there is none. Nothing is written. A GLB with no texture to encode doesn't need `ktx`.
  - `skipped` also covers a missing public source (legacy, loaded as before). A `.ktx2` / `.basis` texture source passes through.
- **`ktx`** (`ktxEncode.ts`): `createKtxProvider()` runs `ensureKtx()` once per run, before the first encode, and keeps a failure (no setup retry per asset). An image is written as an 8-bit PNG to `.cache/asset-pipeline/tmp/` and encoded by `ktx create`.
  - The output depends only on the pixels and the options, not on the file names (checked). `ktx` records the options in the order given (`KTXwriterScParams`), so `getKtxCreateArgs` keeps Phase 1's order.
  - One channel is encoded as grey RGB and two as RGB with B = 0, like a pack's PNG. A grey source is RGB, a grey + alpha one RGBA (as a browser decodes them).
- **Standalone textures** (`textures.ts`): fit to `maxSize`, multiples of 4 for a block-compressed codec (with a warning when that changes the aspect ratio), resize as linear values, flip, encode.
  - sRGB comes from `texOpts.colorSpace`, not from the slot, so the KTX2 matches how the PNG path loads the same file.
  - The `normal` slot reads XYZ only, resizes as unit vectors and adds `--normalize` (Phase 1's `normal` kind).
  - `codec: "none"`: a file that needs no resize is kept as it is (public: its own URL; relative: copied, as in a pass-through). A resized one becomes an unflipped PNG.
- **GLBs** (`gltf.ts`, imported on first use): gltf-transform reads the source (`.gltf` with external files too), compresses the geometry, encodes the textures, and writes a `.glb`. Same order as Phase 1.
  - **Collider sources** are found by a node with a mesh and `colliderType` in its extras, what `CustomProps.ts` reads. The importedAsset JSON has no physics overrides, so a collider that only code adds (`ImportPhysicsParams`) isn't seen: such a source needs `"optimize": { "mesh": { "quantize": false } }`.
  - The collider default (`settings.ts`) now also sets `simplify: null`: simplification changes the shape and scrambles a HEIGHTFIELD's grid.
  - Geometry: meshopt quantized is `meshopt()`. Meshopt with `quantize: false` is lossless, `EXT_meshopt_compression` alone. Draco always quantizes, with a warning when `quantize: false`. `none` is `quantize()` or nothing. `simplify` runs `weld()` then `simplify()` with gltf-transform's error bound, which can stop well short of the ratio: `box01Textured` at 0.5 went from 1340 to 1290 triangles. Not checked visually; p347 owns LOD ratios.
  - Found while checking: a compressed source keeps its extension when read, so a Draco source re-encoded as meshopt came out compressed twice. The other codec's extension is now dropped. An already quantized source keeps its quantization, with a warning when the settings say `quantize: false`.
  - **Texture slots**: a normal map (core or extension) is `normal`; occlusion together with metallicRoughness is `orm`; one core slot is that slot; any other mix, an extension slot or an unused texture is `default`. sRGB for glTF's colour slots (core and extensions). Not flipped. A texture used both as colour and as data is encoded as colour, with a warning.
  - `KHR_texture_basisu` is set required when a texture became KTX2. `KHR_texture_basisu`, `EXT_texture_webp` and `_avif` are dropped when no texture of their format is left. An embedded `image/ktx2` is kept as it is (warning).
  - **Without `importTextures`, a GLB's textures are dropped**, not encoded. The runtime registers none of them then (`ImportRegistry.ts`), but GLTFLoader would still download and decode them. The materials stay (the importer discards them anyway), without their texture references. This doesn't need `ktx`, and it applies whatever the textures settings say (`textures: false` too). The `metalToolbox` source goes from 9.9 MB to 118 KB.
    - `processAsset` takes it as `PipelineAsset.importTextures`. Step 7 must set it for each source file: true when the JSON's `importTextures`, or a scene's latest entry that uses this file (its `fileName` or the JSON's) with its `importTextures` merged over the JSON's, turns it on.
    - A full pass-through (both sides off: `optimize: false`, a rule, the project switches) still keeps the file as it is, textures included: that's what opting out promises (DD8).
    - Code that imports the same file with `importTextures` (`importAssetAsync`) but without it in the JSON gets no textures: set it in the JSON.
  - gltf-transform's own warnings go into the asset's; its info lines are dropped.
- `draco3dgltf` 1.5.7 is now declared directly (it was only installed through `@gltf-transform/cli`). It has no typings: `devTools/assetPipeline/draco3dgltf.d.ts`.
- **§10's texcoord risk doesn't apply to gltf-transform.** Moving the UV dequantization into `KHR_texture_transform` is gltfpack's behaviour. gltf-transform 4.5.1's `quantize()` (inside `meshopt()`) quantizes a `TEXCOORD_n` only when it's inside [0, 1], as normalized Uint16 (12 bits), with no transform; tiling UVs stay float. The risk row is updated.
- **Verified** with scratch scripts (removed, as were their outputs):
  - **Byte-identical to Phase 1**, 17 files:
    - Packs: `rocks01` `albedoRough` (`terrainLayer`, `baseColor`: `_uastc_rdo2`; overrides: `_etc1s_q255`, `_uastc`), `normalHeight` (`terrainLayer`, `data`: `_uastc_rdo1`), `metalRust/orm` (`orm`: `_uastc_rdo1`; override: `_uastc_rdo4`).
    - The 2K MetalRust normal map, a single file (`normal`: `_uastc_rdo1`; overrides: `_nm_uastc_rdo1`, `_etc1s_q128`).
    - `metalToolbox/source.glb` with `hero` and one λ for every slot (`uastc_rdo2.glb`), and with ETC1S q255 (`etc1s_q255.glb`).
    - The three collider models: the detected default gives `_meshoptLossless`; `quantize: true` gives `_meshopt`.
  - The §4 profiles as they are reproduce `albedoRough_uastc_rdo2`, `normalHeight_uastc_rdo1`, `orm_uastc_rdo1` and `normal_uastc_rdo1`.
  - Edge cases: `none` with and without a resize; 1000×750 → 1000×752 with the warning (`none` keeps 1000×750); grey and grey + alpha; `ktx validate` passes on every KTX2; a `.ktx2` source; a missing public file; Draco on a collider (warning); a Draco source → meshopt; simplify; a collider with `simplify` from its JSON's profile (dropped); a GLB with textures `none` or `mesh: false`; an already quantized collider source (warning); `AEK_KTX` pointing nowhere (`encoderMissing` for textures, a texture-less GLB still optimized).
  - Encode times on this machine: 1–4 s per 1K texture, 30 s for the toolbox's three 2K UASTC maps, 10 s as ETC1S.
- The reproduction checks pass `importTextures: true` for the toolbox; without it, its output has no textures, needs no `ktx` (checked with `AEK_KTX` pointing nowhere) and keeps its one material.
- Not yet: the cache (step 6), so every call re-encodes; nothing calls `processAsset` yet (steps 7–8); the runtime doesn't load the outputs (Phase 3).

**Step 6 as built:**

- **The plan's cache alone couldn't serve a clone.** §7 put the cache only in the gitignored `.cache/`. An output's name hashes its _output_ bytes, so nothing linked a committed output to its inputs: a fresh clone would re-encode everything, or report `encoderMissing` without `ktx`, and §8's "committed outputs are used" had no mechanism. Decided (2026-10-04): a committed index, `assets.lock.json` at the repo root. §7 is updated. Outputs keep their content-hash names, so a version bump that doesn't change the bytes churns only the lock, not the committed binaries.
- `devTools/assetPipeline/cache.ts`:
  - **`getCacheKey`** (SHA-256 hex) hashes three things:
    - **The source bytes:** every file a pack reads, and a glTF's external buffers and images.
    - **The params,** serialized with sorted keys (`stableStringify`):
      - a standalone texture: its slot's settings only (a change to the `normal` defaults doesn't re-encode an albedo), plus `slot`, `isSrgb` and the pack recipe;
      - a GLB: `mesh` and `importTextures`, plus every slot's texture settings, which are `null` without `importTextures` because the textures are dropped then;
      - the output's logical path in both cases, so the key also decides the output's name.
    - **The versions:** `PIPELINE_VERSION` (bumped by hand when the pipeline's code changes what it writes) and the pinned tool versions per type. Textures key on `ktx` and sharp; GLBs also on gltf-transform, meshoptimizer and draco3dgltf. A gltf-transform update therefore doesn't re-encode the standalone textures.
  - **The `ktx` version is the pinned `KTX_VERSION`, not the installed one.** Probing the installed one would call `ensureKtx()` on a hit, and a clone without `ktx` would always miss. An encode by a different `ktx` (PATH, `AEK_KTX`) gets a warning, and its lock entry records `ktxVersion`.
  - **`createPipelineCache()`**, one per run: `get(key)` / `set(key, entry)` / `prune()` / `save()`.
    - **`get`** checks the lock entry and its file (exists, same size). If either is missing, it falls back to `.cache/asset-pipeline/store/<key>/` (the output plus `entry.json`). That covers a lock entry whose file is gone, and a key the lock doesn't have (e.g. encoded on another branch).
    - **`save`** writes the lock only when this run changed it. It merges over the file as it is at that moment, so two runs at once keep each other's entries.
    - **`prune`** is for a full run only (step 8): it drops the lock entries this run didn't look up. The store keeps them.
  - The store has no eviction: deleting `.cache/asset-pipeline/` is always safe.
- **`removeStaleOutputs(usedUrls)`** (`outputs.ts`) deletes the `aek-assets/` files no result points to, plus leftover temp files and empty folders. It is for the end of a full, successful run, together with `prune()`, never a watch run (step 8).
- **`processAsset`:**
  - Takes `opts.cache`; without one, nothing is cached.
  - Results get `cache: 'hit' | 'restored' | 'miss'` (`restored` means from the store), and every result gets `durationMs` (for §5's slowest-asset report).
  - Not cached: a plain pass-through copy (cheaper than hashing its source), `skipped` and `encoderMissing`. A packed texture that's passed through is cached.
  - A `codec: "none"` public file that is kept as it is gets a lock entry but no store copy: it's the source, not an output.
- **A GLB's collider default is found before encoding.** It's part of the key, and gltf-transform reads the file only on a miss. `gltfJson.ts` reads the glTF JSON (a .glb's first chunk) to find `colliderType` nodes and external files. `encodeGLTFAsset` now takes the resolved settings, so the key and the encode can't disagree. `passThroughSource` reuses the same reader.
- **Verified** with a scratch script, using its own lock and store (removed, with its outputs):
  - **Cold run, byte-identical to `phase1/`:**
    - `metalRust` `orm` (pack) and `normal`;
    - `rocks01` `albedoRough` and `normalHeight` (packs, `terrainLayer`);
    - `stairsStraightTrimesh` (`_meshoptLossless`);
    - the toolbox `uastc_rdo2.glb` (`hero`, one λ).
    - Also a pack that's passed through, and a `none` public file.
  - **Warm run, `AEK_KTX` pointing nowhere:** 8 / 8 hits, the lock not rewritten. The toolbox went from 30.6 s to 20 ms.
  - **Restores:** two outputs deleted → `restored`, identical. The lock deleted, then two runs started at once on different assets → both `restored`, and the merged lock has all four entries.
  - **A changed setting** (`orm` λ 4): `encoderMissing` without `ktx`; with it, a miss whose output is identical to `orm_uastc_rdo4.ktx2`.
  - **Prune:** a run of two assets with `prune()` + `removeStaleOutputs` leaves a two-entry lock and two files. The next full run restores the other six from the store, except the `none` public file, which has no store copy: it's a cheap miss that needs no `ktx`.
- Not yet: nothing calls `processAsset` with a cache, and no `assets.lock.json` is committed (steps 7–8).

**Step 7 as built:**

- **The gatherer takes a run's results, it doesn't run the pipeline.** `gatherSceneData` is synchronous and the Vite plugin calls it on every save, while `processAsset` is async. Running the pipeline from the gatherer is Phase 3 step 1, which also brings the project switches in through `ssrLoadModule` (step 3). So `gatherSceneData({ pipeline })` takes a finished `PipelineRun`; without one (`yarn gatherAppData`, the plugin, until Phase 3 step 1) the generated data is as before. Its callers are step 8's `yarn assets` and Phase 3 step 1.
- `devTools/assetPipeline/assets.ts`:
  - `readAssetJsons()` reads every `*.texture.json` / `*.importedAsset.json` under `src/` and skips invalid ones (the gatherer reports those).
  - `collectPipelineAssets()` lists one `PipelineAsset` per encode. It covers each JSON's own data and each scene's latest save entry merged over it, shallowly, as the gatherer merges a scene entry (an entry's `texOpts` replaces the JSON's).
  - `getPipelineAssetKey()` is computed the same way by the run and by the gatherer: type, JSON, source (or `pack`), and for a texture its colour space. So a scene that only switches a texture to sRGB gets its own encode. A GLB's `importTextures` isn't part of the key: every use of a file shares one output, kept with its textures when any use imports them (step 5).
- `devTools/assetPipeline/run.ts`, `runPipeline(assets, { resolveSettings, cache?, getKtx?, onResult? })`: one asset at a time (`ktx` and sharp use every core for one encode), one `ktx` setup for the run. A throw becomes an `error` result, so the run goes on. The caller owns the cache: it saves the lock, and only a full run prunes it (step 8).
- `devTools/assetPipeline/generated.ts`, `getGeneratedFields()`. The keys are in `GeneratedAssetFieldsSchema` (`assetsConfigSchema.ts`), which is spread into `TextureAssetSchema` (`__codec` included) and `ImportedAssetSchema` (without it). Inline scene textures don't get the keys: the pipeline never sees them.
  - `optimized`: `__url`, `__sourceUrl`, `__bytes`, `__vramBytes`, `__codec` (standalone textures only; a GLB mixes codecs).
  - `passThrough`: `__url`, `__sourceUrl`, `__bytes`. No VRAM figure: the image isn't read.
  - `encoderMissing`, `skipped` and `error`: only `__sourceUrl`, so Phase 3 step 2 can fall back to the source in dev (§8).
  - `__sourceUrl` is the source as the dev server serves it: `/app/…` for a relative source, its own URL for a public one. A pack has none. It's left out of production data, which ships no relative sources (DD8 level 3).
  - `__bytes.in` counts every file the runtime would download without the pipeline: all of a pack's sources, and a glTF's external files (`getSourceBytes`, `pipeline.ts`).
  - `__vramBytes` uses Phase 1's estimate, which equals three's figure (1e). `in` is the source as RGBA8 with mips. `out` is RGBA8 with mips for `none`, and 1 B/px for KTX2 (the most it takes on any device, which is also Phase 4's budget figure). ETC1S without alpha takes half that on an ETC2 device. A GLB's figure is its textures (none when they were dropped) plus its geometry, so a lossless collider shows `in` = `out`.
- The gatherer writes the keys into the dev registries (the JSON's own data) and into each scene entry. A scene entry drops what it spread from the registry and gets its own file's keys. `__fileSize` stays as it is: the debug Assets tab reads it.
- **Verified** with throwaway fixtures and a scratch script (removed, with their outputs and a scratch lock):
  - **Cold run:** 8 encodes. The fixtures were a normal map, a colour texture with a scene that switches it to sRGB, a pack with `optimize: false`, a collider GLB, a textured GLB whose scene alone sets `importTextures`, plus the app's own `testTexture` and `testImport`.
    - The normal map is byte-identical to `phase1/metalRust/normal_uastc_rdo1.ktx2`, and the collider to `stairsStraightTrimesh_meshoptLossless.glb`.
    - The sRGB scene entry gets its own output. The GLB keeps its textures (VRAM in 1.09 MB → out 0.30 MB).
  - **Warm run with `AEK_KTX` pointing nowhere:** 8 / 8 hits, the lock not rewritten, and the generated data byte-identical to the cold run's.
  - **Production gather:** no `__sourceUrl`.
  - **Cold run without `ktx`:** the textures and the textured GLB get `__sourceUrl` only. The texture-less GLBs and the pack are still written.
  - **No run** (`yarn gatherAppData`): `generatedAppData.json` is unchanged.
- **For step 8:** with the defaults, the app's two asset JSONs (`testTexture`, the 2K MetalRust base colour JPG, and `testImport`, `box01.glb`) are optimized: a 1K UASTC KTX2 and a meshopt GLB. Once Phase 3 step 2 resolves `__url`, the scenes that use them load those. §11 question 4 leaves the debugger test assets raw, but that answer was about the test models without a JSON. These two have JSONs, so they need an `optimize: false` (or a rule) to stay raw. Decided (2026-10-04): leave them as they are for now, so they're optimized.
- Not done here: §5's stats summary (`last-run.json`, totals, cache hit rate, slowest assets). It reports on a run of the command, so it's step 8's.

### Phase 3 — Integrate (~1 day)

1. `gatherAppData` runs the cached pipeline, and the gatherer plugin re-encodes a changed source.
2. The runtime resolves `__url`.
3. The "Load source files" boot-time override in the Assets debug tab (DD8 level 3).
4. Wire into `yarn build`.
5. Colliders from quantized geometry (`core/Import/MeshColliderGeometry.ts`, found in 1d):
   - CONVEXHULL: read the positions through the attribute getters into a `Float32Array`, as TRIMESH does, instead of `applyMatrix4` and the raw `position.array`. That makes quantized and interleaved positions safe.
   - HEIGHTFIELD: refuse a quantized position attribute (§6) before `mergeVertices`, which throws on an `InterleavedBufferAttribute`. Draco keeps its own refusal.
   - Check: 1d's collider check passes CONVEXHULL `quantized` / `meshopt`, and reports HEIGHTFIELD `quantized` / `meshopt` as refused (a clear error, nothing thrown).

### Phase 4 — Harden

1. Budgets: fail the build if an asset exceeds a size or VRAM threshold set per profile.
2. A missing or too-old `ktx` gives a clear error and a working fallback (§8).
3. Write the docs: a section in `readme.md`'s asset section, plus `docs/techniques/asset-optimization.md` (how to add an asset and pick a profile, how to opt out (DD8); codec cheat sheet). `AppConfig.assets.optimization` also goes into `readme.md`'s `AppConfig` example if it lists `assets`.
4. Versioning: an engine minor bump (new runtime decoders and schema keys), plus Project tooling in `CHANGELOG.md`.

---

## 10. Risks and gotchas

| Risk                                                                                                                | Mitigation                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ETC1S ruins normal / ORM maps (and softens terrain and detailed props, 1e)                                          | UASTC is the default for every slot; ETC1S only through `compact`, for colour slots                                                                                                                   |
| Quantized positions break CONVEXHULL and HEIGHTFIELD colliders (1d); a meshopt reorder scrambles a HEIGHTFIELD grid | Collider sources get lossless meshopt (DD6, `terrainBlock` profile); CONVEXHULL reads quantized positions through the getters, and HEIGHTFIELD refuses them with an actionable error (Phase 3 step 5) |
| Quantized UVs (gltfpack moves their dequantization into `KHR_texture_transform`, and glTF materials are discarded)  | Not with gltf-transform (step 5): it quantizes only UVs inside [0, 1], as normalized integers with no transform, and keeps tiling UVs float. Precision is 1/4096 (12 bits), half a texel at 2K        |
| `flipY` can't apply to compressed textures                                                                          | Encode flipped; Phase 0 visual check against the PNG path                                                                                                                                             |
| `KTX2Loader` support detection in the asset worker                                                                  | Main-thread fallback (DD7), Phase 0 spike                                                                                                                                                             |
| Transcode stalls on load                                                                                            | `KTX2Loader` already uses its own workers; measure on a min-spec device; stagger big batches                                                                                                          |
| KTX-Software missing or old                                                                                         | Committed outputs plus source fallback in dev; clear error; pinned version                                                                                                                            |
| Encode times grow                                                                                                   | Content-hash cache; slowest-asset report                                                                                                                                                              |
| Compressed textures can't be read back on the CPU                                                                   | `codec: "none"` per slot; CPU-side data (e.g. height for colliders) comes from geometry, never from textures                                                                                          |
| Asset licensing                                                                                                     | The pipeline doesn't change licenses; terrain sources record theirs in `source.json` (p303)                                                                                                           |

---

## 11. Open questions

1. **Commit outputs or build in CI?** Decided (2026-10-04): commit (DD3).
2. **User-uploaded models?** Would need a client-side encode path for that flow. Not planned.
3. **Minimum target device?** Decided (2026-10-04), as a temporary, general target until p240 (device capability sniffer) can measure devices: the oldest devices that run WebGPU, from about 2020.
   - **Phones:**
     - iPhone 11 (A13, 4 GB): the oldest that runs iOS 26, which Safari's WebGPU needs.
     - An Android mid-range phone of the same age: Adreno 6xx or Mali-G7x, 4 GB, Android 12+, where Chrome has WebGPU.
     - Both read ASTC and ETC2.
   - **Desktop and laptop:** integrated graphics, Intel UHD 620 / Iris Xe class, with 8 GB of RAM. They read BC (BC7 included).
   - **Formats:** every profile's codec has a compressed path on all of these. UASTC loads as ASTC or BC7, and ETC1S as ETC2 or BC7, so nothing falls back to uncompressed RGBA.
   - **Quality bar:** Phase 1's. A variant has to look like the source at screen resolution (1d's toggle).
   - **Budgets for Phase 4, as starting values:**
     - A scene's GPU memory, by three's figure (the profiler's GPU memory tab), stays ≤ 512 MB: the tab's default budget, so the two agree. Textures get ≤ 256 MB of it.
     - Per texture: its profile's `maxSize` at its codec's rate plus mips. That is 1 B/px for UASTC and ETC1S (1K 1.4 MB, 2K 5.6 MB) and 4 B/px for `none` (1K 5.6 MB). A texture over its figure has a size or codec that slipped past its profile.
     - Per GLB, textures plus geometry: `prop` ≤ 8 MB (three 1K maps are 4.2 MB), `hero` ≤ 24 MB (three 2K maps are 16.8 MB).
   - **Still to check:** "Measure all variants" (1d) on an iPhone 11 or Android device of this class, when one is at hand. That replaces the M2 as the transcode-time and frame-time reference.
4. **Should the 287 MB of debugger test assets be optimized and re-pointed, or left as raw test inputs?** They are useful as "raw import" tests. Suggested: leave them as is, and add optimized copies only where a test needs one.
