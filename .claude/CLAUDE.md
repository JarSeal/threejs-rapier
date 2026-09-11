# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Ækasha — a WebGPU/Three.js + Rapier physics game engine framework (package name `aekasha-js`). It's a "template" repo: an engine (`_engine`) plus one example app (`app`) built on top of it.

## Commands

- `yarn dev` — start the dev server (Vite, port 8080), development env.
- `yarn dev:test` — dev server with `VITE_APP_ENV=test`.
- `yarn dev:production` — dev server against production env vars.
- `yarn build` — type-check (`tsc`) + production build to `dist/`.
- `yarn build:test` — production build with `VITE_APP_ENV=test`.
- `yarn lint` — ESLint (flat config in `eslint.config.js`, Prettier enforced as a lint rule).
- `yarn docs` — generate TypeDoc docs (scoped to `src/_engine/**` only — the engine is the documented public API surface; `app`/`toolkit` are not documented).
- `yarn gatherAppData` — manually run the scene/asset JSON → generated data pipeline (see below); this also runs automatically before `dev`/`build` and via a Vite plugin on file save.

There is no test suite/framework configured in this repo currently (no `test` script, no test runner dependency).

In the browser, append query params to toggle modes: `?isDebug=true` (full debug tooling) and `?isProdTest=true` (production build with a subset of debug features). These only take effect in the `development`/`test` `VITE_APP_ENV` builds (see `src/_engine/core/Config.ts`).

## Architecture

### Three-folder split

- `src/_engine/` — the core engine (renderer, ECS, physics, cameras, lights, debug tooling, UI). Treat as stable/library code; changes here should be minimal and purposeful.
- `src/toolkit/` — reusable ECS components/modules, models, textures, shaders, and assets meant to be imported as-is or copy-pasted into `app` and modified.
- `src/app/` — the actual game/app: scenes and asset JSON files, app-specific managers/components.

This boundary is convention only — nothing in `eslint.config.js` enforces import restrictions between the folders (the one exception is a manual comment, not a lint rule: `core/ECS/ECSRegistry.ts` says "NO OTHER LOCAL IMPORTS ALLOWED HERE").

### ECS core

`src/_engine/core/ECS.ts` defines `ECSWorld`, a bitwise-packed (index + generation) entity/component store. Key patterns:

- **Plugin registration**: managers call `ECSWorld.registerPlugin(fn)` and `ECSWorld.registerComponentHooks(type, { onAddComponent, onRemoveComponent, onDeleteEntity })` at module load time (static, applies to all current/future worlds). App-level plugin registration is centralized in `src/AppECSPlugins.ts` — this is where you wire up new app/toolkit ECS managers/effects.
- **Component types**: core types live in `src/_engine/core/ECS/ECSRegistry.ts` + `ECSCoreComponents.ts`. App-specific component types/data extend this in `src/AppECSRegistry.ts` (`AppComponentType`, `AppComponentData`) — that file is import-type-only by convention (comment at the top: "import only types and everything with `import type ...`") so it stays tree-shakeable.
- **System stages**, also defined in `src/AppECSRegistry.ts` (`ECSSystemStage`), run in this fixed order every frame: `MAIN → APP_PRE_PHYSICS → APP_POST_PHYSICS → APP_LOGIC → APP_RENDER_SYNC → LATE_MAIN`. `APP_POST_PHYSICS` is where physics state syncs into ECS transforms; `APP_RENDER_SYNC` is where ECS transforms sync into Three.js `Object3D`s.

### Scene/asset data pipeline (JSON → generated code)

Scenes and assets are authored as JSON files under `src/app/**`, named by suffix (e.g. `*.scene.json`, `*.mesh.json`, `*.camera.json`, `*.light.json`, `*.geometry.json`, `*.texture.json`, `*.material.json`, `*.importedMesh.json`, `*.skybox.json`). `devTools/gatherAppData.ts`:

1. Walks `src/`, finds files matching those suffixes.
2. Validates each against a Zod schema in `src/_engine/schemas/*.ts`.
3. Emits `src/_engine/generatedAppData.json` and `generatedAppFns.ts` (consumed at runtime by `src/_engine/core/Scene.ts`'s `registerScenesFromGeneratedData()` to build scenes).
4. Also compiles the Zod schemas to plain JSON Schema files in `.schemas/*.schema.json` (used for editor autocomplete/validation on the asset JSON files themselves).

This runs via `yarn gatherAppData`, and automatically on file add/change/delete during `yarn dev` through the custom `sceneGathererPlugin` Vite plugin in `vite.config.ts` (triggers a full reload, or surfaces a Vite error overlay if validation fails).

### Bootstrap flow

`src/index.html` → `src/index.ts` → `InitEngine()` (`src/_engine/InitApp.ts`), which in order: loads config, creates the root Three.js scene, `initECSWorld()`, creates the HUD container, registers scenes from generated data, registers Camera/Light managers, inits the debug camera, inits Rapier physics, then (only if `IS_DEBUG_ENV`/`IS_PROD_TEST_MODE`) registers debug tooling/stats/GUIs — and finally invokes the app's own start callback (passed into `InitEngine`) before starting the main loop.

### Debug system (dual-layer, lazy-loaded)

Debug tooling (Tweakpane-based) is split into two layers so it tree-shakes out of production builds:

- `src/_engine/debug/*.ts` and other core modules (e.g. `core/Renderer.ts`'s `createRendererDebugGUI`) are thin public entry points that, only when `IS_DEBUG_ENV` is true, dynamically `import()` the real implementation via `loadDebugModuleAsync`/`useDebug` (`src/_engine/utils/helpers.ts`).
- The actual Tweakpane implementations live in files prefixed `_dbg__` (e.g. `src/_engine/core/Debug/_dbg__Renderer.ts`, `_dbg__DebuggerGUI.ts`, plus `Debug/Camera/` and `Debug/Light/` subfolders). Follow this `_dbg__` + dynamic-import pattern when adding new debug panels for engine-level features.
- The debug drawer itself is toggled in-app with the `h` key (bound in `src/CONFIG.ts`) via `toggleDrawer()`.

This debug drawer (`src/_engine/debug/`, `src/_engine/core/Debug/`) is under active rewrite on the current branch (`legacy-refactoring-camera-mesh-light-debug-tools`) to align it with the ECS architecture — expect WIP rough edges here. Legacy (pre-ECS) Camera/Light/Mesh managers have already been fully removed in favor of ECS-based `CameraManager.ts`/`LightManager.ts`/`MeshManager.ts` in `src/_engine/core/`; favor ECS patterns for any new manager-like code rather than reintroducing non-ECS managers.

### Physics

`src/_engine/core/PhysicsRapier.ts` wraps `@dimforge/rapier3d-compat`, exposing rigid bodies/colliders as `PhysicsObject`s and integrating with the ECS world, `MeshManager`, and the main loop. Despite a `PhysicsWorkerTarget` config option and worker-switch scaffolding in `src/_engine/workers/physicsWorker.ts` and `src/_engine/workers/physics/*.ts`, that worker-threaded path is currently disabled (the worker file body is commented out) — physics currently only runs on the main thread. `src/_engine/core/PhysicsAPI.ts` is entirely commented-out legacy code from an earlier threaded design; don't build on it.

The plan in the near future is to implement the commented code in the PhysicsAPI.ts file (and others) so that physics system is engine agnostic (Rapier, Jolt, Ammo, etc.) and can be changed in the settings, and also that the physics system can be either run by the main thread or in a worker (also configured in the settings). When that is implemented, then the physics object can be made into an ECS component and the physics object should be added to the scene and saveable file schema format.

### Build config notes (`vite.config.ts`)

- `root: './src'`, output to `../dist`.
- `vite-plugin-wasm` for Rapier's WASM binary.
- Custom `sceneGathererPlugin` (see data pipeline above) and an `html-transform` plugin that injects `%APP_NAME%`/`%VERSION_CHECKSUM%`/etc. placeholders (sourced from `package.json`'s `app_metadata`/ `engine_metadata`) into `index.html`.
- `rollup-plugin-visualizer` writes a bundle treemap to `dist-stats/bundle-stats.html`.
- No TS path aliases are configured (`tsconfig.json` has no `paths`) — imports are relative.
