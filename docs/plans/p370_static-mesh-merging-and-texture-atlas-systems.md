Status: research done — epic, not-implemented
Category: Rendering, Merging, Texture atlas
Blocks: p299_texture-arrays-and-atlases.md, p371_geometry-merging.md, p372_mesh-merge-groups.md, p373_merge-debug-and-member-editing.md, p374_multi-material-merging.md, p375_batched-mesh-batches.md, p376_hlod-merged-cluster-proxies.md
Related: p350_lod-system-research.md (the LOD epic this one follows; "feeds the instancing/batching layer"), \_DONE_p348_ecs-lod-selection.md (§4.4's `BatchedMesh` spike is shared with p375), \_DONE_p347_lod-chain-generation.md (HLOD reuses its simplifier), p353_macro-streaming-grid.md (merge groups never cross its cells), p352_physics-simulation-tiers.md (static body cost), \_DONE_p346_spatial-domains.md (cell maths), p301_terrain-texturing-epic.md (new terrain processes, §10), p303_texture-sets-and-terrain-texture-library.md and p309_terrain-decals.md (their array and atlas tools move to p299), p308_terrain-scatter.md, \_DONE_p083_editor-creator-view.md (future select/transform tools), \_DONE_p345_gpu-memory-and-draw-call-debugger.md (measures every result)

# Static Mesh Merging & Texture Arrays/Atlases — Research & Epic

How Ækasha lowers the draw count of large static worlds: merging meshes into fewer draws, and the
texture arrays and atlases that let meshes with different materials share one. The research is
done: this file holds the findings and decisions, and the work is split into the child plans in
§11.

The short version:

- **Only a baked merge (one geometry, one material) is one draw.** On WebGPU, three r186 draws a
  `BatchedMesh` as one draw call per member, and a multi-material mesh as one per group.
- **Members stay entities.** A merged mesh is a render artefact owned by a group entity. The
  source entities keep their transform, physics body and data, so they can be listed, selected,
  moved and re-merged.
- **Different materials merge through a merge material**: a per-vertex material index, a
  parameter table and one **texture array** per map slot. Arrays, not 2D atlases, because merged
  materials tile. 2D atlases stay for content that doesn't tile (decals, cards, sprites).
- **The array/atlas core comes first** (`p299`, before the terrain plans), because p303 and p309
  would each build their own otherwise.

---

## 1. Goal

1. Fewer draw calls, in the main pass and in every shadow pass (each shadow-casting light or
   cascade draws every caster again), for worlds built from many small static pieces.
2. Keep the ECS model: every piece is still an entity, visible as such in debug mode, and editable
   by the debug tools now and the select/transform tools later.
3. Texture arrays and atlases as a standalone engine feature too, so a developer can build custom
   ones without merging anything.

Non-goal: merging colliders (§7).

## 2. Grounding (checked against the code, 2026-10-05)

- **Meshes** (`core/MeshManager.ts:81`): `createMeshEntity(props, entityOpts?, world?)` builds one
  `THREE.Mesh`, adds `OBJECT3D` and `TAG_IS_MESH`, and adds the mesh to the root scene unless
  `doNotAddToScene`. Geometry and material come from ref-counted registries (`Geometry.ts`,
  `Material.ts`); `disposeMesh` releases the refs on entity delete. `MeshProps` has no static,
  merge, group or LOD flag. `CoreEntityOpts.managedBy` already passes through to `createEntity`.
- **Ad hoc merges exist**: `app/largeWorld.ts:348,398`, `utils/world/characterTestObjects.ts:25`
  and `toolkit/geometry/generateFoliage.ts:59,101` call `mergeGeometries` and register the result
  with `saveBufferGeometry` (`Geometry.ts:290`). No shared utility, no part bookkeeping.
- **Imported assets** use one engine material for all their pieces (`SpawnImportedParams.material`,
  `core/Import/ImportTypes.ts`); glTF materials are never imported. So the pieces of one imported
  level are already same-material: the easiest merge case.
- **Visibility** (`ECS/ECSCoreSystems.ts:22`): `reconcileObject3DVisibility` sets
  `.visible = !DISABLED && !TAG_FRUSTUM_CULLED && !TAG_OBJECT_CULLED`; p348 adds `TAG_LOD_CULLED`.
- **Static bodies are synced every frame** (`PhysicsManager.ts:379-388`, on purpose): every
  `BODY_STATIC` entity's transform is marked dirty every frame. p352 Phase 1 changes this.
- **Spatial index** (`core/Spatial/`): meshes are `SPATIAL_INDEXED` by default, with a radius
  from their geometry. A large merged mesh lands in the grid's oversized tier.
  `core/Spatial/CellKey.ts` (`worldToCell`, `packCellKey`, `cellBounds`) is the shared cell maths.
- **No `BatchedMesh` anywhere**, only the profiler census counts one (`_dbg__Census.ts:296`).
- **No array textures** (`DataArrayTexture` / `CompressedArrayTexture`) are used yet. p303 D4
  designs KTX2 array assembly; p309 D1 designs a decal atlas build tool.
- **Asset pipeline** (`devTools/assetPipeline/`): `gltf.ts` uses only `weld`, `simplify`,
  `meshopt`, `draco` and `quantize`. The installed `@gltf-transform/functions` 4.5.1 also has
  `flatten`, `join`, `dedup`, `instance` and `palette`. The pinned `ktx` 4.4.2 can write array
  textures (`ktx create --layers N`).
- **No Meshes debug tab or mesh edit window exists.** The Lights tab
  (`core/Debug/Light/_dbg__LightGUI.ts`) is the pattern for an entity list with edit windows.

### 2.1 How three r186 draws batches on WebGPU

`renderers/webgpu/WebGPUBackend.js:2124-2145`:

```js
if (object.isBatchedMesh === true) {
  for (let i = 0; i < drawCount; i++) {
    passEncoderGPU.drawIndexed(counts[i], 1, starts[i] / bytesPerElement, 0, i);
    info.update(object, counts[i], 1);
  }
}
```

WebGPU core has no multi-draw-indirect, so a `BatchedMesh` is **one draw call per visible member**,
and `renderer.info.render.drawCalls` counts each. What it does save: one render object, one
pipeline, one bind group, no per-object render-list work. A mesh with geometry groups and a
material array is likewise one render object per group. Neither lowers the draw count. Only one
geometry drawn with one material does.

## 3. The batching tools and when each wins

| Tool                               | Members                                  | Draws (WebGPU)    | Members move?             | Per-member culling / LOD  | Plan              |
| ---------------------------------- | ---------------------------------------- | ----------------- | ------------------------- | ------------------------- | ----------------- |
| `InstancedMeshPool` / static cells | same geometry, same material             | 1 per pool / cell | yes (matrix per instance) | via p348 pools            | done, p308, p348  |
| **Baked merge group**              | different geometry, same material        | **1 per group**   | rarely (in-place rewrite) | no: the group is the unit | p371, p372        |
| **Merge material group**           | different geometry, compatible materials | **1 per group**   | rarely                    | no                        | p374              |
| `BatchedMesh` batch                | different geometry, same material        | 1 per member      | yes (matrix per member)   | yes                       | p375              |
| Geometry groups + material array   | different materials                      | 1 per group       | no                        | no                        | — (fallback only) |

Rules of thumb, written into the handbook (p372):

- Many copies of one thing → instancing (exists).
- Many different static things sharing a material → a baked merge group, spatially bounded.
- Many different static things with different materials → a merge material group if they share a
  compatibility class (§4), otherwise one group per material.
- Things that move, or need their own culling or LOD → instancing or `BatchedMesh`, not a merge.

## 4. What can be merged

| Content                                                      | Baked merge     | Why                                                                    |
| ------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------- |
| Static meshes without physics                                | yes             | the main case                                                          |
| Static meshes with a `BODY_STATIC` body                      | yes             | the render mesh merges; the body stays per member (§7)                 |
| Meshes moved now and then (doors swung once, an editor move) | yes             | in-place range rewrite (§8): the vertex count doesn't change           |
| Kinematic / dynamic bodies, animated transforms              | no              | a rewrite per frame costs more than the draw; use `BatchedMesh` (p375) |
| Skinned meshes, morph targets                                | no              | per-vertex skinning state can't be shared                              |
| Transparent materials                                        | no              | they need back-to-front sorting per object                             |
| `InstancedMesh` / pool instances                             | no              | already one draw                                                       |
| `managedBy` entities (sky lights etc.)                       | no              | their manager owns their Object3D                                      |
| Entities with `LOD` (p348)                                   | not before p376 | a group's level is the group's (HLOD)                                  |

## 5. Different materials in one draw

**Can meshes with different materials be merged? Yes, within a compatibility class, at a cost.**
A merge material replaces N materials with one:

- a per-vertex `aekMatIndex` attribute (Uint8/Uint16), written during the merge;
- a parameter table indexed by it: base colour, roughness, metalness, emissive, UV transform and
  one array layer per map slot;
- one texture array per map slot (albedo, normal, ORM, emissive, …), so each map type has its own
  array, all linked by the merge material's palette.

**Compatibility class**: the same shading model (standard PBR node material), alpha mode (opaque
or alpha-test, never blended), side, and feature set. The merged shader carries the union of its
members' features, so a palette that mixes one emissive material into twenty plain ones makes
every pixel pay for emissive. Custom TSL materials don't merge automatically (open question 1).

**Costs:**

| Cost                    | Effect                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Draws                   | N → 1 per group, in the main pass and in every shadow pass                                        |
| Texture fetches / pixel | the same as one member material: an array fetch costs about what a 2D fetch does                  |
| ALU / pixel             | one table read, plus the union of features                                                        |
| VRAM                    | every layer of a slot has one size, so small textures are scaled up (or big ones down, `maxSize`) |
| Missing maps            | a neutral layer (white albedo, flat normal) or a per-entry flag that skips the fetch              |
| Bindings                | one per slot (3–5), well under WebGPU's 16 sampled textures per stage                             |
| WebGL2 fallback         | array textures work; storage buffers don't, so the table is a uniform array or a data texture     |
| Build time              | arrays are encoded at build time: KTX2 can't be resized or re-encoded in the browser              |

The fallback when members aren't compatible is a group per material, not a multi-material mesh:
same draw count, but each group keeps its own culling unit.

## 6. Texture arrays vs atlases

|                                     | Texture array                                               | 2D atlas                                                                        |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Tiling (UV repeat, world-space UVs) | yes: each layer wraps on its own                            | no: repeat needs `fract()` in the shader and breaks mip selection at cell edges |
| Mip bleeding                        | none                                                        | needs padding/gutters, which grow with every mip level                          |
| Layer/cell sizes                    | all layers one size and one format                          | any sizes in one image                                                          |
| Geometry change                     | none: the layer comes from the table                        | UVs remapped into the cell rect                                                 |
| Good for                            | merge materials, terrain layers (p303), anything that tiles | decals (p309), scatter cards (p308), sprites, impostors (p351), UI              |

**Decision:** merge materials use arrays. Atlases are a separate, equally first-class tool for
UV-bounded content. Both are in p299, both work without merging, and both give each map type its
own output linked by one layout or palette id.

## 7. Physics

Render merging never touches colliders. A `BODY_STATIC` member keeps its body and its
`PhysicsTransformBuffer` slot. Merging colliders into compound or trimesh bodies is a separate
concern for p352 (its slot-less static bodies) and is not planned here.

`physicsToTransformSystem` marks every static body's transform dirty every frame (§2). So a remerge
is **never** driven by a transform's dirty flag: members are static by contract, and every move
goes through `updateMergeMember` (p372) or an edit session (p373).

## 8. Culling, LOD, streaming and editing

- **Culling:** a merged group is one bounding sphere, so it is culled as a whole. `AUTO` groups
  are therefore bounded by a spatial cell (`CellKey.ts`) and a vertex cap, and the group entity,
  not its members, is in the DEFAULT spatial domain and frustum culling.
- **LOD:** a group's LOD unit is the group. Simplifying a merged group as a whole is HLOD (p376),
  which reuses p347's simplifier and p348's selection.
- **Streaming:** groups never cross a p353 cell; an `AUTO` cell size divides the streaming cell
  size, and explicit groups spanning cells get a dev warning.
- **Editing:** a member's vertex range in the merged buffers is known, so moving a member rewrites
  that range in place (positions, normals, tangents, with an update range) without a rebuild.
  Picking a merged mesh returns a face index, which maps to its member through the range table.
  The future select/transform tool (no plan yet; the p083 editor epic) uses p373's edit sessions.

## 9. Order relative to the other epics

| Plan                    | Can it run before terrain (p302–p310)?                  | Before LOD (p347–p354)?                       |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------- |
| p299 arrays and atlases | **yes, and it should**: p303 D4 and p309 D1 build on it | yes: nothing in LOD needs it                  |
| p371 geometry merging   | yes: no terrain dependency                              | yes                                           |
| p372 mesh merge groups  | yes                                                     | yes, but `LOD` members are refused until p376 |
| p373 debug and editing  | yes                                                     | yes                                           |
| p374 merge materials    | after p302 (setup entry, input resolvers) and p299      | yes                                           |
| p375 `BatchedMesh`      | yes                                                     | its spike is p348 §4.4's; run it once         |
| p376 HLOD               | no: needs p306 blocks for the terrain case              | no: needs p347 and p348                       |

The intended order: p299 before p303; the merge plans after the LOD plans, as requested. Nothing
in the terrain plans is blocked by p371–p376; they get better with them (§10).

## 10. New ways to make terrain

Merging and arrays add terrain processes the terrain epic doesn't have:

1. **Modular kit terrain.** Cliffs, rock shelves, ledges and ground pieces built from a kit of
   modules (kit-bashing in Blender or placed in code), merged per cell with one array material.
   Suits caves, dungeons, stylized and hand-built levels, where a heightfield can't express
   overhangs. Handbook page `terrain-modular-kits.md` (p372; array variation p374).
2. **Tile-chunk worlds.** Hex or square tile games (strategy, puzzle, city builders): each tile is
   a small mesh, tiles are merged per chunk, tile types are array layers, and changing a tile
   rewrites its range. Same page.
3. **A block merged with its static dressing.** A terrain block's static props and mesh decals
   (p309 mesh decals share one atlas material) merge into one draw per material per block.
4. **HLOD far blocks** (p376): a cell's merged content, simplified as a whole, as p353's FAR
   representation.

Heightfield blocks themselves gain little: each is already one mesh.

## 11. Roadmap

| Tier | Plan                                      | What it delivers                                                                                                               | Depends on                          |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 0    | `p299_texture-arrays-and-atlases`         | Runtime and build-time texture arrays, 2D atlases with cell tables, UV remap and TSL helpers, JSON binding                     | \_DONE_p300; p302 D4 (Phase 5 only) |
| 1.1  | `p371_geometry-merging`                   | `mergeGeometryParts` with a part range table, `MERGED` geometry JSON, GLB `merge` at build time, adoption of the ad hoc merges | —                                   |
| 1.2  | `p372_mesh-merge-groups`                  | `MERGE_GROUP` / `MERGE_MEMBER`, `merge: id \| 'AUTO'`, in-place member updates, scene-load build                               | p371                                |
| 1.3  | `p373_merge-debug-and-member-editing`     | "Merging" drawer tab, group and member windows, overlay, A/B toggle, edit sessions, face picking                               | p372                                |
| 2.1  | `p374_multi-material-merging`             | Merge materials: palettes, per-slot arrays, parameter table, compatibility classes                                             | p372, p299, p302                    |
| 2.2  | `p375_batched-mesh-batches`               | Spike-gated `BatchedMesh` groups for movable or per-member-culled content                                                      | p372; p348 §4.4's spike             |
| 3    | `p376_hlod-merged-cluster-proxies` (stub) | Simplified merged groups as far LOD levels and FAR cells                                                                       | p372, p347, p348 (p353)             |

## 12. Open questions

1. **Custom TSL materials in merge materials.** A `mergeable` contract (the material declares its
   per-entry parameters and array slots) would let custom materials merge. Wait for a use case.
2. **Collider merging.** Many small static bodies cost broad phase and slots (p352). Merging them
   into compound bodies per group is plausible but changes collision events per member. Not
   planned.
3. **Indirect draws.** p354's compute culling plus `drawIndexedIndirect` could cull inside a merged
   group per member range. Only if p354 lands and merged groups prove too coarse.
4. **Multi-draw-indirect.** If WebGPU ships it (or three uses Chrome's experimental extension),
   `BatchedMesh` becomes a real draw-count win and p375's trade-off changes.
