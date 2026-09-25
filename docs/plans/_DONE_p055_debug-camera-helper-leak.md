Status: implemented
Category: Bug fix

# Debug Camera Helper Leak — Plan

## Context

Found while verifying [\_DONE_p054_gym-scene-gpu-memory-growth.md](./_DONE_p054_gym-scene-gpu-memory-growth.md).
In debug mode (`?isDebug=true`), `CameraHelper`s pile up as children of the root scene and are
never removed. Each one keeps its camera alive, and with it that camera's render list (Three's
`RenderList`, cached per scene and camera), which still points at the meshes, geometries and
materials of the scene it was last rendered in. So a left scene's objects stay in the JS heap
after their GPU memory has been freed. `renderer.info.memory` stays flat because the helpers are
hidden and never uploaded, so this is JS memory only, and debug only.

A probe listing the root scene's `CameraHelper`s, and whether the ECS still holds each one
(`DEBUG_CAMERA_HELPER`), shows only orphans piling up:

| After | Orphaned helpers (not held by the ECS) |
| --- | --- |
| Boot (`sceneTestECS`) | 3 |
| Each `thirdPersonGymScene` visit | +1 |
| Each `oneMoreScene` visit | +0 |

The helpers the ECS holds (one per scene camera) are removed correctly on leave.

## Root cause (verified in source)

The orphans are not the scene cameras' helpers (`Debug/Camera/_dbg__CameraHelpers.ts`), but the
light helpers' shadow camera helpers. `attachLightHelpers` (`Debug/Light/_dbg__LightHelpers.ts`)
gives every directional, point and spot light a light helper and a
`CameraHelper(light.shadow.camera)`, and stores both on the entity as
`DEBUG_LIGHT_HELPER: { value: helper, camHelper }`. The `onDeleteEntity` hook removes and
disposes `helper.value` only; `camHelper` stays in the root scene.

That matches the probe: `sceneTestECS` has 3 such lights, the Gym has one (its sun), and One More
Scene has none. The `castShadow` check in `attachLightHelpers` is `'castShadow' in light`, which
is true for all three light types, so every one of them gets a `camHelper`, shadows or not.

## Fix

In the `DEBUG_LIGHT_HELPER` `onDeleteEntity` hook, also `removeFromParent()` and `dispose()` the
`camHelper` when there is one.

Also check the other places that replace or drop a `DEBUG_LIGHT_HELPER` (eg. a light type change
or a helper rebuild in the light debug GUI, if any) so that they release `camHelper` too. No new
component or hook should be needed.

The debug drawer is being rewritten, so keep the change small and inside the `_dbg__` file.

## Verification

- A probe like p054's (`loadScene` cycles `sceneTestECS`/`thirdPersonGymScene` ↔ `oneMoreScene`,
  listing `getRootScene().children` of type `CameraHelper`) shows no orphans after leaving a
  scene. The helpers of the current scene's lights and cameras are still there.
- In a heap diff over 4+ Gym ↔ One More Scene cycles, `CameraHelper` stays flat (p054's snapshot
  scripts showed +1 per Gym visit). `_BufferGeometry` drops from +17 to +16 per Gym visit: the
  helper held only one geometry. The other +16 were not this leak (see Implementation notes).
- Light helpers and shadow camera helpers still show, hide and follow their lights in the debug
  drawer, and the console shows no new errors.
- `yarn lint` and `yarn build` stay clean.

## Implementation notes

### Root cause

As described above. The source also had a second place that dropped a `DEBUG_LIGHT_HELPER`:
`refreshLightShadows` (`_dbg__LightGUI.ts`, runs on a shadow map width/height change) replaces
the light and its helpers. It took the old helper and `camHelper` out of the scene but never
disposed them, and `addComponent` overwrites the component without firing a hook. That left no
orphans in the root scene, only two undisposed helpers per change.

The second `registerComponentHooks(DEBUG_LIGHT_HELPER, ...)` in `_dbg__LightGUI.ts` only adds an
`onAddComponent` hook. Hooks are appended, not replaced, so it doesn't interfere.

### Fix

- `_dbg__LightHelpers.ts`: new `disposeLightHelpers(helperComp)` removes and disposes both
  `value` and `camHelper`. The `onDeleteEntity` hook uses it. All four helper types declare
  `dispose()`, so the `as any` check is gone.
- `_dbg__LightGUI.ts`: `refreshLightShadows` calls `disposeLightHelpers` on the old helpers after
  its existing `await import('./_dbg__LightHelpers')`. The light swap before that `await` stays
  synchronous. Moving the `await` above the swap left the old light, with its changed shadow
  map size, in the scene for one more frame, and WebGPU then warned
  `Destroyed texture [... RG16Float] used in a submit` on every map size change.

### Results

Unfixed `HEAD` against the fix, `?isDebug=true`, Gym ↔ One More Scene cycles:

| | Unfixed | Fixed |
| --- | --- | --- |
| Orphaned helpers at boot (`sceneTestECS`) | 3 | 0 |
| Orphaned helpers per Gym visit | +1 | 0 |
| `CameraHelper` in heap snapshots, in One More Scene | +1 per Gym visit | 1, flat |
| Old helpers after a shadow map size change | out of the scene, not disposed | disposed |
| `_BufferGeometry` in heap snapshots | +17 per Gym visit | +16 per Gym visit |

The Gym sun's light helper and shadow camera helper show and hide with the global toggle and
follow the light when it moves. After a map size change the new `camHelper` tracks the new light's
shadow camera. The only console output left, a 404 and a "deprecated parameters" warning, is
the same on the unfixed build.

### The remaining +16 geometries per Gym visit

They are not from the helper and not debug only: without `?isDebug=true` the count grows the
same (49 → 65 → 97 over 4 visits). Each Gym visit's sun stays alive through Three's bind group
cache, and its shadow camera's render list keeps the shadow casters. Follow-up:
[p056_three-bind-group-cache-light-leak.md](./p056_three-bind-group-cache-light-leak.md).

### Method gotchas

- p054's advice to skip `part of key ... -> value` edges hides objects held only by a WeakMap. Here
  15 of the 17 new geometries had no retainer path at all with those edges skipped. Follow such an
  edge only once both the key and the WeakMap's table are reached (the edge name holds
  `part of key (X @keyId)` and `(table @tableId)`), and re-check a parked edge only when its missing
  dependency is reached. Re-scanning the source node's edges makes the pass quadratic.
- `npx vite serve` without `VITE_APP_ENV=development` ignores `?isDebug=true` (use the `yarn dev`
  env). A second dev server run from a git worktree with a symlinked `node_modules` shares and
  rewrites `node_modules/.vite`, the running dev server's dependency cache.
