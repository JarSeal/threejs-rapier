**Title:** WebGPURenderer: `_bindingGroupsCache` keeps every disposed light alive (and, with shadows, its shadow camera)

### Description

`NodeBuilder`'s module-level `_bindingGroupsCache` (`WeakMap<RenderContext, Map<hash, BindGroup>>`) never removes
entries. Its keys are the `RenderContext`s cached by `RenderContexts.get()`, one per attachment state, which live as
long as the renderer. The cached shared `BindGroup`s hold the per-light `renderGroup` uniforms from
`nodes/accessors/Lights.js` (`lightPosition()` / `lightTargetPosition()` / `lightViewPosition()`), and their
`onRenderUpdate` callbacks close over `light`.

So a removed and disposed light is never collected. A new light has new uniform node ids, so it gets a new hash and a
new `BindGroup` next to the old ones. The cache grows with every light ever rendered.

With `castShadow`, the retained light also keeps `light.shadow.camera` alive, and with it the shadow camera's
`RenderList`. On r183 that list's render items keep the disposed geometries alive as well. We found this in an app
that switches scenes, each creating its own shadow-casting sun: the JS heap grows by one sun plus its shadow data
per scene visit (the GPU side is freed correctly, `renderer.info.memory` stays flat).

This is probably what #33912 saw (`DirectionalLightShadow -> shadow.camera -> RenderList -> geometry`). That issue was
closed without a repro. The part it was missing is what holds the light:

```
NodeBuilder.js module scope: _bindingGroupsCache (WeakMap)
  -> [key: the shadow map RenderContext "1:1023:1016:0:true:false-default-0"] Map<hash, BindGroup>
  -> BindGroup -> NodeUniformsGroup -> Vector3NodeUniform -> UniformNode
  -> .update (bound onRenderUpdate callback) -> closure `light`
  -> DirectionalLight -> .shadow -> .camera (OrthographicCamera)
  -> [key: that camera] RenderList -> renderItems[i].geometry   (r183; not seen on r186)
```

(Heap snapshot of the page below on r186.1, following WeakMap edges only when both the key and the table are
reachable.)

With `renderer.shadowMap.enabled = false` (lights still `castShadow`) the lights are retained through the same
entry.

### Reproduction steps

1. Open the page below in Chrome started with `--js-flags=--expose-gc` (or press "Collect garbage" in DevTools >
   Memory, then "Check").
2. It adds a shadow-casting `DirectionalLight` and two meshes, renders 3 frames, removes and disposes all of it, and
   repeats 10 times. It then renders one more light that is kept, so `RenderContext.camera` doesn't
   point at a disposed one.
3. A `FinalizationRegistry` counts how many of the disposed lights and geometries were collected.

Results (Chrome 153, Apple M2, macOS 26.5), 10 visits:

| three | page params | disposed lights collected | disposed geometries collected |
| --- | --- | --- | --- |
| r186.1 | shadows | 0 / 10 | 9 / 10 |
| r186.1 | `shadow=0` (`renderer.shadowMap.enabled = false`) | 0 / 10 | 9 / 10 |
| r186.1 | `reset=1` (calls `renderer._renderContexts.dispose()` after each removal) | 9 / 10 | 9 / 10 |
| r183.2 | shadows | 0 / 10 | 0 / 10 |

The one object left over in each row is the most recent one, held through `renderer._renderLists._activeLists`,
which is bounded.

The `reset=1` row shows that dropping the cached render contexts (and with them their `_bindingGroupsCache` entries)
releases the lights. It doesn't work as an app-side workaround though: in an app where some meshes stay in the scene,
their render objects in `renderer._objects._renderObjects` keep the old `RenderContext`s alive (`RenderObject.context`),
so the lights stay, and the node builder cache and pipelines grow with every reset.

(r183.2 with `reset=1` still retains everything, through `textureData.bindGroups` of the shared DFG LUT texture. That
path was fixed in r186 by untracking destroyed bind groups in `Bindings`.)

### Code

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>WebGPURenderer: disposed lights retained by _bindingGroupsCache</title>
    <style>
      body { font: 13px/1.4 monospace; margin: 12px; }
      pre { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <p>
      Adds a shadow-casting DirectionalLight and two meshes, renders a few frames, then removes and
      disposes all of it. Repeats <code>visits</code> times, then waits for GC and counts how many
      of the disposed lights and geometries were collected.<br />
      Query params: <code>v</code> (three version, default 0.186.1), <code>visits</code> (default 10),
      <code>shadow=0</code> (<code>renderer.shadowMap.enabled = false</code>), <code>reset=1</code> (call
      <code>renderer._renderContexts.dispose()</code> after each removal).<br />
      Run Chrome with <code>--js-flags=--expose-gc</code>, or click "Collect garbage" in DevTools &gt;
      Memory when asked and then press "Check".
    </p>
    <button id="check" disabled>Check</button>
    <pre id="out"></pre>
    <script type="module">
      const params = new URLSearchParams(location.search);
      const version = params.get('v') || '0.186.1';
      const visits = Number(params.get('visits') || 10);
      const shadows = params.get('shadow') !== '0';
      const resetContexts = params.get('reset') === '1';

      const out = document.getElementById('out');
      const log = (msg) => (out.textContent += msg + '\n');

      const THREE = await import(`https://cdn.jsdelivr.net/npm/three@${version}/build/three.webgpu.js`);
      log(`three ${THREE.REVISION}, visits=${visits}, shadows=${shadows}, reset=${resetContexts}`);

      const renderer = new THREE.WebGPURenderer();
      renderer.setSize(256, 256);
      renderer.shadowMap.enabled = shadows;
      document.body.append(renderer.domElement);
      await renderer.init();

      // Long-lived, like an app's root scene and main camera
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      camera.position.set(4, 4, 6);
      camera.lookAt(0, 0, 0);

      const collected = new Set();
      const registry = new FinalizationRegistry((label) => collected.add(label));

      const frames = async (n) => {
        for (let i = 0; i < n; i++) {
          renderer.render(scene, camera);
          await new Promise((r) => requestAnimationFrame(r));
        }
      };

      const addVisit = () => {
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.position.set(3, 6, 2);
        sun.castShadow = true;
        const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
        box.castShadow = true;
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial());
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.5;
        ground.receiveShadow = true;
        scene.add(sun, box, ground);
        return { sun, meshes: [box, ground] };
      };

      const removeVisit = ({ sun, meshes }) => {
        scene.remove(sun, ...meshes);
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          mesh.material.dispose();
        }
        sun.dispose();
      };

      for (let i = 0; i < visits; i++) {
        const visit = addVisit();
        await frames(3);
        removeVisit(visit);
        registry.register(visit.sun, `light ${i}`);
        // Makes the disposed lights easy to find in a heap snapshot
        visit.sun.userData.marker = new (class DisposedLightMarker {})();
        registry.register(visit.meshes[0].geometry, `geometry ${i}`);
        if (resetContexts) renderer._renderContexts.dispose();
        await frames(3);
      }

      // The last shadow render context keeps a reference to the last shadow camera it rendered
      // (RenderContext.camera). Render one more light, never disposed, so that reference doesn't
      // point at a disposed one.
      addVisit();
      await frames(3);

      const check = async () => {
        if (typeof gc === 'function') {
          for (let i = 0; i < 3; i++) {
            gc();
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        const lights = [...collected].filter((l) => l.startsWith('light')).length;
        const geometries = [...collected].filter((l) => l.startsWith('geometry')).length;
        const result = { version: THREE.REVISION, shadows, resetContexts, visits, lights, geometries };
        log(`collected: ${lights}/${visits} disposed lights, ${geometries}/${visits} disposed geometries`);
        window.__result = result;
      };

      const button = document.getElementById('check');
      button.disabled = false;
      button.onclick = check;
      if (typeof gc === 'function') await check();
      else log('Collect garbage in DevTools > Memory, then press "Check".');
    </script>
  </body>
</html>
```

### Live example

Save the code above as an `.html` file and serve it from `localhost` or https (WebGPU needs a secure context), eg.
`npx serve`. Three is loaded from jsDelivr, so `?v=0.183.2` or any other version can be compared on the same page.

### Possible fix directions

- Evict a cached shared `BindGroup` when the last render object using it is deleted (`Bindings` already reference
  counts bind groups with `usedTimes`).
- Or key the cache so that it doesn't outlive the uniforms it holds, eg. drop the entry when the light (or the
  uniform node) is disposed.

The `// TODO: Remove this hack ._currentRenderContext` comment next to the cache suggests the keying is already
known to be temporary.

### Version

r186.1 (also r183.2, and the cache code is unchanged on `dev`)

### Device

Desktop

### Browser

Chrome

### OS

MacOS
