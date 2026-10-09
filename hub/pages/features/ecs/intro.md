The ECS is Ækasha's core. An entity is an id, a component is data on it, and a system is a
function that runs in a fixed stage every frame. Meshes, lights, cameras, physics bodies and
levels of detail are all entities and components, so your game code works the way the engine
does, and you only bring in the systems you need.

::: scene exampleEcs
A `SPIN` component and its system, next to the toolkit's `HOVER`. The
[ECS example](hub:examples/ecs) builds them step by step.
:::
