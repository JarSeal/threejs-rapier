Status: stub — not-implemented
Category: Architecture, Refactoring
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage B, engine major)
Blocks: p607_sbp-foundation-feature-modules.md, p608_engine-folder-restructure.md
Related: p604_multiplayer-viability-study.md (the headless-core rules)

# Layering Inversion and Public Entry — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

The engine stops importing the app, gets one public entry point, and the boundary becomes a lint
rule (p602 D1, D3, D9, D10).

## Scope

- **Stages and order constants** (`ECSSystemStage`, `APP_RENDER_SYNC_ORDER`) move from
  `src/AppECSRegistry.ts` into the engine: 31 engine files import them today.
- **Component types by declaration merging:** `core/ECS/ECSCoreComponents.ts` stops importing
  `AppComponentType` / `AppComponentData`; the app and the toolkit augment the engine's map, and the
  toolkit effects (`HoverEffect`, `SunShadowFit`, `FollowTool`, `MutualGravity`) lose their
  `AppECSRegistry` imports and their `as any` storage reads.
- **Config flows in:** `core/Config.ts` stops importing `../../CONFIG`; `InitEngine` receives it.
  Module-load reads of `window.location` and `import.meta.env` move into `InitEngine` (p604 §4.6).
- **Generated code moves out:** `generatedAppData.json` and `generatedAppFns.ts` to `src/generated/`,
  handed to the engine through `InitEngine({ data })` (p602 D9; `devTools/gatherAppData.ts`
  writes the new paths).
- **The entry points:** `aekasha` (TS `paths` + Vite alias) with the public exports p602 Phase 2
  listed; the app (about 40 deep import paths today) switches to them.
- **Boundary lint** (`import/no-restricted-paths`, `no-restricted-imports`): errors in the engine
  and the toolkit, warnings in the app until p608.
- Decide whether Stage B runs on one long-lived branch or merges plan by plan (p600 §11).

## Inputs

- p600 §2.2 (the 33 files), p602 D1, D3, D9, D10, p604 §4.

## Done when

- `grep` finds no engine import of `src/app`, `src/toolkit` or the `src/*.ts` root files; the lint
  enforces it.
- The app imports the engine only through `aekasha` entries (warnings left: none).
- p601's runner and baselines pass; `api.json`'s diff is the intended public surface.
- Engine major started (`CHANGELOG.md`), the migration guide's first section written.
