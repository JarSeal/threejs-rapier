Status: implemented
Category: Rendering, Multi-viewport, Debugger
Related: \_DONE_p110_skybox-refactor-and-layered-sky-system.md (epic), \_DONE_p115_debug-environment-ball-viewport.md (env ball as a second viewport left of the gizmo, F7; builds on this plan), \_DONE_p105_refactor-debugger-drawer-tab-creation.md (landed first: this plan's Debug Tools options were built on its declarative tab API)

# Multi-viewport Rendering and Axes Gizmo — Plan

A core engine **viewport** feature: extra rectangles rendered on top of the main canvas after the main render (and after PostFX), each with its own scene and camera. It is also known as picture-in-picture, a viewport overlay, or scissored viewport rendering. It works on the WebGPU backend and the WebGL2 fallback, with PostFX on or off. It ships in production because app/game code will want it (minimaps, rear-view cameras, item previews). Its first consumer, built in this plan, is a debug-only, Blender-style **axes gizmo**. It sits in the top-right corner, moves left when the debugger drawer opens, and follows the active camera's rotation. While the debug camera is active, it is clickable: an axis bubble aligns the camera, and a drag orbits it. It is toggled from the Debug Tools Controls tab and with F8.

## Context (grounded in code)

- **One render seam.** `renderScene()` (`src/_engine/core/MainLoop.ts:160-176`) calls either `postFxPipeline.render()` or `renderer.render(rootScene, camera)`, with `camera = getActiveCamera()`. All three loop variants and the warm-up render call it, so one added call covers every loop.
- **Nothing multi-viewport exists yet.** No `setViewport`, `setScissor`, `autoClear`, `setRenderTarget` or `ViewHelper` usage anywhere in `src/`. `renderer.autoClear` is left at three's default `true`.
- **Renderer settings that matter.** `src/index.ts:9-20`: `antialias: true` (MSAA), `ACESFilmicToneMapping`, `toneMappingExposure: 0.7`, `SRGBColorSpace`, `alpha: true`. The canvas fills the window, and `canvasResizer` in `MainLoop.ts` sizes it from `window.innerWidth/innerHeight`. So HUD CSS px equal canvas CSS px.
- **Debug camera.**
  - Created by `initDebugCamera` (`src/_engine/core/CameraManager.ts:412-459`).
  - Uses stock `OrbitControls` (`src/_engine/core/Debug/Camera/_dbg__DebugCamera.ts:43-74`), stored as the ECS component `ORBIT_CONTROLS: { controls, sceneId }`.
  - `debugCameraSystem` (MAIN stage, same file `:79-101`) calls `controls.update()` every frame. It copies position and quaternion into `TRANSFORM` only when `update()` returns true.
  - Position and target are persisted via `saveDebugCameraToLS` (`_dbg__CameraGUI.ts:641`), but only on the controls' `'end'` event (user drags).
  - The pattern for moving it from code is `applyDebugCameraProps` (`src/_engine/core/Debug/_dbg__DebugTools.ts:297-333`): set position and target, call `controls.update()`, then `saveDebugCameraToLS`.
- **Camera queries.**
  - `isDebugCameraActive()` (`CameraManager.ts:464`).
  - `getActiveCamera()` (`:223`): the camera being rendered.
  - `getMainCamera()` (`:233`): always the gameplay camera.
  - There is no camera-change event. PostFX compares the active camera per frame by identity (`PostFX.ts:253`), and this plan does the same.
- **Debugger drawer.**
  - Fixed width: `$drawerWidth: 40rem`, `$drawerWidthSmall: 30rem` below 479px, and 100% below 379px (`src/_engine/styles/variables.scss:19-20`).
  - Animates `right` over 0.2s (`DebuggerGUI.module.scss`).
  - Open/closed shows only as the body class `debugDrawerOpen` (`_dbg__DebuggerGUI.ts:18, 246-266`). There are no JS events. `OnScreenTools.module.scss:38-60` already shifts tools with `:global(.debugDrawerOpen) &`.
  - The drawer toggler (3rem tall, rotated tab) hangs off the drawer's left edge (`right: 100%`). That is the gizmo's minimum padding when the drawer is open.
- **Debug Tools Controls tab.**
  - `src/_engine/core/Debug/_dbg__DebugTools.ts`, `createDebuggerTab({ id: 'debugToolsControls', orderNr: 6 })`.
  - "Show axes helper" is the first binding of the Helpers folder (`:434-439`). Every change saves the whole state object to `AEK_debugTools`.
  - State type and defaults live in `src/_engine/debug/DebugToolsManager.ts:8-90`; the defaults are duplicated in `_dbg__DebugTools.ts:44-84`.
  - **Load is a shallow merge** (`_dbg__DebugTools.ts:96-97`: `{ ...debugToolsState, ...savedDebugToolsState }`). A new key inside `helpers` would be `undefined` for anyone with saved state. New state therefore goes in a new top-level key.
- **Keyboard.**
  - Debug shortcuts are `DEFAULT_DEBUG_KEY_BINDINGS` entries in `src/_engine/core/Input/DefaultDebugKeyBindings.ts`, with chord reservation and `AppConfig.debugKeys` overrides by id.
  - F1 is the precedent: `KEY_DOWN`, `preventDefault`, and a `repeat`/`isTypingInField` guard.
  - **F8 is unused.** F7 is reserved for the env ball (\_DONE_p115_debug-environment-ball-viewport.md).
- **Input conflicts.**
  - OrbitControls listens for pointer events on the canvas.
  - `MouseInput.ts` listens on `window` but only acts when `e.target === canvas`. A click is at most 5px of movement (`CLICK_MAX_MOVE_PX`, `:74`).
  - A DOM element over the canvas therefore never reaches either one.
- **Debug layering rule.** A thin public entry point is guarded by `IS_DEBUG_ENV` and lazy-imports a `_dbg__` implementation via `loadDebugModuleAsync` / `useDebug` (`src/_engine/utils/helpers.ts:470-537`). `DebugToolsManager.ts:92-115` is the example. `_dbg__DebugCamera.ts` shows a debug module registering its own ECS system through `ECSWorld.registerPlugin`.

### Three.js r186 facts (verified against `node_modules/three`, version 0.186.1)

- **Viewport and scissor.** `Renderer.setViewport` / `setScissor` / `setScissorTest` exist (`renderers/common/Renderer.js:2270-2340`). They take **CSS px with a top-left origin on both backends**; WebGL flips y internally at `WebGLBackend.js:706-726`. The renderer multiplies by the pixel ratio and floors.
- **Why naive overlays fail here.**
  - With tone mapping on, or `outputColorSpace` ≠ working space (always true for us), `renderer.render()` to the canvas draws into one internal framebuffer target shared per canvas (`_getFrameBufferTarget`, `Renderer.js:1561`).
  - It then runs an output quad that is **opaque, with no blending**, inside the current viewport (`_renderOutput`, `:1959-2020`).
  - `renderer.clear()` / `clearDepth()` also trigger that output pass.
  - On WebGPU, every clear is a whole-attachment `loadOp: 'clear'` that ignores the scissor (`WebGPUBackend.js:964-1034`). WebGL's `gl.clear` does respect the scissor, so the two backends differ.
  - The result: a `setViewport` + `render` overlay after the main render replaces its rectangle with stale or empty pixels, or wipes the whole frame. This is certain after `RenderPipeline`, which bypasses the internal buffer.
- **How `RenderPipeline.render()` avoids it** (`RenderPipeline.js:130-160`). It temporarily sets `renderer.toneMapping = NoToneMapping` and `outputColorSpace = ColorManagement.workingColorSpace`, draws its own `QuadMesh`, and restores both. Its node chain calls `renderOutput()` itself. **This plan's compositor uses the same trick.**
- **Needed APIs exist.**
  - `renderOutput(color, toneMapping, colorSpace)` is exported from `three/tsl` (`nodes/display/RenderOutputNode.js:157`).
  - `QuadMesh`, `RenderTarget` and `CanvasTarget` are exported from `three/webgpu`.
  - `QuadMesh.render(renderer)` is a plain `renderer.render(quad, cam)`, so it respects the canvas viewport.
- **`CanvasTarget`** (`renderer.setCanvasTarget`, `Renderer.js:2784`) is WebGPU-only: the WebGL fallback binds one context to `renderer.domElement`. It is a fallback, not the primary path.
- **Existing gizmos.**
  - `examples/jsm/helpers/ViewHelper.js` supports WebGPU, but calls `clearDepth()` before setting its viewport, which runs the full-canvas output pass. It breaks with PostFX on.
  - `three-viewport-gizmo` 2.2.0 (MIT, Fennec-hub) uses the WebGL `LineMaterial`, which fails on NodeMaterial (its issue #26), and bottom-left y (#48). The WebGPU fix is PR #54, unmerged as of 2026-05.
  - Neither is used as a dependency. Ideas borrowed from `three-viewport-gizmo`:
    - a DOM hit element over the rectangle
    - `rotateTowards`-style frame-delta animation (instead of the deprecated `THREE.Clock`)
    - a click/drag threshold
    - negative-axis dimming
    - swapping two materials for hover, instead of mutating the atlas UV offset, which is unreliable on node materials

## Naming

- A **viewport** is an extra rendered rectangle composited over the main canvas. The full-canvas render is the **main view**.
- Code: `Viewports.ts`, `createViewport()`, `deleteViewport()`, `setViewportEnabled()`, `getViewport()`, and `renderViewports()` (internal, called from `renderScene()`).
- A viewport is never called a "pass", because PostFX owns that word (see `_DONE_p070_post-fx-system.md` Naming).
- The gizmo is the **axes gizmo** (matching the existing "axes helper" wording): `AxesGizmo.ts` / `_dbg__AxesGizmo.ts`.

## Design decisions

1. **Render-to-target, then composite.** Each enabled viewport, each frame:

   1. **Render the viewport's scene** into the viewport's own `RenderTarget` (`HalfFloatType`, `samples: 4` when `renderer.samples > 0`, sized to the rect in device px). Temporarily: `autoClear = true`, and the clear colour is the viewport's own (alpha 0 for transparent viewports). Rendering into a render target never touches the canvas's internal framebuffer, clears only that target, and gets its own depth and MSAA.
   2. **Composite onto the canvas.** Draw a `QuadMesh` whose `NodeMaterial` samples that target through `renderOutput(texture(rt.texture), toneMapping, renderer.outputColorSpace)`.
      - The draw runs inside `renderer.setViewport(rect)`, with `autoClear = false`, and with `renderer.toneMapping` / `outputColorSpace` temporarily neutralised, exactly as `RenderPipeline.render()` does. That keeps it off the internal framebuffer path.
      - Blending is premultiplied "over" (`CustomBlending`, `One` / `OneMinusSrcAlpha` for colour and alpha). Transparent viewports blend over the frame, and opaque ones simply cover it.
      - The quad has depth test and depth write off.
   3. **Restore state.** Put back the viewport, `autoClear`, clear colour/alpha, render target, tone mapping and colour space. The scissor test is never left on; the r186 bug #31777 is PMREM breaking under a leaked scissor.

   The same code path runs with PostFX on or off, and on both backends. The cost is one small render target and one extra quad draw per viewport. There are no per-frame allocations: temporary vectors and colours are module-level.

2. **Called once, right after the main render.** `renderScene()` gains `renderViewports(renderer)` after the PostFX/plain branch. With zero enabled viewports this is a single length check, so production cost is nil. Viewports are therefore never affected by PostFX (a gizmo must not get ambient occlusion). Per-viewport PostFX is a non-goal.

3. **Tone mapping per viewport.** `toneMapping: 'NONE' | 'RENDERER'`.

   - `'NONE'` (the default for overlays like the gizmo) gives exact flat colours.
   - `'RENDERER'` (for a picture-in-picture view of the game scene) matches the main view. It uses the renderer's `toneMapping` and exposure.
   - The compositor records the tone mapping it built with, and rebuilds the quad material when `renderer.toneMapping` changes (the Renderer debug tab changes it live). This is a per-frame identity compare, like PostFX's camera check.

4. **Layout is DOM-anchored.** Every viewport owns a positioned DOM **slot element** in a new HUD layer (`#aekViewportsLayer`, inside the HUD root, `z-index` below the on-screen tools and the drawer). The rect rendered is the slot's `getBoundingClientRect()`, minus the canvas rect, snapped to whole device pixels. Placement uses one of two options:

   - a **corner stack**: `anchor: 'TOP_RIGHT' | 'TOP_LEFT' | 'BOTTOM_RIGHT' | 'BOTTOM_LEFT'`. Each is a flex container, and a stack's `order` value decides left/right placement. This is how the future env ball lands left of the gizmo with no extra layout code.
   - an explicit `rect: { x, y, width, height }` in CSS px, or in `%` of the canvas.

   CSS stays the single source of truth for placement, media queries and animation. So the debug layer shifts the top-right stack for the open drawer with one SCSS rule (Design decision 9), without the core knowing about the drawer. Rects are read from the DOM only when they may have changed, never each frame by default:

   - on create, enable and window resize
   - every frame between a stack's `transitionrun` and `transitionend` (so the gizmo slides along with the drawer)
   - through an explicit `invalidateViewportLayout()`

5. **Input is opt-in and isolated.** `interactive: true` gives the slot `pointer-events: auto`; otherwise it is `none`, so the canvas and game input see everything. Events on the slot never reach OrbitControls or `MouseInput`, because their target is not the canvas. The core exposes `getViewportPointerNDC(id, event, out: Vector2)` for consumers that raycast inside a viewport. The core does no picking itself.

6. **Viewports are a plain module, not ECS.**

   - A viewport is render-pipeline configuration, like PostFX (p070 Non-goals), not a world object. It usually renders a private scene the ECS never sees.
   - `camera` accepts a `THREE.Camera` or a resolver `() => THREE.Camera | null`, so a viewport can follow `getActiveCamera()`, `getMainCamera()` or an ECS camera entity's object.
   - An optional `sceneId` deletes the viewport on that scene's exit (via the Scene enter/exit hooks). Without it the viewport is global and persistent, like the gizmo.
   - `syncCameraAspect` (default `false`) updates a perspective camera's aspect, or an orthographic frustum, when the rect changes.

7. **Public API** (`src/_engine/core/Viewports.ts`):

   ```ts
   export type ViewportProps = {
     id: string;
     scene: THREE.Object3D; // a private Scene, or getRootScene() for a PiP of the game
     camera: THREE.Camera | (() => THREE.Camera | null);
     anchor?: 'TOP_RIGHT' | 'TOP_LEFT' | 'BOTTOM_RIGHT' | 'BOTTOM_LEFT';
     order?: number; // position inside the corner stack
     rect?: { x: number; y: number; width: number; height: number; unit?: 'px' | '%' };
     size?: { width: string; height: string }; // CSS size of a stacked slot, eg. '10rem'
     slotClass?: string; // extra class on the slot (consumer SCSS: margins, media queries)
     transparent?: boolean; // default true: clear alpha 0 and blend over the frame
     clearColor?: THREE.ColorRepresentation; // for opaque viewports without a scene background
     toneMapping?: 'NONE' | 'RENDERER'; // default 'NONE'
     samples?: number; // default: 4 if renderer.samples > 0, else 0
     interactive?: boolean; // default false
     enabled?: boolean; // default true
     sceneId?: string;
     syncCameraAspect?: boolean;
     onBeforeRender?: (vp: Viewport, delta: number) => void; // eg. update gizmo orientation
   };
   export const createViewport: (props: ViewportProps) => Viewport;
   export const deleteViewport: (id: string) => void; // disposes the RT, quad material and slot
   export const setViewportEnabled: (id: string, enabled: boolean) => void;
   export const setViewportInteractive: (id: string, interactive: boolean) => void;
   export const getViewport: (id: string) => Viewport | undefined; // { props, slotElem, rect }
   export const invalidateViewportLayout: () => void;
   export const getViewportPointerNDC: (id: string, e: PointerEvent, out: THREE.Vector2) => boolean;
   export const renderViewports: (renderer: THREE.WebGPURenderer, delta: number) => void; // MainLoop only
   ```

   Enabled viewports render in stack/insertion order. A disabled viewport keeps its render target (cheap to re-enable) and hides its slot (`display: none`).

8. **The axes gizmo is a debug-only 3D viewport, the first real consumer.**

   - **Code location.** `src/_engine/debug/AxesGizmo.ts` is the thin public entry, guarded by `IS_DEBUG_ENV` and lazy-loading the rest. `src/_engine/core/Debug/_dbg__AxesGizmo.ts` holds the implementation, and `AxesGizmo.module.scss` the styles. It is initialized from `_initDebugTools`, after the Debug Tools state loads.
   - **Viewport.** `anchor: 'TOP_RIGHT'`, `order: 0` (rightmost), `size: 10rem × 10rem` (8rem below `$breakpointSmall`), `transparent`, `toneMapping: 'NONE'`, `interactive` while the debug camera is active.
   - **Scene.** A private `THREE.Scene` with no lights (unlit `MeshBasicNodeMaterial` / `SpriteNodeMaterial`) and a fixed `OrthographicCamera` looking down −Z. Each frame, `onBeforeRender` sets `gizmoRoot.quaternion = inverse(sourceCamera.quaternion)`. The source camera is `getActiveCamera()`: the debug camera, or the main camera when shown there.
   - **Visuals (Blender 2.8+ navigation gizmo, adapted to three's Y-up):**
     - X = red `#ff3653`, Y = green `#8adb00`, Z = blue `#2c8fff`.
     - Positive axes: a line from the centre (thin cylinder mesh, so MSAA smooths it; no `Line2` dependency) ending in a solid bubble labelled `X` / `Y` / `Z`.
     - Negative axes: a bubble with a coloured rim and a darker translucent fill, and no label. The `-X` / `-Y` / `-Z` label appears on hover.
     - Bubbles are camera-facing circle meshes; labels come from one `CanvasTexture` atlas (sRGB). Hover swaps each bubble between two materials (idle / hover).
     - Bubbles are depth-ordered each frame by view z via `renderOrder`. Bubbles pointing away from the viewer dim, like Blender's back-facing axes.
     - A translucent circular backdrop appears behind the whole gizmo while the pointer is over it.
   - **Visibility rule**, evaluated in `onBeforeRender` (a per-frame boolean compare; slot state changes only on transitions):
     - `visible = axesGizmo.show && (isDebugCameraActive() || axesGizmo.showInMainCamera)`
     - `clickable = visible && isDebugCameraActive()`, which drives `setViewportInteractive`
     - When not visible, the viewport is disabled, so it costs no GPU time at all.

9. **Drawer offset is one debug SCSS rule.** `AxesGizmo.module.scss` targets the core's global stack class:

   - `:global(.debugDrawerOpen) :global(.aekViewportStack_TOP_RIGHT) { right: calc($drawerWidth + 3rem + 1.6rem) }`. The 3rem is the drawer toggler, which hangs off the drawer's left edge, and 1.6rem matches the on-screen tools' margin.
   - It uses `transition: right 0.2s ease-in-out`, matching the drawer.
   - The `$drawerWidthSmall` breakpoint gets its own rule. Below `$breakpointSmall`, where the drawer is full-width, the gizmo is hidden while the drawer is open.
   - The closed-drawer margin is `1.6rem`, raised to clear the toggler when it is in the `TOP` position.
   - Transition tracking in Design decision 4 makes the rendered rect follow the CSS animation frame by frame.

10. **Click to align (debug camera only).**

    - **Hit-testing.** A `Raycaster` against the six bubbles, using `getViewportPointerNDC`. The front-most bubble wins.
    - **Click versus drag.** A press counts as a click if it moves ≤ 5px, the same threshold as `MouseInput.ts`'s `CLICK_MAX_MOVE_PX` (exported for reuse rather than duplicated).
    - **Target.** The camera goes to `controls.target + axis * currentOrbitDistance`, so the orbit target and zoom are kept. The camera's `up` stays +Y; OrbitControls requires it.
    - **Pole views.** Top (+Y) uses spherical `phi = ε, theta = 0`, so X points right and −Z up on screen. Bottom (−Y) uses `phi = π − ε, theta = 0`, so X points right and +Z up (corrected in Phase 4: `theta = π` mirrors it to X left, −Z up). Both stay inside OrbitControls' `makeSafe` EPS clamp, so there is no roll jump.
    - **Blender flip.** Clicking the axis the view is already aligned to (within ~1°) aligns to the opposite axis.
    - **Animation.**
      - Interpolates spherical `(theta, phi)` around the target over ~250ms with ease-out, driven by the frame `delta`. Theta takes the shortest path. Spherical interpolation, rather than a quaternion slerp, is well-defined for the antipodal flip and matches how OrbitControls rebuilds orientation from position, target and up.
      - It is stepped in a MAIN-stage ECS system registered by `_dbg__AxesGizmo.ts`, before `debugCameraSystem`, so the same frame's `controls.update()` picks it up.
      - A user orbit (the controls' `'start'` event) cancels it. OrbitControls damping momentum is zeroed at animation start.
      - When it ends, it calls `saveDebugCameraToLS({ position, target })` (the `'end'` event only fires for user drags) and the Debug Tools panel refresh callback.

11. **Drag to orbit** (Blender parity).

    - A drag starting on the gizmo, beyond the 5px threshold, captures the pointer (`setPointerCapture`). It rotates the debug camera around `controls.target` by spherical deltas scaled like OrbitControls' `rotateSpeed`. The deltas are clamped to the controls' `minPolarAngle` / `maxPolarAngle` and EPS.
    - The controls are disabled for the drag (`controls.enabled = false`, restored on release; `debugCameraSystem` writes `enabled` each frame, so the gizmo flags itself as "dragging" and the system respects that).
    - On release it saves to LS the same way.
    - Wheel events over the gizmo are ignored, as in Blender.

12. **Options, state and shortcut.**
    - **State.** A new **top-level** `axesGizmo: { show: boolean; showInMainCamera: boolean }` in `DebugToolsState`, defaulting to `{ show: true, showInMainCamera: false }`. It goes in the type and both default objects (`DebugToolsManager.ts`, `_dbg__DebugTools.ts`). Top-level, so the shallow LS merge fills defaults for existing users.
    - **Bindings.** Two bindings are inserted **above** "Show axes helper" in the Helpers folder:
      - "Show axes gizmo" (the label shows the shortcut: `Show axes gizmo [F8]`)
      - "Show axes gizmo in main camera"
      - Each `on('change')` calls the gizmo toggle and `lsSetItem(LS_KEY, debugToolsState)`, like its neighbours.
    - **Shortcut.** A new `DEFAULT_DEBUG_KEY_BINDINGS` entry: `id: 'sc-toggle-axes-gizmo'`, `KEY_DOWN`, `chord: { key: 'F8' }`, `preventDefault`, the `repeat`/`isTypingInField` guard.
      - It flips `axesGizmo.show`, saves it to LS, and refreshes the Debug Tools pane if it exists. Tweakpane's `refresh()` re-emits `change`, which is harmless because the handler is idempotent.
      - `AppConfig.debugKeys` can rebind it by id.
      - When p105 lands, these options migrate with the rest of the tab (`updateDebuggerTab` replaces the manual refresh).

## Files touched

| File                                                                                   | Change                                                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/_engine/core/Viewports.ts` (new)                                                  | Core viewport API, compositor, layout/rect tracking                                           |
| `src/_engine/core/Viewports.module.scss` (new)                                         | `#aekViewportsLayer`, corner stacks (`.aekViewportStack_*` global classes), slots             |
| `src/_engine/core/MainLoop.ts`                                                         | `renderViewports(renderer, delta)` at the end of `renderScene()` (thread `delta` through)     |
| `src/_engine/core/HUD.ts` or `InitApp.ts`                                              | Create the viewports layer after the HUD root                                                 |
| `src/_engine/debug/AxesGizmo.ts` (new)                                                 | Thin `IS_DEBUG_ENV` entry: `initAxesGizmo`, `setAxesGizmoVisible`, `setAxesGizmoInMainCamera` |
| `src/_engine/core/Debug/_dbg__AxesGizmo.ts` (new)                                      | Gizmo scene, visuals, hover/click/drag, align animation system                                |
| `src/_engine/core/Debug/AxesGizmo.module.scss` (new)                                   | Slot sizing, drawer offset, hover cursor                                                      |
| `src/_engine/debug/DebugToolsManager.ts`, `src/_engine/core/Debug/_dbg__DebugTools.ts` | `axesGizmo` state, two bindings above "Show axes helper", init call                           |
| `src/_engine/core/Input/DefaultDebugKeyBindings.ts`                                    | F8 binding                                                                                    |
| `src/_engine/core/Input/MouseInput.ts`                                                 | Export `CLICK_MAX_MOVE_PX`                                                                    |
| `src/_engine/core/Debug/Camera/_dbg__DebugCamera.ts`                                   | Respect the gizmo's "dragging/animating" flag when writing `controls.enabled`                 |
| `.claude/CLAUDE.md`                                                                    | One paragraph on Viewports under Architecture                                                 |
| `package.json`                                                                         | Engine minor bump at merge (new feature)                                                      |

## Phases

Each phase compiles, lints and leaves the app working.

1. **Compositor spike, then the core API (go/no-go).**

   - Implement Design decisions 1–3 and 7 without the DOM layout (explicit `rect` only), and wire in `renderViewports`.
   - Verify with a throwaway, uncommitted test in a dev scene: a transparent private scene (a spinning coloured cube) and an opaque `rootScene` PiP from `getMainCamera()`. Run the whole matrix in the Verification section.
   - **Gate.** If the composite path fails on a backend, stop and choose a fallback. The fallbacks, in order:

     - (a) the same design, but composite through the PostFX pipeline's final node when PostFX is on
     - (b) `CanvasTarget` overlay canvases (WebGPU only; the WebGL fallback gets no viewports)
     - (c) for the gizmo alone, a 2D-canvas implementation outside the GPU pipeline

     Record the outcome in this plan's "Implementation notes".

2. **Layout and input plumbing.**
   - Viewports layer, corner stacks, slot elements, rect caching (resize, transition tracking, invalidate), `interactive`, `getViewportPointerNDC`, `sceneId` auto-delete, `syncCameraAspect`.
   - Still no committed consumer.
3. **Axes gizmo, display only.**
   - `AxesGizmo.ts` / `_dbg__AxesGizmo.ts`, visuals, follow rotation, the visibility rule, drawer offset SCSS.
   - Debug Tools options, `axesGizmo` state and the F8 binding.
   - The gizmo is fully usable as an orientation indicator here.
4. **Axes gizmo interaction.** Hover (highlight, backdrop, negative labels), click to align with animation, the Blender flip, drag to orbit, LS persistence, the controls-enabled handshake.
5. **Docs and version.** CLAUDE.md paragraph, engine minor version bump, and "Implementation notes" filled in.

## Non-goals

- PostFX inside a viewport (a PiP gets plain `renderer.render` output with tone mapping only).
- Split-screen and `ArrayCamera`. The API doesn't preclude them, but full-canvas tiling would want a scissor-based path and a camera per tile.
- Blender's auto-orthographic switch on align, and its zoom, pan, camera and ortho buttons under the gizmo.
- Camera roll and view-rotation controls. Aligning the main camera from the gizmo (display only by design: the main camera has no controls and belongs to gameplay code).
- Viewports in the scene/asset JSON schema, and a debugger tab listing viewports (candidate follow-ups).
- The env ball viewport, which belongs to \_DONE_p115_debug-environment-ball-viewport.md and is built on this API.

## Risks / open questions

| Risk                                                                                                          | Mitigation                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The composite path misbehaves on one backend: quad UV flip, MSAA canvas load, premultiplied edges             | Phase 1 is a spike with an explicit gate and ordered fallbacks. The quad draw is the same code path `RenderPipeline` already uses to draw to the canvas every frame here.                                   |
| It relies on undocumented renderer internals (the output framebuffer path) that change between three releases | The compositor avoids that path rather than depending on it: render target plus a neutralised quad, the same contract as `RenderPipeline.render()`. Re-verify on every three upgrade (a Verification step). |
| `renderOutput` on premultiplied colour gives slightly wrong sRGB conversion on translucent edges              | Visually negligible for a gizmo; revisit only if a PiP needs translucent edges.                                                                                                                             |
| A `rootScene` PiP renders the game scene twice: shadow maps, `onBeforeRender` hooks, stats draw counts        | Documented in the API JSDoc as the consumer's cost. Its only use here is the Phase 1 test.                                                                                                                  |
| Toggling `renderer.toneMapping` per frame forces an output-material rebuild                                   | The main view's output quad key is stable per frame (it is only used by the main render). Verify pipeline and program counts stay flat over time (Verification).                                            |
| `debugCameraSystem` overwrites `controls.enabled` each frame and breaks the drag handshake                    | Explicit flag check (Files touched).                                                                                                                                                                        |
| OrbitControls clamps (`minPolarAngle`/`maxPolarAngle`, damping) fight the align animation                     | Clamp targets to the controls' limits and zero damping momentum at animation start.                                                                                                                         |
| The drawer toggler overlaps the gizmo in `TOP` toggler position                                               | The closed margin accounts for the toggler (Design decision 9); check both positions in Verification.                                                                                                       |
| Reading `getBoundingClientRect` forces a layout while the DOM is dirty                                        | Rects are only read on resize, during stack transitions, or on invalidate, never every frame by default.                                                                                                    |

## Verification

- `yarn lint` and `yarn build` pass (the Stop hook also runs them).
- **Phase 1 matrix** (`yarn dev`, `?isDebug=true`). Each combination below shows correct colours, no black or stale squares, no full-frame wipe, and crisp MSAA edges:
  - backend: WebGPU / WebGL2 (Renderer tab `forceWebGL`)
  - PostFX: on / off (the PostFX tab, `largeWorld` scene with AO)
  - antialias: on / off
  - pixel ratio: 1 / 2 (Renderer tab)
- Toggle tone mapping in the Renderer tab with a `'RENDERER'` viewport and confirm it follows.
- Confirm the GPU pipeline and program counts are stable after 60s (`renderer.info`, stats-gl), which rules out per-frame recompiles.
- **Gizmo:**
  - It follows debug camera rotation, including pole views.
  - F8 toggles it and the checkbox updates. Both options persist across reloads, and existing `AEK_debugTools` saved state gets the defaults.
  - The drawer (`h`) slides the gizmo left in sync. Check the `$drawerWidthSmall` and full-width breakpoints, and both toggler positions.
  - Each of the six bubbles aligns (animated), a second click flips, and a drag orbits. Clicks and drags on the gizmo never start an OrbitControls rotate.
  - The camera pose survives a reload.
  - Main camera (F1 off): hidden by default. With "in main camera" on, it is visible, follows the gameplay camera, and ignores the pointer, so clicks reach the game (`Character.ts` mouse binding still works under the gizmo area).
  - With the gizmo hidden, the stats show no extra draw calls.
- Production build (`yarn build`, `dist-stats/bundle-stats.html`): `_dbg__AxesGizmo` is not in the main chunk, and `Viewports.ts` is present but idle.
- Use the `run-aekasha-js` skill for screenshots of each Phase 1 matrix cell and the gizmo states.

## Implementation notes

### Phase 1 (compositor spike + core API): GO

- The render-to-target + neutralised-quad composite works as designed on both backends. No fallback needed.
- Verified with a throwaway `?vpTest=1` snippet (not committed) in `largeWorld`: a transparent private-scene cube (top right), the same cube 50% off the canvas's left edge (crop test), and an opaque `'RENDERER'` PiP of `rootScene` from `getMainCamera()` (bottom left, `%` rect).
  - Full matrix, 16 cells (WebGPU / WebGL2 × PostFX AO on / off × antialias on / off × pixel ratio 1 / 2): correct placement (no y flip on WebGL), no black or stale rects, no full-frame wipe, no console errors. The backend was confirmed per cell from the canvas context type.
  - `'NONE'` colours are exact (pure 0/255 channels sampled) on both backends, PostFX on and off. MSAA edges are smooth with antialias on and stepped with it off, with no dark fringe over the frame.
  - A live `renderer.toneMapping` switch (ACES → None → Reinhard → ACES) is followed by the `'RENDERER'` PiP on both backends.
  - Render pipeline cache size, textures and geometries stay flat over 60s and after the tone-mapping switches (no per-frame recompiles).
- r186 facts found while implementing (differ from or add to the plan):
  - `renderOutput()` already un-premultiplies, tone-maps / converts, and re-premultiplies (`RenderOutputNode.setup`), so the "premultiplied sRGB edges" risk does not apply.
  - `Renderer.currentSamples` is 0 for any `QuadMesh` drawn to screen (`fullscreenPass`), so the composite never loads the MSAA canvas attachment.
  - The renderer floors `viewport * pixelRatio`. The compositor snaps rects to whole device px and passes `(devicePx + 0.5) / pixelRatio`, so the floor lands exactly.
- Added beyond the plan: a rect partly outside the canvas is cropped (uv offset/scale uniforms on the quad) rather than squeezed or passed out-of-bounds to `setViewport`.
- Phase 1's `ViewportProps` holds only what Phase 1 implements (`rect` is required). `anchor`/`order`/`size`/`slotClass`/`interactive`/`sceneId`/`syncCameraAspect` and `setViewportInteractive`/`invalidateViewportLayout`/`getViewportPointerNDC` come in Phase 2.

### Phase 2 (layout and input plumbing): done

- Every viewport now owns a slot element, including explicit-`rect` ones: the slot is absolutely positioned in `px` or `%`, so the `%` math of Phase 1 is gone and every rect comes from the DOM the same way.
- The viewports layer (`#aekViewportsLayer`, `z-index: 1`, prepended to the HUD root, so below app windows at 100, loaders at 1000 and debug tools at 10000+) is created **lazily on the first `createViewport()`**, not in `HUD.ts`/`InitApp.ts`: with no viewports, nothing is added to the DOM.
- Corner stacks: `.aekViewportStack_<ANCHOR>` (global), inset `1.6rem`, gap `0.8rem`. Right anchors use `row-reverse`, so `order` always counts from the corner outwards (0 = in the corner) on both sides.
- Layout triggers (all set one dirty flag; all enabled slots are read together, so one forced layout per change):
  - create, delete, enable/disable, `invalidateViewportLayout()`
  - canvas size or pixel ratio change, found by the per-frame size compare (this also covers window resize, so there is no resize listener)
  - **added:** any `class` change on `<body>` (a `MutationObserver`), so rules like `.debugDrawerOpen …` that move or hide a slot without a transition still re-layout
  - every frame while a CSS transition runs anywhere in the layer (`transitionrun` / `transitionend` / `transitioncancel` bubble to the layer), plus one more frame after it ends. A transition that never reports its end stops being tracked after 3s without transition events.
- `getViewportPointerNDC` uses the full (uncropped) rect, returns whether the pointer is inside, and writes `out` either way.
- `syncCameraAspect` is applied right before the render, only when the camera or the rect aspect changed. Orthographic cameras keep their frustum height and centre.
- Verified (throwaway spike, WebGPU and WebGL2, pixel ratio 1 and 2):
  - `viewport.rect` matches the slot box in every state. The rendered PiP edge sits flush with its 1px slot outline at device resolution.
  - Two slots in the top-right stack are placed in `order`. Disabling the corner one moves the other into the corner.
  - A 0.6s `right` transition on the stack is tracked frame by frame (the mid-transition rect was one frame behind the DOM). The final rect is exact.
  - A media query hiding a slot on resize makes it render nothing. A partly off-canvas explicit rect is cropped.
  - Only the interactive slot is hit by `elementFromPoint`: the canvas gets everything else. Pointer NDC was exact (centre `0,0`, 5% corner `-0.9,0.9`).
  - A `sceneId` viewport is deleted on that scene's exit, and the global ones survive the scene change.

### Phase 3 (axes gizmo, display only): done

- Built on p105's declarative tab (landed before this phase), not the plan's `lsSetItem` pattern:
  - `axesGizmo` is a new top-level state key, and it is in `persistKeys`. Hydration still replaces a persisted key whole, so the top-level reasoning holds.
  - The two bindings are declarative, and user changes are persisted by the tab.
  - F8 goes through `DebugToolsManager.toggleAxesGizmo()` → `_toggleAxesGizmo()`, which uses `persistDebuggerTabValue` and `updateDebuggerTab`. A tab refresh never fires `onChange`, so the plan's "refresh re-emits change" concern is gone.
- Module loading: `registerAxesGizmoModule()` (the thin `debug/AxesGizmo.ts`) is awaited in InitApp's `IS_DEBUG_ENV` block. `_initDebugTools` calls `initAxesGizmo(state.axesGizmo)` after hydration.
- The visibility rule runs in a MAIN-stage system (`axesGizmoVisibilitySystem`), not in `onBeforeRender`: a disabled viewport gets no `onBeforeRender`, so it could never re-enable itself. Plugins apply to every ECS world, so the system only runs for the default world.
- Visuals:
  - The bubbles come from one `CanvasTexture` atlas row (+X +Y +Z −X −Y −Z). Each bubble is a quad whose uvs show its cell, and each has its own material, so its opacity can dim independently.
  - The bubbles are scene children placed along the rotated axes, so they always face the camera. The lines are cylinders under the rotated root.
  - The root follows the active camera's **world** quaternion, not the local one, because a gameplay camera can be parented.
- Drawer offset (`AxesGizmo.module.scss`) — additions to the plan:
  - The toggler got a global `debugDrawerToggler` class, so `body:not(.debugDrawerOpen):has(.debugDrawerToggler.TOP)` can clear it (`right: 4.6rem`). The `:not()` is needed because `:has()` would out-specify the open rule.
  - The gizmo is hidden while the drawer is open whenever the window is ≤ 650px. Below that, it can't sit left of the drawer and toggler without being cropped or covering the undo/redo tools. This covers both the `$drawerWidthSmall` and full-width drawer breakpoints.
- Phase 3 keeps the slot non-interactive. `interactive` while the debug camera is active comes with Phase 4's handlers, so the gizmo area doesn't swallow OrbitControls drags before it can use them.
- Verified on WebGPU and WebGL2 (identical results):
  - Hidden with the main camera by default; shown after F1. Existing `AEK_debugTools` saved state without `axesGizmo` got the defaults.
  - Bubble colours were sampled at the screen positions predicted from the active camera. The front ones are exact (`#ff3653` / `#8adb00` / `#2c8fff`) at the default view, after an orbit drag, and in the main camera.
  - Top view: X right, −Z up, −Y hidden behind +Y.
  - F8 toggles it and persists, and the open tab's checkbox follows. The gizmo is 10 draw calls when visible and 0 when hidden.
  - The drawer slide is tracked (mid-frame x = 784, then 454, which is 1000px − 44.6rem − 10rem). At 620px with the drawer open it is hidden. The TOP toggler moves it to x = 854.
  - "In main camera" follows the gameplay camera, and the canvas is still the element under it.
  - Both options survive a reload.
  - Production build: `_dbg__AxesGizmo` is its own 2.7 kB chunk (plus 0.4 kB CSS). The main chunk has only the core `Viewports.ts`.

### Phase 4 (axes gizmo interaction): done

- **Plan correction (Design decision 10, pole views):** the bottom view needs `theta = 0`, the same as the top view. `theta = π` gave X left and −Z up. Verified: the top view is X right, −Z up; the bottom view is X right, +Z up.
- Clickable = visible and the debug camera is active. The gizmo system drives `setViewportInteractive`. Losing clickability (F1, F8, or hidden) drops any press, drag and hover. The align animation is cancelled when the debug camera is no longer active.
- The gizmo system runs at `order: 1` in MAIN, so it runs before `debugCameraSystem` (order 0), whose `controls.update()` applies the animation step in the same frame. Panel refresh comes for free: `controls.update()` dispatches `'change'`, which already drives the Debug Tools panel refresh.
- The align animation is timed with `performance.now()`, not the loop delta. The loop delta is scaled by `playSpeedMultiplier`, and a debug camera move shouldn't crawl in slow motion. It uses a 250ms cubic ease-out over spherical `(phi, theta)`, with theta taking the shortest path.
- Only the polar target is clamped to `min/maxPolarAngle` (within `POLE_EPS = 1e-4`). Azimuth limits are left to OrbitControls' own `update()` clamp.
- The damping momentum (`_sphericalDelta`, `_panOffset`, not in the typings) is zeroed at animation start and drag start.
- Hover:
  - A second atlas with the same layout holds the hover variants: a lighter positive bubble, and a filled, labelled "−X"-style negative one. Hover swaps each bubble's idle/hover material.
  - The backdrop is a translucent disc shown on `pointerenter`.
  - The cursor is `pointer` over a bubble and `grabbing` while dragging.
- Drag handshake: `setDebugCameraControlsSuspended()` in `_dbg__DebugCamera.ts`. `debugCameraSystem` writes `enabled = !isDisabled && !isControlsSuspended`.
- `CLICK_MAX_MOVE_PX` is exported from `MouseInput.ts` and reused.
- Verified on WebGPU and WebGL2 (identical results):
  - Debug camera: the slot is interactive and is the element under the gizmo.
  - Clicking +X animates (mid-frame direction `-0.97, -0.21, -0.13`), ends looking along −X from `(4.5, 0, 0)` with the orbit distance kept, and saves to `AEK_debugCams`. A second click flips to `(-4.5, 0, 0)`. +Y, +Z and −Y all align exactly.
  - A 100px drag on the gizmo, continuing outside it under pointer capture, turned the azimuth by −0.897 rad (OrbitControls' speed predicts −0.898) with no elevation change. So OrbitControls did not rotate as well, and it worked again right after.
  - Wheel over the gizmo leaves the distance unchanged. A canvas drag during an align cancels it.
  - The pose survives a reload.

### Phase 5 (docs and version): done

- `.claude/CLAUDE.md` has a "Viewports" section under Architecture.
- **No version bump.** This branch already carries an engine major bump (`2.0.0` "Morning", from `main`'s `1.2.0`). The rule is one bump per branch, at the level of the biggest change, so this minor feature is covered by it. The app side is unchanged: the throwaway spike in `src/index.ts`, committed in Phases 1–3, was removed here, which restores the file to its pre-plan state.
- The `Blocks` / `Blocked by` links to p115 are removed (p115 is now blocked only by p111). The p110, p115 and p130 references point to the `_DONE_` file.
- How the final file list differs from "Files touched":
  - `HUD.ts` / `InitApp.ts` do not create the viewports layer: it is created by the first `createViewport()`. `InitApp.ts` only awaits `registerAxesGizmoModule()`.
  - Also touched: `core/Debug/_dbg__DebuggerGUI.ts` (a global `debugDrawerToggler` class on the drawer toggler, for the TOP-position rule) and `debug/DebugToolsManager.ts` (`toggleAxesGizmo()` for F8, plus the state type and defaults).
  - `package.json` is unchanged (see above).
