Status: stub — not-implemented
Category: Refactoring, Documentation, Dev tooling
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage C)
Blocked by: p605_coding-standards-and-documentation-tooling.md, p608_engine-folder-restructure.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md

# Review: Schemas, Data Pipeline, Dev Tools and Hub Generator — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Applies p600 §5 (the per-file review standard) and p605's JSDoc style to every file in scope, and records the findings per file group in an "As found" list.

## Scope

- `schemas/` (19 files, 38 of 154 exports documented, 57 Zod-inferred types with 1 comment): documented at the schema (`.describe()` feeds the JSON Schemas' editor tooltips too) or the inferred type, per p605.
- `devTools/gatherAppData.ts`, the asset pipeline (`devTools/assetPipeline/`), the dev files server, the Hub generator (`devTools/hub/`), `devTools/verify/` (p601).
- The Hub's API renderer adapted to the entry points (p602 D3): a module per public entry, the `api:` links fixed.

## Inputs

- p602 D3, p605.

## Done when

- Every file in scope reviewed against p600 §5, the findings fixed or filed (`docs/issues/` or a plan item).
- JSDoc coverage of the scope's public exports at 100% (p601's `docs.json`), members included; the ratchet raised.
- `yarn test`, `yarn verify:scenes` (snapshots and hashes unchanged unless stated), `yarn verify:baselines` (no unexplained growth), `yarn build`, `yarn hub:build`. The verify commands run for minutes to hours: when one starts, give the watch command, `tail -f .cache/verify/progress.log`.
- The Hub pages of the features in scope checked against the code; CLAUDE.md's nested files for them current.
