Status: draft | spike-gated, not-implemented
Category: Merging, Rendering
Epic: p370_static-mesh-merging-and-texture-atlas-systems.md (Tier 2.2)
Blocked by: p372_mesh-merge-groups.md
Related: \_DONE_p348_ecs-lod-selection.md (§4.4's `BatchedMesh` spike is this plan's Phase 0, run once), p309_terrain-decals.md (its runtime decal pools are `BatchedMesh`es; its WebGPU risk is answered here), \_DONE_p347_lod-chain-generation.md (shared-vertex chains), p354_gpu-driven-culling.md

# BatchedMesh Batches (movable and per-member-culled content)

The merge path for content a baked merge can't take: members that move, or that need their own
culling, visibility or LOD. A `BatchedMesh` holds many geometries with one material and a matrix
per member.

**It is spike-gated.** On WebGPU, three r186 draws a `BatchedMesh` as one draw call per visible
member (p370 §2.1), so it doesn't lower the draw count; it lowers CPU cost (one render object, one
pipeline, one bind group, no per-object render-list work). This plan is adopted only if Phase 0
measures a CPU win that matters.

---

## 1. Grounding

- **r186 WebGPU draw loop** (`renderers/webgpu/WebGPUBackend.js:2124-2145`): one `drawIndexed`
  per entry of `_multiDrawStarts` / `_multiDrawCounts`, `firstInstance = i` as the member index,
  each counted in `info.render.drawCalls`.
- `BatchedMesh` keeps member matrices in a data texture, supports per-member visibility, colour,
  `perObjectFrustumCulled` and `sortObjects`, and geometry slots that can be freed and reused.
- **No `BatchedMesh` in the engine.** The profiler census counts one as a whole object
  (`_dbg__Census.ts:296`).
- p348 §4.4 plans a half-day spike on `@three.ez/batched-mesh-extensions`' LOD under
  `WebGPURenderer`; p309 plans decal pools on `BatchedMesh` with a WebGPU risk. One spike answers
  all three.
- p372 provides groups, members, the build system and eligibility rules.

## 2. Phase 0 — Spike (1 day)

In a test scene, 2 000 members of 20 geometries with one material, three ways: separate meshes, a
baked p372 group, a `BatchedMesh`. Both backends. Measure (profiler):

1. CPU frame time (render-list build, `renderer.render`) and GPU time;
2. draw calls as counted;
3. per-member matrix updates for 10% / 100% of members per frame;
4. per-instance colour and visibility on WebGPU (p309's risk);
5. `perObjectFrustumCulled` cost vs. benefit;
6. geometry slot reuse after deletes (p309's FIFO pools);
7. `@three.ez/batched-mesh-extensions`' `addGeometryLOD` under `WebGPURenderer` (p348 §4.4).
   Answered by p348's Phase 5 (`_DONE_p348_ecs-lod-selection.md` §4.4): broken on WebGPU r186 as
   shipped (0.0.12 never sets `_multiDrawBytesPerElement`), and once fixed no faster than p348's
   instanced LOD pool for 2,000 instances of one geometry (and 2,000 draws instead of 3).

Record the numbers here, in p348 §4.4 and in p309's risk row. **Gate:** continue only if
`BatchedMesh` beats separate meshes on CPU frame time by a margin worth a new code path (proposed:
≥ 30% at 2 000 members) and works on both backends.

## 3. Design (if the gate passes)

- **Mode:** `merge: { group: "<id>" | "AUTO", mode: "BATCHED" }`; a group setting
  (`mergeGroups` entry `"mode": "BATCHED"`). Same eligibility as p372, except that kinematic and
  dynamic bodies and animated transforms are allowed.
- **Members** get `MERGE_MEMBER` with a batch instance id instead of a part range. Each geometry is
  added once per batch (`addGeometry`), each member as an instance (`addInstance`).
- **Sync:** a system at `APP_RENDER_SYNC` (after `POSE_PRODUCERS`, so interpolated physics poses
  are final) writes the matrices of members whose transform changed (`setMatrixAt`), using the
  same `_lastVersion` pattern as `instancedMeshPoolSyncSystem`.
- **Visibility:** `DISABLED`, frustum and object culling map to `setVisibleAt` per member; the
  batch itself is never hidden for one member.
- **LOD (with p348):** a member's level is a different geometry id in the same batch (p347 chains
  share one vertex buffer, so `addGeometryLOD`-style index ranges are cheap if the spike's
  extension works; otherwise a geometry per level).
- **Debug:** p373's tab lists batched groups with their member count and visible count.

## 4. Phases (after the gate)

1. Batched groups, sync, visibility. **Exit:** 2 000 moving kinematic boxes in one batch match the
   spike's numbers in the engine.
2. LOD per member (with p348). 3. p309's decal pools on batched groups (if p309 has shipped, port;
   if not, p309 uses this). 4. Docs (`asset-optimization.md` merging section), versioning (engine
   minor).

## 5. Risks

| Risk                                          | Mitigation                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| No CPU win worth the code on WebGPU           | The gate; the spike's numbers stay recorded, and p372/instancing cover the cases  |
| Per-instance features differ between backends | Spike items 4–6 on both backends                                                  |
| WebGPU gains multi-draw-indirect later        | Then batches become a draw-count win too; re-run the spike (p370 open question 4) |

## 6. Open questions

1. Should a baked group switch a member into a batch while it's being edited (p373 D4), instead
   of showing its own mesh? Only if editing large groups shows a cost.
