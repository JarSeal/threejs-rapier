Status: stub — not-implemented
Category: Refactoring, Documentation, Sky box
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage C)
Blocked by: p605_coding-standards-and-documentation-tooling.md, p608_engine-folder-restructure.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md

# Review: Sky Box — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Applies p600 §5 (the per-file review standard) and p605's JSDoc style to every file in scope, and records the findings per file group in an "As found" list.

## Scope

- `SkyBox/` (10 files) and `SkyBox/layers/` (8; 47 of 79 exports documented), its debug folders (17 files: structure and docs only, p800 rewrites the panels).
- The CLAUDE.md sky box section becomes the folder's nested `CLAUDE.md` (p605).

## Inputs

- p600 §2; the three r186 traps CLAUDE.md lists for the sky box (they become `@remarks`).

## Done when

- Every file in scope reviewed against p600 §5, the findings fixed or filed (`docs/issues/` or a plan item).
- JSDoc coverage of the scope's public exports at 100% (p601's `docs.json`), members included; the ratchet raised.
- `yarn test`, `yarn verify:scenes` (snapshots and hashes unchanged unless stated), `yarn verify:baselines` (no unexplained growth), `yarn build`, `yarn hub:build`.
- The Hub pages of the features in scope checked against the code; CLAUDE.md's nested files for them current.
