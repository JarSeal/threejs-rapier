A scene is a JSON file and a scene file. The JSON names what the scene loads: its cameras,
lights, materials, meshes, sky boxes and post effects, each one a JSON file of its own that
scenes can share. The scene file is TypeScript, for everything code does better. Every JSON is
checked against its schema when you save it, and your editor autocompletes it.

::: scene exampleQuickStart
The smallest complete scene: a scene JSON with a camera, two lights and a material, and a scene
file that adds a ground and a hovering cube. The [quick start](hub:examples#your-first-scene)
walks through it.
:::
