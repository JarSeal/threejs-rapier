## Domains

Each ECS world holds named domains, each its own grid with its own cell size, capacity and
update policy. An entity can be in several.

- **`DEFAULT`** is the engine's. Meshes and point and spot lights join it by default (a mesh
  created with `spatialIndex: false` doesn't), and the engine culls lights with it. Its grid is
  built per scene, only once something is in it.
- **Your own** domains hold what your game asks about:

```ts
const world = getECSWorld();
registerSpatialDomain(world, {
  id: 'pickups',
  cellSize: 10, // About the size of a typical query
  maxMembers: 512,
  update: 'STATIC', // Rebuilt only when a member joins or leaves
  sceneId: 'myScene', // These settings end with the scene
});
joinSpatialDomain(pickupId, 'pickups', world);
```

## Queries

A query returns candidates, not results: every member whose cell the sphere or box touches. Test
the real distance yourself. Nothing is allocated, so a query is safe in a hot loop:

```ts
const candidates = new Uint32Array(64); // Allocated once, reused every frame
const grid = getSpatialDomain(world, 'pickups');
const count = grid ? grid.queryInto(playerPosition, 3, candidates) : 0;
for (let i = 0; i < Math.min(count, candidates.length); i++) {
  const entityId = candidates[i];
  // …the exact test, then the pickup
}
```

`queryVisit` calls a function per candidate instead, and `queryAABBInto` / `queryAABBVisit` take
a box. A member whose radius is over twice the cell size (`oversizedRadiusMultiplier`) goes into
an oversized tier that every query checks, so one huge object doesn't slow the grid down.

## Keeping it current

| Update policy | The grid is rebuilt                                         | For                   |
| ------------- | ----------------------------------------------------------- | --------------------- |
| `DYNAMIC`     | Every frame, with fresh positions.                          | Things that move.     |
| `STATIC`      | In a frame where a member joined or left.                   | Things that stay put. |
| `MANUAL`      | Only on [`rebuildSpatialDomain`](api:rebuildSpatialDomain). | You decide when.      |

The rebuild runs at `APP_POST_PHYSICS`, so it sees this frame's physics poses.
[`invalidateSpatialDomain`](api:invalidateSpatialDomain) refreshes a `STATIC` domain whose
members moved. A member's radius comes from its component (a mesh's geometry, a light's range),
scaled by its transform; [`refreshSpatialRadius`](api:refreshSpatialRadius) reads it again after
a geometry change, and [`registerSpatialRadiusProvider`](api:registerSpatialRadiusProvider) gives
your own components one.

## Scene settings

Registered with a `sceneId`, a domain's settings are that scene's: they replace the domain's
world settings until the scene exits, and then the domain goes back to them, or is removed if it
had none. A scene's JSON can do the same with `spatialDomains`; `largeWorld` widens the default
grid's cells:

```json
{ "spatialDomains": [{ "id": "DEFAULT", "cellSize": 24 }] }
```

Instanced pool instances can join a domain too (the pool's `spatialDomain` option): see
[LOD and impostors](hub:features/lod#many-instances).

## The debug tab

The drawer's Spatial index tab works per domain: its cells and members drawn over the scene, the
rebuild times, a cell size to try out (kept for the world or for one scene), and a brute-force
check that compares every query with a full scan.

## Key APIs

- [`registerSpatialDomain`](api:registerSpatialDomain) and
  [`unregisterSpatialDomain`](api:unregisterSpatialDomain).
- [`joinSpatialDomain`](api:joinSpatialDomain) and [`leaveSpatialDomain`](api:leaveSpatialDomain).
- [`getSpatialDomain`](api:getSpatialDomain) and [`getSpatialGrid`](api:getSpatialGrid) (the
  `DEFAULT` grid, built if needed).
- [`SpatialGrid.queryInto`](api:SpatialGrid.queryInto) and
  [`SpatialGrid.queryVisit`](api:SpatialGrid.queryVisit).

## Read more

- The API reference: [Spatial](hub:documentation/engine/core/Spatial).

::: claude-md
:::
