Status: stub — not-implemented
Category: Refactoring, Architecture
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage B, engine major)
Blocked by: p606_layering-inversion-and-public-entry.md, p607_sbp-foundation-feature-modules.md, p299_texture-arrays-and-atlases.md (in progress: merged before the move)
Blocks: p609_toolkit-and-app-restructure.md, p610_character-and-input-action-architecture.md, p611_sbp-tooling-profiles-and-marketing.md, p612_review-ecs-loop-config-init.md, p613_review-rendering-scene-assets.md, p615_review-sky-box.md, p616_review-lod-spatial-instancing-lines.md, p618_review-debug-public-api.md, p619_review-schemas-pipeline-devtools-hub.md

# Engine Folder Restructure — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Apply p602's folder map to the engine in one mechanical, re-runnable step: moves and renames only,
no behaviour change.

## Scope

- **A codemod** (`devTools/refactor/applyMoveMap.ts`) that reads p602's `moveMap.json`, `git mv`s
  every file and rewrites every import (relative imports, `?raw` / `?worker` suffixes, dynamic
  `import()`s, `loadDebugModuleAsync` paths, SCSS imports), plus the paths in `tsconfig.json`
  (`typedocOptions`), `vite.config.ts`, `devTools/`, the Hub's `<<<` includes and CLAUDE.md.
  Re-runnable on a fresh `main`, so it never needs a hand merge.
- **The moves** (p602 D2-D7): `core/` into `kernel/` and `features/`; the debug modules next to
  their features (D4); `ui/` (D5); `utils/` emptied of non-pure code (D6), with the gameplay
  pieces (`movingPlatform`, `followObjectCameraRig`) to the toolkit and the test code
  (`ECSStressTest`, `PhysicsStressTest`, `world/characterTest*`) to the app; the orphans deleted;
  the renames (D7: no `Manager` suffix, PascalCase, no `helpers.ts` / `Helpers.ts` pair).
- **What must survive** (p600 §3.7): LS keys, `__saveData`, URL flags, the Hub's `#region`
  includes, the generated data's shape, every scene's snapshot and hash.
- Runs when no other branch is open (p600 §12.4).

## Inputs

- p602's move map and decisions; p601's runner and `api.json` (the public surface must not change
  in this plan: the entries re-export from the new paths).

## Done when

- The tree matches the map; `api.json` unchanged; p601's runner, `yarn build`, `yarn hub:build`
  and the lint pass.
- The boundary lint's app warnings are gone (the app imports only entries).
- The Hub's migration guide lists the old → new paths for apps that deep-imported.
