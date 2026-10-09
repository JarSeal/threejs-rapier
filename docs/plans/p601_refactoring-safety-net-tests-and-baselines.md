Status: in progress | Phase 1 implemented
Category: Testing, Dev tooling
Epic: p600_whole-codebase-refactoring-and-documentation.md (Stage A)
Blocks: p606_layering-inversion-and-public-entry.md (no Stage B or C plan starts without it)
Related: `.claude/skills/run-aekasha-js/driver.mjs` (the Playwright driver the scene runner grows from), `core/Snapshot.ts` (`takeSnapshotAsync`), `core/Debug/_dbg__PhysicsDeterminism.ts` (the probe), `devTools/devFiles/selfCheck.ts` (the precedent for a self-starting dev server check)

# Refactoring Safety Net: Tests and Baselines

p600 moves and rewrites most of the codebase, and the repo has no tests. This plan builds the net
first: unit tests for pure logic, a scene runner that loads every scene and compares what it sees
with the last good run, and committed baselines for what the refactoring must not grow by accident
(bundle size, API surface, JSDoc coverage).

All phases are non-breaking: they add tooling and change no runtime behaviour, except a dev-only
test bridge (Phase 2) that ships in no production build.

---

## 1. Goal

- **Unit tests** (`yarn test`) for the engine's pure modules, fast enough to run on every change.
- **A scene runner** (`yarn verify:scenes`) that loads every scene in the generated data and fails
  on new console or page errors, changed snapshots or changed determinism hashes.
- **Baselines** (`yarn verify:baselines`) for bundle sizes per chunk, the public API surface and
  JSDoc coverage, diffed against a committed copy, so a refactor's PR shows what it changed.
- Each p600 child plan's verification section is then "`yarn test`, `yarn verify:scenes`,
  `yarn verify:baselines`, plus what's specific to the plan".

## 2. Grounding (checked against the code, 2026-10-09)

- No test script, no runner dependency (`package.json`). CLAUDE.md says so.
- **The run-aekasha-js skill's driver** (`.claude/skills/run-aekasha-js/driver.mjs`, 156 lines)
  uses `playwright-core` installed in the skill's own folder (not the project's), a system Chrome,
  navigates, waits, captures console and page errors and saves a screenshot. Headless WebGPU
  can't render on WSL2; `DRIVER_WEBGL=1` hides `navigator.gpu` so the engine falls back to its
  WebGL2 backend on SwiftShader (the same TSL graphs, compiled to GLSL).
- **Scene selection:** `?startScene=<sceneId>` (`core/Config.ts:307`, honoured in the debug env and
  prod test mode, `SceneLoader.ts:419`). The scene ids are in `src/_engine/generatedAppData.json`.
- **Snapshots:** `takeSnapshotAsync` (`core/Snapshot.ts:221`) renders the current view off screen
  into RGBA8, with the debug helpers hidden, PostFX included; `snapshotToBlobAsync` encodes it.
- **Determinism:** `?physicsProbe=N` freezes physics N steps after each scene enter and logs
  `[PhysicsProbe] <sceneId> | <workerTarget>/<transport> | <interpolation> | <steps> | <hash>`
  (`_dbg__PhysicsDeterminism.ts:233`). The worker target and SAB are boot overrides in
  localStorage (`DEBUG_PHYSICS_API_BOOT_LS_KEY`, `_dbg__PhysicsBootOverrides.ts`), so a runner can
  set them before the page loads.
- **Bundle data:** `rollup-plugin-visualizer` writes `dist-stats/bundle-stats.html` (the module
  tree with rendered and gzip sizes, embedded as JSON). The Vite build writes `dist/.vite/manifest.json`.
- **API data:** the Hub's TypeDoc model, cached at `.cache/hub/typedoc.json`
  (`devTools/hub/api/extract.ts`), has every documented export and its comment.
- **Pure modules worth testing first:** `core/ECS.ts` (entity ids, storages, hooks),
  `utils/deepMerge.ts` (the sky box override merge), `core/Spatial/CellKey.ts`,
  `core/SkyBox/SkyTime.ts` (sun / moon / sidereal directions), `core/Lod/Impostors/Octahedral.ts`
  (the CPU side of the frame maps), `core/Lod/Impostors/ImpostorFormat.ts`, the Zod schemas in
  `schemas/` (accept the repo's own asset JSONs, reject known bad ones).

## 3. Design

### 3.1 Unit tests

- **Vitest** (a devDependency): Vite-native, so it resolves the same imports, `?raw` and the JSON
  imports without extra config. Tests live next to their module as `*.test.ts`, excluded from
  `tsc`'s app build only if they need Vitest globals (prefer explicit `import { describe } from 'vitest'`).
- `environment: 'node'` by default. A module that needs `window` at load is a finding for p606
  (headless core), not a reason for jsdom.
- No GPU in unit tests: anything that needs a renderer belongs to the scene runner.

### 3.2 Scene runner

- **`devTools/verify/scenes.ts`** (run with tsx), using `playwright-core` (a project devDependency
  now) and the system Chrome, like the skill's driver. It starts its own dev server on a free port
  (as the dev files' self-check does) or takes `--url`.
- **A dev-only test bridge** (`window.__AEK_TEST__`, installed only when `IS_DEBUG_ENV` and the
  `?aekTest=true` flag are both set, through a lazy `_dbg__TestBridge.ts`):
  - `whenSceneReady()`: resolves after the scene load finished and the physics hold released.
  - `freeze()`: pauses the app loop and the day-night time, so a snapshot doesn't depend on timing.
  - `snapshot({ width, height })`: `takeSnapshotAsync`, then PNG bytes.
  - `errors()`: the engine's logged errors and warnings since the page loaded.
- **Per scene, per configuration** (`WORKER_THREAD` with SAB, `WORKER_THREAD` without,
  `MAIN_THREAD`; debug and prod test), the runner records the console and page errors, the probe
  hash and a 512 × 288 snapshot.
- **Comparisons:**
  - Errors: any error not in the scene's allow-list fails.
  - Hashes: must equal the last good run of that scene, steps and configuration.
  - Snapshots: a per-pixel diff with a tolerance (mean and max delta), with a diff image written
    next to the failing one.
- **Baselines for hashes and snapshots are local** (`.cache/verify/`, gitignored): they depend on
  the GPU, the driver and the backend (WebGPU vs SwiftShader WebGL), so committing them would fail
  on every other machine. `yarn verify:scenes --update` records the current state as good;
  the workflow is "update on `main`, then run on the branch".
- **Per-scene config** in `devTools/verify/scenes.config.ts`: steps for the probe, scenes or
  configurations to skip (with a reason), known errors allowed, scenes whose characters make the
  hash non-deterministic (characters aren't hashed today, but scenes with them can still diverge).

### 3.3 Baselines

`yarn verify:baselines` writes and diffs three JSON files in `devTools/verify/baselines/`
(committed: none of them depend on the machine):

- **`bundle.json`:** per chunk, its rendered and gzip size; for the main chunk, the size of each
  top-level module group (three, Rapier, each engine folder, toolkit, app). From the visualizer
  data after `yarn build`. The diff prints growth over 1% or 2 kB gzip.
- **`api.json`:** every exported name of the documented API with its kind and module (from the
  TypeDoc model). The diff prints additions, removals and moves; p606's public entry makes this the
  public surface.
- **`docs.json`:** documented / total exports and members per folder (the numbers in p600 §2.5).
  p605 turns its diff into the ratchet: coverage per folder may not drop.

## 4. Phases

### Phase 1: Vitest and the first tests — done

1. Add `vitest`; `yarn test` and `yarn test:watch`; `vitest.config.ts` reusing the Vite config's
   resolve settings.
2. Tests for ECS entity ids and generations, storages and component hooks; `deepMerge` (arrays,
   index objects); `CellKey`; `SkyTime` (known sun positions at fixed times); `Octahedral` (map and
   unmap round trips, the frame basis at the poles); the schemas (every asset JSON in `src/`
   parses, a set of bad fixtures doesn't).
3. The Stop hook runs `yarn test` when `src/` changed (after lint and `tsc`).

As built:

- `vitest` 5.0.3 (exact pin; peer `vite ^6.4`, Node ^22.12). `vitest.config.ts` is standalone, not
  merged with `vite.config.ts`: that has no `resolve` settings, and its plugins (gatherer, Hub, dev
  files, visualizer) must not run under a test. It defines `__PROJECT_METADATA__` (from
  `getProjectMetadata`), which `core/Config.ts` reads at load; `tsconfig.json` includes it.
- `core/ECS.ts` can't load in Node as is: `core/Config.ts:304` reads `window.location.search` at
  module scope (the p606 finding). `ECS.test.ts` stubs only that, per file (`vi.hoisted` +
  `vi.stubGlobal`), not in a global setup file, so a new browser global at load fails the test.
  Everything else in its import graph loads in Node (type-only imports are elided).
- The schema tests are `devTools/gatherAppData.test.ts`: every gathered JSON in `src/` through the
  gatherer's own `validateGatheredJson` (so no second suffix table), and bad cases made by breaking
  one field of a repo asset, each checked against its issue path. No fixture files: a `*.scene.json`
  fixture under `src/` would be gathered.
- `ImpostorFormat.test.ts` too (§2 lists it, step 2 didn't).
- Found and fixed: `docs/issues/ecs-generation-wrap-after-4096-reuses.md` (a slot reused 4096
  times gave entities that were never alive and couldn't be deleted): `deleteEntity` now wraps the
  stored generation at 12 bits (`GEN_MASK`, `core/ECS.ts`). A runtime fix, so Phase 4 bumps the
  engine's patch version.
- For p619: a light's bad field is reported on `lightProps` alone (a plain union the gatherer's
  `expandUnionIssues` can't narrow); and `computeSkyRotation`'s matrix has determinant -1 (the
  hour frame is left-handed), so its JSDoc's "rotation" is loose (correct maths).
- `*.test.ts` is excluded from TypeDoc (`typedocOptions.exclude`) and from the Hub's API hash and
  stale check (`EXCLUDED_FILE_REGEX`, `devTools/hub/api/extract.ts`), so a test save doesn't
  rebuild the API docs.
- The Stop hook runs the tests when `src/`, `devTools/` or `vitest.config.ts` changed (not for a
  Hub-only change). 188 tests, about 0.6 s.

### Phase 2: the scene runner

1. `_dbg__TestBridge.ts` and its `?aekTest=true` gate (dev and test builds only).
2. `devTools/verify/scenes.ts` and `scenes.config.ts`, starting from the skill driver's launch
   code (Chrome discovery, the WebGL fallback flag).
3. `yarn verify:scenes [--only <sceneId>] [--config <name>] [--update] [--url <url>] [--webgl]`.
4. Run it over every scene; fix or allow-list what it finds, with an issue file per real bug.

### Phase 3: baselines

1. `devTools/verify/baselines.ts`: reads the visualizer data, the TypeDoc model (built with the
   Hub's extractor when stale) and writes the three files.
2. `yarn verify:baselines [--update]`. First baselines committed.

### Phase 4: docs and versioning

1. CLAUDE.md: the commands, the "no test suite" sentence replaced, the verification line every
   p600 plan uses. The run-aekasha-js skill points at the runner.
2. The Hub: the commands on the getting-started page (`hub/pages/`), `yarn hub:build`.
3. `CHANGELOG.md` entry: Project (the tooling; the bridge is dev-only) and Engine (a patch bump
   for Phase 1's ECS generation fix); mark the plan done.

## 5. Risks and open questions

1. **Headless GPU.** On machines where headless WebGPU can't render (WSL2), the runner uses the
   WebGL2 fallback, so WebGPU-only regressions need a headed run (`--headed`) on a real GPU.
2. **Flaky snapshots.** Animated scenes (day-night, characters, particles) must be frozen before
   the snapshot; scenes that can't be are compared with a looser tolerance or skipped with a reason.
3. **Run time.** Every scene × three physics targets × two modes is tens of page loads; `--only`
   and a `quick` configuration set (one target, debug only) keep the inner loop short.
4. **Characters** aren't deterministic (p604), so a scene with characters may need its probe steps
   chosen before they move, or the scene's characters left out as the gym's
   `ARE_CHARACTERS_ENABLED` does.
