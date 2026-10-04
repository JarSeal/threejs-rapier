Status: draft | not-implemented
Category: Rendering, LOD
Epic: p350_lod-system-research.md (Tier 2.2)
Blocked by: p348_ecs-lod-selection.md (Phase 3: per-level instanced pools)
Related: p299_texture-arrays-and-atlases.md (Phase 4's exported atlases), p376_hlod-merged-cluster-proxies.md (merged groups' far levels), p347_lod-chain-generation.md (impostors are the level after the last chain level), p353_macro-streaming-grid.md (`FAR` cells show impostors), p308_terrain-scatter.md (leaf-litter cards), p420_npc-simulation-tiers.md (its `CROWD` tier may reuse octahedral impostors), the procedural sky box (p112/p113, implemented: day-night lighting, see §2.3)

# Impostor & Billboard LOD

The last LOD level for distant objects: a few textured quads instead of a mesh. Two techniques,
cheapest first:

1. **Cross-quads**: two or three intersecting alpha-cut planes with the object's silhouette baked
   on them. Reads as volumetric from most ground-level angles. For vegetation.
2. **Octahedral impostors**: one camera-facing quad sampling an atlas of the object baked from
   N×N directions on an octahedron, blending the three nearest views. Correct from any angle,
   including above. For rocks, buildings and anything seen from the air.

Plus a **dithered cross-fade** between any two LOD levels, which every LOD transition (not just
impostors) can use.

Prototype cross-quads first (p350 §8): they may be enough for vegetation at a fraction of the work.

---

## 1. Grounding

- p348's `createInstancedLodPool` gives one `InstancedMesh` per level; an impostor level is just
  another level with a quad geometry and an impostor material.
- **Bakes already done in-engine:** the sky box bakes its nebulae into a cube with a `CubeCamera`
  over a private scene (`SkyBox/SkyStaticLayers.ts`), and the env bake renders `fromScene` into a
  fixed target (`SkyEnvironment.ts`). Both clear new targets once on allocation (the r186 destroyed-
  texture trap in CLAUDE.md). An impostor bake is the same shape: a private scene, an orthographic
  camera, a render target per atlas.
- **Lighting changes over time:** the sky's day-night cycle moves the sun and fades it out at
  night. Any impostor with baked lighting would be lit at the bake's time of day forever.
- **No TAA** in the PostFX chain: dithering stays visible as noise.
- No alpha-hash or dither material exists in the engine yet.

## 2. Design

### 2.1 Cross-quads

`generateCrossQuads(geometry, material, opts) → { geometry, material }` (toolkit):

- Bake the object's silhouette from 2 or 3 horizontal directions (default 3, 60° apart) into one
  atlas, with an orthographic camera fitted to the bounding box. Channels: albedo + alpha, normal
  (§2.3).
- The quad geometry has one plane per direction through the object's vertical axis, UVs into the
  atlas. Alpha test (`alphaTest` / a TSL discard), double-sided, `castShadow` optional (a
  cross-quad shadow is a decent tree shadow at distance).
- Becomes the last level of a p348 LOD pool:
  `levels: [..., { geometry: cross.geometry, material: cross.material, screenSize }]`.

### 2.2 Octahedral impostors

`bakeOctahedralImpostor(geometry, material, { frames: 12, frameSize: 128 })`:

- Bake `frames × frames` views from directions on a full or hemi octahedron (hemi for objects
  never seen from below: half the atlas for the same resolution), into an atlas with albedo +
  alpha, normal + depth.
- Material (TSL): the vertex stage builds a camera-facing quad per instance and computes the view
  direction in the instance's local space, maps it to octahedral coordinates, and picks the three
  nearest frames with barycentric weights. The fragment stage samples and blends the three frames,
  with a parallax offset from the depth channel so frames line up.
- Instanced through the same LOD pools. The view-direction maths is per instance, so one draw
  covers every impostor of one asset.

### 2.3 Lighting

Impostors bake **albedo, normal and depth, never lighting**. The impostor material shades with the
scene's lights and environment at runtime, so it follows the day-night cycle and the sun's
shadows like the real mesh. Baked AO is allowed (it doesn't depend on time of day). This rules
out the cheap "screenshot the lit object" approach.

### 2.4 Dithered cross-fade

A transition shows both levels for `fadeSeconds` (default 0.25 s), dissolving one into the other
with a screen-space dither (an interleaved-gradient noise threshold against a per-instance fade
value; the outgoing level uses the complementary threshold, so their pixels never overlap):

- A per-instance `lodFade` attribute on LOD pool meshes; a TSL node `lodDither(fade)` that
  materials opt into (the engine's own materials via a flag, custom node materials by calling it).
- p348's apply step keeps the instance in both levels' meshes during the fade and adds
  `TAG_LOD_TRANSITIONING` (runtime-only); `lodFadeSystem` advances the fade and removes the old
  copy when done.
- Plain mesh entities (p348 §4.1) fade by drawing the outgoing level through a temporary clone
  for the fade's duration. Phase 2 measures whether that's worth it or whether meshes keep instant
  switches.
- Without TAA the dither is visible as noise up close. At LOD distances it reads as a soft blend;
  if not, the fade is off per pool (`fadeSeconds: 0`).

Why dither rather than alpha blending: alpha blending needs sorting and depth-write off, which
breaks shadows and post effects (fog, SSAO) for the transitioning object. Dithering stays opaque.

### 2.5 Bake caching

Phase 1 bakes at load, in the asset loading phase, budgeted like p353's priming. A baked atlas is
a registered texture owned like any other asset. Phase 4 adds a debug "Export impostor" button
that saves the atlas as PNGs next to an `*.impostor.json` (atlas paths, frame count, bounds); p300
then encodes it as KTX2, and nothing is baked on the client.

## 3. Phases

### Phase 1 — Cross-quads

`generateCrossQuads`, bake at load, as the last level of a p348 LOD pool. largeWorld's trees get a
cross-quad level.

**Exit:** largeWorld's far trees draw as cross-quads; the triangle count drops (p345); at the
switch distance the switch is visible but not jarring.

### Phase 2 — Dithered cross-fade

`lodFade`, `lodDither`, `TAG_LOD_TRANSITIONING`, `lodFadeSystem`, for pools; measure the plain-mesh
variant.

### Phase 3 — Octahedral impostors

Bake, material, three-frame blend with depth parallax, hemi option.

**Exit:** a rock impostor holds up from any angle (including overhead) at its switch distance, and
it darkens at night with the rest of the scene.

### Phase 4 — Exported atlases

Export button, `*.impostor.json` asset type (schema, gatherer suffix), KTX2 through p300. The
exported atlas uses p299's atlas format (a `*.textureAtlas.json` per impostor, frames as cells
with a generated cell table), so `*.impostor.json` holds only frame count, bounds and the atlas id.

## 4. Versioning

Toolkit minor (generators and bake helpers). Engine minor for `lodDither` / fade support in LOD
pools and, in Phase 4, the new asset type (also a `readme.md` entry: a new asset JSON type).

## 5. Open questions

1. Shadows from octahedral impostors: a camera-facing quad casts a shadow facing the _camera_, not
   the light. Use the cross-quad or a lower mesh level as a shadow-only proxy, or
   `castShadow: false`. Decide in Phase 3.
2. Can the impostor bake use the asset worker (OffscreenCanvas + a second WebGPU device)? It would
   keep bakes off the main thread, but doubles device memory for the bake. Main thread first.
