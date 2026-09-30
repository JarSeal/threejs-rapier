Status: draft | not-implemented
Category: Skybox, Rendering
Blocked by: \_DONE_p112_procedural-sky-atmosphere-sun-and-env-bake.md, \_DONE_p113_night-sky-and-day-night-cycle.md (stars layer, sidereal rotation)
Related: \_DONE_p110_skybox-refactor-and-layered-sky-system.md (epic)

# Space Preset and Nebula Creator — Plan

This plan completes the layered sky with the last pieces:

- **Nebula layer** plus an in-debugger **nebula creator**: procedural, and baked once per change into a static cube.
- **Multiple suns** (up to 4) and a **second moon**.
- **Presets**, ready-made definitions: `DAY_SKY`, `NIGHT_SKY`, `DAY_NIGHT` and `SPACE`.
- A **space demo scene** in the app: the SPACE sky box around a few asteroids near the origin that attract each other (zero-g physics), with a debug tab that exists only while that scene is open.
  - For the demo, the **toolkit** gets:
    - a procedural asteroid geometry (semi-low-poly);
    - a procedural asteroid material;
    - a mutual-gravity ECS module.
  - The **engine** gets scene-scoped debugger tabs.

The **SPACE** preset is stars, one or more suns and nebulae, with no atmosphere, ground or clouds.

## Context

- **The schema already holds arrays.** `suns[]` and `moons[]` have been arrays since p111/p112 (p110 "Definition shape"). The builder currently renders only index 0 and warns about the rest (`activate` in `SkyBox.ts`).
- **Why nebulae need a bake.** Live per-pixel nebulae are too expensive:
  - A domain-warped 3D fbm is about 2 × 5 octaves of `mx_noise` per nebula, per pixel.
  - With 2–3 nebulae at 4K, that is about 8.3M pixels × roughly 30 noise evaluations, every frame, just for a backdrop that never changes while the scene runs.
  - Nebulae change only when their params do; they move only by the sidereal rotation, which is a lookup rotation.
  - So they are baked into a cube once per change and sampled with a single cube lookup per pixel.
- **The bake building blocks exist in three (r186.1, checked).**
  - `CubeRenderTarget` is exported from `three/webgpu` (`Three.WebGPU.js:20`). Its texture is a `CubeTexture` with `isRenderTargetTexture` set (`renderers/common/CubeRenderTarget.js`).
  - `CubeCamera.update(renderer, scene)` renders the six faces (`cameras/CubeCamera.js:178-255`).
  - `CubeTextureNode.setupUV` handles the render-target x flip and the WebGPU y flip, so a cube baked by `CubeCamera` from a background node `f(normalWorldGeometry)` samples back as `f(dir)`. Phase 1 verifies this with a live-vs-baked diff.
  - Pass `type: HalfFloatType` for HDR, because the default is UnsignedByte.
- **Noise functions.** `mx_fractal_noise_float` / `_vec3`, `mx_worley_noise_float` and `mx_noise_vec3` are exported from `three/tsl` (`materialx/MaterialXNodes.js:66-108`).
- **Scene-scoped cleanup already exists.** `registerOnAllSceneExits` (`Scene.ts`) is what `Viewports.ts` (`createViewport({ sceneId })`) and `PostFX.ts` use, and `removeDebuggerTab` exists (`debug/DebuggerGUI.ts`). The scene-scoped tab (DD7) reuses both.
- **Physics in space.** Each scene load gets a fresh physics world (`resetPhysicsWorld`, p101), so a scene can set its own zero gravity (`getPhysicsWorld().setGravity`) without touching other scenes.
  - Rigid bodies have `resetForces` / `addForce` (`PhysicsAPITypes.ts:425-431`).
  - `CONVEXHULL` colliders take a vertex list (`PhysicsAPITypes.ts:1119`).
  - In `WORKER_THREAD` mode, `translationSync()` throws on the proxy (`PhysicsAPI.ts`), so per-sub-step positions are only available on the main thread (DD9).

### Changes since the plan was written

- **The memory figures were for RGBA8.** A HalfFloat RGBA texel is 8 bytes. That gives 3.1 MB at 256, 12.6 MB at 512 and 50.3 MB at 1024 per face set without mipmaps; mipmaps add a third. The cube skips mipmaps (DD1).
- **The render-target trap applies to the cube.** Three r186 destroys a render target's GPU texture in place if the target was sampled before anything rendered into it (see CLAUDE.md, sky box). The background samples the cube during the scene load, and bakes never run during a load. So the cube is cleared once when it's allocated, like the env bake target (`initEnvBakeTarget` in `SkyEnvironment.ts`).
- **The env bake depends on the cube, so order matters.** In `skyBoxSystem`, the static bake runs before the env bake in the same tick, and a static bake requests an env bake.
- **The throttle doesn't need release detection.** The rule "at most one bake per 150 ms, and the latest request always runs" gives the final bake after a drag for free.
- **The bake stats become shared.** `_dbg__EnvBakeStats.ts` is module-level state for the env bake only. It becomes a factory (`createBakeStats`), used by both bakes. The GPU timer is already reference counted.
- **The SPACE demo gets its own scene**, instead of being a selectable sky box in the showcase. The showcase also lists the `space` sky box, for the PBR-sphere reflection check.

## Design decisions

1. **Static-layer cube bake** (`SkyBox/SkyStaticLayers.ts`).
   - **What gets baked.**
     - One HalfFloat RGBA `CubeRenderTarget` per active sky box, with `nebula.resolution` per face (default **512**, options 256 and 1024).
     - No mipmaps: nebulae are smooth, and the view magnifies the cube (a 512 face is about 0.18° per texel, a 1080p pixel at 60° FOV about 0.05°).
     - No depth buffer.
     - Nebulae are the only thing baked by default.
     - Optionally, far background stars too (`stars.bakeDistant`): the dense, faint, non-twinkling star layer. The live stars layer then draws only the bright twinkling ones.
   - **How it bakes.** A private scene holds a `backgroundNode` that is the sum of every nebula's emission. A `CubeCamera` renders it with `update()`.
   - **When it bakes.**
     - On activation, and on structural changes: the next `skyBoxSystem` tick.
     - For param changes: throttled to at most one bake per 150 ms, where the latest request always runs, so a drag ends with a bake of the final value.
     - Never while a scene loads, and never per frame otherwise.
   - **Allocation.** The target is cleared once (all six faces) on allocation (see "Changes since the plan was written").
   - **Memory.** 12.6 MB at 512, 50.3 MB at 1024. The debugger shows the figure.
   - **Sampling.** The composite adds `cubeTexture(target.texture, rot · dir)` right after the base, behind the stars. `rot` is its own uniform: the sidereal rotation with day-night on, else identity.
   - **Environment.** The ENV_BAKE composite samples the same cube, so nebula colours tint PBR reflections.
   - **Order.** A static bake requests an env bake, and runs before it in the same tick.
   - **Disposal.** The target and the private scene's background node are disposed in `clearSkyBox`, and on a rebuild without static layers. `getPMREMTexture`'s cache is untouched.
   - **Path.** Static layers make a sky box composite (`hasProceduralLayer`), and whether it has them is part of `getCompositeSignature`. So turning them on or off is a rebuild.
2. **Nebula layer** (`layers/nebula.ts`). `nebulae[]` holds up to 8 entries, a compile-time unrolled sum in the bake only.
   - Each nebula's params:
     - `seed`: offsets the noise domain.
     - `direction`: a `vec3` centre.
     - `size`: angular radius in degrees.
     - `falloff`: edge softness.
     - `stretch` / `orientation`: an elongated, rotated shape.
     - `colors`: 2–3 stops mapped by density.
     - `density`, `octaves` (2–6, structural), `warp` (domain-warp strength via `mx_fractal_noise_vec3`).
     - `dust`: dark lanes through `mx_worley_noise_float`, subtracted.
     - `brightness` (HDR emission).
     - `starBoost`: extra live-star density inside the nebula. This is sampled from a low-resolution mask channel stored in the cube's alpha.
   - **Compositing.** Additive over the base (usually black `COLOR` in space). It sits behind the stars and suns, and behind the atmosphere when an atmosphere exists (a night sky with a faint nebula).
3. **Multiple suns and moons.**
   - **Limits.** `suns[0..3]` and `moons[0..1]`, compile-time unrolled. Adding or removing an entry is structural.
   - **The primary sun.** Only `suns[0]` drives the atmosphere (p110 composite order). The others are discs plus glow.
   - **Colours.** An extra sun's `color` is `'AUTO'`: the extinction colour when an atmosphere exists, otherwise white. A hex colour can be set instead, which space scenes need (a blue and an orange sun).
   - **Lights.** Each sun and moon can have a managed light, with roles `SUN_i` and `MOON_i`. **Only `suns[0].light.castShadow` defaults to true**, and every other light defaults to no shadow. The debugger warns when more than two sky lights cast shadows, because each shadow map is a full extra scene render.
   - **Positions.** With day-night enabled, the extra suns and moons keep fixed elevation/azimuth offsets and rotate with the sidereal rotation when `rotateWithSky` is set. That makes them "stars" in the sky, not solar-system orbits; orbits are out of scope.
4. **Presets** (`SkyBox/presets.ts`).
   - `preset: 'DAY_SKY' | 'NIGHT_SKY' | 'DAY_NIGHT' | 'SPACE'` names a def template. It is deep-merged **under** the def, so explicit fields win. Arrays such as `suns` are replaced, not merged.
   - **SPACE:**
     - base `COLOR #000005`;
     - `stars` dense, with the fade disabled (no atmosphere, so stars are always visible);
     - `suns` with one sun, a light and a large glow;
     - `nebulae` with two seeded entries;
     - no `atmosphere`, `ground` or `clouds`;
     - `env.dynamic: false` (bake once) and `env.size` 256.
   - The other presets package the p112/p113 layers with tuned defaults. The `DAY_NIGHT` preset is the one used by the showcase `dayNight.skybox.json`.
   - The schema validates `preset` as an enum. `gatherAppData` resolves presets at build time: it emits the merged def, so the runtime sees only plain defs, and the resolved JSON autocompletes in the editor.
5. **Nebula creator** (debug; `core/Debug/SkyBox/_dbg__NebulaFolder.ts`).
   - **List:** add, duplicate, remove and select.
   - **Per nebula:** all the params from DD2, plus:
     - "Randomize seed";
     - "Point at view", which sets `direction` to the active camera's forward vector;
     - a live bake-time readout.
   - **Other folders.**
     - A "Suns" folder with a sun list (up to 4) plus the p112 per-sun and per-light folders.
     - The Moon folder (p113) becomes a list (up to 2).
     - A tab-level "Apply preset" dropdown.
   - **Undo.**
     - Params use `skybox.param`, coalesced by path, e.g. `nebulae.1.warp`.
     - Adding, removing or duplicating an entry records `skybox.param` on the **array path** (`nebulae`, `suns`, `moons`) with the whole array as `prev`/`next`, not coalesced.
     - "Apply preset" records the new action `skybox.applyPreset { sceneId, skyBoxId, prevOverride, nextOverride }`.
6. **Static-layers test harness** (Phase 1 only; debug).
   - **Where.** A "Static layers" folder (`core/Debug/SkyBox/_dbg__StaticLayersFolder.ts`) turns on a hard-coded test layer for the active sky box. This is session-only: it's never saved or undoable.
   - **The test layer.** A coloured fbm field on the direction plus three axis markers (+X red, +Y green, +Z blue), so a flip, swapped face or seam is obvious.
   - **Injected from the debug module.** Its node builder is passed in from the `_dbg__` module (`_setStaticLayersTest` in `SkyBox.ts`), so production has no test code.
   - **View modes.**
     - `BAKED`: sample the cube, the real path.
     - `LIVE`: evaluate the same node per pixel.
     - `DIFF`: `|baked − live| × 10`, which should be black apart from filtering noise. This is the orientation and seam check, instead of a reference equirect.
   - **Controls.**
     - Resolution: 256, 512 or 1024.
     - A "Drag test" gain slider: a uniform of the bake source, which requests throttled bakes.
     - "Re-bake now".
     - Stats: bakes, bakes/s, CPU ms, GPU ms (WebGPU) and memory.
   - **Phase 2 replaces it.** Phase 2 replaces the test layer with `nebulae[]`. The folder's stats and resolution move to the Nebulae folder.
7. **Scene-scoped debugger tabs** (engine, `debug/DebuggerGUI.ts` + `core/Debug/_dbg__DebuggerGUI.ts`).
   - **The option.** `DebuggerTabDef.sceneId?: string`. The tab is removed (`removeDebuggerTab`) when that scene exits, through one `registerOnAllSceneExits` hook in the `_dbg__` module, as `createViewport({ sceneId })` does.
   - **Where it's created.** The scene creates the tab in its scene file (or on enter), so it comes back on every visit.
   - **The saved tab.** If the saved `currentTabId` is a scene tab that doesn't exist yet (the drawer opens before the scene creates its tab, eg. after a reload), the drawer falls back to the first tab. It keeps the saved id, and switches to the tab when it registers during that session. Removing the open tab mounts the first tab.
   - **Menu order.** Scene tabs sort after the configured `tabOrder` (unless `orderNr` says otherwise), and are marked as scene tabs in the tooltip.
8. **Asteroid geometry and material** (toolkit).
   - **Geometry.** `toolkit/geometry/generateAsteroid.ts`: `generateAsteroid({ radius, detail, seed, shape, noise, craters, flatShading })`.
     - An icosphere (`IcosahedronGeometry`, detail 2–4). Its vertices are merged, then displaced along the normal:
       - a seeded 3D simplex fbm (`SimplexNoise` with `createSeededRandom`), for lumps;
       - a few spherical-cap craters with raised rims;
       - a per-axis `shape` scale, for elongated rocks.
     - Then it's made non-indexed with flat normals, for the semi-low-poly faceted look (`flatShading: false` keeps smooth normals).
     - It returns:
       - `geometry`;
       - `hullVertices` (the displaced unique positions, for a `CONVEXHULL` collider);
       - `volume` (from the closed mesh, for the mass);
       - `boundingRadius`.
     - Same seed, same rock.
   - **Material.** `toolkit/materials/asteroid.material.json` + `asteroid.tsl.ts`, a `STANDARDNODEMATERIAL` with `colorNode`, `roughnessNode` and `normalNode`, following the toolkit's `tslFile` pattern.
     - It uses object-space 3D noise (`positionLocal`), so the pattern needs no UVs and turns with the rock.
     - Colour: two rock colours mixed by fbm, plus darker Worley pits and light mineral speckles.
     - Roughness varies with the same noise.
     - The normal is a bump from the noise height (`bumpMap`).
     - Inputs are colours, scales and strengths, with a `seed` offset, so one material gives different-looking rocks per mesh through `matOverrides`.
9. **Mutual gravity** (toolkit, `toolkit/ecs/effects/MutualGravity.ts`).
   - **The system.** An `APP_PHYSICS_STEP` system, registered like the other toolkit effects (`registerMutualGravityEffect(world)` in `AppECSPlugins.ts`). Every sub-step, it resets each registered body's forces and adds the pairwise Newtonian pull `G·m₁·m₂ / (r² + ε²)`, where `ε` is a softening length, so touching rocks don't explode.
   - **API.**
     - `addGravityBody(entityId, mass)` and `removeGravityBody`;
     - `setMutualGravityConfig({ G, softening, enabled })`.
     - Bodies are dropped when their entity is gone, and all of them on scene exit.
   - **Positions.**
     - `MAIN_THREAD`: `translationSync()`, exact per sub-step.
     - `WORKER_THREAD`: the entity's `TRANSFORM` (the last synced frame), because sync reads throw on the worker proxy. That makes the forces up to a frame stale, so the simulation is not deterministic in worker mode. This is documented, like the characters' non-determinism.
   - **Cost.** O(n²), fine for the demo's handful of bodies. A spatial or Barnes-Hut version is out of scope.
10. **Space demo scene** (app).
    - **Files.** `app/space.scene.json` + `app/space.ts`, `app/cameras/spaceCamera.camera.json` and `app/skyboxes/space.skybox.json` (`"preset": "SPACE"`).
    - **The asteroids.** Three to five of them near the origin (`generateAsteroid` + the asteroid material, different seeds and sizes).
      - Zero world gravity.
      - Dynamic bodies with `CONVEXHULL` colliders, mass from `volume × density`, some restitution.
      - Initial velocities that put the pair or trio into a loose mutual orbit, instead of a straight fall together.
      - They cast and receive the sun light's shadows.
    - **Scene debug tab "Space demo"** (`sceneId: 'space'`, DD7):
      - `G`, softening and gravity on/off;
      - "Reset asteroids" and "Spawn asteroid" (random seed, near the origin);
      - an asteroid list (mass, speed);
      - total kinetic energy.
      - These settings are session-only, not persisted.

## Files touched

| File                                                                                                          | Change                                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/_engine/core/SkyBox/SkyStaticLayers.ts` (new)                                                            | Cube bake scheduler, target, private scene                      |
| `src/_engine/core/SkyBox/SkyBox.ts`, `SkyComposite.ts`                                                        | Static layers in the composite, bake order, test hook (Phase 1) |
| `src/_engine/core/SkyBox/layers/nebula.ts` (new)                                                              | Nebula emission node                                            |
| `src/_engine/core/SkyBox/layers/{sun,moon}.ts`, `SkyLights.ts`, `SkyComposite.ts`                             | Unrolled arrays, per-index lights and roles                     |
| `src/_engine/core/SkyBox/layers/stars.ts`                                                                     | `bakeDistant`, `starBoost` mask                                 |
| `src/_engine/core/SkyBox/presets.ts` (new)                                                                    | Preset templates + merge                                        |
| `src/_engine/schemas/skyBoxSchema.ts`                                                                         | `nebulae[]`, `preset`, array limits                             |
| `devTools/gatherAppData.ts`                                                                                   | Build-time preset resolution                                    |
| `src/_engine/core/Debug/SkyBox/_dbg__StaticLayersFolder.ts` (new, Phase 1), `_dbg__EnvBakeStats.ts`           | Test harness; bake stats as a shared factory                    |
| `src/_engine/core/Debug/SkyBox/_dbg__{Nebula,Suns}Folder.ts` (new), `_dbg__MoonFolder.ts`, `_dbg__SkyBox.ts`  | Creator, lists, preset dropdown, `skybox.applyPreset` handler   |
| `src/_engine/debug/DebuggerGUI.ts`, `src/_engine/core/Debug/_dbg__DebuggerGUI.ts`                             | `sceneId` scene-scoped tabs                                     |
| `src/toolkit/geometry/generateAsteroid.ts` (new)                                                              | Procedural asteroid geometry                                    |
| `src/toolkit/materials/asteroid.material.json`, `asteroid.tsl.ts` (new)                                       | Procedural asteroid material                                    |
| `src/toolkit/ecs/effects/MutualGravity.ts` (new), `src/AppECSPlugins.ts`                                      | N-body gravity system                                           |
| `src/app/space.scene.json`, `space.ts`, `cameras/spaceCamera.camera.json`, `skyboxes/space.skybox.json` (new) | Space demo scene + scene debug tab                              |
| `src/app/skyShowcase.scene.json`                                                                              | Also lists `space` (reflection check)                           |
| `package.json`, `CHANGELOG.md`, `.claude/CLAUDE.md`                                                           | Engine minor, toolkit minor, app minor                          |

## Phases

Each phase compiles, lints, and leaves existing skyboxes unchanged.

1. **Static-layer cube bake infrastructure.**
   - Build `SkyStaticLayers.ts`, the composite and env-bake sampling, the bake order and throttle, and disposal.
   - Build the shared bake stats and the DD6 test harness.
   - Verify:
     - the bake runs only on change (the bake counter);
     - a drag bakes at most every 150 ms and ends on the final value;
     - `DIFF` is black: no seams, correct orientation, including with day-night rotation;
     - the environment picks up the cube (PBR spheres in the showcase);
     - memory matches the estimate;
     - `renderer.info.memory` is stable over test on/off, resolution changes and scene round trips.
2. **Nebula layer + schema + nebula creator.** The test layer is removed.
   - Verify: every param behaves, dragging stays responsive (bakes at most every 150 ms), seeds are deterministic across reloads, and nebulae rotate with the sky when day-night is on.
3. **Multiple suns and moons.**
   - Verify: 1–4 suns render with the right colours and optional lights, only `suns[0]` shapes the atmosphere, the shadow-count warning appears, and adding or removing an entry is a single rebuild.
4. **Presets.** `presets.ts`, the schema's `preset`, build-time resolution in `gatherAppData`, and "Apply preset" with `skybox.applyPreset`.
   - Verify:
     - `gatherAppData` emits the resolved preset def;
     - `dayNight.skybox.json` on `DAY_NIGHT` looks unchanged;
     - "Apply preset" can be undone.
5. **Scene-scoped debugger tabs** (DD7).
   - Verify:
     - a test tab with `sceneId` disappears on scene exit and comes back on re-entry;
     - a reload with that tab open lands on it once the scene has created it;
     - other tabs are unaffected.
6. **Toolkit: asteroid geometry, asteroid material, mutual gravity** (DD8, DD9).
   - Verify:
     - the same seed gives the same rock;
     - the hull collider matches the mesh (Physics debug render);
     - the material shows no seams or UV artefacts, on WebGPU and WebGL2;
     - two bodies attract symmetrically (momentum is conserved within float error).
7. **Space demo scene + docs + versions** (DD10).
   - Verify:
     - SPACE shows stars, suns and nebulae with no horizon;
     - the asteroids orbit each other, and collide without exploding;
     - the "Space demo" tab appears only while the space scene is open;
     - PBR spheres in the showcase reflect nebula colours with the `space` sky box;
     - both worker targets run the demo.
   - Update CHANGELOG, CLAUDE.md and the versions: engine minor; toolkit minor (new geometry, material and effect); app minor (new scene).

## Non-goals

- Orbital mechanics for extra suns and moons, planets or ring systems.
- Volumetric or parallax nebulae. Nebulae sit at infinity, like the rest of the sky.
- Live (unbaked) nebula animation. A slow drift is possible later by re-baking on a timer, which this plan doesn't do.
- A galaxy or planet texture generator.
- Deterministic mutual gravity in `WORKER_THREAD` mode (DD9), and anything faster than O(n²) gravity.
- Physics objects in the scene/asset JSON (still code-only, per CLAUDE.md): the demo creates its asteroids in `space.ts`.

## Risks / open questions

| Risk                                                                   | Mitigation                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nebula bake time at 1024 per face with 8 nebulae (one-time hitch)      | Default 512 with ≤ 3 nebulae in presets. The bake-time readout is shown, and slider bakes are throttled.                                                                                            |
| Cube seams from noise evaluated per face                               | Noise is evaluated on the 3D direction, not face UVs, so it is seamless by construction. Verified in Phase 1 (`DIFF`).                                                                              |
| Memory of a HalfFloat cube (12.6 MB at 512, 50.3 MB at 1024)           | No mipmaps. Shown in the debugger. The resolution is a param, and RGBA8 plus an intensity scale is a fallback if needed.                                                                            |
| `stars.bakeDistant` stars leak into the env bake (it samples the cube) | They're faint and sub-texel, and the PMREM blur averages them out. If they show up in reflections, bake them into a second cube the env bake doesn't sample. Decide in Phase 2.                     |
| The background shows the cleared (black) cube until the first bake     | It lasts one frame after the scene load ends, the same as the env bake today. Acceptable.                                                                                                           |
| `mx_fractal_noise_vec3` hangs SwiftShader's WebGL2 (found in Phase 1)  | DD2's domain warp uses it. In Phase 2, check it on a real WebGL2 GPU. If it's slow there too, warp with three offset `mx_fractal_noise_float` calls instead (the float fbm is fine on SwiftShader). |
| Several shadow-casting sky lights                                      | Defaults of one; a warning above two (DD3).                                                                                                                                                         |
| Preset changes silently alter JSON-authored skyboxes on engine upgrade | Resolution happens at build time into generated data, and preset templates are versioned in the file header. A change to a preset template is noted in the changelog as a visual change.            |
| Asteroid hulls from high-detail icospheres are slow to build           | The hull takes the displaced unique vertices (≤ 2562 at detail 4). Rapier computes the hull once per body. The demo uses detail 2–3.                                                                |
| Close encounters fling bodies apart (N-body singularity)               | Softening `ε` in the force, plus the colliders keep bodies apart.                                                                                                                                   |

## Verification

- `yarn lint` and `yarn build` after each phase.
- Showcase scene, SPACE and DAY_NIGHT skyboxes via the `run-aekasha-js` skill, on WebGPU and WebGL2, with PostFX on and off (bloom on the suns).
- The space scene in both `MAIN_THREAD` and `WORKER_THREAD` modes.
- `renderer.info.memory` is stable over 10 preset switches and 10 scene round trips.
- Production build:
  - the nebula creator and the static-layers test harness are absent from the main chunk;
  - `presets.ts` is present only if runtime code references it (JSON presets are resolved at build time);
  - the space demo's debug tab is absent.

## Implementation notes

### Phase 1: static-layer cube bake

- **What was built.**
  - `SkyStaticLayers.ts`: the cube target, the camera and the private scene; the NOW/THROTTLED request; `runRequestedStaticLayersBake`; the memory figure; the debug bake hooks.
  - `SkyComposite.ts`: the static layers join `hasProceduralLayer` and the signature, and the cube is sampled after the base in both modes, with its own rotation uniform written by `applySkyRotation` (the former `applyStarsSky`).
  - `SkyBox.ts`: `buildNodes` sets up the cube before the composites; it's disposed on the direct path and in `clearSkyBox`; `skyBoxSystem` runs the static bake before the env bake; `_setStaticLayersTest` for the harness.
  - The debug harness: `_dbg__StaticLayersFolder.ts` ("Static layers (test)" folder, after Environment), plus `_dbg__BakeStats.ts` (`createBakeStats`), which the env bake stats now use too.
  - Until Phase 2, `getStaticLayersSourceOf(def)` ignores the definition and returns the test layer.
- **Checked on WebGL2 (SwiftShader, WSL2), showcase and scene01 (texture base):**
  - one bake on enable, and none over 4 s idle;
  - a 1.6 s drag of 30 ticks made 7 bakes, and it ended on the final value;
  - resolution changes (256, 1024, 512) make one bake each;
  - `renderer.info.memory` returns to its baseline after the layer is turned off, and stays stable over 3 on/off toggles. The WebGL backend doesn't count the cube in `texturesSize`, so the 12.6 MB figure is computed, not measured;
  - the texture-only sky box goes onto the composite path with the layer on.
- **Not checked yet: WebGPU.** WSL2 headless can't run WebGPU, so it needs a real browser.
- **DIFF reading.** With the harness's soft (3°+) edges, DIFF is black apart from a faint, symmetric outline pair around the ring markers: bilinear filtering error, × 10. That holds with the day-night rotation too. An orientation or face error would show as a displaced ghost instead. The first version had 1° edges, and its outlines were bright enough to look like a bug.
- **DIFF needs a dark sky.** The diff replaces only the sky behind it: the atmosphere, clouds and stars still draw on top, so read it at night or on a sky box without an atmosphere.
- **Changing the view mode rebuilds the nodes**, which makes one extra bake. That's harmless, and it's harness-only.
