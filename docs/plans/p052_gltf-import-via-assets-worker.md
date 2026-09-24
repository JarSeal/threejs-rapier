Status: draft | feasibility study — not-implemented
Category: Assets
Epic: https://trello.com/c/YCUX4DKL/219-model-import-refactoring
Blocked by: p051_import-asset-refactoring.md

# GLTF Import via an Assets Worker — Plan

## Context

After p051, a GLTF import is a pure "file → geometries (+ optional textures) + JSON metadata" step (`importAssetAsync` → `ImportedAssetManifest`). Fetching, DRACO decoding, glTF parsing and image decoding all run on the main thread today, and so does every standalone texture load (`Texture.ts`'s `TextureLoader`/`HDRLoader`). Large scene loads therefore stall the render thread.

This plan adds an **assets worker**. Following the Threaded Reality principle, it moves that work off the main thread behind the same public API, with the same config and boot-override conventions as the physics worker (`AppConfig.physics.workerTarget`). It covers:

1. GLTF import (geometries + optional textures) in the worker.
2. Standalone texture loading in the worker (previously Part 3 of p051, moved here so there is one worker and one protocol).

## Feasibility

**Verdict: feasible, and a clear win, but only after p051 lands.** The previous revision of p051 deferred worker-side GLTF because the importer produced a full `THREE` scene graph (meshes, materials, groups). Structured clone can't carry class prototypes, so that would have meant serializing the whole graph. With p051's assets-only scope, the worker only returns:

- geometry data as typed arrays (transferable),
- textures as `ImageBitmap` (transferable) plus sampler/colorSpace metadata,
- node transforms, names and raw glTF `extras` (plain JSON).

The main thread rebuilds `BufferGeometry` and `Texture`, which is cheap wrapping with no parsing, and then runs **p051's own** registration, `parseCustomProps` and manifest code. So main-thread and worker imports produce identical results by construction.

Verified in source (three 0.183.2, this repo's config):

| Check                         | Finding                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GLTFLoader` DOM usage        | None on the normal path. It uses `FileLoader` (fetch), `ImageBitmapLoader` (fetch + `createImageBitmap`, no `document`) and `self.URL` for blob URLs.                                                                                             |
| `GLTFLoader` texture fallback | On **Safari < 17 / Firefox < 98**, or without `createImageBitmap`, it switches to `TextureLoader` → `ImageLoader`, which needs `document`. The worker must detect this at handshake and the facade falls back to the main thread.                 |
| `DRACOLoader`                 | Starts its own nested workers from blob URLs, which current Chrome, Firefox and Safari support. The decoder path must be absolute (see gotchas). Note: DRACO is broken today (bad decoder path, no decoder files); p051 phase 1 fixes it.         |
| Vite worker build             | `vite.config.ts` has no `worker` block, so workers build as `iife`. That means static imports only inside the worker, which is fine here. Import style: `import AssetsWorker from '../workers/assetsWorker?worker'` (same as `PhysicsAPI.ts:10`). |
| Cross-origin isolation / SAB  | Not needed. Loads are one-shot, so a plain transfer list is enough. No `useSAB` equivalent.                                                                                                                                                       |

**Known costs:**

- The worker chunk bundles three.js core + `GLTFLoader` (+ `HDRLoader`), a few hundred KB. It is fetched lazily, only when an asset worker target is enabled, and cached after that.
- Each parse still creates throwaway `THREE` objects inside the worker. That GC cost lands on the worker, not the render thread.

**Out of scope:** skinned meshes, animations and morph-target animation clips (the import is geometry-only anyway; the worker warns and skips them). KTX2/Basis textures (`KTX2Loader.detectSupport` needs the renderer; a future extension could pass the support flags in the handshake). Cube textures stay on the main thread (6 loads, rarely large).

## Decisions

- **Default `MAIN_THREAD`.** This is new infrastructure. The app opts in from `src/CONFIG.ts` once verified (physics defaults to `WORKER_THREAD` only because it is proven).
- **Always a transparent fallback.** If worker init fails, a capability check fails, or a request errors or times out, the facade re-runs the same request on the main thread (`fallbackToMainThread: true`) and `lwarn`s once. The public API never exposes the thread.
- **The worker holds no cache.** Transferred buffers are detached after sending. `Geometry.ts`/`Texture.ts` registries and p051's `ImportRegistry` remain the single source of truth, and in-flight de-dup stays on the main thread.

---

## Part 1 — Config

New `AppConfig.assets` in `Config.ts` (sibling of `physics`):

```ts
assets?: {
  /** Shared default for all asset kinds. Default 'MAIN_THREAD'. */
  workerTarget?: 'MAIN_THREAD' | 'WORKER_THREAD';
  /** Per-kind overrides; fall back to workerTarget. */
  gltfWorkerTarget?: 'MAIN_THREAD' | 'WORKER_THREAD';
  textureWorkerTarget?: 'MAIN_THREAD' | 'WORKER_THREAD';
  maxConcurrentLoads?: number; // default 8
  requestTimeoutMs?: number; // default 30000
  fallbackToMainThread?: boolean; // default true
};
```

Same conventions as physics: `VITE_ASSETS_*` env var overrides, plus a debug-env-only boot override read once in `loadConfig()` from a new `DEBUG_ASSETS_BOOT_LS_KEY = 'AEK_debugAssetsBoot'` (mirrors `DEBUG_PHYSICS_API_BOOT_LS_KEY`, `Config.ts:15,227`) and applied on the next reload.

## Part 2 — Worker, protocol and facade

New files:

- `core/Assets/AssetsAPITypes.ts`: an `AssetsProtocolType` enum and `AssetsUpProtocol`/`AssetsDownProtocol` discriminated unions. Dispatch is a flat `switch` (no hot path, so no numeric-range bucketing like physics).
- `core/Assets/AssetsAPI.ts`: `initAssets()`, called from `InitApp.ts` after `loadConfig()` and before `registerScenesFromGeneratedData()`. It spawns the worker lazily on the first worker-targeted request, not at boot. It also contains the request queue (`maxConcurrentLoads`), timeout and fallback logic, `loadGLTFInWorker(url, opts)` and `loadTextureInWorker(url, opts)`.
- `workers/assetsWorker.ts`: bootstrap + handshake. Its `INIT_READY` reply carries capabilities `{ createImageBitmap, gltfImageBitmapPath, offscreenCanvas }`, computed with the same UA test `GLTFLoader` uses.
- `workers/assets/assetsSwitchGLTF.ts` and `workers/assets/assetsSwitchTexture.ts`: request handlers.

Reused infrastructure:

- `initWorker<T>` (`utils/helpers.ts:400`) for bootstrap and handshake.
- `createNewResolver`/`resolveRequest` (`utils/PromiseResolver.ts`), extended **additively** with an optional `reject` callback, `rejectRequest(requestId, err)` and a per-request timeout. Today there is no reject path, so a worker `ERROR` would leave the pending promise hanging forever. Physics has the same latent issue (`PhysicsAPI.ts`'s `ERROR` branch only logs). Fixing physics is out of scope, but the helper is shaped so it can adopt this later.

## Part 3 — GLTF in the worker

Worker side (`assetsSwitchGLTF.ts`):

1. `GLTFLoader.parseAsync(arrayBuffer, basePath)` after fetching the absolute URL. DRACO is configured with an absolute decoder path.
2. Walk `gltf.scene` with the same unwrap/`meshIndex` rules as p051's `GLTFExtract.ts`. Keep that traversal in a small shared pure module both sides import, so the rules can't drift.
3. Per primitive, post: `attributes: { name, array, itemSize, normalized }[]`, `index`, `groups`, `morphAttributes`, `morphTargetsRelative`, bounding box/sphere, node name, `parentPath`, transform, and raw `extras` (unparsed: `parseCustomProps` runs on the main thread).
4. If `importTextures` is set: per referenced texture, post the `ImageBitmap` plus `{ name, sourceName, slot, colorSpace, wrapS/T, mag/minFilter, flipY: false }`.
5. `postMessage(result, transferList)`. Every attribute `array.buffer` and `ImageBitmap` goes in the transfer list, with shared-buffer de-dup (interleaved attributes or several accessors on one buffer must be transferred once). Interleaved attributes are de-interleaved in the worker.

Main-thread side (`AssetsAPI.ts` → p051 `ImportRegistry.importAssetAsync`):

- Rebuild `BufferGeometry` (`new THREE.BufferAttribute(array, itemSize, normalized)`, `setIndex`, groups, morph attributes, bounds) and `THREE.Texture(bitmap)` with the posted sampler state. Then hand these to the same registration/manifest step the main-thread path uses. Only the "load + extract" stage differs by thread.

## Part 4 — Standalone textures in the worker

`Texture.ts`'s public `loadTextureAsync(props)` signature stays the same. It branches internally on the resolved `textureWorkerTarget`:

- **Worker**: `fetch` → `Blob` → `createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' })`, which matches `TextureLoader`'s default `flipY = true` result. The main thread wraps it in `new THREE.Texture(bitmap)`, sets `flipY = false` (the flip is already baked in), then continues through the existing `setTextureOpts`/`saveTexture` calls.
- **`.hdr`**: `HDRLoader.parse(arrayBuffer)` in the worker (pure JS, a real main-thread cost today). The half-float `data` array is transferred, and the main thread builds the `DataTexture` with the same settings `HDRLoader.load` applies.
- **Cube textures** (array `fileName`): always main thread.

Callers (`SceneLoader.ts`, `SkyBox.ts`, app code) stay thread-agnostic. The legacy synchronous `loadTexture`/`loadTextures`/`createTexture` stay main-thread (they return a texture before the image exists, which a worker round-trip can't honor).

## Gotchas to build in from day one

- **Absolutize URLs on the main thread** before posting (`new URL(fileName, new URL(path ?? './', document.baseURI)).href`). Inside the worker, a relative `fetch` resolves against the worker script's hashed chunk URL, so relative paths 404. The same goes for the DRACO decoder path and a glTF's external `.bin`/image URIs (pass `basePath` explicitly to `parseAsync`).
- **Fallback triggers**: missing `createImageBitmap`, the GLTFLoader Safari/Firefox version gate, worker init failure, timeout, or an `ERROR` reply. Each one falls back to the main thread and warns once per cause.
- **`ImageBitmap` lifetime**: once a texture is disposed, call `bitmap.close()`. `Texture.dispose()` doesn't, so add it to the dispose path for worker-created textures.
- **Detached buffers**: after `postMessage`, the worker must never touch transferred arrays again (the one-shot structure makes this natural).

## Part 5 — Debugger additions

In p051's Assets tab (`_dbg__Assets.ts`):

- A config section at the top: `workerTarget` selector (+ per-kind overrides), writes `AEK_debugAssetsBoot` + a "reload to apply" button (the same pattern as the Physics tab's boot overrides, `_dbg__PhysicsBootOverrides.ts`), and live worker status (not started / ready / fell back: reason).
- The info window gains "loaded on: main | worker (fallback reason)" and a load duration.

---

## Suggested phasing (each independently reviewable/committable)

1. **Scaffolding**: `AppConfig.assets` + env/boot overrides, `Assets/AssetsAPITypes.ts`, `Assets/AssetsAPI.ts`, `workers/assetsWorker.ts` (handshake + capabilities only), the `PromiseResolver.ts` reject/timeout extension. Default `MAIN_THREAD`, so no behavior change.
2. **Standalone textures** (Part 4) incl. HDR and `ImageBitmap.close()` on dispose.
3. **GLTF geometry extraction in the worker** (Part 3 without textures) + the shared traversal module + DRACO in the worker.
4. **GLTF textures in the worker.**
5. **Debugger additions** (Part 5), then switch `src/CONFIG.ts` to `WORKER_THREAD` once the verification below passes.

## Verification

No automated test suite exists. Verification is manual:

- **Phase 1**: with `workerTarget: 'WORKER_THREAD'`, confirm the worker is not started at boot and starts on the first request. Confirm the handshake capabilities in the console. Force an init failure (bad worker URL) and confirm the main-thread fallback and a single warning.
- **Phase 2**: toggle the boot override and load a texture-heavy scene both ways, and compare screenshots (orientation, colorSpace). Include a relative-path texture (the URL-absolutization gotcha) and an HDR skybox.
- **Phases 3–4**: load `scene_thirdPersonGym` in `MAIN_THREAD` and `WORKER_THREAD` modes. Physics wireframes, collisions and positions must match (the manifests should be equal: compare `JSON.stringify` of both, minus timing). Load a DRACO model and a textured model through the worker. Record a Performance-panel trace of a scene load in both modes and confirm the glTF parse and image decode moved to the worker thread.
- **Fallback**: simulate an unsupported browser (stub `createImageBitmap` away in the worker) and confirm the imports still succeed on the main thread.
- Throughout: `yarn lint` and `yarn build` stay clean. Check the worker chunk size in `dist-stats/bundle-stats.html`.
