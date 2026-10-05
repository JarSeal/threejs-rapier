Status: stub — not-implemented
Category: Merging, LOD
Epic: p370_static-mesh-merging-and-texture-atlas-systems.md (Tier 3)
Blocked by: p372_mesh-merge-groups.md, p348_ecs-lod-selection.md
Related: \_DONE_p347_lod-chain-generation.md (the simplifier that makes the proxies), p353_macro-streaming-grid.md (FAR cells show these proxies), p351_impostor-billboard-lod.md (baked albedo, impostors as the next level), p306_terrain-blocks-and-procedural-terrain-meshes.md (a block with its dressing as one cluster)

# HLOD: Merged Cluster Proxies — Stub

**This is a stub.** It records the target and what's known, so the real plan can be written once
p372 and p348 have shipped and their numbers show where distant static content still costs too
much.

## Goal

Hierarchical LOD for merged static content. A merge group is already one mesh; seen from far
away it becomes one simplified proxy mesh, and further away it is hidden or replaced by an
impostor. A whole streaming cell's content can be one proxy when p353 shows it as `FAR`.

## What's known

- **Simplifier:** p347's meshoptimizer chains run on any registered geometry, at runtime in the
  asset worker or at build time. A merged group's geometry is a candidate like any other; its part
  table is dropped at the proxy levels (a proxy isn't editable per member).
- **Selection:** p348 selects levels per entity by projected screen size. The group entity is the
  LOD unit; p372 refuses `LOD` on members, which stays true.
- **Materials:** proxies need one material. Same-material groups already have it; p374's merge
  materials cover mixed groups. Far levels can drop the normal map (p350 §5.1), or bake the
  group's albedo into one small texture (p351's bake path) and use an unlit or simple material.
- **Streaming:** groups never cross p353 cells (p372 §4.2), so a cell's groups merge into one cell
  proxy without splitting anything. p353 §3.3's far representations are where it plugs in.
- **Editing:** a proxy is rebuilt when a member is edited (p373 D4), debounced; in debug mode a
  stale proxy is marked.
- **Prior art:** Unreal's HLOD (World Partition builds merged, simplified proxy meshes per cell
  and layer), Unity's community HLOD tools.

## Open questions

1. Build time or runtime? Build-time proxies need scene analysis in the pipeline (the groups exist
   only at runtime today); runtime proxies cost a worker job per group on load.
2. Terrain: a block plus its merged dressing as one far proxy, and how that meets terrain LOD (p350
   §9 Q2, crack-free stitching unplanned).
