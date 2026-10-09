## What's in it

### ECS effects

A component and its system each, registered in `src/AppECSPlugins.ts` (see
[ECS](hub:features/ecs#plugins-and-hooks)):

- **`HoverEffect`**: bobs an entity up and down (the `HOVER` component).
- **`FollowTool`**: makes an entity follow a target.
- **`SunShadowFit`**: fits a directional light's shadow camera to the main camera's view, so
  shadows stay sharp wherever the camera looks.
- **`MutualGravity`**: Newtonian gravity between the bodies you add with
  [`addGravityBody`](api:addGravityBody), on every physics step, for zero-g scenes.

### TSL materials

Each a `*.material.json` with its `*.tsl.ts`, so a scene lists it by id like any material:
`triplanarCheckerboard`, `triplanarGrid` (both projected from the three axes, in world or object
space, so they need no UVs) and `asteroid`. Their node inputs (colours, scales) are params in the
JSON, which the material editor edits live.

### Procedural geometry

- [`generateTerrain`](api:generateTerrain): a seeded noise terrain, with its height samples and
  a `getHeightAt(x, z)` for placing things on it.
- [`generateTreeGeometry`](api:generateTreeGeometry) and
  [`generateBushGeometry`](api:generateBushGeometry): low-poly foliage.
- [`scatterOnSurface`](api:scatterOnSurface): placements on a mesh's surface, baked into an
  instanced mesh ([`bakeScatterToInstancedMesh`](api:bakeScatterToInstancedMesh)) or spawned as
  entities ([`spawnScatterAsMeshEntities`](api:spawnScatterAsMeshEntities)).
- [`generateAsteroid`](api:generateAsteroid): a rocky body from a seed.
- [`createSeededRandom`](api:createSeededRandom): the seeded random numbers they all use, so the
  same seed gives the same world.

### Models

The Ækasha symbol: the Æ glyph extruded with a small bevel, a Draco GLB with its
`*.importedAsset.json`, ready for a scene's `importedAssets`.

## Using it

- **Import it.** Toolkit code is imported like the engine's, and its asset JSONs are found and
  checked like the app's: a scene lists the `triplanarCheckerboard` material or the `aekashaSymbol` model
  by id.
- **Copy it.** Copy a file into `src/app/`, rename its ids (a JSON's `id`, a component's key) so
  they don't clash with the toolkit's, and change what you need. Your copy is yours; the
  toolkit's keeps getting fixes.
- The toolkit has its own version, next to the engine's and the app's, on the
  [Version](hub:version) page.

## See it

- The [toolkit example](hub:examples/toolkit): the model, two materials and `HoverEffect`.
- The app's `space` scene: toolkit asteroids under `MutualGravity`, at zero world gravity. Open it
  with `?isDebug=true&startScene=space`.

## Read more

- The API reference: [toolkit](hub:documentation/toolkit).
