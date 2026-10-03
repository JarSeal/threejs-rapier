Status: draft | not-implemented
Category: Assets, Rendering, LOD
Epic: p350_lod-system-research.md (Tier 1.1)
Blocked by: p300_asset-optimization-pipeline-plan.md Phase 2 (soft: only this plan's Phase 3, the build-time GLB path)
Blocks: p348_ecs-lod-selection.md Phase 2 (`lod: 'AUTO'` reads these chains)
Related: \_DONE_p345_gpu-memory-and-draw-call-debugger.md (measures the chains' memory), p306_terrain-blocks-and-procedural-terrain-meshes.md (block geometry is a chain candidate)

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

type LodChain = { baseId: string; radius: number; levels: LodChainLevel[] }; // levels[0] is the base
```

- Level 0 is the original geometry, unchanged.
- `error` is what makes p348's screen-space selection possible without per-asset tuning: an
  error of `e` on a mesh of bounding radius `r` is a world-space deviation of about `e × r`, so a
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
- After simplification, each level's index is run through `optimizeVertexCache` (cheap and
  always worth it).

### 2.3 Runtime API (asset worker)

```ts
generateLodChain(geometryId, opts?): Promise<LodChain>;
// opts: { ratios?, maxError?, attributeWeights?, compactVertices?, lockBorder? }
```

- Engine API in `core/Geometry.ts` (or `core/LodChains.ts`). It serializes the geometry to the
  worker (`assetsSwitchSimplify.ts`, a new switch), and registers the returned levels.
- `meshoptimizer` is loaded **in the worker only**, with a dynamic `import()` on first use, so apps
  that never generate a chain don't download it and the main thread never runs the simplifier.
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

### Phase 0 — Spike (half a day)

1. `meshoptimizer` in the asset worker (dynamic import, WASM under Vite's worker build) and in
   Node.
2. Time `simplifyWithAttributes` on largeWorld's tree and bush geometry, an asteroid, and the
   largest test GLB (`src/public/debugger/assets/testModels/`). Record the numbers here.

**Exit:** the numbers decide whether a runtime cache (§2.3) is needed up front.

### Phase 1 — Runtime chains

1. `generateLodChain`, the worker switch, chain registry, ref counting (§2.1–2.3), groups and
   welding (§2.2).
2. Assets tab chain view and "Generate LOD chain" button (§2.5).

**Exit:** largeWorld's tree geometry gets a 4-level chain in the worker with no main-thread stall
over 2 ms, and the chain is released on scene exit (p345's snapshot diff is clean).

### Phase 2 — JSON opt-in

1. `lodChain` on `geometrySchema` / `importedAssetSchema`, compiled into `.schemas/`.
2. Runtime path for JSON assets (after load).

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
