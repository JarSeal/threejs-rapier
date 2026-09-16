Status: draft | not-implemented
Category: Debugger

# Clear Local Storage Buttons for Each Debugger Tab — Plan

Adds two small square icon buttons, placed next to each debugger tab's title, that let a user reset that tab's persisted debug-drawer localStorage state without opening DevTools: **"Clear local storage data for this tab"** (clears the tab's own single/shared state) and, only for tabs that present a list of multiple named items (cameras, lights, ECS worlds, skyboxes, characters), **"Clear local storage data for all items in this list"** (clears every item's entry). Both buttons are disabled whenever there is nothing to clear.

This is a different, complementary feature to `docs/plans/p040_light-and-camera-edit-window-persistence.md` — that plan adds a Clear button *inside* a single camera/light's own edit window (per-entity); this plan adds bulk-clear buttons at the *tab* level (top of each debugger tab, next to its title), covering all 11 debugger tabs, not just Camera/Light.

---

## 1. Goal

- Every debugger tab gets a **"Clear this tab"** icon button next to its title. Clicking it wipes whatever localStorage data belongs to that tab, except any per-item list (see below). Disabled when there's nothing stored for that tab.
- Tabs that present a **list of named items** (Camera, Light, ECS World, SkyBox, Character) additionally get a **"Clear all items in this list"** icon button. Clicking it wipes every item's stored entry (scoped to the current scene, where the data is scene-scoped). Disabled when the list has no stored entries.
- New SVG icons for both buttons, and new CSS for square icon buttons that sit next to a tab title — visually distinct from the existing tab-switcher buttons (`.debugDrawerTabButton` in `DebuggerGUI.module.scss`) so they can't be confused with them.

---

## 2. Current state (grounded in the actual code)

### 2.1 Every debugger tab, its localStorage key(s), and whether it has a list

All tabs are registered via `createDebuggerTab(...)` (`src/_engine/debug/DebuggerGUI.ts` → real impl in `src/_engine/core/Debug/_dbg__DebuggerGUI.ts`), and read/write via `lsGetItem`/`lsSetItem` (`src/_engine/utils/LocalAndSessionStorage.ts`) — `lsRemoveItem` exists there too but is currently **unused anywhere in the codebase**; this plan is the first consumer of it.

| Tab (id) | File | LS key(s) | Has a list of items? | Scene-scoped? |
| --- | --- | --- | --- | --- |
| loopControls | `_dbg__MainLoop.ts:10` | `AEK_debugLoop` | no | no |
| debugToolsControls | `_dbg__DebugTools.ts:30` | `AEK_debugTools` | no | no (flat blob) |
| rendererControls | `Renderer.ts:13` / `_dbg__Renderer.ts` | `debugRenderer` | no | no |
| rayCastControls | `_dbg__Raycast.ts:13` | `debugRayCast` | no | no |
| statsControls | `_dbg__Stats.ts:23` | `AEK_debugStats` | no | no |
| physicsControls | `PhysicsRapier.ts:307` | `debugPhysics` | no (live object list shown, but not LS-backed) | partially — has a `scenes: { [sceneId]: ... }` sub-map, but it's never exposed as a selectable "list" in the tab's own UI |
| skyBoxControls | `_dbg__SkyBox.ts:22` / `SkyBox.ts:79` | `AEK_debugSkyBoxUI` (tab-only fold state) + `AEK_debugSkyBoxStates` (per-skybox, `{ [sceneId]: { [skyboxId]: SkyBoxState } }`) | **yes** — dropdown of the current scene's skyboxes | yes |
| camerasControls | `_dbg__CameraGUI.ts:58` | `AEK_debugCams`, shape `{ [sceneId]: { debugCam: {...}, cams: { [appId]: CamEntityDebugState } } }` | **yes** — `cams` | yes |
| lightsControls | `_dbg__LightGUI.ts:64` | `AEK_debugLights`, shape `{ [sceneId]: { globalHelpersVisible, lights: { [appId]: LightEntityDebugState } } }` | **yes** — `lights` | yes |
| ecsControls | `ECSComponentStorage.ts:23` | `AEK_ecs`, shape `Record<worldId, ECSStorageLSOverride>` | **yes** — the whole key *is* the list (no separate tab-only field) | no (global, keyed by world id) |
| charactersControls | `_dbg__Character.ts` | none currently | **yes** (UI lists characters via `getCharacters()`) but **no LS key exists for character data today** | n/a |

Note the Camera and Light tabs each already have exactly the two-part shape this plan needs: a tab-only field (`debugCam`, `globalHelpersVisible`) alongside the per-item list (`cams`, `lights`) — this is what makes "clear this tab" vs. "clear all items in this list" a clean, pre-existing split rather than something invented for this plan.

### 2.2 UI structure to attach the buttons to

`_createNewDebuggerContainer(id, heading?)` (`_dbg__DebuggerGUI.ts:311-318`, thin public wrapper `createNewDebuggerContainer` in `src/_engine/debug/DebuggerGUI.ts:60-69` per the engine's dual-layer lazy-debug-module pattern) is what every tab calls to build its container and `<h3 class="debuggerTabHeading">` title (e.g. `_dbg__CameraGUI.ts:272`). Today it only renders a bare heading — there is no existing slot for extra header controls; both layers (`_dbg__DebuggerGUI.ts` and `debug/DebuggerGUI.ts`) need a new optional parameter to pass button CMPs in, consistent with how every other debug entry point in this codebase mirrors its signature across the two layers.

### 2.3 Existing button/icon conventions

- Icons: `src/_engine/core/UI/icons/SvgIcon.ts` is a flat `key -> inline SVG string` map, each icon imported via `?raw` from `src/_engine/core/UI/icons/svg/*.svg` (Bootstrap Icons, by filenames like `trash3-fill.svg`, `database-fill-x.svg`). `databaseX` (`database-fill-x.svg`) is already registered but **unused anywhere in the app** — a natural fit to reuse for "clear all items in this list" without adding a new asset. There's no existing "erase/clear" icon for the single-tab button — add one (Bootstrap Icons has `eraser-fill.svg`, same source/license as the existing icon set).
- Square icon button style: `.winSmallIconButton` (+ `.dangerColor` modifier) in `DraggableWindow.module.scss:283-336` is already a 2.6rem × 2.6rem square icon button with hover/disabled states, used outside `DraggableWindow` too (`_dbg__Character.ts`, `PhysicsRapier.ts`). It is **not** what to visually copy 1:1 here — the user wants dedicated, purpose-built styling for these tab-header buttons, so this plan adds new classes rather than reusing `.winSmallIconButton` directly, while following the same visual language (global classes, square, subtle background, hover state, disabled state) so the two families feel like they belong to the same design system.
- Tab-switcher buttons (`.debugDrawerTabButton`, `DebuggerGUI.module.scss:70-91`) are pill/rectangular, bordered, used only for switching between tabs — structurally and visually distinct already; the new buttons must stay visually distinct from these (different shape, not text-labelled, square icon-only).
- CMP + tooltip + click pattern: `_dbg__Character.ts:146-155` — `CMP({ class: [...], html: () => \`<button title="...">${getSvgIcon(...)}</button>\`, onClick: () => {...} })`. Directly reusable pattern.

---

## 3. Design

### 3.1 Governing rule for what each button clears

- **"Clear this tab"**: removes the tab's own LS key(s) *excluding* any per-item list sub-field. For tabs with no list at all (Loop, Renderer, Raycast, Stats), this means wiping the entire key (`lsRemoveItem(LS_KEY)`) directly, no confirmation needed — none of their data is scene-scoped. DebugTools and Physics are mixed: mostly global fields plus one scene-keyed sub-map (`debugCamera`, `scenes`) — clearing always wipes the global fields, but the scene-keyed sub-map goes through the confirmation dialog in §3.5 whenever more than one scene currently has data in it. For tabs with a list (Camera, Light, SkyBox), "Clear this tab" removes only the co-located tab-only field (`debugCam`, `globalHelpersVisible`, `AEK_debugSkyBoxUI`) and leaves the list untouched; Camera/Light's tab-only field is itself scene-scoped, so it also goes through §3.5. For ECS (whose key is *entirely* the list, no separate tab-only field) and Character (no LS key at all), this button has nothing to clear and is permanently disabled — a real, correct edge case that also exercises the "disabled when no data" requirement.
- **"Clear all items in this list"** (Camera, Light, SkyBox, ECS, Character only): removes every item's entry from the list sub-field. `AEK_ecs` isn't scene-scoped (keyed by world id), so this always clears the whole key directly, no dialog. Camera's `cams`, Light's `lights`, and SkyBox's per-scene bucket in `AEK_debugSkyBoxStates` *are* scene-scoped, so this button also goes through the §3.5 confirmation dialog whenever more than one scene has stored list entries. Character has no backing LS key today, so the button exists (per the "every list tab gets one" rule) but is always disabled until character data persistence is ever added — worth a manual-verification step precisely because it proves the disabled state holds even when a key is entirely absent.

### 3.2 UI placement

Extend `_createNewDebuggerContainer(id, heading?, headerButtons?: TCMP[])` (and its public mirror in `src/_engine/debug/DebuggerGUI.ts`) to wrap the heading and any passed button CMPs in one flex row, e.g.:

```ts
export const _createNewDebuggerContainer = (
  id: string,
  heading?: string,
  headerButtons?: TCMP[]
) => {
  const container = CMP({ id: `debuggerPane-${id}` });
  if (heading) {
    const headingRow = CMP({ class: 'debuggerTabHeadingRow' });
    headingRow.add({ html: () => `<h3>${heading}</h3>`, class: 'debuggerTabHeading' });
    headerButtons?.forEach((btn) => headingRow.add(btn));
    container.add(headingRow);
  }
  container.controls.id = id;
  return container;
};
```

Each of the 11 tab files then builds its button CMP(s) (via the shared factory in §3.4) and passes them into its existing `createNewDebuggerContainer(id, heading)` call as a third argument. Confirm against `CMP.ts`'s actual `add`/child-CMP API during implementation — the above sketch assumes `.add()` accepts an already-constructed `TCMP` the same way `_dbg__ECS.ts`'s list building does; if `.add()` only accepts a config object, the row can be built as one CMP whose `html` calls each button CMP's own render and appends via `onMount`, but the intent (one flex row containing the heading text plus 1-2 buttons) stays the same either way.

### 3.3 Icons

Add `eraser` (new `eraser-fill.svg`, Bootstrap Icons, imported the same way as every other icon in `SvgIcon.ts`) for "Clear this tab." Reuse the already-registered-but-unused `databaseX` for "Clear all items in this list" — no new asset needed for that one.

### 3.4 Styling and shared button factory

Add new global classes in `DebuggerGUI.module.scss` (co-located with `.debuggerTabHeading`/`.debugDrawerTabButton` for easy visual comparison during review), e.g. `.debuggerTabHeadingRow` (flex, `align-items: center`, gap) and `:global(.debuggerClearLSButton)` (square icon button, sized to sit comfortably next to an `<h3>`, hover + `:disabled` states) — new rules, not an extension of `.winSmallIconButton`, per the explicit ask for dedicated styling.

Add one new shared helper module, `src/_engine/core/Debug/_dbg__ClearLSButtons.ts`, to avoid re-implementing the same CMP+icon+tooltip+disabled-recompute boilerplate in all 11 tab files:

```ts
export const createClearTabLSButton = (opts: { hasData: () => boolean; onClear: () => void }): TCMP =>
  CMP({
    class: 'debuggerClearLSButton',
    html: () => `<button title="Clear local storage data for this tab"${!opts.hasData() ? ' disabled' : ''}>${getSvgIcon('eraser')}</button>`,
    onClick: () => opts.onClear(),
  });

export const createClearListLSButton = (opts: { hasData: () => boolean; onClear: () => void }): TCMP =>
  CMP({
    class: 'debuggerClearLSButton',
    html: () => `<button title="Clear local storage data for all items in this list"${!opts.hasData() ? ' disabled' : ''}>${getSvgIcon('databaseX')}</button>`,
    onClick: () => opts.onClear(),
  });
```

`onClear` performs the actual `lsRemoveItem`/`lsSetItem` write for that tab (each tab file supplies its own, since the LS shape differs per tab), then calls the button CMP's own `.update()` so `hasData()` is re-evaluated and the `disabled` attribute re-renders — no full tab/window rebuild needed, mirroring the lightweight re-render approach already used for the per-entity Clear button in `p040`.

### 3.5 Scene-scope confirmation dialog

Four buckets are genuinely scene-scoped in a way that matters to the user: Camera's `debugCam`/`cams`, Light's `globalHelpersVisible`/`lights`, SkyBox's per-scene bucket in `AEK_debugSkyBoxStates`, and the scene-keyed sub-maps inside DebugTools (`debugCamera`) and Physics (`scenes`). For any of these, clicking Clear should **not** silently decide "current scene only" or "everything" on the user's behalf — it should ask.

**Trigger condition**: only show the dialog when the relevant bucket currently holds data for **more than one scene**. If only the current scene (or no scene at all) has anything stored, "all scenes" and "this scene" would produce an identical result, so there's nothing to disambiguate — clear directly, same as any other button. This keeps the dialog from popping up on every single click in the common case (one scene loaded, one scene's worth of debug tweaks made).

**Dialog**: built with `openDialog` (`src/_engine/core/UI/DialogWindow.ts`), which is a thin, dialog-flavored wrapper around `openDraggableWindow` (centered, backdrop, non-resizable/non-draggable, per its existing defaults). A new small helper, e.g. `confirmClearScope(opts: { onClearAllScenes: () => void; onClearThisScene: () => void })` in `_dbg__ClearLSButtons.ts`, opens it:

```ts
export const confirmClearScope = (opts: {
  onClearAllScenes: () => void;
  onClearThisScene: () => void;
}) => {
  const DIALOG_ID = 'clearLSScopeConfirmDialog';
  openDialog({
    id: DIALOG_ID,
    title: 'Clear local storage data',
    content: () =>
      CMP({
        html: () => `<p>Do you want to clear this from all scenes or just this current scene?</p>`,
        // three buttons: "Clear all scenes", "Clear this scene", "Cancel"
      }),
  });
  // each button's onClick calls closeDraggableWindow(DIALOG_ID) and then,
  // for the two non-cancel choices, the matching opts.onClearAllScenes()/onClearThisScene()
};
```

The three buttons are plain labelled buttons (not the small square icon buttons from §3.4) — a new lightweight button style is needed for these (following the same `variables.nakedButton` mixin already used by both `.winSmallIconButton` and `.debugDrawerTabButton`, since no existing "dialog action button" class exists in the codebase today; the one existing `openDialog` call site, `_dbg__DebugTools.ts:463-471`, opens an empty test dialog with no content, so there's no button pattern to copy there). "Cancel" just closes the dialog with no LS write. Every tab-file callsite that owns a scene-scoped bucket calls `confirmClearScope` from its button's `onClear` instead of writing to LS directly, e.g. for Camera's "Clear this tab" button:

```ts
onClear: () => {
  const currentData = lsGetItem(LS_KEY, {}) as CamDebugLSData;
  if (Object.keys(currentData).length <= 1) {
    delete currentData[getCurrentSceneId() ?? '']?.debugCam;
    lsSetItem(LS_KEY, currentData);
    return;
  }
  confirmClearScope({
    onClearAllScenes: () => { /* delete `debugCam` from every sceneId entry, write back */ },
    onClearThisScene: () => { /* delete only currentData[sceneId].debugCam, write back */ },
  });
},
```

This directly resolves the risk flagged in an earlier draft of this plan about Physics's "Clear this tab" silently wiping every scene's physics settings — it now asks instead of guessing.

---

## 4. Files touched

- `src/_engine/core/UI/icons/SvgIcon.ts` + new `src/_engine/core/UI/icons/svg/eraser-fill.svg` — new `eraser` icon.
- `src/_engine/core/Debug/DebuggerGUI.module.scss` — new `.debuggerTabHeadingRow` / `.debuggerClearLSButton` styles.
- `src/_engine/core/Debug/_dbg__DebuggerGUI.ts` + `src/_engine/debug/DebuggerGUI.ts` — `_createNewDebuggerContainer`/`createNewDebuggerContainer` gain the optional `headerButtons` param (both layers, per the engine's lazy-debug-module mirroring convention).
- New `src/_engine/core/Debug/_dbg__ClearLSButtons.ts` — shared button factory (§3.4) plus `confirmClearScope` (§3.5), which calls `openDialog` from `src/_engine/core/UI/DialogWindow.ts` (no changes needed to `DialogWindow.ts` itself — it's consumed as-is).
- New dialog-button CSS (three labelled buttons: "Clear all scenes" / "Clear this scene" / "Cancel") — added alongside the §3.4 styles, likely in `DebuggerGUI.module.scss` or a small dedicated stylesheet next to `_dbg__ClearLSButtons.ts`.
- All 11 tab files get a small, per-file addition wiring up `hasData`/`onClear` against their own LS key and passing the resulting button(s) into their existing `createNewDebuggerContainer` call: `_dbg__MainLoop.ts`, `_dbg__DebugTools.ts`, `_dbg__Renderer.ts`, `_dbg__Raycast.ts`, `_dbg__Stats.ts`, `PhysicsRapier.ts`, `_dbg__SkyBox.ts`, `_dbg__CameraGUI.ts`, `_dbg__LightGUI.ts`, `_dbg__ECS.ts`, `_dbg__Character.ts`. Camera, Light, DebugTools, Physics, and SkyBox's list button additionally route their `onClear` through `confirmClearScope` (§3.5) instead of writing to LS directly.

No schema, scene-JSON, or ECS component-type changes — entirely debug-tooling code.

---

## 5. Phased rollout

- **Phase 1 — Shared infrastructure.** New icon, new SCSS classes, the `_createNewDebuggerContainer`/`createNewDebuggerContainer` `headerButtons` param (both layers), and `_dbg__ClearLSButtons.ts` including `confirmClearScope` and its dialog-button styles. No visible behavior change yet (no tab wires it up). Manual verification: confirm the app still builds/lints and the debug drawer looks unchanged with `?isDebug=true`.
- **Phase 2 — Simple single-panel tabs (no scene-scoping at all)**: Loop, Renderer, Raycast, Stats. Each gets only the "Clear this tab" button, wired directly to `lsRemoveItem` on its one flat key, no dialog. Manual verification: change a setting on each tab (creates LS data) → button enables → click → button disables, refresh page → tab reverts to defaults.
- **Phase 3 — Mixed single-panel tabs (global + one scene-keyed sub-map)**: DebugTools, Physics. "Clear this tab" always wipes the global fields; the scene-keyed sub-map (`debugCamera`, `scenes`) routes through `confirmClearScope` when more than one scene has data. Manual verification: with only the current scene's data present, confirm Clear acts immediately (no dialog); load/simulate a second scene's saved state, confirm the dialog now appears and each choice ("all scenes" / "this scene" / "cancel") behaves correctly.
- **Phase 4 — Camera and Light tabs.** Both buttons each, both routed through `confirmClearScope` once more than one scene has data; "Clear this tab" only touches `debugCam`/`globalHelpersVisible`, "Clear all items in this list" only touches `cams`/`lights`. Manual verification: create LS data for two different scenes, confirm both buttons prompt and each dialog choice clears the intended scope; with only one scene's data present, confirm no prompt appears.
- **Phase 5 — Remaining list tabs**: SkyBox (both buttons; only the list button is scene-scoped and dialog-gated, the tab button is a flat key and clears directly), ECS (list-only button, no dialog since it's keyed by world id not scene id; tab button permanently disabled), Character (list-only button, permanently disabled today since no LS key exists yet). Manual verification per §3.1's edge cases, specifically confirming ECS's "Clear this tab" stays disabled and Character's list button stays disabled with no console errors.

---

## 6. Risks and open questions

| Risk / question | Notes |
| --- | --- |
| Overlap with `docs/plans/p040_light-and-camera-edit-window-persistence.md`. | Both plans touch `AEK_debugCams`/`AEK_debugLights`. They're complementary (per-entity window vs. per-tab bulk), not conflicting, but whichever lands second should double check its clear logic against the other's (e.g. reuse `clearCameraFromLS`/`clearLightFromLS` from p040 in a loop, rather than re-deriving the LS shape a third time). No hard ordering dependency either way. |
| `_createNewDebuggerContainer`'s exact child-CMP API (§3.2) isn't fully confirmed against `CMP.ts`'s `add()` implementation. | The sketch assumes appending pre-built `TCMP` button instances into a wrapper row works the same way other tab files compose CMPs; verify against `CMP.ts` at implementation time and adjust the row-building approach if `add()` expects config objects only. |
| Two icons is a design judgment call, not a hard requirement. | Using the already-imported-but-unused `databaseX` for the list-clear button avoids sourcing a second new SVG; if a more list-specific icon is preferred instead, only `SvgIcon.ts`'s import list needs to change, nothing structural. |
| §3.5's trigger condition ("only prompt when more than one scene has data") is a judgment call, not stated explicitly by the spec. | The alternative reading is "always prompt whenever the bucket is structurally scene-scoped, regardless of how many scenes have data." The chosen interpretation avoids a pointless prompt when there's nothing to disambiguate, but flagging it in case the always-prompt reading was actually intended. |
| No existing labelled-button (as opposed to icon-only) style to reuse for the dialog's three choices. | The one existing `openDialog` call site (`_dbg__DebugTools.ts:463-471`) is an empty test dialog with no buttons, so §3.5's "Clear all scenes" / "Clear this scene" / "Cancel" buttons need a new style built on the same `variables.nakedButton` mixin as `.winSmallIconButton`/`.debugDrawerTabButton` — small addition, but worth knowing there's no precedent to copy wholesale. |
| `openDialog`'s `content` prop needs a CMP that itself composes a message plus three buttons with distinct click behavior and closes the dialog (`closeDraggableWindow`) on any choice. | Not fully verified against `DraggableWindow.ts`'s exact `closeDraggableWindow` signature/behavior when called from inside a dialog's own content — confirm at implementation time; expected to work the same as closing any other draggable window by id. |
