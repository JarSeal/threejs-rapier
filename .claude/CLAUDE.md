# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Aekasha (Ækasha) — a WebGPU/Three.js + Rapier physics game engine framework (package name `aekasha-js`). It's a "template" repo: an engine (`_engine`) plus one example app (`app`) built on top of it.

### Aekasha brand, feeling, and core principles

Ækasha is a high-performance WebGPU framework for the modern web. Driven by a modular ECS and a threaded physics core, it acts as the "fifth element" for developers — the invisible medium where complex data transforms into immersive reality.

Primordial Performance: Engineered from the ground up for WebGPU, Ækasha treats the GPU not as a peripheral, but as the primary canvas for logic and rendering.

Modular Infinity: Like the Akasha of myth, the framework is infinite and modular. You only bring into existence what you need, keeping the "memory space" clean and light.

Threaded Reality: By offloading heavy physics calculations and asset loading to dedicated threads via the physics API and asset loading API, Ækasha ensures that the "flow" of the user experience remains uninterrupted.

Maintain the brand, feeling, and core principles in creating the best UX for both, the developer and the end user!

## Commands

- `yarn dev` — start the dev server (Vite, port 8080), development env.
- `yarn dev:https` — `yarn dev` over HTTPS on port 8443 (`AEK_DEV_HTTPS=true` adds `@vitejs/plugin-basic-ssl`'s self-signed certificate): a phone on the LAN needs a secure context for WebGPU and `SharedArrayBuffer`, which a plain `http://` LAN address isn't.
- Dev file server env vars (`_DONE_p342`, every `dev*` script): `AEK_DEV_FILES=false` turns its routes off; `AEK_DEV_FILES_LAN=true` lets other devices on the LAN write too (a phone under `yarn dev:https`; by default only the server's machine can). Its self-check: `devTools/devFiles/CLAUDE.md`.
- `yarn dev:test` — dev server with `VITE_APP_ENV=test`.
- `yarn dev:production` — dev server against production env vars.
- `yarn build` — type-check (`tsc`, then `tsc -p hub`) + production build to `dist/`, then the Ækasha Hub into `dist-hub/` (`yarn hub:build`, below). Its asset checks (missing outputs, budgets): `devTools/assetPipeline/CLAUDE.md`.
- `yarn build:test` — production build with `VITE_APP_ENV=test`.
- `yarn lint` — ESLint (flat config in `eslint.config.js`, Prettier enforced as a lint rule).
- `yarn docs` — generate TypeDoc docs into `docs-api/` (scoped to `src/_engine/**/*.ts` and `src/toolkit/**/*.ts` minus `_dbg__*` and `generatedApp*`, `typedocOptions` in `tsconfig.json` — the engine and the toolkit are the documented public API surface; `app` is not documented). The folder is gitignored and TypeDoc wipes it on every run, so never point `out` at `docs/`. TypeDoc's own theme, kept as a fallback: the Hub's Documentation section (see Ækasha Hub) renders the same model, with the same excludes.
- `yarn hub:build [--out <dir>] [--no-api]` — build the Ækasha Hub (see Ækasha Hub) into `dist-hub/` (gitignored, emptied first; `devTools/hubBuild.ts`). Errors, `--no-api`, `AEK_HUB`, `AEK_HUB_IN_DIST`: `devTools/hub/CLAUDE.md`.
- `yarn hub:preview [--base /hub/] [--port 8090] [--dir dist-hub]` — serve the built Hub as a static host would (`devTools/hubPreview.ts`: directory URLs, `404.html` with a 404; not `vite preview`, whose SPA fallback serves the homepage for a missing path). `--base /hub/` checks it under a path, as `AEK_HUB_IN_DIST` serves it.
- `yarn gatherAppData` — manually run the scene/asset JSON → generated data pipeline (see below); this also runs automatically before `dev`/`build` and via a Vite plugin on file save.
- `yarn setupAssetTools [--force]` — download the pinned KTX-Software `ktx` encoder (`_DONE_p300`) into the gitignored `.tools/` (Linux incl. WSL2, macOS; x64/arm64), SHA-256 checked, unpacked with Node alone (`devTools/assetPipeline/ktxTool.ts`, `archives.ts`). More: `devTools/assetPipeline/CLAUDE.md`.
- `yarn assets [--only <id|glob>]` — the asset optimization pipeline (`_DONE_p300`, `devTools/assets.ts` → `devTools/assetPipeline/`; the how-to is `docs/techniques/asset-optimization.md`): encodes every `*.texture.json` / `*.importedAsset.json` source into `src/public/aek-assets/` (KTX2, meshopt GLBs), records each output in the committed `assets.lock.json` (unchanged assets are cache hits, so a clone needs no `ktx`), then gathers the generated data with their `__url`s. Only a full run without `AEK_ASSETS_OPTIMIZE` deletes stale outputs and lock entries: `yarn gatherAppData` and the dev server run the same cached pipeline (`devTools/assetPipeline/command.ts`) but never prune, so run `yarn assets` before committing assets. More: `devTools/assetPipeline/CLAUDE.md`.
- `yarn checkVersions` — check `package.json` against the versioning rules (see Versioning). `yarn checkVersions --against main` also checks each part's bump; run it before opening a PR.
- `yarn tagRelease` — on `main` after a merge, tag each part's version (`engine-v…`, `toolkit-v…`, `app-v…`). Local tags only; it prints the push command.

- `yarn test` / `yarn test:watch` — the unit tests (Vitest, `_DONE_p601` Phase 1). `vitest.config.ts` is standalone (none of `vite.config.ts`'s plugins run under a test) with `environment: 'node'`, and defines `__PROJECT_METADATA__`. A test is a `*.test.ts` next to its module (`src/` or `devTools/`), importing `describe` / `it` / `expect` from `vitest` (no globals). No GPU: anything that needs a renderer belongs to the scene runner. A module that reads a browser global at load (`core/Config.ts` reads `window.location.search`) is stubbed in its test file (`vi.hoisted` + `vi.stubGlobal`), never in a global setup, so a new one fails a test. Tests are left out of TypeDoc and the Hub's API hash. The Stop hook runs them when `src/`, `devTools/` or `vitest.config.ts` changed. The schema tests are `devTools/gatherAppData.test.ts`: every gathered JSON in `src/` through `validateGatheredJson`, and bad cases made by breaking one field of a repo asset (no fixture files: a fixture under `src/` would be gathered).
- `yarn verify:scenes [--only <sceneId|glob>[,…]] [--config <name|set>[,…]] [--update] [--url <url>] [--webgl] [--headed] [--browser chromium|firefox]` — the scene runner (`devTools/verify/scenes.ts`, per-scene settings in `scenes.config.ts`; `_DONE_p601` Phase 2). Configurations, baselines, `--browser firefox`: `devTools/verify/CLAUDE.md`.
- `yarn verify:baselines [--update [--allow-docs-drop]] [--no-build] [--docs]` — diffs the committed bundle, API and docs baselines in `devTools/verify/baselines/` (the docs ratchet: a folder's undocumented exports may not grow; `--docs` alone is the Stop hook's check). Detail: `devTools/verify/CLAUDE.md`.

- `npx tsx devTools/refactor/moveMap.ts [--check]` — p602's move map for the p600 restructure: applies `devTools/refactor/moveRules.ts` (the target layout as rules; change a rule, never the generated files) to the tracked tree and writes `moveMap.json` (every engine and toolkit file's target, which p608's codemod reads), `layoutReport.md` (the import graph checked against the target layout: kernel → feature imports, feature cycles, the boundaries) and `entryExports.json` (each documented export under its target entry, with who imports it today). It fails on a file no rule maps; `--check` exits 1 when an output is stale.

Both verify commands write their output to `.cache/verify/progress.log` too (emptied when a run starts; `devTools/verify/progressLog.ts`): watch them as Workflow's "Watching a long run" says.

In the browser, append query params to toggle modes: `?isDebug=true` (full debug tooling) and `?isProdTest=true` (production build with a subset of debug features). These only take effect in the `development`/`test` `VITE_APP_ENV` builds (see `src/_engine/core/Config.ts`). Next to either, `?startScene=<sceneId>` (p554 Phase 1, `getStartSceneQueryParam`; null outside those two modes, so a production build never reads it) picks the first scene: `loadScene`'s first load (`core/SceneLoader.ts`) uses it over the Debug tools' start scene and `src/index.ts`'s, with the scene code from `sceneFileObjects`. An id without both its scene data and its scene file warns (also as a debug toast, queued by `addDebugToastWhenReady` until the toaster exists) and loads the usual start scene. Later loads ignore it; the debugger's scene loader still applies only while the Debug tools' start scene is on. `?aekTest=true` installs the test bridge (see Debug system), and `?physicsProbe=N` arms the determinism probe (see Physics).

## Architecture

Subsystem detail lives in nested `CLAUDE.md` files next to its code. A session loads one when it reads a file in that folder; when a task touches a subsystem from elsewhere, read its file first:

- `src/_engine/core/Debug/CLAUDE.md`: the debug tooling (About dialog, debug keys, character debugging, test bridge, profiler, GPU memory, drawer tabs).
- `src/_engine/core/Debug/Editors/CLAUDE.md`: the editor views' code (`createViewCamera`, the material editor).
- `src/_engine/core/SkyBox/CLAUDE.md`: the sky box (layers, composite path and env bake, static layers, day-night, sky lights, its debug tab).
- `src/_engine/core/Lod/CLAUDE.md`: LOD chains and LOD selection (budget, cross-fades, `AUTO`), and the `lodShowcase` scene.
- `src/_engine/core/Lod/Impostors/CLAUDE.md`: impostors (cross-quads, octahedral, exports).
- `src/_engine/core/Spatial/CLAUDE.md`: the spatial index (domains, scene scope, update policies, radii).
- `src/_engine/core/Instancing/CLAUDE.md`: instanced mesh pools.
- `hub/CLAUDE.md`: authoring the Hub (pages, Markdown, code blocks, snippets, scenes and examples, feature pages, issue files).
- `devTools/hub/CLAUDE.md`: the Hub's generator (search, output, modes, dev plugin, generated sections, the API Documentation) and `yarn hub:build`'s detail.
- `devTools/assetPipeline/CLAUDE.md`: the asset pipeline's commands in detail (`yarn assets`, `yarn setupAssetTools`, the build's budgets).
- `devTools/devFiles/CLAUDE.md`: the dev file server (API, security, paths, save entries, its self-check).
- `devTools/verify/CLAUDE.md`: `yarn verify:scenes` and `yarn verify:baselines` in detail.
- `docs/plans/CLAUDE.md`: the plans (naming, header lines, phases, marking a phase or a plan done).

### Three-folder split

- `src/_engine/` — the core engine (renderer, ECS, physics, cameras, lights, debug tooling, UI). Treat as stable/library code; changes here should be minimal and purposeful.
- `src/toolkit/` — reusable ECS components/modules, models, textures, shaders, and assets meant to be imported as-is or copy-pasted into `app` and modified.
  - Models (`toolkit/models/<name>/`): the source GLB sits next to its `*.importedAsset.json` (a JSON-relative `fileName`); the asset pipeline writes the optimized output into `src/public/aek-assets/`. The first is the Ækasha symbol (`aekashaSymbol`, p554 §2.3): the Æ glyph of `src/public/favicon.svg` extruded with a small bevel, 1 unit high, centred, facing +z, Draco-compressed (the JSON's `optimize.mesh.codec: "draco"` keeps it so). `devTools/toolkit/buildAekashaSymbol.ts` builds the GLB (three's `SVGLoader` with `linkedom`'s `DOMParser`, `ExtrudeGeometry`, gltf-transform); run it with `npx tsx` when the glyph changes and commit the GLB. It fails when the glyph has no hole, and leaves the glTF scene unnamed (GLTFLoader makes scene and node names unique together, so a scene named like the node renames the node and its geometry id).
- `src/app/` — the actual game/app: scenes and asset JSON files, app-specific managers/components.

This boundary is convention only — nothing in `eslint.config.js` enforces import restrictions between the folders (the one exception is a manual comment, not a lint rule: `core/ECS/ECSRegistry.ts` says "NO OTHER LOCAL IMPORTS ALLOWED HERE").

### ECS core

`src/_engine/core/ECS.ts` defines `ECSWorld`, a bitwise-packed (index + generation) entity/component store. Key patterns:

- **Plugin registration**: managers call `ECSWorld.registerPlugin(fn)` and `ECSWorld.registerComponentHooks(type, { onAddComponent, onRemoveComponent, onDeleteEntity })` at module load time (static, applies to all current/future worlds). App-level plugin registration is centralized in `src/AppECSPlugins.ts` — this is where you wire up new app/toolkit ECS managers/effects.
- **Component types**: core types live in `src/_engine/core/ECS/ECSRegistry.ts` + `ECSCoreComponents.ts`. App-specific component types/data extend this in `src/AppECSRegistry.ts` (`AppComponentType`, `AppComponentData`) — that file is import-type-only by convention (comment at the top: "import only types and everything with `import type ...`") so it stays tree-shakeable.
- **Managed entities**: `CoreEntityOpts.managedBy` (code only) adds a `MANAGED_BY` component (`{ manager, ownerId, role }`) to an entity its manager creates, drives and deletes (eg. the sky box's lights). `createLightEntity` then skips the saved debug overrides, and the Lights tab shows the light read-only with a link to the manager's tab (registered with `_registerManagerDebugInfo` in `core/Debug/_dbg__ManagedEntities.ts`), without LS writes or undo entries.
- **System stages**, defined in `src/_engine/core/ECS/SystemStages.ts` (`ECSSystemStage`, with the `APP_RENDER_SYNC_ORDER` constants), run in this fixed order every frame: `MAIN → APP_PRE_PHYSICS → APP_POST_PHYSICS → APP_LOGIC → APP_RENDER_SYNC → LATE_MAIN`. `APP_PHYSICS_STEP` is the exception: it runs 0-N times per frame, once right before each fixed physics sub-step (dt = the fixed timestep), from inside `stepPhysics` (between `APP_PRE_PHYSICS` and `APP_POST_PHYSICS`) — use it for anything that must move in lockstep with the simulation (kinematic platforms, character controllers). In `WORKER_THREAD` mode the one-way worker commands those systems issue are carried in that frame's single STEP message and replayed before their own sub-step. Collision/contact-force events (both modes) are delivered by `flushPhysicsEvents` at the start of the next sub-step — after held-key polling, before `APP_PHYSICS_STEP` — an order gameplay code (e.g. `core/Character/DynamicCharacter.ts`'s moving-platform logic) depends on. `APP_POST_PHYSICS` is where physics state syncs into ECS transforms; `APP_RENDER_SYNC` is where ECS transforms sync into Three.js `Object3D`s.

### Scene/asset data pipeline (JSON → generated code)

Scenes and assets are authored as JSON files under `src/app/**`, named by suffix (e.g. `*.scene.json`, `*.mesh.json`, `*.camera.json`, `*.light.json`, `*.geometry.json`, `*.texture.json`, `*.textureArray.json`, `*.textureAtlas.json`, `*.material.json`, `*.importedAsset.json`, `*.skybox.json`, `*.postFx.json`, `*.impostor.json`). `devTools/gatherAppData.ts`:

1. Walks `src/`, finds files matching those suffixes.
2. Validates each against a Zod schema in `src/_engine/schemas/*.ts`.
3. Emits `src/_engine/generatedAppData.json` and `generatedAppFns.ts` (consumed at runtime by `src/_engine/core/Scene.ts`'s `registerScenesFromGeneratedData()` to build scenes).
4. Also compiles the Zod schemas to plain JSON Schema files in `.schemas/*.schema.json` (used for editor autocomplete/validation on the asset JSON files themselves).

Per-scene overrides live in each asset file's `__saveData` (`{ [sceneId]: [latest, ...older] }`; only the latest entry is applied). An entry's `__meta` can carry `engineVersion`/`toolkitVersion`/`appVersion` (`src/_engine/schemas/_saveDataSchema.ts`); anything that writes save entries should stamp all three, and the gatherer warns when an applied entry comes from another major version.

This runs via `yarn gatherAppData`, and automatically on file add/change/delete during `yarn dev` through the custom `sceneGathererPlugin` Vite plugin (`devTools/sceneGathererPlugin.ts`; triggers a full reload, or surfaces a Vite error overlay if validation or an asset fails). Each gather it runs first sends the custom HMR event `aek:gather` (`DevDataGatheredEvent` in `debug/DevFilesProtocol.ts`: `done` / `failed`, the changed files, the asset errors, `willReload`), which the dev files' `onDevDataGathered` delivers; only a failed gather keeps the page (an asset error reloads it too: the generated data changed). Both run the asset pipeline (`_DONE_p300`) first, cached: the gather needs its run for the `__url`s. The plugin builds only what a change touched (an asset JSON, a source file, `assets.config.json`, `assets.optimization` in `src/CONFIG.ts`) and reuses its last run when nothing the pipeline reads changed.

### Bootstrap flow

`src/index.html` → `src/index.ts` → `InitEngine()` (`src/_engine/InitApp.ts`), which in order: loads config, creates the root Three.js scene, `initECSWorld()`, creates the HUD container, registers scenes from generated data, registers Camera/Light managers, inits the debug camera, inits Rapier physics, then (only if `IS_DEBUG_ENV`/`IS_PROD_TEST_MODE`) registers debug tooling/stats/GUIs — and finally invokes the app's own start callback (passed into `InitEngine`) before starting the main loop.

### Debug system (dual-layer, lazy-loaded)

Debug tooling (Tweakpane-based) is split into two layers so it tree-shakes out of production builds:

- `src/_engine/debug/*.ts` and other core modules (e.g. `core/Renderer.ts`'s `createRendererDebugGUI`) are thin public entry points that, only when `IS_DEBUG_ENV` is true, dynamically `import()` the real implementation via `loadDebugModuleAsync`/`useDebug` (`src/_engine/utils/helpers.ts`).
- The actual Tweakpane implementations live in files prefixed `_dbg__` (e.g. `src/_engine/core/Debug/_dbg__Renderer.ts`, `_dbg__DebuggerGUI.ts`, plus `Debug/Camera/` and `Debug/Light/` subfolders). Follow this `_dbg__` + dynamic-import pattern when adding new debug panels for engine-level features.
- The debug drawer itself is toggled in-app with the `h` key (bound in `src/CONFIG.ts`) via `toggleDrawer()`.
- Draggable windows (`core/UI/DraggableWindow.ts`): an edit window per entity is a window kind. Register the kind once at module load with `registerDraggableWindowKind(kind, { content, onClose, sceneTargetResolver })` (it also covers windows restored from LS; a single window uses `registerDraggableWindow(id, …)`). Open a window with `kind` and `id: getKindWindowId(kind, key)`, from a list row through `toggleDraggableWindow` (open, bring to front, close when on top), and select the rows from `getDraggableWindowsOfKind`. Rebuild one with `updateDraggableWindow(id)`, all with `updateDraggableWindowsOfKind(kind)`, and keep per-window module state in a map cleaned up in the content's `onRemoveCmp`. Double-clicking a header fits the window to the screen (`fitDraggableWindowToScreen`), and the Debug tools tab's "Center and fit all windows" fits them all.

Detail: `src/_engine/core/Debug/CLAUDE.md` (the About dialog, debug keys, character debugging, the test bridge, the profiler, GPU memory, drawer tabs) and `devTools/devFiles/CLAUDE.md` (dev files).

### Physics

The engine-agnostic Physics API — `PhysicsAPI.ts` (facade) + `Physics/EngineRapier.ts` (Rapier backend) + `Physics/PhysicsAPITypes.ts` (shared types/protocol) + `PhysicsManager.ts` (ECS integration) + `workers/physicsWorker.ts`/`workers/physics/physicsSwitch{World,Rigid,Coll}.ts` (worker-thread RPC switchboard). The legacy mesh-coupled `PhysicsRapier.ts` has been removed; don't reintroduce a non-ECS physics path. Rapier is currently the only backend (`Physics/ENGINES.ts`); a settings-driven engine choice (Jolt, Ammo, etc.) is a future extension point, not implemented.

`AppConfig.physics.workerTarget` (`'MAIN_THREAD' | 'WORKER_THREAD'`, default `'WORKER_THREAD'`) selects where the new system's simulation runs. In `WORKER_THREAD` mode, per-frame rigid-body transforms sync back via a physics-owned hot-path buffer (`Physics/PhysicsTransformBuffer.ts`): a real `SharedArrayBuffer` when the runtime is cross-origin-isolated (`AppConfig.physics.useSAB`, default `true`; the dev server sends the required COOP/COEP headers), otherwise an automatic single-batched-message-per-frame fallback — never one message per body either way. The `SharedArrayBuffer` is a lock-free triple buffer (p063): the worker writes its back bank, stamps it with its step index and publishes it by an atomic swap with the middle bank, and every `MainLoop` variant calls `latchPhysicsSnapshot()` right after `timer.update()`, which swaps in the newest published bank. So every reader in a frame (held keys, `APP_PHYSICS_STEP`, the TRANSFORM sync, interpolation, debug wireframes) sees one complete snapshot and its stamp, and a write-back that lands mid-frame waits for the next frame. The fallback uses one bank, since each push is already a private copy. Physics objects are ECS components (`BODY_STATIC`/`BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS`, synced to `TRANSFORM` every frame at `ECSSystemStage.APP_POST_PHYSICS` by `PhysicsManager.ts`'s `physicsToTransformSystem`); `PhysicsManager.createPhysicsEntity` is `async` and is the entry point app code should use. Physics objects are still created in code, not yet part of the scene/asset JSON schema — that remains a future step.

Scene loads are deterministic (p101). `SceneLoader.ts` holds physics stepping (`holdPhysicsStepping`) for the whole load, replaces the physics world with a fresh one (`resetPhysicsWorld`, right after `createCameras`), and releases the hold only after every `createPhysicsEntity` call has finished (`settlePendingPhysicsEntities`, which also catches un-awaited ones). So a scene simulates identically on every visit, in both worker targets. Consequences:

- No physics entity survives a scene switch, and any body/collider reference from the previous scene is stale. Deleting one is a quiet no-op.
- Physics writes (poses, velocities, impulses, kinematic targets) go in `APP_PHYSICS_STEP` systems or in scene-load code. Writes from per-frame stages depend on frame timing. In `WORKER_THREAD` mode, `APP_PHYSICS_STEP` commands are captured per sub-step and cloned at capture, so reusing scratch vectors is safe.
- Characters (`core/Character/DynamicCharacter.ts`) are not deterministic yet: they use the wall clock, `Math.random`, and (in `WORKER_THREAD` mode) async shape casts.
- The simulation lint (`SIMULATION_FILES` in `eslint.config.js`: the physics and character files, `movingPlatform.ts`, `MutualGravity.ts`) makes `Math.random`, `performance.now()`, `Date.now()` and `new Date` errors there. Profiling reads go through `readStatsClock` (`utils/StatsClock.ts`, measurement only); the known violations are allow-listed per file with their plan (p610: `DynamicCharacter.ts`'s `Math.random`, and `core/Physics/PhysicsWallClock.ts` under `getPhysGameTime`), never disabled inline. A new simulation file goes on the list.

To check determinism, append `?physicsProbe=N` (debug mode) or use "Determinism probe" in the Physics API debug tab. It freezes physics N fixed steps after each scene enter, logs a hash of every dynamic body's state, and diffs it against the last run of the same scene and N. The gym's `ARE_CHARACTERS_ENABLED` flag leaves its characters out for this. `yarn verify:scenes` probes every scene in all three targets this way (steps and known non-deterministic scenes in `devTools/verify/scenes.config.ts`: `unstableHash`).

Simulation tiers (`_DONE_p352`, `core/PhysicsTiers.ts`): a `DYNAMIC` `createPhysicsEntity` body (not a character, p420 owns those) can be `FULL`, `STATIC` (made `FIXED`), `DISABLED` (`setEnabled(false)`) or `REMOVED` (detached from the Rapier world with its ids, proxies and state kept engine side, `detachRigidBody` / `reattachRigidBody`; its transform-buffer slot is freed). `requestPhysicsTier` applies at the next `APP_PHYSICS_STEP` sub-step (`physicsTierSystem`, order 100); jointed bodies change tier as a group and can't be `REMOVED`. `STATIC` / `DISABLED` entities sit in `BODY_STATIC`; a `REMOVED` one has no bucket or `COLLIDER` component (so `world.getRigidBody` is undefined; the body lives on `PHYSICS_SIM_TIER.body`). Fixed bodies take no slot and `BODY_STATIC` isn't synced per frame: a moved one reaches its transform through `setBodyMovedListener` and `queueStaticBodySync`. Joint checks read the facade's joint registry, which `createJoint` (`PhysicsAPI.ts`) fills but `getPhysicsWorld().createJoint` on `MAIN_THREAD` bypasses.

- The distance policy (`core/PhysicsTierPolicy.ts`, `setPhysicsTierPolicy`; members via `createPhysicsEntity`'s `tierPolicy` option) runs with `cadence: 'STEPS'` by default (`_DONE_p343`): an `APP_PHYSICS_STEP` system (order 110) measures member and focus positions on steps that are multiples of `interval` (`readBodyPositionsAtStep`) and decides `interval` steps later; in `WORKER_THREAD` mode it holds stepping with `addPhysicsStepGate` until the reply arrives. `'FRAMES'` runs at `APP_LOGIC` from `TRANSFORM`s and isn't deterministic; the probe freezes only that cadence. Freeze sources are per world (`setPhysicsTierPolicyFrozen(frozen, source)`).
- `getPhysicsSubStepIndex()` is the step clock for `APP_PHYSICS_STEP` systems (-1 outside a sub-step), and `addPhysicsStepGate(step)` is the production way to make stepping wait for something; the debug-only `setPhysicsStepLimit` is separate. A new world drops every gate.
- The `physicsTiers` scene is the demo and the verification scene: with its policy running, the probe hash is the same on every load and in all three targets (`MAIN_THREAD`, `WORKER_THREAD` with and without SAB).

### Viewports

`src/_engine/core/Viewports.ts` renders extra rectangles over the canvas, each with its own scene and camera (picture-in-picture, minimaps, item previews), after the main render and PostFX. Each enabled viewport renders into its own render target, then a quad composites it with the renderer's tone mapping and colour space neutralised (the `RenderPipeline.render()` contract), so it works on both backends with PostFX on or off. `renderViewports()` is called once from `MainLoop.renderScene()` and is a single count check while no viewport is enabled. A viewport is render configuration, not ECS: `createViewport({ id, scene, camera, anchor | rect, ... })`, where `camera` can be a resolver (eg. `getActiveCamera`), and `sceneId` deletes it on that scene's exit.

- Placement is DOM-driven. Each viewport owns a slot element in `#aekViewportsLayer` (created on the first viewport), either in a corner stack (`anchor` + `order`, 0 = in the corner; global class `aekViewportStack_<ANCHOR>` for consumer SCSS) or at an explicit `rect` (px or %). The rendered rect is the slot's box, re-read only on create/enable, canvas resize, `<body>` class changes, while a CSS transition runs in the layer, or on `invalidateViewportLayout()`.
- `interactive` slots take pointer events, so those never reach the canvas, OrbitControls or `MouseInput`; raycast into the viewport with `getViewportPointerNDC`. Other slots let everything through.
- The first consumer is the debug-only axes gizmo (`debug/AxesGizmo.ts` → `core/Debug/_dbg__AxesGizmo.ts`): top right, follows the active camera, F10 and two Debug Tools options. With the debug camera, clicking a bubble aligns it and dragging orbits it.
- The environment ball (`debug/EnvBall.ts` → `core/Debug/_dbg__EnvBall.ts`) sits left of the gizmo (`order: 1`): an unlit sphere sampling `getActiveEnvironmentTexture()` along the reflection vector (with a direct-path cube's `flipY` and the scene's `environmentRotation`), following the active camera, F9 and three Debug Tools options. A new PMREM texture gets a new node, never a `.value` swap. In an editor view it shows the view scene's `environment` (see Views).

### Snapshots

`core/Snapshot.ts`: `takeSnapshotAsync({ width, height, scene?, camera?, postFx?, hideDebugHelpers?, transparent?, samples? })` renders a scene through a camera into an image off screen and reads it back as a `Snapshot` (`{ width, height, data, postFx }`: RGBA8, sRGB encoded as the canvas shows it, straight alpha, top row first), for thumbnails, the Hub's example images (p554's Hub tab) and save game pictures. By default it's what the canvas shows: the current view's scene and camera (the debug camera too), through the scene's PostFX, without the viewports, and with the debug helpers hidden (`markDebugHelper`'s flag, the 3D symbols, three's `*Helper`s). `snapshotToBlobAsync` encodes one through a canvas (PNG, WebP, JPEG; a fully transparent pixel loses its colour), the dev files' `encodePNG` byte for byte. `readRenderTargetRGBA8Async` is its readback (top row first on both backends), which the texture preview shares.

- Direct path (any scene and camera, PostFX off, or `transparent`): the scene renders into a HalfFloat target, then a quad with `renderOutput()` and the renderer's tone mapping and output colour space (the viewports' contract) into an RGBA8 target. The canvas isn't touched. `transparent` clears to alpha 0 and leaves the scene's background out for the render.
- PostFX path (the root scene with the active camera, its pipeline on): three's `pass()` sizes itself from the drawing buffer, so the renderer is resized to the snapshot (pixel ratio 1) for the render and put back, and `renderFrameNow()` (`MainLoop.ts`) draws the canvas again in the same task, so the browser never shows it cleared.
- Both start a new node frame first: three r186 updates `FRAME` nodes (a `pass()`, a shadow map) once per node frame, so a snapshot after the frame's own render would reuse them at the canvas's size and aspect (the PostFX snapshot came out stretched).
- The camera's aspect (an orthographic camera's width, keeping its height) is set for the snapshot and put back, like everything else it changes, before the readback starts.

### Views

`core/ViewManager.ts` (`_DONE_p083`, the editor/creator view epic): a view is what the whole canvas shows and what the main loop ticks, and exactly one is active. The built-in **Runtime** view (`RUNTIME_VIEW_ID = 'runtime'`, no `ViewDef`) is the loaded scene with the game/app debugger. Editor views (the material editor, `_DONE_p084`, `_DONE_p085`) are registered by debug modules with `registerView({ id, title, icon, orderNr?, scene, getCamera, getCameraRig?, onEnter?, onExit?, mainUpdate?, update?, toggleDrawer? })` and switched with `setActiveView(id)`: calls run one after another, and a failed `onEnter` returns to the Runtime view and resolves `false`. Views aren't viewports: viewports are composited over whichever view is active. Only the debug env registers views so far; in production the loop pays one boolean check.

- Suspension: while an editor view is active (`loopState.isSceneSuspended`, from the start of a switch to one until the switch back has finished; `isRuntimeViewActive()`), `mainLoopForDebug` runs none of the scene's per-frame work. That means no world's ECS stages (`MAIN` and `LATE_MAIN` included, so `object3DSyncSystem`, `skyBoxSystem` and `debugCameraSystem` stop too), no scene loopers, no held keys, and no physics: `stepPhysics` treats it as a pause and resumes without catching up, so a switch keeps a scene deterministic. `getElapsedTime()` stands still. The loop instead runs the view's `mainUpdate(delta)` and, while the view plays, `update(delta)`, then renders `view.scene` with `view.getCamera()` (no PostFX) and the viewports. Work outside the loop (timers, audio, DOM events, TSL's `time` node) keeps going, so per-frame game logic belongs in ECS systems or scene loopers. A scene loaded meanwhile (app code, HMR) is suspended as soon as it exists.
- Debug tools that must run in every view add `addViewFrameListener(fn, 'BEFORE_UPDATE' | 'AFTER_RENDER')`, called only in editor views (the axes gizmo, the env ball, the profiler's frame and GPU memory samplers), next to their ECS system for the Runtime view. `addViewChangeListener` runs after every finished switch.
- Input: `setAppInputsSuspended` (`Input/InputState.ts`; apart from `setAllInputsEnabled`, so a scene load's end doesn't lift it) stops mouse, touch, held keys and every key binding without `isDebugKey` (set on the engine's debug keys and CONFIG.ts `debugKeys`). The scene debug camera's OrbitControls are gated off (`setSceneDebugCameraInputEnabled`). `h` calls `toggleActiveViewDrawer()` (the view's `toggleDrawer`). F1 and F5 do nothing. F7 and the pause button call `toggleViewPlay()`, the view's own play flag (in the Runtime view, `toggleAppPlay`). The master loop button stops every view.
- HUD: `<body>` gets `aekEditorView` and `aekView_<id>`, and `body.aekEditorView #hudRoot > :not(.aekKeepInViews)` hides the scene's HUD (drawer, switch tools, draggable windows, scene loader, app HUD) with `display: none`, so it comes back as it was. `KEEP_IN_VIEWS_CLASS` (`core/HUD.ts`) keeps an element: the top on-screen rows (centred and top left), stats, the toaster, the viewports layer, debug dialogs with a backdrop, and windows of a kind registered with `keepInViews: true` (the profiler). An editor view's own UI needs it too. The scene drawer keeps its open state (`setDrawerSuspendedByView`) and leaves `debugDrawerOpen` to the editor view, whose own right drawer sets it, so the rules keyed on that class (top row, viewport stack) shift for it too.
- On-screen tools: the view tools group (tool type `'VIEW'`) sits right of the About and undo / redo group in the top left row (`onScreenTopLeftRow`); the play group is alone in the centred top row (`onScreenTopRow`). Runtime comes first, then `getViews()` (by `orderNr`, then registration order; a `ViewDef`'s `iconSize: 'small'` shrinks an icon that fills its box). The group shows only when an editor view is registered, and every switch shows a toast. An editor view builds no prod-test play button and no switch tools.
- Camera rig: `ViewCameraRig` (`{ camera, controls, setControlsSuspended, onMoveEnd? }`). The gizmo and the env ball resolve the camera they follow and drive through `core/Debug/Camera/_dbg__CameraRig.ts`: in the Runtime view the active camera, and the debug camera's rig while it is active; in an editor view its `getCameraRig()`, or its `getCamera()` treated like the main camera. The profiler census reads `getActiveViewCamera()` (`ViewManager.ts`) instead, since it also loads in prodTest.
- Undo: `perScene` actions recorded in an editor view go to the bucket `__view:<id>`; `global` ones show in every view.
- Refresh: `AEK_debugViews` (`{ activeViewId, viewPlay }`) is written on every finished switch and every editor view play toggle. `restoreSavedView()` runs at the end of `InitEngine` (debug env, not awaited), after the first scene and the debug GUIs exist, so register views before that (in `InitApp.ts`'s debug block). A saved view that isn't registered falls back to the Runtime view and clears the key. Each view restores its own state.
- The editor views' own code (`createViewCamera`, the material editor): `src/_engine/core/Debug/Editors/CLAUDE.md`.

### Ækasha Hub

`hub/` (p551, epic p550): the engine's instructions, examples and documentation as static pages, served by the dev server at `/hub/` next to the app and built into `dist-hub/` for any static host (Netlify `_headers` and `404.html`). No router in the engine: none of it is in the app's bundle. The generator is `devTools/hub/` (`buildHub({ mode, outDir })` in `build.ts`); the authoring how-to is `docs/techniques/hub-authoring.md`.

- **A `#region` marker in engine, toolkit or app code is a Hub include: renaming, removing or moving it fails `yarn hub:build` with the page and line**, so say which page shows it in the marker's note (`// #region dynamic-box (shown in the Hub: …)`) and fix the include in the same change.
- **A new Architecture section here, or a new `##` section in a nested `CLAUDE.md`, needs a feature page's `aek:covers` (or a `coverageIgnore` entry when it isn't a feature), and renaming a section means updating the `aek:covers` that names it.**
- The rest: `hub/CLAUDE.md` (authoring) and `devTools/hub/CLAUDE.md` (the generator).

### Build config notes (`vite.config.ts`)

- `root: './src'`, output to `../dist`.
- `vite-plugin-wasm` for Rapier's WASM binary.
- `worker: { format: 'es' }`: ES module workers, so a worker can load chunks on demand (an IIFE worker can't be code-split, and a dynamic `import()` in one fails `vite build`). The dev server loads workers as modules either way.
- `server.fs.allow: [<repo root>]`: `/@fs/` serves the repo (`node_modules`, `.tools/`) but nothing outside it, since the dev server is on the LAN (`--host`).
- Custom `sceneGathererPlugin` (see data pipeline above), the dev-only `devFilesPlugin` (see Debug system), the dev-only `hubPlugin` (after `devFilesPlugin`; `/hub/`, see Ækasha Hub) and an `html-transform` plugin that injects `%APP_NAME%`/`%VERSION_CHECKSUM%`/etc. placeholders (sourced from `package.json`'s `app_metadata`/`engine_metadata`/`toolkit_metadata` through `devTools/projectMetadata.ts`) into `index.html`.
- `rollup-plugin-visualizer` writes a bundle treemap to `dist-stats/bundle-stats.html`.
- The public entries' aliases (`aekasha`, `aekasha/<feature>`, `aekasha/toolkit/<category>`, p606) come from one list, `devTools/aliases.ts`: `resolve.alias` here and in `vitest.config.ts`, and `tsconfig.json`'s `paths` (a copy `devTools/aliases.test.ts` checks). Nothing imports them yet; engine code imports engine code by relative path.

## Coding standards

The full text, with examples, is the Hub page `hub/pages/documentation/coding-standards/` (`intro.md`, `jsdoc.md`). In one line each:

- Layering: engine ← toolkit ← app; a feature owns its folder; debug code in colocated `_dbg__` modules, reached only through the debug loader.
- Public API: entry points only, everything else `@internal`; options objects past two parameters or any optional one; no internal types in public signatures.
- Naming: `create`/`delete`, `register`/`unregister`, `get`/`set`, `*Async`, `on*` returning the remover, `is`/`has`; PascalCase files (an asset id's file keeps the id); no `Manager` suffix; no names differing only in case.
- Size: about 800 lines per file and 150 per function or closure, or the file's header says why not.
- Async and disposal: re-check the scene / entity / request after every `await`, and say in the JSDoc which overlapping call wins; one owner disposes each resource; listeners and timers return or register their cleanup.
- Per-frame code: no allocations, storages read once per frame, no redundant GPU state changes (`perf-auditor` agent).
- Smallest build: no module-level side effects, heavy dependencies behind `import()`, no `Addons.js` barrel.
- Simulation (`APP_PHYSICS_STEP`, physics, controllers, AI): step-index time, seeded RNG, intents as the only input, state read at the step (never synced `TRANSFORM`s or interpolated poses), plain-data messages, `import type` across the boundary, data components, one Rapier build.
- Type hygiene: no `any`; `eslint-disable` with `-- reason`; a TODO names its issue file or plan.
- JSDoc: a summary on every export saying what the signature can't; `@param name text` (no hyphen, no type) and `@returns` only where they add; `@example` on entry APIs; `@remarks` for traps; `@template` for type parameters; empty `@internal` on its own line; `@deprecated` with its replacement and removal major; `{@link}` only to our exports; Zod types documented on the alias and on each shape key. `eslint-plugin-jsdoc` checks the shape as errors (`eslint.config.js`; no `require-*` rule: presence is the ratchet's). It's pinned at 63.3.3, the last version that runs on `.nvmrc`'s Node 22.13.0 (64+ needs ≥ 22.22.2). Its `empty-tags` and `no-types` fixers delete text, and the hooks run `--fix` on every edit: write an `@internal` reason in the summary and a `@returns` with words first (`@returns {@link X}` reads as a type, and its fix leaves `@returns` empty).

## Versioning

`package.json` holds four semver versions (`MAJOR.MINOR.PATCH`: major = breaking, minor = new feature, patch = fix):

- `engine_metadata.version` — the engine (`src/_engine/`).
- `toolkit_metadata.version` — the toolkit (`src/toolkit/`), which ships with the engine. Its own scale: additions are minor, fixes/updates are patch, and a major bump happens only when an engine-level change requires it.
- `app_metadata.version` — the example app (`src/app/` and the app-level files in `src/`: `AppECSPlugins.ts`, `AppECSRegistry.ts`, `CONFIG.ts`).
- `version` (the project/package version) — **always identical to `engine_metadata.version`**. App-only changes bump `app_metadata.version` and never touch the project version.

Rules:

- Bump once per branch merged to `main` (in the PR), not per commit, at the level of the biggest change on that side since the last merge. Reset the lower parts to 0 (e.g. `1.4.2` → minor bump → `1.5.0`).
- Engine, toolkit and app are bumped independently; a side with no changes keeps its version.
- A major bump gets a new codename. Engine codenames follow the sun's path (Dawn → Sunrise → Morning → Zenith → …); toolkit codenames follow the moon's phases (Crescent → Half Moon → Gibbous → Full Moon → …); app codenames follow life stages (Toddler → Preschooler → Kid → Teen → …).
- Each PR adds an entry to `CHANGELOG.md` with a section per part it bumped (Engine / Toolkit / App, plus Project for repo tooling).
- Before opening the PR, `yarn checkVersions --against main` must pass. The Stop hook runs the base check (project version = engine version, valid semver) whenever `package.json` changes.
- After merging to `main`, run `yarn tagRelease` and push the tags it prints.
- The `x-version-checksum` meta tag hashes every part's version and codename plus the project version.

## Workflow

- **Always run Node with the version in `.nvmrc` (22.13.0).** The shell's default Node can be older than `package.json`'s `engines` (≥ 22.13.0); yarn then refuses to run, and checks fail or silently do nothing. Every Bash command that runs `yarn`, `npx`, `node` or `tsx` starts with `source .claude/hooks/use-node.sh &&` (from the repo root; it works in bash and zsh and stops the command when that Node isn't installed), eg. `source .claude/hooks/use-node.sh && yarn build`. The hooks source it too. Never report a check result from another Node version.
- **Watching a long run.** A command whose result you wait for and that takes more than a few seconds (`yarn verify:*`, `yarn build`, `yarn hub:build`, `yarn assets`, a long Vitest run) runs in the background with its output in a log under the gitignored `.cache/`: the verify commands write `.cache/verify/progress.log` themselves, anything else is redirected to `.cache/runs/<name>.log`. Give the user a command to copy that starts from the repo root's absolute path on the current machine (the user works on several), eg. `cd /path/to/repo && tail -f .cache/verify/progress.log`. Don't poll the log: the background task reports when it ends. `yarn test` takes about a second: run it in the foreground.
- A Stop hook runs lint (`--fix`, then fails on the errors left; warnings don't block) and type-check (`tsc` and `tsc -p hub`) when `src/`, `hub/`, `devTools/` or `vite.config.ts` changed, the unit tests when `src/`, `devTools/` or `vitest.config.ts` did, the docs ratchet (`yarn verify:baselines --docs`, naming each new undocumented export) when `src/_engine/` or `src/toolkit/` did, plus the version rule check when `package.json` changed. Leave the tree compiling and lint-clean. An edit to a `.ts` file is linted the same way right away (`tool-lint.sh`), showing the file's remaining errors.
- **Keep the Ækasha Hub current.** A change that adds, changes or removes an engine or toolkit feature or public API updates its Hub content (`hub/pages/`) in the same branch: the feature page, the example page and its scene, and the snippets they include. Run `yarn hub:build` after a Hub change: it fails on a dead `hub:` link.
- **Keep the nested `CLAUDE.md` files current.** A change to a subsystem that has one (the map under Architecture) updates it in the same branch; project-wide rules stay here. A new nested file starts with one line naming what it covers, gets a line in the map, and its `## ` sections are Hub sections like the Architecture ones (see Ækasha Hub).
- `readme.md` (root) is the project's public face. Update it in the same branch when a change alters what it lists: a new engine subsystem or toolkit module (Features), a new asset JSON type, a new command or URL flag, a changed runtime/browser requirement, a changed signature of an API its Examples use (`InitEngine`, `createRenderer`, `createSceneLoader`/`loadScene`, `createMeshEntity`, `createPhysicsEntity`, `addSystem`/`registerPlugin`, `AppConfig`), or a Roadmap item that lands (move it into Features). Physics objects in the scene JSON schema, the procedural sky/day-night cycle, the editor/material editor and the LOD system are the ones that call for a new highlight or example. Keep version numbers out of it (they live in `CHANGELOG.md`).
- `docs/plans/` holds specs for unstarted work. Never treat one as current state or implement one unless I reference it explicitly.
