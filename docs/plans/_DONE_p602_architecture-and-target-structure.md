Status: implemented (Phases 1-3)
Category: Architecture, Refactoring
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage A)
Blocks: p603_gameplay-architecture-contracts.md, p604_multiplayer-viability-study.md, p605_coding-standards-and-documentation-tooling.md, p606_layering-inversion-and-public-entry.md, p608_engine-folder-restructure.md

# Architecture and Target Structure

The decisions Stage B builds on: where every file goes, what the public API looks like, how a
feature is installed, where debug code lives, how files are named and how the boundaries are
enforced. Each decision below has a recommendation; this plan's Phase 1 is confirming them (or
choosing otherwise), Phase 2 turns them into a move map that p608's codemod applies.

The facts behind the decisions are in p600 §2 (layering, folders, bundle, docs).

---

## 1. Goal

- A layout where **the folder tells you what a file is**: kernel (every app has it), feature
  (opt-in, costs nothing unused), UI, debug, utilities. The SBP (p600 §4) follows from it.
- **One way to do each thing:** one way to reach debug code, one way to install a feature, one
  public import path per feature.
- **Room to grow:** characters, vehicles, NPCs, world systems and networking (p603, p604) each
  have a place before they're written.

## 2. Decisions

Each was **Recommended** until Phase 1 confirmed it; the "As decided" list under each is what
Stage B builds on (confirmed 2026-10-09).

### D1. The engine stays a folder behind path aliases

- `aekasha` → `src/_engine/index.ts`, `aekasha/<feature>` → the feature entries and
  `aekasha/toolkit/*` → the toolkit. TS `paths` plus Vite `resolve.alias` (the first aliases the repo has; CLAUDE.md
  says there are none today).
- **Not a workspace package yet.** A package (npm workspaces, publishable) would enforce the
  boundary physically, but the repo is a template people copy and modify, and the alias gives the
  same import paths. If the engine is ever published, the aliases become the package name with no
  import changes.
- Folder names `_engine`, `toolkit`, `app` stay: the Hub's API URLs (`documentation/engine/…`),
  CLAUDE.md, the readme and every plan use them.

**As decided:**

- Confirmed, with one root for both: `aekasha`, `aekasha/<feature>`, `aekasha/toolkit/<category>`
  (not `aekasha-toolkit/*`). If the engine is ever published, the package is renamed from
  `aekasha-js` to `aekasha`, so the import paths still don't change.
- `aekasha/toolkit/*` is listed before `aekasha/*` wherever the aliases are matched in order.
- p606 sets the aliases everywhere code is resolved: `tsconfig.json`'s `paths` (which TypeDoc
  and `tsx` read), Vite's `resolve.alias` (the workers' builds too), and `vitest.config.ts`
  (standalone: it doesn't read `vite.config.ts`).

### D2. A kernel and opt-in features

```
src/_engine/
  index.ts                 # the kernel's public API: InitEngine, ECS, scene, camera, mesh, …
  kernel/                  # what every app runs
    ecs/                   # ECS.ts, registry, core components and systems, culling systems
    loop/                  # MainLoop, the stages, the step clock
    config/                # Config, the env flags, the debug define
    init/                  # InitEngine
    scene/                 # Scene, SceneLoader, Group
    assets/                # Assets, Geometry, Material, Texture, TextureArray, TextureAtlas, Import/, the assets worker
    render/                # Renderer, Snapshot, Views (ViewManager), the three helpers
    camera/  light/  mesh/ # the ECS managers, without the "Manager" suffix
    input/                 # devices, then p610's action layer
  features/                # opt-in, one folder each, each with index.ts as its entry
    physics/               # facade, manager, tiers, tier policy, raycast, backends/rapier/, worker/
    character/
    skybox/
    lod/                   # selection, chains, auto, fades, impostors/
    spatial/
    instancing/
    lines/
    postfx/
    viewports/
  ui/                      # the UI kit apps can use (D5)
  debug/                   # the debugger framework (D4)
  schemas/
  utils/                   # pure helpers only (D6)
```

- **Kernel vs feature** is decided by "does a minimal banner need it" (p611's profile): a
  renderer, a scene, a camera, a mesh, the loop and the ECS do; physics, sky box, LOD, lines,
  PostFX and viewports don't.
- **A feature folder is self-contained:** its public entry (`index.ts`), its implementation, its
  ECS registrations, its worker if it has one, its debug modules (D4) and its nested `CLAUDE.md`
  (p605). Deleting the folder and its entry in the app removes the feature.
- Big modules are split along the way (p614 splits `PhysicsAPI.ts` into world, rigid body,
  collider, query and joint modules under `features/physics/`), but p608 only moves.

**As decided:**

- Confirmed, with the spatial index as a feature that **owns light object culling**:
  `core/ECS/LightObjectCullingSystem.ts` moves into `features/spatial/`. Without `spatial()`,
  lights aren't culled by distance and the `spatialIndex` entity flag does nothing.
- `core/Raycast.ts` (with `RayDebugTypes.ts`) casts three's `Raycaster` against `Object3D`s and
  isn't physics: it goes to `kernel/render/`. The physics ray casts are `PhysicsAPI`'s `castRay*`
  and stay in `features/physics/`; p600's roadmap row for p614 ("raycast") means those.
- Workers go with their feature: `workers/assetsWorker.ts` and `workers/assets/` to
  `kernel/assets/worker/`, `workers/physicsWorker.ts` and `workers/physics/` to
  `features/physics/worker/`.
- What the sketch above leaves out (Phase 2 places each in the move map): `styles/` goes to `ui/`
  (`debugger.scss` to `debug/`); `types/` stays at the engine root; `3dModels/`'s Blender sources
  go next to the code that uses their output (the 3D symbols to `debug/`, `characterObstacles.blend`
  to the app); `core/PropertyLoader.ts` merges the debug overrides into camera and light props, so
  it's a candidate for `debug/`.
- **Kernel code imports features in more places than §4's risk 2 lists** (checked 2026-10-09,
  runtime imports only):
  - `core/MainLoop.ts` → physics (`stepPhysics`), PostFX, viewports;
  - `core/Snapshot.ts` → PostFX;
  - `core/Scene.ts`, `core/SceneLoader.ts`, `core/Assets/SceneAssetRelease.ts` → sky box, physics,
    characters, lines, spatial;
  - `core/Import/` → physics (`MeshColliderGeometry.ts`, `SpawnImported.ts`) and LOD
    (`LodChainGLTF`, `LodChainRequests`);
  - the assets worker → LOD (`LodSimplify`, `LodChainGLTF`);
  - `core/ECS.ts`, `core/ECS/ECSCoreComponents.ts`, `core/Config.ts` → `Physics/PhysicsAPITypes`;
  - `InitApp.ts` → every feature (D8's install list replaces it).

  Each becomes a seam the feature fills from `install`: a fixed-step hook in the loop, a render
  pipeline hook (PostFX, viewports, snapshots), scene enter / exit hooks, import extensions, the
  assets worker's job kinds, and the physics config and component types moved into the feature
  (declaration merging, p600 §3.1). p606 designs them.

### D3. The public entry points

- `src/_engine/index.ts` (kernel) and `src/_engine/features/<name>/index.ts` (one per feature)
  re-export the public API. Nothing else is imported from outside the engine.
- Barrels only at entry points. With `sideEffects` set (p607), Rollup drops what isn't used from a
  barrel, so a barrel costs nothing.
- Everything not re-exported is `@internal` (p605's JSDoc rule), and TypeDoc's entry points become
  the entry files, so the Hub's API reference shows the public API per entry instead of per
  source file (p619 adapts the renderer).

### D4. Debug code: the framework central, feature debug colocated

- `debug/` holds the debugger itself: the drawer, the tab host, the pane builder, undo / redo,
  the profiler window, the on-screen tools, the editor views and the dev files client.
- Each feature's debug modules move next to it: `features/skybox/debug/_dbg__SkyBox.ts`,
  `kernel/camera/debug/_dbg__CameraGUI.ts`. The feature's public module reaches them through the
  one loader (`loadDebugModuleAsync`, behind `__AEK_DEBUG__`, p607), not through a second
  `debug/*.ts` wrapper. The 15 wrappers in `debug/` become the framework's own API or move to
  their feature.
- **Why colocated:** the feature and its tooling change together, a feature removed takes its
  debug code with it, and the drawer's tabs don't need to know every feature. The alternative,
  one central `debug/` tree mirroring the features, is today's layout with its two access paths.
- Debug-only code outside debug folders moves in: `DefaultDebugKeyBindings.ts`, `3DSymbols/`,
  `PercentagePieHtml.ts`.
- p800 (the debugger UI overhaul) replaces Tweakpane inside this structure later.

**As decided:**

- Confirmed: colocated. `utils/UI/PercentagePieHtml.ts` is the debug-only module in `utils/UI/`.

### D5. A UI kit apps use

- `ui/` gathers `utils/CMP.ts`, `core/HUD.ts`, `core/UI/*` (DraggableWindow, DialogWindow,
  DropDown, Toaster), the icons and the global styles, with a public entry (`aekasha/ui`).
- **Icons become a registry:** `registerIcon(name, svg)` plus one module per built-in icon, so an
  app adds its own icons, the engine's can be imported one by one, and none are bundled unused
  (p990's item, p607).
- The debugger is the kit's first consumer, not its owner. p800's components (buttons, tables,
  graphs, …) are added here.

**As decided:**

- Confirmed. The global styles are `styles/` (see D2's As decided).

### D6. `utils/` is pure

- `utils/` keeps only code with no three, DOM or ECS dependency: `Logger`, `assert`, `deepMerge`,
  `PromiseResolver`, `constants`, `LocalAndSessionStorage` (the one exception: storage), and a
  seeded RNG (p604; `toolkit/geometry/seededRandom.ts` moves here when the engine needs it).
- Where the rest goes:
  - `helpers.ts` is split: disposal and file helpers to `kernel/assets`, the scratch vectors and
    `smoothDampVec3` to `kernel/render` (three maths), `initWorker` to `kernel/loop`, the debug
    loaders to `debug/`, the light helpers to `kernel/light`. `core/Helpers.ts` (axes and grid)
    goes to `debug/`.
  - `ECSHelpers.ts` → `kernel/ecs`; `object3DHelpers.ts` → `kernel/render`;
    `stats/IntervalCounterStats.ts` → `debug/`; `Window.ts` → `ui/`.
  - `world/movingPlatform.ts` and `cameras/followObjectCameraRig.ts` → the toolkit (they're
    ready-made gameplay pieces, registered by the app).
  - `ECSStressTest.ts`, `PhysicsStressTest.ts`, `world/characterTestObjects.ts`,
    `world/characterTestObstacles.ts` → the app (only app scenes use them).
  - `materials/*Pattern.ts` (no importers) are deleted; `commontTypes.ts` merges into its one user.

**As decided:**

- Confirmed (both claims checked: the pattern files have no importers, and `commontTypes.ts`'s one
  user is `followObjectCameraRig.ts`). `utils/jsIdentifier.ts` is pure and stays.
- Found by Phase 2's move map:
  - `utils/constants.ts` isn't pure (three's shadow map types and direction vectors): it's split
    per export like `helpers.ts`, the three objects to `kernel/render/ThreeMath.ts`.
  - `utils/stats/IntervalCounterStats.ts` stays in `utils/` (not `debug/`): it's pure, and the
    ray and physics stats count with it at runtime.
  - `utils/ECSStressTest.ts` goes to `kernel/ecs/debug/` (not the app): the ECS debug tab's
    benchmark uses it.
  - `utils/PromiseResolver.ts` imports `core/Config.ts` (`isDebugEnvironment`): p606 removes it.

### D7. Naming

- **Files:** PascalCase for every module in the engine and the toolkit (`SkyTime.ts`,
  `Presets.ts`), `index.ts` for entries, `_dbg__` + PascalCase for debug modules, `*.test.ts` next
  to the module. Asset JSONs keep their `<id>.<type>.json` names. The schemas follow the same rule
  (`SkyBoxSchema.ts`).
- **No `Manager` suffix:** the folder names the feature (`kernel/camera/Camera.ts`), and the
  module's verbs (p600 §3.6) say what it does.
- **No same-name-different-case files** (`helpers.ts` / `Helpers.ts`).
- The app: one folder per scene (`src/app/scenes/<sceneId>/` with its `.scene.json`, `.ts` and
  `_dbg__` module), the shared asset JSONs in their type folders as today.

**As decided:**

- Confirmed, with one rule and one exception: every module in the engine and the toolkit is
  PascalCase, except **a file named after an asset id**, which keeps the id (`asteroid.tsl.ts`
  next to `asteroid.material.json`).
- The renames, all in p608's codemod (none before it): about 50 engine modules (the 19 schemas,
  the sky box's layers and `presets.ts` / `legacySkyBox.ts`, the worker modules, the camelCase
  utils) and the toolkit's geometry modules and `triplanarProjection.ts`. The rule replaces p600
  §3.6's "camelCase for data and helpers".

### D8. Installing a feature

- **Explicit:** `InitEngine({ config, features: [physics(), skyBox(), lod()], start })`. A
  feature is `{ id, install(ctx), …}`: its systems, component hooks, boot work (the physics
  worker, its world) and its debug module are registered by `install`, in the order given.
- **Why explicit:** features with boot work (physics, the assets worker) need an order and a
  config anyway; one rule for all is simpler than "some register on import, some on first call".
  Not listing a feature leaves it out of the bundle (the import is the only reference).
- **Checked against the data:** the gatherer's feature manifest (p607) knows what the scenes'
  JSON uses, so a scene with a sky box and no `skyBox()` feature fails the gather with a clear
  error, not a blank sky at runtime.
- Toolkit modules and app plugins (today's `AppECSPlugins.ts`) use the same shape, so a
  third-party module (vehicles, networking) is one more entry in the list.

**As decided:**

- Confirmed: the explicit list is the only way, with no preset such as `defaultFeatures()` (a preset
  would hide what the bundle holds). The template app's `src/index.ts` lists every feature, so a
  copied template works, and deleting a line removes that feature.

### D9. Generated code moves out of the engine

- `generatedAppData.json` and `generatedAppFns.ts` are app data: they move to `src/generated/`
  (still committed, still written by `gatherAppData`) and reach the engine
  through `InitEngine({ data })` (p606), so the engine imports no app path.

**As decided:**

- Confirmed. Today's importers of the generated files: `core/Scene.ts`, `core/SceneLoader.ts`,
  `core/Material.ts`, `core/PostFX.ts`, the material editor, and the devTools (`gatherAppData.ts`,
  `verify/baselines.ts`, `checkVersions.ts`).

### D10. Boundaries are lint rules

- `import/no-restricted-paths` zones: the engine imports neither the toolkit, the app nor the
  `src/*.ts` root files; the toolkit doesn't import the app.
- `no-restricted-imports` patterns: outside the engine, only `aekasha` / `aekasha/*` (no deep
  paths); `_dbg__` modules only through a dynamic `import()` (a small custom rule if the pattern
  can't tell static from dynamic).
- The rules land in p606 as errors for the engine and as warnings for the app until p608's
  codemod has migrated it.

**As decided:**

- Confirmed. `eslint-plugin-import` 2.32.0 is a devDependency but `eslint.config.js` doesn't load
  it yet; p606 adds it.

## 3. Phases

### Phase 1: confirm the decisions — done

Walk D1-D10 with the user, record each as confirmed or changed (with the reason) in an
"As decided" list under each, and update p600 §3 where a decision changes a shared principle.

### Phase 2: the move map — done

1. `devTools/refactor/moveMap.json`: every file under `src/_engine/`, `src/toolkit/` and the app
   files that move, with its target path. Generated by a script from the current tree and the
   decided rules, then edited by hand where a rule doesn't fit.
2. The import graph checked against the target layout: no kernel file importing a feature, no
   cycle between features (a cycle means one belongs in the kernel or they share a contract).
3. The list of public exports per entry point (from p601's `api.json`), so p606 can write the
   entries.

**As built:**

- `devTools/refactor/` (run `npx tsx devTools/refactor/moveMap.ts`, `--check` to verify the
  outputs are current):
  - `moveRules.ts` holds the decisions as rules (longest `from` wins, a folder rule applies D7's
    PascalCase), and the exceptions as file rules with their reason. **The map is never edited by
    hand:** p608 changes a rule and regenerates the map on a fresh `main`, and a new file without a
    rule fails the run.
  - `importGraph.ts` reads imports, re-exports, dynamic `import()`s and exports from the TypeScript
    AST, so a name imported through a facade resolves to its declaring module, and an import of
    names that are all types counts as type-only with or without `type`.
  - `moveMap.ts` writes the three outputs below. It fails on an unmapped file, two files with one
    target (also by case), a target onto a file that stays, a module name that isn't PascalCase,
    and a split file's export without a target.
- `moveMap.json`: 460 files (432 moves, 21 kept, 5 deleted, 1 merge, 1 split). By plan: p608
  389, p609 69 (the toolkit categories and the app's scene folders), p606 2 (the generated data).
  Each entry has `to`, `action`, `plan` and an optional `note`, and a split has a target per
  export (`utils/helpers.ts`, `utils/constants.ts`).
- `layoutReport.md` (item 2): **no cycles between features** (character → physics, instancing →
  lod and spatial, lod → spatial). 101 imports the target layout doesn't allow:
  - kernel → feature: 50 imports in 19 files (29 runtime, 18 type-only, 3 dynamic), the seams D2
    lists;
  - engine → app root files: 32 files, nearly all `AppECSRegistry.ts` (the stages), and the toolkit
    → `AppECSRegistry.ts` in 6 (p600 §3.1: the engine owns its stages);
  - engine → generated data: 5 (D9);
  - `schemas/` → features: 4 (`impostorSchema.ts` → `ImpostorFormat`, `lodSchema.ts` → `LodTypes`,
    `skyBoxSchema.ts` → the presets and the legacy conversion), and `_helperSchemas.ts` → the ECS
    registry (a type). p606 either moves the code they need under `schemas/` or moves a feature's
    schema into its feature;
  - `ui/` → kernel: `DraggableWindow.ts` reads `Config.ts` and `MainLoop.ts`'s `addResizer`
    (p606 / p617: the UI kit gets its own resize listener and its config handed in);
  - `utils/` → kernel: `PromiseResolver.ts` (D6's As decided).

  No static `_dbg__` import outside debug code. The report also lists the imports the codemod
  rewrites for split, merged and deleted files, and the docs, Hub pages, configs and devTools
  files that name a moving path (CLAUDE.md has 56 mentions).
- `entryExports.json` (item 3): the 2,024 exports in `api.json` that aren't re-exports, under the
  entry each lands in, each with who imports it today: `public` (the app, the toolkit, a Hub `api:`
  link or the devTools; 339), `crossEntry` (only engine code of another entry; 336), `internal`
  (only its own entry; 820, the `@internal` candidates) or `unreferenced` (529; part of it is API
  the example app doesn't use). It's evidence for p606, not the decision.
- Entry points: kernel and `utils/` → `aekasha`, each feature → `aekasha/<feature>`, `ui/` →
  `aekasha/ui`, `debug/` → `aekasha/debug`, `schemas/` → `aekasha/schemas`, the toolkit →
  `aekasha/toolkit/<category>`. p606 confirms or changes `aekasha/schemas` and where `utils/`
  belongs.
- Names the map chose: `InitApp.ts` → `kernel/init/InitEngine.ts`, `ViewManager.ts` →
  `kernel/render/Views.ts`, `PhysicsManager.ts` → `features/physics/PhysicsEntity.ts`,
  `LineManager.ts` → `features/lines/Lines.ts`, `GroupManager.ts` → `kernel/scene/Group.ts`,
  `ENGINES.ts` → `backends/Engines.ts`, `DebugToolsManager.ts` → `debug/DebugTools.ts`, the
  `debug/` framework's subfolders `profiler/`, `gpuMemory/`, `editors/` and `symbols/`. The
  toolkit's `generateX.ts` become `geometry/generate/X.ts`. An app scene folder is named by the
  scene id (`thirdPersonGym.scene.json`, id `thirdPersonGymScene` → `scenes/thirdPersonGymScene/`),
  so the codemod rewrites each moved JSON's `sceneFile`.

### Phase 3: mark done — done

`CHANGELOG.md`: nothing (documents only). Mark the plan done; p606 and p608 cite its decisions.

**As built:**

- `CHANGELOG.md` has a Project entry after all (no part bumped, p600 §11): Phase 2 added tooling
  (`devTools/refactor/`), not only documents.
- The plans it blocked (p603, p604, p605, p606) lost their `Blocked by` line; p605's and p606's
  stubs can now be expanded against the decisions above.

## 4. Risks and open questions

1. **Hub API URLs change** when TypeDoc's entry points become the entry files (D3): the API pages
   are regenerated, and `api:` links that named a module path (`api:PhysicsAPI.createRigidBody`)
   are fixed in the same change. `yarn hub:build` lists every broken one.
2. **Feature boundaries that aren't clean:** some kernel code calls into features today (the
   scene loader resets the physics world, clears the sky box and releases spatial domains; the
   loop steps physics and renders PostFX and the viewports; the importer builds physics colliders
   and registers LOD chains; full list in D2's As decided). These become seams in the install
   contract (scene enter / exit hooks, a fixed-step hook, a render pipeline hook, import
   extensions); p606 designs them.
3. **Plain PascalCase everywhere** renames 19 schema files and the sky box's camelCase modules:
   more churn in p608, for one rule without exceptions.
