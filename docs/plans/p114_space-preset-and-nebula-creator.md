Status: draft | not-implemented
Category: Skybox, Rendering
Blocked by: p112_procedural-sky-atmosphere-sun-and-env-bake.md, p113_night-sky-and-day-night-cycle.md (stars layer, sidereal rotation)
Related: p110_skybox-refactor-and-layered-sky-system.md (epic)

# Space Preset and Nebula Creator — Plan

This plan completes the layered sky with the last pieces:

- **Nebula layer** plus an in-debugger **nebula creator**: procedural, and baked once per change into a static cube.
- **Multiple suns** (up to 4) and a **second moon**.
- **Presets**, ready-made definitions: `DAY_SKY`, `NIGHT_SKY`, `DAY_NIGHT` and `SPACE`.

The **SPACE** preset is stars, one or more suns and nebulae, with no atmosphere, ground or clouds.

## Context

- **The schema already holds arrays.** `suns[]` and `moons[]` have been arrays since p111/p112 (p110 "Definition shape"). The builder currently renders only index 0 and warns about the rest.
- **Why nebulae need a bake.** Live per-pixel nebulae are too expensive:
  - A domain-warped 3D fbm is about 2 × 5 octaves of `mx_noise` per nebula, per pixel.
  - With 2–3 nebulae at 4K, that is about 8.3M pixels × roughly 30 noise evaluations, every frame, just for a backdrop that never changes while the scene runs.
  - Nebulae change only when their params do; they move only by the sidereal rotation, which is a lookup rotation.
  - So they are baked into a cube once per change and sampled with a single cube lookup per pixel.
- **The bake building blocks exist in three.**
  - `CubeRenderTarget` is exported from `three/webgpu` (`Three.WebGPU.js:20`). Its texture is a `CubeTexture` with `isRenderTargetTexture` set (`CubeRenderTarget.js:28-62`).
  - `CubeCamera.update(renderer, scene)` renders the six faces (`CubeCamera.js:178-255`).
  - Pass `type: HalfFloatType` for HDR, because the default is UnsignedByte.
- **Noise functions.** `mx_fractal_noise_float` / `_vec3`, `mx_worley_noise_float` and `mx_noise_vec3` are exported from `three/tsl` (`MaterialXNodes.js:66-108`).

## Design decisions

1. **Static-layer cube bake** (`SkyBox/SkyStaticLayers.ts`).
   - **What gets baked.**
     - One HalfFloat `CubeRenderTarget` per active skybox, with `nebula.resolution` per face (default **512**, option 1024).
     - Nebulae are the only thing baked by default.
     - Optionally, far background stars too (`stars.bakeDistant`): the dense, faint, non-twinkling star layer. The live stars layer then draws only the bright twinkling ones.
   - **How it bakes.** A private scene holds a `backgroundNode` that is the sum of every nebula's emission. A `CubeCamera` renders it with `update()`.
   - **When it bakes.**
     - On activation, and on structural changes.
     - While a slider drags, at most every 150 ms, with a final bake on release.
     - Never per frame.
   - **Memory.** A HalfFloat cube with mipmaps takes about 8.4 MB at 512 and 33.5 MB at 1024. The debugger shows the figure.
   - **Sampling.** The composite samples `cubeTexture(target.texture, siderealRot · dir)` behind the stars.
   - **Environment.** The env bake (p112) samples the same cube, so nebula colours tint PBR reflections.
   - **Disposal.** The target is disposed in `clearSkyBox`. `getPMREMTexture`'s cache is untouched.
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

## Files touched

| File                                                                                                         | Change                                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `src/_engine/core/SkyBox/SkyStaticLayers.ts` (new)                                                           | Cube bake scheduler, target, private scene                    |
| `src/_engine/core/SkyBox/layers/nebula.ts` (new)                                                             | Nebula emission node                                          |
| `src/_engine/core/SkyBox/layers/{sun,moon}.ts`, `SkyLights.ts`, `SkyComposite.ts`                            | Unrolled arrays, per-index lights and roles                   |
| `src/_engine/core/SkyBox/layers/stars.ts`                                                                    | `bakeDistant`, `starBoost` mask                               |
| `src/_engine/core/SkyBox/presets.ts` (new)                                                                   | Preset templates + merge                                      |
| `src/_engine/schemas/skyBoxSchema.ts`                                                                        | `nebulae[]`, `preset`, array limits                           |
| `devTools/gatherAppData.ts`                                                                                  | Build-time preset resolution                                  |
| `src/_engine/core/Debug/SkyBox/_dbg__{Nebula,Suns}Folder.ts` (new), `_dbg__MoonFolder.ts`, `_dbg__SkyBox.ts` | Creator, lists, preset dropdown, `skybox.applyPreset` handler |
| `src/app/skyboxes/space.skybox.json` (new), `src/app/skyShowcase.ts`                                         | SPACE demo, selectable in the showcase scene                  |
| `package.json`, `.claude/CLAUDE.md`                                                                          | Engine minor                                                  |

## Phases

Each phase compiles, lints, and leaves existing skyboxes unchanged.

1. **Static-layer cube bake infrastructure.** Exercised by a single hard-coded test nebula behind a debug-only flag.
   - Verify: the bake runs only on change, the cube is sampled correctly (no seams, correct orientation against a reference equirect), the environment picks up the cube, and memory matches the estimate.
2. **Nebula layer + schema + nebula creator.**
   - Verify: every param behaves, dragging stays responsive (bakes at most every 150 ms), seeds are deterministic across reloads, and nebulae rotate with the sky when day-night is on.
3. **Multiple suns and moons.**
   - Verify: 1–4 suns render with the right colours and optional lights, only `suns[0]` shapes the atmosphere, the shadow-count warning appears, and adding or removing an entry is a single rebuild.
4. **Presets + SPACE demo + docs + version.**
   - Verify:
     - SPACE shows stars, suns and nebulae with no horizon;
     - PBR spheres in the showcase reflect nebula colours;
     - `gatherAppData` emits the resolved preset def;
     - "Apply preset" can be undone.

## Non-goals

- Orbital mechanics for extra suns and moons, planets or ring systems.
- Volumetric or parallax nebulae. Nebulae sit at infinity, like the rest of the sky.
- Live (unbaked) nebula animation. A slow drift is possible later by re-baking on a timer, which this plan doesn't do.
- A galaxy or planet texture generator.

## Risks / open questions

| Risk                                                                   | Mitigation                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nebula bake time at 1024 per face with 8 nebulae (one-time hitch)      | Default 512 with ≤ 3 nebulae in presets. The bake-time readout is shown, and slider bakes are throttled.                                                                                 |
| Cube seams from noise evaluated per face                               | Noise is evaluated on the 3D direction, not face UVs, so it is seamless by construction. Verified in Phase 1.                                                                            |
| Memory of a HalfFloat cube                                             | Shown in the debugger. The resolution is a param, and RGBA8 plus an intensity scale is a fallback if needed.                                                                             |
| Several shadow-casting sky lights                                      | Defaults of one; a warning above two (DD3).                                                                                                                                              |
| Preset changes silently alter JSON-authored skyboxes on engine upgrade | Resolution happens at build time into generated data, and preset templates are versioned in the file header. A change to a preset template is noted in the changelog as a visual change. |

## Verification

- `yarn lint` and `yarn build` after each phase.
- Showcase scene, SPACE and DAY_NIGHT skyboxes via the `run-aekasha-js` skill, on WebGPU and WebGL2, with PostFX on and off (bloom on the suns).
- `renderer.info.memory` is stable over 10 preset switches and 10 scene round trips.
- Production build: the nebula creator is absent from the main chunk. `presets.ts` is present only if runtime code references it; JSON presets are resolved at build time.
