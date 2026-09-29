Status: draft | not-implemented
Category: Skybox, Rendering
Blocked by: p112_procedural-sky-atmosphere-sun-and-env-bake.md
Blocks: p114_space-preset-and-nebula-creator.md (its space layers reuse the stars layer and sidereal rotation)
Related: p110_skybox-refactor-and-layered-sky-system.md (epic; Phase 0 §0.3 re-bake strategy, §0.4 lights)

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
   - Measure what the p110 spike left open: an **iGPU** bake time at 128 and 256 (keep 128 for day-night only if it is clearly cheaper there), and a **whole-frame** cross-check on the dGPU (the stats panel's GPU ms with bakes vs. without, same view), since the spike's per-pass sums were taken on a near-idle GPU.
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
