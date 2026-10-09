## Bodies on entities

A physics object is an ECS entity with a rigid body and its colliders.
[`createPhysicsEntity`](api:createPhysicsEntity) attaches them to an entity you already have (a
mesh from [`createMeshEntity`](api:createMeshEntity)), or makes a new one:

<<< src/app/examples/physics/examplePhysics.ts#physics-drop

- A body is `FIXED` (nothing moves it), `DYNAMIC` (the simulation moves it), or kinematic:
  `POS_BASED` or `VELO_BASED`, moved by your code through its next position or its velocity.
- A collider is a box, ball, capsule, cone, cylinder, triangle, triangle mesh, convex hull or
  heightfield. A primitive collider without its sizes takes them from the entity's mesh.
- It resolves with the entity id once the body exists (in `WORKER_THREAD` mode, after the
  worker's reply). Deleting the entity removes its body and colliders.
- A dynamic body's pose is written into the entity's transform every frame (at
  `APP_POST_PHYSICS`), and the transform moves its mesh. Your code never copies a position.

## Where the simulation runs

`AppConfig.physics.workerTarget` picks the thread: `WORKER_THREAD` (the default) or
`MAIN_THREAD`. The API is the same in both. In worker mode:

- The transforms come back through a buffer the physics owns: a real `SharedArrayBuffer` when
  the page is cross-origin isolated, else one batched message per frame. Never one message per
  body.
- The shared buffer is a lock-free triple buffer. At the start of every frame the engine takes
  the newest complete step, so everything that reads physics in a frame (systems, interpolation,
  the debug wireframes) sees the same step.
- `maxBodies` (default 2048) is the buffer's size. A full buffer rejects `createPhysicsEntity`
  with a `PhysicsCapacityError`. `FIXED` bodies take no slot.
- Queries (ray and shape casts) return a promise. The `…Sync` functions are for `MAIN_THREAD`
  mode only and throw in worker mode.

::: tip Hosting
`SharedArrayBuffer` needs cross-origin isolation: the headers `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. The dev server sends them. Your
production host should too, or physics falls back to the batched messages.
:::

## Stepping

Physics steps at a fixed rate (`AppConfig.physics.timestep`, 60 steps a second by default), zero
or more times per frame. Systems in the `APP_PHYSICS_STEP` stage run right before each step,
with the fixed step as their delta: that's where anything that must move in lockstep with the
simulation goes (kinematic platforms, character controllers, impulses). Collision and contact
force events arrive at the start of the next step.

In worker mode, the commands those systems send are captured per step, carried in the frame's
one STEP message and replayed in order in the worker.

## Deterministic scene loads

A scene load holds physics, replaces the world with a fresh one, and lets it step only after
every `createPhysicsEntity` call of the load has finished, awaited or not. So a scene simulates
the same way on every visit, on either thread. What follows from it:

- No physics entity survives a scene switch, and a body or collider from the previous scene is
  stale.
- Physics writes (poses, velocities, impulses, kinematic targets) belong in `APP_PHYSICS_STEP`
  systems or in the scene's load code. Writes from the other stages depend on frame timing.
- Characters aren't deterministic yet: they use the wall clock and random numbers.

To check a scene, open it with `?isDebug=true&physicsProbe=N`, or use "Determinism probe" in the
Physics API debug tab. It freezes physics N steps after the scene starts, hashes every dynamic
body's state, and compares the hash with the last run of the same scene.

## Queries, events and joints

- Ray and shape casts go through the world: [`getPhysicsWorld`](api:getPhysicsWorld)`().castRay(…)`,
  `castShape`, `intersectionsWithRay`. The debug env can draw them, and the Physics API tab
  counts them per frame.
- A collider's `collisionEventFn` and `contactForceEventFn` (in its params) are called when it
  starts or stops touching another collider, and with the contact forces.
- [`createJoint`](api:PhysicsAPI.createJoint) joins two bodies: fixed, revolute, prismatic, spherical, rope,
  spring or generic.

## Simulation tiers

A large world doesn't have to simulate every body. A `DYNAMIC` body made by
`createPhysicsEntity` can change its tier with [`requestPhysicsTier`](api:requestPhysicsTier):

| Tier       | The body                                                                            |
| ---------- | ----------------------------------------------------------------------------------- |
| `FULL`     | Simulated as usual.                                                                 |
| `STATIC`   | Made `FIXED`: frozen in place, and other bodies still collide with it.              |
| `DISABLED` | Disabled: nothing collides with it.                                                 |
| `REMOVED`  | Taken out of the physics world, its state kept, and its transform buffer slot free. |

A request applies at the next physics step, and a body comes back where it left off. Bodies
joined by joints change tier together, and can't be `REMOVED`.

A distance policy picks the tiers for you, from rings around a focus (the main camera by
default, an entity or a point). Its members are the bodies created with `tierPolicy: true`:

```ts
setPhysicsTierPolicy({
  focus: () => playerId, // An entity id or a position; leave it out for the main camera
  rings: [
    { tier: 'FULL', within: 40 },
    { tier: 'STATIC', within: 90 },
    { tier: 'DISABLED', within: 160 },
    { tier: 'REMOVED' }, // Everything farther
  ],
  sceneId: 'myScene', // Removed when the scene exits
});
```

It measures and decides on fixed physics steps, so a scene driven by it stays deterministic.
The app's `physicsTiers` scene is its demo: open it with `?isDebug=true&startScene=physicsTiers`.

## Key APIs

- [`createPhysicsEntity`](api:createPhysicsEntity): a body and its colliders on an entity.
- [`getPhysicsWorld`](api:getPhysicsWorld): the world, for queries.
- [`createJoint`](api:PhysicsAPI.createJoint) and [`deleteJoint`](api:PhysicsAPI.deleteJoint).
- [`requestPhysicsTier`](api:requestPhysicsTier), [`getPhysicsTier`](api:getPhysicsTier) and
  [`setPhysicsTierPolicy`](api:setPhysicsTierPolicy).
- [`getPhysicsSubStepIndex`](api:getPhysicsSubStepIndex): the step clock for `APP_PHYSICS_STEP`
  systems.

## Read more

- The [physics example](hub:examples/physics), with the code of the scene above.
- [Characters](hub:features/characters): the character controller, built on physics.
- The API reference: [PhysicsAPI](hub:documentation/engine/core/PhysicsAPI),
  [PhysicsManager](hub:documentation/engine/core/PhysicsManager),
  [PhysicsTiers](hub:documentation/engine/core/PhysicsTiers) and
  [PhysicsTierPolicy](hub:documentation/engine/core/PhysicsTierPolicy).

::: claude-md
:::
