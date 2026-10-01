Status: implemented
Category: Skybox, Rendering
Blocked by: \_DONE_p112_procedural-sky-atmosphere-sun-and-env-bake.md
Blocks: \_DONE_p114_space-preset-and-nebula-creator.md (its space layers reuse the stars layer and sidereal rotation)
Related: \_DONE_p110_skybox-refactor-and-layered-sky-system.md (epic; Phase 0 §0.3 re-bake strategy, §0.4 lights)

# Night Sky and Day-Night Cycle — Plan

This plan adds the **moon** layer (disc and phases) with its own managed directional light, a procedural **stars** layer, and the **day-night cycle**.

The day-night cycle is a public production API. It animates the sun, moon, stars, sky, clouds and integrated lights. Games drive it; the debugger only calls the same functions. The plan also makes environment re-bakes during animation fit a budget, and adds a showcase scene to the example app.

## Context

- **Built on p112.** The composite builder, the bake scheduler (dirty flag, at most one bake per frame), the managed sun light (`SkyLights.ts`), and the Atmosphere/Sun/Clouds layers.
- **The main loop** (`src/_engine/core/MainLoop.ts`):
  - `delta = dt * playSpeedMultiplier`, only while master play is on (`:180-231`).
  - APP stages run only while the app is playing (`ECS.ts:835`).
  - The only way to read "is the app playing" today is `getReadOnlyLoopState()` (`:465`), which JSON-deep-copies on every call, so it can't be used every frame.
- **Stage and order.** `skyBoxSystem` (p112) runs at MAIN stage with order > 0, before `object3DSyncSystem` (`ECSCoreSystems.ts:134`). That way light transforms written this frame render this frame.
- **Re-bake strategy** is from p110 §0.3: re-bake when the sun or moon has moved more than `env.updateAngleDeg` (1°), capped at `env.maxUpdatesPerSec` (**1/s**, lowered from 4/s by the p110 spike: a bake is ~2 ms of GPU on an RX 7900 XT, whatever the size), and bake once more on pause. `env.size` defaults to 128 when `dayNight.enabled`, kept only as iGPU insurance until Phase 2 measures one.

## Design decisions

1. **Time model** (`SkyBox/SkyTime.ts`). `dayNight` params:
   - `enabled` (structural)
   - `timeOfDay`: hours in `[0, 24)`. This is the start time on activation.
   - `cycleDurationSec`: real seconds per 24 in-game hours, default `1200`.
   - `speed`: a multiplier, default `1`. Negative values reverse time; 0 freezes it.
   - `playing`: whether the cycle runs on activation, default `true`.
   - `timeSource`:
     - `'APP'` (default): advances only while the app is playing, so a game pause pauses the sky. Uses a new cheap `isAppPlaying()` getter in `MainLoop.ts`, returning `loopState.appPlay`.
     - `'MAIN'`: advances with the master loop, and keeps running while the app is paused.
     - `'MANUAL'`: only changes through `setTimeOfDay`.
   - The time step is `timeOfDay = wrap24(timeOfDay + dt · speed · 24 / cycleDurationSec)`. `dt` is the MAIN-stage delta, which already includes `playSpeedMultiplier`. It is plain scalar math, with no allocations.
2. **Celestial model** (CPU only; directions go into module-level `Vector3`s and are copied into uniforms).
   - **Sun.**
     - Declination: `δ = axialTilt · sin(2π (dayOfYear − 81) / 365)`, with `axialTilt` 23.44° by default.
     - Hour angle: `H = 2π (timeOfDay − 12) / 24`.
     - Elevation and azimuth follow the standard `latitude` (default 45°) formula.
     - Mapped into world space with +Y up and north = −Z rotated by `northOffset` (degrees).
   - **Enabled vs disabled.** While `dayNight.enabled`, each sun's `elevation`/`azimuth` are **derived** (shown read-only in the debugger). When it is disabled, the fixed values from p112 apply.
   - **Moon** (`moons[0]`):
     - `phase` in `[0, 1)`: 0 = new, 0.5 = full.
     - `phaseMode: 'FIXED' | 'CYCLE'`. `CYCLE` advances the phase by `1 / lunarCycleDays` (default 29.53) per in-game day.
     - The moon's hour angle is the sun's minus `2π · phase`, plus an `inclination` (default 5°) tilt. So a full moon rises as the sun sets.
     - Illuminated fraction: `(1 − cos 2π·phase) / 2`.
   - **Sidereal rotation.** A `Matrix3` uniform rotates the star and nebula lookup direction about the celestial pole (tilted by `latitude`) by the hour angle plus a sidereal offset. Stars move across the sky with time.
3. **Moon layer** (`layers/moon.ts`).
   - **The disc** is drawn as a small sphere: the in-disc offset is turned into a sphere normal, and the lit side is `max(dot(n, sunDirRelative), 0)`. This gives correct phase and terminator orientation, plus an `earthshine` floor (default 0.02).
   - **Params:** `discSize`, `intensity`, `color`, `limbDarkening`, `texture` (an optional equirect or albedo map projected on the disc sphere, loaded like a base texture), `inclination`, and the phase params from DD2.
   - **In the atmosphere** it is added behind it like the sun (extinction applies). It is left out of ENV_BAKE when its light is enabled, and otherwise becomes a clamped glow (p112 DD2).
   - **Moon light** (`moons[0].light`). Same params and managed-entity pattern as the sun light, with role `MOON_0`. Differences:
     - `intensity` default 0.3;
     - AUTO colour is a cool white (`#b8c6ff`) times the extinction;
     - effective intensity is `intensity · illuminatedFraction · horizonFade · (1 − sunDayFactor)`, so it only matters at night;
     - `castShadow` defaults to `false`: only one shadow-casting sky light by default, with the moon's opt-in. Toggling it is structural, as in p110 §0.4.
   - **Clouds** add moonlight shading at night (p112's cloud lighting, second light term).
4. **Stars layer** (`layers/stars.ts`).
   - **Placement.** Procedural and cube-projected, so there is no pole pinching. The dominant axis picks a face, the face UV is scaled by `gridSize(density)`, and a per-cell PCG hash (`hash` from `three/tsl`) decides whether the cell has a star. Each star gets a jittered position, a brightness from a power distribution, and a colour temperature (a blue → white → orange ramp).
   - **Rendering.** Coverage is `smoothstep` over the angular distance, antialiased with `fwidth`.
   - **Density.** Two cell grids at different scales give density variety.
   - **Params:** `density`, `brightness`, `size`, `colorVariance`, `twinkle` (amount, frequency; a hash-phased `sin(time)`), `fadeRange` (sun elevation in degrees, default `[-4, -12]`: full stars once the sun is 12° below the horizon), `rotateWithSky` (default true).
   - **Milky Way** (optional, `milkyWay.enabled`): an fbm band along a great circle, with `intensity`, `direction` and `width`, using `mx_fractal_noise_float` from `three/tsl`.
   - **Where it composites.** Behind the atmosphere, so extinction dims stars near the horizon and inscatter hides them by day for free. The explicit `fadeRange` saves the cost of the hash where it is invisible: the branch is skipped when the fade uniform is 0.
   - **Not in bakes** (p110 §0.2).
5. **Budgeted re-bakes during animation** (extends p112's scheduler).
   - `skyBoxSystem` keeps `lastBakeSunDir`, `lastBakeMoonDir` and `lastBakeTime` (module-level).
   - While the cycle is advancing, it calls `requestEnvBake()` only when `max(angle(sun), angle(moon)) > updateAngleDeg` **and** `now − lastBakeTime ≥ 1 / maxUpdatesPerSec`.
   - Pausing, scrubbing to a new time or reversing triggers one bake.
   - `env.dynamic: false` turns animated re-bakes off (p110 degrade option 2).
6. **Uniform and light writes per frame.**
   - Only when `timeOfDay` changed: compute the sun and moon directions, the atmosphere's CPU terms (p112 DD3), the fades (stars, moon light, sun light) and the sidereal matrix, then write them with `.value.copy()` / `.value = x`.
   - While paused: one early-out check.
   - This whole path must have **zero allocations**; verify with the `perf-auditor` agent and a DevTools allocation timeline.
7. **Production API** (added to `SkyBox/SkyBox.ts`, all no-ops when there is no active skybox or `dayNight` is off):

   - `setTimeOfDay(hours)`, `getTimeOfDay()`
   - `playDayNight()`, `pauseDayNight()`, `isDayNightPlaying()`
   - `setDayNightSpeed(multiplier)` (negative reverses), `getDayNightSpeed()`
   - `setDayNightCycleDuration(seconds)`
   - `getSunDirection(out, i = 0)`, `getMoonDirection(out, i = 0)`
   - `getSunElevation(i = 0)` (radians), `getMoonPhase(i = 0)`

   Runtime time state lives on `ActiveSkyBox`, not in the def, so a game driving time never writes debug overrides.

8. **Debug "Day-night" folder** (`core/Debug/SkyBox/_dbg__DayNightFolder.ts`) plus Moon and Stars folders.
   - **Transport** (runtime, _not_ persisted or undo-recorded, like the Loop tab's play controls):
     - play/pause;
     - buttons ◀◀ ×−10, ◀ ×−1, ▶ ×1, ▶▶ ×10, ×100;
     - a live speed slider (−100…100);
     - a time-of-day scrub slider (0–24). Dragging pauses the cycle and restores the previous state on release;
     - readouts: `hh:mm`, sun elevation, moon phase, bakes/s.
   - **Config** (persisted as overrides and recorded as `skybox.param`): `enabled`, the start `timeOfDay`, `cycleDurationSec`, the default `speed`, `playing`, `timeSource`, `latitude`, `dayOfYear`, `axialTilt`, `northOffset`. A "Use current time as start time" button records one `skybox.param`.
9. **Showcase scene** (app): `src/app/skyShowcase.scene.json` + `skyShowcase.ts`.
   - Contents: a ground plane, a row of PBR spheres (roughness 0→1, metal and dielectric), shadow casters, and a `DAY_NIGHT` skybox with atmosphere, sun + light, moon + light, stars, clouds and ground.
   - Registered like the other app scenes.
   - It is the verification scene for p113–p115.

## Files touched

| File                                                                                                      | Change                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/_engine/core/SkyBox/SkyTime.ts` (new)                                                                | Time model, celestial directions, sidereal matrix                                        |
| `src/_engine/core/SkyBox/layers/{moon,stars}.ts` (new)                                                    | Layers                                                                                   |
| `src/_engine/core/SkyBox/SkyLights.ts`                                                                    | Moon light; night fades                                                                  |
| `src/_engine/core/SkyBox/SkyEnvironment.ts`, `SkyBox.ts`                                                  | Animated re-bake rules; production API; `skyBoxSystem` time step                         |
| `src/_engine/core/SkyBox/layers/clouds.ts`                                                                | Moonlight term                                                                           |
| `src/_engine/schemas/skyBoxSchema.ts`                                                                     | `moons[]`, `stars`, `dayNight`                                                           |
| `src/_engine/core/MainLoop.ts`                                                                            | `isAppPlaying()` getter                                                                  |
| `src/_engine/core/Debug/SkyBox/_dbg__{DayNight,Moon,MoonLight,Stars}Folder.ts` (new)                      | Folders                                                                                  |
| `src/app/skyShowcase.scene.json`, `src/app/skyShowcase.ts`, `src/app/skyboxes/dayNight.skybox.json` (new) | Showcase                                                                                 |
| `package.json`, `.claude/CLAUDE.md`                                                                       | Engine minor + app minor; a CLAUDE.md line on the day-night API and the stage it runs in |

## Phases

Each phase compiles, lints, and leaves existing skyboxes unchanged.

1. **Time model + production API + `isAppPlaying()`.**
   - It drives only the sun (p112's disc and light) and the atmosphere.
   - It uses the p112 per-change bake, deliberately without throttling, to measure the worst case.
   - Verify: `setTimeOfDay` from the console moves the sun, sky and shadows. Speed, reverse and pause behave as specified, and `timeSource` APP pauses with the app pause.
2. **Budgeted re-bakes.** Angle and rate rules, a final bake on pause, and `env.dynamic`.
   - Verify: bakes/s stays ≤ the cap at ×100, and ~0.3 bakes/s at ×1. Frame time shows no periodic spikes above the budget recorded in p110.
   - Measure what the p110 spike left open: an **iGPU** bake time at 128, 256 and 512 (keep 128 for day-night only if it is clearly cheaper there), and a **whole-frame** cross-check on the dGPU (the stats panel's GPU ms with bakes vs. without, same view), since the spike's per-pass sums were taken on a near-idle GPU. p112's "Re-bake every frame" toggle (Environment → Env bake) gives the worst case, and "Force composite path" lets a texture-only skybox be measured against its direct path.
   - Once those numbers are in "Implementation notes", **remove both toggles**: `_setSkyCompositeForced` / `_isSkyCompositeForced` and `isCompositeForced` in `SkyBox/SkyBox.ts`, `setContinuousEnvBake` / `isContinuousEnvBake` in `Debug/SkyBox/_dbg__EnvBakeStats.ts`, and their bindings in `_dbg__EnvironmentFolder.ts`. The bake stats (count, CPU/GPU ms) and "Re-bake now" stay.
3. **Moon + moon light.**
   - Verify: phases 0, 0.25, 0.5, 0.75 look right, with the terminator facing the sun. A full moon rises at sunset. Moon light only at night; no recompiles across the day/night switch.
4. **Stars (+ Milky Way).**
   - Verify: no pole pinching (look straight up), stars rotate with the sky, twinkle is subtle, and stars fade in through twilight. No cost when faded out (compare frame time by day, with stars enabled and disabled).
5. **Debug folders + showcase scene.**
   - Transport and config folders, and the showcase scene.
   - Verify: all transport controls work, and scrubbing doesn't record undo. Config params undo, redo and persist. Run the `perf-auditor` agent on `SkyTime.ts` / `SkyLights.ts` / the `skyBoxSystem` path.
6. **Docs + version.** CLAUDE.md, the version bumps, and "Implementation notes".

## Non-goals

- Day-night events or callbacks (p110 Non-goals). Games poll `getTimeOfDay()` / `getSunElevation()`.
- Real astronomical accuracy (ephemerides, equation of time, refraction). The model is plausible, not exact.
- Seasons that change anything but the sun path (no snow or foliage).
- Auto-exposure for night (p110 Non-goals). Night brightness is tuned by `atmosphere.nightSkyColor`, the star and moon intensities, and the Renderer exposure.
- Multiple moons (`moons[1]`) and nebulae (p114).

## Risks / open questions

| Risk                                                                            | Mitigation                                                                                                             |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Periodic bake spikes read as stutter at high speed                              | Rate cap (1/s); `env.dynamic: false` as the escape hatch. Size barely helps (p110 spike). Measure in Phase 2.          |
| Night looks black with ACES at exposure 0.7                                     | `nightSkyColor`, moon light and star brightness defaults are tuned in the showcase. Document the recommended settings. |
| Stars shimmer or alias at low resolution or in motion                           | `fwidth` antialiasing, a minimum angular size of ~1 px, and twinkle kept low. Checked at pixel ratios 1 and 2.         |
| `timeSource: 'APP'` surprises users (time stops in the debugger's pause)        | That is the default because game time should pause. The debug folder shows the source, and `'MAIN'` is one click away. |
| Shadow direction flips abruptly when the sun sets and the moon light takes over | Separate fades per light, no shared light. The moon's shadow is off by default.                                        |

## Verification

- `yarn lint` and `yarn build` after each phase.
- The showcase scene, via the `run-aekasha-js` skill:
  - a full cycle at ×100, with screenshots at 06:00, 12:00, 18:30, 00:00;
  - on WebGPU and WebGL2, with PostFX on and off (bloom on the sun and moon).
- `perf-auditor` pass plus a DevTools allocation timeline: no allocations per frame while the cycle is playing.
- A scene switch during the cycle leaves nothing behind: lights, render targets and generators (`renderer.info.memory`, ECS entity count).
- Production build: the `SkyTime` and layers are present, and the debug folders are absent from the main chunk.

## Implementation notes

Where the implementation differs from the plan above (2026-09-30). The code is the current state; these are the reasons.

### Phase 1: time model and API

- **The time step uses the change in `getElapsedTime()`, not the MAIN-stage `dt`.** After a master pause, the first MAIN `delta` spans the whole pause, and the frame that pauses still runs with the old one. The elapsed time discards both, so a pause never jumps the sky forward.
- **The per-frame path has its own writes.** The existing `apply*Uniforms` and light writes allocate (`toSkyColor` creates a `Color` on every call, and the sun light rewrites its shadow camera). Each layer and light is split into a settings write and a sun-dependent write (`applyAtmosphereSunUniforms`, `applySunLightingUniforms`, `applyCloudsSunUniforms`, `applyGroundSunUniforms`, `updateSkyLightsForSun`), and the day-night step (`applySkyTimeUniforms`) calls only the sun-dependent ones.
- **`layers/sun.ts`'s `getSunDirection` is now `getFixedSunDirection`**, so the public `getSunDirection(out, i)` in `SkyBox.ts` could take the name.
- **The getters work with day-night off.** `getSunDirection` and `getSunElevation` return the fixed sun; the setters are no-ops and `getTimeOfDay`/`getDayNightSpeed` return null.
- **Smaller decisions:**
  - `dayOfYear` defaults to 172 (the June solstice, from p110's example definition).
  - Time stands still while a scene loads, so a scene starts at its start time.
  - A structural `updateSkyBox` (a base texture change) keeps the running time; a re-activation starts from the definition.
  - Through `updateSkyBox`, `dayNight.timeOfDay`, `speed`, `playing` and `cycleDurationSec` also set the running cycle's values, and turning day-night on starts it from the definition's.

### Phase 2: budgeted re-bakes

- **Rules.** While the cycle moves, it re-bakes once the sun has turned more than `env.updateAngleDeg` since the last bake (any bake) and at least `1 / env.maxUpdatesPerSec` has passed. When it stops (pause, speed 0, the end of a scrub or a one-off `setTimeOfDay`) or reverses, it bakes once to catch up. `maxUpdatesPerSec: 0` means catch-up bakes only.
- **A `setTimeOfDay` jump while the cycle plays isn't baked at once**: it catches up within the rate cap (up to 1 s of stale reflections), so a game that sets the time every frame can't bake every frame. `bakeEnvironment()` bakes on the next frame.
- **Debug:** the Env bake folder gained a "Bakes/s (10 s)" readout and, with day-night on, the two budget sliders.
- **Measurements** (a powerful desktop dGPU, WebGPU, `scene01V2`'s Day sky with day-night on, `env.size` 128, fixed view):
  - One bake: 2.07 ms GPU on average (last reading 2.22), 0.50 ms CPU. This matches the p110 spike (1.94–2.37 ms).
  - Whole frame (stats panel): 0.33–0.36 ms at night and 0.42–0.44 ms by day without bakes; 2.15–2.32 ms with a bake every frame. A bake adds ~1.8–1.9 ms to a frame, its isolated cost: nothing extra from sharing the frame. This scene's frame is light; a heavy one wasn't measured.
  - At ×100 the rate stays at the 1/s cap: one ~2 ms bump per second, which fits a 16.7 ms frame unless that frame is already near its budget.
  - The stats panel's GPU graph shows a small gap about once a second at ×100. Most likely the timer, not stutter: the bake stats resolve the timestamps once after each bake, and every resolve takes the whole batch, so stats-gl misses that frame (see the header of `_dbg__GPUTimer.ts`). With a bake every frame the graph is steady.
  - **No iGPU was measured.** `env.size` stays 128 with day-night, as p110's insurance, until one is.
- **The p112 measuring toggles are removed** ("Force composite path", "Re-bake every frame"), as planned. The bake stats and "Re-bake now" stay.

### Phase 3: moon and moon light

- **Without day-night, the moon has its own `elevation`/`azimuth`** (defaults 30° and 0, as the sun's convention). The plan only places it from the time; a static night sky still needs a moon.
- **The disc's lit direction is the moon's direction turned toward the sun by the phase's elongation, folded into [0, π]** (the short way). Any phase then shows as given, with the lit side toward the sun, in both modes; unfolded, 0.75 was lit on the side away from the sun. The lit fraction is the plan's `(1 − cos 2π·phase) / 2`.
- **Declination:** `(axialTilt + inclination) · sin(λ_sun + 2π·phase)`, the orbit's node fixed where the tilts add. A full moon runs low in summer and high in winter. At the June solstice, 45° N, it rises between 20:00 and 20:30 as the sun sets.
- **No branch in the disc shader.** `fwidth` and the texture sample need uniform control flow on WebGPU, so the disc is computed for every sky pixel and masked; it's a few dot products.
- **The AUTO moonlight colour uses the extinction relative to the zenith's** (`computeRelativeExtinction`): `#b8c6ff` overhead, warmer toward the horizon. The absolute extinction, normalized as the sun's, is warm even at the zenith, so the colour never showed.
- **The clouds' moonlight** is `0.06 × moon intensity × lit fraction`, faded below the horizon and by day, in the moonlight colour. Tune it with the showcase in Phase 5.
- **Sun and moon lights share one code path** (`DiscKind` in `SkyLights.ts`), and the Sun and Moon folders share one light folder (`_dbg__DiscLightFolder.ts`, instead of a separate `_dbg__MoonLightFolder.ts`). The Moon folder came in this phase, with its layer, as p112 did per layer.
- **A moon texture** (`moons[0].texture`, 'DISC' or 'EQUIRECTANGULAR') loads with the base texture; changing it re-activates the sky box. `getSceneSkyBoxTextureIds` includes its `textureId`.
- **Checked:** phases 0, 0.25, 0.5 and 0.75; the moon light 0 by day and `0.3 × lit fraction` at night; the pipeline count stable (20) across the day/night switch; the texture's orientation (a UV checker, both projections).
- **Debug-only artifact:** the Lights debug tooling draws a `DirectionalLightSymbol` icon at each directional light. The sky lights sit 100 units along their direction from the camera, so the icon covers the moon (and the sun) disc in debug mode. It predates p113 for the sun.

### Phase 4: stars

- **Sidereal rotation.** The stars sit still in their own frame; `computeSkyRotation` turns it into world space by the local sidereal time, the sun's hour angle plus its longitude (the plan's "hour angle plus a sidereal offset"). It shares its latitude and north mapping with the sun (`hourFrameToWorld`), so a star where the sun is stays with the sun at every time (checked numerically), and the pole stands at the latitude. Without day-night, or with `rotateWithSky: false`, the rotation is identity.
- **Pixel size from `fwidth` of the direction, not of the star distance.** The distance jumps at cell edges, and its `fwidth` would have drawn the grid's lines.
- **The day skip is a branch on the fade uniform.** A uniform condition is uniform control flow on WebGPU, so `fwidth` is legal inside it. By day, stars on cost nothing measurable (1.9 fps off vs 2.1 on, faded out, in software rendering).
- **Tuned density:** at density 0.5 the coarse grid has about one star per 5.5 square degrees (the naked-eye sky's), plus ~3× as many faint fine-grid stars; ~8% of stars are over 0.5 radiance. The first defaults (3× denser, 31% over 0.1) looked like snow.
- **Twinkle and the Milky Way are objects** (`twinkle: { amount, frequency }`, `milkyWay: { enabled, intensity, direction, width }`), as DD4 lists; p110's example had `twinkle` as a number. **`seed`** was added for another pattern. The debug folder has no binding for `milkyWay.direction` (a 3-tuple).
- **The moon disc now hides what's behind it** (stars, the base), including its unlit side: `behind · (1 − mask) + moon`.
- **Not checked here:** twinkle in motion, and pixel ratio 2. Only stills at pixel ratio 1 were taken (software rendering).

### Phase 5: debug folders and the showcase

- **The Day-night folder** (`_dbg__DayNightFolder.ts`) has a Transport subfolder (runtime: never an override, never undo) and a Config subfolder (overrides, `skybox.param`). It only calls the public API. The speed buttons are one row of Tweakpane-styled buttons in a `custom` item (there's no button-grid plugin). The time slider pauses the cycle on the first drag event and resumes a playing one on release (`e.last`).
- **The Sky box tab refreshes every 250 ms while it's visible**, for the readouts and for the Sun and Moon folders' disabled sliders, which show where day-night puts them (and the running moon phase).
- **Config values also set the running cycle** (as in Phase 1): moving the start time moves the time, and undoing "Use current time as start time" jumps back to the old start time.
- **The showcase** (`skyShowcase.scene.json`, `skyShowcase.ts`, `skyboxes/dayNight.skybox.json`, `cameras/skyShowcaseCamera.camera.json`): a static camera looking west over a metal and a dielectric row of spheres (roughness 0 to 1) and a stone gate. It uses `dayOfYear` 100, so the sun sets just north of west, in view; a 5-minute day starting at 17:30; a CYCLE moon at 0.4 with a 0.5 light; and `nightSkyColor: '#0a1020'`, which keeps the night navy rather than black at the renderer's 0.7 exposure. The sky box owns every light.
- **p112's `daySky` demo moved out of `scene01_v2.ts`**, as p112 planned: the showcase replaces it.
- **Checked:** ×100 sets the speed and plays; the drag pauses and resumes and records no undo; latitude undoes, redoes and is stored in `AEK_debugSkyBox`; the debug strings are only in a lazy chunk of the production build.
- **`perf-auditor` pass** (`skyBoxSystem` → `stepDayNight`, `applySkyTimeUniforms` and the layers' per-frame writes, `SkyLights.ts`, `SkyTime.ts`): no allocations on the per-frame path, and the paused early-out is one check. It found the atmosphere, clouds, stars (including the sidereal matrix) and ground terms written every frame even when their layer is off; the per-frame path now skips them (turning a layer on runs `applySkyUniforms`). Left as is: ~12 repeated `sin`/`cos` of the latitude and north offset per frame in `SkyTime.ts`, not worth caching. A DevTools allocation timeline on a real GPU is still to do (Verification).
- **Fixed after review: "Destroyed texture used in a submit" (WebGPU), on every frame.** Three (r186) gives a render target texture that's sampled before anything renders into it a placeholder GPU texture, and the first render's target setup destroys that one in place (`Textures.updateTexture`), without invalidating the bind groups that sample it. It hit a sky box shown while a scene loads, the scene loader's way (bakes wait for the load to end, and PBR materials sample the target meanwhile; the gym's non-PBR materials don't), and a sky light created with its disc down (`shadow.autoUpdate` off until it rises: the VSM shadow map, RG16Float). New bake targets are now cleared once on allocation (`initEnvBakeTarget` in `SkyEnvironment.ts`), and a new shadow-casting sky light renders its map once (`shadow.needsUpdate`). Checked in WebGL by counting in-place destroys of the bake texture: one per load-time activation before, none after.
- **Fixed after review: a flat, single-colour sky by day.** With a COLOR base, the stars were the first layer to use the view direction, and built it inside their `If (fade > 0)` branch. TSL caches a node's value where it's first built, so once the branch was skipped (the sun above `fadeRange[0]`), every later layer read an unassigned direction: a sudden flat red at dawn, white at noon, red at dusk. `starsNode` now builds its lookup direction before the branch. A branch in a layer must not be the first to build a node other layers share. (The Phase 5 review first blamed p112's atmosphere for these colours; it was this.)

### Phase 6: docs and versions

- **No new version bumps.** This branch (skybox-overhaul) already bumps the engine to 3.0.0 (major, p111) and the app to 1.3.0 (minor); one bump per branch at its biggest level covers p113's engine minor and app minor. `yarn checkVersions --against main` passes. The branch's CHANGELOG entry gained p113's additions, and its `daySky` line became the showcase.
- **Still to check on real hardware** (Verification): a DevTools allocation timeline while the cycle plays, WebGL2 in a real browser, PostFX with bloom on the sun and moon, twinkle in motion and pixel ratio 2, and `renderer.info.memory` over a scene switch mid-cycle.
