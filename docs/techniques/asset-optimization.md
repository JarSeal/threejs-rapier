# Asset optimization

Ækasha turns the textures and models your asset JSONs point at into GPU-ready files at build time: KTX2 textures (Basis Universal) and meshopt-compressed GLBs. The point is GPU memory as much as download size. A PNG or JPEG is decoded to raw RGBA on the GPU, so a 2048² texture costs about 22 MB of VRAM with mips, whatever its file size. A KTX2 texture stays block-compressed on the GPU (BC7, ASTC or ETC2, whichever the device reads), which is 1 byte per pixel or less.

Measured on this repo's test assets (four 1K textures and a prop with 2K maps), the default codec (UASTC with RDO) cut texture VRAM by 75% at the same resolutions (85 MB → 21 MB), with no visible difference at screen resolution.

Optimization is on by default and never required: you can switch it off for the whole project, per asset, or for one page load (see [Opting out](#opting-out)).

## How it works

```text
src/app/textures/rock.texture.json ──┐
src/app/textures/source/rock.png ────┤   yarn assets / yarn dev / yarn build
assets.config.json (profiles) ───────┘             │
                                                   ▼
                    src/public/aek-assets/app/textures/source/rock.3fa9c21b.ktx2
                    assets.lock.json (cache key → output)
                    generatedAppData.json ("__url": "/aek-assets/…")
                                                   │
                                                   ▼
                    loadTextureAsync / importAssetAsync load the __url
```

- The pipeline reads every `*.texture.json` and `*.importedAsset.json` under `src/`. There is no separate asset list: an asset's settings live in its own JSON (`optimize`), and shared settings live in `assets.config.json` at the repo root.
- Outputs go to `src/public/aek-assets/`, named by a hash of their content. **Commit them, together with `assets.lock.json`.** The lock maps each cache key (the source bytes, the resolved settings and the tool versions) to its output, so someone who clones the project gets cache hits and never needs the encoder.
- The dev server rebuilds only what a save touched (the asset JSON, its source file, `assets.config.json`, or `assets.optimization` in `src/CONFIG.ts`). Everything else is a cache lookup.
- At runtime nothing needs configuring. The KTX2 transcoder and the meshopt decoder load only when a KTX2 file or a meshopt GLB is loaded.

### The encoder

Textures are encoded by the `ktx` CLI from KTX-Software (≥ 4.4.0). You only need it when you add or change an asset. The pipeline downloads the pinned release into the gitignored `.tools/` the first time it needs to encode. `yarn setupAssetTools` does the same thing by hand.

- Supported: Linux x64/arm64 (glibc ≥ 2.34: Ubuntu 22.04+, Debian 12+, Fedora 35+), WSL2 and macOS (arm64 and x64). On native Windows, run the project in WSL2.
- Already have a `ktx`? A `ktx` ≥ 4.4.0 on your `PATH` is used as is, and `AEK_KTX=/path/to/ktx` picks a specific one.
- Without a working `ktx`, the pipeline still runs. Committed and cached outputs are used. An asset that needs an encode is reported as `encoder missing`, and the dev server loads its source file instead, with a warning. A production build fails on it (see [Builds](#builds-and-ci)).

## Add a texture

Put the source image next to its JSON and refer to it with a path that starts with `./` or `../`:

```jsonc
// src/app/textures/rock.texture.json
{
  "$schema": "../../../.schemas/texture.schema.json",
  "id": "rock",
  "fileName": "./source/rock_albedo.png",
  "texOpts": { "colorSpace": "srgb", "wrapS": 1000, "wrapT": 1000 },
  "optimize": { "slot": "baseColor" },
}
```

Save it, and the dev server encodes it. Then commit the source, the new file in `src/public/aek-assets/` and `assets.lock.json`.

- **`slot`** tells the pipeline what the texture is (see [Slots](#slots)). It defaults to `default`.
- **Colour space:** set `texOpts.colorSpace: "srgb"` on colour textures (albedo, emissive). The KTX2 is encoded with the colour space your JSON says, so it looks the same as the PNG loaded with the same JSON.
- **Orientation:** standalone textures are stored flipped in the KTX2, because a compressed texture can't be flipped at load. They look the same as the source loaded through `TextureLoader`. You don't need to do anything.
- **Relative sources** must stay inside `src/` and can't be combined with `path`. A production build doesn't ship `src/`, only the outputs.
- **A `src/public` path** (`"/textures/rock.png"`) still works, and that file is optimized too. A remote URL is loaded as it is.
- HDR sources (`.hdr`, `.exr`) and `.ktx2` / `.basis` sources are passed through as they are: UASTC and ETC1S are LDR formats.

## Add a model

```jsonc
// src/app/importedAssets/crate.importedAsset.json
{
  "$schema": "../../../.schemas/importedAsset.schema.json",
  "id": "crate",
  "fileName": "./source/crate.glb",
  "importTextures": true,
  "optimize": { "profile": "prop" },
}
```

- The geometry is meshopt-compressed and quantized (smaller download and smaller vertex buffers). The embedded textures are encoded to KTX2, each by the material slot that uses it.
- **Without `importTextures`, the output has no textures.** The engine discards glTF materials and registers a GLB's textures only with `importTextures`, so the pipeline drops the textures instead of shipping them. If code imports the file with `importTextures` but the JSON doesn't set it (or a scene's save entry doesn't), the textures are gone: set it in the JSON.
- `.gltf` files with external buffers and images work; the output is always a `.glb`.
- **`"lodChain": true`** (or its options: `ratios`, `maxError`, `compactVertices`, …) builds the LOD levels into the output, so the client never runs the simplifier. They are extra meshes no node uses, so glTF viewers show the model as before. Every use of a file shares one output: if the JSON and a scene's save entry ask for different options, the first one wins and the run warns. With the mesh side off (`"optimize": { "mesh": false }`, or a pass-through), the chains are generated at runtime after the load instead. Changing the options re-encodes the file.

### Collider sources

Quantized positions break CONVEXHULL and HEIGHTFIELD colliders, and the meshopt vertex reorder scrambles a heightfield's grid. So a GLB with a node that has `colliderType` in its extras (the custom property the importer reads) gets **lossless** meshopt: compressed, but not quantized, reordered or simplified. You don't need to set anything.

The pipeline can't see colliders that only code adds (`ImportPhysicsParams`). For those sources, set it yourself:

```jsonc
"optimize": { "mesh": { "quantize": false } }
```

If a quantized mesh ends up under a HEIGHTFIELD anyway, the collider is skipped with an error that names this fix. TRIMESH, BOX and CONVEXHULL handle quantized positions.

## Profiles and settings

Settings are resolved per texture slot, from these levels, deep-merged, later wins:

1. the built-in defaults (`devTools/assetPipeline/settings.ts`);
2. `defaults` in `assets.config.json`;
3. every `rules` entry whose `glob` matches the source path (from the repo root), in order;
4. the profile (the JSON's `profile`, else the last matching rule's);
5. the collider default, for collider sources;
6. the asset JSON's own `optimize`.

Within each level, a slot's entry merges over that level's `textures.default`. So a profile's `default.maxSize` reaches every slot, while `normal: { rdo: 1 }` changes only the normal maps' RDO.

### Profiles

The ones `assets.config.json` ships with. Add your own there.

| Profile        | What it changes                                                                                     | Use it for                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| (none)         | The defaults: UASTC, 1024 px, RDO λ 2 for colour and λ 1 for normal / ORM, `data` slots not encoded | Most assets                                                                |
| `prop`         | Textures up to 1024 px, VRAM budget 8 MB                                                            | Ordinary props                                                             |
| `hero`         | Textures up to 2048 px, VRAM budget 24 MB                                                           | Assets the camera gets close to                                            |
| `compact`      | ETC1S for the `baseColor` and `emissive` slots                                                      | Distant and background assets, mobile VRAM budgets                         |
| `terrainLayer` | Encodes the `data` slot as UASTC λ 1                                                                | Terrain layer textures (packed normal + height)                            |
| `terrainBlock` | Lossless meshopt                                                                                    | Terrain meshes, colliders the pipeline can't detect                        |
| `data`         | No texture is encoded                                                                               | Textures that must stay exact (LUTs, splat maps, anything read on the CPU) |

### Slots

| Slot                                    | Meaning                                                 | Default             |
| --------------------------------------- | ------------------------------------------------------- | ------------------- |
| `baseColor`, `emissive`                 | Colour                                                  | UASTC λ 2           |
| `normal`                                | Normal map (resized as unit vectors, mips renormalized) | UASTC λ 1           |
| `orm`, `occlusion`, `metallicRoughness` | Packed or single PBR data maps                          | UASTC λ 1           |
| `data`                                  | Splat maps, masks, LUTs, height                         | `none` (kept exact) |
| `default`                               | Anything else                                           | UASTC λ 2           |

A GLB's textures are classified by the material slot that uses them: a normal map is `normal`, a texture used for both occlusion and metallic-roughness is `orm`, and a texture in one core slot gets that slot.

### Per-asset overrides

`optimize` takes `profile`, `slot` (textures), and `textures`, `mesh` and `budget` overrides:

```jsonc
"optimize": {
  "profile": "hero",
  "textures": {
    "default": { "maxSize": 512 },
    "normal": { "rdo": 0 }
  },
  "mesh": { "simplify": 0.5 }
}
```

The JSON Schema in `.schemas/` autocompletes and explains every key in your editor, and a misspelt key fails the gather.

### Rules

A rule applies settings by source path, without touching the JSONs. It only affects assets that a JSON references:

```jsonc
// assets.config.json
"rules": [
  { "glob": "src/app/props/**/*.glb", "profile": "prop" },
  { "glob": "src/app/ui/**", "optimize": false }
]
```

## Pack channels

A texture JSON can build its image from several sources with `pack`, in place of `fileName`. Each output channel (`r`, `g`, `b`, `a`, or a group like `rgb`) is a source channel or a constant, with optional `remap`, `invert` and `multiply`. For example, a glTF ORM map:

```jsonc
// src/app/textures/metal_orm.texture.json
{
  "$schema": "../../../.schemas/texture.schema.json",
  "id": "metal_orm",
  "pack": {
    "channels": {
      "r": { "src": "./source/metal_ao.png" },
      "g": { "src": "./source/metal_roughness.png" },
      "b": { "src": "./source/metal_metallic.png" },
    },
  },
  "optimize": { "slot": "orm" },
}
```

- A greyscale source has its grey in r, g and b, so `channel` can be left out here. Taking alpha from an image without alpha is an error.
- Colour channels of an sRGB texture (`texOpts.colorSpace: "srgb"`) are read as sRGB, everything else as linear. Override it per channel with `colorSpace`.
- `normal: true` marks a normal map source: it's resized as unit vectors first. `invert: true` flips a channel, eg. a DirectX normal map's green.
- `multiply: { "src": "./source/ao.png", "strength": 0.8 }` bakes AO into an albedo.
- Sources of different sizes need `size: [width, height]`. The result is then resized to the slot's `maxSize`.

With optimization off, a pack is still built and written as a PNG, since it has no single source file.

## Alpha-cut textures

A mip level averages alpha, so a material with `alphaTest` loses thin features with distance: a leaf card's edge or a trunk falls below the cut and breaks up. `alphaCoverage` fixes that at build time. Set it to the material's `alphaTest`, and each mip level's alpha is scaled so the same share of it passes the cut as at level 0:

```json
"albedo": {
  "image": "./tree.albedo.png",
  "optimize": { "slot": "baseColor", "alphaCoverage": 0.5 }
}
```

- **Where:** an atlas slot's `optimize`. Plain `*.texture.json` files don't take it yet.
- **Only for coverage alpha:** an albedo cut by `alphaTest`. A `normal` or `data` slot, or `normalMode`, is refused: their alpha is data. Without an alpha channel or mipmaps it does nothing (with a warning).
- **Per cell:** an atlas keeps each cell's own coverage on the levels its padding keeps apart, and the whole image's on a full chain's levels past them.
- **What it can't fix:** a level only a few texels across moves in coarse steps. Below that, UASTC's alpha error near the cut (up to about 18/255 on small levels) can still move the edge by a few percent.

## Impostor atlases

An impostor (a far LOD level drawn with a few textured quads) bakes its atlases at load, or is exported once and loaded from the repo. You don't write these files by hand: the LOD debug tab's Impostors folder writes them while `yarn dev` runs (or downloads them, with the paths to put them at). An export is four files, in `src/app/impostors/` by default (`AppConfig.lod.impostorExportDir`):

```text
rock.impostor.json        what the material needs: kind, layout, shading, alpha test, fingerprint
rock.textureAtlas.json    the atlas: one image slot per atlas, one cell per frame
rock.albedo.png           the baked albedo, alpha cut, transparent texels dilated
rock.normalDepth.png      object-space normal + depth (octahedral; cross-quads: rock.normal.png)
```

The pipeline encodes the atlas's slots like any texture, into `src/public/aek-assets/`. A scene loads the impostor by listing it, `"impostors": ["rock"]` in its `*.scene.json`, and code calls the generator with the same `id` as before. Re-export after changing the source mesh: a debug build warns when the export's fingerprint no longer matches it.

The atlas JSON uses two texture atlas keys that exist for exports like this:

- **`slots.<name>.image`**: a ready-made image of the whole layout (the atlas's `size`), relative to the JSON. The slot isn't composed from its cells (no resize, no edge extension, no fill), so every cell needs a `rect` and has no `sources`. The image's size is checked by the gather and again by the encode.
- **`mipChain: "FULL"`**: every mip level down to 1 × 1 (an exact 2 × 2 box, area-filtered past an odd size). The default, `"PROTECTED"`, stops the chain at the last level the padding keeps apart, so cells never mix. An impostor's neighbouring cells are neighbouring views of the same object, so mixing them is harmless, and a short chain would shimmer at distance.

The codecs per slot, as an export writes them:

| Slot                       | Contents                                                | Settings                                                                                             |
| -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `albedo`                   | sRGB colour, alpha cut                                  | `slot: "baseColor"` (UASTC λ 2), `alphaCoverage` set to the impostor's alpha test (see above)        |
| `normalDepth` (octahedral) | Object-space normal in RGB, depth in alpha, linear      | `slot: "data"` with `{ "codec": "uastc", "rdo": 0 }`: depth error moves the parallax and the shadows |
| `normal` (cross-quads)     | Normal in the plane's frame (as the bake camera saw it) | `slot: "normal"` (resized as unit vectors)                                                           |

A 12 × 12 octahedral atlas (864²) is about 1 MB of GPU memory per slot as UASTC, against about 4 MB baked at load (RGBA8 with mips).

## Budgets

A build fails when a shipped asset goes over its budget, so a texture that grew to 4K or slipped into `none` doesn't reach production unnoticed.

- **`budget: { vramMB, downloadMB }`**, on any settings level (defaults, a profile, a rule, the asset's own `optimize`). It's checked against the whole asset: its textures (KTX2 at 1 B/px, the most any device uses) plus a GLB's geometry. `null` clears a limit an earlier level set. MB are 10⁶ bytes.
- **A per-texture ceiling, with no key:** every encoded texture must fit its slot's `maxSize`² at its codec's rate, plus mips, as set by the levels without the asset's own JSON. For example, 1.40 MB for a 1K UASTC texture, 5.59 MB for a 1K `none` one. So raising `maxSize` or switching to `none` in an asset's own JSON fails the build.
- **To allow a bigger asset**, give it its own `budget` in its JSON. That replaces the ceiling, and it's an explicit line a reviewer sees.
- Where it shows: `yarn build` fails for assets that a shipped scene uses (debug-only scenes don't count), `yarn assets` lists them and exits 1, and `yarn gatherAppData` and the dev server only warn.
- Passed-through assets aren't checked.
- The whole scene's GPU memory is checked at runtime instead, by the profiler's GPU memory tab, since a build can't see what code loads.

## Opting out

On by default, at three levels:

1. **The whole project**, in `src/CONFIG.ts` (build time only; the runtime never reads it):

   ```ts
   assets: {
     optimization: {
       enabled: true, // master switch
       textures: true, // KTX2 encoding
       meshes: true, // meshopt / Draco, quantize, simplify
     },
   },
   ```

   Off means no encoding and no `ktx`. Each asset is **passed through**: a relative source is copied into `aek-assets/` and a `src/public` source keeps its own URL, so loading works the same either way. `AEK_ASSETS_OPTIMIZE=false` turns `enabled` off for one run.

2. **One asset:** `"optimize": false` in its JSON, or `{ "glob": "…", "optimize": false }` as a rule. A GLB can keep one side as it is: `"optimize": { "textures": false }` or `{ "mesh": false }`.

3. **One page load (dev / test builds):** the Assets debug tab's "Asset loading" folder has a "Load source files (boot)" checkbox. After a reload, assets load their source files instead of the outputs, for an A/B comparison. Packed textures have no source and stay optimized. A production build ignores it.

## Codec cheat sheet

**Textures**

| Codec   | VRAM                                                         | Download                        | Use for                                                                           | Avoid for                                 |
| ------- | ------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| `uastc` | 1 B/px everywhere (BC7 on desktop, ASTC 4×4 on mobile)       | About the source's (RDO + Zstd) | Everything: the default                                                           | —                                         |
| `etc1s` | 1 B/px on desktop; 0.5 B/px on mobile for maps without alpha | 2.5–4× smaller than UASTC       | Colour maps of distant or background assets (`compact`)                           | Normal maps, ORM, terrain, detailed props |
| `none`  | 4 B/px (RGBA8)                                               | The source's                    | Data that must stay exact: LUTs, splat maps, masks, anything read back on the CPU | Large colour textures                     |

UASTC keys: `level` (0–4, encode effort, default 2), `rdo` (λ: 0 off, higher is smaller and blurrier; λ 4 is visibly softer) and `zstd` (0–22). ETC1S: `quality` (1–255). All codecs: `maxSize` (`null` keeps the source size) and `mipmaps`. Block-compressed sizes are rounded to multiples of 4, with a warning when that changes the aspect ratio.

`normalMode` (two-channel normals) is in the schema but in no profile: the material has to unpack it, and the engine has no flag for that yet.

**Geometry**

| `mesh.codec` | Effect                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `meshopt`    | The default. Quantized: smaller download and smaller vertex buffers. `quantize: false`: lossless |
| `draco`      | Smaller download only, slower to decode, always quantized                                        |
| `none`       | No compression (`quantize: true` still quantizes)                                                |

`simplify` (0–1, a target triangle ratio) is off by default, and always off for collider sources.

## Builds and CI

- **`yarn assets`** runs the whole pipeline and is the only command that deletes stale outputs and lock entries. The dev server and `yarn gatherAppData` never delete anything. **Run it before you commit asset changes.** `yarn assets --only <id|glob>` builds only the matching assets (by id, or by JSON or source path).
- **`yarn build`** runs the cached pipeline and fails when a shipped scene uses an asset with no output (no `ktx`, or a failed encode) or over its budget. The error names the asset, its scenes and the fix. `dist/aek-assets/` gets only the outputs the build loads.
- **`AEK_ASSETS_ALLOW_UNOPTIMIZED=true yarn build`** ships the assets that need `ktx` unoptimized instead of failing (a GLB still gets its geometry compressed). A broken asset still fails.
- **CI:** with the outputs and the lock committed, a build needs no `ktx`. An app that doesn't commit its outputs can run `yarn setupAssetTools` in CI and cache `.cache/asset-pipeline/` between runs.

## Troubleshooting

- **"N assets need ktx and got no output":** run `yarn setupAssetTools`, or put a `ktx` ≥ 4.4.0 on your `PATH`, or set `AEK_KTX`. The line before it says why the lookup failed (eg. a `ktx` 4.3 on `PATH` that was skipped). After a failed download, the dev server waits 5 minutes before trying again; `yarn setupAssetTools --force` retries now.
- **An output changed after a re-encode on another machine:** `ktx` encodes are byte-reproducible per platform, not across platforms (macOS arm64 and Linux x64 differ by a few bytes). The lock decides, so this only happens when an asset is actually re-encoded. Commit the new output and lock.
- **What did this page load actually load?** The Assets debug tab's info windows show the loaded file and what it is (pipeline output, pass-through, source), plus an "Asset pipeline" section with the codec and the download and VRAM figures, before and after. The profiler's GPU memory tab counts KTX2 textures at their real size.
- **Run stats:** every run writes `.cache/asset-pipeline/last-run.json` (totals, cache hit rate, slowest assets, budget violations). Deleting `.cache/asset-pipeline/` is always safe.
