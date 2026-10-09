Status: stub — not-implemented
Category: Build, Dev tooling, Marketing
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage B)
Blocked by: p607_sbp-foundation-feature-modules.md, p608_engine-folder-restructure.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md

# SBP Tooling, Profiles and Marketing — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Make the Smallest Build Possible visible and enforced (p600 §4.3), prove it with a minimal
example, and tell the world.

## Scope

- **`yarn sbp`:** builds, then reports each feature's size from the module graph, why each
  feature is in the bundle (the import chain from the entry), and the diff against p601's
  `bundle.json`. Budgets per feature and chunk in config; over budget fails, as the asset
  pipeline's budgets do.
- **The banner profile:** an example scene and app entry with a renderer, one scene, a camera and a
  mesh, no physics and no debug. Its gzip size is the measured floor and the Hub example's number.
- **The lite-renderer study** (p600 §4.4): what a profile on three's classic WebGLRenderer without
  TSL would cost the engine (a second material path) and save (well under the 635 kB gzip WebGPU
  floor). A recommendation, not an implementation.
- **Marketing:** SBP as a core principle in the readme's "Why Ækasha?", the Hub homepage's featured
  features, a Hub feature page with the real numbers, and the brand section in CLAUDE.md.

## Inputs

- p600 §4; p607's feature modules and manifest; p601's baselines.

## Done when

- `yarn sbp` runs in `yarn build` (skippable), with budgets for the app and the banner profile.
- The banner example is in the Hub with its measured size; the readme and the Hub say what SBP is.
