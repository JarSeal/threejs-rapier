Status: draft | not-implemented
Category: Debugger

# Current Entity Data Source Information on Edit Windows — Plan

Shows, on the Camera and Light debug edit windows, where an entity's current values actually came from (scene config JSON vs. scene TypeScript code) and whether a saved localStorage debug override is currently active — plus tags every entity with its origin, and extends the existing localStorage override mechanism so it also applies in `?isProdTest=true` mode, not just `?isDebug=true`.

---

## 1. Goal

- Every Camera/Light edit window shows an **"Origin"** (Scene Config JSON vs. Scene Code), a **"Persistable"** flag (whether the entity has an `appId` and can therefore have a saved debug override at all), and a **"Local storage override"** status (Active/None for the current scene), plus a short static line describing the precedence order.
- Entities are tagged at creation time with where their config came from, so this is derived from real data, not guessed.
- The existing localStorage → entity-creation override merge (already implemented, see §2.3) is extended to also run under `?isProdTest=true`, not just `?isDebug=true`, without pulling the full Tweakpane debug-GUI code into prod-test builds.

---

## 2. Current state (grounded in the actual code)

### 2.1 The three data sources

- **Scene config JSON**: `.camera.json`/`.light.json` asset files (e.g. `src/app/cameras/mainCamera.camera.json`, `src/app/lights/ambientLight.light.json`), referenced by string id from a `*.scene.json`'s `cameras`/`lights` arrays (e.g. `src/app/testECS.scene.json:7-8`). Baked by `devTools/gatherAppData.ts` into `src/_engine/generatedAppData.json`, and instantiated by `src/_engine/core/SceneLoader.ts`'s `createCameras()` (`SceneLoader.ts:187-215`, called before the scene's own `.ts` code runs, `SceneLoader.ts:478`) and `createNextSceneObject3Ds()` (`SceneLoader.ts:290-335`, called after it, `SceneLoader.ts:492`) — each looping the scene's resolved camera/light props and calling `createCameraEntity(props.camProps, props.entityOpts)` (`SceneLoader.ts:203`) / `createLightEntity(props.lightProps, props.entityOpts)` (`SceneLoader.ts:296`).
- **Scene TypeScript code**: entities created directly inside a scene's own module by calling `createCameraEntity`/`createLightEntity` with hand-written props, bypassing the JSON pipeline entirely. Concrete example: `src/app/testECS.ts:21-31` (`orthoCamera`) and `:54-116` (`hemisphereLight`, `pointLight`, `directionalLight`, `topSpotLight`) — none of these have a matching `.camera.json`/`.light.json` file. This scene mixes both: it also references JSON-config `mainCamera`/`ambientLight` via its scene JSON.
- **localStorage debug override**: saved by the debug edit windows themselves, see §2.2/§2.3.

### 2.2 localStorage storage shape and read/write points

- Camera — `src/_engine/core/Debug/Camera/_dbg__CameraGUI.ts`: LS key `AEK_debugCams` (`LS_KEY`, line 58), shape `{ [sceneId]: { cams: { [appId]: CamEntityDebugState }, debugCam } }`. Every field edit calls `saveCameraToLS(entityId, key, value)` (line 361) immediately on `on('change')`, gated by `appIdComp?.isFixed` (line 368) — non-`appId` entities are silently never saved. Read: `loadCameraDebugData(appId)` (lines 345-359), keyed by `getCurrentSceneId()` + `appId`.
- Light — `src/_engine/core/Debug/Light/_dbg__LightGUI.ts`: mirrors Camera exactly. LS key `AEK_debugLights` (`LS_LIGHTS_KEY`, line 65), `saveLightToLS` (line 833, gated at line 841), `loadLightDebugData(appId)` (lines 805-819).
- Both edit windows already have a "Footer Info" block resolving `debugData`/App ID (`_dbg__CameraGUI.ts:124-143`, `_dbg__LightGUI.ts:210-229`) — the natural place to extend for §4, not a new UI section.

### 2.3 The existing merge point (already works for both JSON and code entities)

`src/_engine/core/PropertyLoader.ts:16-37` (`loadPersistentProps`) is called identically from `CameraManager.createCameraEntity` (`CameraManager.ts:136`) and `LightManager.createLightEntity` (`LightManager.ts:157`) — **regardless of whether the entity came from JSON config (§2.1, step 2/5 in the load order) or scene code (step 4)**. Precedence, per the code's own comment (`PropertyLoader.ts:31`): `Hardcoded < Saved File Props (stub, unimplemented) < Saved LS Props`.

This means: **a scene-code entity's hardcoded initial values are already overridable by saved localStorage debug data today**, exactly like a JSON-config entity — no new override mechanism is needed. The one hard requirement is an explicit `appId` on the entity (`entityOpts.appId` or `camProps.appId`/`lightProps.appId`), which sets `APP_ID.isFixed = true` (`ECS.ts:442-448`); without it, `loadPersistentProps` has nothing to key a lookup on (`PropertyLoader.ts:20-21`) and the save functions refuse to write (§2.2). This — not "JSON vs. code" — is the most likely actual cause of the reported "sometimes it doesn't survive a refresh" confusion, and is exactly what §4's "Persistable" indicator surfaces.

### 2.4 `IS_DEBUG_ENV` vs `IS_PROD_TEST_MODE` gating

`src/_engine/core/Config.ts`: `IS_DEBUG_ENV` (186-187) requires a dev/test build **and** `?isDebug=true`; `IS_PROD_TEST_MODE` (198-199) requires a dev/test build **and** `?isProdTest=true` — independent flags, neither implies the other.

The LS-override merge is gated **exclusively on `IS_DEBUG_ENV`**, at every layer:
- `PropertyLoader.ts:28` — `if (IS_DEBUG_ENV) { ... }` around the actual merge.
- `CameraManager.ts:40` / `LightManager.ts:15` — the debug-GUI modules (`cameraDebugGUI`/`debugGUI`), which `getSavedDebugProps` reads through (`PropertyLoader.ts:39-46`), are only ever loaded via `loadDebugModule()` (`utils/helpers.ts:453-457`: `if (!IS_DEBUG_ENV) return null;` — no prod-test escape hatch on this sync loader, unlike the async `loadDebugModuleAsync`'s `includeInProdTestMode` param used elsewhere for Character/MainLoop/OnScreenTools).

So today, a `?isProdTest=true` session (no `?isDebug=true`) never applies saved debug overrides — it only ever sees JSON-config/scene-code hardcoded values. This is a gap relative to the intent of prod-test mode (a production build with a *subset* of debug features) and should be closed for the read side.

---

## 3. Design — Phase 1: Tag entities with their config origin (non-breaking, isolated)

Add an optional `source` field to the entity debug-data schema, defaulted generically, tagged explicitly for the JSON path:

- `src/_engine/schemas/_helperSchemas.ts:56-69` (`EntityDebugDataSchema`): add `source: z.enum(['sceneConfig', 'sceneCode']).optional()`.
- `src/_engine/core/ECS.ts:442-455` (`createEntity` — the single generic entity-creation entry point shared by every manager, camera/light/mesh/group alike): default it when absent —
  ```ts
  this.addComponent(id, CoreComponentType.DEBUG_DATA, {
    ...opts?.debugData,
    source: opts?.debugData?.source ?? 'sceneCode',
  });
  ```
  `'sceneCode'` becomes the implicit default for anything created without an explicit source — correct for hand-written scene `.ts` entities, and generic enough to cover Mesh/other entity types later at no extra cost.
- `src/_engine/core/SceneLoader.ts`: tag `entityOpts.debugData.source = 'sceneConfig'` before the manager call, in both JSON-driven loops:
  - `createCameras()` (`SceneLoader.ts:187-215`), at the `createCameraEntity(props.camProps, props.entityOpts)` call (`SceneLoader.ts:203`).
  - `createNextSceneObject3Ds()` (`SceneLoader.ts:290-335`), at the `createLightEntity(props.lightProps, props.entityOpts)` call (`SceneLoader.ts:296`).

No change needed in `CameraManager.createCameraEntity`/`LightManager.createLightEntity` — `entityOpts` already flows straight through to `world.createEntity(entityOpts)` unmodified (`CameraManager.ts:163`).

This phase alone is invisible (no UI change yet) and safely committable on its own.

## 4. Design — Phase 2: Show origin + precedence on the edit windows

Extend the existing Footer Info blocks:

- `src/_engine/core/Debug/Camera/_dbg__CameraGUI.ts` — `createEditCameraContent` (line 65), footer (lines 124-143).
- `src/_engine/core/Debug/Light/_dbg__LightGUI.ts` — `createEditLightContent` (line 176), footer (lines 210-229).

Add, per window, reusing the existing `winSmallLabel` styling:

- **Origin**: "Scene Config (JSON)" / "Scene Code", from `debugData.source`.
- **Persistable**: "Yes" / "No — no appId set" from `appIdComp.isFixed`; when "No", an inline warning that edits here won't survive a refresh.
- **Local storage override**: "Active" / "None" — from whether `loadCameraDebugData(appId)`/`loadLightDebugData(appId)` returns data for the current scene.
- A short static precedence line: `Scene Config / Scene Code → Local Storage (debug-mode override, highest precedence)`.

Depends on Phase 1 for `Origin`; independently committable otherwise.

## 5. Design — Phase 3: Extend the localStorage override to `?isProdTest=true`

Read-only extension — writing remains `IS_DEBUG_ENV`-only (the debug GUI is the only writer, per §2.2). To avoid pulling the full Tweakpane-based edit-window modules into prod-test builds just to read two localStorage keys, extract the plain read functions into small, dependency-free modules:

- New `src/_engine/core/Debug/Camera/CameraDebugStorage.ts` (not `_dbg__`-prefixed — must always be bundled): move `CamEntityDebugState`, `CamSceneDebugState`, `CamDebugLSData`, `LS_KEY`, and `loadCameraDebugData()` (currently `_dbg__CameraGUI.ts:345-359`) here. Only deps: `lsGetItem` (`utils/LocalAndSessionStorage.ts`), `getCurrentSceneId` (`Scene.ts`) — no Tweakpane/UI imports.
- New `src/_engine/core/Debug/Light/LightDebugStorage.ts`: same treatment for `LightEntityDebugState`, `LightDebugLSData`, `LS_LIGHTS_KEY`, `loadLightDebugData()` (currently `_dbg__LightGUI.ts:805-819`).
- `_dbg__CameraGUI.ts`/`_dbg__LightGUI.ts` re-import/re-export these from the new modules — every existing call site (`saveCameraToLS`, `clearCameraFromLS`, the edit-window builders) keeps working unchanged; pure extraction, no behavior change to the debug GUI.
- `src/_engine/core/PropertyLoader.ts`: import `loadCameraDebugData`/`loadLightDebugData` directly from the new lean modules (not via `useDebug(cameraDebugGUI)`/`useDebug(debugGUI)`), and widen the gate at `PropertyLoader.ts:28` from `if (IS_DEBUG_ENV)` to `if (IS_DEBUG_ENV || IS_PROD_TEST_MODE)`.
- No change to `loadDebugModule`'s `IS_DEBUG_ENV`-only gating, nor to `CameraManager.ts:40/406`/`LightManager.ts:15` — the edit-window GUI, camera/light helpers, and debug orbit camera remain `IS_DEBUG_ENV`-only exactly as today; only the LS-read side becomes available in prod-test mode.

Independently committable; benefits from (but doesn't strictly require) Phases 1-2.

---

## Verification

1. `yarn build` (`tsc`) — schema change, `ECS.ts` default, `SceneLoader.ts` tagging, and the new storage modules type-check; `_dbg__CameraGUI.ts`/`_dbg__LightGUI.ts` still compile after re-exporting.
2. `yarn dev` with `?isDebug=true`, load `sceneTestECS` (mixes JSON-config `mainCamera`/`ambientLight` with scene-code `orthoCamera`/`hemisphereLight` etc.):
   - Open each entity's edit window — confirm "Origin" reads correctly, "Persistable: Yes" for all (all have `appId`s), "Local storage override: None" initially.
   - Edit a value on both a JSON-origin and a code-origin entity, refresh — confirm both persist and the window now reports "Local storage override: Active".
   - Create/inspect an entity without an `appId` — confirm "Persistable: No" with the warning, and that an edit to it does not survive refresh.
3. Reload with `?isProdTest=true` (no `?isDebug=true`) after saving overrides in step 2 — confirm camera/light entities pick up the previously-saved localStorage values, and (via `dist-stats/bundle-stats.html` from `yarn build`, or inspecting network/chunk loads) confirm the full `_dbg__CameraGUI`/`_dbg__LightGUI` modules are *not* loaded in this mode.
4. `yarn lint` — Stop hook runs lint + type-check; confirm clean.
