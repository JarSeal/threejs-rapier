Status: draft | feasibility study — not-implemented
Category: Skybox, Refactor, Rendering
Blocks: p111_skybox-core-refactor-and-layered-schema.md, p112_procedural-sky-atmosphere-sun-and-env-bake.md, p113_night-sky-and-day-night-cycle.md, p114_space-preset-and-nebula-creator.md, p115_debug-environment-ball-viewport.md
Related: \_DONE_p080_multi-viewport-rendering-and-axis-gizmo.md (the env ball viewport builds on it), \_DONE_p105_refactor-debugger-drawer-tab-creation.md (will migrate the SkyBox tab and the Debug Tools env ball options)

# SkyBox Refactor and Layered Sky System — Epic Plan

This is the main plan for replacing today's `SkyBox.ts` / `_dbg__SkyBox.ts` with a clean, **layered** sky system.

- **Layers.** Every skybox is built from the same optional layers, composited in a fixed order: a base (color, equirectangular or cube texture), atmosphere, sun(s), moon(s), stars, clouds, ground and nebulae.
- **Lights.** The sun and moon can own real ECS directional lights, plus an optional hemisphere light, all driven by the sky.
- **Day-night cycle.** It animates the whole sky through a public production API; the debug UI only controls that API.
- **Space.** A SPACE preset gives stars, one or more suns, and nebulae.
- **Env ball.** A debug environment ball becomes a viewport next to the p080 axes gizmo.

This file holds the **Phase 0 feasibility study** (research is done; one measured spike remains and gates the rest), the verdict, the target architecture shared by every sub-plan, and the sub-plan index. Implementation lives in p111–p115.

## Sub-plans

| Plan                                                 | Scope                                                                                                                                  | Blocked by   | Engine bump                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------- |
| `p111_skybox-core-refactor-and-layered-schema.md`    | Clean refactor: layered definition + schema v2 with legacy adapter, base layer, state flow, LS migration, debug tab rewrite, bug fixes | p110 Phase 0 | **major** (see Versioning) |
| `p112_procedural-sky-atmosphere-sun-and-env-bake.md` | Composite node builder, dynamic env bake, atmosphere, sun, managed ECS lights, clouds, ground                                          | p111         | minor                      |
| `p113_night-sky-and-day-night-cycle.md`              | Moon (+ light), stars, day-night production API, budgeted re-bakes, transport UI, showcase scene                                       | p112         | minor                      |
| `p114_space-preset-and-nebula-creator.md`            | Static-layer cube bake, nebula creator, multiple suns, SPACE / DAY_SKY / NIGHT_SKY presets                                             | p112, p113   | minor                      |
| `p115_debug-environment-ball-viewport.md`            | Env ball viewport left of the axes gizmo, F7, Debug Tools section                                                                      | p080, p111   | minor                      |

Order: p111 → p112 → p113 → p114. p115 can start as soon as p080 and p111 are both done, and runs in parallel with p112–p114.

## Context: what is wrong today (grounded in code)

- **State is flat, per type.**
  - `SkyBoxState` (`src/_engine/core/SkyBox.ts:59-78`) holds `equiRect*` and `cubeText*` fields side by side, plus `envBallRoughness` and a UI flag (`sceneSkyBoxesFolderExpanded`).
  - Every new type would add another set of fields.
- **Global mutable default.**
  - `export let defaultRoughness = 0` (`:82`) is overwritten by every `createSkyBox` call that passes `roughness` (`:196-201`, marked `@TODO`).
  - "Reset" in the debugger therefore resets to whatever the last created skybox passed.
- **The state flow is unclear.** `createSkyBox` (`:163-401`) does all of this in one function:

  - resolves the scene (current, given, or the one loading);
  - merges localStorage;
  - clears `isDefaultForScene` flags;
  - loads textures;
  - sets `rootScene.backgroundNode` / `environmentNode`;
  - rebuilds the debug GUI.

  `isCurrent`, `isDefaultForScene` and the LS copy are three overlapping notions of "which skybox is active". `applySkyBoxForScene` (`:516-528`) re-creates a skybox from its flattened state via `extractSkyBoxParamsFromState` (`:439-475`).

- **Bugs:**
  - **The equirect environment samples at the surface normal with the background roughness.** `SkyBox.ts:290-298` builds a single node, `pmremTexture(pmrem, normalWorld, pmremRoughnessBg)`, and uses it as both `backgroundNode` and `environmentNode`.
    - `PMREMNode` asks the lighting context for its UV and level only when `uvNode` / `levelNode` are null (`PMREMNode.js:333-358`).
    - `EnvironmentNode` supplies the reflection vector and the material roughness only through that context (`EnvironmentNode.js:78-89`, `createRadianceContext` / `createIrradianceContext`).
    - So today, every PBR material's radiance **and** irradiance sample the environment along the surface normal at roughness 0: no view-dependent reflections, and no diffuse convolution.
    - The fix, in p111, is two nodes: the background gets `pmremTexture(pmrem, dir, bgRoughness)`, and the environment gets a bare `pmremTexture(pmrem)`, so the lighting context drives UV and level. Rotation goes through `scene.environmentRotation` (`MaterialProperties.js:30-48`, applied inside `PMREMNode.js:346-348`).
  - **The cube texture path never sets `environmentNode`** (`:341-349`). Cube skyboxes don't light PBR materials, and an earlier skybox's environment can stay behind.
  - **`extractSkyBoxParamsFromState` uses `|| undefined`** (`:447, :459-461`), so a roughness or rotation of `0` is dropped.
  - **An equirect's `path` is never stored**, so re-applying it loses the path.
  - **The JSON schema and the runtime disagree.** `skyBoxSchema.ts:42-54` uses `type: 'CUBEMAP'`, `fileName: string` and `cubeTextureRotate`. The runtime (`SkyBox.ts:40-52`) uses `'CUBETEXTURE'`, `fileNames: string[]` and `cubeTextRotate`. `Scene.ts:741` just spreads the JSON through, so **a JSON cube skybox is silently recorded as type `CUBEMAP` and never renders.**
  - **`devTools/gatherAppData.ts:543` never `safeParse`s skybox JSON.** Every other asset type is validated (`:209, :243, :282, …`).
  - **`gatherAppData.ts:906-925` drops `debugData`**, and flattens `__saveData` into `params`.
  - `src/app/skyboxes/basicSkybox.skybox.json` carries an invalid `__saveData` override `colorSpace: ""` for `sceneTestECS`.
- **Unfinished pieces:**
  - `SKYANDSUN` is only an `lwarn` (`SkyBox.ts:368-372`).
  - Cube rotation is `@TODO` in both the runtime (`:49`) and the debugger (`_dbg__SkyBox.ts:366-374`).
  - The env ball is commented-out code (`SkyBox.ts:285-288, 300-304, 350-354`; `_dbg__SkyBox.ts:276-277, 292-293, 351-352, 376-377`). There is also a dead `DebugToolsState.env` block (`debug/DebugToolsManager.ts:8-48`, duplicated in `_dbg__DebugTools.ts:44-51`) that no UI binds.
- **Callers.**
  - Engine:
    - `InitApp.ts:102, :139`: `registerSkyBoxDebugGUI` and `createSkyBoxDebugGUI`.
    - `Scene.ts:240-245`: texture release in `deleteScene`.
    - `Scene.ts:741`: JSON skyboxes are registered with `isCurrent: false`.
    - `SceneLoader.ts:499`: `clearSkyBox` on exit.
    - `SceneLoader.ts:538`: `applySkyBoxForScene` on enter.
    - `Assets/SceneAssetRelease.ts:51`: `getActiveSkyBoxTexture`.
  - App: `scene01.ts:29` (cube), `scene01_v2.ts:24, 33, 42, 59` (three equirects and a cube), `scene_thirdPersonGym.ts:82, 92` (two equirects), and `largeWorld` / `testECS` through `basicSkybox.skybox.json`.
- **What already works and must be kept.**
  - `getPMREMTexture` (`SkyBox.ts:132-156`) bakes one PMREM per source texture and PMREM version, reuses the target on re-bake, and disposes it with its source texture.
  - This fixes PMREMNode's own leak, where a `pmremTexture(source)` bakes with a private generator and nothing disposes it.
  - `SceneAssetRelease` and `Scene.deleteScene` rely on `getActiveSkyBoxTexture` / `getSceneSkyBoxTextureIds` to avoid releasing the texture that is on screen.

## Phase 0 — Feasibility (research findings)

Everything below was checked against `node_modules/three` **0.186.1** and the current tree.

### 0.1 Composition: one `backgroundNode`, no sky mesh in the game scene

- **How a background node is drawn.** `Background.js:83-161` draws `scene.backgroundNode` on a `SphereGeometry(1, 32, 32)`.
  - The mesh has identity transform, `BackSide`, no depth, `lights = false`, and z forced to the far plane (`z = w`).
  - The colour node is `vec4(backgroundNode).mul(backgroundIntensity)`, with a context whose `getUV` is `backgroundRotation.mul(normalWorldGeometry)` and whose `getTextureLevel` is `backgroundBlurriness` (`:91-95`).
  - So **any TSL function of `normalWorldGeometry` (or `positionWorldDirection`) is a valid full-sky background.** `backgroundIntensity` always applies, but rotation and blurriness reach only texture-like nodes, so a procedural node has to apply its own.
  - The material is rebuilt when `backgroundNode.getCacheKey()` changes (`:148-159`). **Changing which layers exist costs a rebuild; changing a uniform costs nothing.**
- **`SkyMesh` can't be used as-is.** Two reasons, both in `examples/jsm/objects/SkyMesh.js`:
  - **Direction.** It computes the view direction as `normalize(positionWorld - cameraPosition)` (`:239`). That needs a real mesh around the camera, and is wrong on the background sphere.
  - **Varyings.** Its colour node reads varyings (`vSunDirection`, `vSunE`, `vBetaR`, `vBetaM`, `:151-154`) that only its own `vertexNode` writes (`:160-218`). The background material brings its own vertex node, so those varyings would never be written.
- **Placing `SkyMesh` in the scene doesn't help either.** It outputs an opaque `vec4(color, 1)` (`:381`), so a textured base, stars or nebulae behind it could never show through, which is the whole point of layering.
- **Decision: port SkyMesh's math into an engine TSL function of direction, `atmosphere(dir)`.** This is a deliberate deviation from "use `SkyMesh`" in the brief.
  - It keeps **the same parameters and defaults** (turbidity 2, rayleigh 1, mieCoefficient 0.005, mieDirectionalG 0.8, and the cloud set; `:58-128`).
  - It keeps the same constants, and the file header credits the MIT-licensed three.js source.
  - Its vertex-stage terms (sun direction, `sunE`, `betaR`, `betaM`, `sunfade`; `:160-212`) depend **only on uniforms**. So they are computed on the CPU when params change and uploaded as uniforms, which is cheaper than SkyMesh, where they run per vertex.
  - It keeps its clouds (`:280-379`: gradient noise, 4-octave fbm, Beer-powder shading, silver lining).
- **Where the composite goes.**
  - **The main view:** `rootScene.backgroundNode = composite(normalWorldGeometry)`, evaluated per pixel at full resolution, so stars and discs stay sharp.
  - **The env bake:** the **same builder**, with an `ENV_BAKE` compile flag, is the `backgroundNode` of a private `envBakeScene` (0.2).
  - There is no sky mesh, no second scene in the render loop, and nothing to cull.

### 0.2 Baking the result into the environment

- **`fromScene` renders a scene's `backgroundNode`.** `PMREMGenerator.fromScene(scene, sigma = 0, near = 0.1, far = 100, { size = 256, position, renderTarget })` (`src/renderers/common/extras/PMREMGenerator.js:133-171`) calls `renderer.render(scene, cubeCamera)` six times, into viewports of a CubeUV target (`_sceneToCubeUV`, `:448-551`). `renderer.render` goes through `Background.update`, which prefers `getBackgroundNode(scene)`, so a scene holding only a `backgroundNode` bakes correctly.
- **It is synchronous and safe to call.** It throws before `renderer.init()` (`:143-147`). The renderer is created and initialized before `InitEngine` runs (`src/index.ts:9` awaits `createRenderer`, which awaits `renderer.init()` at `Renderer.ts:49-81`). The bake is still deferred to the skybox system (0.3), never run inside `createSkyBox`.
- **Stable identity means no material rebuild.**
  - `pmremTexture(texture)` uses a texture as-is when it `isPMREMTexture` or has `CubeUVReflectionMapping` (`src/nodes/pmrem/PMREMNode.js:299-301`). `fromScene` targets are both (`PMREMGenerator.js:838-856`).
  - Material cache keys use the environment node's id (`NodeManager.js:637-680`, `Node.customCacheKey()` → id).
  - So `rootScene.environmentNode = pmremTexture(envTarget.texture)`, **re-baked into the same target** via `{ renderTarget }`, never changes the node graph. The node has no explicit UV or level, so the lighting context drives both (see the first bug under Context).
  - `_init` reuses the ping-pong target, the LOD planes and the GGX material while the target size stays the same (`:419-437`). **The env size must therefore be fixed per skybox**, because a size change reallocates the working set and rebuilds its materials.
- **Texture-only skyboxes keep today's path.** A skybox with only a texture base and no procedural layers keeps `pmremTexture(getPMREMTexture(texture), dir, roughness)` exactly as now: no `fromScene`, no per-frame cost, and the same cache and dispose logic. Only a skybox with procedural layers uses a bake target.
- **What the `ENV_BAKE` variant changes:**
  - **Sun and moon discs are left out** when their layer has an integrated light, because the directional light already provides that specular term; including them too would double-count. With no light, the bake uses a clamped, wider glow instead.
  - Either way this avoids GGX fireflies: the sun disc peaks near `min(sunE·Fex, 80)·760 ≈ 60,800` (`SkyMesh.js:275-278`), next to the half-float max of 65,504. This is why SkyMesh's own docs say to hide the disc for bakes (`:29-37`).
  - **Stars are left out.** They are sub-texel at bake sizes and contribute nothing to irradiance.
  - **Clouds are frozen at the bake time**, using a uniform time instead of the `time` node.
- **The PBR path is correct.** Only `MeshStandardNodeMaterial` and its subclasses read `builder.environmentNode` (`MeshStandardNodeMaterial.js:106-116`). Radiance and irradiance are scaled by `scene.environmentIntensity` (`EnvironmentNode.js:79, 89`; `MaterialProperties.js:21-25`), which the skybox sets from `env.environmentIntensity`.
- **The env ball (p115) samples the same PMREM texture** that `getActiveEnvironmentTexture()` returns: the texture PMREM or the bake target.

### 0.3 PMREM re-bake cost and the chosen strategy

| `env.size` | LODs | `render()` calls per bake | GGX texel fetches (≈) | Estimated GPU time                     |
| ---------- | ---- | ------------------------- | --------------------- | -------------------------------------- |
| 256        | 11   | 26 (6 faces + 20 GGX)     | ~36 M                 | ~0.5–1.5 ms desktop dGPU, ~2–5 ms iGPU |
| 128        | 10   | 24                        | ~9 M                  | ~0.2–0.5 ms dGPU, ~0.8–1.5 ms iGPU     |
| 64         | 9    | 22                        | ~2.3 M                | draw-call bound, ~0.2–0.5 ms           |

- **Where the counts come from.**
  - `LOD_MIN = 4`, `EXTRA_LODS = 6` and `GGX_SAMPLES = 256` (`PMREMGenerator.js:33-44`).
  - Each GGX step is two draws: filter into the ping-pong target, then copy back (`:620-666`).
  - The fetch counts sum 256 samples over each filtered level. The largest level at size 256 is 384×256 texels.
- **The times are estimates**, which the Phase 0 spike replaces with measurements.

Options compared:

- **Full bake every frame.** 26 extra draws and up to 5 ms on an iGPU, every frame. **Rejected.**
- **Amortized bake (faces over frames).** `_sceneToCubeUV` and `_applyPMREM` are private and run back to back, so time-slicing means forking PMREMGenerator. That is fragile across three upgrades. **Rejected.**
- **Throttled full bakes into a fixed-size target. Chosen.** A bake writes the same target within one frame's command stream, so no double buffering is needed.
  - **Event-driven.** A `dirty` flag is set by any change to layer uniforms or structure, and consumed at most once per frame by `skyBoxSystem`. Debug slider drags therefore cost at most one bake per frame, and zero once released.
  - **During day-night (p113).** Re-bake only when the sun or moon direction has moved more than `env.updateAngleDeg` (default **1°**) since the last bake, **and** at least `1 / env.maxUpdatesPerSec` has passed (default **4/s**). Do one final bake when the cycle pauses.
    - With the default 20-minute cycle the sun moves 0.3°/s, which gives one bake every ~3.3 s.
    - At 100× fast-forward the 4/s cap applies.
  - **Size.** `env.size` defaults to 256, or **128 when day-night is enabled**. It is fixed for the skybox's lifetime (see 0.2).
  - **Generator.** A dedicated long-lived `PMREMGenerator` is used for dynamic bakes, and disposed on `clearSkyBox`. The existing create-bake-dispose generator in `getPMREMTexture` stays for texture PMREMs. It is right for one-off bakes and wrong for repeated ones, because it would reallocate the working set every time.
  - **Escape hatch.** With `env.dynamic: false`, bakes happen only on activation, on structural changes and on explicit `bakeEnvironment()`. The background and lights still animate; only reflections lag.
- **How the spike measures it.** It reuses the WebGPU timestamp-query code in `core/Debug/_dbg__PostFXProfiler.ts:243, 341-360` (`backend.trackTimestamp`, `resolveTimestampsAsync(TimestampQuery.RENDER)`), plus `renderer.info.render.calls` and CPU `performance.now()` around `fromScene`. On WebGL2 only CPU times are available.

### 0.4 Integrated lights in the ECS LightManager

What exists today:

- **One entry point.** `createLightEntity(lightProps, entityOpts?, world?)` (`LightManager.ts:156-358`) is the only way to create a light.
  - It creates the light, a separate target entity linked with `TARGET_LINK` (`:293-307`), `TRANSFORM` and `OBJECT3D`.
  - Tags come from the `OBJECT3D` hook (`ECS/ECSCoreSystems.ts:79-95`).
  - Lights are added to the root scene, not the scene group (`:332`).
- **Movement is TRANSFORM-driven.**
  - `object3DSyncSystem` (MAIN, `ECSCoreSystems.ts:134, 156-192`) copies TRANSFORM to the Object3D.
  - `lookAtSystem` (APP_RENDER_SYNC, `:142, 218-255`) aims the light at its target.
  - The target is moved with `setLightTargetPosition` (`LightManager.ts:381-394`).
- **No owner concept.**
  - Nothing marks a light as owned or managed.
  - The Lights tab lists every `TAG_IS_LIGHT` (`Debug/Light/_dbg__LightGUI.ts:1004-1041`), and "toggle all helpers" iterates them all (`:1066-1084`).
  - LS overrides are merged in at creation by appId (`PropertyLoader.ts:18-51`, called at `LightManager.ts:166`).
  - The edit window can edit, move, re-create (`refreshLightShadows`, `:1124-1188`, which **swaps `OBJECT3D.value`**) and delete a light (`:879`).
- **Scene lifetime.** Lights have no `sceneId`. They die with `clearNonPersistent()` (`SceneLoader.ts:518`), which runs after `clearSkyBox()` (`:499`).
  - `createEntity` ignores `entityOpts.persistent` for the light itself (`ECS.ts:456-469`); only the target gets `PERSISTENT` (`LightManager.ts:294-296`). This is noted here only; skybox lights are non-persistent anyway.
- **Shadow toggling is expensive.** `castShadow` is part of `LightsNode.customCacheKey` (`src/nodes/lighting/LightsNode.js:156`), which feeds every lit render object's cache key (`NodeManager.js:653`). Toggling it rebuilds the nodes of every lit material. `shadow.intensity` is a uniform (`ShadowNode.js:451`), and `shadow.autoUpdate = false` skips the shadow render (`:792-822`).

Decision (implemented in p112):

1. **Skybox lights are ordinary ECS light entities, made by `createLightEntity`.** There is no parallel light path, so they get helpers, symbols, spatial indexing and culling like any other light.
2. **A new generic core component, `MANAGED_BY: { manager: string; ownerId: string; role: string }`** (`ECSRegistry.ts` + `ECSCoreComponents.ts`, set through a new `entityOpts.managedBy`). Skybox lights use `{ manager: 'SKYBOX', ownerId: skyBoxId, role: 'SUN_0' | 'MOON_0' | 'AMBIENT' }`. The component is generic on purpose: character-owned or vehicle-owned lights can reuse it later. With it:
   - LightManager **skips `loadPersistentProps`** for managed lights, so no stale `AEK_debugLights` overrides apply.
   - The Lights tab shows them with a "Managed by Sky box" badge. The edit window is read-only, with an "Open in Sky box tab" button and no delete button.
   - All their controls live in the Skybox tab.
3. **Driving the lights.**
   - `skyBoxSystem` (MAIN stage, order > 0, so it runs before `object3DSyncSystem`) writes the light's TRANSFORM (`followPoint + dir · distance`) and moves its target to `followPoint`.
   - Colour, intensity and shadow intensity are written onto the `THREE.DirectionalLight`, which is **read from `OBJECT3D` every update and never cached** (see `refreshLightShadows` above).
   - The system writes only when a value actually changed.
4. **Fading below the horizon** ramps `intensity` and `shadow.intensity` down, and sets `shadow.autoUpdate = false` once the light is fully faded. **The system never toggles `castShadow` at runtime.** `castShadow` is a structural light param: changing it from the debug UI costs one rebuild, and gameplay never changes it.
5. **Shadow frustum follow.** `light.shadowFollow: 'ACTIVE_CAMERA' | 'ORIGIN'` (default `ACTIVE_CAMERA`). A directional shadow camera covers a fixed ortho box (`DirectionalLightShadow.js:16`), so it follows the camera, snapped to shadow-map texels to avoid shimmering.
6. **Cleanup.** The lights are created when the skybox activates and deleted by `clearSkyBox` / deactivation through `world.deleteEntity`, which also deletes the target (`LightManager.ts:477-500`). A scene switch runs `clearSkyBox` first (`SceneLoader.ts:499`), so nothing leaks into `clearNonPersistent`.

### 0.5 Tone mapping, exposure, Renderer and PostFX

- **The background is tone-mapped exactly once, on both paths.**
  - PostFX off: the renderer renders into its internal half-float framebuffer and applies tone mapping in the output pass (`Renderer.js:1561`, `:2609-2615`).
  - PostFX on: `PostFX.ts:166` is `pass(rootScene, camera)`, which renders the background and environment. `RenderPipeline` forces `NoToneMapping` for the scene pass, then applies `renderOutput(output, toneMapping, colorSpace)` once (`RenderPipeline.js:75, 138-156, 192-194`).
- **Bakes are linear HDR.** `currentToneMapping` is `NoToneMapping` for non-output render targets (`Renderer.js:2663-2666`).
- **The example's "exposure" can't be the renderer's.** The three.js example's exposure slider sets `renderer.toneMappingExposure`. Here the Renderer tab owns that value (`_dbg__Renderer.ts:172-182`), and `src/index.ts:9-21` sets it to 0.7 with ACES.
  - Hence the second deviation from the brief: **`atmosphere.exposure` is a sky-only radiance multiplier**, applied inside the composite before tone mapping. Its default is chosen so the look matches the example at exposure 0.7.
  - The global exposure stays with the Renderer tab.
- **Skybox-level intensities.**
  - `env.backgroundIntensity` maps to `scene.backgroundIntensity`.
  - `env.environmentIntensity` maps to `scene.environmentIntensity`.
  - Nothing in `src/` sets either today.
- **PostFX interactions.**
  - **Bloom.** Sun and moon discs are HDR, so bloom picks them up, which is usually wanted. `sun.discIntensity` is clamped (default ~40, versus the 60,800 peak) so bloom and TAA don't blow out.
  - **AO and depth passes.** They see the background at the far plane, as today.

### 0.6 WebGL2 fallback

- **Same node path.** `Background.js`, `PMREMGenerator` and `CubeRenderTarget` are backend-agnostic.
- **No new requirement.** Half-float render targets need `EXT_color_buffer_half_float` / `EXT_color_buffer_float` (`webgl-fallback/WebGLBackend.js:262-271`), which today's equirect PMREM already requires.
- **Viewport flips are handled once.** `PMREMGenerator._setViewport` flips only for `isWebGLRenderer`, which is false for `WebGPURenderer`, and the backend flips internally (`WebGLBackend.js:706-726`).
- **Timings are CPU-only on WebGL2** in the spike.

### 0.7 Schema/JSON and localStorage impact

- **JSON.** `*.skybox.json` gets the layered shape (see "Definition shape" below).
  - **Legacy files keep working.** A Zod `z.preprocess` adapter converts the legacy `{ type, params }` shape into the layered shape. It accepts `EQUIRECTANGULAR`, `CUBETEXTURE` and `CUBEMAP`, maps `fileName`/`fileNames` and `cubeTextRotate`/`cubeTextureRotate`, and warns once in dev. The runtime `createSkyBox` uses the same adapter.
  - `gatherAppData.ts` gains the missing `safeParse`, keeps `debugData` in non-production builds, and **deep-merges** `__saveData[sceneId][0]` over the definition instead of spreading it into `params`.
  - `basicSkybox.skybox.json` is rewritten to the new shape, and its invalid `colorSpace: ""` save entry is dropped.
- **localStorage.**
  - `AEK_debugSkyBoxStates` (a full copy of the flat state per scene and id) is replaced by **`AEK_debugSkyBox`**: `{ [sceneId]: { [skyBoxId]: DeepPartial<SkyBoxDef> } }`, holding only the values changed from the definition, like p071's PostFX settings.
  - A one-time migration moves each saved `equiRectRoughness` / `cubeTextRoughness` that differs from the definition into `env.backgroundRoughness`, then removes the old key. Nothing else in the old key is worth keeping: `isCurrent` and `isDefaultForScene` are session-only by design (`_DONE_p061` §SkyBox).
- The scene schema is unchanged (`skyboxes: (string | inline)[]`, `sceneSchema.ts:38`). The scene options `backgroundColor` / `backgroundTexture` (`sceneSchema.ts:25-28`, applied in `Scene.ts:271-291`) stay as the "no skybox" fallback.

### Verdict

**The full layered design is feasible, and it is the design these plans follow.** Specifically:

- **Feasible with high confidence:**
  - all layers composited into one `backgroundNode`;
  - static env bakes via `fromScene`;
  - a texture base behind procedural layers;
  - ECS-owned sun, moon and ambient lights;
  - tone mapping with PostFX on or off, on both backends.
- **The main risk is the cost of dynamic env re-bakes on low-end GPUs.** It is covered by the throttled strategy in 0.3 and by the degrade order below.
- **What day-night can animate:**
  - every procedural layer: atmosphere, sun, moon, stars, clouds, ground, nebula rotation;
  - the integrated lights;
  - a **texture base only by rotation, intensity and opacity**. A photographed sky can't change its time of day, so games use the texture base for space or backdrop art, or fade it with `base.intensity` driven by the time of day.

**Degrade order**, if the spike misses budget (bake > 2 ms at 128 on the iGPU reference):

1. `env.size` 64, and `maxUpdatesPerSec` 1.
2. `env.dynamic: false` by default: bake on activation and explicit `bakeEnvironment()` only.
3. Only if the composite background itself fails on a backend (not expected: it is the same NodeMaterial path Background.js already uses), fall back to **mutually exclusive types** (none/background colour, equirectangular, cube texture, sky and sun with an integrated directional light and ambient), keeping the p111 clean refactor.

## Phase 0 — Spike (go/no-go gate, not committed)

A throwaway, uncommitted spike in a dev scene (`scene01_v2`):

1. A minimal ported `atmosphere(dir)` Fn as `rootScene.backgroundNode`, with the sun parameters as uniforms.
2. `fromScene(envBakeScene, 0, 0.1, 100, { size, renderTarget })` into a reused target, with `rootScene.environmentNode = pmremTexture(target.texture)`.
3. Keys to re-bake per frame, or at 4/s, while the sun rotates. Log the timestamp-query bake ms, `renderer.info.render.calls` and the pipeline and program counts.

Matrix:

- backend: WebGPU, WebGL2 (the Renderer tab's `forceWebGL`)
- PostFX: on, off (`largeWorld` with AO)
- `env.size`: 256, 128, 64
- a desktop dGPU plus an iGPU laptop, if one is available

Pass criteria:

- The background matches SkyMesh visually, checked side by side with a temporary SkyMesh.
- PBR spheres pick up the sky's colour.
- No material or pipeline counts grow over 60 s of re-baking.
- A bake at 128 costs ≤ 1 ms on the dGPU and ≤ 2 ms on the iGPU.

Record the results in "Implementation notes" below. If the criteria fail, apply the degrade order and update p112/p113 before starting them.

## Target architecture (shared by p111–p115)

### Composite order (back to front)

1. **Base:** `COLOR` | `EQUIRECTANGULAR` | `CUBE_TEXTURE`, with `rotate` (radians, both texture types), `flipY` (cube), `colorSpace`, `intensity` and `opacity`.
2. **Space layers:** nebulae (sampled from one baked static cube, p114), then stars (live, p113). Both rotate with a `sidereal` rotation uniform.
3. **Discs:** suns (≤ 4, unrolled) and moons (≤ 2), additive with limb darkening, and moon phase shading.
4. **Atmosphere:** `result = behind · extinction(dir) + inscatter(dir)`, driven by the **primary sun (`suns[0]`) only**. At night, inscatter goes to ~0 and extinction to ~1, so stars, moon and base show through naturally. A small `nightSkyColor` floor replaces SkyMesh's hard-coded `L0` and blue offset.
5. **Clouds:** alpha over, lit by the primary sun and by the moon at night.
6. **Ground:** a lower-hemisphere colour with a `horizonBlend` band. Its `height` offset moves the horizon line.

Each layer is optional and **compiled out when absent or disabled.** Toggling a layer rebuilds the background material and the bake material, a one-time hitch. Every other parameter is a uniform. Fades (stars by day, moon light by day, and so on) are uniforms driven by the time of day, never structural toggles.

### Module layout

- `src/_engine/core/SkyBox/SkyBox.ts`: the public facade. It holds the registry, the active controller and the lifecycle.
- `src/_engine/core/SkyBox/SkyBoxTypes.ts`: types only. The runtime def type is `z.input` of the schema plus runtime-only fields such as `texture?: THREE.Texture`.
- `src/_engine/core/SkyBox/SkyComposite.ts`: the TSL builder, `buildSkyComposite(def, uniforms, { mode: 'VIEW' | 'ENV_BAKE' })`.
- `src/_engine/core/SkyBox/SkyEnvironment.ts`: `getPMREMTexture` (moved here unchanged), the bake target, the long-lived generator and the bake scheduler.
- `src/_engine/core/SkyBox/SkyLights.ts`: managed light creation and updates.
- `src/_engine/core/SkyBox/SkyTime.ts`: the day-night model and celestial directions (p113).
- `src/_engine/core/SkyBox/layers/{base,atmosphere,sun,moon,stars,clouds,ground,nebula}.ts`: one TSL function and one uniform-set factory per layer.
- `src/_engine/core/Debug/_dbg__SkyBox.ts` (the tab shell), plus `src/_engine/core/Debug/SkyBox/_dbg__*Folder.ts` (one folder builder per layer). They are loaded through the existing `loadDebugModuleAsync` / `useDebug` pattern.

### ECS stance

The skybox itself is **scene-level render configuration**, like PostFX (`_DONE_p070` Non-goals) and viewports (p080 DD6), not a world object. There is exactly one per root scene and it has no transform, so an ECS entity or component would add bookkeeping without adding queries. What _is_ ECS-first:

- the integrated lights (0.4, tagged `MANAGED_BY`);
- the update: one system, `skyBoxSystem`, registered through `ECSWorld.registerPlugin` at MAIN stage with order > 0. It advances time, updates uniforms and lights, and schedules bakes.

When nothing is dirty and the cycle is paused, the system returns after one boolean check.

### Public API (engine)

```ts
// Definitions and activation (p111)
registerSkyBox(def: SkyBoxDef, sceneId?: string): void;       // stores a definition for a scene (the loading scene by default)
createSkyBox(def: SkyBoxDef | LegacySkyBoxProps): Promise<void>; // register + activate unless isDefault === false (legacy-compatible)
setActiveSkyBox(id: string | null, sceneId?: string): Promise<void>;
getActiveSkyBox(): Readonly<ActiveSkyBox> | null;              // { id, sceneId, def (resolved) }
updateSkyBox(id: string, patch: DeepPartial<SkyBoxDef>): void; // uniforms live; structural keys rebuild
clearSkyBox(): void;
getActiveEnvironmentTexture(): THREE.Texture | null;           // PMREM texture (texture or bake target)
getActiveSkyBoxTexture(): THREE.Texture | null;                // kept: source texture (asset release)
getSceneSkyBoxTextureIds(sceneId: string): string[];           // kept
onSkyBoxChange(id: string, fn: (active: ActiveSkyBox | null) => void): void; // listener, eg. the env ball
// Environment (p112)
bakeEnvironment(): void;                                       // request a bake on the next system tick
// Day-night (p113)
setTimeOfDay(hours: number): void; getTimeOfDay(): number;
playDayNight(): void; pauseDayNight(): void; isDayNightPlaying(): boolean;
setDayNightSpeed(multiplier: number): void;                    // negative = reverse
setDayNightCycleDuration(seconds: number): void;               // real seconds per 24 h
getSunDirection(out: THREE.Vector3, index?: number): THREE.Vector3;
getMoonDirection(out: THREE.Vector3, index?: number): THREE.Vector3;
getSunElevation(index?: number): number;                       // radians, < 0 below horizon
```

### State flow (replaces `isCurrent` / `isDefaultForScene` / the LS copy)

1. **Definitions** are immutable and stored per scene: `Map<sceneId, Map<id, SkyBoxDef>>`.
   - They come from scene JSON (`registerScenesFromGeneratedData`) or from code (`registerSkyBox` / `createSkyBox`).
   - The **scene default** is the definition with `isDefault: true`; otherwise it is the first one registered. The legacy `isCurrent` maps to `isDefault`.
2. **Active:** at most one `ActiveSkyBox` exists. It holds the resolved def (the definition deep-merged with any debug overrides), its uniforms, its nodes, its lights, and its bake and time state.
3. **Debug overrides** (debug env only) are the values changed from the definition, stored in `AEK_debugSkyBox`. They are applied when a skybox activates, and written by the Skybox tab.
4. **Debug selection** (the "Sky boxes in scene" dropdown) is **session-only**, as p061 decided. On load, the scene default wins, and the dropdown marks it `[*default]`.
5. **Scene switch:** `clearSkyBox()` on exit (`SceneLoader.ts:499`, unchanged), then `setActiveSkyBox(sceneDefault)` on enter (`SceneLoader.ts:538`, replacing `applySkyBoxForScene`).

### Definition shape (JSON; p111 defines the schema, later plans fill in the layer schemas)

```jsonc
{
  "$schema": "../../../.schemas/skyBox.schema.json",
  "id": "sunnyDay",
  "isDefault": true,
  "preset": "DAY_SKY", // optional template, p114; explicit fields override it
  "base": {
    "type": "EQUIRECTANGULAR",
    "file": "/path/sky.hdr",
    "textureId": "skyHdr",
    "colorSpace": "srgb-linear",
    "rotate": 0,
    "intensity": 1,
  },
  // | { "type": "COLOR", "color": "#1a2433" }
  // | { "type": "CUBE_TEXTURE", "fileNames": [6 × string], "path": "...", "rotate": 0, "flipY": false }
  "env": {
    "backgroundRoughness": 0,
    "backgroundIntensity": 1,
    "environmentIntensity": 1,
    "size": 256,
    "dynamic": true,
    "updateAngleDeg": 1,
    "maxUpdatesPerSec": 4,
  },
  "atmosphere": {
    "enabled": true,
    "turbidity": 2,
    "rayleigh": 1,
    "mieCoefficient": 0.005,
    "mieDirectionalG": 0.8,
    "exposure": 1,
  }, // p112
  "suns": [
    {
      "elevation": 30,
      "azimuth": 180,
      "discSize": 1,
      "discIntensity": 40,
      "light": { "enabled": true, "intensity": 3, "castShadow": true, "shadowPreset": "MEDIUM" },
    },
  ], // p112
  "ambientLight": { "enabled": false, "type": "HEMISPHERE", "intensity": 0.5 }, // p112
  "clouds": { "enabled": false, "coverage": 0.4, "density": 0.4 }, // p112
  "ground": { "enabled": false, "color": "#3b3a36", "horizonBlend": 0.05 }, // p112
  "moons": [{ "discSize": 1, "phaseOffset": 0, "light": { "enabled": true, "intensity": 0.3 } }], // p113
  "stars": { "enabled": false, "density": 0.5, "brightness": 1, "twinkle": 0.3 }, // p113
  "dayNight": {
    "enabled": false,
    "timeOfDay": 12,
    "cycleDurationSec": 1200,
    "speed": 1,
    "playing": true,
    "latitude": 45,
    "dayOfYear": 172,
    "northOffset": 0,
  }, // p113
  "nebulae": [
    { "seed": 1, "direction": [0.3, 0.5, -0.8], "size": 40, "colors": ["#2a0f4a", "#c8457a"] },
  ], // p114
  "debugData": { "name": "Sunny day" },
}
```

`suns` and `moons` are **arrays from day one**, so p114's multiple suns don't change the schema. Until p114 lands, the builder renders only index 0 and warns about any extra entries.

### Naming

- A **sky box** (code: `SkyBox`) is the whole configurable sky. A **layer** is one of base, atmosphere, sun, moon, stars, clouds, ground or nebula. A **preset** is a definition template.
- The **env bake** is one `fromScene` run into the active skybox's bake target. A **texture PMREM** is `getPMREMTexture`'s per-texture bake.
- The type names become `COLOR`, `EQUIRECTANGULAR` and `CUBE_TEXTURE`, which ends the `CUBETEXTURE` / `CUBEMAP` split.

## Constraints (every sub-plan)

- **Every phase compiles and lints**, and leaves the app working (the Stop hook runs lint and `tsc`).
- **No per-frame allocations** on the update path. Module-level scratch `Vector3` / `Color` / `Matrix4` objects are written with `.copy()` / `.set()`, and a value is written only when it changed. Verify with the `perf-auditor` agent on the day-night path (p113).
- **All Tweakpane code lives in `_dbg__` files**, loaded lazily. `dist-stats/bundle-stats.html` must show no `_dbg__SkyBox*` in the main chunk.
- **Debug edits record undo/redo** through `_recordUndoRedoAction` / `_recordOrCoalesceUndoRedoAction` / `_registerUndoRedoActionHandler` (`core/Debug/_dbg__UndoRedo.ts:147-206`), following `_DONE_p060`–`_DONE_p062`. The per-plan action tables are in p111–p114.
- **Engine, toolkit and app stay split.** App code gets migration notes (p111), and the example app gets a showcase scene (p113).

## Versioning

- **p111 is breaking for the engine's public API**, which TypeDoc covers for `src/_engine/**`. It removes `defaultRoughness`, `getEnvMapRoughnessBg`, `extractSkyBoxParamsFromState`, `SkyBoxState`, `defaultSkyBoxState`, `LS_KEY_ALL_STATES`, `NO_SKYBOX_ID` (it moves into the debug module), `deleteCurrentSkyBox`, `applySkyBoxForScene` and `getCurSceneSkyBoxSceneId`, and it replaces the `SkyBoxProps` shape.
  - Legacy `createSkyBox` props and legacy JSON stay accepted through the adapter, with a deprecation `lwarn`, so **app code keeps working without edits**.
  - It is still a **major** bump under CLAUDE.md's rules: 1.x → 2.0.0, with codename **"Morning"** as the next in the sun's path after "Sunrise".
  - **If p105, which also plans 2.0.0 "Morning", merges in the same release window, fold both into one major bump.** Otherwise, whichever merges second takes 3.0.0 "Zenith". Decide this when p111 merges.
- **p112, p113, p114 and p115** each add features: an engine minor bump each.
- **App:**
  - p111's call-site migration is an app patch bump.
  - p113's `skyShowcase` scene is an app minor bump.
  - p114's SPACE demo, if it is added to that scene in the same branch, needs no extra bump.
- Every sub-plan's final phase does its bump, following "once per branch merged to `main`".

## Non-goals (whole epic)

- Auto-exposure or eye adaptation for night scenes (a PostFX follow-up).
- Physically based multiple scattering (Hillaire 2020 LUTs). Preetham matches SkyMesh, and a precomputed-LUT atmosphere is a possible follow-up layer.
- Volumetric 3D clouds, weather systems, rain or fog coupling.
- Sky in viewports other than the env ball.
- Day-night events or callbacks (`onSunrise` / `onSunset`). The getters are enough for games to poll; events are a follow-up.
- A JSON write-back endpoint. The Skybox tab's "Copy JSON" button covers authoring (p111).
- Skyboxes in secondary ECS worlds. The skybox belongs to the root scene.

## Risks / open questions

| Risk                                                                     | Mitigation                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ported atmosphere drifts from three's `SkyMesh` over upgrades        | The file header records the source file and three version. The upgrade checklist diffs `examples/jsm/objects/SkyMesh.js` and re-runs the visual side-by-side from the spike.                                                      |
| Dynamic bakes are too slow on iGPUs or mobile                            | Phase 0 gate plus the degrade order; `env.dynamic` / `size` / `maxUpdatesPerSec` are per-skybox settings.                                                                                                                         |
| A layer toggle recompiles the background, the bake and the lit materials | Only the background and bake materials rebuild; lit materials keep the same `environmentNode` identity (0.2). It is a debug-time or load-time hitch only. Games use uniforms (fades) at runtime.                                  |
| `castShadow` changes rebuild every lit material                          | It is a structural light param (0.4). Fades use `intensity`, `shadow.intensity` and `shadow.autoUpdate`.                                                                                                                          |
| Managed lights edited from the Lights tab would fight the skybox         | Managed lights are read-only in the Lights tab (0.4) and skip LS overrides.                                                                                                                                                       |
| Legacy JSON or props hide mistakes                                       | The adapter warns once per id in dev. p111 Phase 4 migrates every app file, so warnings only show up for third-party code.                                                                                                        |
| The HDR sun disc interacts with bloom and TAA                            | `discIntensity` clamp. The showcase scene is verified with PostFX bloom on.                                                                                                                                                       |
| No automated tests, and headless WebGPU doesn't run under WSL2           | Manual matrices per phase (`run-aekasha-js` skill), as in p071 and p080.                                                                                                                                                          |
| Overlap with p105 (SkyBox tab migration)                                 | If p105 Phase 2 has landed, p111 writes the new tab against the pane builder. If not, p111 uses the legacy API and p105 Phase 4 migrates the new tab. Either way, p111's tab is folder-per-layer so it maps 1:1 to p105 sections. |

## Verification (epic level)

- Each sub-plan's own verification, plus at the end of p114:
  - Every app scene shows its skybox as before, including a JSON **cube** skybox, which is broken today.
  - Cube skyboxes light PBR materials.
  - A day-night cycle runs smoothly with PostFX on and off, on WebGPU and WebGL2.
  - Scene switches leave no stray lights, render targets or generators. Check `renderer.info.memory` before and after 10 switches.
  - A production build has no debug code in the main chunk, and the `?isProdTest=true` behaviour is unchanged.

## Implementation notes

(Filled in by the Phase 0 spike and the sub-plans.)
