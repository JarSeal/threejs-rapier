Status: in progress | Phases 1–6 implemented
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
- **Extra suns and moons with day-night (decided in Phase 3).** DD3's "fixed elevation/azimuth offsets" had no field and no reference point. `dayOfYear` never advances, so the sun stands still in the star frame, and "turns with the sky" is the same motion as "keeps its offset to `suns[0]`".
  - An extra sun gets `rotateWithSky` (default true). Its elevation and azimuth are where it stands at `dayNight.timeOfDay` (the start time), and it turns with the sky from there. With false, it stays at its elevation and azimuth.
  - `moons[1]` is a second p113 orbit, not an offset: its own phase, `phaseMode`, `lunarCycleDays` and `inclination` (`computeMoonDirection` already took the moon). `SkyTimeState.moonPhase` became `moonPhases[]`.
- **What stays primary-only.** `suns[0]` drives the atmosphere, the stars' fade, the clouds' light, the ground and the ambient light. `moons[0]` lights the clouds. Every sun is dimmed and coloured by the atmosphere along its own direction: a custom colour's compensation, the disc's `sunE` cap and the light's AUTO colour are per sun (`computeSunE`, `computeExtinction` at its height).
- **The Suns and Moons lists (DD5) are built in Phase 3**, since the Phase 3 check "adding or removing an entry is a single rebuild" needs them. "Apply preset" stays in Phase 4.
- **Presets and the schema (found in Phase 4).**
  - `base` was required, so it's now optional when a `preset` gives one (a refine). The editor's JSON Schema can't say "required unless preset", so it no longer marks `base` as required; the gatherer still enforces it.
  - The "clouds need an atmosphere" refine runs on the resolved definition, since a preset may give the atmosphere.
  - The runtime `SkyBoxDef` type has no `preset`. Code definitions go through `resolveSkyBoxPreset` (the plan only covered JSON), so `presets.ts` stays out of the main chunk unless code uses it.
- **Toolkit details (found in Phase 6).**
  - Three's `IcosahedronGeometry` splits each edge into `detail + 1` segments, so detail 2–4 is 92–252 vertices, not up to 2562. `generateAsteroid` takes detail 1–10 (default 4).
  - Rapier's mass for a `CONVEXHULL` collider is density × the **hull's** volume, about 10% more than the cratered mesh's. `generateAsteroid` also returns `hullVolume`, and the gravity mass should use it.
  - `RigidBodyAPI` has no `translationSync()` (only colliders do). Its `readPoseInto` is exact on the main thread and reads the last synced pose in worker mode, so the gravity reads that in both modes. That's better than `TRANSFORM`, which can hold an interpolated render pose.
  - three's `bumpMap()` only works on texture nodes: it re-samples the texture at UVs offset by the screen derivatives, so a procedural height gives no bump. The asteroid material does its own derivative bump.
  - `createMaterial` gives each node socket its own inputs, so the asteroid material keeps every input on `colorNode`, which also sets `roughnessNode` and `normalNode`. One `seed` in `matOverrides` then changes all three.
- **"Apply preset" is a computed override (found in Phase 4).** An override can't delete a key or change `base.type`. So the override that makes a definition look like a preset is a diff against the definition: layers the preset lacks get `enabled: false`, every key either side sets gets the preset's effective value, and the lists are whole arrays. A texture base is kept, with a toast.

## Design decisions

1. **Static-layer cube bake** (`SkyBox/SkyStaticLayers.ts`).
   - **What gets baked.**
     - One HalfFloat RGBA `CubeRenderTarget` per active sky box, with `env.nebulaSize` per face (default **512**, options 256 and 1024). It sits next to `env.size`, because `nebulae` is an array.
     - No mipmaps: nebulae are smooth, and the view magnifies the cube (a 512 face is about 0.18° per texel, a 1080p pixel at 60° FOV about 0.05°).
     - No depth buffer.
     - Nebulae are the only thing baked by default.
     - ~~Optionally, far background stars too (`stars.bakeDistant`).~~ **Dropped in Phase 2.** At 512, a cube texel is about 0.18°, so a baked star (≈ 0.05°) would blur to 3–4 screen pixels and dim, and it would leak into the env bake. The live stars stay live.
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
     - `density`, `octaves` (2–6, structural), `warp` (domain-warp strength, from three offset `mx_fractal_noise_float` calls: the vec3 fbm hangs SwiftShader's WebGL2).
     - `dust`: dark lanes, subtracted. Made from ridged fbm, not `mx_worley_noise_float`: Worley is a 27-cell loop per sample and makes blotches, not lanes.
     - `brightness` (HDR emission).
     - `starBoost`: extra live-star density inside the nebula. This is sampled from a low-resolution mask channel stored in the cube's alpha.
   - **Compositing.** Additive over the base (usually black `COLOR` in space). It sits behind the stars and suns, and behind the atmosphere when an atmosphere exists (a night sky with a faint nebula).
3. **Multiple suns and moons.**
   - **Limits.** `suns[0..3]` and `moons[0..1]`, compile-time unrolled. Adding or removing an entry is structural.
   - **The primary sun.** Only `suns[0]` drives the atmosphere (p110 composite order). The others are discs plus glow.
   - **Colours.** An extra sun's `color` is `'AUTO'`: the extinction colour when an atmosphere exists, otherwise white. A hex colour can be set instead, which space scenes need (a blue and an orange sun).
   - **Lights.** Each sun and moon can have a managed light, with roles `SUN_i` and `MOON_i`. **Only `suns[0].light.castShadow` defaults to true**, and every other light defaults to no shadow. The debugger warns when more than two sky lights cast shadows, because each shadow map is a full extra scene render.
   - **Positions.** With day-night enabled, an extra sun with `rotateWithSky` (default true) stands at its elevation/azimuth at the start time and turns with the sky from there, which makes it a "star" in the sky, not a solar-system orbit (orbits are out of scope). Each moon follows the p113 orbit with its own phase. See "Changes since the plan was written".
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
6. **Static-layers test harness** (Phase 1 only; debug; removed in Phase 2).
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
     - An icosphere (`IcosahedronGeometry`, detail 1–10, default 4; see "Changes since the plan was written"). Its vertices are merged, then displaced along the normal:
       - a seeded 3D simplex fbm (`SimplexNoise` with `createSeededRandom`), for lumps;
       - a few spherical-cap craters with raised rims;
       - a per-axis `shape` scale, for elongated rocks.
     - Then it's made non-indexed with flat normals, for the semi-low-poly faceted look (`flatShading: false` keeps smooth normals).
     - It returns:
       - `geometry`;
       - `hullVertices` (the displaced unique positions, for a `CONVEXHULL` collider);
       - `volume` (from the closed mesh);
       - `hullVolume` (of the convex hull, which is what the physics mass comes from);
       - `boundingRadius`.
     - Same seed, same rock.
   - **Material.** `toolkit/materials/asteroid.material.json` + `asteroid.tsl.ts`, a `STANDARDNODEMATERIAL` with `colorNode`, `roughnessNode` and `normalNode`, following the toolkit's `tslFile` pattern.
     - It uses object-space 3D noise (`positionLocal`), so the pattern needs no UVs and turns with the rock.
     - Colour: two rock colours mixed by fbm, plus darker Worley pits and light mineral speckles.
     - Roughness varies with the same noise.
     - The normal is a bump from the noise height (screen-derivative bump, not `bumpMap`).
     - Inputs are colours, scales and strengths, with a `seed` offset, so one material gives different-looking rocks per mesh through `matOverrides`.
9. **Mutual gravity** (toolkit, `toolkit/ecs/effects/MutualGravity.ts`).
   - **The system.** An `APP_PHYSICS_STEP` system, registered like the other toolkit effects (`registerMutualGravityEffect(world)` in `AppECSPlugins.ts`). Every sub-step, it resets each registered body's forces and adds the pairwise Newtonian pull `G·m₁·m₂ / (r² + ε²)`, where `ε` is a softening length, so touching rocks don't explode.
   - **API.**
     - `addGravityBody(entityId, mass)` and `removeGravityBody`;
     - `setMutualGravityConfig({ G, softening, enabled })`.
     - Bodies are dropped when their entity is gone, and all of them on scene exit.
   - **Positions.**
     - Both modes read `rb.readPoseInto`.
     - `MAIN_THREAD`: exact per sub-step.
     - `WORKER_THREAD`: the last pose the worker synced back. That makes the forces up to a frame stale, so the simulation is not deterministic in worker mode. This is documented, like the characters' non-determinism.
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

| File                                                                                                                            | Change                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/_engine/core/SkyBox/SkyStaticLayers.ts` (new)                                                                              | Cube bake scheduler, target, private scene                        |
| `src/_engine/core/SkyBox/SkyBox.ts`, `SkyComposite.ts`                                                                          | Static layers in the composite, bake order, test hook (Phase 1)   |
| `src/_engine/core/SkyBox/layers/nebula.ts` (new)                                                                                | Nebula emission node                                              |
| `src/_engine/core/SkyBox/layers/{sun,moon}.ts`, `SkyLights.ts`, `SkyComposite.ts`                                               | Unrolled arrays, per-index lights and roles                       |
| `src/_engine/core/SkyBox/layers/stars.ts`                                                                                       | `starBoost` mask                                                  |
| `src/_engine/core/SkyBox/presets.ts` (new)                                                                                      | Preset templates + merge                                          |
| `src/_engine/schemas/skyBoxSchema.ts`                                                                                           | `nebulae[]`, `preset`, array limits                               |
| `devTools/gatherAppData.ts`                                                                                                     | Build-time preset resolution                                      |
| `src/_engine/core/Debug/SkyBox/_dbg__StaticLayersFolder.ts` (Phase 1 only), `_dbg__EnvBakeStats.ts`, `_dbg__BakeStats.ts` (new) | Test harness (removed in Phase 2); bake stats as a shared factory |
| `src/_engine/core/Debug/SkyBox/_dbg__{Nebula,Suns}Folder.ts` (new), `_dbg__MoonFolder.ts`, `_dbg__SkyBox.ts`                    | Creator, lists, preset dropdown, `skybox.applyPreset` handler     |
| `src/_engine/debug/DebuggerGUI.ts`, `src/_engine/core/Debug/_dbg__DebuggerGUI.ts`                                               | `sceneId` scene-scoped tabs                                       |
| `src/toolkit/geometry/generateAsteroid.ts` (new)                                                                                | Procedural asteroid geometry                                      |
| `src/toolkit/materials/asteroid.material.json`, `asteroid.tsl.ts` (new)                                                         | Procedural asteroid material                                      |
| `src/toolkit/ecs/effects/MutualGravity.ts` (new), `src/AppECSPlugins.ts`                                                        | N-body gravity system                                             |
| `src/app/space.scene.json`, `space.ts`, `cameras/spaceCamera.camera.json`, `skyboxes/space.skybox.json` (new)                   | Space demo scene + scene debug tab                                |
| `src/app/skyShowcase.scene.json`                                                                                                | Also lists `space` (reflection check)                             |
| `package.json`, `CHANGELOG.md`, `.claude/CLAUDE.md`                                                                             | Engine minor, toolkit minor, app minor                            |

## Phases

Each phase compiles, lints, and leaves existing skyboxes unchanged.

1. **Static-layer cube bake infrastructure.** **Done** (see Implementation notes, Phase 1).
   - Build `SkyStaticLayers.ts`, the composite and env-bake sampling, the bake order and throttle, and disposal.
   - Build the shared bake stats and the DD6 test harness.
   - Verify:
     - the bake runs only on change (the bake counter);
     - a drag bakes at most every 150 ms and ends on the final value;
     - `DIFF` is black: no seams, correct orientation, including with day-night rotation;
     - the environment picks up the cube (PBR spheres in the showcase);
     - memory matches the estimate;
     - `renderer.info.memory` is stable over test on/off, resolution changes and scene round trips.
2. **Nebula layer + schema + nebula creator.** **Done** (see Implementation notes, Phase 2). The test layer is removed.
   - Verify: every param behaves, dragging stays responsive (bakes at most every 150 ms), seeds are deterministic across reloads, and nebulae rotate with the sky when day-night is on.
3. **Multiple suns and moons.** **Done** (see Implementation notes, Phase 3).
   - Verify: 1–4 suns render with the right colours and optional lights, only `suns[0]` shapes the atmosphere, the shadow-count warning appears, and adding or removing an entry is a single rebuild.
4. **Presets.** **Done** (see Implementation notes, Phase 4). `presets.ts`, the schema's `preset`, build-time resolution in `gatherAppData`, and "Apply preset" with `skybox.applyPreset`.
   - Verify:
     - `gatherAppData` emits the resolved preset def;
     - `dayNight.skybox.json` on `DAY_NIGHT` looks unchanged;
     - "Apply preset" can be undone.
5. **Scene-scoped debugger tabs** (DD7). **Done** (see Implementation notes, Phase 5).
   - Verify:
     - a test tab with `sceneId` disappears on scene exit and comes back on re-entry;
     - a reload with that tab open lands on it once the scene has created it;
     - other tabs are unaffected.
6. **Toolkit: asteroid geometry, asteroid material, mutual gravity** (DD8, DD9). **Done** (see Implementation notes, Phase 6).
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

| Risk                                                                   | Mitigation                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nebula bake time at 1024 per face with 8 nebulae (one-time hitch)      | Default 512 with ≤ 3 nebulae in presets. The bake-time readout is shown, and slider bakes are throttled.                                                                                 |
| Cube seams from noise evaluated per face                               | Noise is evaluated on the 3D direction, not face UVs, so it is seamless by construction. Verified in Phase 1 (`DIFF`).                                                                   |
| Memory of a HalfFloat cube (12.6 MB at 512, 50.3 MB at 1024)           | No mipmaps. Shown in the debugger. The resolution is a param, and RGBA8 plus an intensity scale is a fallback if needed.                                                                 |
| `stars.bakeDistant` stars leak into the env bake (it samples the cube) | Moot: `bakeDistant` was dropped in Phase 2 (DD1).                                                                                                                                        |
| The background shows the cleared (black) cube until the first bake     | It lasts one frame after the scene load ends, the same as the env bake today. Acceptable.                                                                                                |
| `mx_fractal_noise_vec3` hangs SwiftShader's WebGL2 (found in Phase 1)  | Resolved in Phase 2: the warp uses three offset `mx_fractal_noise_float` calls. Nothing in the sky uses the vec3 fbm.                                                                    |
| Several shadow-casting sky lights                                      | Defaults of one; a warning above two (DD3).                                                                                                                                              |
| Preset changes silently alter JSON-authored skyboxes on engine upgrade | Resolution happens at build time into generated data, and preset templates are versioned in the file header. A change to a preset template is noted in the changelog as a visual change. |
| Asteroid hulls from high-detail icospheres are slow to build           | The hull takes the displaced unique vertices (252 at the default detail 4, 1212 at the maximum 10). Rapier computes the hull once per body.                                              |
| Close encounters fling bodies apart (N-body singularity)               | Softening `ε` in the force, plus the colliders keep bodies apart.                                                                                                                        |

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

### Phase 2: nebula layer, schema and creator

- **What was built.**
  - `layers/nebula.ts`: the nebula node and uniforms.
    - Every nebula shares one pipeline: an elliptical shape (size, stretch, orientation, falloff) in azimuthal-equidistant coordinates around its direction, eroding a domain-warped fbm cloud.
    - The cloud is bright filaments over a soft glow body. It's coloured by density through 2–3 stops, with ridged-fbm dust lanes cut out.
    - A nebula is skipped beyond its widest extent (a branch; the bake has no derivatives).
    - The seed feeds a mulberry32 noise-domain offset, so the same seed always gives the same cloud.
    - Every param but `octaves` and which nebulae exist is a uniform: 8 uniform sets, created once per activation.
  - Schema: `SkyBoxNebulaSchema` and `nebulae[]` (max 8), `env.nebulaSize` (256, 512 or 1024), and `nebulae` in the overrides (array or index object, like the suns).
  - `SkyStaticLayers.ts`: the bake draws its own back-side sphere with `NoBlending`, not the scene's `backgroundNode`. The background material is opaque, and three writes alpha 1 for opaque materials (`NodeMaterial.setupDiffuseColor`), which dropped the star-boost mask.
  - `SkyComposite.ts`: `hasStaticLayers` means an enabled nebula. The signature adds each enabled nebula's octaves and the cube size. `starsToStatic` maps the stars' frame to the cube's (identity unless `stars.rotateWithSky` is false).
  - `SkyBox.ts`: `nebulae` merges like the suns. A nebula change requests a throttled bake and leaves the env bake to follow it (not a second, stale one first).
  - `layers/stars.ts`: each cell's star chance is multiplied by `1 + 2 × mask`, where the mask is sampled at the cell's centre so a star is never cut.
  - Debug:
    - The "Nebulae" folder (`_dbg__NebulaFolder.ts`, after Stars) has the list controls: a nebula dropdown, "Add (at view)", "Duplicate" (with a new seed) and "Remove".
    - The selected nebula's folder has every DD2 param, direction as elevation/azimuth in the sky frame, "Randomize seed", "Point at view", colour stops, "Reset nebula" and "Reset nebulae list".
    - A "Nebula cube" subfolder shows the size, memory and bake stats (the live bake-time readout).
  - `_dbg__SkyBoxShared.ts`:
    - `selectNebula` repoints the `nebula` layer path.
    - The sun, moon and nebula defaults are shared by every index.
    - `setSkyBoxArray` records a list edit as one undo step (`skybox.param` on `nebulae`, not coalesced) and rebuilds the tab.
    - `withPath` / `writeSkyBoxOverride` write into a whole-array override by index, and never drop "equal to the definition" values there.
  - The Phase 1 test harness is removed.
- **Checked on WebGL2 (SwiftShader), with a test sky box registered in code (black base, three nebulae) in the showcase:**
  - bakes: 1 on activation, 0 over 4 s idle;
  - a 1.6 s drag of 30 warp ticks made 8 bakes (under the ~12 cap), ending on the final value;
  - an octaves change is one rebuild and one bake;
  - a time-of-day change makes no nebula bake, and the nebulae turn with the sky;
  - the same seeds give byte-identical sky pixels across a reload;
  - the cube's alpha holds the boost mask: 0 with `starBoost` 0, and up to 1 over about 17.5k texels of one face with 1;
  - list edits and undo through the debug helpers:
    - add, then a param on the new entry: the array override is updated in place;
    - undo twice returns to 3 nebulae with no override left;
    - a param on a definition's nebula makes `{ "1": { "dust": 0.9 } }`, and "Reset nebula" clears it;
  - `renderer.info.memory` is back at its baseline after three switches to and from the test sky box;
  - a production build keeps the creator in the lazy debug chunk.
- **Not checked yet:**
  - WebGPU (WSL2 headless can't);
  - the folder's buttons by hand in the drawer (the script drove the same helpers they call);
  - bake times on a real GPU.
- **Reading the showcase.** In the showcase, the stone gate's lintel and the unlit ground hide part of the sky: straight dark cuts across a nebula there are those, not cube seams (confirmed by hiding the meshes and by dumping the cube faces).
- **Stars need the fade off without a sun.** Without a sun, the default sun is at 30° elevation, so the stars' day fade hides them. A space sky box needs `stars.fadeRange: [90, 90]` (the SPACE preset in Phase 4 will set it).

### Phase 3: multiple suns and moons

- **What was built.**
  - Schema: `suns` max 4 and `moons` max 2, in the definition and in whole-array overrides. A sun's `rotateWithSky`. A sun light's `castShadow` defaults to true for `suns[0]` only.
  - `SkyComposite.ts`:
    - `u.suns[4]` / `u.moons[2]`, one uniform set per index (the old `u.sun` / `u.moon`).
    - `computeSunDirectionOf` / `computeMoonDirectionOf` place every entry. Index 0 is written even without entries: the atmosphere, clouds and lights read it.
    - The composite unrolls the enabled discs, suns then moons. The signature holds each index's disc, light and (moons) texture flags.
    - The per-frame path loops only over existing entries.
  - `layers/sun.ts`: `applySunLightingUniforms` takes `{ u, def }` of the atmosphere and computes the sun's own extinction (`SunUniforms.extinction`) and `sunE` cap from its height. For `suns[0]`, that equals the atmosphere's `extinctionAtSun` and `sunE` (checked).
  - `layers/atmosphere.ts`: `computeSunE(def, y)`, pulled out of `applyAtmosphereSunUniforms`.
  - `SkyTime.ts`:
    - `MAX_MOONS` lives here, since `layers/moon.ts` imports this module at load, and is re-exported there.
    - `moonPhases[]`, `setSkyTimeMoonPhase(state, i, phase)`, `getMoonPhaseOf(…, i)`.
    - `turnWithSky(dayNight, dir, fromTime, toTime, out)`: into the star frame at one time, back out at the other. Allocation-free.
  - `SkyLights.ts`: the lights are kept by kind and index, with roles `SUN_0..3` / `MOON_0..1` and names "Sky box sun", "Sky box sun 2", …
    - A moon light fades by its own moon's lit fraction.
    - `EXTRA_SUN_LIGHT_DEFAULTS` (no shadow), `getSkyShadowCasterCount()`.
    - A debug-env `lwarn` fires once per activation, and again only when the count changes, above `MAX_SHADOW_CASTERS_HINT` (2).
    - `getSkyLightIds()` returns `{ suns[], moons[], ambient }`.
  - `SkyBox.ts`:
    - Moon textures are loaded per moon.
    - A moon texture change reloads; adding or removing a moon without one is a rebuild.
    - `getSunDirection` / `getSunElevation` / `getMoonDirection` / `getMoonPhase` take any index.
    - The dev warning is now about entries past the limits (code definitions aren't schema-validated).
    - The day-night re-bake still watches `suns[0]` and `moons[0]` only: the other entries move at about the same rate.
  - Debug:
    - `_dbg__ListFolderItems.ts` holds the list controls: a dropdown, "Add", "Duplicate", "Remove" and "Reset <list> list". The Nebulae folder moved onto it too.
    - `_dbg__SkyBoxShared.ts`: `selectListEntry(list, i)` repoints the `sun`/`sunLight`, `moon`/`moonLight` and `nebula` paths, and `isListOverrideAnArray(list)` is the generalized nebulae check. `getDefValue` gives `castShadow: false` for an extra sun's light, and `[]` for a definition without `suns`/`moons`.
    - Suns folder (`_dbg__SunsFolder.ts`, was `_dbg__SunFolder.ts`): "Add (at view)" is turned back to the start time for an extra sun with day-night. "Duplicate" goes 15° further round, with the light's shadow off. The selected sun has "Turns with the sky" (extra suns) and a "Now at" readout while it turns.
    - Moons folder (`_dbg__MoonFolder.ts`): "Add" makes a quarter moon, at the view without day-night. "Duplicate" is a quarter cycle on, without a shadow.
    - The Light subfolder shows a warning line above 2 shadow casters.
- **Checked on WebGL2 (SwiftShader), showcase:**
  - `dayNight.skybox.json` is unchanged against a HEAD worktree at 11:00, 17:30 and 21:00 (paused): the pixel diff shows only the drifting clouds, twinkling stars and the FPS panel.
  - A test sky box with 4 suns and 2 moons (3 shadow-casting sun lights, a light on `moons[1]`): roles `SUN_0..2` and `MOON_1`, 3 casters, and the warning logged.
  - Moving `suns[1]` leaves the atmosphere's `sunE` unchanged; moving `suns[0]` changes it.
  - `suns[2]`'s orange tint is its colour ÷ its own extinction.
  - Removing a sun or a moon, and a param change: one `update` each, never an `activate`. The removals rebuild the background node, and the param change doesn't. The removed moon's light is deleted.
  - Day-night: at the start time `suns[1]` is at its elevation/azimuth. At 15:00 it has turned, and its angle to `suns[0]` is the same (95.33°). With `rotateWithSky: false` it stays put. `moons[1]` has its own direction and phase.
  - Undo: a list edit (remove to 2 suns), then a param on `suns.1` (written into the array override), then undo twice: back to 4 suns with no override left.
  - Screenshots: 4 coloured suns and 2 phased moons in a black sky (no atmosphere), and the same through an atmosphere with `suns[0]` at 6°.
  - `renderer.info.memory`: textures, render targets and geometries are back at baseline after 3 switches. `uniformBuffers` grows by 2 per switch that creates shadow-casting sky lights, exactly as on HEAD: three's bind-group cache (p056), not this phase.
  - A production build keeps the Suns/Moons folders in the lazy debug chunk.
- **Not checked yet:**
  - WebGPU (WSL2 headless can't);
  - the folders' buttons by hand in the drawer (the script drove the helpers they call);
  - bloom on the extra suns.
- **Custom disc colours clip to white at the core** without bloom or strong tone mapping (radiance 40 × colour); the glow shows the colour. It's the same for `suns[0]`.
- **Changing `dayNight.timeOfDay` moves the extra suns that turn with the sky**, because their elevation/azimuth is anchored to the start time.

### Phase 4: presets

- **What was built.**
  - `SkyBox/presets.ts`: the `DAY_SKY`, `NIGHT_SKY`, `DAY_NIGHT` and `SPACE` templates (template version 1, in the header).
    - It imports only `deepMerge` and types, because the gatherer and the schema run it in Node.
    - `mergeSkyBoxPreset` is generic, for the schema and the gatherer. The definition's type comes from the schema, so a typed version there would be a type cycle.
    - `resolveSkyBoxPreset` is the typed version for code, re-exported from `SkyBox.ts`.
    - The definition's layers merge over the preset's key by key. Its arrays and its base replace the preset's. The template is cloned first, so a result never shares its arrays.
  - Schema: `preset` is `z.enum(SKYBOX_PRESET_NAMES)`, `base` is optional with a preset (see "Changes since the plan was written").
  - `gatherAppData`: sky box files and inline scene sky boxes are resolved after validation. The emitted definition has no `preset` key, and scene save data merges over the resolved definition.
  - `registerSkyBox` warns (debug env) about a definition that still has a `preset` (a cast or plain JS).
  - `dayNight.skybox.json` is now `"preset": "DAY_NIGHT"` plus its own cycle (17:30, a 5-minute day, day 100). The preset has the default cycle.
  - Debug: in "Scene's skyboxes", a "Preset" dropdown (session-only) and "Apply preset (replaces the overrides)".
    - `getPresetOverrides` / `applySkyBoxPreset` are in `_dbg__SkyBoxShared.ts`, next to the other override helpers. The plan put them in `_dbg__SkyBox.ts`, but `getPath` and `getDefValue` live in the shared module.
    - It writes the whole override and activates again from the definition.
    - Undo records `skybox.applyPreset { sceneId, skyBoxId, preset, prevOverride, nextOverride }`.
- **Checked:**
  - The generated `dayNight` definition (and the showcase scene's copy) is identical to the pre-preset JSON, compared with sorted keys. Only `debugData.description` changed. So the showcase looks unchanged by construction.
  - Schema cases:
    - no base and no preset is an error;
    - a preset alone is valid;
    - an unknown preset is an enum error;
    - clouds with DAY_SKY are valid, and with SPACE, or with DAY_SKY's atmosphere turned off, they are errors;
    - an inline scene sky box with a preset validates and resolves.
  - WebGL2 (SwiftShader), showcase. Each preset was applied in turn, and the active definition compared with the resolved preset on every leaf path:
    - NIGHT_SKY, SPACE and DAY_NIGHT match exactly.
    - DAY_SKY differs only in `stars.milkyWay.enabled` under stars that are off: the override is `stars: { enabled: false }`, which hides the Milky Way too.
    - Screenshots of all four look as intended (SPACE: nebula, dense stars, sun shadows, no horizon glow).
  - Undo four times: each step restores the previous override, and it ends on the registered definition with `AEK_debugSkyBox` removed.
  - Production build: the templates are only in the lazy `_dbg__SkyBox` chunk.
- **Not checked yet:**
  - WebGPU;
  - the dropdown and button by hand in the drawer (the script called `applySkyBoxPreset`, which the button calls);
  - SPACE with the space scene's camera (Phase 7 may retune its nebulae).
- **The preset templates are a first pass.** SPACE's second nebula (teal, `[0.7, -0.1, 0.6]`) is behind the showcase camera. Phase 7's space scene is where the SPACE look gets its final tuning.

### Phase 5: scene-scoped debugger tabs

- **Most of DD7's saved-tab behaviour was already there.** `_createDebuggerTab` rebuilds the drawer, and every rebuild mounts `drawerState.currentTabId` if it exists, so a saved tab that registers later is mounted then. The fallback never overwrote the saved id, and removing the open tab already mounted the first tab.
- **What was built.**
  - `DebuggerTabDef.sceneId` (`debug/DebuggerGUI.ts`).
  - `_dbg__DebuggerGUI.ts`:
    - one `registerOnAllSceneExits` hook (`debuggerSceneTabs`) at module load. It removes the exiting scene's tabs with one drawer rebuild, and keeps the saved id, so a re-entry lands on the tab again;
    - `deleteTabEntry` is shared with `_removeDebuggerTab`;
    - scene tabs sort after the other tabs with the same order value, so an unlisted scene tab goes last. `orderNr` or a `tabOrder` entry still place it;
    - the tooltip reads "<title> (scene tab: <sceneId>)";
    - a debug warning fires when `sceneId` isn't a scene, since such a tab is never removed.
  - A fix: while the fallback tab is shown, its scroll position is no longer saved, so the saved tab opens at its own scroll position.
- **Checked on WebGL2 (SwiftShader).** A script created a scene tab for `scene01` and a plain unlisted tab in the page, going through `createDebuggerTab`:
  - the scene tab registered first still sorts after the plain tab, and the other 14 tabs keep their order;
  - on exit to `oneMoreScene`, the tab is removed and Statistics is mounted. The saved id and scroll (300) are kept, including after a scroll event on the fallback tab;
  - re-entering `scene01` (the tab re-created by an enter hook, standing in for the scene file) mounts it again at scroll 300;
  - after a reload with it open, the drawer shows Statistics until the tab is created, then switches to it at scroll 300;
  - after clicking another tab, entering the scene doesn't jump back to the scene tab;
  - no new console warnings or errors.
- **Not checked yet:** by hand in the drawer. Phase 7's "Space demo" tab is the first real scene tab.

### Phase 6: toolkit asteroid geometry, material and mutual gravity

- **What was built.**
  - `toolkit/geometry/generateAsteroid.ts`: `generateAsteroid({ radius, detail, seed, shape, noise, craters, flatShading })`.
    - It merges the icosphere's corners, then displaces every vertex along its direction: simplex fbm lumps, plus crater bowls with raised rims. It never goes below 35% of the radius, so the mesh stays star-shaped. Then it applies `shape`.
    - The noise and the craters come from one seeded stream.
    - It returns `geometry`, `hullVertices`, `volume`, `hullVolume` (three's `ConvexHull`) and `boundingRadius`.
    - The geometry isn't registered: the caller passes it through `saveBufferGeometry`, as with `generateTerrain`. Otherwise `MeshManager` warns that it is never disposed.
  - `toolkit/materials/asteroid.material.json` + `asteroid.tsl.ts`:
    - object-space mottling (fbm), Worley pits and Perlin speckles, with a sine-hashed `seed` offset;
    - roughness from the same field;
    - a Mikkelsen bump with unnormalized surface derivatives, so `bumpStrength` is in object units and looks the same at any distance;
    - `staticDefines.octaves` (default 4).
  - `toolkit/ecs/effects/MutualGravity.ts`: `registerMutualGravityEffect` (`APP_PHYSICS_STEP`, wired in `AppECSPlugins.ts`), `addGravityBody` / `removeGravityBody` / `clearGravityBodies` / `getGravityBodies`, and `set/getMutualGravityConfig` (defaults G 1, softening 0.5).
    - Plummer softening: `G·m₁·m₂·r / (r² + ε²)^(3/2)`.
    - Each pair is computed once, equal and opposite.
    - Allocation-free per sub-step.
    - Turning it off resets the forces once. Scene exit clears the bodies.
  - An engine fix: `createRigidBody` skipped `gravityScale: 0`, a falsy check (`EngineRapier.ts`). This is a patch-level change for the Phase 7 changelog.
- **Checked:**
  - Node (tsx):
    - the same seed gives byte-identical positions and hull vertices at details 2–4, and seed 8 differs;
    - with no lumps or craters, the volume approaches 4/3·π·r³ (32.78 vs 33.51 at detail 4, r = 2), and the same holds for an ellipsoid;
    - `flatShading: false` stays indexed.
  - WebGL2 (SwiftShader), ECS test scene, three rocks created in the page (`gravityScale` 0, density 2, G 0.3), in both `WORKER_THREAD` and `MAIN_THREAD`:
    - Rapier's mass equals `hullVolume` × density to 4 digits. The mesh volume is 11% less.
    - Total momentum stays at 1.2–2.2·10⁻⁵ of Σ|p| after 3 s. Before the `gravityScale` fix, world gravity leaked in.
    - The Physics debug hull wireframes wrap the meshes, with craters spanned, as a convex hull should.
    - A close-up shows no seams or UV artefacts across faces.
    - The rocks collide without exploding.
    - No new console errors.
- **Not checked yet:** WebGPU (WSL2 headless can't), and the look under the space scene's lighting (Phase 7 may retune the material's defaults and the crater sizes).
