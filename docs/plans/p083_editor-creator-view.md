Status: draft | not-implemented
Category: Editor-Creator View
Blocks: p084_material-editor-stage-and-selector.md, p085_material-editor-params-and-persistence.md
Related: \_DONE_p080_multi-viewport-rendering-and-axis-gizmo.md (the axes gizmo must follow the editor camera), \_DONE_p062_add-undo-and-redo-ui.md and \_DONE_p060_debugger-undo-engine-core.md (undo buckets per view), \_DONE_p105_refactor-debugger-drawer-tab-creation.md (the editor drawers reuse its declarative tabs), p110_skybox-refactor-and-layered-sky-system.md (later editors: skybox), \_DONE_p130_add-on-screen-tools-disabler-settings.md (the view tools group joins its disabled set)

# Editor-Creator View — Epic and View Switching Core

Today the debug mode has one view: the scene. This epic adds **editor/creator views** next to it. An editor view replaces what the canvas shows (its own scene, camera, lights and environment) while the loaded scene stays in memory, frozen and hidden. Switching back resumes the scene exactly where it was.

The first editor is the **material editor**. It starts as a viewer with a few editable parameters. Later editors (skybox, animation, particles, …) plug into the same view system. A later "save" plan will write editor results back to the asset JSON, which makes the editors useful for prototyping and, later, as the base of a production configurator.

This file is the epic. It also holds the first implementation plan: the **view switching core**. The material editor itself is in p084 and p085.

## Sub-plans

| Plan                                             | Scope                                                                                                                                                            | Blocked by | Engine bump |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| `p083_editor-creator-view.md` (this file)        | View registry, scene suspension in the main loop, view tools group, HUD rules per view, undo buckets per view, gizmo camera rig, active view restored on refresh | —          | minor       |
| `p084_material-editor-stage-and-selector.md`     | Material editor view: stage (ball, lights, environment), editor camera with per-material memory, bottom material selector with filter, right drawer shell        | p083       | minor       |
| `p085_material-editor-params-and-persistence.md` | Basic editable params (Params tab), editor settings (Settings tab), per-material LS + clear, undo/redo, full state restored on refresh                           | p084       | minor       |

All three can land on one branch (one engine minor bump at merge) or on separate branches (a minor bump each).

**Future plans (not written yet):** material preview thumbnails in the selector, deeper material params (textures, TSL graph inputs by type, all three.js material types), saving editor results to JSON, skybox editor (after p111), animation editor, particle editor, views in production builds (configurator).

## Naming

- **View**: what the whole canvas shows and what the main loop ticks. There is always exactly one active view. The built-in `SCENE` view is today's behaviour. Editor views are registered by modules.
- **Viewport** (p080): an extra rectangle composited _over_ the active view's frame. The axes gizmo is a viewport. Views and viewports are independent: viewports render over any view.
- **Suspended scene**: the loaded scene while a non-scene view is active. It is not rendered and none of its per-frame work runs.

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
- **On-screen tools** (`core/Debug/_dbg__OnScreenTools.ts`): three groups rebuilt from scratch on every update: `playTools` (prod-test play/stop, master loop, app pause; top centre), `switchTools` (debug cam, camera, scene, helpers; bottom centre), `undoRedoTools` (top left). `ToolTypes` is `'SWITCH' | 'PLAY' | 'UNDO'` (`debug/OnScreenTools.ts:3`). The top-centre group shifts left with the `debugDrawerOpen` body class (`OnScreenTools.module.scss:54-66`); so does the top-right viewport stack (p080 DD9).
- **Debug drawer** (`core/Debug/_dbg__DebuggerGUI.ts`): a module singleton on the right, `$drawerWidth: 40rem`. `_toggleDrawer` sets/clears `debugDrawerOpen` on `<body>` (`:368-395`). Bound to `h` (`Input/DefaultDebugKeyBindings.ts:27-32`).
- **Undo buckets** (`core/Debug/_dbg__UndoRedo.ts:57-84`): `perScene` actions go into the current scene's bucket (`getCurrentSceneId()`), `global` ones into `_global`; undo works on the current scene's bucket merged with the global one.
- **Inputs.** `setAllInputsEnabled(false)` (`Input/InputState.ts`) gates app keyboard, mouse and touch handlers (`KeyboardInput.ts:180,201,267`, `MouseInput.ts:113,222`, `TouchInput.ts:91`). `SceneLoader.loadScene` uses it during loads.
- **Boot** (`InitApp.ts`): debug modules register, then `appStartFn()` loads the first scene, then `initMainLoop()` renders the first frame and, in debug, `initDebugTools()`.
- **Icons**: `getSvgIcon` keys (`core/UI/icons/SvgIcon.ts`); the scene dropdown uses `easel`. There is no material icon yet.

## Design decisions

1. **An engine-core view registry, used only by debug views for now.**
   - New `src/_engine/core/ViewManager.ts`. It lives in core (not `_dbg__`) because a future production configurator needs it, but no view is registered in production, so the cost there is one `activeView === null` check.
   - API:
     - `SCENE_VIEW_ID = 'scene'`
     - `registerView(def: ViewDef)`, `unregisterView(id)`
     - `setActiveView(id)`, `getActiveViewId()`, `getActiveView()`, `isSceneViewActive()`
     - `isViewPlaying()`, `toggleViewPlay(value?)` (see DD5)
     - `addViewChangeListener(fn)`, returning its remover
   - `ViewDef`:
     - `id`, `title`, `icon: SvgIconKey`, `orderNr?` (position in the view tools group; the scene view is always first)
     - `scene: THREE.Scene`, the view's own private scene (never added to the root scene)
     - `getCamera(): THREE.Camera | null`
     - `getCameraRig?(): ViewCameraRig | null` (DD7)
     - `onEnter?(): void | Promise<void>`, `onExit?(): void`
     - `mainUpdate?(delta)`: every frame the master loop runs (camera controls, UI)
     - `update?(delta)`: only while the view is playing (DD5), eg. auto-rotate
     - `toggleDrawer?()`: what `h` does in this view
   - `setActiveView` is serialised: a switch that is still running its `onEnter` makes the next call wait. Switching to the active view is a no-op.
2. **Scene suspension happens in the main loop, not in the scene.**
   - While a non-scene view is active, `mainLoopForDebug` skips, for the scene:
     - every world's `updateMainLoop`, `updateAppLoop`, `updateLateMainLoop` (and so `updatePhysicsStep`)
     - `runSceneMainLoopers`, `runSceneAppLoopers`, `runSceneMainLateLoopers`
     - `countRayCastFrames` and held-key polling
   - Instead it runs `view.mainUpdate(delta)`, `view.update(delta)` when the view is playing, and the view frame listeners (DD7).
   - It renders `renderer.render(view.scene, view.getCamera())`, **without** the scene's PostFX pipeline (it is built for the root scene and its camera), then `renderViewports(renderer, delta)` as before. Stats keep working.
   - **Physics** sees the suspension as an explicit pause: `LoopState` gets `isSceneSuspended`, and `stepPhysics` adds it to its pause check. `notePhysicsAppPause()` runs every suspended frame, so resuming never catches up on the hidden time. This works the same in both worker targets, because nothing is stepped.
   - **Elapsed time** (`getElapsedTime`) stands still while the scene is suspended, like during a master pause, and the first delta after resuming is discarded. Scene code that reads it resumes without a jump.
   - The production loops are not changed in this plan. Views in production are a future plan.
3. **Entering and leaving a non-scene view** (done by `ViewManager`, in this order).
   - Enter:
     1. Set `loopState.isSceneSuspended = true` (through a `MainLoop` setter).
     2. `setAllInputsEnabled(false)`, so app keyboard/mouse/touch handlers ignore input (debug key bindings still run).
     3. Disable the scene debug camera's OrbitControls right away (a new `setSceneDebugCameraInputEnabled(false)` in `_dbg__DebugCamera.ts` that sets the flag and `controls.enabled = false`).
     4. Body classes: `aekNonSceneView` and `aekView_<id>`. Remove `debugDrawerOpen` (the scene drawer's own `isOpen` state is kept).
     5. `await view.onEnter()`.
     6. `updateOnScreenTools()` and persist the active view id (DD9).
   - Leave: the reverse. `view.onExit()`, remove the body classes, restore `debugDrawerOpen` from `getDrawerState().isOpen`, re-enable the debug camera input, `setAllInputsEnabled(true)` (unless a scene load is running, which re-enables it itself), clear the suspension, update the on-screen tools.
   - Switching between two editor views is `onExit` of one and `onEnter` of the other; the scene stays suspended.
4. **HUD rules per view** (a body class plus one SCSS rule, like p130 DD1).
   - `body.aekNonSceneView #hudRoot > :not(.aekKeepInViews) { display: none }`. That hides the scene debug drawer, the bottom switch tools, draggable windows, the debugger scene loader and any app HUD, without touching their state.
   - Kept (global class `aekKeepInViews`): the top on-screen row (DD6), the undo/redo group, the stats container, the debug toaster, the viewports layer if it is inside the HUD root, and every editor view's own UI.
   - `display: none` keeps the hidden CMPs mounted, so returning to the scene shows them as they were.
5. **Play and pause per view.**
   - The **master loop** button stays global (`toggleMainPlay`): it stops everything in every view.
   - The **pause** button acts on the active view: in the scene view it is `toggleAppPlay` (unchanged); in an editor view it toggles that view's own play flag (`toggleViewPlay`), which gates `view.update`.
   - So pausing the editor's animation never changes the scene's `appPlay`, and the suspended scene is frozen whatever its `appPlay` is.
   - The view play flags are persisted with the active view (DD9).
6. **The view tools group** (on-screen tools, `IS_DEBUG_ENV` only, never in prod test mode).
   - A new `ToolTypes` member `'VIEW'` and a `viewTools()` builder in `_dbg__OnScreenTools.ts`: one icon button per registered view, in order, with the usual `active` state. The scene view uses the `easel` icon; views bring their own icon.
   - It sits in its own group **left of the play group**. Both go into a new fixed, centred flex row (`onScreenTopRow`, global class `aekKeepInViews`) that takes over the play group's current positioning and its `debugDrawerOpen` shift. In prod test mode the row only holds the play group, so it looks as it does today.
   - With only the scene view registered, the group is not shown.
   - Per view: in a non-scene view the play group hides the "Play in production test mode" button (master loop and pause stay), and `switchTools` is not built (it is also hidden by DD4). The undo/redo group is unchanged.
   - `setActiveView` calls `updateOnScreenTools()`; `registerView`/`unregisterView` call `updateOnScreenTools('VIEW')`.
7. **Camera rig for the gizmo, and view frame listeners.**
   - `ViewCameraRig = { camera: THREE.Camera; controls: OrbitControls; setControlsSuspended(suspended: boolean): void }`.
   - The axes gizmo resolves its rig through one function: in the scene view, today's behaviour (the active camera; the ECS debug camera entity and `setDebugCameraControlsSuspended` when the debug camera is active); in an editor view, `view.getCameraRig()`, always treated like "debug camera active" (visible when "Show axes gizmo" is on, clickable, align and drag work).
   - The body of `axesGizmoSystem` becomes `tickAxesGizmo()`. The ECS system keeps calling it in the scene view. In an editor view the default world does not run, so `ViewManager` exposes `addViewFrameListener(fn)`: listeners run once per frame, only while a non-scene view is active, before `view.mainUpdate` (the same "before the controls update" order the gizmo has today).
   - Editor camera rigs run their own `controls.update()` in `mainUpdate` and respect `setControlsSuspended`, like `debugCameraSystem` does.
   - The env ball (p115) will use the same rig resolver.
8. **Keys and undo in editor views.**
   - `h` (`sc-toggle-debug-drawer`) calls a new `toggleActiveViewDrawer()`: the debug drawer in the scene view, `view.toggleDrawer()` in an editor view (a no-op if the view has none).
   - `F1` (debug camera toggle) is a no-op in an editor view. `F8` (gizmo) and undo/redo work everywhere.
   - Undo: `getSceneBucketId()` in `_dbg__UndoRedo.ts` returns `__view:<id>` while an editor view is active. So `perScene` actions recorded in an editor land in that view's own history, undo there never touches the hidden scene, and `global` actions stay visible in every view. The history tab (scene drawer) is hidden in editor views anyway.
9. **The active view survives a refresh.**
   - LS key `AEK_debugViews`: `{ activeViewId: string; viewPlay: Record<string, boolean> }`, written on every switch and play toggle.
   - Restore: once, right after `initMainLoop()`'s first `renderScene()` in `InitApp.ts` (debug env only). The first scene has loaded by then (or keeps loading in the background, suspended: loads are promise-driven, not loop-driven). If the saved view is not registered (eg. it was removed), fall back to the scene view and clear the key.
   - Restoring the editor's own state (material, camera, drawers, tabs) is up to each view (p084, p085).
10. **Scene loads while an editor view is active.** The editor UI offers no way to load a scene, but app code or HMR can. `loadScene` keeps working: it loads in the background, its loader UI is hidden by DD4, and it re-enables inputs at its end, so `ViewManager` re-applies `setAllInputsEnabled(false)` from a `registerOnAllSceneEnterings` hook while a non-scene view is active. The new scene is suspended as soon as it exists, because suspension is a loop state, not a scene state.

## Files touched

| File                                                                                                                  | Change                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/_engine/core/ViewManager.ts` (new)                                                                               | View registry, `setActiveView` (enter/leave sequence), view play flags, frame listeners, LS persistence and restore                              |
| `src/_engine/core/MainLoop.ts`                                                                                        | `isSceneSuspended` in `LoopState` + setter; suspended branch in `mainLoopForDebug`; `advanceElapsedTime` rule; view render path in `renderScene` |
| `src/_engine/core/PhysicsAPI.ts`                                                                                      | `stepPhysics` treats `loopState.isSceneSuspended` as a pause                                                                                     |
| `src/_engine/debug/OnScreenTools.ts`, `core/Debug/_dbg__OnScreenTools.ts`, `OnScreenTools.module.scss`                | `'VIEW'` tool type, `viewTools()`, top row container, per-view play group and switch tools                                                       |
| `src/_engine/styles/index.scss` (or a new `ViewManager.module.scss`)                                                  | `aekNonSceneView` HUD rule, `aekKeepInViews`                                                                                                     |
| `src/_engine/core/Debug/_dbg__Stats.ts`, `_dbg__UndoRedo.ts`, `_dbg__DebuggerGUI.ts`, `UI/Toaster.ts`, `Viewports.ts` | Add `aekKeepInViews` where the element must stay visible (stats, toaster, undo group, viewports layer)                                           |
| `src/_engine/core/Debug/_dbg__UndoRedo.ts`                                                                            | View-aware `getSceneBucketId()`                                                                                                                  |
| `src/_engine/core/Debug/_dbg__AxesGizmo.ts`                                                                           | Rig resolver, `tickAxesGizmo()`, frame listener in editor views                                                                                  |
| `src/_engine/core/Debug/Camera/_dbg__DebugCamera.ts`                                                                  | `setSceneDebugCameraInputEnabled`                                                                                                                |
| `src/_engine/core/Input/DefaultDebugKeyBindings.ts`                                                                   | `h` → `toggleActiveViewDrawer()`, `F1` guard                                                                                                     |
| `src/_engine/InitApp.ts`                                                                                              | Restore the saved view after the main loop starts (debug env)                                                                                    |
| `.claude/CLAUDE.md`                                                                                                   | A "Views" paragraph under Architecture (view vs viewport, suspension rules, how to register a view)                                              |
| `package.json`                                                                                                        | Engine minor bump at merge                                                                                                                       |

## Phases

Each phase compiles, lints and leaves the app working.

1. **ViewManager and suspension, no UI.**
   - `ViewManager.ts`, the `MainLoop`/`PhysicsAPI` changes, the enter/leave sequence without the on-screen tools.
   - Verify with a throwaway, uncommitted test view (a private scene with a spinning cube and its own `PerspectiveCamera`) switched from the browser console: the scene freezes and hides, physics resumes without a jump, both worker targets.
2. **HUD rules, view tools group and keys.**
   - Body classes and the HUD SCSS rule, `aekKeepInViews` on the kept elements, the top row container, `viewTools()`, per-view play group, `h`/`F1` routing.
   - Still no committed view, so the group stays hidden; the test view from Phase 1 shows it.
3. **Gizmo rig, undo buckets, refresh restore.**
   - `ViewCameraRig`, the gizmo refactor (`tickAxesGizmo`, frame listeners), view-aware undo buckets, `AEK_debugViews` persistence and restore.
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
  - Canvas drags in the test view don't move the scene debug camera; app key bindings (eg. character movement) do nothing; `h` does nothing in a view without a drawer; `F1` does nothing; `F8` toggles the gizmo, which follows the view camera and can align/drag it.
  - Pause in the test view stops its animation; the scene's `appPlay` (loop tab) is unchanged. The master loop button stops everything.
  - The switch tools, debug drawer, draggable windows and app HUD are hidden and come back unchanged; stats, undo/redo and toasts stay.
  - Undo in the test view doesn't undo scene actions recorded before the switch; back in the scene they are still undoable.
  - Refresh with the test view active returns to it; unregistering it and refreshing falls back to the scene view.
- Production build (`yarn build`, `dist-stats/bundle-stats.html`): no view is registered and `ViewManager.ts` is present but idle; the `_dbg__` changes stay out of the main chunk.
- Use the `run-aekasha-js` skill for screenshots of the scene view, the test view and the view tools group in both drawer states.

## Implementation notes

(Filled in during implementation.)
