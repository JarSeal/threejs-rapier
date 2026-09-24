Status: draft | not-implemented
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
