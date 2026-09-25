Status: draft | not-implemented
Category: Bug fix

# Three Bind Group Cache Light Leak — Plan

## Context

Found while verifying [\_DONE_p055_debug-camera-helper-leak.md](./_DONE_p055_debug-camera-helper-leak.md).
Each `thirdPersonGymScene` visit leaves ~16 `_BufferGeometry` objects in the JS heap for good,
in every mode:

| Mode | `_BufferGeometry` in One More Scene after Gym visit 1 / 2 / 4 |
| --- | --- |
| `?isDebug=true` | 55 / 71 / 103 |
| no query | 49 / 65 / 97 |

The GPU side is fine: p054's cycle script shows `renderer.info.memory` flat, so these are
disposed geometries whose JS objects can't be collected. The same chain also keeps each visit's
sun, its shadow camera and that camera's render list alive. So the growth is more than the
geometries, and it grows with every scene that has a shadow-casting light.

## Root cause (verified in heap snapshots, Three 0.183.2)

Retainer path of the geometries left from an earlier Gym visit, with WeakMap edges followed only
when both key and table are alive:

```
NodeBuilder.js module scope: _bindingGroupsCache (WeakMap)
  -> [key: the shadow RenderContext] Map<hash, BindGroup>
  -> BindGroup -> NodeUniformsGroup -> Vector3NodeUniform -> UniformNode
  -> .update (bound onRenderUpdate callback) -> closure `light`
  -> DirectionalLight (old Gym sun) -> .shadow -> .camera (OrthographicCamera)
  -> [key: that camera] RenderList (renderer's render lists, keyed by the root scene)
  -> renderItems[i].geometry
```

- `_bindingGroupsCache` (`three/src/nodes/core/NodeBuilder.js`) is a module-level
  `WeakMap<RenderContext, Map<hash, BindGroup>>`. The hash is built from the node uniform ids of
  a shared uniform group, and entries are never removed.
- The key doesn't die: `RenderContexts.get()` (`renderers/common/RenderContexts.js`) caches one
  `RenderContext` per attachment state (format, type, samples...). Every shadow map with the same
  format shares it, for the renderer's lifetime.
- The uniform is one of the per-light `renderGroup` uniforms in `nodes/accessors/Lights.js`
  (`lightPosition`, `lightTargetPosition` or `lightViewPosition`: `Vector3` uniforms whose
  `onRenderUpdate` closure holds `light`). A new light has new uniform ids, so the hash is new
  and a new `BindGroup` is added next to the old ones.
- The latest visit's sun is also held by `renderer._renderContexts._renderContexts[<shadow key>]
  .camera` (the last camera rendered with that context). That one is overwritten on the next
  shadow render, so it's bounded to one camera.

## Fix options (to decide)

1. **Upstream first.** Check whether a newer Three release evicts `_bindingGroupsCache` entries
   (or keys it differently). If it does, this becomes a Three upgrade. If not, open an issue with
   the path above.
2. **Reset the render contexts on scene leave.** `renderer._renderContexts.dispose()` drops the
   cached `RenderContext`s, so their `_bindingGroupsCache` entries (and the `.camera` reference)
   can be collected. It's a private field, and other caches are keyed by `RenderContext`
   (render objects, bindings), so the first frames of the next scene rebuild them. Measure that
   cost, and check that pipelines/shaders are not recompiled. It would live next to p053's scene
   leave sweep in `SceneLoader.ts`, not in `_engine` code that runs every frame.
3. **Reuse light objects across scenes**, so no new uniform ids appear. Doesn't fit how scenes
   create their lights. Only worth it if 1 and 2 fail.

`_bindingGroupsCache` isn't exported, so evicting its entries directly isn't an option.

## Method

- Cycle script and heap snapshots as in p054/p055: `loadScene` Gym ↔ One More Scene, CDP
  `HeapProfiler.takeHeapSnapshot` in One More Scene after visits 1, 2 and 4. Count
  `_BufferGeometry`, and diff node ids against the first snapshot to trace retainers of the
  geometries left from earlier visits (see p055's Method gotchas for WeakMap edges).
- Test option 2 behind a temporary flag before deciding.

## Verification

- `_BufferGeometry` in One More Scene stays flat over 4+ Gym ↔ One More Scene cycles, with and
  without `?isDebug=true`, and no old `DirectionalLight` or its shadow camera is retained.
- The Gym renders the same (shadows included), with no new WebGPU warnings, and the first frame
  after a scene switch costs no more than before (no shader recompiles).
- `yarn lint` and `yarn build` stay clean.
