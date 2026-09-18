Status: implemented
Category: Debugger

# Editable Debug Camera Params in Debug Tools Controls Tab — Plan

Add a "Debug Camera" folder to the existing **Debug Tools Controls** tab (`debugToolsControls`, built in `_dbg__DebugTools.ts`'s `buildDebugToolsGUI()`) that exposes the debug (orbit) camera's params — position, target (look-at point), FOV, near, far, zoom — as editable Tweakpane bindings. Edits in the panel should drive the live `THREE.PerspectiveCamera` + `OrbitControls`, and conversely, moving the debug camera in the viewport (dragging with OrbitControls) should live-refresh the panel's values.

This reuses the debug camera's existing state machinery (`DebugCamLSProps`, `getDebugCamProps`/`saveDebugCameraToLS`, LS key `AEK_debugCams`) rather than the `debugToolsState.debugCamera` scaffolding that already exists in `DebugToolsManager.ts`/`_dbg__DebugTools.ts` but was never wired to a UI. That scaffolding is dead/unused and is deleted and rebuilt from scratch as part of this plan — see §1.3.

Also adds a "Reset to origin" button in the new folder that snaps the debug camera's position back to the default `(0, 0, 0)`.

**Target vs. rotation**: the spec allows either rotation or target/look-at. This plan uses **target**, because OrbitControls (and the existing `DebugCamLSProps`/LS persistence) already track `target` natively — there is no quaternion/Euler state anywhere in the current debug-camera code to bind to, so exposing rotation would require deriving and re-deriving Euler angles from the camera's quaternion on every sync, with no existing precedent for that in this codebase, purely to duplicate what target already expresses more simply for an orbit camera.

---

## 1. Current state (grounded in code)

### 1.1 Debug camera creation, controls, and per-frame update

- `InitApp.ts:68` calls `initDebugCamera(ecsWorld)`, defined in `CameraManager.ts:399-446`. It creates the debug camera via the normal `createCameraEntity({ type: 'PERSPECTIVE', active: false, fov: 60, near: 0.1, far: 2000 }, { appId: DEBUG_CAMERA_ID, ... })` path — a real `THREE.PerspectiveCamera`, tagged `ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA` + `ComponentType.PERSISTENT`.
- Controls are `OrbitControls` (`three/examples/jsm/controls/OrbitControls`), attached in `_dbg__DebugCamera.ts:26` (`attachOrbitControls`). On the `'end'` event (drag release only, not continuous) it calls `saveDebugCameraToLS({ position, target })`.
- `debugCameraSystem` (`_dbg__DebugCamera.ts:56`) runs every frame in `ECSSystemStage.MAIN` (registered via `ECSWorld.registerPlugin`, `_dbg__DebugCamera.ts:22`). It calls `controls.update()` and, if OrbitControls reports a change, syncs the live `Object3D`'s position/quaternion back into the ECS `Transform` component. **This is the natural per-frame hook point for a panel refresh.**
- `DebugCamLSProps` (`CameraManager.ts:379`): `{ position, target, enabled, latestAppCameraId, fov, near, far, zoom }` — already the full param set this plan needs. Defaults in `DEFAULT_DEBUG_CAM_PROPS` (`_dbg__DebugCamera.ts:11`). Persisted to LS key `AEK_debugCams`.
- `debugCamSceneChange` (`CameraManager.ts:337`) is the single existing place where fov/near/far/zoom/position/target are applied across all five representations (Three object, OrbitControls, ECS Transform, ECS `CAMERA_SETTINGS`, LS) — useful as a reference for how to push panel edits back out consistently.
- `getDebugCamProps`/`saveDebugCameraToLS` live in `_dbg__CameraGUI.ts:424-482`.

### 1.2 Debug Tools Controls tab

- Tab is registered in `_dbg__DebugTools.ts:145-189` (`createDebuggerTab({ id: 'debugToolsControls', title: 'Debug tools controls', orderNr: 6, ... })`), content built by `buildDebugToolsGUI()` (`_dbg__DebugTools.ts:240-561`).
- It currently has three folders, in order: **"Change scene and debug start scene"** (line 255), **"Helpers"** (line 311), **"Logging actions"** (line 466) — each following the same `debugGUI.addFolder({ title, expanded }).on('fold', (ev) => lsSetItem(...))` idiom, persisted into module-local `debugToolsState` (LS key `AEK_debugTools`).
- No camera-related folder exists here today. `_dbg__DebugTools.ts` currently has zero imports from any camera-related file.

### 1.3 Orphaned `debugCamera` scaffolding — deleted, rebuilt from scratch

`DebugToolsState` (`DebugToolsManager.ts:17-51`) already declares `debugCamera: { [sceneId: string]: DebugCameraState }` and `debugCameraFolderExpanded: boolean`. `_dbg__DebugTools.ts` has a matching `DebugCameraState` shape and `DEFAULT_DEBUG_CAM_PARAMS` (lines 32-42), and `_addSceneToDebugtools` (line 219) populates `debugToolsState.debugCamera[sceneId]` — but **no folder/binding in `buildDebugToolsGUI()` ever reads or renders it.** It's dead/unfinished scaffolding, and it is a second, redundant state shape next to the real source of truth (`DebugCamLSProps`/`AEK_debugCams`).

Decision: this scaffolding (the `debugCamera`/`debugCameraFolderExpanded` fields, the matching `DebugCameraState`/`DEFAULT_DEBUG_CAM_PARAMS` types, and `_addSceneToDebugtools`'s population of them) is **dead code and is deleted outright**, not repurposed. Phase 1 builds the new "Debug Camera" folder fresh, wired to the real live state (`CameraManager`/`_dbg__DebugCamera`/`_dbg__CameraGUI`), with no dependency on or reuse of the old shape.

### 1.4 Existing camera UI that does _not_ cover this

`_dbg__CameraGUI.ts:326-407` builds a separate **"Camera Controls"** tab (id `camerasControls`, orderNr 11) with a full position/fov/near/far editor per scene camera (`createEditCameraContent`, line 70) — but it explicitly skips the debug camera: `_dbg__CameraGUI.ts:272` `if (world.hasComponent(entityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA)) continue;`. No existing panel anywhere exposes the debug camera's own params for editing; today it's adjustable only by dragging it in the viewport, or via the on/off toggle in `_dbg__OnScreenTools.ts:125/138/187-188`.

---

## 2. Phases

**Phase 1 — Delete orphaned scaffolding, add "Debug Camera" folder with editable bindings.**
First, delete the dead `debugCamera`/`debugCameraFolderExpanded` fields from `DebugToolsState` (`DebugToolsManager.ts:35-36`) and the matching `DebugCameraState`/`DEFAULT_DEBUG_CAM_PARAMS` types and `_addSceneToDebugtools` population logic in `_dbg__DebugTools.ts` (lines ~32-42, 219) — confirm no other call sites reference them before removing.
Then, in `buildDebugToolsGUI()` (`_dbg__DebugTools.ts`), add a fresh `debugGUI.addFolder({ title: 'Debug Camera', expanded: ... })` block (placed after the "Change scene..." folder, before "Helpers", matching existing fold/persist idiom against `debugToolsState`/`AEK_debugTools` — a new `debugCameraFolderExpanded` flag can reuse that name since the old field is being deleted, not aliased).
Add bindings for `position` (vector3), `target` (vector3), `fov`, `near`, `far`, `zoom`, bound to a plain proxy object seeded from `getDebugCamProps(sceneId)` (`_dbg__CameraGUI.ts`). On `.on('change', (e) => { if (!e.last) return; ... })` (matching the drag-release-commit pattern used in `_dbg__LightGUI.ts:361-379`), push the new values onto the live debug camera + `OrbitControls` (`camera.position.copy(...)`, `controls.target.copy(...)`, `camera.fov = ...; camera.updateProjectionMatrix()`, `controls.update()`) and persist via `saveDebugCameraToLS`.
Add a **"Reset to origin"** button (`pane.addButton({ title: 'Reset to origin' })`, matching the existing button idiom used for e.g. the tab's "clear" buttons) that sets the debug camera's position to `(0, 0, 0)` (the documented default), applies it the same way as a position-binding change (`camera.position.set(0, 0, 0)`, `controls.update()`, persist via `saveDebugCameraToLS`), and refreshes the position binding to reflect it. Target/fov/near/far/zoom are left untouched by this button — it only resets position, per the spec ("move the debug camera to 0, 0, 0").
Requires new imports into `_dbg__DebugTools.ts` from `CameraManager.ts` and/or `_dbg__CameraGUI.ts`/`_dbg__DebugCamera.ts` to reach the live camera/controls instance and the LS helpers — confirmed safe direction (no existing reverse imports found, see §5).
Manual verification: open the Controls tab, expand "Debug Camera", edit each field, confirm the debug camera in the viewport moves/updates accordingly and the change survives a scene reload (LS round-trip). Click "Reset to origin" and confirm the camera snaps to `(0, 0, 0)` and the position binding updates to match.

**Phase 2 — Live sync from viewport back into the panel.**
Hook the panel refresh into `debugCameraSystem` (`_dbg__DebugCamera.ts:56`, runs every frame) — after `controls.update()` detects a change, if the Debug Camera folder's bindings exist (panel built/open), call `.refresh()` on the position/target/fov/near/far/zoom `BindingApi`s (matching the `.refresh()`-after-external-mutation idiom used throughout the codebase, e.g. `_dbg__ECS.ts:107`, `_dbg__SpatialGrid.ts:140`, `_dbg__DebugTools.ts:560`).
Since this fires every frame while orbiting, guard it so it's a no-op unless OrbitControls actually reported a change this frame (the system already computes that boolean for the existing ECS Transform sync) — do not call `.refresh()` unconditionally per frame.
Store the binding references (e.g. module-local map of `BindingApi` instances keyed by field) at folder-build time so the per-frame system can reach them without rebuilding the pane.
Manual verification: with the Controls tab open on the Debug Camera folder, orbit/pan/zoom the debug camera in the viewport and confirm the panel's position/target values update live, continuously, without needing to release the mouse or reopen the tab.

---

## 3. Files touched

- `src/_engine/core/Debug/_dbg__DebugTools.ts` — delete orphaned `debugCamera`/`DebugCameraState`/`DEFAULT_DEBUG_CAM_PARAMS`/`_addSceneToDebugtools` population logic; add fresh "Debug Camera" folder + bindings + reset button in `buildDebugToolsGUI()` (Phase 1); refresh wiring hookup point (Phase 2).
- `src/_engine/core/Debug/Camera/_dbg__DebugCamera.ts` — `debugCameraSystem` gains a conditional panel-refresh call (Phase 2).
- `src/_engine/core/Debug/Camera/_dbg__CameraGUI.ts` — possibly exposes/exports binding-reference storage or a small helper if the refresh call needs to reach across files (Phase 2); reuse of `getDebugCamProps`/`saveDebugCameraToLS` (Phase 1).
- `src/_engine/core/CameraManager.ts` — no functional change expected; referenced for live camera/controls access.
- `src/_engine/debug/DebugToolsManager.ts` — delete orphaned `debugCamera`/`debugCameraFolderExpanded` fields from `DebugToolsState` (Phase 1).

## 4. Out of scope

- Editing debug camera rotation via Euler/quaternion fields (target is used instead — see rationale above).
- Adding debug-camera editing to the separate "Camera Controls" tab (`_dbg__CameraGUI.ts`) — that tab is for real scene cameras and explicitly excludes the debug camera by design; this plan keeps that exclusion.
- Multi-debug-camera support (only one debug camera exists per the current architecture).
- Changing the OrbitControls `'end'`-only LS persistence trigger to something more frequent (e.g. persist on every panel edit is fine per Phase 1, but continuous viewport-drag LS writes are out of scope — Phase 2 only refreshes the panel's display, it doesn't add new persistence triggers).

## 5. Risks and open questions

| Risk / question                                    | Notes                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-frame `.refresh()` cost while orbiting         | Must be gated on "OrbitControls actually changed this frame" (value already computed in `debugCameraSystem`), not called unconditionally every frame, and only when the Debug Camera folder is actually built/visible.                                                         |
| Circular imports                                   | `_dbg__CameraGUI.ts`/`_dbg__DebugCamera.ts`/`CameraManager.ts` currently have no imports from `_dbg__DebugTools.ts`, so `_dbg__DebugTools.ts` importing from them (new, one-directional) should be safe — worth a quick build check once wired up.                             |
| Orphaned `debugToolsState.debugCamera` scaffolding | Confirmed unused (no folder/binding reads it). Deleted outright in Phase 1 and rebuilt fresh against the real source of truth (`DebugCamLSProps`/`AEK_debugCams`) rather than repurposed — double-check no other call sites reference the old fields before removing.          |
| "Reset to origin" scope                            | Per spec, the button only resets position to `(0, 0, 0)` — target/fov/near/far/zoom are left as-is. Confirm this matches intent before implementation if a full reset-to-defaults (using `DEFAULT_DEBUG_CAM_PROPS`, `_dbg__DebugCamera.ts:11`) is actually wanted instead.     |
| Target vs. rotation                                | Plan uses target per §"Target vs. rotation" above; flag before implementation in case rotation fields are actually preferred despite the extra derivation work.                                                                                                                |
| Binding reference lifecycle                        | Panel bindings must be safely reachable/nullable across tab rebuilds (tab can be destroyed/recreated, e.g. via the existing "clear tab" button at `_dbg__DebugTools.ts:151-178`) — the per-frame refresh call in Phase 2 must not throw if the folder/pane has been torn down. |
