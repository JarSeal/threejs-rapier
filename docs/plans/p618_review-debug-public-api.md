Status: stub — not-implemented
Category: Refactoring, Documentation, Debug
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage C)
Blocked by: p608_engine-folder-restructure.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md

# Review: Debug Public API — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Applies p600 §5 (the per-file review standard) and p605's JSDoc style to every file in scope, and records the findings per file group in an "As found" list.

## Scope

- The debugger framework's public API (`createDebuggerTab`, `createProfilerTab`, `registerStatsSource`, `registerGPUMemorySource`, the dev files, undo / redo, views, draggable windows) and the one debug-module loader: documented with examples, so an app writes its own tab from the Hub page alone.
- The debug folders' structure after p608 (p602 D4).
- **Not in scope:** polishing the Tweakpane panels' code (about 40% of the codebase). p800 replaces them; this plan only fixes what is broken or blocks p800.

## Inputs

- p602 D4, the p800 prompt.
- p605 Phase 5's `notExported` warnings in scope (`yarn hub:build` lists each with its file and line; export the type with a summary or change the signature): `PhysicsProbeReport`, `DrawerState`, `DebugKeyShortcutsTab` and `EnvBallOpts` (types in `_dbg__` modules, named by `debug/` entry points) and `AnyStatsSource` (named by `_getStatsSources`).

## Done when

- Every file in scope reviewed against p600 §5, the findings fixed or filed (`docs/issues/` or a plan item).
- JSDoc coverage of the scope's public exports at 100% (p601's `docs.json`), members included; the ratchet raised.
- `yarn test`, `yarn verify:scenes` (snapshots and hashes unchanged unless stated), `yarn verify:baselines` (no unexplained growth), `yarn build`, `yarn hub:build`. The verify commands run for minutes to hours: when one starts, give the watch command, `tail -f .cache/verify/progress.log`.
- The Hub pages of the features in scope checked against the code; CLAUDE.md's nested files for them current.
