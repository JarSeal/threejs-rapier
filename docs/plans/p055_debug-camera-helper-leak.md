Status: draft | not-implemented
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
- In a heap diff over 4+ Gym ↔ One More Scene cycles, `CameraHelper` and `_BufferGeometry` stay
  flat (p054's snapshot scripts showed +1 and ~+16 per Gym visit).
- Light helpers and shadow camera helpers still show, hide and follow their lights in the debug
  drawer, and the console shows no new errors.
- `yarn lint` and `yarn build` stay clean.
