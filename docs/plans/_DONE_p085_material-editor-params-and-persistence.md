Status: implemented (Phases 1-4)
Category: Editor-Creator View, Materials
Related: \_DONE_p083_editor-creator-view.md (epic; undo buckets per view), \_DONE_p084_material-editor-stage-and-selector.md (implemented: editor view, editor copy, right drawer, per-material record), the debugger undo engine (`core/Debug/_dbg__UndoRedo.ts`, p060-p062, implemented: undo recording pattern), `createDebuggerTab` (p105, implemented: pane bindings, clear-LS buttons)

# Material Editor — Editable Params, Settings and Persistence

Fills the material editor's right drawer (p084):

- **Params** tab: a first, basic set of editable material parameters, plus the inputs of TSL materials.
- **Settings** tab: the editor's own settings **per material** (stage lighting, environment, background, auto-rotate, camera).

Every change applies live to the editor copy, is saved to LocalStorage per material, is undoable, and survives a refresh. Each material's editor data can be cleared on its own, or all at once.

Deeper params (textures, every three.js material type and property, TSL input ranges and types) come in a later plan, as does saving edits to the material JSON. The override format here is chosen so that the save plan can write it as is.

## Context (grounded in code)

- **The editor copy** (p084 DD3): `createMaterial({ ...asset, id: '__matEditor__' + id, tslMaterialId: asset.id })`, recreated on each material load and view enter, with a hook to merge overrides before creation.
- **TSL inputs** are uniform nodes kept in `mat.userData.uniforms[`${socket}_${input}`]` (`core/Material.ts:449-451`): numbers and booleans → `uniform(value)`, `#hex` → `uniform(color(hex))`, arrays and `{x,y,z}` objects → vector uniforms, texture ids → `texture(tex)`. Setting `.value` updates them without a rebuild.
- **Override shape.** `MaterialOverridesSchema` (`schemas/materialSchema.ts:9-17`) already has `params` and `nodes` (`{ [socket]: { [input]: value } }`), used by `__saveData` and by mesh `matOverrides` (`MaterialVariantOverridesSchema`, `:22-26`).
- **Pane builder** (`core/Debug/_dbg__DebuggerPaneBuilder.ts`):
  - A binding without `target` binds to `def.state` and is persisted when its top-level key is in `persistKeys`; paths can only be one level deep (`'a.b'`).
  - `persistDebuggerTabStateValue` rewrites the whole `lsKey` object from `persistKeys` and **drops every other field** (`:40-58`).
  - A binding with an explicit `target` is never persisted by the builder. `onChange` fires on user input only, with `e.prev`/`e.last`.
  - Folder open states go to `uiLsKey` (default `${lsKey}UI`).
- **Clear-LS buttons** (`_dbg__ClearLSButtons.ts`): `createClearTabLSButton` removes the tab's `lsKey` and calls `onClearLS`; `confirmClearScope` exists for confirmations. `openDialog` (`core/UI/DialogWindow.ts:15`).
- **Undo** (`debug/UndoRedo.ts`): `registerUndoRedoActionHandler(type, { undo, redo }, scope)` with synchronous handlers; `recordOrCoalesceUndoRedoAction(type, label, { prev, next, … }, coalesceKey)` merges slider/colour drags. With p083, `perScene` actions recorded in the editor go to the editor view's own bucket.
- **Material instance facts (three r186):** `transparent`, `side`, `flatShading`, `wireframe`, `vertexColors`, and `alphaTest` going between 0 and non-0 change the render pipeline and need `material.needsUpdate = true`. Colours are set with `Color.set('#rrggbb')`, the same conversion the JSON params get at creation.

## Design decisions

1. **One LocalStorage record per material** (p084 introduced its `camera` field).
   - Key: `AEK_debugMatEditorMat_<materialId>`.
   - Value:
     ```ts
     type MaterialEditorRecord = {
       overrides?: {
         params?: Record<string, unknown>;
         nodes?: Record<string, Record<string, unknown>>;
       };
       settings?: Partial<MaterialEditorSettings>;
       camera?: { position: Vec3; target: Vec3; fov: number };
     };
     ```
   - **Deviation-only**: a value is stored only once the user changes it. Values not changed keep following the asset JSON, so editing the JSON still shows up in the editor.
   - `overrides` has the exact shape of `MaterialOverridesSchema`'s `params` and `nodes`, and only JSON values (colours as `#rrggbb`, numbers, booleans, three.js enum numbers such as `side`, vectors as `{x,y(,z,w)}`). The save plan can write it into the JSON or its `__saveData` without conversion.
   - **The editor module owns the record** (`readRecord(id)`, `patchRecord(id, patch)`: read, merge, write). The tabs don't use `persistKeys`, because the builder would drop the fields the other tab and the camera write (Context). Every binding uses an explicit `target` (a small object built from the copy) and its `onChange` applies and persists the value.
   - The tabs still set `lsKey` to the record key, which gives both headings a clear button for **this material** (DD5). `uiLsKey` is one shared key, `AEK_debugMatEditorTabsUI`, so folder open states are the same for every material and a per-material clear doesn't reset them.
   - Applying overrides: p084's merge hook puts `overrides.params` over the asset's `params`, and `overrides.nodes[socket][input]` over the asset's node inputs, before `createMaterial`. So a reload or a refresh builds the copy with the edits already in it.
2. **Params tab: the first set of editable params.**
   - Each param is shown only when the copy has it (`key in material` and the value has the expected kind), so one list covers every material type.
   - Folders:
     - **Base**: `color`, `emissive`, `emissiveIntensity`; Phong: `specular`, `shininess`
     - **Surface**: `roughness` (0–1), `metalness` (0–1); Physical: `clearcoat`, `clearcoatRoughness`, `sheen`, `iridescence`, `transmission`, `ior` (1–2.333)
     - **Transparency**: `transparent`, `opacity` (0–1), `alphaTest` (0–1)
     - **Rendering**: `side` (Front / Back / Double), `wireframe`, `flatShading`
     - **Points / lines** (only for those types): `size`, `sizeAttenuation`; dashed lines: `dashSize`, `gapSize`, `scale`
     - **TSL inputs** (TSL materials only): one sub-folder per node socket (eg. `colorNode`), with one binding per input from the asset's `nodes`: numbers → number input (no range: the asset doesn't declare one), `#hex` → colour, booleans → checkbox, vectors → Tweakpane point 2D/3D/4D. Texture inputs are shown read-only (the texture id). `staticDefines` are shown read-only (changing them needs a rebuild: later plan).
     - **Other asset params** (read-only): asset `params` keys that no binding above covers, so nothing in the JSON is invisible.
   - Setting a value: plain params are set on the copy (`Color.set` for colours); pipeline-changing params (Context) also set `needsUpdate`; TSL inputs set the uniform's `.value` (`.set()` for colours and vectors).
   - Heading buttons: the clear button (DD5) and **"Reset params"**, which removes only `overrides` from the record and rebuilds the copy.
3. **Settings tab: the editor settings per material.**
   - `MaterialEditorSettings` and its defaults (the constants p084 uses):
     - **Stage**: `backgroundColor`, `environment` (`'STUDIO' | 'NONE'`), `environmentIntensity` (`scene.environmentIntensity`), `keyLightIntensity`, `fillLightIntensity`, `hemiLightIntensity`
     - **Preview**: `autoRotate`, `autoRotateSpeed` (deg/s; runs in the view's `update`, so the pause button pauses it)
     - **Camera**: `fov`, "Reset camera to default" (from p084), the read-only pose
   - A material without saved settings uses the defaults. Changing a setting applies it to the stage at once and patches `settings` in the record. Loading another material applies that material's settings.
   - A **"Clear editor data of all materials"** button at the bottom, behind a confirm dialog (`confirmClearScope`/`openDialog`). It removes every `AEK_debugMatEditorMat_*` key, but not the editor UI state (p084) or the folder states, and rebuilds the current copy.
4. **Undo and redo.**
   - One action type, `materialEditor.setValue`, registered with scope `perScene` (so it lands in the editor view's bucket, p083 DD8).
   - Payload: `{ materialId, section: 'params' | 'nodes' | 'settings', path, prev, next }`, where `path` is eg. `roughness` or `colorNode.gridScale`. `prev` is the value before the change as a JSON value (not "deleted"), so undo restores exactly what was shown.
   - Recorded with `recordOrCoalesceUndoRedoAction`, coalesce key `${materialId}.${section}.${path}`, so a slider drag is one entry.
   - Handlers: if the payload's material is the loaded one, apply the value (copy + record) and `refresh()` the drawer. If another material is loaded, select the payload's material first (like jumping to the edit), then apply once its load finishes; the handler is synchronous, so it starts the load and applies in its continuation. A material that no longer exists is a no-op with a warning.
   - The clear and reset buttons aren't recorded (as elsewhere in the debugger), and they don't clear the undo history. An undo after a clear re-applies that single value.
5. **Clearing a material's data.**
   - The clear button in either tab heading removes `AEK_debugMatEditorMat_<id>` (via the tab's `lsKey`). Its `onClearLS` rebuilds the copy from the asset, applies the default settings and camera pose, and rebuilds the drawer.
   - The button is disabled while the record doesn't exist (`lsKeyHasData`), like every tab's clear button.
6. **Refresh restore, complete.** With p083 (active view) and p084 (UI state, camera), a refresh now also restores every param, TSL input and setting (from the record) and the folder states (`AEK_debugMatEditorTabsUI`). Nothing in the editor is held only in memory.

## Files touched

| File                                                                          | Change                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/_engine/core/Debug/Editors/Material/_dbg__MaterialEditor.ts`             | Record read/patch, overrides merged before creation, settings applied to the stage, undo handler           |
| `src/_engine/core/Debug/Editors/Material/_dbg__MaterialEditorTabs.ts`         | Params and Settings tab content, clear/reset buttons                                                       |
| `src/_engine/core/Debug/Editors/Material/_dbg__MaterialEditorParams.ts` (new) | The param catalogue (key, folder, kind, range, `needsUpdate`, applies-to check) and the TSL input bindings |
| `.claude/CLAUDE.md`                                                           | Extend the material editor line: per-material LS record and its override shape                             |

## Phases

Each phase compiles, lints and leaves the app working.

1. **Record and overrides.** — done `MaterialEditorRecord`, read/patch, merge before creation, clear with rebuild. Params tab with the Base, Surface, Transparency and Rendering folders.
   - As built:
     - The record type and its read / patch were already in `_dbg__MaterialEditorStore.ts` (p084: `readMaterialRecord`, `patchMaterialRecord`), not in `_dbg__MaterialEditor.ts`. It adds `readMaterialOverrides` (shape-checked) and `setMaterialOverride(materialId, section, path, value)` (`path`: a param key or `<socket>.<input>`, `undefined` removes it, emptied objects and records are removed), and `MATERIAL_EDITOR_TABS_UI_LS_KEY`.
     - p084 had no merge hook: the copy is built by `getCopyProps`. Only the **node** overrides are merged before creation (`mergeNodeOverrides` in `_dbg__MaterialEditorParams.ts`: an input the asset has, of an editable kind, with a value of the same kind; textures, `staticDefines` and `{ r, g, b }` objects never). The **param** overrides are set on the created copy through the bindings' own setter (`applyParamOverrides` → `setMaterialParamValue`): only the created copy tells whether it has the key with the expected kind, and three warns about unknown constructor params. The copy is never rendered in between, so it is the same.
     - Deviation-only goes one step further: `current.baseParams` holds the copy's catalogue params as the asset alone gives them (read before the overrides), and a param set back to its base value drops its override, so it follows the JSON again.
     - A binding applies every change and saves only a drag's last one (`e.last`).
     - The drawer is rebuilt when the copy changes (`drawerCopy`), not only the material: the bindings are made from the copy (the clear, Phase 2's reset).
     - The clear button's `onClearLS` (both tabs) calls `viewCam.setPoseKey(id)` (the record's pose is gone, so the default one) and `loadEditorMaterial(id)` (a new copy from the asset).
     - A param the copy doesn't have is ignored but stays in the record (`roughness` on a Phong material).
2. **TSL inputs and the remaining params.** — done TSL input bindings, Points/lines and Physical folders, read-only "Other asset params", "Reset params".
   - As built:
     - The Physical params are in the **Surface** folder (DD2), like the Phong ones in Base; there is no separate Physical folder. Their three.js setters bump the material's version when a value crosses 0, so they need no `needsUpdate`.
     - The catalogue has an `appliesTo` check: `size` / `sizeAttenuation` only on points materials (a sprite also has `sizeAttenuation`), `dashSize` / `gapSize` / `scale` (label "Dash scale") only on dashed lines. `sizeAttenuation` sets `needsUpdate` (a build-time branch).
     - A TSL input is editable when the asset's value has an editable kind and the copy has a uniform of that kind (`getEditableNodeInput`). The kind comes from the asset, not the uniform: a `{ r, g, b }` input also becomes a colour uniform, but its overrides are never merged (Phase 1). Everything else in a socket is a read-only row in asset order: texture ids, inputs without a uniform (a socket createMaterial skipped), `{ r, g, b }`. `staticDefines` (a socket's and the material-wide ones) are a read-only "staticDefines (read-only)" sub-folder.
     - TSL input values are JSON values: colours `#rrggbb` (through `Color`, as the params are), vectors `{ x, y(, z, w) }`, also from an asset array. An input set back to the asset's value drops its override (`getNodeInputBaseValue`, `isSameNodeInputValue`), like the params.
     - Folder ids: `params/TSL inputs`, `params/TSL inputs/<socket>`, `…/staticDefines`, `params/Other`.
     - "Reset params" is a heading button (`arrowCounterClockwise`), made with `createClearLSButton`, whose `icon` now takes any `SvgIconKey` (`_dbg__ClearLSButtons.ts`). It is disabled while the record has no `overrides` (it watches the record key).
     - Not exercised in the app: no app material is POINTS, LINEDASHED or PHYSICAL, and none has an asset param without a binding, so the Points / lines and Physical bindings and "Other asset params" were checked only by type-check.
3. **Settings tab.** — done Stage, preview and camera settings per material, "Clear editor data of all materials".
   - As built:
     - The settings catalogue, defaults and value check are a new module, `_dbg__MaterialEditorSettings.ts` (`MaterialEditorSettings`, `DEFAULT_MATERIAL_EDITOR_SETTINGS`, `normalizeMaterialEditorSetting`, `getSettingsPaneItems`). The store adds `readMaterialSettings(id | null)` (the record's valid values over the defaults), `setMaterialSetting` (deviation-only: a value equal to its default is removed) and `clearAllMaterialRecords`.
     - **`fov` is not a setting**: it was already part of the camera pose in the record's `camera` (p084), so it stays there, and storing it twice could let the two disagree. The Camera folder's FOV binding calls the new `ViewCamera.setFov(fov, save)`, and "Reset camera to default" resets it with the pose. The pose is read-only rows (Position, Target) in the same folder, replacing p084's HTML readout.
     - `autoRotate` (default off) + `autoRotateSpeed` in deg/s (default 30) replace p084's `stageSettings.autoRotateSpeed` in turns per second. The stage keeps its lights and its baked studio PMREM (`Stage.lights`, `Stage.environmentTexture`), so 'NONE' sets `scene.environment = null` and 'STUDIO' puts the texture back without a re-bake.
     - A material's settings are applied together with its camera pose (`applyMaterialStage`), i.e. with the swap to its copy, not on its selection: the previous material stays on the stage while the textures load. `stageSettingsMaterialId` records which material the stage settings belong to; until it matches the selection, the tab shows no Stage / Preview folders and edits are ignored. Without a selected material the stage has the defaults and the tab says so.
     - "Clear editor data of all materials" opens a new plain confirm dialog, `confirmClearLS` (`_dbg__ClearLSButtons.ts`; `confirmClearScope` only offers all scenes / this scene). It removes every record, then resets the selected material like its own clear. The button is disabled while no record exists; the tab refreshes after a setting's last change and on the camera controls' `end`, so its disabled state follows the record.
     - Folder ids: `settings/Stage`, `settings/Preview`, `settings/Camera`.
4. **Undo/redo.** — done Action type, handlers (including the switch to another material), coalescing.
   - As built:
     - The tabs' bindings call wrappers (`editCopyParam`, `editCopyNodeInput`, `editStageSetting`, `editCameraFov` in `_dbg__MaterialEditor.ts`) that read the value before and after the setter, from the copy / stage / camera (so `prev` and `next` are normalized JSON values, not Tweakpane's), and record every tick with `_recordOrCoalesceUndoRedoAction`; nothing is recorded when the value didn't change. The handler path calls the setters directly, so it never records. Label: `Material <name or id>: <param label | socket.input | setting label | FOV>`.
     - A fourth section, **`camera`** (path `fov`): the FOV moved into the camera pose in Phase 3, so it is undoable through it. Its material is the camera's pose key (the previous material while the selected one loads), and the view's own pose (no material) isn't recorded. Camera moves and "Reset camera to default" aren't recorded.
     - **Record first, not apply in the continuation.** The handler sets the value live when its material is on the stage (copy, settings or pose key there), else writes it into the record and, when another material is selected, calls `loadEditorMaterial(id)`: the load builds the copy, the settings and the pose from the record. A load that is overtaken, fails or is discarded by the view's exit therefore can't lose the value, and the handler needs no continuation. A material that is selected but still loading (or failed) gets only the record write.
     - Deviation-only without a copy: a TSL input is compared with the asset's value (`normalizeAssetNodeInputValue`, `getNodeInputBaseValue`), a setting with its default, the FOV is patched into the saved pose (or `DEFAULT_CAMERA_POSE`). A param's base value needs the copy, so the record write keeps it, and `applyParamOverrides` now removes an override equal to the copy's base value on every load. This also covers a JSON edited to match an override, which then follows the JSON again, the same rule as an edit back to the base value.
     - New exports: `getNodeInputValue`, `normalizeAssetNodeInputValue` (`_dbg__MaterialEditorParams.ts`), `getMaterialEditorSettingLabel` (`_dbg__MaterialEditorSettings.ts`), and `setFov` on `MaterialEditorTabsCtx`.
     - Verified with a scripted headless run (WebGL2 / SwiftShader, `?isDebug=true`): Shininess on `testMaterial`, `gridScale` on `testTslMat`, back to `testMaterial`; undo selects `testTslMat` and reverts `gridScale` live (record removed); undo again selects `testMaterial` with shininess 30 (record removed by the load's cleanup); both redos re-apply; after a reload the history is kept in `__view:materialEditor` and undo still works. Settings, FOV and drag coalescing were not exercised there.

## Non-goals

- Editing textures (picking, loading, UV transforms), `staticDefines`, or anything that rebuilds a TSL graph.
- Every three.js material property; ranges and types declared in the material JSON for TSL inputs.
- Writing to the material JSON or `__saveData` (the save plan), and applying editor overrides to scene materials.
- Creating or duplicating materials, changing a material's type.

## Risks / open questions

| Risk                                                                                                | Mitigation                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A TSL graph reads an input once at build time instead of through its uniform, so changes don't show | Visible as "no change" in the editor. A later plan can add "rebuild on change" per input; this plan only binds uniforms.               |
| Number inputs without a declared range are awkward to drag                                          | Tweakpane's number field still allows drag and typing. Ranges in the material JSON belong to the deeper params plan.                   |
| Overrides of a param later removed from the asset, or of a material type that changed               | Values are applied only when the copy has the key with the expected kind; the rest is ignored (and still cleared by the clear button). |
| LocalStorage size with many materials                                                               | Records are deviation-only and small; "Clear editor data of all materials" removes them all.                                           |

## Verification

- `yarn lint` and `yarn build` pass (the Stop hook also runs them).
- `yarn dev`, `?isDebug=true`, material editor open:
  - `testMaterial` (PHONG): colour, emissive, shininess, specular, wireframe, side and transparency change the ball live. `STANDARD`/`PHYSICAL` params only appear for those types.
  - `testTslMat`: `baseColor`, `panelColor` and `gridScale` change live; the texture input shows its id read-only.
  - Refresh: every edited value, setting, the folder states, the tab and the camera come back.
  - Edit material A, switch to B, undo: A is selected again and the value reverts; redo re-applies it. A slider drag is one undo step. Scene actions are not in the editor's undo history and vice versa.
  - The clear button restores A to its JSON values, default settings and default camera pose, and doesn't touch B. "Reset params" keeps settings and camera. "Clear editor data of all materials" asks first, then resets both.
  - Edit the material's JSON on disk (Vite reload): an unchanged param follows the new JSON value, a changed one keeps the override.
  - Settings: background, environment on/off and intensity, light intensities, auto-rotate (the pause button stops it, the scene stays paused either way), fov — all per material.
- Use the `run-aekasha-js` skill for before/after screenshots of a param change and of a refresh restore.

## Implementation notes

(Filled in during implementation.)
