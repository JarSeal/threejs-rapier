## The shapes

Each kind of shape is a geometry, a material and a collider of the same size:

<<< src/app/examples/physics/examplePhysics.ts#physics-shapes

The ids register each geometry and material the first time, so every box shares one geometry
and one material, however many you drop. Sizes are where three.js and Rapier differ: a capsule's
`height` in three.js is its straight part, and Rapier's `halfHeight` is half of that. A Rapier
cylinder's `halfHeight` is half of the whole height.

## Dropping one

<<< src/app/examples/physics/examplePhysics.ts#physics-drop

[`createMeshEntity`](api:createMeshEntity) makes the entity, and
[`createPhysicsEntity`](api:createPhysicsEntity) attaches a `DYNAMIC` body and its collider to
it (the entity id is its last argument). The body starts at `translation` with `rotation`, and
from then on the simulation moves the entity's transform, and the transform moves the mesh.

## The scene

<<< src/app/examples/physics/examplePhysics.ts#physics-scene

- The ground is a mesh with a `FIXED` body: other bodies collide with it, and nothing moves it.
- The first four drops are the same on every visit. A scene's physics starts from a fresh world
  and waits for every `createPhysicsEntity` call of the load before it steps, so a scene
  simulates the same way every time it loads.
- [`createKeyBinding`](api:createKeyBinding) with a `sceneId` only fires in that scene. Its
  `name` shows in the debug key shortcuts dialog (`u`).
- Deleting an entity ([`deleteEntity`](api:ECSWorld.deleteEntity)) removes its body and
  colliders too.

Back to the [examples](hub:examples).
