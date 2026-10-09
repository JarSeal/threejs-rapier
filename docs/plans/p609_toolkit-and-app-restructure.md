Status: stub — not-implemented
Category: Refactoring, Toolkit, App
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage B, toolkit major)
Blocked by: p608_engine-folder-restructure.md
Blocks: p620_review-toolkit-and-app-code.md
Related: the "Toolkit and asset housekeeping" (p450) prompt in `docs/templates/todo-plan-prompts.txt` (its folder structure is absorbed here; its new assets and LOD test scene stay in p450)

# Toolkit and App Restructure — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

The toolkit and the app get the same clarity as the engine: the toolkit as a catalogue of
ready-made pieces by category, the app as one folder per scene.

## Scope

- **Toolkit categories** (from the p450 prompt): `ecs` (effects, and the gameplay pieces p608
  moved in), `geometry` with `generate/` and `scatter/`, `materials/<name>/`,
  `textures/<name>/`, `models/<category>/<name>/`, `skyboxes/<name>/`; each with its own entry
  (`aekasha-toolkit/*`).
- **Remove the deprecated re-exports** `toolkit/ecs/InstancedMeshPool*.ts` (kept until the
  toolkit's next major: this one).
- **The app:** one folder per scene (`src/app/scenes/<sceneId>/`, p602 D7), consistent scene file
  names (today `scene01_v2.ts`, `scene_thirdPersonGym.ts`, `largeWorld.ts` side by side), the
  shared asset JSONs in their type folders, `characterVisual.ts` with the gym.
- **`AppECSPlugins.ts`** becomes the app's feature list for `InitEngine` (p602 D8).
- The asset location question from the p450 prompt (`src/public/aek-assets/` vs the toolkit):
  answered here or handed back to p450, with the asset pipeline's output paths in mind.

## Inputs

- p602 D2, D7, D8; the p450 prompt; p608's moves.

## Done when

- The toolkit's folders follow the categories, each piece importable by its entry; the app's
  scenes each in their folder; p601's runner passes; the toolkit major is in the changelog.
