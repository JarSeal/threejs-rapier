A viewport is a rectangle over the canvas with its own scene and camera: a minimap, a
picture-in-picture of another camera, an item preview in the HUD. It's placed by the DOM, so your
CSS lays it out, and it works on both backends, with post effects on or off. A view is the other
way round: it takes over the whole canvas, as the debugger's editors do.
