Status: stub — not-implemented
Category: Refactoring, Documentation, ECS
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage C)
Blocked by: p605_coding-standards-and-documentation-tooling.md, p608_engine-folder-restructure.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md

# Review: ECS, Main Loop, Config and Init — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Applies p600 §5 (the per-file review standard) and p605's JSDoc style to every file in scope, and records the findings per file group in an "As found" list.

## Scope

- The ECS (`core/ECS.ts`, `core/ECS/*`: 925 lines in `ECS.ts`; ECS class members documented 10 of 96), the core components and systems, the culling systems.
- The main loop (`MainLoop.ts`, its three variants, the stages, the step clock's frame side), `Config.ts` (6 TODOs), `InitApp.ts`, `ViewManager.ts`.
- **p200's recommendation:** cache the main-camera singleton-tag lookup (`p200_component-query-caching.md`).
- The id → entity map for `appId` (p604 §4.4) instead of `getEntityIdByAppId`'s linear scan.

## Inputs

- p200, p604 §4, p600 §2.

## Done when

- Every file in scope reviewed against p600 §5, the findings fixed or filed (`docs/issues/` or a plan item).
- JSDoc coverage of the scope's public exports at 100% (p601's `docs.json`), members included; the ratchet raised.
- `yarn test`, `yarn verify:scenes` (snapshots and hashes unchanged unless stated), `yarn verify:baselines` (no unexplained growth), `yarn build`, `yarn hub:build`. The verify commands run for minutes to hours: when one starts, give the watch command, `tail -f .cache/verify/progress.log`.
- The Hub pages of the features in scope checked against the code; CLAUDE.md's nested files for them current.
