Status: stub — not-implemented
Category: Rendering, LOD, GPU
Epic: p350_lod-system-research.md (Tier 3)
Related: \_DONE_p346_spatial-domains.md, p351_impostor-billboard-lod.md (impostor levels are bins too), p240_client-device-capability-sniffer.md (whether the GPU path is worth enabling on a device)

# GPU-Driven Culling & Per-Instance LOD — Stub

**This is a stub.** It records the target and what's known, so the real plan can be written once
p348 has shipped and its numbers show where the CPU path stops scaling.

## Goal

Move instance culling and LOD selection for instanced content off the CPU:

1. A compute pass reads every instance's bounds from a storage buffer, tests it against the camera
   frustum, picks its LOD level with p348's rules (screen size, bias), and appends its index to
   that level's visible list.
2. Each level draws with an indirect draw whose instance count the compute pass wrote. The vertex
   stage fetches the instance's matrix through the visible list.
3. No per-instance CPU work per frame: ten thousand or a million trees cost one dispatch and one
   indirect draw per level.

This is the realistic end state for the engine (p350 §7): "Nanite-lite" at instance granularity,
without meshlets or software rasterization.

## What's known (2026-10-02)

- three r186's WebGPU backend supports indirect draws (`geometry.indirect`, an
  `IndirectStorageBufferAttribute`; `renderers/common/Geometries.js:286`,
  `WebGPUBackend.js:2187`) and indirect compute dispatch (`WebGPUBackend.js:1925`).
- The engine has no compute passes yet. The only compute-related code is the debug GPU timer
  wrapper (`core/Debug/_dbg__GPUTimer.ts:80`).
- **The WebGL2 fallback (`forceWebGL`) has no compute.** The CPU path (p348) must stay and is
  chosen per backend.
- ECS state: GPU-culled instances have no ECS visibility tags (`TAG_FRUSTUM_CULLED`,
  `TAG_LOD_CULLED`). That's fine for instanced content, which has none of the per-entity hooks
  anyway, but anything gameplay-side reading "is this visible" can't use the GPU path.

## Open questions for the real plan

1. **Shadow passes.** Each shadow-casting light needs its own cull against its own frustum (or a
   conservative union). How many dispatches per frame is that with the sky's sun plus a few spot
   lights?
2. **Where instance data lives.** Pool transforms are on the ECS side today, synced into
   `instanceMatrix` by `instancedMeshPoolSyncSystem`. A GPU path wants them in a storage buffer
   written once (static instances) or from a dirty list (dynamic).
3. **Occlusion culling.** A Hi-Z pyramid from the previous frame's depth is the usual next step.
   Worth it only for dense scenes (cities, forests seen from inside); measure first.
4. **Interaction with three's own culling.** Instanced meshes on the GPU path must have
   `frustumCulled = false` (the whole batch is one object to three).
5. **Debugging.** A readback of per-level visible counts (async, debug only) for the LOD tab.

## Rough phases (to be refined)

0. **Spike.** A TSL compute pass that frustum-culls 100k instances into one indirect draw, on
   WebGPU, with p345's frame numbers before and after.
1. **Frustum culling + indirect draw** for one instanced pool type, behind a per-pool flag.
2. **Per-instance LOD** binned into per-level indirect draws (p348's rules ported to TSL).
3. **Shadow passes.**
4. **Occlusion culling**, if measured as worth it.

## Not in scope

Cluster-level (meshlet) LOD stays research (p350 §8, Tier 4): a timeboxed spike, and only if huge
single meshes (terrain chunks, large architecture) need finer detail than per-object LOD gives.
