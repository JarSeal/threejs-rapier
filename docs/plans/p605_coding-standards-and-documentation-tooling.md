Status: stub — not-implemented
Category: Documentation, Dev tooling, Standards
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage A)
Blocks: p612_review-ecs-loop-config-init.md, p613_review-rendering-scene-assets.md, p614_review-physics.md, p615_review-sky-box.md, p616_review-lod-spatial-instancing-lines.md, p617_review-input-ui-hud.md, p618_review-debug-public-api.md, p619_review-schemas-pipeline-devtools-hub.md, p620_review-toolkit-and-app-code.md (the standard they apply)
Related: p604_multiplayer-viability-study.md (the simulation rules)

# Coding Standards and Documentation Tooling — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

The written standard every review plan applies, and the tooling that keeps documentation from
regressing: today 63% of the 2,029 exported reflections are documented and nothing enforces it
(p600 §2.5).

## Scope

- **Coding standards** (p600 §3, §5 made concrete): layering, the public / `@internal` split,
  naming and API verbs, file and function size, async and disposal rules, performance rules for
  per-frame code, SBP rules, the simulation rules (p604 §4: step-index time, seeded RNG, no DOM).
- **JSDoc style:** what a summary says, when `@param` / `@returns` / `@example` / `@remarks` /
  `@internal` / `@deprecated` are required, how Zod-inferred types (`schemas/`, 25% today) and
  the Physics API's type aliases (29%) get their docs (on the schema with `.describe()` or on the
  alias), `{@link}` use, examples that compile.
- **Tooling:** `eslint-plugin-jsdoc` (a new devDependency) for the comment shape; TypeDoc's
  `validation.notDocumented` in the Hub's extraction; a **ratchet** on p601's `docs.json`: per
  folder, coverage may not drop (`yarn verify:baselines` fails), so the review plans raise it and
  nothing else lowers it. Rules start as warnings where the code isn't there yet.
- **Lint rules for the simulation** (p604 §4): no `Math.random`, `performance.now` or `Date` in
  simulation folders (allow-listed exceptions with a reason).
- **The CLAUDE.md split** (p600 §8): the root file becomes the map plus the rules; the subsystem
  sections move into nested `CLAUDE.md` files next to their code (after p608's moves the paths are
  final; before them the split follows today's folders, and p608 moves the files with the code).

## Inputs

- p600 §3, §5, §8; p602's decisions; p604 §4; p601's `docs.json`.
- The JSDoc that already reads well (the sky box, LOD and spatial modules) as the style's examples.

## Done when

- The standards are in CLAUDE.md (short) with the detail in a Hub "Project" page or
  `docs/techniques/coding-standards.md`.
- `yarn lint` runs the JSDoc rules; the Hub build runs TypeDoc's validation; the ratchet is part
  of `yarn verify:baselines` and the Stop hook.
- The nested `CLAUDE.md` files exist and the root file is a fraction of its 340 lines.
