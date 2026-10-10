## Entities

[`createEntity`](api:ECSWorld.createEntity) returns an id that packs the entity's slot and a
generation. When an entity is deleted and its slot reused, the old id no longer matches
([`isAlive`](api:ECSWorld.isAlive)), so a stale id can't reach the new entity.

Most entities come from the managers, which create them with their components:
[`createMeshEntity`](api:createMeshEntity), [`createLightEntity`](api:createLightEntity),
[`createPhysicsEntity`](api:createPhysicsEntity) and the others. Their options include:

- `appId`: a name of yours, to find the entity with [`getEntityIdByAppId`](api:getEntityIdByAppId).
- `persistent`: the entity survives scene switches. Everything else a scene creates is deleted
  when it exits.
- `disabled`: created switched off, hidden and with its physics body disabled.
  [`setDisabled`](api:ECSWorld.setDisabled) switches it later.

## Components

A component is a type key and its data:
[`addComponent`](api:ECSWorld.addComponent), [`getComponent`](api:ECSWorld.getComponent),
[`hasComponent`](api:ECSWorld.hasComponent) and [`removeComponent`](api:ECSWorld.removeComponent).
[`getStorage`](api:ECSWorld.getStorage) gives every entity that has a component, with its data,
which is what a system loops over.

The engine's component types are in `src/_engine/core/ECS/ECSRegistry.ts`. An app or toolkit
module adds its own next to its code, by augmenting the engine's `ComponentDataMap` interface
(`declare module 'aekasha'`), so the type checker knows each component's data everywhere. The
[ECS example](hub:examples/ecs#2-adding-it-to-the-component-map) shows how.

The transform is a component too. Write it with [`setTransform`](api:ECSWorld.setTransform)
(physics bodies included) and the engine syncs it onto the entity's Three.js object before the
frame is drawn. `AppConfig.ecs.storageMode` chooses its storage: `MAP` (the default) or
`TYPED_ARRAY`, a fixed-size typed-array store.

## Systems and stages

[`addSystem`](api:ECSWorld.addSystem) puts a function in a stage. The stages run in this order
every frame:

| Stage              | What it's for                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `MAIN`             | The engine's own per-frame work.                                                                             |
| `APP_PRE_PHYSICS`  | Input and anything that must happen before physics.                                                          |
| `APP_PHYSICS_STEP` | Zero or more times a frame, right before each fixed physics step: anything that moves in lockstep with it.   |
| `APP_POST_PHYSICS` | Physics poses are written into the transforms.                                                               |
| `APP_LOGIC`        | Gameplay.                                                                                                    |
| `APP_RENDER_SYNC`  | Transforms are written into the Three.js objects; culling and levels of detail. Cameras that follow go here. |
| `LATE_MAIN`        | After the frame is drawn.                                                                                    |

- Pausing the app (`F7` in debug) stops physics and `APP_POST_PHYSICS`, `APP_LOGIC` and
  `APP_RENDER_SYNC`. `MAIN`, `APP_PRE_PHYSICS` and `LATE_MAIN` keep running.
- Within a stage, a higher `order` runs first. The order is resolved when a system is added, so
  a frame never sorts.
- A system belongs to its world until [`removeSystem`](api:ECSWorld.removeSystem). A system only
  one scene needs is added in its scene file and removed when the scene exits.

## Plugins and hooks

[`registerPlugin`](api:ECSWorld.registerPlugin) runs a function for every world, now and when
one is created: that's how the engine's managers and the app's systems install themselves. The
app registers its plugins in one place, `src/AppECSPlugins.ts`:

<<< src/AppECSPlugins.ts#ecs-register-plugin

[`registerComponentHooks`](api:ECSWorld.registerComponentHooks) runs code when a component is
added or removed, or its entity deleted. The engine uses hooks to create and free what a
component stands for (a mesh's Three.js object, a body's colliders), so deleting an entity
cleans up after it.

## Managed entities

An entity a manager creates, drives and deletes itself (the sky box's sun light, for one) is
created with `managedBy`. The debugger then shows it read-only, with a link to its manager's
tab, so a change made by hand can't fight the manager.

## Key APIs

- [`getECSWorld`](api:getECSWorld): the world (the default one without an id).
- [`createEntity`](api:ECSWorld.createEntity), [`deleteEntity`](api:ECSWorld.deleteEntity) and
  [`isAlive`](api:ECSWorld.isAlive).
- [`addComponent`](api:ECSWorld.addComponent), [`getStorage`](api:ECSWorld.getStorage) and
  [`setTransform`](api:ECSWorld.setTransform).
- [`addSystem`](api:ECSWorld.addSystem), [`registerPlugin`](api:ECSWorld.registerPlugin) and
  [`registerComponentHooks`](api:ECSWorld.registerComponentHooks).

## Read more

- The [ECS example](hub:examples/ecs): a component and its system, from the type to the scene.
- The [toolkit](hub:features/toolkit)'s effects: more components and systems to read or copy.
- The API reference: [ECS](hub:documentation/engine/core/ECS).

::: claude-md
:::
