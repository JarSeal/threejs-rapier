Status: draft | epic — not-implemented
Category: Refactoring, Documentation, Architecture, Build
Blocks: \_DONE_p601_refactoring-safety-net-tests-and-baselines.md, \_DONE_p602_architecture-and-target-structure.md, \_DONE_p603_gameplay-architecture-contracts.md, \_DONE_p604_multiplayer-viability-study.md, \_DONE_p605_coding-standards-and-documentation-tooling.md, p606_layering-inversion-and-public-entry.md, p607_sbp-foundation-feature-modules.md, p608_engine-folder-restructure.md, p609_toolkit-and-app-restructure.md, p610_character-and-input-action-architecture.md, p611_sbp-tooling-profiles-and-marketing.md, p612_review-ecs-loop-config-init.md, p613_review-rendering-scene-assets.md, p614_review-physics.md, p615_review-sky-box.md, p616_review-lod-spatial-instancing-lines.md, p617_review-input-ui-hud.md, p618_review-debug-public-api.md, p619_review-schemas-pipeline-devtools-hub.md, p620_review-toolkit-and-app-code.md, p621_hub-docs-readme-and-claude-md-final.md
Related: p990_follow-ups-from-done-plans.md (its bundle size items move to p607), p200_component-query-caching.md (its main-camera cache lands in p612), p420_npc-simulation-tiers.md (fits p603's actor model), p500_restore-physics-snapshot.md (p604's rollback prerequisite), p302_material-and-texture-system-refactor.md (p613 leaves what it rewrites), p240_client-device-capability-sniffer.md (SBP-aware: its benchmark is a lazy chunk), `docs/templates/todo-plan-prompts.txt` (the original prompt, and the p800, p450, p070 and p770 prompts this epic sequences)

# Whole Codebase Refactoring and Documentation — Epic

Every file in `src/` (and the dev tooling) gets reviewed for code quality, performance and
documentation, and the engine, toolkit and app get the structure they need to grow: a layering
the lint enforces, one public entry point, feature modules that cost nothing when unused (the
**Smallest Build Possible**, SBP), and contracts the future gameplay features (characters,
vehicles, NPCs, missions, weather, multiplayer) plug into.

The structural work comes first (Stages A and B), the per-file review and JSDoc pass after it
(Stage C), the Hub and CLAUDE.md last (Stage D). This file holds what every child plan shares; the
work is split into the plans in §10.

---

## 1. Goal

- **A codebase that competes with the best engines' DX:** a developer finds a feature where they
  expect it, imports it from one place, reads its JSDoc in the editor and the Hub, and extends it
  without editing engine files.
- **Done means measurable:**
  - Every export of the public API is documented, and the lint plus TypeDoc's validation keep it
    so (a ratchet, p605).
  - The engine ← toolkit ← app layering is a lint rule, not a convention (p606).
  - The SBP is a number: per-feature bundle sizes with budgets, checked on every build (p611).
  - CLAUDE.md states the structure, the coding standards, the SBP strategy and the main flow
    (p605, p621).
  - The Hub's documentation, architecture and migration pages are current (p621).
- **No behaviour change by accident.** Structural plans keep every scene's snapshot, determinism
  hash and saved data identical (§3.7). A plan that changes behaviour says so.

## 2. Grounding (checked against the code, 2026-10-09)

### 2.1 Size and shape

- 103.9k lines of `.ts` in `src/`: about 40% debug tooling (`core/Debug/**`, 92 `_dbg__` files).
- Largest files: `core/PhysicsAPI.ts` 4,481 lines, `core/Physics/PhysicsAPITypes.ts` 3,212,
  `core/Physics/EngineRapier.ts` 2,612, `core/Character/DynamicCharacter.ts` 1,534,
  `core/UI/DraggableWindow.ts` 1,503, `Debug/Light/_dbg__LightGUI.ts` 1,474.
- Largest functions: `createDynamicCharacter` (a ~970-line closure, `DynamicCharacter.ts:512`),
  `RigidBodyProxyAPI` (~985 lines, `PhysicsAPI.ts:2920`), `EngineRapier`'s `step` (~517 lines),
  `scene_thirdPersonGym.ts`'s `scene` (~544 lines), `createEditLightContent` (~503 lines).
- Quality markers: 59 `any`, 57 `eslint-disable` (33 `no-explicit-any`, 20 `no-unused-vars`),
  40 TODO / FIXME, no `@ts-ignore`, no `console.*` outside `utils/Logger.ts`.

### 2.2 Layering is inverted

- **33 engine files import app-root files.** 31 import `ECSSystemStage` / `APP_RENDER_SYNC_ORDER`
  from `src/AppECSRegistry.ts` (`core/ECS.ts`, `core/Character.ts`, `core/PhysicsManager.ts`,
  `core/ECS/ECSCoreSystems.ts`, many `_dbg__` files); `core/ECS/ECSCoreComponents.ts` imports
  `AppComponentType` / `AppComponentData`; `core/Config.ts` imports `../../CONFIG`.
- `generatedAppFns.ts` statically imports the app's and toolkit's `.tsl.ts` files, and
  `SceneLoader`, `PostFX`, `Material` and `_dbg__MaterialEditor` import it.
- **Toolkit → app root:** `toolkit/ecs/effects/{HoverEffect, SunShadowFit, FollowTool,
MutualGravity}.ts` import `AppECSRegistry`, which imports them back (and
  `app/examples/ecs/SpinComponent`). Three of them read their own storage through `as any`.
- **Extending the ECS means editing app files:** component keys are strings merged into
  `ComponentType` in `ECSCoreComponents.ts`; a third-party module (vehicles, networking) has to
  add its key and data type to `AppECSRegistry.ts` and its systems to `AppECSPlugins.ts`. System
  stages are a closed enum in the app-root file.
- **No public API file:** the app deep-imports about 40 engine paths (`core/MeshManager` 28 times,
  `core/Material` 26, `core/Geometry` 23, `core/ECS/ECSCoreComponents` 13, `utils/world/*`), so any
  move breaks app code.
- The app never imports `core/Debug` or `_dbg__` engine files (0 hits): the debug boundary holds.

### 2.3 Folder structure

- **Debug code is reached two ways:** through the 15 `debug/*.ts` entry files (`debug/DebuggerGUI.ts`
  has 61 importers, `debug/Profiler.ts` 24), or through an inline "Debugger stuff" block at the
  bottom of 13 core feature files that load their `_dbg__` module themselves (`CameraManager`,
  `Character`, `ECS`, `LightManager`, `Lod/LodSystem`, `MainLoop`, `PhysicsAPI`, `PhysicsManager`,
  `PostFX`, `Raycast`, `Renderer`, `SkyBox/SkyBox`, `Spatial/SpatialIndexSystem`). Debug-only code
  also sits in `core/Input/DefaultDebugKeyBindings.ts`, `core/UI/3DSymbols/` and
  `utils/UI/PercentagePieHtml.ts`. The app's own `_dbg__` modules (5) follow the engine's naming.
- **`utils/` mixes four kinds of code:**
  - Real utilities: `Logger`, `assert`, `LocalAndSessionStorage`, `constants`, `deepMerge`,
    `PromiseResolver`, `Window`, `object3DHelpers`, `stats/IntervalCounterStats`.
  - A grab bag: `helpers.ts` (612 lines: file extensions, disposal, scratch vectors,
    `smoothDampVec3`, `initWorker`, the debug-module loaders, light helpers), whose name differs
    from `core/Helpers.ts` (axes and grid helpers) only in case.
  - ECS and gameplay features: `ECSHelpers.ts`, `world/movingPlatform.ts` (493 lines),
    `cameras/followObjectCameraRig.ts`, registered from `src/AppECSPlugins.ts`.
  - Test and demo code: `ECSStressTest.ts`, `PhysicsStressTest.ts`,
    `world/characterTestObjects.ts`, `world/characterTestObstacles.ts`. Orphans:
    `materials/checkerBoardPattern.ts`, `materials/nestedGridPattern.ts`. Misspelled:
    `commontTypes.ts` (one type).
- **UI is scattered:** `core/UI/` (DialogWindow, DraggableWindow, DropDown, Toaster,
  `icons/SvgIcon.ts`, 3DSymbols), `core/HUD.ts`, `utils/CMP.ts` (1,062 lines, the DOM component
  helper, 36 core importers), `utils/UI/`, `styles/`. Apps use `getHUDRootCMP()` + CMP, `addToast`
  or raw DOM; DraggableWindow, DialogWindow, DropDown and `SvgIcon` are engine-only.
- **`core/` is half flat, half folders:** feature pairs (`Character.ts` + `Character/`, `ECS.ts` +
  `ECS/`, `PostFX.ts` + `PostFX/` holding one types file, `LineManager.ts` + `Lines/`, `Raycast.ts`
  - `RayDebugTypes.ts`), physics over four flat files (`PhysicsAPI`, `PhysicsManager`,
    `PhysicsTiers`, `PhysicsTierPolicy`) plus `Physics/`, and `Texture`, `TextureArray`,
    `TextureAtlas` flat. `*Manager` on some modules only (Camera, Light, Mesh, Group, Line, Physics,
    View) and plain names on the rest (Geometry, Material, Texture, Scene, Renderer).
- **The app:** about 25 scene files flat in `src/app/` with mixed naming (`scene01_v2.ts`,
  `scene_thirdPersonGym.ts`, `largeWorld.ts`) next to the asset-type folders.
- **The toolkit:** `toolkit/ecs/InstancedMeshPool*.ts` are deprecated re-exports of
  `core/Instancing` (kept until the toolkit's next major).

### 2.4 Bundle (production build, 2026-10-08)

The main chunk `index-*.js` is 214 modules, **6.60 MB rendered, 1.77 MB gzip**.

| Module                    | Rendered | Gzip   |
| ------------------------- | -------- | ------ |
| `rapier.mjs`              | 2.24 MB  | 829 kB |
| `three.webgpu.js`         | 2.23 MB  | 433 kB |
| `three.core.js`           | 1.03 MB  | 202 kB |
| GLTFLoader                | 116 kB   |        |
| `core/PhysicsAPI.ts`      | 92 kB    |        |
| `Physics/EngineRapier`    | 64 kB    |        |
| `core/UI/DraggableWindow` | 33 kB    |        |

- **Rapier is in the main chunk even with `WORKER_THREAD`** (the app's default): `ENGINES.ts:23`
  loads the backend with a dynamic `import()`, but `ENGINES.ts:3` imports EngineRapier statically
  and `EngineRapier.ts:1` imports `@dimforge/rapier3d-compat` as a value (`:1073`,
  `Rapier.World.restoreSnapshot`). The compat build inlines its WASM as base64, so the worker
  carries a second copy. Rapier alone is 47% of the main chunk's gzip.
- **Every subsystem ships:** `InitApp.ts:1-63` imports them all statically and runs their init.
  SkyBox (91 kB rendered), LOD (30 kB), Spatial (37 kB), Lines (27 kB), Viewports (12 kB), Input
  (22 kB, `DefaultDebugKeyBindings` 8.9 kB of it), Import + GLTF / Draco loaders, the 13 `debug/*`
  wrappers, Toaster and all 49 SVG icons (`SvgIcon.ts`'s `?raw` imports) are in main whether the
  app uses them or not.
- **Module-level registrations defeat tree-shaking:** `ECSWorld.registerPlugin` /
  `registerComponentHooks` at the top level of `ECSCoreSystems.ts`, `ObjectFrustumCullingSystem.ts`,
  `LightObjectCullingSystem.ts`, `MeshManager.ts`, `GroupManager.ts`, `SkyBox/SkyBox.ts:722`,
  `Lod/LodSystem.ts`, `Spatial/SpatialIndexSystem.ts`, `Character.ts`, `Raycast.ts`, plus
  `src/AppECSPlugins.ts`. `package.json` has no `sideEffects` field.
- **`generatedAppFns.ts`'s TSL material and PostFX maps are static `import * as`** (`:3-9`,
  `:213`, `:234`): every TSL material (28 kB) and GTAONode (21 kB) are in main. The scene modules
  themselves are lazy, one chunk each.
- **Debug gating is runtime only:** `IS_DEBUG_ENV` (`Config.ts:507`) is a `let` computed from
  `VITE_APP_ENV` and the URL, so the build keeps every debug branch. The `_dbg__` modules and
  Tweakpane (152 kB) are lazy chunks; the wrappers that load them aren't.
- **three:** 194 `three/webgpu` and 41 `three/tsl` imports; `three/examples/jsm/Addons.js` barrel
  imports in `Texture.ts:3` and `Import/MeshColliderGeometry.ts:2`. The classic WebGLRenderer is
  tree-shaken out (285 B); the WebGL fallback backend is part of `three.webgpu.js`.
- `vite.config.ts`: no `manualChunks`, no `build.target`, `define` has only `__PROJECT_METADATA__`.

### 2.5 Documentation

From the Hub's TypeDoc model (`.cache/hub/typedoc.json`, the documented API surface: engine and
toolkit minus `_dbg__*` and `generatedApp*`):

- 2,029 exported reflections, **1,282 documented (63%)**; members of exported classes and
  interfaces 209 of 441 (47%; ECS class members 10 of 96).
- Worst folders: `core/Physics` 65 / 221 (29%: 153 type aliases, 33 documented), `schemas`
  38 / 154 (25%: 57 Zod-inferred types, 1 documented), `core` 359 / 509 (71%), `debug` 128 / 176,
  `utils` 61 / 107, `SkyBox/layers` 47 / 79, `core/Input` 30 / 54, `core/UI` 28 / 47,
  `toolkit/geometry` 8 / 21.
- Non-exported top-level functions: about half have a comment (`utils` 0 of 35,
  `toolkit/materials` 0 of 14, `core/Input` 10 of 44).
- **Nothing enforces it:** `eslint.config.js` has no JSDoc plugin; `typedocOptions` has no
  `validation`, `requiredToBeDocumented` or `treatValidationWarningsAsErrors`.

### 2.6 Gameplay and multiplayer foundations

- **Characters:** `core/Character.ts` is generic (the `CHARACTER` component, bindings,
  `characterControllerSystem` at `APP_PHYSICS_STEP`). `CharacterController` (`tick`, `dispose?`,
  `probes?`, `config?`) and `CharacterBodyPlan` are pluggable, and `CharacterIntent` (move, turn,
  `faceYaw`, jump, run, crouch) is a device-free input boundary whose doc names AI, cutscenes and
  network code as writers. Hardwired: `createCharacter` always creates a physics entity,
  `DynamicCharacter` is the only controller, the input schemes (TANK, WORLD*FIXED,
  CAMERA_RELATIVE) are a closed keyboard-only union wired inside `createDynamicCharacter`,
  `CharacterData` mixes state, `*`config and`\_\_`internals, and the intent is humanoid-shaped
(no throttle, steer, brake). No hook for animation, IK or vehicles beyond`onLocomotionStateChange`.
- **Input:** `core/Input/*` is per-device binding registries (keyboard, mouse, touch); the gamepad
  is a TODO stub; there is no action layer and no input recording.
- **Multiplayer bases:** a fixed-step accumulator (`stepPhysics`, `PhysicsAPI.ts:355`) with an
  absolute step index (`getPhysicsSubStepIndex`), the `APP_PHYSICS_STEP` stage, deterministic
  scene loads and the determinism probe, `CharacterIntent`, a DOM-free physics worker
  (`EngineRapier.ts` imports only Rapier; p604 ran it in Node, bit for bit) and a tick-stamped
  protocol (`STEP` with per-sub-step commands, `requestId`-matched replies, `SHARED_MEMORY` /
  `MESSAGE_BATCH` transports).
- **Multiplayer blockers:**
  - Characters aren't deterministic: `Math.random` for the tumble impulse
    (`DynamicCharacter.ts:1497`), the wall-clock `getPhysGameTime()` (`performance.now()`,
    `PhysicsAPI.ts:987`), async casts that answer a step late in `WORKER_THREAD` mode.
  - Rapier is the compat build, not the one Rapier guarantees deterministic across platforms
    (p604 found the compat build reproducing across browsers and CPUs all the same, §7).
  - Entity ids are per world (index + generation); `appId` is optional (a UUID otherwise) and
    `getEntityIdByAppId` is a linear scan.
  - No ECS serializer; physics snapshot restore is broken (p500).
  - The core can't run headless: `Config.ts:304` reads `window.location` and `import.meta.env` at
    load, `PhysicsAPI.ts:10` imports `physicsWorker?worker`, `MainLoop.ts` needs rAF and a
    renderer, `InitEngine` always builds the HUD and imports SCSS, `ECS.ts` imports `three/webgpu`.
  - `worker.postMessage` is called directly (`PhysicsAPI.ts:842`): no transport interface.

## 3. Shared principles

Every child plan follows these; p602 turns §3.1-§3.5 into exact decisions.

### 3.1 Layering

- **Engine ← toolkit ← app.** The engine imports neither; the toolkit imports only the engine.
  Enforced by `import/no-restricted-paths` (eslint-plugin-import is already a dependency), so a
  violation fails `yarn lint` and the Stop hook.
- **The engine owns its types:** system stages and their order constants move into the engine.
  App and toolkit component types extend the engine's registry by TypeScript declaration merging
  (`declare module '…' { interface ComponentDataMap { … } }`), so a module adds components without
  editing a shared file and reads its storage without `as any`.
- **Configuration flows in:** `InitEngine(appConfig, …)` receives `CONFIG`; generated data and the
  generated function maps are handed to the engine (or imported through one generated module the
  engine declares), not imported from app paths.

### 3.2 Public API

- One entry point (`aekasha`, a TS path alias plus a Vite alias), with per-feature entry modules
  (`aekasha/physics`, `aekasha/skybox`, …) so an import names what it costs, and the toolkit under
  the same root (`aekasha/toolkit/*`, p602 D1). Only the entry points
  are documented; everything else is `@internal`.
- The app and the toolkit import only entry points (a lint rule after p606).

### 3.3 Feature modules

- A feature is installed explicitly, by listing it in `InitEngine`'s `features` (p602 D8; no
  preset). Never by a module-level side effect.
- Each feature owns its ECS registrations, its systems, its debug module and its Hub page.

### 3.4 Simulation vs presentation

- **Simulation** (ECS game state, physics, characters' controllers, AI, gameplay systems):
  deterministic, advanced only at the step clock (`APP_PHYSICS_STEP`, the step index as time),
  serializable, and free of the DOM, the renderer and Vite-only imports.
- **Presentation** (rendering, interpolation, animation, UI, audio, debug): reads the simulation,
  never writes it except through intents and commands.
- The simulation never reads the presentation: not the synced `TRANSFORM`s, interpolated poses or
  `Object3D`s, which lag a frame behind the physics worker. It reads physics state through
  step-stamped reads (`readBodyPositionsAtStep`; p604 §4.8).
- Not every module needs both halves; the split is about which rules a file lives under.

### 3.5 Debug code

- One gate and one pattern: the feature's public module stays thin, its debug implementation
  lives in an `_dbg__` module next to the feature (colocated, p602 D4), and it is
  reached through one loader, compiled out of shipping builds (§4.1).
- p800 (the debugger UI overhaul, not planned yet) replaces Tweakpane later, so p600 moves and
  documents debug code but doesn't polish its panels.

### 3.6 Naming and API shape

- Verbs: `create*` / `delete*` (entities and owned objects), `register*` / `unregister*`
  (definitions), `get*` / `set*`, `load*Async` / `*Async` for promises, `on*` listeners that
  return their remover, `is*` / `has*` predicates.
- Options objects for anything with more than two parameters or any optional one.
- Files: PascalCase for every module; the one exception is a file named after an asset id
  (`asteroid.tsl.ts`). p602 D7 has the rule and the renames.

### 3.7 What a move must keep

- **localStorage keys** (`AEK_debug*`), **`__saveData`** entries and their `__meta`, URL flags.
- **The Hub's `#region` markers:** a renamed or moved file breaks its includes; `yarn hub:build`
  fails with the page and line, and the include is fixed in the same change.
- **Every scene's determinism hash and snapshot** (p601's runner), unless the plan says otherwise.
- **The generated data's shape** and the JSON Schemas the asset files point at.

## 4. Smallest Build Possible (SBP)

"Only what you use ships." A 3D banner on a marketing page and an open-world game build from the
same engine; each one's bundle holds the features it calls and nothing else.

### 4.1 Layer 1: tree-shakeable by construction (p607)

- No module-level registrations (§2.4): features register when installed.
- `package.json` `sideEffects` listing only the stylesheets, so Rollup may drop unused modules.
- Rapier loaded only by dynamic `import()`: out of the main chunk in `WORKER_THREAD` mode (~829 kB
  gzip, ~47% of today's main chunk), and in `MAIN_THREAD` mode a lazy chunk fetched at
  `initPhysics`. An app without physics loads it nowhere.
- The line core registered on first use (from p990), an icon registry where each icon is its own
  import (from p990), lazy TSL material and PostFX maps in `generatedAppFns.ts`, no `Addons.js`
  barrel imports, loaders (GLTF, Draco, KTX2, HDR) imported where they're used.
- A compile-time `__AEK_DEBUG__` define: `false` in `VITE_APP_ENV=production` builds, so the debug
  wrappers, debug key bindings and debug branches fold away. Development and test builds keep it
  `true`, so `?isDebug` and `?isProdTest` work as today (`isProdTest` is only honoured in those
  builds already, `core/Config.ts`).

### 4.2 Layer 2: a data-driven feature manifest (p607, p611)

`gatherAppData` already knows what each shipped scene's data uses: asset types, sky box layers,
impostors, LOD definitions, PostFX passes, texture codecs (KTX2 → KTX2Loader, Draco GLBs →
DRACOLoader). It emits that as constants in a generated module, so code paths no shipped scene
needs are eliminated even when a feature's entry point is imported for code-driven use.

### 4.3 Layer 3: tooling (p611)

- **`yarn sbp`:** builds, then reports the size of each feature (from the module graph), why each
  one is included (the import chain from the entry), and the diff against the committed baseline
  (p601). Budgets per feature and per chunk in config; over budget fails the build like the asset
  pipeline's budgets do.
- **Profiles:** a minimal "banner" example (renderer, one scene, a camera, a mesh, no physics, no
  debug) that measures the floor and is the SBP Hub example.

### 4.4 The honest floor

`three.webgpu.js` + `three.core.js` are 635 kB gzip after tree-shaking: the floor for any page on
the WebGPU renderer and TSL. The node system is what makes them large, and three ships it as one
build, so SBP can't go below it. A "lite" profile on three's classic WebGLRenderer (no TSL, no
node materials, no WebGPU) could reach well under 200 kB, but the engine's materials, sky box,
PostFX and LOD dither are all TSL. p611 studies whether a lite profile is worth a second material
path; it is not a promise of this epic.

### 4.5 Marketing

SBP becomes one of the brand's core principles next to Primordial Performance, Modular Infinity
and Threaded Reality: in the readme's "Why Ækasha?", the Hub homepage's featured features, and a
Hub feature page with the banner example's real numbers (p611, p621).

## 5. The per-file review standard

Every Stage C plan applies this checklist to each file in its scope, and records what it found
and changed per file group:

1. **Correctness:** races in async code (scene switches, worker replies), stale references after
   a scene change, disposal (three r186's render objects, GPU resources), error paths.
2. **Placement:** the right layer (§3.1) and folder (p602's map).
3. **API shape:** §3.6, the public / `@internal` split, no leaking internals in types.
4. **Performance:** no per-frame allocations, storages read once per frame in hot loops,
   no redundant GPU state changes. The project's `perf-auditor` agent runs over each area.
5. **SBP:** no module-level side effects, heavy dependencies behind `import()`.
6. **Size:** a soft limit of about 800 lines per file and about 150 per function; a file or
   closure over it is split unless the plan says why not.
7. **Type hygiene:** `any`, `eslint-disable` and TODO / FIXME are removed, or turned into an
   issue (`docs/issues/`) or a plan item with a reason.
8. **JSDoc** (style set by p605): a summary sentence on every export, `@param` and `@returns`
   where they add something, `@example` on entry APIs, `@remarks` for traps (the "three r186
   traps" CLAUDE.md lists today), `@internal` on what isn't public. Non-exported functions get a
   comment when their purpose isn't obvious from the name.
9. **Tests:** Vitest tests for pure logic the plan touches (p601's setup).
10. **Verification:** p601's scene runner passes (no new console errors, snapshots and
    determinism hashes unchanged), `yarn build`, `yarn hub:build`, the coverage ratchet.

## 6. Gameplay architecture direction

p603 decided it (firm contracts C1-C5 and the RNG, the rest a direction with a stub plan each,
p421-p427); this is the direction it started from. The engine provides contracts and one solid
implementation of each; new features are separate plans outside this epic.

- **Actor:** an ECS entity with a role (player, NPC, vehicle, prop). No class hierarchy.
- **Controllers** move an actor's body: dynamic (today's `DynamicCharacter`), kinematic (Rapier's
  `KinematicCharacterController`, a commented-out signature in `PhysicsAPITypes.ts` today),
  backend-provided (a future Jolt `CharacterVirtual`), vehicle (raycast wheels). One interface,
  chosen per actor, swappable at runtime (NPC tiers, p420).
- **Intents and actions:** a device-free action layer (p610) above keyboard, mouse, touch and
  gamepad, with bindings per context. `CharacterIntent` becomes one intent schema next to vehicle
  and camera schemas.
- **Brains** write intents: player input, AI (behaviour trees or utility AI, p420's tiers),
  network (remote players), replay and cutscenes. A controller never knows which brain drives it.
- **Animation** (presentation side): a state graph fed by the locomotion state and intents, IK
  layers (foot placement, look-at, hand targets), ragdoll as a controller mode
  (`PHYSICS_ONLY` exists).
- **World systems:** missions and objectives (an event-driven state machine with save data), a
  sequencer with spline paths for cutscenes and cameras, weather and mood (global state that
  materials read, which p307 consumes, and the sky box drives), and a seeded RNG service
  (simulation code never calls `Math.random`).
- **Where it lives:** generic contracts and the core implementations in the engine; ready-made
  controllers, brains and effects in the toolkit; game-specific logic in the app.

## 7. Multiplayer: the verdict (p604)

**Viable, with a staged path**, confirmed by p604's measurements (its §3.1 and Phase 1): the
engine's physics worker ran in Node from a recorded message stream and reproduced the browser
bit for bit, and so did Chromium, Firefox and an Android phone (x86-64 and ARM).

- **Go after the structural stage:** an authoritative server running the simulation headless,
  clients sending intents stamped with the step index and rendering interpolated snapshots. The
  physics half runs headless today; the gameplay half (the `APP_PHYSICS_STEP` systems in the main
  thread's ECS) needs the headless core (p606, p608). `physicsTiers` steps in 0.29 ms on a server;
  sending only the changed bodies, quantized, at 20 Hz costs 45-62 kbit/s per client for its 687
  bodies.
- **Go, staged:** client prediction and reconciliation, blocked by p500 (snapshot restore) and
  p610 (deterministic characters). Snapshots take and restore in 0.25-4 ms; re-simulating the
  whole world is the cost, so the local character is predicted with a kinematic controller (p421)
  and only small worlds are rewound whole.
- **Possible later, not shaping the engine now:** lockstep and rollback. Rapier's compat build
  reproduced across machines in p604's tests, but only its deterministic build
  (`@dimforge/rapier3d-deterministic-compat`: 0-9 % slower, +12 kB gzip, different results
  from compat) is guaranteed to; a lockstep game switches then. The blockers are our own code:
  characters, JS `Math` in simulation code, every peer on the same build. Rollback re-simulates
  every misprediction, so it fits small active worlds only.
- **Constraints adopted now** (cheap, and good design anyway; the full list is p604 §4):
  - The simulation/presentation split (§3.4), including the simulation reading its own state at
    the step, never the synced or interpolated poses.
  - Simulation time is the step index (`getPhysicsSubStepIndex`), never the wall clock.
  - A seeded RNG service for simulation code.
  - A stable network id per replicated entity, with a map instead of the linear `appId` scan.
  - The input action layer: brains write intents, so a network brain is just another brain.
  - A transport interface in front of `postMessage`, so a WebSocket or WebTransport channel can
    stand where the worker is; protocol messages stay plain data.
  - A core that runs headless (no `window`, `import.meta.env` or `?worker` at module load), with
    type-only imports written `import type` across the simulation boundary.
  - Serializable simulation components.
  - One Rapier build for every peer (the compat build, until a game needs the deterministic one).
- **Performance cost of the constraints:** none in the hot paths. The action layer and transport
  interface are one indirection per frame or message.

## 8. CLAUDE.md strategy

The root `.claude/CLAUDE.md` is 340 dense lines, loaded into every session. Adding the coding
standards, the structure and the SBP strategy to it would make every session pay for all of it.

- **The root file becomes the map and the rules:** the three-layer structure and its lint, the
  coding standards (§3, §5), the SBP strategy (§4), the main flow (bootstrap, frame stages, scene
  load), commands and workflow. Short, and always loaded.
- **Subsystem detail moves into nested `CLAUDE.md` files** next to the code they describe (the sky
  box section into the sky box folder, the LOD sections into the LOD folder, …), which Claude Code
  loads when it works in that folder. Nothing is lost, and a session pays only for what it touches.
- p605 writes the standards and the split; p621 makes the final pass after the moves.

## 9. Integration with existing plans and prompts

- **`p990_follow-ups-from-done-plans.md`:** "The line core ships in production" and "Every SVG
  icon's raw string is in the main chunk" move into p607 and are deleted from p990 (its own rule).
  "Remove the deprecated `RayCastOpts` aliases" belongs to the engine major; p614 does it.
- **`p200_component-query-caching.md`:** its recommendation (cache the main-camera tag lookup) is
  implemented in p612.
- **`p420_npc-simulation-tiers.md`:** its NPC data entity and tiers fit p603's actor, controller
  and brain model; p603 rewrote its tiers in those terms, and it's blocked by p610 (the contracts in
  code) and softly by p603's stubs p421 (kinematic controller) and p424 (AI brains, navmesh).
- **`p500_restore-physics-snapshot.md`:** stays its own plan; p604 lists it as the prerequisite for
  prediction and rollback.
- **`p302_material-and-texture-system-refactor.md`:** stays in the terrain epic; p613 leaves
  whatever p302 rewrites and only moves it.
- **`p240_client-device-capability-sniffer.md`:** already SBP-shaped (its benchmark is downloaded
  only when it runs).
- **Prompts in `docs/templates/todo-plan-prompts.txt` that have no plan yet:**
  - p800 "Debugger UI overhaul": its own epic, after p608 (the moved debug structure) and aligned
    with p617 (the UI kit apps can use).
  - p450 "Toolkit and asset housekeeping": its toolkit folder structure is absorbed by p609; its
    new PBR textures, models and LOD test scene stay in p450.
  - p070 "Refactor dynamic character code": its sensor bug fixes and new options come after p610,
    on the restructured controller.
  - p770 "Key binding refactoring": aligned with p610's action layer (one key binding model).
- **In-flight work:** `p299` (in progress) is merged before p608's move, which touches nearly
  every file.

## 10. Roadmap

| Stage | Plan                                                      | What                                                                                                                   | Blocked by              |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| A     | \_DONE_p601_refactoring-safety-net-tests-and-baselines.md | Vitest, the scene runner (snapshots, console errors, determinism hashes), bundle / API / coverage baselines            | —                       |
| A     | \_DONE_p602_architecture-and-target-structure.md          | The decisions: folder map, public entry, feature-module contract, debug placement, naming, boundaries                  | —                       |
| A     | \_DONE_p603_gameplay-architecture-contracts.md            | Actors, controllers, intents, brains, animation, world systems; the stub plans                                         | p602                    |
| A     | \_DONE_p604_multiplayer-viability-study.md                | The verdict, the constraints (measured; the two-client spike dropped)                                                  | p602                    |
| A     | \_DONE_p605_coding-standards-and-documentation-tooling.md | Coding standards, JSDoc style, eslint-plugin-jsdoc + TypeDoc validation as a ratchet, the CLAUDE.md split              | p602                    |
| B     | p606_layering-inversion-and-public-entry.md               | The engine stops importing the app; declaration-merged component types; the `aekasha` entry; boundary lint             | p601, p602              |
| B     | p607_sbp-foundation-feature-modules.md                    | No side-effect registrations, `sideEffects`, lazy Rapier, `__AEK_DEBUG__`, lazy maps and loaders, the feature manifest | p606                    |
| B     | p608_engine-folder-restructure.md                         | The folder map applied with a codemod; utils, UI and debug moved; demo code out of the engine                          | p606, p607, p299 merged |
| B     | p609_toolkit-and-app-restructure.md                       | Toolkit categories (p450's structure), app scenes in folders, deprecated re-exports removed                            | p608                    |
| B     | p610_character-and-input-action-architecture.md           | The input action layer, the controller contract, `createDynamicCharacter` split, intents                               | p603, p608              |
| B     | p611_sbp-tooling-profiles-and-marketing.md                | `yarn sbp`, budgets, the banner profile and example, the lite-renderer study, marketing                                | p607, p608              |
| C     | p612_review-ecs-loop-config-init.md                       | ECS, main loop, config, `InitEngine`, views (+ p200's cache)                                                           | p608                    |
| C     | p613_review-rendering-scene-assets.md                     | Renderer, scenes and loader, geometry / material / texture, assets, import, PostFX, viewports, snapshots               | p608                    |
| C     | p614_review-physics.md                                    | PhysicsAPI split, EngineRapier, worker, tiers, raycast (+ the `RayCastOpts` removal)                                   | p608, p610              |
| C     | p615_review-sky-box.md                                    | The sky box                                                                                                            | p608                    |
| C     | p616_review-lod-spatial-instancing-lines.md               | LOD, impostors, spatial index, instancing, lines                                                                       | p608                    |
| C     | p617_review-input-ui-hud.md                               | Input devices, the UI kit (usable by apps), HUD, icons                                                                 | p608, p610              |
| C     | p618_review-debug-public-api.md                           | The debug entry points and their docs, debug structure (no panel polish: p800)                                         | p608                    |
| C     | p619_review-schemas-pipeline-devtools-hub.md              | Schemas, the data pipeline, the asset pipeline, devTools, the Hub generator                                            | p608                    |
| C     | p620_review-toolkit-and-app-code.md                       | Toolkit and app code                                                                                                   | p609                    |
| D     | p621_hub-docs-readme-and-claude-md-final.md               | Architecture, SBP and migration pages, readme, CLAUDE.md final, the epic closed                                        | Stage C                 |

**Order:** p601 and p602 first (in either order), then p603-p605. Stage B is one engine major and
must land in order (p606 → p607 → p608, then p609-p611). Stage C plans are independent of each
other once their blockers land, and can run in parallel branches.

## 11. Versioning

- **Stage A** is tooling and documents: `CHANGELOG.md` Project entries, no part bumped. The
  exception is `_DONE_p605`: its lint rules changed engine, toolkit and app source (`import type`,
  the stats clock, JSDoc), so each got a patch bump.
- **Stage B** is breaking for engine and toolkit: one engine major and one toolkit major, with new
  codenames from the sun's and the moon's sequences, chosen when the major merges. The app gets
  the bump its migration needs. The import codemod and the Hub migration guide ship with the
  major; no long-lived re-export shims.
  - The majors land with p606 and p607 together (p606 D5), on the `stage-b` integration branch
    below; p608-p611 are then minor or patch bumps (from p606 on, consumers import entries, so
    the moves are internal).
- **Stage C** plans are patch or minor bumps per part (documentation and internal refactors are
  patches; a new public API is a minor).

### Branches and PRs

Every PR into `main` runs `yarn checkVersions --against main` and bumps what it changed (one bump
per merge).

| Plans | Branch | Merges into | PR |
| --- | --- | --- | --- |
| Stage A (p601-p605) | each its own; the document plans p602 and p603 shared one | `main` | one per branch (all merged) |
| p606 | `layering-invasion-and-public-entry` | `stage-b` (cut from `main` when p606 is done) | into `stage-b` after p606's last phase: reviewed alone, its versions and changelog entry already in |
| p607 | its own, from `stage-b` | `stage-b` | into `stage-b` after p607's last phase; it adds to p606's changelog entry |
| `stage-b` | — | `main` | right after p607's PR merges: the engine and toolkit majors (codenames chosen then) and the app minor |
| p608, then p609; p610 and p611 after p608 | each its own, from `main` | `main` | one per plan when its last phase is done; p608 opens with no other branch open (its codemod reruns on a fresh `main`) |
| Stage C (p612-p620) | each its own, from `main` | `main` | one per plan; they can run in parallel once their blockers land |
| Stage D (p621) | its own | `main` | closes the epic |

## 12. Risks and open questions

1. **Scope.** About 104k lines and 21 plans: months of work. Stage C is split by area so each plan
   is a reviewable PR, and the epic is useful at every stage boundary, not only at the end.
2. **Regressions without tests.** There is no test suite today, and a refactor of this size will
   break things that nobody checks by hand. p601 lands first, and no Stage B or C plan starts
   without its runner.
3. **The SBP floor** (§4.4): 635 kB gzip for any WebGPU page. The marketing must state the real
   numbers, not promise kilobytes.
4. **Branch conflicts.** p608 touches nearly every import; it runs when no other branch is open,
   with a codemod so it can be re-run on a fresh `main` instead of merged by hand.
5. **Over-abstraction.** A gameplay contract is generalized only when a second real
   implementation is named (eg. the kinematic controller next to the dynamic one). p603 records
   which contracts are firm and which wait for their second user.
6. **The deterministic Rapier build:** measured by p604 at 0-9 % slower and +12 kB gzip, with
   results that differ from compat's. No plan depends on it: the engine stays on the compat build
   until a lockstep or rollback game needs it (p604 §4.9).
7. **Tooling churn.** eslint-plugin-jsdoc and TypeDoc's validation are new dependencies of the
   lint and the Hub build; the ratchet (p605) must not block unrelated work while coverage climbs.
8. **Open:** whether the engine should become a real package (a workspace, publishable to npm) or
   stay a folder behind a path alias. p602 decides; the alias is the default.
