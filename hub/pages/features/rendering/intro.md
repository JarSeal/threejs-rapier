Ækasha renders with Three.js's `WebGPURenderer`. WebGPU comes first, and where a browser has
none, the same renderer runs on WebGL 2. Materials and effects are written in TSL, three's
shading language, so one shader runs on both.

::: scene exampleHubHero
The Hub's own homepage image, rendered by the engine: the `SPACE` sky box, toolkit asteroids in
a glowing ring, and the bloom pass from [Post effects](#post-effects).
:::
