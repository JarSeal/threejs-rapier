Status: draft | study + not-implemented
Category: Materials, Terrain, Weather
Blocked by: p305_terrain-material-generator.md, p306_terrain-blocks-and-procedural-terrain-meshes.md, p304_procedural-texture-baker.md (ripple atlas)
Blocks: p310_terrain-preview-scenes.md
Epic: p301_terrain-texturing-epic.md

# Wet & Dry Surface States

This plan has two halves:

- **A study** of how wet and dry surfaces can be rendered in a real-time WebGPU forward renderer. What each technique costs and what it looks like.
- **An implementation** of the chosen techniques:
  - a global, engine-level **surface conditions** state (wetness, rain, puddle level, water level, snow coverage);
  - a toolkit **wet response** node used by the terrain material generator (p305), structure materials, scatter (p308) and decals (p309).

This plan doesn't add a weather system, rain particles or audio. The surface-conditions state is the part of a future weather system that materials read. p990 lists "volumetric clouds and weather" as a deferred sky idea, so a later weather plan should drive this state rather than replace it.

---

## Context (grounded)

- **No weather, rain, wetness or puddle concept exists** in `src` (p301 survey).
- **No global shared-uniform registry exists.** Sky uniforms are created per activation (`createSkyUniforms`), so a material that binds them goes stale when a sky box re-activates. Surface conditions therefore need **stable uniform nodes created once**, which materials bind at build time.
- **Sky box API** (`core/SkyBox/SkyBox.ts`):
  - `getSunElevation(i)` (radians), `getSunDirection`, `getTimeOfDay`, `isDayNightPlaying`;
  - time advances by `getElapsedTime()` deltas per `dayNight.timeSource` (default `APP`: stops with the app loop).
  - Drying can follow the sun through the getters. There are no events; games poll.
- **Environment reflections:** both the background and the environment sample one PMREM (`SkyEnvironment.ts`). With day-night on, the environment re-bakes every ~1° of sun movement or 1/s at most.
- **No SSR** (p990: "More PostFX passes … SSR"). Puddle reflections are environment reflections only. Outdoors, under the sky, that's the dominant term; reflections of nearby objects are missing.
- **`aoNode`** affects indirect light only.
- **The GTAO pass** multiplies the final colour (p301 survey). Wet darkening and AO stack multiplicatively; that's fine.
- **p305** reserves `wet?: WetConfig` and a `WETNESS` debug view. Layers have `surface.porosity`, `wetDarkening` and `wetRoughness` from their texture set (p303 D1).
- **p304** provides `rippleAtlas` (4×4 cells of expanding rings: RG normal, B mask, A time offset) and `macroNoise`.

---

## Part 1 — Study

### S1 — What actually happens to a wet surface

Based on Lagarde, "Water drop 2a/2b" (2012–2013), and the BRDF measurements it cites:

1. **Porous materials** (sand, soil, mud, concrete, rough stone) soak up water first.
   - Water filling the pores lowers the refractive-index contrast inside the material, so light scatters deeper and more of it is absorbed. The **diffuse albedo darkens**: strongly for porous materials, barely for dense stone.
   - Roughness falls only a little in this stage.
2. **When the pores are full, a water film forms** on top.
   - The film is smooth, so **roughness drops toward water's** (≈ 0.02–0.1).
   - The **film flattens the normal** (small bumps are filled), so detail normals fade under it.
   - Water's F0 (≈ 0.02) is close to typical dielectric F0 (0.04), so **specular colour barely changes**. What changes is the gloss.
3. **Puddles** form where water collects: low points of the micro-relief (between pebbles, in tyre ruts) and low, flat areas of the macro shape.
   - A puddle is a water surface: roughness ≈ 0.01–0.05, normal = the geometry normal (flat), plus rain ripples.
   - The ground below is darker and slightly visible.
4. **Non-porous materials** (ice, polished stone, metal, glossy plastic) skip stage 1 and get the film straight away. Ice is the extreme: melting makes it a mirror.
5. **Drying runs the other way:**
   - film first;
   - then pores;
   - exposed high points and sun-facing or wind-exposed surfaces first;
   - cavities, shade and porous dense soils last.
   - Sand dries visibly fast at the surface; mud stays wet for a long time.
6. **Rain exposure:** surfaces facing the sky get wet; overhangs and the undersides of rocks stay dry. Vertical surfaces don't collect puddles; they show **streaks and drips** running down.
7. **Snow-melt and slush:** melting snow darkens, turns greyish and translucent, roughness drops, and meltwater wets what's around it.

### S2 — Technique catalogue

| #   | Technique                                                                                                                                                        | What it models           | Cost                                                               | Verdict                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| T1  | **Porosity darkening + roughness lerp** (two-stage: pores then film)                                                                                             | S1.1–2, S1.4             | ~10–15 ALU, no fetches                                             | **Implement**: the core of everything                                                                      |
| T2  | **Height-driven wetness distribution** (cavities wet first, peaks dry first) using the blended layer height (p305) + AO                                          | S1.3, S1.5               | ~5 ALU (height already sampled)                                    | **Implement**                                                                                              |
| T3  | **Puddles from height + macro mask** (`puddleLevel` vs combined height, macro-noise patches, a flat-slope gate, regional vertex attribute)                       | S1.3                     | ~10 ALU + optional `macroNoise` (already sampled when macro is on) | **Implement**                                                                                              |
| T4  | **Rain ripples** from the ripple atlas (2 time-offset samples, only in film/puddle areas, branch-gated on rain > 0)                                              | S1.3                     | 0–2 fetches                                                        | **Implement**                                                                                              |
| T5  | **Streaks / drips** on steep faces (scrolling along −Y with a streak noise; wetness runs down)                                                                   | S1.6                     | 1 fetch on steep pixels only (slope-gated `If`)                    | **Implement** for cliffs and structures                                                                    |
| T6  | **Sky exposure from the normal** (`normalWorld.y` gate: overhangs and undersides stay dry)                                                                       | S1.6                     | ~3 ALU                                                             | **Implement**                                                                                              |
| T7  | **Regional wetness attribute** (`_WETNESS` vertex attribute or a splat channel: riverbanks, swamps, permanently wet zones)                                       | Authored wetness         | 0 fetches (vertex)                                                 | **Implement**                                                                                              |
| T8  | **Shoreline band** (wet sand above `waterLevel`, noisy edge, optional run-up animation)                                                                          | Beaches, lakes           | ~8 ALU                                                             | **Implement**                                                                                              |
| T9  | **Drying model** in the state: rise with rain, decay by drying rate × sun factor (from `getSunElevation`) × per-layer drying speed                               | S1.5                     | CPU only                                                           | **Implement**                                                                                              |
| T10 | **Snow coverage** (dynamic snow over any layer: normal-up and height-noise mask, blended to a snow set; melting raises wetness)                                  | S1.7                     | +1 set sample (P fetches) where coverage > 0, branch-gated         | **Implement** (Phase 5)                                                                                    |
| T11 | **Frost** on ice and rock (roughness up, slight white, sparkle)                                                                                                  | Cold dry state           | ~5 ALU                                                             | Implement with T10                                                                                         |
| T12 | **Rain occlusion map**: an orthographic depth render from above around the camera, every N frames; a surface below an occluder stays dry (roofs, trees, bridges) | S1.6 for structures      | 1 fetch + a depth render (~0.2–0.5 ms per update)                  | **Optional** (Phase 6). T6 + T7 cover open terrain                                                         |
| T13 | Screen-space reflections in puddles                                                                                                                              | Nearby objects reflected | A PostFX pass (several ms)                                         | **Not here**: environment reflections only; SSR is a p990 PostFX follow-up                                 |
| T14 | Wetness-dependent physics friction                                                                                                                               | Gameplay                 | —                                                                  | **Not here**. Note it for a future surface-material query (`getSurfaceAt(x, z)` → layer weights + wetness) |
| T15 | Footprints / wet trails                                                                                                                                          | Interaction              | Decals                                                             | Via p309's runtime decals (a wet-footprint decal), not a material feature                                  |

### S3 — Per-category response defaults (written into p303's set `surface`)

| Category       | porosity | wetDarkening | wetRoughness (pores) | puddleResponse | dryingSpeed | Notes                                                                                     |
| -------------- | -------- | ------------ | -------------------- | -------------- | ----------- | ----------------------------------------------------------------------------------------- |
| SAND           | 0.9      | 0.55         | 0.45                 | 0.3            | 1.6         | Darkens strongly, stays fairly rough until saturated; absorbs puddles; surface dries fast |
| MUD            | 0.7      | 0.6          | 0.15                 | 1.0            | 0.4         | Glossy quickly, puddles everywhere low, dries slowly                                      |
| ROCKS (gravel) | 0.4      | 0.35         | 0.2                  | 0.6            | 1.0         | Puddles between stones (height-driven)                                                    |
| CLIFF          | 0.2      | 0.25         | 0.15                 | 0.0            | 1.2         | No puddles (steep); streaks                                                               |
| SNOW           | 0.5      | 0.25         | 0.3                  | 0.5            | 0.6         | Wet = slush: + grey-blue tint, slight translucency look via albedo                        |
| ICE            | 0.0      | 0.1          | 0.02                 | 1.0            | 1.0         | Film straight away; a mirror when melting                                                 |
| GRASS (ground) | 0.6      | 0.35         | 0.35                 | 0.2            | 0.8         | Vegetation sheds water; stays rough                                                       |
| CONCRETE       | 0.5      | 0.45         | 0.15                 | 0.7            | 0.9         | Puddles in low spots; streaks on walls                                                    |

These are starting values, tuned by eye in the gallery's wet row (Phase 2). p303's `surface` schema gains `puddleResponse` and `dryingSpeed` (optional, category defaults).

### S4 — How it composes (per pixel, after p305's layer accumulation)

```
exposure   = T6 (normal-up) × (1 − rainOcclusion [T12 optional])
wetGlobal  = conditions.wetness × exposure
wetLocal   = saturate(wetGlobal·(1 + k₁) − heightN·k₂ + cavity·k₃ + regional[T7] + shoreline[T8])   // T2
pores      = saturate(wetLocal·2)               // stage 1
film       = saturate(wetLocal·2 − 1)           // stage 2
albedo    *= mix(1, 1 − wetDarkening·porosity, pores)          // T1 (weighted per layer)
roughness  = mix(roughness, wetRoughness, pores); roughness = mix(roughness, 0.05, film)
normal     = mix(normal, geometryNormal, film)
puddle     = smoothstep(edge, puddleLevel·puddleResponse − heightN, …) × flatGate × macroPatch   // T3
→ puddle: roughness 0.02, normal = geometry normal (+ ripples T4), albedo *= 0.85
streaks    = steep ? scroll(streakNoise, time)·wetGlobal : 0    // T5
snow       = coverage mask → blend to the snow set; melting → wetness += melt                   // T10
```

- Per-layer values (porosity, darkening, wetRoughness, puddleResponse) are **weight-blended** like the other layer outputs. A beach blends sand's response with rock's.
- Height is the normalized combined height from p305's height blend, so puddles settle between pebbles and in ruts.

---

## Part 2 — Implementation

### D1 — Surface conditions state (engine: `core/SurfaceConditions.ts`)

**Why the engine:**

- It's global environment state, read by any material (terrain, structures, props, characters later) and in future by fog, particles, audio and physics.
- Its uniforms must be stable for the app's lifetime.

```ts
type SurfaceConditions = {
  wetness: number; // 0..1 current
  rain: number; // 0..1 intensity (drives wetness rise and ripples)
  puddleLevel: number; // 0..1 how full puddles are (follows wetness with lag)
  waterLevel: number; // world Y for shoreline effects (−Infinity = off)
  snowCoverage: number; // 0..1
  temperature: number; // °C, melting/freezing thresholds
  dryingRate: number; // base wetness decay per minute
  wind: [number, number]; // xz, streak bend and drying
  mode: 'SIMULATED' | 'MANUAL';
};
```

- **`getSurfaceConditionNodes()`** returns uniform nodes created **once**, plus `surfaceTime` (seconds, from `getElapsedTime()` deltas; `timeSource` `APP` | `MAIN` like day-night, so pausing the app loop freezes ripples).
- **Setters:**
  - `setSurfaceConditions(partial, { transitionSec? })` (smooth transitions);
  - `getSurfaceConditions()`;
  - `startRain(intensity, { rampSec })`, `stopRain({ rampSec })`.
- **`surfaceConditionsSystem`** (MAIN, after `skyBoxSystem`), in `SIMULATED` mode:

  - `wetness` rises with `rain` (rate scaled by intensity);
  - `wetness` decays with `dryingRate × sunFactor × windFactor`, where `sunFactor = clamp(sin(getSunElevation(0)), 0.2, 1)` when a day-night sky is active, else 1;
  - `puddleLevel` lags `wetness` (fills slower, drains slower);
  - `snowCoverage` melts above 0 °C into wetness.

  `MANUAL` leaves all values to the app.

- **Per scene:**
  - the scene schema gets an optional `surfaceConditions` object (initial values);
  - `SceneLoader` resets the state on scene enter;
  - the state never runs while a scene loads (same rule as the sky).
- **Allocation:** none per frame; values are written into the stable uniforms.
- **Debug tab "Surface conditions"** (`core/Debug/_dbg__SurfaceConditions.ts`, dynamic import, droplet icon):
  - runtime sliders, with no overrides, no undo and no LS, like the sky box's day-night Transport;
  - buttons: Rain shower (ramp up 10 s, hold 60 s, stop), Dry now, Soak, Snowfall;
  - a graph-free readout of the simulated values (250 ms refresh while visible).

### D2 — Wet response nodes (toolkit: `src/toolkit/terrain/nodes/wet.ts`)

- **`applySurfaceWetness(surface, ctx, config)`:**
  - takes `{ albedo, roughness, normalWorld, height, cavity, response: { porosity, wetDarkening, wetRoughness, puddleResponse } }`;
  - returns the modified surface and the masks (`pores`, `film`, `puddle`, `streak`, `snow`) for debug views.
- **Used by:**
  - p305's generator (`wet` config, below);
  - structure materials;
  - p308's scatter rock material;
  - p309's decal material;
  - any app TSL material (exported, documented).
- **`WetConfig`** (p305's reserved `wet` key):
  ```ts
  wet?: {
    puddles?: { maxSlope?: number; macroPatchScale?: number; edgeSoftness?: number };
    ripples?: boolean;                        // needs rippleAtlas
    streaks?: { minSlope?: number; scale?: number };
    shoreline?: { band: number; noise?: number; runUp?: boolean };
    regional?: { attribute: '_WETNESS' } | { splatChannel: 'A' };
    snow?: { set: string; minUpDot?: number; noiseScale?: number };
    rainOcclusion?: 'NORMAL_Y' | 'MAP';       // MAP = T12 (Phase 6)
    quality?: 'FULL' | 'SIMPLE';              // SIMPLE = T1 + T6 only (LOW tier)
  };
  ```
- Each sub-feature compiles only when present. The ripple, streak and snow fetches sit in `If` branches on their masks and uniforms. Shared coordinates are built before the branches (TSL `If` trap, p305 D5).

### D3 — Defaults and data

- p303's `surface` gains `puddleResponse` and `dryingSpeed`. Category defaults come from S3; the library's 16 sets get tuned values.
- **`dryingSpeed`** (per layer, weighted) shifts the local wetness threshold, so sand pixels dry before mud pixels under the same global wetness. One global state, visually varied drying.
- **Regional wetness:** the Blender workflow (p306) documents painting `_WETNESS` (a float attribute through Geometry Nodes _Store Named Attribute_, or a second colour attribute converted) and the splat-alpha alternative.

---

## Phases

### Phase 1 — State (D1)

1. Module, system, setters, transitions, scene defaults, time source.
2. The debug tab.

**Exit:** a rain shower in the debug tab raises and lowers `wetness` and `puddleLevel` over time; it pauses with F7 (app loop); it resets on scene re-enter.

### Phase 2 — Wet response (T1, T2, T6, T9)

1. `applySurfaceWetness`, p305 integration (`wet` key), weighted per-layer responses, the `WETNESS` debug view.
2. Category defaults (S3), `dryingSpeed`.

**Gallery row "Wet/dry"** (p310 completes it): one 12 m block per category plus a blended beach block, with a global wetness slider.

**Exit:** each category reads as plausibly wet at 0.3 / 0.6 / 1.0 when judged side by side against reference photos (collect 1–2 photo references per category from CC0 sources into the handbook page).

### Phase 3 — Puddles and ripples (T3, T4, T7)

1. Puddle mask from height, macro patches, flat gate, regional attribute.
2. Ripples (`rippleAtlas`).

**Exit:** on `mud02` and the `rocks01` gravel, puddles fill the low points first and ripple only while it rains. Frames without rain sample no ripples (verify with the `TAPS` view).

### Phase 4 — Streaks, shoreline (T5, T8)

**Exit:** cliffs and concrete walls streak downward during rain and fade after; a beach block shows a wet band that follows `waterLevel`.

### Phase 5 — Snow coverage and frost (T10, T11)

**Exit:**

- `snowCoverage` 0 → 1 covers upward faces first;
- melting (temperature > 0) turns the snow to slush and wets the ground;
- the ice layer frosts below −5 °C.

### Phase 6 (optional) — Rain occlusion map (T12)

1. An orthographic depth render (512², 64 m around the camera, updated every N frames or on camera movement > X), sampled in `wet` when `rainOcclusion: 'MAP'`.

**Exit:** the area under a concrete roof stays dry in rain; the cost measured and recorded.

### Phase 7 — Handbook and versioning

1. **`docs/techniques/wet-dry-surfaces.md`** (page template):
   - the S1 physics in plain words;
   - the technique table with costs (S2);
   - the response table (S3);
   - **how to set up:**
     - per material: the `wet` config;
     - per set: `surface` values;
     - per block: regional wetness painted in Blender, or a splat alpha;
     - per scene: initial conditions in the scene JSON;
     - at runtime: the API, rain showers, tying drying to the day-night cycle;
   - **variations, each with why and cost:**
     - SIMPLE quality for LOW tier;
     - puddles without ripples;
     - wetness-only for top-down (puddle reflections barely read from above);
     - streaks only on structures;
   - **"Best for":**
     - first- and third-person, where gloss and reflections read close-up;
     - weather-driven games (survival, open world, racing on wet tracks);
     - stylized games use SIMPLE (darkening only);
     - top-down/RTS get little from puddles and ripples, so use SIMPLE.
2. **Repo docs:**
   - `readme.md` Features (engine: surface conditions; toolkit: wet response);
   - `CLAUDE.md` gets a short section on surface conditions (stable uniforms, time source, scene reset);
   - **p990:** its deferred "weather" bullet already points here (since 2026-10-02). When this plan lands, update that bullet to say the surface side is done.
3. **Versions:** engine minor, toolkit minor, app minor; `CHANGELOG.md`.

---

## Risks

| Risk                                                                         | Mitigation                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Stable uniforms bound by many materials, then a material is disposed: leaks? | Uniform nodes are plain objects shared by reference; disposing a material doesn't touch them; nothing per material is registered |
| Puddles look like holes without reflections of nearby objects (no SSR)       | Keep puddles mostly in the open (sky reflections dominate); cap puddle darkness; document the SSR follow-up                      |
| Ripple atlas tiling visible                                                  | Two time-offset samples at different scales and rotations; ripples only in puddles and film                                      |
| Cost creep from every sub-feature                                            | Everything compiles out; SIMPLE for LOW; `TAPS` debug view; gallery measurements                                                 |
| `surfaceTime` vs determinism                                                 | Visual only; it follows `getElapsedTime()` deltas and never touches physics                                                      |
