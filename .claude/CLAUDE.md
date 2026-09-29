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
- `yarn dev:test` — dev server with `VITE_APP_ENV=test`.
- `yarn dev:production` — dev server against production env vars.
- `yarn build` — type-check (`tsc`) + production build to `dist/`.
- `yarn build:test` — production build with `VITE_APP_ENV=test`.
- `yarn lint` — ESLint (flat config in `eslint.config.js`, Prettier enforced as a lint rule).
- `yarn docs` — generate TypeDoc docs into `docs-api/` (scoped to `src/_engine/**` and `src/toolkit/**` — the engine and the toolkit are the documented public API surface; `app` is not documented). The folder is gitignored and TypeDoc wipes it on every run, so never point `out` at `docs/`.
- `yarn gatherAppData` — manually run the scene/asset JSON → generated data pipeline (see below); this also runs automatically before `dev`/`build` and via a Vite plugin on file save.
- `yarn checkVersions` — check `package.json` against the versioning rules (see Versioning). `yarn checkVersions --against main` also checks each part's bump; run it before opening a PR.
- `yarn tagRelease` — on `main` after a merge, tag each part's version (`engine-v…`, `toolkit-v…`, `app-v…`). Local tags only; it prints the push command.

There is no test suite/framework configured in this repo currently (no `test` script, no test runner dependency).

In the browser, append query params to toggle modes: `?isDebug=true` (full debug tooling) and `?isProdTest=true` (production build with a subset of debug features). These only take effect in the `development`/`test` `VITE_APP_ENV` builds (see `src/_engine/core/Config.ts`).

## Architecture

### Three-folder split

- `src/_engine/` — the core engine (renderer, ECS, physics, cameras, lights, debug tooling, UI). Treat as stable/library code; changes here should be minimal and purposeful.
- `src/toolkit/` — reusable ECS components/modules, models, textures, shaders, and assets meant to be imported as-is or copy-pasted into `app` and modified.
- `src/app/` — the actual game/app: scenes and asset JSON files, app-specific managers/components.

This boundary is convention only — nothing in `eslint.config.js` enforces import restrictions between the folders (the one exception is a manual comment, not a lint rule: `core/ECS/ECSRegistry.ts` says "NO OTHER LOCAL IMPORTS ALLOWED HERE").

### Plans logic and structure

- Agentic coding plans are located in `docs/plans/`.
- The naming of the files has a special pattern: [priority number eg. "p520" or "_DONE"]\_[name-of-the-feature].md (eg. "p020_some-feature.md").
- The lower the priority number the higher the priority.
- Plans that have been implement (filename starts with "\_DONE\_") are kept if they provide useful information for another feature and when the whole larger concept/epic that consists of those plans is done those plans are removed.
- Plan header has some required and optional information lines:
  - Status (required): describes a status of the plan. This is usually something like "draft | not-implemented", "draft | feasibility study — not-implemented", or "implemented".
  - "Category" (optional): a general category that this particular plan falls into, usually one or two words like "ECS", "Assets", "Bug fix", "Refactoring", or "Physics".
  - "Blocked by" (optional): describes a plan file name that blocks this plan from implementation.
  - "Blocks" (optional): describes a plan file name that this plan is blocking the implementation.
  - "Epic" (optional): link to the epic (usually a Trello ticket).
- Bigger plans should have non-breaking phases described so that the changes can be reviewed and committed in smaller chunks.

### ECS core

`src/_engine/core/ECS.ts` defines `ECSWorld`, a bitwise-packed (index + generation) entity/component store. Key patterns:

- **Plugin registration**: managers call `ECSWorld.registerPlugin(fn)` and `ECSWorld.registerComponentHooks(type, { onAddComponent, onRemoveComponent, onDeleteEntity })` at module load time (static, applies to all current/future worlds). App-level plugin registration is centralized in `src/AppECSPlugins.ts` — this is where you wire up new app/toolkit ECS managers/effects.
- **Component types**: core types live in `src/_engine/core/ECS/ECSRegistry.ts` + `ECSCoreComponents.ts`. App-specific component types/data extend this in `src/AppECSRegistry.ts` (`AppComponentType`, `AppComponentData`) — that file is import-type-only by convention (comment at the top: "import only types and everything with `import type ...`") so it stays tree-shakeable.
- **Managed entities**: `CoreEntityOpts.managedBy` (code only) adds a `MANAGED_BY` component (`{ manager, ownerId, role }`) to an entity its manager creates, drives and deletes (eg. the sky box's lights). `createLightEntity` then skips the saved debug overrides, and the Lights tab shows the light read-only with a link to the manager's tab (registered with `_registerManagerDebugInfo` in `core/Debug/_dbg__ManagedEntities.ts`), without LS writes or undo entries.
- **System stages**, also defined in `src/AppECSRegistry.ts` (`ECSSystemStage`), run in this fixed order every frame: `MAIN → APP_PRE_PHYSICS → APP_POST_PHYSICS → APP_LOGIC → APP_RENDER_SYNC → LATE_MAIN`. `APP_PHYSICS_STEP` is the exception: it runs 0-N times per frame, once right before each fixed physics sub-step (dt = the fixed timestep), from inside `stepPhysics` (between `APP_PRE_PHYSICS` and `APP_POST_PHYSICS`) — use it for anything that must move in lockstep with the simulation (kinematic platforms, character controllers). In `WORKER_THREAD` mode the one-way worker commands those systems issue are carried in that frame's single STEP message and replayed before their own sub-step. Collision/contact-force events (both modes) are delivered by `flushPhysicsEvents` at the start of the next sub-step — after held-key polling, before `APP_PHYSICS_STEP` — an order gameplay code (e.g. `dynamicCharacter.ts`'s moving-platform logic) depends on. `APP_POST_PHYSICS` is where physics state syncs into ECS transforms; `APP_RENDER_SYNC` is where ECS transforms sync into Three.js `Object3D`s.

### Scene/asset data pipeline (JSON → generated code)

Scenes and assets are authored as JSON files under `src/app/**`, named by suffix (e.g. `*.scene.json`, `*.mesh.json`, `*.camera.json`, `*.light.json`, `*.geometry.json`, `*.texture.json`, `*.material.json`, `*.importedAsset.json`, `*.skybox.json`). `devTools/gatherAppData.ts`:

1. Walks `src/`, finds files matching those suffixes.
2. Validates each against a Zod schema in `src/_engine/schemas/*.ts`.
3. Emits `src/_engine/generatedAppData.json` and `generatedAppFns.ts` (consumed at runtime by `src/_engine/core/Scene.ts`'s `registerScenesFromGeneratedData()` to build scenes).
4. Also compiles the Zod schemas to plain JSON Schema files in `.schemas/*.schema.json` (used for editor autocomplete/validation on the asset JSON files themselves).

Per-scene overrides live in each asset file's `__saveData` (`{ [sceneId]: [latest, ...older] }`; only the latest entry is applied). An entry's `__meta` can carry `engineVersion`/`toolkitVersion`/`appVersion` (`src/_engine/schemas/_saveDataSchema.ts`); anything that writes save entries should stamp all three, and the gatherer warns when an applied entry comes from another major version.

This runs via `yarn gatherAppData`, and automatically on file add/change/delete during `yarn dev` through the custom `sceneGathererPlugin` Vite plugin in `vite.config.ts` (triggers a full reload, or surfaces a Vite error overlay if validation fails).

### Bootstrap flow

`src/index.html` → `src/index.ts` → `InitEngine()` (`src/_engine/InitApp.ts`), which in order: loads config, creates the root Three.js scene, `initECSWorld()`, creates the HUD container, registers scenes from generated data, registers Camera/Light managers, inits the debug camera, inits Rapier physics, then (only if `IS_DEBUG_ENV`/`IS_PROD_TEST_MODE`) registers debug tooling/stats/GUIs — and finally invokes the app's own start callback (passed into `InitEngine`) before starting the main loop.

### Debug system (dual-layer, lazy-loaded)

Debug tooling (Tweakpane-based) is split into two layers so it tree-shakes out of production builds:

- `src/_engine/debug/*.ts` and other core modules (e.g. `core/Renderer.ts`'s `createRendererDebugGUI`) are thin public entry points that, only when `IS_DEBUG_ENV` is true, dynamically `import()` the real implementation via `loadDebugModuleAsync`/`useDebug` (`src/_engine/utils/helpers.ts`).
- The actual Tweakpane implementations live in files prefixed `_dbg__` (e.g. `src/_engine/core/Debug/_dbg__Renderer.ts`, `_dbg__DebuggerGUI.ts`, plus `Debug/Camera/` and `Debug/Light/` subfolders). Follow this `_dbg__` + dynamic-import pattern when adding new debug panels for engine-level features.
- The debug drawer itself is toggled in-app with the `h` key (bound in `src/CONFIG.ts`) via `toggleDrawer()`.
- Drawer tabs are one declarative `createDebuggerTab({ id, title, icon, content, ... })` call (`debug/DebuggerGUI.ts`; implementation `core/Debug/_dbg__DebuggerGUI.ts`). `content` is a factory (re-run on every mount/rebuild) returning sections: CMPs, `{ pane: true, content: [...] }` declarative Tweakpane panes (`_dbg__DebuggerPaneBuilder.ts`: bindings, folders, buttons, separators, a `custom` escape hatch) and `debuggerListCMP` lists (`_dbg__DebuggerList.ts`, with optional per-row icon toggles). Menu order is `AppConfig.debugDrawer.tabOrder` (engine default `DEFAULT_DEBUG_DRAWER_TAB_ORDER` in `core/Config.ts`), overridable per tab with `orderNr` (same 0-based scale).
  - `openDebuggerTab(id)` opens the drawer on a tab. Refresh with `updateDebuggerTab(id, { rebuild? })`: it's a no-op unless that tab is visible (`isDebuggerTabOpen(id)`); a closed tab is rebuilt from `content` on its next mount. Use `refreshIntervalMs` (runs only while visible) and `onOpen` (returns its cleanup) instead of hand-rolled intervals/teardown, and `onRefresh` to sync live values into the objects panes bind to.
  - Persistence: `lsKey` + `state` + `persistKeys` — only those state keys are hydrated (synchronously at registration, also in prod test mode) and written (on a finished change) as a flat object; bindings can use one-level paths (`'helpers.showGrid'`). Folder open states go to `uiLsKey` (default `${lsKey}UI`). Binding `onChange` fires on user input only (never on hydration/refresh/rebuild) and gets `e.prev`/`e.last` for undo recording. Scene-scoped, boot-time and deviation-only keys stay module-owned (custom `headerButtons` for their clear-LS buttons).

This debug drawer (`src/_engine/debug/`, `src/_engine/core/Debug/`) is under active rewrite on the current branch (`legacy-refactoring-camera-mesh-light-debug-tools`) to align it with the ECS architecture — expect WIP rough edges here. Legacy (pre-ECS) Camera/Light/Mesh managers have already been fully removed in favor of ECS-based `CameraManager.ts`/`LightManager.ts`/`MeshManager.ts` in `src/_engine/core/`; favor ECS patterns for any new manager-like code rather than reintroducing non-ECS managers.

### Physics

The engine-agnostic Physics API — `PhysicsAPI.ts` (facade) + `Physics/EngineRapier.ts` (Rapier backend) + `Physics/PhysicsAPITypes.ts` (shared types/protocol) + `PhysicsManager.ts` (ECS integration) + `workers/physicsWorker.ts`/`workers/physics/physicsSwitch{World,Rigid,Coll}.ts` (worker-thread RPC switchboard). The legacy mesh-coupled `PhysicsRapier.ts` has been removed; don't reintroduce a non-ECS physics path. Rapier is currently the only backend (`Physics/ENGINES.ts`); a settings-driven engine choice (Jolt, Ammo, etc.) is a future extension point, not implemented.

`AppConfig.physics.workerTarget` (`'MAIN_THREAD' | 'WORKER_THREAD'`, default `'WORKER_THREAD'`) selects where the new system's simulation runs. In `WORKER_THREAD` mode, per-frame rigid-body transforms sync back via a physics-owned hot-path buffer (`Physics/PhysicsTransformBuffer.ts`): a real `SharedArrayBuffer` when the runtime is cross-origin-isolated (`AppConfig.physics.useSAB`, default `true`; the dev server sends the required COOP/COEP headers), otherwise an automatic single-batched-message-per-frame fallback — never one message per body either way. Physics objects are ECS components (`BODY_STATIC`/`BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS`, synced to `TRANSFORM` every frame at `ECSSystemStage.APP_POST_PHYSICS` by `PhysicsManager.ts`'s `physicsToTransformSystem`); `PhysicsManager.createPhysicsEntity` is `async` and is the entry point app code should use. Physics objects are still created in code, not yet part of the scene/asset JSON schema — that remains a future step.

Scene loads are deterministic (p101). `SceneLoader.ts` holds physics stepping (`holdPhysicsStepping`) for the whole load, replaces the physics world with a fresh one (`resetPhysicsWorld`, right after `createCameras`), and releases the hold only after every `createPhysicsEntity` call has finished (`settlePendingPhysicsEntities`, which also catches un-awaited ones). So a scene simulates identically on every visit, in both worker targets. Consequences:

- No physics entity survives a scene switch, and any body/collider reference from the previous scene is stale. Deleting one is a quiet no-op.
- Physics writes (poses, velocities, impulses, kinematic targets) go in `APP_PHYSICS_STEP` systems or in scene-load code. Writes from per-frame stages depend on frame timing. In `WORKER_THREAD` mode, `APP_PHYSICS_STEP` commands are captured per sub-step and cloned at capture, so reusing scratch vectors is safe.
- Characters (`utils/character/dynamicCharacter.ts`) are not deterministic yet: they use the wall clock, `Math.random`, and (in `WORKER_THREAD` mode) async shape casts.

To check determinism, append `?physicsProbe=N` (debug mode) or use "Determinism probe" in the Physics API debug tab. It freezes physics N fixed steps after each scene enter, logs a hash of every dynamic body's state, and diffs it against the last run of the same scene and N. The gym's `ARE_CHARACTERS_ENABLED` flag leaves its characters out for this.

### Sky box

`src/_engine/core/SkyBox/` shows at most one sky box, as the root scene's `backgroundNode` and `environmentNode`. A definition (`SkyBoxDef` in `SkyBoxTypes.ts`, typed from `schemas/skyBoxSchema.ts`) is a set of layers: `base` (`COLOR` | `EQUIRECTANGULAR` | `CUBE_TEXTURE`, with `rotate` in radians, cube `flipY` = a half turn about X, `intensity`) and `env` (background roughness and intensity, environment intensity, and the env bake's `size` 64-512 and `dynamic`). The procedural layers are `atmosphere` (a port of three's `SkyMesh`, driven by `suns[0]`), `suns[]` (disc and halo; only `suns[0]` is drawn until p114; `suns[i].light` is a managed directional light), `clouds` (need the atmosphere), `ground` and `ambientLight`; each is on when its key is there, unless `enabled: false`. Later plans add theirs (moons, stars, ...) the same way.

- State flow: `registerSkyBox(def, sceneId?)` stores definitions per scene (default: the loading scene, else the current one). `setActiveSkyBox(id | null)` resolves one (plus its debug overrides from `AEK_debugSkyBox`, debug env only), loads its texture, builds its nodes and shows it; when calls overlap, the latest wins. `SceneLoader` clears the sky box on exit and calls `activateSceneDefaultSkyBox` on enter (the last one registered with `isDefault: true`, else the first). `createSkyBox` registers and, for the current scene, shows it; its `isDefault` defaults to true, so the last one created is the default. `updateSkyBox(id, partial)` re-activates on a base structural key (`BASE_STRUCTURAL_KEYS` in `layers/base.ts`), rebuilds the nodes when the set of layers changes (`getCompositeSignature`), or `env.size`, or the background blur crossing 0; anything else is a uniform or scene property write. Overrides address one sun as `{ suns: { "0": { ... } } }` (`deepMerge` merges an index object into an array by index). Activation owns `scene.environmentIntensity`, `backgroundIntensity` and `environmentRotation`: set them in the definition, not by hand.
- Both nodes sample one PMREM (`getPMREMTexture` in `SkyEnvironment.ts`: baked once per texture, disposed with it) in the same world direction, so reflections match the background. The background looks up `normalWorldGeometry` (not `normalWorld`, which is negated on the back-side background box), and the environment is a bare `pmremTexture` so the lighting context drives its direction and level. Rotation: PMREMNode applies `scene.environmentRotation` to the environment only (it skips materials without an `envMap` property, like the background box's plain `NodeMaterial`), so the background applies the same transposed rotation itself, in `layers/base.ts`.
- Two paths. A texture-only or colour-only sky box takes the direct path (above). One with a procedural layer takes the composite path (`SkyComposite.ts`): `buildSkyComposite` stacks the layers (base, sun, atmosphere with clouds, ground, back to front) into one node, used as the background (`VIEW`) and as the background of a private bake scene (`ENV_BAKE`: wider clamped disc, no disc when the sun has a light, frozen clouds). `SkyEnvironment.ts`'s env bake runs `fromScene` into a fixed target (allocated at activation; `rootScene.environmentNode` is `pmremTexture` of it, a new node only on a size change) with one long-lived `PMREMGenerator`. Rotation and flip are baked in, so `environmentRotation` is 0 there. A blurred background samples the bake.
- `skyBoxSystem` (MAIN, order 1, default world only) moves the sky lights and runs a requested bake: at most one per frame, never while a scene loads. Value changes request a bake (`env.dynamic: false` turns that off; `bakeEnvironment()` always does). Layer uniforms are created once per activation (`createSkyUniforms`); the atmosphere's vertex-stage terms are computed on the CPU in `layers/atmosphere.ts`.
- Sky lights (`SkyLights.ts`): ordinary ECS lights made by `createLightEntity` with `managedBy: { manager: 'SKYBOX', ownerId, role }`, created on activation and deleted by `clearSkyBox`. The sky only writes what it owns (transform, colour, intensity, shadow settings and intensity, `shadow.autoUpdate`) and reads the light from `OBJECT3D` every time. The sun light follows the active camera, snapped to shadow texels in light space, and fades out below the horizon (`horizonFade`) without touching `castShadow`; a `castShadow` change re-creates the light (toggling it back on in place crashed with PostFX on, WebGPU).
- The pre-3.0 `{ type, params }` shape (code and JSON) still converts through `legacySkyBox.ts`, with a dev warning. Legacy equirects get `rotate: π` and legacy cubes `flipY: true`: that reproduces their old look in the standard orientation.
- Debug tab: `core/Debug/_dbg__SkyBox.ts` plus one `core/Debug/SkyBox/_dbg__*Folder.ts` per layer. Bindings call `setSkyBoxParam(path, ...)`, which renders the value, stores it as an override (only values that differ from the definition) and records the `skybox.param` undo action; a new layer's controls need no new action type. Layer paths, proxy keys and defaults live in `_dbg__SkyBoxShared.ts`; `_dbg__LayerFolderItems.ts` has the slider, auto/custom colour and 2-tuple helpers. The Environment folder's bake stats time GPU only on WebGPU (`_dbg__GPUTimer.ts`, shared with the PostFX profiler).

### Viewports

`src/_engine/core/Viewports.ts` renders extra rectangles over the canvas, each with its own scene and camera (picture-in-picture, minimaps, item previews), after the main render and PostFX. Each enabled viewport renders into its own render target, then a quad composites it with the renderer's tone mapping and colour space neutralised (the `RenderPipeline.render()` contract), so it works on both backends with PostFX on or off. `renderViewports()` is called once from `MainLoop.renderScene()` and is a single count check while no viewport is enabled. A viewport is render configuration, not ECS: `createViewport({ id, scene, camera, anchor | rect, ... })`, where `camera` can be a resolver (eg. `getActiveCamera`), and `sceneId` deletes it on that scene's exit.

- Placement is DOM-driven. Each viewport owns a slot element in `#aekViewportsLayer` (created on the first viewport), either in a corner stack (`anchor` + `order`, 0 = in the corner; global class `aekViewportStack_<ANCHOR>` for consumer SCSS) or at an explicit `rect` (px or %). The rendered rect is the slot's box, re-read only on create/enable, canvas resize, `<body>` class changes, while a CSS transition runs in the layer, or on `invalidateViewportLayout()`.
- `interactive` slots take pointer events, so those never reach the canvas, OrbitControls or `MouseInput`; raycast into the viewport with `getViewportPointerNDC`. Other slots let everything through.
- The first consumer is the debug-only axes gizmo (`debug/AxesGizmo.ts` → `core/Debug/_dbg__AxesGizmo.ts`): top right, follows the active camera, F8 and two Debug Tools options. With the debug camera, clicking a bubble aligns it and dragging orbits it.

### Build config notes (`vite.config.ts`)

- `root: './src'`, output to `../dist`.
- `vite-plugin-wasm` for Rapier's WASM binary.
- Custom `sceneGathererPlugin` (see data pipeline above) and an `html-transform` plugin that injects `%APP_NAME%`/`%VERSION_CHECKSUM%`/etc. placeholders (sourced from `package.json`'s `app_metadata`/`engine_metadata`/`toolkit_metadata`) into `index.html`.
- `rollup-plugin-visualizer` writes a bundle treemap to `dist-stats/bundle-stats.html`.
- No TS path aliases are configured (`tsconfig.json` has no `paths`) — imports are relative.

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

- A Stop hook runs lint and type-check, plus the version rule check when `package.json` changed. Leave the tree compiling.
- `docs/plans/` holds specs for unstarted work. Never treat one as current state or implement one unless I reference it explicitly.
