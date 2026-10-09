## Your first scene

A scene is a JSON file and a scene file. The JSON names what the engine loads before the scene
file runs: here its camera, its lights and a material. Each one is a JSON file of its own,
referenced by its id, so scenes can share them.

<<< src/app/examples/quickStart/exampleQuickStart.scene.json

The engine finds every `*.scene.json` under `src/` by itself and checks it against its schema.
The `$schema` line gives your editor the same checks and autocompletion.

::: code-group

<<< src/app/examples/quickStart/exampleQuickStartCamera.camera.json title="Camera"

<<< src/app/examples/quickStart/exampleQuickStartSun.light.json title="Sun"

<<< src/app/examples/quickStart/exampleQuickStartAmbient.light.json title="Ambient light"

:::

The scene file exports `scene`, which the engine calls once the JSON's assets are loaded:

<<< src/app/examples/quickStart/exampleQuickStart.ts#quick-start

- [`createMeshEntity`](api:createMeshEntity) makes an entity with a mesh. Its geometry and
  material can be props, registered under their `id` the first time (the ground), or ones that
  are registered already: [`getMaterial`](api:getMaterial) returns the material the scene JSON
  listed. `matOverrides` makes a variant of it ([`getMaterialVariant`](api:getMaterialVariant)),
  here one without the checkerboard's plus signs.
- [`addComponent`](api:ECSWorld.addComponent) gives the cube the toolkit's `HOVER` component.
  A system updates every entity that has it once a frame, so the cube needs nothing else.
- Everything the scene creates is removed when another scene loads.

## Make it yours

1. Copy the `src/app/examples/quickStart/` folder and rename its ids (the `id` in the scene JSON,
   the files and their `appId`s).
2. Open it with `?startScene=<your scene id>` next to `?isDebug=true`, or make it the app's start
   scene in `src/index.ts` (`loadScene({ sceneId: '<your scene id>' })`).
3. Edit the scene file or the JSON: the page reloads with the change.

## Next

Drop some shapes onto the ground in the [physics example](hub:examples/physics), or see the
[toolkit example](hub:examples/toolkit) for a model, materials and an effect from the toolkit.
