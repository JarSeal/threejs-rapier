Status: implemented (Phases 1-5)
Category: Rendering, LOD
Epic: p350_lod-system-research.md (Tier 2.2)
Related: \_DONE_p341_alpha-coverage-mips.md (Phase 4's exported albedo atlases keep level 0's alpha coverage, which Phase 5's cross-quad lane needed), \_DONE_p342_dev-file-server.md (Phase 4's export writes through it), p299_texture-arrays-and-atlases.md (Phase 4's exported atlases; Phase 4 section 1 extends its format), \_DONE_p300_asset-optimization-pipeline-plan.md (Phase 4's KTX2 encode), p354_gpu-driven-culling.md / p375_batched-mesh-batches.md (later lanes of Phase 5's showcase), p376_hlod-merged-cluster-proxies.md (merged groups' far levels), \_DONE_p347_lod-chain-generation.md (impostors are the level after the last chain level), p353_macro-streaming-grid.md (`FAR` cells show impostors), p308_terrain-scatter.md (leaf-litter cards), p420_npc-simulation-tiers.md (its `CROWD` tier may reuse octahedral impostors), the procedural sky box (p112/p113, implemented: day-night lighting, see §2.3)

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

`generateCrossQuads(geometry, material, opts) → { geometry, material, albedo, normal }` (engine,
`core/Lod/Impostors/CrossQuads.ts`: Phase 4's asset type, Phase 2's fade and p353 / p376 / p420
consume impostors from core, and core never imports the toolkit):

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
  materials opt into (`enableLodDither(material)`, which pools call on their level materials;
  custom node materials can call `lodDither` themselves).
- p348's apply step keeps the instance in both levels' meshes during the fade and adds
  `TAG_LOD_TRANSITIONING` (runtime-only); `lodFadeSystem` advances the fade and removes the old
  copy when done.
- Plain mesh entities (p348 §4.1) fade by drawing the outgoing level through a temporary clone
  for the fade's duration. Phase 2 measures its cost; meshes fade like pools.
- Culling fades too: an entity fades out to LOD culled and in from it.
- **No LOD change pops unless asked to.** `fadeSeconds` (default 0.25 s from
  `AppConfig.lod.fadeSeconds`, per `LodDef`) is the option; 0 switches instantly. Every later LOD
  or representation switch (p308's cells, p353's cell states, p354's GPU bins, p375's batch
  members, p376's proxies, p420's NPC tiers) honours it.
- Without TAA the dither is visible as noise up close. At LOD distances it reads as a soft blend;
  if not, the fade is off per pool (`fadeSeconds: 0`).

Why dither rather than alpha blending: alpha blending needs sorting and depth-write off, which
breaks shadows and post effects (fog, SSAO) for the transitioning object. Dithering stays opaque.

### 2.5 Bake caching

Phase 1 bakes at load, in the asset loading phase, budgeted like p353's priming. A baked atlas is
a registered texture owned like any other asset. Phase 4 adds a debug "Export" button that writes
each atlas as one PNG, a p299 `*.textureAtlas.json` and an `*.impostor.json` (everything the
material needs, see Phase 4's decisions) straight into the repo through the dev file server
(`_DONE_p342`); p300 then encodes the atlases as KTX2, and a scene that lists the impostor bakes
nothing on the client.

## 3. Phases

### Phase 1 — Cross-quads — done

`generateCrossQuads`, bake at load, as the last level of a p348 LOD pool. largeWorld's trees get a
cross-quad level.

**Exit:** largeWorld's far trees draw as cross-quads; the triangle count drops (p345); at the
switch distance the switch is visible but not jarring.

As built:

- In core, not the toolkit (§2.1): `core/Lod/Impostors/CrossQuads.ts` and the shared
  `ImpostorBake.ts` (bake materials per pass, frame and atlas targets, the dilating copy). Phase 3
  builds on `ImpostorBake.ts`.
- No budget: p353 isn't implemented, so the bake is synchronous during the scene load
  (`getBakeRenderer` throws before `InitEngine`). The largeWorld tree bakes in about 12 ms
  (WebGPU, Apple GPU, measured on a second bake of the same tree). `generateCrossQuads` is
  synchronous; making it budgeted later is an API change (it would return a promise).
- Two atlases per impostor, frames side by side with a 4-texel gutter: albedo (RGBA8 sRGB) and
  normal (RGBA8 linear, the bake camera's view-space normal), mipmapped. The frame is fitted to the
  object's radius around its vertical axis and its height, with a 2-texel margin. The tree's atlases
  are 252×136, 182,738 B each with mips, counted by owner in the profiler's GPU memory tab.
- Transparent texels are dilated (the nearest opaque colour within 16 texels), so the alpha cut and
  far mips get no dark fringes.
- The normal is rebuilt from the plane's screen-space derivative frame and `normalViewGeometry`, not
  a `normalMap`: three r186 doesn't rotate `tangentLocal` per instance, and its double-sided normal
  maps negate the whole frame on back faces (a plane seen from behind would look lit from below).
  Only the out component flips on the back face. `normalMap` still holds the atlas so the asset
  tooling sees it.
- Plane UVs run top-down: a render target texture's v = 0 is the top of the image on both backends.
  Verified upright on WebGPU and the WebGL2 fallback.
- The material copies the shading model of the source material drawing the most triangles (Phong,
  Lambert, unlit, else standard) with its shininess / specular or roughness / metalness. An unlit
  source bakes no normals.
- Shadows: `map` + `alphaTest` is enough, three r186's shadow pass copies `alphaTest` and takes
  alpha from `map`. The planes cast cut-out shadows (Phase 3's open question 1 still stands for
  octahedral impostors).
- Exit, measured from the overview camera (WebGPU): 297-455 of the 1,500 trees are cross-quads
  (it varies with the frame the count is read in). Drawing the same instances with level 1's mesh
  instead: 138,580 → 135,016 triangles in the main pass (12 per tree, 18 → 6) and 18 → 17 draw
  calls (level 1 has two material groups). The tree is already very low-poly, so the saving is small
  here; heavier assets gain far more. At the switch distance, level 1 and the cross-quads are hard to
  tell apart; the cross-quads read slightly darker on the lit side.
- largeWorld: level 1 now ends at screen size 0.032 (about 180 m), cross-quads below it.
- Not done: no alpha coverage correction per mip. Not needed for the solid tree cone; a thin
  asset (leaf cards) may thin out at distance, which Phase 2 or p308 should check.

### Phase 2 — Dithered cross-fade — done

`lodFade`, `lodDither`, `TAG_LOD_TRANSITIONING`, `lodFadeSystem`, for pools and plain meshes,
level changes and culling alike. No LOD change pops unless it's asked to: `fadeSeconds` (default
0.25 s from `AppConfig.lod.fadeSeconds`, per `LodDef`, `setLodFadeSeconds` at runtime) is the
option, and 0 switches instantly.

What changed from §2.4 when the code was read:

- Level materials are shared between level meshes (largeWorld's levels 0 and 1 use the same trunk
  and foliage materials) and can be shared with other meshes, so a material can't read one fixed
  `lodFade` attribute. three r186 builds every `InstancedMesh` on its own (its uuid is in the render
  object's cache key, `RenderObject.js:846`), so one shared mask node resolves the drawn object's
  fade when its shader is built. The material "flag" is `enableLodDither(material)`, which a pool
  calls on its own level materials; no schema flag.
- `maskNode` works on classic materials too (`NodeLibrary.fromMaterial` copies every key, and the
  largeWorld trees are `MeshPhongMaterial`s), and the shadow pass reads it
  (`Renderer._getShadowNodes`): shadows dither with the complementary pattern, so the two levels'
  shadows add up to one.
- Culling fades too (§2.4 didn't cover it): largeWorld's bushes pop out at their cull distance.
- Plain meshes fade too: not optional (no LOD change pops), only measured.

Sections, each reviewed before the next:

1. **Dither primitive** (`core/Lod/LodFade.ts`): `lodDither(fade)` (interleaved-gradient noise on
   the pixel position against a signed fade: ≥ 0 shows where noise < v, < 0 where noise > 1 − |v|,
   so the incoming copy at `t` and the outgoing at `−(1 − t)` never share a pixel; 1 = fully shown),
   `enableLodDither(material)` (idempotent, combines with an existing `maskNode`), and the mask node
   resolving the drawn object's fade: a per-instance `lodFade` attribute on pool level meshes, else
   a per-object value. No behaviour change yet; checked by setting a fade by hand, WebGPU and
   WebGL2. — done: `createLodFadeAttribute(mesh)` (not on the shared geometry; three frees it with
   the geometry's buffers, like the instance matrix), `setLodObjectFade` / `clearLodObjectFade` (an
   object-group uniform, written per draw), `enableLodDither`. Checked in largeWorld on both
   backends: level 0's tree mesh dithers (shadows too) while level 1, on the same materials without
   the attribute, stays whole; one rock at 0.3 dithers while the other on its material stays
   whole. The noise reads as fine diagonal hatching at 0.5 when still.
2. **Pool fades:** `TAG_LOD_TRANSITIONING` (runtime-only), fade hooks on `LodTarget`, `fadeSeconds`
   (`LodDef`, `AppConfig.lod.fadeSeconds`, `setLodFadeSeconds`), `lodFadeSystem` (right after
   `lodApplySystem`, only the transitioning entities). During a fade the instance is in both level
   meshes (the slot's outgoing copy); the swap-remove, the matrix sync, despawn and LOD removal
   handle it; a change mid-fade finishes the running fade first. Fading out to culled and in from
   culled. largeWorld fades with no code change. — done: `LodTarget.applyLevel` / `setCulled` take
   a `fade` flag (keep the old copy as the outgoing one, start the new one hidden) and the optional
   `setFade(entityId, world, progress)` draws a running fade (1 ends it). Only targets with
   `setFade` fade; plain meshes still pop until section 3. The fade's progress is `LodData._fade`;
   the outgoing copy is the slot's `_fadeOutMesh` / `_fadeOutIndex` (a fade to culled has only it,
   with `index` -1), patched by the swap-remove like `index`. Pools create the `lodFade` attribute
   per level mesh and call `enableLodDither` on their level materials. Found in the code: the first
   apply after the LOD is added never fades (the load would cross-fade every instance out of level
   0), removing the LOD never fades, and an entity shown again in another level than it was hidden
   in switches to it while still hidden (the selection sets `lod.level` before removing
   TAG_LOD_CULLED), so it fades in in the selected level. `LodFrameStats` gets `fading` and
   `fadeMs`. Checked in largeWorld by changing the bias (all trees and bushes at once): ~2,000
   instances fade per change, `lodFadeSystem` 0.2-0.35 ms for 2,000 (0.6 ms for 3,300 under
   repeated mid-fade changes), every slot and outgoing copy holds its own matrix and fade and every
   level mesh's `count` matches its copies, also after deleting entities and removing their LOD
   mid-fade; `fadeSeconds` 0 switches at once. Dithers on WebGPU and WebGL2.
3. **Plain-mesh fades:** the outgoing level drawn by a temporary clone of the mesh for the fade's
   duration, the per-object fade on both, culling included; also for an `InstancedMesh` entity (a
   p308 static cell fades as a whole). `fadeSeconds` in `*.mesh.json` / scene mesh overrides
   (`schemas/lodSchema.ts`). Measure the per-object cost on a scene with many plain LOD meshes.
   — done: plain meshes fade through the same hooks as targets (`applyLevelTo` / `setCulledTo` /
   `drawFade` in `LodSystem.ts` pick the target or the mesh side). A level change adds a copy of
   the mesh showing the previous level as a child of the mesh (it follows the mesh and hides with
   it), never raycast, holding no refs; an InstancedMesh's copy shares its instance attributes. The
   copy is disposed at the fade's end: three r186 holds every render object in a strong set until
   its object fires `dispose`, so a copy only removed from the scene leaks its render objects.
   Culling fades need no copy: the mesh itself fades out or in, and `reconcileObject3DVisibility`
   keeps a LOD-culled mesh visible while it has `TAG_LOD_TRANSITIONING`. The fade's copies are
   `LodData._fadeIn` / `_fadeOut`. The `LOD` add hook calls `enableLodDither` on the level materials
   unless the LOD's `fadeSeconds` is 0 (it now returns whether it changed one; then a `preWarm` mesh
   pre-warms its own level too). Skinned meshes don't fade (a plain copy wouldn't be skinned).
   `fadeSeconds` is in `*.mesh.json` (and so in scene overrides) and passes through `AUTO`. Checked
   in testDebugScene (the p348 sphere and instance cell) on WebGPU and WebGL2: level fades, fades to
   and from culled, a change mid-fade, removing the LOD and deleting the entity mid-fade; no copy
   left after any of them, and three's render-object count back to its baseline after repeated
   fades. Cost (WebGPU, Apple GPU, frame CPU time, 1,024 plain LOD spheres all switching at once via
   `forceLevel`): the change frame takes 40 ms with fades against 5 ms instant, about 35 µs per mesh
   (3 µs of it in `lodApplySystem`, the rest is three creating the copy's render objects for its
   first draw, main and shadow pass). During the fade, 5.6-6.3 ms against 3.5 ms steady (every mesh
   drawn twice); `lodFadeSystem` 0.1 ms; the end frame (disposing 1,024 copies) 5.7-6.9 ms. An
   InstancedMesh's copy costs 11-14 ms per fade (the instance cell), because three builds an
   InstancedMesh's shaders per object (main and shadow pass).
4. **Debug:** the LOD tab's fade time scale (slow motion, to judge the fades), the fade seconds
   override (0 = pop) and the count of entities fading; the LOD window shows an entity's fade.
   — done: the tab's Fades folder has "Fade seconds" (the global `setLodFadeSeconds`, with a reset
   to the app's value, like the bias: a LOD's own `fadeSeconds` still wins, and a debug override
   that forced fades on a LOD with `fadeSeconds: 0` would draw two whole copies, its materials
   undithered) and "Time scale" (the `fadeTimeScale` debug option, which `lodFadeSystem` multiplies
   `dt` by: 0 holds every fade, "Real time" resets it). "Last frame" shows `fading` and `fadeMs`,
   and a fading mesh's row says so. The LOD window's State reads "fading level 0 → 1",
   "fading out level 1 to LOD culled" or "fading in level 2 from LOD culled" with the progress,
   its Fade row the duration and where it comes from (own / global, or why the entity never
   fades), and its level table marks the outgoing level ▷. For that, `LodData._fadeFrom` keeps
   the level shown before the fade (-1 from culled). Checked on WebGPU in largeWorld (pool
   instances: level fades and fades to culled held at time scale 0, the reset buttons, 0 = pop)
   and testDebugScene (the sphere and the instance cell: level fades and fades to and from
   culled, no copy left after).
5. **Close the phase:** the exit below measured, As built, CLAUDE.md's LOD sections, versions and
   CHANGELOG. — done: the versions stay as Phase 1 set them (engine 4.11.0, app 1.6.1: one bump
   per branch, CLAUDE.md's rule, over §4's "minor per phase"), and the branch's CHANGELOG entry
   gets Phase 2.

**Exit:** in largeWorld nothing pops: the trees cross-fade between their levels and the cross-quads,
the bushes fade out at their cull distance, with `fadeSeconds: 0` everything switches instantly as
before; draw calls stay one per non-empty level mesh; shadows don't darken during a fade;
`lodFadeSystem`'s cost per frame and the plain-mesh fade's per-object cost are measured.

As built:

- Exit, measured in largeWorld (WebGPU, Apple GPU, 1200×800, `?isDebug=true`) by a frame recorder
  after the render: every `LOD` entity whose shown state (its applied level, or LOD culled) changed
  since the last frame must have TAG_LOD_TRANSITIONING.
  - Nothing pops: a camera dolly from the overview camera to 20 % of its distance and back (8 s
    each, 2,522 and 2,177 changes) and five bias steps (10,847 changes, up to 3,251 entities fading
    at once) all faded, with no pop. With `fadeSeconds` 0, all 4,134 changes of two bias steps
    switched in their frame and nothing faded.
  - The exit found one pop: a bush LOD culled at its first selection (`applied` -1) appeared
    whole the first time it was shown, as the "first apply never fades" rule took it for the load.
    Showing an entity from LOD culled now fades even when it's its first apply
    (`prepareChange`'s `isShowing`, `LodSystem.ts`): nothing of it was drawn before. 620 pops on
    the dolly in before the fix, 0 after.
  - Draw calls: 94 with every tree and bush held half way through a fade, 94 before it (same
    non-empty level meshes); 91 after, when one level mesh had emptied (one draw per pass). A
    fade adds no draw.
  - Shadows: with 1,703 entities held at 0.5, the mean luma of the frame's rows at 40-70 % of its height
    (dense trees and their shadows) is 55.71, between before (55.62) and after (55.92). Drawing both
    copies whole instead (the dither off) drops it to 55.14: the metric sees doubled shadows, and
    the complementary split has none.
  - `lodFadeSystem`: 0.02-0.03 ms per frame on average during the dollies (up to 127 fading,
    0.14 ms at most), 0.3 ms on average for the bias steps (up to 3,251 fading, 0.57 ms at most).
  - The plain-mesh fade's per-object cost is section 3's: about 35 µs per mesh in the frame a fade
    starts (three building the copy's render objects), the mesh drawn twice during the fade.
- Everything else is in the sections' notes above.

Out of Phase 2: alpha coverage per mip (Phase 1's note) needs a thin asset; p308's leaf cards
check it.

### Phase 3 — Octahedral impostors — done

Bake, material, three-frame blend with depth parallax, hemi option. The impostor material gets
`enableLodDither` like any pool level material, so the switch to and from it cross-fades (Phase 2).

What changed from §2.2 when the code was read:

- The name is `generateOctahedralImpostor`, like `generateCrossQuads`: the same contract
  (synchronous, registered assets owned by the loading scene, a later call with the same `id`
  returns them).
- three r186's instancing doesn't expose the instance matrix: `instancedMesh()` multiplies
  `positionLocal` by it before the material's `positionNode` runs (`Instance.js`,
  `NodeMaterial.setupPosition`). The billboard needs the instance's centre and rotation, so the
  impostor material reads the instance matrix itself, resolved per object when its shader is built
  (like the fade mask): a second binding of the same array.
- The shadow pass reuses `positionNode` (or `castShadowPositionNode`), `depthNode` and `maskNode`
  (`Renderer._getShadowNodes`), so in the shadow pass the billboard faces the light and shows the
  frame seen from it: the impostor casts its own silhouette shadow. Open question 1 becomes
  self-shadowing (the light-facing and the camera-facing quads are different planes through the
  centre); section 4 decides. A `FrontSide` material's shadow side is `BackSide`, so the material
  sets `shadowSide`.
- The albedo can't be the material's `map`: the shadow pass samples `map` with the geometry's uv,
  which the billboard doesn't use. Its alpha comes from `colorNode` (`_getShadowNodes` reads its
  `.a`).
- Normals are baked in the object's space, not a frame's view space (three frames with different
  view spaces are blended), and depth goes in the normal atlas's alpha.
- Atlas size: §2.2's 12 frames of 128 texels make 1,632² atlases (with 4-texel gutters), about 14 MB
  each with mips, two per asset. Default 12 frames of 64: 864², about 4 MB each.
- The exit's scene: largeWorld has two plain sphere rocks and a sky box without day-night. Section 5
  adds a rock pool and lists the day-night sky box.

Sections, each reviewed before the next:

1. **Bake** (`core/Lod/Impostors/OctahedralImpostor.ts`, `Octahedral.ts`): the octahedral maps (full
   and hemi) and frame bases, the `NORMAL_DEPTH` bake pass, dilation options, the atlases registered
   with their layout, the cache by `id`. No material yet. Checked by drawing the atlases (full,
   hemi, a rock) on WebGPU and WebGL2. — done: `generateOctahedralImpostor(geometry, material,
{ id, frames = 12, hemi = false, frameSize = 64, gutter = 4 })` returns `{ id, layout, albedo,
normalDepth }`. Frames show the bounding sphere (2-texel margin), from directions on an
   edge-inclusive `frames × frames` grid of the octahedral square (full: +y at the centre, the
   equator on the diamond, -y at the corners; hemi: the horizon on the square's edge, below it
   clamped onto it). A frame's camera axes are `getOctahedralFrameBasis(dir)`: up is +y on the
   image plane, -z within 0.999 of a pole; the material must rebuild them the same way. Frame
   (`i`, `j`) is the cell at texel (`i`, `j`) × the cell size from the image's top left on both
   backends (WebGPU viewports are top-down, WebGL samples render targets flipped). The
   `NORMAL_DEPTH` pass writes the object-space normal and, in alpha, the depth toward the frame's
   camera, `IMPOSTOR_DEPTH_MIN` (2/255) at -radius to 1 at +radius (`encodeImpostorDepth`), so 0
   stays "not covered"; it uses `NoBlending` (an opaque material's alpha is forced to 1) and the
   source's alpha test as a `maskNode`. Its dilation takes the found texel's alpha too, so depth
   doesn't fall toward the back at the silhouette. The layout (frames, hemi, sizes, the sphere's
   centre and radius, the frame's half extent) is stored on the albedo atlas's
   `userData.octahedralImpostor`. `getDominantMaterial` / `getShadingProps` moved from
   `CrossQuads.ts` to `ImpostorBake.ts` for section 2. Found in Phase 1's code: the normal pass kept
   the source's vertex colours, which three multiplies into `colorNode` (the normal); both normal
   passes now leave them out (no current source uses them). Checked with a marker object (a box,
   a red ball at +x, a blue ball at +z, a cone on top) and a toolkit asteroid, full and hemi: every
   frame upright and on the side its direction says, the normals by face, decoded depths within one
   8-bit step of the expected (1.012 / -0.028 / -0.193 against 1.025 / -0.025 / -0.175, one step
   0.032 at that radius); WebGPU and WebGL2 agree on 98.7-99.9 % of the pixels (the rest are
   silhouette edges). Cost (WebGPU, Apple GPU): a 12 × 12 bake takes 40-50 ms when the GPU is idle
   and settles at 105-115 ms when bakes follow each other, the same for a box as for the 500-
   triangle rock: it's per-frame overhead (7 render passes a frame), not geometry; 8 × 8 takes
   26 ms. A rock's two default atlases are 864², 3.98 MB each with mips.
2. **Material, nearest frame:** the quad geometry (with the object's bounds), the billboard
   `positionNode` (perspective and orthographic cameras, the instance matrix read per object), the
   frame picked from the view direction in the instance's space, the normal from object to view
   space, the alpha cut through `colorNode`, the shading model as cross-quads pick it, `shadowSide`.
   Checked on a test pool forced to the impostor level, WebGPU and WebGL2. — done:
   `generateOctahedralImpostor` also returns (and registers) `geometry` (`id`) and `material`
   (`${id}.mat`), with the options `alphaTest` (0.5) and `shading` (`AUTO`); the nodes are in
   `OctahedralImpostorMaterial.ts` (`createOctahedralImpostorNodes`, `createOctahedralImpostorQuad`)
   and the TSL maps next to the CPU ones in `Octahedral.ts` (`encodeOctahedralNode`,
   `decodeOctahedralNode`, `getOctahedralFrameBasisNode`). The second instance-matrix binding is
   always an instanced attribute over a second GPU buffer on the same array (three's own is
   private), its version synced from the matrices' before each draw (an `OBJECT` `updateBefore`):
   64 B × capacity more GPU memory per impostor mesh. On a plain mesh it's the identity, so the
   material works there too. The quad's corners are ±`extent` in its xy plane, turned by the view
   direction's frame basis (in the instance's space, so it shows the object upright as rotated);
   its bounds are the bounding sphere, so culling and LOD screen sizes measure the object. A
   corner's frame coordinate is its projection onto the nearest frame's image plane, clamped to the
   frame in the fragment stage (that also takes care of the roll between the view's and the frame's
   basis near the poles). Orthographic cameras are detected at runtime (`projection[3][3]`), so one
   shader serves both kinds, and a directional light's shadow camera gets its forward. The normal
   goes through the inverse transpose of model × instance, then the view matrix, as three column
   varyings. Double-sided instead of a `shadowSide`: the quad always faces whoever draws it, so
   that costs nothing, and the shadow pass (side null → double) and mirrored instance matrices
   draw it too. `map` stays unset (the shadow pass would sample it with the quad's uv); a lit
   material has `normalDepth` as its `normalMap` for the tooling, like cross-quads. Checked with a
   flat-shaded asteroid coloured by side, beside its impostor from the same camera (orbit at 0° and
   35°, 60°, 80°, straight down and up, -45°, hemi, a plain mesh, an orthographic camera), and with
   a 5 × 5 instanced LOD pool in the running app forced to each level, an instance moved and one
   despawned while on the impostor level: every view upright and on the same side as the mesh,
   matching shading, the moved and swap-removed instances read their own matrices; WebGPU and
   WebGL2 agree, no errors. Left for later sections, as seen: the frame snaps when the nearest one
   changes (3), the hemi map from below shows the horizon frames (3), the quad's flat depth through
   the centre (it cuts into neighbours differently from the mesh; 3 / 4), and dark streaks of
   self-shadowing on lit sides from the light-facing shadow quad (4).
3. **Three-frame blend and depth parallax:** the three nearest frames with barycentric weights, each
   frame's UV from the view ray's intersection with its plane, offset by the sampled depth; hemi
   views from below the horizon. Checked from every angle, overhead included, and at the frame
   boundaries (no popping as the camera orbits). — done: the vertex stage passes the corner's
   offset from the centre, the view ray through it (both linear over the quad, so interpolated
   exactly; an orthographic camera's is its forward) and the view direction's grid position; the
   fragment stage takes the grid cell's diagonal triangle (base and far corners, plus the corner
   on the view's side), weights `1 − max(f)`, `|fx − fy|`, `min(f)` (continuous across cells and the
   diagonal), and per frame rebuilds its direction and basis, crosses the ray with its image plane
   and takes two parallax steps (`PARALLAX_STEPS`: each samples the depth where the last landed and
   moves along the ray to it), then samples albedo and normal-depth there; the colours (alpha
   included, for the cut) and object-space normals are blended by weight. Every sample uses the
   plane uv's gradients, as the parallax offset jumps at depth edges. 12 samples a pixel (4 per
   frame); section 5 measures the cost. The quad's roll no longer matters (the rays pick the
   texels). Hemi below the horizon: the frames clamp to its edge, and the parallax fades out
   between about -20° and -45° (`HEMI_PARALLAX_FADE`, by the view direction's y), so from well
   below the horizon frames are drawn as the flat cards they are: stepping along a steep ray
   through a side view tore the image apart there. Checked with section 2's harness plus sweeps
   (the asteroid, its impostor beside it, no ground): orbits in 1° steps at 0°, 30°, 60° and 85°
   elevation, full -88° to 88° and hemi -60° to 30° in 2° steps, comparing each step's image
   change. The impostor's largest step is now 0.9-1.3× the mesh's (section 2's nearest frame:
   up to 18×, the pops), and the mean mesh-vs-impostor difference fell from 3.8-6.8 to 1.4-1.8
   (one parallax step: 1.7-2.5, with torn silhouettes at depth edges; two clean them up). Hemi:
   1.4-2.2 from 30° down to -30°, 4.8 at -40° and 12 at -50° (the card; the hemi map has no view of
   the underside). WebGPU and WebGL2 agree on the impostor as much as on the mesh in every view
   (76-100 % of the pixels within 16 levels, the rest the ground's shadow acne, the same on both
   halves). The pool check (forced levels, a moved and a despawned instance) still holds. Seen,
   not changed: the blend is softer than one frame (three 64-texel frames averaged; sharper at the
   switch distance than up close), and the quad's flat depth still cuts into neighbours (section
   4's `depthNode` option).
4. **Shadows** (open question 1): measure the impostor's own light-facing shadow, its self-shadowing
   on its camera-facing quad, and the options (a depth offset from the depth channel through
   `depthNode`, a cross-quad or lower mesh level through `castShadowPositionNode` / a shadow-only
   level, `castShadow: false`); pick one. Per-level `receiveShadow` if it needs it. — done: the
   baked surface's depth. Both passes write the depth of the point the pixel's ray meets (each
   frame's parallax landing point back on the ray, weighted by the frames' blend weights and
   coverage, as an uncovered frame's depth is the back) through `depthNode`, and the impostor
   receives its shadows at that point (`receivedShadowPositionNode`), out along its normal by one
   frame texel (`SHADOW_OFFSET_TEXELS`). The shadow pass already took the light-facing quad and its
   frames from section 2; now its depth is the surface's too, so the camera's surface point is
   compared against the light's. No per-level `receiveShadow` is needed. Found in three r186:
   `VSMShadowMap` (the app's) draws every _receiving_ object into the shadow map whatever its
   `castShadow` (`ShadowBaseNode.js:90`), so `castShadow: false` alone doesn't remove an
   impostor's shadow, nor its light-facing quad from its own self-shadowing; a shadow map renders
   once per camera and node frame (`ShadowNode.updateBefore`), and a NodeMaterial `clone()` loses
   `alphaTest` (`NodeMaterial.copy` skips `_alphaTest`; nothing in the engine clones materials).
   Sections 2 and 3's harness drew both halves in one node frame, so its impostor half received the
   mesh's shadow map. Measured with the asteroid beside its impostor (scale 1.3, a VSM sun at the
   MEDIUM preset, three sun directions at 30°, 50° and 75°, each from its side, across it and from
   behind; each variant against the mesh):
   - Its own shadow on the ground (the object cast-only on its own layer, seen from above): shadow
     mask IoU 0.98-0.99 against the mesh's, area 0.99-1.00, with flat quads and the surface depth
     alike. The light-facing quad casts the right silhouette; it was never the problem.
   - Self-shadowing (no ground), the share of the object's pixels in shadow, mesh / impostor: flat
     quads 8-14 % / 30-44 % on lit views (a straight dark half: the camera's quad behind the
     light's), mean luma difference 15-35; the surface depth with no offset 9-14 % / 12-15 %, the
     excess acne (dark dots and slashes on lit faces, where the light's and the camera's frames
     disagree by about a texel); with the one-texel offset within -3 to +1 points of the mesh in
     every view, luma difference 4.8-10.8 (`receiveShadow: false`: 5.2-11.0). From 1.5 texels it
     equals `receiveShadow: false` on this nearly convex rock: more offset removes real
     self-shadowing.
   - The main pass's surface depth also settles section 3's flat-depth note: a rock sunk into the
     ground meets it along its surface, like the mesh, where the flat quad cut a straight line.
   - WebGL2 agrees with WebGPU within 0.2 on every figure above.
   - Cost (WebGPU, Apple GPU, 800×400, 1,600 impostors of 0.6 scale in a grid filling the view, with
     a sun and a receiving floor): 2.15 → 4.33 ms a frame from a grazing view, 1.85 → 3.65 ms from
     a steep one with little overlap; shadows off, 0.67 → 1.51 and 0.38 → 0.84 ms. Writing depth
     costs about the same in both passes, overlap or not: on a tile-based GPU a shader that writes
     depth turns off hidden-surface removal, so every fragment is shaded. Of an impostor's shadow
     cost, the cast pass is nearly all (1.4 ms here, every fragment running the 12-sample blend for
     its alpha), receiving next to nothing. Section 5 measures it at largeWorld's real coverage; if
     it matters there, the options are a flat mode (no `depthNode` / `receivedShadowPositionNode`,
     `receiveShadow: false`: loses shadows from neighbours, which under VSM needs per-level
     `receiveShadow` in the pools) and a cheaper shadow-pass blend.
5. **largeWorld rocks:** a rock pool (toolkit asteroids: the mesh, a lower level, the impostor last),
   the day-night sky box listed in the scene, the exit measured. — done: 300 rocks scattered on the
   terrain (scale 0.6-1.6, a third of each one's height in the ground, by its bounding box), the
   asteroid (seed 11, shape 1.25 × 0.75 × 1, 500 triangles) at levels 0 (screen size ≥ 0.05, about
   50 m at scale 1), the same rock at icosphere detail 1 (80 triangles, ≥ 0.025, about 100 m) and a
   hemi octahedral impostor last (they turn about y only and sit in the ground). From the overview
   camera: 4 at level 0, 79 at level 1, 217 impostors. The scene lists `dayNight` after `basicSkybox` (still its
   default). Found in the code: `dayNight` brings its own sun light, so largeWorld's sun and
   ambient would stay on beside it, all night; the scene now turns both off while the active sky
   box has a sun light (`onSkyBoxChange` + `getSkyLightIds`) and back on with `basicSkybox`. The
   scene's JSON lights are created after its scene file runs (`createNextSceneObject3Ds`, after the
   default sky box), not before as `largeWorld.ts`'s header said, so the first sync runs on enter.
   Exit, measured (WebGPU, Apple GPU, 1200×800) on the rock nearest (5, 5) (scale 0.87) with only
   the terrain and the rocks drawn, from 15°, 30°, 60° (each at three azimuths) and straight down,
   forcing each level (`forceLevel`, fades off), its pixels masked against a render without rocks:

   - At the impostor's switch distance (where screen size drops below 0.025 × 0.9, 95 m here; the
     rock 18 px tall), against level 0, the mesh it was baked from: mean luma difference 5.6-8.0,
     mask IoU 0.80-0.88, area 0.90-0.99; overhead 5.6 / 0.87 / 0.99. At half that distance
     3.6-5.5 / 0.88-0.92. Against level 1, which it replaces: 12.8-17.6. For scale, level 1 against
     level 0 at their own switch (47 m): 15.0-19.7. So the impostor switch is the subtler one.
     One more view (az 0°, 15°: 21.6 / 0.77 / 0.88) is left out: an animated object in front of the
     rock (also in the no-rock render) moves between renders; the hovering crate did the same at
     az 120°, 15° until every other object was hidden.
   - Night (`dayNight` held at 12:00, 18:30 and 0:00, the same rock and distance, 30° and overhead):
     the impostor's mean luma night / noon 0.074-0.082 against 0.072-0.080 for levels 0 and 1, dusk
     / noon 0.060-0.065 against 0.058-0.064. It darkens with the meshes. (Midnight is lighter than
     dusk: the moon's light.)
   - Cost, the overview camera's frame rendered 150 times per variant, GPU queue timed (no PostFX):
     4.36 ms without the 217 impostors, 4.70 ms with them (+0.34 ms), 4.45 ms with the impostor
     material's `depthNode` and `receivedShadowPositionNode` removed (+0.09 ms), 4.39 ms drawing
     the same instances as level 1's 80-triangle mesh (+0.03 ms). Section 4's surface depth is most
     of the impostor's cost here (its depth write turns off the tile GPU's hidden-surface removal),
     and an impostor of this rock costs more than its 80-triangle level: an impostor pays off for
     heavier meshes, which this rock isn't.
   - WebGL2: the scene renders the same, no errors.
   - First measured with the rocks two thirds in the ground (a placement bug: the centre below the
     surface), which the surface depth drew right; the figures above are with the fix.

   The opt-out (after review): `generateOctahedralImpostor`'s `surfaceDepth: false` draws the quad's
   flat depth and receives no shadows, through the material (`receivedShadowNode` returning 1), not
   a per-level `receiveShadow` in the pools: the material holds on any mesh, and the flat quad must
   never receive (section 4's dark half). It still casts its silhouette. Checked on largeWorld's
   rock (a second bake swapped onto the impostor level): +0.09 ms from the overview against the
   surface depth's +0.34 ms; against level 0 at the switch distance from 30°, 60° and overhead,
   luma difference 5.6-11.0, IoU 0.75-0.88, area 0.83-0.99 (the surface depth: 5.6-7.1,
   0.83-0.88, 0.90-0.99); night / noon 0.084 against level 0's 0.080. Where it differs: the
   terrain cuts it along a straight line, and it has no self-shadowing. With the rocks two thirds
   in the ground, it lost most of each rock (area 0.32 from above: a flat quad through a buried
   centre is underground), so it's for objects standing on the ground. largeWorld keeps the
   default.

6. **Close the phase:** As built, CLAUDE.md's Impostors section, versions and CHANGELOG. — done:
   the versions stay as Phase 1 set them (engine 4.11.0, app 1.6.1: one bump per branch, as in
   Phase 2), and the branch's CHANGELOG entry gets Phase 3. `readme.md`'s cross-quad feature became
   one Impostors feature, and the Roadmap's "octahedral impostor LODs" became Phase 4's exported
   atlases. CLAUDE.md's Impostors section gets octahedral impostors and the three r186 traps
   above, its Sky box section largeWorld's sky light handoff.

**Exit:** a rock impostor holds up from any angle (including overhead) at its switch distance, and
it darkens at night with the rest of the scene.

As built:

- Exit, met (section 5's measurements, largeWorld's rocks, WebGPU): at the switch distance the
  impostor differs from the mesh it was baked from less than level 1 does from level 0 at its own
  switch (mean luma difference 5.6-8.0 against 15.0-19.7), from 15° to straight down (overhead
  5.6, mask IoU 0.87); with the day-night sky box it darkens with the meshes (night / noon
  0.074-0.082 against 0.072-0.080). WebGL2 agrees.
- `generateOctahedralImpostor(geometry, material, { id, frames = 12, hemi = false, frameSize = 64,
gutter = 4, alphaTest = 0.5, shading = 'AUTO', surfaceDepth = true })` in
  `core/Lod/Impostors/OctahedralImpostor.ts`, the maps in `Octahedral.ts` (CPU and TSL, which must
  agree), the nodes in `OctahedralImpostorMaterial.ts`. Sections 1-5's notes have the details.
- Cost: a 12 × 12 bake 40-115 ms (it scales with the frame count, not the triangles), two 864² atlases of about 4 MB each
  with mips; 12 texture samples a pixel. With the surface depth, an impostor costs about four times
  the GPU time of the flat quad (217 rock impostors from largeWorld's overview: 0.34 against
  0.09 ms), and more than the 80-triangle rock it replaces there (0.03 ms): impostors pay off for
  heavier meshes. Phase 4 removes the bake at load, not the draw cost.
- Open question 1 is settled (§5). Left as seen: the blend is softer than one frame up close, and
  a hemi impostor from well below the horizon is drawn as flat cards.

### Phase 4 — Exported atlases — done

A debug "Export" button writes an impostor's atlases into the repo through the dev file server
(`_DONE_p342`); p300 encodes them as KTX2, and a scene that lists the impostor loads it instead of
baking. Both impostor kinds export (octahedral first, cross-quads last), through one asset type.

Decided before it started (the design review of Phase 4's first draft; each point names what it
replaced):

1. **One PNG per atlas, through a p299 extension.** p299's atlas composes each slot from per-cell
   sources (resized into the cell, edge-extended), and a cell without a source is an error. The
   bake has already composed and dilated the whole atlas, so p299 gets a whole-image slot source
   (`slots.<name>.image`: that slot skips composition, every cell needs a `rect`). Not 288 PNGs
   per impostor (one per frame and slot): that recomposes what the bake composed, and as the file
   server can't delete (`_DONE_p342` §5), a re-export with fewer frames would leave stale ones.
2. **A full mip chain.** p299 stops the chain at the last level its padding protects. The bake's
   72 px cells (64 + 2 × 4) keep levels 0-1 there, so a frame would never get below 32 texels and
   shimmer at distance, unlike the runtime bake (a full chain, `generateMipmaps`), which Phase 3
   measured. p299 gets `mipChain: "FULL"` (the exact box down to 1 × 1, cells mixing past the
   protected levels): neighbouring cells are neighbouring views of the same object, dilated, as in
   the runtime bake. Not a larger gutter: 8 keeps levels 0-2 at 960², 16 keeps 0-3 at 1152², over
   the default `maxSize` of 1024 (level 0 dropped).
3. **Codecs per slot.** Albedo (sRGB colour, cut alpha): the default `baseColor` profile (UASTC,
   RDO 2). `normalDepth` (object-space normal in RGB, depth in alpha, linear): slot `data` with
   UASTC, `rdo: 0`, zstd on. Not `normalMode` (two channels can't hold an object-space normal and a
   depth), not codec `none` (p299 slots are KTX2 only). Depth error moves the parallax sample and
   the written depth, and Phase 3 section 4's one-texel shadow offset is tuned to one 8-bit step;
   section 5 measures it. A cross-quad normal atlas is a `normal` slot. UASTC is 8 bits a texel
   on the GPU: a rock's atlas drops from about 4 MB (RGBA8 with mips) to about 1 MB.
4. **`*.impostor.json` holds everything the material needs**, not only "frame count, bounds and
   the atlas id": `kind` (`OCTAHEDRAL` | `CROSS_QUADS`), the atlas id, the kind's layout (for
   octahedral the whole `OctahedralImpostorLayout`), `alphaTest`, `surfaceDepth`, the resolved
   shading (`getShadingProps`' `{ type, params }`, never `AUTO`: the source material isn't needed
   at runtime), a format version (`IMPOSTOR_EXPORT_FORMAT_VERSION`, bumped when the depth
   encoding, the frame maps or the layout's meaning changes; an older one is refused, with a
   re-export hint) and a source fingerprint (a hash of the source geometry's attributes and index,
   the resolved shading and the bake options). In the debug env, using an export compares its
   fingerprint against the geometry and material passed in and warns "stale, re-export" (a
   procedural rock whose seed changed would otherwise keep its old impostor); production skips the
   hash.
5. **One synchronous call, the scene lists the impostor.** A scene JSON's new `impostors: [id]`
   is expanded by the gatherer into the atlas's slot textures (like p299's atlas id in
   `textures`), so `SceneLoader` loads them before the scene file runs, unchanged.
   `generateOctahedralImpostor` / `generateCrossQuads` with that `id` then find the gathered JSON
   (generated data, no load) and the loaded slots, and build the quad (or planes) and the material
   from them without baking. Not listed, not exported, or an older format: they bake as now. No
   `loadImpostorAsync`: app code keeps one path, and largeWorld's adoption is a scene JSON line.
6. **Cross-quads export too**, as the phase's last section: the export, the JSON, the scene
   listing and the fingerprint are shared; only their layout (planes, frame size, the planes'
   placement) and rebuilding the plane geometry are their own. Leaving them out would mean a
   second format later.
7. **The button lives in the LOD tab**, an "Impostors" folder: one row per impostor generated in
   the current scene (id, kind, baked / exported / exported but stale, atlas size, bake ms) with
   Export, plus Export all. Re-exporting an exported impostor bakes it again from its source (the
   registry keeps the geometry and material the call got), never reads the KTX2 back.

Sections, each reviewed before the next:

1. **p299 extensions:** `slots.<name>.image` (a ready-made image of the layout's `size`; that slot
   is not composed: no resize, edge extension or fill; every cell needs a `rect`; a cell needs no
   `sources` when every slot has an `image`; the image's size is checked by the synchronous header
   read) and `mipChain: "PROTECTED" | "FULL"` (default `PROTECTED`; `FULL` computes every level
   with `images.ts`'s exact box and doesn't warn about unprotected levels). Both in the schema,
   `textureAtlases.ts` (layout, cache key, composition) and the cell table's `levels`. A third test
   atlas in the `textureAtlases` scene: a ready-made 2-slot image with a full chain, each cell
   through its rect at every level. p299's D3 notes these (done with this plan update). — done:
   `image` is resolved like a cell source (a file relative to the JSON or served from src/public,
   or a texture asset's id); its header size must be the atlas's `size`, else the gather fails
   naming it, and the encode checks it again. With an image slot every cell needs a `rect`, and a
   cell's source in an image slot is an error. Changed from the rule above: a cell with no
   `sources` is fine as soon as _one_ slot has an image (it is in that image), not only when every
   slot has one; a composed slot without the cell gets its fill as before. `image` and `fill`
   exclude each other (schema). `mipChain: "FULL"` stores every level down to 1 × 1: exact halving
   while the size is even, then `resizeImage`'s area filter to the GPU's `floor(size / 2)` (a
   192² layout goes 6² → 3² → 1²), and the protected chain's warnings are off. `__atlas.levels`
   keeps its meaning (the levels kept apart) and `__atlas` gets `mipChain: "FULL"` and
   `fromImage: true` when set; the runtime's level check takes the full chain's count for a FULL
   slot (`getAtlasSlotInfo`, `Texture.ts`, inline: core imports no zod), and the Assets tab shows
   the mip chain and "a ready-made image". The cache key gets `mipChain` and `image` only when set,
   so the existing atlases kept their keys (all cache hits). The run labels an image slot "9 cells
   in an image, full chain". Test asset: `p299TestAtlasImage` (192², padding 4, 3 × 3 frames of
   56 px, an albedo slot of alpha-cut discs with dilated colour and a `normalDepth` slot, decision
   3's `data` / UASTC / `rdo: 0`), from two generated PNGs in `source/p299Atlas/`. Decoded: level
   0 of albedo equals its image exactly, `normalDepth` within 1.3 / 255; 8 levels, the 1 × 1
   texel's alpha 95 / 255, the discs' area share. The scene draws it off to the side with its own
   camera ("Ready-made image atlas", quads `image_*`): each slot at each level and its source
   image, each cell at every level; `results.imageSlots`, and `errors.fullChainAsProtected` (the
   file read without `mipChain` fails). Checked on WebGL2 (SwiftShader, WSL2): frames upright,
   levels 0-2 clean, the cells mixing from level 3. WebGPU not checked here (no headless WebGPU on
   WSL2).
2. **Asset type and registry:** `schemas/impostorSchema.ts` (decision 4, a discriminated union by
   `kind`), the `.impostor.json` suffix in `gatherAppData.ts` (validated, its atlas must exist and
   have the kind's slots; impostor ids in their own id space), the generated data's impostors, the
   scene schema's `impostors` expanded into the atlas's slot ids. The impostor registry
   (`core/Lod/Impostors/ImpostorRegistry.ts`): every impostor generated in this session by id, its
   kind, where it came from (`BAKED` | `EXPORTED`), its bake ms, and (for re-exports) its source
   geometry, material and options, released with the impostor's assets. The source fingerprint
   (`getImpostorSourceHash`). No behaviour change yet. — done: `ImpostorAssetSchema`
   (`schemas/impostorSchema.ts`) is a discriminated union with the `OCTAHEDRAL` branch only
   (section 6 adds `CROSS_QUADS`): `atlas`, `formatVersion`, `sourceHash`, `alphaTest`, `shading`
   (`{ type, params }`, `specular` as a hex string), `layout` (its `atlasSize` checked against
   `frames × (frameSize + 2 × gutter)`) and `surfaceDepth`, all required (a tool writes them).
   `IMPOSTOR_EXPORT_FORMAT_VERSION` (1), the kinds and their atlas slots (`IMPOSTOR_ATLAS_SLOTS`)
   are in `core/Lod/Impostors/ImpostorFormat.ts`, which imports nothing, so the schema, the
   gatherer and the runtime share them. The gatherer fails an impostor whose atlas is missing,
   lacks a slot its kind reads or isn't the layout's size, and warns about another format version
   (the runtime bakes it). Changed from the text above: a production gather keeps only `scenes`,
   so a scene's `impostors` is expanded into the impostors' definitions (`ImpostorDef`, on
   `SceneData.impostors`), not only into slot ids; the slots the kind reads (not every slot of
   the atlas) are added to the scene's `textures` before those are resolved, so a slot also listed
   by its atlas loads once, and the production output check covers them. The top-level
   `impostors` registry is dev data. An id with no valid `*.impostor.json` warns and is left out
   (it bakes). The registry (`ImpostorRegistry.ts`: `recordImpostor`, `getImpostorRecord`,
   `getImpostorRecords`) gets both generators' bakes with their wall time; its record keeps the
   source (geometry, material, the call's options) in the debug env and prod test mode only, and
   is dropped when the impostor's geometry is deleted (`onGeometryDeleted`). The fingerprint
   (`ImpostorSourceHash.ts`, 64 bits: MurmurHash3 in two seeded lanes, synchronous) covers every
   geometry attribute by name, the index, groups and draw range, what the bake reads of the
   materials (colour, map and alpha map by registered id, alpha test, opacity, side, vertex
   colours, flat shading, a `colorNode` as there or not: beyond the decision's text, as the
   rock's colour is a material param), and the settings `resolveOctahedralImpostorOptions` /
   `resolveCrossQuadsOptions` return (the defaults and the resolved shading, which the
   generators now take their own options from). Checked: the gatherer with a temporary impostor
   over `p299TestAtlasImage` (its 3 × 3 frames of 56 + 2 × 4 make 192), in a dev and a production
   gather, and each error; the hash in Node (a 1e-6 vertex move, a colour, an option, the index,
   the groups each change it; key order doesn't; a 16k-triangle torus knot in 0.75 ms); largeWorld
   on WebGL2 (SwiftShader): both impostors recorded with their sources, the rock's fingerprint the
   same on two loads, both records gone after leaving the scene.
3. **Export:** read each atlas render target's level 0 back (`readRenderTargetPixelsAsync`; rows
   flipped where a backend reads bottom-up, checked on WebGPU and WebGL2), `encodePNG` it (byte-
   exact: a transparent texel keeps its dilated colour), and write one `writeDevFiles` batch: the
   PNGs, the `*.textureAtlas.json` (`image` slots, one cell per frame with its `rect`, `mipChain:
"FULL"`, decision 3's `optimize`) and the `*.impostor.json`, into `src/app/impostors/`
   (`AppConfig.lod.impostorExportDir`). A re-export reads both JSONs first and passes their
   `expectedHash`. `onDevDataGathered` shows the gather's asset errors (a failed KTX2 encode, a
   budget) as a toast before the reload. When `getDevFilesStatus()` is unavailable (a LAN device
   without `AEK_DEV_FILES_LAN`, prodTest), the button downloads the four files with the paths to
   put them at. The LOD tab's Impostors folder (decision 7). Checked by exporting largeWorld's rock:
   four files written, the gather encodes both slots (`assets.lock.json`), the Assets tab shows the
   cells; a second export is `unchanged`. — done: `core/Debug/Lod/_dbg__ImpostorExport.ts`
   (`exportImpostorsAsync(ids)`, `getImpostorExportState(record)`). Every export bakes again from
   the record's source, into fresh targets: the atlas bake is split out of
   `generateOctahedralImpostor` as `bakeOctahedralImpostorAtlases(geometry, material, settings,
id)` (unregistered targets, the caller disposes them), so a first export and a re-export are
   the same path and the PNGs are what the written fingerprint describes. The readback is
   `readRenderTargetImageAsync` (`_dbg__TexturePreview.ts`, the previews' row reader: WebGPU pads
   rows to 256 bytes, WebGL reads them bottom-up). Files: `<dir>/<id>.impostor.json`,
   `<dir>/<id>.textureAtlas.json` and `<dir>/<id>.albedo.png` / `<id>.normalDepth.png` beside the
   atlas JSON (`image: "./…"`), cells `f<i>_<j>` with their rects; the JSONs carry an explicit `id`
   and a `debugData` saying "re-export, don't edit". The atlas id is the impostor's, so its slot
   textures are `${id}.albedo` / `${id}.normalDepth`, the ids the runtime bake registers: section 4
   relies on that, and must stop `getRegistered` / `deleteLeftovers` from taking the loaded slots
   (they have no layout in `userData`) for a bake's leftovers. A re-export writes wherever the
   gathered impostor and its atlas are (their `__sourcePath`), so moved files stay where they are;
   `impostorExportDir` (default `src/app/impostors`) is for new ones. A cell size that isn't a
   multiple of 4 is refused before baking (block compression). "Export all" is one batch, so one
   gather and one reload. The gather's note (written and encoded, an atlas slot's asset error, or
   a failed gather) is a toast, kept in `sessionStorage` over the reload and shown again once the
   debug toaster exists. Found in the code: the LOD tab loads in the debug env only, so prodTest
   never gets there; the fallback covers a LAN device, `AEK_DEV_FILES=false` and a debug build
   without the dev server. The Impostors folder: the dev files' state, then per impostor its
   kind, origin (baked / loaded from its export), export state (not exported / up to date / stale
   / another format / no source), atlas size and bake time, with Export (Re-export once exported);
   cross-quads are listed with Export disabled until section 6. Checked on WebGL2 (SwiftShader,
   WSL2) against the running dev server: largeWorld's rock exported, four files written, both
   slots encoded (UASTC, 10 levels down to 1 × 1, 3.98 → 1.00 MB of GPU memory each; albedo
   81 KB, normalDepth 768 KB on disk), `assets.lock.json` and the dev data's cell table (144
   cells) updated, the page reloaded with the note; after the reload the rock reads "export up to
   date" (the fingerprint is the same in a new session) and a second export is `unchanged` (no
   gather). Orientation, checked apart from the reader: each frame's mean object-space normal
   over the texels it covers points along its own bake direction (mean dot 0.97, least 0.90; the
   rows read flipped: 0.34, least -1). With the status route answering `enabled: false`, the
   button downloaded the four files (the PNGs byte-identical to the written ones) and listed
   their paths in a toast and the console. Not checked here: WebGPU (no headless WebGPU on WSL2),
   and the Assets tab's cells (no scene loads the atlas before section 5). An export on
   SwiftShader takes 26 s (the bake and two 864² PNG encodes in software).
4. **Load path:** the material and quad build split from the bake in `OctahedralImpostor.ts`
   (one `buildOctahedralImpostor(layout, albedo, normalDepth, opts)` both paths call). A loaded
   KTX2 atlas is stored v-up (p299: three's UVs), a render target has v = 0 at the top, so the
   material takes the atlas's v origin (a build-time constant per material, from the layout: no
   runtime cost); the frame maps in `Octahedral.ts` don't change. `generateOctahedralImpostor`
   uses an export when its JSON is gathered and its slots are loaded (decision 5), checks the
   format version and (debug env) the fingerprint, and otherwise bakes. Checked against a bake of
   the same rock under another id, both forced to the impostor level side by side, on WebGPU and
   WebGL2: the same frames, upright, the same side. — done: `buildOctahedralImpostor(layout,
albedo, normalDepth, { id, alphaTest, surfaceDepth, shading, vOrigin })` registers the quad and
   the material and stores the layout on the albedo atlas (so a later call with the id returns
   them, either origin). The v origin is `vOrigin: 'TOP' | 'BOTTOM'`
   (`createOctahedralImpostorNodes`' fourth argument, a flip in `toAtlasUV`), not a layout field:
   the layout is the exported JSON's (strict schema) and describes the image from its top left
   either way; the bake passes `TOP`, an export `BOTTOM`. The lookup is shared with section 6
   (`core/Lod/Impostors/ImpostorExports.ts`): `getImpostorExport(id, kind, caller)` finds `id` in
   the loading scene's `impostors` (else the current scene's), and refuses with a warning (the
   generator bakes) another kind, another format or a slot that isn't loaded, or that is
   registered but isn't a slot of the def's atlas (`getTextureAtlasInfo`);
   `warnIfImpostorExportStale` hashes the call's source and resolved options in the debug env
   only and warns, using the export anyway. Built from an export, the call's options other than
   `id` only feed that check: the export's layout, shading, `alphaTest` and `surfaceDepth` win.
   The record is `EXPORTED` with `bakeMs: null` and keeps its source, so a re-export bakes as
   before. Found in the code: `saveTexture` returns a texture already registered under the id, so
   a bake with the export's slots loaded under `${id}.albedo` / `${id}.normalDepth` would have drawn
   the loaded slot and leaked its render target. The bake path still clears them
   (`deleteLeftovers`), and the export path keeps them (`deleteLeftovers(id, true)`: only a
   leftover geometry and material go). The gatherer only warned about another format version and
   still listed the impostor's slots, which loaded for nothing and took those ids, so a scene now
   leaves such an impostor out (the runtime's format check stays as a guard). Left as it is: a
   scene that lists an impostor, entered from one that baked it under the same id, keeps the bake
   (the loader finds the baked textures under the slot ids and keeps them; the generator then
   finds the whole bake registered). Checked with largeWorld listing `largeWorldRockImpostor`
   (temporarily, section 5 adds it): the record is `EXPORTED`, the slots are the KTX2 atlases
   (864², 10 levels). The export, a bake of the same rock under another id (41 ms on WebGPU) and
   the mesh were each drawn alone into a 320² target from 7 views (15° at three azimuths, 40°,
   60°, overhead, 0°). Exported against baked: mean luma difference 0.48-1.01, mask IoU
   0.993-0.996, area 1.001-1.005. Each against the mesh: baked 1.49-3.05, exported 1.66-3.46,
   IoU 0.98 for both. A control with the wrong v origin: 8.5-27.2, IoU 0.72-0.90, so the figures
   see a flip. WebGL2 (SwiftShader) gives the same figures within 0.1. The export was made on
   WebGL2 in section 3 and its fingerprint matches on WebGPU (no stale warning), so section 3's
   readback holds on both backends. The quad deleted and the call repeated with `hemi: false`:
   rebuilt from the loaded slots in 1.6-1.9 ms, no bake, the stale warning logged. largeWorld
   with level 2 forced draws every rock through the exported impostor, with no errors.
5. **largeWorld rocks and the codecs:** largeWorld lists `largeWorldRockImpostor` in `impostors`.
   Measured with Phase 3 section 5's harness: the exported impostor against the runtime bake and
   against level 0 at the switch distance (15° to overhead, mean luma difference, mask IoU, area),
   its self-shadowing (no extra acne from the compressed depth; if there is, raise `normalDepth`'s
   UASTC `level` to the highest, then `rdo: 0` on albedo too, and record which settled it), the
   GPU memory tab's bytes per atlas, the scene load's time without the bake. Change
   the rock's seed: the debug env warns that the export is stale and the scene still runs. — done:
   `largeWorld.scene.json` lists `largeWorldRockImpostor`; the record is `EXPORTED` (no bake) and
   the scene's generated data carries the def and both slots. Measured on WebGPU (Apple GPU,
   1200×800) with Phase 3 section 5's harness, the same rock (nearest (5, 5), scale 0.87), the
   impostor level drawn with the exported material and then with a runtime bake of the same rock
   under another id (`hemi`, swapped onto the impostor mesh), against level 0:
   - At the switch distance (15°, 30°, 60° at three azimuths, overhead): exported against level 0
     mean luma difference 6.0-8.6, mask IoU 0.80-0.88, area 0.90-1.00; the bake 5.6-8.0 /
     0.80-0.88 / 0.90-0.99 (Phase 3 section 5's figures, again). Per view the export is 0.0-1.2
     above the bake. Exported against baked: 2.1-3.0, IoU 0.92-0.96, area 0.97-1.03. At half the
     distance 4.0-5.9 / 0.86-0.92 against the bake's 3.6-5.5 / 0.88-0.92, exported against baked
     1.5-2.1. Level 1 against level 0 at its own switch was 15.0-19.7 (Phase 3). az 0°, 15° is left
     out again, as in Phase 3: a moving object that isn't a child of the root scene (so the harness
     doesn't hide it) stands in front of the rock in a different place in each render.
   - Self-shadowing (no extra acne): largeWorld's rock alone in a private scene (scale 1.3, turned
     about y only), the shadowing sun of Phase 3 section 4 (VSM, MEDIUM preset, suns at 30°, 50°
     and 75°, each from its side, across it and from behind), mesh beside impostor. Share of the
     object's pixels in shadow against the mesh's: exported -0.9 to +3.3 points, the bake -1.3 to
     +1.9; exported against the bake -0.7 to +1.4 points, luma difference 1.3-2.1, IoU 0.92-0.98.
     Side by side the shadow bands are the same, no dots or slashes on lit faces, the export a touch
     softer. Decision 3's codecs stay as they are (neither fallback was needed).
   - GPU memory tab: 995,712 B per atlas (UASTC, 10 levels down to 1 × 1), against 3,980,317 B per
     atlas of the bake (RGBA8 with mips): 1.9 against 7.6 MB for the rock.
   - Scene load (`oneMoreScene` → largeWorld, four alternating rounds, the generated scene data
     patched in the page to drop the listing and its slots): listed 1,398-1,444 ms, baking
     1,440-1,477 ms (the record's bake 32-34 ms), so about 45 ms faster. Loading the two KTX2 slots
     adds no measurable time.
   - Draw cost from the overview camera (150 frames, GPU queue timed, 217 impostors): 5.26 ms
     without them, 5.49 ms exported, 5.50-5.51 ms baked. The compressed atlases sample at the
     same cost (the scene's base has grown since Phase 3's 4.36 ms; the impostors' share went from
     +0.34 to +0.23 ms).
   - Stale: with the rock's seed 11 → 12 the debug env warns once ("the export of
     'largeWorldRockImpostor' is stale … fingerprint 6afa4fc04bd2e912, now 87537a04fe84d025"), the
     scene draws from the export, no errors. Seed put back.
   - WebGL2 (SwiftShader): the switch distance's figures within 0.5 of WebGPU (exported 5.9-8.4,
     the bake 5.7-8.0, exported against baked 1.6-2.6). Its az 0°, 15° renders caught the app
     loop's own frame (software rendering is slow), left out too.
6. **Cross-quads:** the `CROSS_QUADS` kind (planes, frame size and gutter, each plane's placement:
   the radius around the vertical axis, the height and base), the plane geometry rebuilt from it
   with v-up UVs for a loaded atlas, the `normal` slot optional (`normals: false`), export and
   load as for octahedral. largeWorld lists `largeWorldTreeCross`; checked like section 5 against
   the runtime bake. — done: `CrossQuadsImpostorAssetSchema` (`kind: "CROSS_QUADS"`, `normals`,
   `layout`). Changed from the text above: the layout is what the bake used, not radius / height /
   base (the planes' margins and rounding would have to be recomputed): `CrossQuadsLayout`'s
   `planes`, `frameWidth`, `frameHeight`, `gutter`, `atlasSize` ([w, h], checked against them),
   `center` (where the planes cross) and `halfWidth` / `halfHeight`. `generateCrossQuads` is split
   like the octahedral one: `bakeCrossQuadsAtlases` (unregistered targets and the layout, what an
   export reads back) and `buildCrossQuads(layout, albedo, normal, { id, alphaTest, shading,
vOrigin })`, which rebuilds the planes with uvs for the v origin and flips the plane normal
   node's up (along -v on a bake's atlas, +v on a loaded one). `ImpostorAtlasVOrigin` moved to
   `ImpostorFormat.ts`. Found in the code: p299 refuses a cell rect that isn't a multiple of 4, and
   a cross-quad frame is sized from the object, so the bake now grows each frame by up to 3 texels
   until its cell is (split around the object). largeWorld's tree was already 76 × 128 in 84 × 136
   cells (252 × 136, unchanged). `normal` is no longer simply optional: `getImpostorDefSlots(def)`
   (`ImpostorFormat.ts`) is the slots an export reads, `normal` when its `normals` is true; the
   gatherer fails an atlas without one, a scene loads exactly those slots, and the runtime refuses
   (and bakes) when one didn't load. The export writes one cell per plane (`p<i>`), `mipChain:
"FULL"`, albedo with the `baseColor` profile and the normal atlas as a `normal` slot (resized
   as unit vectors). Bug found, in section 2's fingerprint: three r186's WebGPU backend replaces a
   16 or 8-bit integer index or attribute with a 32-bit copy on its first upload
   (`WebGPUAttributeUtils.createAttribute`), and the hash read the bytes, so the tree (a
   `Uint16Array` index) hashed differently before and after its first draw: the export (after)
   read stale at the next load (before). `getImpostorSourceHash` now hashes integer arrays as
   that 32-bit upload; 32-bit and float arrays hash as before, so the rock's fingerprint stands.
   Measured on WebGPU (Apple GPU, 1200×800) with section 5's harness on the tree nearest (5, 5)
   (scale 1.14), the cross-quad level drawn exported and then as a runtime bake under another id
   (its geometry and material swapped onto the level mesh), against level 1 (which it replaces)
   and level 0, from 5°, 15°, 30° and 60° at four azimuths:
   - At the switch distance (below screen size 0.032 × 0.9): exported against level 1 mean luma
     difference 11.6-21.8, IoU 0.59-0.81, area 0.74-1.01; the bake 11.3-22.3, 0.70-0.89,
     0.86-1.20. Exported against baked: 6.2-11.7, IoU 0.80-0.90, area 0.82-0.92. At half the
     distance exported against baked 1.5-4.5, IoU 0.93-0.98, area 0.95-1.00. Level 1 against
     level 0 for scale: 7.0-11.4. Both cross-quads read much darker than level 1 from these
     views (the bake as much as the export: Phase 1's look, not this section's).
   - The export is thinner far away, mostly its trunks breaking up. Not the codec: decoded, the
     KTX2's alpha equals the PNG's at level 0, and its levels match the exact box chain within 1-3 %
     coverage; `rdo: 0` on the albedo (tried) changes no figure. It's the mips: the bake's GPU mips
     (read back) equal the export's at levels 1-3 (IoU 0.96-0.99), but at levels 4-5 (15 × 8,
     7 × 4: the switch distance samples levels 3-4) they hold mean alpha 72-77 against the true 65.
     three r186 generates odd-sized levels with a bilinear sample, which isn't area-preserving and
     keeps thin features above the cut; p299's `FULL` chain is the exact area filter, so its alpha
     test thins them as Phase 1's "no alpha coverage correction per mip" note expected. Decided
     (after review): accepted for this phase, as the switch from level 1 is no worse than with the
     bake; the fix is \_DONE_p341_alpha-coverage-mips.md (alpha scaled per level to level 0's
     coverage at the cut, in the pipeline), done before Phase 5, whose showcase puts cross-quads on screen.
   - GPU memory tab: 46,112 B per atlas (UASTC, 8 levels), against 182,738 B per bake atlas.
   - Scene load (four alternating rounds, as in section 5, the rock exported in both): listed
     1,376-1,414 ms, baking 1,388-1,408 ms (the bake 13-15 ms), about 15 ms faster. With both
     impostors exported largeWorld loads in about 1,385 ms, against about 1,450 ms with both baked
     (section 5).
   - Draw cost from the overview camera (455 cross-quad instances): exported 5.47-5.48 ms, baked
     5.48-5.49 ms, none drawn 5.11-5.13 ms.
   - Stale: the foliage colour one step off warns once ("fingerprint d926cf62b35cba4b, now
     df48ea43e5e2a6b8") and the scene draws from the export. A second export writes nothing (all
     four files `unchanged`): the bake is deterministic.
   - WebGL2 (SwiftShader; 5° and 30° at two azimuths, the forest is slow there): every figure
     within 0.4 of WebGPU's (exported against baked at the switch distance 7.1-12.0, area
     0.83-0.91; at half 1.6-3.9).
7. **Close the phase:** As built, the exit measured, CLAUDE.md (the data pipeline's suffix list,
   the Impostors section: export, the scene's `impostors`, the v origin), `readme.md` (the new asset
   JSON type; the Roadmap's exported atlases into Features), `docs/techniques/asset-optimization.md`
   (impostor atlases: `image` slots, `mipChain`, the slot codecs), versions and CHANGELOG. — done:
   engine 4.12.0 → 4.13.0 (the asset type, p299's extensions, the export and load paths), app
   1.7.0 → 1.7.1 (largeWorld's adoption, the exports, p299's test atlas), toolkit unchanged; the
   branch's CHANGELOG entry has a Project section for the gatherer and the asset pipeline.
   Found in the code: `asset-optimization.md` has no texture atlas section yet (p299 Phase 6's), so
   its new "Impostor atlases" section explains `image` slots and `mipChain` on their own and points
   at p299's schema for the rest. CLAUDE.md's suffix list lacked `*.textureArray.json`,
   `*.textureAtlas.json` and `*.postFx.json` too; added with `*.impostor.json`. Exit re-checked at
   the branch's tip (macOS, Chrome, `?isDebug=true`, `sceneTestECS` → largeWorld through the app's
   own `loadScene`): both records `EXPORTED`, `bakeMs: null`, sources kept; no warning or error
   during the load; 1,411 ms on WebGPU, 2,132 ms on WebGL2 (SwiftShader). The download fallback is
   kind-agnostic in the code (it downloads whatever files the kind built), so section 3's run on
   the rock covers the tree; not run again.

**Exit:** largeWorld's rocks and trees load from their exports, with no bake at load (the scene
load is faster by the rock's 40-115 ms and the tree's 12 ms); they look like the runtime bake
(Phase 3 section 5's comparison at the switch distance stays within the bake's own figures, no
extra self-shadowing acne); WebGPU and WebGL2 agree; the GPU memory tab shows about 1 MB per
atlas; a stale export warns in the debug env; with `getDevFilesStatus()` unavailable the button
downloads the files.

As built:

- Exit, met for the rocks, met with one accepted gap for the trees (sections 5-7's measurements,
  WebGPU on an Apple GPU unless named):
  - No bake at load: both records `EXPORTED` (section 7, both backends). Load: rock about 45 ms
    faster (its bake was 32-34 ms here, under Phase 3's 40-115 ms range: a faster machine), tree
    about 15 ms; largeWorld about 1,385 ms against about 1,450 ms with both baked.
  - Looks like the bake: the rock at the switch distance, exported 6.0-8.6 against level 0, the
    bake 5.6-8.0; per view 0.0-1.2 above the bake (so at most 0.6 over the bake's own range),
    exported against baked 2.1-3.0. No extra self-shadowing acne (decision 3's codecs kept). The
    trees: exported against level 1 IoU 0.59-0.81 against the bake's 0.70-0.89, outside the bake's
    figures. Its thin trunks break up at mip levels 3-4 under the exact box chain, where three's
    bilinear GPU mips keep them. Accepted after review; \_DONE_p341_alpha-coverage-mips.md fixes it
    before Phase 5.
  - WebGPU and WebGL2 agree: within 0.5 (rock) and 0.4 (tree) of each other.
  - GPU memory: 995,712 B per rock atlas (against 3,980,317 B baked), 46,112 B per tree atlas
    (against 182,738 B).
  - Stale warns once, for both kinds, and the scene draws from the export.
  - Download fallback: section 3 (the rock); the same code for the tree (section 7).
- What a later phase builds on: `*.impostor.json` (`schemas/impostorSchema.ts`, both kinds,
  `IMPOSTOR_EXPORT_FORMAT_VERSION` 1 in `ImpostorFormat.ts`), the scene's `impostors`, the
  generators' split into a bake (`bakeOctahedralImpostorAtlases`, `bakeCrossQuadsAtlases`) and a
  build (`buildOctahedralImpostor`, `buildCrossQuads`, with `vOrigin`), `getImpostorExport` /
  `warnIfImpostorExportStale` (`ImpostorExports.ts`), the registry (`ImpostorRegistry.ts`), the
  fingerprint (`ImpostorSourceHash.ts`: integer arrays hashed as their 32-bit upload) and the
  LOD tab's Impostors folder (`_dbg__ImpostorExport.ts`). Phase 5's lanes 3-5 export through it.
- p299 gained `slots.<name>.image` and `mipChain: "FULL"` (section 1), which p299 Phase 6's docs
  should fold into its atlas section.

### Phase 5 — LOD showcase scene — done

A demo scene for the LOD system as it stands after Phase 4, built so that later plans add to it:
p376 (HLOD proxies), p353 (streaming cells), p354 (GPU culling), p375 (batched meshes), p308
(scatter, leaf cards) and p420 (NPC tiers) each add a lane. largeWorld stays the stress test;
this scene shows one feature per lane, side by side, and what each one costs.

- **Scene:** `lodShowcase` (`src/app/lodShowcase.scene.json`, `lodShowcase.ts`), not a debug
  scene. A flat ground, lanes side by side along x, each running away from the camera along -z with
  its objects at increasing distances, so every level of every lane is on screen at once from the
  start camera. The `dayNight` sky box (impostors are lit at runtime: §2.3), so night shows that
  every level darkens alike.
- **Lanes** (`src/app/lodShowcase/lanes/*.ts`, one module each: `{ id, title, description,
create(ctx), debugItems? }`, laid out by a lane list in `lodShowcase.ts`; a later plan adds a
  lane with a module and a list entry):
  1. **Hand-made levels on plain meshes** (p348): a `*.mesh.json` with `lod` levels (geometries at
     lower segment counts, `fadeSeconds`), authored in JSON, not code.
  2. **Generated chain** (p347): a heavy procedural mesh (a `TorusKnotGeometry` at 256 × 32
     segments, about 16k triangles) with `lod: 'AUTO'`, its chain simplified at load.
  3. **Instanced pool and cross-quads** (p348, Phases 1-2): a tree grove ending in cross-quads and
     a cull fade at the far end (largeWorld's tree generators), exported (Phase 4).
  4. **Instanced pool and octahedral impostor** (Phase 3): the heavy mesh of lane 2 as a pool, its
     chain's levels then an exported impostor: the lane where an impostor pays off (largeWorld's
     80-triangle rock doesn't, Phase 3 section 5).
  5. **Baked against exported:** the same rock twice, one impostor baked at load and one exported,
     forced to the impostor level side by side.
  6. **Static instance cell** (p348 §4.3): an `InstancedMesh` entity whose whole cell swaps levels
     and fades.
- **Demo tab** ("LOD demo", scene-scoped, `src/app/_dbg__lodShowcase.ts`, debug env only like
  `_dbg__spaceDemo.ts`): camera stops (the start view, each lane's switch distances, overhead), a
  dolly along the lanes at a set speed (a scene looper, the same path every run, so it doubles as
  Phase 2's no-pop recorder run), the time of day (`setTimeOfDay`, play / pause), per lane its
  instances per level and triangles drawn, and buttons that open the LOD tab (overlay, bias,
  forced level, fade time scale, Impostors) and the profiler. Nothing persisted but the camera stop.
- **Exit:** every lane visible from the start camera; the dolly runs end to end with no pop
  (Phase 2's recorder); the scene loads without an impostor bake (lanes 3-5 exported, lane 5's
  baked half excepted); lane 4's GPU time with impostors against drawing its chain's last level
  shows the payoff; WebGPU and WebGL2; `readme.md`'s LOD highlight points at the scene.

What changed from the text above when the code was read:

- **Where the objects stand is computed, not hand-placed.** A level is used while the screen size
  `r × k / d` (`k = zoom / tan(fov / 2)`, LodSystem.ts) is at least its `screenSize`, so a lane's
  level bands are distance ranges from the start camera. The layout (`lodShowcase/layout.ts`) turns
  a lane's `LodDef` and level 0's radius into those bands (past the hysteresis on the far side of
  each switch, so a level is the same whether the camera came from near or far) and puts objects
  in each, so every level of every lane is on screen whatever the thresholds. A lane's nearest
  object is as far as it has to be to be in view (at a 4:3 aspect, see section 1).
- **Lane 1's mesh JSON is one object.** A `*.mesh.json` is one entity at its own position, so it is
  the lane's first object (level 0's band), and the lane places copies of its definition (the
  gathered entry in the scene's data, with the scene's save entry) in the other bands. The levels,
  `fadeSeconds` and the geometries (`*.geometry.json`) are JSON; only the copies' positions are code.
- **Lane 2's torus knot is code:** the geometry JSON types are box, sphere, cylinder, capsule and
  cone. The scene file registers it, starts `generateLodChain` and sets an `AUTO` lod (which awaits
  the chain) on copies placed by the levels it resolves to (section 1).
- **The sky holds still:** `dayNight` plays a 5-minute day, so the scene sets 15:00 and pauses it on
  enter (the demo tab plays it). Levels are compared under one light.
- **A lane returns its state** (`ShowcaseLaneState`: its entities, level 0's radius, its switch
  distances), which the demo tab reads for its camera stops and per-level counts.

Sections, each reviewed before the next:

1. **Scene, layout, lanes 1-2:** `lodShowcase.scene.json` (the start camera JSON, `dayNight`), the
   ground, the lane contract and the layout (`lodShowcase/layout.ts`), lane 1 (hand-made levels in
   JSON: three sphere geometries, a material, the mesh with `lod` and `fadeSeconds`) and lane 2 (the
   torus knot's generated chain, `AUTO`). Checked on WebGPU and WebGL2 from the start camera: both
   lanes in view, every level band holds an object at the level the layout expects (the LOD tab's
   overlay), the chain's levels and load time. — done: `lodShowcase.ts` (the ground, the lane list
   with a slot per lane, the sky held at 15:00 on enter, `getShowcaseLanes()` for the tab),
   `lodShowcase/layout.ts` (`ShowcaseLane`, `ShowcaseLaneContext` with `placeAt` / `getSlots` /
   `getSwitchDistances`, `getStartCamera`), `lanes/handMadeLevels.ts`, `lanes/generatedChain.ts`
   (`getShowcaseKnot`, which lane 4 reuses), the camera JSON and lane 1's JSON (three
   `lodShowcaseSphereLod*.geometry.json`, `lodShowcaseSphere.material.json`,
   `lodShowcaseHandMade.mesh.json`: screen sizes 0.06 / 0.025 / 0, cull 0.01, `fadeSeconds` 0.4).
   Lanes are 8 m apart in six slots centred on the camera (lane 1 at -12, lane 2 at -4); the
   ground runs to 290 m. Found in the code:

   - The layout's first version put each lane's nearest object where the lane comes into view,
     so the nearest objects of neighbouring lanes lined up along the view's edge and lane 2's knot
     hid lane 1's sphere. A lane is now in a slot (`{ lane, slot }`), and one whose finest level
     needs the camera close takes a centre slot; "in view" is a projection through the start
     camera (sides and bottom), not the lane's x alone.
   - Lane 2's chain and `AUTO`'s default don't fit a lane: at 1 px (1080p) the knot keeps level 0
     only within 5 m and level 1 within 14 m, nearer than any lane starts, and its five-level chain
     (down to 2 %) spans switch distances 36× apart against the lane's 15× (19-290 m). The chain
     stops at 6 % (16,384 → 8,192 → 3,276 → 982 triangles, errors 0.0011 / 0.003 / 0.0105) and the
     lane asks `{ auto: true, maxPixelError: 0.25 }`: switches at 21, 58 and 202 m. The lane
     resolves the levels with `resolveAutoLod` before creating the meshes, then each mesh sets its
     own (`setMeshLod`, awaited).
   - When the scene loads again, its camera object hasn't turned to its `lookAtPoint` yet while
     the scene file runs (identity rotation; on the first load it has), which moved lane 2's
     nearest point from 19 to 21 m and dropped its level 0 object. The layout measures from a
     private camera built from the camera JSON's pose (`getStartCamera`) instead.

   Checked (WebGPU, Apple GPU, and WebGL2 on SwiftShader, 1200×800, `?isDebug=true`, by a harness
   that reads each object's distance, screen size, the level its band expects and the level shown,
   instead of the overlay): every object of both lanes shows its band's level, lane 1's farthest
   LOD culled (lane 1 at 29, 58, 143 and 263 m; lane 2 at 19, 37, 114 and 255 m), the same on a
   reload of the scene and after a visit to skyShowcase, no warnings or errors. The chain is
   simplified on the assets worker in 90-107 ms on the first load (27-31 ms when warm, 517 ms on
   SwiftShader); the scene loads in 1.1-1.2 s (1.9 s on WebGL2), about skyShowcase's 1.1 s.
   After a bias change lane 1's copies fade for its own 0.4 s and lane 2's for the global 0.25 s.

2. **Lanes 3 and 6:** the tree grove pool (largeWorld's generators, its own thresholds) ending in
   cross-quads and a cull fade, exported through the LOD tab's Impostors folder; the static
   instance cell (an `InstancedMesh` entity with hand-made levels). Checked like section 1, plus
   the load without a cross-quad bake. — done: `lanes/treeGrove.ts` (slot 0, x -20) and
   `lanes/instanceCell.ts` (slot 5, x 20).

   - Lane 3: largeWorld's tree generator, larger (trunk 1.4 m, foliage 1.2 × 3 m) at 8 and 4
     radial segments, the trunk and foliage Phong materials, and the cross-quads
     `lodShowcaseTreeCross` last; screen sizes 0.15 / 0.075 / 0, cull 0.04 (LOD radius 4.26:
     switches at 61 and 122 m, hidden from 228 m). Three trees per band (`getSlots`' `perBand`),
     each up to 1.5 m off the lane's line and turned at random (seeded), scale 1 so a tree's band
     is exact. Exported with the LOD tab's export (`exportImpostorsAsync`, through the dev files):
     the four files in `src/app/impostors/`, 252 × 136 like largeWorld's tree (UASTC, 8 levels,
     5,498 and 15,194 B), and the scene lists it in `impostors`.
   - Lane 6: one cell per band, each a 4 × 4 block of capsule bollards (0.7 m apart, jittered)
     drawn by one `InstancedMesh` entity, its instances around the mesh's origin; levels by
     segment count (caps × sides 6 × 16, 2 × 8, 1 × 4, the last casting no shadow), screen sizes
     0.08 / 0.035 / 0, cull 0.022 (LOD radius 2.04 over every instance: switches at 55 and 125 m,
     hidden from 199 m). The first cell measures the radius (`setMeshLod`, then `LodData.radius`)
     that places all of them. Found in the code: such an entity gets a `Transform` (the mesh tag's
     hooks), synced onto the mesh every frame, so a cell is placed through its `Transform`, not
     `mesh.position` (which the sync put back at the origin: every cell at one spot).

   Checked (WebGPU and WebGL2, the same harness, now measuring through `measureLodEntity`, the
   selection's own code, since a cell has no position of its own): all 22 objects of the four lanes
   show their band's level (the trees at 44-57, 75-111 and 148-209 m, the farthest at 271 m LOD
   culled; the cells at 47, 87, 167 and 247 m), also after a visit to skyShowcase and back. The
   cross-quads load from the export (record `EXPORTED`, `bakeMs` null; the bake took 19-21 ms
   before), with no stale warning. Forced to the cross-quads (`forceLevel` 2) from 10 m, the
   exported planes stand upright and are lit like the mesh trees, on both backends. After a bias
   change the trees and cells fade over the global 0.25 s. Seen, not changed: lane 1's level 2
   sphere (8 × 6 segments) forced up close shows dark self-shadowing streaks on WebGPU (VSM draws
   a receiving object into the shadow map whatever its `castShadow`, Phase 3 section 4), not at
   its own distance (143 m).

3. **Lanes 4 and 5:** the torus knot as a pool (its chain's levels, then an exported octahedral
   impostor); the rock baked and exported side by side, held at the impostor level. Checked: no
   bake at load but lane 5's baked half, lane 4's GPU time with the impostor against its chain's
   last level. — done: `lanes/knotImpostor.ts` (slot 3, x 4) and `lanes/rockImpostors.ts` (slot 4,
   x 12); `getSlots`' `perBand` takes a count per level, and `getShowcaseKnotMaterial()` is the
   material lanes 2 and 4 share.

   - Lane 4: a pool of lane 2's knot through its chain's four levels (awaiting the chain lane 2
     started), then the hemi octahedral impostor `lodShowcaseKnotImpostor`; screen sizes 0.2 /
     0.12 / 0.065 / 0.04 / 0 (switches at 27, 44, 82 and 133 m), one knot per mesh band and four in
     the impostor's (more on the lane's line hid each other and lane 5), turned up to ±0.6 rad.
     Exported like lane 3 (864² atlases, UASTC: 101 KB and 797 KB) and listed in the scene.
   - Lane 5: largeWorld's rock (seed, shape and material as there), in rows at 33, 55 and 95 m:
     its impostor baked at load (`lodShowcaseRockBaked`), the mesh, and largeWorld's export
     (`largeWorldRockImpostor`, which the scene lists too), 3 m apart. The impostors are drawn as
     plain meshes with no LOD, so they stay impostors at any distance. Their options match
     largeWorld's call (`hemi`), so the export's fingerprint matches: no stale warning. A lane's
     state allows entities without a LOD (radius 0, no switch distances).
   - Found by measuring (WebGPU, Apple GPU, 1200×800, main loop paused, every mesh but the measured
     ones hidden, 150 renders timed through the queue, median of three): the default impostor
     doesn't pay off against the chain's last level. 400 knots spread over the impostor band's
     distances (150-290 m), GPU time over the frame without them (0.52-0.53 ms): level 0 (16,384
     triangles) +2.32-2.37 ms, level 1 (8,192) +0.79, level 2 (3,276) +0.31-0.32, level 3 (982)
     +0.12-0.13, the impostor with surface depth +0.43-0.45, flat (`surfaceDepth: false`)
     +0.07-0.08. Phase 3's cause again: writing depth from the shader turns off the tile GPU's
     hidden-surface removal. The knots stand on the ground, which the flat quad suits (Phase 3
     section 5), so lane 4's impostor is flat (re-exported: the same atlases, `surfaceDepth: false`
     in its JSON), and lane 5's rocks show the surface depth. The lane itself from the start camera
     (eight knots): +0.09 ms as selected (mostly the near knots' mesh levels), forced to level 3
     +0.01, to the impostor +0.02 (forced, the nearest knot's impostor covers a fifth of the view).

   Checked (WebGPU and WebGL2): all 30 LOD objects of the five LOD lanes show their band's level,
   also after a visit to skyShowcase and back; the records are `EXPORTED` (`bakeMs` null) for the
   tree's cross-quads, the knot's impostor and largeWorld's rock, `BAKED` only for lane 5's baked
   rock (38-43 ms; 1.6 s on SwiftShader), no stale warning (the knot's showed once, as it should,
   between the switch to flat and its re-export). The scene loads in 1.27-1.45 s (4.1 s on WebGL2;
   it was 1.1-1.2 s before lanes 4 and 5: the baked rock and two more pairs of 864² atlases). Up
   close (10 m), lane 5's baked and exported impostors look alike and like the mesh between them,
   on both backends; lane 4's knot forced to its impostor at 10 m reads as the knot, softer, torn a
   little where its tubes cross (64-texel frames at a fifth of the distance they're used from).

4. **Demo tab:** "LOD demo" (`_dbg__lodShowcase.ts`): camera stops, the dolly (a scene looper), the
   time of day, per lane its instances per level and triangles, buttons to the LOD tab and the
   profiler; the camera stop persisted. — done: `src/app/_dbg__lodShowcase.ts`
   (`createLodShowcaseTab`, a scene tab created by the scene file in the debug env, like the space
   demo's). `lodShowcase.ts` now also keeps the start camera (`getShowcaseStartCamera`) and runs
   listeners on enter (`addShowcaseEnterListener`, as a scene has one enter callback).

   - Camera: a stop (start view, overhead, and every switch of every lane by its distance from the
     start camera, labelled "Hand-made levels: level 1 → 2 (86 m)" or "…: hides (214 m)") and a
     side: just inside (0.95 × the switch distance) shows the finer level, just past (1.15 ×, past
     the 10 % hysteresis) the coarser one. A switch stop stands on the line from the start camera to
     the lane's first object past the switch, at that distance from it, looking at it, so the rest
     of the lane stands behind it; toggling the side shows that object's cross-fade (slow it down
     with the LOD tab's fade time scale). The camera moves through its `Transform`
     (`cameraLookAtPoint`). The stop and side are the tab's only persisted state
     (`AEK_debugLodShowcase`), applied again on the scene's enter; the clear-LS button goes back to
     the start view.
   - Dolly: a scene app looper (so the app pause stops it) that runs the camera from the start view
     240 m down the lanes and back, keeping its height and direction, at a set speed (default 15
     m/s), then stops at the start view: the same path every run. `startShowcaseDolly`,
     `stopShowcaseDolly`, `isShowcaseDollyRunning` and `setShowcaseCameraStop` /
     `getShowcaseCameraStops` are exported for section 5's recorder.
   - Time of day (`setTimeOfDay`), play and pause, whether it's playing; the LOD system's fading
     count; buttons to the LOD tab (`lodControls`) and the profiler window.
   - Lanes, left to right: per lane its entities per level shown (`L0 4 · L1 3 · L2 3 · culled 1
· fading 2`, `no LOD` for lane 5's), its switch distances and the triangles of the levels shown
     (the main pass, before frustum culling, a fading entity's outgoing copy not counted).

   Checked (WebGPU and WebGL2, a harness driving the exported functions): every switch stop of the
   five LOD lanes on both sides (32 stops) shows the expected level on the object it looks at; the
   stop set last comes back after a page reload (the camera at the same position); the dolly runs
   at its speed, and the tab renders its folders and the six lane rows.

5. **Close the phase:** the exit measured (the dolly with Phase 2's recorder, the load, lane 4's
   payoff, both backends), As built, `readme.md`'s LOD highlight, CLAUDE.md, versions (an app
   minor: a new scene) and CHANGELOG; mark the plan done. — done: app 1.7.1 → 1.8.0 (the new
   scene; engine and toolkit unchanged by Phase 5, the engine's 4.13.0 is Phase 4's), the branch's
   CHANGELOG entry gets the scene, its tab and its exports. `readme.md`'s LOD selection feature and
   its LOD example point at the scene; CLAUDE.md's Impostors section gets a paragraph on the scene
   (the lane contract, the layout, the tab, the `InstancedMesh` entity's `Transform`).

**Exit:** met (below), with one finding about very slow frames.

As built:

- Every lane in view from the start camera, every level of every LOD lane on screen (sections
  1-3's harness, WebGPU and WebGL2: all 30 LOD objects show their band's level).
- The dolly with Phase 2's recorder (each frame, every LOD entity of the lanes whose applied level
  or LOD culling changed since the last frame must have TAG_LOD_TRANSITIONING; WebGPU, Apple GPU,
  1200×800): the full run, 240 m down the lanes and back at 15 m/s (32 s, 1,921 frames), 200
  changes, 0 pops, up to 5 entities fading at once. The control, the same run with the global
  `fadeSeconds` 0: the same 200 changes, 176 pops (every lane but lane 1, whose JSON keeps its own
  0.4 s).
- WebGL2 (SwiftShader): the same run at 3-4 fps (105 frames in 30 s) shows 46 of 175 changes as
  pops. A frame there (0.28 s) is longer than a fade (0.25 s), and `lodFadeSystem` advances a fade
  by the frame's dt in the frame it starts, so the fade ends before it is drawn once: a real pop,
  but only below about 4 fps (at 30 fps a fade spans 7-8 frames). With the LOD tab's fade time scale
  at 0.1 (a fade over about 9 of those frames): 198 changes, 0 pops, up to 21 fading. Seen, not
  changed: drawing a fade's first frame at least once would need `lodFadeSystem` to skip the start
  frame's dt; noted for a later LOD plan.
- No bake at load but lane 5's baked half: the records of `lodShowcaseTreeCross`,
  `lodShowcaseKnotImpostor` and `largeWorldRockImpostor` are `EXPORTED` (`bakeMs` null), only
  `lodShowcaseRockBaked` is `BAKED` (38-43 ms), on both backends, with no stale warning. The scene
  loads in 1.27-1.50 s on WebGPU.
- Lane 4's payoff (section 3): drawing 400 knots at the impostor band's distances, the flat
  impostor adds 0.07-0.08 ms of GPU time against 0.12-0.13 ms for the chain's last level (982
  triangles) and 2.3 ms for the 16,384-triangle mesh; the default (surface depth) impostor adds
  0.43-0.45 ms, so lane 4 uses the flat one and lane 5 shows the surface depth.
- WebGPU and WebGL2: every check above on both, except the payoff (WebGPU only: SwiftShader's
  timings say nothing about a GPU).
- `readme.md`'s LOD highlight points at the scene.
- What later plans build on: a lane is a `ShowcaseLane` module in `src/app/lodShowcase/lanes/` and
  an entry with a slot in `lodShowcase.ts`'s lane list (slots 0-5 are taken: a seventh lane widens
  the layout); `layout.ts`'s `getSlots` / `placeAt` / `getSwitchDistances` place a lane's objects by
  its `LodDef`; the tab picks up a new lane's switch stops and its row by itself. The dolly and the
  recorder's functions (`startShowcaseDolly`, `isShowcaseDollyRunning`, `setShowcaseCameraStop`)
  are the no-pop check for a later plan's representation switch.

## 4. Versioning

Engine minor per phase: the generators and bake helpers live in core (`core/Lod/Impostors/`, see
§2.1), plus `lodDither` / fade support in LOD pools and, in Phase 4, the new asset type and p299's
atlas extensions (also a `readme.md` entry: a new asset JSON type). App patches for largeWorld's
adoption; an app minor for Phase 5's new scene. One bump per branch merged to `main` (CLAUDE.md),
at the level of its biggest change.

## 5. Open questions

1. Shadows from octahedral impostors: a camera-facing quad casts a shadow facing the _camera_, not
   the light. Use the cross-quad or a lower mesh level as a shadow-only proxy, or
   `castShadow: false`. Decided in Phase 3: the shadow pass's quad faces the light (section 2),
   and both passes write the baked surface's depth (section 4).
2. Can the impostor bake use the asset worker (OffscreenCanvas + a second WebGPU device)? It would
   keep bakes off the main thread, but doubles device memory for the bake. Main thread first.
