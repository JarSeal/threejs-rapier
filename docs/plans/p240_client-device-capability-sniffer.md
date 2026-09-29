Status: draft | not-implemented
Category: Performance, Settings
Related: \_DONE_p070_post-fx-system.md (`setPostFxEnabled` is one of the switches the recommendations target), p350_lod-system-research.md (the device levels are a natural LOD budget input), p063_triple-buffered-physics-transform-buffer.md (SAB availability is part of the probe), p112_procedural-sky-atmosphere-sun-and-env-bake.md (its sky box sun light `shadowPreset` uses the same `LOW`…`ULTRA` scale as the device levels, see §3.1)

# Client Device Capability Sniffer — Plan

Measure what the client device can do, once, and hand the result to the app so it can choose (or disable) settings before and during play. The result has three layers:

1. **Measurements**: what the browser exposes (WebGPU adapter info, features and limits, WebGL2 fallback caps, cores, memory hints, display) plus a short synthetic GPU and CPU benchmark.
2. **Verdict**: the measurements checked against **targets** (FPS, memory, GPU memory, cores, required features). Every target has an engine default and can be overridden in `CONFIG.ts` or per call.
3. **Levels and recommendations**: a device level (`LOW | MEDIUM | HIGH | ULTRA`, the same scale as the shadow presets) per category (GPU, CPU, memory, GPU memory) plus an overall level (§3.1), and suggested values (pixel ratio, antialias, shadow quality, PostFX, backend, physics worker target). They are advisory data. The engine applies nothing on its own (see §1.3).

It is opt-in at engine init (`AppConfig.deviceCapabilities.runAtInit`, default `false`) and always callable from app code (eg. a "Re-test my device" button in a game settings menu). With `saveToLS` (default `true`) the measurements are stored in localStorage and later boots skip the test while the stored result is still valid (§4).

Code-level name: `DeviceCapabilities` (the plan name keeps "sniffer"; in web terms "sniffing" usually means user-agent string guessing, which is only a small fallback here).

All phases are non-breaking: with `runAtInit` off and nobody calling the API, nothing runs and the benchmark code is never downloaded.

---

## 1. Scope decisions

### 1.1 What can and cannot be measured (read this first)

| Target | Source | Availability | Result when unavailable |
| --- | --- | --- | --- |
| FPS | Synthetic GPU benchmark → estimated frame time for a reference frame at the target resolution; display refresh rate via rAF | All browsers with WebGPU or WebGL2 | never unavailable, but it is an **estimate** (§1.2) |
| System memory | `navigator.deviceMemory` | Chromium only, bucketed (0.25…8), capped at 8 GB | `UNKNOWN` |
| JS heap limit | `performance.memory.jsHeapSizeLimit` | Chromium only, non-standard | `UNKNOWN` |
| GPU memory (VRAM) | **No web API exposes it.** Heuristic only: unified memory (Apple silicon, from adapter info) → a share of `deviceMemory`; integrated GPU → a smaller share; discrete → unknown | Heuristic, low confidence | `UNKNOWN` (common) |
| CPU cores | `navigator.hardwareConcurrency` | All (Safari may clamp) | — |
| CPU speed | Short main-thread micro-benchmark | All | — |
| WebGPU features/limits | `GPUAdapter.features` / `.limits` / `.info` | WebGPU browsers (`info` is coarse or empty on some) | fields `null` |

Each target check returns `'PASS' | 'FAIL' | 'UNKNOWN'`. `targets.unknownIs` (`'PASS' | 'FAIL'`, default `'PASS'`) decides how `UNKNOWN` counts toward `meetsTargets`. Otherwise a Firefox or Safari user would fail every memory target just because the browser doesn't say.

**Not done:** probing VRAM by allocating textures until failure. That can lose the device, crash the tab or push the OS into swap.

### 1.2 FPS is predicted, not observed

`requestAnimationFrame` is capped at the display refresh rate, so timing rAF frames only tells us "at least 60" (or 120, 144…). The benchmark instead measures **GPU throughput** (fill rate × shader cost, triangles) with vsync out of the picture. It then predicts the frame time of a configurable **reference frame** (`targets.referenceFrame`) at the target resolution. That is a proxy for the app's real scenes. Defaults are calibrated against the example app (Phase 2 task) and apps should tune them. Phase 4 adds the real check: it samples actual frame times once a scene is running.

The effective FPS target is `min(targets.fps, measuredRefreshHz)`. A 60 Hz display can never "fail" a 120 FPS target. The report shows both numbers.

### 1.3 Advisory, not applied

The engine has no graphics settings system yet (`createRenderer` options are set once by the app, and `ShadowQuality`/`SHADOW_PRESETS` in `core/LightManager.ts` are chosen per light). This plan therefore stops at data. The app reads `report.recommendations` and passes them where it wants, eg. `createRenderer({ devicePixelRatio: rec.pixelRatio, antialias: rec.antialias })` in `appStartFn`. A future "graphics settings" plan can consume the same report to apply settings automatically.

### 1.4 Benchmark on raw WebGPU / WebGL2, not three.js

The benchmark creates its own short-lived GPU device (WebGPU) or context (WebGL2) on a small offscreen canvas and destroys it afterwards. Why not three.js:

- It runs at engine init, **before** `createRenderer` (the app creates the renderer in `appStartFn`), so its result can shape the renderer options.
- A second `WebGPURenderer` would cost TSL node compilation (often seconds on a first compile) and a second full renderer.
- Raw pipelines with fixed WGSL/GLSL shaders measure throughput in milliseconds and give numbers that are comparable across runs.

The trade-off (synthetic ≠ the app's scene) is what §1.2 and Phase 4 address.

---

## 2. Config

New optional block in `AppConfig` (`src/_engine/core/Config.ts`), with defaults in the `config` default object:

```ts
deviceCapabilities?: {
  /** Run the check in InitEngine, before appStartFn. Default false (opt-in). */
  runAtInit?: boolean;
  /** Store the measurements in localStorage and reuse them on later boots. Default true. */
  saveToLS?: boolean;
  /** Days before a stored result is measured again. 0 = never expires. Default 30. */
  maxAgeDays?: number;
  benchmark?: {
    /** Run the GPU/CPU benchmark (false = static probe only; GPU and CPU levels from heuristics). Default true. */
    enabled?: boolean;
    /** Upper bound (ms) for the whole benchmark. Default 1500. */
    budgetMs?: number;
  };
  targets?: DeviceCapabilityTargets;
  /** Per-category level thresholds (§3.1), deep-merged over the engine defaults. */
  levelThresholds?: DeviceLevelThresholds;
};

type DeviceCapabilityTargets = {
  fps?: number;                       // default 60
  /** 'CANVAS' = current window size × devicePixelRatio. Default 'CANVAS'. */
  resolution?: 'CANVAS' | { width: number; height: number };
  referenceFrame?: {
    fullscreenPasses?: number;        // default 6 (scene + shadow + PostFX-ish overdraw)
    trianglesPerFrame?: number;       // default 1_000_000
  };
  minDeviceMemoryGB?: number;         // default 4
  minGPUMemoryMB?: number;            // default 2048
  minCpuCores?: number;               // default 4
  requireWebGPU?: boolean;            // default false
  requiredGPUFeatures?: GPUFeatureName[]; // default []
  /** Minimum device levels (§3.1), eg. { overall: 'MEDIUM', gpu: 'HIGH' }. Default {}. */
  minLevels?: Partial<Record<DeviceLevelCategory | 'overall', QualityLevel>>;
  unknownIs?: 'PASS' | 'FAIL';        // default 'PASS'
};
```

Targets are deep-merged: engine defaults ← `CONFIG.ts` ← per-call `targets`.

---

## 3. Public API (`src/_engine/core/DeviceCapabilities.ts`)

```ts
runDeviceCapabilityCheck(opts?: {
  force?: boolean;          // ignore a valid stored result and measure again
  saveToLS?: boolean;       // default: config value
  benchmark?: boolean;      // default: config value
  targets?: DeviceCapabilityTargets;
  pauseMainLoop?: boolean;  // default true; only matters when the loop is running (§5)
  onProgress?: (phase: 'PROBE' | 'GPU' | 'CPU' | 'DONE', progress01: number) => void;
}): Promise<DeviceCapabilityReport>;

getDeviceCapabilityReport(): DeviceCapabilityReport | null;  // last result (init, LS or a call)
evaluateDeviceCapabilities(targets: DeviceCapabilityTargets): DeviceCapabilityVerdict; // re-score, no re-measure
clearStoredDeviceCapabilityReport(): void;
addDeviceCapabilityListener(fn: (report) => void): () => void; // returns unsubscribe
```

- Concurrent calls share one in-flight promise.
- `evaluateDeviceCapabilities` lets a settings menu answer "what would ULTRA need / does this device meet the 'High' preset's targets" without running anything.

Report shape (`DeviceCapabilities/DeviceCapabilitiesTypes.ts`):

```ts
type DeviceCapabilityReport = {
  reportVersion: number;             // bumped when measuring changes → stored results re-measure
  measuredAt: number;                // epoch ms
  fromCache: boolean;
  measurements: {
    gpu: { api: 'WEBGPU' | 'WEBGL2' | 'NONE'; vendor; architecture; device; description;
           isFallbackAdapter; isUnifiedMemory: boolean | null; isIntegrated: boolean | null;
           features: string[]; limits: Record<string, number>; preferredCanvasFormat? ;
           webgl2?: { maxTextureSize; maxSamples; extensions: string[]; unmaskedRenderer? } };
    gpuMemoryMB: { value: number | null; source: 'HEURISTIC_UNIFIED' | 'HEURISTIC_INTEGRATED' | 'UNKNOWN' };
    memory: { deviceMemoryGB: number | null; jsHeapLimitMB: number | null };
    cpu: { cores: number | null; benchScore: number | null };
    display: { width; height; devicePixelRatio; refreshHz: number | null; hdr: boolean; wideGamut: boolean };
    env: { crossOriginIsolated: boolean; offscreenCanvas: boolean; isMobile: boolean | null; coarsePointer: boolean };
    benchmark: { fillRateMPixOpsPerMs: number; trianglesPerMs: number; usedTimestampQuery: boolean; durationMs: number } | null;
  };
  verdict: DeviceCapabilityVerdict;  // recomputed from measurements + current targets, never stored
};

type DeviceCapabilityVerdict = {
  targets: Required<DeviceCapabilityTargets>;
  checks: Record<'fps' | 'deviceMemory' | 'gpuMemory' | 'cpuCores' | 'webgpu' | 'gpuFeatures' | 'minLevels',
                 { result: 'PASS' | 'FAIL' | 'UNKNOWN'; measured: number | boolean | string | null; required: number | boolean | string }>;
  estimatedFps: number | null;       // at target resolution, reference frame
  effectiveFpsTarget: number;        // min(targets.fps, refreshHz)
  meetsTargets: boolean;
  failedTargets: string[];
  levels: DeviceLevels;              // §3.1
  scores: { gpu: number | null; cpu: number | null; memory: number | null; gpuMemory: number | null }; // 0..100, null = UNKNOWN
  recommendations: {
    pixelRatio: number;              // largest DPR ≤ window.devicePixelRatio whose estimated FPS meets the target
    antialias: boolean;
    shadowQuality: QualityLevel;     // a SHADOW_PRESETS key (§3.1)
    postFx: boolean;
    renderBackend: 'WEBGPU' | 'WEBGL2';
    physicsWorkerTarget: PhysicsWorkerTarget;
  };
};
```

### 3.1 Device levels

**One scale.** Device levels use the same `LOW | MEDIUM | HIGH | ULTRA` scale as the shadow presets, so a level can be used directly as a preset key:

- `ShadowQuality` enum + `SHADOW_PRESETS` in `core/LightManager.ts` (on `main` and on `skybox-overhaul`).
- On the `skybox-overhaul` branch, also `ShadowQualitySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'ULTRA'])` in `schemas/_helperSchemas.ts`. The light JSON `shadowPreset` and the sky box sun light (`SUN_LIGHT_DEFAULTS.shadowPreset: 'MEDIUM'` in `core/SkyBox/SkyLights.ts`, p112) use it.

**Shared type.** Add a general `QualityLevelSchema` (same enum) and `QualityLevel` type to `schemas/_helperSchemas.ts`, with `QUALITY_LEVELS` (ordered array), `compareQualityLevels(a, b)` and `minQualityLevel(...levels)`. Then make `ShadowQualitySchema` an alias of it (`export const ShadowQualitySchema = QualityLevelSchema`). This is non-breaking and the generated JSON schema is unchanged.

- **Merge order:** if this plan lands before `skybox-overhaul`, it adds `QualityLevelSchema` on `main` and the sky box branch turns its `ShadowQualitySchema` into the alias when it rebases. If the sky box branch lands first, this plan adds the alias there.
- **Imports:** `DeviceCapabilities` imports only the `QualityLevel` type and string literals, never `ShadowQuality` from `LightManager.ts`. That keeps it out of the `LightManager → Scene → SkyBox` import cycle that `SkyLights.ts` already works around.

**Categories.**

```ts
type DeviceLevelCategory = 'gpu' | 'cpu' | 'memory' | 'gpuMemory';

type DeviceLevels = {
  overall: QualityLevel;
  gpu: QualityLevel;              // always set (heuristic when the benchmark is off, §2)
  cpu: QualityLevel;              // always set (cores only when the benchmark is off)
  memory: QualityLevel | null;    // null = UNKNOWN (no navigator.deviceMemory)
  gpuMemory: QualityLevel | null; // null = UNKNOWN (common, §1.1)
  /** How each level was decided; shown in the debug tab. */
  sources: Record<DeviceLevelCategory, 'BENCHMARK' | 'HEURISTIC' | 'API' | 'UNKNOWN'>;
  /** A debug override is active (Phase 3). */
  forced: boolean;
};
```

**Default thresholds** (`levelThresholds` in §2 overrides them). A category gets the highest level whose threshold it meets. The benchmark-based numbers are starting values that Phase 2 calibrates.

| Category | Input | LOW | MEDIUM | HIGH | ULTRA |
| --- | --- | --- | --- | --- | --- |
| GPU (benchmark) | headroom = `estimatedFps / effectiveFpsTarget` at the target resolution | < 1 | ≥ 1 | ≥ 2 | ≥ 4 |
| GPU (heuristic) | adapter info, when the benchmark is off | fallback adapter or no GPU API | integrated, or WebGL2 only | discrete or unified memory | never (only the benchmark can rate ULTRA) |
| CPU | the lower of: cores, and benchmark score (thresholds set in Phase 2) | < 4 cores | ≥ 4 | ≥ 6 | ≥ 12 |
| Memory | `deviceMemory` GB | < 4 | ≥ 4 | ≥ 8 (the API's cap) | — (see rules) |
| GPU memory | heuristic MB | < 1024 | ≥ 1024 | ≥ 2048 | ≥ 4096 |

**Rules.**

- **Overall** is the lowest of the known category levels, because the weakest part is the bottleneck. `UNKNOWN` categories are skipped.
- **Memory cap:** `deviceMemory` never reports more than 8, so a reading of 8 is marked capped. It shows as `HIGH` but doesn't limit `overall`.
- **GPU depends on resolution:** the same GPU rates lower on a 4K DPR-2 display than at 1080p. The level answers "what can this device run here", not "how fast is this chip".
- **Shadow level:** `recommendations.shadowQuality` is `min(gpu, gpuMemory ?? gpu)`, because ULTRA's 4096² shadow maps need memory headroom. An app can pass it as a light's or the sky box sun light's `shadowPreset`, or use `SHADOW_PRESETS[level]`. The engine doesn't apply it (§1.3). A future `shadowPreset: 'AUTO'` that resolves to this level would be a separate change.
- **Intended use per category** (a guide for apps, not enforced):
  - GPU: rendering settings (shadows, PostFX, antialias, pixel ratio, sky/env bake resolution).
  - CPU: physics sub-steps, entity and character counts, spatial-index density.
  - Memory and GPU memory: texture resolution, streaming radius, cache sizes.

---

## 4. Storage and cache validity

- LS key `AEK_deviceCapabilities`, read and written with `lsGetItem`/`lsSetItem` (`utils/LocalAndSessionStorage.ts`, which already handles unavailable storage).
- Stored: `{ reportVersion, fingerprint, measuredAt, measurements }`. Only raw measurements are stored. The verdict is always recomputed, so changing targets in a new app version needs no re-measure.
- A stored result is used only when all of these hold:
  - `reportVersion` matches.
  - It is newer than `maxAgeDays`.
  - The fingerprint matches.
- Fingerprint: a hash of UA string, adapter `vendor/architecture/device/description` (or the WebGL unmasked renderer), screen size × DPR and `hardwareConcurrency`. A new GPU, a browser update, a different monitor or switching to the WebGL path makes it stale.
- The fingerprint needs a `requestAdapter()` on every boot (typically a few ms to tens of ms). That is the whole cost of a cache hit. The benchmark modules are dynamically imported only on a cache miss, so a cache hit never downloads them.
- A benchmark run while `document.hidden` (throttled) is postponed until the page is visible. A run that blew through `budgetMs` because of stalls is marked and not stored.
- Everything stays in the browser. The report is never sent anywhere by the engine. Hardware detail is fingerprinting-grade data, so an app that uploads it for telemetry needs to handle it accordingly.

---

## 5. Flow

**At init** (`src/_engine/InitApp.ts`): right after `loadConfig()`/`consoleBootText()`, before `createRootScene()`. It runs this early so the Rapier worker boot, asset work and scene registration don't compete with the CPU benchmark:

```ts
if (getConfig().deviceCapabilities?.runAtInit) {
  const { runDeviceCapabilityCheck } = await import('./core/DeviceCapabilities');
  await runDeviceCapabilityCheck();
}
```

The dynamic import keeps the module out of the main chunk for apps that don't use it. The report is ready for `appStartFn` through `getDeviceCapabilityReport()`. A first-run benchmark delays boot by up to `budgetMs`. No engine UI exists at that point, so the app's `index.html` splash covers it.

**From app code at runtime**: when the main loop is running and `pauseMainLoop` is true, the check pauses it (`toggleMainPlay(false)` in `core/MainLoop.ts`), runs, then restores the previous `masterPlay` state (it reads it first via `getReadOnlyLoopState()`). Otherwise the game's own rendering would share the GPU with the benchmark and skew it.

**Steps:**

1. **Probe** (`DeviceCapabilities/probe.ts`):
   - WebGPU: `navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })` for `info`, `features`, the relevant `limits` and `getPreferredCanvasFormat()`.
   - WebGL2: a temporary `webgl2` context for `MAX_TEXTURE_SIZE`, `MAX_SAMPLES`, extensions and `WEBGL_debug_renderer_info` (when allowed). The context is released with `WEBGL_lose_context`. This runs when WebGPU is missing, and always for the WebGL2 fallback fields.
   - Memory, cores, display (`screen`, DPR, `matchMedia` for HDR/P3/coarse pointer), `crossOriginIsolated`, `userAgentData.mobile` (UA fallback).
   - GPU memory heuristic (§1.1).
2. **Refresh rate**: median rAF interval over ~30 frames.
3. **GPU benchmark** (`DeviceCapabilities/_bench_gpu.ts`):
   - Own device and offscreen target at the target resolution, capped at 3840×2160.
   - Workload A: blended fullscreen quads running a fixed-cost fragment shader (ALU loop + texture sample), which measures fill rate × shader cost.
   - Workload B: instanced triangles, which measures geometry throughput.
   - Warm-up submit first (pipeline compile excluded). Then double the workload until one batch takes ≥ ~8 ms or the budget is used.
   - Timing: `timestamp-query` when the adapter has it, otherwise wall time around `queue.onSubmittedWorkDone()`.
   - WebGL2 path: the same workloads in GLSL, synced with a 1-pixel `readPixels`, plus `EXT_disjoint_timer_query_webgl2` if exposed.
   - `device.destroy()` / lose context at the end.
4. **CPU benchmark** (`DeviceCapabilities/_bench_cpu.ts`): about 150 ms of typed-array mat4 multiplies (ECS-transform-like work) after a JIT warm-up, reported as ops/ms.
5. **Score** (`DeviceCapabilities/scoring.ts`, pure functions):
   - Predict the reference-frame time from the throughputs and the target pixel count, then derive `estimatedFps`.
   - Normalise the gpu/cpu/memory/gpuMemory scores.
   - Rate each category's level from the thresholds, then the overall level (§3.1). An `UNKNOWN` category never lowers the overall level.
   - Run the target checks (including `minLevels`), then build the recommendations (the pixel ratio is solved against the FPS target, the shadow quality comes from the levels).

---

## 6. Phases

### Phase 1: Probe, config, cache, API (no benchmark)

- `QualityLevelSchema`/`QualityLevel` + helpers in `schemas/_helperSchemas.ts`, with `ShadowQualitySchema` aliased to it (§3.1).
- `DeviceCapabilitiesTypes.ts`, `probe.ts`, `scoring.ts` (levels from probe data only: GPU from heuristics, CPU from cores, memory and GPU memory from the API and heuristics), `DeviceCapabilities.ts` (API, LS cache, fingerprint, listeners).
- `AppConfig.deviceCapabilities` + defaults in `Config.ts`.
- `runAtInit` hook in `InitApp.ts`.
- FPS check is `UNKNOWN` in this phase.
- Engine minor bump + CHANGELOG entry.

### Phase 2: Benchmarks and FPS target

- Refresh-rate sampling, `_bench_gpu.ts` (WebGPU + WebGL2 paths), `_bench_cpu.ts`, `budgetMs`, the hidden-tab deferral, main-loop pausing for runtime calls and `onProgress`.
- The full verdict with `estimatedFps` and the pixel-ratio solver.
- Calibrate the `referenceFrame` defaults: run the example app's `sceneTestECS` on 2–3 machines (integrated laptop GPU, Apple silicon, a discrete GPU). Compare the predicted and observed FPS (debug stats panel) and tune the constants. Record the numbers in this plan.
- Calibrate the level thresholds on the same machines: the GPU headroom bands and the CPU benchmark-score bands. As a sanity check, each machine's GPU level should match the shadow preset it actually runs at the target FPS.

### Phase 3: Debug tab and level override

- `debug/DeviceCapabilities.ts` (thin entry) → `core/Debug/_dbg__DeviceCapabilities.ts` (the `_dbg__` + `loadDebugModuleAsync` pattern), a `createDebuggerTab({ id: 'deviceCapabilitiesControls', ... })`, and the id added to `DEFAULT_DEBUG_DRAWER_TAB_ORDER`.
- Tab contents:
  - Measurements and checks as a `debuggerListCMP` (PASS/FAIL/UNKNOWN per target).
  - The levels per category and overall, with their `sources`.
  - Buttons "Re-run (force)" and "Clear stored result".
  - Debug-only **forced levels** (`lsKey` persisted): overall and/or per category, each `OFF` or `LOW`…`ULTRA`. When set, `getDeviceCapabilityReport()` returns the forced levels (`levels.forced: true`) and the recommendations derived from them, so developers can test the LOW path on a strong machine. The override has no effect outside `IS_DEBUG_ENV`.
- Example app: enable `runAtInit` in `src/CONFIG.ts` and pass `recommendations.pixelRatio`/`antialias` to `createRenderer` in `src/index.ts`. App minor bump.

### Phase 4 (optional, may split into its own plan): Runtime verification

- After a scene has run N seconds (default 5, skipping load/warm-up), sample real frame times from `MainLoop` and store them as `measurements.observed = { sceneId, p50FrameMs, p95FrameMs, pixelRatio }`.
- When observed performance is clearly below the prediction, lower `estimatedFps` (and so the GPU level) for this device. Notify listeners with a `levelSuggestionChanged` flag so the app can offer "lower settings?" instead of silently changing anything.

---

## 7. Risks

1. **GPU memory target is heuristic only.** Browsers expose no VRAM figure. Expect `UNKNOWN` on most discrete-GPU and non-Apple devices. Mitigation: explicit `UNKNOWN` + `unknownIs`. Don't build gameplay-critical decisions on this target.
2. **System memory is Chromium-only and capped at 8 GB.** `minDeviceMemoryGB` above 8 can never pass. The scorer clamps the target to 8 and warns once.
3. **FPS is a prediction** from a synthetic workload (§1.2). It is only as good as the `referenceFrame` calibration. Thermal throttling, battery-saver modes (eg. iOS Low Power Mode caps rAF at 30) and background load at measuring time can produce a pessimistic stored result. Mitigations: `maxAgeDays`, fingerprint invalidation, `force` re-runs from the settings UI, and Phase 4.
4. **First-boot delay** of up to `budgetMs` (default 1.5 s) before any engine UI exists. Later boots cost one `requestAdapter()`.
5. **Two GPU devices briefly coexist** when the check runs at runtime. The benchmark device is destroyed right after. The main loop is paused so the two don't contend.
6. **Browser variance**: `GPUAdapter.info` is intentionally coarse or empty in some browsers (privacy), and `WEBGL_debug_renderer_info` is masked in Firefox/Safari. This weakens the fingerprint and the integrated/unified-memory heuristics, not the benchmark.
7. **Level thresholds are a judgement call.** The default bands are only as good as the Phase 2 calibration. They're overridable (`levelThresholds`), and the debug forced levels make every path testable regardless.

---

## 8. Files

New:

- `src/_engine/core/DeviceCapabilities.ts`: public API, cache, listeners
- `src/_engine/core/DeviceCapabilities/DeviceCapabilitiesTypes.ts`
- `src/_engine/core/DeviceCapabilities/probe.ts`
- `src/_engine/core/DeviceCapabilities/scoring.ts`
- `src/_engine/core/DeviceCapabilities/_bench_gpu.ts`, `_bench_cpu.ts` (dynamically imported)
- `src/_engine/debug/DeviceCapabilities.ts`, `src/_engine/core/Debug/_dbg__DeviceCapabilities.ts`

Changed:

- `src/_engine/schemas/_helperSchemas.ts`: `QualityLevelSchema`/`QualityLevel` + helpers, `ShadowQualitySchema` alias (§3.1)
- `src/_engine/core/Config.ts`: `AppConfig.deviceCapabilities`, defaults, tab order id
- `src/_engine/InitApp.ts`: the `runAtInit` hook, debug tab registration
- `src/CONFIG.ts`, `src/index.ts`: example usage (Phase 3)
- `package.json` versions, `CHANGELOG.md`

Reused:

- `lsGetItem`/`lsSetItem`/`lsRemoveItem` (`utils/LocalAndSessionStorage.ts`)
- `toggleMainPlay`/`getReadOnlyLoopState` (`core/MainLoop.ts`)
- The `LOW`…`ULTRA` scale of `ShadowQuality`/`SHADOW_PRESETS` (`core/LightManager.ts`) and `ShadowQualitySchema` (`schemas/_helperSchemas.ts`, `skybox-overhaul` branch)
- `PhysicsWorkerTarget` (`core/Physics/PhysicsAPITypes.ts`)
- `createDebuggerTab`/`debuggerListCMP` (`debug/DebuggerGUI.ts`)
- `loadDebugModuleAsync` (`utils/helpers.ts`)
- `llog`/`lwarn` (`utils/Logger.ts`)

---

## 9. Verification

- `yarn lint` and `yarn build` pass. `yarn build` + `dist-stats/bundle-stats.html`: with `runAtInit: false` and no app import, no DeviceCapabilities code is in the main chunk. On a cache hit, the `_bench_*` chunks are not requested (Network tab).
- `yarn dev` with `runAtInit: true`:
  - The first load logs a report and writes `AEK_deviceCapabilities`.
  - A reload uses the cache (`fromCache: true`, no benchmark).
  - Changing `targets` in `CONFIG.ts` re-scores without re-measuring.
  - Bumping `reportVersion` or clearing via the debug tab re-measures.
- Chrome DevTools rendering emulation / `forceWebGL`: the WebGL2 path produces a report. A browser with no WebGPU gives `api: 'WEBGL2'` and a `webgpu` check result that follows `requireWebGPU`.
- Firefox and Safari: memory and GPU memory checks read `UNKNOWN`, and `meetsTargets` follows `unknownIs`.
- Levels:
  - With the benchmark off, `gpu`/`cpu` come from `HEURISTIC`/`API` and never reach `ULTRA` via the heuristic.
  - `overall` equals the lowest known category, and a capped 8 GB memory reading doesn't lower it.
  - `minLevels: { overall: 'ULTRA' }` fails on a mid-range machine.
  - A forced `LOW` in the debug tab changes `recommendations.shadowQuality` to `LOW`.
  - `yarn gatherAppData` still produces an unchanged light/sky box JSON schema after the `ShadowQualitySchema` alias.
- Runtime call from the console / debug tab while a scene runs: the loop pauses and resumes in its previous state, and no GPU device is left alive (no WebGPU warnings, no FPS drop afterwards).
- Phase 2 calibration table: the predicted FPS is within ±25 % of the observed FPS on the calibration machines for `sceneTestECS`.
