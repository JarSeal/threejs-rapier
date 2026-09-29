Status: draft | not-implemented
Category: Debugger, Rendering, Multi-viewport
Blocked by: p111_skybox-core-refactor-and-layered-schema.md (`getActiveEnvironmentTexture`, `onSkyBoxChange`)
Related: p110_skybox-refactor-and-layered-sky-system.md (epic), \_DONE_p080_multi-viewport-rendering-and-axis-gizmo.md (implemented: Viewports API + axes gizmo), \_DONE_p105_refactor-debugger-drawer-tab-creation.md (landed: the Debug Tools tab is a `createDebuggerTab` with pane-builder bindings and `persistKeys`)

# Debug Environment Ball Viewport — Plan

This adds a debug-only **environment ball** to the top-right corner, to the left of the p080 axes gizmo. It is a reflective sphere showing the current environment map: the actual PMREM that PBR materials sample, not the background. Like the gizmo, it moves left when the debugger drawer opens and follows the active camera's rotation.

It has its own "Environment ball" section in the Debug Tools Controls tab, directly under the axes section:

- "Show environment ball" (F7)
- "Show env ball in main camera"
- "Env ball roughness"

It replaces the env ball that the pre-ECS code once had and that now only survives as commented-out code, which p111 removes.

## Context (grounded in code)

- **p080 provides the viewport API and the layout.**
  - `createViewport(props)` renders a private scene into its own target and composites it over the frame after the main render, with PostFX on or off and on both backends (p080 DD1–2).
  - Corner stacks: `anchor: 'TOP_RIGHT'` plus `order`, where **order 0 is the rightmost**. The gizmo uses `order: 0` (p080 DD4, DD8).
  - A single SCSS rule shifts the whole top-right stack when the drawer opens (`.debugDrawerOpen .aekViewportStack_TOP_RIGHT`, p080 DD9). **Any viewport in that stack moves with the drawer for free.**
  - `toneMapping: 'RENDERER'` matches the main view (p080 DD3).
  - The visibility rule and the Debug Tools state pattern: a new **top-level** key, because `persistKeys` persists and hydrates top-level keys whole (`_dbg__DebugTools.ts:117`; p080 DD12).
- **p111 provides the environment.** `getActiveEnvironmentTexture()` returns the PMREM texture in use: a texture PMREM from `getPMREMTexture`, or the p112 bake target. `onSkyBoxChange(id, fn)` fires on activation, clear and structural rebuilds.
- **PMREM facts (three r186).**
  - `pmremTexture(tex, uv, level)` samples a CubeUV texture directly (`PMREMNode.js:299-301`).
  - Setting `.value` swaps the texture without a material rebuild (`PMREMNode.js:256-260`).
  - `reflectVector` is the world-space reflection (`accessors/ReflectVector.js:28`).
  - `materialEnvRotation` uses `material.envMapRotation` when the scene has no environment (`MaterialProperties.js:35-48`). That is the case for the private ball scene.
- **Debug Tools tab** (`core/Debug/_dbg__DebugTools.ts`).
  - The Helpers folder starts at `:424`: "Show axes helper" at `:434-439`, then "Axes helper size" at `:440-449`, then a separator, then the grid helper.
  - p080 inserts "Show axes gizmo [F8]" and "Show axes gizmo in main camera" **above** "Show axes helper". The "axis section" is therefore those four bindings.
  - Per `_DONE_p061`, Helpers-folder controls are `[COSMETIC]` and not undo-recorded.
- **Keys.** F7 is free (only F1 is bound today, `core/Input/DefaultDebugKeyBindings.ts:37`) and reserved for this ball by p080.

## Design decisions

1. **One debug viewport.**
   - Entry point: `src/_engine/debug/EnvBall.ts`, a thin `IS_DEBUG_ENV` entry (`initEnvBall`, `setEnvBallVisible`, `setEnvBallInMainCamera`, `setEnvBallRoughness`).
   - Implementation: `src/_engine/core/Debug/_dbg__EnvBall.ts`, with styles in `EnvBall.module.scss`.
   - It is initialized from `_initDebugTools` right after the axes gizmo.
   - `createViewport` props:
     - `id: 'envBall'`, `anchor: 'TOP_RIGHT'`, `order: 1` (directly left of the gizmo);
     - `size: 7rem × 7rem` (6rem below `$breakpointSmall`);
     - `slotClass` centres it vertically against the 10rem gizmo;
     - `transparent: true`, `toneMapping: 'RENDERER'`, `interactive: false`.
   - When the gizmo is hidden, flex layout moves the ball into the corner by itself.
2. **The ball scene.**
   - A private `THREE.Scene` holding one `SphereGeometry(1, 64, 32)` with an **unlit** `MeshBasicNodeMaterial`:
     - `colorNode = pmremTexture(envTex, reflectVector, uRoughness)`;
     - `uRoughness` is a `uniform(0)` driven by "Env ball roughness".
   - Unlit on purpose: it shows the environment map exactly, independent of lights, at any roughness from mirror (0) to fully diffuse (1).
   - The camera is a `PerspectiveCamera(25°)` at a fixed distance. `onBeforeRender` copies the **quaternion** of `getActiveCamera()` into it, so the ball shows what the main camera would see reflected.
   - `material.envMapRotation` is copied from the active skybox's `environmentRotation` on every `onSkyBoxChange`, so a rotated skybox reflects correctly.
3. **Environment swap.**
   - On `onSkyBoxChange`, set `pmremNode.value = getActiveEnvironmentTexture()`. There is no rebuild, because PMREMNode resets its internal PMREM on `value` set.
   - With no environment (no skybox, or a COLOR base without layers), the viewport is disabled.
   - A p112 dynamic re-bake writes into the same target, so the ball updates live with no extra wiring.
4. **Visibility rule**, evaluated in `onBeforeRender` (a per-frame boolean compare; the slot changes only on transitions):
   - `visible = envBall.show && hasEnvironment && (isDebugCameraActive() || envBall.showInMainCamera)`.
   - When not visible, the viewport is disabled and costs no GPU time.
5. **Debug Tools state, options and shortcut.**

   - **State:** a new top-level `envBall: { show: boolean; showInMainCamera: boolean; roughness: number }`, default `{ show: true, showInMainCamera: false, roughness: 0 }`. It goes in the `DebugToolsState` type, in both default objects (`debug/DebugToolsManager.ts`, `core/Debug/_dbg__DebugTools.ts`) and in the tab's `persistKeys` (`_dbg__DebugTools.ts:117`, next to `axesGizmo`). p111 has already removed the dead `env` block.
   - **Bindings.** In the "Helpers" folder, a separator plus three pane-builder bindings **after "Axes helper size"** and before the grid-helper separator, forming the section directly under the axes section:

     - "Show environment ball [F7]" (boolean)
     - "Show env ball in main camera" (boolean)
     - "Env ball roughness" (slider 0–1, step 0.01)

     They use one-level `key` paths (`'envBall.show'`, …), like the `axesGizmo.*` bindings (`_dbg__DebugTools.ts:428-436`). Each `onChange` calls the matching `EnvBall.ts` setter; the tab persists the value itself. They are cosmetic, so there is no undo (per `_DONE_p061`).

   - **Shortcut.** A `DEFAULT_DEBUG_KEY_BINDINGS` entry: `id: 'sc-toggle-env-ball'`, `KEY_DOWN`, `chord: { key: 'F7' }`, `preventDefault`, and the same `repeat` / `isTypingInField` guard as F1 and F8.
     - It flips `envBall.show`, then calls `persistDebuggerTabValue(TAB_ID, 'envBall')` and `updateDebuggerTab(TAB_ID)`, exactly like `_toggleAxesGizmo` (`_dbg__DebugTools.ts:137-143`).
     - It can be rebound through `AppConfig.debugKeys`.

6. **Drawer offset.** Nothing new is needed: p080's `.aekViewportStack_TOP_RIGHT` rule moves the stack, including the ball, and its breakpoint rules (hidden below `$breakpointSmall` while the drawer is open) apply to the whole stack.

## Files touched

| File                                                                                   | Change                                                            |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/_engine/debug/EnvBall.ts` (new)                                                   | Thin `IS_DEBUG_ENV` entry                                         |
| `src/_engine/core/Debug/_dbg__EnvBall.ts` (new)                                        | Viewport, scene, material, visibility, skybox listener            |
| `src/_engine/core/Debug/EnvBall.module.scss` (new)                                     | Slot size and vertical alignment, small breakpoint                |
| `src/_engine/debug/DebugToolsManager.ts`, `src/_engine/core/Debug/_dbg__DebugTools.ts` | `envBall` state, three bindings under the axes section, init call |
| `src/_engine/core/Input/DefaultDebugKeyBindings.ts`                                    | F7 binding                                                        |
| `package.json`                                                                         | Engine minor                                                      |

## Phases

Each phase compiles, lints and leaves the app working.

1. **The ball.** Viewport, scene, material, environment swap, visibility rule, `envBall` state and the three bindings.
   - Verify:
     - The ball appears left of the gizmo in the debug camera.
     - It shows the skybox's environment, rotating with the view.
     - Roughness 0 → 1 blurs it smoothly.
     - Switching skyboxes (including "[No skybox]") updates or hides it.
     - It survives a reload, and existing `AEK_debugTools` users get the defaults.
2. **Shortcut + polish + docs.** F7, the pane refresh, and the drawer and breakpoint checks.
   - Verify:
     - F7 toggles it and the checkbox follows.
     - Opening the drawer with `h` slides the ball and the gizmo together, at both drawer widths and both toggler positions.
     - With "in main camera" off, it is hidden in the main camera; with it on, it is visible and ignores the pointer.
     - With p112 or p113 present, the ball updates live while the day-night cycle re-bakes.
   - Then update CLAUDE.md's debug paragraph (one line) and bump the engine minor version.

## Non-goals

- A lit, material-preview ball (metal and dielectric pair, light probes). It is a possible follow-up; the unlit ball shows the environment itself.
- Showing the _background_ (for example, a sharp starfield) instead of the environment.
- Interaction: clicking the ball does nothing.
- A ball in production builds. It is debug-only and tree-shaken out.

## Risks / open questions

| Risk                                                                                                                 | Mitigation                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p080's compositor gate falls back to option (b) or (c) (CanvasTarget, or 2D-canvas gizmo only)                       | (b) keeps this design on WebGPU, and WebGL2 gets no ball. With (c) the ball needs its own overlay approach; re-plan then.                                                                     |
| `envMapRotation` is not applied to an unlit material's explicit `pmremTexture`                                       | PMREMNode always multiplies by `materialEnvRotation` (`PMREMNode.js:346-348`). Verify with a rotated cube skybox in Phase 1. If it is missing, rotate `reflectVector` with a uniform instead. |
| The ball reflects the environment, so its content changes if p112 leaves the disc out of the bake (sun with a light) | Intended: the ball shows what PBR materials actually reflect. Documented in the tooltip.                                                                                                      |

## Verification

- `yarn lint` and `yarn build` after each phase.
- `yarn dev`, `?isDebug=true`, driven with the `run-aekasha-js` skill: `scene01_v2` with all its skyboxes, and the p113 showcase scene if present. Run it on WebGPU and WebGL2, with PostFX on and off, at pixel ratios 1 and 2.
- Production build (`dist-stats/bundle-stats.html`): `_dbg__EnvBall` is not in the main chunk.
