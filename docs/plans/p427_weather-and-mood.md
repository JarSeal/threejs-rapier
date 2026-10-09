Status: stub — not-implemented
Category: Weather, Rendering, Gameplay
Related: \_DONE_p603_gameplay-architecture-contracts.md (C7: weather and mood, the time-of-day clock), p307_wet-and-dry-surface-states.md (its surface conditions state is what this plan drives), p615_review-sky-box.md (the sky box reads the clock from here once it moves), p425_game-events-missions-and-save-games.md (the world state is saved), p990_follow-ups-from-done-plans.md (volumetric clouds and weather)

# Weather and Mood — Stub

**This is a stub.** p603 left weather and mood as a direction (C7). This plan decides the world
state and moves the time-of-day clock into it.

## Goal

One world state (wetness and rain, snow, wind, fog, the time of day, a mood or colour grade), owned
by a weather system and read by the sky box, materials (p307), PostFX and audio, with transitions
between weather presets.

## The direction it starts from (p603 C7)

- **The time-of-day clock leaves the sky box.** Gameplay (NPC schedules, missions, saves) needs it
  without an active sky box, which today resets it on every activation, and it advances by frame
  time (`getElapsedTime()`), not by step. This plan moves it into the world state, advanced by the
  step clock, and the sky box reads it.
- Until then the clock stays the sky box's day-night cycle (`ActiveSkyBox.time`, `setTimeOfDay` /
  `getTimeOfDay` in `SkyBox/SkyBox.ts`), and the world state reads it there.

## Grounding (2026-10-09)

- **p307 already defines the materials' half:** an engine-level surface conditions state (wetness,
  rain, puddle level, water level, snow coverage) with a drying model, and says a later weather plan
  should drive that state rather than replace it. So this plan drives p307's state; it doesn't own
  a second copy of wetness.
- No fog (`scene.fog` / fog nodes) and no audio in the engine.
- PostFX passes are TSL files with `params` (`schemas/postFxSchema.ts`); there is no colour grade
  or LUT pass. A mood drives a pass's params.
- The sky box's clouds are a layer of the composite (`clouds`, needing the atmosphere), with
  `coverage`, `speed` and `windDirection` in its definition: the cover and wind a weather state
  would drive.
- p990's deferred sky ideas list volumetric clouds, a weather driver and day-night events
  (`onSunrise` / `onSunset`); the last would be game events (p425) fired from the clock.

## Open questions

1. **Clock ownership in practice:** what `dayNight.timeSource` (`APP` / `MAIN` / `MANUAL`) becomes,
   and how the sky box's debug Transport drives the world clock.
2. **Presets and transitions:** weather presets as data (`*.weather.json`), blended over time; a
   transition's curves per value.
3. **Fog:** height and distance fog as nodes the materials share, and its cost with impostors and
   PostFX.
4. **Wind:** one vector for foliage (p308), clouds, particles and maybe physics (forces on light
   bodies), and its gusts.
5. **Determinism:** weather that changes gameplay (wet friction, p307 T14) changes by the step clock
   and the seeded RNG; purely visual weather can run at frame time.
6. **Regional weather:** one global state, or zones (spatial domains) blended around the camera.
