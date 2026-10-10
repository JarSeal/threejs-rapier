Notes for writing and implementing the plans in `docs/plans/`; the root `.claude/CLAUDE.md` keeps the project-wide rules, commands and workflow.

## Plans logic and structure

- Agentic coding plans are located in `docs/plans/`.
- The naming of the files has a special pattern: [priority number eg. "p520" or "_DONE"]\_[name-of-the-feature].md (eg. "p020_some-feature.md").
- The lower the priority number the higher the priority.
- Plans that have been implement (filename starts with "\_DONE\_") are kept if they provide useful information for another feature and when the whole larger concept/epic that consists of those plans is done those plans are removed.
- Plan header has some required and optional information lines:
  - Status (required): describes a status of the plan. This is usually something like "draft | not-implemented", "draft | feasibility study — not-implemented", or "implemented".
  - "Category" (optional): a general category that this particular plan falls into, usually one or two words like "ECS", "Assets", "Bug fix", "Refactoring", or "Physics".
  - "Blocked by" (optional): describes a plan file name that blocks this plan from implementation.
  - "Blocks" (optional): describes a plan file name that this plan is blocking the implementation.
  - "Epic" (optional): link to the epic (usually a Trello ticket).
- Bigger plans should have non-breaking phases described so that the changes can be reviewed and committed in smaller chunks.
- A refactoring plan's (p600's children) verification is `yarn test`, `yarn verify:scenes` and `yarn verify:baselines`, plus what's specific to the plan. Record the scene baselines on `main` (`yarn verify:scenes --update`) before the branch's first run.
- **Keep the Ækasha Hub current (plans):** when it helps, a plan's second-to-last phase (before the last one's versioning, changelog and marking the plan done) updates the Hub content and builds the relevant examples. Whoever writes the plan asks whether an example scene should be built for it.
- "Mark the phase done":
  - Append ` — done` to the phase heading (`### Phase 2: Units — done`).
  - Status line: `in progress | Phase 1 implemented`, then `in progress | Phases 1-2 implemented`, and so on.
  - When the built code differs from the plan, add an "As built" list under the phase, so later phases don't build on stale assumptions.
- "Mark the plan done" (the last phase's own steps included):
  - Status line: `implemented`, with the phases when it had some (`implemented (Phases 1-4)`, `implemented (Phases 1-3; Phase 4 dropped)`).
  - `git mv` the file to `_DONE_<same name>` (`_DONE_p094_….md`), then update the references to the old name: other plans' `Blocked by` / `Blocks` lines and mentions (drop a `Blocked by` that pointed only at this plan) and the CLAUDE.md files.
  - Update the root `.claude/CLAUDE.md`, the nested `CLAUDE.md` of a subsystem it changed, and `readme.md` where the change alters what they describe (see the root's Workflow).
  - Bump the versions in `package.json` and add (or extend) the branch's `CHANGELOG.md` entry (see Versioning), then run `yarn checkVersions --against main`.
