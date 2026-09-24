Status: implemented
Category: Assets

# Scene Asset Lifecycle Cleanup — Plan

## Context

Found while reviewing p052's Assets tab. Scene changes leave non-persistent assets registered
for the rest of the session. They are not persistent and nothing references them, but nothing
ever frees them either. That is real memory, not just a debugger display issue. The worst case
seen so far is a 4k skybox texture, roughly 85 MB of GPU memory with mipmaps.

Reproduced in the browser (both assets worker targets give the same result) by loading
`sceneTestECS` → `thirdPersonGymScene` → `oneMoreScene` with `loadScene({ sceneId })`. These
stay registered in the empty One More Scene:

| Asset | Count | Why it stays |
| --- | --- | --- |
| Collider-only imported geometries (`stairsStraightCompound/Stairs_phys_compoundBase`, `test_multi_box/Phys_BOX002`, ...) | 10 | Imported in Gym scene code, so `releaseSceneImports` never releases them. No mesh ever used them, so their ref count never dropped to 0. |
| `stress-box-geo`, `stress-sphere-geo` | 2 | Created by `initPhysicsStressTest()` (called from the Gym scene) and never used by a mesh. |
| `otherTestBox` | 1 | Declared by the ECS scene JSON but never used by a mesh. |
| `equiRectEmptyId`, `equiRectSunsetStylizedId` (skybox textures) | 2 | Skybox textures are only deleted by `deleteScene()`, which scene switching doesn't call by default. |

## Root causes (verified in source)

1. **Cleanup only happens when a ref count drops to 0.** `decGeometryRef`/`decMaterialRef`
   delete an entry when its count *drops* to 0. An asset that is registered but never referenced
   stays at 0 and is never checked again. `MeshManager.ts` is the only caller of
   `incGeometryRef`.
2. **Textures have no ref counting in practice.** `incTextureRef`/`decTextureRef` exist but
   nothing calls them. A texture is only freed when:
   - a material using it is deleted (`decMaterialRef` → `deleteTexturesFromMaterial`),
   - its import is released (`releaseImportedAsset`),
   - `deleteScene()` handles the skybox,
   - or something calls `deleteTexture()` directly.

   A texture no registered material uses (skyboxes, environment maps, textures fed straight
   into TSL nodes) is never freed.
3. **Only imports declared in scene JSON are released.** `releaseSceneImports`
   (`SceneLoader.ts`) walks the previous scene's JSON `importedAssets`. Imports made in scene
   code (all of the Gym's) keep their manifest and their collider-only geometries.
4. **Skybox cleanup never runs.**
   - It lives in `deleteScene()`, which `loadScene` only calls with `deletePrevScene: true`, and
     nothing passes that.
   - `clearSkyBox()` only unsets `backgroundNode`/`environmentNode`.
   - `scene.userData.backgroundNodeTextureId` holds one id, but a scene can create several
     skyboxes: the Gym and `scene01V2` each create two.
5. **Materials probably have the same gap** (never-used materials stay at 0). The Assets tab
   doesn't list materials yet, so this is unverified.

## Goals

- Leaving a scene frees every non-persistent asset that the scene brought in and the next scene
  doesn't use. This includes the geometries, textures, materials and import manifests that no
  mesh ever referenced.
- An asset shared by the previous and the next scene is not deleted and then loaded again.
- Persistent assets (`isPersistent`) and assets created outside any scene load (at boot) are
  never touched.
- No change to the public loading APIs.

## Options

**A. Sweep everything unused at scene exit.** After `releaseSceneImports`, delete every
non-persistent geometry and material with ref count 0, every non-persistent texture no registered
material uses, and every non-persistent import manifest.

- Simple, and it also catches assets loaded in scene code.
- It runs before the next scene loads, so shared assets get deleted and loaded again.
- It also deletes assets created at boot without `isPersistent`, which would break app or debug
  code that expects them to stay. That needs an audit first.

**B. Track which scene owns each asset, and release per scene.** Record which scene
registered each asset, and re-tag it whenever a later scene gets it from the cache. On scene
exit, release what the exited scene owns.

- Precise, and assets registered at boot have no owner, so they stay safe.
- It needs hooks on every path that can return a cached asset. Plain `getTexture(id)` reads
  can't be tracked reliably.

**C. (Recommended) Hybrid: record the owner, and sweep after the next scene has loaded.**

- **Recording the owner:** each registration records the scene being loaded
  (`getNextSceneId()` while `isCurrentlyLoading()`, else `getCurrentSceneId()`). Assets created
  before the first scene loads get no owner.
- **Re-tagging on reuse:** when an asset is returned from the cache, it is re-tagged to the
  scene being loaded. This covers the id-hit returns of `createGeometry`, `createMaterial`,
  `loadTexture`, `loadTextureAsync` and `importAssetAsync`. Every registry already returns the
  existing entry on an id hit, so these are one-line additions.
- **The sweep:** it runs at the end of `loadScene`'s LOAD phase, so the next scene has already
  taken refs on, or re-tagged, whatever it shares. It releases the non-persistent assets the
  previous scene still owns and nothing references:
  - geometries and materials with ref count 0,
  - textures no registered material uses and that aren't the active skybox,
  - the previous scene's import manifests, through `releaseImportedAsset`.
- **Memory:** both scenes' assets already coexist during a load today, so peak memory doesn't
  change.

## Phases (each can be reviewed and committed on its own)

1. **Owner tracking, no behavior change.**
   - Record the owner on registration and re-tag on cache hits, for geometries, textures,
     materials and imports. Keep it in one small owner map, not in `userData`: `setTextureOpts`
     replaces texture `userData`, and clones copy it.
   - Show "Owner scene" in the Assets tab's info window.
   - Let the tab's "in this scene" list use declared ∪ owned. This also fixes code-driven scenes
     like the Gym showing "0 assets in this scene".
2. **The sweep after the scene loads.**
   - Release what the previous scene owns and nothing references, as described in option C.
   - Log a debug summary of what was released.
3. **Skybox cleanup.** Fold skybox textures into the sweep. Drop the single
   `backgroundNodeTextureId`, or make it a list. Decide what `deletePrevScene` should still mean
   on top of the sweep.
4. **Audit.** Find assets created during a scene load that are meant to outlive it, and mark them
   `isPersistent`. Candidates: debug tooling, and anything the app registers from inside a
   scene's first load.

## Verification

No automated test suite exists. Verification is manual:

- `sceneTestECS` → `thirdPersonGymScene` → `oneMoreScene`: afterwards only persistent assets and
  those registered at boot are left (the 15 above are gone). The Assets tab's "+N" button shows
  0, or only those.
- Back to the Gym: models, colliders (physics wireframes), textures and the skybox are all back
  and correct, and the console shows no errors.
- Two scenes sharing an asset (for example the same texture id): switching between them doesn't
  reload it. Check the texture's "Loaded on / Load duration" in the Assets tab: it keeps its
  first load's report.
- The renderer's memory info (`renderer.info.memory` geometry/texture counts) goes back down
  after leaving a scene.
- `yarn lint` and `yarn build` stay clean.

## Open questions

- Should a scene be able to keep assets for the next one (eg. preloading a level)? Options:
  `isPersistent` plus a later manual release, or a `keepAssets` option on `loadScene`.
- Should the sweep be configurable (eg. `AppConfig.assets.releaseOnSceneChange`, default on)?
- Materials: confirm root cause 5 first. Adding materials to the Assets tab would make it visible.

## Implementation notes

What was built, where it differs from the plan above:

- **Owner tracking** (`core/Assets/AssetOwners.ts`): a `WeakMap` keyed by the registered object.
  SceneLoader sets the owner scene when a load starts, so the registries don't import
  SceneLoader. A cache hit never claims an asset without an owner (registered at boot), so boot
  assets stay untouched. Re-tagging also covers `loadTextures`, the `save*` id hits, the
  file-name hit of `loadTexture`, reused geometries and textures of a re-import, the assets of a
  cached import, scene JSON references by id, spotlight cookie textures and
  `spawnImportedAsset`.
- **The sweep** (`core/Assets/SceneAssetRelease.ts`) runs after `createNextSceneObject3Ds`. It
  replaces `releaseSceneImports` and is skipped when a scene is reloaded onto itself. A released
  material only disposes its own texture clones: registered textures are released by owner. The
  "used by a material" check also covers TSL node input textures.
- **Sky boxes**: `SkyBox.ts` bakes PMREMs itself (a throwaway `PMREMGenerator` per bake) and
  disposes each with its source texture. `pmremTexture(sourceTexture)` gave every node its own
  generator, and neither the generators nor the baked targets were ever disposed.
  `backgroundNodeTextureId` is gone: `deleteScene` deletes the textures of all the scene's sky
  boxes. A sky box created without a `sceneId` during a load now belongs to the loading scene
  (it used to go to the scene still showing).
- **`deletePrevScene`** runs the sweep before the next scene loads instead of after it (lower
  peak memory, shared assets are loaded again). It used to force-delete the previous scene's mesh
  assets, persistent ones included.
- **Found on the way**: `addCheckerboardMaterialToMesh`/`addNestedGridMaterialToMesh` assigned
  `mesh.material` directly and leaked material refs. `MeshManager.setMeshMaterial` moves the ref.
- **Audit (phase 4)**: nothing needed `isPersistent`. `PhysicsStressTest` now resolves its assets
  per batch, since its `j` key works in every scene.

Open questions, as resolved: no `keepAssets` option (`isPersistent` covers keeping assets), the
sweep isn't configurable, and root cause 5 (unused materials) was confirmed and is covered.

Follow-ups, not part of this plan:

- The Gym grows by one GPU geometry and one texture per visit:
  [p054_gym-scene-gpu-memory-growth.md](./p054_gym-scene-gpu-memory-growth.md).
- `ECSStressTest`'s instanced mesh (unregistered geometry and material, added to the root scene)
  and its systems are never cleaned up and carry across scenes.
