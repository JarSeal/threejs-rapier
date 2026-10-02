**Title:** WebGPURenderer (three r186): a removed `InstancedMesh` keeps its instance attributes on the GPU, so every visit to a scene with instanced meshes adds ~3.7 MB

Status: open | fixed upstream on `dev` (three r187 milestone), not in a release yet
Category: Bug, Rendering, Memory
Found: 2026-10-03, while building the GPU memory tab (p345 Phase 2), three 0.186.1, Chrome, macOS, WebGPU backend

## Summary

Each visit to `largeWorld` leaves the previous visit's instance attributes (the tree and bush
`InstancedMesh`es' `instanceMatrix`) allocated in the renderer. `renderer.info.memory.attributesSize`
grows by about 3.66 MB per visit and never comes back down. This happens in every build, with or without
`?isDebug=true`.

This is a Three.js bug, not an Aekasha one. The engine releases everything correctly: the meshes are
removed, their registered geometries are disposed, and the number of live geometries is the same on every
visit. It is fixed on three's `dev` branch and is expected to ship in r187 (see Upstream fix).

Note: this is not the `_bindingGroupsCache` light leak (`three-bind-group-cache-light-leak.md`,
p056). That one keeps old lights alive in the JS heap only and leaves `renderer.info.memory` flat.

## Reproduce

### With the GPU memory tab (debug mode)

1. `yarn dev`, open `http://localhost:8080/?isDebug=true`.
2. Open the debug drawer (`h`) on the **GPU memory** tab.
3. Press `p` and pick **Large ECS test world**. Note the Totals table's **Attributes** row and, under
   **By owner**, the **Untracked → Attributes + index** row.
4. Press `p` → **Sky showcase (day-night)**, then `p` → **Large ECS test world** again.

Expected: the same figures as in step 3. Actual: Attributes goes from about 4.0 MB (76) to 7.7 MB (112),
and grows by the same amount on every further round trip. The `largeWorld` row under **By owner** stays the
same, so all of the growth is untracked.

### From the console (any mode)

Paste this into the console after the first scene has loaded. It imports the engine modules from the
URLs the app loaded them from (a bare `import('/_engine/...')` would create a second module instance),
then does four `largeWorld` ↔ `skyShowcase` round trips:

```js
const url = (n) =>
  performance.getEntriesByType('resource').map((e) => e.name).find((x) => new URL(x).pathname === n);
const { getRenderer } = await import(url('/_engine/core/Renderer.ts'));
const { loadScene, isCurrentlyLoading } = await import(url('/_engine/core/SceneLoader.ts'));
const visit = async (sceneId) => {
  await loadScene({ sceneId });
  while (isCurrentlyLoading()) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 3000));
  const m = getRenderer().info.memory;
  console.log(sceneId, {
    attributes: m.attributes,
    attributesMB: ((m.attributesSize + m.indexAttributesSize) / 2 ** 20).toFixed(2),
    geometries: m.geometries,
  });
};
for (const id of ['largeWorld', 'skyShowcase', 'largeWorld', 'skyShowcase', 'largeWorld', 'skyShowcase', 'largeWorld'])
  await visit(id);
```

Measured without `?isDebug=true`:

| `largeWorld` visit | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| Attributes (count) | 64 | 100 | 136 | 172 |
| Attributes + index | 4.63 MB | 8.47 MB | 12.31 MB | 16.15 MB |
| Geometries (count) | 17 | 17 | 17 | 17 |

The geometry count stays the same, which rules out the engine's geometry release. To see what stays
alive, list the `InstancedMesh`es in the root scene (`getRootScene()` in `core/Scene.ts`) and compare
their `instanceMatrix.array` with the arrays of the live interleaved attributes. The extra attributes are
`InterleavedBufferAttribute`s with `itemSize` 4 over `Float32Array`s of 24,000 and 32,000 floats: the
previous visit's tree (1,500 instances) and bush (2,000 instances) meshes, which are no longer in the scene.

## Root cause

three's `InstanceNode` (`nodes/accessors/Instance.js`) reads an `InstancedMesh`'s `instanceMatrix` through
four vec4 interleaved attributes. They are node attributes: they aren't in `geometry.attributes`, and each
render object of the mesh (one per render pass: main, shadow and so on) gets its own four.

In r186, `Geometries.initGeometry` (`renderers/common/Geometries.js`) frees node attributes in the
geometry's dispose listener. But the listener is created once per geometry and closes over the *first*
render object that used that geometry. When the geometry is disposed, it deletes only that render
object's node attributes. The attributes of every other render object of the mesh stay allocated and stay
counted in `renderer.info.memory`.

A related r186 counting issue makes the numbers look larger than the real GPU cost. `Info` counts every
`InterleavedBufferAttribute` at the full size of its shared buffer, so the four attributes of each render
pass are each counted as the whole matrix buffer. The 44 instance attributes alive in one `largeWorld`
visit report about 4.5 MB for two buffers of about 220 KB in total. The leak is real either way: the
leaked attribute objects keep their buffers alive.

## Upstream fix

- [mrdoob/three.js#34603](https://github.com/mrdoob/three.js/pull/34603) "WebGPURenderer: Refactor node
  attribute disposal" (merged to `dev` 2026-09-18, milestone r187). It adds `deleteNodeAttributes()`, and
  each render object now deletes its own node attributes when its geometry is disposed. This is the fix.
- [mrdoob/three.js#34690](https://github.com/mrdoob/three.js/pull/34690) "WebGPURenderer: Unify handling of
  interleaved attributes" (merged to `dev` 2026-09-28, milestone r187). Interleaved attributes are tracked
  by their `InterleavedBuffer`, so a shared buffer is held and counted once.

Checked in the app by emulating #34603 in the page. A patched `RenderObjects.createRenderObject` adds a
geometry dispose listener per render object that deletes its node attributes. With that patch the same
round trips stay flat: 64 → 76 → 76 → 76 attributes and 4.63 → 5.91 → 5.91 → 5.91 MB. The one-time step
after the first visit is not a leak: from then on, every live instance attribute belongs to a mesh in the
current scene.

## What to do

- No engine change. A workaround would need three's private `renderer._attributes`, and the leak is
  about 3.7 MB per `largeWorld` visit, so waiting for the release is acceptable.
- When three r187 is released: upgrade, run the console round trip above, and check that the attribute
  count and size are the same on every `largeWorld` visit from the second one on. Then close this issue.
- Until then, the GPU memory tab's **Untracked → Attributes + index** row includes the leaked buffers.
  Its instanced-mesh figures are also overstated by the r186 counting issue above.

## Not part of this issue

The same investigation found two smaller leaks in Aekasha's own code:

- Debug mode only: the light and camera debug symbols (`debug/3DSymbols.ts`) get cloned materials. The
  `DEBUG_SYMBOL` delete hook (`core/Debug/_dbg__Symbols.ts`) only removes them from the scene, and the
  cloned materials are never disposed. So their render objects stay alive in three, with about 56 uniform
  buffers per round trip.
- Every mode: about one uniform buffer pair (~0.4 KB) per scene visit, with one more `Background.mesh`
  render object per visit. Not traced yet.
