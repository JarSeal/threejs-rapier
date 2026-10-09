## The renderer

The app creates the renderer once, first thing in its start callback (`src/index.ts`):

<<< src/index.ts#create-renderer

- [`createRenderer`](api:createRenderer) uses WebGPU when the browser has it and `forceWebGL`
  is off, and WebGL 2 otherwise. [`isWebGPURenderer`](api:isWebGPURenderer) tells you which one
  runs.
- The options are three's: antialiasing, tone mapping and its exposure, the output colour space,
  a transparent canvas (`alpha`), shadows and the shadow map type.
- In the debug env, the drawer's Renderer tab changes them and keeps the change for the next
  reload.

## Post effects

A scene's post effects are an ordered chain of PostFX passes, rendered through a TSL
`RenderPipeline`. A pass is two files: a `*.postFx.json` with its params, and a `*.tsl.ts` that
builds its node. The scene JSON lists them in order:

```json
{
  "postFx": ["heroBloom"],
  "postFxEnabled": true
}
```

The homepage image above has one pass, a bloom:

::: code-group

<<< src/app/examples/hubHero/heroBloom.tsl.ts title="heroBloom.tsl.ts"

<<< src/app/examples/hubHero/heroBloom.postFx.json title="heroBloom.postFx.json"

:::

- `fxNode` gets the pass's params and the chain so far: `ctx.colorNode` is the previous pass's
  output (the scene's colour for the first one). `ctx.sceneNormalNode` and `ctx.sceneDepthNode`
  give view-space normals and depth, from an extra scene render that only runs when a pass reads
  them.
- It returns a node, or the node with hooks: `setParam` takes a param change live, without a
  shader recompile (without it, a change rebuilds the chain), and `profileNodes` names the nodes
  the PostFX profiler times as this pass.
- `paramsMeta` gives the debugger's PostFX tab its sliders. The tab switches passes on and off
  and edits their params live, and its profiler times each pass on the GPU (WebGPU only).
- From code, [`setPostFxEnabled`](api:setPostFxEnabled) switches the whole chain,
  [`setPostFxPassEnabled`](api:setPostFxPassEnabled) one pass, and
  [`setPostFxPassParam`](api:setPostFxPassParam) sets a param.
- A change to the set of enabled passes recompiles the chain, a one-frame hitch. A disabled pass
  costs nothing, and switching the whole chain off keeps it compiled.

The app has another pass to start from: ambient occlusion (GTAO) in `src/app/postFx/`.

## Snapshots

[`takeSnapshotAsync`](api:takeSnapshotAsync) renders a scene into an image off screen, at any
size: thumbnails, save game pictures, or the images on these pages, which the example scenes'
Hub tab saves with it.

```ts
const snapshot = await takeSnapshotAsync({ width: 1600, height: 1000 });
const png = await snapshotToBlobAsync(snapshot); // Or { type: 'image/webp' }
```

By default it's what the canvas shows: the active camera, through the scene's post effects,
without the viewports, the HUD or the debug helpers. Pass `scene` and `camera` to render
anything else, and `transparent: true` for a transparent background. The canvas isn't touched.

## More on screen

- [Viewports](hub:features/viewports): extra rectangles over the canvas with their own scene and
  camera, drawn after the post effects.
- [Sky box](hub:features/sky-box): the background and the environment lighting.
- [LOD and impostors](hub:features/lod): fewer triangles for what's far away.

## Key APIs

- [`createRenderer`](api:createRenderer), [`getRenderer`](api:getRenderer) and
  [`isWebGPURenderer`](api:isWebGPURenderer).
- [`setPostFxEnabled`](api:setPostFxEnabled), [`setPostFxPassEnabled`](api:setPostFxPassEnabled),
  [`setPostFxPassParam`](api:setPostFxPassParam) and [`getPostFxPasses`](api:getPostFxPasses).
- [`takeSnapshotAsync`](api:takeSnapshotAsync) and [`snapshotToBlobAsync`](api:snapshotToBlobAsync).

## Known issues

Two three.js r186 issues of the WebGPU renderer keep memory after a scene is gone. Neither has a
workaround in the engine yet:

- [Disposed lights stay in memory](hub:issues/three-bind-group-cache-light-leak).
- [A removed `InstancedMesh` leaks its instance attributes](hub:issues/three-instanced-node-attribute-leak).

## Read more

- The [quick start](hub:examples#quick-start): the dev environment and the smallest complete
  scene.
- The API reference: [Renderer](hub:documentation/engine/core/Renderer),
  [PostFX](hub:documentation/engine/core/PostFX) and
  [Snapshot](hub:documentation/engine/core/Snapshot).

::: claude-md
:::
