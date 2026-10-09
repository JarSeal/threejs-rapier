Ækasha's engine, toolkit and example app follow these rules. Use them for your own features,
toolkit modules and app systems too: a module written to them installs, tree-shakes and stays
deterministic the way the engine's do. Code review points at a rule by its heading.

::: note Older code
Parts of the engine predate these rules and are being brought in line. New and changed code
follows them; a file you touch is a good time to fix what it breaks.
:::

## Layering

- **Engine ← toolkit ← app.** The engine imports neither the toolkit nor the app, and the toolkit
  doesn't import the app. Configuration and generated data are handed to the engine (through
  `InitEngine`), never imported from an app path.
- **A feature owns its folder:** its public entry, its implementation, its ECS registrations, its
  worker if it has one, and its debug modules. Removing the folder and its install line removes the
  feature.
- **Debug code is colocated and lazy.** A feature's debug panels live in `_dbg__` modules next to
  it and are reached only through the debug loader
  ([loadDebugModuleAsync](api:loadDebugModuleAsync)), never by a static import, so a shipping
  build doesn't load them.

## Public API

- **Only entry points are public.** Everything a feature exports for its own files and not from
  its entry is `@internal`.
- **Options objects** for a function with more than two parameters or any optional one:
  `createViewport({ id, scene, camera, anchor })`, not positional flags.
- **No internals in public types:** a public signature names only public types. An internal type
  leaking into a parameter or a result is an internal that can't change anymore.

## Naming

| Kind | Verb | Example |
| --- | --- | --- |
| Entities and objects the caller owns | `create*` / `delete*` | [createPhysicsEntity](api:createPhysicsEntity) |
| Definitions kept by id | `register*` / `unregister*` | [registerSpatialDomain](api:registerSpatialDomain) |
| Plain reads and writes | `get*` / `set*` | [getPhysicsSubStepIndex](api:getPhysicsSubStepIndex) |
| Promises | `load*Async` / `*Async` | [loadDebugModuleAsync](api:loadDebugModuleAsync) |
| Listeners | `on*`, returning the remover | `const off = onSkyBoxChange(fn)` |
| Predicates | `is*` / `has*` | `isDayNightPlaying()` |

- **Files are PascalCase** (`SkyTime.ts`), with one exception: a file named after an asset id
  keeps the id (`asteroid.tsl.ts` next to `asteroid.material.json`). Entries are `index.ts`, debug
  modules `_dbg__` + PascalCase, tests `*.test.ts` next to their module.
- **No `Manager` suffix.** The folder names the feature, and the verbs say what a function does.
- **No two names that differ only in case**, in any one folder or between the files a reader
  would confuse (`helpers.ts` and `Helpers.ts`).

## Size

About **800 lines per file** and **150 per function or closure**. Past either, split it along
what it does (a world, its bodies, its queries) unless there's a reason not to, and write the
reason in the file's header comment.

## Async and disposal

- **Re-check after every `await`.** A scene switch, a deleted entity or a newer call can happen
  while a promise is pending: compare a load token, the scene id or the entity's generation before
  writing anything. When calls overlap, say in the JSDoc which one wins (usually the latest:
  [setActiveSkyBox](api:setActiveSkyBox)).
- **References don't outlive their scene.** Physics bodies, colliders and scene-scoped entities are
  gone after a scene switch; code that keeps one checks it, or registers with the scene's exit.
- **Every resource has one owner that disposes it:** a geometry, material, texture, render target
  or worker is released by whoever created it, or handed to the asset registry, which counts its
  users. three keeps an object's render objects until the object fires `dispose`.
- **Listeners and timers return or register their cleanup.** An `on*` returns its remover, a debug
  tab's `onOpen` returns its teardown, and a scene-scoped registration takes the scene's id.

## Per-frame code

Systems, loopers and anything else that runs every frame or every physics step:

- **No allocations.** Module-level scratch objects (`const _tmpVec = new Vector3()`), reused
  arrays, no object or array literals, closures, spreads or `map` / `filter` per entity.
- **Read component storages once per frame** (`world.getStorage(type)`) and index them in the
  loop, not one lookup per entity.
- **No redundant GPU state changes:** don't set a uniform, a material property or `needsUpdate`
  unless the value changed.
- Measure it: the profiler window (F8) shows a frame's cost, and the project's `perf-auditor` agent
  hunts allocations and GPU state churn in a folder.

## Smallest build

Only what an app uses ships.

- **No module-level side effects.** Registering a system, a component hook or a plugin happens
  when the feature is installed, not when its module is imported, so importing a type or an unused
  function costs nothing.
- **Heavy dependencies behind `import()`:** a physics backend, a loader, a decoder, a debug panel.
- **Import what you use,** never a barrel of three's addons (`three/examples/jsm/Addons.js`).

## The simulation

The simulation is the game's state as the physics steps it: ECS game state, physics, character
controllers, AI and gameplay systems at `APP_PHYSICS_STEP`. It must run identically on every
machine, in the physics worker and, later, on a headless server. The presentation (rendering,
interpolation, animation, UI, audio, debug) reads it and never writes it except through intents
and commands.

- **Time is the step index** ([getPhysicsSubStepIndex](api:getPhysicsSubStepIndex)), never
  `performance.now()`, `Date` or the frame delta. Measuring how long something took (profiling)
  isn't simulation input.
- **Randomness is seeded:** [createSeededRandom](api:createSeededRandom), never `Math.random`.
- **Input arrives as intents:** player input, AI, network and replays all write the same intents,
  and a controller never knows which one drives it.
- **It reads its own state at the step,** not the synced `TRANSFORM`s, interpolated poses or
  `Object3D`s, which lag a frame behind the physics worker. Read physics state through
  step-stamped reads ([readBodyPositionsAtStep](api:readBodyPositionsAtStep)), and make stepping
  wait for an answer with [addPhysicsStepGate](api:addPhysicsStepGate).
- **Messages are plain data:** no class instances or functions in a worker or network message, so
  a recording replays and a network can carry it.
- **Type imports are written `import type`** across the simulation's boundary, so a type can't pull
  the renderer, three or the DOM into the physics worker or a server.
- **Components are data,** not closures, so a save game or a network can serialize them.
- **One physics build for every peer:** Rapier's compat and deterministic builds give different
  results, so switching between them is deliberate and changes every stored determinism hash once.

The determinism probe (`?physicsProbe=N`, see the [debug suite](hub:features/debug-suite)) and the
scene runner check that a scene simulates identically on every load and in every physics target.

## Type hygiene

- **No `any`.** Use `unknown` and narrow it, or a type parameter.
- **An `eslint-disable` says why:** `// eslint-disable-next-line no-console -- the logger itself`.
- **No orphan TODOs:** a TODO becomes an issue file (`docs/issues/`) or an item in a plan, and the
  comment names it.

## Tests

Pure logic (maths, parsing, state machines, anything without a renderer) gets a Vitest test,
`*.test.ts` next to its module. What needs a GPU is checked by the scene runner: its snapshots,
console errors and determinism hashes.
