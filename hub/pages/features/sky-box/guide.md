## A definition

A sky box is a `*.skybox.json` (or the same object in code). A `preset` is the starting point,
and the definition's own keys go over it:

<<< src/app/skyboxes/space.skybox.json

The presets are `DAY_SKY`, `NIGHT_SKY`, `DAY_NIGHT` and `SPACE`. The definition is merged over
its preset: a list (the suns here) and `base` replace the preset's whole, other keys merge into
it. A scene lists its sky boxes in its JSON's `skyboxes`, and the first one (or the last one
marked `isDefault`) shows when the scene starts.

## The layers

Each layer is on when its key is there, unless it has `enabled: false`:

| Layer          | What it is                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `base`         | A colour, an equirectangular panorama (HDR too) or a cube map, with its rotation and intensity. |
| `env`          | How the sky lights the scene: background blur and intensity, environment intensity, bake size.  |
| `atmosphere`   | A physically based sky, lit by the first sun.                                                   |
| `suns`         | Up to four, each a disc and a halo. A sun's `light` is a directional light, casting shadows.    |
| `moons`        | Up to two, lit into their phase, with an optional texture and a light of their own at night.    |
| `stars`        | Procedural stars and an optional Milky Way, fading out by day.                                  |
| `nebulae`      | Up to eight, baked once into a cube, since they're costly per pixel.                            |
| `clouds`       | Clouds in the atmosphere, moonlit at night.                                                     |
| `ground`       | A ground below the horizon.                                                                     |
| `ambientLight` | An ambient light following the sky.                                                             |
| `dayNight`     | Places the suns and moons from a time of day, and moves it.                                     |

A sky with only a `base` is drawn straight from its texture. One with procedural layers is drawn
as one combined node, and baked into the environment map that lights the scene. While the
day-night time moves, it bakes again once the sun or a moon has turned a degree, at most once a
second (`env.updateAngleDeg`, `env.maxUpdatesPerSec`).

## Day and night

With `dayNight`, the sky keeps a running time of day. Your game drives it:

- [`setTimeOfDay`](api:setTimeOfDay) and [`getTimeOfDay`](api:getTimeOfDay): hours, from 0 up
  to 24.
- [`playDayNight`](api:playDayNight), [`pauseDayNight`](api:pauseDayNight) and
  [`setDayNightSpeed`](api:setDayNightSpeed), or [`setDayNightCycleDuration`](api:setDayNightCycleDuration)
  for the length of a whole day.
- [`getSunDirection`](api:getSunDirection), [`getSunElevation`](api:getSunElevation),
  [`getMoonDirection`](api:getMoonDirection) and [`getMoonPhase`](api:getMoonPhase): for game
  logic that follows the sky (street lights at dusk).

By default the time stops when the app is paused (`dayNight.timeSource: "APP"`). `MAIN` keeps it
going, and `MANUAL` moves it only when you set it. It stands still while a scene loads.

## Sky lights

A sun's or a moon's `light` is an ordinary ECS light that the sky box manages: it's created when
the sky box shows and deleted when it goes, and the debugger shows it read-only. The sun's light
follows the camera with its shadows and fades out below the horizon. Read the ids with
[`getSkyLightIds`](api:getSkyLightIds) to react to them, and
[`onSkyBoxChange`](api:onSkyBoxChange) when the sky box changes.

## From code

- [`createSkyBox`](api:createSkyBox): registers a definition and shows it.
- [`setActiveSkyBox`](api:setActiveSkyBox): shows another of the scene's sky boxes, or none.
- [`updateSkyBox`](api:updateSkyBox): changes part of the active one. A value change is cheap; a
  change to the set of layers rebuilds the sky.
- [`bakeEnvironment`](api:bakeEnvironment): bakes the environment again now.

## The debug tab

The drawer's Sky box tab has a folder per layer: every value is live, undoable and kept per
browser as an override of the definition. "Apply preset" tries another preset over it, and the
day-night folder plays and scrubs the running time.

## Read more

- The [sky box example](hub:examples/sky-box).
- The app's `skyShowcase` scene has every layer on a five-minute day, and `space` the `SPACE`
  preset with asteroids: open them with `?isDebug=true&startScene=skyShowcase` or `space`.
- The API reference: [SkyBox](hub:documentation/engine/core/SkyBox).

::: claude-md
:::
