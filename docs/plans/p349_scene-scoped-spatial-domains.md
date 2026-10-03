Status: in progress | Phases 1-3 implemented
Category: ECS, Spatial
Related: \_DONE_p346_spatial-domains.md (the domains this scopes), p102_physics-world-bounds.md (the same "a scene's own settings replace the app default while it's active" model), p353_macro-streaming-grid.md (its `STREAMING` domain belongs to the streamed scene), p348_ecs-lod-selection.md and p308_terrain-scatter.md (per-scene static cell domains)

# Scene-Scoped Spatial Domains

Lets a spatial domain, and `DEFAULT`'s settings, belong to a scene: registered for that scene,
and removed (or, for `DEFAULT`, reverted) when it exits. Scenes can then tune their own cell sizes
without leaking them into the next scene, and a scene's domains stop outliving it. `DEFAULT`'s
grid itself becomes per scene too: built when the scene first needs it, freed when it exits, so
a scene that indexes nothing never pays for one.

All phases are non-breaking: a registration without a scene behaves exactly as today, and the
`DEFAULT` API keeps working (only the lifetime of its grid changes).

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
- **`DEFAULT`'s grid outlives every scene.** Once one scene creates it, it stays allocated at
  `world.maxEntities` slots (~4.5 MB, p346 §7 Q1) for the session, also in scenes that index
  nothing. Registering `DEFAULT`'s settings allocates it too, so a scene that only wants to set a
  cell size would create the grid for the rest of the session.

## 2. What exists

- `core/Spatial/SpatialIndexSystem.ts`: `registerSpatialDomain(world, opts)` keeps
  `requested` (the app's settings) and `opts` (after the debug override) per domain. Non-default
  domains get a mask bit from `byBit.length` (0-30), and bits are never freed. `DEFAULT` is
  created lazily with `cellSize` 20 and `world.maxEntities` members (`defaultDomainOptions`), by
  its first `SPATIAL_INDEXED` member, a `getSpatialGrid` call or a registration, and never
  dropped. Re-registering with other settings re-creates the grid and re-inserts the current
  members.
- `DEFAULT`'s only engine consumer is `core/ECS/LightObjectCullingSystem.ts`, which calls
  `getSpatialGrid(world)` (so it would create the grid) for every light with object culling.
  Every other consumer (`InstancedMeshPool`, `largeWorld`'s `FOLIAGE`, p353/p348/p308) uses a
  named domain.
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
  joins it. `DEFAULT`'s entry only stores its scene settings (§3.6); its grid is built by the
  scene's first join, already at those settings. Other domains are allocated at registration:
  listing one is asking for it.
- Code registrations stay the way to size a domain from runtime data (eg. `maxMembers` from a
  scatter count).

### 3.5 Debug tab

- The override function gets the registration's scope: `(world, requested, sceneId?)`. The tab
  saves a cell size for the scope it was edited in: `domains[id].cellSize` for a world-level
  registration (as today), `domains[id].cellSizeByScene[sceneId]` for a scene-scoped one. Each
  scope gets only its own value: a scene's settings never fall back to the id-wide one (a scene
  without its own value gets the app's). Existing saved values were all saved for world settings
  and keep applying to them, so they need no migration. The one exception is a value saved for a
  domain that later became scene-scoped (`FOLIAGE`, Phase 2); it no longer applies there.
- A read-only "Scope" row: `world` or `scene: largeWorld`.
- The dropdown lists the registered domains, plus unregistered ones only when they have a saved
  cell size for the current scene or id-wide (so it can still be seen and cleared). An
  unregistered selection shows `DEFAULT`, and the saved selection is kept, so it comes back when
  the domain is registered again.
- "Reset to the app's cell size" clears the override of the current scope.

### 3.6 `DEFAULT`'s grid per scene

`DEFAULT` stays the engine's built-in domain (light object culling's, joined by the default-on
`spatialIndex` flag), but its grid lives for one scene at most. Its settings layers (§3.1) live
for the session; only the grid comes and goes.

- **Built on demand.** By the first join (a `SPATIAL_INDEXED` component added) or an explicit
  `getSpatialGrid` call, with the settings in effect at that moment. A build inserts every
  current `SPATIAL_INDEXED` holder, so persistent members from earlier scenes are back in it.
  The entity whose join triggered the build is already in storage when its hook runs
  (`ECSWorld.addComponent` stores before it calls the hooks), so it goes in with the others, and
  the hook's own insert is an update (`addMember` on an existing member).
- **Freed on every scene change.** `releaseSceneSpatialDomains` drops `DEFAULT`'s scene settings
  (as now) and then its grid, also on the first load (no previous scene; today it returns early
  without one). The next scene builds a new one if it needs it.
- **Settings without a grid.** Registering `DEFAULT` (`registerSpatialDomain`,
  `setSpatialGridCellSize`, the scene JSON) while it has no grid stores the layer and allocates
  nothing. With a grid it works as today (a changed setting re-creates it).
- **Light culling doesn't build it.** `LightObjectCullingSystem` reads `getSpatialDomain(world,
  DEFAULT_SPATIAL_DOMAIN)`, and no grid means no candidates. Since every `SPATIAL_INDEXED` holder
  builds the grid, no grid means no indexed receivers, so the result is the same as an empty
  grid, without allocating one. (Point and spot lights are indexed by default, so a scene with
  one has the grid anyway.)

What the public calls see:

| Call | With a grid | Without |
|---|---|---|
| `getSpatialDomain(world, 'DEFAULT')` | the grid | undefined |
| `getSpatialGrid(world)` | the grid | builds it |
| `getSpatialDomainOptions(world, 'DEFAULT')` | the settings in use | the settings it would be built with |
| `getSpatialDomainSceneId(world, 'DEFAULT')` | the scope | the scope (scene settings can exist without a grid) |
| `getSpatialDomainIds(world)` | includes `DEFAULT` | doesn't |
| `registerSpatialDomain` / `setSpatialGridCellSize` | re-creates the grid on a change | stores the settings |
| `isInSpatialDomain`, `joinSpatialDomain`, `leaveSpatialDomain` | `SPATIAL_INDEXED`, unchanged | same (a join builds the grid) |

Debug state across builds: the oracle's on/off is kept (keyed by domain id, as today); the
rebuild counts start over with each build. The tab always lists `DEFAULT`; without a grid it
shows `DEFAULT (no grid)`, the settings it would be built with and empty stats. Its cell size
stays editable, since the scope is known, and an edit applies at the next build. A shown overlay
empties (Phase 1's rule for an unregistered domain).

Cost: an indexed scene builds `DEFAULT` on every visit, once, during its load: one allocation
and one insert per member, which its named domains already pay.

### 3.7 Alternative: no `DEFAULT` at all

Letting every scene declare all of its grids, with no built-in one, was considered and left for
a later major. The `spatialIndex` flag, `SPATIAL_INDEXED` and `getSpatialGrid` would change
meaning (an engine major), light culling would stop in any scene that doesn't declare its grid
(it would need a fallback or a warning), and persistent indexed entities would have to rejoin
each scene's grid. §3.6 gets the cost benefit (no scene pays for a grid it doesn't use) without
the break.

## 4. Phases

### Phase 1 — Unregister and bit reuse — done

1. `unregisterSpatialDomain` (§3.3), freed bits reused lowest first, the bit loops skip empty
   entries.

**Exit:** register a domain, join entities, unregister it, register another: it gets the same
bit, and none of the old members reports membership in it (`isInSpatialDomain`, the oracle).

As built:

- Unregistering an id that isn't registered is a quiet no-op (like deleting a stale physics
  body), not a warning.
- The tab's visualizer empties a shown overlay whose domain is no longer registered, instead of
  leaving its last contents on screen.

### Phase 2 — Scene scope — done

1. `sceneId` in `SpatialDomainOptions`, the world and scene settings layers (§3.1).
2. `releaseSceneSpatialDomains`, called by `SceneLoader` after `clearNonPersistent()` (§3.2).
3. `largeWorld` registers `FOLIAGE` with `sceneId: 'largeWorld'`.

**Exit:** after `largeWorld` → Top-down test, `FOLIAGE` isn't registered. A scene that sets
`DEFAULT`'s cell size with its `sceneId` gets it; the next scene gets 20 again, and the revert
re-inserts only persistent members. The oracle stays clean in both domains.

As built:

- The layers are `worldRequested` and `sceneRequested` on the domain (the single `requested` is
  gone); `applyDomainOptions` is the one path that puts the layer in effect (re-registration,
  release, `reapplySpatialDomainOptions`).
- `setSpatialGridCellSize(world, cellSize, sceneId?)`: without `sceneId` it builds on the world
  settings; with it, on that scene's settings when it has some, else on the world settings.
- `getSpatialDomainOptions` returns `ResolvedSpatialDomainOptions` (the settings in use, without
  `sceneId`).
- The "other scene" warning compares against the loading scene during a load and the current one
  otherwise (as sky boxes resolve theirs), so a load that registers for the scene it's leaving is
  warned about too: that scene's release has already run.
- The debug override still gets one cell size per domain id, applied to whichever layer is in
  effect, until Phase 3 (which scopes it).

### Phase 3 — Debug tab — done

1. The scoped override, the "Scope" row, the dropdown rules (§3.5).

**Exit:** a cell size tuned for `DEFAULT` in one scene doesn't change it in another. A fresh
Top-down test visit lists only `DEFAULT`.

As built:

- The override is `(world, settings, sceneId)`: the settings without the scope, and the scope
  separately (undefined for the world settings). It runs whenever settings take effect, with the
  scope of the layer in effect. `getSpatialDomainSceneId(world, id)` tells the tab that scope.
- No fallback from a scene's settings to the id-wide value (§3.5 as first written had one).
  With it, a scene without its own value showed the id-wide one, and Reset there had to choose
  between clearing a value shared by every scene and doing nothing. Without it, Reset clears
  only the shown scope's value and never changes another scene.
- The Domain dropdown binds a proxy of the shown domain, and choosing one writes
  `selectedDomain`. An unregistered domain that is listed shows its saved value. Its Scope row
  shows the current scene when that scene has a value saved, and `world` otherwise.
- Only a world-level `DEFAULT` exists in the app so far, and its tuned value is id-wide (the
  world scope). The exit check registered `DEFAULT` with a `sceneId` from code. Phase 5's scene
  JSON is the first non-code way to get a scene-scoped `DEFAULT`.

### Phase 4 — `DEFAULT`'s grid per scene

1. `DEFAULT`'s settings layers kept apart from its grid: registering without a grid stores
   them only (§3.6).
2. A build inserts every current `SPATIAL_INDEXED` holder.
3. `releaseSceneSpatialDomains` frees `DEFAULT`'s grid on every scene change, the first load
   included.
4. `LightObjectCullingSystem` reads `getSpatialDomain` and treats no grid as no candidates.
5. The tab's `DEFAULT (no grid)` state.

**Exit:** after `largeWorld` → a scene with no indexed entity and no point/spot light,
`getSpatialDomain(world, 'DEFAULT')` is undefined, and a JS heap snapshot holds no
`SpatialGrid` for it (the grid is CPU memory, so the GPU memory tab won't show it). A persistent indexed
entity is a member again once the next scene builds the grid. `setSpatialGridCellSize` in a
scene without a grid allocates nothing, and the grid that scene builds later has that cell size.
The oracle stays clean.

### Phase 5 — Scene JSON

1. The `spatialDomains` schema and field (§3.4), the JSON Schema regenerated by
   `gatherAppData`.
2. The loader applies them after `releaseSceneSpatialDomains`.

**Exit:** a scene sets `DEFAULT`'s cell size in its `*.scene.json`. The grid is built once, at
that size, by the scene's first join (no re-creation during the load), and the next scene is
back to 20. A scene that lists `DEFAULT` but indexes nothing has no grid.

## 5. Versioning

Engine minor (new API, new scene JSON field, `DEFAULT`'s grid per scene). App patch
(`largeWorld`). The toolkit is untouched: `InstancedMeshPool.spawn` already looks the domain up
when it spawns.

`DEFAULT`'s grid lifetime is a behavior change, not a break. `getSpatialDomain(world, 'DEFAULT')`
can now be undefined after a scene change where it used to return the old grid, but it was
always documented as "undefined if it isn't there", and readers are told to re-read the grid
where they use it. The changelog entry should still name it.

Docs: CLAUDE.md's Spatial index section (scopes, the loader step, and "`DEFAULT` is created
lazily" becoming "built per scene on demand, freed on every scene change"), `readme.md` (the
Spatial index line: per scene; the scene JSON field if it lists them).

## 6. Open questions

1. Should a registration during a scene load default to that scene (`getNextSceneId()`), as sky
   boxes do? It's what a scene's code almost always means, but it changes what an existing call
   does. This plan keeps `sceneId` explicit; a later major could flip the default.
2. Should world settings also come from `AppConfig` (`spatial.defaultCellSize`,
   `spatial.defaultMaxMembers`)? With §3.6 they'd be the template every `DEFAULT` build starts
   from, and `defaultMaxMembers` would answer p346 §7 Q1 (`DEFAULT`'s 4.5 MB at
   `world.maxEntities`): §3.6 frees that memory between scenes but doesn't make a build smaller.
3. With `spatialDomains` in `SceneOverridesSchema`, a save entry can override it. Should the tab
   get a "save to scene JSON" button for a tuned cell size, like other debug tabs write
   `__saveData`? Not in this plan.
4. Should a world-level non-default domain (registered without `sceneId`) also free its grid at
   a scene exit when it has no members left, and rebuild on its next join, like `DEFAULT`? It
   would make every grid pay-per-use, but the app registered it explicitly, so this plan keeps
   it allocated.
