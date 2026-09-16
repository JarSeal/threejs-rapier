Status: draft | not-implemented
Category: Debugger

# Light &amp; Camera Edit Window Persistence — Clear Local Storage + Session Delete — Plan

Adds a "Clear local storage" and a "Delete" button to the Camera and Light debug edit windows, plus a "Clear local storage" button to the ECS World debug edit window, so a user working in the debug drawer can reset a single entity's/world's persisted debug overrides or remove an entity for the current browser session without touching the underlying scene JSON.

---

## 1. Goal

- **Clear local storage** button on the Camera edit window, Light edit window, and ECS World edit window. Disabled when there is no localStorage data for that specific entity/world.
- **Delete camera** button on the Camera edit window. Session-only (does not touch scene JSON) — calls the generic ECS entity deletion, which already cascades correctly (see §2.4). Disabled when this is the last (non-debug) camera in the scene.
- **Delete light** button on the Light edit window. Session-only, same mechanism. No "last light" restriction (not requested, and nothing in the engine requires at least one light to exist).

Field-level **persistence across page refresh already exists** for Camera and Light edit windows (see §2.1/§2.2) — this plan does not add that; it adds the missing controls to manage/reset it.

---

## 2. Current state (grounded in the actual code)

### 2.1 Camera edit window

`src/_engine/core/Debug/Camera/_dbg__CameraGUI.ts`:

- Every field's `on('change')` handler already calls `saveCameraToLS(entityId, key, value)` (line 324), which persists under LS key `AEK_debugCams` (`LS_KEY`, line 58), keyed by scene id then app id: `{ [sceneId]: { cams: { [appId]: CamEntityDebugState }, debugCam } }`.
- **Gate**: `saveCameraToLS` only writes if the entity's `APP_ID` component has `isFixed: true` (line 331) — auto-generated/non-authored ids are never persisted. This is the correct signal for "does this entity have any LS data to clear."
- Reader: `loadCameraDebugData(appId)` (line 308) returns `undefined` if there's no scene/appId bucket — this is the exact check to drive the Clear button's `disabled` state.
- The window is a single shared draggable window (`EDIT_CAMERA_WIN_ID`), rebuilt per open via `createEditCameraContent(data)`, which resolves `entityId`/`appId` fresh each time from `data.id` via `getEntityIdByAppId` (lines 63–82).
- Camera count / "last camera" query: `getAllCamerasAsArray()` (`CameraManager.ts:295`) already returns only real (non-debug-fly-camera) cameras with an `APP_ID` — `getAllCamerasAsArray().length <= 1` is exactly "is this the last camera."

### 2.2 Light edit window

`src/_engine/core/Debug/Light/_dbg__LightGUI.ts` mirrors the Camera GUI exactly: `saveLightToLS(entityId, key, value)` (line 805) writes to LS key `AEK_debugLights` (`LS_LIGHTS_KEY`, line 64) under `{ [sceneId]: { lights: { [appId]: LightEntityDebugState }, globalHelpersVisible } }`, gated by the same `appIdComp?.isFixed` check (line 813). Reader: `loadLightDebugData(appId)` (line 785). Single shared window `EDIT_LIGHT_WIN_ID`, rebuilt via `createEditLightContent`.

### 2.3 ECS World edit window

`src/_engine/core/Debug/_dbg__ECS.ts` is a per-**world** editor (not per-entity — confirmed no generic ECS entity/component inspector exists anywhere in the codebase). It already persists a storage override per world id:

- `src/_engine/core/ECS/ECSComponentStorage.ts`: LS key `AEK_ecs` (`ECS_LS_KEY`, line 23), shape `Record<worldId, ECSStorageLSOverride>` (`{ storageMode?, maxEntities? }`). `getECSStorageLSOverride(worldId)` (line 28) / `setECSStorageLSOverride(worldId, override)` (line 39).
- In `_dbg__ECS.ts`, changing "Storage mode" or "Max entities" (lines 107–130) calls `setECSStorageLSOverride` then `location.reload()` (storage mode is boot-time-only).
- Existing conditional-button precedent in the same file: `if (!isDefault) { pane.addButton({ title: 'Delete world' })... }` (lines 132–140) — closes the window first, then performs the destructive action.

### 2.4 Entity deletion mechanics (already generic and correct)

`ECSWorld.deleteEntity(entityId)` (`src/_engine/core/ECS.ts:460`) fires every registered `onDeleteEntity` hook for the entity's component types before removing it. For cameras and lights this cascade is already fully wired — no new cleanup code is needed, just call it:

- Camera: `TAG_IS_CAMERA` hook → `disposeCamera` (`CameraManager.ts:233`) removes the Object3D and refreshes the debugger list. `DEBUG_CAMERA_HELPER` hook (`_dbg__CameraHelpers.ts`) disposes the helper mesh. `DEBUG_SYMBOL` hook (`_dbg__Symbols.ts`) disposes the billboard icon.
- Light: `TAG_IS_LIGHT` hook → `disposeLight` (`LightManager.ts:434`) disposes the light **and** its linked `TARGET_LINK` target entity, and refreshes the list. `DEBUG_LIGHT_HELPER` hook disposes the helper.

None of these hooks close the currently-open edit window, so the click handler must do that itself, in the same order as the existing "Delete world" precedent: **close window, then delete**.

This deletion is inherently session-only/non-permanent already — `deleteEntity` only mutates the live `ECSWorld`, never the scene JSON on disk, so a page refresh reconstructs the entity from `generatedAppData.json` exactly as today. No extra flag or guard is needed to satisfy "only for this page session" — it's a property of the existing mechanism, not something to build. (Same reasoning `_dbg__Character.ts`'s existing delete-character button tooltip already states: "only for this browser load, does not delete character permanently.")

---

## 3. Design

### 3.1 "Clear local storage" button (Camera, Light, ECS World)

Add one new function per file to remove just that entity's/world's bucket and write the rest back:

```ts
// _dbg__CameraGUI.ts
export const clearCameraFromLS = (appId: string) => {
  const sceneId = getCurrentSceneId();
  const currentData = lsGetItem(LS_KEY, {}) as CamDebugLSData;
  if (!sceneId || !currentData[sceneId]?.cams?.[appId]) return;
  delete currentData[sceneId].cams[appId];
  lsSetItem(LS_KEY, currentData);
};
```

Same shape for `clearLightFromLS(appId)` in `_dbg__LightGUI.ts` (deletes `currentData[sceneId].lights[appId]`), and for the ECS World editor add `clearECSStorageLSOverride(worldId: string)` in `ECSComponentStorage.ts` next to the existing getter/setter:

```ts
export const clearECSStorageLSOverride = (worldId: string): void => {
  const all = lsGetItem(ECS_LS_KEY, {}) as ECSStorageLSOverrides;
  if (!(worldId in all)) return;
  delete all[worldId];
  lsSetItem(ECS_LS_KEY, all);
};
```

Button, added via `pane.addButton` in each window's content-builder (mirrors the existing "Delete world" button call style):

```ts
const clearLSBtn = pane.addButton({
  title: 'Clear local storage',
  disabled: !loadCameraDebugData(appId), // or !loadLightDebugData(appId) / !getECSStorageLSOverride(world.id)
});
clearLSBtn.on('click', () => {
  clearCameraFromLS(appId);
  clearLSBtn.disabled = true; // Tweakpane's BladeApi exposes a writable `disabled` on every blade, incl. buttons — confirmed via @tweakpane/core/dist/blade/common/api/blade.d.ts. No window rebuild needed.
});
```

For the ECS World editor specifically, since the storage override only takes effect at world construction (same as the existing storageMode/maxEntities change handlers), follow the same convention and call `location.reload()` after clearing so the pane doesn't show a stale "override active" state.

### 3.2 "Delete camera" button

```ts
const deleteBtn = pane.addButton({
  title: 'Delete camera',
  disabled: getAllCamerasAsArray().length <= 1,
});
deleteBtn.on('click', () => {
  closeDraggableWindow(EDIT_CAMERA_WIN_ID);
  world.deleteEntity(entityId);
});
```

`getAllCamerasAsArray` (`CameraManager.ts:295`, already imported into other Camera GUI code) already excludes the debug fly-camera, so no new query is needed. Computed once at window-build time — consistent with how the Light GUI's other `disabled` bindings are computed (build-time, refreshed only on window rebuild) — not live-tracked against other windows changing camera count mid-edit.

### 3.3 "Delete light" button

Same pattern, no count guard:

```ts
const deleteBtn = pane.addButton({ title: 'Delete light' });
deleteBtn.on('click', () => {
  closeDraggableWindow(EDIT_LIGHT_WIN_ID);
  world.deleteEntity(entityId);
});
```

### 3.4 Placement

Add both buttons as plain `pane.addButton(...)` calls at the end of each window's Tweakpane pane (after existing folders), matching how `_dbg__ECS.ts` places "Delete world" — keeps all three edit windows internally consistent (no new CMP-based icon-button pattern introduced, unlike `_dbg__Character.ts`'s trash icon, which is a different file's existing convention and not necessary to replicate here).

---

## 4. Files touched

- `src/_engine/core/Debug/Camera/_dbg__CameraGUI.ts` — add `clearCameraFromLS`, "Clear local storage" + "Delete camera" buttons (needs `getAllCamerasAsArray` imported from `../../CameraManager`, already imports other things from there).
- `src/_engine/core/Debug/Light/_dbg__LightGUI.ts` — add `clearLightFromLS`, "Clear local storage" + "Delete light" buttons.
- `src/_engine/core/ECS/ECSComponentStorage.ts` — add `clearECSStorageLSOverride`.
- `src/_engine/core/Debug/_dbg__ECS.ts` — add "Clear local storage" button to `createEditECSWorldContent`.

No schema, scene-JSON, or ECS component-type changes — this is entirely debug-tooling code.

---

## 5. Phased rollout

Small enough to be three independent, non-breaking phases (one file each, easy to review/commit separately):

- **Phase 1 — Camera edit window.** `clearCameraFromLS` + "Clear local storage" button + "Delete camera" button (with last-camera guard via `getAllCamerasAsArray`). Manual verification: `?isDebug=true`, edit a camera's FOV (creates LS data) → Clear button enables → click it → button disables, refresh page → FOV reverts to scene-JSON default. Delete a non-last camera → it disappears from the list/scene; refresh → it's back (session-only). With only one camera left, confirm Delete is disabled.
- **Phase 2 — Light edit window.** Same shape as Phase 1, minus the count guard. Manual verification: same Clear/Delete/refresh flow on a light, including one that has a `TARGET_LINK` (spot/directional) — confirm deleting it removes the target helper too (already handled by `disposeLight`, just confirm no regression).
- **Phase 3 — ECS World edit window.** `clearECSStorageLSOverride` + button. Manual verification: change a non-default world's storage mode (creates an override + reloads), reopen its edit window, confirm Clear is enabled, click it (reloads), reopen, confirm Clear is now disabled and the world is back to its default storage mode.

---

## 6. Risks and open questions

| Risk / question | Notes |
| --- | --- |
| Deleting the main camera isn't guarded, only the *last* camera is (per the original spec). | If a scene has 2+ cameras and the user deletes the currently-active `TAG_IS_MAIN_CAMERA` one, rendering likely breaks until another is set main. Out of scope per the explicit request ("if that particular camera is the last camera... it cannot be deleted"), but worth confirming this is acceptable before implementing. |
| ECS World "Clear local storage" forces `location.reload()`. | Matches existing storageMode/maxEntities change behavior in the same file, but is a slightly different UX than the Camera/Light Clear buttons (which don't reload). Flagging so it's a deliberate choice, not an inconsistency someone flags in review. |
| Tweakpane's per-blade `disabled` (confirmed present on `BladeApi`, incl. buttons, via `@tweakpane/core`) has no existing precedent of being toggled at runtime in this codebase — only build-time conditional button presence (`if (!isDefault) pane.addButton(...)`) is used today (`_dbg__ECS.ts`'s "Delete world"). | Verified directly against the installed `@tweakpane/core` type declarations that `.disabled` is a writable property on all blades, so this is safe to use; noting it as a new-but-supported pattern for this codebase. |
