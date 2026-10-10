Status: stub — not-implemented
Category: Refactoring, Documentation, LOD, Rendering
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage C)
Blocked by: p608_engine-folder-restructure.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md

# Review: LOD, Spatial Index, Instancing and Lines — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Applies p600 §5 (the per-file review standard) and p605's JSDoc style to every file in scope, and records the findings per file group in an "As found" list.

## Scope

- `Lod/` (10 files, `LodSystem.ts` 1,086 lines) and `Lod/Impostors/` (9), `Spatial/` (`SpatialIndexSystem.ts` 1,128 lines), `Instancing/`, `Lines/` and the line manager.
- The hot loops (LOD selection's ~0.15-0.2 µs per entity, the spatial rebuild): measured before and after with the profiler, no regression.

## Inputs

- p600 §2; the LOD sections of CLAUDE.md (they become nested files).
- p605 Phase 5's `notExported` warnings in scope (`yarn hub:build` lists each with its file and line; export the type with a summary or change the signature): `Vec2Node` / `Vec3Node` (`Lod/Impostors/Octahedral.ts`'s local TSL aliases, named by `encodeOctahedralNode` / `decodeOctahedralNode`).

## Done when

- Every file in scope reviewed against p600 §5, the findings fixed or filed (`docs/issues/` or a plan item).
- JSDoc coverage of the scope's public exports at 100% (p601's `docs.json`), members included; the ratchet raised.
- `yarn test`, `yarn verify:scenes` (snapshots and hashes unchanged unless stated), `yarn verify:baselines` (no unexplained growth), `yarn build`, `yarn hub:build`. The verify commands run for minutes to hours: when one starts, give the watch command, `tail -f .cache/verify/progress.log`.
- The Hub pages of the features in scope checked against the code; CLAUDE.md's nested files for them current.
