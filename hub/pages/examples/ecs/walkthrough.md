## 1. The component

A component is a key and the type of its data:

<<< src/app/examples/ecs/SpinComponent.ts#spin-component

## 2. Its types in the registry

`src/AppECSRegistry.ts` lists the app's components next to the engine's, so
[`addComponent`](api:ECSWorld.addComponent) and [`getStorage`](api:ECSWorld.getStorage) know
`SPIN` and its data's type:

<<< src/AppECSRegistry.ts#ecs-component-types

<<< src/AppECSRegistry.ts#ecs-component-data

Keep this file to keys and types (`SpinComponent.ts` has no imports): everything that imports the
ECS imports it.

## 3. The system

<<< src/app/examples/ecs/SpinSystem.ts#spin-system

- [`getStorage`](api:ECSWorld.getStorage) gives every entity with the component and its data.
- [`setTransform`](api:ECSWorld.setTransform) writes the new rotation, and the engine syncs it
  onto the mesh before the frame is drawn.
- A system belongs to a stage. Every frame runs `MAIN`, `APP_PRE_PHYSICS`, `APP_POST_PHYSICS`,
  `APP_LOGIC`, `APP_RENDER_SYNC` and `LATE_MAIN` in that order. `APP_LOGIC` is for gameplay, and
  it stops while the app is paused.

## 4. Registering it

<<< src/AppECSPlugins.ts#ecs-register-plugin

[`registerPlugin`](api:ECSWorld.registerPlugin) runs for every ECS world, so the system is there
in every scene: where no entity has the component, it loops over nothing. For a system only one
scene needs, call [`addSystem`](api:ECSWorld.addSystem) in the scene file and
[`removeSystem`](api:ECSWorld.removeSystem) when the scene exits.

## Using it

<<< src/app/examples/ecs/exampleEcs.ts#ecs-scene

An entity can have any number of components, and each system only reads its own: `SPIN` turns
the last box while the toolkit's `HOVER` moves it.

Back to the [examples](hub:examples).
