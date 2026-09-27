Status: draft | not-implemented
Category: PostFX
Blocks: p071_post-fx-debugger-ui.md
Epic: https://trello.com/c/6a8QkjPf/62-add-postprocessing-system-to-core-code

# PostFX System — Core Engine — Plan

A post-processing system for the Aekasha engine, built on Three.js r183's TSL `RenderPipeline`. It introduces a new authored asset kind — the **PostFX pass** — following the exact `<name>.postFx.json` + `<name>.tsl.ts` pattern already established by TSL materials, gathered at build time into `generatedAppData.json`/`generatedAppFns.ts`, and referenced per-scene as an ordered array in the scene JSON. The whole stack can be toggled on and off live at runtime, as can each individual pass, and each pass carries `debugData` (name/description) for the debugger UI.

Ships one PostFX pass — Ambient Occlusion, wrapping Three.js's `GTAONode` with every option it exposes — wired into the Large ECS test world scene.

Also ships an opt-in per-pass performance measuring **API only** (no UI; the UI is p071's job). Research finding: measurement does **not** require a page refresh — see Design decision 8.

## Context (grounded in code)

- **No post-processing exists anywhere today.** Repo-wide grep for `postprocess`/`PostProcessing`/`EffectComposer`/`RenderTarget` over `src/` returns zero runtime hits (the only match is a comment in `CameraManager.ts:256`). The engine renders through exactly one line.
- **The single render seam is `renderScene()`,** `src/_engine/core/MainLoop.ts:95-106`, ending in `renderer.render(rootScene, camera)`. It is called from four places, all in `MainLoop.ts`: `mainLoopForDebug` (~173), `mainLoopForProduction` (~219), `mainLoopForProductionWithFPSLimiter` (~279), and one warm-up render in `initMainLoop()` (~361). A live on/off toggle only has to change this one function, and it then works in every loop variant.
- **The gatherer already reserves this asset kind.** `devTools/gatherAppData.ts:40` has a commented-out `// postFx: '.postFx.json',` inside `JSON_ENDING_SIGNATURES`, and line ~134 has a matching `// postFx: {},` in `combinedData`. The intended file suffix and `generatedAppData.json` registry key are therefore already decided; this plan uncomments them.
- **`isFilePathValid()` (`gatherAppData.ts:56`) tests a path against every value of `JSON_ENDING_SIGNATURES`,** and `vite.config.ts`'s `sceneGathererPlugin` imports it directly. Adding the `postFx` key alone wires up dev-server HMR re-gathering — **`vite.config.ts` needs no change**.
- **The TSL material pipeline is the template to clone,** across four touch-points:
  - `compileJsonSchemas()` (`gatherAppData.ts:73-104`) — a flat `targets` array of `{ name, schema }` fed through `z.toJSONSchema(schema, { target: 'draft-07' })` into `.schemas/`. One new row.
  - The material branch (`gatherAppData.ts:385-427`) resolves `matJSON.tslFile` against disk (with an implicit `.ts` fallback), hard-errors if absent, and emits `import * as <uniqueNs> from '../<basePath>/<tslFile>';` plus a `tslMaterialFileObjects` entry — all gated by `(isFoundInAScene || !isProduction)`, so **production only bundles TS files a scene actually references**.
  - `src/_engine/generatedAppFns.ts` currently exports `sceneFileObjects` (lazy `import()` per scene) and `tslMaterialFileObjects` (static namespace imports). A sibling `postFxFileObjects` is the natural shape.
  - `src/_engine/core/Material.ts:314-450` consumes it: `existsOrThrow` on the registry entry, then per-socket lookup with a graceful `lwarn`+`continue` on a missing export.
- **`getBasePath()` (`gatherAppData.ts:65`) extracts the first folder under `src/`,** so `tslFile` is relative to `src/<basePath>/` — not to the JSON file. `src/toolkit/materials/checkerBoard.material.json` declares `"tslFile": "materials/checkerBoard.tsl.ts"`.
- **Scene assets are ordered arrays of `string | inlineObject`** (`sceneSchema.ts`'s `SceneOverridesSchema`), inlined by the gatherer's scene loop (which runs last, after every other registry is built) with `__saveData[sceneId][0]` merged over the base asset. `SceneData` in `Scene.ts:26-51` is the hand-written runtime mirror.
- **The camera identity changes at runtime.** `renderScene()` uses `getActiveCamera()` (`CameraManager.ts:223`), a cached direct pointer reassigned by `setActiveCamera()`, `setCurrentCamera(appId)` and `toggleDebugCamera()` — the last of which swaps in the debug fly camera. A TSL `pass(scene, camera)` node binds its camera by reference at construction, so the pipeline must notice this.
- **`debugData` is a uniform, established shape:** `DebugDataSchema` in `src/_engine/schemas/_helperSchemas.ts` (`name?`, `description?`, `comments?`, `todo?`, `debugObj?`), folded into `.name`/`.userData` by `Material.ts:452-459`, `Texture.ts`, `SkyBox.ts`, and carried on ECS entities as `ComponentType.DEBUG_DATA`. 79 occurrences repo-wide. Exactly what the brief asks each PostFX pass to carry.
- **The debug layering rule** (CLAUDE.md, and `helpers.ts:443-512`): a thin always-bundled entry point guarded by `IS_DEBUG_ENV`, dynamically `import()`ing the real implementation via `loadDebugModuleAsync`/`useDebug`, whose functions are `_`-prefixed. `Renderer.ts:158-165` is the canonical two-line example.
- **GPU timestamp infra already exists and is already enabled.** `_dbg__Stats.ts:68-74` calls `renderer.resolveTimestampsAsync(TimestampQuery.RENDER)` each frame, and `stats-gl@3.6.0` sets `renderer.backend.trackTimestamp = true` inside `stats.init()` (`node_modules/stats-gl/dist/main.js:142`). `docs/plans/_DONE_p027_physics-api-stats-tracker.md` is the directly analogous opt-in measuring-API plan and is the model for this plan's Phase 5.
- **Prior art:** `docs/analysis/ambient-occlusion-options.md` item 13 names `GTAONode` as the intended screen-space AO path and item 14 names the depth+normal prepass as its dependency; its "Suggested phasing" Phase 4 reads *"Once PostFX exists. Start by integrating N8AO or `GTAONode`."* This plan is that prerequisite plus that first integration.

### Three.js r183 facts verified against `node_modules/`

- `PostProcessing` **is deprecated as of r183** — `renderers/common/PostProcessing.js:20` emits `warnOnce('PostProcessing has been renamed to RenderPipeline')`. **Use `RenderPipeline`**, exported from `three/webgpu` (`src/Three.WebGPU.js:9`) and typed in `@types/three` (`renderers/common/RenderPipeline.d.ts`): `{ renderer, outputNode, outputColorTransform, needsUpdate, render(), dispose() }`. `render()` is **synchronous** — `renderAsync()` is itself deprecated — so `renderScene()` stays sync.
- `RenderPipeline.render()` handles tone mapping correctly: it captures `renderer.toneMapping`/`outputColorSpace`, bakes them into the chain via `renderOutput()` in `_update()`, and temporarily forces the renderer to `NoToneMapping`/working-color-space for the final quad. **No double transform.** But `_update()` only re-reads them when `needsUpdate === true` — see Design decision 7.
- `three/tsl` exports `pass`, `mrt`, `output`, `normalView` (verified via `node -e "require('three/tsl')"`). `PassNode.getTextureNode('depth')` works — `PassNode.js:257` names the auto-created depth texture `'depth'`.
- `GTAONode` (`three/examples/jsm/tsl/display/GTAONode.js`, typed in `@types/three`) exposes uniforms `radius`, `thickness`, `distanceExponent`, `distanceFallOff`, `scale`, `samples`, `resolution`, plus plain JS props `resolutionScale` and `useTemporalFiltering`, and methods `getTextureNode()` / `setSize(w, h)`. Its own `updateBefore()` already calls `setSize()` from the renderer's drawing-buffer size each frame, so resize is self-managing. Constructor is `(depthNode, normalNode, camera)`; the addon's own docblock shows the exact MRT + `.mul(sceneColor)` composition this plan uses.
- `PassNode` inherits MSAA automatically: `PassNode.js:756` sets `renderTarget.samples = renderer.samples`, so today's `antialias: true` keeps working unchanged when PostFX is on.
- **Timestamp queries can be enabled at runtime, no reload needed.** `WebGPUBackend.js:206-211` requests *all* adapter-supported features at device creation (`requiredFeatures: supportedFeatures`), so `timestamp-query` is always on the device; `initTimestampQuery()` (`:2007-2028`) creates the query pool **lazily** on first use once `backend.trackTimestamp` is true. This is exactly how stats-gl flips it after `renderer.init()`. `WebGLBackend` has an equivalent `WebGLTimestampQueryPool`.
- **Per-render-pass GPU attribution is a supported, public API in r183.** `renderer.inspector` is a settable `InspectorBase` subclass (`Renderer.js:1029-1049`) receiving `begin()`, `finish()`, `beginRender(uid, scene, camera, renderTarget)` and `finishRender(uid)` for **every** render context, and `renderer.backend.getTimestamp(uid)` returns that context's GPU duration after `resolveTimestampsAsync()`. The official `three/examples/jsm/inspector/RendererInspector.js` addon already does exactly this.

## Naming — "PostFX pass"

A single item in the chain is a **PostFX pass**. In code: `PostFxPass`, `PostFxPassAsset`, `createPostFxPass()`, `togglePostFxPass()`. In JSON: the scene's `postFx` array. In the debugger UI: "PostFX passes".

This matches the dominant term across the field — Three.js's own legacy `EffectComposer` (`RenderPass`, `BloomPass`), Unreal's post-process passes, and general render-graph vocabulary.

**The one hazard, and its mitigation.** TSL already uses `pass()`/`PassNode` for something narrower and different: the scene render pass that feeds the chain. To keep this unambiguous, engine code **never uses the bare token `Pass`/`pass` for a PostFX item** — always the compound `PostFxPass`/`postFxPass`/`postFxPasses` — and the TSL scene pass is always named `scenePass`, never `pass`. This rule is stated once in `PostFX.ts`'s module doc comment.

File/registry naming follows the gatherer's already-reserved slot: suffix `.postFx.json`, `generatedAppData.json` key `postFx`, generated glue export `postFxFileObjects`. The TS file uses the material convention `<name>.tsl.ts`.

## Design decisions

1. **Every PostFX pass is a `.postFx.json` + `.tsl.ts` pair. There are no engine-built-in pass types.** Even AO — which wraps a Three.js addon class rather than writing raw TSL — is authored as an ordinary pass whose TS file constructs and wires `GTAONode`. This directly satisfies the brief ("designed the same way as TSL materials"), keeps the engine free of a growing built-in `type` enum, and means `GTAONode` only enters the bundle when a scene actually references the AO pass (via the gatherer's existing `isFoundInAScene || !isProduction` production gate). "Modular Infinity": you only bring into existence what you need.

2. **Flat `params`, not material-style `nodes`.** A material has several node sockets (`colorNode`, `roughnessNode`, `normalNode`), so its JSON nests inputs per socket. A PostFX pass has exactly one output, so its JSON carries a flat `params` object. Values reach the TS function as **raw JSON values, not pre-marshalled TSL uniform nodes** — because addon nodes like `GTAONode` own their own `UniformNode`s (`aoPass.radius.value = 0.25`) and also have plain JS props (`resolutionScale`, `useTemporalFiltering`) that are not uniforms at all. A hand-written TSL pass that wants uniforms calls `uniform()` from `three/tsl` itself. This also avoids extracting/refactoring `Material.ts:359-438`'s value→node coercion table, keeping this plan additive.

3. **The TS file exports one contract-named function, `fxNode`.** Mirrors how material node-socket exports are contract-named, but with a single fixed name since there is one output:

   ```ts
   // src/_engine/core/PostFX/PostFXTypes.ts (new)
   import type * as THREE from 'three/webgpu';
   import type { Node } from 'three/tsl';

   /** Everything a PostFX pass needs from the engine to build its node. */
   export type PostFxPassContext = {
     renderer: THREE.WebGPURenderer;
     scene: THREE.Scene;
     camera: THREE.Camera;
     /** The shared TSL scene pass (MRT: output + normal, plus auto depth). */
     scenePass: ReturnType<typeof import('three/tsl').pass>;
     /** Output of the previous pass in the chain — what this pass should build on. */
     colorNode: Node;
     /** Unmodified scene buffers, for passes that need the raw G-buffer. */
     sceneColorNode: Node;
     sceneNormalNode: Node;
     sceneDepthNode: Node;
   };

   /** What a pass may return instead of a bare Node, when it needs lifecycle hooks. */
   export type PostFxPassApi = {
     /** The node this pass contributes to the chain. */
     node: Node;
     /** Nodes whose updateBefore() cost is attributed to this pass when profiling. Defaults to [node]. */
     profileNodes?: Node[];
     /** Live param write-through, used by the debugger (p071). */
     setParam?: (key: string, value: unknown) => void;
     onSetSize?: (width: number, height: number) => void;
     onDispose?: () => void;
   };

   export type PostFxPassFn = (
     params: Record<string, unknown>,
     ctx: PostFxPassContext,
     defines?: Record<string, unknown>
   ) => Node | PostFxPassApi;
   ```

   Returning a bare `Node` is the simple case; returning a `PostFxPassApi` is what AO does. `setParam` exists because live editing of a `GTAONode` means both `aoPass.radius.value = v` (uniform) and `aoPass.resolutionScale = v` (plain prop) — the pass author knows which is which, the engine does not.

4. **The scene declares an ordered array plus a sibling boolean.** Keeping `postFx` a plain array preserves the uniform shape of every other scene asset registry (and so the gatherer's existing inlining loop pattern); array order *is* execution order:

   ```json
   {
     "postFx": ["ambientOcclusion"],
     "postFxEnabled": true
   }
   ```

   `postFxEnabled` is optional and defaults to `true` when `postFx` is non-empty — so setting it `false` authors a stack that starts switched off. This is the field p071's "PostFX enabled" checkbox binds to. Ordering being semantic is new for a scene registry and is called out in the schema's JSDoc.

5. **Runtime on/off is a branch in `renderScene()`, and it is genuinely live.** `MainLoop.ts`'s `renderScene()` becomes:

   ```ts
   const pipeline = getActivePostFxPipeline(); // null when off / no passes / not built
   if (pipeline) pipeline.render();
   else renderer.render(rootScene, camera);
   ```

   Both branches are synchronous and both already have everything they need in scope. Because all four call sites go through this one function, every loop variant gets the toggle for free. Turning the stack off does not dispose the pipeline — it is kept warm so toggling back on does not recompile.

6. **The pipeline is rebuilt, not bypassed, when the pass set changes — and the camera is checked per frame.** Toggling an individual pass off removes it from the chain entirely (so it costs nothing), which means a new `outputNode` and `pipeline.needsUpdate = true`, which means a shader recompile and a one-frame hitch. That is the correct trade (a uniform-based `mix()` bypass would avoid the hitch but keep paying the GPU cost, defeating the point of the toggle); the hitch is documented and is acceptable for what is primarily a debugger action. Rebuild triggers: scene enter, global toggle on (first time), per-pass toggle, pass reorder, and **active-camera change**. For the last one, `renderScene()` compares the camera the pipeline was built with against `getActiveCamera()` by identity each frame and rebuilds on mismatch — a cheap pointer compare, and it correctly handles the debug fly camera being toggled in and out (`toggleDebugCamera()`), with no new event bus needed. Resize needs no rebuild: `PassNode` and `GTAONode` both self-resize from the renderer's drawing-buffer size.

7. **The Renderer debug tab must invalidate the pipeline when tone mapping or color space changes.** `RenderPipeline._update()` reads `renderer.toneMapping`/`renderer.outputColorSpace` and *bakes them into the compiled chain*, re-reading only when `needsUpdate` is true. `_dbg__Renderer.ts` currently sets `r.toneMapping = ...` live and expects it to take effect immediately — which it silently would not, while PostFX is on. Fix: those two `.on('change')` handlers additionally call a new thin `invalidatePostFxPipeline()` export. Without this the tab appears broken in exactly the scenes this plan targets.

8. **Per-pass performance measurement, opt-in, debug-only, lazily loaded — and no page refresh needed.** The brief allowed for a reload; research shows one isn't required (see the r183 facts above): `renderer.backend.trackTimestamp` can be flipped after init and Three creates the query pool lazily. The measuring API therefore toggles live. It is built in two tiers:
   - **CPU time per pass** — the profiler wraps each pass's `profileNodes`' `updateBefore()` with `performance.now()`. This is the JS-side cost: render-target setup, uniform updates, draw dispatch.
   - **GPU time per pass** — the engine installs its own `InspectorBase` subclass as `renderer.inspector`. Because the profiler already brackets each pass's `updateBefore()`, any render context opened inside that window (`beginRender(uid, …)`) is attributed to that pass; after the frame, `resolveTimestampsAsync(TimestampQuery.RENDER)` then `renderer.backend.getTimestamp(uid)` gives each one's GPU duration, summed per pass.
   - **The honest limitation, stated in the API docs and surfaced in the returned data:** passes that are pure in-chain math (a sepia or chromatic-aberration pass, which adds no render target of its own) are all evaluated inside the single final composite quad and therefore **share one uid** — they cannot be separated from each other on the GPU side. Their CPU number is still per-pass and exact, and the composite's GPU total is reported as one shared figure. Passes that own render targets — AO, bloom, DoF, SSR, i.e. the ones whose cost actually matters — attribute cleanly. The returned type makes this explicit with a `gpuAttribution: 'exact' | 'shared'` field rather than silently reporting a misleading number.
   - Ownership: `renderer.inspector` is a single slot. The profiler must therefore chain to any previously installed inspector rather than clobbering it, and restore it on disable. Nothing installs one today, but `RendererInspector` is a plausible future addition.
   - Entirely `_dbg__`-lazy-loaded and `IS_DEBUG_ENV`-gated, so it is fully tree-shaken from production builds, per CLAUDE.md's debug layering rule. When off: no inspector installed, no `updateBefore` wrappers, no `performance.now()` calls, no `trackTimestamp`, zero per-frame cost.

9. **Antialiasing is left exactly as it is.** `PassNode` inherits `renderer.samples`, so today's `antialias: true` MSAA keeps working when PostFX is on, with no code change. `docs/analysis/ambient-occlusion-options.md` notes MSAA and screen-space AO don't combine perfectly (AO reads the resolved depth buffer, so edges can be marginally off), but the artifact is minor and fixing it properly means an AA pass (FXAA/SMAA/TRAA) — which is a later PostFX pass, not this plan. Called out under Non-goals.

10. **`AppConfig.postFx` holds engine-level defaults only.** A new optional section in `src/_engine/core/Config.ts`'s `AppConfig` type + defaults object, following the `physics`/`debugPhysicsWireframe` precedent (fully optional, JSDoc per field stating the default and citing this plan): `enabled?: boolean` (global master, default `true` — a scene still has to declare passes) and `measureEnabled?: boolean` (default `false`). Per-scene and per-pass state lives in the scene/pass JSON, not here.

## Asset shape

`src/app/postFx/ambientOcclusion.postFx.json`:

```json
{
  "$schema": "../../../.schemas/postFx.schema.json",
  "id": "ambientOcclusion",
  "tslFile": "postFx/ambientOcclusion.tsl.ts",
  "enabled": true,
  "debugData": {
    "name": "Ambient Occlusion",
    "description": "Ground Truth Ambient Occlusion (GTAO). Darkens creases and contact points using the scene depth and normal buffers. Screen-space only — cannot see off-screen geometry."
  },
  "params": {
    "radius": 0.25,
    "thickness": 1,
    "distanceExponent": 1,
    "distanceFallOff": 1,
    "scale": 1,
    "samples": 16,
    "resolutionScale": 1,
    "useTemporalFiltering": false
  }
}
```

`src/app/postFx/ambientOcclusion.tsl.ts`:

```ts
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import type { PostFxPassContext, PostFxPassApi } from '../../_engine/core/PostFX/PostFXTypes';

export const fxNode = (
  params: Record<string, unknown>,
  ctx: PostFxPassContext
): PostFxPassApi => {
  const aoPass = ao(ctx.sceneDepthNode, ctx.sceneNormalNode, ctx.camera);

  const setParam = (key: string, value: unknown) => {
    switch (key) {
      case 'radius': case 'thickness': case 'distanceExponent':
      case 'distanceFallOff': case 'scale': case 'samples':
        aoPass[key].value = value as number; break;
      case 'resolutionScale': aoPass.resolutionScale = value as number; break;
      case 'useTemporalFiltering': aoPass.useTemporalFiltering = value as boolean; break;
    }
  };
  for (const [k, v] of Object.entries(params)) setParam(k, v);

  return {
    // AO is multiplicative over the incoming color, per GTAONode's own documented usage.
    node: aoPass.getTextureNode().mul(ctx.colorNode),
    profileNodes: [aoPass],
    setParam,
    onSetSize: (w, h) => aoPass.setSize(w, h),
  };
};
```

Correctness notes:

- `ctx.colorNode` (not `ctx.sceneColorNode`) is what AO multiplies, so AO composes correctly when another pass runs before it.
- `resolutionScale` must be set **before** the first `setSize`; `GTAONode.setSize()` multiplies by it (`GTAONode.js:256-257`). Applying params in the returned-object constructor, before the first frame's `updateBefore()`, satisfies this.
- `useTemporalFiltering: true` requires a `TRAANode` pass in the chain; leave it `false` until an AA/TAA pass exists (Non-goals). Worth an explicit `lwarn` from the engine if it is enabled with no TRAA pass present.
- `import 'three/addons/...'` matches the existing repo convention (`GLTFLoader`, `OrbitControls`, `lines/webgpu/LineSegments2.js` are all imported this way).

Scene wiring — `src/app/largeWorld.scene.json` gains two keys:

```json
  "skyboxes": ["basicSkybox"],
  "postFx": ["ambientOcclusion"],
  "postFxEnabled": true
```

## Files touched

- `src/_engine/schemas/postFxSchema.ts` — **new**. `PostFxOverridesSchema`, `PostFxAssetSchema`, `PostFxAsset`, following `materialSchema.ts`'s structure exactly (`id` required with a Zod-4 `{ error: ... }` message, `tslFile: z.string()`, `enabled`, `params`, `staticDefines`, `debugData`, `userData`, `$schema`, `__sourcePath`, `__saveData: createSaveDataSchema(PostFxOverridesSchema)`). JSDoc comments per field, **not** `.describe()` — the repo uses `.describe()` nowhere, and introducing it here would be a new convention.
- `src/_engine/schemas/sceneSchema.ts` — add `postFx: z.array(z.union([z.string(), PostFxAssetSchema])).optional()` and `postFxEnabled: z.boolean().optional()` to `SceneOverridesSchema`, with a JSDoc noting that array order is execution order.
- `devTools/gatherAppData.ts` — uncomment `postFx: '.postFx.json'` (line 40) and `postFx: {}` (~line 134); add the `postFx.schema.json` row to `compileJsonSchemas()`; add `postFx: []` to `ids`; add the validate/dedupe/`__sourcePath`/`delete $schema` loop and the `tslFile` resolution + `postFxFileObjects` emission, both cloned from the Materials block; add the scene-inlining block alongside the other registries; append `postFxFileObject` to the `OUTPUT_FILE_FN` write with the same empty-fallback the material one has. **No `vite.config.ts` change needed** — `isFilePathValid()` picks the new suffix up automatically.
- `src/_engine/core/PostFX.ts` — **new**. Public surface: `initPostFX()`, `getActivePostFxPipeline()`, `buildPostFxForScene(sceneId)`, `setPostFxEnabled(bool)` / `isPostFxEnabled()` / `togglePostFx()`, `setPostFxPassEnabled(id, bool)` / `togglePostFxPass(id)`, `getPostFxPasses()` (id + debugData + enabled, for p071), `setPostFxPassParam(id, key, value)`, `invalidatePostFxPipeline()`, `disposePostFx()`. Holds the `RenderPipeline`, the built-camera pointer, and the per-scene pass list. Module doc comment states the `PostFxPass` vs TSL `scenePass` naming rule.
- `src/_engine/core/PostFX/PostFXTypes.ts` — **new**. `PostFxPassContext`, `PostFxPassApi`, `PostFxPassFn`, `PostFxPassProps`, plus the measurement result types. Type-only, so app-side `.tsl.ts` files can import it without pulling in runtime code.
- `src/_engine/core/MainLoop.ts` — `renderScene()` gains the branch from Design decision 5 and the per-frame camera-identity check from Design decision 6. ~6 lines.
- `src/_engine/core/Scene.ts` — `SceneData` gains `postFx?: (PostFxPassProps | string)[]` and `postFxEnabled?: boolean`; `SceneOptions` gains the matching pair.
- `src/_engine/core/Config.ts` — `AppConfig` gains the optional `postFx` section + defaults (Design decision 10).
- `src/_engine/InitApp.ts` — call `initPostFX()` after `appStartFn()` (the renderer is created inside it, by `src/index.ts`) and before `initMainLoop()`.
- `src/_engine/core/Debug/_dbg__Renderer.ts` — tone-mapping and output-color-space `.on('change')` handlers additionally call `invalidatePostFxPipeline()` (Design decision 7).
- `src/_engine/debug/PostFXProfiler.ts` — **new**, thin always-bundled entry point (`registerPostFxProfiler`, `setPostFxMeasureEnabled`, `getPostFxPassStats`), forwarding through `loadDebugModuleAsync`/`useDebug`.
- `src/_engine/core/Debug/_dbg__PostFXProfiler.ts` — **new**, the real implementation: the `InspectorBase` subclass, the `updateBefore` wrappers, the per-pass CPU/GPU accumulators.
- `src/app/postFx/ambientOcclusion.postFx.json` + `src/app/postFx/ambientOcclusion.tsl.ts` — **new**, per "Asset shape" above.
- `src/app/largeWorld.scene.json` — two new keys.
- `src/_engine/generatedAppData.json`, `src/_engine/generatedAppFns.ts`, `.schemas/postFx.schema.json`, `.schemas/scene.schema.json` — regenerated by `yarn gatherAppData`; never hand-edited.

Everything except `MainLoop.ts`'s `renderScene()`, `_dbg__Renderer.ts`'s two handlers, and the two schema/type additions is purely new-file additive.

## Phases

Each phase is independently reviewable and committable, and leaves the tree compiling and the app rendering.

**Phase 1 — Schema + gatherer.** `postFxSchema.ts`, the `sceneSchema.ts` additions, and the full `gatherAppData.ts` wiring. No runtime code yet, so nothing renders differently. Add a placeholder `src/app/postFx/ambientOcclusion.postFx.json` + a stub `.tsl.ts` (returning `ctx.colorNode` unchanged) purely so the gatherer has something to gather.

Manual verification: `yarn gatherAppData` exits clean; `.schemas/postFx.schema.json` and an updated `.schemas/scene.schema.json` appear; `generatedAppData.json` grows a `postFx` registry with the stub entry; `generatedAppFns.ts` grows a `postFxFileObjects` export importing the stub. Then deliberately break it three ways and confirm each is caught with a clear message: an invalid `.postFx.json` body (Zod validation error), a `tslFile` pointing at a nonexistent path (the disk-existence hard error), and two files claiming the same `id` (duplicate-id error). Confirm `yarn dev` re-gathers and full-reloads when a `.postFx.json` is edited, added or deleted. Finally, `NODE_ENV=production yarn gatherAppData` and confirm a `postFx` asset not referenced by any scene has no `import` emitted into `generatedAppFns.ts`. `tsc --noEmit` and `yarn lint` clean.

**Phase 2 — Runtime pipeline, off by default.** `PostFXTypes.ts`, `PostFX.ts` (build/dispose/toggle, minus profiling), the `SceneData`/`SceneOptions`/`AppConfig` additions, `initPostFX()` in `InitApp.ts`, and the `renderScene()` branch. The stub pass from Phase 1 is a pure pass-through, so with `postFx` still absent from every scene JSON, **rendering is byte-identical to today**.

Manual verification: `yarn dev` + `?isDebug=true`, load every scene, confirm no visual change and no console/WebGPU errors. Then from the console, temporarily point the pipeline at the stub pass and call `setPostFxEnabled(true)` / `false` repeatedly on a live scene — confirm the image is unchanged in both states (the stub is pass-through), that toggling never throws, and that the first `true` costs one visible hitch and subsequent toggles do not (the pipeline is kept warm). Confirm `?isProdTest=true` and a real `yarn build` bundle behave the same. Check `dist-stats/bundle-stats.html` to confirm nothing debug-only leaked in.

**Phase 3 — Camera, scene-lifecycle and renderer-tab correctness.** The per-frame camera-identity check, rebuild on scene enter/exit, `disposePostFx()` on scene exit, and the `_dbg__Renderer.ts` invalidation hookup (Design decision 7).

Manual verification: with the stub pass active, toggle the debug fly camera on and off (`toggleDebugCamera`) and switch cameras from the on-screen camera dropdown — confirm the image stays correct and the pipeline rebuilds exactly once per switch (log the rebuild). Switch scenes back and forth repeatedly and confirm no leaked pipelines or render targets and no growth in `renderer.info`. With PostFX on, change tone mapping and output color space from the Renderer debug tab and confirm both now take effect immediately.

**Phase 4 — The Ambient Occlusion pass.** Replace the stub with the real `ambientOcclusion.tsl.ts` (MRT scene pass wiring in `PostFX.ts`, `GTAONode` construction, all eight params, `setParam`, `onSetSize`), and add the two keys to `largeWorld.scene.json`.

Manual verification: `?isDebug=true`, load the Large ECS test world, confirm visible contact-shadow darkening in creases and where objects meet the terrain, and that it tracks the camera as it moves. From the console, sweep each of the eight params across its range and confirm each visibly does what its name says and that none throw (`samples` and `resolutionScale` should trade quality against frame time noticeably). Confirm `setPostFxEnabled(false)` cleanly returns the un-occluded image and `true` restores AO. Confirm MSAA still applies (Design decision 9) by checking geometry edges. Confirm every other scene is unaffected. Repeat the core checks under `?isProdTest=true` and against a `yarn build` bundle, and confirm in `dist-stats/bundle-stats.html` that `GTAONode` **is** present (largeWorld references it) — and, as a control, that a `.postFx.json` left unreferenced by any scene is absent.

**Phase 5 — The measuring API.** `debug/PostFXProfiler.ts` + `core/Debug/_dbg__PostFXProfiler.ts` per Design decision 8: the `InspectorBase` subclass (chaining to any pre-existing inspector), the `updateBefore` wrappers driven by each pass's `profileNodes`, per-pass CPU and GPU accumulators, the `gpuAttribution: 'exact' | 'shared'` flag, and `setPostFxMeasureEnabled(bool)` / `getPostFxPassStats()`. No UI — p071 builds that.

Manual verification: on the Large ECS test world with AO on, call `setPostFxMeasureEnabled(true)` from the console and confirm `getPostFxPassStats()` returns a plausible per-frame CPU and GPU millisecond figure for the AO pass with `gpuAttribution: 'exact'`; confirm raising `samples` from 16 to 64 raises the reported GPU number roughly proportionally (this is the check that the number is real and not an artifact). Confirm enabling and disabling measurement works **without a page reload** in both directions, that disabling restores `renderer.inspector` to what it was, and that the stats-gl GPU panel keeps working throughout (both call `resolveTimestampsAsync`; confirm they don't fight). Add a second, throwaway in-chain-only pass and confirm it reports `gpuAttribution: 'shared'` with an exact CPU figure rather than a fabricated GPU one. Confirm with `yarn build` + `dist-stats/bundle-stats.html` that neither profiler file ships in production.

## Non-goals

- **The PostFX debugger tab and UI** — that is `p071_post-fx-debugger-ui.md`, which this plan blocks. Phase 5 deliberately ships the measuring API with no UI, as the brief asks. `PostFX.ts`'s `getPostFxPasses()`/`setPostFxPassParam()` and the profiler's `getPostFxPassStats()` are the surfaces p071 will consume.
- **Any second PostFX pass** (bloom, DoF, FXAA/SMAA/TRAA, SSR, godrays, …). Three.js ships 40 ready-made TSL display nodes; each becomes a small, self-contained follow-up once this plan lands. AA passes in particular are deliberately deferred — see Design decision 9.
- **Changing antialiasing behavior.** MSAA keeps working exactly as today. The MSAA-vs-screen-space-AO tension documented in `docs/analysis/ambient-occlusion-options.md` is acknowledged and left alone.
- **Reworking `_dbg__Renderer.ts`'s ownership of tone mapping / output color space.** This plan only makes the existing controls keep working when PostFX is on; moving tone mapping into the chain as an authored pass is a separate question.
- **Extracting `Material.ts`'s JSON-value→TSL-node coercion into a shared utility.** Tempting for reuse, but Design decision 2 removes the need, and touching working material code for no functional gain is scope this plan doesn't need.
- **Runtime `__saveData` write-back.** No runtime code reads or writes `__saveData` anywhere today (`PropertyLoader.ts` still has a `// @TODO: Load and return properties from file` stub). The `__saveData` field is added to the schema purely for build-time merge parity with every other asset kind.
- **PostFX passes as ECS components.** The stack is a per-scene render-pipeline concern, not an entity concern.

## Risks / open questions

| Risk / question | Notes |
|---|---|
| Per-pass GPU attribution relies on `renderer.inspector` + `backend.getTimestamp(uid)` | Both are public r183 API, and the official `three/examples/jsm/inspector/RendererInspector.js` addon uses exactly this pairing — but the `uid` format and the `Inspector` surface are young and could shift in a future three release. Contained: debug-only, and a break degrades to the CPU-only tier rather than breaking rendering. Verify in Phase 5 against a real `samples` sweep, not by trusting the numbers. |
| In-chain-only passes cannot be separated on the GPU side | Inherent to how TSL fuses a node chain into one composite quad, not a fixable implementation detail. Handled by reporting `gpuAttribution: 'shared'` explicitly instead of a misleading per-pass number (Design decision 8). The passes that actually cost something own render targets and attribute exactly. |
| Toggling a pass causes a shader recompile and a frame hitch | Accepted and documented (Design decision 6). Primarily a debugger action. If a game ever needs hitch-free gameplay toggling, the answer is pre-warming the variants, which can be added later without changing this design. |
| MSAA + screen-space AO produce slightly wrong edges | Known and documented in the repo's own AO analysis; minor. The real fix is an AA pass, deferred by choice (Non-goals). |
| `GTAONode` is documented to halo at depth discontinuities and ships no denoiser | Called out in `docs/analysis/ambient-occlusion-options.md` item 13. Mitigations (a `DenoiseNode` pass, or `useTemporalFiltering` + `TRAANode`) are both additional passes, i.e. follow-up work this plan's architecture accommodates directly. |
| Timestamp query pool is capped at 2048 queries and warns if exceeded | `WebGPUTimestampQueryPool` sizing, with `resolveTimestampsAsync` called every frame by `_dbg__Stats.ts` already. Only a concern with a very deep pass stack under measurement; watch for the warn during Phase 5. |
| `forceWebGL` mode | The whole design uses `WebGPURenderer`, which also drives the WebGL backend, and `WebGLBackend` has its own `WebGLTimestampQueryPool` — so both tiers should work. Not independently verified; check the AO pass and the profiler under `forceWebGL: true` during Phase 4/5 and note any divergence rather than assuming parity. |
| `renderer.inspector` is a single slot | The profiler chains to and restores any pre-existing inspector (Design decision 8). Nothing installs one today, so this is forward-protection, not a current conflict. |
| Filename discrepancy in the source brief | `docs/templates/todo-plan-prompts.txt` names the follow-up `p071_post-fx-debug-ui.md` in this plan's *Blocks* line but titles its own follow-up prompt `p071_post-fx-debugger-ui.md`. This plan's header uses `p071_post-fx-debugger-ui.md` — flagged for confirmation. |

## Verification

- `tsc --noEmit` and `yarn lint` clean after **every** phase — the repo's Stop hook enforces this.
- Per-phase manual verification as written under each phase above. There is no test framework in this repo, so verification is `yarn dev` + `?isDebug=true` / `?isProdTest=true` walkthroughs (the `run-aekasha-js` skill drives this).
- The two checks worth repeating at the end of Phases 2, 4 and 5, because they are what this design most depends on:
  - **Tree-shaking**: `yarn build`, then `dist-stats/bundle-stats.html` — neither profiler file present, `GTAONode` present only because `largeWorld` references it, and no `.postFx.json` TS file bundled that no scene uses.
  - **Zero-cost-when-off**: with `postFx` absent from a scene, and separately with measurement disabled, confirm the frame time and the stats-gl panels are indistinguishable from the pre-plan baseline.
