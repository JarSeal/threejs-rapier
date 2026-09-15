Status: draft | not-implemented

# Multiple ECS Worlds — Plan

Support more than one `ECSWorld` instance at once (e.g. a UI world and/or standalone simulation worlds alongside the default/main world), each independently identified, listed in the ECS debug tab, and disposable.

---

## 1. Goal

Today `ECS.ts` supports exactly one live `ECSWorld`, created once by `initECSWorld()` and retrieved everywhere via `getECSWorld()`. The ask is to let the app create additional, independently-identified worlds (`new ECSWorld({ id: 'ui' })`), list every live world in the ECS debug tab, throw on id collisions (including a second unnamed/default world), and add a `deleteECSWorld` teardown helper — while keeping today's single-default-world creation path working exactly as it does now. Each world also carries an optional debug-only `name`/`description` pair purely for a nicer, more readable debug-tab listing — `id` stays the sole identity/lookup key.

Three shape-defining decisions were made up front (recapped in §3) rather than guessed at, because they change how large this refactor actually is:

1. New worlds get **all** globally-registered plugins by default, same as today, with an opt-out flag per world.
2. `MainLoop.ts` **auto-drives every registered world** every frame (not just the default one).
3. `ECSWorld`'s constructor becomes a single **options object** instead of positional args.

---

## 2. Current state (grounded in the actual code)

### 2.1 Single global world today (`src/_engine/core/ECS.ts`)

```ts
let ecsWorld: ECSWorld;

export const initECSWorld = (): ECSWorld => {
  const ecsConfig = getConfig().ecs;
  let storageMode: ECSStorageMode = ecsConfig?.storageMode ?? 'MAP';
  let maxEntities = ecsConfig?.maxEntities ?? 100_000;
  // ...LS overrides in debug...
  ecsWorld = new ECSWorld(storageMode, maxEntities);
  return ecsWorld;
};

export const getECSWorld = () =>
  existsOrThrow(ecsWorld, 'ECS World not initialized. Could not get ECS World.');
```

`ECSWorld` already has a `private static activeWorlds = new Set<ECSWorld>()`, populated in the constructor and consumed only by `registerPlugin`'s hot-load path (`this.activeWorlds.forEach((world) => plugin(world))`). It exists to support *future* multiple instances, but nothing keys it by id, and `getECSWorld()`/`initECSWorld()` ignore it entirely.

Everything else that matters for multi-world support is **already instance-scoped**, not static — this is the load-bearing fact for this whole plan:

- `storages: Map<ComponentType, IComponentStorage<any>>` — per instance.
- `systems: Map<ECSSystemStage, SystemEntry[]>` — per instance (`addSystem`/`removeSystem`/`getSystemOrder` already operate per-world).
- `generations`, `nextEntityId`, `freeIds`, `entities` — per instance.

Only the **plugin/hook registries** are `static` (shared across all worlds by design — see §2.4).

### 2.2 The optional-world-param pattern already exists almost everywhere

`src/_engine/utils/ECSHelpers.ts` and most managers (`CameraManager.ts`, `GroupManager.ts`, `MeshManager.ts`, `LightManager.ts`) already thread an **optional** `ecsWorld?: ECSWorld` parameter through, falling back to `getECSWorld()`:

```ts
export const createEntity = (opts?: CoreEntityOpts, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  return world.createEntity(opts);
};
```

This means most of the ~73 `getECSWorld()` call sites across 34 files **do not need to change at all** — they already accept an explicit `ECSWorld` and only fall back to the default when the caller omits one. Calling `createEntity(opts, uiWorld)` today would already create the entity in `uiWorld`, once `uiWorld` exists.

### 2.3 Where `getECSWorld()` is hardcoded (and why that's fine to leave alone)

A grep for *bare* `getECSWorld()` calls (no `ecsWorld ||` fallback) turns up ~25 sites, but they cluster in exactly the places that are inherently tied to **the one rendered scene**: `CameraManager.ts`, `Scene.ts`, `SceneLoader.ts`, `ImportModel.ts`, `Character.ts`, `movingPlatform.ts`, `3DSymbols.ts`, and `PhysicsRapier.ts` (`src/_engine/core/PhysicsRapier.ts:1231`).

That's not an oversight — the scene/asset JSON pipeline (`registerScenesFromGeneratedData()`) only ever populates the default world, Rapier physics is a main-thread singleton hardwired to `getECSWorld()`, and the debug camera/scene loader machinery is scene-lifecycle code. None of this is in scope for a UI or standalone-simulation world per the stated use case (§6 makes this an explicit non-goal rather than a silent limitation).

### 2.4 Static vs. instance state — why plugin scope is a real design question

```ts
private static plugins: WorldPlugin[] = [];
private static onAddComponentHooks: Map<ComponentType, ComponentHook[]> = new Map();
// ...

constructor(storageMode = 'MAP', maxEntities = 100_000) {
  // ...preallocate storages/systems...
  ECSWorld.activeWorlds.add(this);
  ECSWorld.plugins.forEach((plugin) => plugin(this)); // <-- every plugin, every world
}
```

Every manager that calls `ECSWorld.registerPlugin(...)` at module load (`MeshManager.ts`, `LightManager.ts`, `LightFrustumCullingSystem.ts`, `ECSCoreSystems.ts`, `AppECSPlugins.ts`'s hover/follow tool effects) gets applied to **every** `ECSWorld` instance, current and future, with no way to opt out today. `registerComponentHooks` (add/remove/delete-entity hooks) is separate from this and stays global regardless of plugin scope — see §4.6 for why that's the right call.

---

## 3. Decisions already made

Asked and answered before designing §4, since they change the size and shape of this refactor:

1. **Plugin scope — opt-out, not opt-in.** New worlds get every globally-registered plugin by default (identical to today's behavior for the default world); the constructor accepts a flag to exclude them for a world that wants to stay bare (e.g. a UI world with no meshes/lights).
2. **Update loop — auto-drive every world.** `MainLoop.ts` iterates every registered `ECSWorld` each frame and calls its `updateMainLoop`/`updateAppLoop`/`updateLateMainLoop`, the same way it drives the default world today. No manual per-world wiring needed in app code.
3. **Constructor shape — options object.** `new ECSWorld({ id?, storageMode?, maxEntities?, applyGlobalPlugins? })` replaces the positional `(storageMode?, maxEntities?)`. `initECSWorld()` is the only call site and gets updated to match; nothing about calling `initECSWorld()` itself changes.

---

## 4. Design

### 4.1 World identity & registry

```ts
export const DEFAULT_ECS_WORLD_ID = '[default]';

export type ECSWorldOptions = {
  /** Defaults to DEFAULT_ECS_WORLD_ID. Must be unique among live worlds — the identity/lookup key. */
  id?: string;
  /** Debug-only display name. Defaults to `id` if omitted. Not required to be unique. */
  name?: string;
  /** Debug-only free-text description, shown in the ECS debug tab's Worlds listing. */
  description?: string;
  storageMode?: ECSStorageMode;
  maxEntities?: number;
  /** Whether globally registered plugins (ECSWorld.registerPlugin) run on this world. Default true. */
  applyGlobalPlugins?: boolean;
};
```

Replace the untyped `activeWorlds: Set<ECSWorld>` with a keyed registry, which is the actual source of truth `getECSWorld`/the debug GUI/`deleteWorld` need:

```ts
private static worldsById: Map<string, ECSWorld> = new Map();

public readonly id: string;
/** Debug-only — never used for lookup/equality, purely a nicer label in the debug tab. */
public readonly name: string;
/** Debug-only — shown alongside `name` in the debug tab, omitted if not given. */
public readonly description?: string;
private readonly applyGlobalPlugins: boolean;
```

### 4.2 Constructor

```ts
constructor(opts?: ECSWorldOptions) {
  const id = opts?.id ?? DEFAULT_ECS_WORLD_ID;
  if (ECSWorld.worldsById.has(id)) {
    const msg =
      id === DEFAULT_ECS_WORLD_ID
        ? 'Default ECS World already exists. Pass an explicit `id` to create an additional world.'
        : `ECS World with id '${id}' already exists.`;
    lerror(msg);
    throw new Error(msg);
  }

  this.id = id;
  this.name = opts?.name ?? id;
  this.description = opts?.description;
  this.applyGlobalPlugins = opts?.applyGlobalPlugins ?? true;
  this.storageMode = opts?.storageMode ?? 'MAP';
  this.maxEntities = opts?.maxEntities ?? 100_000;

  // ...existing stage/storage preallocation, unchanged...

  ECSWorld.worldsById.set(id, this);

  if (this.applyGlobalPlugins) {
    ECSWorld.plugins.forEach((plugin) => plugin(this));
  }
}
```

`initECSWorld()` becomes a one-line call-site update: `new ECSWorld({ storageMode, maxEntities })` (id omitted → default world, identical behavior to today).

### 4.3 Duplicate-id / duplicate-default guard

Covered above — the constructor is the single choke point, so both "id already taken" and "default world already created" are the same check (`worldsById.has(id)`), just with a clearer error message for the default case. This satisfies the requirement directly; no separate registry-level validation pass is needed.

### 4.4 Lookup / enumeration API

```ts
public static registerPlugin(plugin: WorldPlugin) {
  this.plugins.push(plugin);
  this.worldsById.forEach((world) => {
    if (world.applyGlobalPlugins) plugin(world);
  });
}

public static getWorld(id: string): ECSWorld | undefined {
  return this.worldsById.get(id);
}

public static getAllWorlds(): ECSWorld[] {
  return Array.from(this.worldsById.values());
}

public getEntityCount(): number {
  return this.entities.size;
}
```

```ts
export const getECSWorld = (id: string = DEFAULT_ECS_WORLD_ID): ECSWorld =>
  existsOrThrow(ECSWorld.getWorld(id), `ECS World '${id}' not initialized. Could not get ECS World.`);

export const getAllECSWorlds = (): ECSWorld[] => ECSWorld.getAllWorlds();
```

`getECSWorld()` with no argument is unchanged for every one of the ~73 existing call sites (§2.2/§2.3) — this is what keeps the refactor's blast radius small. A caller that wants a specific secondary world passes its id explicitly, or (per the existing pattern in §2.2) just passes the `ECSWorld` instance it already holds a reference to.

### 4.5 `deleteECSWorld` — teardown semantics

A naive `worldsById.delete(id)` would leak: any mesh/light/camera entities in that world have Object3D/Rapier resources released via the `onDeleteEntity` hooks (`ECSWorld.registerComponentHooks(...).onDeleteEntity`) that `deleteEntity()` fires per entity — a bulk `clearWorld()`-style wipe does **not** fire those hooks today (it clears storages/entities directly), so it's the wrong primitive to reuse here. Deletion instead routes every live entity through the real `deleteEntity()` path:

```ts
public static deleteWorld(id: string): boolean {
  const world = this.worldsById.get(id);
  if (!world) return false;

  // Route through deleteEntity so onDeleteEntity hooks run (mesh/light/camera
  // disposal, physics body cleanup, etc.) — a bulk clearWorld()-style wipe
  // would skip them.
  for (const entityId of Array.from(world.entities)) {
    world.deleteEntity(entityId);
  }
  this.worldsById.delete(id);
  return true;
}
```

```ts
export const deleteECSWorld = (id: string): boolean => ECSWorld.deleteWorld(id);
```

Deleting `DEFAULT_ECS_WORLD_ID` is allowed by this helper (symmetry — no special-casing), but is almost certainly a mistake if the main loop and the JSON scene pipeline are still pointed at it; `getECSWorld()` will simply throw afterward like any other "not initialized" case, which is the existing invariant-violation pattern elsewhere in this file.

### 4.6 Why component hooks stay global (not scoped by `applyGlobalPlugins`)

`registerComponentHooks` fires by `ComponentType`, not by "which plugin registered it," and hooks are cheap, generic housekeeping (e.g. `DISABLED` → hide `Object3D`, `OBJECT3D`/`PERSISTENT`/`TARGET_LINK` bookkeeping in `ECSCoreSystems.ts`). A bare UI world that never adds an `OBJECT3D` component to any entity simply never triggers the `OBJECT3D` hook — the scoping happens naturally through what component types a world's entities actually use, with no extra mechanism needed. Only **systems** (registered via `addSystem` inside a plugin's callback, which run unconditionally every frame per stage regardless of whether any matching entities exist) carry a real per-world cost, and that's exactly what `applyGlobalPlugins` gates.

### 4.7 `MainLoop.ts`: auto-driving every registered world

`src/_engine/core/MainLoop.ts` currently caches one module-level `ecsWorld: ECSWorld`, set once in `initMainLoop()`, and calls `ecsWorld.updateMainLoop(delta)` etc. directly in both `mainLoopForDebug` and `mainLoopForProduction`. Per decision §3.2, this becomes a live iteration each frame instead of a cached single reference — which also means a world created *after* `initMainLoop()` runs (e.g. a UI world spun up when a menu opens) is automatically picked up on the very next frame, with no extra wiring:

```ts
// mainLoopForDebug / mainLoopForProduction, replacing each
// `ecsWorld.update*Loop(...)` call:
for (const world of getAllECSWorlds()) world.updateMainLoop(delta);
// ...
for (const world of getAllECSWorlds()) world.updateAppLoop(deltaApp);
// ...
for (const world of getAllECSWorlds()) world.updateLateMainLoop(delta);
```

`initMainLoop()` drops its `ecsWorld = getECSWorld()` line entirely — nothing to cache anymore. Physics stepping (`stepPhysicsWorld`/`renderPhysicsObjects`) stays a single global call, unaffected — it's not per-world (§6).

`Array.from(worldsById.values())` inside `getAllWorlds()` also means a world calling `deleteECSWorld` on itself mid-frame (e.g. from one of its own systems) can't corrupt the frame's iteration — each frame gets its own snapshot array, not a live iterator over the registry.

### 4.8 Debug GUI: Worlds panel in the ECS tab

`src/_engine/core/Debug/_dbg__ECS.ts` currently builds one pane with a "Component Storage" folder and a "Stress Test Benchmark" folder, both implicitly targeting the single default world via `getECSWorld()`. Add a "Worlds" folder above them, rebuilt from `getAllECSWorlds()`:

```ts
const worldsFolder = debugGUI.addFolder({ title: 'ECS Worlds', expanded: true });

getAllECSWorlds().forEach((world) => {
  const isDefault = world.id === DEFAULT_ECS_WORLD_ID;
  const sub = worldsFolder.addFolder({
    // world.name defaults to world.id (§4.1/§4.2) when no explicit name was
    // given, so this reads fine either way — a named world shows its name,
    // an unnamed one shows its id.
    title: isDefault ? `${world.name} [default]` : world.name,
    expanded: false,
  });
  const readout = {
    id: world.id,
    description: world.description ?? '—',
    entities: world.getEntityCount(),
    storageMode: world.storageMode,
  };
  // id is always shown explicitly, even when the folder title already shows
  // `name` — name is a debug-only label and may not equal id (or may not be
  // unique), so the raw identity key stays visible for anything that needs
  // to reference this world by id (getECSWorld(id), deleteECSWorld(id)).
  sub.addBinding(readout, 'id', { readonly: true });
  sub.addBinding(readout, 'description', { readonly: true });
  sub.addBinding(readout, 'entities', { readonly: true });
  sub.addBinding(readout, 'storageMode', { readonly: true });
  if (!isDefault) {
    sub.addButton({ title: 'Delete world' }).on('click', () => {
      deleteECSWorld(world.id);
      debugGUI.refresh(); // folder list itself needs the tab reopened, same
                           // caveat as every other structural change in this pane
    });
  }
});
```

Same caveat as the existing "reloads the app" storage-mode control: Tweakpane folders here are built once when the tab's `container()` runs, so a world created *while the tab is already open* won't appear until the tab is reopened. That's an existing limitation of this debug pane's pattern (see the "Component Storage (reloads the app)" folder title already acknowledging similar staleness), not a new one introduced by this plan — not worth solving here.

`storageMode` needs to go from `private readonly` to `public readonly` (or get a small getter) for the debug pane to read it; trivial, called out in §7.

---

## 5. Performance research & memory footprint

### 5.1 Fixed per-world cost: the `generations` array dominates

```ts
private generations = new Uint32Array(1048576);
```

This is **~4 MiB per `ECSWorld` instance** (1,048,576 × 4 bytes), allocated unconditionally in the constructor, sized to the full 20-bit index space the packed-id scheme supports (`INDEX_MASK = 0xfffff`) — **not** to `maxEntities`. `maxEntities` today only sizes `TypedArrayTransformStore`'s `Float32Array`s when `storageMode === 'TYPED_ARRAY'`; in the default `MAP` mode it's inert metadata. So a bare secondary world created for a few dozen UI entities still eagerly pays the same ~4 MiB as the default world.

Everything else scales with **types**, not capacity, and is cheap:

- `storages`: one `Map` per `ComponentType` — ~33 core + ~6 app types today (`ECSRegistry.ts` / `AppECSRegistry.ts`) ≈ 39 empty `Map`s, a few KB total.
- `systems`: one array per `ECSSystemStage` (6 stages), empty until `addSystem` is called.

Net: **N worlds ≈ N × 4 MiB fixed overhead**, dominated almost entirely by `generations`. Three worlds (default + UI + one simulation world) ≈ 12 MiB before a single entity exists. That's not alarming in absolute terms (comparable to a couple of mid-size textures), but it's pure waste for a small UI world, and it compounds if the app spins up several short-lived simulation worlds over a session — see §5.4.

### 5.2 Per-frame cost under "auto-drive every world" + "opt-out, not opt-in" plugins (§3)

The two chosen defaults compound: every world (including a near-empty UI world) runs every globally-registered system, every frame, because plugins apply by default and `MainLoop.ts` drives every world unconditionally.

Concretely, per extra world with `applyGlobalPlugins: true` (the default), each frame adds one call per registered system across `MAIN`/`APP_PRE_PHYSICS`/`APP_POST_PHYSICS`/`APP_LOGIC`/`APP_RENDER_SYNC`/`LATE_MAIN` — today that's `ECSCoreSystems.ts` (object3D sync, look-at, etc.), `LightFrustumCullingSystem.ts`, and whatever `AppECSPlugins.ts` registers (hover/follow tool effects). Each of those iterates a `getStorage(type)` `Map` that's empty for a world with no matching entities, so the *work* is effectively O(0) — but the **call** still happens: roughly half a dozen no-op function calls per extra world per frame. At the scale implied by "a UI world and maybe some simulation worlds" (2–4 total worlds), this is on the order of tens of extra no-op calls per frame — not measurable against a 60 FPS budget, and not worth pre-optimizing.

Where it *would* start to matter is if a system does non-entity-proportional work unconditionally before checking storage — e.g. `LightFrustumCullingSystem.ts` calls `getMainCamera()` and rebuilds a `THREE.Frustum` from the projection matrix before iterating lights. For a UI/simulation world with no lights, that's small fixed math done for no reason, repeated once per such world per frame. Worth a quick audit when implementing (or just set `applyGlobalPlugins: false` on any world that has no use for mesh/light/camera-adjacent systems, per the opt-out flag in §4.1) rather than auditing every system's early-exit behavior up front.

### 5.3 Recommendation: size `generations` from `maxEntities` — phase 2, not phase 1

The real fix for §5.1 is straightforward — `new Uint32Array(Math.min(maxEntities, 1_048_576))` — but it changes semantics, not just allocation size: `maxEntities` is currently **unenforced** in `MAP` storage mode (`_getNewEntityId()` never checks `nextEntityId` against it), so shrinking `generations` to `maxEntities` would newly make `maxEntities` a hard cap in `MAP` mode too (index-out-of-bounds risk if exceeded, where today there's silent headroom up to ~1M). That's a real behavior change for the *existing* default world (`maxEntities` defaults to 100,000), not just new secondary worlds, and it deserves its own small pass — bounds-check entity creation against `maxEntities` and decide what happens on overflow (throw vs. grow) — rather than folding it silently into the multi-world rollout. Flagged as a natural phase 2 follow-up (§8), not a blocker: the ~4 MiB/world cost is affordable at the 2–4 world scale this plan targets, it's just not free, and this is the concrete lever if it ever needs to be.

### 5.4 Bottom line

Creating and destroying a *handful* of worlds (UI, a couple of simulation worlds) has negligible per-frame cost and a fixed ~4 MiB/world memory cost that's wasteful-but-affordable at that scale. It would **not** scale well to, say, dozens of short-lived worlds spun up/torn down repeatedly (e.g. one per some frequently-instantiated sub-scene) — that pattern should either reuse a pooled world or wait for §5.3's follow-up. Nothing here needs to block Phase 1.

---

## 6. Non-goals / explicit limitations

- **Physics stays single/default-world only.** `PhysicsRapier.ts` is hardwired to `getECSWorld()` (default) and is a main-thread singleton (`PhysicsAPI.ts`'s engine-agnostic, worker-capable redesign is commented-out legacy code per `CLAUDE.md`'s Physics section — not built on here). A "simulation" world that needs Rapier rigid bodies is **not** enabled by this plan; it needs that separate, already-documented physics refactor first. Non-physics simulations (pure ECS logic/state, no rigid bodies) are fully supported.
- **The scene/asset JSON pipeline stays single/default-world only.** `registerScenesFromGeneratedData()`, `Scene.ts`, `SceneLoader.ts`, `ImportModel.ts` remain hardcoded to the default world (§2.3) — no `*.scene.json`-authored content can target a secondary world in this plan.
- **No cross-world entity references or queries.** An entity id from one world is meaningless in another (each world has its own index/generation space) — nothing in this plan adds validation to catch that misuse; it's the caller's responsibility, same as today's single-world footguns (e.g. passing a dead id).

---

## 7. Files touched

- `src/_engine/core/ECS.ts` — `DEFAULT_ECS_WORLD_ID`, `ECSWorldOptions` (incl. debug-only `name`/`description`), keyed `worldsById` registry (replaces `activeWorlds`), constructor options object + duplicate-id guard, `id`/`name`/`description` public readonly fields, `getWorld`/`getAllWorlds`/`deleteWorld` statics, `getEntityCount()`, `storageMode` visibility, module-level `getECSWorld(id?)`/`getAllECSWorlds()`/`deleteECSWorld(id)`.
- `src/_engine/core/MainLoop.ts` — drop cached module-level `ecsWorld`; iterate `getAllECSWorlds()` in `mainLoopForDebug`/`mainLoopForProduction`.
- `src/_engine/InitApp.ts` — `initECSWorld()`'s one call site: `new ECSWorld(storageMode, maxEntities)` → `new ECSWorld({ storageMode, maxEntities })`.
- `src/_engine/core/Debug/_dbg__ECS.ts` — "ECS Worlds" folder listing every world by `name` (title) with `id`, `description`, entity count, and storage mode as readonly fields, plus a delete button for non-default worlds.

Everything else (`ECSHelpers.ts`, `CameraManager.ts`, `GroupManager.ts`, `MeshManager.ts`, `LightManager.ts`, and the ~25 hardcoded-default call sites in §2.3) needs **no changes** — confirmed by §2.2/§2.3's audit. This is materially smaller than "a large refactoring operation touching most `getECSWorld()` call sites."

---

## 8. Phased rollout

### Phase 1 — Core multi-world support
- §4.1–§4.6: registry, constructor options, duplicate-id guard, lookup/enumeration, `deleteECSWorld`.
- §4.7: `MainLoop.ts` auto-drive.
- §4.8: debug GUI worlds panel.
- Manual test: create a second world (`new ECSWorld({ id: 'ui', applyGlobalPlugins: false })`), add/remove entities in it independently of the default world, confirm it appears/updates in the ECS debug tab, confirm `deleteECSWorld('ui')` fires disposal hooks and the world disappears from the tab on reopen, confirm a duplicate `new ECSWorld({ id: 'ui' })` (or a second `new ECSWorld()` with no id) throws.

### Phase 2 — `maxEntities` as a real cap (follow-up, not blocking)
- §5.3: bound `generations` (and `nextEntityId`/`freeIds`) to `maxEntities` in `MAP` mode, decide overflow behavior, ship as an explicit opt-in or a documented behavior change for the default world's existing `maxEntities: 100_000`.

---

## 9. Risks and open questions

- **Debug-pane staleness (§4.8):** worlds created while the ECS tab is already open don't appear until it's reopened, same class of limitation as the existing storage-mode control. Acceptable for now; a live-refreshing folder list would need `container()` itself to re-run on an interval or on a registry-change event, which is more machinery than this plan's scope justifies.
- **Deleting the default world is technically allowed (§4.5)** with no special-casing — `MainLoop.ts` and the scene pipeline will start throwing on their next `getECSWorld()` call, which is the existing "not initialized" invariant. Consider whether that should instead be a hard guard (`deleteECSWorld` refuses `DEFAULT_ECS_WORLD_ID`) once real usage patterns emerge — left open rather than guessed at, since a legitimate "full app teardown/reset" flow might actually want this to work.
- **`LightFrustumCullingSystem`'s per-frame fixed cost (§5.2)** on worlds that will never have lights is a minor, known inefficiency once multiple worlds exist; mitigated by setting `applyGlobalPlugins: false` on such worlds rather than an early-exit audit of every existing system.

---

## 10. Recommendation

Build Phase 1 as scoped — it's a small, well-contained change (four files) precisely because the codebase's existing optional-`ecsWorld`-param convention (§2.2) already did most of the plumbing work needed for multi-world support; this plan mainly closes the gap between "any function *can* target an explicit world" and "explicit worlds can actually be created, identified, listed, and torn down." Treat §5.3 (bounding `generations` to `maxEntities`) as a deliberate follow-up once real multi-world memory pressure is observed, not a prerequisite.
