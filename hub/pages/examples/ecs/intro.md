::: scene exampleEcs
A row of boxes, each turning about its own axis at its own speed. The last one hovers too.
:::

Ækasha keeps game state in an ECS: an entity is an id, a component is a piece of data on it, and
a system is a function that runs every frame over the entities with a component. This example
adds a `SPIN` component and its system in four steps.
