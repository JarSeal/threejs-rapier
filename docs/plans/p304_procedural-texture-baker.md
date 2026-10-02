Status: draft | not-implemented
Category: Rendering, Materials, Procedural
Blocked by: p302_material-and-texture-system-refactor.md, p303_texture-sets-and-terrain-texture-library.md
Blocks: p305_terrain-material-generator.md (soft: macro noise and ripple atlas), p307_wet-and-dry-surface-states.md (ripple atlas), p309_terrain-decals.md (procedural decals)
Epic: p301_terrain-texturing-epic.md

# Procedural Texture Baker

A material built from a TSL node graph runs its noise math for every covered pixel every frame. This plan lets a node graph be **baked once** into a mipmapped texture, so per-frame cost drops to one fetch. Baking can happen at load, on a parameter change, or in the browser for export as a committed and KTX2-encoded asset.

It adds:

- **`bakeTexture()`**, engine core: TSL node(s) → `Texture` / array texture, with MRT, mips, clear-once, asset ownership, a bake queue and GPU timing.
- **A periodic noise library** in the toolkit, so baked textures tile seamlessly.
- **Procedural surface generators** in the toolkit (one or more per terrain category, plus concrete), usable **baked** (as procedural texture sets) or **live** (evaluated in the material; never tiles, costs ALU).
- **Shared generated textures**: macro noise (p305) and the rain ripple atlas (p307).
- A debug "export PNG" tool: bake in the browser, commit the PNG, and let p300 encode it to KTX2. This is the bridge between the procedural and imported workflows.

---

## Context (grounded)

- **Bake precedent:** `core/SkyBox/SkyStaticLayers.ts`.
  - It bakes a `NodeMaterial` into a HalfFloat `CubeRenderTarget` through a `CubeCamera` (`:65-117`, `:190`).
  - It throttles to one bake per 150 ms (`:28`).
  - It skips while a scene loads or before `renderer.hasInitialized()`.
  - Its `initTarget` (`:80-96`) clears each face once on allocation. Three r186 otherwise destroys the placeholder GPU texture in place on the first render without invalidating bind groups ("Destroyed texture used in a submit"). `SkyEnvironment.ts:107-121` does the same.
  - Neither bake generates mipmaps.
- **QuadMesh precedent:** `core/Viewports.ts:295` composites with `THREE.QuadMesh`. It saves and restores the render target, cube face and mip level (`:550`, `:602`) and notes that a leaked scissor breaks PMREM (three #31777).
- **GPU timing:** `core/Debug/_dbg__GPUTimer.ts` (`_acquireGpuTimer`, `_onRenderContext`, `_sumGpuMs`; WebGPU only; nested contexts never resolve on WebGL).
- **Noise in the repo:**
  - `mx_noise_float`, `mx_fractal_noise_float` and `mx_worley_noise_float` (`toolkit/materials/asteroid.tsl.ts:11-13`, `SkyBox/layers/stars.ts:34`, `layers/nebula.ts:24`).
  - `nebula.ts:10` warns that `mx_fractal_noise_vec3` **hangs SwiftShader's WebGL2**.
  - None of these are periodic, so baking them gives visible tile seams.
- No `renderer.compute`, `StorageTexture` or render-target-array usage exists yet.

---

## Design

### D1 — `bakeTexture` (engine: `core/TextureBaker.ts`)

```ts
type BakeOutput = { name: string; node: Node; colorSpace?: 'SRGB' | 'LINEAR'; type?: 'UNSIGNED_BYTE' | 'HALF_FLOAT' };

bakeTexture(opts: {
  id: string;                         // registered with saveTexture, owned like any texture
  size: number | [number, number];    // power of two recommended (mips, KTX2 export)
  outputs: BakeOutput[];              // 1 = plain target; 2-4 = MRT, one texture per output
  layers?: number;                    // > 1 = array texture; the graph reads `bakeLayer` (int uniform)
  build?: (ctx: { uv: Node; layer: Node; texel: Node }) => Record<string, Node>; // alternative to static nodes
  mipmaps?: boolean;                  // default true
  wrap?: 'REPEAT' | 'CLAMP';          // default REPEAT
  anisotropy?: number | 'MAX';
  isPersistent?: boolean;
}): Promise<BakedTexture>;            // { textures: Record<name, Texture>, rebake(params?), dispose() }
```

- **Render:** a full-screen `QuadMesh` with a `NodeMaterial` whose output is `mrt({ … })` for several outputs.
  - Several outputs mean one `RenderTarget` with `count: n`.
  - Layers are rendered one by one into an array render target (three r186 array render target, chosen by layer). If r186 can't target array layers on both backends, the fallback bakes each layer into a 2D target and assembles them with p303's array assembly.
  - Render-target state is saved and restored as in `Viewports.ts`, including the scissor.
- **Clear once on allocation**, the same as `initTarget`.
- **Mipmaps:**
  - Turn on the target texture's `generateMipmaps` and verify that r186 generates them after the render on both backends.
  - If not, add a small downsample chain (box filter, one `QuadMesh` pass per level), which also lets alpha-as-data be averaged correctly.
- **Pipeline compile:** `renderer.compileAsync(quad, camera)` before the first bake, so compiling doesn't stall the frame.
- **Scheduling:**
  - During scene load, bakes run inside the loader's hold, with loader status updates (`getLoaderStatusUpdater`).
  - Outside loads they queue into `textureBakeSystem` (MAIN, after `skyBoxSystem`), which runs at most one bake per frame and throttles rebakes of the same id to one per 150 ms (the latest request always runs; same rule as the static layers).
- **Memory:** `getBakedTextureMemoryBytes()` (RGBA8 1K + mips ≈ 5.6 MB; HalfFloat doubles that). This number goes into each page's "VRAM" section.
- **Stats (debug only):** last bake GPU ms per id through `_dbg__GPUTimer`, shown in the gallery tab and the p220 profiler later.

### D2 — Periodic noise library (toolkit: `src/toolkit/terrain/nodes/noise/`)

Tileable baking needs noise with an integer period over the tile:

- `periodicValueNoise(p, period)`, `periodicGradientNoise(p, period)`: hash on `mod(cell, period)`.
- `periodicFbm(p, period, octaves, lacunarity = 2, gain)`: the period doubles with each octave, so every octave tiles.
- `periodicWorley(p, period) → { f1, f2, cellId }`: F1 gives pebbles, F2 − F1 gives cracks and cell edges.
- `domainWarp(p, period, strength)`.
- Each also has a **non-periodic** variant (`period = 0` selects it at build time) for live use in world space.
- Helpers:
  - `heightToNormal(heightFn, uv, texel, heightScale)`: central differences on the analytic height, so 4 extra evaluations at bake time only.
  - `heightToCavity(heightFn, uv, radius)`: 8-tap ring, for AO.
  - `hash22`, `hash12`.
- All of these use our own hashing, not `mx_*`, so they're safe on SwiftShader and deterministic across backends up to float precision. GPU float differences make baked textures visual-only data. Never derive gameplay from them.

### D3 — Procedural surface generators (toolkit: `src/toolkit/terrain/procedural/`)

- **Shape:** each generator is `defineSurfaceGenerator({ id, category, params: ZodSchema, defaults, build(ctx, params) → { albedo, height, roughness, ao?, normal? } })`. `normal` defaults to `heightToNormal` and `ao` to `heightToCavity`.
- **Packing:** the generator's output is packed into the requested packing (FULL/LITE/MINIMAL from p303 D2) by a shared `packSurfaceOutputs` node function. A baked procedural set is therefore indistinguishable from an imported one.

| Generator       | Category | Idea                                                                             | Notable params                                  |
| --------------- | -------- | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `sandRipples`   | SAND     | Wind ripples (directional sine on warped coordinates) + grain noise              | direction, wavelength, warp, grain, colour pair |
| `sandFlat`      | SAND     | Fine grain + low-contrast mottling (a beach)                                     | grain, mottling, colours                        |
| `mudCracked`    | MUD      | Worley F2−F1 cracks, dried-mud plates curled at edges                            | crack width, plate size, moisture tint          |
| `mudSmooth`     | MUD      | Smooth fbm with glossy low spots (pairs with p307 puddles)                       | lumpiness, colours                              |
| `rockyGround`   | ROCKS    | Worley F1 pebbles with per-cell colour and height, fill noise between            | pebble size, density, colour spread             |
| `cliffStrata`   | CLIFF    | Banded strata along Y + fbm + crack lines (meant for triplanar; tiles in its UV) | strata frequency, tilt, crack density           |
| `snowDrift`     | SNOW     | Soft fbm drifts, roughness sparkle variation, faint blue AO                      | drift scale, sparkle                            |
| `iceSheet`      | ICE      | Cracks (Worley edges at two scales) + bubble specks; low roughness               | crack scales, bubble density, tint              |
| `grassGround`   | GRASS    | Ground seen through short grass: clumpy greens on soil, fine streak noise        | clump scale, green range, soil show-through     |
| `concretePores` | CONCRETE | Fine pores, fbm stains, form-work seams (optional)                               | pore density, stain strength, seam spacing      |

- **Procedural texture sets.** `*.textureSet.json` gains an alternative to `packings`:
  ```json
  "procedural": { "generator": "sandRipples", "params": { "wavelength": 0.12 }, "seed": 7, "size": 1024, "packing": "LITE" }
  ```
  - On load the set is baked (D1) into its packing's slots and then behaves like any set.
  - **Array limitation:** baked textures are uncompressed RGBA8 and imported sets are block-compressed, so they can't share a layer array. A terrain material uses either all-procedural or all-imported arrays, or the separate-binding path. p305 validates this and says so in the error.
- **Live mode.** The same `build` runs inside a material in world space with non-periodic noise.
  - p305's `proceduralLive` layer source uses it.
  - It never repeats and costs only ALU, which makes it useful for comparison and for large stylized surfaces.
  - It is too costly for first-person photoreal on low-end hardware, and the handbook page says so with gallery measurements.

### D4 — Shared generated textures (toolkit: `src/toolkit/terrain/textures/`)

- **`macroNoise`** (512², RGBA8, tileable over a large period):
  - R = low-frequency fbm (brightness);
  - G = a second fbm, decorrelated (hue / roughness);
  - B = Worley cells (patch masks);
  - A = blue-ish noise (dithering, the rule-noise base).
  - It is sampled by p305 at 1/40–1/300 m scales.
  - It is baked once at load, or exported and committed as KTX2 (`codec: none` or UASTC; it's data).
- **`rippleAtlas`** (256², 4×4 cells, RGBA8): per cell, an expanding ring at a random phase. RG = ring normal XY, B = ring mask, A = cell time offset. p307 animates it with two time-offset samples.
- **`blueNoise`** (64², R8): a void-and-cluster approximation baked once, for dithered transitions (optional).

### D5 — Export to PNG (debug only)

- **Where:** in the gallery tab, and as `exportBakedTexture(id, output)` in `_dbg__TextureBaker.ts`.
- **What:** reads the target back with `renderer.readRenderTargetPixelsAsync` (per mip 0 only; mips are rebuilt by p300) and downloads `<id>_<output>.png` (8-bit; `HALF_FLOAT` outputs are tone-clamped with a warning).
- **Workflow** (documented in `procedural-textures.md`):

  1. Tune a generator live in the gallery.
  2. Export.
  3. Put the PNGs in a texture set's `source/` (committed, since it's not re-downloadable).
  4. Write pack recipes.
  5. `yarn assets`.

  The result is a compressed, imported set born procedural. It is the best of both: unique looks, made in-engine, compressed in VRAM, no bake at load.

---

## Phases

### Phase 1 — Bake core (D1, single output, 2D)

1. `bakeTexture`, clear-once, state save/restore, mip check (or downsample chain), ownership, memory number.
2. A debug-scene check: bake a checker, sample it on a plane.

**Exit:**

- No "destroyed texture" errors on WebGPU.
- Identical output on WebGL2.
- Mips visibly present at a grazing angle.

### Phase 2 — MRT, arrays, scheduling (D1)

1. MRT outputs, array layers (or the 2D + assembly fallback), `compileAsync`.
2. `textureBakeSystem` queue, throttled rebake, loader integration, GPU timing.

**Exit:** a 3-output, 4-layer bake runs during scene load with progress shown, and a rebake from a slider never bakes more than once per frame.

### Phase 3 — Noise library (D2)

**Exit:**

- Each periodic function tiles seamlessly in a 3×3 repeat preview.
- The non-periodic variants match the periodic ones statistically.
- SwiftShader WebGL2 doesn't hang (`?forceWebGL` headless check).

### Phase 4 — Generators and procedural sets (D3)

1. `defineSurfaceGenerator`, `packSurfaceOutputs`.
2. The 10 generators.
3. `procedural` in the texture set schema; bake on load; validation against arrays.
4. Live-mode wrapper for p305.

**Exit:** every generator bakes into all three packings and looks right on a gallery block.

### Phase 5 — Shared textures and export (D4, D5)

**Exit:**

- `macroNoise` and `rippleAtlas` exist as baked textures and as committed KTX2.
- Export → commit → `yarn assets` round trip works for one generator (`sandRipples` → a new set `sand03` is **not** added to the library, only demonstrated in the doc).

### Phase 6 — Gallery row, handbook, versioning

1. **Gallery** (`terrainGallery`): a "Procedural" row with one block per generator, toggling **imported / baked / live** for categories that have both, plus last-bake GPU ms and per-block frame GPU ms (p310 standardizes the measurement).
2. **`docs/techniques/procedural-textures.md`** (page template), covering:
   - live vs baked vs exported (decision table);
   - the VRAM and download trade-offs (baked = uncompressed; exported = compressed);
   - tileability and periodic noise;
   - seeds and determinism (visual only);
   - writing a generator (a worked example: `sandRipples` line by line);
   - "Best for": stylized PBR, top-down/RTS, procedural worlds, game jams with no texture budget, unique non-repeating large surfaces (live), and NOT first-person photoreal on low-end (live).
3. Versions: engine minor (`bakeTexture`), toolkit minor (noise, generators, shared textures); `CHANGELOG.md`; `readme.md` Features (engine: texture baker; toolkit: procedural surfaces).

---

## Risks

| Risk                                                               | Mitigation                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| r186 doesn't render into array render target layers on one backend | 2D bake + p303 assembly fallback (Phase 2 decides)                          |
| r186 doesn't generate mips for render targets on one backend       | Own downsample chain (Phase 1)                                              |
| Pipeline compile hitches on first bake                             | `compileAsync` before baking; bakes at load                                 |
| Baked VRAM adds up (16 procedural sets at 1K LITE ≈ 180 MB)        | The handbook's export → KTX2 path; `size` per set; the gallery shows memory |
| Live procedural is costly per pixel                                | Measured in the gallery; tiers; the handbook's "poor fit" rows              |
| Float differences across GPUs                                      | Visual-only data; never feed gameplay or colliders from baked textures      |
