## A scene

<<< src/app/examples/quickStart/exampleQuickStart.scene.json

- `sceneFile` is the scene's code, from `src/app/`. It exports `scene`, which the engine calls
  once the JSON's assets are loaded.
- The lists name assets by their id (or hold one inline): `cameras`, `lights`, `geometries`,
  `textures`, `materials`, `meshes`, `importedAssets`, `skyboxes` and `postFx`. The lights,
  cameras and meshes are created right after the scene file runs, so its code reaches them on the
  scene's enter.
- Other keys set up the scene itself: `postFxEnabled`, `backgroundColor`, `spatialDomains` (see
  [Spatial index](hub:features/spatial-index)) and `impostors` (see
  [LOD and impostors](hub:features/lod#exporting-an-impostor)).
- `name` is the scene's name in the debugger's scene lists.

## The asset types

The engine finds every file with one of these suffixes under `src/` by itself:

| Suffix                 | What it is                                                                 |
| ---------------------- | -------------------------------------------------------------------------- |
| `*.scene.json`         | A scene.                                                                   |
| `*.camera.json`        | A perspective or orthographic camera.                                      |
| `*.light.json`         | A light of any three.js type.                                              |
| `*.geometry.json`      | A geometry: a three.js type and its params.                                |
| `*.texture.json`       | A texture, and how the asset pipeline encodes it.                          |
| `*.textureArray.json`  | Textures of one size as the layers of one array texture.                   |
| `*.textureAtlas.json`  | Images packed into one atlas, each a named slot.                           |
| `*.material.json`      | A material: a three.js one, or a TSL node material with its `tslFile`.     |
| `*.mesh.json`          | A mesh: its geometry, material, transform, shadows and levels of detail.   |
| `*.importedAsset.json` | A glTF or GLB model to import, and how the asset pipeline optimizes it.    |
| `*.skybox.json`        | A [sky box](hub:features/sky-box).                                         |
| `*.postFx.json`        | A [PostFX pass](hub:features/rendering#post-effects), with its `*.tsl.ts`. |
| `*.impostor.json`      | An exported [impostor](hub:features/lod#impostors), written by its export. |

Each has a Zod schema in `src/_engine/schemas/`. Start a file with a `$schema` line pointing at
`.schemas/<type>.schema.json`, and your editor checks and autocompletes it as you type.

## The gatherer

`devTools/gatherAppData.ts` walks `src/`, checks every asset JSON against its schema, and writes
the generated data the engine loads its scenes from. It runs before `yarn dev` and `yarn build`,
and in `yarn dev` on every save: the page reloads with the change, and an invalid file shows an
error overlay naming the file and the problem. `yarn gatherAppData` runs it by hand.

The textures and models the JSONs point at go through the
[asset pipeline](hub:features/asset-optimization) first.

## Per-scene overrides

An asset shared by several scenes can look different in one of them. Its `__saveData` holds,
per scene id, a list of overrides, newest first, and the scene uses the newest:

```json
{
  "__saveData": {
    "myScene": [
      {
        "__meta": { "date": 1779449688109, "engineVersion": "4.14.0" },
        "intensity": 0.5
      }
    ]
  }
}
```

An entry's `__meta` records the versions it was saved with, and the gatherer warns when the
entry in use comes from another major version. Debug tools write these entries through the
[dev file server](hub:features/debug-suite#dev-file-server).

## Loading scenes

[`loadScene`](api:loadScene) switches scenes. A load:

1. Deletes the previous scene's physics entities and loopers, runs its exit hooks, then deletes
   every other entity it created, except those created with `persistent: true`.
2. Starts a fresh physics world (see
   [deterministic scene loads](hub:features/physics#deterministic-scene-loads)).
3. Loads the next scene's assets, then runs its scene file and creates its JSON objects.
4. Releases what the previous scene loaded and the next one doesn't use. An asset both use is
   kept, not loaded again. (`deletePrevScene: true` releases first instead: a lower peak in
   memory, but shared assets load again.)
5. Runs the next scene's enter hooks.

[`createSceneLoader`](api:createSceneLoader) gives the load its screen: your functions for its
start and end and its progress, with a HUD element of its own.

In a scene file, [`registerOnSceneEnter`](api:registerOnSceneEnter) and
[`registerOnSceneExit`](api:registerOnSceneExit) add hooks,
[`createSceneAppLooper`](api:createSceneAppLooper) runs a function every frame while the app
plays (and [`createSceneMainLooper`](api:createSceneMainLooper) also while it's paused), and
scene-scoped features take a `sceneId` to remove themselves on exit. A system that should run
in lockstep with physics goes in the ECS instead (see [ECS](hub:features/ecs#systems-and-stages)).

## Key APIs

- [`loadScene`](api:loadScene) and [`createSceneLoader`](api:createSceneLoader).
- [`registerOnSceneEnter`](api:registerOnSceneEnter),
  [`registerOnSceneExit`](api:registerOnSceneExit),
  [`createSceneAppLooper`](api:createSceneAppLooper) and
  [`createSceneMainLooper`](api:createSceneMainLooper).
- [`getMaterial`](api:getMaterial), [`getTexture`](api:getTexture) and
  [`getGeometry`](api:getGeometry): the assets a scene loaded, by id.
- [`createMeshEntity`](api:createMeshEntity), [`createMaterial`](api:createMaterial) and
  [`importAssetAsync`](api:importAssetAsync): the same assets from code.

## Read more

- The [quick start](hub:examples#quick-start).
- The API reference: [Scene](hub:documentation/engine/core/Scene),
  [SceneLoader](hub:documentation/engine/core/SceneLoader) and the
  [schemas](hub:documentation/engine/schemas).

::: claude-md
:::
