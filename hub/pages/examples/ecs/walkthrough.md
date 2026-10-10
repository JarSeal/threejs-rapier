## 1. The component

A component is a key and the type of its data:

<<< src/app/examples/ecs/SpinComponent.ts#spin-component

## 2. Adding it to the component map

The same file adds `SPIN` to the engine's component map, so
[`addComponent`](api:ECSWorld.addComponent) and [`getStorage`](api:ECSWorld.getStorage) know it
and its data's type:

<<< src/app/examples/ecs/SpinComponent.ts#spin-component-map

`declare module 'aekasha'` merges the key into the engine's `ComponentDataMap` interface, with no
shared file to edit: the toolkit's components (`HOVER`, `FOLLOW`, `SUN_SHADOW_FIT`) add theirs the
same way, and code uses each module's own key object (`SpinComponentType.SPIN`,
`HoverToolComponentType.HOVER`). Always augment `'aekasha'`, never a path into the engine: the
same interface augmented through two paths loses keys without an error.

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
