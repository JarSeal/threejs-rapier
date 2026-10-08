::: scene examplePhysics
A static ground with a box, a sphere, a capsule and a cylinder dropping onto it. Press Space to
drop another one.
:::

Every shape is an ordinary mesh entity with a Rapier body attached by
[`createPhysicsEntity`](api:createPhysicsEntity). The simulation runs on a worker thread by
default and moves the meshes, so the scene code never updates a position itself.
