Status: stub — not-implemented
Category: Refactoring, Documentation, Physics
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage C)
Blocked by: p605_coding-standards-and-documentation-tooling.md, p610_character-and-input-action-architecture.md
Blocks: p621_hub-docs-readme-and-claude-md-final.md, p511_network-transport-and-replication.md (the transport interface)

# Review: Physics — Stub

**This is a stub.** It fixes the scope, the inputs and the done criteria. Expand it into a full plan (grounding checked against the code, non-breaking phases, the Hub phase, versioning) when its blockers land: its details depend on p602's decisions.

## Goal

Applies p600 §5 (the per-file review standard) and p605's JSDoc style to every file in scope, and records the findings per file group in an "As found" list.

## Scope

- **Split the three largest files:** `PhysicsAPI.ts` (4,481 lines; `RigidBodyProxyAPI` alone ~985) into world, rigid body, collider, query, joint and stepping modules; `PhysicsAPITypes.ts` (3,212) along the same lines plus the protocol; `EngineRapier.ts` (2,612; `step` ~517 lines) per area, like the worker's `physicsSwitch*` files.
- The physics manager, tiers and tier policy, raycast, the worker and its switchboard.
- **The transport interface** in front of `postMessage` (p604 §4.5).
- **Remove the deprecated `RayCastOpts` aliases** (from p990: due in a major, this epic's).
- JSDoc: `core/Physics` is the worst folder (65 of 221 documented, 153 type aliases).

## Inputs

- p604 §4, p990's ray casting item (moved here), p500 (its snapshot repair touches the same modules: coordinate), p600 §2.
- p605 Phase 5's `notExported` warnings in scope (`yarn hub:build` lists each with its file and line; export the type with a summary or change the signature): `EngineColliderProxyAPI`, `EngineRigidBodyProxyAPI`, `EngineJointProxyAPI` (`EngineRapier.ts`) and `RigidBodyProxyAPI` (`PhysicsAPI.ts`), named by the `create*` functions' results.

## Done when

- Every file in scope reviewed against p600 §5, the findings fixed or filed (`docs/issues/` or a plan item).
- JSDoc coverage of the scope's public exports at 100% (p601's `docs.json`), members included; the ratchet raised.
- `yarn test`, `yarn verify:scenes` (snapshots and hashes unchanged unless stated), then `yarn verify:scenes --browser firefox` (p605 Phase 6: Firefox's hashes equal Chromium's), `yarn verify:baselines` (no unexplained growth), `yarn build`, `yarn hub:build`. The verify commands run for minutes to hours: when one starts, give the watch command, `tail -f .cache/verify/progress.log`.
- The Hub pages of the features in scope checked against the code; CLAUDE.md's nested files for them current.
