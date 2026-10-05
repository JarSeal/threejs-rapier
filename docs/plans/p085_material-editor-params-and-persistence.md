Status: draft | not-implemented
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

1. **Record and overrides.** `MaterialEditorRecord`, read/patch, merge before creation, clear with rebuild. Params tab with the Base, Surface, Transparency and Rendering folders.
2. **TSL inputs and the remaining params.** TSL input bindings, Points/lines and Physical folders, read-only "Other asset params", "Reset params".
3. **Settings tab.** Stage, preview and camera settings per material, "Clear editor data of all materials".
4. **Undo/redo.** Action type, handlers (including the switch to another material), coalescing.

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
