## Quick start

### Requirements

- Node.js 22.13.0, the version in the repo's `.nvmrc`. With [nvm](https://github.com/nvm-sh/nvm),
  `nvm use` in the repo picks it (`nvm install` first if you don't have it).
- Yarn 1 (`>= 1.22.15`).
- A browser with WebGPU: a recent Chrome, Edge or Safari, or Firefox with WebGPU enabled. Other
  browsers fall back to WebGL 2.

### Install and run

```bash
git clone https://github.com/JarSeal/aekasha-js.git my-game
cd my-game
nvm use
yarn
yarn dev
```

The dev server runs at `http://localhost:8080`. Open `http://localhost:8080/?isDebug=true` for
the full debug tooling, then press `h` to open the debug drawer.

::: tip On a phone
A phone on your network needs a secure context for WebGPU and `SharedArrayBuffer`, which a plain
`http://` address isn't. `yarn dev:https` serves the app over HTTPS on port 8443 with a
self-signed certificate: open `https://<your computer's address>:8443/?isDebug=true` on the phone
and accept the certificate.
:::

### Your first scene

::: scene exampleQuickStart
The smallest complete scene: a camera and two lights, a ground, and a cube with the toolkit's
checker board material, hovering.
:::

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
  listed.
- [`addComponent`](api:ECSWorld.addComponent) gives the cube the toolkit's `HOVER` component.
  A system updates every entity that has it once a frame, so the cube needs nothing else.
- Everything the scene creates is removed when another scene loads.

### Make it yours

1. Copy the `src/app/examples/quickStart/` folder and rename its ids (the `id` in the scene JSON,
   the files and their `appId`s).
2. Open it with `?startScene=<your scene id>` next to `?isDebug=true`, or make it the app's start
   scene in `src/index.ts` (`loadScene({ sceneId: '<your scene id>' })`).
3. Edit the scene file or the JSON: the page reloads with the change.

### Next

Drop some shapes onto the ground in the [physics example](hub:examples/physics), or see the
[toolkit example](hub:examples/toolkit) for a model, materials and an effect from the toolkit.
