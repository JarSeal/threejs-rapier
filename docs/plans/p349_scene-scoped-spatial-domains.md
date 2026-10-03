Status: draft | not-implemented
Category: ECS, Spatial
Related: \_DONE_p346_spatial-domains.md (the domains this scopes), p102_physics-world-bounds.md (the same "a scene's own settings replace the app default while it's active" model), p353_macro-streaming-grid.md (its `STREAMING` domain belongs to the streamed scene), p348_ecs-lod-selection.md and p308_terrain-scatter.md (per-scene static cell domains)

# Scene-Scoped Spatial Domains

Lets a spatial domain, and `DEFAULT`'s settings, belong to a scene: registered for that scene,
and removed (or, for `DEFAULT`, reverted) when it exits. Scenes can then tune their own cell sizes
without leaking them into the next scene, and a scene's domains stop outliving it.

All phases are non-breaking: a registration without a scene behaves exactly as today.

---

## 1. Why

p346 made domains belong to an ECS world, and the default world lives for the whole session:

- **Domains outlive their scene.** `largeWorld` registers `FOLIAGE`. After leaving it, `FOLIAGE`
  stays registered with 0 members in every later scene (its members are deleted by
  `clearNonPersistent()`, the domain isn't). There is no way to unregister a domain.
- **Settings stick.** A scene that wants a different `DEFAULT` cell size (a dense indoor level vs.
  an open landscape, for light culling) can call `setSpatialGridCellSize` in its scene code, and
  that works and is cheap (the loader runs the scene code before it creates the scene JSON's
  meshes and lights). But the next scene inherits the value, so every scene that cares has to set
  it, and one that doesn't gets whatever the previous scene left.
- **The tab's cell-size override is per domain id**, applied to every registration of that id in
  every scene (`setSpatialDomainOptionsOverride` in `_dbg__SpatialGrid.ts`). Tuning `DEFAULT` in
  one scene changes it everywhere and overrides each scene's own value.
- **The tab lists domains that aren't there.** Its dropdown includes every domain with saved
  settings, and selecting a domain once is enough to save settings for it. So `FOLIAGE (not
  registered)` shows in every scene after one visit to the tab in `largeWorld`.

## 2. What exists

- `core/Spatial/SpatialIndexSystem.ts`: `registerSpatialDomain(world, opts)` keeps
  `requested` (the app's settings) and `opts` (after the debug override) per domain. Non-default
  domains get a mask bit from `byBit.length` (0-30), and bits are never freed. `DEFAULT` is
  created lazily with `cellSize` 20 and `world.maxEntities` members (`defaultDomainOptions`).
  Re-registering with other settings re-creates the grid and re-inserts the current members.
- `core/SceneLoader.ts` `loadScene`, in order: `runOnSceneExit(prevSceneId)` and
  `runOnAllSceneExits()`, secondary worlds deleted, `ecsWorld.clearNonPersistent()`,
  `createCameras`, `resetPhysicsWorld`, `loadNextSceneAssets`, the scene code (`loadFn`),
  `setCurrentScene(sceneId)`, `createNextSceneObject3Ds` (the JSON lights and meshes).
- Scene-scoped precedents: `createViewport({ sceneId })` and `createDebuggerTab({ sceneId })`
  are removed on that scene's exit, by an `onAllSceneExits` hook.
- `schemas/sceneSchema.ts`: `SceneOverridesSchema` holds the scene's own fields (`postFxEnabled`,
  `backgroundColor`, the asset registries), overridable per save entry.

## 3. Design

### 3.1 Scope

```ts
registerSpatialDomain(world, {
  id: 'FOLIAGE',
  cellSize: 16,
  maxMembers: 1500,
  update: 'STATIC',
  sceneId: 'largeWorld', // new, optional
});

unregisterSpatialDomain(world, 'FOLIAGE'); // new
```

`sceneId` is a scope, not a setting: it isn't compared when deciding whether a re-registration
changed anything. Each domain keeps two layers of settings:

- **World settings**: the last registration without `sceneId`. For `DEFAULT` it defaults to
  today's (`cellSize` 20, `world.maxEntities`). Other domains have none until one is registered.
- **Scene settings**: the last registration with `sceneId`, at most one at a time. It wins while
  it exists.

On the exit of scene `S`, every domain whose scene settings belong to `S` drops them:

- with world settings (always for `DEFAULT`): it goes back to them (a re-registration, so a
  changed cell size re-creates the grid);
- without: it is unregistered.

A world-level registration while scene settings are active only updates the world layer; the
scene's settings stay in effect until the scene exits. A scene registration for a different
scene than the current or loading one is allowed but warned about in the debug env (it would
stay until that other scene exits).

### 3.2 When the exit runs

Not in an `onAllSceneExits` hook: those run before `clearNonPersistent()`, so reverting `DEFAULT`
there would re-insert the whole old scene's membership into the new grid only to delete it right
after. Instead the loader calls one function right after `clearNonPersistent()`:

```ts
releaseSceneSpatialDomains(world, prevSceneId); // SceneLoader.ts, default world
```

At that point only persistent entities are left, so a reverted grid re-inserts just those, and
it happens before the next scene's assets, scene code and JSON objects join anything. Secondary
worlds need nothing: the loader deletes them on every scene change.

A persistent entity in a domain that is unregistered leaves it (its bit is cleared). That's
documented, not warned about: persistence is about the entity, the domain is the scene's.

### 3.3 Unregistering and bit reuse

`unregisterSpatialDomain(world, id)`:

- `DEFAULT` can't be unregistered (dev warning, no-op): its membership is `SPATIAL_INDEXED`,
  which other code adds. Scene settings are how a scene changes it.
- Every entity with the domain's bit has it cleared (one pass over `SPATIAL_DOMAINS`' storage,
  removing the component when the mask reaches 0). Then the grid, the oracle state and the
  domain's registry entries are dropped.
- The bit is freed: `byBit[bit]` becomes empty, and a new domain takes the lowest free bit.
  `leaveMaskedDomains` and the other bit loops skip empty entries. Since every holder's bit was
  cleared, a reused bit can't carry a stale membership.

### 3.4 Scene JSON

```json
{
  "id": "largeWorld",
  "spatialDomains": [
    { "id": "DEFAULT", "cellSize": 24 },
    { "id": "FOLIAGE", "cellSize": 16, "maxMembers": 1500, "update": "STATIC" }
  ]
}
```

- A new optional `spatialDomains` array in `SceneOverridesSchema` (its own Zod schema in
  `schemas/`). `DEFAULT` takes a partial entry (merged over its world settings); other domains
  need `cellSize` and `maxMembers`.
- The loader registers them with `sceneId` = the next scene, right after
  `releaseSceneSpatialDomains`, so every grid is created once at its final size before anything
  joins it.
- Code registrations stay the way to size a domain from runtime data (eg. `maxMembers` from a
  scatter count).

### 3.5 Debug tab

- The override function gets the registration's scope: `(world, requested, sceneId?)`. The tab
  saves a cell size for the scope it was edited in: `domains[id].cellSize` for a world-level
  registration (as today), `domains[id].cellSizeByScene[sceneId]` for a scene-scoped one. Lookup
  is scene first, then the id-wide value, so existing saved values keep applying and need no
  migration.
- A read-only "Scope" row: `world` or `scene: largeWorld`.
- The dropdown lists the registered domains, plus unregistered ones only when they have a saved
  cell size for the current scene or id-wide (so it can still be seen and cleared). An
  unregistered selection shows `DEFAULT`, and the saved selection is kept, so it comes back when
  the domain is registered again.
- "Reset to the app's cell size" clears the override of the current scope.

## 4. Phases

### Phase 1 — Unregister and bit reuse

1. `unregisterSpatialDomain` (§3.3), freed bits reused lowest first, the bit loops skip empty
   entries.

**Exit:** register a domain, join entities, unregister it, register another: it gets the same
bit, and none of the old members reports membership in it (`isInSpatialDomain`, the oracle).

### Phase 2 — Scene scope

1. `sceneId` in `SpatialDomainOptions`, the world and scene settings layers (§3.1).
2. `releaseSceneSpatialDomains`, called by `SceneLoader` after `clearNonPersistent()` (§3.2).
3. `largeWorld` registers `FOLIAGE` with `sceneId: 'largeWorld'`.

**Exit:** after `largeWorld` → Top-down test, `FOLIAGE` isn't registered. A scene that sets
`DEFAULT`'s cell size with its `sceneId` gets it; the next scene gets 20 again, and the revert
re-inserts only persistent members. The oracle stays clean in both domains.

### Phase 3 — Debug tab

1. The scoped override, the "Scope" row, the dropdown rules (§3.5).

**Exit:** a cell size tuned for `DEFAULT` in one scene doesn't change it in another. A fresh
Top-down test visit lists only `DEFAULT`.

### Phase 4 — Scene JSON

1. The `spatialDomains` schema and field (§3.4), the JSON Schema regenerated by
   `gatherAppData`.
2. The loader applies them after `releaseSceneSpatialDomains`.

**Exit:** a scene sets `DEFAULT`'s cell size in its `*.scene.json`; the grid is created once at
that size (no re-creation during the load), and the next scene is back to 20.

## 5. Versioning

Engine minor (new API, new scene JSON field). App patch (`largeWorld`). The toolkit is untouched:
`InstancedMeshPool.spawn` already looks the domain up when it spawns.

Docs: CLAUDE.md's Spatial index section (scopes, the loader step), `readme.md` (the Spatial index
line: per scene; the scene JSON field if it lists them).

## 6. Open questions

1. Should a registration during a scene load default to that scene (`getNextSceneId()`), as sky
   boxes do? It's what a scene's code almost always means, but it changes what an existing call
   does. This plan keeps `sceneId` explicit; a later major could flip the default.
2. Should world settings also come from `AppConfig` (`spatial.defaultCellSize`,
   `spatial.defaultMaxMembers`)? It would answer p346 §7 Q1 (`DEFAULT`'s 4.5 MB at
   `world.maxEntities`) through the same layer.
3. With `spatialDomains` in `SceneOverridesSchema`, a save entry can override it. Should the tab
   get a "save to scene JSON" button for a tuned cell size, like other debug tabs write
   `__saveData`? Not in this plan.
