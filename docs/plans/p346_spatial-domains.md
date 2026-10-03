Status: in progress | Phases 1-2 implemented
Category: ECS, Spatial
Epic: p350_lod-system-research.md (Tier 0)
Blocks: p353_macro-streaming-grid.md (Phase 1: shared cell maths; Phase 4: per-cell entity lookup)
Related: \_DONE_p050_spatial-index.md (this is its Phase 4: §5 static/dynamic split and §5.1 per-domain grids), p348_ecs-lod-selection.md, p308_terrain-scatter.md (static cells), p420_npc-simulation-tiers.md (NPC perception queries)

# Spatial Domains — Several Spatial Grids per World

Turns the one spatial grid per ECS world into **named domains**: separate `SpatialGrid` instances,
each with its own cell size, capacity and update policy, which entities join explicitly. The
existing grid becomes the `DEFAULT` domain, and everything that uses it today keeps working
unchanged.

It also fixes three gaps the LOD research found in the current index (p350 §4): no radius getter,
radii that go stale on a scale change, and instanced-pool instances that can't be indexed.

All phases are non-breaking.

---

## 1. Why now

`_DONE_p050_spatial-index.md` deliberately left per-domain grids for "Phase 4, only if measured",
with the trigger "a second consumer needing very different cell-size tuning". There are now
several, with very different needs:

| Consumer                                | Members                      | Cell size | Changes          |
| --------------------------------------- | ---------------------------- | --------- | ---------------- |
| Light object culling (today)            | meshes, point/spot lights    | ~20 m     | every frame      |
| NPC perception (p420)                   | NPCs, the player             | ~5 m      | every frame      |
| Static scatter / LOD cells (p308, p348) | cell entities, static props  | 16–64 m   | at load only     |
| Streaming ownership (p353)              | live entities owned by cells | 128–256 m | as entities move |

One cell size can't serve these. A 5 m grid holding a level's static props rebuilds thousands of
unmoving members every frame; a 256 m grid makes every NPC perception query return a crowd.

## 2. What exists

- `core/Spatial/SpatialGrid.ts`: the instantiable grid (sparse, CSR, zero-allocation queries,
  oversized tier, 17-bit-per-axis packed cell keys). It has no ECS knowledge.
- `core/Spatial/SpatialIndexSystem.ts`: the ECS wiring.
  - One grid per world in a `WeakMap`, created lazily, `cellSize` 20, `maxMembers` =
    `world.maxEntities` (100k by default: roughly 45 bytes per slot, ~4.5 MB).
  - Membership is the boolean `SPATIAL_INDEXED` component; its hooks add and remove members.
    `MeshManager.ts:225` and `LightManager.ts:357` add it unless
    `entityOpts.spatialIndex === false` (`schemas/_helperSchemas.ts:82`).
  - `computeSpatialRadius` handles meshes (bounding sphere × max scale) and point/spot lights
    (influence radius), and is called **only on add**.
  - `spatialIndexRebuildSystem` (`APP_POST_PHYSICS`, order -1) refreshes every member's position
    and rebuilds the whole grid every frame.
  - `setSpatialGridCellSize` swaps in a re-sized grid (debug).
- `core/Debug/_dbg__SpatialGrid.ts`: the "Spatial index" tab: stats, occupancy histogram, live
  cell-size control (LS-persisted), brute-force oracle, cell and oversized overlays. Default world
  only.
- `SpatialGrid.updateRadius` calls `_recomputeMaxIndexedRadius`, an O(n) scan, on every call. Fine
  when radii are set once; O(n²) if radii are refreshed every frame.

## 3. Design

### 3.1 Domains

```ts
type SpatialUpdatePolicy = 'DYNAMIC' | 'STATIC' | 'MANUAL';

registerSpatialDomain(world, {
  id: 'NPC',
  cellSize: 5,
  maxMembers: 2048,
  update: 'DYNAMIC',
  oversizedRadiusMultiplier?: 2,
});

getSpatialDomain(world, 'NPC'): SpatialGrid | undefined;
```

- A domain belongs to one world. Registering an existing id with the same settings is a no-op;
  with different settings it re-creates the grid and re-inserts the members (the same path the
  debug cell-size control uses today).
- `DEFAULT` is registered lazily, exactly as the grid is today (`cellSize` 20, `maxMembers` =
  `world.maxEntities`). `getSpatialGrid(world)` stays as the `DEFAULT` accessor.
- **Update policies:**
  - `DYNAMIC`: today's behaviour. Positions refreshed and the grid rebuilt every frame by
    `spatialIndexRebuildSystem`.
  - `STATIC`: positions are read when an entity joins and when the domain is invalidated. The grid
    is rebuilt only in a frame where the domain is dirty (a member joined or left, or
    `invalidateSpatialDomain(world, id)` was called). `ECSWorld.clearNonPersistent()` empties it
    through the delete hooks. This is p050 §5's static half.
  - `MANUAL`: never rebuilt automatically. The owner calls `rebuildSpatialDomain(world, id)`. For
    p353, which updates ownership on its own schedule.
- The rebuild system iterates registered domains in registration order, in the same stage slot as
  today, so every query in `APP_LOGIC` / `APP_RENDER_SYNC` sees this frame's state.
- A `world` that registers no domain and opts nothing in pays nothing, as today.
- Capacity: `addMember` past `maxMembers` throws today. Domains other than `DEFAULT` refuse the
  member with one dev warning per domain instead, and `joinSpatialDomain` returns `false`.

### 3.2 Membership

`SPATIAL_INDEXED` stays and keeps meaning "member of `DEFAULT`". Other domains use one new
component:

| Component         | Kind                | Data                                                     |
| ----------------- | ------------------- | -------------------------------------------------------- |
| `SPATIAL_DOMAINS` | runtime bookkeeping | `{ mask: number }`: bit _i_ = member of domain index _i_ |

```ts
joinSpatialDomain(entityId, domainId, world): boolean;
leaveSpatialDomain(entityId, domainId, world): void;
isInSpatialDomain(entityId, domainId, world): boolean;
```

- Domain ids map to a per-world index (at most 31 non-default domains, so the mask fits a small
  integer). The functions update the grid directly and keep the mask current; the component is
  added on the first join and removed on the last leave.
- `SPATIAL_DOMAINS`' `onDeleteEntity` hook removes the entity from every domain in its mask.
- Why not one component per domain: components are declared statically in the registries, and
  domains are runtime configuration. Why not route `DEFAULT` through the mask too: it would change
  `SPATIAL_INDEXED`'s meaning and its JSON flag for no gain. `SPATIAL_INDEXED`'s hooks call the
  same internal join/leave, so there is one code path.
- An entity can be in several domains (a mesh in `DEFAULT` for light culling and in a streaming
  domain for ownership).

### 3.3 Radius providers

`computeSpatialRadius`' hard-coded `instanceof` chain becomes a provider table, mirroring
`ObjectFrustumCullingSystem.ts`'s `boundingVolumeProviders`:

```ts
registerSpatialRadiusProvider(componentType, (entityId, world) => localRadius | undefined);
```

- Engine providers: `TAG_IS_MESH` (geometry bounding sphere), `TAG_IS_POINT_LIGHT` and
  `TAG_IS_SPOT_LIGHT` (influence radius, scale-independent).
- **Toolkit provider:** `InstancedMeshPool.ts` registers one for `INSTANCED_MESH_SLOT` (the pool
  geometry's bounding sphere). Registration from the toolkit keeps the engine from importing the
  toolkit. `CreateInstancedMeshPoolOptions` gets `spatialDomain?: string`, and `spawn` joins each
  instance to it. Pool instances are then indexable, which they aren't today.
- A provider returns the **local** radius. Grids store it, and the world radius is
  `local × max(|scale|)`, taken from the `Transform` the rebuild already reads. A scale change is
  picked up on the next rebuild instead of never. Lights opt out of scaling (their provider marks
  the radius absolute).
- `SpatialGrid` changes: `getRadius(entityId)`, a `setRadiusNoRecompute` used by the rebuild, and
  `maxIndexedRadius` recomputed once at the end of `rebuild()` (which already loops every slot)
  instead of on every `updateRadius`. `updateRadius` keeps its behaviour for direct callers.

### 3.4 Shared cell maths

The cell maths moves out of `SpatialGrid.ts` into `core/Spatial/CellKey.ts`, unchanged:
`worldToCell`, `packCellKey`, `unpackCellKey` (today inlined in `cellBoundsVisitor`), the axis
constants, and a `cellBounds(key, cellSize, out)` helper. `SpatialGrid` imports it. p353's
streaming cells and p308's static instance cells use the same keys, so a cell key means the same
thing everywhere for a given cell size.

At 17 bits per axis, a 256 m streaming cell covers ±16,000 km, far past where 32-bit float
precision fails (p350 §9 Q3).

### 3.5 Queries

Unchanged: `queryVisit` / `queryInto` / AABB variants on the domain's grid, candidates not
results. A caller that needs both a static and a dynamic domain (p050 §5's "one facade") queries
both. Each grid dedups its own candidates with its own stamps; an entity is in at most one of a
static/dynamic pair by convention, so no cross-grid dedup is needed. A facade can be added when a
second caller needs it.

### 3.6 Debug tab

`_dbg__SpatialGrid.ts` gets a domain dropdown at the top. Stats, histogram, oracle and overlays
apply to the selected domain; the cell-size control re-registers that domain. Overlay colour per
domain, so two domains' overlays can be shown at once. The LS-persisted settings become a map by
domain id (the old flat `cellSize` is read as `DEFAULT`'s).

## 4. Phases

### Phase 1 — Extract and fix, no behaviour change — done

1. `CellKey.ts` (§3.4).
2. `getRadius`, `maxIndexedRadius` recomputed once per rebuild (§3.3, grid side).

**Exit:** the oracle shows no mismatches in `debugScene` and `largeWorld`; the "Spatial index"
tab's rebuild time is the same or lower.

As built:

- No `setRadiusNoRecompute`. `addMember`, `removeMember` and `updateRadius` are all O(1) now:
  they only ever raise `maxIndexedRadius` (a conservative bound, so queries between rebuilds get
  extra candidates, never missed ones), and `rebuild()` makes it exact in its first loop. Phase 2's
  rebuild calls plain `updateRadius`. This also removes the O(n²) re-insert in
  `setSpatialGridCellSize`, which called the O(n) recompute on every `addMember`.
- `CellKey.ts` also exports `isCellInRange` (the grid keeps its one-time out-of-range warning around
  the now-pure `packCellKey`), `unpackCellKey` writes into an `out` object, and `cellBounds` takes
  an `offset` (the grid writes 6 floats per cell into one array).
- `debugScene` (`testDebugScene`) has no meshes or indexed members, so it can't exercise the
  oracle. `largeWorld` (26 members) showed no mismatches, also on 2000 direct random
  `validateSpatialGridQuery` calls.

### Phase 2 — Domains and membership — done

1. `registerSpatialDomain`, `getSpatialDomain`, `DYNAMIC` policy, `DEFAULT` routed through the
   registry (§3.1).
2. `SPATIAL_DOMAINS`, join/leave, delete hook (§3.2).
3. Radius providers, scale-aware radii (§3.3), and the toolkit's pool provider and `spatialDomain`
   option.
4. Debug tab domain dropdown (§3.6).

**Exit:** `largeWorld` registers a `FOLIAGE` domain for its tree pool. The tab shows both domains,
and light culling (on `DEFAULT`) is unchanged.

As built:

- `SpatialUpdatePolicy` is only `'DYNAMIC'`; Phase 3 widens it. `registerSpatialDomain` returns
  nothing, and `getSpatialDomain` never creates a domain (`getSpatialGrid` still creates
  `DEFAULT` lazily). An app can register `DEFAULT` itself before its first member to set its
  settings. Extra getters for the tab: `getSpatialDomainIds`, `getSpatialDomainOptions`.
- The rebuild loops over each grid's own members (`SpatialGrid.memberAt(index)`), not over the
  membership components.
- Mask bits are 0-30; a 32nd non-default domain throws. Re-registering with a smaller
  `maxMembers` drops the members past it from a non-default domain (bit cleared) and throws for
  `DEFAULT` before changing anything. `SPATIAL_DOMAINS` also has an `onRemoveComponent` hook, so
  removing it directly leaves every domain in the mask. `joinSpatialDomain`/`leaveSpatialDomain`/
  `isInSpatialDomain` with `DEFAULT` add, remove or check `SPATIAL_INDEXED`.
- Radii: the mesh and pool providers return `|center| + radius` of the geometry's bounding
  sphere (`getConservativeGeometryRadius`), so off-centre geometry is covered (the `largeWorld`
  crate stack: 1.885 → 2.667). The local radius is cached per domain (`localRadius`, scaled
  members only), not in the grid. `SpatialGrid.updateRadius` returns early for an unchanged
  radius. `refreshSpatialRadius(entityId)` re-reads a member's radius after what its provider
  measures changed; the debug Lights tab's distance edits call it.
- The pool's component keys and data moved to `toolkit/ecs/InstancedMeshPoolTypes.ts` (which
  `AppECSRegistry.ts` imports), so `InstancedMeshPool.ts` left the `ECSCoreComponents ↔
  AppECSRegistry` import cycle and can import `SpatialIndexSystem`. It re-exports the types.
- The oracle is per domain (`setSpatialGridOracleEnabled(world, enabled, domainId?)` and so on,
  plus `getOracleCheckedQueryCount`). While on, it also runs 8 probe queries near random members
  every frame, from the system loop (not the rebuild), so a domain nobody queries yet, and a
  Phase 3 `STATIC` domain between rebuilds, is checked too. It logs the first 10 mismatches.
- Tab settings are `{ selectedDomain, domains: { [id]: { cellSize?, showCells, cellsColor,
  showOversized, oversizedColor } } }`; the old flat keys migrate into `DEFAULT` (its cell size
  only when it wasn't 20). A cell size set in the tab is a debug override
  (`setSpatialDomainOptionsOverride`) applied on every registration, so it holds when the app
  registers the domain again; "Reset to the app's cell size" re-registers with the settings the
  app asked for (`reapplySpatialDomainOptions`). The grid is re-created only on a finished edit,
  not per drag tick. Non-default domains' overlay colors come from a palette by id.

### Phase 3 — Static and manual policies

1. `STATIC` and `MANUAL` (§3.1), `invalidateSpatialDomain`, `rebuildSpatialDomain`.
2. Rebuild time per domain in the tab, and the frames each domain actually rebuilt.

**Exit:** `largeWorld`'s `FOLIAGE` domain as `STATIC` rebuilds once at load and then never, and the
oracle stays clean.

## 5. Not in this plan

From p050's Phase 4: AABB-overlap insert (replacing query expansion) and incremental updates from
`Transform.version`. Both stay deferred until the tab's numbers ask for them.

## 6. Versioning

Engine minor (new API, new core component). Toolkit minor (`InstancedMeshPool`'s
`spatialDomain` option and radius provider). App patch, if `largeWorld` adopts it.

## 7. Open questions

1. Should `DEFAULT`'s capacity stay `world.maxEntities`? It's what keeps today's behaviour, but
   it's also 4.5 MB of typed arrays for a grid that usually holds a few hundred members. A
   follow-up could make it `AppConfig.spatial.defaultMaxMembers`.
2. Should `TYPED_ARRAY` storage mode feed positions to the rebuild as a strided copy (p050 §6's
   `copyPositionsTo`)? Only if a domain's rebuild time shows the per-entity `getPosition` cost.
