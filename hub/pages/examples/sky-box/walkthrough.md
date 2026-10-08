## The sky box

A sky box is a JSON file like any other asset. This one starts from a preset and sets its day:

<<< src/app/examples/skyBox/exampleSkyBox.skybox.json

- `preset` is a template the definition is merged over: `DAY_SKY`, `NIGHT_SKY`, `DAY_NIGHT` or
  `SPACE`. `DAY_NIGHT` has every layer: atmosphere, a sun and a moon with their lights, stars and
  the Milky Way, clouds and the ground below the horizon.
- `dayNight` places the sun and the moon from a time of day: here it starts at 16:00 and a whole
  day takes 120 seconds.
- Any layer the definition gives wins over the preset's, so `"clouds": { "coverage": 0.8 }`
  would make it overcast.

The scene JSON lists it in `skyboxes`, and a scene shows its default sky box when it loads (the
first one listed, unless another says `isDefault`). There's no `lights` list:

<<< src/app/examples/skyBox/exampleSkyBox.scene.json

## The scene

<<< src/app/examples/skyBox/exampleSkyBox.ts#sky-objects

The two balls show the environment: the mirror ball reflects the sky, and the matte one takes its
colour from it, blurred. Both change with the time of day.

## Controlling the day

<<< src/app/examples/skyBox/exampleSkyBox.ts#sky-controls

- [`setTimeOfDay`](api:setTimeOfDay), [`playDayNight`](api:playDayNight),
  [`pauseDayNight`](api:pauseDayNight) and [`setDayNightSpeed`](api:setDayNightSpeed) drive the
  running day, and [`getTimeOfDay`](api:getTimeOfDay),
  [`isDayNightPlaying`](api:isDayNightPlaying) and [`getDayNightSpeed`](api:getDayNightSpeed)
  read it. They do nothing for a sky box without day-night.
- The day runs with the app loop, so pausing the app pauses it too.
- [`createSceneMainLooper`](api:createSceneMainLooper) runs a function every frame while the
  scene is loaded. The HUD line is only rewritten when its text changes.

::: tip Try the layers
In debug mode, the drawer's Sky box tab (`h`) has every layer's settings. A change shows at once
and is saved in your browser, until you clear it.
:::

Back to the [examples](hub:examples).
