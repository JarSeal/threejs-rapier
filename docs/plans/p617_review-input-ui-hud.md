Status: stub — not-implemented
Category: Refactoring, Documentation, UI, Input
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage C)
Blocked by: p605_coding-standards-and-documentation-tooling.md, p610_character-and-input-action-architecture.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md

# Review: Input, UI Kit and HUD — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Applies p600 §5 (the per-file review standard) and p605's JSDoc style to every file in scope, and records the findings per file group in an "As found" list.

## Scope

- The input devices after p610 (`core/Input` 30 of 54 exports documented, 10 of 44 internal functions commented).
- **The UI kit** (`ui/`, p602 D5): CMP (1,062 lines), the HUD, DraggableWindow (1,503 lines), DialogWindow, DropDown, Toaster, the icon registry, the styles; documented for app use, with a Hub page showing an app HUD built from it.
- **Aligned with p800** (the debugger UI overhaul, a prompt today): this plan makes the kit usable and documented; p800 restyles it and adds the components that replace Tweakpane.

## Inputs

- p602 D5, p610, the p800 prompt in `docs/templates/todo-plan-prompts.txt`.

## Done when

- Every file in scope reviewed against p600 §5, the findings fixed or filed (`docs/issues/` or a plan item).
- JSDoc coverage of the scope's public exports at 100% (p601's `docs.json`), members included; the ratchet raised.
- `yarn test`, `yarn verify:scenes` (snapshots and hashes unchanged unless stated), `yarn verify:baselines` (no unexplained growth), `yarn build`, `yarn hub:build`.
- The Hub pages of the features in scope checked against the code; CLAUDE.md's nested files for them current.
