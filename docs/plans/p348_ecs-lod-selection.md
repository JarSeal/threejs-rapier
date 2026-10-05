Status: in progress | Phases 1-4 implemented, Phase 5 step 1
Category: ECS, Rendering, LOD
Epic: p350_lod-system-research.md (Tier 1.3)
Blocks: p351_impostor-billboard-lod.md (needs Phase 3's per-level instanced pools), p354_gpu-driven-culling.md
Related: \_DONE_p346_spatial-domains.md (pool instances indexable; static domains for cells), p308_terrain-scatter.md (its static instance cells are Phase 4's contract), p240_client-device-capability-sniffer.md (global LOD bias), \_DONE_p345_gpu-memory-and-draw-call-debugger.md

# ECS LOD Selection & Apply

The core of the LOD epic. A system picks a level per entity from its projected screen size, with
hysteresis, and the render side applies it:

- a plain mesh entity swaps its geometry and material;
- an instanced-pool instance moves to the pool of its new level;
- a static instance cell (p308) switches the whole cell's geometry.

Levels past the last one hide the entity through the same visibility reconcile as frustum
culling. `THREE.LOD` is not used (p350 §2).

---

## 1. Grounding

- **Visibility** (`ECS/ECSCoreSystems.ts:22`): `reconcileObject3DVisibility` sets
  `.visible = !DISABLED && !TAG_FRUSTUM_CULLED && !TAG_OBJECT_CULLED`. Each reason is a tag whose
  add/remove hook calls the reconcile.
- **Render-sync order** (`AppECSRegistry.ts:101`): `POSE_PRODUCERS` 0, `POSE_CONSUMERS` -0.5,
  `SHADOW_FIT` -0.75, `FRUSTUM_CULLING` -1, `LIGHT_CULLING` -2 (higher runs earlier).
  `object3DSyncSystem` runs at the default order with the producers.
- **Frustum culling** (`ECS/ObjectFrustumCullingSystem.ts`): opt-in per entity, uses
  `getMainCamera()` (never the debug camera), early-out on an empty storage, mesh bounds from
  `getMeshWorldBoundingSphere`.
- **Meshes** (`core/MeshManager.ts`): `createMeshEntity` resolves `geo` / `mat` ids or inline
  definitions (`schemas/meshSchema.ts`), takes registry refs, and supports `preWarm`
  (`compileAsync`, `MeshManager.ts:137-165`).
- **Instanced pools** (`toolkit/ecs/InstancedMeshPool.ts`, now `core/Instancing/`, Phase 3): one `InstancedMesh` per pool, one
  entity per instance holding `INSTANCED_MESH_SLOT { mesh, index, _lastVersion }`,
  `instancedMeshPoolSyncSystem` at `APP_RENDER_SYNC`. **No despawn**: slots are only appended,
  and `computeBoundingSphere()` over every instance runs after each `spawn`.
- **Cameras:** perspective and orthographic main cameras both exist.
- **No TAA** in the PostFX chain, which matters for cross-fades (p351).

## 2. Data

### 2.1 Components

| Component        | Kind                  | Data                                                                                  |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `LOD`            | opt-in, user-authored | `{ def: LodDef, level: number, applied: number, radius: number }`                     |
| `TAG_LOD_CULLED` | runtime-only          | the entity is beyond its last level; a fourth reason in `reconcileObject3DVisibility` |

- `level` is the selection, `applied` is what the render side last applied (`-1` before the first
  apply). The apply step only touches entities where they differ, so there is no per-frame write
  for an entity whose level holds.
- Why not a separate `LOD_LEVEL` component (the draft's split): the level changes far more often
  than the definition, and adding/removing a component per change costs more than a field write.
  The opt-in vs runtime split is kept where it matters, for visibility (`TAG_LOD_CULLED`), which
  goes through hooks like the other cull reasons.
- `radius` is the local bounding radius of level 0, cached at opt-in (the same value p346's radius
  provider gives); the world radius is `radius × max(|scale|)`.

### 2.2 Definition

```ts
type LodLevelDef = {
  /** Smallest screen size (bounding-sphere diameter / viewport height) this level is used at. */
  screenSize: number;
  geo?: string; // registered geometry id; level 0 defaults to the mesh's own
  mat?: string; // registered material id; omitted = the previous level's material
  castShadow?: boolean; // omitted = the previous level's
};

type LodDef = {
  levels: LodLevelDef[]; // level 0 first, screenSize descending
  /** Below this screen size the entity is hidden (TAG_LOD_CULLED). 0 = never hidden. */
  cullScreenSize?: number;
  hysteresis?: number; // default 0.1
  bias?: number; // multiplies the screen size; >1 keeps detail longer. Default 1.
};
```

- `mat` per level is p350 §5.1's point: far levels drop the normal map or use a cheaper node
  material, which matters more than triangles on a GPU-bound scene.
- `castShadow: false` on far levels is the only shadow LOD (p350 §9 Q1).

## 3. Selection

### 3.1 Metric

Screen size = projected bounding-sphere diameter as a fraction of the viewport height:

- Perspective: `screenSize = worldRadius / (distance × tan(fov / 2))`. Resolution-independent and
  FOV-correct: zooming in (a scope) keeps detail, which a raw distance can't.
- Orthographic: `screenSize = 2 × worldRadius × zoom / (top − bottom)`. Distance doesn't matter.
- The camera terms are computed once per frame. Per entity it's one distance and one multiply.
- The effective screen size is `screenSize × def.bias × globalBias`. `globalBias` is
  `AppConfig.lod.bias` (default 1), settable at runtime with `setLodBias`, which is where p240's
  device level plugs in.

Rejected: authoring levels in metres. It's familiar, but it breaks under FOV changes and with
orthographic cameras, and p347's chains give error-derived screen sizes for free (§5). The debug
tab shows each threshold's equivalent distance at the current FOV instead.

### 3.2 Hysteresis

Moving to a **finer** level happens at `levels[i].screenSize`. Moving to a **coarser** level
happens only below `levels[i].screenSize × (1 − hysteresis)`. The same rule applies to
`cullScreenSize`. Without it an entity on a boundary flips every frame.

### 3.3 The system

`lodSelectionSystem` at `APP_RENDER_SYNC`, order `APP_RENDER_SYNC_ORDER.LOD_SELECTION = -1.5`
(new): after frustum culling, so it skips entities culled this frame and sees the final camera;
before light culling, which doesn't depend on it.

- Early-out when the `LOD` storage is empty.
- `getMainCamera()`, like the culling systems. A debug option switches to the active camera, to
  inspect levels with the debug camera without changing what the game camera sees.
- Skips `DISABLED` and `TAG_FRUSTUM_CULLED` entities, keeping their last level. Because frustum
  culling runs first, an entity re-entering the view gets a fresh level in the same frame: no pop
  from a stale level. Frustum-culled entities don't cast shadows today either (their
  `.visible` is false), so skipping them doesn't change shadows.
- **Budget:** `AppConfig.lod.maxSelectionsPerFrame` (default `Infinity`). With a cap, the system
  walks the storage round-robin from where it stopped, so each entity is reconsidered every few
  frames. The selection is cheap (§3.1), but the storage walk isn't free in JS for 50k+ entities.
- Writes `level`, and adds/removes `TAG_LOD_CULLED`.

## 4. Apply

`lodApplySystem`, same stage, right after selection. Only entities with `level !== applied`.

### 4.1 Plain meshes

- Swap `mesh.geometry` and `mesh.material` to the level's registered assets, and set
  `castShadow`. The `LOD` component took a registry ref on every level's geometry and material
  when it was added and releases them on removal, so a level's assets live as long as the entity
  and are released with the scene like any other.
- **Pre-warm:** a swap to a material the renderer has never drawn compiles a pipeline in that
  frame. When the mesh has `preWarm`, every level is pre-warmed (`compileAsync` per level
  material), not just level 0.
- Bounds: frustum culling keeps using level 0's geometry bounds (levels share them within the
  simplifier's error), so a swap never changes culling.

### 4.2 Instanced pools

A new API next to `createInstancedMeshPool` (an engine API since Phase 3 step 3):

```ts
createInstancedLodPool({
  world, levels: [{ geometry, material, castShadow? }, ...],
  maxInstances, lod: Omit<LodDef, 'levels'> & { screenSizes: number[] },
}): InstancedLodPool; // spawn(world, placements) like InstancedMeshPool
```

- One `InstancedMesh` per level, each sized `maxInstances`. An instance is in exactly one of them.
  The instance entity has `INSTANCED_MESH_SLOT` (pointing at its current level's mesh) and `LOD`.
- **Moving an instance** between levels: swap-remove from the old level's mesh (the last instance
  moves into the hole, and its entity's slot index is patched through a per-mesh `slot → entity`
  array), then append to the new level's mesh. Both meshes' `count` and `instanceMatrix` update
  once per frame, not per move.
- **Despawn** on `InstancedMeshPool` uses the same swap-remove. It's added to the existing pool
  too (`despawn(entityId)`, plus an `onDeleteEntity` hook on `INSTANCED_MESH_SLOT`), since
  deleting a pooled entity today leaves its matrix drawn.
- **Bounds:** recomputing `computeBoundingSphere()` over all instances on every move would be
  O(n) per frame. Instead, every level mesh gets the bounding sphere of _all_ placements once at
  spawn (the union doesn't change when instances move between levels).
- `TAG_LOD_CULLED` for a pooled instance removes it from every level mesh (there is no
  per-instance `.visible`).

### 4.3 Static instance cells (contract for p308)

p308's `StaticInstances` cells have no per-instance entities. Their LOD unit is the cell: one
entity per cell with `LOD` and a radius covering the cell, and the apply swaps the cell's
`InstancedMesh` geometry for the whole cell. This replaces p308's `maxDistance` with
`cullScreenSize` (a one-level LOD when the cell has no other levels).

The contract (Phase 4, built ahead of p308): a cell is an `InstancedMesh` in `OBJECT3D` with
`TAG_IS_MESH`, set up like a pool's mesh entity:

- `mesh.userData.entityId` set when the mesh took registry refs on its geometry and material(s),
  so the level swaps (`setMeshGeometry` / `setMeshMaterial`) move them;
- instance matrices and `count` written before `setMeshLod`, and `refreshLodBounds(entityId)`
  called after they change;
- `mesh.userData.preWarm` for pre-warmed levels.

The selection then measures the cell, not one instance: `radius` and the centre it measures the
distance from are level 0 over every instance (`Lod/LodBounds.ts`), transformed by the mesh's world
matrix. `AUTO` thresholds use that radius over the largest instance scale (an instance's error
scales with its matrix), so `maxPixelError` holds at the cell's centre; instances nearer the camera
show more.

### 4.4 `BatchedMesh` (spike)

Spike, half a day: does `@three.ez/batched-mesh-extensions`' `addGeometryLOD` work under
`WebGPURenderer` r186 (its per-instance uniforms are documented as WebGL-only), and does it beat
§4.2 on draw calls for a scene with many different assets? Record the outcome here. §4.2 doesn't
depend on the answer.

Run it once, as p375's Phase 0 (`p375_batched-mesh-batches.md`), which also answers p309's decal
pool risk. Known already (p370 §2.1): on WebGPU r186 a `BatchedMesh` is one draw call per visible
member, so it can't beat §4.2's one draw per level on draw count; the question is CPU cost.

## 5. JSON and generated chains

`meshSchema` gets `lod`:

```json
"lod": {
  "levels": [
    { "screenSize": 0.25 },
    { "screenSize": 0.08, "geo": "rock01_lod1", "mat": "rock01_noNormal" },
    { "screenSize": 0.02, "geo": "rock01_lod2", "castShadow": false }
  ],
  "cullScreenSize": 0.004
}
```

or `"lod": "AUTO"` (or `{ "auto": true, "maxPixelError": 1, "cullScreenSize": 0.004 }`), which
reads the geometry's p347 chain. Each level's screen size comes from its error: a level is
used while its world-space error `error × extent` (p347's error is relative to the chain's
`extent`, the base's largest bounding box side) projects to at most `maxPixelError` pixels at a
reference viewport height of 1080. This needs no per-asset tuning, and the global bias still
scales it.

How a chain is made stays on the asset, not the mesh (p347 Phase 2): an `*.importedAsset.json`'s
`lodChain` generates the chains of its geometries after the import, and code-made geometry calls
`generateLodChain`. `meshSchema` gets no `lodChain`. Several meshes can share a geometry, and its
one chain would have to pick one mesh's options. Decided: `lod: 'AUTO'` on a geometry without a
chain warns and stays on level 0 (generating one with the default options would hide a missing
`lodChain` and cost a simplify at the first mesh). A chain that's still requested or pending when
the mesh is created keeps it on level 0 until it resolves.

Code: `setMeshLod(entityId, def, world)` / `removeMeshLod(entityId, world)` in `MeshManager.ts`,
and the same `lod` option on `createMeshEntity`'s props.

## 6. Debug

A "LOD" debug drawer tab (`core/Debug/_dbg__LOD.ts`):

- Counts per level and culled, selections and applies last frame, selection time.
- Global bias slider (runtime only, not persisted), freeze (stop selecting), force level _N_ for
  all, "use active camera" (§3.3).
- Overlay: a coloured wire box per LOD entity by level, drawn with the line system, for entities
  in view only.
- Per-mesh: a screen-size readout and each threshold's equivalent distance at the current FOV
  (§3.1).

## 7. Phases

### Phase 1 — Core — done

1. `LOD`, `TAG_LOD_CULLED` (fourth reason in `reconcileObject3DVisibility`), the order constant.
2. Selection (§3) and plain-mesh apply (§4.1), with ref counting and pre-warm.
3. `setMeshLod` / `createMeshEntity`'s `lod` option.
4. Debug tab counts, bias, freeze, force level (§6).

**Exit:** a debugScene test mesh with three hand-made levels (sphere segment counts) switches
without flicker at the boundaries, also with the camera stopped right on a threshold, and FOV
zoom keeps level 0.

As built:

- Exit test passed (WebGPU, headless Chrome, driven frame by frame through the app's modules).
  The test mesh is `p348LodSphere` in `debugScene.scene.ts`: radius 0.5, 64×32 / 16×8 / 6×4
  segments, green / yellow / red, level 2 without shadows, `cullScreenSize` 0.01.
  - A sweep from 2 m to 150 m and back, 0.5% per frame, makes exactly the six expected
    transitions, each within one step of its threshold distance at fov 50. The mesh always
    shows the applied level's geometry, material and `castShadow`.
  - Stopped exactly on each of the six thresholds, coming from either side, for 120 frames:
    no swap and no visibility change. Jitter of ±3% every frame on each threshold: at most one
    change.
  - Zooming to fov 10 keeps level 0 at 8 m (level 1 at fov 50) and at 15 m (level 2 at fov 50).
    `camera.zoom` 5 does the same.
  - Bias, freeze and force level behave as specified, including a forced level past the cull
    distance and a clamp to the last level. `removeMeshLod` goes back to level 0 and releases
    the other levels' geometries (refcount 0, removed from the registry).
- Code lives in `core/Lod/LodTypes.ts` (types only) and `core/Lod/LodSystem.ts` (hooks,
  systems, bias, debug controls). `LodData` has a fifth field, `_levels`: `def.levels` resolved
  against the registries when the component is added. Omitted `geo` / `mat` / `castShadow` come
  from the previous level (level 0: the mesh's own), and a missing id warns and keeps the
  previous level's.
- `radius` is `getConservativeGeometryRadius` of level 0's geometry (`|center| + radius`,
  `Spatial/SpatialIndexSystem.ts`), the same value the spatial radius provider uses.
- Refs: the mesh holds one ref on what it shows (moved by `setMeshMaterial` and the new
  `setMeshGeometry` in `MeshManager.ts`), and the component one on every level's assets, so
  deletion releases them in any hook order. Removing the component restores level 0 and removes
  `TAG_LOD_CULLED`.
- Pre-warm: `createMeshEntity`'s compile was extracted to `preWarmMesh` (`MeshManager.ts`), and
  `preWarm` is remembered on `mesh.userData.preWarm`, so a LOD added later pre-warms too. Each
  distinct geometry/material/`castShadow` combination is compiled once through a stand-in mesh.
- Both systems run at `APP_RENDER_SYNC_ORDER.LOD_SELECTION` (-1.5). Registration order puts
  selection first. Selection hands the changed entities to apply through a per-world pending list.
- `setLodBias` / `getLodBias` and `AppConfig.lod.bias` landed here, not in Phase 5. Phase 5 still
  has `maxSelectionsPerFrame` and the overlay.
- `setMeshLod` replaces an existing LOD (it removes the old one first, back to level 0). The
  definition is read, not copied.
- Debug controls are engine API, applied to every world: `setLodDebugOptions` /
  `getLodDebugOptions` with `freeze`, `forceLevel` (wins over freeze, unhides LOD-culled
  entities, clamps to an entity's last level) and `useActiveCamera` (§3.3's option, built here).
  `getLodFrameStats(world)` gives selections, swaps (last frame and total) and the selection
  time, which is measured only in the debug environment.
- The tab (`core/Debug/_dbg__LOD.ts`, id `lodControls`, last in the default tab order, `lod`
  icon) covers the default world. It shows on-screen entities per level, plus LOD culled, out of
  view (disabled or frustum-culled) and the total, along with the last frame's stats and the
  controls. Nothing is persisted.

### Phase 2 — JSON and `AUTO` — done

1. `lod` in `meshSchema` (§5), compiled into `.schemas/`.
2. `AUTO` from p347 chains.

As built:

- Schema (`schemas/lodSchema.ts`): `LodDefSchema` (levels strictly descending, checked with a
  path to the offending level), `LodAutoDefSchema` and `MeshLodDefSchema` (either, or `'AUTO'`),
  each `satisfies` its hand-written type in `Lod/LodTypes.ts`. The mesh props and the per-scene
  overrides both take it (an override replaces the whole `lod`).
- Types: `LodAutoDef` is `{ auto: true, maxPixelError? }` plus `cullScreenSize`, `hysteresis` and
  `bias` (passed through); `MeshLodDef = LodDef | LodAutoDef | 'AUTO'` is what `setMeshLod` and
  `createMeshEntity`'s `lod` take. The `LOD` component only ever holds a concrete `LodDef`: `AUTO`
  is resolved before the component is added, so selection and apply didn't change.
- Thresholds (`Lod/LodAuto.ts`, `lodDefFromChain`): chain level k is fine while
  `s ≤ 2 × radius × maxPixelError / (error_k × extent × 1080)`, `radius` being the LOD radius
  (`getConservativeGeometryRadius`, what the component caches). Level i is used down to where the
  next kept level becomes fine; the last level's `screenSize` is 0. A level the next one is never
  worse than (errors not increasing) is dropped. A chain without levels gives a one-level LOD when
  `cullScreenSize` is set, else nothing (warned).
- `setMeshLod` with `AUTO` loads `Lod/LodAuto.ts` on demand (like `LodChains`; a static import
  would also close a cycle MeshManager → SpatialIndexSystem → SceneLoader → MeshManager) and
  returns `Promise<boolean>`: whether the LOD was set (a concrete def resolves true at once).
  Until then the mesh has no `LOD`. A later `setMeshLod` / `removeMeshLod` cancels the wait
  (per-world `pendingAutoLods`), as does deleting the entity or swapping its geometry.
- The race §5 didn't name: an import's `lodChain` generation only starts once `LodChains` has
  loaded, after `importAssetAsync` resolved, so a mesh created right after the import (every JSON
  mesh, SceneLoader) found neither a chain nor a pending one. `Lod/LodChainRequests.ts`
  (import-free) tracks a request from the moment `requestLodChains` makes it, and `AUTO` awaits it
  and then `getPendingLodChain` (new in `LodChains.ts`) before reading the chain.
- Verified in the dev app (WebGPU, headless Chrome, through the app's modules): Suzanne imported
  with `lodChain: { permissive: true }` and a mesh created synchronously after the import (the
  request tracked, no chain yet) gets `AUTO` levels once the chain lands, with thresholds equal to
  the formula (1 px at 1080 for both levels); a sweep around each threshold switches at
  `t` and `t × 0.9`, not inside the hysteresis band, and culls below `cullScreenSize`. A geometry
  without a chain warns and gets no LOD; `generateLodChain` pending at `setMeshLod` is awaited;
  `removeMeshLod`, a replacing `setMeshLod` and deleting the entity all resolve the wait to false.
- The debug tab is unchanged: it shows `AUTO` meshes like any other once their LOD is set.

### Phase 3 — Instanced pools — done

1. `InstancedMeshPool.despawn` and the delete hook (§4.2). — done
2. `createInstancedLodPool`. — done
3. Move the pool into the engine (`core/Instancing/`), with deprecated toolkit re-exports. — done
4. largeWorld's trees and bushes on LOD pools with p347 chains. — done (hand-made levels, see As built)

**Exit:** largeWorld's draw-call count is unchanged (one draw per level per pool), its triangle
count drops (p345), and frame time doesn't rise with 3,500 instances selecting every frame.

As built:

- The engine's `LOD` hooks handled plain meshes only, so the pool plugs in through a new engine
  seam: `registerLodTarget(componentType, target)` with `LodTarget` (`resolveLevels`,
  `applyLevel`, `setCulled`) in `Lod/LodTypes.ts`, and `LodData._target`. An entity without a
  plain mesh gets its levels from the first target registered for one of its components; its
  `Transform` gives the selection its world position and scale, and the target owns its levels'
  assets (the component takes no refs). Apply and the `TAG_LOD_CULLED` hooks call the target.
  Removing `LOD` drops the culled tag first, then goes back to level 0.
- `createInstancedLodPool({ world, levels: [{ geometry, material, screenSize, castShadow? }],
maxInstances, lod?, receiveShadow?, entityOpts?, spatialDomain? })`: `screenSize` is per level
  instead of the sketch's `lod.screenSizes` array, and `lod` is `Omit<LodDef, 'levels'>`. It returns
  `{ meshes, meshEntityIds, spawn, despawn }`; add `pool.meshes` directly under the scene.
  Instances spawn into level 0's mesh. A LOD-culled instance is in no mesh (`index -1`), its slot
  still pointing at the applied level's mesh, and comes back with a matrix built from its
  `Transform`. `maxInstances` counts live instances across levels and culled ones. Bounds: the
  union of every placement's, from the union of every level's geometry bounds, extended at each
  spawn and copied to every level mesh.
- Both pools take a registry ref on their geometry and material(s), which the `TAG_IS_MESH` delete
  hook releases (before, the pool released a ref it never took).
- Not done: pre-warm for pool levels (every level in use compiles in the first frame, since
  instances move before the first render); per-instance colours aren't carried between levels.
- Step 3: the pool is `core/Instancing/InstancedMeshPool.ts`, its component the core
  `ComponentType.INSTANCED_MESH_SLOT` (`CORE_INSTANCED_MESH_SLOT`, data in
  `Instancing/InstancedMeshPoolTypes.ts`), and its sync system registers itself
  (`APP_RENDER_SYNC`, `POSE_PRODUCERS`) when the module loads. `spawn` takes the engine's
  `InstancePlacement` (`ScatterPlacement` is one). `toolkit/ecs/InstancedMeshPool.ts` and
  `InstancedMeshPoolTypes.ts` are deprecated re-exports (the enum with the core key, and a no-op
  `registerInstancedMeshPoolEffect`) until the toolkit's next major version.
- Verified (WebGPU, headless Chrome, through the app's modules): 300 instances over 1-180 m with
  bias sweeps, a forced level, moved instances, despawn / delete / `LOD` removal / slot removal and
  a respawn past `maxInstances` keep every live instance in its applied level's mesh or culled,
  no shared slots, every matrix equal to its `Transform`, and mesh counts + culled = live; the
  first selection matches the formula exactly. largeWorld's pool refs are 1 inside the scene and
  released on exit.
- Step 4 doesn't use p347 chains. p347's Phase 0 measured these two geometries: the tree (30
  triangles) and the bush (120) produce no levels at any setting, `permissive` included. Their
  levels are hand-made from the same generators at lower segment counts, so the silhouette holds
  (the bush's blobs are placed by its seed, not its segment count):
  - Trees: `radialSegments` 5 (30 triangles), then 3 (18), level 1 below screen size 0.04
    (about 145 m at scale 1 from the overview camera, fov 60).
  - Bushes: 5 segments (120 triangles), then 3 (36), level 1 below 0.03 (about 75 m), hidden
    below `cullScreenSize` 0.012 (past about 200 m with the hysteresis).
  - Every level casts shadows. The trees keep their `FOLIAGE` spatial domain.
- The exit's draw-call wording contradicts itself: with levels, a pool draws once per non-empty
  level per material group in each pass, so "unchanged" can't hold. largeWorld goes from 82 to 91
  draws per frame from the overview camera: 3 more non-empty level meshes (tree level 1 with 2
  groups, bush level 1) in each of 3 passes.
- Exit measured (WebGPU, headless Chrome, 1600×900, through the app's modules; "before" is level
  0 forced for every instance, the old pools' content):
  - Overview camera: foliage triangles 285,000 → 90,948 (trees 874 / 626 at levels 0 / 1, bushes
    69 / 1,255, 676 hidden), renderer triangles per frame 1,035,676 → 453,520. Follow camera:
    173,184 foliage triangles, 32 bushes hidden. The overview looks the same apart from the far
    bushes thinning out.
  - Selection of the 3,500 instances every frame took about 1.0 ms. Per entity,
    `lodSelectionSystem` looked each storage up again (`hasComponent` / `getComponent`) and
    looked up an `OBJECT3D` a pool instance never has. It now reads its five storages once per
    frame and goes straight to a target entity's `Transform` (the `LodTarget` contract), which
    brought it to about 0.5-0.65 ms with identical results. The way the loop iterates the
    storage doesn't matter (a Node micro-benchmark: about 100 µs per 3,500-entry pass either
    way). The remaining cost, about 0.15 µs per instance, is Phase 5's (`maxSelectionsPerFrame`,
    §9 Q1). The whole-frame CPU varies too much between headless runs (±0.5 ms) to show it.

### Phase 4 — Static cells — done

1. The cell contract (§4.3), with p308. — done ahead of p308 (engine side; p308's adoption is its own)

As built:

- p308 isn't built (draft, blocked by p306 ← p305), so this phase built the engine side of the
  contract and checks it with a hand-made cell. §4.3's old claim, that §4.1 already handled an
  `InstancedMesh` cell, didn't hold. Gaps found and closed:
  - Bounds: the radius was one instance's geometry and the distance was measured from the mesh's
    origin. `Lod/LodBounds.ts` (`getInstancedLodBounds`) gives level 0's sphere over every
    instance, centred on their bounding box, in mesh space. It's tighter than
    `InstancedMesh.computeBoundingSphere`, whose incremental union depends on the instance order
    (24% too large on a 5×5 grid). `LodData._center` holds the centre; the selection transforms it
    by the world matrix for these entities only, so the plain-mesh hot path is unchanged.
    `refreshLodBounds(entityId, world?)` (`LodSystem.ts`) re-reads it.
  - Pre-warm: the stand-in was a plain `Mesh`, another pipeline. An `InstancedMesh`'s stand-in is
    an `InstancedMesh` sharing its `instanceMatrix`, `instanceColor` and `count`. Every stand-in is
    now `frustumCulled = false`: `compileAsync` culls against its own camera at the origin, which
    would skip a cell far from it.
  - Refs: `setMeshGeometry` / `setMeshMaterial` move refs only for a mesh with
    `userData.entityId`. A pool's mesh took refs without it, so a swap on it would have leaked one
    and released another twice. `createPoolMesh` sets it now, which also makes `deleteScene`
    delete a pool's mesh entity like a plain mesh's.
  - `AUTO`: the thresholds came from one geometry's radius while the selection measures the cell.
    `resolveAutoLod` takes the mesh and uses the bounds' radius over the largest instance scale.
- The check is `p348LodCell` in `debugScene.scene.ts`: 25 small spheres on the Phase 1 sphere's
  levels, away from the mesh's origin, built as p308 would (an `InstancedMesh` entity, refs taken
  by hand). Verified (WebGPU, headless Chrome, through the app's modules): exact bounds (radius
  1.2814, centre at the grid's); a 2-400 m sweep makes the six transitions within a step of their
  thresholds, the whole cell swapping, `count` and matrices untouched; scale 2 and a rotation move
  the thresholds and centre with the matrix; `refreshLodBounds` after squeezing the instances
  changes the level; re-setting the LOD pre-warms levels 1 and 2 on instanced stand-ins; deleting
  the cell at level 2 releases exactly its refs; `AUTO` on a cell matches
  `lodDefFromChain(chain, R / maxInstanceScale)`. Phase 1's exit test (40/40) and Phase 3's pool
  test (no errors in any state) still pass.
- Not changed: the ECS frustum culling and light culling bounds (`getMeshWorldBoundingSphere`)
  and the spatial radius provider still read one instance's geometry at the mesh's origin, so a
  cell must not opt into ECS frustum culling or spatial indexing as is (p308's D1 relies on three's
  per-object culling, which reads `mesh.boundingSphere`). Also, §4.1's "frustum culling keeps using
  level 0's bounds" isn't what the code does: `getMeshWorldBoundingSphere` reads the geometry the
  mesh shows. Chain levels' bounds are within the simplifier's error of level 0's.

### Phase 5 — Budget and spike

1. `maxSelectionsPerFrame` round-robin, `setLodBias`, the overlay.
   - a. `maxSelectionsPerFrame` — done (`setLodBias` landed in Phase 1)
   - b. The overlay, and §6's per-mesh readout. — done
2. The `BatchedMesh` spike (§4.4).

As built (step 1a):

- `AppConfig.lod.maxSelectionsPerFrame` (default `Infinity`), `setLodMaxSelectionsPerFrame` /
  `getLodMaxSelectionsPerFrame`, applied per world. A value below 1 warns and means no cap. A
  forced level ignores the cap.
- The capped walk keeps an iterator of the `LOD` storage across frames, per world. The `LOD`
  storage is always a `Map` (`TYPED_ARRAY` mode swaps only `TRANSFORM`), whose iterators survive
  deletes and adds. A frame stops after the cap's selections or one full lap, so a frame where most
  entities are out of view doesn't walk the storage twice. Skipped entities (disabled, frustum
  culled) cost a walk step but not a selection.
- §3.3's "an entity re-entering the view gets a fresh level in the same frame" doesn't hold for a
  plain round-robin: the entity would keep the level it had when it left until its turn. Hooks on
  `TAG_FRUSTUM_CULLED` and `DISABLED` removal, and the `LOD` add hook, queue the entity (only while
  there is a cap), and the selection takes the queue first, past the cap. Queued selections count
  against the cap, and the walk gets what's left (it can get nothing in a frame where many entities
  came into view). Frozen or without a camera, the queue is dropped: those entities wait for the walk.
- `LodFrameStats.lapFrames`: the frames the last full lap took (1 without a cap), how long an
  entity in view can show a stale level. The tab shows it, and a "Max selections / frame" list
  (no cap, 100-10,000, plus a value the app set) with a reset button. Runtime only, like the bias.
- Verified (WebGPU, headless Chrome, through the app's modules):
  - Re-entry, cap 1: 100 plain LOD meshes with ECS frustum culling held their level behind the
    camera, then moved into view at 2-150 m in one frame. Their first frame in view had 100
    selections and every mesh on the level (and LOD-culled state, and geometry) that an uncapped
    selection settled on afterwards. The same through `setDisabled(true)` → move →
    `setDisabled(false)`.
  - largeWorld, 3,500 pool instances, overview camera: selection 0.667 ms per frame uncapped,
    0.122 ms at a cap of 500 (500 selections per frame, a 7-frame lap). Switching between the
    overview and the follow camera at cap 500, the levels differed from the uncapped result in
    1,624 / 1,418 / 1,230 / 929 / 615 / 299 instances over the first six frames and matched from
    the seventh on (both directions). With the camera still, the capped result equals the uncapped
    one.

As built (step 1b):

- `LodSystem.ts` measures through one function, `measureEntity` (the world position and largest
  scale), used by the selection and by two debug exports: `getLodWorldSphere(entityId, lod, world,
out)` (level 0's sphere in world space, no camera) and `measureLodEntity(entityId, world, out)`
  (the sphere plus distance, screen size and `k` against `getLodSelectionCamera()`, both biases
  included). The camera terms became `computeCameraTerms(camera, out)`; `DEFAULT_LOD_HYSTERESIS` is
  exported.
- Overlay (`core/Debug/Lod/_dbg__LodOverlay.ts`, the tab's "Overlay" folder, runtime only): a box
  around the sphere the selection measures, per `LOD` entity shown (not disabled, frustum-culled or
  LOD-culled) and inside the selection camera's frustum, pool instances included. A line has one
  colour, so there is one 1px FIXED line per colour (green, yellow, orange, red, magenta, then blue
  for every level from 5), 8,192 boxes each, created on the first enable, persistent and marked for
  the census. Not at `LATE_MAIN` as the spatial grid's: that stage runs after the render, so the boxes
  would be a frame late. It refills at `APP_RENDER_SYNC`, `LOD_SELECTION` order, registered after
  the apply. It also fills once when switched on, since the app loop (and the system) may be paused.
  A line without boxes is hidden (an empty draw warns on WebGPU).
- §6's per-mesh readout is a draggable window per entity (`core/Debug/Lod/_dbg__LodEntityWindow.ts`):
  the entity's kind, state, the selection's overrides and camera, the live screen size, distance and
  world radius, and a table of levels with their screen size, triangles and switch distances. "in ≤"
  is `worldRadius × k / screenSize`, where the row is taken coming from a coarser one; "out >" is that
  over `1 − hysteresis`, where it's left. The same for culling; orthographic shows none. There was no
  mesh window to add it to (the engine has none), so it opens from the tab: a list of the LOD meshes
  (pool instances are too many; at most 100 rows), a "Nearest in view" button that reaches pool
  instances too, and an `EntityWindowOpener` (priority -1) for the profiler's heaviest objects. It
  refreshes every 250 ms and closes on a scene change (entity ids don't survive one).
- Verified (WebGPU, headless Chrome, through the app's own module instances, each LOD system
  registered once):
  - `p348LodSphere`'s window gives 3.57 / 3.97 m, 10.7 / 11.9 m and cull 107 / 119 m at fov 50. Sweeps
    in 1.4% steps switch at 3.544, 10.688 and 106.03 m inward and 4.012, 11.95 and 120.04 m outward,
    each within a step.
  - largeWorld, overview camera: the overlay's boxes per level (585 / 1,824) equal the shown
    instances inside the camera's frustum counted independently; 676 LOD-culled ones are left out.
    Off hides every line, and on while the app loop is paused fills them at once.
  - "Nearest in view" opens a tree instance's window (level 0, 188 / 209 m at fov 60).

## 8. Versioning

Engine minor (components, systems, schema, mesh API, the instanced pools with `despawn` and
`createInstancedLodPool`). Toolkit patch (the deprecated pool re-exports). App patch for
largeWorld's adoption and the pool's import path.

## 9. Open questions

1. Should `level` move into `TYPED_ARRAY` storage when `ecs.storageMode` allows it (p350's old open
   question)? Only if Phase 5's numbers show the storage walk dominating.
2. Cross-fades between levels are p351's (they need a per-instance fade value and a dithered
   material). Until then switches are instant, which hysteresis keeps rare.
