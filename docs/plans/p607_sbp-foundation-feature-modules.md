Status: stub — not-implemented
Category: Build, Performance, Architecture
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage B, engine major)
Blocked by: p606_layering-inversion-and-public-entry.md
Blocks: p608_engine-folder-restructure.md, p611_sbp-tooling-profiles-and-marketing.md
Related: p990_follow-ups-from-done-plans.md (the two bundle items moved here), p240_client-device-capability-sniffer.md

# SBP Foundation: Feature Modules — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Make the engine tree-shakeable by construction (p600 §4.1) and install features explicitly
(p602 D8), so an app's bundle holds only what it uses. Today the main chunk is 1.77 MB gzip with
every subsystem in it (p600 §2.4).

## Scope

- **Rapier out of the main chunk:** `Physics/EngineRapier.ts:1` imports Rapier as a value and
  `Physics/ENGINES.ts:3` imports EngineRapier statically, which cancels the dynamic import at
  `ENGINES.ts:23`. Load the backend only through `import()`: ~829 kB gzip (47%) off the main chunk
  in `WORKER_THREAD` mode, a lazy chunk in `MAIN_THREAD` mode, nothing without physics.
- **The install contract:** `InitEngine({ features: [...] })` (p602 D8) with `install(ctx)` and the
  scene hooks the kernel calls today directly (physics world reset, sky box clear, spatial domain
  release in `SceneLoader.ts`).
- **No module-level registrations:** `ECSCoreSystems.ts`, the two culling systems, `MeshManager.ts`,
  `GroupManager.ts`, `SkyBox/SkyBox.ts:722`, `Lod/LodSystem.ts`, `Spatial/SpatialIndexSystem.ts`,
  `Character.ts`, `Raycast.ts` and `src/AppECSPlugins.ts` register from their feature's `install`.
- **`sideEffects`** in `package.json`, listing only the stylesheets.
- **`__AEK_DEBUG__`:** a compile-time define, `false` in `VITE_APP_ENV=production` builds, so the
  `debug/*` wrappers, `DefaultDebugKeyBindings`, debug branches in the managers, the Toaster and
  `3DSymbols` fold away; `true` in development and test builds (`?isDebug`, `?isProdTest` unchanged).
- **From p990:** the line core registered on first `createLines`, with `LineManager` hooking scene
  teardown itself (`SceneLoader.ts:50` imports `disposeNonPersistentLines` today); the icon registry
  (p602 D5), one module per icon instead of 49 `?raw` imports in `SvgIcon.ts`.
- **Lazy data maps:** `generatedAppFns.ts`'s TSL material and PostFX maps as `import()`s, so the
  TSL materials and GTAONode load with the scene that uses them.
- **Loaders and barrels:** no `three/examples/jsm/Addons.js` imports (`Texture.ts:3`,
  `Import/MeshColliderGeometry.ts:2`); GLTF, Draco, KTX2 and HDR loaders imported where used.
- **The feature manifest** (p600 §4.2): `gatherAppData` emits what the shipped scenes' data uses;
  a scene that needs an uninstalled feature fails the gather.

## Inputs

- p600 §2.4, §4; p602 D2, D5, D8; p990's line core and SVG icon items (moved here from its former "Bundle size and rendering" section).

## Done when

- The main chunk holds no Rapier in `WORKER_THREAD` mode; the app's main chunk diff in
  `bundle.json` is recorded in the changelog.
- No top-level `registerPlugin` / `registerComponentHooks` / `addSystem` outside `install` (a lint
  rule or a check script).
- A production build contains no debug wrapper code (`grep` the output for their names).
- p601's runner passes in all three physics targets.
