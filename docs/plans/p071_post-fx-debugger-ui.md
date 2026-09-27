Status: draft | not-implemented
Category: PostFX, Debugger
Blocked by: p070_post-fx-system.md
Epic: https://trello.com/c/6a8QkjPf/62-add-postprocessing-system-to-core-code

# PostFX System Debugger UI — Plan

Add a debugger drawer tab for the PostFX system that `p070_post-fx-system.md` builds. The tab carries a new hand-authored "screen with FX" SVG icon, two global toggles at the top (**PostFX enabled**, **Measuring enabled**), and below them a list of the PostFX passes active in the current scene; clicking a row opens that pass's properties in a draggable edit window, exactly as the Camera, Light, Character, ECS and Physics API tabs already do.

p070 ships `PostFX.ts` and the measuring API with **no UI at all** and names this plan as the consumer of `getPostFxPasses()` / `setPostFxPassParam()` / `setPostFxMeasureEnabled()`. This plan is that consumer, plus the small additive engine-side gaps those surfaces are missing.

## Context (grounded in code)

- **Nothing here exists yet.** There is no `postFx`/`PostFX` runtime code anywhere in `src/` — the only repo-wide hits are two commented-out placeholders in `devTools/gatherAppData.ts:40` and `:134`. `src/_engine/core/PostFX.ts`, `src/_engine/core/Debug/_dbg__PostFX.ts` and `src/_engine/core/UI/icons/svg/post-fx.svg` are all new.
- **`_dbg__PhysicsAPI.ts` is the template, near line-for-line.** `src/_engine/core/Debug/_dbg__PhysicsAPI.ts:531-804` is the newest tab and is structurally identical to what this plan needs: `createNewDebuggerPane(...)` → Tweakpane `addBinding` settings → `debugGUI.addBlade({ view: 'separator' })` → `container.add(listCmp)` → a `DraggableWindow` editor opened from each row. This plan clones that structure rather than inventing one.
- **Tab registration** is `createDebuggerTab({ id, buttonText, title, orderNr, container })` from `src/_engine/debug/DebuggerGUI.ts:45` (impl `core/Debug/_dbg__DebuggerGUI.ts:288`). The registry is a flat `tabsAndContainers[]` array — each feature module registers itself, there is no central manifest. **`container()` is re-invoked on every tab click**, so anything started inside it (intervals, subscriptions) must be torn down in `onRemoveCmp`.
- **`orderNr: 8` is free**, and sits directly after `rendererControls` (7) — the right neighbourhood for a render-pipeline tab. Taken: 3 stats, 4 loop, 5 skybox/legacy-physics, 6 physics-API/debug-tools, 7 renderer, 10 light/raycast, 11 camera, 14 character, 15 ECS, 16 spatial grid.
- **Icons are one `.svg` file + two lines in `SvgIcon.ts`.** `src/_engine/core/UI/icons/SvgIcon.ts` imports each file with Vite's `?raw` and maps it in an `icons` object; `getSvgIcon(key, size?)` wraps it in `<span class="uiIcon">`. Three of the 31 icons are hand-authored rather than Bootstrap (`spatial-grid.svg`, `ecs-nodes.svg`, `heart-arrow.svg`), all following the same 16×16 viewBox + `currentColor` convention — so a hand-drawn icon is established practice here.
- **The list + edit-window idiom** (`_dbg__PhysicsAPI.ts:220-258`, `Camera/_dbg__CameraGUI.ts:267-302`, `Light/_dbg__LightGUI.ts:719-756`): the list function returns an **HTML string** with `CMP({ onClick, html })` buttons interpolated into `<li data-id="…">` rows; the row's `onClick` calls `openDraggableWindow({ id, title, content: <contentFn>, data, isDebugWindow: true, closeOnSceneChange: true, saveToLS: true, onClose })`, and a `updateXListSelectedClass(id)` helper toggles the `selected` class on the matching `<li>`. Clicking the already-open row closes the window (`_dbg__PhysicsAPI.ts:232-236`).
- **Window content functions can't survive a reload.** `content` is a function, and `DraggableWindow` persists window state as JSON. Every tab with an editor re-attaches it: a module-level `registerDraggableWindowContentFn(WIN_ID, contentFn)` (`Camera/_dbg__CameraGUI.ts:484`, `Light/_dbg__LightGUI.ts:717`, `_dbg__ECS.ts:166`) and/or a boot-time `setTimeout(… registerDraggableWindowCmp(…), 0)` (`_dbg__PhysicsAPI.ts:789-803`).
- **Tweakpane binds to object properties**, so every tab keeps a plain local "proxy" object mirroring the live value and writes through in `.on('change')` (`_dbg__PhysicsAPI.ts:475-477` documents this explicitly; also `deltaTimeHzProxy`, `visibilityProxy`). PostFX params — plain JSON values on a `Record<string, unknown>` — fit this directly.
- **Scene-scoped debug persistence has one established shape:** `{ [sceneId]: {...} }` in a dedicated `AEK_`-prefixed LS key, re-applied on scene enter via `registerOnAllSceneEnterings(id, fn)` (`Scene.ts:693`) — see `CameraManager.ts:44-49` (`'cameraDebugSync'` → `syncCameraHelpersFromLS`) and `LightManager.ts:26-27`. `_dbg__PhysicsDebugDraw.ts:324-383` adds the refinement this plan reuses for the two global toggles: **persist only deviation from the default**, so a scene absent from the record means "as authored".
- **Settings LS and pure-UI LS are kept in separate keys** (`_dbg__PhysicsAPI.ts:53-60` explains why: clearing one shouldn't reset the other), and every tab passes `createClearTabLSButton` / `createClearListLSButton` (`core/Debug/_dbg__ClearLSButtons.ts`) as `createNewDebuggerPane`'s third argument, with `confirmClearScope({ onClearAllScenes, onClearThisScene })` when more than one scene has data.
- **The `_dbg__` split** (CLAUDE.md; helpers at `utils/helpers.ts:443-512`): a thin always-bundled entry point in the core file, dynamically importing the `_`-prefixed implementation. `Renderer.ts:159-165` is the canonical two-liner; `InitApp.ts:116-121` is where the `createXDebugGUI()` calls live, after `appStartFn()`.
- **p070's surfaces this plan consumes:** `getPostFxPasses()`, `setPostFxPassEnabled(id, bool)`, `setPostFxPassParam(id, key, value)`, `setPostFxEnabled(bool)` / `isPostFxEnabled()` (all `core/PostFX.ts`), and `setPostFxMeasureEnabled(bool)` (`debug/PostFXProfiler.ts`). Three of them need small additions before they're sufficient — see "Engine-side gaps" below.

## Design decisions

1. **New `core/Debug/_dbg__PostFX.ts` + a thin `createPostFXDebugGUI()` wrapper in `core/PostFX.ts`**, following `Renderer.ts`/`_dbg__Renderer.ts` exactly. Registered from `InitApp.ts`'s `IS_DEBUG_ENV` block alongside `createRendererDebugGUI()`. The whole tab therefore code-splits out of production builds, per CLAUDE.md's debug layering rule.

2. **Tab identity:** `id: 'postFxControls'`, `title: 'PostFX controls'`, `orderNr: 8` (immediately after Renderer, which is the subsystem it modifies), `buttonText: getSvgIcon('postFx')`.

3. **The icon is hand-authored, 16×16, `currentColor`**, matching `spatial-grid.svg`'s stroke style so the "FX" letterforms stay legible at tab size. Letters are drawn as stroked paths, **not** `<text>` — an SVG `<text>` element would render differently per platform font and is used nowhere else in the icon set. Full content under "The icon" below.

4. **Two global toggles at the top, both live, no reload.**

   - **PostFX enabled** → `isPostFxEnabled()` / `setPostFxEnabled(bool)`. This is a runtime override of the scene's authored `postFxEnabled`, so it persists _per scene_ and _only when it deviates from the authored value_ — the `_dbg__PhysicsDebugDraw.ts:324-383` master-visibility pattern, not a blanket save. Re-applied on scene enter.
   - **Measuring enabled** → `setPostFxMeasureEnabled(bool)` / a new `isPostFxMeasureEnabled()`. Global (not scene-scoped), persisted in the tab's settings key. p070 Design decision 8 establishes that this needs **no page reload** in either direction — so this deliberately does _not_ copy `_dbg__Stats.ts:179-233`'s `location.reload()` pattern.

5. **Measuring is a toggle only — no numbers are displayed anywhere in this plan.** `getPostFxPassStats()` stays console-reachable. This keeps the tab's first version tight and avoids committing UI to a stats shape (`gpuAttribution: 'exact' | 'shared'`) that p070 itself flags as the least-settled part of its design. A stats readout is a natural follow-up once p070 Phase 5's numbers have been validated against a real `samples` sweep.

6. **The pass list is event-driven, not polled.** Unlike the physics entity list (`_dbg__PhysicsAPI.ts:761-773`, `setInterval(…, 500)`), the PostFX pass set can only change on scene enter or on a toggle the tab itself initiated — passes are per-scene render-pipeline config, not entities created at arbitrary times (p070 Non-goals: "PostFX passes as ECS components"). So the list refreshes from exactly two places: `registerOnAllSceneEnterings('postFxDebugSync', …)` and the tab's own toggle handlers. No interval, no teardown hazard, no staleness window.

7. **Param controls are inferred from the live value, and upgraded by an optional `paramsMeta` block.** p070's `params` is a deliberately untyped `Record<string, unknown>` (its Design decision 2), which is enough to pick a _control_ but not a _range_. So:

   - **Inference (always):** `number` → number binding; `boolean` → checkbox; `string` → text; `{x,y,z}` → point; `{r,g,b}` → color. Any pass, including one written after this plan with no extra authoring, gets a working editor.
   - **`paramsMeta` (optional, per param):** `{ label?, min?, max?, step?, options?, hidden? }` in the `.postFx.json`, merged over the inferred binding options. This is what turns AO's `radius` into a 0–2 slider and `samples` into a stepped 1–64 integer.
   - An unrecognised value shape renders as a `readonly` JSON string rather than being silently dropped, so a pass is never _partly_ represented without saying so.

   ```json
   "params": { "radius": 0.25, "samples": 16, "useTemporalFiltering": false },
   "paramsMeta": {
     "radius":  { "label": "Radius",  "min": 0, "max": 2,  "step": 0.01 },
     "samples": { "label": "Samples", "min": 1, "max": 64, "step": 1 }
   }
   ```

8. **A pass that can't be live-edited says so instead of lying.** p070's `PostFxPassApi.setParam` is **optional**, and a pass may return a bare `Node` with no API object at all. In that case `setPostFxPassParam()` has nothing to call. The edit window renders such a pass's params as `readonly` bindings with a one-line note, driven by a new `supportsLiveParams` flag on `getPostFxPasses()`'s return. Rebuilding the whole pipeline on every keystroke to fake live editing is explicitly rejected — it would mean a shader recompile per edit (p070 Design decision 6).

9. **Per-pass `Enabled` checkbox lives at the top of the edit window**, wired to `setPostFxPassEnabled(id, bool)`, with disabled passes dimmed in the list. Not an inline checkbox on the list row: every list row in this debugger is a plain click-to-open button, and toggling a pass costs a shader recompile (p070 Design decision 6) — not something to put one stray click away.

10. **Param edits persist per scene + pass and are re-applied on scene enter**, matching Camera/Light. LS shape `{ [sceneId]: { [passId]: { enabled?: boolean, params?: Record<string, unknown> } } }` under `AEK_debugPostFx`, with pure-UI state (folder expanded flags) in a separate `AEK_debugPostFxUI`. Re-application runs in the `registerOnAllSceneEnterings` handler from Design decision 6, **after** p070's `buildPostFxForScene()` has run, by calling `setPostFxPassParam()` / `setPostFxPassEnabled()` — the debug tab never reaches inside `PostFX.ts`'s state. Scene entries are pruned when empty (`Light/_dbg__LightGUI.ts:612-625`'s `pruneEmptyLightScene` / `writeLightLSOrRemove`).

11. **Both clear-LS header buttons.** `createClearTabLSButton` covers the two global toggles + UI state; `createClearListLSButton` covers the per-pass param/enabled overrides — the same division Camera and Light use. `confirmClearScope` when more than one scene has data.

## The icon

`src/_engine/core/UI/icons/svg/post-fx.svg` — a monitor with "FX" on the screen. 16×16 viewBox, `currentColor`, stroked letterforms (see Design decision 3):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" class="bi bi-post-fx" viewBox="0 0 16 16">
  <rect x="0.75" y="1.75" width="14.5" height="10.5" rx="1.25" stroke="currentColor" stroke-width="1.1"/>
  <path stroke="currentColor" stroke-width="1.1" stroke-linecap="round" d="M8 12.25v2.5M6.25 14.75h3.5"/>
  <path stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M4.6 9.3V4.7H7M4.6 7h2"/>
  <path stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="m8.4 4.7 3 4.6m0-4.6-3 4.6"/>
</svg>
```

The "FX" glyphs span x 4.6–11.4 and y 4.7–9.3, centred in the screen area (x 0.75–15.25, y 1.75–12.25) on both axes. Wiring is two edits to `src/_engine/core/UI/icons/SvgIcon.ts`: the `import postFxIcon from './svg/post-fx.svg?raw';` line (alphabetical, between `personArmsUp` and `playFill`) and the `postFx: postFxIcon,` entry in the `icons` object — `getSvgIcon` is generic and needs nothing else.

Verify at real size, not zoomed: the icon renders at `.uiIcon`'s size (`DebuggerGUI.module.scss:112-116`) in the tab strip, and the letters are the part most at risk of turning to mush. Adjust `stroke-width` on the two letter paths if so.

## Engine-side gaps to close first (Phase 1, additive to p070)

All four are additive and break nothing; three of them touch files p070 creates.

- **`core/PostFX.ts` — widen `getPostFxPasses()`'s return.** p070 specifies it returns "id + debugData + enabled". The tab additionally needs, per pass: the **live** `params` object (so the editor shows current values, not the authored JSON), `paramsMeta`, `supportsLiveParams: boolean` (whether the pass returned a `PostFxPassApi` with a `setParam` — Design decision 8), and the pass's index in the chain (execution order is semantic per p070 Design decision 4, so the list must show it).
- **`schemas/postFxSchema.ts` — add the optional `paramsMeta` block** (Design decision 7): `z.record(z.string(), z.object({ label, min, max, step, options, hidden }).partial()).optional()`, with JSDoc per field (not `.describe()` — p070 establishes that the repo uses `.describe()` nowhere). The gatherer carries it through with no change, since it is part of the validated asset body. Regenerate `.schemas/postFx.schema.json`.
- **`src/app/postFx/ambientOcclusion.postFx.json` — add `paramsMeta` for its eight params**, so the first real pass demonstrates the good-controls path rather than the fallback one.
- **`debug/PostFXProfiler.ts` — add `isPostFxMeasureEnabled(): boolean`**, so the tab's checkbox can initialise to the true state rather than assuming p070's `AppConfig.postFx.measureEnabled` default.

Manual verification: from the console on a scene with the AO pass, confirm `getPostFxPasses()` returns one entry with live `params`, the new `paramsMeta`, `supportsLiveParams: true` and index `0`; confirm `yarn gatherAppData` regenerates `.schemas/postFx.schema.json` with the `paramsMeta` property and that an invalid `paramsMeta` body is rejected with a clear Zod error; confirm `isPostFxMeasureEnabled()` tracks `setPostFxMeasureEnabled()` in both directions.

## Files touched

- `src/_engine/core/UI/icons/svg/post-fx.svg` — **new**, content above.
- `src/_engine/core/UI/icons/SvgIcon.ts` — one import line + one `icons` entry.
- `src/_engine/core/Debug/_dbg__PostFX.ts` — **new**, the whole tab: `_createPostFXDebugGUI()`, `createPostFxPassList()`, `createEditPostFxPassContent()`, `updateDebuggerPostFxListSelectedClass()`, the LS read/write/prune helpers, and the `registerOnAllSceneEnterings('postFxDebugSync', …)` registration. Modelled on `_dbg__PhysicsAPI.ts:531-804`.
- `src/_engine/core/PostFX.ts` — thin `createPostFXDebugGUI()` wrapper (`loadDebugModuleAsync` + `useDebug(ref)?._createPostFXDebugGUI()`), plus the widened `getPostFxPasses()` return.
- `src/_engine/InitApp.ts` — `await createPostFXDebugGUI();` in the `IS_DEBUG_ENV` block next to `createRendererDebugGUI()`.
- `src/_engine/schemas/postFxSchema.ts` — the optional `paramsMeta` block.
- `src/_engine/debug/PostFXProfiler.ts` — `isPostFxMeasureEnabled()`.
- `src/app/postFx/ambientOcclusion.postFx.json` — `paramsMeta` for its eight params.
- `.schemas/postFx.schema.json` — regenerated by `yarn gatherAppData`; never hand-edited.

Everything except the four Phase 1 additions is new-file work.

## Phases

**Phase 1 — Icon + engine-side gaps.** The SVG file and its two `SvgIcon.ts` lines (independent of p070, can be verified on its own), plus the four additions under "Engine-side gaps" above. No tab yet.

Manual verification: per "Engine-side gaps" above, plus render `getSvgIcon('postFx')` into any existing tab's header temporarily and check it at actual tab size in both the light and dark drawer styling — the letters are the risk. `tsc --noEmit` and `yarn lint` clean.

**Phase 2 — The tab and its two global toggles.** `_dbg__PostFX.ts` with `createDebuggerTab` (`postFxControls`, icon, `orderNr: 8`), `createNewDebuggerPane` with both clear-LS buttons, the **PostFX enabled** and **Measuring enabled** bindings (Design decision 4), their LS persistence + scene-enter re-application, and the `InitApp.ts` wiring. No list yet.

Manual verification: `yarn dev` + `?isDebug=true`, confirm the tab appears between Renderer and Light with the new icon and a correct tooltip. On the Large ECS test world, toggle **PostFX enabled** off and on and confirm the AO effect disappears and returns; reload and confirm the off state persisted; switch to a scene with no `postFx` and confirm the toggle reads as authored there rather than carrying over. Toggle **Measuring enabled** and confirm `getPostFxPassStats()` starts and stops returning data **without a reload** in both directions. Click into another tab and back and confirm no duplicate registrations or console noise. Exercise both clear-LS buttons.

**Phase 3 — The pass list.** `createPostFxPassList()` reading `getPostFxPasses()`, rows showing chain index, `debugData.name` (falling back to the id, italicised, as `_dbg__CameraGUI.ts:296` does), a dimmed style for disabled passes, and an `emptyState` row for scenes with no passes. Refresh wired to the scene-enter handler (Design decision 6) and the `selected` class helper.

Manual verification: on the Large ECS test world confirm the AO pass is listed with its authored name, description and index; switch to a scene with no `postFx` and confirm the empty state; switch back and confirm the list repopulates without a reload. Add a second throwaway pass to the scene JSON and confirm both appear **in the authored array order**.

**Phase 4 — The edit window.** `createEditPostFxPassContent()` per Design decisions 7-10: the `Enabled` checkbox, the inferred + `paramsMeta`-upgraded param bindings writing through `setPostFxPassParam()`, the `readonly` fallback when `supportsLiveParams` is false, the `debugData` name/description/id footer (matching `_dbg__CameraGUI.ts:129-148`), per-scene LS persistence with re-application on scene enter, and both the `registerDraggableWindowContentFn` module-level call and the boot-time `registerDraggableWindowCmp` re-attach.

Manual verification: click the AO row, confirm the window opens with all eight params as proper sliders/checkboxes from `paramsMeta`; drag `radius` and `samples` and confirm the image changes live and the reported frame time moves with `samples`; toggle the pass's `Enabled` off and confirm the effect disappears, the list row dims, and it comes back on re-enable. Reload with the window open and confirm it reopens **with content** and with the edited values still applied. Switch scenes and back and confirm the window closes (`closeOnSceneChange`) and the edits are re-applied. Clicking the already-open row closes the window. Finally, add a throwaway pass that returns a bare `Node` (no `setParam`) and confirm its params render `readonly` with the explanatory note rather than appearing editable and silently doing nothing.

**Phase 5 — Production check.** No new code. `yarn build`, then `dist-stats/bundle-stats.html`: confirm `_dbg__PostFX.ts` is code-split out of the main chunk and that `post-fx.svg`'s raw string is not in the production bundle. Confirm `?isProdTest=true` behaves sanely (the tab should not appear — it is `IS_DEBUG_ENV`-only, like the Renderer tab).

## Non-goals

- **Any per-pass statistics readout.** The **Measuring enabled** toggle ships; the numbers it produces are console-only via `getPostFxPassStats()` (Design decision 5). A stats display is a follow-up, and a natural fit for the "Statistics profiler mega window" idea in `docs/templates/todo-plan-prompts.txt`.
- **Adding, removing or reordering passes from the UI.** The chain is authored in the scene JSON; this tab edits and toggles what is there. Reordering in particular would need runtime write-back to the scene asset, which does not exist (p070: `__saveData` has no runtime reader or writer, `PropertyLoader.ts` is still a stub).
- **Writing edits back to the `.postFx.json` files.** Same reason. Edits live in localStorage, exactly as Camera/Light/Physics edits do today.
- **An on-screen-tools button for the global PostFX toggle.** The bottom bar (`_dbg__OnScreenTools.ts:305-310`) is a plausible future home for it, but nothing in the brief asks for one and every existing entry there is a helper-visibility toggle rather than a render-pipeline switch.
- **Any second PostFX pass.** p070 ships AO; new passes are follow-ups and this tab picks them up with no change.
- **Touching p070's `PostFX.ts` internals.** This plan only widens one return type and consumes public functions.

## Risks / open questions

| Risk / question                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **p070 is not implemented; this plan is fully blocked on it.**             | Nothing here can start until `PostFX.ts`, `postFxSchema.ts`, `debug/PostFXProfiler.ts` and the AO pass exist. The one genuinely independent piece is the icon (Phase 1's first half), which can land early. p070's exact signatures may also drift during its own implementation — re-read `PostFX.ts` before starting Phase 1 rather than trusting p070's draft prose.                                                              |
| `getPostFxPasses()`'s shape is specified only in p070's prose, not in code | Hence Phase 1 widens it deliberately and up front, rather than discovering the gap mid-Phase-3. If p070 lands with a different shape, Phase 1 is where the reconciliation happens.                                                                                                                                                                                                                                                   |
| A pass with no `setParam` cannot be live-edited                            | Surfaced honestly via `supportsLiveParams` + readonly bindings (Design decision 8), not papered over. Worth confirming during Phase 4 with a deliberately bare-`Node` pass.                                                                                                                                                                                                                                                          |
| Inferred controls are only as good as the value's runtime type             | A param authored as `0` that is really a 0–1 float gets an unbounded integer-looking field until `paramsMeta` is added. Mitigated by AO shipping full metadata as the worked example, and by the readonly-JSON fallback for shapes that can't be inferred at all.                                                                                                                                                                    |
| Toggling a pass costs a shader recompile and a visible frame hitch         | Inherited from p070 Design decision 6, not introduced here. It is why the toggle is in the edit window rather than inline on the list row (Design decision 9). Worth a note in the checkbox's label.                                                                                                                                                                                                                                 |
| Scene-enter re-application ordering                                        | The `registerOnAllSceneEnterings` handler must run **after** p070's own scene-enter pipeline build, or `setPostFxPassParam()` will target passes that don't exist yet. `SceneLoader.ts:470-523` runs `runOnSceneEnter(sceneId)` then `runOnAllSceneEnters()`; confirm p070 builds the pipeline before that point, and if it does not, hook the re-application to p070's own build instead. Check this first in Phase 2, not Phase 4. |
| Per-scene "PostFX enabled" override vs. the authored value                 | Persisting only deviation (Design decision 4) means a scene whose authored `postFxEnabled` later changes in JSON is not shadowed by a stale LS entry. Confirm in Phase 2 by flipping the JSON value with an override saved.                                                                                                                                                                                                          |

## Verification

- `tsc --noEmit` and `yarn lint` clean after **every** phase — the repo's Stop hook enforces this.
- Per-phase manual verification as written under each phase above. There is no test framework in this repo, so verification is `yarn dev` + `?isDebug=true` walkthroughs (the `run-aekasha-js` skill drives this).
- The two end-of-plan checks that matter most:
  - **Code-splitting**: `yarn build` → `dist-stats/bundle-stats.html` shows no `_dbg__PostFX` code and no `post-fx.svg` string in the main chunk.
  - **Full round trip**: edit AO's params, toggle the pass off and on, switch scenes, reload — and confirm the list, the window and the applied values all come back consistent, with no console errors.
