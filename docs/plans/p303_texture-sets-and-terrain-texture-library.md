Status: draft | not-implemented
Category: Assets, Materials, Terrain
Blocked by: p302_material-and-texture-system-refactor.md
Blocks: p304_procedural-texture-baker.md, p305_terrain-material-generator.md
Epic: p301_terrain-texturing-epic.md

# Texture Sets & the Terrain Texture Library

This plan delivers:

- **Texture sets**: a new engine asset type (`*.textureSet.json`). A texture set is a named group of packed PBR maps plus the physical facts about the surface (tile size, height relief, wet response).
- **Layer arrays**: several sets of one packing assembled into array textures, so a terrain material binds 2–3 textures however many layers it uses.
- **The toolkit terrain library**: 16 CC0 sets (2 each of sand, mud, rocks, cliffs, snow, ice, grass ground, plus 2 optional concrete). They have a fetch script and packing recipes, and ship as KTX2 through p300.
- **The `terrainGallery` scene skeleton**: one isolated, engine-generated block per set.
- **The handbook**: `docs/techniques/README.md` and `docs/techniques/texture-sets.md`.

---

## Context (grounded)

- After p300:
  - texture JSONs may have relative `fileName`s and `pack` sources;
  - outputs are KTX2 in `src/public/aek-assets/`;
  - `loadTextureAsync` loads `.ktx2` through a shared `KTX2Loader` on the main thread.
- After p302:
  - material inputs go through a resolver registry (`registerMaterialInputResolver`, with `dependencies`);
  - `setup` TSL entries take shared `inputs`;
  - scenes get per-scene dependency closure.
- `gatherAppData` gathers 10 suffixes (`gatherAppData.ts:35-47`). A new suffix needs: a schema in `src/_engine/schemas/`, an entry in the suffix table, a `generatedAppData` section, and JSON Schema compilation.
- Asset ownership and release are in `core/Assets/AssetOwners.ts` and `SceneAssetRelease.ts:57-94`. Textures are released when no material uses them (`isTextureUsedByAnyMaterial`, `Material.ts:601-634`).
- No `DataArrayTexture` or `CompressedArrayTexture` is used anywhere yet.
- WebGPU's default `maxSampledTexturesPerShaderStage` is 16. Shadow maps and the environment PMREM count against it (p301 §6).
- `toolkit/geometry/generateTerrain.ts` builds an indexed grid with `position`, `uv` and `normal` (no tangents, no colour), seeded simplex noise, and returns `getHeightAt` / `heights`.

---

## Design

### D1 — The `*.textureSet.json` asset

**Schema:** `src/_engine/schemas/textureSetSchema.ts`.

```json
{
  "$schema": "../../../../../.schemas/textureSet.schema.json",
  "id": "sand01",
  "category": "SAND",
  "physicalSize": [3, 3],
  "heightScale": 0.03,
  "defaultPacking": "LITE",
  "packings": {
    "LITE": { "albedoRough": "sand01_albedoRough", "normalHeight": "sand01_normalHeight" },
    "FULL": {
      "albedoHeight": "sand01_albedoHeight",
      "normal": "sand01_normal",
      "orm": "sand01_orm"
    },
    "MINIMAL": { "albedoHeight": "sand01_albedoHeightAO" }
  },
  "surface": {
    "tint": "#ffffff",
    "normalStrength": 1,
    "roughnessScale": 1,
    "aoStrength": 1,
    "heightContrast": 1,
    "porosity": 0.85,
    "wetDarkening": 0.55,
    "wetRoughness": 0.4
  },
  "debugData": { "name": "Sand 01 (dry dunes)", "description": "ambientCG Ground080, CC0" }
}
```

- **`category`**: `SAND | MUD | ROCKS | CLIFF | SNOW | ICE | GRASS | CONCRETE | OTHER`. p305 uses it for defaults, p307 for wet-response defaults, p310 for the gallery's grouping.
- **`physicalSize`**: metres covered by one tile. **`heightScale`**: metres of relief that height = 1 represents. Used for height blending, puddles and parallax-free depth cues.
- **`packings`**: at least one. Each slot is a texture id. Slot names are fixed per packing (D2).
- **`surface`**: defaults the terrain material copies into uniforms. Each layer of a terrain material can override any of them.
- **`averageColor`** (the linear-averaged albedo of the shipped map) is **computed by the p300 pack/encode step**. It's stored as generated metadata of the albedo texture (`__averageColor` in `generatedAppData`) and exposed through `getTextureSet(id).averageColor`. An optional `averageColor` in the set JSON overrides it. The source JSON is never written back. p305 uses it for the zero-fetch far mode and for colour map + detail.
- **Runtime** (`core/TextureSet.ts`): `getTextureSet(id)`, `loadTextureSetAsync(id, packing?)` (loads only that packing's textures) and `getTextureSetPackingTextures(id, packing)`.
- **Ownership:** texture sets are owned and released like other assets. A set is plain data; its textures are what get released.
- **Scenes:** the scene schema gets an optional `textureSets: string[]` for code-only use. D6 of p302 adds sets referenced by materials automatically.

### D2 — Packings (binding conventions)

| Packing   | Slot           | R         | G         | B         | A         | Colour space    | Codec (p300 slot)                          |
| --------- | -------------- | --------- | --------- | --------- | --------- | --------------- | ------------------------------------------ |
| `FULL`    | `albedoHeight` | albedo    | albedo    | albedo    | height    | sRGB (A linear) | UASTC (`baseColor`)                        |
|           | `normal`       | N.x       | N.y       | N.z       | –         | linear          | UASTC (`normal`)                           |
|           | `orm`          | AO        | roughness | metalness | –         | linear          | UASTC (`orm`)                              |
| `LITE`    | `albedoRough`  | albedo×AO | albedo×AO | albedo×AO | roughness | sRGB (A linear) | UASTC (`baseColor`)                        |
|           | `normalHeight` | N.x       | N.y       | height    | –         | linear          | UASTC (`data`, not normal mode: B isn't Z) |
| `MINIMAL` | `albedoHeight` | albedo×AO | albedo×AO | albedo×AO | height    | sRGB (A linear) | UASTC or ETC1S (`baseColor`)               |

- **Normals** use the OpenGL convention (+Y), as three.js does: ambientCG `NormalGL`, Poly Haven `nor_gl`. Never the DX variants.
- **LITE** reconstructs N.z = √(1 − x² − y²).
- **MINIMAL** gets its normal from screen-space height derivatives (a bump from `dFdx/dFdy`, no extra fetch) or uses a flat normal, per material option.
- **Height** is remapped per set to the full 0..1 range when packing. The real relief is `heightScale`.
- **Missing AO** (the Ice and Concrete034 sources have none) is derived when packing as a **cavity term** from height: `ao = 1 − k·max(0, blur(height, r) − height)`. Constant 1 is the fallback. This is a pack-recipe option, not a code path at runtime.
- **AO into albedo** (LITE, MINIMAL), with `aoStrength` applied at pack time:
  - **Why:** it saves the AO fetch (and in LITE, all of ORM) per layer, per anti-tiling tap, per projection, which is the biggest multiplier in p301 §6. Pebble-scale crevice AO looks the same whether it darkens all light or only indirect light.
  - **Cost:**
    - AO now darkens direct sunlight too. That's wrong for large-scale occlusion: never bake valley- or rock-scale AO into a tiling layer (that belongs in vertex AO or a colour map, p306/p305).
    - It stacks with screen-space GTAO (`app/postFx/ambientOcclusion.tsl.ts`), so p305 lowers the material's AO influence when the layer's AO is baked (`docs/analysis/ambient-occlusion-options.md` rule: combine with `min()` or split by scale).
- **Metalness** is constant 0 for terrain. FULL keeps the channel for glTF compatibility, since structures may use it.
- **Mipmaps:** all mip levels are generated at encode time (p300). Height and roughness in alpha are mipmapped as linear data; sRGB applies to RGB only.

### D3 — Pack recipes in texture JSON (uses p300's `pack`)

The LITE `albedoRough` of `sand01`:

```json
{
  "id": "sand01_albedoRough",
  "pack": {
    "size": [2048, 2048],
    "channels": {
      "rgb": {
        "src": "./source/raw/color.jpg",
        "multiply": { "src": "./source/raw/ao.jpg", "channel": "r", "strength": 0.8 }
      },
      "a": { "src": "./source/raw/roughness.jpg", "channel": "r" }
    }
  },
  "optimize": { "profile": "terrainLayer", "slot": "baseColor" },
  "texOpts": { "wrapS": "REPEAT", "wrapT": "REPEAT", "colorSpace": "SRGB", "anisotropy": "MAX" }
}
```

- `./source/raw/` holds the downloaded maps renamed to fixed names (`color`, `normal`, `roughness`, `ao`, `height`; D5). So recipes are identical across sets apart from the strengths.
- The p300 resize step makes the 1K output from the 2K source.

### D4 — Layer arrays

**`buildTextureSetArray({ id, sets: string[], packing }): TextureSetArray`**, in `core/TextureSet.ts`:

- Returns one array texture per slot of the packing (2 for LITE). Layer `i` = `sets[i]`.
- A per-layer uniform array holds `physicalSize`, `heightScale` and the surface defaults.
- **Requirements:**
  - all sets have the packing;
  - every slot has the same resolution and mip count;
  - the transcoded format is the same, which holds when every slot was encoded with the same codec.
- A mismatch throws a clear error naming the offending set, slot and value.
- **Baseline: CPU assembly.**
  - For KTX2, `CompressedTexture.mipmaps[level].data` of each member is concatenated per level into a `CompressedArrayTexture`, and the result is uploaded once.
  - For uncompressed dev fallbacks (PNG source while p300 can't encode), it's a `DataArrayTexture` built from `ImageBitmap`s through an `OffscreenCanvas`, with mipmaps generated on the GPU.
  - This works on both backends. The member textures are never uploaded on their own, so no VRAM is spent twice.
  - Each member's CPU mip data is kept only until assembly, then released.
- **Optional optimization: GPU assembly** (`renderer.copyTextureToTexture` into layer `z`, per mip). WebGPU only. Spike it in Phase 3; adopt it only if it's measurably faster on large arrays.
- **Swapping a member** at runtime (`setTextureSetArrayLayer(arrayId, i, setId)`, used by the debug tab and p310's gallery) reassembles that layer only: it re-fetches the member's KTX2 and re-uploads that layer, through `texture.needsUpdate` with a layer-update range if r186 supports it, otherwise a full re-upload.
- **Resolver** (p302 D4): `{ "textureSetArray": ["sand01", "grass01", "rocks01", "cliffs01"], "packing": "LITE" }` → a bundle `{ arrays: { albedoRough, normalHeight }, layerCount, layerParams }`. Its `dependencies` list every member texture.
- Array ids are derived from the member list and packing, so two materials with the same palette share one array. The array is ref counted like textures.

### D5 — The fetch tool

- **`devTools/fetchTextureSources.ts`** (`yarn fetchTextureSources [--only <setId>] [--force]`). It reads every `src/**/textureSets/*/source.json`:

```json
{
  "provider": "ambientCG",
  "assetId": "Ground080",
  "download": "2K-JPG",
  "license": "CC0-1.0",
  "page": "https://ambientcg.com/view?id=Ground080",
  "maps": {
    "color": "_Color",
    "normal": "_NormalGL",
    "roughness": "_Roughness",
    "ao": "_AmbientOcclusion",
    "height": "_Displacement"
  }
}
```

- **ambientCG:** `https://ambientcg.com/get?file=<assetId>_<download>.zip`. This URL pattern is what the ambientCG v2 API (`/api/v2/full_json?id=…&include=downloadData`) returns as `downloadLink`.
- **Poly Haven:** `https://api.polyhaven.com/files/<assetId>` → per-map URLs (`Diffuse`, `nor_gl`, `Rough`, `AO`, `Displacement`; `arm` is a ready-made AO/rough/metal pack).
- **Behaviour:**
  - Downloads are cached in `.cache/texture-downloads/` (gitignored).
  - Maps are matched by file-name suffix, extracted with `fflate` (small pure-JS unzip, dev dependency) and written to `<setDir>/source/raw/<map>.<ext>`.
  - `src/**/textureSets/*/source/` is gitignored.
  - A missing optional map (`ao`) is logged as such, never as an error.
- **Download size:** use `2K-JPG` by default (≈ 20–40 MB per zip, ≈ 0.5 GB for all 16 sets, one-off and cached). `2K-PNG` (≈ 55–75 MB) is worth it only for a set whose normal map shows JPEG blocking at 1K, typically cliffs.
- **Why 2K sources for 1K output:** downsampling averages out JPEG artifacts and gives clean mips. 4K is unnecessary for tiling layers. 2K output is kept for an optional `terrainLayerHero` profile (cliffs, first-person close-ups).
- **Credits:** `src/toolkit/terrain/CREDITS.md` is generated from the `source.json` files (asset, provider, licence, page). CC0 requires no attribution, but the record keeps provenance clear.

### D6 — The library (toolkit, 16 sets)

These are candidates checked against the providers' APIs (2026-10-02): the ids exist and the maps are as listed. **Pick by eye in Phase 4**: open each candidate's page and keep it, or swap in the alternate. `physicalSize` for assets whose API dimension is 0 is an estimate; confirm it with the gallery's 1 m texel-density overlay (p305 debug view, or a temporary checker in Phase 5).

| Set          | Look                               | Primary (ambientCG) | Alternate                | physicalSize       | Maps         | Notes                                               |
| ------------ | ---------------------------------- | ------------------- | ------------------------ | ------------------ | ------------ | --------------------------------------------------- |
| `sand01`     | dry beige sand                     | `Ground080`         | PH `aerial_sand`         | 3 m                | C N R AO H   |                                                     |
| `sand02`     | coastal sand, accumulation ripples | `Ground093C`        | PH `coast_sand_05`       | 3 m                | C N R AO H   | Wet-response showcase                               |
| `mud01`      | soil mud                           | `Ground036`         | PH `brown_mud_02`        | 2.5 m              | C N R AO H   |                                                     |
| `mud02`      | forest mud with sticks             | `Ground071`         | PH `brown_mud_leaves_01` | 1.75 m (API)       | C N R AO H   | Puddle showcase                                     |
| `rocks01`    | gravel / rocky ground              | `Ground079S`        | PH `aerial_rocks_02`     | 2 m                | C N R AO H   |                                                     |
| `rocks02`    | mossy stony ground                 | `Ground068`         | PH `brown_mud_rocks_01`  | 2 m                | C N R AO H   |                                                     |
| `cliffs01`   | grey mountain cliff                | `Rock051`           | PH `cliff_side`          | 6 m                | C N R AO H M | Triplanar showcase; candidate for 2K                |
| `cliffs02`   | dark cave cliff                    | `Rock035`           | ambientCG `Rock058`      | 6 m                | C N R AO H   |                                                     |
| `snow01`     | clean snow                         | `Snow010A`          | PH `snow_02`             | 3 m                | C N R AO H   |                                                     |
| `snow02`     | wind-shaped snow                   | `Snow008A`          | PH `snow_field_aerial`   | 4 m                | C N R AO H   |                                                     |
| `ice01`      | lake ice                           | `Ice002`            | ambientCG `Snow014`      | 4 m                | C N R H      | AO derived (D2)                                     |
| `ice02`      | lake ice, variant                  | `Ice004`            | ambientCG `Ice003`       | 4 m                | C N R H      | AO derived                                          |
| `grass01`    | lawn-grass ground, top-down        | `Grass004`          | ambientCG `Grass005`     | 1.4 m (API)        | C N R AO H   | Ground layer only, no blades                        |
| `grass02`    | forest floor with grass            | `Ground037`         | PH `forrest_ground_01`   | 2.1 m (API)        | C N R AO H   |                                                     |
| `concrete01` | smooth concrete                    | `Concrete034`       | PH `brushed_concrete`    | 1.1 × 0.55 m (API) | C N R H      | Non-square: structures only, never in a layer array |
| `concrete02` | damaged concrete                   | `Concrete044D`      | —                        | 2 m                | C N R AO H M | Structures                                          |

Map key: C colour, N normal (GL), R roughness, AO ambient occlusion, H height/displacement, M metalness (ignored).

**What ships:**

- Every set: `LITE` at 1K (KTX2 UASTC + Zstd, ≈ 0.6–1.2 MB per map; ≈ 2.7 MB of VRAM per set with mips).
- `sand01`, `grass01` and `cliffs01` also ship `FULL` and `MINIMAL`, for the packing comparison in the gallery.
- `cliffs01` ships an optional 2K LITE (`terrainLayerHero`).
- Committed outputs ≈ 16 × 2 × ~0.9 MB + extras ≈ 35–40 MB.

### D7 — `textureSetSurface` toolkit material (baseline and preview)

- `src/toolkit/terrain/materials/textureSetSurface.tsl.ts`: a `setup` TSL material that renders **one** texture set with world-space tiling (`positionWorld.xz / physicalSize`), any packing, and `surface` uniforms. No anti-tiling, no splat.
- It is the baseline every technique in p305 is compared against, the gallery's isolated-block material and the simplest structure material.
- **Decode helper** `src/toolkit/terrain/nodes/sampleTextureSet.ts`: `sampleTextureSet(bundle, uv, { packing, grad? }) → { albedo, normalTS, roughness, ao, height }`. It is shared by p305 (array and non-array variants).

### D8 — `terrainGallery` skeleton (app)

- `src/app/terrainGallery.scene.json` + `terrainGallery.ts`.
- **Blocks:** a 4 × 4 grid of 12 × 12 m blocks with 4 m gaps, one per set, all from `generateTerrain`:
  - 48 segments, gentle 0.4 m noise;
  - one edge raised into a 35° ramp, so normals and later triplanar can be judged;
  - a distinct seed per block.
- **Look:** sky box `dayNight`, paused at 10:00. `cliffs*` blocks get a vertical 6 m wall piece.
- **Scene-scoped debug tab** `app/_dbg__terrainGallery.ts` (pattern: `_dbg__spaceDemo.ts`):
  - a list of sets, where clicking one flies the camera to it;
  - a packing selector (for the 3 sets that ship all packings);
  - a "1 m checker" toggle for checking `physicalSize`.
- p305 adds the technique rows, p307 the wet controls, and p310 the camera presets and measurements.

---

## Phases

### Phase 1 — Asset type and runtime (D1, D2)

1. Schema, suffix in `gatherAppData`, generated section, JSON Schema.
2. `core/TextureSet.ts`, ownership, scene `textureSets`.
3. Resolver `{ "textureSet": id }` with dependencies.

**Exit:** a hand-made set (PNG sources, no pipeline) loads through a material input and is released on scene exit.

### Phase 2 — Fetch tool and recipes (D3, D5)

1. `fetchTextureSources.ts`, `fflate`, gitignore entries, `CREDITS.md` generation.
2. Pack recipe templates (FULL/LITE/MINIMAL), cavity-AO derivation.

**Exit:** `yarn fetchTextureSources --only sand01 && yarn assets --only 'sand01*'` produces the three packings as KTX2.

### Phase 3 — Layer arrays (D4)

1. CPU assembly (compressed and uncompressed), validation errors, ref counting.
2. Layer swap.
3. Spike GPU assembly (record the result in this plan).
4. Verify on WebGPU and WebGL2: sample layer `i` in a test material and compare against the single-texture path.

**Exit:** a 4-set LITE array renders identically to 4 separate sets, using 2 bindings.

### Phase 4 — The library (D6)

1. Create the 16 set folders (`source.json`, set JSON, texture JSONs).
2. Fetch, choose by eye, tune `physicalSize` / `heightScale` / `surface`.
3. Encode and commit the outputs.

**Exit:** all sets load; VRAM total measured and recorded in this plan.

### Phase 5 — Baseline material and gallery skeleton (D7, D8)

1. `textureSetSurface` + `sampleTextureSet`.
2. `terrainGallery` scene and tab.

**Exit:** 16 blocks render with correct scale and orientation (no mirrored normals, sun-lit relief matches light direction), on both backends.

### Phase 6 — Handbook and versioning

1. **`docs/techniques/README.md`:** index table (p301 §5), the page template, the "which technique for my game" matrix skeleton (rows: game type/camera; columns: recommended technique, packing, anti-tiling, projection), and a "start here" path.
2. **`docs/techniques/texture-sets.md`** (page template), covering:
   - what each map does and which are optional (table: required = colour; strongly recommended = normal, roughness; optional = AO, height, metalness);
   - the three packings with exact channel layouts and when to choose each (art style / camera / tier);
   - **AO into albedo, step by step** (recipe option, strength, what it costs, how it interacts with GTAO);
   - deriving AO from height;
   - choosing `physicalSize` and texel density per camera type;
   - sources: ambientCG and Poly Haven, which download to pick (2K JPG/PNG), why 2K → 1K;
   - making your own set in Blender: baking a tileable PBR set from a sculpted or procedural Blender material (Cycles bake of colour, normal, roughness and AO to a 2K image on a plane, with seam checking via a 2×2 tiled preview);
   - adding a set to the library (folder, JSON, fetch or commit sources, `yarn assets`);
   - KTX2 settings per slot.
3. `readme.md` Features: "Texture sets" (engine) and "Terrain texture library" (toolkit).
4. Versions: engine minor (asset type, arrays), toolkit minor (library, baseline material), app minor (gallery); `CHANGELOG.md`.

---

## Risks

| Risk                                                                                                                        | Mitigation                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| UASTC transcodes to different GPU formats on different devices, so an array can mix formats if members use different codecs | One codec per packing slot (profile), validated at assembly                                                                                    |
| CPU mip data is not retained after upload                                                                                   | Members are fetched for assembly and never uploaded on their own; assembly happens before any material uses them                               |
| Committed outputs make the repo heavy (~40 MB)                                                                              | LITE only by default; FULL and MINIMAL only for 3 sets; revisit LFS (p301 Open questions)                                                      |
| Provider ids or download URL patterns change                                                                                | `source.json` records the page URL; the fetch tool fails per set with a clear message; committed outputs keep the repo working without a fetch |
| Photo-scanned layers have baked-in lighting or strong large-scale features that repeat visibly                              | Choose by eye (Phase 4); p305's anti-tiling and macro variation                                                                                |
| Sets differ in brightness, so a blend shows seams in tone                                                                   | `surface.tint` per set and per layer; gallery side-by-side tuning                                                                              |
