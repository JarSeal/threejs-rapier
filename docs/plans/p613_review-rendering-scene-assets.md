Status: stub — not-implemented
Category: Refactoring, Documentation, Rendering, Assets
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage C)
Blocked by: p605_coding-standards-and-documentation-tooling.md, p608_engine-folder-restructure.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md

# Review: Rendering, Scenes and Assets — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Applies p600 §5 (the per-file review standard) and p605's JSDoc style to every file in scope, and records the findings per file group in an "As found" list.

## Scope

- The renderer, `Scene.ts`, `SceneLoader.ts` (4 TODOs), `GroupManager`, `CameraManager`, `LightManager`, `MeshManager`.
- Geometry, material, texture, texture arrays and atlases, the assets API and worker, `Import/` (15 files).
- PostFX, viewports, snapshots, the property loader.
- **Leaves what p302 rewrites** (`p302_material-and-texture-system-refactor.md`, the terrain epic): those files are only moved and documented, not refactored, if p302 hasn't landed.

## Inputs

- p302, p600 §2.

## Done when

- Every file in scope reviewed against p600 §5, the findings fixed or filed (`docs/issues/` or a plan item).
- JSDoc coverage of the scope's public exports at 100% (p601's `docs.json`), members included; the ratchet raised.
- `yarn test`, `yarn verify:scenes` (snapshots and hashes unchanged unless stated), `yarn verify:baselines` (no unexplained growth), `yarn build`, `yarn hub:build`. The verify commands run for minutes to hours: when one starts, give the watch command, `tail -f .cache/verify/progress.log`.
- The Hub pages of the features in scope checked against the code; CLAUDE.md's nested files for them current.
