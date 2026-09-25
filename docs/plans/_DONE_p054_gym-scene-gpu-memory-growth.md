Status: implemented
Category: Bug fix

# Gym Scene GPU Memory Growth — Plan

## Context

Found while verifying [\_DONE_p053_scene-asset-lifecycle-cleanup.md](./_DONE_p053_scene-asset-lifecycle-cleanup.md).
Every visit to `thirdPersonGymScene` leaves one more geometry and one more texture on the GPU
(`renderer.info.memory`), and they never come back down. Cycling
`thirdPersonGymScene` → `oneMoreScene` with `loadScene({ sceneId })`, after p053:

| Visit | Gym (geometries / textures) | One More Scene (geometries / textures) |
| --- | --- | --- |
| 1 | 34 / 16 | 7 / 5 |
| 2 | 35 / 17 | 8 / 6 |
| 3 | 36 / 18 | 9 / 7 |
| 4 | 37 / 19 | 10 / 8 |

Without `?isDebug=true` the numbers are lower but the growth is the same (30 / 15 → 33 / 18).

## What is already ruled out

- **Registered assets.** After leaving the Gym, the geometry, texture and material registries
  are empty, so the leaked objects were never registered (or were deleted from the registry
  without being disposed).
- **Sky boxes and PMREM.** `sceneTestECS` ↔ `oneMoreScene` and `scene01V2` ↔ `oneMoreScene` stay
  flat over the same cycles, although their sky box texture is released, reloaded and baked
  again every time.
- **p053 itself.** The same growth is there at commit `6b5ad2b`, before p053.
- **Debug tooling.** It grows without `?isDebug=true` too.
- **The sun's shadow map (probably).** `scene01V2` also has a shadow-casting directional sun
  referenced by id (`scene01Sun`) and stays flat. Differing shadow settings in
  `thirdPersonGymSun.light.json` could still matter.
- **Physics entities.** Every visit has the same counts (49 entities: 16 static and 13 dynamic
  visual bodies).

## Hypotheses

Things only the Gym sets up (`src/app/scene_thirdPersonGym.ts`):

1. The two dynamic characters (`createDynamicCharacter`, `utils/character/dynamicCharacter.ts`).
2. The follow camera rig (`createFollowObjectCameraRig`, `utils/cameras/followObjectCameraRig.ts`).
3. The six moving platforms (`createMovingPlatform`, `utils/world/movingPlatform.ts`).
4. The test obstacles (`characterTestObstacles`, `getTestObstacle`).
5. `addCheckerboardMaterialToMesh`, which adds a `uvRepeatFactor` instanced attribute to the
   spawned imports' geometries.
6. Anything the Gym adds that outlives the scene: its `registerOnSceneExit` hooks, ECS systems
   added with `addSystem`, or objects added to the root scene outside ECS.

One geometry and one texture growing together hints at a single object that owns both, eg. a
mesh with its own texture (a sprite, label or canvas texture), or a render target with a
full-screen quad.

## Method

### 1. Reproduce with a script

A Playwright script driven by `.claude/skills/run-aekasha-js` (the driver's launch code) that:

- opens `http://localhost:8080/?isDebug=true` and waits for the first scene,
- in the page, imports the modules at the exact URLs the app loaded them from (after HMR Vite
  serves them with a `?t=` query, so a plain `import('/_engine/core/SceneLoader.ts')` gets a
  second module instance):

  ```js
  const url = (n) => performance.getEntriesByType('resource').map((e) => e.name)
    .find((x) => new URL(x).pathname === n) || n;
  const L = await import(url('/_engine/core/SceneLoader.ts'));
  ```

- calls `loadScene`, waits while `isCurrentlyLoading()`, then 1.5 s, and reads
  `getRenderer().info.memory`,
- repeats `thirdPersonGymScene` → `oneMoreScene` 4 times.

### 2. Find the objects

Take heap snapshots through the Chrome DevTools Protocol (`HeapProfiler.takeHeapSnapshot`)
in One More Scene after visits 2 and 4, and compare how many `BufferGeometry`/`Texture`
(and subclass) objects are retained, and by what. The retainer path names the owner directly,
which may make step 3 unnecessary.

### 3. Bisect, if the snapshots don't say

Skip the Gym's sections one at a time behind a temporary flag (the hypotheses above, in
that order) and rerun the cycle script until it's flat. Revert the flags afterwards.

### 4. Fix at the owner

Dispose the objects where they're created: on entity delete (component hooks), on scene exit, or
by giving them to the registries so the p053 sweep releases them. Don't add a general "dispose
everything" pass to scene switching.

## Verification

- The cycle script is flat over 4+ Gym ↔ One More Scene cycles, with and without
  `?isDebug=true`.
- The Gym behaves as before: the characters, camera rig, platforms, obstacles and checker
  materials all work, and the console shows no new errors.
- `yarn lint` and `yarn build` stay clean.

## Implementation notes

### Root cause

Hypothesis 4 (the test obstacles). Two assets were passed to `createMeshEntity` without being
registered, and a mesh's ref count only releases registered assets (`disposeMesh` releases by
`userData.id`). Nothing ever disposed them:

- **Geometry**: `characterTestObstacles()` merged the stairs with `mergeGeometries`, which
  returns a new geometry without an id.
- **Texture**: the Gym made the slide obstacle's material with `bigBoxWallMesh.material.clone()`
  and gave it its own `uvTexture.clone()` map. The clone carries `bigBoxWallUvMat`'s id, so the
  slide mesh only moved that material's ref count, and releasing `bigBoxWallUvMat` disposed its
  own textures, never the clone's. The ground, stairs and big box wall clones of `uvTexture` sit
  on registered materials and were always disposed.

The JS heap grew much more than the GPU counts: about 9 box geometries, 17 buffer geometries, 7
textures, a depth texture and ~3.5 MB per visit. That was a side effect of the geometry. Three's
WebGPU renderer keeps a strong `Map` (`renderer._geometries._geometryDisposeListeners`) from
every uploaded geometry to its dispose callback, and removes an entry only when the geometry is
disposed. The stairs geometry's callback held its `RenderObject`, and through it the Gym camera
(and its render list), the mesh's parent groups, and the cached node state holding the old sun
and its shadow map. So the sun's shadow map did show up in the heap growth, but only as a
passenger.

### Fix

- `characterTestObjects.ts`: the merged stairs geometry is registered with
  `saveBufferGeometry(..., { id: 'stairsGeo' })`.
- `scene_thirdPersonGym.ts`: the slide material is `createMaterial({ id: 'slideAnglesMat', ... })`
  with the `uvTexture` clone as its map (same look: phong `#999`, repeat 34), like the ground's.
- `MeshManager.ts`: `warnIfUnregistered` (debug only, `IS_DEBUG_ENV`) warns when
  `createMeshEntity` or `setMeshMaterial` gets a geometry or material that isn't the registered
  object under its id: no id, or a copy carrying another asset's id. On the unfixed Gym it names
  exactly the two leaks above.

Cycle script after the fix (5 cycles):

| Mode | Gym (geometries / textures) | One More Scene (geometries / textures) |
| --- | --- | --- |
| `?isDebug=true` | 34 / 16 every visit | 6 / 4 every visit |
| no query | 30 / 15 every visit | 2 / 3 every visit |

The heap diff between visits 2 and 4 is flat too, except for a debug camera helper (see the
follow-ups).

### Method gotchas

- `page.waitForFunction` with an async predicate returns at once: it treats the returned
  Promise as truthy. Poll inside `page.evaluate` instead.
- The `url()` helper's `|| n` fallback imports the bare path, which is a second module instance,
  if it runs before the app has loaded that module. Only import once the resource entry exists.
- Heap snapshots taken over CDP include `(Global handles) → DevTools console` roots: whatever
  the page logged is kept alive by the attached session. Skip edges with that name (it's in the
  edge name, not the node name).
- A shortest retainer path found with a plain BFS can go through a WeakMap value (eg.
  `DirectionalLightNode → .light`) even when only its own key keeps it alive. Skip the
  `part of key ... -> value` edges to find real retainers, and strip `@ids` and numeric indices
  from labels to compare paths between snapshots.
- The retained geometries can be listed live from
  `renderer._geometries._geometryDisposeListeners`. Textures have no such map: add a `dispose`
  listener to every texture reachable from the scene, then check `renderer._textures.has(t)`
  after leaving.

### Follow-ups, not part of this plan

- Debug only: the `CameraHelper` left in the root scene per Gym visit is the sun's shadow camera
  helper, which the light helpers' delete hook never removes:
  [p055_debug-camera-helper-leak.md](./p055_debug-camera-helper-leak.md).
- The new warning finds the same leak in `largeWorld`: `largeWorldTerrain` (the generated terrain
  geometry), `largeWorldDynamicCrateStack` and `largeWorldDynamicBarbell` (`mergeGeometries`
  results) use unregistered geometries. One More Scene has 5 more geometries after a `largeWorld`
  visit.
- On a revisit of `sceneTestECS` it warns about `testMesh` and `testImportedMesh`.
  `createNextSceneObject3Ds` (`SceneLoader.ts`) writes the resolved geometry and material objects
  over the string ids in the cached scene data (`props.props.geo = geo`), so the next visit reuses
  the previous visit's objects, which are disposed and no longer registered, instead of looking
  the ids up again.
