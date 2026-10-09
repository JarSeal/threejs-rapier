Status: in progress | Phases 1-2 implemented
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
  `yarn verify:baselines`, plus what's specific to the plan". The verify commands run for minutes to
  hours, so whoever starts one gives the watch command, `tail -f .cache/verify/progress.log`.

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

### Phase 2: the scene runner — done

1. `_dbg__TestBridge.ts` and its `?aekTest=true` gate (dev and test builds only).
2. `devTools/verify/scenes.ts` and `scenes.config.ts`, starting from the skill driver's launch
   code (Chrome discovery, the WebGL fallback flag).
3. `yarn verify:scenes [--only <sceneId>] [--config <name>] [--update] [--url <url>] [--webgl]`.
4. Run it over every scene; fix or allow-list what it finds, with an issue file per real bug.

As built (step 1):

- The bridge (`debug/TestBridge.ts`, the types and `registerTestBridge`; `core/Debug/_dbg__TestBridge.ts`)
  installs with `?aekTest=true` in the debug env **and prod test mode** (`mode: 'DEBUG' | 'PROD_TEST'`),
  from `InitEngine` right before `appStartFn`, so it sees the first load.
- Prod test mode has no probe (`registerPhysicsDeterminismProbe` is `IS_DEBUG_ENV` only), no step
  limit (`setPhysicsStepLimit` is a no-op there) and no physics boot overrides (`loadConfig` reads
  them in the debug env only). So the §3.2 matrix is: debug × three targets (errors, hash, snapshot)
  plus prod test × the config's target (errors only: without the step freeze its snapshot would
  catch physics at an arbitrary step). Four loads per scene, not six.
- `errors()` was dropped: the logger is `console`, and the runner's `console` / `pageerror`
  listeners see everything from the first script, before the bridge can install.
- `whenProbeDone()` was added: the probe's report through `onPhysicsProbeReport`
  (`_dbg__PhysicsDeterminism.ts`), not a parsed log line; `NOT_ARMED` without `?physicsProbe`,
  `TIMEOUT` when the scene's physics never reaches the step. The runner calls `freeze()` after it:
  a paused app loop never reaches the step.
- `whenSceneReady()` waits for `hasFirstSceneBeenLoaded() && !isCurrentlyLoading()` (after
  `loadEndFn`, so after the physics hold's release) plus two frames. `freeze()` pauses the app and
  master loops and the day-night cycle; TSL's `time` node still moves per render.
- `snapshot()` returns the PNG base64 encoded (`encodeRGBA8PNG`, byte exact).
- Checked on SwiftShader WebGL: `physicsTiers` at 120 steps hashes `49157b8f` on `WORKER_THREAD`/SAB
  and `MAIN_THREAD`; a 512 × 288 snapshot takes about 10 s there.

As built (steps 2-3):

- `playwright-core` 1.63.0 (exact pin, the skill's version: it reuses the Chromium that version
  downloaded). `yarn verify:scenes` runs `copyDecoders` and `gatherAppData` first, as `yarn dev` does
  (the gatherer plugin doesn't gather on start), then `tsx devTools/verify/scenes.ts`.
- Flags: `--only` takes ids or `*` globs, comma separated; `--config` a configuration
  (`workerSab`, `workerMsg`, `mainThread`, `prodTest`) or a set (`all`, the default; `quick` =
  `workerSab`); `--headed` added (risk 1). On WSL2 the WebGL fallback is the default without
  `--headed`, and it's logged.
- Own dev server on 8092 (the dev files self-check has 8091); a fresh browser context per page
  load, so no localStorage carries over; the physics boot override is written by an init script.
- Each debug configuration names the probe config it expects (`WORKER_THREAD/SHARED_MEMORY`,
  `WORKER_THREAD/MESSAGE_BATCH`, `MAIN_THREAD/`): a load that ran as something else fails (eg. no
  COOP/COEP headers, so SAB fell back). The debug configurations' hashes are also compared with
  each other, a mismatch printed as a warning (p101 says they match).
- Baselines per backend the page reports (`whenSceneReady`'s `backend`, added to the bridge, so a
  silent WebGPU → WebGL2 fallback never compares against WebGPU images):
  `.cache/verify/scenes/<webgpu|webgl>/baseline.json` + `baseline/<scene>.<config>.png`, the run in
  `last-run.json` + `last-run/` (with `*.diff.png` for a failed snapshot: the current image dimmed,
  the changed pixels red). Each entry records the commit (`+dirty` with local changes).
  `--update` records only runs without failures, merged into the file.
- Snapshot tolerance: mean RGB delta ≤ 0.5 and ≤ 0.2 % of pixels with a channel delta over 24
  (the max delta alone fails on one moving pixel). A run without a baseline is `NEW`, not a failure.
- Console warnings are recorded in `last-run.json`, not compared; console errors and page errors fail
  unless `scenes.config.ts` allows them. Prod test mode runs 3 s after the scene is ready.
- `physicsTiers`, all four configurations: about 95 s on SwiftShader; recorded, then passed again.
  Its dotted rings move a few pixels between loads (inside the tolerance; to look at in step 4).

As built (step 4):

- The first run over every scene (24 scenes × 4 configurations, SwiftShader) failed on snapshots
  of anything that moves with time: objects turned by frame-time systems and loopers, the day-night
  sky, the clouds and star twinkle (three's TSL `time`), and `physicsTiers`' plough. The time
  between scene ready and the freeze differs per load, so they did too.
- **The test clock** (the bridge, from its install): every frame advances by 1/60 s.
  `setFixedFrameDelta` (`MainLoop.ts`, debug and test only) gives the main loop and physics
  stepping (`stepPhysics`, which has its own timer) that delta, so one physics step per frame,
  and the bridge replaces `NodeFrame.prototype.update` so TSL `time` advances by it too (three
  r186's fields; re-check on a three upgrade). What a page shows then depends on how many frames
  ran, not how long they took. It stops TSL `time` on freeze (three's own animation loop keeps
  calling `update`).
- **The freeze is in the probe report's frame:** `whenProbeDone({ freeze: true })` freezes inside
  the report listener, so no frames run during a round trip to the runner. `freeze()` is async:
  it first pins physics interpolation to the newest snapshot for two frames
  (`setPhysicsInterpolationPinnedToNewest`, `PhysicsManager.ts`), so moving bodies show the step
  the probe hashed, not a timing-dependent blend of the last two (`physicsTiers`' rings).
  `TEST_BRIDGE_VERSION` 2.
- Cost: the probe takes its steps in frames, so loads are 2-3× longer on SwiftShader; the full
  matrix takes about 57 min a pass. `PROBE_TIMEOUT_MS` is 300 s.
- `--update` compares nothing with the baseline: it records every run without errors, timeouts
  or a wrong probe config (before, a changed snapshot blocked its own re-recording).
  `unstableHash` takes `configs`, like `skip`.
- Found and fixed: `docs/issues/scene-loopers-registered-on-the-previous-scene.md`. A scene looper
  created by scene code without a scene id went nowhere on a first load (`scene01`'s sphere never
  turned) or to the previous scene after a switch. `Scene.ts` now defaults to the loading scene
  (`setLoadingSceneId`, set by `loadScene`), and the running looper lists follow the current scene.
  A runtime fix: Phase 4 bumps the engine's patch version for it too.
- `scenes.config.ts`: `textureArrays` and `textureAtlases` allow the errors they trigger on purpose;
  `largeWorld` probes 30 steps (no bodies, about 1 s a frame on SwiftShader); `space`'s worker
  targets and `thirdPersonGymScene` have an `unstableHash` (`MutualGravity` reads the worker's last
  synced poses, its own JSDoc; characters aren't deterministic).
- Every run's output also goes to `.cache/verify/progress.log` (emptied when a run starts; the
  header prints the watch command), so `tail -f .cache/verify/progress.log` follows whichever run is
  going, from any terminal.
- Not acted on: every page warns "using deprecated parameters for the initialization function"
  from inside `@dimforge/rapier3d-compat` 0.19.3's own `init()` (our call passes nothing);
  SwiftShader's GL performance messages in heavy scenes. Warnings are recorded, not compared.
- Result on SwiftShader, recorded then rechecked: all 96 loads pass (92 in the full recheck, 57 min;
  `largeWorld` and `space` again after their config). Most snapshots are pixel-identical; the rest
  differ by at most 20/255 on 0.00 % of the pixels.
- For p604: with the test clock the gym's characters hashed alike in every target and run; their
  wall clock and `Math.random` remain. For the toolkit: `MutualGravity` could read per-step poses
  (`readBodyPositionsAtStep`, as the tier policy does) to be deterministic in the worker.

### Phase 3: baselines

1. `devTools/verify/baselines.ts`: reads the visualizer data, the TypeDoc model (built with the
   Hub's extractor when stale) and writes the three files. Its output goes to the same
   progress log as the scene runner's (`.cache/verify/progress.log`, emptied when a run starts).
2. `yarn verify:baselines [--update]`. First baselines committed.

### Phase 4: docs and versioning

1. CLAUDE.md: the commands, the "no test suite" sentence replaced, the verification line every
   p600 plan uses. With the watch command: an agent that starts `verify:scenes` or
   `verify:baselines` (in the background: they take minutes to hours) gives the user
   `tail -f .cache/verify/progress.log`, the one log every verify run writes. The run-aekasha-js
   skill points at the runner.
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
