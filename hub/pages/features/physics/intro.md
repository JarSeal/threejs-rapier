Ækasha's physics is [Rapier](https://rapier.rs/) behind an engine-agnostic Physics API. The
simulation runs on a worker thread by default, so it never competes with the frame, and every
body's transform comes back through one shared buffer. Every scene load starts from a fresh
world, so a scene simulates the same way on every visit.

::: scene examplePhysics
A static ground with a box, a sphere, a capsule and a cylinder dropping onto it. The
[physics example](hub:examples/physics) walks through its code.
:::
