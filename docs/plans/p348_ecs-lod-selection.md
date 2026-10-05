Status: in progress | Phases 1-2 implemented
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
- **Instanced pools** (`toolkit/ecs/InstancedMeshPool.ts`): one `InstancedMesh` per pool, one
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

A new toolkit API next to `createInstancedMeshPool`:

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
`cullScreenSize`. Implemented when p308 lands. This plan only fixes the contract, so p308 can
build its cells as plain mesh entities that §4.1 already handles.

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

### Phase 3 — Instanced pools

1. `InstancedMeshPool.despawn` and the delete hook (§4.2).
2. `createInstancedLodPool`.
3. largeWorld's trees and bushes on LOD pools with p347 chains.

**Exit:** largeWorld's draw-call count is unchanged (one draw per level per pool), its triangle
count drops (p345), and frame time doesn't rise with 3,500 instances selecting every frame.

### Phase 4 — Static cells

1. The cell contract (§4.3), with p308.

### Phase 5 — Budget and spike

1. `maxSelectionsPerFrame` round-robin, `setLodBias`, the overlay.
2. The `BatchedMesh` spike (§4.4).

## 8. Versioning

Engine minor (components, systems, schema, mesh API). Toolkit minor (`createInstancedLodPool`,
`despawn`). App patch for largeWorld's adoption.

## 9. Open questions

1. Should `level` move into `TYPED_ARRAY` storage when `ecs.storageMode` allows it (p350's old open
   question)? Only if Phase 5's numbers show the storage walk dominating.
2. Cross-fades between levels are p351's (they need a per-instance fade value and a dithered
   material). Until then switches are instant, which hysteresis keeps rare.
