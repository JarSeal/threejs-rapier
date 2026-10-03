Status: implemented (Phases 1-6)
Category: Debug, Performance, UI
Epic: Profiler (this plan is the base; later profiler plans build on its window, tab host and stats sources)
Related: _DONE_p345_gpu-memory-and-draw-call-debugger.md (its tab moves in, Phase 6), p240_client-device-capability-sniffer.md (device budgets next to the measured figures), p350_lod-system-research.md (the LOD plans measure their result with it), p354_gpu-driven-culling.md (GPU culling makes the CPU "in view" census an estimate of what the GPU draws, §2.7)

# Profiler Mega Window

The Statistics drawer tab and the stats-gl panels show a few numbers. This plan adds a draggable
**Profiler** window that shows far more of the scene and the engine's current state in real time.
It has the drawer's look: an icon tab row and declarative tab content. It is the base for later
profiler plans. Only these tabs are built here:

- **Overview**: key figures in one table, refreshed at a set rate, no graphs.
- **Objects**: a breakdown of entities, meshes, triangles, vertices and more, in view and total,
  with bars and small time series.
- **Settings**: what the Overview shows and in which order, the update rate, the entry points, and
  prodTest.
- **GPU memory**: the p345 drawer tab, moved in (Phase 6).

It opens from the on-screen stats panels (can be switched off), from a button in the Statistics
tab, and from a speedometer button next to the pause button in the top on-screen tools.

Debug tooling (`_dbg__` + dynamic import). It loads in prodTest only when its prodTest setting is
on. Every measurement it turns on is acquired while the window is open and released when it
closes, so a closed profiler costs nothing.

---

## 1. What already exists (reuse, don't re-measure)

| What | Where | Notes |
| --- | --- | --- |
| stats-gl panels (FPS, CPU, GPU, CPT) + PHY, TFPS | `core/Debug/_dbg__Stats.ts` | Debug env only (`registerStatsModule`). TFPS = 1000 / avg main-loop CPU time over 60 frames, so it doesn't see the GPU. `statsCmp` is the panels' container. stats-gl only adds a click listener in minimal mode, which is forced off, so a click on the container is free to use. |
| Loop timing hooks | `core/MainLoop.ts` `mainLoopForDebug` | `startCustomMeasurements()` at loop start, `updateRestOfStats()` at the end. The production loops have no hooks. |
| GPU timer | `core/Debug/_dbg__GPUTimer.ts` | Refcounted (`_acquireGpuTimer` / `_releaseGpuTimer`): switches `trackTimestamp` on, taps every render context, shares one resolve (`_requestTimestampResolve`, `_onTimestampsResolved`, `_sumGpuMs`). WebGPU + `timestamp-query` only. |
| Physics step stats | `core/PhysicsAPI.ts` | `getLastPhysicsStepDuration`, `getLastPhysicsStepMessagingLatency` (`dispatchMs`, `writeBackMs`; `writeBackMs` is transit time on `MESSAGE_BATCH` and read latency on `SHARED_MEMORY`, never summed with the step). Boot-time flag `stepStatsEnabled`: the worker allocates its SAB stats buffer at `CREATE_WORLD` only when it is on. |
| Ray stats | `core/Raycast.ts`, `core/PhysicsAPI.ts` | `setRayCastStatsEnabled` / `getRayCastStats`, `setPhysicsRayStatsEnabled` / `getPhysicsRayStats`. Plain booleans shared with the Raycast tab (no refcount). |
| PostFX pass GPU times | `debug/PostFXProfiler.ts` | `setPostFxMeasureEnabled`, `getPostFxPassStats`. Console-only today. |
| Sky box bake stats | `core/Debug/SkyBox/_dbg__BakeStats.ts` | Uses the GPU timer. |
| Windowed counters | `utils/stats/IntervalCounterStats.ts` | min / max / avg per rolling window, allocation-free snapshots. |
| `renderer.info` | three r186 | `render.drawCalls/triangles/points/lines` for all passes of the frame. Reset at the start of three's animation frame, so it is read in a `LATE_MAIN` system (the p345 lesson). `memory.total` is three's own estimate. |
| GPU memory tab | `core/Debug/_dbg__GPUMemory*.ts`, `debug/GPUMemory.ts` | Tab id `gpuMemoryControls`, a `createDebuggerTab` def with `refreshIntervalMs: 500`, its own `LATE_MAIN` sampler (peaks are tracked while it is closed too). |
| Drawer tab machinery | `core/Debug/_dbg__DebuggerGUI.ts` (`buildTabContent`, `mountTab`, `unmountTab`, `refreshMountedTab`, intervals), `_dbg__DebuggerPaneBuilder.ts`, `_dbg__DebuggerList.ts` | `DebuggerTabDef`: sections (CMP / declarative pane / list), `lsKey` + `persistKeys`, `refreshIntervalMs`, `onOpen`, `onRefresh`. |
| Draggable windows | `core/UI/DraggableWindow.ts` | `registerDraggableWindow(id, …)`, `toggleDraggableWindow`, `saveToLS`, `isDebugWindow`, `showInProdTest` (its content module must then load with `loadDebugModuleAsync(importer, true)`). |
| On-screen tools | `core/Debug/_dbg__OnScreenTools.ts` `playTools()` | Play/stop prodTest, main loop, pause. In prodTest only when `getDebugToolsState(true).onScreenTools.showOnScreenToolsInProdTest`. |
| ECS counts | `core/ECS.ts` | `world.getEntityCount()`, `world.getEntitiesWith(type)`, `getAllECSWorlds()`. |
| Icons | `core/UI/icons/SvgIcon.ts` | `speedometer` exists (Statistics tab). No cog (`tools` is a wrench); `geometry-cube` is a single filled cube. |

There is no convention for marking debug helper objects. Only `userData.isHelperSymbol` on 3D
symbols exists (see §2.7).

## 2. Design

### 2.1 Window and tab host

- **Window:** id `aekProfiler`, title "Profiler", `isDebugWindow: true`, `saveToLS: true`
  (geometry and open state persist). Default 560×640 px, min 380×320. Registered once with
  `registerDraggableWindow('aekProfiler', { content, onClose })`, so a window restored from LS gets
  its content. `showInProdTest` comes from the setting (§2.3).
- **Layout:** a row of icon tab buttons at the top of the window body, in the drawer's menu style.
  The drawer's `.debugDrawerTabButton*` rules move into a shared SCSS mixin used by both. Below it
  are the selected tab's heading row (icon, title, clear-LS and header buttons) and its content,
  which scrolls.
- **Tab host:** the drawer's per-tab lifecycle (build the heading and sections, mount / unmount,
  the section refreshers, `refreshIntervalMs` only while visible, `onOpen` cleanup, `onRefresh`)
  moves out of `_dbg__DebuggerGUI.ts` into `core/Debug/_dbg__TabHost.ts`. It becomes a small
  factory, `createTabHost({ container, onMount })`, with `mount(def)`, `refresh(rebuild?)`,
  `unmount()` and `mountedId`. The drawer keeps its own menu, ordering, scene tabs and drawer
  state, and uses one host. The profiler uses another. Behaviour change for the drawer: none.
- **Profiler tabs are `DebuggerTabDef`s:** `createProfilerTab(def)`, `openProfilerTab(id)`,
  `updateProfilerTab(id, opts)` and `isProfilerTabOpen(id)` in the public `debug/Profiler.ts`, the
  same contract as the drawer functions. A tab can be moved between the drawer and the profiler by
  changing its registration call. Order: `orderNr`, then registration order (no config list yet).
  Profiler tabs never take `sceneId` in this plan.
- **Open tab** (and nothing else UI-wise) is saved in `AEK_debugProfilerUI`, next to the folder
  states.

**New icons** (16×16, `fill="currentColor"`, Bootstrap-style like the others, registered in
`SvgIcon.ts`):

- `profiler` (`profiler-pulse.svg`): the profiler's main icon, used by the Overview tab and the
  window's header icon. A rounded monitor frame with a pulse (ECG) line across it and a small
  stand: "vital signs". It is clearly not the `speedometer` (Statistics tab and on-screen button).
- `objectsCubes` (`cubes-wireframe.svg`): three isometric wireframe cubes (two below, one on top),
  outlines only. This keeps it apart from the filled `geometry` cube.
- `gear` (`gear-fill.svg`): a cog wheel. Bootstrap's `gear-fill` (MIT, the same source as the
  other icons).

### 2.2 Opening it

All three entry points call `toggleProfilerWindow()`: open and bring to front, or close when it is
on top (the `toggleDraggableWindow` semantics).

1. **On-screen stats panels.** `_initStats` adds a click handler to `statsCmp` (with
   `stopPropagation`, so the canvas never gets the click). It toggles the window when
   `openFromStatsPanels` is on. When on, the container gets `cursor: pointer` and the title
   "Open the profiler". When off, neither.
2. **Statistics tab.** A "Profiler" button (title "Open profiler"). The tab also gets the toggle
   **"Profiler mega window can be opened by clicking the on screen stats panels"** (default true).
   It is bound through a proxy target to the profiler's stored `openFromStatsPanels` (one source of
   truth, the `physicsStepTrackingProxy` pattern). Its change applies immediately, no reload.
3. **Top on-screen tools.** A `speedometer` button in `playTools()`, right after the pause button.
   It is active (`styles.active`) while the window is open; the title is "Profiler (open / close)".
   It shows in prodTest only when the profiler is enabled there (§2.4). The window's open and close
   call `_updateOnScreenTools('PLAY')`, so the active state follows.

Not in this plan: a default debug key (it can be added later with a `category`, following
`DefaultDebugKeyBindings.ts`).

### 2.3 Settings tab and persistence

LS key `AEK_debugProfiler`, flat object, persisted with `persistKeys`:

| Key | Default | Meaning |
| --- | --- | --- |
| `updateRateHz` | 4 | Overview and Objects refresh rate (options 1, 2, 4, 10). Drives the tabs' `refreshIntervalMs` and the census rate. |
| `overviewMetrics` | §2.6 default list | Ordered list of `{ id, visible }`. Unknown ids are dropped and new metrics appended on hydrate, so a saved list survives metrics being added. |
| `openFromStatsPanels` | true | Entry point 1 (also bound in the Statistics tab). |
| `enabledInProdTest` | false | The profiler module loads in prodTest, the window gets `showInProdTest`, and the on-screen button shows there. Read at boot with a plain `lsGetItem` (the drawer tab hydration doesn't run in prodTest, the same reason `getDebugToolsState(true)` exists). |
| `measureGpu` | true | Acquire the GPU timer while the window is open (only when supported). |
| `excludeDebugHelpers` | true | The census skips debug helpers (§2.7). |

Overview metric list UI: one row per metric with a visibility checkbox and ▲/▼ buttons, plus
"Reset to default". It is a small CMP list, because `debuggerListCMP` has no reordering. Changes
apply at the next refresh, with no rebuild of the window.

### 2.4 prodTest

- Boot: `InitApp.ts`'s `IS_DEBUG_ENV || IS_PROD_TEST_MODE` block calls `registerProfiler()`. It
  loads `core/Debug/Profiler/_dbg__Profiler.ts` in debug, and in prodTest only when
  `enabledInProdTest` is stored true (`loadDebugModuleAsync(importer, true)`).
- The play button reloads into prodTest, and the window's persisted `isOpen` +
  `showInProdTest: enabledInProdTest` reopen it there. That is "stay open in prodTest".
- In prodTest there are no stats-gl panels and no drawer. The Profiler measures by itself (§2.5),
  and the GPU memory (§2.9) and Settings tabs work as usual.

### 2.5 Measurement core

**Frame probe** (`core/Debug/Profiler/_dbg__FrameProbe.ts`). `MainLoop.ts` gets
`setFrameProbe(probe: { begin(now): void; end(now, rendered: boolean): void } | null)` and calls
`frameProbe?.begin(performance.now())` at loop start and `frameProbe?.end(…)` at loop end. It does
this in `mainLoopForDebug`, `mainLoopForProduction` and `mainLoopForProductionWithFPSLimiter`
(`rendered` is false on a limiter-skipped frame). Only the profiler sets the probe, while its
window is open, so production pays one null check per frame. Kept in ring buffers (preallocated
`Float64Array`, no per-frame allocation):

- Frame interval between rendered frames → **FPS** and **frame time** (avg, max).
- Loop CPU time (begin → end, the span TFPS already uses) → **CPU ms**.

**Stats sources** (`debug/Profiler.ts`, the p140 idea):

```ts
registerStatsSource({
  id: 'physics.step',
  label: 'Physics step',
  acquire?: () => void,   // turn the measurement on (first viewer)
  release?: () => void,   // turn it off again (last viewer)
  read: () => StatsValue | null, // called only at the update rate
  availability?: () => true | string, // a string = why it's n/a ("WebGPU only", "Chromium only")
});
```

- Refcounted per source, so the Overview and Objects tabs share one acquisition.
- `release` only switches off what this source switched on. For the plain-boolean switches (ray
  stats, PostFX measure) it records whether they were already on at acquire and leaves them as
  found. If the user turns one off in its own tab meanwhile, that wins.
- Engine and toolkit code can register their own sources (eg. a later streaming plan). A no-op
  outside debug / prodTest-with-profiler, like `registerGPUMemorySource`.

**Draw counters:** a `LATE_MAIN` system on the default world, added while the window is open,
reads `renderer.info.render` (`drawCalls`, `triangles`, `points`, `lines`) into an
`IntervalCounterStats`-style window. It has the same reason as p345 for reading there.

**GPU time:** while open and `measureGpu`, `_acquireGpuTimer()`. Every render context of the frame
is summed (`_onRenderContext` + `_sumGpuMs`), and results arrive a few frames late (fine at the
update rate). Released on close.

### 2.6 Overview tab

One compact table: label, value, small secondary text (min/max or "in view / total"), and an "n/a"
reason when unavailable. It is refreshed at `updateRateHz` (`refreshIntervalMs`, so only while
visible). No graphs.

| Id | Label | Value | Source | Default |
| --- | --- | --- | --- | --- |
| `tfps` | TFPS (est.) | 1000 / max(avg CPU ms, avg GPU ms); CPU only (labelled "CPU-bound est.") without GPU timing | probe + GPU timer | shown |
| `fps` | FPS | rendered frames / s | probe | shown |
| `frameTime` | Frame time | avg ms, worst frame in the window | probe | shown |
| `cpu` | CPU | main-loop ms per frame | probe | shown |
| `gpu` | GPU | ms per frame, all passes | GPU timer | shown |
| `physics` | Physics | step ms · dispatch ms · write-back ms (labelled "transit" on `MESSAGE_BATCH`, "read latency" on `SHARED_MEMORY`) · sub-steps this frame. Never summed. | PhysicsAPI | shown |
| `drawCalls` | Draw calls | per frame, all passes | `info.render` | shown |
| `trianglesDrawn` | Triangles drawn | per frame, all passes (shadows, PostFX, viewports) | `info.render` | shown |
| `triangles` | Triangles | in view / total | census | shown |
| `vertices` | Vertices | in view / total | census | shown |
| `meshes` | Meshes | in view / total | census | shown |
| `entities` | Entities | with a visual in view / total (all worlds) | census + ECS | shown |
| `memJs` | JS heap | used / limit | `performance.memory` (Chromium only) | shown |
| `memGpu` | GPU memory (est.) | three's estimate | `info.memory.total` | shown |
| `instances` | Instances | in view / total (instanced + batched) | census | hidden |
| `lights` | Lights | lights · shadow casters (each one is an extra scene pass, a point light six) | census | hidden |
| `bodies` | Physics bodies | bodies · colliders | PhysicsAPI (new `getPhysicsObjectCounts()`) | hidden |
| `rays` | Ray casts | Three.js rays · physics queries per frame | ray stats (acquired) | hidden |
| `postFxGpu` | PostFX GPU | ms per frame | PostFX profiler (acquired) | hidden |
| `longTasks` | Long tasks | count and longest in the last second | `PerformanceObserver('longtask')` (Chromium only, observed only while open) | hidden |
| `scene` | Scene | current scene id, loading state | Scene / SceneLoader | hidden |

Additions beyond the original request, with the reasoning:

- **Frame time worst:** hitches show up there, not in averages.
- **GPU ms:** it is what makes TFPS honest.
- **Draw calls and triangles drawn:** these differ from "in view" by the shadow and PostFX passes.
- **Shadow casters:** the most common hidden multiplier.
- **Long tasks.**
- **Physics sub-steps per frame:** a spiral-of-death warning.

### 2.7 "In view" census

Can visible / not-culled counts be done? Yes, as a sampled estimate. three exposes no per-object
culling result, so the census repeats its rules. At the update rate (never per frame), and only
while a tab that needs it is visible, it walks the root scene. It follows three's `_projectObject`:

- skip an invisible object's whole subtree;
- `layers.test(camera.layers)`;
- `frustumCulled && !frustum.intersectsObject` → total only;

all against the active camera (`getActiveCamera`; with the debug camera active it counts what the
debug camera sees, and says so).

- Per object: triangles = (index ? index.count : position.count) / 3 within `drawRange`, and
  vertices = `position.count`. Both are cached per geometry in a `WeakMap` keyed with the
  geometry's `id` + attribute versions.
  - `InstancedMesh`: × `count` (three culls it by its whole bounding sphere).
  - `BatchedMesh`: per-instance culling isn't repeated, so the whole object counts. Labelled
    "approx."
  - Lines, points and sprites are counted in their own buckets, never in triangles.
- Debug helpers: with `excludeDebugHelpers`, the census skips subtrees with
  `userData.aekDebugHelper` (a new `markDebugHelper(obj)` in `debug/Profiler.ts`, set by the light
  and camera helpers, physics wireframes, ray helpers, character gizmos, spatial grid and 3D
  symbols), `userData.isHelperSymbol`, and three's `*Helper` types. Their counts go into a separate
  "debug helpers" row, so nothing disappears silently.
- Entities: ECS entities with `OBJECT3D` whose object was counted in view. The total is the sum of
  `getEntityCount()` over `getAllECSWorlds()`.
- Viewport scenes (axes gizmo, env ball) are not in the root scene. They appear in "drawn" only.
- Cost: O(objects) per sample. Scenes the size of `largeWorld` are the target to check (Phase 4
  exit).

### 2.8 Objects tab

No new dependency. Charts are CSS bars and Tweakpane `graph` monitors (Tweakpane is already the
debug UI).

1. **Breakdown by kind** (Mesh, InstancedMesh, BatchedMesh, SkinnedMesh, Lines, Points, Sprites,
   Lights, Cameras, debug helpers). Each row shows count, triangles and vertices, and a two-tone
   bar: the in-view part solid, the culled part faded. The bar length is the share of the scene
   total. Culling efficiency shows at a glance.
2. **Breakdown by owner:** the current scene, managed entities by manager (`MANAGED_BY`, eg. the
   sky box), non-ECS objects, debug helpers. Same bars.
3. **ECS:** entities per world, and the component types sorted by entity count
   (`getEntitiesWith`, counted at the update rate).
4. **Heaviest objects:** the top 10 by triangles in view (name, kind, triangles, instances). A row
   with an ECS entity that has an edit window kind opens it (`toggleDraggableWindow`).
5. **Over time:** Tweakpane `graph` monitors of triangles in view, meshes in view and draw calls
   (the last ~60 samples at the update rate). They show what moving the camera does.

### 2.9 GPU memory tab: here, not in the drawer

Recommendation: move it (Phase 6). It is a read-mostly monitoring view, it wants the window's width
and height next to an open drawer, and it belongs with the frame figures it is usually read
against. The Statistics tab's "Draw calls, memory" button already treats it as a stats sub-view.

- `createDebuggerTab` → `createProfilerTab` (id `gpuMemory`, icon `memory`, `orderNr` after
  Objects, before Settings). `updateDebuggerTab` / `openDebuggerTab` calls become the profiler
  equivalents. `gpuMemoryControls` leaves `DEFAULT_DEBUG_DRAWER_TAB_ORDER`. An app `tabOrder`
  that still lists it is harmless (unknown ids are ignored).
- Its `LATE_MAIN` sampler and peak tracking keep running with the window closed, as now.
- It loads wherever the profiler does, so in prodTest too when the profiler is enabled there. Its
  allocation tracker installs at renderer creation in those modes.
- The Statistics tab's "Draw calls, memory" button opens the profiler on that tab.

## 3. Phases

Each phase is non-breaking and can be committed on its own.

### Phase 1: Window shell, entry points, Settings — done

1. Extract `_dbg__TabHost.ts` from `_dbg__DebuggerGUI.ts`. The drawer uses it, with no behaviour
   change. Move the tab button styles to a shared mixin.
2. `debug/Profiler.ts` (public API, §2.1–2.3) and `core/Debug/Profiler/_dbg__Profiler.ts` (window,
   tab row, `createProfilerTab`, LS state). Registered from `InitApp.ts` (§2.4).
3. Icons `profiler`, `objectsCubes` and `gear` (§2.1).
4. `setFrameProbe` in `MainLoop.ts` (all three loops) and `_dbg__FrameProbe.ts` (§2.5), set only
   while the window is open.
5. Tabs: Overview with the probe's rows only (TFPS as CPU-only, FPS, frame time, CPU), and
   Settings (update rate, `openFromStatsPanels`, `enabledInProdTest`).
6. The three entry points and the Statistics tab toggle (§2.2).

**Exit:** the window opens and closes from the panels, the Statistics tab and the top tools
button. The panel click respects the toggle. Settings persist over a reload. With
`enabledInProdTest` on, an open window survives the play button into prodTest and shows FPS / CPU
there. The Overview's FPS matches the stats-gl FPS panel within ±1. Every drawer tab behaves as
before (open/close, refresh intervals, scene tabs, folder states).

As built:

- Tab host: `createTabHost({ getContainer, isVisible, onMount, label })`. `getContainer` (not a
  fixed `container`) because the drawer and the window both rebuild their scroller.
  `isVisible()` gates the refresh interval (the drawer's `drawerState.isOpen`, the window's
  mounted content). Besides `mount` / `refresh(rebuild?)` / `unmount` / `mountedId` it has
  `resume()` (refresh + start the interval, the drawer's open) and `pause()` (the drawer's
  close). It keeps the mounted def, and it imports `DebuggerGUI.module.scss`, so the profiler
  gets the debugger styles in prodTest, where the drawer module never loads.
- Shared tab button mixins: `core/Debug/_debugTabButtons.scss` (`tabButton($selectedClass)`,
  `tabButtonSelected`). The scene tab variant stays in the drawer's SCSS.
- `DraggableWindow` got an `icon` option (config and open props, persisted) for the header icon.
- Public `debug/Profiler.ts` also has `isProfilerAvailable`, `isProfilerWindowOpen`,
  `isProfilerEnabledInProdTest`, `getProfilerSettings` / `setProfilerSettings` (persist and
  apply), `DEFAULT_PROFILER_SETTINGS`, `PROFILER_UPDATE_RATES_HZ` and the LS key constants.
- Files: `core/Debug/Profiler/_dbg__Profiler.ts` (window, menu, tab registry, settings and their
  side effects), `_dbg__ProfilerOverview.ts` (`OVERVIEW_METRICS`: `{ id, label, read(sample) }`
  rows; Phase 2 adds rows, the sample's sources and the order/visibility list),
  `_dbg__ProfilerSettings.ts`, `_dbg__FrameProbe.ts`, `Profiler.module.scss`.
- Tab ids and `orderNr`: `profilerOverview` 0, `profilerSettings` 100 (Objects and GPU memory go
  between). The Overview's `refreshIntervalMs` is a getter on `updateRateHz`, read at mount.
- Frame probe: a 1024-frame `Float64Array` ring, summarized over the rendered frames of the last
  1000 ms. A limiter-skipped frame's CPU time is added to the next rendered frame, and a gap
  over 1 s (paused main loop, hidden tab) is not counted as a frame time. Refcounted
  `_acquireFrameProbe` / `_releaseFrameProbe`: the window content acquires on build and releases
  on removal.
- The window's measurements and the mounted tab's `onOpen` cleanup are released in the content
  root's `onRemoveCmp`, so (unlike the drawer) the cleanup runs after the tab's CMPs are removed.
- The Statistics tab's toggle binds straight to the profiler's settings object (a `target`, one
  source of truth, no proxy copy) and its `onChange` calls `setProfilerSettings`. It sits with
  the "Profiler" button in a Profiler folder.
- The on-screen button is in `playTools()`, so in prodTest it also needs the Debug tools tab's
  `showOnScreenToolsInProdTest`.
- Icons: `gear-fill.svg` and `cubes-wireframe.svg` (Bootstrap Icons 1.11.3 `gear-fill` and
  `boxes`); `profiler-pulse.svg` is a monitor frame with Bootstrap's `activity` pulse.

### Phase 2: Stats sources and the full Overview — done

1. `registerStatsSource` registry with refcounted acquire/release. Sources: GPU timer, draw
   counters (`LATE_MAIN` system), physics (read-only, boot flag: "off: enable (reloads)" through
   `setBootOverride`), memory, rays, PostFX, long tasks, scene. `getPhysicsObjectCounts()` in
   PhysicsAPI.
2. The rest of the Overview (§2.6, census rows show "—" until Phase 4), and the metric list editor
   in Settings.

**Exit:** with GPU timing on (WebGPU), TFPS drops below the CPU-only figure in a GPU-heavy scene.
With the window closed: no GPU timer holder, no probe set, no extra `LATE_MAIN` system, and the
Raycast tab's switches are as the user left them. In prodTest the Overview also shows draw calls.

As built:

- Sources are held by the tab that shows them, not by the window: the Overview holds the sources
  of its shown rows while it is mounted (`createStatsSourceHolder`, set in `onRefresh`, released
  in the `onOpen` cleanup), so hidden rows cost nothing and the Settings tab holds nothing. The
  frame probe stays window-level (Phase 1). A per-frame source starts from an empty 1 s window on
  every mount.
- Registry: the source map is in the public `debug/Profiler.ts` (so code can register before the
  profiler loads), the refcounts in `Profiler/_dbg__StatsSources.ts` (`_acquireStatsSource`,
  `_releaseStatsSource`, `_readStatsSource` → `{ value } | { value: null, na }`,
  `_syncStatsSources`). Availability is re-checked on every acquire, release and read: a held
  source is acquired once it becomes available (eg. the renderer exists after the window was
  restored open from LS) and released when it stops being available.
- Built-in sources in `Profiler/_dbg__ProfilerSources.ts` (ids in `PROFILER_SOURCE`): `gpu.frame`,
  `render.draw`, `physics.step`, `physics.subSteps`, `physics.objects`, `memory.js`,
  `memory.gpu`, `rays`, `postFx`, `longTasks`, `scene`. GPU time, draw counters and sub-steps
  share one `LATE_MAIN` system (`aekProfilerFrameSampler`, order -10000), added with the first of
  them and removed with the last. Per-frame figures are summarized over the last 1 s
  (`_dbg__SampleWindow.ts`, preallocated ring).
- GPU time: WebGPU with `timestamp-query` only (three's WebGL pool can't time nested contexts).
  The render contexts between two sampler runs are one frame's record (pooled); a record whose
  batch another resolver took is dropped after 8 frames.
- Physics sub-steps: no per-frame count existed, so PhysicsAPI got `getPhysicsSubStepTotal()` (a
  since-boot total, never reset; the sampler diffs it). `getPhysicsObjectCounts()` also counts
  joints.
- The physics row's "enable (reloads)" action shows in the debug env only: `loadConfig` applies
  the boot overrides there only. The PostFX profiler is debug-only too ("debug env only" in
  prodTest). PostFX GPU = the PostFX passes' own render passes + the composite (not the scene
  pass).
- Ray stats use the existing 3 s per-frame average window (`RAY_STATS_WINDOWS`) and the last
  frame. While the profiler holds them the Raycast tab shows live stats with its checkbox off,
  and a user turning them on while the profiler holds them has them turned off with the window
  (no refcount in `Raycast.ts`, as planned).
- New setting `measureGpu` (Settings → Measuring); `overviewMetrics` defaults to `[]`, which the
  sanitizer turns into the default rows. The row editor is a CMP list with a delegated click
  handler. Metric rows can carry `warn` (sub-steps at `maxSubSteps`, long tasks) and an `action`
  button. New SCSS variable `$debugValueWarn`.

### Phase 3: Runtime physics step stats — done

1. `setPhysicsStepStatsEnabled(on)` in `PhysicsAPI.ts`.
   - `MAIN_THREAD`: flip `physicsState.stepStatsEnabled`.
   - `WORKER_THREAD`: a one-way `SET_STEP_STATS` message (the `SET_DEBUG_STATE_TRACKING`
     pattern), re-sent after every world reset.
   - On `SHARED_MEMORY`, the 3-slot stats SAB is allocated at every `CREATE_WORLD`, whatever the
     flag. It is tiny, and this is what makes the flag runtime.
   - The boot override stays as the initial value. The PHY stats-gl panel is still boot-only.
2. The profiler's physics source acquires it while open.

**Exit:** with `stepStatsEnabled` off at boot, opening the profiler shows step / dispatch /
write-back figures in `MAIN_THREAD`, `WORKER_THREAD` + `SHARED_MEMORY` and `MESSAGE_BATCH`
(`?physicsProbe` hashes unchanged). Closing it stops the measuring.

Can be dropped. The Overview then keeps Phase 2's "enable (reloads)".

As built:

- `SET_STEP_STATS = 7` (ENGINE range, one-way) sets the worker's `workerPhysicsState`, which
  outlives `DELETE_WORLD` / `CREATE_WORLD`, so it is sent once per change, not re-sent after a
  world reset. The worker reads the flag once per STEP message.
- The SHARED_MEMORY stats SAB is allocated at every `CREATE_WORLD` (a fresh one reads
  `STEP_END_AT` 0, "no step yet"); both sides drop their view when a world resolves
  MESSAGE_BATCH.
- Also `isPhysicsStepStatsEnabled()`. Switching on clears the last figures (and zeroes the SAB's
  `STEP_END_AT`), so the Overview says "waiting for a step" instead of showing an earlier
  period's frozen values.
- The physics source uses `createSharedSwitch` (like the ray stats): step stats that were on at
  boot stay on after the release. Its only n/a reason is "physics off"; `STEP_STATS_OFF` and the
  "enable (reloads)" action are gone. The metric row `action` support stays (no user now).
- The Physics API tab's "Track physics step time (reloads)" binds to the boot value (a proxy,
  like `workerTargetProxy`), so the profiler's runtime switch doesn't show as the boot setting.
- Verified: on/off with the window in MAIN_THREAD, SHARED_MEMORY and MESSAGE_BATCH;
  `?physicsProbe=120` on `physicsTest` hashes the same with stats on and off in all three.
- Fixed, older than this phase (p027): `dispatchMs` and `writeBackMs` were off by the worker's
  start time (about ±1.3 s, opposite signs). A dedicated worker's `performance.now()` counts from
  its own creation, not from the page's time origin. `INIT_PHYSICS` now carries
  `mainTimeOrigin`, and the worker puts its receipt and step-end stamps on the main thread's
  clock. After the fix: dispatch 0.05–0.2 ms, MESSAGE_BATCH transit ~0.8 ms, SHARED_MEMORY read
  latency ~1 frame (polled on the next frame).

### Phase 4: In-view census — done

1. The census (§2.7), `markDebugHelper` and its call sites.
2. The Overview's census rows (triangles, vertices, meshes, entities, instances, lights).

**Exit:** in `largeWorld`, turning the camera changes the in-view figures, and the totals stay put.
Toggling light helpers doesn't change the triangle totals with `excludeDebugHelpers` on. The
sample costs < 2 ms at 4 Hz (measured with the probe).

As built:

- `Profiler/_dbg__Census.ts`: `runSceneCensus(excludeDebugHelpers)` returns one reused
  `SceneCensus`: per kind (`CENSUS_KINDS`: MESH, INSTANCED_MESH, BATCHED_MESH, SKINNED_MESH, LINES,
  POINTS, SPRITES, LIGHTS, CAMERAS, DEBUG_HELPERS) a bucket of `objects`, `instances`,
  `primitives` (triangles for the mesh kinds, segments for lines, points, sprite quads) and
  `vertices`, each `{ inView, total }`; `meshes` (the mesh kinds summed); `lights` (count, shadow
  casters, shadow passes: 6 per point light); `entities`; `isDebugCamera`, `isApprox`,
  `sampleMs`. Phase 5's kind bars read the buckets; the owner breakdown and the heaviest objects
  still need adding to the walk.
- It mirrors three r186's WebGPU `Renderer._projectObject`: it calls `object.intersectsFrustum`
  (three's own test, `FrustumArray` for an `ArrayCamera`) and skips objects whose materials are
  all hidden. The layer test gates only the object itself (its children are still walked).
  Instances are three's draw count (`InstancedBufferGeometry.instanceCount`, else `object.count`).
- The engine's `FAT` line backend (`FatLineSegments`) and three's `Line2` are `Mesh`es: they count
  as LINES, one segment per instance, never as triangles.
- Totals count hidden objects too. Lights and cameras are never culled: their "in view" is
  "shown". An entity is in view when its OBJECT3D or a descendant was drawn in view, so entities
  without an Object3D of their own (eg. `InstancedMeshPool` slots) never are; the row says "own
  Object3D".
- No per-geometry cache: the counts are O(1) getters. A BatchedMesh sums its visible instances
  from three's private `_instanceInfo` / `_geometryInfo` (nothing uses one yet) and marks the
  census `isApprox`.
- `markDebugHelper(obj)` and `DEBUG_HELPER_USER_DATA_KEY` (`aekDebugHelper`) in
  `debug/Profiler.ts`. Marked: light and camera helpers, physics wireframe lines and hosts, ray
  helpers, character gizmos, spatial grid overlays and 3D symbols (a line's mark is on
  `line.object3D`; its `userData` survives a backend swap). `isHelperSymbol` and three's `*Helper`
  types count without the mark.
- New setting `excludeDebugHelpers` (Settings → Measuring). The census source (`scene.census`,
  no acquire) walks at most once per half update interval, so views reading it together share a
  walk; a sample of the other `excludeDebugHelpers` value isn't reused.
- The census runs in the Overview's refresh interval, outside the main loop, so it times itself
  (shown on the Meshes row) instead of the frame probe. Measured in `largeWorld`: median 0.10 ms,
  max 0.15 ms (the first sample after a load 0.4-0.75 ms).
- `largeWorld`'s in-view triangles barely move with the camera: its instanced pools have
  world-sized bounding spheres, and three culls an `InstancedMesh` whole. The figure is right;
  that is a finding for the LOD and culling plans (p350, p354).

### Phase 5: Objects tab — done

The Objects tab (§2.8) on the census.

**Exit:** the kind and owner bars add up to the totals. The top-10 rows open edit windows where one
exists. The graphs move with the camera.

As built:

- `Profiler/_dbg__ProfilerObjects.ts`, tab id `profilerObjects`, `orderNr` 10, icon
  `objectsCubes`. It holds the census and the draw counters while mounted and reads them once
  per refresh (`onRefresh`). Sections in §2.8's order, each a CMP with its own `html`, so only
  a changed section re-renders.
- Census additions (`_dbg__Census.ts`, shared with the Overview's walk): a `triangles` figure per
  bucket (the primitives of mesh-kind objects only), `owners` and `heaviest`. The owner is the
  nearest entity whose OBJECT3D is the object or an ancestor of it: "Managed: <manager>"
  (`MANAGED_BY`), "Persistent entities" (`PERSISTENT`), else "Scene entities" (any world, no
  per-scene split), then "Non-ECS objects" and "Debug helpers". Every counted object goes into
  one kind and one owner bucket, so both tables have the same Total row. `heaviest` is 10
  preallocated slots (object name or type, the entity's debug name or app id, world id + entity
  id), with no scene graph reference kept. Census cost in `largeWorld` is now 0.17-0.23 ms.
- Bars: a Triangles / Vertices / Objects picker in the tab, persisted as the new setting
  `objectsBarMeasure`. Lines, points and sprites have no triangles: their own primitives are
  shown under the kind. The bar's 100% is the Total row, debug helpers included.
- Edit windows: there is no mesh edit window. Lights and cameras have one, but no triangles, so
  they never reach the top 10. New registry `registerEntityWindowOpener({ id, label, priority?,
  canOpen, toggle })` in `debug/Profiler.ts` (the profiler never imports the drawer modules). The
  character window (priority 10) and the physics entity window register. The Edit button shows
  in the debug env only.
- Over time: inline SVG sparklines (0 to the window's max, gaps where there is no value), not
  Tweakpane `graph` monitors: those show no scale, and `pane.refresh()` adds a sample on every
  tab refresh (a click too). One sample per census walk, the last 60, kept while the tab is
  mounted. Draw calls are the 1 s per-frame average.
- ECS: entities per world, and the component types (enum keys) summed over the worlds from
  `getStorage(type).size`, sorted by count.
- Verified in `largeWorld`, the ECS test scene and the GYM scene: the kind and owner totals are
  equal; with the debug camera, a drag changes the in-view figures and the sparklines while the
  totals stay put; a GYM row's Edit opens "Edit character". `largeWorld` has no physics bodies,
  so its rows have no Edit button.

### Phase 6: GPU memory tab moves in — done

§2.9. Update `CLAUDE.md`'s GPU memory paragraph, and the readme if it names the tab's place.

**Exit:** the tab works in the profiler as it did in the drawer (snapshots, diff, budget toast,
sources). The drawer no longer lists it. Shown in prodTest when the profiler is enabled there.

As built:

- `GPU_MEMORY_TAB_ID` is `gpuMemory`, `orderNr` 20. Its `lsKey` (`AEK_debugGPUMemory`) is
  unchanged, so the budget and "Call sites" settings carry over. A drawer whose saved open tab
  was `gpuMemoryControls` falls back to its first tab.
- Changed after review: the tab shows in prodTest too (the plan had it debug-only). It loads
  where the profiler does: `isProfilerLoadedInThisMode()` (now exported from
  `debug/Profiler.ts`) gates `registerGPUMemoryDebugGUI` and `registerGPUMemorySource`, which
  was debug-env only before. In prodTest there is no budget toast (no debug toaster; the budget
  bar still shows it), and the "Viewports" and "GPU time" buttons, which open drawer tabs, are
  hidden.
- `registerGPUMemoryDebugGUI()` moved in `InitApp.ts` from the debug-only block to right after
  `registerProfiler()`: `createProfilerTab` is a no-op before the profiler module loads. It
  still runs before `appStartFn`, so the allocation tracker sees the renderer's `init()`.
- The budget toast now says "See the profiler's GPU memory tab."
- The readme's drawer line lost GPU memory, so the readme got a profiler bullet (the plan-done
  readme step only needs to check it).
- Verified in the ECS test scene: the drawer has no GPU memory tab; the Statistics tab's "Draw
  calls, memory" opens the profiler on it; the menu order is Overview > Objects > GPU memory >
  Settings; snapshot and clear work; a reload restores it. In prodTest (enabled there) the window
  restores on the GPU memory tab with its sources and snapshots and without the drawer links. On the
  plain URL nothing of it loads.

**Plan done:** engine minor bump (new debug window and public `debug/Profiler.ts` API,
`setPhysicsStepStatsEnabled`); app untouched; CHANGELOG entry; `yarn checkVersions --against main`.

## 4. Out of scope (later profiler plans)

- More tabs: a Physics tab (bodies awake / sleeping from the debug state buffer, contacts), a
  Frame / passes tab (`getPostFxPassStats` per pass, shadow passes, viewports), Assets / textures
  (the Statistics `@TODO` list), Streaming cells (p353), LOD (p348).
- A default debug key, recording and exporting a capture (CSV/JSON), per-system ECS timings,
  `measureUserAgentSpecificMemory()`, WASM / worker memory.
- Detaching the window into a second browser window.

## 5. Risks

- **The tab host extraction touches the drawer, which is under active rewrite.** Phase 1 must not
  change drawer behaviour, and its exit lists what to check.
- **Census accuracy:** it mirrors three's culling, so a three upgrade that changes
  `_projectObject` (or GPU culling, p354) can make "in view" drift from what is drawn. "Drawn"
  (`info.render`) stays the ground truth, and both are shown.
- **GPU timer contention:** the PostFX profiler, the sky box bake stats and the profiler share one
  resolve. That is already designed for (listeners retry), but three holders at once is new.
- **`performance.memory` and long tasks are Chromium-only.** The rows say "n/a (Chromium only)".
- **Phase 3 is the only change outside the debug code** (worker protocol). Drop it if it grows.
