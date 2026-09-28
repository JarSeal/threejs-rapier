Status: draft | not-implemented
Category: Skybox, Refactor
Blocked by: p110_skybox-refactor-and-layered-sky-system.md (the Phase 0 spike / go-no-go gate)
Blocks: p112_procedural-sky-atmosphere-sun-and-env-bake.md, p115_debug-environment-ball-viewport.md
Related: p105_refactor-debugger-drawer-tab-creation.md (Phase 4 migrates the Skybox tab; see Risks)

# SkyBox Core Refactor and Layered Schema — Plan

This plan is the clean refactor that the rest of the p110 epic builds on. It adds no new visual features. It does these things:

- Replaces the flat `equiRect*` / `cubeText*` state with the **layered definition** from p110 (only the `base` and `env` layers are implemented here).
- Replaces the tangled `isCurrent` / `isDefaultForScene` / localStorage flow with the **explicit state flow** from p110 (registry → one active skybox → debug overrides).
- Fixes the bugs listed in p110's Context.
- Moves the code into `src/_engine/core/SkyBox/`, and rewrites the Skybox debugger tab folder by folder.

Legacy `createSkyBox` props and legacy JSON keep working through an adapter, so the app runs unchanged until Phase 4 migrates it.

## Context

See p110 "Context" (everything that is wrong today, with file:line) and Phase 0 §0.2, §0.7. Two facts drive the design:

- **Environment sampling is wrong today.**
  - `SkyBox.ts:290-298` builds one node, `pmremTexture(pmrem, normalWorld, pmremRoughnessBg)`, and uses it for both `backgroundNode` and `environmentNode`.
  - Its explicit UV and level stop `EnvironmentNode`'s radiance and irradiance contexts from applying (`PMREMNode.js:333-358`, `EnvironmentNode.js:78-89`).
  - So the environment must be a bare `pmremTexture(pmrem)`, separate from the background node.
- **`getPMREMTexture` (`SkyBox.ts:113-156`) is correct and must move unchanged.** That includes its WeakMap cache, its reuse of `cached.target` on a `pmremVersion` bump, dispose-with-source, and the generator disposed per bake once the renderer has initialized. `Scene.ts:240-245` and `SceneAssetRelease.ts:50-56` depend on `getActiveSkyBoxTexture()` and `getSceneSkyBoxTextureIds()`.

## Design decisions

1. **The definition type comes from the schema.**
   - `src/_engine/schemas/skyBoxSchema.ts` defines `SkyBoxDefSchema`: `id`, `isDefault?`, `preset?`, `base`, `env?`, `debugData?`, and the meta fields (`$schema`, `__sourcePath`, `__saveData`).
   - `base` is a discriminated union on `type`:
     - `COLOR`: `color`.
     - `EQUIRECTANGULAR`: `file?`, `path?`, `textureId?`, `colorSpace?`, `rotate?`, `intensity?`. It needs at least one of `file` / `textureId`, checked with `.refine`.
     - `CUBE_TEXTURE`: `fileNames` (length 6), `path?`, `textureId?`, `colorSpace?`, `rotate?`, `flipY?`, `intensity?`.
   - `env`: `backgroundRoughness`, `backgroundIntensity`, `environmentIntensity`, plus the bake fields from p110 (`size`, `dynamic`, `updateAngleDeg`, `maxUpdatesPerSec`). The bake fields are accepted and ignored until p112.
   - All later layer keys (`atmosphere`, `suns`, `moons`, `ambientLight`, `clouds`, `ground`, `stars`, `dayNight`, `nebulae`) are added by their plans as optional schema objects. Adding them later is non-breaking.
   - The runtime type is `SkyBoxDef = z.input<typeof SkyBoxDefSchema> & { base: … & { texture?: THREE.Texture } }`, so code can pass an already-loaded texture.
   - The type lives in `SkyBox/SkyBoxTypes.ts` as `import type` from the schema, following the `AppECSRegistry.ts` convention.
2. **One legacy adapter, used by both JSON and runtime.**
   - `SkyBox/legacySkyBox.ts` exports `fromLegacySkyBoxProps(input): SkyBoxDef | null`. It maps:
     - `{ type: 'EQUIRECTANGULAR', params }` → `base.type: 'EQUIRECTANGULAR'`, with `roughness` → `env.backgroundRoughness`.
     - `{ type: 'CUBETEXTURE' | 'CUBEMAP', params }` → `base.type: 'CUBE_TEXTURE'`, with `fileNames` or `fileName` → `fileNames` (a single string is split on `,`), and `cubeTextRotate` or `cubeTextureRotate` → `rotate`.
       - The old rotate value was a multiple of π (`makeRotationY(Math.PI * rotate)`, `SkyBox.ts:333`). **It is converted to radians**, and `rotate` is radians from here on.
     - `isCurrent` → `isDefault`.
     - `{ type: '' }` → `null`, meaning "no skybox".
     - `{ type: 'SKYANDSUN' }` → a `COLOR` base plus an `lwarn` that the type now lives in p112's `atmosphere` layer.
   - The schema wraps it with `z.preprocess`, so legacy JSON validates, and `createSkyBox` calls it for legacy objects.
   - Each id warns **once** in dev: "legacy sky box shape, see p111 migration notes".
3. **The data pipeline** (`devTools/gatherAppData.ts`):
   - Run `SkyBoxDefSchema.safeParse` at `:543`, like every other asset type. On failure, report through the Vite overlay path.
   - At `:906-925`:
     - keep `debugData` outside production;
     - carry `isDefault`;
     - **deep-merge** `__saveData[sceneId][0]` (minus `__meta`) over the definition, instead of spreading it into `params`;
     - drop the `params` flattening.
   - `SkyBoxOverridesSchema` becomes `DeepPartial` of the definition's layer objects, built with Zod `.deepPartial()` or a manual equivalent. `textureId` is no longer required.
   - `.schemas/skyBox.schema.json` regenerates automatically.
4. **Module layout** (the parts p111 creates; the rest of p110's layout comes later):

   - `SkyBox/SkyBox.ts`: the facade.
   - `SkyBox/SkyBoxTypes.ts`.
   - `SkyBox/legacySkyBox.ts`.
   - `SkyBox/SkyEnvironment.ts`: `getPMREMTexture`, moved verbatim.
   - `SkyBox/layers/base.ts`.

   `src/_engine/core/SkyBox.ts` becomes a re-export shim during Phases 2–3, so imports don't all have to change at once, and is deleted in Phase 4.

5. **State flow** (p110 "State flow"):
   - **Registry.** `registry: Map<sceneId, Map<id, SkyBoxDef>>`. `registerSkyBox(def, sceneId?)` defaults the scene to the loading scene (`isCurrentlyLoading() ? getNextSceneId() : getCurrentSceneId()`, the same rule as `SkyBox.ts:167-172` today). Re-registering an id replaces it.
   - **Active skybox.** `active: ActiveSkyBox | null`, holding `{ id, sceneId, def (resolved), uniforms, nodes, textures }`.
   - **Activation.** `setActiveSkyBox(id | null, sceneId = current)`:
     1. resolves the def, deep-merged with debug overrides when `isDebugEnvironment()`;
     2. loads textures;
     3. builds the nodes;
     4. assigns `backgroundNode` / `environmentNode`;
     5. sets `scene.environmentIntensity` / `backgroundIntensity` / `environmentRotation`;
     6. notifies the `onSkyBoxChange` listeners and the debug GUI.
        Activation is **serialized**: a second call during an `await` wins, and the stale one is dropped by a sequence number, instead of racing the way `selectSkyBox`'s `setTimeout` does today.
   - **`createSkyBox(defOrLegacy)`.** Adapter, then register, then activate if the def belongs to the current scene and `isDefault !== false`. If it belongs to the loading scene, it only registers; the scene default is activated by the loader. This keeps today's call semantics.
   - **`clearSkyBox()`.** Nulls the nodes, clears the scene intensities and rotation, resets `active`, and notifies.
   - **Scene switch.** `SceneLoader.ts:538` calls `activateSceneDefaultSkyBox(sceneId)`, which picks the `isDefault` def or else the first one registered. It replaces `applySkyBoxForScene`. `Scene.ts:741` calls `registerSkyBox` instead of `createSkyBox({ …, isCurrent: false })`.
   - **Released textures.** `getSceneSkyBoxTextureIds(sceneId)` reads the registry's `base.textureId`s.
   - **The scene's own background.** `Scene.ts:271-291` still applies scene `backgroundColor` / `backgroundTexture` in `setCurrentScene`. Activating a skybox overrides them, and clearing it restores nothing, as today. `setCurrentScene` also resets `rootScene.environmentNode = null` (a missing reset, `:272-273`).
6. **The base layer** (`layers/base.ts`) builds two nodes from one PMREM:
   - **Background:**
     - For `EQUIRECTANGULAR` / `CUBE_TEXTURE`: `pmremTexture(getPMREMTexture(tex), lookupDir, uBgRoughness).mul(uBaseIntensity)`.
     - `lookupDir` is `normalWorldGeometry`, optionally flipped (see flipY below). Rotation goes through `scene.environmentRotation`, which `PMREMNode` applies for both background and environment (`PMREMNode.js:346-348`).
     - Phase 2 must check whether the background also picks up `backgroundRotation`; `Background.js:93` only reaches nodes without an explicit UV, and ours has one. If it does, keep `backgroundRotation` at identity.
     - For `COLOR`: `uniform(color)`. The environment stays `null` in p111; p112 adds an optional solid-colour bake.
   - **Environment** (texture bases): a bare `pmremTexture(getPMREMTexture(tex))`. **The cube path now sets it too.**
   - **Cube `flipY` / mirror.**
     - Today, a lookup of `vec3(-x, ±y, z)` fixes cube map handedness for the background only (`SkyBox.ts:336-340`).
     - The environment direction comes from the lighting context, so it needs the same correction. Wrap the env node in a context whose `getUV` maps the parent context's direction through the same flip.
     - If context chaining turns out not to work in r186, fall back: at load, bake the flipped cube once into a `CubeRenderTarget` (6 renders; `CubeRenderTarget.fromEquirectangularTexture`-style), then run `getPMREMTexture` on that.
     - Phase 2 validates this with a reflective sphere.
   - **Roughness.**
     - `uBgRoughness` is a per-skybox uniform. It is **never a module-global default**. "Reset" goes back to the _definition's_ value.
     - Material roughness keeps driving the environment through the lighting context.
   - **Colour space.** `colorSpace` defaults to sRGB, or to linear-sRGB for `.hdr` files (`isHDR`, `utils/helpers.ts:23`). **An empty string is treated as unset**, fixing the `basicSkybox` `__saveData` case.
   - **Texture loading** uses `loadTextureAsync` (`Texture.ts:412-488`, cached by id), exactly as today, including `useHDRLoader` for `.hdr` files. The `@TODO: cache equirectangular textures` is covered by the id cache. The `path` is kept in the def, fixing the lost-path bug.
7. **Debug tab rewrite** (`core/Debug/_dbg__SkyBox.ts` + `core/Debug/SkyBox/_dbg__BaseFolder.ts`, `_dbg__EnvironmentFolder.ts`).

   - **Layout:**
     - **"Sky boxes in scene"**: a dropdown with `[*default]` and "[No skybox]".
     - **"Base"**: type (read-only), file/path/texture id/colour space (read-only), rotate, flipY (cube), intensity.
     - **"Environment"**: background roughness, background intensity, environment intensity, and a "Reset layer" button.
     - **"Copy JSON"**: copies the resolved def, minus meta, to the clipboard. It exists because there is no JSON write-back (p110 Non-goals).
   - **Rebuilds.**
     - Folders are rebuilt with `{ hidden }`, instead of the dispose-all-blades loop (`_dbg__SkyBox.ts:234-237`).
     - The tab no longer receives state objects to hold on to (`_dbg__SkyBox.ts:39-42`). It reads `getActiveSkyBox()` and a new debug accessor, `_getSkyBoxRegistry()`.
   - **Overrides.**
     - `AEK_debugSkyBox = { [sceneId]: { [skyBoxId]: DeepPartial<SkyBoxDef> } }` stores only the values changed from the definition.
     - A value edited back to the definition is **removed** from the override, and an empty override is deleted.
     - `SkyBox.ts` reads the key **only** inside `if (isDebugEnvironment())`, as today (`SkyBox.ts:203-205`), so production never touches LS.
   - **LS migration.** A one-time `migrateLegacySkyBoxLS()` runs in the debug module's init. For each `AEK_debugSkyBoxStates[sceneId][id]`, it copies an `equiRectRoughness` or `cubeTextRoughness` that is non-zero and differs from the definition into `env.backgroundRoughness`, then calls `lsRemoveItem('AEK_debugSkyBoxStates')`. The clear-LS buttons (`_dbg__ClearLSButtons.ts`) switch to the new key and keep the scene-scope confirm.
   - **Undo/redo.** The old action types are replaced, and their handlers keep resolving by scene + id each time, never by a stale reference:

     | Action              | Recorded from                                                                           | Coalesced                                 | Undo/redo does                                                                       |
     | ------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
     | `skybox.param`      | any layer binding: `{ sceneId, skyBoxId, path: 'env.backgroundRoughness', prev, next }` | yes, key `${sceneId}.${skyBoxId}.${path}` | `updateSkyBox(id, set(path, value))` + override write                                |
     | `skybox.resetLayer` | "Reset layer"                                                                           | no                                        | restores the whole layer object's override (payload holds the prev override subtree) |
     | `skybox.select`     | the dropdown                                                                            | no                                        | `setActiveSkyBox(prev/next)`, including `null`                                       |

     `skybox.param` is the one action later plans use for every new layer, so p112–p114 add bindings without adding action types.

   - `_dbg__SkyBox.ts` keeps `createDebuggerTab({ id: 'skyBoxControls', orderNr: 5 })` and the `cloudSun` icon. If p105 Phase 2 has landed, write the tab against its pane builder instead (see Risks).

8. **Dead code removed:**
   - the commented env ball code (`SkyBox.ts:285-288, 300-304, 350-354`; `_dbg__SkyBox.ts:276-277, 292-293, 351-352, 376-377`);
   - `SkyBoxState.envBallRoughness`;
   - `DebugToolsState.env` in both `debug/DebugToolsManager.ts:8-57` and `core/Debug/_dbg__DebugTools.ts:44-51`. p115 adds a fresh top-level `envBall`. The shallow LS merge (`_dbg__DebugTools.ts:96-97`) leaves an old `env` key in saved state as harmless dead data.
9. **Public API after p111** (`SkyBox/SkyBox.ts`):

   - `registerSkyBox`, `createSkyBox`, `setActiveSkyBox`, `getActiveSkyBox`, `updateSkyBox`, `clearSkyBox`;
   - `getActiveSkyBoxTexture`, `getActiveEnvironmentTexture`, `getSceneSkyBoxTextureIds`, `onSkyBoxChange`;
   - `registerSkyBoxDebugGUI`, `createSkyBoxDebugGUI` (a thin `useDebug` wrapper, as now);
   - types `SkyBoxDef`, `ActiveSkyBox`.

   For `updateSkyBox`, each layer module declares which of its keys are **structural** (for base: `type`, `file`, `fileNames`, `textureId`, `flipY`). A structural change re-runs activation; anything else only writes uniforms or scene properties.

## Migration notes (app code)

- Existing calls keep working with a dev warning. The new form is:
  ```ts
  // before
  createSkyBox({
    id: 'desert-dunes',
    type: 'CUBETEXTURE',
    params: {
      fileNames: map02,
      path: '/debugger/assets/testTextures',
      textureId: 'cubeTextureId',
      cubeTextRotate: 0.5,
    },
  });
  // after
  createSkyBox({
    id: 'desert-dunes',
    base: {
      type: 'CUBE_TEXTURE',
      fileNames: map02,
      path: '/debugger/assets/testTextures',
      textureId: 'cubeTextureId',
      rotate: Math.PI * 0.5,
    },
  });
  ```
- `params.roughness` becomes `env.backgroundRoughness`. `isCurrent` becomes `isDefault`.
- `rotate` is now in radians. The old `cubeTextRotate` was a multiple of π.
- Removed exports, all engine-internal in practice (no `src/app` or `src/toolkit` usage):
  - `defaultRoughness`, `defaultSkyBoxState`, `SkyBoxState`, `LS_KEY_ALL_STATES`, `NO_SKYBOX_ID`;
  - `extractSkyBoxParamsFromState`, `getEnvMapRoughnessBg`, `getCurSceneSkyBoxSceneId`, `deleteCurrentSkyBox` (use `setActiveSkyBox(null)`), `applySkyBoxForScene`.
- JSON: legacy `*.skybox.json` still validates through the adapter. Migrate to `base` / `env` (see Phase 4).

## Files touched

| File                                                                                                                   | Change                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/_engine/schemas/skyBoxSchema.ts`                                                                                  | Layered `SkyBoxDefSchema` (base + env), `z.preprocess` legacy adapter, deep-partial overrides       |
| `src/_engine/core/SkyBox/SkyBox.ts` (new)                                                                              | Facade: registry, activation, update, clear, listeners                                              |
| `src/_engine/core/SkyBox/SkyBoxTypes.ts` (new)                                                                         | Types (`import type` from the schema)                                                               |
| `src/_engine/core/SkyBox/legacySkyBox.ts` (new)                                                                        | `fromLegacySkyBoxProps`                                                                             |
| `src/_engine/core/SkyBox/SkyEnvironment.ts` (new)                                                                      | `getPMREMTexture` + `isPMREMSourceReady`, moved verbatim                                            |
| `src/_engine/core/SkyBox/layers/base.ts` (new)                                                                         | Base background/env nodes, uniforms, structural keys                                                |
| `src/_engine/core/SkyBox.ts`                                                                                           | Re-export shim (Phases 2–3), deleted in Phase 4                                                     |
| `src/_engine/core/Scene.ts`                                                                                            | `registerSkyBox` at `:741`; `SceneData.skyboxes` type; `environmentNode` reset in `setCurrentScene` |
| `src/_engine/core/SceneLoader.ts`                                                                                      | `activateSceneDefaultSkyBox` at `:538`; `clearSkyBox` at `:499` unchanged                           |
| `src/_engine/core/Assets/SceneAssetRelease.ts`, `src/_engine/InitApp.ts`                                               | Import paths                                                                                        |
| `devTools/gatherAppData.ts`                                                                                            | `safeParse`, `debugData`, deep-merge `__saveData`, no `params` flattening                           |
| `src/_engine/core/Debug/_dbg__SkyBox.ts` + `core/Debug/SkyBox/_dbg__BaseFolder.ts`, `_dbg__EnvironmentFolder.ts` (new) | Tab rewrite, overrides, LS migration, undo actions, Copy JSON                                       |
| `src/_engine/debug/DebugToolsManager.ts`, `src/_engine/core/Debug/_dbg__DebugTools.ts`                                 | Remove the dead `env` state                                                                         |
| `src/app/scene01.ts`, `scene01_v2.ts`, `scene_thirdPersonGym.ts`, `src/app/skyboxes/basicSkybox.skybox.json`           | Phase 4 migration                                                                                   |
| `.claude/CLAUDE.md`                                                                                                    | A "Sky box" paragraph under Architecture (Phase 4)                                                  |
| `package.json`                                                                                                         | Engine major + app patch (Phase 4; see p110 Versioning)                                             |

## Phases

Each phase compiles, lints, and leaves every app scene rendering as before, or better where a bug is fixed.

1. **Schema v2 + adapter + pipeline** (no runtime change).
   - Add `SkyBoxDefSchema`, `fromLegacySkyBoxProps` and `SkyBoxTypes.ts`, plus the `gatherAppData` validation, `debugData` and deep-merge changes.
   - Runtime `SkyBox.ts` still consumes the old shape: `Scene.ts:741` passes JSON through a `toLegacyProps` shim, which Phase 2 deletes.
   - Verify: `yarn gatherAppData` validates `basicSkybox`, the generated JSON is unchanged apart from `debugData` / `isDefault`, and a deliberately broken skybox JSON shows the Vite overlay.
2. **New module + base layer + state flow.**
   - Add `SkyBox/SkyBox.ts`, `SkyEnvironment.ts` and `layers/base.ts`. Wire `Scene.ts`, `SceneLoader.ts` and `SceneAssetRelease.ts` to it.
   - The old `core/SkyBox.ts` becomes a re-export shim. The old debug tab is temporarily reduced to the dropdown plus a background roughness slider on the new API.
   - Fixes land: the environment sampling, the cube environment, rotate for both texture types, flipY for the environment, `path` kept, `0` kept, and the empty colour space.
   - Verify: every app scene (see Verification) looks right. A reflective sphere in `scene01_v2` now shows view-dependent reflections, and roughness spheres blur correctly. The desert-dunes cube lights materials.
3. **Debug tab rewrite.**
   - Base + Environment folders, the dropdown, Copy JSON, the `AEK_debugSkyBox` overrides with LS migration, the new undo actions, the updated clear-LS buttons, and the dead `env` state removed.
   - Verify: edits persist per scene and id. Reverting a value to its definition removes it from LS. Undo and redo work for param, reset and select, including across the "[No skybox]" choice. The old key is migrated, then gone.
4. **App + JSON migration, shim removal, docs, version.**
   - Migrate the three app files and `basicSkybox.skybox.json` to the new shape. Delete `core/SkyBox.ts`, the shim, and any remaining legacy imports.
   - Update CLAUDE.md and bump the version.
   - Verify: no legacy warnings in the console for app scenes. `grep -rn "CUBETEXTURE\|cubeTextRotate\|equiRect\|extractSkyBoxParamsFromState" src/` returns only `legacySkyBox.ts`.

## Non-goals

- Procedural layers, env bakes and lights (p112–p114).
- The env ball (p115).
- Changing debug selection persistence, which stays session-only (p110 "State flow").
- Renaming the tab id `skyBoxControls`.

## Risks / open questions

| Risk                                                                                                                      | Mitigation                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The environment-sampling fix makes existing scenes look different: materials become more reflective, rough materials blur | This is a correctness fix. Call it out in the PR with before and after screenshots. App scenes may need a lower `env.environmentIntensity`; tune it in Phase 4.                                          |
| Cube flip for the environment through context chaining                                                                    | Phase 2 validates it; the fallback is a one-time corrected cube bake (DD6).                                                                                                                              |
| `rotate` changes unit (a multiple of π → radians)                                                                         | The adapter converts; migration notes.                                                                                                                                                                   |
| p105 Phase 4 rewrites the same tab                                                                                        | If p105's pane builder exists, write the new tab on it. Otherwise use the legacy API with one folder per layer builder, which maps 1:1 onto p105 sections. Update p105's Phase 4 bullet when this lands. |
| Deep-merged `__saveData` could change generated data for other scenes                                                     | Only `basicSkybox` has save data today. Diff `generatedAppData.json` in Phase 1.                                                                                                                         |
| Breaking-API bump                                                                                                         | p110 Versioning: major, possibly folded into p105's 2.0.0.                                                                                                                                               |

## Verification

- `yarn lint` + `yarn build` after each phase.
- `yarn dev`, `?isDebug=true`, using the `run-aekasha-js` skill for screenshots:
  - `scene01`: the desert-dunes cube; the environment now lights materials.
  - `scene01_v2`: switch between all four skyboxes and "[No skybox]"; undo and redo the selection.
  - `scene_thirdPersonGym`: two equirects.
  - `largeWorld` and `testECS`: JSON `basicSkybox`.
  - A scratch JSON cube skybox (reverted afterwards) now renders.
- Scene switching ten times leaves `renderer.info.memory.textures` stable, and the displayed skybox texture is never released.
- WebGPU and WebGL2 (`forceWebGL`), with PostFX on and off, on `largeWorld`.
- `?isProdTest=true` and a production build: no LS reads for skyboxes, and no `_dbg__SkyBox*` in the main chunk (`dist-stats/bundle-stats.html`).
