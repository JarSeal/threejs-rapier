## The model

The Ækasha symbol is a GLB next to its asset JSON in `src/toolkit/models/aekashaSymbol/`:

<<< src/toolkit/models/aekashaSymbol/aekashaSymbol.importedAsset.json

- `fileName` starting with `./` is relative to the JSON. The asset pipeline optimizes the file into
  `src/public/aek-assets/`, and the app loads that output.
- `optimize.mesh.codec` keeps its geometry Draco-compressed (the pipeline's default is meshopt).
- The import registers each mesh's geometry as `<import id>/<node name>`: here
  `aekashaSymbol/aekashaSymbol`. An import registers no meshes or entities of its own.

The model is the Æ of the favicon, extruded with a small bevel: 1 unit high, centred on the
origin and facing +z. `devTools/toolkit/buildAekashaSymbol.ts` builds it from
`src/public/favicon.svg`.

## The scene

The scene JSON lists the import and the two materials, so they're loaded before the scene file
runs:

<<< src/app/examples/toolkit/exampleToolkit.scene.json

<<< src/app/examples/toolkit/exampleToolkit.ts#toolkit-scene

- A mesh takes the imported geometry by its id (`geo: 'aekashaSymbol/aekashaSymbol'`) and any
  material: the toolkit's materials don't need UVs, they project their pattern from the object's
  own axes (triplanar).
- `matOverrides` gives one mesh a variant of a registered material: here other checker colours.
  Meshes with the same overrides share one variant.
- The `HOVER` component is the toolkit's hover effect, the same as in the
  [quick start](hub:examples#your-first-scene). Its system is registered for the whole app in
  `src/AppECSPlugins.ts`, so any entity can use it.

Back to the [examples](hub:examples).
