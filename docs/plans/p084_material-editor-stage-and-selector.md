Status: in progress | Phase 1 implemented
Category: Editor-Creator View, Materials
Blocks: p085_material-editor-params-and-persistence.md
Related: \_DONE_p083_editor-creator-view.md (epic), `createDebuggerTab` (p105, implemented: the right drawer reuses its declarative tabs), the layered sky box (p111, implemented: skybox environments in the editor can now build on it, still a non-goal here), the debug environment ball (`debug/EnvBall.ts`, p115, implemented: same "ball + environment" idea for the scene)

# Material Editor — Stage, Camera and Material Selector

The first editor view of the p083 epic. It registers a `materialEditor` view (the **Material editor** button with its `material` icon, right of the **Runtime** button in the view tools group) with:

- a **stage**: one ball in the middle, lit by the editor's own lights and environment (the scene's skybox and lights are not used);
- its **own camera** with OrbitControls, a default pose, and a pose remembered per material;
- a **bottom drawer**: every project material, with a filter by id and name, and room for preview images later;
- a **right drawer** with a **Params** and a **Settings** tab, built like the scene debugger drawer. This plan builds the drawer and a read-only info section; p085 fills in the editable params and settings.

In this plan the editor is a viewer: clicking a material shows it on the ball. After a refresh the editor comes back as it was: view, material, camera, drawers, tab, filter and scroll positions.

## Context (grounded in code)

- **Project materials** are the `*.material.json` files, gathered into `getGeneratedAppData().materials`, keyed by id, with `__sourcePath` (`devTools/gatherAppData.ts:417-495`). Current files: `src/toolkit/materials/` (`checkerBoard`, `triplanarGrid`, `triplanarCheckerboard`) and `src/app/materials/` (`testMaterial`, `testTslMat`).
  - A TSL material's graph functions are in `tslMaterialFileObjects` (`generatedAppFns.ts`). With `NODE_ENV=production` (`yarn build`, `yarn build:test`), they are only emitted for materials that some scene references (`gatherAppData.ts:452`). In `yarn dev` every material has them.
- **`createMaterial(props)`** (`core/Material.ts:204-470`):
  - An `id` that is already registered returns the registered instance (`:207-210`). An editor copy therefore needs its own id.
  - `tslMaterialId` (`:328-330`) picks the TSL registry entry independently of `id`, so a copy with another id can still use the original's graph.
  - Texture ids in `params` and in TSL node inputs are resolved with `getTexture(id)` at creation (`:223-237`, `:383-393`). A texture that isn't loaded is stripped (params) or turned into an empty texture node (TSL). The editor must load the textures first: `loadTextureAsync(generatedAppData.textures[id])` (`core/Texture.ts:412`), like `SceneLoader.loadNextSceneAssets` does (`SceneLoader.ts:240-315`).
  - It throws on bad TSL inputs or a missing TSL registry entry.
  - TSL inputs are kept in `mat.userData.uniforms[`${socket}_${input}`]` (`:449-451`); p085 binds to them.
  - `deleteMaterial(id)` (`:577`) disposes a material without its textures.
- **Asset owners** (`core/Assets/AssetOwners.ts`): textures loaded or taken from the cache are tagged to the current scene. So a texture only the editor uses is released when that scene is left. Fine, because the editor's copy only lives while the view is active (DD3).
- **The scene debugger drawer** (`core/Debug/_dbg__DebuggerGUI.ts`) is a module singleton: `buildTabContent(def)` (`:127`), `mountTab` (`:216-240`), `refreshMountedTab` (`:242-252`), drawer state in `AEK_debugDrawerState`. `hydrateDebuggerTabState` (`debug/DebuggerGUI.ts`) restores a tab's `persistKeys`. The pane builder (`_dbg__DebuggerPaneBuilder.ts:71`) takes a tab def and a pane section and doesn't depend on the drawer.
- **Drawer sizes** (`DebuggerGUI.module.scss:4-36`): `$drawerWidth` 40rem, 30rem at `$breakpointSmall`, 100% at `$breakpointXSmall`; `z-index: 10200`. The stats container is bottom-left at `z-index: 10000` (`styles/index.scss:44-59`); on-screen tool groups are also 10000.
- **Debug camera pattern** (`Debug/Camera/_dbg__DebugCamera.ts:14-86`): default props, pose applied on attach, saved to LS on the OrbitControls `end` event.
- **The debug toaster** (`DEBUG_TOASTER_ID`, `_dbg__UndoRedo.ts:209-221` shows the `addToast` pattern) for load errors.

## Layout

```
┌──────────────────────────────────────────────────────────────┬───────────────┐
│ [↶][↷]       [runtime][material] [∞][⏸]              (gizmo) │ MATERIAL  ✕   │
│                                                              │ testTslMat    │
│                                                              │ [Params][Set.]│
│                          ( ball )                            │               │
│                                                              │  (tab content)│
│                                                              │               │
├──────────────────────────────────────────────────────────────┤               │
│ Materials  12/14  [filter: id or name____]              [▾]  │               │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐      │               │
│ │ ▢  │ │ ▢  │ │ ▢  │ │ ▢  │ │ ▢  │ │ ▢  │ │ ▢  │ │ ▢  │      │               │
│ │name│ │name│ │name│ │name│ │name│ │name│ │name│ │name│      │               │
└──────────────────────────────────────────────────────────────┴───────────────┘
 (stats panel, when shown, sits under the materials drawer)
```

## Design decisions

1. **Files and registration.**
   - `src/_engine/debug/MaterialEditor.ts`: thin `IS_DEBUG_ENV` entry (`registerMaterialEditor()`), loading the implementation with `loadDebugModuleAsync`.
   - `src/_engine/core/Debug/Editors/Material/`:
     - `_dbg__MaterialEditor.ts`: the view definition, stage, camera, material loading
     - `_dbg__MaterialEditorSelector.ts`: the bottom drawer
     - `_dbg__MaterialEditorTabs.ts`: the right drawer's tab definitions (info only here; p085 adds the rest)
     - `MaterialEditor.module.scss`
   - `src/_engine/core/Debug/Editors/_dbg__EditorDrawer.ts` (+ SCSS): the right drawer, written for reuse by later editors (DD6).
   - `registerMaterialEditor()` is called in `InitApp.ts`'s `IS_DEBUG_ENV` block, after `registerDebuggerGUI()` and `registerAxesGizmoModule()`, so it is registered before p083 restores the saved view.
   - The view def: `id: 'materialEditor'`, `title: 'Material editor'` (the button's tooltip and the switch toast, p083 DD6), `icon: 'material'`, `orderNr: 0` (the first editor, right after Runtime).
   - **The Material editor icon** (`material`, `core/UI/icons/svg/material-sphere.svg`, registered in `core/UI/icons/SvgIcon.ts`): a material preview ball, the subject of the editor (p083 DD6's icon rules). An outlined sphere, lit from the upper left: a solid crescent of core shadow on the lower right and a short specular arc in the lit part. The arc instead of a highlight dot keeps it from reading as an eye at 16 px, and it is a shaded sphere, not the `geometry` cube or the `texture` image, so it doesn't look like an asset type.
     ```svg
     <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-material-sphere" viewBox="0 0 16 16">
       <circle cx="8" cy="8" r="6.45" fill="none" stroke="currentColor" stroke-width="1.1"/>
       <path d="M11.04 2.25A6.5 6.5 0 1 1 2.25 11.04 6.3 6.3 0 0 0 11.04 2.25"/>
       <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" d="M4.3 6.6a3.4 3.4 0 0 1 2.3-2.3"/>
     </svg>
     ```
     The crescent is the sphere (centre 8,8, r 6.5) minus a circle moved up-left (centre 5.9,5.9, r 6.3); its two arcs meet at (11.04, 2.25) and (2.25, 11.04).
2. **The stage** (a private `THREE.Scene`, created on the first enter and kept while the view is registered).
   - **Preview object**: a `SphereGeometry(1, 128, 64)` mesh at the origin (UVs for textured materials).
     - Non-mesh material types get a fitting object: `POINTS` → `Points` on the same sphere geometry; `LINEBASIC`/`LINEDASHED` → `LineSegments` of its `WireframeGeometry` (plus `computeLineDistances()` for dashes); `SPRITE` → a `Sprite`.
     - `SHADOW`, `DEPTH`, `DISTANCE`, `SHADER`, `SHADERRAW` show a centred "Preview not supported for <type>" notice instead of the ball (`SHADER`/`SHADERRAW` don't work on WebGPU at all).
   - **Lights**: a `HemisphereLight` (low), a key `DirectionalLight` from the upper front left and a weaker fill from the right, fixed to the stage (not to the camera). Values are constants in this plan; p085 exposes them.
   - **Environment**: a neutral studio environment, the PMREM of three's `RoomEnvironment` (`PMREMGenerator.fromScene(new RoomEnvironment(), 0.04)`), set as `scene.environment`. **Background**: a solid neutral grey. (Phase 1 checks that `fromScene` works on both backends; if not, fall back to an equirect gradient texture run through the renderer's own PMREM path.)
   - Using a skybox asset as the editor environment is a follow-up (see Non-goals; p111's layered sky box has landed). The scene's `SkyBox.ts` state is never touched: the root scene keeps its background and environment while it is suspended.
3. **Loading a material into the editor** (`loadEditorMaterial(id)`).
   - Look up the asset in `getGeneratedAppData().materials`.
   - Load its missing textures (`params` texture keys, and TSL string inputs not starting with `#`) with `loadTextureAsync` from `generatedAppData.textures`.
   - Merge the per-material overrides (an empty hook here; p085 fills it).
   - Create an **editor copy**: `createMaterial({ ...asset, params: { ...params }, id: '__matEditor__' + id, tslMaterialId: asset.id })`. The scene's instance of the same material (if any) is never used or changed. This was chosen over live-editing the scene material; how edits reach scenes and JSON is the later "save" plan's job.
   - Swap it onto the preview object and `deleteMaterial` the previous copy (textures stay with the registry and the asset owners).
   - Apply the material's saved camera pose, or the default one (DD4).
   - Update the selector's selected card, the right drawer's title and tabs, and persist `selectedMaterialId`.
   - Fast clicking: each load gets a token, and a load that finishes after a newer one started is discarded (its copy deleted).
   - **Errors** (createMaterial throws, a TSL entry is missing): show a debug toast, mark the card as failed, and show an error material (flat magenta `MeshBasicNodeMaterial`) on the ball.
   - **Unavailable** materials (a TSL material without a `tslMaterialFileObjects` entry, ie. a production-gathered build) are listed but disabled, with the reason in the tooltip.
   - On view exit the copy is deleted; on enter it is created again from `selectedMaterialId`. So nothing the editor holds can outlive a scene switch that released its textures.
4. **Editor camera.**
   - Built with p083's `createViewCamera` (p083 DD7, `core/Debug/Editors/_dbg__ViewCamera.ts`), which every editor view shares. It provides the camera with its OrbitControls (enabled only while the view is active, not an ECS entity), `controls.update()` in `mainUpdate` unless the gizmo suspended the controls, the aspect resizer, and the `ViewCameraRig` the axes gizmo follows, aligns and orbits. This plan only configures it: `viewId: 'materialEditor'`, fov 45, near 0.01, far 100.
   - **Default pose**: position `(0, 0.4, 3.2)`, target `(0, 0, 0)` (the ball fills about half the height).
   - **Per-material pose**: the pose key is the material id (`setPoseKey(materialId)` in `loadEditorMaterial`). The editor passes a `store` that saves the pose into that material's editor record `AEK_debugMatEditorMat_<id>` as `camera: { position, target, fov }`, so p085's clear button clears it with the rest. Loading a material applies its pose, or the default when it has none. With no material selected (`setPoseKey(null)`), the pose is the view's own pose in the helper's default store (`AEK_debugViewCams`).
   - "The camera data is kept in the material's debug data" is implemented as this per-material LS record. The JSON `debugData` is not written in this epic; saving to JSON is the later save plan.
5. **The material selector (bottom drawer).**
   - Fixed to the bottom, from the left edge to the right edge of the canvas, `z-index: 10100`: above the stats panel and on-screen tools (so a shown stats panel is under it), below the right drawer (10200) and the toaster.
   - **Header row** (always visible): "Materials", the count (`shown / total`), the filter input, and a collapse button. Collapsed, only the header row shows; the open state is persisted.
   - **Body** (open height `15rem`, scrolls vertically): a CSS grid `repeat(auto-fill, minmax(11rem, 1fr))`, so it reflows to any width.
   - **Card**:
     - a square **preview slot** (`.matEditorPreviewSlot`), reserved for the future thumbnails. For now it shows a swatch of the material's first colour (`params.color`, else the first `#` input of a TSL node) or the type's initials;
     - the name (`debugData.name` or the id), the id in small monospace, and a type badge;
     - `title`: the source path and the description.
     - Classes: `selected`, `unavailable`, `failed`.
   - Sorted by name, then id.
   - **Filter**: a case-insensitive substring match on id and name, applied as you type; `Escape` in the input clears it. The text is persisted. It is written as a list of matcher functions, so later criteria (type, source folder, tags) are one more matcher. The input is a normal text field, so `isTypingInField()` already keeps the key bindings out of it.
   - **Responsive with the right drawer**: while the right drawer is open (`debugDrawerOpen`), the selector's right edge moves to the drawer's left edge, with the drawer's own breakpoints: `right: $drawerWidth`, `$drawerWidthSmall` at `$breakpointSmall`, and at `$breakpointXSmall` (full-width drawer) it stays full width under the drawer. The same `0.2s` transition as the drawer. The grid reflows to the remaining width, so no card is cut off.
6. **The right drawer** (`_dbg__EditorDrawer.ts`).
   - `createEditorDrawer({ id, lsKey, headingLabel, getTitle, getTabs })` returns `{ cmp, toggle(open?), isOpen(), rebuild(), refresh() }`. An instance, not a singleton, so later editors get their own.
   - It looks like the scene debugger drawer (same widths, toggler button, heading row with a title and a close button, tab menu, scrolling tab container) by reusing `DebuggerGUI.module.scss`. The toggler reads "Material".
   - Tabs are ordinary `DebuggerTabDef`s: the content is built with the scene drawer's own `buildTabContent` (exported from `_dbg__DebuggerGUI.ts` as `_buildDebuggerTabContent`), so panes, lists, `lsKey` clear buttons, `onRefresh`/`onOpen`/`refreshIntervalMs`, and folder persistence (`uiLsKey`) work the same. `hydrateDebuggerTabState` is exported from `debug/DebuggerGUI.ts` for it.
   - `getTabs()` is called again on `rebuild()`, because the tabs are per material (their `lsKey` is the material's record, see p085). A material load calls `rebuild()`.
   - Open state, current tab id and scroll position per tab are persisted (DD8).
   - Opening it sets `debugDrawerOpen` on `<body>` (the broadened meaning from p083), so the top row, the gizmo and the selector shift with it. `h` toggles it (the view's `toggleDrawer`).
   - The scene drawer isn't refactored into instances here: that is a larger change to the most-used debug UI. Unifying the two is a candidate follow-up once a second editor exists.
   - In this plan the tabs are **Params** (a read-only "Material" section: id, name, type, source path, description, TSL file, and the texture ids it uses) and **Settings** ("Reset camera to default", and the camera's pose as read-only values). p085 adds the editable content.
7. **Pause and play.** `update(delta)` (p083 DD5) drives an optional slow auto-rotation of the preview object (p085 exposes it; off by default), so the pause button has something to pause. TSL materials that animate with the wall-clock `time` node keep moving, as in the scene.
8. **Editor UI state** (LS `AEK_debugMatEditorUI`, written on each change, read on first enter):
   - `selectedMaterialId` (the camera pose without a material is in `AEK_debugViewCams`, DD4)
   - `selector: { isOpen, filterText, scrollTop }`
   - `drawer: { isOpen, currentTabId, scrollPos: Record<tabId, number> }`
   - With p083's saved view, a refresh returns to the editor with the same material, camera pose, drawers, tab, filter and scroll positions. A `selectedMaterialId` that no longer exists is dropped.

## Files touched

| File                                                                              | Change                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/_engine/debug/MaterialEditor.ts` (new)                                       | Thin debug entry                                                                     |
| `src/_engine/core/Debug/Editors/Material/_dbg__MaterialEditor.ts` (new)           | View def, stage, `createViewCamera` config and store, `loadEditorMaterial`, UI state |
| `src/_engine/core/Debug/Editors/Material/_dbg__MaterialEditorSelector.ts` (new)   | Bottom drawer: header, filter, grid, cards                                           |
| `src/_engine/core/Debug/Editors/Material/_dbg__MaterialEditorTabs.ts` (new)       | Params/Settings tab defs (info + camera reset here)                                  |
| `src/_engine/core/Debug/Editors/Material/MaterialEditor.module.scss` (new)        | Selector layout, cards, responsive offsets, notice                                   |
| `src/_engine/core/Debug/Editors/_dbg__EditorDrawer.ts` (new)                      | Reusable right drawer instance                                                       |
| `src/_engine/core/Debug/_dbg__DebuggerGUI.ts`, `src/_engine/debug/DebuggerGUI.ts` | Export `_buildDebuggerTabContent`, `hydrateDebuggerTabState`                         |
| `src/_engine/core/UI/icons/SvgIcon.ts`, `icons/svg/material-sphere.svg` (new)     | `material` icon (DD1)                                                                |
| `src/_engine/InitApp.ts`                                                          | `registerMaterialEditor()` in the debug block                                        |
| `.claude/CLAUDE.md`                                                               | One line under the "Views" paragraph: the material editor and where it lives         |

## Phases

Each phase compiles, lints and leaves the app working.

1. **View, stage and camera.** — done. Register the view with its title and the `material` icon (the view tools group appears, Runtime + Material editor), the stage (ball, lights, studio environment, background), the camera rig with the default pose, and `loadEditorMaterial` hard-wired to the first material. Check the `RoomEnvironment` PMREM on WebGPU and on WebGL2 (`forceWebGL`) and record the outcome in the Implementation notes.
2. **Material selector.** Bottom drawer, cards, filter, click to load, texture loading, the load token, errors and unavailable materials, non-mesh preview objects.
3. **Right drawer.** `_dbg__EditorDrawer.ts`, the two tabs with their info content, the `debugDrawerOpen` shift, `h`, and the selector's responsive offsets.
4. **Persistence.** Per-material camera pose, UI state, and restore on refresh.

## Non-goals

- Editable params and editor settings, per-material clear-LS, undo/redo (p085).
- Preview thumbnails in the selector (the slot is reserved).
- Skybox assets as the editor environment (p111 has landed, so this is unblocked), HDR/EXR environment files.
- Other preview shapes (cube, plane, torus knot), several balls side by side, comparing two materials.
- Creating a new material, duplicating one, or saving anything to JSON.
- Materials created only in code (not in a `*.material.json`).
- Refactoring the scene debugger drawer into drawer instances.

## Risks / open questions

| Risk                                                                                                                                      | Mitigation                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PMREMGenerator.fromScene(RoomEnvironment)` misbehaves on one backend                                                                     | Phase 1 checks both backends, with an equirect gradient fallback (DD2).                                                    |
| TSL graphs written for a specific mesh (instancing, custom attributes, world-space inputs set by scene code) look wrong on a plain sphere | Expected for a viewer; the preview shows what the material does on its own. The error path covers graphs that throw.       |
| TSL materials not referenced by a scene have no graph in production-gathered builds (`yarn build:test`)                                   | Listed as unavailable with the reason (DD3). The editor is meant for `yarn dev`.                                           |
| The editor copy is registered in the material registry while it exists (`__matEditor__` prefix)                                           | Only while the view is active. Anything that lists the registry can skip the prefix (a constant exported with the editor). |
| The selector and the right drawer both listen to `debugDrawerOpen`, which the scene drawer also sets                                      | p083 removes it on enter and restores it on exit, so only the editor drawer drives it inside the view.                     |

## Verification

- `yarn lint` and `yarn build` pass (the Stop hook also runs them).
- `yarn dev`, `?isDebug=true`:
  - The view tools group shows **Runtime** and **Material editor** (titles on hover, the active one highlighted). The Material editor button switches to the editor: grey background, the ball, no scene objects, no skybox; the Runtime button switches back to the unchanged, resumed scene. Each switch shows its toast. The `material` icon is crisp at 16 px and doesn't read as an eye.
  - Every material in the selector loads: `testMaterial` (PHONG), `testTslMat` (TSL with a texture), the three toolkit materials. A material the current scene doesn't use still loads its textures.
  - The filter narrows by id and by name, the count updates, `Escape` clears it, and `h`/`F10` don't fire while typing.
  - With the right drawer open, the selector's cards all stay visible at each breakpoint (resize from wide to `$breakpointXSmall`). With the stats panel on, it sits under the selector.
  - Orbit the camera on two materials, switch between them, and each keeps its own pose; a material with no saved pose uses the default; "Reset camera" works. The gizmo follows and aligns the editor camera.
  - Refresh with the editor open: same view, material, camera pose, drawers, tab, filter and scroll positions.
  - Leave the editor, switch to another scene, come back: the material reloads without warnings about missing or disposed textures.
  - Both backends (Renderer tab `forceWebGL`).
- Production build: `_dbg__MaterialEditor*` and `_dbg__EditorDrawer` are not in the main chunk.
- Use the `run-aekasha-js` skill for screenshots of the editor with the drawer closed and open, at a wide and a narrow width.

## Implementation notes

### Phase 1

- **Code drift since the plan.**
  - Line numbers moved: the material gathering is `gatherAppData.ts:604-682` (the production gate `:637`), `deleteMaterial` is `Material.ts:674`, `loadTextureAsync` `Texture.ts:447`, `loadNextSceneAssets` `SceneLoader.ts:248-339`.
  - There are six project materials: the toolkit's `asteroid` is new.
  - The scene drawer no longer has its own `buildTabContent` / `mountTab` / `refreshMountedTab`: it mounts tabs through `createTabHost` (`core/Debug/_dbg__TabHost.ts`, from the profiler work), which doesn't depend on its owner and is also used by the profiler window. Phase 3's editor drawer gets a host of its own, so `_buildDebuggerTabContent` isn't exported. `hydrateDebuggerTabState` is already exported.
  - Scene asset release (`core/Assets/SceneAssetRelease.ts`) deletes the non-persistent materials with ref count 0 that the scene being left owns. The editor copy is one of them (nothing refs it, and it is tagged to the current scene), so a scene loaded while the view is active (app code, HMR) would dispose it under the ball.
  - The on-screen, toast and window icon rules set `svg path { fill }`, which fills DD1's stroked specular arc (p083 Phase 2 hit the same with the `runtime` icon).
- **As built.**
  - The `material` icon has DD1's geometry as filled shapes: the outline is an even-odd ring (r 7 / 5.9), the arc a filled outline of the 1.1 stroke with round ends.
  - The editor copy is created with `isPersistent: true`, so a scene release skips it; `deleteMaterial` still removes it. While it exists, its textures count as used (`isTextureUsedByAnyMaterial`).
  - `loadEditorMaterial` deletes the previous copy right before creating the new one, in the same task (no frame in between): `createMaterial` returns an id that is already registered, so reloading the same material would otherwise get the old copy back.
  - Default pose `(0, 0.6, 4.8)`: DD4's `(0, 0.4, 3.2)` at fov 45 makes the ball fill about 75% of the height, not half.
  - Stage constants: background `0x5a5a5a` (renders about `#434343`), hemisphere `0xffffff` / `0x606060` at 0.7, key light 2 at `(-3, 4, 4)`, fill 0.6 at `(4, 1, 1)`. A lower hemisphere left the side away from the key light black on non-PBR materials (Phong ignores the environment).
  - The stage scene and the ball are created at registration (no GPU work). The environment and the view camera are created on the first enter, since they need the renderer and the canvas. The PMREM generator and the `RoomEnvironment` are disposed after the bake.
  - `stageSettings.autoRotateSpeed` (0) drives `update`; p085 exposes it.
  - This phase shows the first material in the generated data (`testMaterial`).
- **Verified** (`yarn dev`, `?isDebug=true`, SwiftShader WebGL2 on WSL2, Playwright clicking the view buttons):
  - The view group shows Runtime and Material editor. The editor shows the grey stage, the ball with `testMaterial`, no scene objects and no sky box; the env ball shows the `RoomEnvironment` PMREM, and the gizmo follows the editor camera. Back in the Runtime view the scene is as it was.
  - A canvas orbit moves the camera, the gizmo follows, and the pose is saved to `AEK_debugViewCams` (`materialEditor.view`). A refresh in the editor returns to it with that pose.
  - `RoomEnvironment` PMREM on WebGL2: works (also p083 Phase 3's test view B). **WebGPU is not verified**: headless WebGPU can't render on WSL2 (`run-aekasha-js` skill), so it needs a check in a real browser.
  - The icon, rendered at 16 px on dark and light backgrounds, reads as a shaded ball, not an eye.
