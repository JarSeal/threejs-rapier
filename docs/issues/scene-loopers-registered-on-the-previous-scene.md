**Title:** A scene looper created by scene code without a scene id lands on the previous scene, or nowhere

Status: fixed | 2026-10-09, p601 Phase 2
Category: Bug, Scenes
Found: 2026-10-09, the scene runner's first run over every scene (p601 Phase 2 step 4): `scene01` warned "Could not find scene with id null in createSceneMainLoopers."

## What happens

`createSceneMainLooper`, `createSceneAppLooper`, `createSceneResizer` and the matching get and
delete functions in `src/_engine/core/Scene.ts` take an optional scene id that defaulted to
`currentSceneId`. Scene code runs inside `loadScene` before the scene is current:
`setCurrentScene(sceneId)` runs only after the scene function resolves
(`src/_engine/core/SceneLoader.ts`). So a scene file that calls `createSceneMainLooper(fn)`
without an id, as `scene01.ts` does:

- **On the first load** (eg. `?startScene=scene01`): `currentSceneId` is null, the looper is
  dropped with the warning above, and the scene's sphere never turns.
- **After a switch from scene A** (read from the code, not reproduced): the looper is filed under
  A, which has already exited. It runs anyway, because every create and delete overwrote the
  running lists (`curSceneMainLoopers` and the others) with the list it touched, whatever its
  scene. A's list then still holds it, and the next visit to A appends A's own loopers to it, so
  it runs again in A, turning a sphere the scene switch disposed.

`setCurrentScene` never pointed the running lists at the new scene's loopers either: loopers ran
only because the create calls during the load happened to overwrite them.

## Fix

- `Scene.ts` knows the loading scene (`setLoadingSceneId`, set by `loadScene` right before the
  scene code runs, after the previous scene's exit hooks, and cleared once it's current or the
  load fails). An omitted scene id means the loading scene while its code runs, else the current
  one (`resolveSceneId`), the rule `registerSkyBox` already follows.
- The running lists follow the current scene only: `setCurrentScene` refreshes them, and a create
  or delete refreshes them only when it touched the current scene's list. A scene's loopers start
  running once it's current, no longer during its load.

## Also seen (not fixed here)

- Scene resizers are never deleted on a scene exit (`deleteAllSceneLoopers` leaves them), so a
  revisit adds them again.
- `deleteSceneResizer` with an array of indexes filters with `i !== index[i]` (the filter's own
  index against the array at that index), and deleting by `filter` shifts the indexes of the
  resizers after it.
