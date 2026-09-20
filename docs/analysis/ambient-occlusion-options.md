# Ambient Occlusion Options for Aekasha

A survey of AO techniques, ordered **easiest to hardest to implement**, with scope, owning subsystem, and runtime cost.

Target engine context: Three.js + Rapier, WebGL2/WebGPU, no PostFX stack yet, currently only static `aoMap` textures.

---

## Legend

**Runtime cost scale**

| Symbol | Meaning                                                                               |
| ------ | ------------------------------------------------------------------------------------- |
| `0`    | Free. No extra runtime work at all (authoring-time only).                             |
| `1`    | Negligible. A few ALU ops or one extra texture fetch per pixel.                       |
| `2`    | Low. Extra vertex attribute, one texture, or a handful of ALU per pixel.              |
| `3`    | Moderate. Per-pixel loop over a bounded occluder set, or a low-res volume fetch.      |
| `4`    | High. Fullscreen pass(es) with many samples plus denoise/upsample.                    |
| `5`    | Very high. Volume tracing, multiple fullscreen passes, or heavy build-time + runtime. |

**Implementation effort** is the ordering of this document: item 1 is the easiest, item 22 the hardest.

**Scope**

- _Global_ — one setting for the whole scene/renderer.
- _Per material_ — authored on the material.
- _Per mesh_ — data baked into the geometry or its textures.
- _Per entity_ — a runtime component on an object instance.
- _Per region_ — a volume/probe placed in the world.

---

## Quick reference table

| #   | Technique                                          | Scope                      | Controlled from                         | Runtime cost        |
| --- | -------------------------------------------------- | -------------------------- | --------------------------------------- | ------------------- |
| 1   | Indirect-only AO application                       | Global rule                | Shader chunk / renderer                 | 0                   |
| 2   | Cavity AO in albedo & roughness                    | Per material               | DCC authoring                           | 0                   |
| 3   | Geometry skirt                                     | Per mesh                   | DCC authoring                           | 0–1                 |
| 4   | AO map plumbing (intensity, UV channel)            | Per mesh / material        | Material texture slot                   | 1                   |
| 5   | Directional ambient (hemisphere / env)             | Global                     | Scene lighting config                   | 1                   |
| 6   | Multi-bounce AO tint                               | Global toggle              | Shading config                          | 1                   |
| 7   | Curvature darkening from normal derivatives        | Per material               | Material flag                           | 1                   |
| 8   | Vertical ground gradient                           | Per material + global      | Material + env settings                 | 1                   |
| 9   | Specular occlusion                                 | Per material               | Material flag                           | 1                   |
| 10  | Vertex-baked AO                                    | Per mesh                   | Asset import bake                       | 1                   |
| 11  | Decal / billboard blob AO                          | Per entity                 | Mesh custom props → decal system        | 2                   |
| 12  | Bent normals                                       | Per mesh                   | Bake pipeline + material slot           | 1–2                 |
| 13  | Third-party screen-space AO pass (N8AO / GTAONode) | Global                     | PostFX stack                            | 4                   |
| 14  | Depth + normal prepass                             | Global                     | Renderer pipeline                       | 2 (shared)          |
| 15  | Per-object AO influence mask                       | Per material               | Material → prepass channel              | 1 (on top of 13/14) |
| 16  | Analytic sphere/capsule AO from Rapier colliders   | Per entity                 | Physics entity + global occluder buffer | 3                   |
| 17  | Box / AABB analytic occluders                      | Per entity                 | Occluder component                      | 3                   |
| 18  | Lightmap / baked scene occlusion                   | Per mesh, per scene        | Scene bake tool                         | 1                   |
| 19  | AO volume (3D texture)                             | Per region                 | Volume entity                           | 2–3                 |
| 20  | Ambient occlusion fields                           | Per mesh asset → receivers | Asset bake + runtime occluder list      | 3                   |
| 21  | Occlusion in irradiance probes                     | Per region (probe grid)    | Probe system                            | 2–3                 |
| 22  | Signed distance field AO                           | Per mesh asset + global    | Asset build flag + AO pass              | 5                   |

**Custom screen-space AO written from scratch** (GTAO or SSILVB) sits between 16 and 22 in effort depending on ambition. See note under item 13.

---

## 1. Indirect-only AO application

**Description.** Guarantee AO multiplies ambient and indirect diffuse only, never direct light. Three.js already does this for `aoMap`, but the rule has to be enforced in every AO source you add later. Multiplying the final composited image is the single biggest reason SSAO looks like dirt.

**Scope.** Global rule, with optional per-material override.
**Controlled from.** Shader chunk + renderer config.
**Runtime cost.** `0` — it's a correctness constraint, not a feature.
**Notes.** Write this as the contract for the whole AO system before anything else. Every later item plugs into the same `totalOcclusion` accumulator.

---

## 2. Cavity AO in albedo and roughness

**Description.** Micro-scale occlusion painted into the base color and roughness maps at authoring time. Handles the scale no runtime technique can reach (fabric weave, panel gaps, pores).

**Scope.** Per material / per texture.
**Controlled from.** DCC authoring. No engine code.
**Runtime cost.** `0`.
**Notes.** Zero engine work, but worth documenting as an official part of the AO strategy so artists don't double up with baked AO maps.

---

## 3. Geometry skirt

**Description.** A ring of darkened, vertex-colored geometry modeled into the base of a prop so it reads as grounded. Ugly in theory, invisible in practice, standard on mobile and stylized titles.

**Scope.** Per mesh asset.
**Controlled from.** DCC authoring; engine only needs vertex color support.
**Runtime cost.** `0–1` (a handful of extra triangles).
**Notes.** Only works on flat receivers. Pairs badly with uneven terrain.

---

## 4. AO map plumbing

**Description.** What you already have, properly exposed: intensity control, explicit UV channel selection, and a clear rule that `aoMap` is a _mesh-local_ signal only (it can never capture object-to-object occlusion).

**Scope.** Per mesh / per material.
**Controlled from.** Material texture slot (`aoMap`, `aoMapIntensity`, UV channel index).
**Runtime cost.** `1` — one texture fetch, often packable into an unused channel of an existing ORM texture.
**Notes.** Pack AO/Roughness/Metalness into one RGB texture if you aren't already. Free bandwidth win.

---

## 5. Directional ambient (hemisphere / env irradiance)

**Description.** Replace flat ambient with sky/ground directional ambient or a real environment map. Half of what people want from AO is actually "ambient should come from above and bounce off the ground".

**Scope.** Global.
**Controlled from.** Scene lighting config.
**Runtime cost.** `1`.
**Notes.** This is a prerequisite for bent normals (item 12) mattering at all, and it makes every other AO technique read correctly instead of just looking like a grey wash.

---

## 6. Multi-bounce AO tint

**Description.** The cubic polynomial fit from the GTAO paper: takes AO and albedo, returns colored, less-crushed occlusion that approximates light bouncing within the crevice. Roughly two lines of shader code.

**Scope.** Global toggle, per-material opt-out.
**Controlled from.** Shading config.
**Runtime cost.** `1`.
**Notes.** Apply once, at the end, to the combined occlusion term from all sources. Do not apply per-source or you'll compound the tint.

---

## 7. Curvature darkening from normal-map derivatives

**Description.** Derive a curvature/convexity term from `dFdx`/`dFdy` of the normal and darken by it. Gives micro-occlusion for free on any normal-mapped surface with no extra authored data.

**Scope.** Per material.
**Controlled from.** Material flag + strength.
**Runtime cost.** `1`.
**Notes.** Screen-resolution dependent and noisy at grazing angles. Clamp the strength hard. Best on tiling architectural materials with no baked AO.

---

## 8. Vertical ground gradient

**Description.** A world-space Y falloff near ground planes, tinted toward the ground color. Fakes the darkening and color bleed you get at the base of walls.

**Scope.** Per material, driven by global ground height and color.
**Controlled from.** Material flag + scene environment settings.
**Runtime cost.** `1`.
**Notes.** Breaks on multi-storey interiors unless you feed a per-room ground height. Cheap and effective for outdoor scenes.

---

## 9. Specular occlusion

**Description.** A second occlusion term derived from AO, roughness and N·V (the Frostbite/Lagarde `computeSpecOcclusion` approach, or horizon occlusion from the normal map). Without it, crevices go dark in diffuse but keep full-strength highlights, which reads as plastic.

**Scope.** Per material.
**Controlled from.** Material shader feature flag + strength.
**Runtime cost.** `1`.
**Notes.** Not provided by Three.js by default. Needs AO available _before_ the specular term is evaluated, so it consumes the combined occlusion accumulator from item 1.

---

## 10. Vertex-baked AO

**Description.** Occlusion stored in a vertex attribute (vertex color alpha, or a dedicated float attribute). No texture memory, no UV requirement, works on instanced geometry. Quality is tied to tessellation density.

**Scope.** Per mesh (geometry attribute).
**Controlled from.** Asset import step (BVH raycast bake in a worker) + material flag to read the attribute.
**Runtime cost.** `1` — interpolated attribute, no fetch.
**Notes.** Ideal for foliage, rocks, dense props and anything instanced. `three-mesh-bvh` makes the bake straightforward, and it fits the import step where you're already parsing custom properties. Cache the result so it's baked once, not per load.

---

## 11. Decal / billboard blob AO

**Description.** A dark radial gradient with alpha falloff projected onto receiving surfaces beneath an object. A legitimate shipping technique, not just a hack.

**Scope.** Per entity.
**Controlled from.** Mesh custom properties at import → a decal component (offset, radius, strength, fade distance).
**Runtime cost.** `2` — one extra draw per blob, or one texture fetch per pixel if done as a deferred decal.
**Notes.** Two refinements worth making over the naive version:

- Project along the _receiving surface normal_, not camera-facing, so blobs don't float on walls.
- Drive radius and intensity from the object's bounds, and fade by distance-to-ground, so one authored gradient texture serves every prop.

Works off-screen, works at any distance, and degrades gracefully. The best "potato tier" option.

---

## 12. Bent normals

**Description.** The average unoccluded direction, baked alongside AO, used to sample the irradiance/env map instead of the geometric normal. The cheapest thing that genuinely reads as global illumination, because it gives _directional_ ambient rather than uniform darkening.

**Scope.** Per mesh (baked texture, or a vertex attribute alongside item 10).
**Controlled from.** Import/bake pipeline + material texture slot.
**Runtime cost.** `1–2` — one extra texture fetch, same shading cost thereafter.
**Notes.** Requires item 5 to be worth anything. Also improves item 9 (feed the bent normal into specular occlusion). Effort is mostly in the bake tool, not the shader.

---

## 13. Third-party screen-space AO pass

**Description.** Drop in an existing implementation rather than writing one. Current options in the Three.js ecosystem:

- **N8AO** (`N8AOPass` for vanilla Three.js, `N8AOPostPass` for pmndrs/postprocessing). Version 2.0 adds neural denoising for temporal stability, quality presets from Performance to Neural-High, and a half-resolution mode. A WebGPU/TSL port exists.
- **`GTAONode`** — TSL addon in Three.js for the WebGPU pipeline. Takes a depth/normal prepass, exposes radius, resolution scale, sample count, scale, thickness, and optional temporal filtering (requires TRAA). Known to produce halos at depth discontinuities and ships without a denoiser.
- **`SSGINode`** — also in Three.js, if you want indirect bounce alongside occlusion.

**Scope.** Global.
**Controlled from.** PostFX stack (radius, falloff, intensity, resolution scale, sample count, denoiser mode).
**Runtime cost.** `4`.

**Notes.**

- Set radius in **world units**, one or two orders of magnitude below scene scale.
- Render at half resolution with a depth-aware upsample.
- MSAA does not work with screen-space AO, so SMAA or TAA becomes mandatory.
- Cannot see off-screen geometry. This is the permanent limitation that items 16–22 exist to solve.

**Writing your own instead.** The algorithm family — SSAO → HBAO → SAO/ASSAO/CACAO → GTAO → visibility bitmask (SSILVB) — all take the same depth+normal inputs and differ mainly in how the hemisphere is integrated. That makes a single `AOPass` with preprocessor-selected modes the clean API. SSILVB is the current high-water mark: it replaces the two horizon angles with a bit field of N occluded/unoccluded sectors around the hemisphere slice, which lets light pass behind thin surfaces of constant thickness, samples more than one visibility cone for better ambient than a bent normal, and hands you a diffuse bounce nearly for free. Effort for a from-scratch implementation with denoiser: comparable to items 16–20.

---

## 14. Depth + normal prepass

**Description.** Not AO itself, but the dependency the whole screen-space tier sits on, and shared with TAA, SSR and any deferred decal work.

**Scope.** Global.
**Controlled from.** Renderer pipeline config.
**Runtime cost.** `2` — amortized across every effect that uses it.
**Notes.** `N8AOPass` manages this internally, so item 13 can ship without it. A custom pass or item 15 requires it explicitly.

---

## 15. Per-object AO influence mask

**Description.** A G-buffer channel letting individual materials scale or reject screen-space AO. Skin, foliage, glass, emissives and hair all want less AO than concrete does.

**Scope.** Per material, consumed by the global pass.
**Controlled from.** Material property written into the prepass.
**Runtime cost.** `1` on top of items 13/14.
**Notes.** Small feature, disproportionate quality return. Also the hook for stylized/toon materials that want no AO at all.

---

## 16. Analytic sphere/capsule AO from Rapier colliders

**Description.** Occlusion from a sphere has a closed-form solution; capsules are a cheap extension. Feed a bounded set of proxy capsules into the forward shader for soft, grounded, fully dynamic occlusion with no depth buffer, no denoiser, no temporal artifacts, and no screen-space misses. This is what Unreal calls capsule shadows, where a character casts a soft shadow that grounds them in areas lit only by bounce light.

**Scope.** Per entity (occluder), gathered into a global buffer per frame.
**Controlled from.** Physics entity or a dedicated proxy component, plus a global occluder buffer and a per-material receive toggle.
**Runtime cost.** `3` — scales with occluders-per-pixel, so it needs culling and a hard per-pixel budget.

**Notes.** **The standout option for Aekasha.** Rapier already provides capsule and sphere colliders for every dynamic body, so the AO proxy set comes free from physics with zero extra authoring — a genuine architectural advantage over engines where capsule proxies must be hand-placed. Reuse (or build toward) a clustered/tiled culling structure so occluders are gathered the same way lights are. Cap contributions per pixel and fade distant occluders out entirely.

---

## 17. Box / AABB analytic occluders

**Description.** The same analytic approach for architecture. A handful of boxes can convincingly darken a whole room corner, including for dynamic objects moving through it.

**Scope.** Per entity.
**Controlled from.** Mesh entity or a dedicated occluder component.
**Runtime cost.** `3`, shared budget with item 16.
**Notes.** Mostly an extension of item 16 once the occluder buffer and culling exist. Worth treating as the same subsystem with two occluder shapes.

---

## 18. Lightmap / baked scene occlusion

**Description.** A second-UV bake that captures occlusion **between** objects and the floor — the one thing per-mesh AO maps fundamentally cannot do. Unbeatable quality for static scenes.

**Scope.** Per mesh data, authored per scene.
**Controlled from.** Scene bake tool, texture slot + second UV set.
**Runtime cost.** `1` at runtime.
**Notes.** Cost is entirely in tooling: UV unwrapping, atlas packing, a bake backend, and asset pipeline plumbing. Very cheap to _use_, expensive to _build_. Consider whether a third-party bake in the DCC plus an import convention gets you 90% of the value for 10% of the work.

---

## 19. AO volume (3D texture)

**Description.** A low-resolution 3D texture of occlusion over a room or prop cluster, sampled per pixel by world position. Lets **dynamic** objects receive **static** occlusion, which baked maps can't do.

**Scope.** Per region (volume entity with bounds + resolution).
**Controlled from.** A scene entity, sampled globally in the shader.
**Runtime cost.** `2–3` — one 3D texture fetch, but memory-hungry at useful densities.
**Notes.** Good middle ground between lightmaps and runtime tracing. Watch total VRAM if you place many volumes.

---

## 20. Ambient occlusion fields

**Description.** (Kontkanen & Laine, 2005.) Store the occlusion an object _emits_ into the space around it, then apply it to whatever receivers are nearby. The precursor to modern capsule shadows, and a good fit for movable props on static geometry.

**Scope.** Per mesh asset, applied to receivers at runtime.
**Controlled from.** Asset bake + a runtime occluder list, managed much like lights.
**Runtime cost.** `3`.
**Notes.** More accurate than capsules for oddly shaped props, but needs a bake step per asset. If item 16 is already shipped, the marginal gain may not justify the pipeline work.

---

## 21. Occlusion in irradiance probes

**Description.** Store a visibility cone or SH visibility per probe, giving large-scale occlusion — a character walking under an archway getting darker — that screen space fundamentally cannot see.

**Scope.** Per region (probe grid), sampled per entity or per pixel.
**Controlled from.** The irradiance probe system.
**Runtime cost.** `2–3` on top of whatever the probe system already costs.
**Notes.** Only makes sense as an extension once a probe/GI system exists. Effectively free _if_ that system is already there, which is why it's ranked late rather than expensive.

---

## 22. Signed distance field AO

**Description.** Per-mesh SDF volumes, cone-traced at runtime. World-space correct, handles off-screen geometry, supports dynamic scene changes. Unreal precomputes SDF volumes around each rigid mesh for medium-scale AO from world-space occluders, so there are no artifacts from missing off-screen data.

**Scope.** Per mesh asset + a global trace pass.
**Controlled from.** Asset build setting ("generate mesh SDF") + a renderer-level AO pass.
**Runtime cost.** `5`.
**Notes.** The "correct" non-screen-space answer, and the hardest item here. Real limitations even in mature engines: only slight non-uniform scaling is supported, large static meshes give poor results because a small volume texture maps to the whole object, and skeletal meshes aren't covered (which is exactly why capsules exist alongside it). Probably overkill for a WebGL/WebGPU engine. Listed for completeness.

---

## Composition rules

The techniques above are **not** mutually exclusive, and the engine API should treat them as composable layers feeding one occlusion accumulator.

1. **Split by scale, not by preference.** Baked/vertex AO owns detail smaller than a prop. Capsules and volumes own object-scale. Probes own room-scale. Screen space owns contact detail at whatever radius you set.
2. **Beware double-darkening.** Baked AO and screen-space AO overlapping is the classic offender. Either `min()` the two rather than multiplying, or split the radius so each covers a distinct scale band.
3. **Combine before applying.** Accumulate all sources into one occlusion value, then apply multi-bounce tint (item 6), then specular occlusion (item 9), then multiply into indirect diffuse only (item 1). Applying per-source compounds errors.
4. **One global intensity, many local scales.** A single scene-level AO strength plus per-material influence (item 15) is enough control; per-technique intensity sliders exposed to users become unmanageable fast.

---

## Suggested phasing for Aekasha

**Phase 1 — application correctness (items 1, 4, 5, 6, 9).**
No new occlusion sources. Just make the AO you already have behave properly, and give the system its accumulator contract. Highest quality-per-hour ratio in this entire document.

**Phase 2 — cheap authored data (items 10, 12, 2, 3, 11).**
Vertex AO and bent normals in the import pipeline; blob decals driven from mesh custom properties. Everything here works on low-end hardware, works off-screen, and needs no PostFX stack.

**Phase 3 — dynamic proxy AO (items 16, 17).**
The differentiating feature, since Rapier hands you the proxies for free. Grounded dynamic objects without a fullscreen pass.

**Phase 4 — screen-space tier (items 14, 13, 15).**
Once PostFX exists. Start by integrating N8AO or `GTAONode`, then consider a custom multi-mode `AOPass` if you want SSILVB.

**Phase 5 — optional, scene-scale (items 18, 19, 21).**
Driven by what your projects actually need. Skip item 20 if item 16 landed well, and treat item 22 as research rather than roadmap.
