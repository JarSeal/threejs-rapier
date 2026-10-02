# Ækasha

**A high-performance WebGPU game engine framework for the web, built on Three.js and Rapier.**

Ækasha (`aekasha-js`) is the "fifth element" and the invisible medium where complex data turns into immersive, real-time 3D. It pairs Three.js's WebGPU renderer with a bitwise-packed ECS, a threaded Rapier physics core and a data-driven scene pipeline. Scenes are authored as validated JSON and extended with TypeScript, and a full in-browser debug suite tree-shakes out of production builds.

The repository is a template. It holds the engine, a toolkit of reusable modules and an example app, so you can clone it and start building your own game or interactive experience.

---

## Why Ækasha?

Building a serious 3D app on the web usually means gluing together a renderer, a physics engine, an asset loader, a game loop and a pile of debug UI, and then fighting the main thread for every millisecond. Ækasha puts those pieces together around a few principles:

- **Primordial performance.** Built for WebGPU from the ground up, with WebGL as the fallback. The GPU is the main canvas for logic and rendering.
- **Modular infinity.** An ECS core with opt-in plugins and systems. You only bring in what you need, and nothing else ends up in the bundle.
- **Threaded reality.** Physics runs in a Web Worker by default, and transforms come back through a `SharedArrayBuffer`. Asset decoding can be moved off the main thread too, so the frame keeps flowing.
- **Data-driven, type-safe content.** Scenes, meshes, cameras, lights, materials, textures, skyboxes and PostFX passes are JSON files, checked against Zod schemas at build time and autocompleted in your editor.
- **Deterministic by design.** A scene simulates identically on every load, in both physics thread modes, and a built-in probe proves it.
- **Debug everything, ship nothing extra.** A rich debug drawer, a fly camera, undo/redo and physics visualizers load lazily in debug builds only.

---

## Features

### Engine (`src/_engine/`)

- **Rendering**: Three.js `WebGPURenderer` with automatic WebGL fallback, configurable tone mapping, color space and shadow maps.
- **ECS**: entity ids pack an index and a generation. Plugins and component hooks can be registered at runtime, systems run in fixed stages, and transform storage is either a `Map` or a typed-array (SoA) store.
- **Physics API**: an engine-agnostic facade with Rapier as the backend. It covers rigid bodies, colliders (including heightfields and imported mesh colliders), impulse joints, ray casts and shape casts, contact and collision events, and fixed-timestep stepping with render interpolation.
- **Threaded physics**: `WORKER_THREAD` or `MAIN_THREAD` mode. The worker syncs every body's transform through one shared buffer per frame, never one message per body. The buffer is a lock-free triple buffer, so every system in a frame reads the same complete physics step.
- **Deterministic scene loads**: physics is held during a scene load, the world is recreated fresh, and stepping resumes only after every body exists.
- **Scene system**: JSON scenes with per-scene overrides (`__saveData`), a customizable scene loader with progress callbacks, and persistent or scene-scoped entities.
- **Assets**: glTF/GLB import (with Draco), textures, HDR environment maps, per-scene asset ownership and release, and optional worker-thread loading.
- **Cameras and lights**: ECS-managed perspective and orthographic cameras, all Three.js light types, frustum culling for objects and lights, and a follow-camera rig.
- **PostFX**: an ordered, per-scene chain of TSL passes (`*.postFx.json` + `*.tsl.ts`), switchable per pass at runtime, with ambient occlusion (GTAO) included.
- **Viewports**: extra render rectangles with their own scene and camera (picture-in-picture, minimaps, item previews), placed by the DOM and working with or without PostFX.
- **Lines**: pooled thin and thick lines with screen-space dashes and ECS binding.
- **Spatial index**: a uniform grid with an oversized tier for "what's near this point/volume" queries.
- **Ray casting**: Three.js and physics ray APIs with per-frame statistics and debug helpers.
- **Input**: keyboard, mouse, touch and gamepad, plus picking and rebindable key chords.
- **Characters**: a dynamic, physics-driven character controller that handles slopes and moving platforms, with swappable body plans (a humanoid capsule built in). Characters are driven through an intent object, from tank, world-fixed (8-direction) or camera-relative keyboard controls, or from code. A locomotion state (idle, walk, run, jump, fall, slide, tumble, …) reports what each one is doing, and a physics-only control mode hands the body to physics, eg. for a ragdoll.
- **Sky box**: a layered sky that is both the background and the scene's environment lighting, so reflections match what you see. The base is a colour, an equirectangular (including HDR) or a cube map, and procedural layers go on top: a physically based atmosphere, up to four suns and two phased moons (each can drive a shadow-casting light), stars with a Milky Way, baked nebulae, clouds, a ground and ambient light. A day/night cycle moves the suns, moons and stars from a time of day you can play, pause, speed up or set from code. Presets (`DAY_SKY`, `NIGHT_SKY`, `DAY_NIGHT`, `SPACE`) give a starting point for a definition.
- **UI**: a lightweight component helper (`CMP`), a HUD layer, draggable windows, dialogs and toasts.

### Toolkit (`src/toolkit/`)

These are ready-made modules you can import as they are, or copy into your app and change:

- **ECS effects**: `HoverEffect` (bobbing), `FollowTool` (follow a target), `SunShadowFit` (fits a directional light's shadow to the camera's view) and `InstancedMeshPool` (instanced rendering managed by the ECS).
- **TSL materials**: checkerboard, triplanar checkerboard and triplanar grid materials.
- **Procedural geometry**: seeded noise terrain, foliage generation and scattering on surfaces.

### Debug suite (debug builds only)

- A tabbed **debug drawer** (`h`) built on Tweakpane, with tabs for stats, main loop, renderer, physics, ECS, assets, PostFX (with a GPU profiler), skybox, spatial index, ray casting and characters. Its state is saved to localStorage.
- A **debug fly camera** (`F1`), an axes gizmo (`F10`), an environment ball (`F9`) and a debug scene loader.
- **Undo/redo** for changes made in the debugger.
- **Physics visualizers**: collider wireframes colored by body state, ray helpers, and query statistics.
- **Ray tester windows** for firing Three.js or physics rays at the scene.
- A **character state window** per character, showing its live data grouped and formatted, with freeze and copy. Its configuration values can be **edited live** (with undo, reset, copy-out as code and saving across reloads). It also toggles in-world **character gizmos** for the vectors and probes its controller decides from (velocity, facing, ground normal, floor ray and sensor, wall cast, trail), which can be pinned to stay after the window closes.
- A **determinism probe** (`?physicsProbe=N`) that hashes and diffs the physics state after N fixed steps.
- **Production test mode** (`?isProdTest=true`), which runs a production build with a subset of the debug tools.
- **Stress tests** for the ECS and physics.

---

## Technical highlights

| Area                   | How it works                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame pipeline         | Fixed stage order every frame: `MAIN → APP_PRE_PHYSICS → [APP_PHYSICS_STEP × N] → APP_POST_PHYSICS → APP_LOGIC → APP_RENDER_SYNC → LATE_MAIN`. `APP_PHYSICS_STEP` runs once per fixed sub-step, in lockstep with the simulation. |
| Physics ↔ render sync | A physics-owned transform buffer, which is a real `SharedArrayBuffer` when the page is cross-origin isolated (the dev server sends COOP/COEP headers) and falls back to one batched message per frame otherwise.                 |
| Worker commands        | The commands issued in `APP_PHYSICS_STEP` are captured per sub-step, carried in that frame's single STEP message, and replayed in order in the worker.                                                                           |
| Content pipeline       | `devTools/gatherAppData.ts` walks `src/`, validates every asset JSON file with Zod, generates typed runtime data and emits JSON Schema for editor autocomplete. It runs on every file save through a Vite plugin.                |
| Tree-shaking           | Debug implementations live in `_dbg__*` files that are loaded only through a dynamic `import()` behind `IS_DEBUG_ENV`, so production bundles don't contain them.                                                                 |
| Save data              | Each asset file stores per-scene override history stamped with the engine, toolkit and app versions, and the gatherer warns when an entry comes from another major version.                                                      |
| Versioning             | Engine, toolkit and app are versioned independently, with release tags and a checksum meta tag in the built HTML.                                                                                                                |

---

## Getting started

### Requirements

- Node.js `>= 22.13.0` and Yarn `>= 1.22.15`
- A browser with WebGPU (recent Chrome, Edge or Safari; Firefox with WebGPU enabled). Other browsers fall back to WebGL 2.

### Install and run

```bash
git clone https://github.com/JarSeal/threerapier.git my-game
cd my-game
yarn
yarn dev            # http://localhost:8080
```

Open `http://localhost:8080/?isDebug=true` to get the full debug suite, then press `h` to open the drawer.

### Commands

| Command                               | Description                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `yarn dev`                            | Dev server (development env) with hot scene/asset regeneration.                 |
| `yarn dev:test`                       | Dev server with `VITE_APP_ENV=test`.                                            |
| `yarn dev:production`                 | Dev server with production env vars.                                            |
| `yarn build`                          | Type-check and production build to `dist/` (bundle treemap in `dist-stats/`).   |
| `yarn build:test`                     | Production build with `VITE_APP_ENV=test`.                                      |
| `yarn lint`                           | ESLint with Prettier.                                                           |
| `yarn docs`                           | TypeDoc API docs for the engine and toolkit, written to `docs-api/`.            |
| `yarn gatherAppData`                  | Runs the JSON → generated data pipeline by hand.                                |
| `yarn checkVersions [--against main]` | Checks the versioning rules (run it with `--against main` before opening a PR). |
| `yarn tagRelease`                     | Tags the engine, toolkit and app versions after a merge to `main`.              |

### URL flags (development and test builds)

| Flag               | Effect                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| `?isDebug=true`    | Full debug tooling.                                                       |
| `?isProdTest=true` | Production behavior with a subset of the debug tools.                     |
| `?physicsProbe=N`  | Freezes physics N steps after each scene load and logs a state hash diff. |

---

## Project structure

```text
.
├── src/
│   ├── _engine/            # The core engine: stable library code
│   │   ├── core/           # Renderer, ECS, scenes, physics, characters, assets, cameras,
│   │   │                   # lights, PostFX, viewports, lines, input, spatial index, UI
│   │   ├── debug/          # Thin public debug entry points (lazy-load core/Debug/_dbg__*)
│   │   ├── schemas/        # Zod schemas for every asset JSON type
│   │   ├── workers/        # Physics and asset worker threads
│   │   └── utils/          # Helpers, camera rigs, world test objects, stress tests
│   ├── toolkit/            # Reusable ECS effects, TSL materials and procedural geometry
│   ├── app/                # Your game: *.scene.json + scene .ts files and asset JSON files
│   ├── AppECSPlugins.ts    # Wires app and toolkit systems into the ECS
│   ├── AppECSRegistry.ts   # App component types, data shapes and system stages (type-only)
│   ├── CONFIG.ts           # App configuration (physics, debug keys, debug camera…)
│   ├── index.ts            # App entry: renderer, scene loader, first scene
│   └── index.html
├── devTools/               # Data gatherer, version checks, release tagging
├── docs/plans/             # Feature plans and specs (priority-ordered)
├── .schemas/               # Generated JSON Schemas for editor autocomplete
├── CHANGELOG.md
└── vite.config.ts
```

The split between `_engine`, `toolkit` and `app` is a convention: the engine stays stable, the toolkit ships with it, and `app` is yours to change.

---

## Examples

### 1. Boot the engine

```ts
// src/index.ts
import * as THREE from 'three/webgpu';
import { InitEngine } from './_engine/InitApp';
import { createRenderer } from './_engine/core/Renderer';
import { createSceneLoader, loadScene } from './_engine/core/SceneLoader';

InitEngine(async () => {
  await createRenderer({
    antialias: true,
    toneMapping: THREE.ACESFilmicToneMapping,
    enableShadows: true,
    shadowMapType: THREE.VSMShadowMap,
  });
  createSceneLoader({ id: 'main-scene-loader' /* loader UI callbacks… */ });
  await loadScene({ sceneId: 'myScene' });
});
```

### 2. Author a scene in JSON

Each file is validated against its schema, and the `$schema` line gives you autocomplete in the editor.

```jsonc
// src/app/myScene.scene.json
{
  "$schema": "../../.schemas/scene.schema.json",
  "id": "myScene",
  "sceneFile": "./myScene.ts",
  "name": "My scene",
  "cameras": ["mainCamera"],
  "lights": ["ambientLight"],
  "materials": ["checkerBoard"],
  "meshes": ["testMesh"],
  "skyboxes": ["basicSkybox"],
}
```

```jsonc
// src/app/meshes/testMesh.mesh.json
{
  "$schema": "../../../.schemas/mesh.schema.json",
  "props": {
    "appId": "testMesh",
    "geo": "testSphere",
    "mat": "checkerBoard",
    "castShadow": true,
    "position": { "x": 4, "y": 1, "z": 2 },
  },
}
```

### 3. Add code-driven content and physics

The `sceneFile` exports a `scene` function that runs while the scene loads.

```ts
// src/app/myScene.ts
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';

export const scene = async () => {
  const position = { x: 0, y: 5, z: 0 };
  const geo = createGeometry({ id: 'ball', type: 'SPHERE', params: { radius: 0.4 } });
  const mat = createMaterial({ id: 'ball', type: 'STANDARD', params: { color: 0xff5533 } });

  const ballId = createMeshEntity({ geo, mat, position, castShadow: true }, { appId: 'ball' });

  // Attach a dynamic rigid body. Its transform syncs back to the mesh every frame.
  await createPhysicsEntity(
    { type: 'BALL', radius: 0.4, restitution: 0.6 },
    { rigidType: 'DYNAMIC', translation: position },
    ballId
  );
};
```

### 4. Write your own component and system

```ts
// src/AppECSRegistry.ts: declare the component type and its data shape
export const AppComponentType = { SPIN: 'APP_SPIN' /* , ... */ } as const;
export interface AppComponentData extends ExtraComponentData {
  [AppComponentType.SPIN]: { speed: number };
}
```

```ts
// src/app/systems/spin.ts
import * as THREE from 'three/webgpu';
import type { ECSWorld } from '../../_engine/core/ECS';
import { ComponentType } from '../../_engine/core/ECS/ECSCoreComponents';
import { ECSSystemStage } from '../../AppECSRegistry';

const UP = new THREE.Vector3(0, 1, 0);
const step = new THREE.Quaternion(); // reused scratch, no per-frame allocation

const spinSystem = (world: ECSWorld, dt: number) => {
  for (const [entityId, { speed }] of world.getStorage(ComponentType.SPIN)) {
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) continue;
    transform.quaternion.multiply(step.setFromAxisAngle(UP, speed * dt));
    transform.setDirty();
    world.commitTransform(entityId, transform); // needed in both storage modes
  }
};

export const registerSpinSystem = (world: ECSWorld) =>
  world.addSystem(ECSSystemStage.APP_LOGIC, 'spinSystem', spinSystem);
```

```ts
// src/AppECSPlugins.ts: wire it in
ECSWorld.registerPlugin((world) => {
  registerSpinSystem(world);
});

// Anywhere in scene code:
ecsWorld.addComponent(ballId, ComponentType.SPIN, { speed: 2 });
```

> Anything that moves physics bodies (poses, velocities, impulses, kinematic targets) goes in an `APP_PHYSICS_STEP` system, so it stays in lockstep with the simulation and deterministic.

### 5. Configure the app

```ts
// src/CONFIG.ts
const config: AppConfig = {
  physics: {
    enabled: true,
    gravity: { x: 0, y: -9.81, z: 0 },
    timestep: 60,
    workerTarget: 'WORKER_THREAD', // or 'MAIN_THREAD'
    useSAB: true,
    interpolationMode: 'RENDERER',
  },
  debugKeys: [{ id: 'sc-toggle-debug-drawer', chord: { key: 'h' } }],
};
```

The example scenes in [`src/app/`](src/app/) cover more: a physics and joints test, a large procedural world with instancing and culling, a third-person character gym, a top-down character scene (world-fixed controls, hills, and sun shadows fitted to the view), and an ECS stress test.

---

## Roadmap

Planned work is specified in [`docs/plans/`](docs/plans/), where a lower number means a higher priority. Highlights:

- An editor/creator view and a material editor
- Physics objects in the scene JSON schema, physics world bounds, multibody joints and physics snapshot restore
- Component query caching
- A client device capability sniffer, an asset optimization pipeline and an LOD system

---

## Versioning and changelog

The engine, toolkit and example app each have their own semantic version and codename in `package.json`. The engine's codenames follow the sun's path, the toolkit's follow the moon's phases, and the app's follow life stages. The project version always matches the engine version. See [`CHANGELOG.md`](CHANGELOG.md) for the release history.

## Documentation

- **API reference**: run `yarn docs` and open `docs-api/index.html` (covers the engine and the toolkit).
- **Design docs**: [`docs/plans/`](docs/plans/). Files prefixed `_DONE_` describe features that are already implemented.
- **Contributor and agent guide**: [`.claude/CLAUDE.md`](.claude/CLAUDE.md).

## Built with

[Three.js](https://threejs.org/) (WebGPU + TSL) · [Rapier](https://rapier.rs/) · [Vite](https://vitejs.dev/) · [TypeScript](https://www.typescriptlang.org/) · [Zod](https://zod.dev/) · [Tweakpane](https://tweakpane.github.io/docs/) · [stats-gl](https://github.com/RenaudRohlinger/stats-gl)

## License

MIT © JarSeal
