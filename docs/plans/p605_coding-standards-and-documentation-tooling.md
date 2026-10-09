Status: in progress | Phases 1-3 implemented
Category: Documentation, Dev tooling, Standards
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage A)
Blocks: p612_review-ecs-loop-config-init.md, p613_review-rendering-scene-assets.md, p614_review-physics.md, p615_review-sky-box.md, p616_review-lod-spatial-instancing-lines.md, p617_review-input-ui-hud.md, p618_review-debug-public-api.md, p619_review-schemas-pipeline-devtools-hub.md, p620_review-toolkit-and-app-code.md (the standard they apply)
Related: \_DONE_p602_architecture-and-target-structure.md (the decisions the standard states), \_DONE_p604_multiplayer-viability-study.md (§4: the simulation rules), \_DONE_p601_refactoring-safety-net-tests-and-baselines.md (`docs.json`, the scene runner)

# Coding Standards and Documentation Tooling

The written standard every review plan (Stage C) applies, and the tooling that keeps it: JSDoc
shape in the lint, a documentation ratchet that stops coverage from dropping, the simulation's lint
rules (p604 §4), a cross-browser determinism run, and the CLAUDE.md split (p600 §8).

---

## 1. Goal

- **One standard, written down:** layering, the public / `@internal` split, naming, size, async and
  disposal, per-frame performance, SBP, the simulation rules and the JSDoc style, each concrete
  enough that a reviewer can point at a line and say which rule it breaks.
- **Documentation can't regress:** a change that adds an undocumented export to a folder fails
  before it's committed, so the Stage C plans raise coverage and nothing else lowers it.
- **The simulation rules are lint, not memory:** no wall clock or `Math.random` in simulation code,
  and type imports that can't pull the renderer into the physics worker.
- **Every session pays only for the context it uses:** subsystem detail in nested `CLAUDE.md` files
  next to its code.

## 2. Grounding (checked against the code, 2026-10-09)

Where the stub's assumptions no longer hold, it says so.

### 2.1 Documentation and the ratchet

- `devTools/verify/baselines/docs.json`: **1,290 of 2,036 exports documented (63%)**, members 209 of
  441. The stub's 2,029 / 1,282 is from p600's earlier count.
- **Part of the ratchet already exists:** `diffDocs` (`devTools/verify/baselines.ts`) fails
  `yarn verify:baselines` when a folder's documented *share* drops. What it lacks:
  - It measures the share, so deleting a documented export from a 63% folder fails it, and adding
    three documented exports and one undocumented one passes.
  - It reports shares, not which exports lost or lack their docs.
  - It runs only behind a full bundle build (12-20 s), so it isn't in the Stop hook. The TypeDoc
    model it reads is cached (`.cache/hub/typedoc.json`) and converts in about 6 s when the engine or
    toolkit changed.
  - `--update` records a drop as silently as any other baseline change.
- TypeDoc 0.28.20; `typedocOptions` has no `validation`. The Hub's extraction (`devTools/hub/api/
  extract.ts`) captures TypeDoc's messages, and `hubBuild.ts` prints each as a warning. With
  `validation.notDocumented`, that would be one warning per undocumented export and member, about
  1,000 lines on every `yarn hub:build`.

### 2.2 JSDoc as written today

- Tags in `src/_engine` and `src/toolkit`: 654 `@param`, 218 `@returns`, 44 `@internal`, 20
  `@deprecated`, 3 `@throws`, **2 `@example`**. The house style is `@param name text` (no hyphen, no
  type), `{@link X}` for cross-references, prose summaries that state behaviour and edge cases
  (`generateLodChain`, `setActiveSkyBox`, `registerSpatialDomain`).
- eslint-plugin-jsdoc's shape rules on `src/` today, from a dry run (the plugin installed outside
  the repo): 64 `check-param-names` (a `@param` naming a parameter that isn't there), 35 `@internal`
  with text after it (`empty-tags`), 61 `check-indentation`, 43 `tag-lines`, 40 blocks with no
  description, 11 `informative-docs`, 5 `no-types`, 4 unescaped inline tags, 2 `sort-tags`. Its
  `require-hyphen-before-param-description` and `require-*-type` rules contradict the house style
  and the TypeScript setting, and are left off.
- **eslint-plugin-jsdoc's current major (65.x, and 64.x) needs Node ≥ 22.22.2;** `.nvmrc` pins
  22.13.0. The newest version that runs on 22.13.0 is **63.3.3** (`^22.13.0 || >=24`).

### 2.3 The lint isn't enforced anywhere

- `yarn lint` is clean today (0 errors, 0 warnings, 469 files, about 10 s).
- **Neither hook reports lint results:** `.claude/hooks/verify.sh` runs `yarn lint --fix
  >/dev/null 2>&1` without checking its exit code, and `tool-lint.sh` does the same per file.
  CLAUDE.md says the Stop hook "runs lint"; it only autofixes. A rule this plan adds would be
  invisible to a session unless the hook reports it.
- Warnings are invisible in practice, so "start rules as warnings" (the stub) means "not enforced".
  This plan fixes the existing violations and lands each rule as an error, or doesn't add it.

### 2.4 Type-only imports

- **268 type-only imports without `import type`, in 122 files** (`consistent-type-imports` dry
  run): `src/_engine/core` 148, `debug` 25, `utils` 19, `workers` 18, `devTools/gatherAppData.ts`
  17, the rest scattered. All autofixable. They include p604 §4.6's three (`EngineRapier.ts`,
  `physicsWorker.ts`, `PhysicsAPITypes.ts` importing `LoopState` from `MainLoop`).
- `tsconfig.json` has `isolatedModules` but not `verbatimModuleSyntax`.
- **A trap for the fix:** under `verbatimModuleSyntax`, `import { type LoopState } from
  './MainLoop'` compiles to `import {} from './MainLoop'`, a side-effect import that still loads
  `MainLoop` (and three) into the worker. The rule must produce top-level `import type`, or
  `@typescript-eslint/no-import-type-side-effects` must forbid the inline-only form.

### 2.5 The simulation rules' targets

Simulation code today (p602's `features/physics/` and `features/character/` targets, before p608
moves them): `core/Physics/**`, `workers/physicsWorker.ts`, `workers/physics/**`,
`core/PhysicsAPI.ts`, `core/PhysicsManager.ts`, `core/PhysicsTiers.ts`, `core/PhysicsTierPolicy.ts`,
`core/Character.ts`, `core/Character/**`, and the toolkit's `APP_PHYSICS_STEP` systems
(`toolkit/ecs/effects/MutualGravity.ts`).

- `Math.random`: `DynamicCharacter.ts:1497-1500` (the tumble impulse; p610 replaces it). Outside
  simulation: `Spatial/SpatialIndexSystem.ts:1091-1096` (the debug oracle), the stress tests in
  `utils/` (demo code, moved by p608).
- `performance.now()`: about 25 reads in the simulation files, nearly all **profiling** (step stats,
  write-back timing, step-gate hold time, the worker's clock offset). The one that feeds the
  simulation is `getPhysGameTime()` (`PhysicsAPI.ts:984-988`, read by the characters; p610).
- No `Date` in simulation files.

### 2.6 The cross-browser run

- `devTools/verify/scenes.ts` launches Chromium only (`chromium.launch`, a system Chrome or
  Playwright's). Baselines are per backend (`.cache/verify/scenes/<webgpu|webgl>/baseline.json`),
  each entry with `hash`, `steps`, `probeConfig` and the snapshot.
- Playwright's Firefox is installed (`~/.cache/ms-playwright/firefox-1543`, from p604) and has no
  WebGPU, so it renders on WebGL2. p604 found Chromium 153 and Firefox 155 bit-identical on
  `physicsTiers`.

### 2.7 CLAUDE.md

- **116 kB in 352 lines** (about 29k tokens per session). Lines are the wrong measure: `## Commands`
  is 29 lines and 12 kB. The largest sections: Ækasha Hub 19 kB, Debug system 16 kB, Commands
  12 kB, Sky box 10 kB, Impostors 10 kB, Views 8 kB, LOD selection 7 kB, Physics 6 kB.
- **The Hub reads CLAUDE.md** (`devTools/hub/repoFiles.ts` `readClaudeMdSections`,
  `devTools/hub/claudeMd.ts`): every page's `aek:covers` must name a `###` section under the root
  file's `## Architecture`, and `::: claude-md` links to it. Moving a section into a nested file
  breaks both unless the Hub reads the nested files too. The stub doesn't mention this.
- **p602's move map tracks every file under `src/`** (`devTools/refactor/moveMap.ts`): a nested
  `CLAUDE.md` under `src/_engine/` needs a rule, or `moveMap.ts --check` fails.
- Some subsystems sit in one folder today (sky box, LOD, spatial, instancing, the debug framework,
  the Hub generator, the asset pipeline, the verify tools). Others are flat files in `core/`
  (physics: `PhysicsAPI.ts`, `PhysicsManager.ts`, `PhysicsTiers.ts` next to `Physics/`; views,
  viewports, snapshots, the ECS). A nested file in `core/Physics/` isn't loaded while a session
  works on `core/PhysicsAPI.ts`.

## 3. Decisions

### S1. The standard lives on the Hub

The standard is a Hub page, `hub/pages/documentation/coding-standards/`. Its readers are
contributors and anyone writing a feature, toolkit module or app system on the engine: the SBP,
simulation and JSDoc rules apply to them too. CLAUDE.md gets a short "Coding standards" section
with one line per rule, linking the page's source. There is no copy in `docs/techniques/`.

### S2. Lint rules land as errors on a clean tree

Each rule is added together with the fixes for its existing violations, as an error. A rule whose
violations are Stage C's work (`require-jsdoc` on every export, `require-example`) isn't added: the
ratchet (S4) handles presence. The hooks report lint errors (Phase 2).

### S3. eslint-plugin-jsdoc 63.3.3, pinned

It's the newest version that runs on `.nvmrc`'s Node 22.13.0. The upgrade to 64+ needs a Node bump
to ≥ 22.22.2 (every machine and the hooks' `use-node.sh`), a separate change.

### S4. The ratchet counts undocumented exports, by name

Per folder, the number of **undocumented** exports (and, separately, undocumented class and
interface members) may not grow. A share-based rule fails on deleting documented code; a count
rule fails only when undocumented code is added. The report names each newly undocumented export
(`file:line name`). It runs without the bundle build (`yarn verify:baselines --docs`) and in the
Stop hook when `src/_engine/` or `src/toolkit/` changed. `--update` won't record a count that grew
unless it's given `--allow-docs-drop`, so recording one is deliberate and shows in `docs.json`'s
diff.

A new folder starts at zero: everything in it is documented. p608's moves rename folders, so p608
records the baselines again (`--update --allow-docs-drop`, with the move as its reason).

### S5. TypeDoc validation: links and leaks, not presence

The Hub's extraction turns on `validation.notExported` (a public signature that names a type the
API doesn't export: an internal leaking, p600 §5.3) and `invalidLink`. It doesn't turn on
`notDocumented`, because the ratchet (S4) already gates presence and names what's missing.
TypeDoc's version would print about 1,000 warnings on every Hub build. This replaces the stub's
"TypeDoc's `validation.notDocumented`".

### S6. Type-only imports: lint plus the compiler

`@typescript-eslint/consistent-type-imports` (`fixStyle: 'separate-type-imports'`) and
`@typescript-eslint/no-import-type-side-effects` as errors, plus `verbatimModuleSyntax: true` in
`tsconfig.json`. With the compiler flag, `tsc`, and so the Stop hook, catches a missing `import
type` even if the lint is skipped. The lint rules avoid §2.4's trap: `import { type X }` alone
becomes `import type { X }`, never `import {}`.

### S7. Simulation rules by file list, profiling through one clock

- `eslint.config.js` has a `SIMULATION_FILES` list (§2.5's paths) with `no-restricted-properties`
  (`Math.random`, `performance.now`, `Date.now`) and `no-restricted-syntax` (`new Date`). Each
  message points to the alternative: the step index (`getPhysicsSubStepIndex`) or a seeded RNG
  (p603 C7; `toolkit/geometry/seededRandom.ts` until the RNG service exists).
- Profiling reads go through one module, `utils/StatsClock.ts` (`readStatsClock()`, documented
  "for measurement only: never an input to the simulation"), which the rule allows. The roughly 25
  profiling `performance.now()` calls in simulation files switch to it. There's no behaviour
  change, and the number of `eslint-disable` comments doesn't grow (p600 §2.1 counts them).
- Known violations are allow-listed in the config with the plan that removes them
  (`DynamicCharacter.ts`'s `Math.random` and `getPhysGameTime`: p610), not in inline disables.
- p608's codemod rewrites the list's paths (the layout report already lists configs that name a
  moving path).

### S8. The Firefox run checks hashes against Chromium's baseline

`yarn verify:scenes --browser firefox` runs the debug configurations (`workerSab`, `workerMsg`,
`mainThread`; `prodTest` has no hash) and compares **probe hashes only** against the Chromium
baseline's entries for the same scene, config and steps. Snapshots aren't compared: Firefox has
another rasterizer. It has no baseline of its own, and `--update` is refused with it. The Chromium
baseline is read from the `webgl` file, falling back to `webgpu`'s: the probe hash doesn't depend
on the render backend (Phase 6 checks that on the scenes both files have).

### S9. The CLAUDE.md split: folder-contained sections now, the rest with p608

- **Moved now, into a nested `CLAUDE.md` next to their code:** sky box (`core/SkyBox/`), LOD chains,
  LOD selection and impostors (`core/Lod/`), spatial index (`core/Spatial/`), instanced mesh pools
  (`core/Instancing/`), the debug framework's detail (`core/Debug/`), the Hub (`hub/` for authoring,
  `devTools/hub/` for the generator), the asset pipeline, dev files and verify commands' detail
  (`devTools/assetPipeline/`, `devTools/devFiles/`, `devTools/verify/`), and the plans' rules
  (`docs/plans/`).
- **Stay in the root until p608 gives them a folder:** ECS core, physics, views, viewports,
  snapshots, the data pipeline, bootstrap, build config. A nested file would load only for part of
  their code (§2.7). p608 moves them out with the code.
- **The root keeps:** the project and brand, one line per command, the map (each nested file in one
  line, so a session knows where the detail is), the coding standards (S1), the rules that apply
  everywhere (the `#region` rule, the `_dbg__` pattern, Node, the Hub and readme upkeep),
  versioning and workflow.
- Text moves verbatim; rewriting it is p621's job.
- **Target:** the root at or under 45 kB after this plan (from 116 kB), and about 27 kB after p608
  moves the rest. Measured in bytes, not lines.
- The Hub reads every tracked `CLAUDE.md`: a nested file's `## ` headings are sections like the
  root's Architecture `###` ones, under the same names, so no `aek:covers` changes (Phase 7).

### S10. No example scene

This plan changes tooling and documents, not engine behaviour: no Hub example or scene. The Hub
work is the standards page (S1) and the Hub's reading of nested CLAUDE.md files.

## 4. Phases

Each phase is its own commit and leaves the tree compiling, linting clean and passing `yarn test`.
p600's refactoring verification applies (`yarn test`, `yarn verify:scenes`, `yarn
verify:baselines`). **Before the branch's first code change, record the scene baselines on `main`**
(`yarn verify:scenes --update`, about an hour on SwiftShader).

### Phase 1: the standard — done

Documents only.

1. Check how TypeDoc renders a Zod-inferred type and its fields (`SkyBoxDef`, a `*Params` type from
   `schemas/`): whether JSDoc on a schema's shape keys reaches the inferred type's properties, and
   what `.describe()` feeds (the generated JSON Schemas' editor tooltips; 105 calls today). Decide
   the schema rule from what renders, and record it as "As built".
2. Write `hub/pages/documentation/coding-standards/` (`index.html` with its `aek:` metas and slots,
   one `.md` per slot):
   - **Layering and placement:** engine ← toolkit ← app (p600 §3.1, p602 D10; the lint lands in
     p606), the folder map (p602 D2, D6), debug code colocated through the one loader (D4).
   - **Public API:** entry points only (D3), `@internal` on everything else, options objects
     (p600 §3.6).
   - **Naming:** the verbs (§3.6), PascalCase files with the asset-id exception (D7), no `Manager`.
   - **Size:** about 800 lines per file and 150 per function (p600 §5.6).
   - **Async and disposal:** re-check the scene, entity or request after every `await` (a scene
     switch or a newer call wins), listeners and `on*` return their remover, every GPU resource has
     an owner that disposes it, three r186's render objects freed by `dispose`.
   - **Per-frame code:** no allocations (module-level scratch objects), storages read once per frame
     (`world.getStorage`), no closures or array methods per entity in hot loops, no redundant GPU
     state changes; the `perf-auditor` agent as the check.
   - **SBP:** no module-level side effects, heavy dependencies behind `import()`, debug behind the
     loader (p600 §4.1).
   - **Simulation:** p604 §4 rules 1, 2, 3, 5, 6, 7, 8 and 9 as code rules (step-index time, the
     seeded RNG, intents only, plain-data messages, `import type` across the boundary, data
     components, reading state at the step, one Rapier build), with the lint that enforces each.
   - **Type hygiene:** no `any`; an `eslint-disable` carries `-- reason`; a TODO becomes an issue
     file or a plan item.
   - **Tests:** a `*.test.ts` for pure logic (p601).
   - **JSDoc style**, with examples taken from the sky box, LOD and spatial modules:
     - The summary says what it does and what the signature can't (when it's a no-op, what wins
       on overlapping calls, what it owns).
     - `@param name text` with no hyphen and no type, only where it adds something.
     - `@returns` when the result has cases (null, a remover).
     - `@example` on every entry-point API (D3).
     - `@remarks` for traps (three r186's).
     - `@internal` as an empty tag (the reason goes in the summary).
     - `@deprecated` naming the replacement and the major that removes it.
     - `{@link X}` only for something TypeDoc resolves.
     - Type aliases (the Physics API's protocol types) documented on the alias, the union
       documented once.
     - Zod types per step 1.
     - **Examples compile:** the rule is written now; the check (extract each `@example` and run
       `tsc` on it) needs the `aekasha` import alias and is added to p606.
3. CLAUDE.md: a "Coding standards" section, one line per rule, linking the page's source.
4. `yarn hub:build` passes.

**As built:**

- The open questions at the expanded plan's review went with the recommendations: S3 (pin 63.3.3),
  S5 (no `notDocumented`), S9 (folder-contained sections now).
- Step 1, Zod types (TypeDoc 0.28.20, Zod 4.4.3):
  - TypeDoc renders all 57 `z.infer` / `z.input` aliases in `schemas/` as an opaque reference
    (`z.infer<typeof X>`), with no fields. None has a comment.
  - JSDoc on a shape key **does** reach the inferred property in the editor's hover. `.describe()`
    doesn't: it reaches only the generated JSON Schemas, so the asset JSON editor's tooltips.
  - `typedoc-plugin-zod` 1.4.3 (TypeDoc 0.23-0.28) expands an inferred object type into its fields,
    carrying the shape keys' JSDoc (tested on a plain `z.object`; not yet on unions such as
    `CameraProps`, or on `.extend()` chains). It ignores `.describe()`.
  - **The rule:** a summary on the exported alias, JSDoc on each shape key, and a one-line
    `.describe()` kept on fields authored in asset JSON files (the editor tooltip). Phase 5 adds
    the plugin to the Hub's extraction (step 3a), so the API reference shows the fields.
- The page is `hub/pages/documentation/coding-standards/` (`intro.md`: the rules; `jsdoc.md`: the
  JSDoc style), `aek:order` 80 under Documentation. It cites no plan numbers (no Hub page does).
  It states the rules without saying how they're checked: each later phase adds its check to the
  rule it enforces (the lint, the ratchet, the Firefox run) when the check lands.
- The `@example` "compiles" rule leaves imports out of the example (the check adds the entry's).
  The check itself is p606's (add it to p606's stub when this plan is marked done).
- The search index grew 988 → 1,014 kB, **10 kB under** `hub:build`'s 1 MB warning. Phase 5's Zod
  plugin may push the API docs over it; that phase measures it, and if it does, it cuts the index
  (p552 §2.4: the members or the stored summaries) rather than raising the limit.
- `hub:build`: 286 pages, the same 23 warnings as before (TypeDoc's unused `@param`s and unresolved
  `{@link}`s, which Phase 4's lint and Phase 5's validation pick up).
- CLAUDE.md: the "Coding standards" section (2.6 kB) between Architecture and Versioning.

### Phase 2: lint enforcement and type-only imports — done

1. `verify.sh`: after `yarn lint --fix`, run `yarn lint` again and exit 2 with its first 30 error
   lines when it fails. `tool-lint.sh`: after `--fix`, print the file's remaining errors to stderr
   and exit 2, so the session sees them at the edit. Warnings don't block.
2. `eslint.config.js`: `consistent-type-imports` and `no-import-type-side-effects` as errors (S6);
   `yarn lint --fix` converts the 268 imports.
3. `tsconfig.json` (and `hub/tsconfig.json`): `verbatimModuleSyntax: true`. Fix what `tsc` reports
   beyond the lint (type re-exports needing `export type`, TS1205).
4. Check the physics worker's bundle: its modules are unchanged (`bundle.json`'s worker chunk). A
   type import that was a side-effect import before shows up here.
5. Verification: `yarn lint`, `tsc`, `yarn test`, `yarn verify:baselines` (bundle and API
   unchanged), `yarn verify:scenes --config quick`.

**As built:**

- The scene baselines were recorded on `main` before this phase (`ee5a641`, `webgl`, 96 entries).
- The hooks fix and report in one pass: `yarn -s lint --fix --quiet` exits 1 with the errors it
  couldn't fix (shown, exit 2), and 2 when ESLint itself failed; no second lint run (§5 risk 1).
  The Stop hook takes about 29 s on a clean tree. `tool-lint.sh` shows the edited file's remaining
  errors and skips a file outside the project (ESLint fails on one). ESLint 9 has no `unix`
  formatter, so both print `stylish`'s lines.
- The rules' count was 185 declarations in 91 files plus 15 inline-only `import { type X }`: the
  rule reports one per declaration, not per name (the plan's 268). Two of the 15 were in the
  generated `generatedAppFns.ts`, fixed in `gatherAppData.ts`'s emitter.
- `consistent-type-imports` has `disallowTypeAnnotations: false`: the 35 `typeof import('…')`
  annotations that type the debug loader's modules stay (they're erased and load nothing).
- `verbatimModuleSyntax`: `tsc` and `tsc -p hub` reported nothing beyond the lint (no TS1205 or
  TS1484). `hub/tsconfig.json` inherits it through `extends`, so it's unchanged.
- The bundle is byte-identical to the committed `bundle.json`, every chunk, `physicsWorker.js`
  (2,308,147 B) and the main chunk included: esbuild already dropped imports used only as types,
  so the rules change the source, not the output. API and docs baselines unchanged.
- `yarn verify:scenes --config quick`: 24 of 24 passed against `main`'s baselines (966 s).
- The Hub page's `import type` rule names its check; CLAUDE.md's Workflow describes the hooks.

### Phase 3: the simulation rules — done

1. `utils/StatsClock.ts` (`readStatsClock`), and the profiling `performance.now()` reads in §2.5's
   files switched to it.
2. `eslint.config.js`: `SIMULATION_FILES`, the restricted properties and syntax with their messages,
   and the allow-list with the owning plan (S7).
3. CLAUDE.md's Physics section: the rule in one line.
4. Verification: as Phase 2, plus the full `yarn verify:scenes` (the hashes are unchanged: profiling
   reads never fed the simulation).

**As built:**

- 19 restricted reads, not about 25: 16 profiling (step timing, write-back latency, step-gate hold
  time, ray stats, the ray helpers' draw time) switched to `readStatsClock`, and 3 in `PhysicsAPI.ts`
  (the pause bookkeeping in `stepPhysics` and `setPhysicsPauseTime`, and `getPhysGameTime`) that
  feed the characters through `getPhysGameTime`, so they aren't measurement.
- ESLint allow-lists by file only, and allow-listing `PhysicsAPI.ts` would drop the rule for the
  whole facade. The game-time reads go through `readPhysicsWallClock`
  (`core/Physics/PhysicsWallClock.ts`, `@internal`), and that file alone is allow-listed (p610
  deletes it). `DynamicCharacter.ts`'s entry allows `Math.random` only; its clock reads stay
  restricted. A later config entry replaces the rule's options for its files, so each entry lists
  what stays restricted (`SIMULATION_RESTRICTED_PROPERTIES` filtered).
- `PhysicsUtils.ts` has a dead, exported duplicate of `setPhysicsPauseTime` (nothing calls it). It
  reads the wall clock through `readPhysicsWallClock` like the live one; deleting it is an API
  removal, left to p614.
- `SIMULATION_FILES` adds `utils/world/movingPlatform.ts` (an `APP_PHYSICS_STEP` system §2.5
  missed; p608 moves it to `toolkit/ecs/MovingPlatform.ts`). No violations there. The rules: the
  three properties (destructuring included) and `new Date` / `Date()` as syntax.
- `@internal` exports are in TypeDoc's model (no `excludeInternal`), so `api.json` records the two
  clocks (`--update`); `docs.json` rose in both folders. The bundle is within tolerance:
  `physicsWorker.js` 14 B smaller (2,308,133 B).
- The Hub page's time and randomness rules name the lint; CLAUDE.md's Physics section has it in
  one line. `hub:build`: 288 pages, the same 23 warnings; the search index 1,016 kB (8 kB under the
  1 MB warning).
- `yarn verify:scenes` (full, 3,222 s): 95 of 96 passed, every hash unchanged. `scene01V2
  mainThread`'s snapshot failed (changed 0.22 % over the 0.2 % limit): its red wireframe sphere,
  spun by a scene app looper, is one app frame off on some loads. That's pre-existing: on HEAD
  without this phase it failed 1 of 4 runs with the identical diff (mean 0.065, max 156). The
  looper counted `deltaApp` from the scene's first frame, and a load spends a varying number of
  frames with physics held. Fixed in `scene01_v2.ts`: the angle is computed from
  `getPhysicsSimClock()` (the world's simulated time, which doesn't advance while held; 2 rad/s as
  before), the standard's own rule for presentation. `scene01V2`'s baselines were recorded again on
  this branch (`--only scene01V2 --update`; `main` doesn't have the change), then 2 of 2 runs
  passed in every configuration with exact snapshots.

### Phase 4: JSDoc lint

1. `eslint-plugin-jsdoc` 63.3.3 as a devDependency (S3).
2. Rules for `src/**/*.ts` and `devTools/**/*.ts` (minus `generatedApp*`), as errors:
   `check-param-names`, `check-tag-names` (with TypeDoc's tags: `remarks`, `privateRemarks`,
   `typeParam`, `defaultValue`, `category`, `internal`), `empty-tags`, `no-types`,
   `escape-inline-tags`, `check-alignment`, `no-multi-asterisks`, `require-asterisk-prefix`,
   `tag-lines` (no blank line after the description), `check-indentation`, `sort-tags`,
   `require-hyphen-before-param-description: never`, `informative-docs`. The `require-*` rules stay
   off (S2).
3. Fix §2.2's violations. The 35 `@internal` blocks with text move the text into the summary;
   misnamed `@param`s are renamed to the parameter (or the destructured path, `opts.id`).
4. Verification: `yarn lint`, `yarn hub:build` (comments render the same; the API pages' warnings
   don't grow), `yarn verify:baselines` (`docs.json` only grows).

### Phase 5: the documentation ratchet and TypeDoc validation

1. `baselines.ts`:
   - `--docs` collects and diffs `docs.json` alone, without the bundle build or `api.json` (a new
     export is `api.json` attention by design, which would stop every feature's session).
   - `docs.json` gets `formatVersion: 2`: per folder the undocumented exports and members by name
     (`module#name`, `module#Owner.member`), plus the counts.
   - `diffDocs` fails on a folder whose undocumented count grew, naming each new one with its
     file and line from the model (S4).
   - `--update` refuses a grown count without `--allow-docs-drop`.
2. `.claude/hooks/verify.sh`: when `src/_engine/` or `src/toolkit/` changed, `yarn -s
   verify:baselines --docs` after the tests; on failure, exit 2 with the named exports.
3. `extract.ts`: `validation: { notExported: true, invalidLink: true, notDocumented: false }`
   (S5), and bump `EXTRACT_VERSION`. Count what it reports. Fix what's cheap (a missing export of a
   type the API names), and list the rest for the Stage C plan that owns the folder.
   a. `typedoc-plugin-zod` 1.4.3 as a devDependency, loaded by the extraction (Phase 1's As built).
      Check that the renderer shows the expanded fields (a union like `CameraProps`, an `.extend()`
      chain), what `api.json` and `docs.json` record for them, and the search index's size.
4. CLAUDE.md's `yarn verify:baselines` entry and the Stop hook's description: the count rule,
   `--docs`, `--allow-docs-drop`.
5. Verification: `yarn verify:baselines --update` (the new format), then a test run: add an
   undocumented export (the Stop hook fails, naming it), document it (it passes), delete a
   documented one (it passes).

### Phase 6: the cross-browser determinism run

1. `scenes.ts`: `--browser chromium|firefox` (default `chromium`). Firefox:
   - `firefox.launch` from playwright-core (the install hint `npx playwright-core install
     firefox`);
   - WebGL2 always (logged);
   - the debug configurations only;
   - hashes compared against the Chromium baseline (S8), no snapshots;
   - `--update` refused.
   The error checks apply as in Chromium; allowed Firefox-only messages go in `scenes.config.ts`
   with their reason.
2. Check that the `webgl` and `webgpu` baselines' hashes agree where both exist. If any differ, the
   hash depends on the backend, and Firefox compares against the `webgl` file only.
3. Run it over every scene. A difference against Chromium is a finding: the scene's simulation
   depends on the JS engine (a `Math` function, iteration order). It gets an issue file and an
   `unstableHash`-style entry per browser with the reason, never a silent skip.
4. CLAUDE.md's `verify:scenes` entry, and the refactoring verification for p610 and p614 (which
   change simulation code): `--browser firefox` before the PR.

### Phase 7: the CLAUDE.md split

1. `devTools/hub/repoFiles.ts`:
   - `readClaudeMdSections` reads the root's Architecture `###` sections and every tracked
     `CLAUDE.md` below the root (`git ls-files`), whose `## ` headings are sections under the same
     names;
   - each section keeps its file and line, so `::: claude-md` links to it;
   - the files go into the build's watched files.
   `aek:covers` and `coverageIgnore` keep working unchanged.
2. Move S9's sections verbatim into their nested files (a file starts with one line naming what it
   covers). The root gets the map: one line per nested file. The `#region` rule, the `_dbg__`
   pattern and the Workflow rules stay in the root.
3. `devTools/refactor/moveRules.ts`: the nested files move with their folders. `npx tsx
   devTools/refactor/moveMap.ts`, then `--check` passes.
4. The Workflow section: a subsystem change updates its nested `CLAUDE.md` (the readme and Hub
   rules' companion).
5. Verification: `yarn hub:build` (no coverage warnings, the `claude-md` links resolve), the root
   at or under 45 kB, and every moved line present in exactly one file (a script diff of the
   section texts, before and after).

### Phase 8: versioning and mark done

1. Versions:
   - Engine, toolkit and app **patch** bumps: Phases 2-4 change their source (`import type`, the
     stats clock, JSDoc fixes) without changing behaviour.
   - `CHANGELOG.md` entry with Engine, Toolkit, App and Project sections (the hooks, the ratchet,
     the Firefox run, the split).
   - `yarn checkVersions --against main`.
   - This replaces p600 §11's "Stage A: no part bumped", which assumed documents only.
2. `readme.md`: the `--browser firefox` flag where it lists the verify commands, if it does.
3. Mark the plan done (`_DONE_p605_…`), update the Stage C plans' references and p600's roadmap
   row.

## 5. Risks and open questions

1. **The Stop hook gets slower:** a second lint pass (about 10 s) and, after an engine or toolkit
   change, the TypeDoc conversion (about 6 s, cached otherwise), inside its 180 s limit. If it
   becomes a burden, the second lint pass can lint only the changed files.
2. **The ratchet stops a session that adds an undocumented export.** That's the intent; the hook's
   message names the export and the fix.
3. **`verbatimModuleSyntax` may surface errors the lint doesn't fix** (type re-exports, a devTools
   file that mixes CJS habits). Phase 2 counts them first; if they're many, the flag waits and the
   lint alone carries the rule.
4. **Firefox on software WebGL may be too slow** for the heavy scenes: per-scene skips with a reason
   in `scenes.config.ts`, as for Chromium.
5. **Nested CLAUDE.md files load only when a session reads a file in that folder.** The root's map
   is what makes them discoverable for a task that starts elsewhere.
