Status: draft | not-implemented
Category: Assets
Epic: https://trello.com/c/YCUX4DKL/219-model-import-refactoring

# Import Asset Refactoring — Plan

## Context

`src/_engine/core/ImportModel.ts` (1086 lines) is the engine's GLTF/GLB model importer, and it has accumulated real architectural debt: three overlapping entry points with inconsistent internals, a 287-line function with two near-duplicate code paths (single mesh vs. group import), a `createMeshEntity({...})` call copy-pasted four times (one copy has a live bug — wrong fallback field), and custom-property parsing spread across several tightly-coupled helper functions. It also has two capability gaps the user wants closed: it never touches textures at all (GLTF-embedded materials/textures ride along untracked, bypassing the engine's own `Texture.ts`/`Material.ts` registries), and all asset loading — this importer and the separate `Texture.ts` — is main-thread-only with no way to move loading off the render thread.

This plan designs a ground-up rewrite (not an incremental patch, given the scope) that:

1. Restructures model importing into a clean pipeline of small, mostly-pure modules, while preserving every existing feature — especially the Blender-custom-property → physics-entity pipeline that scenes like `scene_thirdPersonGym.ts` depend on.
2. Adds an opt-in feature to import and properly register GLTF-embedded textures.
3. Adds a main-thread/worker-thread configuration for asset loading, modeled on the existing physics worker-threading architecture, applied to texture loading now (GLTF loading stays main-thread in this plan — see Decisions).
4. Adds a new "Assets" debugger tab (with a new SVG icon) listing scene assets with click-to-inspect detail windows.

This was researched via 3 parallel codebase-exploration passes and 3 parallel architecture-design passes, all with direct source verification (not assumption) of the claims below. Four scope-defining decisions were made explicitly with the user (see Decisions).

## Decisions (confirmed with user)

- **Physics backend: dual-backend, ship on legacy.** The new import pipeline will produce physics params in the *new* Physics API's shape (`Physics/PhysicsAPITypes.ts` `ColliderParams`/`RigidBodyParams`), but by default still create bodies in the **legacy** `PhysicsRapier.ts` world via an adapter (`PhysicsBackendLegacy`). A second adapter (`PhysicsBackendECS`, using `PhysicsManager.createPhysicsEntity`) is built in this plan but stays **opt-in/dark** (not the default), verified on a dedicated test scene. Reason: `PhysicsRapier.ts` and the new Physics API are two *separate Rapier worlds* — bodies in one can't collide with bodies in the other — and `Character.ts`/`MainLoop.ts`/`movingPlatform.ts`/etc. (~10 files) still run on the legacy world. Porting the importer alone would make `scene_thirdPersonGym.ts`'s character fall through every imported surface. Migrating those ~10 files is a separate future plan; this plan makes that eventual flip a config change, not a rewrite.
- **GLTF threading: textures threaded now, GLTF stays main-thread.** Worker-thread texture loading (fetch + `createImageBitmap`) is implemented in this plan. Worker-thread GLTF *parsing* is architecturally designed for (the shared `AppConfig.assets` config, the worker/protocol scaffolding) but not implemented — `GLTFLoader.parse()` continues to run on the main thread. Reason: textures are a clear, low-risk win; full in-worker GLTF parsing requires serializing the entire scene graph into transferable descriptors (structured clone can't preserve `THREE.*` class prototypes) and correctly covering morph targets, skinning, and GLTF extensions — real fidelity risk that deserves its own follow-up plan and spike, not to be absorbed into this one.
- **`importTextures` opt-in defaults off.** Registering GLTF textures/materials changes their memory-lifetime semantics (ref-counted and shareable, vs. today's untracked-inside-the-material). Off by default so no existing scene's behavior changes; consumers opt in per import.
- **Consumer call sites updated now.** The new `placement` import option (set position/rotation/quaternion at import time) is added, and `scene_thirdPersonGym.ts`'s ~15 manual post-import `mesh.position.set(...)` + `physObj.rigidBody.setTranslation(...)` blocks are refactored to use it, in this plan — rather than deferring that cleanup to when the ECS backend is eventually flipped on.

## Two corrections to prior assumptions (verified in source, load-bearing)

- `cleanUpCustomProps` does **not** mutate the live `mesh.userData` — the parameter is rebound to a shallow copy (`ImportModel.ts:585`, `userData = { ...userData, ...overrides }`) before any `delete` runs. So today, imported meshes **retain** their GLTF custom props in `userData` after import (only `isPhysObj` is truly deleted, group path only). The redesign should preserve this real behavior (leave `mesh.userData` as GLTF delivered it, additionally attach a parsed-props debug object) rather than "fixing" it into a breaking change.
- The new Physics API was seemingly designed with this importer in mind: `saveBufferGeometry(geo, { isImported: true })` (`Geometry.ts:274`) and `ColliderParams.orientation` ("Do not set manually! ... for imported models", `PhysicsAPITypes.ts:1035`) already exist with **zero current call sites**.

---

## Part 1 — Import pipeline rewrite

### Module structure

Keep `src/_engine/core/ImportModel.ts` as a thin facade (re-exports only, ~60 lines) so no existing import path breaks. Real implementation moves into a new `src/_engine/core/Import/` folder (mirroring the `Physics/` convention):

| File | Responsibility |
|---|---|
| `Import/ImportTypes.ts` | All public + internal types (`ImportModelParams`, `ImportResult`, `ImportPhysicsParams`, `ImportedNode`, `TextureImportOptions`, etc.) |
| `Import/GLTFSource.ts` | `GLTFLoader`/DRACO setup, filename validation, `loadGLTF()`, in-flight de-dup (today, `SceneLoader.ts`'s `Promise.all` can fetch the same `.glb` twice) |
| `Import/GLTFScenegraph.ts` | Normalizes `gltf.scene` → flat `ImportedNode[]`; owns the "single empty wrapper `Object3D`" unwrap and `meshIndex` path picking |
| `Import/CustomProps.ts` | Pure, non-mutating Blender-custom-property parsing (see below) |
| `Import/PhysicsSpec.ts` | Pure merge (caller `physicsParams` overrides file custom props) + `index`-based compound-object grouping |
| `Import/MeshColliderGeometry.ts` | Mesh → engine-agnostic collider geometry (bbox sizing, TRIMESH/CONVEXHULL vertex arrays, HEIGHTFIELD grid, spine-axis orientation) — this logic doesn't exist in the new Physics API by design (it can't; colliders there are mesh-free so they can run in a worker), so it must live here regardless of backend choice |
| `Import/PhysicsBackend.ts` | The one shared interface (`ImportPhysicsBackend`, `PhysicsBodyRequest`, `ImportedPhysicsHandle`) |
| `Import/PhysicsBackendLegacy.ts` | Default. Adapts to `createPhysicsObjectWithMesh`/`WithoutMesh` (`PhysicsRapier.ts`) |
| `Import/PhysicsBackendECS.ts` | Opt-in. Adapts to `PhysicsManager.createPhysicsEntity` |
| `Import/EntityBuilder.ts` | The one and only `createMeshEntity` call site; group entity creation; `keepMesh` disposal (computed as a set up front, not re-derived from userData) |
| `Import/GLTFAssetRegistration.ts` | New feature: registers GLTF textures/materials/geometries into `Texture.ts`/`Material.ts`/`Geometry.ts` (Part 2 detail) |
| `Import/ImportPipeline.ts` | Orchestrator — one pipeline for all three public entry points |

`importGroup` stops being a structural fork; it collapses into one pipeline with orthogonal flags:
```
loadGLTF → collectNodes → parseCustomProps → resolvePhysicsSpecs → groupCompounds
  → registerImportedAssets (if importTextures) → buildVisualEntities
  → deriveColliderGeometry → createPhysicsBodies (backend) → disposeUnkeptMeshes → toImportResult
```
The array↔single-value coalescing that's currently duplicated ~8 places happens exactly once, in `toImportResult`.

### Key types (additive — existing fields/behavior unchanged)

```ts
export type ImportModelParams = {
  // ...all existing fields unchanged...
  importTextures?: boolean | TextureImportOptions;   // new, Part 2
  placement?: { position?: Vector3Like; quaternion?: QuatLike; rotation?: Vector3Like }; // new
  physicsBackend?: 'LEGACY' | 'ECS';                  // new, per-import override; default from AppConfig
};

export type ImportResult = {
  // existing fields unchanged: group, groupId, mesh, meshId, physObj (kept, @deprecated on LEGACY path)
  entityIds: number[];              // new
  physics: ImportedPhysicsHandle[]; // new — backend-neutral handle, see below
  assets?: ImportedAssetIds;        // new, Part 2
};

// PhysicsBackend.ts
export type ImportedPhysicsHandle = {
  appId: string;
  entityId?: number;                 // ECS backend only
  setTranslation(pos: Partial<Vector3Like>, opts?: { wakeUp?: boolean; moveVisual?: boolean }): void;
  setRotation(rot: QuatLike, opts?: { wakeUp?: boolean; moveVisual?: boolean }): void;
  legacy?: PhysicsObject;    // exactly one of legacy/rigidBody is populated
  rigidBody?: RigidBodyAPI;
};
```

### Custom-property parsing (pure, preserves every recognized key)

`CUSTOM_PROP_KEYS` (one source of truth, also drives future docs/debug display): `isPhysObj`, `keepMesh`, `rigidType`, `colliderType`, `density`, `friction`, `frictionCombineRule`, `restitution`, `restitutionCombineRule`, `index`, `id`, `name`, `nCols`, `nRows`, `hx`/`hy`/`hz`, `radius`, `borderRadius`, `halfHeight`, plus the `userData_<key>` forwarding convention (kept as-is — no in-repo consumers to break, and it's the only mechanism Blender artists have for attaching arbitrary gameplay data to a body).

`parseCustomProps(userData) → ParsedCustomProps` is a pure function (no mutation, no side effects) that also collects `warnings` for unrecognized/malformed values — today a typo'd `colliderType` in Blender silently produces *no* physics with no error; this rewrite `lwarn`s once per import with the offending node name instead.

`resolvePhysicsSpec(parsed, override?)` in `PhysicsSpec.ts` implements the override semantics exactly as today: caller-supplied `physicsParams` wins field-by-field over GLTF-parsed custom props, or can add physics with no custom props present at all. `groupByCompoundIndex(specs)` replaces `importMultiplePhysicsObjects`/`getRigidParamsAndChildColliders` with the same `index`-based bucketing (meshes sharing a numeric `index` become one compound body: a "main" mesh carrying `rigidType` plus sibling collider-only meshes).

### JSON schema additions

New `src/_engine/schemas/_physicsSchemas.ts`: `RigidBodyParamsSchema`, `ColliderParamsSchema` (Zod discriminated union on `type`, covering CUBOID/BOX, BALL/SPHERE, CAPSULE/CONE/CYLINDER, TRIMESH, HEIGHTFIELD, CONVEXHULL), `ImportPhysicsParamsSchema`. (Typed-array-only fields like `vertices`/`heights` and function fields like `collisionEventFn` are intentionally excluded from the JSON schema — they're derived from the mesh or are TS-only.)

`importedMeshSchema.ts` gains: `physicsParams` (currently commented out — `// physicsParams: z.union([]),` — this is why JSON-authored imports can currently only get physics from GLTF-baked custom props, never from JSON overrides), `importTextures`, `placement`. Also drop the dead `saveMaterial` field (in the schema, but nothing in `ImportModel.ts` ever reads it) and fix a real bug found during research: `SceneLoader.ts:338` calls `importModelAsync(props.props)` but drops the sibling `entityOpts` the schema defines — so `appId`/`debugData`/`persistent` authored in a `.importedMesh.json` file are silently ignored today.

### Consumer migration

No consumer *needs* to change (new fields are all optional, existing `ImportResult` fields keep their type/semantics under the default LEGACY backend). Per the confirmed decision, this plan also does the following non-required-but-recommended cleanup:

- `src/app/scene_thirdPersonGym.ts`: replace its ~15 manual `mesh.position.set(...)` + `physObj.rigidBody.setTranslation(...)`/`physObj.setTranslation(...)` blocks with the new `placement` option on the import call.
- `src/_engine/utils/world/characterTestObstacles.ts`: re-type its `physicsParams` param from the legacy-typed `Partial<PhysicsParams & AdditionalImportPhysicsParams>` to the new `ImportPhysicsParams`.
- `src/_engine/core/SceneLoader.ts`: fix the dropped-`entityOpts` bug above.

`scene01.ts`/`scene01_v2.ts` need no changes (optionally adopt `importTextures: true` later to drop their hand-rolled texture-swap workaround — not required by this plan).

### Verified physics-capability parity (why the dual-backend design is safe)

Checked directly against `Physics/PhysicsAPITypes.ts`, `PhysicsManager.ts`, `Physics/EngineRapier.ts`: all 7 collider types match, compound multi-collider bodies are supported (`PhysicsManager.ts:75-81` sets `parentId` per collider), per-collider local offset and the Blender spine-axis `orientation` field both exist and are unused elsewhere (built for this), rigid-body userData forwarding has parity, and `createPhysicsEntity` being async fits the already-async import flow cleanly. The real gap is mesh→collider-geometry derivation, which doesn't exist in the new API by design (colliders there are mesh-free, since they may run in a worker) — `MeshColliderGeometry.ts` fills that gap for both backends.

---

## Part 2 — Texture importing from GLTF (new opt-in feature)

```ts
export type TextureImportOptions = {
  idPrefix?: string;             // default: appId ?? basename(fileName)
  isPersistent?: boolean;
  texOpts?: TexOpts;
  registerMaterials?: boolean;   // default true
  registerGeometries?: boolean;  // default false
  reuseExistingIds?: boolean;    // default true
};
```

`registerImportedAssets` walks each material actually applied to a mesh (**after** any caller `meshProps[].mat` override — GLTF materials that lose to an override must not be registered, or they'd sit at `count: 0` forever), and for each populated slot in `textureMapKeys` (`Material.ts` — needs exporting) calls `saveTexture`/`saveMaterial`/optionally `saveBufferGeometry`. Id generation prefers the glTF texture's own name, then its source image filename, then a stable positional fallback, with collision-on-different-instance producing a `_2` suffix and a warning.

**Ordering matters and is the reason this is simple:** `createMeshEntity` already calls `incGeometryRef`/`incMaterialRef` when `geo.userData.id`/`mat.userData.id` exist (`MeshManager.ts:76-77`), and `disposeMesh` already calls the matching `dec*Ref`. Running registration *before* `buildVisualEntities` in the pipeline means imported assets get correct ref-counting and disposal for free, with zero `MeshManager` changes.

**One pre-existing hazard this feature makes reachable, fixed in this plan:** `Material.ts`'s `deleteTexturesFromMaterial` (called from `decMaterialRef` at zero) currently force-disposes textures via `deleteTexture(id)` regardless of remaining refcount. That's harmless today because nothing shares a texture across materials, but once imported textures are shared and ref-counted, disposing one material could yank a texture still in use elsewhere. Fix: change it to `decTextureRef` (keep the hard-delete behind an explicit `deleteMaterial(id, deleteTextures: true)`).

---

## Part 3 — Main/worker-thread asset loading (textures now, GLTF-ready architecture)

### Config

New `AppConfig.assets` (`Config.ts`, sibling to `physics`):
```ts
assets?: {
  workerTarget?: 'MAIN_THREAD' | 'WORKER_THREAD';   // shared default, default 'MAIN_THREAD'
  textureWorkerTarget?: 'MAIN_THREAD' | 'WORKER_THREAD'; // per-kind override, falls back to workerTarget
  maxConcurrentLoads?: number;   // default 8
  requestTimeoutMs?: number;     // default 30000
  fallbackToMainThread?: boolean; // default true
};
```
Follows the exact `physics.workerTarget` convention: env var overrides (`VITE_ASSETS_*`) plus a debug-env-only boot-time localStorage override (`AEK_debugAssetsBoot`) read in `loadConfig()`, applied on next reload — mirroring `DEBUG_PHYSICS_API_BOOT_LS_KEY`. Default is `MAIN_THREAD` (not `WORKER_THREAD` like physics) since this is new, unproven infrastructure — the app opts in via `src/CONFIG.ts` once verified.

No `useSAB`/transport-mode fields: verified that `SharedArrayBuffer`/`crossOriginIsolated` are irrelevant here. Physics needs a persistent shared buffer because it's written 60×/second; asset loads are one-shot, so plain `Transferable` (`ArrayBuffer`/`ImageBitmap`) postMessage — which needs no cross-origin isolation — is sufficient and simpler. The worker holds no cache (transferred buffers are detached after send); `Texture.ts`'s existing registry remains the single source of truth.

### What moves to the worker

Textures: worker does `fetch` → `Blob` → `createImageBitmap(blob, opts)` (verified available in Web Workers, no DOM dependency), or for `.hdr` runs `HDRLoader.parse()` on the raw `ArrayBuffer` (pure JS, currently a genuine main-thread cost). Returns a transferable `ImageBitmap`/typed array. Main thread wraps it (`new THREE.Texture(bitmap)`) and proceeds through the **existing, unchanged** `setTextureOpts`/`saveTexture` calls — so registry/ref-count/persistence semantics are identical on both branches.

GLTF: **not moved to the worker in this plan** (see Decisions). Feasibility was investigated (source-verified against the installed three.js 0.183.2 — `GLTFLoader.parse()` has zero DOM dependencies except a Safari-<17/Firefox-<98 fallback branch), so the config/protocol groundwork below is deliberately shaped to support adding it later without rework.

### Protocol & facade

New `AssetsProtocolType` enum + `AssetsUpProtocol`/`AssetsDownProtocol` discriminated unions (flat `switch` dispatch — no numeric-range bucketing like physics needs, since there's no per-frame hot path to fast-dispatch). Reuses the two genuinely generic pieces of the physics worker infrastructure, confirmed to have zero non-physics consumers today:

- `initWorker<T>` (`utils/helpers.ts:400`) for the worker bootstrap/handshake.
- `createNewResolver`/`resolveRequest` (`utils/PromiseResolver.ts`) for request/response correlation — extended **additively** (new optional `reject` param + `rejectRequest`/`deleteResolver`) to fix a latent bug found during research: the physics `ERROR` path (`PhysicsAPI.ts:325-329`) logs and returns without resolving, leaking the pending promise forever. The assets worker's `ERROR` messages must resolve (as a `{ok:false, error}` envelope), not just log.

`Texture.ts`'s public `loadTextureAsync(props)` signature **does not change** — internally it branches on the resolved worker target exactly as `PhysicsAPI.ts` branches on `physicsState.workerTarget`, with both branches converging on the same `setTextureOpts`/`saveTexture` calls. Callers (`SceneLoader.ts`, `SkyBox.ts`, app code) stay thread-agnostic.

New files: `Assets/AssetsAPITypes.ts`, `Assets/AssetsAPI.ts` (`initAssets()`, called from `InitApp.ts` after `loadConfig()` and before `registerScenesFromGeneratedData()`), `workers/assetsWorker.ts`, `workers/assets/assetsSwitchTexture.ts`.

**Known gotcha to build in from day one:** URLs must be absolutized on the main thread before posting to the worker (`new URL(fileName, new URL(path, document.baseURI)).href`) — inside the worker, relative `fetch` resolves against the worker's own (hashed, production-chunked) script URL, not the page, so unabsolutized relative paths 404 silently.

---

## Part 4 — Assets debugger tab

Follows the repo's established dual-layer debug pattern exactly (thin public wrapper + `_dbg__`-prefixed real implementation, lazy-imported only in debug builds — see `PhysicsAPI.ts`/`Debug/_dbg__PhysicsAPI.ts` as the reference).

- **New files**: `Debug/_dbg__Assets.ts` (the tab), `Debug/_dbg__AssetStats.ts` (pure stat-computation helpers: geometry vertex/triangle counts, texture descriptions, byte-size formatting — kept separate so they're reusable and independently readable).
- **Registration**: `InitApp.ts`, alongside `createPhysicsAPIDebugGUI()`, `orderNr: 8` (free slot between Renderer=7 and Raycast=10).
- **Tab layout**: config section (workerTarget selector for `AppConfig.assets`, boot-override + reload, same pattern as the Physics tab) above a filterable, searchable asset list (scope: current scene / all declared / all loaded — see scoping note below).
- **List**: hand-built `<ul>` (not Tweakpane — matches the existing list-of-entities pattern in `_dbg__PhysicsAPI.ts`), sourced by merging `getTextureRegistry()` + `getGeometryRegistry()` + declared assets from the generated scene data (`generatedAppData.json`), refreshed on a polling interval with signature-diffing to avoid needless rebuilds. Each row shows name + description (from each asset's `debugData`) and a type icon.
- **Scene scoping — recommendation**: scope by the *declared* assets in the current scene's generated data (`generatedAppData.scenes[id].textures/geometries/importedMeshes`), not by tagging registry entries with a scene id. Assets are shared/ref-counted across scenes (many-to-many), so a single "owning scene" field on the registry would be semantically wrong; the declared-assets relation already exists in generated data for free. A visible "+N loaded assets not declared in this scene" affordance covers assets created imperatively in scene `.ts` code (which the declared-list approach can't see), switching to an "all loaded" scope on click.
- **Icons**: 4 new SVG keys added to `UI/icons/SvgIcon.ts`'s existing `icons` map (drop `.svg?raw` file, add key, use via `getSvgIcon(key)`) — one for the Assets tab button itself (a stacked-cards "collection" mark combining a sphere + picture-corner glyph to signal "3D + image assets"), and three for per-row type differentiation: texture (filled image-frame glyph), geometry (outlined isometric cube), imported model (a faceted low-poly solid with a small inbound arrow).
- **Info window**: click-to-open `DraggableWindow` (matching `_dbg__PhysicsAPI.ts`'s `createEditPhysicsEntityContent` pattern, including the `registerDraggableWindowCmp` re-registration needed for the window to survive a page reload while open). Fields:
  - Common: type, filename, path, filetype (all derived from the asset's `fileName`/`path` — no schema change needed), size.
  - Texture: dimensions, plus color space / format-type / mipmaps / filtering / wrap / anisotropy / estimated GPU memory / ref count.
  - Imported model: mesh/material/texture counts, aggregate vertex/triangle counts (triangle count via `geometry.index ? index.count/3 : position.count/3`; **"edges" is intentionally not shipped as a single number** — `BufferGeometry` has no edge topology, and a meaningful unique-edge count requires an expensive weld/hash pass whose result depends on a chosen tolerance; instead show the exact, cheap "edge instances = 3 × triangles" with a clearly-labeled on-demand "compute unique edges" button for indexed geometry under a size guard), the list of embedded textures each showing full texture info recursively, plus a total estimated VRAM footprint.
- **File size**: not tracked anywhere today. Primary source: bake it at build time in `devTools/gatherAppData.ts` (a `fs.statSync` per declared asset file, written as a new optional `__fileSize` field alongside the existing `__sourcePath`, on the top-level catalog entries only). Fallback for undeclared/remote assets: an on-demand "Measure" button doing a `HEAD` request and reading `content-length`.
- **`debugData` (name/description) gap**: `TextureSchema` already has it and `Texture.ts` already surfaces it on the live resource; `GeometrySchema` has it in the schema but `Geometry.ts`'s runtime type doesn't carry it through yet; `importedMeshSchema.ts` has no props-level `debugData` at all (only via `entityOpts.debugData`). This plan adds the missing runtime plumbing for geometries and adds a props-level `debugData` field to `importedMeshSchema.ts` (Part 1) so all three asset kinds support it uniformly.

---

## Suggested phasing (each independently reviewable/committable)

1. **Extract, no behavior change** — `Import/` module split, single pipeline, dedup the 4x `createMeshEntity` call (fixing the `rotation: m.position` bug), remove the two-path fork. Consumers untouched.
2. **`MeshColliderGeometry.ts`** — move mesh→collider-shape derivation into the importer; legacy backend now receives fully-resolved params. Acceptance: visual diff of `scene_thirdPersonGym.ts` (the only scene exercising compound bodies, TRIMESH, CONVEXHULL, and heightfield terrain — there's no automated test suite, so this scene is the manual gate for every physics-adjacent phase).
3. **Texture/material/geometry registration** (Part 2) + the `deleteTexturesFromMaterial` refcount fix. Opt-in, default off.
4. **Schema updates** (`_physicsSchemas.ts`, `importedMeshSchema.ts` additions, drop `saveMaterial`, fix the `SceneLoader.ts` dropped-`entityOpts` bug).
5. **`placement` option + consumer cleanup** — add the option, refactor `scene_thirdPersonGym.ts`'s manual positioning.
6. **`PhysicsBackendECS.ts`** — opt-in second backend, verified on a dedicated test scene (e.g. `src/app/physicsTest.ts`), not defaulted on.
7. **Asset threading (Part 3)** — `AppConfig.assets`, worker/protocol scaffolding, `Texture.ts` worker branch, `PromiseResolver.ts` reject/timeout extension.
8. **Assets debugger tab (Part 4)** — icons, schema `debugData` plumbing, `gatherAppData.ts` file-size baking, the tab itself.

Later, out of scope for this plan: migrating `Character.ts`/`movingPlatform.ts`/etc. off the legacy physics world (which is what would let the ECS import backend become the default), and in-worker GLTF parsing.

## Verification

No automated test suite exists in this repo. Verification is manual, per phase:

- After phases 1–2 and 5–6: load `scene_thirdPersonGym.ts` with `?isDebug=true`, confirm the character still collides correctly with imported stairs/terrain/obstacles (compound bodies, TRIMESH, CONVEXHULL, heightfield), and that positions match pre-refactor screenshots.
- After phase 3: toggle `importTextures: true` on one import in a test scene, confirm textures appear in the new Assets tab's texture list with correct ref counts, and confirm disposal (`decMaterialRef` reaching zero) doesn't break a texture still shared elsewhere.
- After phase 4: run `yarn gatherAppData` and confirm `.importedMesh.json`/`.texture.json` assets with the new fields still validate; confirm `.schemas/*.schema.json` regenerate without errors.
- After phase 7: toggle `AppConfig.assets.workerTarget` between `MAIN_THREAD`/`WORKER_THREAD` via the debug boot-override, confirm textures load and render identically both ways (visual diff), including a relative-path texture (to catch the URL-absolutization gotcha) and an HDR texture.
- After phase 8: open the Assets tab, confirm the list matches the current scene's declared assets, click through texture/geometry/model info windows, reload the page with a window open and confirm it survives.
- Throughout: `yarn lint` and `yarn build` must stay clean.
