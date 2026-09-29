Status: draft | not-implemented
Category: Debugger
Related: \_DONE_p141_ray-debug-line-helpers.md and \_DONE_p142_physics-ray-debugging-and-stats.md (both implemented: the helpers, the fixed physics queries and the `'PHYSICS'` helper kind this plan builds on), \_DONE_p105_refactor-debugger-drawer-tab-creation.md (edit windows are out of its scope), p150_current-entity-data-source-info-on-edit-windows.md

# Ray Cast Tester Windows — Plan

Part of the ray casting plan set (index: `_DONE_p140_refactor-ray-casting.md` §1.1). This plan adds two
buttons to the Ray Cast Controls tab. They open two draggable debug windows: a **Three.js ray
tester** and a **physics ray tester**. Each lets you configure a ray, cast it into the current scene
with a **Fire** button, see it with a debug helper (p141), and read the hits. The parameters are
saved to localStorage **per scene**. The state is shaped for firing several rays at once, but only
one ray is edited and fired for now.

---

## 1. Goal

- One-click ray testing in debug mode for both ray kinds, using the same code paths that gameplay
  uses: `Raycast.ts` (p140) and the `WorldAPI` queries (p142).
- Every ray-relevant option is configurable in the window.
- The results are readable: hit distance/toi, point, normal, and object/collider → entity/app id.
- Params persist per scene and survive reloads and scene switches.
- The state and fire loop are multi-ray-ready; the UI is single-ray for now.

---

## 2. Current state (grounded in the actual code)

- **Draggable windows** (`src/_engine/core/UI/DraggableWindow.ts`):
  - `openDraggableWindow({ id, title, content, data, isDebugWindow, saveToLS, closeOnSceneChange,
    onClose, … })` (`:152`). There is one window per id; re-opening raises it.
  - The content is a CMP. Tools create their own Tweakpane `Pane` inside it and dispose it in
    `onRemoveCmp` (`_dbg__PostFX.ts:418,427`).
  - Position, size, open and collapsed state persist in `AEK_popupWindows` for `saveToLS` windows.
    Content functions are re-attached after reload through `registerDraggableWindowContentFn(id, fn)`
    (`:1065`, e.g. `_dbg__PostFX.ts:511`).
  - `updateDraggableWindow(id)` (`:605`) rebuilds the content. `closeDraggableWindow(id)` (`:417`).
  - The open/close toggle pattern from a tab button is at `_dbg__PostFX.ts:120-137`.
- **Per-scene localStorage pattern:** `AEK_debugPostFx = { [sceneId]: … }` (`_dbg__PostFX.ts:209-254`),
  with `getCurrentSceneId()` (`core/Scene.ts:320`) and
  `registerOnAllSceneEnterings(id, fn)` (`Scene.ts:692`).
  - The first scene is entered before the debug GUIs exist, so state must also be applied at GUI
    creation (`_dbg__PostFX.ts:568-575`).
  - `confirmClearScope({ onClearAllScenes, onClearThisScene })` is in `_dbg__ClearLSButtons.ts:60`.
- **Raycast targets:**
  - `getCurrentScene()` (`Scene.ts:307`) is the current scene's group. The root scene
    (`getRootScene()`) also holds debug visuals (symbols, light helpers, collider wireframes, lines),
    so it must **not** be the target.
  - Line objects already opt out of raycasting.
- **Hit → entity:**
  - `userData.entityId` is set on meshes, groups, lights, cameras and lines (`MeshManager.ts:161`,
    `GroupManager.ts:66`, …).
  - Children of imported models are not tagged, so walk up `.parent` until an id is found. No helper
    exists for this.
  - App id: `getStableAppId(entityId)` / the `APP_ID` component (`ECS.ts`).
- **Physics hit → entity:** `collider.parentId` → rigid body → its entity mapping (as
  `dynamicCharacter.ts:707` does).
- **Camera:** `getActiveCamera()` (used by `Input/InputPicking.ts`) respects the debug camera.
- **Undo:** tester params are a dev tool, so no undo recording (p061 §2.2 categories).

---

## 3. Design

### 3.1 Entry points (Ray Cast Controls tab)

- Two buttons at the top of the tab: **"Three.js ray tester"** and **"Physics ray tester"**. Each
  toggles its window, following the PostFX pattern.
- The physics button is disabled with a note when `isPhysicsWorldEnabled()` is false.
- Window ids: `debugRayTesterThree` and `debugRayTesterPhysics`, both with `isDebugWindow: true` and
  `saveToLS: true`.
- They are **not** `closeOnSceneChange`: they stay open and reload the new scene's params (§3.5).
- Content functions are registered at module scope with `registerDraggableWindowContentFn`, so
  windows reopened from localStorage after a reload get their content.

### 3.2 Shared state shape (multi-ray-ready)

```ts
type RayOrigin = { x: number; y: number; z: number };
type RayAim =
  | { mode: 'DIRECTION'; dir: RayOrigin }          // normalized on fire
  | { mode: 'TARGET_POINT'; point: RayOrigin }
  | { mode: 'CAMERA_FORWARD' };                     // origin + dir taken from the active camera at fire time

type ThreeRayParams = {
  origin: RayOrigin; aim: RayAim;
  near: number; far: number; recursive: boolean;
  target: { type: 'CURRENT_SCENE' } | { type: 'ENTITY'; appId: string };
  helper: { color: string; inactiveColor: string; width: number; holdMs: number };
};
type PhysicsRayParams = {
  query: 'CAST_RAY' | 'CAST_RAY_AND_GET_NORMAL' | 'INTERSECTIONS_WITH_RAY';
  origin: RayOrigin; aim: RayAim;
  maxToi: number; solid: boolean;
  filterFlags: number; filterGroups: number | null; excludeAppId: string | null;
  helper: { color: string; inactiveColor: string; width: number; holdMs: number };
};
type RayTesterState<P> = { version: 1; rays: P[]; activeIndex: number };
```

- **Fire iterates over all `rays`** and collects `results[i]` per ray. The UI edits and shows only
  `rays[activeIndex]` (always `rays[0]` for now). Adding patterns later (fan, grid, "N rays around
  the camera") is a UI-only change.
- Physics fire is `await Promise.all(rays.map(...))`, so a later multi-ray fire works in worker mode
  without changes. A batched query message is noted as a p142 follow-up.
- `version` allows migrating the stored shape later.

### 3.3 Three.js ray tester window

- **Tweakpane bindings:**
  - origin (Vector3), with a "Set origin from active camera" button;
  - aim mode (list), then dir (Vector3) or target point (Vector3) depending on the mode;
  - `near` and `far`, `recursive`;
  - target: current scene, or entity by app id (a text field with validation);
  - helper color, inactive color, width and hold time. The hold time defaults to 3000 ms so the
    fired ray stays readable.
- **Fire button** →
  - `castRayFromDirection(targetObjects, origin, dir, { near, far, recursive, countInStats: false,
    debug: { id: 'rayTester_three_<i>', color, inactiveColor, width, holdMs } })`;
  - or `castRayFromPoints` for TARGET_POINT;
  - CAMERA_FORWARD uses the camera position and `getWorldDirection`.
- **Results panel** (a plain CMP list under the pane, rebuilt only on fire): hit count, then per hit
  (first 20, then "+N more"):
  - distance and point;
  - face normal, transformed to world space;
  - object name;
  - entity id and app id (§2 walk-up helper);
  - a "copy" icon that copies the hit as JSON.

  No hits → "No hits".
- A small helper `getEntityIdForObject3D(obj)` (walk up `userData.entityId`) goes into
  `core/Debug/_dbg__RayTester.ts`, or into `utils/helpers.ts` if another tool needs it.

### 3.4 Physics ray tester window

- **Bindings:**
  - query type, origin, aim (same modes as the Three.js tester);
  - `maxToi`, `solid`;
  - filter flags (one checkbox per `QueryFilterFlags` bit, `PhysicsAPITypes.ts:877`);
  - filter groups (a number, or unset);
  - exclude entity by app id, resolved to its rigid body at fire time;
  - helper settings.
- **Fire** → the corresponding `getPhysicsWorld()` async query (works in both `workerTarget` modes),
  with `debug: { id: 'rayTester_physics_<i>', … }` so p142's observer draws it in the physics
  colors. Tester queries pass a `countInStats: false`-equivalent, so the observer skips stats for
  ids starting with `rayTester_` (a documented convention; there is no extra API param).
- The Fire button shows a pending state until the promise resolves.
- **Results:**
  - toi and point (`origin + dir × toi`);
  - normal (for GET_NORMAL and INTERSECTIONS_WITH_RAY);
  - collider id and entity/app id via collider → rigid body.

  `INTERSECTIONS_WITH_RAY` lists all hits.

### 3.5 Per-scene persistence

- LS key `AEK_debugRayTester`:

  ```ts
  { [sceneId]: { three?: RayTesterState<ThreeRayParams>; physics?: RayTesterState<PhysicsRayParams> } }
  ```

  It is written on every committed change (`e.last`), and reading merges over defaults.
- Scene switch: a `registerOnAllSceneEnterings('rayTester', …)` hook calls `updateDraggableWindow` for
  each open tester window, so it rebuilds with the new scene's params or the defaults. The state is
  also applied at window-content creation, which covers the first scene entered before the debug
  GUIs.
- Results are **not** persisted. They are cleared on scene switch.
- A clear button in each window header uses `confirmClearScope` (this scene / all scenes) and resets
  that tester's params. The Ray Cast tab's clear-LS button also covers `AEK_debugRayTester`, through
  the same `confirmClearScope`.

### 3.6 Optional: pick point with the mouse

- "Pick origin" / "Pick target" buttons arm a one-shot `createMouseBinding({ type: 'MOUSE_CLICK',
  targets: [getCurrentScene()], enabledInDebugCam: true, fn })` (`Input/MouseInput.ts:283`). The
  click writes the intersection point into the param and then deletes the binding.
- Esc or a second press cancels it.

---

## 4. Phases (each non-breaking and committable on its own)

### Phase 1: Three.js ray tester

- Tab button, window, bindings, Fire, and results for `THREE`. Params are in memory only.

### Phase 2: physics ray tester

- Tab button, window, bindings, async Fire, and results. The stats-skip convention for `rayTester_`
  ids goes in p142's observer.

### Phase 3: per-scene persistence and clearing

- `AEK_debugRayTester`, the scene-enter reload, the clear buttons, and the `registerDraggableWindowContentFn`
  reload path.

### Phase 4 (optional): mouse picking of origin and target

- §3.6.

---

## 5. Risks, notes, out of scope

- **Hidden or large scenes.** Raycasting `getCurrentScene()` recursively tests every mesh, including
  invisible ones (three doesn't skip `visible: false`). For a tester this is acceptable. An "Ignore
  invisible objects" option (a post-filter walking `.visible` up the parents) is noted as a small
  add-on.
- **Imported models** without per-child entity ids resolve through the walk-up. Objects outside any
  entity show "—".
- **Worker timing.** Physics results arrive ≥1 frame later. The Fire button's pending state makes
  this explicit.
- **Window reload.** A saved open window whose content function isn't registered yet would open
  empty. Registering at module scope, loaded before `loadDraggableWindowStatesFromLS`
  (`InitApp.ts:167`), avoids this, as PostFX does.
- **Out of scope:** multi-ray UI and patterns (the state is ready), shape-cast testing (`castShape`
  can be added later as a query type), and saving tester rays into scene JSON.

---

## 6. Verification

- `yarn lint` and `yarn build` are clean.
- `yarn dev`, open `?isDebug=true`, then Ray Cast Controls:
  - **Three.js tester:** set the origin from the camera and fire at a mesh. The helper line appears
    in the tester color, holds about 3 s, then fades dashed. The results list the mesh with the
    correct entity/app id and distance.
  - **Target point mode:** a point behind a mesh yields a hit only on the near mesh when `far` is the
    distance.
  - **Physics tester:** fire `CAST_RAY_AND_GET_NORMAL` at the ground in both `workerTarget` modes.
    It gives the same toi and normal (this depends on the p142 Phase 1 fix). Exclude-by-app-id skips
    that body. `INTERSECTIONS_WITH_RAY` lists several stacked colliders.
  - Tester rays don't change the Three.js or physics ray statistics.
  - Change params, switch scene, then switch back. Each scene restores its own params. Reload the
    page: the windows reopen with their content and params.
  - Clear "this scene" and "all scenes". The params reset accordingly.

---

## 7. Follow-up plans

- Multi-ray fire patterns (fan, grid, cone) using `rays[]`.
- A batched physics query message (p142 §7) if multi-ray physics fire gets heavy.
- A shape-cast tester (`castShape`) with a shape outline helper.
