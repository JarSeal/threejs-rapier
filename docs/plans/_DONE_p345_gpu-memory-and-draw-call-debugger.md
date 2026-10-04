Status: implemented (Phases 1-3)
Category: Debug, Rendering, Performance
Epic: p350_lod-system-research.md (Tier 0)
Blocks: nothing hard; p347, p348, p351 and p353 each measure their result with it
Related: \_DONE_p300_asset-optimization-pipeline-plan.md (its `__vramBytes` estimates and Phase 1 baseline read `renderer.info.memory` too), p240_client-device-capability-sniffer.md (a device memory target is the natural default budget), p353_macro-streaming-grid.md (per-cell owners)

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
  backends. Phase 2's diff should name what stays alive. (It does: see Phase 2's As built.)
- Known gap: three r186 counts compressed textures as 1 B (`Info._getTextureMemorySize`). Nothing
  uses KTX2 yet; p300 will, and Phase 2's per-owner sizes need a better estimate for them.

### Phase 2 — Owners and snapshots — done

1. "By owner" from `AssetOwners` plus the Assets tab's estimates; untracked row.
2. Snapshots and diff (§2.5).

**Exit:** a scene A → B → A round trip diffs to (near) zero, or the diff names the leak.

As built:

- "By owner" (`_dbg__GPUMemoryOwners.ts`) uses three's own per-object bytes (`info.memoryMap`, not in
  @types/three), not the Assets tab's estimates. Owners plus untracked add up exactly to
  `info.memory.total`. An asset that was never drawn counts 0, and the tab says how many there are.
  Textures a registered material holds alone (eg. clones; three uploads every `Texture` object on
  its own) are counted under the material's owner. Untracked has its own table per category.
- The diff doesn't stop at registered assets: §2.5's per-asset list alone would have missed the
  leak below. An allocation tracker (`_dbg__GPUMemoryAllocations.ts`) wraps `renderer.info`'s create
  / destroy calls for every kind three counts (textures, attributes, uniform buffers, programs,
  readback buffers). It is installed through a new `onRendererCreated` (`core/Renderer.ts`), before
  `renderer.init()`. It holds objects through `WeakRef`s and records kind, bytes, a label, the scene
  visit and, with the persisted "Call sites" toggle, the first engine/app stack frame.
- Scene visits, not scene ids: a new visit starts on every scene load or scene change. That way,
  what the first A left behind can be told from what the second A made. The tracker works out the
  visits itself; `SceneLoader` has no load-start hook.
- `_dbg__GPUMemorySnapshots.ts`: one in-memory snapshot. The tab shows a live diff against it:

  - category changes;
  - **Left behind**: allocations from the snapshot's visit or later (not the current visit) that are
    still counted, grouped by kind, label, visit and call site, with how many were garbage
    collected without a destroy call (three counts those for good);
  - registered assets new / gone / changed, with a net figure.

  "Log diff to console" logs it all; the tab shows up to 12 rows per table.

- Exit result (`largeWorld` → `skyShowcase` → `largeWorld`): the diff names the leak, 24 interleaved
  instance-matrix attributes (2.44 MB) left by the first `largeWorld` visit. It's a three r186 bug,
  fixed for r187 (`docs/issues/three-instanced-node-attribute-leak.md`). All 24 are collected, so
  what leaks for sure is three's count; the buffers themselves are only held weakly. The registered
  asset diff nets to 0 (unnamed geometries get new uuids per visit, so they show as new / gone
  pairs). Smaller leftovers named by the same diff: the sky background's programs and uniform
  buffers, and, in debug mode only, the light / camera debug symbols' render objects (their cloned
  materials are never disposed).
- Call sites of render-time allocations point at `MainLoop.ts`'s render call: three allocates lazily
  while rendering, so that's the first non-three frame.

### Phase 3 — Sources — done

1. `registerGPUMemorySource` and the first registrations (§2.3).

**Exit:** untracked is under ~10 % of the total in `skyShowcase` with PostFX on.

As built:

- A source hands over three objects, not a byte estimate: `getResources()` returns textures, render
  targets, geometries and attributes, and the tab counts three's own bytes for them
  (`_dbg__GPUMemorySources.ts`), so assets, sources and untracked still add up to
  `info.memory.total` (Phase 2). Assets are counted first; a GPU object an asset or an earlier source
  counts is never counted again. A render target counts its textures and its internal depth texture,
  and an attribute every buffer three made from its array (eg. an `instanceMatrix`'s interleaved
  attributes). Those two aren't reachable from the object, so they are found through the Phase 2
  allocation tracker's live objects.
- `registerGPUMemorySource({ id, label, getResources, owner? })` in `debug/GPUMemory.ts` returns
  its remover. The registry lives in that thin module, so registering needs no `_dbg__` import.
  `owner` can be a function (eg. the current scene); without one, the source is listed under
  "engine (no scene)". Sources sum into "By owner" (textures under Textures, buffers under Geometry,
  the count column is now "Items") and have their own table, with a row per source, also at 0 B.
- Most engine sources are defined on the debug side, reading getters that already exist
  (`registerEngineGPUMemorySources`): sky box env bake (with its PMREM generator's working set), sky
  box nebula cube, sky box PMREM (texture sky), shadow maps, PostFX chain, instance buffers (every
  `InstancedMesh` in the root scene, not only pools) and the renderer's output target (not in §2.3,
  and the largest untracked item: three's MSAA / output-pass target, read from the private
  `_frameBufferTargets`). Viewports register themselves (one row each, owned by their `sceneId`),
  and so do the debug 3D symbols (debug only, ~1.6 MB), so debug overhead is named.
- PostFX: every render target reachable from the built chain's node graph, found by its property
  values, so TSL's PassNode, the effect nodes and app-written PostFX passes need no names.
- Shadows: the app uses `VSMShadowMap`, whose blur pair lives on three's `ShadowNode`, which a light
  can't reach (three keeps light nodes in a module-private `WeakMap`). The tab wraps
  `ShadowNode.prototype.setupShadow` (debug only, at tab creation, before the first render) to map
  each `shadow.map` to its node.
- Not tracked: small instance counts (three keeps their matrices in uniform buffers), uniform
  buffers, programs and unregistered geometry.
- Found: three r186 counts a cube texture's faces as 1×1 each (it sizes a texture by its image, an
  array of faces or none on a `CubeRenderTarget`). The tab estimates what's left out with three's own
  formula at the real face size (`getUncountedCubeBytes`) and shows it per source and as one line
  under "By owner", outside every total. `space`'s nebula cube at 512: 72 KB counted, ~12 MB real.
- Exit result (untracked, debug mode): `skyShowcase` 0.26 MB of 36.9 MB (0.7 %), `space` 0.30 MB of
  47.5 MB (0.6 %), `largeWorld` with its PostFX chain (`ambientOcclusion`) 0.57 MB of 150.9 MB
  (0.4 %). `skyShowcase` has no PostFX passes, so `largeWorld` stands in for "with PostFX on".

## 4. Versioning

Engine minor (a new debug tab and a debug API). No toolkit or app change.

## 5. Open questions

1. Is `info.memory` reset or double-counted on a WebGPU device loss? Check when the engine grows
   device-loss handling; until then the tab says the figures are since boot.
2. On the WebGL2 fallback, does three r186 fill `info.memory` the same way? Verify in Phase 1 with
   `forceWebGL`, and label the tab's figures with the backend.
