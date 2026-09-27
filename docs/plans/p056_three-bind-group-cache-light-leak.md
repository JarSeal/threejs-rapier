Status: draft | not-implemented
Category: Bug fix

# Three Bind Group Cache Light Leak — Plan

## Context

Found while verifying the (implemented, since-removed) p055 debug-camera-helper-leak fix.
Each `thirdPersonGymScene` visit leaves ~16 `_BufferGeometry` objects in the JS heap for good,
in every mode:

| Mode | `_BufferGeometry` in One More Scene after Gym visit 1 / 2 / 4 |
| --- | --- |
| `?isDebug=true` | 55 / 71 / 103 |
| no query | 49 / 65 / 97 |

The GPU side is fine: the cycle script (see Method) shows `renderer.info.memory` flat, so these are
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
   cost, and check that pipelines/shaders are not recompiled. It would live next to the scene-leave
   asset sweep in `SceneLoader.ts`, not in `_engine` code that runs every frame.
3. **Reuse light objects across scenes**, so no new uniform ids appear. Doesn't fit how scenes
   create their lights. Only worth it if 1 and 2 fail.

`_bindingGroupsCache` isn't exported, so evicting its entries directly isn't an option.

## Method

- Cycle script: a Playwright script driven by `.claude/skills/run-aekasha-js` opens
  `http://localhost:8080/?isDebug=true`, waits for the first scene, then in the page imports the
  engine modules at the exact URLs the app loaded them from (after HMR Vite serves them with a
  `?t=` query, so a plain `import('/_engine/core/SceneLoader.ts')` gets a second module instance):

  ```js
  const url = (n) => performance.getEntriesByType('resource').map((e) => e.name)
    .find((x) => new URL(x).pathname === n) || n;
  const L = await import(url('/_engine/core/SceneLoader.ts'));
  ```

  It calls `loadScene`, waits while `isCurrentlyLoading()`, then 1.5 s, reads
  `getRenderer().info.memory`, and repeats `thirdPersonGymScene` → `oneMoreScene`.
- Heap snapshots: CDP `HeapProfiler.takeHeapSnapshot` in One More Scene after visits 1, 2 and 4.
  Count `_BufferGeometry`, and diff node ids against the first snapshot to trace retainers of the
  geometries left from earlier visits.
- Test option 2 behind a temporary flag before deciding.

### Method gotchas (learned in the earlier Gym leak fixes)

- `page.waitForFunction` with an async predicate returns at once: it treats the returned
  Promise as truthy. Poll inside `page.evaluate` instead.
- The `url()` helper's `|| n` fallback imports the bare path, which is a second module instance,
  if it runs before the app has loaded that module. Only import once the resource entry exists.
- Heap snapshots taken over CDP include `(Global handles) → DevTools console` roots: whatever
  the page logged is kept alive by the attached session. Skip edges with that name (it's in the
  edge name, not the node name).
- WeakMap edges: a plain BFS shortest retainer path can go through a WeakMap value even when only
  its own key keeps it alive, but skipping all `part of key ... -> value` edges hides objects held
  only by a WeakMap. Follow such an edge only once both the key and the WeakMap's table are
  reached (the edge name holds `part of key (X @keyId)` and `(table @tableId)`), and re-check a
  parked edge only when its missing dependency is reached (re-scanning the source node's edges
  makes the pass quadratic). Strip `@ids` and numeric indices from labels to compare paths
  between snapshots.
- The retained geometries can be listed live from
  `renderer._geometries._geometryDisposeListeners`.
- `npx vite serve` without `VITE_APP_ENV=development` ignores `?isDebug=true` (use the `yarn dev`
  env). A second dev server run from a git worktree with a symlinked `node_modules` shares and
  rewrites `node_modules/.vite`, the running dev server's dependency cache.

## Verification

- `_BufferGeometry` in One More Scene stays flat over 4+ Gym ↔ One More Scene cycles, with and
  without `?isDebug=true`, and no old `DirectionalLight` or its shadow camera is retained.
- The Gym renders the same (shadows included), with no new WebGPU warnings, and the first frame
  after a scene switch costs no more than before (no shader recompiles).
- `yarn lint` and `yarn build` stay clean.
