Status: implemented
Category: Bug, Refactor
Related: p101_physics-scene-load-determinism.md (the physics determinism item, split out because it is a multi-phase engine change)

# Small Bug Fixes and Tweaks — Plan

A batch of small, independent fixes: clear all lint problems, fix the crash when the debugger scene loader is used for the start scene, fix two asset-registry leaks carried over from the removed p054 GPU memory plan, remove the `hasFeatureAsync()` deprecation warning by upgrading stats-gl, and make debug edit windows behave on scene switches and in prodTest mode. The physics determinism investigation is summarized here (§5) but planned in `p101`. The small bugs found while planning are fixed in §8. Every section below is its own phase and can be reviewed and committed separately, in any order.

---

## 1. Lint errors and warnings (Phase 1)

Baseline (`yarn lint`, 2026-09-27): **21 problems (6 errors, 15 warnings)**.

| File | Problem | Fix |
| --- | --- | --- |
| `devTools/gatherAppData.ts:259, 295, 331, 368, 447, 483, 521, 547` | unused `e` in `catch (e)` | optional catch binding: `catch {` |
| `src/_engine/utils/LocalAndSessionStorage.ts:39, 49` | unused `e` in `catch (e)` | `catch {` |
| `src/_engine/core/Physics/EngineRapier.ts:182` | unused `err` in `catch (err)` | keep the cause: `throw new Error('Failed to initialize Rapier physics.', { cause: err })` (the `lib` target must allow `ErrorOptions`, otherwise use `catch {`) |
| `src/_engine/utils/CMP.ts:286, 319, 420` | `no-unused-expressions` (`a ? b() : c()`, `x && y()` used as statements) | rewrite as `if/else` / `if` |
| `src/_engine/types/three-node-material-helpers.d.ts:69, 73, 77` | `no-empty-object-type` (`interface Vec2Node extends Node<THREE.Vector2> {}` etc.) | turn them into type aliases: `type Vec2Node = Node<THREE.Vector2>`. Nothing imports them (`src/_engine/core/Lines/LinePulse.ts:48` declares its own `FloatNode`). |
| `src/_engine/types/three-node-material-helpers.d.ts:17` | unused `T` in `interface Node<T = any>` | the type parameter is intentional (phantom type), so use a targeted `// eslint-disable-next-line @typescript-eslint/no-unused-vars` |
| `src/app/oneMoreScene.ts:2`, `src/app/scene01.ts:242`, `src/app/scene01_v2.ts:276` | `no-console` | replace with `llog` (`src/_engine/utils/Logger.ts:39`) |

Done when `yarn lint` reports 0 problems and `tsc` passes.

---

## 2. Crash: "Use debugger scene loader for start scene" + reload (Phase 2)

### 2.1 Root cause (confirmed in code)

1. On the first scene load, `loadScene` reads the debug tools state (`SceneLoader.ts:386-389`). With "Use debug start scene" and "Use debugger scene loader for start scene" both checked, it sets `targetLoaderId = DEBUGGER_SCENE_LOADER_ID` (`SceneLoader.ts:405-407`).
2. The loader lookup then fails and throws `Could not find scene loader with loader id "__debugger-scene-loader"` (`SceneLoader.ts:443-450`).
3. That loader is only created lazily, inside `initDrawerState()` (`src/_engine/core/Debug/_dbg__DebuggerGUI.ts:39-44`). The first thing that reaches `initDrawerState()` is `setCurrentScene` → `updateDebuggerSceneTitle` (`SceneLoader.ts:537`, `Scene.ts:286`), which runs *after* the lookup. `registerDebuggerGUI()` (`src/_engine/debug/DebuggerGUI.ts:22-24`) only imports the module.
4. The throw happens before the loader's `.then/.catch` chain, so it escapes `loadScene` and `appStartFn`, gets re-thrown at `InitApp.ts:159`, and goes unhandled at `src/index.ts:7`. The main loop never starts, so the page stays blank.

This is a regression from commit `63391f7` ("Make DebuggerGUI and DebuggerSceneLoader dynamic"). Before it, `InitApp.ts` created the debugger scene loader eagerly.

### 2.2 Fix

- `_dbg__DebuggerGUI.ts`: move the loader creation out of `initDrawerState()` into an exported, idempotent `_ensureDebuggerSceneLoader()` that reuses the `debugSceneLoaderCreated` guard. `initDrawerState()` calls it too, so nothing else changes.
- `debug/DebuggerGUI.ts` `registerDebuggerGUI()`: after the import, call `_ensureDebuggerSceneLoader()` when `isDebugEnvironment()`. This runs at `InitApp.ts:102`, before `appStartFn`.
- Hardening in `loadScene` (`SceneLoader.ts:443-450`): when the missing loader is `DEBUGGER_SCENE_LOADER_ID`, `lwarn` and fall back to `getCurrentSceneLoader()` instead of throwing. A stale debug setting should never be able to kill boot.
- The broken `isDebugEnvironment` guard in the same file is fixed in §8.1.

### 2.3 Verify

- Debug mode, pick a debug start scene, check both options, reload: the start scene loads through the debugger scene loader with no console error.
- Uncheck "Use debugger scene loader": the start scene loads through the main loader as before.

---

## 3. Asset-registry carry-overs from the removed p054 plan (Phase 3)

### 3.1 `largeWorld` leaks unregistered geometries

`src/app/largeWorld.ts` passes geometries that were never registered to `createMeshEntity`, so they are never disposed. One More Scene ends up with 5 more geometries after a `largeWorld` visit:

- `:39-56`: the terrain from `generateTerrain(...)` (`src/toolkit/geometry/generateTerrain.ts:57`), appId `largeWorldTerrain`.
- `:331`: `crateStackGeo = mergeGeometries([crateBaseGeo, crateTopGeo])`, appId `largeWorldDynamicCrateStack`.
- `:378`: `barbellGeo = mergeGeometries([...])`, appId `largeWorldDynamicBarbell`.

Fix:
- Register all three with `saveBufferGeometry(geo, { id: 'largeWorldTerrainGeo' })` (and `largeWorldCrateStackGeo` / `largeWorldBarbellGeo`), from `src/_engine/core/Geometry.ts:290`, before `createMeshEntity`.
- Dispose the intermediate clones (`crateTopGeo`, `barbellSphereGeoA`, `barbellSphereGeoB`) with `.dispose()` after merging. `.clone()` copies `userData.id` from the registered source, so `deleteGeometry(source.userData.id)` never reaches the clones.

Verify:
- The geometry count shown in One More Scene is the same before and after a `largeWorld` visit.
- The `[MeshManager] ... uses an unregistered geometry` warning (`src/_engine/core/MeshManager.ts:65`) no longer appears for these meshes.

### 3.2 `sceneTestECS` revisit reuses disposed geometry/material objects

`createNextSceneObject3Ds` (`src/_engine/core/SceneLoader.ts:346-365`) resolves the mesh's `geo`/`mat` string ids and then writes the resolved objects back over the ids in the **cached** generated scene data (`props.props.geo = geo`, `props.props.mat = mat`). On the next visit, `typeof props.props.geo === 'string'` is false, so the previous visit's disposed, unregistered objects are reused. That triggers the unregistered-geometry warning for `testMesh` and `testImportedMesh`.

Fix:
- Resolve into a local copy, `createMeshEntity({ ...props.props, geo, mat }, props.entityOpts)`, and never mutate the generated scene data.
- Check `createCameras` and the light loop in the same file for the same write-back pattern.

Verify: visit `sceneTestECS`, switch away, and come back. There is no unregistered-geometry/material warning, and the meshes render.

---

## 4. `hasFeatureAsync()` deprecation warning: upgrade stats-gl (Phase 4)

### 4.1 Where it comes from

- The warning is not from engine code: `src/` has no `hasFeatureAsync` call. It comes from **stats-gl 3.6.0**, `handleWebGPURenderer` (`node_modules/stats-gl/dist/main.js:143`): `await renderer.hasFeatureAsync("timestamp-query")`.
- three 0.186.1 deprecated that call in r181 (`three/src/renderers/common/Renderer.js:3008-3014`).
- It only fires with **Track GPU** or **Track CPT** on (both default `false`).
- Our renderer already does `await renderer.init()` (`src/_engine/core/Renderer.ts:78`), long before `stats.init()` runs (`_dbg__Stats.ts:120`, reached from `initMainLoop`).

**stats-gl 4.2.3** (latest) fixes it upstream with `if (!renderer._initialized) await renderer.init(); if (renderer.hasFeature('timestamp-query')) ...`.

### 4.2 Upgrade and adapt `src/_engine/core/Debug/_dbg__Stats.ts`

v4 is a major version. The internal fields this file reaches into (`fpsPanel`, `msPanel`, `gpuPanel`, `gpuPanelCompute`, `vsyncPanel`, `dom`, `addPanel`, `Stats.Panel`) still exist, but these behaviors changed:

- **FPS and CPU panels are only created when `trackFPS` is on** (v3 always created them). `_initStats` spreads our saved config, including `trackFPS`, into the constructor. So with FPS off, CPU would silently disappear too. Fix: always pass `trackFPS: true` to the constructor and keep the existing detach-if-off logic (`_dbg__Stats.ts:99-100`).
- **GPU/CPT panels are built in the constructor**, not after `init()` has checked `timestamp-query`. Update the comments near `PANEL_ORDER` (`:37-41`) and `:115-118`. Keep the `applyPanelOrder()` call after `init()`. Check what shows when `timestamp-query` is unsupported. If v4 leaves dead GPU/CPT panels, detach them after `init()` when `renderer.hasFeature('timestamp-query')` is false.
- **Native WebGPU timestamp path** (`webgpuNative`, its own `resolveTimestampsAsync`): check whether `_updateRestOfStats` still needs to call `renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE/RENDER)` itself (`:197-198`), or whether that now resolves twice. Drop our calls if stats-gl owns resolving.
- A new `WRK` panel (worker-reported CPU) exists. It isn't used here, but make sure it doesn't appear.
- Check the v4 `.d.ts` for renamed or removed constructor options (`StatsOptions` in `src/_engine/debug/Stats.ts`).

Fallback if v4 misbehaves: stay on 3.6.0 and, right before `stats.init(...)`, shadow the deprecated method on the renderer instance (`hasFeatureAsync = async (n) => renderer.hasFeature(n)`) with a comment pointing at this plan.

### 4.3 Verify

- Track GPU + CPT on: no deprecation warning, and GPU/CPT panels show values.
- FPS / CPU / Hz / TFPS / PHY toggles, horizontal/vertical layout and the `PANEL_ORDER` top-to-bottom order behave exactly as before.

---

## 5. Physics determinism (Gym scene): see `p101`

Verified: the reported case (Gym → other scene → Gym puts a Suzanne somewhere else) is real, and it is structural, not a fluke. The main causes, ranked:

1. **Physics keeps stepping while a scene is being built.** `setIsLoadingScene(true)` is never read by `stepPhysics`. The first gym load fetches assets, while the revisit hits the cache, so bodies join the simulation at different step offsets.
2. **The Rapier world is reused across scenes.** It is created once and only has its bodies removed, so handle reuse, broadphase and island history change the solver order.
3. **Without SAB (MESSAGE_BATCH), a new body can read a deleted body's stale pose from a reused buffer slot.** This moves the gym's stairs/wall, which Suzanne lands on.
4. **Worker-only ordering races.** Body and colliders are created in separate messages, and deletes aren't awaited.

Interpolation is visual-only, so it isn't a direct cause. The characters are nondeterministic by design (wall clock + `Math.random`). The probe, the verification matrix (main thread / worker ± SAB / interpolation modes) and the fixes are all in **`p101_physics-scene-load-determinism.md`**.

---

## 6. Edit windows carried over on scene switch (Phase 5)

### 6.1 Current state

- Windows live in `draggableWindows` (`src/_engine/core/UI/DraggableWindow.ts:93`) and persist to LS key `AEK_popupWindows`. The only link to their target is the free-form `data` object.
- A scene-change hook already exists: `handleDraggableWindowsOnSceneChangeStart()` (`DraggableWindow.ts:984-991`, called at `SceneLoader.ts:500`). It closes windows flagged `closeOnSceneChange` and removes those flagged `removeOnSceneChange`. The Camera, Light, ECS world, Physics entity and Character tracker windows are flagged.
- Why windows still carry over:
  - **The Assets info window** (`_dbg__Assets.ts:185-195`) and **the two test windows** (`_dbg__DebugTools.ts:657-681`) have no scene-change flag.
  - **Stored LS flags override the props passed in code** (`DraggableWindow.ts:241-252`: `foundWindow?.closeOnSceneChange !== undefined ? foundWindow.closeOnSceneChange : prop`). A window that was persisted before a flag was added (or with a different value) keeps the stale value.
- How each window finds its target:
  - Camera: `getEntityIdByAppId(d.id)` (`_dbg__CameraGUI.ts:189-194`); survives a scene switch.
  - Light: `getEntityIdByAppId(d.id)` (`_dbg__LightGUI.ts:399-405`); survives a scene switch.
  - ECS world: `ECSWorld.getWorld(d.id)` (`_dbg__ECS.ts:64-73`).
  - Assets: registry id (`_dbg__Assets.ts:616-631`).
  - Physics entity: the raw index+generation `entityId` (`_dbg__PhysicsAPI.ts:359-370, 453-468`); never survives a scene switch.

**Step 0:** reproduce in the browser first (run-aekasha-js skill), with each window type open, to confirm which windows carry over.

### 6.2 Design: close on scene switch, unless the same target exists in the next scene

- **Target resolvers.** Add `registerDraggableWindowSceneTargetResolver(id, (data) => boolean)` to `DraggableWindow.ts`. It's a module-level map, not persisted, because functions can't go into LS. It's registered next to each window's content function.
- **Scene change start** (`handleDraggableWindowsOnSceneChangeStart`): for windows flagged `closeOnSceneChange`:
  - with a resolver: **suspend** the window (hide its DOM, keep `isOpen`, mark it as pending);
  - without a resolver: close it, as today.

  Hiding rather than keeping the window live means no content refresh runs against entities that are being torn down.
- **Scene change end**: new `handleDraggableWindowsOnSceneChangeEnd()`, called in `loadScene` right after `runOnAllSceneEnters()` (`SceneLoader.ts:554`), so entities created by scene code exist too. For each suspended window:
  - resolver returns true: `updateDraggableWindow(id)` (rebuild the content for the new entity, unhide);
  - resolver returns false: `closeDraggableWindow(id)`.

  The load-error path closes every suspended window.
- **Resolvers per window:**
  - Camera / Light: the `appId` resolves to a living entity (reuse the lookups above).
  - ECS world: `ECSWorld.getWorld(d.id)` exists.
  - Assets info: the id is still in the texture/geometry registry. Also add `closeOnSceneChange: true` to this window.
  - Physics entity: add `appId` to the window `data` when the entity has one. Resolver and content look up by `appId` first, falling back to `entityId`. No `appId` means no resolver, so the window closes.
  - Character windows: unchanged (`removeOnSceneChange`, existing `@TODO` at `_dbg__Character.ts:310`, out of scope).
  - Test windows: add `closeOnSceneChange: true`, no resolver.
- **Props win over stale LS flags.** For the behavioral flags (`closeOnSceneChange`, `removeOnSceneChange`, `removeOnClose`, `isDebugWindow`, and the new `showInProdTest` from §7), a prop passed explicitly takes precedence. The LS value is only used when the prop is `undefined`, e.g. restoring via `openDraggableWindow({ id })`. Position, size, collapsed state etc. keep their LS-first behavior.
- **Restore on reload.** `loadDraggableWindowStatesFromLS()` (`DraggableWindow.ts:993-1024`) runs the same resolver check, so a reload into a scene without the target closes the window instead of showing "Camera not found".
- The scene-exit hook bug next to the enter hooks is fixed in §8.2.

### 6.3 Verify

- Open a Camera window for `mainCamera` (present in several scenes) and a Light window for a scene-specific light, then switch scenes. The Camera window stays open and shows the new scene's `mainCamera`, and the Light window closes.
- Assets info, ECS world and Physics entity windows follow their resolver.
- Reloading keeps the same behavior.

---

## 7. Edit windows showing up empty in prodTest (Phase 6)

### 7.1 Current state

- The play button in the top on-screen tools **reloads the page** with `?isProdTest=true` (and without `isDebug`), see `_dbg__OnScreenTools.ts:61-74`. `IS_DEBUG_ENV`/`IS_PROD_TEST_MODE` are module-load constants (`src/_engine/core/Config.ts`), so nothing toggles at runtime.
- `loadDraggableWindowStatesFromLS()` runs with no environment check (`InitApp.ts:158`) and reopens every window saved as open.
- The modules that provide the content (Camera/Light via `loadDebugModule`, ECS/PhysicsAPI/Assets via `loadDebugModuleAsync` without `includeInProdTestMode`) never load in prodTest. So `createWindowCMP` builds the frame with an empty content wrapper (`DraggableWindow.ts:590-600`).
- `isDebugWindow` is persisted, but today it only affects z-index. No per-window prodTest option exists.

### 7.2 Design

- Add `showInProdTest?: boolean` (default `false`) to the `DraggableWindow` type and to `openDraggableWindow`'s props. Persist it like the other flags.
- Add a single predicate in `DraggableWindow.ts`:
  ```ts
  const isDraggableWindowAllowed = (state) =>
    !state.isDebugWindow || IS_DEBUG_ENV || (Boolean(state.showInProdTest) && IS_PROD_TEST_MODE);
  ```
  Non-debug (app) windows are always allowed. Debug windows are allowed in debug mode, and in prodTest only when they opt in.
- Apply it in three places:
  - `loadDraggableWindowStatesFromLS()`: skip disallowed windows **without** touching `isOpen`, so they come back when you return to debug mode (stop button).
  - `openDraggableWindow()`: early return for disallowed windows.
  - Content resolution in `createWindowCMP`: the content only resolves when the window is allowed. This is the automatic gating: the property decides whether the content is gated by the debug env or by debug-or-prodTest.
- Document the contract in the `showInProdTest` JSDoc: a window that sets it must have its content module loaded in prodTest too, i.e. via `loadDebugModuleAsync(importer, true)` / `useDebug(ref, true)` (`src/_engine/utils/helpers.ts:500-537`), the same mechanism DebuggerGUI/OnScreenTools/DebugTools/Character/MainLoop already use.
- No existing window opts in for now. The most likely candidates later are the character windows (their module is already prodTest-loaded).
- `myFirstDialogTest` (`_dbg__DebugTools.ts:676`) has `isDebugWindow` commented out, so it would count as an app window and still show (empty) in prodTest. Find out why it's commented out (likely z-index vs. its backdrop). Then either re-enable it, or fix the z-index issue first so it can be re-enabled.

### 7.3 Verify

- Open Camera, Light and ECS windows in debug mode, press play: prodTest shows no windows.
- Press stop: back in debug mode, the same windows are restored where they were.
- A temporary test window with `showInProdTest: true` and a prodTest-loaded content module shows up **with** content in prodTest.

---

## 8. Side bugs found while planning (Phase 7)

Two small bugs turned up while tracing §2 and §6. Neither causes a visible problem today, but both are one-line fixes that would bite the first caller that relies on them.

### 8.1 `_disableDebugger` guard never fires

- `src/_engine/core/Debug/_dbg__DebuggerGUI.ts:327` has `if (!isDebugEnvironment) return;`. That tests the function reference, which is always truthy, so the guard never returns.
- It is harmless today: the thin wrapper `disableDebugger` (`src/_engine/debug/DebuggerGUI.ts:108`) uses `useDebug(debugGUI)` without `includeInProdTestMode`, so `_disableDebugger` is never reached outside `IS_DEBUG_ENV`. The module itself is loaded in prodTest too (`DebuggerGUI.ts:23`, `true`), so any future direct caller would get past the guard.
- Fix: `if (!isDebugEnvironment()) return;`.
- Verify: the debugger drawer is still disabled during scene loads (`SceneLoader.ts:481`) and re-enabled afterwards (`SceneLoader.ts:558`) in `?isDebug=true`.

### 8.2 `registerOnAllSceneExits` registers into the scene-enter map

- `src/_engine/core/Scene.ts:687`:
  ```ts
  export const registerOnAllSceneExits = (id: string, fn: () => void) => (onAllSceneEnters[id] = fn);
  ```
  This is a copy-paste bug. The hook is stored in `onAllSceneEnters` (`:68`) instead of `onAllSceneExits` (`:67`), so `runOnAllSceneExits()` (`:698-700`) never runs it, and `runOnAllSceneEnters()` (`:690-692`) runs it on every scene *enter* instead.
- Nothing calls `registerOnAllSceneExits` today, so there's no visible effect yet.
- Fix: write into `onAllSceneExits[id]`.
- Verify: temporarily register an exit hook that logs with `llog`. It fires once when leaving a scene (`SceneLoader.ts:503`), and never on enter.

---

## 9. Risks and notes

- **§4, stats-gl major upgrade.** `_dbg__Stats.ts` deliberately depends on stats-gl internals (see its comment at `:25-28`). The fallback shim in §4.2 keeps this phase low-risk.
- **§6, suspend/restore.** The one subtle part is timing. `updateDraggableWindow` must only run after the new scene's entities exist (hence after `runOnAllSceneEnters`), and suspended windows must not refresh while the old scene is torn down.
- **§6, props-over-LS precedence** is a behavior change for every window. Only the listed behavioral flags change; layout state stays LS-first.
- **Versioning at merge:** engine (and therefore project `version`) patch bump. App patch bump for the `src/app/` changes (§1 logging, §3.1 `largeWorld`).

## 10. Verification (whole plan)

- `yarn lint` (0 problems) and `tsc` pass after every phase. The Stop hook enforces this.
- Run each phase's browser checks above via the run-aekasha-js skill in `?isDebug=true` and `?isProdTest=true`. The console must be free of errors, the `hasFeatureAsync` deprecation and `[MeshManager] ... unregistered ...` warnings.

## 11. Implementation notes (where the code differed from this plan)

- **§1:** the baseline was 22 problems, not 21 (a 9th unused `catch (e)` in `gatherAppData.ts`). The `lib` target is ES2021, so `EngineRapier.ts` puts the original error's message into the thrown one instead of using `{ cause }`.
- **§2:** `registerDebuggerGUI()` uses the file's `useDebug(debugGUI)?._ensureDebuggerSceneLoader()` idiom instead of importing `isDebugEnvironment()`.
- **§3.1:** `largeWorld` leaked 5 geometries, not 3: the tree and bush geometries (passed to `createInstancedMeshPool`, so never flagged by the `[MeshManager]` warning) are registered too. In debug mode One More Scene still counts 3 more GPU geometries after the first `largeWorld` visit: the shared debug symbol templates, uploaded once and stable over repeated visits (not a leak).
- **§4:** stats-gl 4.2.3 reads a three.js `WebGPURenderer`'s timestamps but never resolves them, so `_updateRestOfStats` keeps its `resolveTimestampsAsync` calls. `yarn add` needs Node ≥ 22.13 (`engines.node` raised accordingly).
- **§6:** the PostFX pass window (not listed above) got a resolver too. Suspending tears the window's content down (not just hides it), so panes and intervals stop. Also fixed: Assets/Physics windows reopening empty after a reload (the restore never passed their registered content), and a stale LS `title` winning over the passed one. The Physics window stores the entity's stable (fixed) `appId`.
- **§7:** the gate lives only in `openDraggableWindow` (every path that builds content goes through it), and the scene change start handler also skips disallowed windows, so a scene switch in prodTest can't close and persist them as closed. The test dialog's `isDebugWindow` was re-enabled; no z-index fix was needed.
- **§8.1:** the same uncalled-function guard existed in `ECS.ts` `addComponent`; `DEBUG_DATA` is now only stored in debug and prodTest mode.
- **§8.2:** already fixed before this plan was implemented (commit `c9e4e93`); PostFX's exit hook depends on it.
