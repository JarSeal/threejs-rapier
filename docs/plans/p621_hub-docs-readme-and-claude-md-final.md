Status: stub — not-implemented
Category: Documentation, Hub
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage D)
Blocked by: p611_sbp-tooling-profiles-and-marketing.md, p612_review-ecs-loop-config-init.md, p613_review-rendering-scene-assets.md, p614_review-physics.md, p615_review-sky-box.md, p616_review-lod-spatial-instancing-lines.md, p617_review-input-ui-hud.md, p618_review-debug-public-api.md, p619_review-schemas-pipeline-devtools-hub.md, p620_review-toolkit-and-app-code.md

# Hub Docs, Readme and CLAUDE.md: the Final Pass — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Close the epic: the Hub, the readme and CLAUDE.md describe the engine as it is after p600.

## Scope

- **Hub pages:** an Architecture page (the kernel and features, the layering, the frame stages, the
  feature install, the simulation / presentation split), the SBP page (with p611), the migration
  guide for the major (completed from p606 and p608's sections), the coding standards (p605) for
  contributors, the gameplay contracts (p603) as "where your feature goes".
- **The readme:** Features, Project structure and Examples rewritten for the new layout and entry
  points (`InitEngine`'s new signature, the feature list), SBP in "Why Ækasha?". The readme's
  Features list could become a short list linking the Hub's feature pages (`/hub/features/`), so
  the two don't repeat each other (p555's open question; it waited for a public Hub).
- **CLAUDE.md:** the root file's final map and the nested files checked against the code (p605's
  split); the commands from p601 and p611.
- The epic marked done; the `_DONE_` child plans kept or removed per the plans rule.

## Inputs

- Every child plan's "As built" lists.

## Done when

- `yarn hub:build` passes with no warnings about the new pages; JSDoc coverage of the public API
  at 100% (p601's `docs.json`); the readme's examples compile against the entries.
