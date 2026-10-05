Status: in progress | Phases 0-2 implemented
Category: Assets, Rendering, LOD
Epic: p350_lod-system-research.md (Tier 1.1)
Blocks: p348_ecs-lod-selection.md Phase 2 (`lod: 'AUTO'` reads these chains)
Related: p376_hlod-merged-cluster-proxies.md (chains of merged group geometry), p371_geometry-merging.md (same worker path), \_DONE_p345_gpu-memory-and-draw-call-debugger.md (measures the chains' memory), p306_terrain-blocks-and-procedural-terrain-meshes.md (block geometry is a chain candidate)

# LOD Chain Generation (meshoptimizer)

Generates a chain of simplified geometries (LOD1, LOD2, …) for a geometry, with the error of
each level, so p348 has something to select between. Two entry points produce the same result:

- **Runtime, in the asset worker**, for geometry that only exists at runtime: the toolkit's
  procedural generators (`generateTreeGeometry`, `generateBushGeometry`, `generateAsteroid`,
  `generateTerrain`) and code-made geometry.
- **Build time, in p300's pipeline**, for imported GLBs, so shipped assets carry their chain and
  nothing is simplified on the client.

Nothing selects a level in this plan. Generated chains are registered geometries that sit unused
until p348.

---

## 1. Grounding

- No simplifier exists in the repo: no `meshoptimizer`, gltf-transform or `@three.ez/*` in
  `package.json`.
- p300 adds gltf-transform and the meshopt _codec_ (compression) at build time. Its `mesh.simplify`
  setting (p300 §4) is a single ratio applied to the shipped mesh, not a chain.
- **Geometry registry** (`core/Geometry.ts`): registered geometries have ids and ref counts
  (`incGeometryRef` / `decGeometryRef`), persistence, `prewarmGeometry` (a `compileAsync` on a
  staging mesh) and `saveBufferGeometry` for code-made geometry. Scene asset release
  (`core/Assets/SceneAssetRelease.ts`) frees geometries with ref count 0 that the old scene owns.
- **Asset worker** (`workers/assetsWorker.ts`, `workers/assets/assetsSwitch*.ts`): a switchboard
  per request kind, called through `core/Assets/AssetsAPI.ts`. Geometry crosses the thread
  boundary with `serializeGeometry` / `deserializeGeometry` (`core/Import/GeometryTransfer.ts`),
  transferring the attribute buffers.
- **GLB extraction** (`core/Import/GLTFExtract.ts`) walks `isMesh` nodes into primitives with ids
  and parsed custom props. It runs on both threads.
- Procedural geometry: `generateAsteroid` is non-indexed by default; `generateTreeGeometry`
  returns a geometry with material groups (trunk, foliage).

## 2. Design

### 2.1 What a chain is

```ts
type LodChainLevel = {
  geometryId: string; // registered: `${baseId}#lod${n}`
  triangles: number;
  /** meshoptimizer's result error, relative to the mesh's extent (0..1). */
  error: number;
};

type LodChain = {
  baseId: string;
  radius: number; // bounding sphere
  extent: number; // largest bounding box side: the scale `error` is relative to
  levels: LodChainLevel[]; // levels[0] is the base
};
```

- Level 0 is the original geometry, unchanged.
- `error` is what makes p348's screen-space selection possible without per-asset tuning: an
  error of `e` on a mesh of extent `x` is a world-space deviation of at most about `e × x` (§2.2), so a
  level is acceptable while that deviation projects to fewer than _N_ pixels. p348 turns this into
  default screen sizes for `lod: 'AUTO'`.
- Chains are kept in a small registry next to the geometry registry: `getLodChain(baseId)`. The
  levels are ordinary registered geometries; the chain takes one ref on each, and releasing the
  base geometry releases the chain.

### 2.2 Simplification rules

Using the `meshoptimizer` npm package (`MeshoptSimplifier`, WASM, same package in Node and in the
worker):

- **Indexed input required.** Non-indexed geometry is welded first (`mergeVertices` semantics,
  position + normal + uv, with a small tolerance). The weld is level 0's _source_; level 0 itself
  stays the original geometry.
- **Shared vertex buffer by default.** `simplify` only writes a new index buffer, so every level
  can reuse level 0's vertex attributes, with only the index differing. That costs no vertex memory
  per level, and keeps the `BatchedMesh` LOD option open (`@three.ez/batched-mesh-extensions`
  requires shared vertex arrays, p350 §7.1). `compactVertices: true` instead gives each level its
  own trimmed vertex buffer, which is better for large meshes whose far levels use few vertices.
- **Attributes.** `simplifyWithAttributes` with normal (and uv) weights, so shading seams and UV
  islands survive. Defaults: normals 0.5, uv 0.5.
- **Groups.** A geometry with material groups (the tree's trunk and foliage) is simplified per
  group range, and the groups are rebuilt over the new index. A group that collapses below a
  minimum triangle count keeps its last viable level.
- **Borders.** `lockBorder` is on for geometry flagged as tiling (p306 terrain blocks), so
  neighbouring blocks still meet at the same level. Off by default.
- **Stopping.** Levels are requested as target ratios (default `[0.5, 0.25, 0.1]`) with a target
  error cap (default 0.05). A level whose triangle count drops less than 10 % from the previous
  one is dropped, and the chain stops when the cap is hit. A chain can be shorter than requested.
- After simplification, each level's index is vertex-cache optimized (cheap and always worth it).
  The meshopt JS has no index-only `optimizeVertexCache`: `MeshoptEncoder.reorderMesh` runs it
  per group range and its vertex remap is inverted, so the level keeps the shared vertex ids.
- **Flat-shaded geometry** (a normal per face) has an attribute seam on every edge and doesn't
  simplify (Phase 0). `permissive: true` lets the simplifier collapse across seams; a chain that
  comes out without levels warns and suggests it.
- **Error.** meshoptimizer's error is relative to the mesh's extent (`getScale`, the largest side
  of its bounding box), not its bounding radius, and with attributes it includes their deviation.
  The chain stores `extent` next to `radius`: a level's world-space deviation is at most about
  `error × extent`.

### 2.3 Runtime API (asset worker)

```ts
generateLodChain(geometryId, opts?): Promise<LodChain>;
// opts: { ratios?, maxError?, attributeWeights?, compactVertices?, lockBorder?, permissive? }
```

- Engine API in `core/Geometry.ts` (or `core/LodChains.ts`). It serializes the geometry to the
  worker (`assetsSwitchSimplify.ts`, a new switch), and registers the returned levels.
- `meshoptimizer` is loaded with a dynamic `import()` on first use, so apps that never generate a
  chain don't download it. That needs the ES module worker (Phase 0): an IIFE worker can't be
  code-split. The main thread loads it only on `MAIN_THREAD` or a fallback.
- Thread choice follows `AppConfig.assets.workerTarget`, with a per-kind
  `simplifyWorkerTarget` override like the existing `gltfWorkerTarget` / `textureWorkerTarget`
  (`Config.ts:123-126`). On `MAIN_THREAD` it runs inline, with a dev warning, since it can take
  tens of ms for a large mesh.
- Results are not cached across reloads. A procedural geometry with a seed produces the same chain
  every time, so a cache can come later (IndexedDB keyed by a geometry hash) if Phase 0 shows the
  cost matters.
- The toolkit generators get an opt-in, eg. `generateTreeGeometry({ ..., lodChain: true })`
  returning the base plus a pending chain, or callers chain `generateLodChain` themselves. The
  latter is enough for Phase 1.

### 2.4 JSON and generated data

- A `*.geometry.json` or `*.importedAsset.json` asset can ask for a chain:
  `"lodChain": true | { "ratios": [...], "maxError": 0.05, "compactVertices": false }`.
- **Imported assets with the build-time path (Phase 3):** p300's gltf-transform step runs the
  simplifier per primitive and writes the levels into the optimized GLB as extra meshes named
  `<name>__lod<n>`. `GLTFExtract.ts` recognises the suffix, attaches them to their base primitive's
  chain instead of registering them as separate pieces, and the worker transfers them like any
  geometry. `gatherAppData` writes `__lodChain` (per-level triangles and error) into
  `generatedAppData.json` for tooling. Why extra meshes rather than `MSFT_lod`: three's
  `GLTFLoader` doesn't support `MSFT_lod`, and named meshes survive any glTF tool.
- **Without the build-time path** (p300 not done, or a primitive geometry type): `lodChain` on an
  imported asset falls back to the runtime path after load. Primitive geometry types (`BOX`,
  `SPHERE`, …) ignore `lodChain` with a dev warning: their LOD is a lower `segments` count, which
  p348 lets authors write as an explicit level.

### 2.5 Debug

- The Assets tab's geometry info window shows a geometry's chain: per level triangles, error,
  bytes, and whether its vertex buffer is shared.
- A "Generate LOD chain" button in that window (debug only) runs `generateLodChain` with defaults,
  for trying a geometry before writing `lodChain` into its JSON.
- A wireframe preview of each level is p348's "force level" tool.

## 3. Phases

### Phase 0 — Spike (half a day) — done

1. `meshoptimizer` in the asset worker (dynamic import, WASM under Vite's worker build) and in
   Node.
2. Time `simplifyWithAttributes` on largeWorld's tree and bush geometry, an asteroid, and the
   largest test GLB (`src/public/debugger/assets/testModels/`). Record the numbers here.

**Exit:** the numbers decide whether a runtime cache (§2.3) is needed up front.

**Results** (2026-10-05, meshoptimizer 1.1.1, Node 22.13 on macOS: the same WASM build as the
worker's; ratios `[0.5, 0.25, 0.1]`, maxError 0.05, weights normal 0.5 / uv 0.5; a level counts
when it drops ≥ 10 % from the previous kept level):

| Geometry                                         |  Tris | Verts | 3× `simplifyWithAttributes` | `reorderMesh` | Kept levels (tris / error)                 |
| ------------------------------------------------ | ----: | ----: | --------------------------: | ------------: | ------------------------------------------ |
| largeWorld tree (2 groups)                       |    30 |    57 |                     0.13 ms |       0.07 ms | none                                       |
| largeWorld bush                                  |   120 |   108 |                     0.17 ms |       0.13 ms | none                                       |
| asteroid d4, flat, weld pos+normal (§2.2)        |   500 |  1500 |        0.48 ms (+ weld 2.4) |       0.31 ms | none                                       |
| asteroid d4, flat, weld position only            |   500 |   252 |        0.45 ms (+ weld 0.8) |       0.15 ms | 250 / .026, 124 / .045, 96 / .050          |
| asteroid d4, flat, weld pos+normal, `Permissive` |   500 |  1500 |                      2.1 ms |       0.16 ms | 250 / .049                                 |
| asteroid d4, smooth                              |   500 |   252 |                     0.43 ms |       0.20 ms | 250 / .042, 208 / .050                     |
| asteroid d10, smooth                             |  2420 |  1212 |                      1.8 ms |       0.63 ms | 1210 / .022, 604 / .039, 468 / .049        |
| largeWorld terrain 150²                          | 45000 | 22801 |                       36 ms |        8.3 ms | 22499 / .0006, 11249 / .0011, 4500 / .0031 |
| terrainSmooth.glb                                | 20000 | 10502 |                       18 ms |        3.0 ms | 9999 / .0005, 4999 / .0011, 1999 / .0034   |
| customPropTestMonkey.glb (flat normals)          |   968 |  1966 |                     0.51 ms |       0.16 ms | none                                       |
| customPropTestMonkey.glb, `Permissive`           |   968 |  1966 |                      3.9 ms |       0.22 ms | 484 / .027, 276 / .049                     |

- Cost: under 2 ms below ~2.5k triangles, ~0.8 ms per 1k triangles above. No runtime cache up
  front; the worker is what keeps a 45k-triangle chain (~45 ms) off the main thread.
- The tree and bush don't simplify at any setting (attributes, no attributes, `Permissive`):
  5-segment shapes with every vertex on a border or seam. Phase 1's exit can't use them.
- Flat-shaded geometry (a normal per face) doesn't simplify with the §2.2 weld (position + normal
  - uv): every edge is an attribute seam. It needs `Permissive` or a position-only weld.
- `simplifyWithAttributes`' error includes the attribute deviation (terrain at 0.1: 0.0031 with
  attributes, 0.0014 on positions alone), so `e × r` overestimates the world-space deviation.
- The meshopt JS has no index-only `optimizeVertexCache`: `MeshoptEncoder.reorderMesh` always
  remaps the vertices too (vertex fetch), so it only fits `compactVertices: true`.
- Vite: the assets worker builds as IIFE (Vite's default `worker.format`), and a dynamic
  `import('meshoptimizer/simplifier')` in it fails `vite build` ("UMD and IIFE output formats
  are not supported for code-splitting builds"). With `worker: { format: 'es' }` it builds, and
  the simplifier is its own 42 kB chunk. A static import adds ~15 kB gzipped to the worker. The
  WASM is embedded in the JS, so it needs no Vite WASM handling. Node already runs it
  (`devTools/assetPipeline/gltf.ts`).

**Decisions** (they change §2.2, §2.3 and Phase 1 as noted there):

- The assets worker builds as an ES module worker (`worker: { format: 'es' }`), so the simplifier
  is a lazy chunk on both threads. The dev server already loads workers as modules.
- Flat-shaded geometry gets a `permissive` option (meshoptimizer's `Permissive` flag), and a chain
  that comes out without levels warns and names it. No position-only weld: the levels keep
  sharing a vertex buffer.
- Phase 1's exit uses largeWorld's terrain (45k triangles) instead of the tree.
- No runtime cache.

### Phase 1 — Runtime chains — done

1. `generateLodChain`, the worker switch, chain registry, ref counting (§2.1–2.3), groups and
   welding (§2.2).
2. Assets tab chain view and "Generate LOD chain" button (§2.5).

**Exit:** largeWorld's terrain geometry (45k triangles) gets a 4-level chain in the worker with no
main-thread stall over 2 ms, and the chain is released on scene exit (p345's snapshot diff is
clean). (The tree was the target, but it can't be simplified: Phase 0.)

**As built:**

- Files: `core/Lod/LodChains.ts` (API, registry: `generateLodChain`, `getLodChain`,
  `getLodChains`, `getLodChainOfLevel`, `isLodChainPending`, `releaseLodChain`),
  `core/Lod/LodSimplify.ts` (the worker-safe simplifier, both threads),
  `workers/assets/assetsSwitchSimplify.ts`, protocol `SIMPLIFY_GEOMETRY`, asset kind `SIMPLIFY`.
- `generateLodChain` resolves to `LodChain | null`: null when it's refused (a level, skinned or
  morph-target geometry, no position, no ratio in (0, 1); warned) or the base was deleted while it
  ran. A chain the base already has is replaced; a call while one is pending returns that one.
- `LodChain` also has `extent` (§2.2), `options` and `report` (where it ran, how long, and
  `mainThreadMs`: the main thread's own copy and register work). `LodChainLevel` has `vertices`:
  `BASE` (the base's attributes), `WELDED` (a non-indexed base's welded arrays, shared by the
  levels) or `OWN` (`compactVertices`).
- `simplifyWorkerTarget` defaults to `WORKER_THREAD` whatever `workerTarget` is (the engine's
  `workerTarget` default is `MAIN_THREAD`). Env var `VITE_ASSETS_SIMPLIFY_WORKER_TARGET`, and a
  boot override in the Assets tab.
- Only the arrays the simplifier needs are sent, as copies (`serializeGeometry`'s new `copy`
  option): position, normal and uv, or every attribute when the base is welded or compacted.
  Indexed levels come back as index arrays only (Uint16 when they fit).
- Each level is simplified from the base, not from the previous level, so its error is against
  the base. A group whose result stays above its target is limited (a lower target gives the
  same), and the chain stops once every group is. A group simplified below 4 triangles keeps its
  last kept level's.
- Release: `Geometry.ts` got `onGeometryDeleted` (every delete path goes through one
  `removeGeometry`), and the chain releases its level refs when its base goes. Levels take the
  base's scene owner (`copyAssetOwner` in `AssetOwners.ts`). Disposing any geometry of a chain frees
  the shared GPU vertex buffers (three r186 deletes a disposed geometry's attributes); a geometry of
  the chain still drawn re-uploads them on its next render. Nothing draws levels before p348, so
  this was accepted rather than worked around.
- Exit (2026-10-05, Chrome on macOS, `?isDebug=true`): 45000 → 22499 → 11249 → 4500 triangles
  (errors .0006, .0011, .0031) in the worker, 139 ms including the worker's start, 0.5 ms of
  main-thread work. The longest frame gap during generation was 17.2 ms against an 18.7 ms
  baseline. After a switch to scene01: no `#lod` geometry, no chain, and the snapshot diff's
  leftovers match a control run without the chain (each level was drawn for a few frames first,
  so its index reached the GPU). Safari not checked.

### Phase 2 — JSON opt-in — done

1. `lodChain` on `geometrySchema` / `importedAssetSchema`, compiled into `.schemas/`.
2. Runtime path for JSON assets (after load).

**As built:**

- Only `importedAssetSchema` has `lodChain` (`schemas/lodChainSchema.ts`: `true` or the
  `LodChainOptions`, strict). `geometrySchema` has only primitive types, which §2.4 already leaves
  out, so it gets no key and no warning. `meshSchema` gets none either: several meshes can share a
  geometry, and its one chain would have to pick one mesh's options (noted in p348).
- `lodChain` is an `ImportAssetParams` option, so code imports get it too. `importAssetAsync`
  requests the chains once it has its manifest (`requestLodChains` in `ImportRegistry.ts`), also for
  a cached or shared import: not awaited, one per rendered geometry (collider-only nodes are skipped,
  a geometry shared by several nodes counts once), skipping a geometry that already has a chain or
  one pending (the first options win) or was released meanwhile. Skinned and morph-target geometry
  is refused by `generateLodChain` (warned).
- `LodChains` is loaded with a dynamic `import()` on the first request, so an app that never asks
  for a chain doesn't download it (only debug code imports it statically).
- A scene that references an import by id only, without its JSON (an import made in code), gets no
  chain from the scene: it has no `lodChain` to read.
- `lodChain` isn't part of p300's cache key (it hashes the resolved optimize settings, not the
  JSON), so adding it doesn't re-encode the GLB. Phase 3 step 2 adds it.
- Known gap: `retagImportOwner` re-tags a cached import's geometries, not their LOD levels, so the
  levels keep the scene that generated them as owner. The chain's ref keeps them from the owner
  sweep and they are released with the base, so only the GPU memory tab's "by owner" is off.
- Checked (2026-10-05, Chrome on macOS, `?isDebug=true`): `"lodChain": true` on
  `testImport.importedAsset.json` gave `testImport/Cube` 1340 → 670 → 426 triangles in the worker at
  the boot scene's load (68 ms, 0.6 ms on the main thread). Not checked: the cached-manifest path on
  a scene re-enter.

### Phase 3 — Build time (after p300 Phase 2)

1. gltf-transform step writing `__lod<n>` meshes (§2.4); `GLTFExtract.ts` chain attachment;
   `__lodChain` in generated data.
2. p300's cache key includes the `lodChain` settings.

**Exit:** a test GLB with `lodChain: true` loads its chain without running the simplifier on the
client.

## 4. Versioning

Engine minor (new API, schema keys). Toolkit minor if the generators get a `lodChain` option.
Project entry for the build-time pipeline step (Phase 3).

## 5. Open questions

1. Skinned and morph-target geometry: simplification breaks skin weights and morph targets unless
   they're passed as attributes. Out of scope for now: `lodChain` on a skinned primitive is refused
   with a dev warning. Characters' LOD belongs with p420.
2. Should the default ratios differ per profile (p300's `hero` / `prop` profiles)? Probably, once
   p348 shows which levels actually get selected.
