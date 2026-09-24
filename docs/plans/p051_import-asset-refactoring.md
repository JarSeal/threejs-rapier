Status: draft | not-implemented
Category: Assets
Epic: https://trello.com/c/YCUX4DKL/219-model-import-refactoring
Blocks: p052_gltf-import-via-assets-worker.md

# Import Asset Refactoring — Plan

## Context

`src/_engine/core/ImportModel.ts` (992 lines) is the engine's GLTF/GLB importer. Today one call does everything: it loads the file, creates a group entity, creates one mesh entity per glTF mesh (reusing the glTF materials), parses Blender custom properties, and creates physics entities from them. There are three overlapping entry points (`importModelAsync`, `importModels`, `importModel`) and two structurally different code paths (single mesh vs `importGroup`).

**Scope decision (2026-09-24): a GLTF import only brings in assets.** It registers **geometries** and, when opted in, **textures**, in the engine's existing registries (`Geometry.ts`, `Texture.ts`). It creates no mesh, group or physics entities, and it never imports GLTF materials (meshes use engine materials). Each registered geometry carries its node transform and its parsed Blender custom properties as metadata. A separate **spawner** turns that metadata into mesh and physics entities, which keeps the Blender-authored physics workflow (`isPhysObj`, `colliderType`, compound `index` groups, …) that `scene_thirdPersonGym.ts` depends on.

Why this split:

- **Modular.** Geometry becomes a first-class, ref-counted, shareable asset like any `*.geometry.json` one. Scene JSON `meshes` can reference imported geometry by id, and nothing is created that the app didn't ask for.
- **Threadable.** A pure "file → typed arrays + images + JSON metadata" step is exactly the shape a worker can produce. Moving it off the main thread is its own plan: **p052_gltf-import-via-assets-worker.md**. This plan stays main-thread only, but its output (`ImportedAssetManifest`) is the contract p052's worker must reproduce exactly.

### What changed since the previous revision of this plan

The previous revision predates `_DONE_p028_refactor-old-phys-objs-to-phys-entities.md`. Verified against the code on `physics-api-finalization`:

- `ImportModel.ts` already creates physics through the new Physics API (`createPhysicsEntity`, `deriveColliderDimensionsFromMesh` from `PhysicsManager.ts`). **No file imports `PhysicsRapier.ts` any more** (it is an orphan file, mentioned only in comments), so the whole "dual LEGACY/ECS physics backend" design is dropped.
- The four copy-pasted `createMeshEntity` calls were already deduplicated into `createEntityFromImportedMesh` (`ImportModel.ts:88`), and the `rotation: m.position` bug is gone.
- `Material.ts`'s `deleteTexturesFromMaterial` is already refcount-aware (`isTextureInUseByOtherMaterial`, `Material.ts:497-541`), so the "shared texture gets force-disposed" fix is no longer needed.
- The requested `placement` option is covered by the new spawner's root `transform` (Part 2). `scene_thirdPersonGym.ts` currently works around the gap with an app-side `placeImportedModel` helper (`:36`).
- Worker-thread asset loading (previously Part 3) moved to p052.

Still true today, and handled by this plan:

- `SceneLoader.ts:338` calls `importModelAsync(props.props)` and drops the sibling `entityOpts` the schema defines.
- `importedMeshSchema.ts` has a dead `saveMaterial` field and a commented-out `physicsParams`.
- There is no in-flight de-dup: parallel scene loading can fetch the same `.glb` twice.
- **DRACO is broken, but no one has hit it yet.** `setDracoLoader` (`ImportModel.ts:78-83`) points at `/examples/jsm/libs/draco/`, and no decoder files exist in `src/public`. None of the 20 repo GLBs uses `KHR_draco_mesh_compression`, so the decoder has never been requested. It also creates a new `DRACOLoader` (its own decoder fetch + worker pool) per import call and never disposes it. See Part 5.
- An unknown or typo'd `colliderType` custom prop silently produces no physics.
- The `Geometry.ts` runtime registry doesn't carry `debugData` (the schema has it), and `gatherAppData.ts` doesn't record file sizes.

## Decisions

- **Assets only, plus metadata** (confirmed with the user). The import creates no entities and no materials.
- **`importTextures` is opt-in and off by default.** When on, only textures actually referenced by a glTF material slot are registered. All other GLTF material data is disposed.
- **Physics goes only through the new Physics API.** The spawner calls `createPhysicsEntity`. Physics remains code-only (not in scene/asset JSON), per the existing rule in CLAUDE.md.
- **`ImportModel.ts` is deleted in the last phase.** Every consumer is in-repo and gets migrated in this plan, so no compatibility facade is kept.
- **Threading lives in p052.** This plan adds no worker, config or protocol.

---

## Part 1 — Asset import pipeline

New folder `src/_engine/core/Import/` (mirrors the `Physics/` convention). Everything here runs on the main thread. Everything except the registry writes is pure, so p052 can reuse the same code after rebuilding geometries from worker-transferred arrays.

| File                             | Responsibility                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Import/ImportTypes.ts`          | `ImportAssetParams`, `ImportedAssetManifest`, `ImportedGeometryInfo`, `ParsedCustomProps`, `SpawnImportedParams`, `SpawnImportedResult`                                                                                                        |
| `Import/DracoDecoder.ts`         | Shared, lazily created `DRACOLoader` + decoder path/config (Part 5). Lands first, used by today's `ImportModel.ts` until `GLTFSource.ts` replaces it                                                                                           |
| `Import/GLTFSource.ts`           | `GLTFLoader` setup (DRACO via `DracoDecoder.ts`), filename/extension validation, `loadGLTF(url)` with in-flight de-dup keyed on the absolutized URL                                                                                            |
| `Import/GLTFExtract.ts`          | Walks `gltf.scene` → one `ImportedGeometryInfo` per primitive. Unwraps a single empty wrapper `Object3D` and picks by `meshIndex`/`nodeFilter` (both kept from today). Registers geometries and disposes all remaining GLTF materials/textures |
| `Import/GLTFTextures.ts`         | Opt-in texture registration (see below)                                                                                                                                                                                                        |
| `Import/CustomProps.ts`          | Pure Blender custom-property parsing                                                                                                                                                                                                           |
| `Import/MeshColliderGeometry.ts` | Geometry + transform → collider shape data (moved from `ImportModel.ts`, see Part 2)                                                                                                                                                           |
| `Import/ImportRegistry.ts`       | `importAssetAsync`, `getImportedAsset`, `releaseImportedAsset`, manifest cache                                                                                                                                                                 |
| `Import/SpawnImported.ts`        | Part 2's entity spawner                                                                                                                                                                                                                        |

### Key types

```ts
export type ImportAssetParams = {
  /** Import id, also the geometry/texture id prefix. Default: file basename. */
  id?: string;
  fileName: string;
  /** Default false. true = register every material-slot texture with defaults. */
  importTextures?: boolean | { texOpts?: TexOpts; isPersistent?: boolean };
  /** Kept from today: pick one node by (nested) child index instead of importing all. */
  meshIndex?: number | number[];
  isPersistent?: boolean;
  throwOnError?: boolean;
  debugData?: { name?: string; description?: string };
};

export type ImportedGeometryInfo = {
  geometryId: string;
  nodeName: string;
  /** Node names from the glTF root to this node, for debugging / filtering. */
  parentPath: string[];
  /** Relative to the glTF root (after the empty-wrapper unwrap). */
  transform: { position: Vector3Like; quaternion: QuatLike; scale: Vector3Like };
  customProps: ParsedCustomProps;
  /** The primitive came from KHR_draco_mesh_compression (vertex order not preserved, see Part 5). */
  isDracoCompressed: boolean;
  /** Only with importTextures: which registered texture fills which material slot. */
  textureSlots?: Partial<Record<TextureMapKey, string>>;
};

export type ImportedAssetManifest = {
  id: string;
  fileName: string;
  geometries: ImportedGeometryInfo[];
  textureIds: string[];
};
```

The same `ImportedGeometryInfo` is also stored on `geometry.userData.importInfo`. The debugger and ad-hoc code can then read it from the geometry alone.

### Geometry registration

- Each primitive gets one geometry (a glTF mesh with several primitives yields several geometries). Ids follow `${importId}/${nodeName}`, with a `#n` suffix when a mesh has several primitives. A name collision with a different geometry gets a `_2` suffix and an `lwarn`.
- Geometries are registered with the existing `saveBufferGeometry(geo, { id, isImported: true, isPersistent })` (`Geometry.ts:274`), which already has an `isImported` flag and no call sites yet.
- Collider-only nodes (`isPhysObj && !keepMesh`) are registered too, because the spawner derives TRIMESH/CONVEXHULL/HEIGHTFIELD shapes from them. Nothing ever increments their ref count, so `releaseImportedAsset(id)` is the way to free them: it deletes the import's count-0, non-persistent geometries and textures and drops the manifest. Scene teardown for imports declared in scene JSON calls it.
- A repeat `importAssetAsync` with the same id returns the cached manifest if all of its geometries still exist (`doesGeoExist`), and re-imports otherwise.

### Texture registration (opt-in)

`GLTFTextures.ts` visits only textures actually referenced by a material slot in `textureMapKeys` (`utils/constants.ts`). For each one it:

- Registers the texture with `saveTexture(texture, id, isPersistent)`. Ids prefer the glTF texture name, then the source image filename, then a stable positional fallback, all prefixed `${importId}/`.
- Keeps GLTFLoader's `flipY = false` and its colorSpace (sRGB for color maps, none for data maps). An engine material using these textures then samples them the same way the glTF material would have.
- Sets `userData.gltfSlot` to the slot name.
- Writes `textureSlots` onto each geometry's info, so app code (or a scene JSON material) can pair the right maps with the right geometry.

A texture shared by several glTF materials is registered once. Engine materials that use it go through the existing refcount-aware material cleanup.

### Custom-property parsing (pure)

`parseCustomProps(userData) → ParsedCustomProps` recognizes every key of today's `CustomPropsUserData` (`ImportModel.ts:473-494`): `isPhysObj`, `keepMesh`, `rigidType`, `colliderType`, `density`, `friction`, `frictionCombineRule`, `restitution`, `restitutionCombineRule`, `index`, `id`, `name`, `nCols`, `nRows`, `hx`/`hy`/`hz`, `radius`, `borderRadius`, `halfHeight`. It also keeps the `userData_<key>` → rigid-body `userData` forwarding.

It produces the same defaults as today's `cleanUpCustomProps` (density/friction/restitution 0.2, combine rule `AVERAGE`, unknown `rigidType` → `FIXED`). It has no side effects: it neither mutates `userData` nor creates physics. It returns `warnings`, so an unknown `colliderType` gets one `lwarn` naming the node and file. Today that fails silently.

---

## Part 2 — Entity spawner

`spawnImportedAsset(manifestOrId, params?) → Promise<SpawnImportedResult>` does everything the entity half of `ImportModel.ts` does today, but reads geometries and metadata instead of a live glTF scene graph:

```ts
export type SpawnImportedParams = {
  /** Root transform; every node's transform is composed under it (replaces the gym's placeImportedModel). */
  transform?: { position?: Vector3Like; quaternion?: QuatLike; rotation?: Vector3Like };
  /** Engine material for all visible pieces (glTF materials are never imported). */
  material?: THREE.Material | string;
  /** Per-geometry overrides, by geometryId or node order. */
  meshProps?: Partial<MeshProps>[] | Record<string, Partial<MeshProps>>;
  /** Same override semantics as today's physicsParams: wins field-by-field over custom props,
   * or adds physics to a node that has none. */
  physicsParams?: ImportPhysicsParams | ImportPhysicsParams[];
  /** Only spawn some of the import's geometries. */
  filter?: (info: ImportedGeometryInfo) => boolean;
  entityOpts?: CoreEntityOpts;
};

export type SpawnImportedResult = {
  meshEntityIds: number[];
  /** Entities carrying rigid bodies: a mesh entity (anchor) or a headless physics entity. */
  physicsEntityIds: number[];
};
```

- **Visible pieces.** Each non-collider-only node gets one `createMeshEntity` using the registered geometry by id (so `incGeometryRef` works through the existing `MeshManager.ts` path), the given material, and root ∘ node transform.
- **Physics.** The existing logic moves over rather than being rewritten: the `index` compound grouping, anchor selection and per-collider offset maths from `importMultiplePhysicsObjects` (`ImportModel.ts:816-928`), and `getRigidParamsAndChildColliders`. `deriveMeshDependentColliderFields` (TRIMESH/CONVEXHULL/HEIGHTFIELD, including the fragile HEIGHTFIELD row/column logic, kept as-is) moves into `MeshColliderGeometry.ts`. So do the primitive dimension steps (`setMeshCreatePropsToUserData` + `deriveColliderDimensionsFromMesh`). These now take `(geometry, info.transform.scale)` instead of a template `THREE.Mesh`.
  - HEIGHTFIELD's `mergeVertices` currently replaces `mesh.geometry` in place. It must now write to a scratch geometry and must not replace the registered asset.
- **Collider-only nodes** get no mesh entity. A compound group with no visible piece becomes a headless physics entity at its rigid-body node's transform, as today.
- `createPhysicsEntity(..., target = anchorEntityId)` attaches physics to the existing mesh entity, as today.

---

## Part 3 — JSON schema + scene loading

- **New asset kind.** Replace `schemas/importedMeshSchema.ts` with `schemas/importedAssetSchema.ts`. The file suffix changes from `*.importedMesh.json` to `*.importedAsset.json`, and the scene key from `importedMeshes` to `importedAssets`. Props: `id`, `fileName`, `importTextures`, `meshIndex`, `isPersistent`, `throwOnError`, `debugData`. Dropped: `saveMaterial` (dead), `allMeshesVisible` (already a no-op), `importGroup`, `meshProps`, `groupId`/`groupName`, which are all entity-level. Update `devTools/gatherAppData.ts`'s suffix map, registry and `.schemas/` output accordingly.
- **Load order in `SceneLoader.loadNextSceneAssets`.** Textures and imported assets load first, in parallel. Then materials, geometries and meshes. A scene's `meshes` JSON can then reference an imported geometry (`"geo": "box01/Cube"`) and a material can reference an imported texture id. This gives GLTF geometry a JSON authoring path. The old `createNextSceneObject3Ds` import loop, and with it the dropped-`entityOpts` bug, goes away.
- Scene exit calls `releaseImportedAsset` for the scene's declared imports (persistent ones survive).
- **Migrate `src/app/importedMeshes/testImport.importedMesh.json`** into `importedAssets/testImport.importedAsset.json` plus a `meshes/*.mesh.json` that references the imported geometry and keeps the existing `importedMeshMat`/`testTexture` material, position and shadows. Carry its `__saveData` (`sceneTestECS`) over where the fields still exist.

---

## Part 4 — Assets debugger tab

Follows the repo's dual-layer debug pattern (thin public wrapper + `_dbg__`-prefixed implementation, lazy-imported in debug builds only; `PhysicsAPI.ts` / `Debug/_dbg__PhysicsAPI.ts` is the reference).

- **New files**: `Debug/_dbg__Assets.ts` (the tab) and `Debug/_dbg__AssetStats.ts` (pure helpers: vertex/triangle counts, texture descriptions, byte-size formatting).
- **Registration**: in `InitApp.ts` next to `createPhysicsAPIDebugGUI()`, `orderNr: 8` (free: Physics=6, Renderer=7, Light/Raycast=10).
- **List**: a hand-built `<ul>` (the same list pattern as `_dbg__PhysicsAPI.ts`), built from `getTextureRegistry()` + `getGeometryRegistry()` only, refreshed on a polling interval with signature-diffing. Each row shows name, description (from `debugData`) and a type icon. There are only two row kinds, texture and geometry: an import is a recipe, not an asset.
- **Scene scoping**: scoped by the current scene's declared assets in generated data (`textures`, `geometries`, and the geometry/texture ids of its `importedAssets` manifests), not by tagging registry entries with a scene id (assets are shared many-to-many). A "+N loaded assets not declared in this scene" affordance switches to an "all loaded" scope, which covers assets created in scene `.ts` code.
- **Icons**: 3 new keys in `UI/icons/SvgIcon.ts` (add the `.svg?raw` file + key): the tab icon (a stacked-cards collection mark, sphere + picture corner), texture (filled image frame) and geometry (outlined isometric cube).
- **Info window**: click-to-open `DraggableWindow` (the same pattern as `createEditPhysicsEntityContent`, including `registerDraggableWindowCmp` so it survives a reload). Fields:
  - Common: type, id, filename/path/filetype, file size, ref count, persistent.
  - Texture: dimensions, colorSpace, format/type, mipmaps, filtering, wrap, anisotropy, flipY, estimated GPU memory, and `gltfSlot` if it came from an import.
  - Geometry: vertex and triangle counts. Also "edge instances = 3 × triangles", with an on-demand "compute unique edges" button for indexed geometry under a size guard (BufferGeometry has no edge topology). Also estimated VRAM (buffer byte sizes). For imported geometry: the source (`file.glb`, import id, node path), transform, and parsed custom props incl. warnings, all read from `geometry.userData.importInfo`.
- **File size**: `gatherAppData.ts` bakes a `__fileSize` (`fs.statSync`) next to `__sourcePath` for declared texture files and imported-asset source files. The fallback for undeclared or remote assets is an on-demand "Measure" button (`HEAD` request → `content-length`).
- **`debugData` plumbing**: `Geometry.ts` stores `debugData` on the registry entry and `resource.userData` (the schema already has it; the runtime drops it). Imported geometries get the import's `debugData` name plus their node name.

The worker-target config section of this tab belongs to p052.

---

## Part 5 — DRACO compression (fix + proper support)

### What's wrong today (verified in code)

1. **Wrong decoder path.** `dracoLoader.setDecoderPath('/examples/jsm/libs/draco/')` (`ImportModel.ts:81`) points at a URL nothing serves. Vite's `root` is `./src`, so only `src/public/**` is served at `/`, and the decoders exist only in `node_modules/three/examples/jsm/libs/draco/`. The first DRACO-compressed primitive would fail to load its decoder, and the import would error.
2. **One `DRACOLoader` per import.** `setDracoLoader` runs on every `importModelAsync`/`importModels` call and builds a fresh `DRACOLoader`. Each instance fetches and compiles the decoder separately, starts its own worker pool (up to `workerLimit`, default 4, workers per instance), and is never `dispose()`d. Ten compressed imports would mean ten decoder downloads and up to 40 idle workers.
3. **Never exercised.** None of the repo's GLBs (the 19 test models + `3DSymbols.glb`) lists `KHR_draco_mesh_compression` in `extensionsUsed`, which is why nothing has failed yet. `debug/3DSymbols.ts` has its own `GLTFLoader` without DRACO; it stays as is.

### Design

- **Serve the decoders from the installed three.js version, not from committed copies.** A small `devTools/copyDracoDecoders.ts` (run with `tsx`, like `gatherAppData`) copies the **glTF-variant** decoders into `src/public/draco/gltf/`: `draco_decoder.js`, `draco_decoder.wasm` and `draco_wasm_wrapper.js` from `node_modules/three/examples/jsm/libs/draco/gltf/`. The encoder is not copied.
  - It runs as a step in the `dev`, `dev:*` and `build*` scripts next to `yarn gatherAppData`. It is idempotent (it skips files with identical size/mtime) and `src/public/draco/` is gitignored.
  - Why the glTF variant: it is the build targeted at `KHR_draco_mesh_compression` and smaller (192 KB vs 286 KB wasm).
  - Why a copy script rather than `?url` imports: `DRACOLoader` expects a directory with fixed file names, so hashed `?url` assets would need a `LoadingManager` URL-modifier shim. `vite-plugin-wasm` also intercepts `.wasm` imports. And upgrading three.js then updates the decoders automatically, with no binaries in git.
- **One shared loader: `Import/DracoDecoder.ts`.**
  - `getDracoLoader()` creates the `DRACOLoader` lazily, once. Its decoder path is ``new URL(`${import.meta.env.BASE_URL}draco/gltf/`, document.baseURI).href``: absolute, so it also works with a non-root `base` and inside p052's worker.
  - `configureDraco({ decoderPath?, decoderType?: 'wasm' | 'js', workerLimit? })` lets an app point at a CDN, force the JS decoder, or cap workers. Call it before the first compressed import.
  - `disposeDracoLoader()` terminates the pool on demand. It is not called automatically.
  - No `preload()`. The decoder files are only fetched when a compressed primitive is actually decoded, so apps without DRACO models pay nothing, in keeping with the "only bring into existence what you need" principle.
  - Phase 1 wires this into the **current** `ImportModel.ts` by replacing `setDracoLoader`'s body with `loader.setDRACOLoader(getDracoLoader())`. That fix is testable immediately; phase 2's `GLTFSource.ts` then reuses the same module.
- **HEIGHTFIELD guard.** Draco's default edgebreaker encoding reorders vertices, but HEIGHTFIELD derivation reads heights by grid-ordered vertex index (`threeIndex = flippedZ * sizeX + i`, `ImportModel.ts:791`). A compressed heightfield would load without errors but build the wrong terrain.
  - The pipeline detects compressed primitives through `gltf.parser.json.meshes[m].primitives[p].extensions.KHR_draco_mesh_compression`, mapped to nodes via `gltf.parser.associations`. It records `isDracoCompressed` on `ImportedGeometryInfo`.
  - When `colliderType: 'HEIGHTFIELD'` meets a compressed geometry, it `lerror`s and skips that collider (TRIMESH/CONVEXHULL are order-independent and fine).
  - Authoring note for the docs: export heightfield terrains uncompressed, or with Draco's sequential encoding.
- **COEP check.** The dev server sends cross-origin-isolation headers for the physics SAB. `DRACOLoader`'s blob-URL workers and same-origin decoder fetches should be unaffected, but this has to be confirmed in the browser (see Verification). A cross-origin `decoderPath` (CDN) needs CORP/CORS headers under COEP, which is worth a comment in `configureDraco`'s doc.

### Test assets

Add at least two DRACO-compressed GLBs under `src/public/debugger/assets/testModels/`, either exported from the `.blend` sources in `src/_engine/3dModels/` (`customPropTemplates.blend`, `characterObstacles.blend`) with the Blender glTF exporter's "Compression" option, or re-compressed from the existing GLBs with `npx @gltf-transform/cli draco in.glb out.glb`. No `.blend` source for `box01` exists in the repo, so that one has to use the gltf-transform route:

- `box01Draco.glb`: compare against `box01.glb` visually and by vertex/triangle count.
- `customPropTestMultiColliderDraco.glb`: confirms that node custom props (`extras`) survive compression and that compound physics from compressed geometry matches the uncompressed file.

Optionally, a compressed `terrainSmooth` to confirm the HEIGHTFIELD guard fires.

---

## Suggested phasing (each independently reviewable/committable, non-breaking)

1. **DRACO fix** (Part 5): `devTools/copyDracoDecoders.ts` + script wiring + `.gitignore`, `Import/DracoDecoder.ts`, and today's `ImportModel.ts` switched to the shared loader. Add the compressed test models and a temporary import of them in `physicsTest.ts`. Independent of the rest of the rewrite and testable on the current importer.
2. **Import pipeline, alongside the old importer.** `Import/` types, `GLTFSource` (using `DracoDecoder.ts`), `GLTFExtract` (+ `isDracoCompressed`), `CustomProps`, `ImportRegistry`. `ImportModel.ts` and all consumers are untouched.
3. **Texture opt-in**: `GLTFTextures.ts`.
4. **Spawner**: `SpawnImported.ts` + `MeshColliderGeometry.ts` (+ the HEIGHTFIELD/Draco guard), with the collider/compound logic moved over. Verified with a temporary side-by-side import in `physicsTest.ts`.
5. **Migrate code consumers**:
   - `scene_thirdPersonGym.ts` (16 imports; the spawner `transform` replaces `placeImportedModel`, and `material` replaces `applyMaterialToImportedPieces`/checkerboard loops where possible).
   - `scene01.ts` / `scene01_v2.ts` (box01: its hand-rolled TRIMESH extraction becomes a spawner `physicsParams` override).
   - `utils/world/characterTestObstacles.ts` (re-typed to `ImportPhysicsParams`).
6. **Schema + SceneLoader + JSON migration** (Part 3).
7. **Delete `ImportModel.ts`**, with a repo-wide grep for leftovers (`ImportReturnObj`, `AdditionalImportPhysicsParams`, `PhysicsParams`).
8. **Assets debugger tab** (Part 4).

## Verification

No automated test suite exists. Verification is manual, per phase:

- **Phase 1 (DRACO)**: this needs a real browser and real compressed assets, so it is a hands-on check.
  - `yarn dev` creates `src/public/draco/gltf/` with the three decoder files, and `git status` stays clean.
  - With `?isDebug=true`, load the scene importing the compressed test models. In the Network panel, the three decoder files are fetched **once** in total across all imports, not per import. A scene with no compressed models fetches none of them.
  - `box01Draco.glb` renders the same as `box01.glb`. The compressed multi-collider has the same custom props (`mesh.userData`) and the same physics wireframes as the uncompressed one.
  - In DevTools → Sources → Threads, the DRACO worker count stays ≤ `workerLimit` after several compressed imports (it grew per import before the fix).
  - There are no COEP/CORP console errors with the dev server's isolation headers on. `crossOriginIsolated` is still `true`.
  - `yarn build` → `dist/draco/gltf/` exists. Serve `dist` and repeat the Network check against the production build.
  - Optional: `configureDraco({ decoderType: 'js' })` still decodes, which covers the no-WASM fallback.
- **Phases 2–3**: in a debug scene, `importAssetAsync` a few test models (`box01.glb`, `box01Draco.glb`, `customPropTestMultiCollider.glb`, one with textures) and inspect the manifest and registries in the console: ids, transforms, parsed props, `isDracoCompressed`, warnings, and `flipY`/colorSpace on textures. Import the same file twice in parallel and confirm one fetch in the Network panel.
- **Phases 4–5**: load `scene_thirdPersonGym` with `?isDebug=true` and physics wireframes on. Compare against screenshots taken before the migration: the character must still collide with compound stairs, the TRIMESH/CONVEXHULL monkeys, both heightfield terrains, the slide-angle obstacle and `obstacles.glb`, and positions must match. Check scene01/scene01_v2's box01. If a compressed terrain test model exists, confirm the HEIGHTFIELD guard logs its error and skips the collider.
- **Phase 6**: `yarn gatherAppData` validates `*.importedAsset.json` and regenerates `.schemas/`. `sceneTestECS` shows the migrated test import with its texture. Switch scenes and confirm the import's non-persistent geometries are released (registry counts in the console).
- **Phase 8**: the Assets tab lists the current scene's declared textures and geometries (including imported ones). Click through both info-window kinds. Reload with a window open and confirm it survives.
- Throughout: `yarn lint` and `yarn build` stay clean.
