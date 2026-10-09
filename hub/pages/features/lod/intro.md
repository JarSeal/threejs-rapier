A far object doesn't need its full mesh. Ækasha's LOD system gives each object a level of
detail from its size on screen, and cross-fades every change, so nothing pops. The levels are
hand-made, or generated from the mesh with meshoptimizer, and the farthest can be an impostor:
the object drawn on a few textured quads, still lit by the scene. Thousands of instances cost a
draw call per level.

::: scene exampleLod
180 torus knots of 16,384 triangles each, in one instanced LOD pool: a generated chain of
simplified levels, then an octahedral impostor. The [LOD example](hub:examples/lod) walks
through its code.
:::
