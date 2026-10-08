Status: in progress | Phase 1 implemented
Category: Assets, Textures
Blocks: p351_impostor-billboard-lod.md (Phase 5: its cross-quad lane and no-pop dolly)
Related: p299_texture-arrays-and-atlases.md (the atlas mip chain this extends), \_DONE_p300_asset-optimization-pipeline-plan.md (the pipeline), p308_terrain-scatter.md (leaf cards)

# Alpha-Coverage-Preserving Mips

Alpha-tested textures thin out with distance: a mip level averages alpha, and the alpha test then
cuts a thin feature (a trunk, a leaf card's edge) whose texels fall below the cut. This plan makes
the asset pipeline scale each mip level's alpha so the share of texels passing the cut stays what
it is at level 0, per slot and opt-in.

Found in p351 Phase 4 section 6: largeWorld's exported tree cross-quads draw 10-18 % thinner than
the runtime bake at their switch distance (area 0.82-0.92 against the bake), the trunks breaking
up. Not the codec (the decoded KTX2 matches the exact box chain within 1-3 % coverage; `rdo: 0`
changed nothing). The export's `mipChain: "FULL"` is the exact box / area filter, and the alpha
test thins it as expected; the bake looks thicker only because three r186's GPU mip generator
samples odd-sized levels bilinearly (mean alpha 72-77 at levels 4-5 against the true 65). So the
target is level 0's coverage, not the bake's.

---

## 1. Grounding

- Atlases build their own levels: `textureAtlases.ts`'s `nextLevel` (exact halving, `resizeImage`'s
  area filter past an odd size), each level flipped and handed to `encodeKtx2Levels` (`ktx create
--levels`). A per-level alpha step fits there.
- Plain `*.texture.json` sources get their mips from `ktx create --generate-mipmap`
  (`ktxEncode.ts`), which the pipeline doesn't see. Coverage there means building the levels in the
  pipeline too, as atlases do.
- Only some alpha channels are coverage: an albedo cut by `alphaTest` is, an octahedral impostor's
  `normalDepth` alpha (depth) and any packed data alpha aren't. So it must be opt-in per slot.
- p351's export knows the material's `alphaTest` (`resolveCrossQuadsOptions` /
  `resolveOctahedralImpostorOptions`), so it can write the cut itself.
- Runtime bakes (`ImpostorBake.ts`'s render targets) take GPU mips and are out of scope: with this
  plan an export draws closer to the mesh than a bake of the same object. Exports are what scenes
  ship (p351 Phase 4).

## 2. Design

- **Option:** `alphaCoverage: number` (the cut, 0-1) on an atlas slot's `optimize` and on a
  `*.texture.json`'s `optimize`; unset means no change. It requires an alpha channel and
  `mipmaps`, and isn't allowed on a `normal` / `data` slot (schema).
- **Per level** (Castaño, "Computing alpha mipmaps", 2010; NVTT's `scaleAlphaForCoverage`):
  measure level 0's coverage at the cut, then for each later level find the alpha scale `s` (binary
  search, about 10 steps) whose coverage of `clamp(alpha × s)` is closest to it, and store the
  scaled copy. The next level is computed from the **unscaled** one, so scales don't compound.
- **Coverage measure:** the share of texels with alpha ≥ cut, measured with 4 × 4 bilinear
  sub-samples per texel (what Castaño does), not texel centres only, which is too coarse at the
  small levels where this matters (15 × 8 for the tree).
- **Per cell or whole image:** per cell while the level keeps the cells apart (p299's protected
  levels), whole image past that (a `FULL` chain's mixed levels). An impostor's frames have their
  own coverage (a tree's three planes are alike; an octahedral atlas's top and side views aren't).
- **Cache key:** `alphaCoverage` joins the resolved settings only when set, so every existing
  output keeps its key (as p299 did with `mipChain`).
- **Export:** p351's `_dbg__ImpostorExport.ts` writes `alphaCoverage: alphaTest` on both kinds'
  albedo slots, and the impostor format version stays (the layout's meaning doesn't change, only
  the encode).

## 3. Phases

### Phase 1 — Atlases — done

The schema option on atlas slots, the per-level scale in `textureAtlases.ts`, the per-cell rule,
the cache key, the run's label ("alpha coverage 0.5"). Checked on p299's `p299TestAtlasImage`
(alpha-cut discs): each level's coverage within 1 % of level 0's, against the unscaled chain's drop.

As built:

- The maths is `devTools/assetPipeline/alphaCoverage.ts` (`measureAlphaCoverage`,
  `scaleAlphaForCoverage`), for Phase 3 to reuse. Coverage is measured on the alpha **quantized to
  8 bits**, as `encodePng` stores it: the search puts texels right at the cut, and measuring the
  floats lost those that round below it (level 2 0.995, level 3 0.984 before the fix).
- The option is `TextureAtlasSlotOptimizeSchema` (the array's `optimize` plus `alphaCoverage`, so
  `*.textureArray.json` doesn't get it), with `AlphaCoverageSchema` and `refineAlphaCoverageSlot`
  in `assetsConfigSchema.ts` for Phase 3. It travels on `AtlasSlotSource.alphaCoverage`, not the
  resolved settings: the cut is the asset's (its material's), not a profile's or a rule's. The
  encode refuses (throws) a slot that resolves to `normal` / `data` or `normalMode` through a rule
  or profile, which the schema can't see, and warns and skips without alpha or mipmaps.
- The cache key gets `alphaCoverage: { cut, version: ALPHA_COVERAGE_VERSION }` only when set: bump
  the version when what the scale writes changes.
- The search: closest coverage to the target, the bracket doubling from 1 (up to 256) or [0, 1],
  then 12 bisection steps; ties keep the scale nearest 1, so empty and opaque cells stay as they are.
- Measured (decoded KTX2 against level 0's coverage, cut 0.5; unscaled box chain in brackets):
  levels 1-2 per cell 1.000 / 1.002 (1.001 / 0.984); level 3 whole 0.969 (0.964), its 8-bit input
  1.005; level 4 0.922 (0.838); levels 5-7 0 (0). The 1 % holds on the levels the layout keeps
  apart. Level 3 is UASTC: up to 18/255 of alpha error on the disc edges (75 and 189 against the
  cut's 127.5), the same with `rdo: 0` and with `level: 4` (open question 1). Levels 4 and down are
  granularity: the 9 identical discs at a few texels each move in steps of several percent, and at
  6 × 6 no scale gets nearer than 0 (they jump from none passing to most). The tree's atlas
  (`alphaTest` 0.5, levels 0 protected, so whole image from 1) does better, its 8-bit input
  against the unscaled chain: levels 1-4 1.000 (0.998-0.837), 7 × 4 1.006 (0.254), 3 × 2 0.939
  (0), 1 × 1 0 (0); Phase 2 measures the decoded export.

### Phase 2 — Impostor exports

The export writes `alphaCoverage`; re-export largeWorld's tree and rock. Measured with p351 Phase 4
section 6's harness (`angles`, the tree at its switch distance and half): the export's area against
level 1 at least the bake's (0.86-1.20), the trunks whole; half the distance no worse than now
(exported against baked 1.5-4.5). The rock (solid, nearly convex) within section 5's figures.

### Phase 3 — Plain textures

`*.texture.json` with `alphaCoverage` builds its own levels like an atlas (no `--generate-mipmap`)
and scales them. For p308's leaf cards and any alpha-cut texture outside an atlas. Checked on a
test texture with thin features.

**Exit:** the tree's exported cross-quads keep level 0's coverage at every level (within 1 %),
draw no thinner than the runtime bake at their switch distance, and the rock's export doesn't
change measurably; `docs/techniques/asset-optimization.md` documents `alphaCoverage`.

## 4. Versioning

Engine minor (a new schema option in `schemas/`), app patch (largeWorld's re-exports). The
pipeline itself is repo tooling (Project in the CHANGELOG).

## 5. Open questions

1. UASTC's alpha error near the cut (about 7/255 on the tree's levels 1-2) remains. Does it matter
   once coverage is scaled? Phase 2 measures; if so, a slot can raise its UASTC `level`.
2. Should runtime bakes get the same scale (a GPU pass after three's mip generation), so bake and
   export match again? Not needed while scenes ship exports; revisit if bakes stay common.
