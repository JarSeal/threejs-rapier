Status: in progress | Phases 1-2 implemented
Category: Rendering, LOD
Epic: p350_lod-system-research.md (Tier 2.2)
Related: p299_texture-arrays-and-atlases.md (Phase 4's exported atlases), p376_hlod-merged-cluster-proxies.md (merged groups' far levels), \_DONE_p347_lod-chain-generation.md (impostors are the level after the last chain level), p353_macro-streaming-grid.md (`FAR` cells show impostors), p308_terrain-scatter.md (leaf-litter cards), p420_npc-simulation-tiers.md (its `CROWD` tier may reuse octahedral impostors), the procedural sky box (p112/p113, implemented: day-night lighting, see §2.3)

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
a registered texture owned like any other asset. Phase 4 adds a debug "Export impostor" button
that saves the atlas as PNGs next to an `*.impostor.json` (atlas paths, frame count, bounds); p300
then encodes it as KTX2, and nothing is baked on the client.

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

### Phase 3 — Octahedral impostors

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
   Checked on a test pool forced to the impostor level, WebGPU and WebGL2.
3. **Three-frame blend and depth parallax:** the three nearest frames with barycentric weights, each
   frame's UV from the view ray's intersection with its plane, offset by the sampled depth; hemi
   views from below the horizon. Checked from every angle, overhead included, and at the frame
   boundaries (no popping as the camera orbits).
4. **Shadows** (open question 1): measure the impostor's own light-facing shadow, its self-shadowing
   on its camera-facing quad, and the options (a depth offset from the depth channel through
   `depthNode`, a cross-quad or lower mesh level through `castShadowPositionNode` / a shadow-only
   level, `castShadow: false`); pick one. Per-level `receiveShadow` if it needs it.
5. **largeWorld rocks:** a rock pool (toolkit asteroids: the mesh, a lower level, the impostor last),
   the day-night sky box listed in the scene, the exit measured.
6. **Close the phase:** As built, CLAUDE.md's Impostors section, versions and CHANGELOG.

**Exit:** a rock impostor holds up from any angle (including overhead) at its switch distance, and
it darkens at night with the rest of the scene.

### Phase 4 — Exported atlases

Export button, `*.impostor.json` asset type (schema, gatherer suffix), KTX2 through p300. The
exported atlas uses p299's atlas format (a `*.textureAtlas.json` per impostor, frames as cells
with a generated cell table), so `*.impostor.json` holds only frame count, bounds and the atlas id.

## 4. Versioning

Engine minor per phase: the generators and bake helpers live in core (`core/Lod/Impostors/`, see
§2.1), plus `lodDither` / fade support in LOD pools and, in Phase 4, the new asset type (also a
`readme.md` entry: a new asset JSON type). App patches for largeWorld's adoption.

## 5. Open questions

1. Shadows from octahedral impostors: a camera-facing quad casts a shadow facing the _camera_, not
   the light. Use the cross-quad or a lower mesh level as a shadow-only proxy, or
   `castShadow: false`. Decide in Phase 3.
2. Can the impostor bake use the asset worker (OffscreenCanvas + a second WebGPU device)? It would
   keep bakes off the main thread, but doubles device memory for the bake. Main thread first.
