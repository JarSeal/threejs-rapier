## The scene

<<< src/app/examples/lod/exampleLod.ts#lod-scene

1. The knot is a registered geometry ([`saveBufferGeometry`](api:saveBufferGeometry)): a chain
   is generated for a geometry id.
2. [`generateLodChain`](api:generateLodChain) simplifies it with meshoptimizer in the assets
   worker, into levels registered as `lodExampleKnot#lod1` and so on. Each level shares the knot's
   vertices and has its own, smaller index. A chain can come out shorter than asked for: a mesh
   with nothing to remove has only its base.
3. [`generateOctahedralImpostor`](api:generateOctahedralImpostor) renders the knot from 144
   directions into an atlas. Its material turns the quad toward the camera and blends the three
   nearest views, lit like the knot.
4. A level is used while the object's height on screen, as a fraction of the screen's, is at
   least its `screenSize`. The sizes go down from the finest level, and the last is 0, so the
   impostor is used however far away a knot is.
5. Each placement is one knot: an entity with its own transform.
6. [`createInstancedLodPool`](api:createInstancedLodPool) makes an instanced mesh per level. Every
   frame the LOD system picks each knot's level and moves it into that level's mesh. A level
   change cross-fades through a dither, so nothing pops.

## Seeing the levels

In debug mode, open the drawer's LOD tab (`h`) and turn on **Level boxes** in its Overlay
folder: every object gets a box in its level's colour. The tab also shows the selection's cost,
can freeze the levels or force one, and slows the fades down to look at them.

## The impostor

Here the impostor is baked when the scene loads, in about 40-115 ms. To load it instead, export
it from the LOD tab's Impostors folder while the scene runs in `yarn dev`: the export writes
`lodExampleKnotImpostor.impostor.json`, an atlas JSON and two PNGs into `src/app/impostors/`
(a later export writes wherever its files are then). List the id in the scene JSON's
`impostors`, and the same call then builds the impostor from those files. The debug build
warns when the knot or its material no longer matches the export.

## Other ways in

- A single mesh takes levels through its `lod` prop ([`setMeshLod`](api:setMeshLod)), or
  `lod: 'AUTO'` to pick levels from its geometry's chain by their error in pixels.
- A `*.mesh.json` can list hand-made levels, and an `*.importedAsset.json` can ask the asset
  pipeline to build the chain into the GLB (`lodChain`), so nothing is simplified at load.
- For foliage, [`generateCrossQuads`](api:generateCrossQuads) makes a cheaper impostor: two or
  three crossed planes.

::: scene lodShowcase
**The full demo:** every LOD feature in its own lane, every level on screen from the start
camera, with a tab to fly through them.
:::

Back to the [examples](hub:examples).
