## A level is a screen size

An object's screen size is its bounding sphere's height on screen, as a fraction of the screen's:
`radius × k / distance`, where `k` comes from the camera's field of view and zoom (an
orthographic camera has no distance). So an object keeps its detail when the camera zooms in.

Levels go from the finest down, each with the smallest `screenSize` it's used at:

<<< src/app/lodShowcase/lodShowcaseHandMade.mesh.json

- A level's `geo`, `mat` and `castShadow` default to the level before's (level 0's to the mesh's
  own). Here the far levels are the same sphere at fewer segments, and the last stops casting
  shadows.
- Below `cullScreenSize` the object is hidden.
- Hysteresis keeps an object on a boundary from flipping: it moves to a coarser level only below
  `screenSize × (1 − hysteresis)` (0.1 by default).
- [`setLodBias`](api:setLodBias) (or `AppConfig.lod.bias`) trades detail for speed everywhere.

A mesh gets levels from its JSON's `lod`, the `lod` prop of
[`createMeshEntity`](api:createMeshEntity), or [`setMeshLod`](api:setMeshLod).

## Generated levels

[`generateLodChain`](api:generateLodChain) simplifies a registered geometry with meshoptimizer,
in the assets worker, into levels registered as `<id>#lod1`, `<id>#lod2` and so on. Each level
records its triangle count and its error, and shares the base's vertices (only its index is its
own). The chain is released with its base.

- `lod: "AUTO"` uses a geometry's chain: a level is used while its error is at most one pixel on
  a 1080-pixel-high screen (`{ "auto": true, "maxPixelError": 2 }` allows more).
- An `*.importedAsset.json` with `"lodChain": true` has the
  [asset pipeline](hub:features/asset-optimization) build the chain into the GLB, so the client
  loads the levels instead of simplifying.
- Very low-poly meshes have nothing to remove: their chain comes out without levels, with a
  warning. Hand-make theirs.

## Cross-fades

A level change, and hiding or showing, dissolves over `fadeSeconds` (0.25 s by default, 0 for an
instant switch) through a screen-space dither: the old and the new level each draw part of the
pixels. Both stay opaque, so shadows, depth and post effects work through a fade. On the
`lodShowcase` scene's dolly (below), 200 level changes gave no pops, against 176 with fades off.

## Many instances

[`createInstancedMeshPool`](api:createInstancedMeshPool) draws many instances with one
`InstancedMesh`, each instance an ECS entity with its own transform.
[`createInstancedLodPool`](api:createInstancedLodPool) has one mesh per level and moves each
instance into its level's mesh, so a whole forest is a draw call per level. A fading instance is
in two level meshes, which adds no draw call.

The selection costs one distance and one multiply per entity, after frustum culling, and only an
entity whose level changed is touched. `AppConfig.lod.maxSelectionsPerFrame` spreads it over
frames when there are very many.

## Impostors

An impostor is a far level drawn with a few textured quads. Only the albedo, normals and depth
are baked, never light, so it's lit by the scene's sun, shadows and day-night cycle like the
mesh, and it casts its silhouette's shadow.

- **Cross-quads** ([`generateCrossQuads`](api:generateCrossQuads)): two or three crossed,
  alpha-cut planes. Cheap, and right for vegetation seen from the side.
- **Octahedral** ([`generateOctahedralImpostor`](api:generateOctahedralImpostor)): one quad that
  faces the camera, blending the three nearest of a grid of baked views (12 × 12 by default), so
  it holds from any angle, overhead included. `hemi: true` bakes only the upper half, for objects
  never seen from below.
- **`surfaceDepth`** (octahedral, on by default): the impostor writes its surface's depth, so it
  meets the ground and shadows itself like the mesh. Writing depth from a shader turns off the
  GPU's early depth test, so `surfaceDepth: false` draws a cheaper flat quad, fine for objects
  standing on the ground.

An impostor pays off against heavy meshes, not low-poly ones. Measured on WebGPU (an Apple GPU),
400 knots at the impostor's distances add:

| Drawn as                                | GPU time |
| --------------------------------------- | -------- |
| The 16,384-triangle mesh                | 2.3 ms   |
| The chain's last level (982 triangles)  | 0.12 ms  |
| A flat impostor (`surfaceDepth: false`) | 0.07 ms  |
| An impostor with surface depth          | 0.43 ms  |

## Exporting an impostor

An impostor bakes when its scene loads, in about 40-115 ms for an octahedral one. Export it once,
and the scene loads it instead:

1. Run the scene in `yarn dev` with `?isDebug=true`, and open the LOD tab's Impostors folder.
   It lists the impostors made this session.
2. **Export** writes four files through the
   [dev file server](hub:features/debug-suite#dev-file-server): `<id>.impostor.json`,
   `<id>.textureAtlas.json` and two PNGs, into `src/app/impostors/` by default
   (`AppConfig.lod.impostorExportDir`). The asset pipeline encodes the PNGs to KTX2, about a
   quarter of a bake's GPU memory.
3. List the id in the scene JSON's `impostors`. The same `generateOctahedralImpostor` /
   `generateCrossQuads` call with that `id` now builds from the export, without baking.

The debug build warns when the source mesh, its material or the options no longer match the
export's fingerprint, and uses the export anyway: export again after changing the mesh.

## Seeing it work

In debug mode, the drawer's LOD tab shows the selection's cost, can freeze the levels or force
one, slows fades down, and draws a box in each object's level colour. An object's LOD window
shows its live screen size and the distance of each switch.

::: scene lodShowcase
**The full demo:** every LOD feature in its own lane, every level of every lane on screen from
the start camera. Its LOD demo tab has camera stops on both sides of every switch and a dolly
down the lanes.
:::

## Key APIs

- [`setMeshLod`](api:setMeshLod), [`setLodBias`](api:setLodBias) and
  [`setLodFadeSeconds`](api:setLodFadeSeconds).
- [`generateLodChain`](api:generateLodChain).
- [`createInstancedMeshPool`](api:createInstancedMeshPool) and
  [`createInstancedLodPool`](api:createInstancedLodPool).
- [`generateCrossQuads`](api:generateCrossQuads) and
  [`generateOctahedralImpostor`](api:generateOctahedralImpostor).
- [`registerLodTarget`](api:registerLodTarget): levels for entities that aren't plain meshes.

## Read more

- The [LOD example](hub:examples/lod).
- [Alpha-cut textures](repo:docs/techniques/asset-optimization.md#alpha-cut-textures) and
  [Impostor atlases](repo:docs/techniques/asset-optimization.md#impostor-atlases) in the asset
  optimization guide.
- The API reference: [Lod](hub:documentation/engine/core/Lod) and
  [Instancing](hub:documentation/engine/core/Instancing).

::: claude-md
:::
