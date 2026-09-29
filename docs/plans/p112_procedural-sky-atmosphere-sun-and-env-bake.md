Status: draft | not-implemented
Category: Skybox, Rendering, Lights
Blocked by: p111_skybox-core-refactor-and-layered-schema.md
Blocks: p113_night-sky-and-day-night-cycle.md, p114_space-preset-and-nebula-creator.md
Related: \_DONE_p110_skybox-refactor-and-layered-sky-system.md (epic; Phase 0 §0.1–0.5 are the research this plan implements)

# Procedural Sky: Atmosphere, Sun, Clouds, Ground and Environment Bake — Plan

This plan adds the first procedural layers to the p111 skybox:

- the **composite node builder**, which composites every layer into one `backgroundNode`;
- the **dynamic environment bake**, which runs `fromScene` into a fixed target on a budget;
- the **atmosphere** layer, a port of three's `SkyMesh` Preetham model;
- the **sun** layer (the disc);
- **managed ECS lights**: a directional light per sun, plus an optional hemisphere/ambient light that follows the sun;
- **clouds** and **ground**;
- their debugger folders.

When this plan is done, the brief's fallback "Sky and sun" type is covered as one layered configuration. There is no time animation yet; that comes in p113.

## Context

- The p110 Phase 0 findings apply unchanged:
  - §0.1 composition, and why `SkyMesh` is ported rather than used;
  - §0.2 bake mechanics;
  - §0.3 cost and strategy;
  - §0.4 lights;
  - §0.5 tone mapping.
- The Phase 0 spike results (p110 "Implementation notes → Phase 0 spike results") set the defaults: a bake costs ~2 ms of GPU on an RX 7900 XT at every size (~80 µs per pass, almost all in the GGX filter passes), so `maxUpdatesPerSec` defaults to **1** and `env.size` stays 256 (128 with day-night). **Re-read them before Phase 1.**
- The p111 state flow is the base:
  - `ActiveSkyBox` holds the uniforms, nodes and lights;
  - `updateSkyBox` separates structural keys from uniform keys;
  - `skybox.param` is the single undo action.

## Design decisions

1. **The composite builder** (`SkyBox/SkyComposite.ts`).
   - Signature: `buildSkyComposite(def, u: SkyUniforms, mode: 'VIEW' | 'ENV_BAKE'): Node<vec3>`.
   - It is a `Fn` of the direction: `normalWorldGeometry` in VIEW mode, and on the bake scene's background sphere in ENV_BAKE mode.
   - Order (p110 "Composite order"): base, space layers (p113/p114), discs, atmosphere, clouds, ground.
   - Each layer module exports:
     - `createUniforms(def)`
     - `applyUniforms(u, def)`, which writes only changed values
     - `node(dir, behind, u, mode)`, which returns the new colour
     - `STRUCTURAL_KEYS`
   - Absent or disabled layers are skipped at build time.
   - `SkyUniforms` is created once per activation and reused. Rebuilds only rebuild nodes.
   - **When the composite is used.** It is the background and environment source whenever any procedural layer is enabled. A texture-only or colour-only skybox keeps p111's direct path (p110 §0.2).
   - **Background roughness with the composite.** If `env.backgroundRoughness > 0`, the background samples the bake target, `pmremTexture(bake, dir, uBgRoughness)`. Otherwise it is the live composite. Switching between them is structural: one rebuild, and only while dragging across 0.
2. **The environment bake** (`SkyBox/SkyEnvironment.ts`).
   - **Resources.** One persistent `RenderTarget` per active skybox, created by the first `fromScene` call and passed back through `{ renderTarget }` on every later bake. One long-lived `PMREMGenerator`. One private `envBakeScene` (a `THREE.Scene` whose `backgroundNode` is the ENV_BAKE composite). `rootScene.environmentNode = pmremTexture(target.texture)`, created once.
   - **Scheduling.**
     - `requestEnvBake()` sets a dirty flag.
     - `skyBoxSystem` consumes the flag at most once per frame, and never during scene loading.
     - `bakeEnvironment()` is the public alias.
     - Uniform writes from `updateSkyBox` and structural rebuilds call `requestEnvBake()`.
     - p113 adds the angle and rate rules.
   - **Size.**
     - `env.size` (a power of two: 64, 128 or 256) is fixed per activation.
     - Changing it from the debugger is structural: the target and generator are disposed and recreated, **and `environmentNode` gets a new `pmremTexture` node** (one lit-material rebuild). Swapping `.value` of the old node to the new target left stale texture bindings on WebGL2 in the spike.
     - The default comes from p110: 256, or 128 if `dayNight.enabled` (unchanged by the spike, which found size saves almost no GPU time on a dGPU).
   - **Disposal.** `clearSkyBox()` disposes the target, the generator, the bake scene's background material and the view composite material. **Nothing from `getPMREMTexture`'s cache is touched.**
   - **Stats (debug).** Each bake records CPU ms (`performance.now()`), and GPU ms when timestamp queries are available. The helper is factored out of `_dbg__PostFXProfiler.ts:243, 341-360` into a shared `_dbg__` util, and exposed in the Environment folder together with a bake counter and "Re-bake now".
   - **The `ENV_BAKE` variant** (p110 §0.2):
     - a sun with `light.enabled` contributes no disc to the bake;
     - (spike) the bake scene has no `background`, so `fromScene` also draws a solid-colour clear box first: one extra `render()` call, nothing measurable;
     - otherwise the disc becomes a clamped, wide glow (`min(disc, envSunClamp)`, default 20);
     - clouds use a frozen time uniform;
     - stars are skipped (p113).
3. **The atmosphere layer** (`layers/atmosphere.ts`).
   - **What it ports.** The body of three r186 `SkyMesh.js` (`:151-381`), rewritten as a function of `dir`.
   - **What moves to the CPU.** The vertex-stage terms are computed in `applyUniforms` whenever the primary sun direction or the params change: `sunDirection`, `sunE` (`:170-179`), `sunfade` (`:183`), `betaR` (`:187-191`) and `betaM` (`:195-198`). They are plain arithmetic and are uploaded as `vec3`/`float` uniforms.
   - **Header.** The file records the source path, the three version and the MIT attribution.
   - **Params** (SkyMesh parity, with defaults): `turbidity` 2, `rayleigh` 1, `mieCoefficient` 0.005, `mieDirectionalG` 0.8.
   - **The official example's `elevation` and `azimuth`** belong to the sun (DD4). **`exposure` is a sky-only multiplier** (p110 §0.5). Its default is calibrated so that, at renderer exposure 0.7 with ACES, the sky matches the three example at its default 0.5 exposure. Check the calibration against a temporary `SkyMesh` in Phase 2.
   - **Proposed extra params:**
     - `sunIntensity`: a scale on `EE` (`:179`), for artistic brightness without changing turbidity.
     - `nightSkyColor`: replaces the hard-coded `L0 = 0.1·Fex` term and the `vec3(0, 0.0003, 0.00075)` blue offset (`:272, :278`). It is the floor colour when the sun is down.
     - `twilightLength`: maps onto the earth-shadow `cutoffAngle` and `steepness` (`:167-169`) to lengthen or shorten dusk.
     - `horizonTint` / `zenithTint`: multiplicative colour grading, blended by `dir.y`.
   - **Compositing.** `behind · Fex + inscatter`, where `Fex` is SkyMesh's extinction term. At night inscatter is ~0 and `Fex` is ~1, so layers behind the atmosphere show through.
4. **The sun layer** (`layers/sun.ts`, reading `suns[0]`; p114 adds indices 1–3).
   - `elevation` / `azimuth` in degrees. These are used directly until p113; when day-night is on, p113 computes them instead.
   - `discSize`: a multiplier on SkyMesh's angular diameter, `sunAngularDiameterCos` (`:230`).
   - `discIntensity`: a clamp on SkyMesh's `min(…,80)·760` peak (`:276`), default ~40.
   - `glowIntensity` / `glowSize`: an extra Mie-like halo, cheap `pow(cosTheta)`.
   - `color`: `'AUTO'` (from atmosphere extinction) or a hex colour.
   - The disc is drawn behind the atmosphere, which is how SkyMesh composites it.
5. **Managed lights** (infrastructure, reusable beyond skyboxes; p110 §0.4).
   - **The component.**
     - New `ComponentType.MANAGED_BY` in `core/ECS/ECSRegistry.ts`, with its data type `{ manager: string; ownerId: string; role: string }` in `ECSCoreComponents.ts`.
     - `ECSRegistry.ts` stays free of local imports, per its header comment.
     - It is set through a new `CoreEntityOpts.managedBy`, which is **not** in the JSON schema: managed entities are only created in code.
   - **`LightManager.createLightEntity`** skips `loadPersistentProps` (`LightManager.ts:166`) when `managedBy` is set, and passes the option on to the target entity.
   - **The Lights tab** (`Debug/Light/_dbg__LightGUI.ts`):
     - list rows for managed lights get a sky icon and a "Managed by Sky box" subtitle (`getLightsListData`, `:1055-1081`);
     - `createEditLightContent` (`:426`) renders a read-only summary for them, with an "Open in Sky box tab" button (switching the drawer's current tab) and no delete button (`:905-907`);
     - `saveLightToLS` (`:1287`) and undo recording skip managed lights;
     - "Toggle all helpers" (`_toggleAllLightHelpers`, `:1127-1167`) still includes them, since helpers are cosmetic.
   - Out of scope, flagged: `createEntity` ignores `entityOpts.persistent` for the light itself (`ECS.ts:460-474`). Skybox lights are non-persistent, so this plan doesn't need the fix.
6. **Sun light** (`SkyBox/SkyLights.ts`, `suns[i].light`).
   - **Params:**
     - `enabled`, `intensity`
     - `colorMode: 'AUTO' | 'CUSTOM'` and `color`
     - `castShadow` (structural), `shadowPreset`, `shadowBias`, `shadowNormalBias`, `shadowMapSize`
     - `shadowFrustumSize` (ortho half-extent)
     - `distance` (from the follow point, default 100)
     - `shadowFollow: 'ACTIVE_CAMERA' | 'ORIGIN'`
     - `horizonFade: [startDeg, endDeg]` (default `[6, -3]`)
   - **Creation.** `createLightEntity({ type: 'DIRECTIONAL', …, castShadow }, { managedBy: { manager: 'SKYBOX', ownerId, role: 'SUN_0' }, appId: `\__skybox_${ownerId}\_SUN_0` })` runs on activation. The light is deleted in `clearSkyBox`.
   - **Updates** (`skyBoxSystem`, MAIN stage, order > 0, so it runs before `object3DSyncSystem`, `ECSCoreSystems.ts:134`):
     - The follow point is the active camera's world position, snapped to shadow texels (`frustumSize·2 / mapSize`), or the origin.
       - Snap in **light space** (along the light's own X/Y axes; depth unsnapped), not along world axes, or the shadows still shimmer. `scene_thirdPersonGym.ts:80-133` (`gymSunFollow`) already does exactly this for an entity-followed sun; port its maths. Once `shadowFollow` exists, consider an `ENTITY` mode (follow an entity id with an offset) so the gym can drop its app-side system.
     - Position is `followPoint + sunDir·distance`, set with `world.setTransform` + `commitTransform`. The target goes to `followPoint` with `setLightTargetPosition` (`LightManager.ts:381`).
     - `AUTO` colour is the CPU-evaluated extinction along the sun direction (the same maths as `Fex`, written into a module-level `Color`).
     - Intensity is `intensity · smoothstep(horizonFade)`. `shadow.intensity` follows the same factor. `shadow.autoUpdate` is `false` while the factor is 0.
     - The `THREE.DirectionalLight` is read from `OBJECT3D` on every update, because the Lights tab's `refreshLightShadows` can swap it.
     - Nothing is written, and no transform is committed, when the sun direction and the follow point are unchanged.
7. **Ambient light** (`ambientLight`).
   - **Params:**
     - `enabled` (default `false`)
     - `type: 'HEMISPHERE' | 'AMBIENT'` (structural)
     - `intensity`
     - `colorMode: 'AUTO' | 'CUSTOM'`, `skyColor`, `groundColor`
   - **AUTO colours.**
     - `skyColor` is the CPU zenith inscatter, normalized to its max channel and scaled by the sun fade.
     - `groundColor` is the ground layer's colour times the same fade.
   - **Why it is off by default.** The env bake already gives PBR materials image-based ambient light, so a hemisphere light double-counts. The debug folder says so. The ambient light exists for non-PBR materials (Lambert/Phong use `BasicEnvironmentNode`, not the PMREM path, per p110 §0.2) and for stylized looks.
8. **Clouds** (`layers/clouds.ts`).
   - **Ported** from SkyMesh (`:280-379`): gradient noise, fbm, Beer-powder shading, silver lining.
   - **Params** at SkyMesh's defaults: `coverage` 0.4, `density` 0.4, `scale` 0.0002, `speed` 0.00002, `elevation` 0.5.
   - **Extras:** `color` tint, and `windDirection` (vec2 instead of SkyMesh's fixed xz scroll).
   - **Time.** Clouds use the engine's `time` node in VIEW mode and a frozen `uCloudTime` in ENV_BAKE mode. They are lit by the primary sun; p113 adds moonlight.
   - Clouds are only available with the atmosphere layer enabled, because they read its `Fex`/`Lin`. The schema refines this.
9. **Ground** (`layers/ground.ts`). This is the lower-hemisphere colour of the sky only; a physical ground plane is the game's job.
   - **Params:**
     - `color`
     - `horizonBlend` (width of the blend band in `dir.y`)
     - `height` (shifts the horizon line, for sitting above a sea of clouds)
     - `useAtmosphereHorizon` (blends toward the atmosphere's horizon colour for aerial perspective)
   - It supplies the AUTO `groundColor` for the ambient light.
10. **Debug folders** (`core/Debug/SkyBox/_dbg__{Atmosphere,Sun,SunLight,AmbientLight,Clouds,Ground}Folder.ts`).
    - Each layer folder has an `enabled` toggle, which is structural and runs through `skybox.param`, and every param above.
    - The Sun folder nests a "Light" subfolder, so the brief's "tweak the sun light from the Skybox tab" is met there.
    - The Environment folder (from p111) gains size, dynamic, bake stats and "Re-bake now".
    - All edits use `skybox.param` (coalesced by path, e.g. `suns.0.light.intensity`). No new action types are needed.

## Files touched

| File                                                                                                      | Change                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/_engine/core/SkyBox/SkyComposite.ts` (new)                                                           | Builder, `SkyUniforms`                                                                      |
| `src/_engine/core/SkyBox/SkyEnvironment.ts`                                                               | Bake target, long-lived generator, bake scene, scheduler, dispose                           |
| `src/_engine/core/SkyBox/SkyLights.ts` (new)                                                              | Managed sun + ambient light creation, update, delete                                        |
| `src/_engine/core/SkyBox/layers/{atmosphere,sun,clouds,ground}.ts` (new)                                  | Layer nodes, uniforms, CPU helpers                                                          |
| `src/_engine/core/SkyBox/SkyBox.ts`                                                                       | Composite path, `skyBoxSystem` registration (`ECSWorld.registerPlugin`), `bakeEnvironment`  |
| `src/_engine/schemas/skyBoxSchema.ts`                                                                     | `atmosphere`, `suns[]`, `ambientLight`, `clouds`, `ground`, and the new `env` fields in use |
| `src/_engine/core/ECS/ECSRegistry.ts`, `ECSCoreComponents.ts`, `schemas/_helperSchemas.ts` (TS type only) | `MANAGED_BY`, `CoreEntityOpts.managedBy`                                                    |
| `src/_engine/core/LightManager.ts`                                                                        | Skip LS props for managed lights; pass `managedBy` to the target                            |
| `src/_engine/core/Debug/Light/_dbg__LightGUI.ts`                                                          | Badge, read-only edit window, no save/undo/delete for managed lights                        |
| `src/_engine/core/Debug/SkyBox/_dbg__*Folder.ts` (new), `_dbg__SkyBox.ts`                                 | New folders; Environment folder stats                                                       |
| `src/_engine/core/Debug/_dbg__GPUTimer.ts` (new, factored from `_dbg__PostFXProfiler.ts`)                 | Shared timestamp-query helper                                                               |
| `package.json`, `.claude/CLAUDE.md`                                                                       | Engine minor; one line on managed entities and the sky system                               |

## Phases

Each phase compiles, lints, and leaves existing skyboxes unchanged.

1. **Composite builder + dynamic bake infrastructure.**
   - Add `SkyComposite`, the bake target, generator and scene, the scheduler, disposal, `bakeEnvironment` and the GPU timer util.
   - It is exercised through a debug-only "Force composite path" toggle in the Environment folder, which routes a texture base through the builder and the bake.
   - Verify: with the toggle on, the result is identical to the direct path, and the pipeline counts stay flat while re-baking for 60 s.
2. **Atmosphere + sun disc** (no lights yet).
   - Add the layers, the schema and the debug folders.
   - Add a `DAY_SKY` demo skybox to `scene01_v2`, registered in code; p113 moves it into the showcase scene.
   - Verify:
     - side by side with a temporary `SkyMesh` at the same parameters (then removed);
     - on WebGPU and WebGL2, with PostFX on and off;
     - PBR spheres pick up the sky tint;
     - dragging a slider causes at most one bake per frame, and none after release.
3. **Managed-entity infrastructure.**
   - Add `MANAGED_BY`, the LightManager changes and the Lights tab changes.
   - It is exercised by a throwaway managed light in the dev scene.
   - Verify:
     - the Lights tab shows the badge and the read-only window;
     - nothing is written to `AEK_debugLights` and no undo entries are recorded;
     - normal lights are unaffected.
4. **Sun light + ambient light.**
   - Add `SkyLights.ts`, the light params and the Sun > Light and Ambient folders.
   - Verify:
     - the shadow direction matches the disc;
     - AUTO colour warms toward the horizon;
     - the light fades below the horizon with no shader recompile (pipeline count stable, `castShadow` never toggled);
     - the shadow frustum follows the camera without shimmering;
     - a scene switch leaves no stray lights (the Lights tab and ECS entity count).
5. **Clouds + ground.**
   - Add the layers and folders.
   - Verify:
     - clouds animate in the view but stay frozen in the environment;
     - the ground band and `height` behave as specified;
     - the AUTO ground colour feeds the hemisphere light.
6. **Docs + version.** CLAUDE.md, the engine minor bump, and "Implementation notes" (measured bake times per size and backend).

## Non-goals

- Time animation, moon, stars, and re-bake throttling by angle (p113).
- Multiple suns, nebulae and presets (p114). `suns[1..]` entries warn and are ignored.
- The env ball (p115).
- Atmosphere seen from altitude or space (a future layer).
- Applying `entityOpts.persistent` to lights (flagged in DD5).

## Risks / open questions

| Risk                                                                                                          | Mitigation                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port fidelity: CPU-side vertex terms vs GPU                                                                   | Side-by-side check against `SkyMesh` in Phase 2; values checked within 1e-4 at five sun elevations.                                                                               |
| `exposure` calibration disagrees with the Renderer tab's exposure                                             | It is documented as sky-only. The calibration is recorded in Implementation notes.                                                                                                |
| A managed light is edited through code paths other than the Lights tab (e.g. `setLightEnabled` from app code) | Allowed: the skybox only writes the fields it owns (transform, colour, intensity, shadow intensity and autoUpdate). The rest is the app's business. JSDoc on `SkyLights` says so. |
| Shadow texel snapping needs the light's orientation basis                                                     | Compute it once per sun direction change into module-level vectors.                                                                                                               |
| Hemisphere light double-counts with IBL                                                                       | Off by default, with a note in the folder (DD7).                                                                                                                                  |
| The bake scene renders on the frame of a slider drag while PostFX is on                                       | One bake per frame at most. The Phase 2 matrix covers PostFX on.                                                                                                                  |

## Verification

- `yarn lint` and `yarn build` after each phase.
- The matrix from p110 Phase 0 (backend × PostFX × `env.size`), repeated in Phase 2 and Phase 4 with the `run-aekasha-js` skill.
- Pipeline and program counts are stable over 60 s with the sun moving from the debugger (`renderer.info`).
- A scene round trip 10×: no leaked lights, render targets or generators (`renderer.info.memory`, ECS entity count).
- Production build: no `_dbg__*Folder` code in the main chunk. `SkyComposite` and the layers are in the main chunk, since they are production features.
