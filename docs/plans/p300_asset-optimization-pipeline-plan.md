Status: draft | not-implemented
Category: Assets

# glTF Asset Optimization Pipeline — Plan

A manifest-driven, build-time pipeline that converts source GLB/glTF assets into GPU-compressed, runtime-ready assets (KTX2 textures + compressed mesh data).

---

## 1. Goal

Reduce both **download size** and **GPU memory** for 3D assets, with per-asset control expressed as data (a JSON manifest) rather than ad-hoc manual runs of a web tool.

Target outcome, based on published figures for this class of optimization:

|                                               | File size | VRAM   |
| --------------------------------------------- | --------- | ------ |
| Raw export                                    | 39 MB     | 342 MB |
| Size-only optimization (typical online tools) | 4.26 MB   | 22 MB  |
| KTX2 + mesh compression                       | 0.68 MB   | 6 MB   |

The VRAM column is the part that ordinary "compress my GLB" tools miss. PNG/JPEG/WebP textures are fully decoded to raw RGBA in VRAM — a 2048×2048 texture costs ~16 MB regardless of file size, plus ~33% for mipmaps. KTX2/Basis textures stay block-compressed on the GPU, transcoded at load into whatever format the device supports (BC7, ASTC, ETC2).

---

## 2. Key decision: build-time, not load-time

Encoding runs **at build time only**. Reasons:

- Basis/KTX2 **encoding** is orders of magnitude slower than **transcoding**. Encoding is seconds-to-minutes per texture; transcoding (what the client does at load) is milliseconds. They are different operations.
- Encoding at load would require shipping the uncompressed source asset to the client, throwing away the entire download win and keeping only the VRAM win.
- The encoder is a large WASM payload that would ship to every user.

**Exception:** if end users ever upload their own models and there is no build step to hook into, a client-side encode path becomes necessary. Out of scope for now; noted in Open Questions.

**Dev ergonomics:** a watch mode that re-encodes changed assets on save gives most of the convenience of "on every load" without any of the cost. Same code path as the build, just triggered by a file watcher.

---

## 3. Architecture

```
source assets/            assets.config.json
  models/*.glb       +    (profiles + asset rules)
  models/**/*.gltf
          |
          v
  +---------------------------+
  |  build script             |
  |   1. resolve manifest     |
  |   2. hash check / cache   |
  |   3. gltf-transform pass  |
  |   4. write output + stats |
  +---------------------------+
          |
          v
  dist/assets/<name>.<hash>.glb
  dist/assets.generated.json      <- consumed by the app at runtime
  .cache/asset-pipeline/          <- content-addressed, gitignored
```

Source assets stay in the repo (Git LFS if large). Optimized outputs are build artifacts — either gitignored and built in CI, or committed if the team prefers not to run the toolchain locally. Pick one and be consistent.

---

## 4. Input manifest

Settings are defined as **profiles**, with assets pointing at a profile. This avoids maintaining dozens of near-identical per-asset config blocks while still allowing per-asset overrides where genuinely needed.

```json
{
  "$schema": "./asset-config.schema.json",
  "defaults": {
    "mesh": { "codec": "meshopt", "quantize": true, "simplify": null },
    "textures": {
      "default": { "codec": "etc1s", "maxSize": 1024, "quality": 200 }
    }
  },
  "profiles": {
    "hero": {
      "textures": {
        "baseColor": { "codec": "uastc", "maxSize": 2048, "level": 4, "rdo": 4 },
        "normal": { "codec": "uastc", "maxSize": 2048, "level": 4 },
        "metallicRoughness": { "codec": "uastc", "maxSize": 1024 },
        "default": { "codec": "etc1s", "maxSize": 1024 }
      },
      "mesh": { "codec": "meshopt", "simplify": null }
    },
    "prop": {
      "textures": { "default": { "codec": "etc1s", "maxSize": 512 } },
      "mesh": { "codec": "meshopt", "simplify": 0.6 }
    },
    "ui-preview": {
      "textures": { "default": { "codec": "none", "maxSize": 256 } },
      "mesh": { "codec": "none" }
    }
  },
  "assets": [
    { "src": "models/player.glb", "profile": "hero" },
    { "src": "models/props/**/*.glb", "profile": "prop" },
    {
      "src": "models/terrain.glb",
      "profile": "prop",
      "overrides": { "mesh": { "simplify": null } }
    },
    {
      "src": "models/logo.glb",
      "profile": "ui-preview",
      "note": "Lossless required — brand asset, viewed at close range"
    }
  ]
}
```

### Resolution order

`defaults` → `profile` → `overrides`, deep-merged. Later wins.

### Texture slot keys

Match glTF material slots: `baseColor`, `normal`, `metallicRoughness`, `occlusion`, `emissive`, plus `default` as the fallback. This matters because the right codec differs per slot:

- **ETC1S** — small and fast, acceptable for base color and emissive. Visibly destructive on normal maps and packed ORM maps.
- **UASTC** — higher quality, larger files. Correct default for normal maps and metallic-roughness.
- **none** — pass through uncompressed. Needed for data textures, LUTs, anything read back on the CPU, and anything where compression artifacts are unacceptable.

### Validation

Ship a JSON Schema (`asset-config.schema.json`) alongside the config. Gives editor autocomplete and catches typos like `"codec": "uastcc"` before a 20-minute encode run.

---

## 5. Output manifest

The build emits `assets.generated.json`. The app loads this rather than hardcoding paths, which gives content-hash cache busting for free.

```json
{
  "generatedAt": "2026-09-12T10:00:00Z",
  "pipelineVersion": "1.0.0",
  "assets": {
    "models/player.glb": {
      "url": "assets/player.8f3a21c9.glb",
      "profile": "hero",
      "bytes": { "in": 40894464, "out": 713031 },
      "vram": { "in": 358612992, "out": 6291456 },
      "extensions": ["KHR_texture_basisu", "EXT_meshopt_compression"],
      "warnings": []
    }
  }
}
```

`vram` is an estimate computed from texture dimensions, format block size and mip chain — not a measurement, but enough to catch regressions.

---

## 6. Caching

Non-negotiable. Without it, a full encode pass makes builds slow enough that people start skipping the step.

Cache key = hash of:

1. Source file bytes
2. Resolved settings for that asset (post-merge, canonically serialized)
3. Pipeline version + pinned encoder tool versions

On hit, copy from `.cache/asset-pipeline/<key>` and skip encoding entirely. In CI, persist this directory between runs.

---

## 7. Tooling

### Chosen: gltf-transform JS API

- `@gltf-transform/core`, `@gltf-transform/functions`, `@gltf-transform/extensions`
- Maps close to one-to-one onto the manifest structure
- Supports Draco, Meshopt, UASTC and ETC1S, texture resizing, and per-slot targeting
- Full programmatic control over which slot gets which treatment

**Dependency to be aware of:** KTX2 encoding shells out to the `ktx` binary from KTX-Software. It is a system dependency, not an npm package. Pin the version in the Dockerfile / CI setup, and have the build fail with a clear message if it's missing.

### Alternative considered: gltfpack

Single static binary (`-tc` for KTX2, `-cc` for meshopt). Far easier to install and pin, but coarser — much less control over per-slot codec choice, which is the main thing this pipeline exists to provide. Reasonable fallback if the KTX-Software dependency proves painful in CI.

### Mesh codec note

**Meshopt** is the default over **Draco**. Draco reduces download size but has higher decode cost and does not reduce VRAM. Meshopt decodes faster, and its quantization also shrinks vertex buffers in memory. Draco stays available in the schema for assets where download size dominates.

---

## 8. Runtime setup

> Assumes three.js. Adjust if the target is Babylon.js, model-viewer, or an engine
> importer — see Open Questions.

- `KTX2Loader` with `setTranscoderPath()` and `detectSupport(renderer)`, wired into `GLTFLoader` via `setKTX2Loader()`
- `MeshoptDecoder` via `gltfLoader.setMeshoptDecoder()`
- **Self-host** the transcoder and decoder WASM files; do not depend on a CDN
- Set long-lived cache headers on hashed asset filenames
- Load `assets.generated.json` at startup and resolve logical names through it

---

## 9. Phased rollout

### Phase 1 — Validate the approach (~half a day)

1. Pick 2–3 representative assets (one hero, one prop, one problem case).
2. Baseline: file size, `renderer.info.memory`, Spector.js or browser GPU memory capture.
3. Run them through `gltf-optimizer.simondev.io` by hand to find settings that look right.
4. A/B the visuals at actual on-screen resolution — not zoomed in.
5. Test on the weakest target device, including iOS Safari.
6. Record the settings that worked. These become the first profiles.

Exit criteria: measured VRAM reduction with no visual regression anyone notices.

### Phase 2 — Build the pipeline (~2–3 days)

1. Manifest schema + resolver (defaults → profile → overrides).
2. gltf-transform pipeline implementing the resolved settings.
3. Content-hash cache.
4. Output manifest with stats.
5. npm script: `npm run assets:build`.

Exit criteria: Phase 1 results reproduced by running one command.

### Phase 3 — Integrate (~1 day)

1. Runtime loader setup (section 8).
2. App loads `assets.generated.json` instead of hardcoded paths.
3. Wire into the build: run before the bundler, or as a bundler plugin.
4. Watch mode for local development.

### Phase 4 — Harden

1. CI integration with a persisted cache.
2. Budget enforcement — fail the build if an asset exceeds a size or VRAM threshold.
3. A stats summary printed per build (total in/out, cache hit rate, slowest assets).
4. Document how to add a new asset and how to pick a profile.

---

## 10. Risks and gotchas

| Risk                                          | Mitigation                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ETC1S ruins normal / ORM maps                 | Per-slot codec config; UASTC default for those slots                                                                      |
| Block compression wants dimensions ÷ 4        | Resize step enforces it; warn when it changes aspect-affecting dimensions                                                 |
| Transcode cost at load causes stutter         | Measure on min-spec device; consider staggering loads                                                                     |
| KTX-Software missing in CI                    | Pin in Docker image; fail fast with an actionable error                                                                   |
| Encode times balloon as assets grow           | Content-hash cache; report slowest assets each build                                                                      |
| Compressed textures can't be read back on CPU | `"codec": "none"` escape hatch per slot                                                                                   |
| Asset licensing                               | Optimization doesn't change the source model's license — track licenses separately for anything from Sketchfab or similar |

---

## 11. Open questions

1. **Which runtime/engine?** Determines the loader setup in section 8 and whether `KHR_texture_basisu` is supported at all. Web engines (three.js, Babylon.js, model-viewer) are fine. Unity / Unreal / Godot importers vary.
2. **Do optimized assets get committed, or built in CI?** Affects whether every developer needs KTX-Software installed locally.
3. **Any user-uploaded models?** If so, a client-side encode path is needed for that flow specifically.
4. **Are there assets requiring lossless textures?** Data textures, LUTs, brand assets. Identify these up front so they get `"codec": "none"`.
5. **What's the minimum target device?** Sets the quality bar and the VRAM budget.
