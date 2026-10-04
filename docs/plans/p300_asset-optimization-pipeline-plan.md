Status: in progress | Phase 0 implemented
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
- **Collider sources** (anything with `colliderType` custom props) default to `mesh.quantize: false`. With `KHR_mesh_quantization`, positions become integers and the dequantization moves into the node transform (gltfpack writes eg. `translation: [-0.5, -0.5, -0.5]`, `scale: 6.1e-5`). The attribute getters de-normalize, and the collider builder applies the node's scale but not its translation, so TRIMESH/HEIGHTFIELD shapes would be offset. Meshopt without quantization is lossless and safe. Phase 1 tests a quantized collider source rather than assuming. See risks.

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

- **Resolution order:** `defaults` → rule (glob) → profile → the JSON's `optimize` overrides, deep-merged, later wins. An `optimize: false` (rule or JSON) and the project switches in `src/CONFIG.ts` (DD8) win over all of it.
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

### Phase 1 — Validate settings (~half a day)

1. Pick 3 representative assets: one terrain layer set (from p303's candidates), one prop GLB, and one problem case (a normal map, or an ORM with sharp channel edges).
2. Baseline: file size, `renderer.info.memory`, and a browser GPU memory capture.
3. A/B the visuals at on-screen resolution, not zoomed in, including a tiled terrain layer at grazing angles.
4. Test on the weakest target device, including iOS Safari.
5. Record the settings that worked as the first profiles.

**Exit:** a measured VRAM reduction with no visual regression anyone notices.

Found when Phase 1 started (2026-10-04), and the sections it was split into:

- **`renderer.info.memory` can't measure KTX2:** three r186 counts every compressed texture as 1 B (`Info.js` `_getTextureMemorySize`). A compressed texture's `mipmaps[i].data` is exactly what is uploaded, so the GPU memory tab can count it.
- **ETC1S saves no VRAM over UASTC on desktop:** without ETC2, KTX2Loader transcodes ETC1S to BC7 (priority 3, before BC1), 1 B/px like UASTC; ETC1S wins there on download only. On ETC2 devices (iOS, Android) ETC1S becomes ETC2 RGB at 0.5 B/px (without alpha). So `__vramBytes` (§5) depends on the device's format family.
- **iOS can't reach the dev server:** it listens on localhost over HTTP, and WebGPU and `SharedArrayBuffer` need a secure context (a LAN `http://` address isn't one); WSL2's NAT adds a hop.
- **DD6's quantized collider test** was not in the step list; it is now (1c).
- WebGPU in r186 requests every adapter feature, so BC / ASTC / ETC2 are available to KTX2Loader.

Sections:

- **1a — Tooling — done.** `yarn setupAssetTools`, `sharp`, `@gltf-transform/cli`.
- **1b — Measuring — done.** Count compressed textures' real bytes in the GPU memory tab.
- **1c — Assets and encoding — done.** Terrain layer `rocks01` (ambientCG `Ground079S`, LITE), a CC0 Poly Haven prop GLB at 2K (with an ARM map), the Poliigon MetalRust set as the problem case (ORM with hard metal / rust edges, and its normal map), a quantized copy of `stairsStraightTrimesh.glb` for the collider test. Variants: ETC1S q128 / q255, UASTC without RDO, UASTC + RDO λ 1 / 2 / 4 (all Zstd 18), normal mode on / off. Downloaded sources go in a gitignored folder; the outputs are committed, like Phase 0's.
- **1d — Comparison scene.** A tiled ground plane at grazing angles (REPEAT, max anisotropy), the prop, the MetalRust ORM on a sphere; a scene-scoped debug tab that swaps variants in place (a key) and shows each one's file size and VRAM.
- **1e — Measurements.** File sizes, three's estimate, headless WebGL2 screenshots; a checklist for WebGPU on a real GPU, Chrome's GPU memory, the weak device and iOS (HTTPS on the LAN: a `--host` run with `@vitejs/plugin-basic-ssl` and WSL port forwarding, or a tunnel).
- **1f — Record.** The results table and profiles in §4, the collider outcome in DD6.

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

### Phase 2 — Pipeline (~2–3 days)

1. Config schema plus resolver (DD2), compiled to `.schemas/`.
2. `optimize` (incl. `optimize: false`) and relative `fileName` in `textureSchema` / `importedAssetSchema`.
3. Opting out (DD8 levels 1–2): `AppConfig.assets.optimization` and `AEK_ASSETS_OPTIMIZE`, `optimize: false` in asset JSONs and rules, and the pass-through copy.
4. Packing step (DD5).
5. Texture encoder (`ktx`, through `ensureKtx()`) and GLB pipeline (gltf-transform).
6. Content-hash cache (§7).
7. Generated-data integration (§5), with `__sourceUrl` next to `__url`.
8. `yarn assets`.

**Exit:** Phase 1 results reproduced by one command, and a second run is all cache hits. With `optimization.enabled: false`, a run needs no `ktx` and the app looks and loads as it did before p300.

### Phase 3 — Integrate (~1 day)

1. `gatherAppData` runs the cached pipeline, and the gatherer plugin re-encodes a changed source.
2. The runtime resolves `__url`.
3. The "Load source files" boot-time override in the Assets debug tab (DD8 level 3).
4. Wire into `yarn build`.

### Phase 4 — Harden

1. Budgets: fail the build if an asset exceeds a size or VRAM threshold set per profile.
2. A missing or too-old `ktx` gives a clear error and a working fallback (§8).
3. Write the docs: a section in `readme.md`'s asset section, plus `docs/techniques/asset-optimization.md` (how to add an asset and pick a profile, how to opt out (DD8); codec cheat sheet). `AppConfig.assets.optimization` also goes into `readme.md`'s `AppConfig` example if it lists `assets`.
4. Versioning: an engine minor bump (new runtime decoders and schema keys), plus Project tooling in `CHANGELOG.md`.

---

## 10. Risks and gotchas

| Risk                                                                                                                          | Mitigation                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ETC1S ruins normal / ORM maps                                                                                                 | Per-slot codecs; UASTC is the default for those slots and for terrain layers                                                                                                                                                       |
| Quantized positions break colliders (the dequantization offset is in the node transform)                                      | `quantize: false` for collider sources (`terrainBlock` profile); the runtime refuses quantized collider geometry with an actionable error                                                                                          |
| Quantized UVs: the UV dequantization moves into the glTF material's `KHR_texture_transform`, and glTF materials are discarded | Imported textures carry it (`offset`/`repeat`), so the glTF's own maps are right; any other texture on that geometry samples the wrong UVs. Don't quantize texcoords by default, or bake the transform back into the UVs at import |
| `flipY` can't apply to compressed textures                                                                                    | Encode flipped; Phase 0 visual check against the PNG path                                                                                                                                                                          |
| `KTX2Loader` support detection in the asset worker                                                                            | Main-thread fallback (DD7), Phase 0 spike                                                                                                                                                                                          |
| Transcode stalls on load                                                                                                      | `KTX2Loader` already uses its own workers; measure on a min-spec device; stagger big batches                                                                                                                                       |
| KTX-Software missing or old                                                                                                   | Committed outputs plus source fallback in dev; clear error; pinned version                                                                                                                                                         |
| Encode times grow                                                                                                             | Content-hash cache; slowest-asset report                                                                                                                                                                                           |
| Compressed textures can't be read back on the CPU                                                                             | `codec: "none"` per slot; CPU-side data (e.g. height for colliders) comes from geometry, never from textures                                                                                                                       |
| Asset licensing                                                                                                               | The pipeline doesn't change licenses; terrain sources record theirs in `source.json` (p303)                                                                                                                                        |

---

## 11. Open questions

1. **Commit outputs or build in CI?** Recommended: commit (DD3). Confirm before Phase 2.
2. **User-uploaded models?** Would need a client-side encode path for that flow. Not planned.
3. **Minimum target device?** Sets the quality bar and the VRAM budgets (Phase 4). p240 (device capability sniffer) would make this measurable.
4. **Should the 287 MB of debugger test assets be optimized and re-pointed, or left as raw test inputs?** They are useful as "raw import" tests. Suggested: leave them as is, and add optimized copies only where a test needs one.
