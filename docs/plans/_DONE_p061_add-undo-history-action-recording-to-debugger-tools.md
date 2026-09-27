Status: implemented
Category: Debugger
Blocked by: \_DONE_p060_debugger-undo-engine-core.md
Blocks: \_DONE_p062_add-undo-and-redo-ui.md
Epic: https://trello.com/c/JYgK1s1u/86-add-undo-redo-system

# Add Undo History Action Recording to Debugger Tools — Plan

Wires the undo/redo engine core (`docs/plans/_DONE_p060_debugger-undo-engine-core.md`) into the debugger's actual mutation sites: OnScreenTools, every debugger drawer tab, and every entity edit window. This is the "make it real" plan `p060` deliberately deferred — it goes through every actionable UI element across the whole debugger, decides whether recording it as an undo/redo action makes sense, and for the ones that do, specifies the `actionType`/payload/handler. **No key bindings, no UI (history list, undo/redo buttons) are added here** — only the recording/handler wiring, per the request. Actual keyboard shortcuts and UI affordances are separate, later work.

This plan is unusually catalog-heavy by nature of the request ("go through each actionable UI element... report every single UI action that is not possible"). §2 is the full inventory (grounded in a dedicated research pass across all 11 debugger tabs + both entity edit windows); §3 proposes concrete `p060` core amendments the inventory in §2 revealed are necessary (explicitly permitted by the request: "refactoring the undo engine core is allowed to suit the different types of edge cases"); §4 lists the actual recordable actions with their `actionType`/payload/handler shape; §5 is the full non-recordable report the request asked for.

---

## 1. Method

A dedicated research pass (four parallel deep-dives, one per debugger area) walked every `pane.add...(...)`/`.on('change'|'click', ...)` call and CMP-based button across:

- OnScreenTools (`src/_engine/debug/OnScreenTools.ts` + `src/_engine/core/Debug/_dbg__OnScreenTools.ts`)
- All 11 debugger drawer tabs: MainLoop, Renderer, Raycast, Stats, DebugTools, Physics, SkyBox, Camera, Light, ECS, Character
- Both entity edit windows that exist today: Camera edit window and Light edit window (both inside their tab's own file — there are no separate edit-window files)
- The Physics Object edit window and Character edit window (Rapier rigid-body position/rotation editors)

No generic ECS entity/component inspector exists anywhere (confirmed independently by this pass and by `p040`'s own research) — "edit windows" in this codebase means these four specific windows plus the ECS World edit window, not a generic per-entity editor.

**Note on `p040`** (`docs/plans/p040_light-and-camera-edit-window-persistence.md`): still `draft | not-implemented`. Its "Clear local storage" and "Delete camera/light" buttons **do not exist in the current codebase** — verified directly, not assumed. This plan therefore cannot catalog them as live UI; where relevant they're noted as anticipated/future elements with a provisional verdict, not scheduled into any phase here.

---

## 2. Full element inventory

### 2.1 Blanket exclusion categories (stated once, referenced by short tag below instead of repeating the reasoning per row)

| Tag                          | Rule                                                                                                                                                                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[RELOAD]**                 | Any control whose handler calls `location.reload()` or `window.location.href = ...`                                                                                                                 | Undo/redo state (the in-memory handler registry, the stack) lives in the JS heap. A reload/navigation destroys it. Nothing downstream of a reload can be undone in the same session — at best the persisted LS entries survive, but with zero handlers registered until re-registration on the next load.                                                                                                                                                                                       |
| **[COSMETIC]**               | Debug-visualization-only toggles (helper visibility, symbol visibility, debug ray/physics visualizer, `*FolderExpanded` fold state)                                                                 | No user/scene-data consequence — purely how the debugger _looks_, not what the scene _is_. Undoing "I expanded a folder" or "I hid a gizmo" has no product meaning.                                                                                                                                                                                                                                                                                                                             |
| **[NAV]**                    | List-row buttons that only open/close a window, or dropdowns that only pick what a window is inspecting                                                                                             | No state mutation at all — nothing to undo.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **[SESSION-ONLY]**           | Debugger session/workflow preferences (debug-start-scene selection, "use debugger scene loader", debug-camera fly position, which app camera the debug-cam returns to)                              | Not app/scene data — a preference for the _next_ debug session or the developer's own free-fly navigation, not something a redo/undo history should govern.                                                                                                                                                                                                                                                                                                                                     |
| **[DESTRUCTIVE-NO-INVERSE]** | Full entity/world teardown via `ECSWorld.deleteEntity`/a world's deletion, cascading through every registered `onDeleteEntity` hook (disposes live Three.js objects, physics bodies, GPU resources) | Reconstructing the deleted thing for redo needs a general "recreate entity/world from a serialized snapshot, replaying every creation side effect in order" primitive that doesn't exist anywhere in the engine. Out of scope for a payload-is-plain-data engine (`p060` §2.1) — would need its own, much larger initiative. Already session-only today (a page/scene reload restores it "for free" per `p040` §2.4), which is the reason this isn't a blocking gap, just an explicit non-goal. |
| **[DEV-TOOL]**               | Debug-only diagnostic/perf-testing actions with no real user-authored consequence (console-log buttons, toaster/dialog test buttons, ECS stress-test spawn/clear)                                   | Not user data by any definition — pure developer tooling, several explicitly marked `@TODO: REMOVE THESE!` in-repo.                                                                                                                                                                                                                                                                                                                                                                             |
| **[SCENE-BOUNDARY]**         | Anything that changes _which scene is current_ (scene-select dropdowns in OnScreenTools/DebugTools)                                                                                                 | This is the exact axis `p060`'s history is bucketed on (§2.3 there). Recording "switched scene A → B" under scene A's bucket, only reachable once B is current, is structurally incoherent with the per-scene design — not a simple cosmetic exclusion, a scoping conflict.                                                                                                                                                                                                                     |

### 2.2 Per-tool inventory

**OnScreenTools** (`src/_engine/debug/OnScreenTools.ts` thin + `core/Debug/_dbg__OnScreenTools.ts` impl) — every element excluded:

| Element                                     | File:line                        | Tag                                                                            |
| ------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| "Play/Stop in production test mode" buttons | `_dbg__OnScreenTools.ts:44-74`   | [RELOAD]-equivalent (full navigation)                                          |
| Main/App loop play-pause buttons            | `_dbg__OnScreenTools.ts:89-111`  | [SESSION-ONLY] (ephemeral run-state, not user data)                            |
| Debug/app camera toggle button              | `_dbg__OnScreenTools.ts:131-141` | [SESSION-ONLY]                                                                 |
| Camera-select dropdown                      | `_dbg__OnScreenTools.ts:176-193` | [SESSION-ONLY] (debugger view focus, not scene data — borderline, see §5 note) |
| Scene-select dropdown                       | `_dbg__OnScreenTools.ts:220-238` | [SCENE-BOUNDARY]                                                               |
| Light/Camera helper-toggle buttons          | `_dbg__OnScreenTools.ts:253-278` | [COSMETIC]                                                                     |
| Physics visualizer toggle                   | `_dbg__OnScreenTools.ts:281-297` | [COSMETIC] (persisted to LS, but still a visualization toggle, not user data)  |

**MainLoop tab** (`_dbg__MainLoop.ts`) — every element excluded:

| Element                                | File:line                 | Tag                                                                               |
| -------------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Master/App loop bindings               | `_dbg__MainLoop.ts:27-41` | [SESSION-ONLY]                                                                    |
| Forced max FPS / play speed multiplier | `_dbg__MainLoop.ts:42-60` | [SESSION-ONLY] + continuous-slider concern (moot since excluded on other grounds) |

**Renderer tab** (`_dbg__Renderer.ts`) — global scope (`debugRenderer` LS key is flat, not scene-keyed):

| Element                         | File:line                   | Verdict                                                                                                                                                             |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antialias / Force WebGL         | `_dbg__Renderer.ts:31-43`   | [RELOAD]                                                                                                                                                            |
| Device pixel ratio              | `_dbg__Renderer.ts:45-55`   | Excluded — continuous slider, niche perf knob, not worth the coalescing cost for a debug-only DPR override                                                          |
| **Tone mapping dropdown**       | `_dbg__Renderer.ts:57-77`   | **RECORDABLE** — see §4.1                                                                                                                                           |
| Tone mapping exposure           | `_dbg__Renderer.ts:79-89`   | Excluded — continuous fine-grained slider (see §3.2's coalescing amendment; deferred rather than wired in this pass to keep Renderer's phase small, see §6 Phase 2) |
| **Output color space dropdown** | `_dbg__Renderer.ts:91-106`  | **RECORDABLE** — see §4.1                                                                                                                                           |
| **Enable alpha**                | `_dbg__Renderer.ts:108-111` | **RECORDABLE** — see §4.1                                                                                                                                           |
| **Enable shadows**              | `_dbg__Renderer.ts:113-118` | **RECORDABLE** — see §4.1                                                                                                                                           |
| Shadow map type dropdown        | `_dbg__Renderer.ts:120-132` | [RELOAD]                                                                                                                                                            |

**Raycast tab** (`_dbg__Raycast.ts`) — every element excluded:

| Element                    | File:line                  | Tag                                              |
| -------------------------- | -------------------------- | ------------------------------------------------ |
| Show ray-cast helpers      | `_dbg__Raycast.ts:187-191` | [COSMETIC]                                       |
| Enable ray-cast statistics | `_dbg__Raycast.ts:192-208` | [COSMETIC]/[DEV-TOOL] (telemetry, not user data) |

**Stats tab** (`_dbg__Stats.ts`) — every element excluded, whole tab is [RELOAD]:

| Element                                                                         | File:line                | Tag                                   |
| ------------------------------------------------------------------------------- | ------------------------ | ------------------------------------- |
| Both folder-fold flags                                                          | `_dbg__Stats.ts:172-191` | [COSMETIC]                            |
| Enable measuring / Track GPU / Track Hz / Track CPT / Horizontal / Minimal look | `_dbg__Stats.ts:193-225` | [RELOAD] (all six reload immediately) |

**DebugTools tab** (`_dbg__DebugTools.ts`) — every currently-built element excluded:

| Element                                                                                                                     | File:line                     | Tag                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Scenes-listing folder + "Change scene" dropdown + "Use debug start scene"/"Start scene to load"/"Use debugger scene loader" | `_dbg__DebugTools.ts:190-243` | [SCENE-BOUNDARY] (dropdown) / [SESSION-ONLY] (the three checkboxes/dropdown that only affect what loads on next reload) |
| Helpers folder + all axes/grid/polar-grid helper toggles and sliders (13 controls)                                          | `_dbg__DebugTools.ts:246-398` | [COSMETIC] (all — pure scene-decoration helpers)                                                                        |
| Logging-actions folder + 4 log buttons                                                                                      | `_dbg__DebugTools.ts:401-445` | [DEV-TOOL] (no state mutated, console output only)                                                                      |
| Test draggable-window / dialog / 3 toaster buttons                                                                          | `_dbg__DebugTools.ts:448-493` | [DEV-TOOL] (explicitly `@TODO: REMOVE THESE!` scaffolding)                                                              |

Note: `DebugToolsState.env.*` and `.debugCamera`/`debugCameraFolderExpanded` fields exist in the type (`DebugToolsManager.ts:18-41`) but **are dead — `buildDebugToolsGUI()` builds no folder for either**. Nothing to catalog; flagged for whoever owns that tab, not an undo-plan concern.

> **STALE:** the legacy `PhysicsRapier.ts` (and the Physics tab it built) has been removed. Every `PhysicsRapier.ts:NNNN` reference in this table and in the §4.1 table below points at deleted code. The catalog was redone against `_dbg__PhysicsAPI.ts` during implementation — see "Implementation notes" at the end.

**Physics tab** (`PhysicsRapier.ts`) — mixed global/per-scene, first tab where the §3.1 scope amendment matters:

| Element                                                    | File:line                    | Scope     | Verdict                                                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Global timestep                                            | `PhysicsRapier.ts:1981-1986` | global    | Excluded — continuous + would need the global-scope amendment for a setting whose "undo" value (simulation rate) is borderline meaningful; deferred, not wired in this pass (see §6 risks) |
| Enable world step                                          | `PhysicsRapier.ts:1988-1999` | per-scene | [SESSION-ONLY]-equivalent (pause/resume, not user data)                                                                                                                                    |
| Enable visualizer                                          | `PhysicsRapier.ts:2000-2004` | per-scene | [COSMETIC]                                                                                                                                                                                 |
| **Gravity**                                                | `PhysicsRapier.ts:2005-2021` | per-scene | **RECORDABLE** — see §4.1                                                                                                                                                                  |
| **Solver iterations**                                      | `PhysicsRapier.ts:2022-2041` | per-scene | **RECORDABLE** — see §4.1                                                                                                                                                                  |
| **Internal PGS iterations**                                | `PhysicsRapier.ts:2042-2061` | per-scene | **RECORDABLE** — see §4.1                                                                                                                                                                  |
| Enable interpolation                                       | `PhysicsRapier.ts:2062-2066` | per-scene | [COSMETIC]-equivalent — rendering-smoothness preference, doesn't change simulation outcome                                                                                                 |
| Background behavior dropdown                               | `PhysicsRapier.ts:2067-2082` | global    | Excluded — engine-runtime/tab-visibility preference, not scene content, plus global-scope mismatch                                                                                         |
| Min/Max delta time, Min/Max sub-steps (4 sliders)          | `PhysicsRapier.ts:2083-2123` | global    | Excluded — timing/config knobs, same category as pause; "undo" is semantically weird for a simulation-timing parameter                                                                     |
| Physics-object list row buttons                            | `PhysicsRapier.ts:2308-2333` | —         | [NAV]                                                                                                                                                                                      |
| Physics Object edit window: console.log button             | `PhysicsRapier.ts:2202-2209` | —         | [DEV-TOOL]                                                                                                                                                                                 |
| Physics Object edit window: Delete button                  | `PhysicsRapier.ts:2210-2218` | —         | [DESTRUCTIVE-NO-INVERSE]                                                                                                                                                                   |
| **Physics Object edit window: "Set position" button**      | `PhysicsRapier.ts:2260-2265` | —         | **RECORDABLE** — see §4.1                                                                                                                                                                  |
| Physics Object edit window: "Update position input" button | `PhysicsRapier.ts:2266-2269` | —         | [NAV]-equivalent — pure read-back/refresh, no mutation                                                                                                                                     |
| **Physics Object edit window: "Set rotation" button**      | `PhysicsRapier.ts:2276-2283` | —         | **RECORDABLE** — see §4.1                                                                                                                                                                  |
| Physics Object edit window: "Update rotation input" button | `PhysicsRapier.ts:2284-2294` | —         | [NAV]-equivalent                                                                                                                                                                           |

**SkyBox tab** (`_dbg__SkyBox.ts`):

| Element                                                   | File:line                          | Verdict                                               |
| --------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| Both folder-fold flags                                    | `_dbg__SkyBox.ts:83-92, 223-231`   | [COSMETIC]                                            |
| All readonly bindings (type/file/textureId/colorSpace ×2) | `_dbg__SkyBox.ts:93-108, 154-178`  | N/A, not actionable                                   |
| **Equirect + cube-texture roughness sliders**             | `_dbg__SkyBox.ts:109-131, 179-201` | **RECORDABLE** (needs §3.2 coalescing) — see §4.1     |
| **Both "Reset [roughness]" buttons**                      | `_dbg__SkyBox.ts:132-141, 211-220` | **RECORDABLE** — see §4.1                             |
| **"Sky boxes in scene" dropdown**                         | `_dbg__SkyBox.ts:238-279`          | **RECORDABLE** — see §4.1, best candidate in this tab |

**Camera tab + Camera edit window** (`_dbg__CameraGUI.ts`, `_dbg__CameraHelpers.ts`, `_dbg__DebugCamera.ts`):

| Element                                                                  | File:line                     | Verdict                                                                                                                                         |
| ------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera list row button                                                   | `_dbg__CameraGUI.ts:239-256`  | [NAV]                                                                                                                                           |
| "Show Helper" toggle                                                     | `_dbg__CameraGUI.ts:86-99`    | [COSMETIC]                                                                                                                                      |
| **Position (x/y/z)**                                                     | `_dbg__CameraGUI.ts:134-140`  | **RECORDABLE** — already `ev.last`-gated, see §4.1                                                                                              |
| "Lens Settings" folder fold                                              | `_dbg__CameraGUI.ts:143-145`  | [COSMETIC]                                                                                                                                      |
| **Responsive Aspect checkbox**                                           | `_dbg__CameraGUI.ts:150-164`  | **RECORDABLE** — see §4.1                                                                                                                       |
| **Reference Aspect / Fov / Frustum Size / near / far**                   | `_dbg__CameraGUI.ts:165-219`  | **RECORDABLE** (needs §3.2 coalescing) — see §4.1                                                                                               |
| Debug fly-camera position/target/toggle                                  | `_dbg__DebugCamera.ts:40-155` | [SESSION-ONLY]                                                                                                                                  |
| (Anticipated, not implemented — `p040`) Clear LS / Delete camera buttons | —                             | Provisional: Clear-LS excluded (resetting a debug override has no coherent redo — nothing to redo _to_); Delete camera [DESTRUCTIVE-NO-INVERSE] |

**Light tab + Light edit window** (`_dbg__LightGUI.ts`, `_dbg__LightHelpers.ts`):

| Element                                                                 | File:line                            | Verdict                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Light list row button                                                   | `_dbg__LightGUI.ts:601-620`          | [NAV]                                                                                                                     |
| `_toggleAllLightHelpers` (global helper toggle)                         | `_dbg__LightGUI.ts:653-692`          | [COSMETIC]                                                                                                                |
| **Enabled checkbox**                                                    | `_dbg__LightGUI.ts:222-226`          | **RECORDABLE** — see §4.1                                                                                                 |
| "Show Helper" / "Show Symbol" toggles                                   | `_dbg__LightGUI.ts:229-249`          | [COSMETIC]                                                                                                                |
| **Sky Color / Ground Color / Color**                                    | `_dbg__LightGUI.ts:259-287`          | **RECORDABLE** (needs §3.2 coalescing) — see §4.1                                                                         |
| **Intensity / Distance / Decay**                                        | `_dbg__LightGUI.ts:292-310`          | **RECORDABLE** (needs §3.2 coalescing) — see §4.1                                                                         |
| **Frustum Culling checkbox**                                            | `_dbg__LightGUI.ts:312-321`          | **RECORDABLE** — see §4.1                                                                                                 |
| **Position / Target Position**                                          | `_dbg__LightGUI.ts:323-359`          | **RECORDABLE** — already `ev.last`-gated, see §4.1 (Target Position needs the target entity's own stable id, see §5 risk) |
| **Cast Shadow checkbox**                                                | `_dbg__LightGUI.ts:362-372`          | **RECORDABLE** — see §4.1                                                                                                 |
| "Shadow"/"Shadow Camera" folder folds                                   | `_dbg__LightGUI.ts:374-376, 473-478` | [COSMETIC]                                                                                                                |
| **Shadow Bias / Normal Bias / Intensity / Blur Samples / Radius**       | `_dbg__LightGUI.ts:378-421`          | **RECORDABLE** (needs §3.2 coalescing, especially Bias's very fine step) — see §4.1                                       |
| **Shadow map width / height dropdowns**                                 | `_dbg__LightGUI.ts:423-471`          | **RECORDABLE** — see §4.1 (needs `refreshLightShadows` replay, not a bare property set)                                   |
| **Shadow camera Near/Far (tuple)**                                      | `_dbg__LightGUI.ts:481-500`          | **RECORDABLE** (needs §3.2 coalescing + whole-tuple payload) — see §4.1                                                   |
| **Ortho Left/Right/Top/Bottom (4-tuple)**                               | `_dbg__LightGUI.ts:507-553`          | **RECORDABLE** (needs §3.2 coalescing + whole-tuple payload) — see §4.1                                                   |
| (Anticipated, not implemented — `p040`) Clear LS / Delete light buttons | —                                    | Same provisional verdict as Camera's, Delete additionally cascades to the linked target entity                            |

**ECS tab + ECS World edit window** (`_dbg__ECS.ts`, `ECSComponentStorage.ts`) — every element excluded:

| Element                                                        | File:line              | Tag                                               |
| -------------------------------------------------------------- | ---------------------- | ------------------------------------------------- |
| World list row buttons                                         | `_dbg__ECS.ts:260-279` | [NAV]                                             |
| Storage mode dropdown / Max entities input                     | `_dbg__ECS.ts:107-130` | [RELOAD]                                          |
| Delete world button                                            | `_dbg__ECS.ts:132-140` | [DESTRUCTIVE-NO-INVERSE]                          |
| Batch size input                                               | `_dbg__ECS.ts:224-230` | N/A — inert staging value, no mutation of its own |
| Spawn individual / Spawn instanced / Clear stress-test buttons | `_dbg__ECS.ts:232-246` | [DEV-TOOL]                                        |

**Character tab** (`_dbg__Character.ts`):

| Element                                     | File:line                    | Verdict                                                  |
| ------------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| Character list row buttons                  | `_dbg__Character.ts:243-268` | [NAV]                                                    |
| "Open data tracker" / "Console-log" buttons | `_dbg__Character.ts:119-145` | [NAV]/[DEV-TOOL]                                         |
| Delete character button                     | `_dbg__Character.ts:146-155` | [DESTRUCTIVE-NO-INVERSE]                                 |
| Position/rotation staging bindings          | `_dbg__Character.ts:193-211` | N/A — inert staging values                               |
| **"Set position" button**                   | `_dbg__Character.ts:196-201` | **RECORDABLE** — see §4.1 (physics-continues caveat, §5) |
| "Update position input" button              | `_dbg__Character.ts:202-205` | [NAV]-equivalent                                         |
| **"Set rotation" button**                   | `_dbg__Character.ts:212-219` | **RECORDABLE** — see §4.1                                |
| "Update rotation input" button              | `_dbg__Character.ts:220-230` | [NAV]-equivalent                                         |

---

## 3. Required amendments to the `p060` engine core

The inventory in §2 surfaced two structural gaps in `p060`'s design that must be fixed before any real wiring — both explicitly permitted ("refactoring the undo engine core is allowed to suit the different types of edge cases").

### 3.1 Per-actionType scope (global vs. per-scene)

`p060` §2.3 buckets every entry by `getCurrentSceneId() ?? '_global'`, treating `'_global'` only as a fallback for "no scene is loaded yet." But §2's inventory found genuinely **global** recordable actions (Renderer's tone mapping/color space/alpha/shadows — `debugRenderer` is a flat, non-scene-keyed LS key) that apply regardless of which scene happens to be current. Bucketing a Renderer change into whichever scene happens to be loaded at record time would make it only "undoable while that particular scene remains loaded" — wrong, since the setting isn't scene data at all.

**Amendment**: `registerUndoRedoActionHandler` gains a third parameter, `scope: 'perScene' | 'global'` (default `'perScene'`):

```ts
export const _registerUndoRedoActionHandler = <TPayload>(
  actionType: string,
  handler: UndoRedoActionHandler<TPayload>,
  scope: 'perScene' | 'global' = 'perScene'
) => {
  actionHandlers.set(actionType, { ...handler, scope });
};
```

`_recordUndoRedoAction`/`_undoLastAction`/`_redoLastAction` resolve the bucket as `handler.scope === 'global' ? '_global' : (getCurrentSceneId() ?? '_global')` — i.e. `'_global'` becomes a real, permanent bucket for global actions, not just a transient fallback. This only affects `_dbg__UndoRedo.ts`; the LS shape (`p060` §2.3) already supports an arbitrary string key so `'_global'` fits without a schema change.

### 3.2 Coalescing continuous (drag/slider) actions

§2's inventory found this is the dominant shape across the debugger: the large majority of RECORDABLE fields are Tweakpane numeric/color sliders that fire `on('change')` on every drag tick, not just on release. Two different situations exist in the current code:

- **Vector/point3 bindings already self-gate**: Camera/Light Position and Target Position handlers check `if (!ev.last) return` before persisting (`_dbg__CameraGUI.ts:135`, `_dbg__LightGUI.ts:328`/`348`) — Tweakpane's point binding marks only the final event of a drag gesture `last: true`. These need no new engine support; `recordUndoRedoAction` can be called directly inside the existing `ev.last` branch.
- **Plain number/color bindings have no such gate.** FOV, near/far, intensity, distance/decay, every shadow scalar, gravity, solver iterations, roughness sliders, etc. would call `recordUndoRedoAction` on every intermediate tick without a new mechanism — flooding the stack with one entry per pixel of drag and burning through `historySize` almost instantly.

**Amendment**: add a coalescing entry point, used only by continuous fields, alongside the existing one-shot `_recordUndoRedoAction`:

```ts
export const _recordOrCoalesceUndoRedoAction = <TPayload extends { prev: unknown; next: unknown }>(
  actionType: string,
  label: string,
  payload: TPayload,
  coalesceKey: string, // e.g. `${appId}.${fieldName}` — identifies "the same drag gesture's target"
  coalesceWindowMs = 800
) => {
  const bucket = /* resolve per §3.1 */;
  const top = bucket.entries[bucket.pointer];
  if (top?.actionType === actionType && top?.coalesceKey === coalesceKey &&
      Date.now() - top.timestamp < coalesceWindowMs) {
    // still the same gesture: update in place, keep the original `prev`, refresh `next` + timestamp
    top.payload = { ...top.payload, next: payload.next };
    top.timestamp = Date.now();
  } else {
    _recordUndoRedoAction(actionType, label, payload); // new gesture: normal push
  }
  persist();
};
```

A time-window heuristic (not a Tweakpane "drag end" event — no such event exists uniformly for plain number bindings in this codebase) closes an entry once `coalesceWindowMs` passes without another tick for the same field — in practice, once the user stops dragging/typing. `UndoRedoEntry` gains an optional `coalesceKey?: string` field (still plain JSON-serializable). Every RECORDABLE continuous field in §4.1 uses this entry point instead of `_recordUndoRedoAction`; every discrete one (checkboxes, dropdowns, buttons, `ev.last`-gated vectors) keeps using the plain one-shot call.

### 3.3 Entity-identity guard (no core change — a call-site convention)

Per `_dbg__CameraGUI.ts:331`/`_dbg__LightGUI.ts:813`, `saveCameraToLS`/`saveLightToLS` only persist when the entity's `APP_ID` component has `isFixed: true` — auto-generated ids aren't stable across a reload. Since `p060`'s history persists across reloads (its whole point) but handlers only exist in-memory and must re-resolve the _current_ entity by id at undo/redo time (never a captured reference, per `p060` §2.1), **only entities with `isFixed` app ids are safe to record at all** — an auto-generated id can't be reliably re-resolved after a reload reconstructs the scene from `generatedAppData.json`. Every Camera/Light/Physics-Object/Character handler in §4.1 gates recording on this exact condition, mirroring the existing LS-persistence gate rather than inventing a new one. No `p060` core change needed — this is a call-site rule, stated once here so it isn't rediscovered per field during implementation.

---

## 4. Recordable actions

### 4.1 Action catalog

`actionType` uses a `<domain>.<field>` dot convention. `scope` per §3.1; unmarked = `perScene`. Coalescing (§3.2) marked "coalesced." Payloads below are sketches, not final field names — implementation should match each file's actual existing types (`CamEntityDebugState`, `LightEntityDebugState`, etc.).

| actionType                                                                                         | Source                             | scope    | Coalesced?                                 | Payload sketch                                         | Handler notes                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ---------------------------------- | -------- | ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `renderer.toneMapping`                                                                             | `_dbg__Renderer.ts:57-77`          | global   | no                                         | `{prev, next}` (enum)                                  | `undo/redo`: `r.toneMapping = value`                                                                                                            |
| `renderer.outputColorSpace`                                                                        | `_dbg__Renderer.ts:91-106`         | global   | no                                         | `{prev, next}` (string enum)                           | same shape                                                                                                                                      |
| `renderer.alpha`                                                                                   | `_dbg__Renderer.ts:108-111`        | global   | no                                         | `{prev, next}` (bool)                                  | same shape                                                                                                                                      |
| `renderer.shadowsEnabled`                                                                          | `_dbg__Renderer.ts:113-118`        | global   | no                                         | `{prev, next}` (bool)                                  | same shape                                                                                                                                      |
| `camera.position`                                                                                  | `_dbg__CameraGUI.ts:134-140`       | perScene | no (already `ev.last`-gated)               | `{appId, prev:{x,y,z}, next:{x,y,z}}`                  | resolve entity via `getEntityIdByAppId(appId)` at apply time; gate on §3.3                                                                      |
| `camera.responsiveAspect`                                                                          | `_dbg__CameraGUI.ts:150-164`       | perScene | no                                         | `{appId, prev, next}` (bool)                           | must also call `applyCameraProjection` + the same delayed GUI rebuild the original handler does                                                 |
| `camera.referenceAspect`                                                                           | `_dbg__CameraGUI.ts:165-175`       | perScene | **yes**                                    | `{appId, prev, next}` (number)                         | + `applyCameraProjection`                                                                                                                       |
| `camera.fov`                                                                                       | `_dbg__CameraGUI.ts:177-196`       | perScene | **yes**                                    | `{appId, prev, next}` (number)                         | must replicate the existing `responsiveAspect`-branching logic (writes to `camera.fov` or `settings.fov` depending on mode)                     |
| `camera.frustumSize`                                                                               | `_dbg__CameraGUI.ts:198-210`       | perScene | **yes**                                    | `{appId, prev, next}`                                  | + `applyCameraProjection`                                                                                                                       |
| `camera.near` / `camera.far`                                                                       | `_dbg__CameraGUI.ts:212-219`       | perScene | **yes**                                    | `{appId, prev, next}`                                  | + `camera.updateProjectionMatrix()`                                                                                                             |
| `light.enabled`                                                                                    | `_dbg__LightGUI.ts:222-226`        | perScene | no                                         | `{appId, prev, next}` (bool)                           | `setLightEnabled`                                                                                                                               |
| `light.color` / `light.skyColor` / `light.groundColor`                                             | `_dbg__LightGUI.ts:259-287`        | perScene | **yes**                                    | `{appId, prev, next}` (hex/number)                     | direct property set + LS write                                                                                                                  |
| `light.intensity` / `light.distance` / `light.decay`                                               | `_dbg__LightGUI.ts:292-310`        | perScene | **yes**                                    | `{appId, prev, next}`                                  | direct property set                                                                                                                             |
| `light.frustumCullingEnabled`                                                                      | `_dbg__LightGUI.ts:312-321`        | perScene | no                                         | `{appId, prev, next}` (bool)                           | `setLightFrustumCullingEnabled`                                                                                                                 |
| `light.position`                                                                                   | `_dbg__LightGUI.ts:323-341`        | perScene | no (already `ev.last`-gated)               | `{appId, prev:{x,y,z}, next:{x,y,z}}`                  | `world.setTransform` + helper `.update()`                                                                                                       |
| `light.targetPosition`                                                                             | `_dbg__LightGUI.ts:343-359`        | perScene | no (already `ev.last`-gated)               | `{appId, targetEntityRef, prev:{x,y,z}, next:{x,y,z}}` | **only recordable if the target entity itself has a stable, resolvable reference** — verify at implementation time (§5 risk)                    |
| `light.castShadow`                                                                                 | `_dbg__LightGUI.ts:362-372`        | perScene | no                                         | `{appId, prev, next}` (bool)                           | must replay `reconcileDebugVisuals` + the delayed `updateDraggableWindow`                                                                       |
| `light.shadowBias` / `shadowNormalBias` / `shadowIntensity` / `shadowBlurSamples` / `shadowRadius` | `_dbg__LightGUI.ts:378-421`        | perScene | **yes** (Bias especially — very fine step) | `{appId, prev, next}`                                  | direct `.shadow.*` property set                                                                                                                 |
| `light.shadowMapSize`                                                                              | `_dbg__LightGUI.ts:423-471`        | perScene | no                                         | `{appId, prev:{w,h}, next:{w,h}}`                      | **must call `refreshLightShadows` again**, not a bare property set — it swaps the live Three.js light object and re-attaches helpers            |
| `light.shadowCameraNearFar`                                                                        | `_dbg__LightGUI.ts:481-500`        | perScene | **yes**                                    | `{appId, prev:[near,far], next:[near,far]}`            | whole tuple, not a scalar — LS/state stores near+far as one pair                                                                                |
| `light.shadowCameraFrustum`                                                                        | `_dbg__LightGUI.ts:507-553`        | perScene | **yes**                                    | `{appId, prev:[l,r,t,b], next:[l,r,t,b]}`              | whole 4-tuple, same reasoning                                                                                                                   |
| `physics.gravity`                                                                                  | `PhysicsRapier.ts:2005-2021`       | perScene | **yes**                                    | `{sceneId, prev:{x,y,z}, next:{x,y,z}}`                | set `curScenePhysParams.gravity` + live `physicsWorld.gravity` + wake bodies                                                                    |
| `physics.solverIterations` / `physics.internalPgsIterations`                                       | `PhysicsRapier.ts:2022-2061`       | perScene | **yes**                                    | `{sceneId, prev, next}`                                | set per-scene param + live Rapier world property + wake bodies                                                                                  |
| `physicsObject.position`                                                                           | `PhysicsRapier.ts:2260-2265`       | perScene | no (explicit button click, not a drag)     | `{physObjectId, prev:{x,y,z}, next:{x,y,z}}`           | re-resolve `rigidBody` via `getPhysicsObject(physObjectId)` at apply time, not a captured handle; no-op+warn if the object no longer exists     |
| `physicsObject.rotation`                                                                           | `PhysicsRapier.ts:2276-2283`       | perScene | no                                         | `{physObjectId, prev, next}`                           | same resolution pattern                                                                                                                         |
| `character.position`                                                                               | `_dbg__Character.ts:196-201`       | perScene | no                                         | `{characterId, prev:{x,y,z}, next:{x,y,z}}`            | re-resolve character's rigid body at apply time                                                                                                 |
| `character.rotation`                                                                               | `_dbg__Character.ts:212-219`       | perScene | no                                         | `{characterId, prev, next}`                            | same                                                                                                                                            |
| `skybox.roughness`                                                                                 | `_dbg__SkyBox.ts:109-131, 179-201` | perScene | **yes**                                    | `{sceneId, skyboxId, kind:'equirect'                   | 'cube', prev, next}`                                                                                                                            | set `allSkyBoxStates[...].{equiRectRoughness | cubeTextRoughness}` + live TSL uniform + LS |
| `skybox.resetRoughness`                                                                            | `_dbg__SkyBox.ts:132-141, 211-220` | perScene | no                                         | same shape as above, `next` = `defaultRoughness`       | same handler as `skybox.roughness`, reusable                                                                                                    |
| `skybox.select`                                                                                    | `_dbg__SkyBox.ts:238-279`          | perScene | no                                         | `{sceneId, prevSkyBoxId, nextSkyBoxId}`                | re-invoke `createSkyBox(extractSkyBoxParamsFromState(...))` or `deleteCurrentSkyBox()` for the "no skybox" case, resolved by id fresh each time |

### 4.2 Not wired in this pass despite being technically recordable

A few fields are RECORDABLE by the same criteria as §4.1 but are deliberately left out of the phased rollout (§6) to keep phases reviewable — flagged so they aren't mistaken for an oversight:

- Renderer's **tone mapping exposure** and **device pixel ratio** — continuous, niche debug-only knobs; lower value than the four Renderer actions already in §4.1.
- Physics's **global timestep** — continuous, and its "undo" value (simulation rate) is a genuinely borderline case (§2's Physics tab table); left out pending a decision on whether global perf/timing knobs belong in undo history at all.

---

## 5. Risks and open questions (including the explicit non-recordable report)

The full non-recordable inventory is §2.2 (organized per tool, tagged by category) — this table covers cross-cutting risks and judgment calls that don't reduce to a single tag.

| Risk / question                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.1/§3.2 are real amendments to an already-drafted core plan.                                               | `p060` ships before this plan (per `Blocked by`), so by the time this plan is implemented, `_dbg__UndoRedo.ts` will need to be revisited, not just extended additively — `scope` changes the bucket-resolution logic in `_recordUndoRedoAction`/`_undoLastAction`/`_redoLastAction`, and coalescing adds a new stack-mutation code path. Both are called out as necessary in §3, not proposed speculatively — the request explicitly allows this.                                                                                                                                                                                                                                                                                              |
| `light.targetPosition`'s target entity may not have a stable, `isFixed` app id of its own.                   | Per `_dbg__LightGUI.ts`, a spot/directional light's target is a _separate_ ECS entity reached via `TARGET_LINK`, not necessarily authored with its own stable id the way the light itself is. If it isn't `isFixed`, this action can't satisfy §3.3's re-resolution requirement across a reload — confirm at implementation time; if unresolvable, this action should be demoted to session-only-undo (still record it, but document that a reload breaks the redo/undo chain for it specifically) rather than excluded outright.                                                                                                                                                                                                              |
| Camera/Light/Physics-Object/Character **Delete** buttons are the clearest "wanted but not deliverable" case. | All four are architecturally identical: a hook-driven teardown of live Three.js/physics/GPU resources with no snapshot taken anywhere (`[DESTRUCTIVE-NO-INVERSE]`, §2.1). A correct inverse needs a general "recreate entity from a serialized snapshot, replaying every creation side effect (mesh, physics body, helpers, tags, input bindings) in the original order" — that's a materially larger feature than this plan (arguably its own future plan, e.g. "entity snapshot/restore primitive"), not something to half-build here. Recommend confirming this scope cut is acceptable before implementation starts, since "go through each actionable UI element and try to implement it" could be read as expecting these to be covered. |
| `p040`'s Clear-LS/Delete buttons don't exist yet.                                                            | This plan's provisional verdicts for them (§2.2, Camera/Light rows) are forward-looking guesses, not verified against real code. If `p040` lands before or during this plan's implementation, re-verify those two verdicts against the actual button implementation rather than trusting the guess here.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SkyBox/Light/Physics coalescing (§3.2) uses a time-window heuristic, not a real "gesture end" signal.        | Tweakpane doesn't expose a uniform drag-start/drag-end event for plain number/color bindings (only point3/vector bindings get `ev.last`). An 800ms idle-window is a reasonable default but arbitrary — worth tuning once real usage is observed (too short: still splits one drag into two entries; too long: two separate quick edits to the same field get wrongly merged into one).                                                                                                                                                                                                                                                                                                                                                         |
| Physics-object/Character position "Set" buttons only teleport position, not velocity/momentum.               | Per the Physics-tools research: the simulation keeps running every frame, so `undo` snapping a rigid body back to its previous transform doesn't restore the velocity/angular-velocity it had at that instant — the body may immediately resume moving/falling in a way that isn't a true rollback. Not a reason to exclude it (it's still the best available inverse), just a documented limitation.                                                                                                                                                                                                                                                                                                                                          |
| Renderer's four RECORDABLE actions are the first real exercise of the `scope: 'global'` amendment (§3.1).    | If `p060` ships without anticipating this (i.e., if its author doesn't read this plan before finishing `p060`), the amendment lands as a breaking-ish change to `_dbg__UndoRedo.ts`'s internal bucket-resolution — flagged so it's a planned revisit, not a surprise regression during this plan's Phase 1 (§6).                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 6. Phased rollout

- **Phase 1 — Core amendments.** Implement §3.1 (`scope` param + bucket resolution) and §3.2 (`_recordOrCoalesceUndoRedoAction` + `coalesceKey`/time-window logic) in `_dbg__UndoRedo.ts` (+ thin-layer mirrors in `debug/UndoRedo.ts`), plus the shared §3.3 `isFixed`-app-id guard helper. No tab is wired yet. Manual verification: exercise both new API paths directly (browser console) — confirm a `scope:'global'` entry lands in the `'_global'` bucket regardless of current scene, and confirm two rapid coalescing calls with the same `coalesceKey` collapse into one entry while a call after `coalesceWindowMs` starts a new one.
- **Phase 2 — Renderer tab (global scope).** Wire the four Renderer actions (§4.1). Smallest, simplest, proves out `scope:'global'` end-to-end. Manual verification: change tone mapping → confirm one `_global`-bucket entry regardless of which scene is loaded; switch scenes and confirm the entry is still reachable (global bucket, not tied to the scene that was current at record time).
- **Phase 3 — Camera edit window.** Wire all six Camera actions (§4.1), including the first real use of `_recordOrCoalesceUndoRedoAction` (FOV/near/far/frustumSize/referenceAspect) alongside the already-gated Position action. Manual verification: drag FOV continuously, confirm exactly one history entry per drag gesture (not one per tick); toggle Responsive Aspect, confirm projection reapplies correctly on undo.
- **Phase 4 — Light edit window.** Largest phase — wire all Light actions in §4.1, including the shadow-map-size `refreshLightShadows`-replay case and the two tuple-payload shadow-camera actions. Manual verification per field category: booleans (Enabled/FrustumCulling/CastShadow), colors/scalars (coalescing), the two tuple fields (confirm undo restores the _whole_ tuple, not just the touched scalar), and shadow map width/height (confirm helpers/camera aspect stay consistent after undo, not just the raw size value).
- **Phase 5 — Physics tab + Physics Object edit window.** Wire Gravity/Solver-iterations/Internal-PGS-iterations (per-scene, coalesced) and the Set-position/Set-rotation buttons. Manual verification: drag gravity, confirm one coalesced entry; undo a Set-position click, confirm the rigid body teleports back (and note in review that velocity isn't restored, per §5).
- **Phase 6 — Character edit window.** Wire Set-position/Set-rotation, same shape and same caveat as Phase 5's physics-object actions. Manual verification: same as Phase 5.
- **Phase 7 — SkyBox tab.** Wire both roughness sliders (coalesced), both Reset buttons, and the skybox-select dropdown. Manual verification: drag roughness, confirm coalescing; select a different skybox then undo, confirm the previous skybox's background/environment nodes are restored via `createSkyBox`, not a stale reference.

No phase is scheduled for MainLoop, Raycast, Stats, DebugTools, ECS, or OnScreenTools — every element in those areas was excluded in §2 (Stats/ECS storage/DebugTools' scene controls are `[RELOAD]`/`[SCENE-BOUNDARY]`; the rest are `[COSMETIC]`/`[DEV-TOOL]`/`[SESSION-ONLY]`/`[NAV]`). This is a deliberate, reasoned "zero phases" outcome, not an omission.

---

## Implementation notes

Implemented in seven phases: Phases 1–6 in `f27e0be`..`c421d21`, Phase 7 in the commit that
renamed this plan to `_DONE_`. The plan body above is the original draft; where it differs from
the code, these notes are what shipped.

### What shipped

| Action types                                                                                                                                                                                                      | Source                                  | Scope     | Recording                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------- | --------------------------------------- |
| `renderer.toneMapping` / `outputColorSpace` / `alpha` / `enableShadows`                                                                                                                                           | `_dbg__Renderer.ts`                     | global    | one per change                          |
| `camera.position` / `responsiveAspect`                                                                                                                                                                            | Camera edit window                      | per scene | one per change (`ev.last` for position) |
| `camera.referenceAspect` / `fov` / `frustumSize` / `near` / `far`                                                                                                                                                 | Camera edit window                      | per scene | coalesced                               |
| `light.enabled` / `frustumCullingEnabled` / `objectCullingEnabled` / `position` / `targetPos` / `castShadow` / `shadowMapSize`                                                                                    | Light edit window                       | per scene | one per change                          |
| `light.color` / `groundColor` / `intensity` / `distance` / `decay` / `shadowBias` / `shadowNormalBias` / `shadowIntensity` / `shadowBlurSamples` / `shadowRadius` / `shadowCameraNearFar` / `shadowCameraFrustum` | Light edit window                       | per scene | coalesced                               |
| `physics.gravity`                                                                                                                                                                                                 | Physics API tab                         | global    | once per drag (`ev.last`)               |
| `physics.solverIterations` / `internalPgsIterations`                                                                                                                                                              | Physics API tab                         | global    | coalesced                               |
| `physicsObject.position` / `rotation`                                                                                                                                                                             | Physics entity edit window, Set buttons | per scene | one per click                           |
| `character.position` / `rotation`                                                                                                                                                                                 | Character edit window, Set buttons      | per scene | one per click                           |
| `skybox.roughness`                                                                                                                                                                                                | SkyBox tab sliders                      | per scene | coalesced                               |
| `skybox.resetRoughness` / `skybox.select`                                                                                                                                                                         | SkyBox tab Reset buttons / dropdown     | per scene | one per click / change                  |

Every handler is registered at module load (the `_dbg__` files import `_dbg__UndoRedo.ts`
directly, as p060's notes suggested) and resolves its target when it runs: cameras, lights and
physics entities by stable app id, characters by character id, sky boxes by scene + sky box id.
A target that no longer exists is skipped with a warning and the entry still counts as applied,
so one deleted entity can't block the rest of the history. Handlers mirror what the control
itself does (apply, save to the tab's LS key) and then refresh or rebuild the tab/window; a pane
refresh that would fire `change` again is guarded so it doesn't re-record.

### How it was verified

No test runner exists, so every phase was checked with a throwaway headless Playwright script
(`playwright-core` from `.claude/skills/run-aekasha-js/`) against `yarn dev` with
`?isDebug=true`, driving the real Tweakpane controls (including real mouse drags on number
knobs to check coalescing) and asserting the live objects, the tab's LS key, the pane and the
history, across scene switches and reloads. Practical notes for the next person doing this:

- Import engine modules through the exact URL the page loaded
  (`performance.getEntriesByType('resource')`) — Vite adds `?t=` after invalidations, and a bare
  path gives a second, empty module instance.
- CMP ids are not DOM ids (only with `idAttr`); find tabs by their `title` and controls by
  their Tweakpane label text.
- Open the debug drawer (`h`) before any mouse drag on a drawer tab — closed, its controls have
  no layout.

### Where the implementation departs from this plan

- **Undo/redo walk one merged timeline (§3.1 left this open).** `scope` decides which bucket an
  entry is stored in; undo reverts the newest applied entry across the current scene's bucket
  and `'_global'`, redo reapplies the oldest undone one, and recording drops the redo tail of
  both. Entry timestamps are kept strictly increasing because they order the timeline.
  `getUndoRedoHistory()` now returns that merged list, each entry marked with `scope` and
  `applied`, instead of `{ entries, pointer }` (one pointer can't describe two buckets).
- **Coalescing is stricter than §3.2's sketch.** A tick only merges into the newest entry of the
  whole timeline, and only while nothing is undone; the first tick's label is kept. Scalars
  whose control is a point binding (camera/light position, gravity) record on `ev.last`
  instead.
- **§3.3's helper already existed** privately in `_dbg__PhysicsDebugDraw.ts`; it moved to
  `ECS.ts` as `getStableAppId(entityId, world?)`, next to `getEntityIdByAppId`.
- **Renderer:** the shadows action is `renderer.enableShadows` (every type is
  `renderer.<option key>`).
- **Light:** the Object Culling checkbox (not in §2's inventory) is recorded too. §5's
  target-position risk didn't apply: the handler finds the light by its stable id and follows its
  current `TARGET_LINK`, so the target entity needs no stable id of its own.
- **Physics (catalog redone against `_dbg__PhysicsAPI.ts`):** there's one physics world with
  one global state under the flat `AEK_debugPhysicsApi` key, so gravity and the iteration counts
  are `global`, not per scene. Excluded: the four boot-time controls (`setBootOverride` reloads),
  the interpolation mode and wireframe pose dropdowns and the whole Wireframe folder (cosmetic),
  per-entity wireframe controls (cosmetic), console-log (dev tool), Delete (no inverse), the
  "Update … input" buttons and read-only readouts, plus everything §2/§4.2 already excluded
  (timestep, world step, background behaviour, delta times, sub-steps). Physics entities are
  recorded only when they have a stable app id.
- **Character:** character ids are always app-supplied, so no stable-id guard is needed.
- **SkyBox:** `skybox.select` stores sky box ids (including `NO_SKYBOX_ID`). The dropdown choice
  is session-only by design — on load `createSkyBox` takes `isCurrent` from the scene code —
  so a reload shows the scene default again; the history still undoes/redoes across it.
- **`p040` had landed** by implementation time: Delete camera/light exist and stay unrecorded
  ([DESTRUCTIVE-NO-INVERSE], as §2 provisioned). The Assets and SpatialGrid tabs postdate §2's
  inventory and were not reviewed or wired.

### Pre-existing bugs fixed along the way

- **Camera/light debug props restored against the wrong scene.** `loadScene` creates cameras
  (and scene init code creates lights) before `setCurrentScene`, so `loadPersistentProps` read
  the previous scene's LS data or none. `PropertyLoader.ts` now reads the loading scene
  (`getNextSceneId() ?? getCurrentSceneId()`).
- **Camera fov slider.** It was bound to the live `camera.fov`: non-responsive edits reverted on
  resize (`applyCameraProjection` derives fov from `settings.fov`), and in responsive mode it
  showed the derived fov while storing it as the base. It's now bound to a proxy of
  `settings.fov`, like Frustum Size.
- **Directional shadow frustum stretch.** `refreshLightShadows` widened the ortho bounds by the
  map aspect on every shadow-map-size change (compounding, and never saved, so a reload dropped
  it). Removed: the frustum is `shadowCameraFrustum` as authored, same as `createLightEntity`.
- **SkyBox tab.** The tab was built from the boot-time state objects (`createSkyBox` replaces
  them), so it showed "[No skybox]" and stale folders; it now uses the latest ones `SkyBox.ts`
  passes. The roughness sliders wrote a local uniform nothing rendered with; they now write
  `getEnvMapRoughnessBg()`. `debuggerCreated` is set before the tab is created so the tab's own
  build can't re-enter it.

### Known limitations

- Physics-object and character pose undo restores the pose only; velocity isn't rolled back, and
  anything driving the body keeps doing so (e.g. `thirdPersonGym`'s `dummyCharLooper`, or the
  `sideWaysPlatform` next to `topDownChar`'s spawn point).
- Undo doesn't refresh the staged position/rotation fields of those two windows (the Set buttons
  don't either; the "Update … input" buttons still work).
- Entities with generated app ids aren't recorded (they can't be found again after a reload).
- The 800 ms coalescing window is still an untuned default.

### Notes for p062

- One Undo/Redo button pair and one shortcut pair fit the merged timeline; `canUndo()` /
  `canRedo()` already look at both the scene and the global bucket.
- p062 §2.1 calls `updateOnScreenTools('UNDO')` from every record/undo/redo path.
  `_recordOrCoalesceUndoRedoAction` runs on every drag tick and OnScreenTools rebuilds fully on
  update, so refresh only when `canUndo()`/`canRedo()` actually change.
- `historySize` is enforced per bucket, so the merged history can hold up to twice that many
  entries (scene + global).
- `getUndoRedoHistory()`'s shape changed (above); p062 doesn't use it.
- Undo from a key binding must not run while a Tweakpane input has focus (p062 §2.3's
  `isTypingInField()` guard) — several handlers rebuild the pane the user would be typing in.
