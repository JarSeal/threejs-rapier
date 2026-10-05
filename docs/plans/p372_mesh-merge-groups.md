Status: draft | not-implemented
Category: Merging, ECS, Rendering
Epic: p370_static-mesh-merging-and-texture-atlas-systems.md (Tier 1.2)
Blocked by: p371_geometry-merging.md
Blocks: p373_merge-debug-and-member-editing.md, p374_multi-material-merging.md, p375_batched-mesh-batches.md, p376_hlod-merged-cluster-proxies.md
Related: \_DONE_p346_spatial-domains.md (cell maths, DEFAULT domain), \_DONE_p348_ecs-lod-selection.md (`LOD` members are refused until p376), p352_physics-simulation-tiers.md (static body sync), p353_macro-streaming-grid.md (groups stay inside a cell), p301_terrain-texturing-epic.md (the modular kit terrain page, Phase 5), \_DONE_p345_gpu-memory-and-draw-call-debugger.md

# Mesh Merge Groups

The "merge meshes" tool. Mesh entities that share a material are drawn as one merged mesh, owned
by a group entity, while each source mesh stays an entity with its own transform, physics body and
data. A member can be moved, removed or added later: its vertex range in the merged buffers is
rewritten in place.

Members join a group by id or automatically:

```json
{
  "props": { "geo": "ruinKit/wallStraight", "mat": "ruinStone", "position": [4, 0, 0] },
  "merge": "AUTO"
}
```

---

## 1. Grounding

- **Meshes** (`core/MeshManager.ts:81`): `createMeshEntity` builds a `THREE.Mesh`, adds `OBJECT3D`
  and `TAG_IS_MESH`, adds the mesh to the root scene (unless `doNotAddToScene`), sets `TRANSFORM`,
  and adds `SPATIAL_INDEXED` by default (`:224-226`). `object3DSyncSystem`
  (`ECS/ECSCoreSystems.ts:156`) copies `TRANSFORM` onto the Object3D every frame. `disposeMesh`
  (`:238`) releases the geometry and material refs.
- **Visibility** (`ECS/ECSCoreSystems.ts:22`): `reconcileObject3DVisibility(entityId, world,
overrides?)` sets `.visible` from `DISABLED`, `TAG_FRUSTUM_CULLED` and `TAG_OBJECT_CULLED`; each
  tag's hooks call it, with an `overrides` field for the tag being toggled.
- **Managed entities**: `CoreEntityOpts.managedBy` adds `MANAGED_BY { manager, ownerId, role }`
  (`ECS.ts:470`); debug tools treat managed entities as read-only.
- **Scene load** (`SceneLoader.ts`): `createNextSceneObject3Ds` (`:345`, called at `:580`) creates
  the scene JSON's meshes; then the enter hooks run (scene code creates its meshes there or in its
  init); then `settlePendingPhysicsEntities()` (`:610`) and `releasePhysicsStepping()`, while the
  loader is still shown.
- **Static bodies** (`PhysicsManager.ts:379-388`): `BODY_STATIC` transforms are synced and marked
  dirty every frame.
- **Render-sync order** (`AppECSRegistry.ts:101`): `POSE_PRODUCERS` 0, `POSE_CONSUMERS` -0.5,
  `SHADOW_FIT` -0.75, `FRUSTUM_CULLING` -1, `LIGHT_CULLING` -2 (higher runs earlier).
- **Cell maths** (`core/Spatial/CellKey.ts`): `worldToCell`, `packCellKey`, `cellBounds`.
- **Imported assets** share one engine material per asset (`SpawnImportedParams.material`), and
  Blender custom props already group physics nodes (`index`, `core/Import/ImportTypes.ts:71`).
- p371's `mergeGeometryParts` returns a merged geometry with a part table
  (`vertexStart/Count`, `indexStart/Count`, `key`).

## 2. Data

| Component      | On           | Data                                                                                              |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `MERGE_GROUP`  | group entity | `{ id, members: number[], cellKey?, settings, partIndex: Map<entityId, part>, wasted, rebuilds }` |
| `MERGE_MEMBER` | member       | `{ groupEntityId, groupId, partIndex }`                                                           |
| `TAG_MERGED`   | member       | runtime-only; a fourth (fifth with p348) reason in `reconcileObject3DVisibility`                  |

- **The group entity** is a plain mesh entity (`OBJECT3D` + `TAG_IS_MESH`, so `disposeMesh` and
  the profiler handle it) created with `managedBy: { manager: 'MERGE', ownerId: <scene or
caller>, role: 'group' }`. Its geometry is registered (`mergeGroup:<id>`), its material is the
  members' (one ref).
- **A member keeps everything** except being drawn: `TAG_MERGED` hides its own Object3D, and it
  leaves the DEFAULT spatial domain (its `SPATIAL_INDEXED` is removed and restored on leave).
  Its geometry and material refs stay, so leaving the group needs no reload.

## 3. API (`core/MergeGroups.ts`)

```ts
createMergeGroup(opts: { id: string; sceneId?: string; castShadow?: boolean; receiveShadow?: boolean }, world?): number;
addToMergeGroup(groupId: string, entityIds: number[], world?): void; // batched to the next build
removeFromMergeGroup(entityIds: number[], world?): void;
updateMergeMember(entityId: number, world?): void; // after the member's TRANSFORM changed
rebuildMergeGroup(groupId: string, world?): void;
dissolveMergeGroup(groupId: string, world?): void; // members drawn on their own again
getMergeGroupOf(entityId: number, world?): string | undefined;
```

- **Builds** are batched: adds and removes mark the group pending; `mergeGroupBuildSystem` at
  `APP_RENDER_SYNC` (new `APP_RENDER_SYNC_ORDER.MERGE_BUILD = 0.5`, before the pose producers)
  builds pending groups once per frame with `mergeGeometryParts` (or its worker variant above a
  vertex threshold, the members staying visible until the new mesh is in).
- **`updateMergeMember`** rewrites the member's range in place: positions by the new world matrix,
  normals and tangents by its normal matrix, then `attribute.addUpdateRange` + `needsUpdate` per
  attribute and a bounds refresh. No rebuild, no allocation; the vertex count doesn't change.
- **Remove** collapses the member's index range to degenerate triangles (one index write range)
  and counts the vertices as `wasted`. Past `max(wasted / total, 25%)` the group rebuilds compact.
- **Remerge is explicit**, never driven by `TRANSFORM` dirty flags: static bodies are marked dirty
  every frame (§1), so a dirty-flag trigger would rewrite every physics member every frame. A
  debug check (debug env only) compares a member's world matrix with its baked one every N frames
  and warns once per member that moved without `updateMergeMember`.

## 4. Options and JSON

### 4.1 `merge`

On `createMeshEntity` props, `meshSchema` (`MeshAssetSchema`, next to `props` / `entityOpts`) and
inline scene meshes:

```ts
merge?: string | 'AUTO' | { group?: string | 'AUTO'; cellSize?: number; maxVertices?: number };
```

- `"<groupId>"`: an explicit group. Created on first use with default settings, or from the
  scene's `mergeGroups` entry.
- `"AUTO"`: the engine picks the group from a **compatibility key** (material ref id, geometry
  attribute signature, `castShadow`, `receiveShadow`, layers, `renderOrder` when p309 adds it) plus
  the member's **cell** (`worldToCell` of its world position at `cellSize`, default 32 m) and a
  vertex cap (`maxVertices`, default 262 144). A full bucket opens a second group in that cell.
  `AUTO` group ids are derived (`auto:<key hash>:<cellKey>:<n>`).
- Groups are scene-scoped: created during a load, they belong to that scene and go with it;
  `persistent` members can only join groups created with `sceneId: undefined`.

### 4.2 Scene `mergeGroups`

```json
"mergeGroups": [
  { "id": "ruins", "castShadow": true },
  { "id": "AUTO", "cellSize": 48, "maxVertices": 131072 }
]
```

The `AUTO` entry sets the scene's defaults for automatic groups. A scene with `streaming` (p353)
gets an `AUTO` cell size that divides its streaming cell size (a dev warning otherwise), and an
explicit group whose members span two streaming cells is warned about.

### 4.3 Imported assets

- A `merge` custom prop on Blender nodes (`"AUTO"` or a group id), parsed with the other custom
  props (`core/Import/CustomProps.ts`), like `index` for compound bodies.
- `spawnImportedAsset` options: `merge: 'AUTO' | string` applies to every eligible node of the
  asset (the common case: one imported level, one material).

## 5. Eligibility

Refused with a dev warning naming the entity and the reason (it then renders on its own):

- skinned meshes, morph targets, `InstancedMesh` / pool instances;
- transparent materials (`material.transparent`), which need per-object sorting;
- material arrays (a multi-material mesh): merge with p374 instead;
- `BODY_DYNAMIC_*` and kinematic bodies;
- `managedBy` entities (their manager owns the Object3D);
- entities with `LOD` (p348) until p376;
- members whose geometry's attribute signature can't be unified (p371 D1 reports why).

## 6. Scene load

`buildSceneMergeGroups()` runs in `SceneLoader` after the enter hooks and before
`settlePendingPhysicsEntities()` (`:610`): by then the scene JSON's meshes and the scene code's
meshes exist, and the loader still hides the scene. It builds every pending group synchronously
(or awaits worker builds), so the first frame already draws merged. Physics members' transforms
are their creation transforms at that point (bodies spawn at the entity's `TRANSFORM`).

On scene exit, the group entities are deleted with the scene's non-persistent entities;
`disposeMesh` releases their geometry, and the members' refs go with the members.

## 7. Integration

- **Culling:** three culls the group mesh by its bounding sphere, and ECS frustum culling
  (`ecsFrustumCullingEnabled`) can be set on the group from its settings. Members are hidden, so
  their own culling flags do nothing while merged.
- **Spatial index:** the group entity is `SPATIAL_INDEXED` with its geometry radius (the mesh
  radius provider); `AUTO`'s cell size keeps it out of the oversized tier in a default grid.
- **Shadows:** a group casts and receives as its settings say; mixed members land in different
  `AUTO` groups (the key includes both flags).
- **Physics:** untouched. A member's body stays per member (p370 §7).
- **Raycasts:** the engine's mesh raycasts hit the group mesh; `getMergeMemberAtFace(groupEntity,
faceIndex)` (p373 D4) maps the hit to its member.
- **Disabling a member** (`DISABLED`) collapses its range like a remove, without counting it as
  wasted; enabling restores it from the member's geometry.

## 8. Phases

### Phase 1 — Components and runtime API (§2, §3)

Components, `TAG_MERGED` in the reconcile, `createMergeGroup` / `addToMergeGroup` /
`dissolveMergeGroup`, the build system. **Exit:** 200 debugScene boxes with one material in one
group: one draw (profiler), same image as unmerged, dissolving restores 200 draws.

### Phase 2 — In-place updates (§3)

`updateMergeMember`, remove by collapse, compaction, disable/enable, the moved-member check.
**Exit:** moving one member rewrites only its range (no rebuild counted); removing 30% compacts.

### Phase 3 — JSON, AUTO and scene load (§4, §6)

`merge` in `meshSchema` and `createMeshEntity`, scene `mergeGroups`, `AUTO` buckets, imported
asset custom prop and option, the scene-load step. **Exit:** a scene with 500 `AUTO` meshes in 3
materials over 4 cells loads with 12 groups, and its first frame is already merged.

### Phase 4 — Adoption and measurements

1. largeWorld's static props (and its imported level pieces) use `AUTO`.
2. Record draws, triangles and CPU frame time before and after (profiler, main + shadow pass) in
   this file.

**Exit:** largeWorld's draw count drops by the measured amount with no visual change, on both
backends.

### Phase 5 — Handbook, docs and versioning

1. `docs/techniques/terrain-modular-kits.md` (p301 §5 row): modular kit terrain and tile-chunk
   worlds, built on groups. Page template from p301 §5; p374 adds the array-material variation.
2. A "Merging" section in `docs/techniques/asset-optimization.md`: p370 §3's decision table, when
   not to merge.
3. `CLAUDE.md` (a "Mesh merging" architecture paragraph), `readme.md` Features.
4. Engine minor, app patch; `CHANGELOG.md`.

## 9. Versioning

Engine minor (components, API, schema). App patch (largeWorld adoption).

## 10. Risks

| Risk                                                                        | Mitigation                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A member moved without `updateMergeMember` draws at its old place           | Debug moved-member check (§3); the API is the only documented way to move a merged member                                                                                                                               |
| `AUTO` groups too big for culling, or too small to matter                   | Per-scene `cellSize` / `maxVertices`; Phase 4 measures; p373 shows group sizes                                                                                                                                          |
| Merged buffers double memory while members keep their geometry refs         | Member geometry stays CPU/GPU-resident only while some unmerged mesh uses it: the member's own Object3D is hidden, so three never uploads a geometry only merged members use. Verify in Phase 1 with the GPU memory tab |
| Worker builds leave a frame where neither the old nor the new mesh is right | Members stay visible until the new group mesh replaces them in one frame                                                                                                                                                |
| Compatibility key misses a material property that changes rendering         | The key uses the material ref (same material instance), not a property hash; variants (`matOverrides`) are separate materials                                                                                           |

## 11. Open questions

1. Should `AUTO` also group across materials when a p374 palette covers them? Yes, but that's
   p374 D4.
2. Should the group mesh carry per-member vertex colours for debugging (a "colour by member" mode)?
   p373 D3 decides; it would need a debug-only extra attribute.
