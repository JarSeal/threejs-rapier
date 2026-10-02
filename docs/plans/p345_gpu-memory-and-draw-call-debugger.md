Status: in progress | Phase 1 implemented
Category: Debug, Rendering, Performance
Epic: p350_lod-system-research.md (Tier 0)
Blocks: nothing hard; p347, p348, p351 and p353 each measure their result with it
Related: p300_asset-optimization-pipeline-plan.md (its `__vramBytes` estimates and Phase 1 baseline read `renderer.info.memory` too), p240_client-device-capability-sniffer.md (a device memory target is the natural default budget), p353_macro-streaming-grid.md (per-cell owners)

# GPU Memory & Draw-Call Debug Tab

A debug drawer tab that shows what the GPU is holding and drawing: memory by category, by owner
(scene now, streaming cell later) and over time, plus per-frame draw calls and triangles. It comes
first in the LOD epic because every later optimization is otherwise unmeasured (p350 §5.3).

Debug env only, following the `_dbg__` + dynamic-import pattern. Nothing changes in production
builds.

---

## 1. What already exists

- **three r186 `renderer.info`** (`node_modules/three/src/renderers/common/Info.js`):
  - `info.memory`: counts _and byte sizes_ of what the renderer has created: `textures` /
    `texturesSize`, `attributes` / `attributesSize`, `indexAttributes` / `indexAttributesSize`,
    `storageAttributes`, `indirectStorageAttributes`, `uniformBuffers`, `programs`,
    `readbackBuffers` (all with `…Size`), `renderTargets` (count only), `geometries` (count), and
    `total` in bytes.
  - `info.render`: `drawCalls`, `frameCalls` and `triangles` for the current frame; `info.compute`
    the same for compute.
  - These are three's own bookkeeping of the buffers and textures it created, not a driver
    measurement. Browsers expose no real VRAM figure.
- **Assets tab** (`core/Debug/_dbg__Assets.ts`, helpers in `_dbg__AssetStats.ts`): lists every
  registered texture and geometry with `getTextureByteSize` / `getGeometryByteSize` estimates,
  and an info window per asset.
- **Asset owners** (`core/Assets/AssetOwners.ts`): a `WeakMap` from each registered asset to the
  scene that owns it.
- **Stats tab** (`_dbg__Stats.ts:358-370`): a `@TODO` list asking for per-scene draw calls,
  object, mesh, face and vertex counts, and texture lists. This plan covers the draw-call and
  memory parts; the rest stays in the Assets tab.
- **GPU timer** (`_dbg__GPUTimer.ts`): GPU timings on WebGPU, shared by the sky box bake stats and
  the PostFX profiler. Not needed here, but the tab links to the PostFX profiler for GPU time.

## 2. Design

### 2.1 The tab

`core/Debug/_dbg__GPUMemory.ts`, registered from `InitApp.ts`'s debug block like
`registerSpatialIndexDebugGUI`, as one `createDebuggerTab({ id: 'gpuMemoryControls', title: 'GPU
memory', ... })`. Placed after `rendererControls` in `DEFAULT_DEBUG_DRAWER_TAB_ORDER`.
`refreshIntervalMs: 500`, so it costs nothing while hidden.

Sections:

1. **Totals.** `info.memory.total`, then one row per category (bytes and count), sorted by size.
   A bar against the budget (§2.4). The high-water mark since boot and since the last scene enter,
   each with the time it was reached.
2. **Frame.** Draw calls, triangles and compute calls of the last frame, plus min/avg/max over
   the refresh window. Rendering the debug drawer itself adds nothing (it's DOM), but the axes
   gizmo and env ball viewports do; a note says so, with their toggles.
3. **By owner.** The Assets tab's per-asset estimates, summed per owner (§2.2) and per kind
   (textures, geometries). The difference between `info.memory.total` and the sum of all owners is
   shown as **untracked**: render targets (shadow maps, PostFX, sky env bake, viewports), uniform
   buffers, programs and unregistered geometry. A large or growing untracked figure is a finding on
   its own.
4. **Sources** (§2.3): engine-owned GPU resources that are not registered assets.
5. **Snapshots** (§2.5).

### 2.2 Owners

An owner is the string `AssetOwners` stores. Today that is a scene id, or none (registered before
the first scene load, shown as **boot**). p353 extends owner keys to `sceneId#cellKey`; the tab
groups by the part before `#` and lists cells under their scene, so it needs no change when
streaming lands. This is the "per-cell attribution hook" p350 asked for: the key format is the
hook.

### 2.3 Sources

A small registry for GPU resources that aren't registered assets:

```ts
registerGPUMemorySource({
  id: 'skyBox.envBake',
  label: 'Sky box env bake',
  getBytes: () => number, // estimate, called only while the tab refreshes
  owner?: string,
});
```

Exported from a thin public module (`debug/GPUMemory.ts`, a no-op outside the debug env), so
engine code can register without importing the `_dbg__` file. First registrations: the sky box
env bake target and nebula cube (`SkyEnvironment.ts`, `SkyStaticLayers.ts`), shadow maps (sum
over shadow-casting lights' `shadow.map`), PostFX targets, viewport render targets
(`Viewports.ts`), and instanced pools' `instanceMatrix` / `instanceColor` buffers. Sources are
summed into the "By owner" view under their owner, and reduce **untracked**.

### 2.4 Budget

A single number in MB, persisted in the tab's `lsKey` (debug state, not `AppConfig`). Default 512
MB. When p240 lands, its device memory level supplies the default. Over budget, the bar turns red
and a debug toast fires once per scene.

### 2.5 Snapshots and diff

"Take snapshot" stores the totals, per-category figures and the per-asset list. "Diff" lists what
grew or shrank since the snapshot, per asset and per category. The main use is leak hunting
across scene switches: snapshot in scene A, go to B and back to A, diff. Anything still listed is
a release that `releaseSceneOwnedAssets` missed. Snapshots live in memory only.

## 3. Phases

### Phase 1 — Totals and frame counters — done

1. The tab with Totals and Frame (§2.1, sections 1–2), high-water marks, budget bar.
2. Fill in the draw-call part of `_dbg__Stats.ts`'s `@TODO` by linking to the tab, and remove those
   lines from the `@TODO`.

**Exit:** switching between `largeWorld` and `skyShowcase` shows the totals and draw calls change,
and the high-water marks reset on scene enter.

As built:

- `info.render` is reset at the start of three's own animation frame (`Animation.js`, started by
  `renderer.init()`), not per `render()` call, so the tab never reads it from its refresh interval.
  A debug-only `LATE_MAIN` system (`gpuMemorySamplerSystem`, default world) reads it right after
  the frame's `renderScene()`, keeps min/avg/max per 500 ms window, and also tracks the memory
  peaks and the budget toast, so those work while the tab is closed. `MainLoop.ts` is unchanged.
- Frame rows: draw calls, triangles, render calls (`info.render.frameCalls`) and compute calls.
  Totals: one row per `info.memory` category, plus render target and geometry counts (their bytes
  are in textures and attributes). The backend (WebGPU / WebGL2) is labelled.
- The axes gizmo and env ball note names their keys (F10 / F9) and links to the Debug tools tab
  instead of duplicating their toggles, which that tab persists. A second link opens the PostFX
  profiler for GPU time.
- The Stats tab got an "Open GPU memory" button; only the draw-call line left its `@TODO`.
- New `memory` icon (Bootstrap Icons). Budget persisted in `AEK_debugGPUMemory`.
- Open question 2 answered: the WebGL2 fallback fills `info.memory` through the same shared
  classes (same figures as WebGPU in `largeWorld`).
- First finding: `largeWorld` → `skyShowcase` → `largeWorld` comes back with ~3.7 MB more
  attributes (76 → 112), more programs (46 → 68) and uniform buffers (104 → 178), on both
  backends. Phase 2's diff should name what stays alive.
- Known gap: three r186 counts compressed textures as 1 B (`Info._getTextureMemorySize`). Nothing
  uses KTX2 yet; p300 will, and Phase 2's per-owner sizes need a better estimate for them.

### Phase 2 — Owners and snapshots

1. "By owner" from `AssetOwners` plus the Assets tab's estimates; untracked row.
2. Snapshots and diff (§2.5).

**Exit:** a scene A → B → A round trip diffs to (near) zero, or the diff names the leak.

### Phase 3 — Sources

1. `registerGPUMemorySource` and the first registrations (§2.3).

**Exit:** untracked is under ~10 % of the total in `skyShowcase` with PostFX on.

## 4. Versioning

Engine minor (a new debug tab and a debug API). No toolkit or app change.

## 5. Open questions

1. Is `info.memory` reset or double-counted on a WebGPU device loss? Check when the engine grows
   device-loss handling; until then the tab says the figures are since boot.
2. On the WebGL2 fallback, does three r186 fill `info.memory` the same way? Verify in Phase 1 with
   `forceWebGL`, and label the tab's figures with the backend.
