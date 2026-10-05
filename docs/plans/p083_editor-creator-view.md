Status: in progress | Phases 1-3 implemented
Category: Editor-Creator View
Blocks: p084_material-editor-stage-and-selector.md, p085_material-editor-params-and-persistence.md
Related (all implemented; their plan files have been removed, see `.claude/CLAUDE.md` and the code): p080 viewports (`core/Viewports.ts`; the axes gizmo must follow the editor camera), p060/p062 debugger undo (`core/Debug/_dbg__UndoRedo.ts`; undo buckets per view), p105 `createDebuggerTab` (the editor drawers reuse its declarative tabs), p110-p115 layered sky box (later editors: skybox), p130 on-screen tools disabler (`DebugToolsState.onScreenTools`; the view tools group joins its disabled set)

# Editor-Creator View — Epic and View Switching Core

Today the debug mode has one view: the running game/app with its debugger. This epic names it the **Runtime** view, the editor's main view, and adds **editor/creator views** next to it. An editor view replaces what the canvas shows (its own scene, camera, lights and environment) while the loaded scene stays in memory, frozen and hidden. Switching back to Runtime resumes the scene exactly where it was. The view buttons ("Runtime", "Material editor", …) sit in a new group in the top on-screen row, each with its own icon (DD6).

The first editor is the **material editor**. It starts as a viewer with a few editable parameters. Later editors (skybox, animation, particles, …) plug into the same view system. A later "save" plan will write editor results back to the asset JSON, which makes the editors useful for prototyping and, later, as the base of a production configurator.

This file is the epic. It also holds the first implementation plan: the **view switching core**. The material editor itself is in p084 and p085.

## Sub-plans

| Plan                                             | Scope                                                                                                                                                                                                                                                     | Blocked by | Engine bump |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| `p083_editor-creator-view.md` (this file)        | View registry, scene suspension in the main loop, view tools group with the Runtime view's button and icon, HUD rules per view, undo buckets per view, gizmo camera rig, a reusable editor camera with its pose per view, active view restored on refresh | —          | minor       |
| `p084_material-editor-stage-and-selector.md`     | Material editor view: stage (ball, lights, environment), editor camera with per-material memory, bottom material selector with filter, right drawer shell                                                                                                 | p083       | minor       |
| `p085_material-editor-params-and-persistence.md` | Basic editable params (Params tab), editor settings (Settings tab), per-material LS + clear, undo/redo, full state restored on refresh                                                                                                                    | p084       | minor       |

All three can land on one branch (one engine minor bump at merge) or on separate branches (a minor bump each).

**Future plans (not written yet):** material preview thumbnails in the selector, deeper material params (textures, TSL graph inputs by type, all three.js material types), saving editor results to JSON, skybox editor (p111 has landed), animation editor, particle editor, views in production builds (configurator).

**Particle editor physics (to work out in its plan).** Still open: where the particle simulation runs. One option is a TSL/GPU compute simulation with simple collisions (shapes, the depth buffer), which scales to many particles and needs no physics engine. The other is physics-engine bodies on the main thread or in the physics worker, which fits a few hundred rigid pieces like debris. If it uses the engine, the editor gets a private world of its own and doesn't use the Physics API, which holds one world in module state (`PhysicsAPI.ts`, `Physics/EngineRapier.ts`). It steps that world from the view's `update(delta)` with a fixed-timestep accumulator, while the Runtime scene's world stays suspended. The particle system would then talk to a small backend interface: the Physics API in the Runtime view, the private world in the editor. A private world on the main thread loads Rapier's WASM there on first use, since the default `WORKER_THREAD` target loads it only in the worker.

## Naming

- **View**: what the whole canvas shows and what the main loop ticks. There is always exactly one active view.
- **Runtime view** (button label "Runtime", id `runtime`): the built-in view, today's behaviour: the loaded scene running with the game/app debugger (drawer, switch tools, draggable windows). It is the editor's main view: the app boots into it and every editor view returns to it.
- **Editor view**: any other view (the material editor first). Editor views are registered by modules.
- **Viewport** (p080): an extra rectangle composited _over_ the active view's frame. The axes gizmo is a viewport. Views and viewports are independent: viewports render over any view.
- **Suspended scene**: the loaded scene while an editor view is active. It is not rendered and none of its per-frame work runs.

## Context (grounded in code)

- **Everything per-frame goes through `MainLoop.ts`.**
  - `mainLoopForDebug` (`MainLoop.ts:195-243`): `world.updateMainLoop` and `runSceneMainLoopers` for every frame; then, only while `loopState.appPlay`, `stepPhysicsAndPollHeldKeys`, `world.updateAppLoop`, `runSceneAppLoopers`, `countRayCastFrames`; then `renderScene()`, `world.updateLateMainLoop`, `runSceneMainLateLoopers`.
  - `renderScene()` (`:173-191`) renders `getRootScene()` with `getActiveCamera()`, through the PostFX pipeline when there is one, then `renderViewports(renderer, delta)`.
  - So skipping those calls freezes the scene. There is no other central tick: app code that uses `setTimeout`, DOM events or audio is not covered (see Risks).
- **Physics pause.** `stepPhysics(loopState)` (`PhysicsAPI.ts:284-308`) treats `!loopState.masterPlay || !loopState.appPlay` as an explicit pause: it stops the timer and resumes without catching up. `notePhysicsAppPause()` (`MainLoop.ts:147`) exists so the pause is noticed while the app loop is paused.
- **Elapsed time.** `advanceElapsedTime()` (`:159-170`) stops `getElapsedTime()` during a master pause and discards the first delta after it.
- **ECS stages that run even with the app loop paused** (`MAIN`, `LATE_MAIN`) hold scene work that must not run while the scene is hidden: `hoverSystem` (`Input/MouseInput.ts:263`), `object3DSyncSystem`, `lineTimeSystem`, `entityLifetimeSystem`, plus debug systems (`debugCameraSystem`, `axesGizmoSystem`, helper sync systems).
- **The scene debug camera's OrbitControls listen on the canvas** (`Debug/Camera/_dbg__DebugCamera.ts:55-86`) and apply rotate/pan/dolly synchronously in their own pointer handlers. `debugCameraSystem` re-sets `controls.enabled` every frame, but it won't run while the world is frozen, so the controls must be disabled explicitly.
- **The axes gizmo is tied to the scene debug camera.**
  - `updateGizmo()` follows `getActiveCamera()` (`_dbg__AxesGizmo.ts:284-304`).
  - Align/drag use the ECS debug camera entity and its `ORBIT_CONTROLS` (`getDebugCamera()`, `:309-316`) and `setDebugCameraControlsSuspended` (`:469,482`).
  - Visibility and clickability are decided in `axesGizmoSystem`, an ECS `MAIN` system of the default world (`:126-152`) that checks `isDebugCameraActive()`.
- **On-screen tools** (`core/Debug/_dbg__OnScreenTools.ts`): three groups rebuilt from scratch on every update: `playTools` (prod-test play/stop, master loop, app pause; top centre), `switchTools` (debug cam, camera, scene, helpers; bottom centre), `undoRedoTools` (top left). `ToolTypes` is `'SWITCH' | 'PLAY' | 'UNDO'` (`debug/OnScreenTools.ts:3`). The top-centre group shifts left with the `debugDrawerOpen` body class (`OnScreenTools.module.scss:54-66`); so does the top-right viewport stack (`aekViewportStack_TOP_RIGHT`, p080).
- **Debug drawer** (`core/Debug/_dbg__DebuggerGUI.ts`): a module singleton on the right, `$drawerWidth: 40rem`. `_toggleDrawer` sets/clears `debugDrawerOpen` on `<body>` (`:368-395`). Bound to `h` (`Input/DefaultDebugKeyBindings.ts:27-32`).
- **Undo buckets** (`core/Debug/_dbg__UndoRedo.ts:57-84`): `perScene` actions go into the current scene's bucket (`getCurrentSceneId()`), `global` ones into `_global`; undo works on the current scene's bucket merged with the global one.
- **Inputs.** `setAllInputsEnabled(false)` (`Input/InputState.ts`) gates app keyboard, mouse and touch handlers (`KeyboardInput.ts:180,201,267`, `MouseInput.ts:113,222`, `TouchInput.ts:91`). `SceneLoader.loadScene` uses it during loads.
- **Boot** (`InitApp.ts`): debug modules register, then `appStartFn()` loads the first scene, then `initMainLoop()` renders the first frame and, in debug, `initDebugTools()`.
- **Icons**: `getSvgIcon` keys (`core/UI/icons/SvgIcon.ts`), imported as raw SVG files from `core/UI/icons/svg/`: 16×16 viewBox, `fill="currentColor"`, mostly solid shapes. The scene dropdown uses `easel` and the play group `infinity`, `pause`, `playFill` (prod test play) and `stop`. There is no view or material icon yet.

## Design decisions

1. **An engine-core view registry, used only by debug views for now.**
   - New `src/_engine/core/ViewManager.ts`. It lives in core (not `_dbg__`) because a future production configurator needs it, but no view is registered in production, so the cost there is one `activeView === null` check.
   - API:
     - `RUNTIME_VIEW_ID = 'runtime'`
     - `registerView(def: ViewDef)`, `unregisterView(id)`
     - `setActiveView(id)`, `getActiveViewId()`, `getActiveView()`, `isRuntimeViewActive()`
     - `isViewPlaying()`, `toggleViewPlay(value?)` (see DD5)
     - `addViewChangeListener(fn)`, returning its remover
   - The Runtime view is built in, not a `ViewDef`: `ViewManager` holds its button data (`title: 'Runtime'`, `icon: 'runtime'`), and `getActiveView()` returns `null` while it is active.
   - `ViewDef` (editor views):
     - `id`, `title` (the button's tooltip and switch toast, eg. "Material editor"), `icon: SvgIconKey`, `orderNr?` (position in the view tools group; the Runtime view is always first)
     - `scene: THREE.Scene`, the view's own private scene (never added to the root scene)
     - `getCamera(): THREE.Camera | null`
     - `getCameraRig?(): ViewCameraRig | null` (DD7)
     - `onEnter?(): void | Promise<void>`, `onExit?(): void`
     - `mainUpdate?(delta)`: every frame the master loop runs (camera controls, UI)
     - `update?(delta)`: only while the view is playing (DD5), eg. auto-rotate
     - `toggleDrawer?()`: what `h` does in this view
   - `setActiveView` is serialised: a switch that is still running its `onEnter` makes the next call wait. Switching to the active view is a no-op.
2. **Scene suspension happens in the main loop, not in the scene.**
   - While an editor view is active, `mainLoopForDebug` skips, for the scene:
     - every world's `updateMainLoop`, `updateAppLoop`, `updateLateMainLoop` (and so `updatePhysicsStep`)
     - `runSceneMainLoopers`, `runSceneAppLoopers`, `runSceneMainLateLoopers`
     - `countRayCastFrames` and held-key polling
   - Instead it runs `view.mainUpdate(delta)`, `view.update(delta)` when the view is playing, and the view frame listeners (DD7).
   - It renders `renderer.render(view.scene, view.getCamera())`, **without** the scene's PostFX pipeline (it is built for the root scene and its camera), then `renderViewports(renderer, delta)` as before. Stats keep working.
   - **Physics** sees the suspension as an explicit pause: `LoopState` gets `isSceneSuspended`, and `stepPhysics` adds it to its pause check. `notePhysicsAppPause()` runs every suspended frame, so resuming never catches up on the hidden time. This works the same in both worker targets, because nothing is stepped.
   - **Elapsed time** (`getElapsedTime`) stands still while the scene is suspended, like during a master pause, and the first delta after resuming is discarded. Scene code that reads it resumes without a jump.
   - The production loops are not changed in this plan. Views in production are a future plan.
3. **Entering and leaving an editor view** (done by `ViewManager`, in this order).
   - Enter:
     1. Set `loopState.isSceneSuspended = true` (through a `MainLoop` setter).
     2. `setAllInputsEnabled(false)`, so app keyboard/mouse/touch handlers ignore input (debug key bindings still run).
     3. Disable the scene debug camera's OrbitControls right away (a new `setSceneDebugCameraInputEnabled(false)` in `_dbg__DebugCamera.ts` that sets the flag and `controls.enabled = false`).
     4. Body classes: `aekEditorView` and `aekView_<id>`. Remove `debugDrawerOpen` (the scene drawer's own `isOpen` state is kept).
     5. `await view.onEnter()`.
     6. `updateOnScreenTools()` and persist the active view id (DD9).
   - Leave: the reverse. `view.onExit()`, remove the body classes, restore `debugDrawerOpen` from `getDrawerState().isOpen`, re-enable the debug camera input, `setAllInputsEnabled(true)` (unless a scene load is running, which re-enables it itself), clear the suspension, update the on-screen tools.
   - Switching between two editor views is `onExit` of one and `onEnter` of the other; the scene stays suspended.
4. **HUD rules per view** (a body class plus one SCSS rule, like p130's disabled on-screen tools).
   - `body.aekEditorView #hudRoot > :not(.aekKeepInViews) { display: none }`. That hides the scene debug drawer, the bottom switch tools, draggable windows, the debugger scene loader and any app HUD, without touching their state.
   - Kept (global class `aekKeepInViews`): the top on-screen row (DD6), the undo/redo group, the stats container, the debug toaster, the viewports layer if it is inside the HUD root, and every editor view's own UI.
   - `display: none` keeps the hidden CMPs mounted, so returning to the scene shows them as they were.
5. **Play and pause per view.**
   - The **master loop** button stays global (`toggleMainPlay`): it stops everything in every view.
   - The **pause** button acts on the active view: in the Runtime view it is `toggleAppPlay` (unchanged); in an editor view it toggles that view's own play flag (`toggleViewPlay`), which gates `view.update`.
   - So pausing the editor's animation never changes the scene's `appPlay`, and the suspended scene is frozen whatever its `appPlay` is.
   - The view play flags are persisted with the active view (DD9).
6. **The view tools group** (on-screen tools, `IS_DEBUG_ENV` only, never in prod test mode).
   - A new `ToolTypes` member `'VIEW'` and a `viewTools()` builder in `_dbg__OnScreenTools.ts`: one icon button per view, in order: **Runtime** first, then the registered editor views (the material editor's **Material editor** button, p084).
     - Each button shows only its icon (`getSvgIcon(icon)`, the same size as the play group's icons), like every other on-screen tool. Its name is the `title` and `aria-label` ("Runtime", "Material editor"), and the active view's button has the usual `active` state.
     - A switch shows a debug toast with the view's icon and title (`addDebugToast`, like F1 does for the debug camera), so the name is visible once without a hover.
   - It sits in its own group **left of the play group**. Both go into a new fixed, centred flex row (`onScreenTopRow`, global class `aekKeepInViews`) that takes over the play group's current positioning and its `debugDrawerOpen` shift. In prod test mode the row only holds the play group, so it looks as it does today.
   - With only the Runtime view (no editor view registered), the group is not shown.
   - Per view: in an editor view the play group hides the "Play in production test mode" button (master loop and pause stay), and `switchTools` is not built (it is also hidden by DD4). The undo/redo group is unchanged.
   - `setActiveView` calls `updateOnScreenTools()`; `registerView`/`unregisterView` call `updateOnScreenTools('VIEW')`.
   - **View icons.** A view icon is drawn for the 16×16 set (`fill="currentColor"`, solid shapes with ~1.1-1.3 strokes, no ids, masks or gradients, since the same SVG is inlined many times), and it must not look like a play group icon (no play triangle: `playFill` is the prod-test button right next to the group). The editor icons show their subject on its own (the material editor's is a shaded sphere, p084 DD1), so later editors (skybox, animation, particles) get one recognisable glyph each.
   - **The Runtime icon** (`runtime`, `icons/svg/runtime-view.svg`): a solid cube, the live 3D world, inside four viewfinder corners, "what the camera sees right now". It stands apart from the outlined `geometry` cube and from the editor subjects.
     ```svg
     <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-runtime-view" viewBox="0 0 16 16">
       <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M1.15 4.3V2.6a1.45 1.45 0 0 1 1.45-1.45h1.7m7.4 0h1.7a1.45 1.45 0 0 1 1.45 1.45v1.7m0 7.4v1.7a1.45 1.45 0 0 1-1.45 1.45h-1.7m-7.4 0H2.6a1.45 1.45 0 0 1-1.45-1.45v-1.7"/>
       <path d="M8 3.3 12.3 5.65 8 8 3.7 5.65z"/>
       <path d="M3.3 6.4 7.55 8.75v4.95L3.3 11.35z"/>
       <path d="M12.7 6.4 8.45 8.75v4.95l4.25-2.35z"/>
     </svg>
     ```
     The three cube faces are separate shapes with a ~0.8 px gap between them, which draws the edges without a stroke and stays readable at 16 px on light and dark backgrounds.
7. **Camera rig for the gizmo, and view frame listeners.**
   - `ViewCameraRig = { camera: THREE.Camera; controls: OrbitControls; setControlsSuspended(suspended: boolean): void }`.
   - The axes gizmo resolves its rig through one function: in the Runtime view, today's behaviour (the active camera; the ECS debug camera entity and `setDebugCameraControlsSuspended` when the debug camera is active); in an editor view, `view.getCameraRig()`, always treated like "debug camera active" (visible when "Show axes gizmo" is on, clickable, align and drag work).
   - The body of `axesGizmoSystem` becomes `tickAxesGizmo()`. The ECS system keeps calling it in the Runtime view. In an editor view the default world does not run, so `ViewManager` exposes `addViewFrameListener(fn)`: listeners run once per frame, only while an editor view is active, before `view.mainUpdate` (the same "before the controls update" order the gizmo has today).
   - Editor camera rigs run their own `controls.update()` in `mainUpdate` and respect `setControlsSuspended`, like `debugCameraSystem` does.
   - The env ball (p115) will use the same rig resolver.
   - **A reusable editor camera with its own state per view** (`createViewCamera`, `core/Debug/Editors/_dbg__ViewCamera.ts`). Every editor (material, particles, skybox, animation, …) needs an orbit camera that remembers its pose apart from the Runtime view's debug camera, so it is written once here instead of in each editor (p084 DD4 builds on it).
     - Opts: `viewId`, `defaultPose: { position, target, fov }`, `near`/`far`, and an optional `store: { load(key), save(key, pose), clear(key?) }`.
     - Returns `{ camera, controls, rig: ViewCameraRig, setPoseKey(key | null), getPose(), resetPose(), onEnter(), onExit(), mainUpdate() }`. A view wires the last three into its `ViewDef` and returns `rig` from `getCameraRig`.
     - Its own `PerspectiveCamera` and `OrbitControls` on the canvas, not an ECS entity (the view owns it, like a viewport owns its camera). The controls are enabled only between `onEnter` and `onExit`, and `mainUpdate` runs `controls.update()` unless the gizmo suspended them. The aspect is updated on enter and by a resizer.
     - **Pose memory, per view and per pose key.** The pose key is the editor's subject (a material id, a particle system id). `null`, the default, is the view's own pose. The pose is saved on the controls' `end` event and when the gizmo's align or drag ends (the rig's `setControlsSuspended(false)`). `setPoseKey` applies the saved pose for that key, or `defaultPose`.
     - Default store: LS `AEK_debugViewCams`, `{ [viewId]: { view?: Pose; keys?: Record<string, Pose> } }`. An editor that keeps per-subject data in its own record passes a `store` that writes there (p084: the material's record, so p085's clear button clears the pose too). `clearViewCameraPoses(viewId)` backs an editor's clear-LS button.
     - The Runtime view's debug camera and its per-scene state (`AEK_debugCams`) are never touched: the scene's debug camera stays where it was while the scene is suspended. Poses are per view, not per scene, because an editor's stage doesn't depend on the loaded scene.
     - Debug env only, like the editors. A production configurator (a future plan) would move it out of `_dbg__`.
8. **Keys and undo in editor views.**
   - `h` (`sc-toggle-debug-drawer`) calls a new `toggleActiveViewDrawer()`: the debug drawer in the Runtime view, `view.toggleDrawer()` in an editor view (a no-op if the view has none).
   - `F1` (debug camera toggle) is a no-op in an editor view. `F10` (gizmo), `F8` (profiler) and undo/redo work everywhere.
   - Undo: `getSceneBucketId()` in `_dbg__UndoRedo.ts` returns `__view:<id>` while an editor view is active. So `perScene` actions recorded in an editor land in that view's own history, undo there never touches the hidden scene, and `global` actions stay visible in every view. The history tab (scene drawer) is hidden in editor views anyway.
9. **The active view survives a refresh.**
   - LS key `AEK_debugViews`: `{ activeViewId: string; viewPlay: Record<string, boolean> }`, written on every switch and play toggle.
   - Restore: once, right after `initMainLoop()`'s first `renderScene()` in `InitApp.ts` (debug env only). The first scene has loaded by then (or keeps loading in the background, suspended: loads are promise-driven, not loop-driven). If the saved view is not registered (eg. it was removed), fall back to the Runtime view and clear the key.
   - Restoring the editor's own state (material, camera, drawers, tabs) is up to each view (p084, p085).
10. **Scene loads while an editor view is active.** The editor UI offers no way to load a scene, but app code or HMR can. `loadScene` keeps working: it loads in the background, its loader UI is hidden by DD4, and it re-enables inputs at its end, so `ViewManager` re-applies `setAllInputsEnabled(false)` from a `registerOnAllSceneEnterings` hook while an editor view is active. The new scene is suspended as soon as it exists, because suspension is a loop state, not a scene state.

## Files touched

| File                                                                                                                  | Change                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/_engine/core/ViewManager.ts` (new)                                                                               | View registry, `setActiveView` (enter/leave sequence), view play flags, frame listeners, LS persistence and restore                                |
| `src/_engine/core/MainLoop.ts`                                                                                        | `isSceneSuspended` in `LoopState` + setter; suspended branch in `mainLoopForDebug`; `advanceElapsedTime` rule; view render path in `renderScene`   |
| `src/_engine/core/PhysicsAPI.ts`                                                                                      | `stepPhysics` treats `loopState.isSceneSuspended` as a pause                                                                                       |
| `src/_engine/debug/OnScreenTools.ts`, `core/Debug/_dbg__OnScreenTools.ts`, `OnScreenTools.module.scss`                | `'VIEW'` tool type, `viewTools()` (Runtime + editor view buttons, switch toast), top row container, per-view play group and switch tools           |
| `src/_engine/core/UI/icons/SvgIcon.ts`, `icons/svg/runtime-view.svg` (new)                                            | `runtime` icon (DD6)                                                                                                                               |
| `src/_engine/styles/index.scss` (or a new `ViewManager.module.scss`)                                                  | `aekEditorView` HUD rule, `aekKeepInViews`                                                                                                         |
| `src/_engine/core/Debug/_dbg__Stats.ts`, `_dbg__UndoRedo.ts`, `_dbg__DebuggerGUI.ts`, `UI/Toaster.ts`, `Viewports.ts` | Add `aekKeepInViews` where the element must stay visible (stats, toaster, undo group, viewports layer)                                             |
| `src/_engine/core/Debug/_dbg__UndoRedo.ts`                                                                            | View-aware `getSceneBucketId()`                                                                                                                    |
| `src/_engine/core/Debug/_dbg__AxesGizmo.ts`                                                                           | Rig resolver, `tickAxesGizmo()`, frame listener in editor views                                                                                    |
| `src/_engine/core/Debug/Editors/_dbg__ViewCamera.ts` (new)                                                            | `createViewCamera` (DD7): an editor view's orbit camera, its rig, and its pose per view and pose key (`AEK_debugViewCams` or the view's own store) |
| `src/_engine/core/Debug/Camera/_dbg__DebugCamera.ts`                                                                  | `setSceneDebugCameraInputEnabled`                                                                                                                  |
| `src/_engine/core/Input/DefaultDebugKeyBindings.ts`                                                                   | `h` → `toggleActiveViewDrawer()`, `F1` guard                                                                                                       |
| `src/_engine/InitApp.ts`                                                                                              | Restore the saved view after the main loop starts (debug env)                                                                                      |
| `.claude/CLAUDE.md`                                                                                                   | A "Views" paragraph under Architecture (view vs viewport, suspension rules, how to register a view)                                                |
| `package.json`                                                                                                        | Engine minor bump at merge                                                                                                                         |

## Phases

Each phase compiles, lints and leaves the app working.

1. **ViewManager and suspension, no UI.** — done
   - `ViewManager.ts`, the `MainLoop`/`PhysicsAPI` changes, the enter/leave sequence without the on-screen tools.
   - Verify with a throwaway, uncommitted test view (a private scene with a spinning cube and its own `PerspectiveCamera`) switched from the browser console: the scene freezes and hides, physics resumes without a jump, both worker targets.
2. **HUD rules, view tools group and keys.** — done
   - Body classes and the HUD SCSS rule, `aekKeepInViews` on the kept elements, the top row container, `viewTools()` with the `runtime` icon, the switch toast, per-view play group, `h`/`F1` routing.
   - Still no committed editor view, so the group stays hidden; the test view from Phase 1 shows it (with any existing icon until p084 adds `material`).
3. **Gizmo rig, undo buckets, refresh restore.** — done
   - `ViewCameraRig`, the gizmo refactor (`tickAxesGizmo`, frame listeners), view-aware undo buckets, `AEK_debugViews` persistence and restore.
   - `createViewCamera` (DD7). Verify it with two throwaway test views: each keeps its own pose across view switches and a refresh, a pose key switch applies that key's pose or the default, and the Runtime view's debug camera pose is unchanged.
4. **Docs.** The CLAUDE.md "Views" paragraph. (The version bump happens with the epic's merge, see Sub-plans.)

## Non-goals

- The material editor itself (p084, p085).
- Views in production and prod test builds.
- Rendering the suspended scene into a thumbnail or keeping it animating behind the editor.
- Pausing work the main loop does not own: app `setTimeout`/`setInterval`, audio, DOM animations, TSL's wall-clock `time` node.
- PostFX inside editor views (a later editor setting could build its own pipeline).
- Merging the view tools and the scene dropdown into one control.

## Risks / open questions

| Risk                                                                                                      | Mitigation                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App code keeps running outside the loop (timers, audio, DOM events) while the scene is hidden             | Inputs are disabled (DD3). Everything else is documented in the CLAUDE.md paragraph: per-frame game logic belongs in ECS systems or scene loopers, which are suspended.         |
| A system in `MAIN`/`LATE_MAIN` that the editor needs stops running (the gizmo is the known one)           | Frame listeners (DD7) cover debug tools that must keep running. Grep for `ECSSystemStage.MAIN` / `LATE_MAIN` during Phase 1 and list any other one in the Implementation notes. |
| The scene debug camera's OrbitControls react to canvas input in the editor                                | Disabled explicitly on enter (DD3), because `debugCameraSystem` doesn't run to do it.                                                                                           |
| On refresh the scene still loads first, so booting into an editor view takes as long as booting the scene | Accepted: the scene is needed when switching back. A "skip the scene on boot" option can come later.                                                                            |
| `debugDrawerOpen` gets a broader meaning ("a right-side debug drawer is open") when editors use it (p084) | Deliberate: every existing offset rule (top row, viewport stack) keeps working without changes. Documented in `_dbg__DebuggerGUI.ts` and CLAUDE.md.                             |
| Physics determinism (p101): a suspension in the middle of a scene                                         | It is the same path as an app-loop pause, which already resumes cleanly. Run the determinism probe once with a view switch during the probe window and record the result.       |

## Verification

- `yarn lint` and `yarn build` pass (the Stop hook also runs them).
- `yarn dev`, `?isDebug=true`, with the Phase 1 test view:
  - Switching to the test view shows only its scene. The physics bodies, character and `Math.sin`-driven scene loopers are frozen; switching back resumes them from the same pose, with no physics catch-up burst, in both `MAIN_THREAD` and `WORKER_THREAD` targets.
  - `getElapsedTime()` doesn't advance while the view is active.
  - Canvas drags in the test view don't move the scene debug camera; app key bindings (eg. character movement) do nothing; `h` does nothing in a view without a drawer; `F1` does nothing; `F10` toggles the gizmo, which follows the view camera and can align/drag it.
  - Pause in the test view stops its animation; the scene's `appPlay` (loop tab) is unchanged. The master loop button stops everything.
  - The switch tools, debug drawer, draggable windows and app HUD are hidden and come back unchanged; stats, undo/redo and toasts stay.
  - Undo in the test view doesn't undo scene actions recorded before the switch; back in the scene they are still undoable.
  - Refresh with the test view active returns to it; unregistering it and refreshing falls back to the Runtime view.
  - With two test views on `createViewCamera`: orbiting in each and switching between them (and to Runtime and back) keeps each view's pose, also after a refresh; the scene debug camera's pose is unchanged.
  - The view tools group shows the Runtime button (`runtime` icon) first and the test view's button after it; hovering shows their titles, the active one is highlighted, and a switch shows the toast. The `runtime` icon is crisp at 16 px on the on-screen tools' background and doesn't read as a play group button.
- Production build (`yarn build`, `dist-stats/bundle-stats.html`): no view is registered and `ViewManager.ts` is present but idle; the `_dbg__` changes stay out of the main chunk.
- Use the `run-aekasha-js` skill for screenshots of the Runtime view, the test view and the view tools group in both drawer states.

## Implementation notes

### Phase 1

- **Code drift since the plan.** `MainLoop.ts`'s line numbers moved (the profiler's `frameProbe`, p344). `countRayCastFrames` no longer exists: ray stats end their frame in `rayCastFrameEndSystem` (`Raycast.ts`, `LATE_MAIN`, default world) and the physics ray stats system next to it (`PhysicsManager.ts`), so skipping `updateLateMainLoop` already covers them.
- **`MAIN` / `LATE_MAIN` systems that stop in an editor view.**
  - Scene work, which should stop: `object3DSyncSystem`, `entityLifetimeSystem`, `hoverSystem`, `lineTimeSystem`, `skyBoxSystem` (the day-night time stands still with `getElapsedTime`), `rayCastFrameEndSystem`, the physics ray stats system.
  - Debug helpers of the hidden scene, which can stop: `debugCameraSystem`, `cameraHelperSyncSystem`, `lightHelperSyncSystem`, `debugSymbolSyncSystem`, the spatial grid overlay system.
  - Debug tools that must keep running, through view frame listeners (Phase 3): `axesGizmoSystem` (known), `envBallSystem` (p115 has landed: its viewport would keep showing the root scene's environment over the view; Phase 3 decides whether it follows the view rig or hides in editor views), the profiler's `frameSamplerSystem` (draw counters, GPU frame time) and `gpuMemorySamplerSystem` (p345). The last two read `renderer.info` right after the render, which is why `addViewFrameListener` has an `'AFTER_RENDER'` phase next to the default `'BEFORE_UPDATE'`.
- **As built.**
  - `isRuntimeViewActive()` is false from the start of a switch to an editor view until the switch back has finished. Between two editor views (and during an `onEnter`) there is no active view, the scene is still suspended, and nothing is rendered, so the canvas keeps its last frame instead of flashing the scene.
  - `toggleViewPlay()` / `isViewPlaying()` in the Runtime view are `toggleAppPlay()` / `isAppPlaying()`, so the pause button (Phase 2) can call one function in every view.
  - A failed `onEnter` returns to the Runtime view, and `setActiveView` resolves `false`.
  - `renderFrameWhileMasterPaused()` (`MainLoop.ts`) renders one frame after a switch while the master loop is paused, so the canvas shows the new view.
  - The debug camera gate (`setSceneDebugCameraInputEnabled`, reached through `CameraManager.ts`) is a flag that `attachOrbitControls`, `debugCamSceneChange` and `debugCameraSystem` all respect. That way a scene loaded while an editor view is active can't re-enable the controls, whatever order the scene-enter hooks run in.
- **Verified** (`yarn dev`, `?isDebug=true`, SwiftShader WebGL2 on WSL2, a throwaway test view loaded from the console, both worker targets): in the view, `getElapsedTime()` and the physics sub-step total stand still, physics reports paused, inputs and the debug camera's OrbitControls are off; the view's pause stops its `update` and leaves the scene's `appPlay` alone. Back in the Runtime view, the first frame takes 0 sub-steps and the next ones take the same count per frame as before the switch (no catch-up burst), and the inputs and OrbitControls are back on.

### Phase 2

- **Code drift since the plan.** `setAllInputsEnabled(false)` also stops the debug key bindings (`KeyboardInput.ts`'s `dispatchKeyEvent` returns before any binding), so DD3's "debug key bindings still run" didn't hold: in Phase 1's test view, F6, F7, F8, F10 and undo/redo did nothing. The draggable windows DD4 hides include the profiler window and the debug dialogs (About, key shortcuts, clear-LS confirmations).
- **As built.**
  - Inputs: a separate flag, `setAppInputsSuspended` (`Input/InputState.ts`), not `setAllInputsEnabled`. Mouse, touch, held keys and every key binding without `isDebugKey` ignore input while it is set. `registerDefaultDebugKeyBindings` sets `isDebugKey` on the engine's debug keys and the CONFIG.ts `debugKeys`. A scene load's re-enable at its end no longer lifts the suspension, so DD10's `registerOnAllSceneEnterings` hook was dropped. Debug keys stay off during scene loads, as before.
  - `KEEP_IN_VIEWS_CLASS` (`'aekKeepInViews'`) lives in `core/HUD.ts`. It is on the top row, the undo/redo group, the stats container, the debug toaster, the viewports layer, debug dialogs (`isDebugWindow` with a backdrop, plus the backdrop) and the windows of a kind registered with `keepInViews: true` (`DraggableWindowKindOpts`, not persisted; the profiler window uses it).
  - The scene drawer: `setDrawerSuspendedByView` (`debug/DebuggerGUI.ts`). It keeps `isOpen`, pauses the open tab's refresh (the tab host's `isVisible` is false while suspended), and leaves `debugDrawerOpen` to the editor view, also when the drawer is rebuilt or toggled by code meanwhile.
  - Keys: `h` → `toggleActiveViewDrawer()` (ViewManager). F1 and F5 are no-ops in an editor view (F5 follows its hidden button). F7 is the pause button's key, so it calls `toggleViewPlay()` too, with a "View paused / playing" toast in an editor view. `o` / `p` do nothing there, since the switch tools aren't built.
  - `getViews()` returns the editor views in button order (`orderNr`, then registration order). `RUNTIME_VIEW_BUTTON` holds the Runtime button's data.
  - The `runtime` icon's viewfinder corners are filled outlines of DD6's 1.3 stroke (same shape). Every on-screen and toast icon rule sets `path { fill }`, which overrides the `fill="none"` of a stroked path.
- **Verified** (`yarn dev`, `?isDebug=true`, SwiftShader WebGL2, Phase 1's test view imported from the page): the view group appears on registration (Runtime active, then "Test view") left of the play group, and both shift with the drawer. In the test view: the drawer, switch tools and scene HUD are hidden, `debugDrawerOpen` is off, undo/redo, stats, the top row and toasts stay, the prod test play button is gone, F7 and the pause button toggle only the view's play flag (`appPlay` unchanged), F6 stops the master loop, `h` and F1 do nothing. Back in the Runtime view the drawer comes back open with `debugDrawerOpen`, the switch tools are rebuilt, and each switch shows its toast.

### Phase 3

- **Code drift since the plan.** DD7's "`mainUpdate` runs `controls.update()` unless the gizmo suspended them" doesn't match the debug camera it copies: `debugCameraSystem` keeps calling `controls.update()` during the gizmo's drag, and that call turns the camera to its target after `orbitBy` moves it. The phase also needed the profiler's `frameSamplerSystem` and `gpuMemorySamplerSystem` and the env ball (Phase 1's list), next to the gizmo.
- **As built.**
  - `ViewCameraRig` (`ViewManager.ts`) has an optional `onMoveEnd()`, called by the gizmo when an align or a drag ends. Poses are saved there, not on `setControlsSuspended(false)`: an align never suspends the controls, since a canvas drag must still be able to cancel it. The Runtime view's debug camera is a rig too, built from its ECS entity, with `setDebugCameraControlsSuspended` and the `AEK_debugCams` save as `onMoveEnd`. So the gizmo has one align and drag path for every view.
  - One rig resolver, `core/Debug/Camera/_dbg__CameraRig.ts`, used by the gizmo and the env ball: `getViewSourceCamera()` (the camera they follow), `isCameraRigActive()` (the debug camera in the Runtime view, a view with a `getCameraRig` in an editor view) and `getActiveCameraRig()`. A view without a rig counts as "main camera": the gizmo follows `getCamera()`, is shown only with "in main camera" on, and can't be clicked.
  - `tickAxesGizmo()` and `tickEnvBall()` run from their `MAIN` systems in the Runtime view and from `BEFORE_UPDATE` view frame listeners in an editor view. A view change listener cancels a gizmo align, ends a drag (saving the old rig's pose) and ticks both, so a switch while the master loop is paused renders them right.
  - Env ball: in an editor view it follows the view's camera and shows the view scene's own `environment` (with its `environmentRotation`). It is checked every frame there, since a view sets its environment without an event. It is hidden while the view scene has no environment. The root scene's sky box environment shows only in the Runtime view.
  - Profiler: the frame sampler adds an `AFTER_RENDER` view frame listener with its `LATE_MAIN` system and removes it with the system. The GPU memory sampler has one for good (`sampleGPUMemory`).
  - Undo: `perScene` actions recorded in an editor view go to `__view:<id>`. `_clearUndoRedoHistory('scene')` in a view clears that view's bucket.
  - `AEK_debugViews` is written on every finished switch (also the fall back after a failed `onEnter`) and every editor view play toggle, in the debug env only. `restoreSavedView()` (`ViewManager.ts`) runs at the very end of `InitEngine`, after the debug GUIs and the draggable windows from LS, not right after `initMainLoop()`, so everything the Runtime view shows exists before it's hidden. It isn't awaited. It restores the play flags also when the saved view is the Runtime view.
  - `createViewCamera` (`core/Debug/Editors/_dbg__ViewCamera.ts`): `near` / `far` default to 0.1 / 1000. The aspect comes from `renderer.getSize()`, compared every `mainUpdate` and in `onEnter`, instead of a registered resizer. It also returns `getPoseKey()` and `dispose()`. A second view camera for the same view id replaces and disposes the first. Stored poses are validated on load. `store.clear()` with no argument clears all of the view's poses, `null` the view's own, and a key that key's. `resetPose()` clears the current key's saved pose and applies `defaultPose`. `clearViewCameraPoses(viewId)` also puts a live view camera back to its default pose.
  - The Phase 1 test view (`src/app/_tmp_testView.ts`) was committed with Phase 1. It now has two views on `createViewCamera` (B with a `RoomEnvironment` PMREM). Phase 4 removes it.
- **Verified** (`yarn dev`, `?isDebug=true`, SwiftShader WebGL2 on WSL2, Playwright scripts driving the console API, the test views registered at boot through a temporary, reverted import in `index.ts`):
  - Each test view starts at its default pose. A canvas orbit, a gizmo drag and a gizmo +Y align (top view) each move the view camera and save it to `AEK_debugViewCams`.
  - Each view keeps its own pose across switches. A new pose key gets the default pose, and switching keys applies each key's saved pose.
  - Undo in a view sees only that view's action; back in the Runtime view the earlier scene action is still there and undoes.
  - A refresh in view B returns to it with both views' poses and A's paused flag. A refresh without the test views registered stays in the Runtime view and clears `AEK_debugViews`.
  - `AEK_debugCams` is unchanged by the views. In the Runtime view, the gizmo still aligns and saves the debug camera, which keeps its pose and stays active across a view visit.
  - In view B the env ball shows the `RoomEnvironment`, and the profiler window (F8) samples draw calls and triangles.
  - The census in view B counts its 1 mesh (12 triangles), 2 lights and 1 debug helper (the `AxesHelper`), under the owner "Test view B", and Entities reads n/a. Back in the Runtime view it counts the scene's 5 meshes and 15 entities in 2 worlds again.
  - Profiler census (`Profiler/_dbg__Census.ts`): in an editor view it walks the view's own scene against the view's camera (`getActiveViewCamera()`, `ViewManager.ts`: the rig's camera, else `getCamera()`), not the suspended root scene. `SceneCensus.view` names the view. Its objects go to one `VIEW` owner labelled with the view's title. The entity figures are 0 in 0 worlds, since a view's scene has no entities.
    - The Overview rows say "<title>'s view" where they said "debug camera's view", and Entities is n/a there.
    - The Objects tab's note names the view, and its ECS section notes that the worlds are the suspended scene's. Its history restarts when the counted view changes.
    - Availability between two editor views is "switching views". The census reads the view camera from `ViewManager.ts`, not `_dbg__CameraRig.ts`, because the profiler also loads in prodTest, where importing `_dbg__DebugCamera.ts` would register its ECS plugin.
