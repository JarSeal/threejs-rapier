Status: draft | not-implemented
Category: Debugger
Blocked by: p060_debugger-undo-engine-core.md and p061_add-undo-history-action-recording-to-debugger-tools.md
Epic: https://trello.com/c/JYgK1s1u/86-add-undo-redo-system

# Add Undo Engine UI and History Setting — Plan

Adds the user-facing surface for the undo/redo engine (`p060`) once it's wired to real actions (`p061`): an OnScreenTools button group (top-left corner) for Undo/Redo, two new SVG icons for them, `Ctrl+Z`/`Ctrl+Shift+Z` keyboard shortcuts, and a "history depth" number control in the Debug Tools tab. No other UI (history list, per-action inspector, etc.) is in scope.

Two of the four asks in this plan turn out to require small, well-scoped amendments to engine code that isn't part of `p060`/`p061` — flagged prominently here, not just in the risk table, since they widen this plan's blast radius slightly beyond "debugger-only files":

1. **The keyboard-shortcut system has no modifier-key (Ctrl/Shift) support at all today.** The "h" pattern this plan was asked to reuse only matches a bare key string — see §1.3. Adding `Ctrl+Z` needs a small extension to `src/_engine/core/InputControls.ts`, which is a general-purpose engine module used by gameplay input too, not a `_dbg__`-prefixed debug-only file. The change is additive/optional-field (non-breaking), but it's worth flagging that this plan can't stay confined to debug-only files the way `p060`/`p061` did.
2. **`p060`'s `historySize` is a boot-time config value only** — there's no runtime getter/setter for it to bind a live Debug Tools control to. This plan adds one (§2.4), another small, expected amendment in the same spirit as `p061`'s already-flagged core changes.

---

## 1. Current state (grounded in the actual code)

### 1.1 OnScreenTools pattern

`src/_engine/core/Debug/_dbg__OnScreenTools.ts` currently builds two button groups, each a `CMP` with class `[styles.onScreenToolGroup, 'onScreenToolGroup', '<name>Tools']` appended directly to the HUD root (`getHUDRootCMP()`):

- `playToolsCMP` (lines 33-115) — positioned via `:global(.playTools) { top: 1.6rem; left: 50%; ... }` in `OnScreenTools.module.scss:54-67`.
- `switchToolsCMP` (lines 118-307) — positioned via `:global(.switchTools) { bottom: 1.6rem; left: 50%; ... }` in `OnScreenTools.module.scss:24-52`.

Each button inside a group is a `CMP({ class: [styles.onScreenTool, 'onScreenTool', ...(active ? [styles.active, 'onScreenToolActive'] : [])], html: () => \`<button>${getSvgIcon('iconName')}</button>\`, attr: { title: '...' }, onClick: (e) => { e.stopPropagation(); ...; _updateOnScreenTools('TAG'); } })`. Module-level state (`playToolsCMP`/`switchToolsCMP`) is torn down (`.remove()`) and fully rebuilt on every update — no partial/diffed updates.

Thin/impl split (`InitApp.ts` bootstrap wiring, `CLAUDE.md`'s dual-layer pattern): `src/_engine/debug/OnScreenTools.ts` exports `ToolTypes = 'SWITCH' | 'PLAY'`, `registerOnScreenTools`/`InitOnScreenTools`/`updateOnScreenTools(tools?)`, each a thin `useDebug(debugGUI, true)?._fn(...)` wrapper (note the `true` — OnScreenTools, unlike most debug modules, is also included in `IS_PROD_TEST_MODE`, per `OnScreenTools.ts:9,13,17`; this plan's Undo/Redo group should **not** follow that — it's meaningless outside a real debug session, see §2.1).

`_dbg__OnScreenTools.ts:321-328`'s `updateTool` switch has **no `break` statements**:

```ts
const updateTool = (toolType: ToolTypes) => {
  switch (toolType) {
    case 'PLAY':
      playTools();
    case 'SWITCH':
      switchTools();
  }
};
```

This is a pre-existing fallthrough bug (calling `updateTool('PLAY')` also rebuilds `switchTools()`) — harmless today since both rebuild functions are idempotent and cheap, but adding a third case here (for this plan's new group) means it's worth fixing in passing, since this plan is editing this exact function anyway (§2.1).

### 1.2 Icons

`src/_engine/core/UI/icons/SvgIcon.ts` already imports (and nothing currently uses) `arrowClockwise`/`arrowCounterClockwise` (`arrow-clockwise.svg`/`arrow-counterclockwise.svg`, Bootstrap Icons' circular-refresh-style arrows) — grep confirms zero usages anywhere in `src` besides the map declaration itself. These are the icons the request says not to reuse. Icons in this codebase are manually sourced raw `.svg` files under `src/_engine/core/UI/icons/svg/` (no `bootstrap-icons` npm package installed — confirmed, `node_modules/bootstrap-icons` doesn't exist), imported via `?raw` and registered in the flat `icons` map (`SvgIcon.ts:31-59`) — same pattern `p041`'s research already documented for `databaseX`/`eraser-fill.svg`.

### 1.3 Keyboard shortcuts — the "h" pattern, and its real limits

`src/CONFIG.ts:6-15` registers the debug-drawer toggle via `AppConfig.debugKeys`:

```ts
debugKeys: [{ enabled: true, id: 'sc-toggle-debug-drawer', key: ['h', 'H'], type: 'KEY_UP', fn: () => toggleDrawer() }]
```

`src/_engine/core/Debug/_dbg__DebuggerGUI.ts:48-64` reads `getConfig().debugKeys` once and calls `createKeyInputControl({ type, fn, ...(key && {key}), ...(id && {id}), ...(sceneId && {sceneId}) })` per entry (`InputControls.ts:350-. `). Matching happens in `InputControls.ts`'s `initKeyUpControls`/`initKeyDownControls` (lines 85-. ): for each registered `KeyMapping`, `KEY.toLowerCase() === String(mapping.key).toLowerCase()` (or `.includes(KEY...)` for an array of keys) — **that is the entire match condition**. `KeyMapping` (`InputControls.ts:15-26`) and `AppConfig.debugKeys`'s type (`Config.ts:14-21`) have **no `ctrlKey`/`shiftKey`/`altKey`/`metaKey` field at all**, and no code anywhere in `InputControls.ts` reads `e.ctrlKey`/`e.shiftKey`. Confirmed via grep across the whole file. There is also no `preventDefault()` call anywhere in the key-handling code.

This means: the literal "same pattern as 'h'" cannot express `Ctrl+Z` today. Registering `key: 'z'` as-is would fire on every bare "z" keypress (ctrl or not) — a real bug, not just an incomplete feature, since `Z` may be a legitimate character-input/gameplay key elsewhere in `app`/`toolkit` and would now also trigger undo. §2.3 covers the required fix.

### 1.4 Debug Tools tab structure

`src/_engine/core/Debug/_dbg__DebugTools.ts`'s `buildDebugToolsGUI()` currently builds three folders in order: "Change scene and debug start scene" (190-243), "Helpers" (246-398), "Logging actions" (401-493) — confirmed by `p061`'s research pass; `env`/`debugCamera` state exists in the type but is dead (no folder built for it). All folder-level state persists to the flat (non-scene-scoped) LS key `AEK_debugTools` via `lsSetItem(LS_KEY, debugToolsState)`.

### 1.5 `p060`'s current API surface (as specified, before `p061`'s amendments)

Relevant here: `canUndo()`/`canRedo()` (booleans, "for a future UI" per `p060` §2.2 — this is that future UI), `undoLastAction()`/`redoLastAction()`, and `historySize` as a **read-only, boot-time** `AppConfig.undoRedo.historySize` (`p060` §2.4) — no setter exists. `p061` §3.1 also added a `scope: 'perScene' | 'global'` concept to action handlers; irrelevant to this plan's own additions (Undo/Redo button state and history size are inherently global, not per-scene).

---

## 2. Design

### 2.1 OnScreenTools Undo/Redo button group

New third group, `undoRedoToolsCMP`, in `_dbg__OnScreenTools.ts`, following the existing group pattern exactly:

```ts
const undoRedoTools = () => {
  const hudRootCMP = getHUDRootCMP();
  if (!hudRootCMP) return;
  if (undoRedoToolsCMP) undoRedoToolsCMP.remove();
  undoRedoToolsCMP = CMP({ class: [styles.onScreenToolGroup, 'onScreenToolGroup', 'undoRedoTools'] });

  const undoBtn = CMP({
    class: [styles.onScreenTool, 'onScreenTool'],
    html: () => `<button${!canUndo() ? ' disabled' : ''}>${getSvgIcon('undo')}</button>`,
    attr: { title: 'Undo' },
    onClick: (e) => { e.stopPropagation(); undoLastAction(); },
  });
  const redoBtn = CMP({
    class: [styles.onScreenTool, 'onScreenTool'],
    html: () => `<button${!canRedo() ? ' disabled' : ''}>${getSvgIcon('redo')}</button>`,
    attr: { title: 'Redo' },
    onClick: (e) => { e.stopPropagation(); redoLastAction(); },
  });
  undoRedoToolsCMP.add(undoBtn);
  undoRedoToolsCMP.add(redoBtn);
  hudRootCMP.add(undoRedoToolsCMP);
};
```

Gated on `IS_DEBUG_ENV` only (**not** `IS_PROD_TEST_MODE`, unlike the rest of `_dbg__OnScreenTools.ts`'s own `_InitOnScreenTools`/`_updateOnScreenTools` gate) — undo/redo of debugger edits is meaningless in a production-test view with no debug drawer to edit anything from. `_InitOnScreenTools`/`_updateOnScreenTools` need an `IS_DEBUG_ENV`-only branch added for this one group, since today both functions treat `IS_PROD_TEST_MODE` and `IS_DEBUG_ENV` identically (`_dbg__OnScreenTools.ts:309-319, 330-354`).

New `'UNDO'` member added to `ToolTypes` (`debug/OnScreenTools.ts:3`), a new case in `updateTool`'s switch (`_dbg__OnScreenTools.ts:321-328`) — fixing the missing `break`s in the same edit (§1.1) since a third fallthrough case would compound the existing bug. Buttons re-render disabled state via the existing full-rebuild-on-update pattern (no partial diffing anywhere else in this file either, so consistent).

**Refresh trigger**: rather than have every `p061` call site remember to call `updateOnScreenTools('UNDO')` after recording/undoing/redoing an action, `_dbg__UndoRedo.ts`'s own `_recordUndoRedoAction`/`_recordOrCoalesceUndoRedoAction`/`_undoLastAction`/`_redoLastAction` (all from `p060`/`p061`) each call `updateOnScreenTools('UNDO')` once at the end — importing it from the thin `debug/OnScreenTools.ts` entry point, exactly the same direction and pattern `PhysicsRapier.ts:1929` already uses (`updateOnScreenTools('SWITCH')` called from inside a core manager after a physics-visualizer toggle). This is a small addition to `_dbg__UndoRedo.ts` (touched again here, on top of `p061`'s amendments to the same file), not something `p061`'s dozens of call sites each need to know about.

**Positioning — flagged, not silently decided**: `stats-gl`'s own DOM element is hardcoded to `position: fixed; top: 0; left: 0; z-index: 10000;` (`node_modules/stats-gl/dist/main.js:93-98`), and the Stats tab is enabled by default (`defaultStatsOptions.enabled: true`, `Stats.ts:23-33`). A literal top-left corner placement (e.g. `top: 1.6rem; left: 1.6rem;`, mirroring `playTools`/`switchTools`'s `1.6rem` offset convention) sits almost exactly on top of the stats panel in its default size. `InitApp.ts:96-99` already solves an analogous problem for the debug toaster by computing an offset from `getStatsCmp()?.elem.offsetHeight` at runtime — the same technique (compute a `left` offset from the stats panel's live `offsetWidth`, falling back to a fixed `1.6rem` when stats are disabled/absent) is the natural fix here. Implementation should apply it; exact values aren't pinned down in this plan (visual polish, confirm in the browser during implementation) — flagged in §5 as a risk to resolve rather than assumed away.

### 2.2 New icons

Add two new raw SVG assets under `src/_engine/core/UI/icons/svg/`, registered in `SvgIcon.ts` the same way as every other icon:

```ts
import undoIcon from './svg/arrow-90deg-left.svg?raw';
import redoIcon from './svg/arrow-90deg-right.svg?raw';
// ...
const icons = {
  // ...
  undo: undoIcon,
  redo: redoIcon,
};
```

`arrow-90deg-left`/`arrow-90deg-right` (Bootstrap Icons' right-angle "hook" arrows) are suggested as visually distinct from the existing circular `arrow-clockwise`/`arrow-counterclockwise` glyphs already in the codebase (and explicitly disliked per the request) while staying within the same icon family/style/license already used everywhere else in `SvgIcon.ts`. This is a design suggestion, not a hard requirement — confirm the actual glyph choice against the real Bootstrap Icons artwork at implementation time (this plan doesn't have network access to fetch/verify the exact SVG markup). The existing unused `arrowClockwise`/`arrowCounterClockwise` entries are left untouched — nothing depends on removing them, and CLAUDE.md's instructions caution against unrelated cleanup.

### 2.3 Keyboard shortcuts (requires an `InputControls.ts` amendment)

**Amendment**: add four optional fields to `KeyMapping` (`InputControls.ts:15-26`) — `ctrlKey?: boolean`, `shiftKey?: boolean`, `altKey?: boolean`, `metaKey?: boolean` — and to `AppConfig.debugKeys`'s per-entry type (`Config.ts:14-21`). Update the key-match condition everywhere it's computed in `initKeyUpControls`/`initKeyDownControls` (four near-identical blocks per `InputControls.ts:85-. `/`130-. ` for the global and per-scene mapping arrays) from:

```ts
let isCurrentKey = KEY.toLowerCase() === String(mapping.key).toLowerCase();
```

to also require every specified modifier to match the event's actual modifier state, e.g.:

```ts
const modifiersMatch =
  (mapping.ctrlKey === undefined || mapping.ctrlKey === e.ctrlKey) &&
  (mapping.shiftKey === undefined || mapping.shiftKey === e.shiftKey) &&
  (mapping.altKey === undefined || mapping.altKey === e.altKey) &&
  (mapping.metaKey === undefined || mapping.metaKey === e.metaKey);
```

`isCurrentKey` and the existing array-of-keys branch stay as-is; `modifiersMatch` gates alongside them (`if ((isCurrentKey || !mapping.key) && modifiersMatch)`). Every field is optional and defaults to "don't care," so existing mappings (including the "h" one) are unaffected — purely additive. `_dbg__DebuggerGUI.ts:54-60`'s config pass-through needs the same four optional spreads added alongside the existing `key`/`id`/`sceneId` ones.

`src/CONFIG.ts` then registers two new entries alongside the existing "h" one:

```ts
{ enabled: true, id: 'sc-undo', key: ['z', 'Z'], ctrlKey: true, shiftKey: false, type: 'KEY_UP', fn: () => undoLastAction() },
{ enabled: true, id: 'sc-redo', key: ['z', 'Z'], ctrlKey: true, shiftKey: true, type: 'KEY_UP', fn: () => redoLastAction() },
```

(`shiftKey: false` on the undo entry so a bare `Ctrl+Z` doesn't also satisfy the redo mapping's "don't care about ctrl" — actually needed the other way: since both entries require `ctrlKey: true`, the only distinguishing field is `shiftKey`, so undo must pin `shiftKey: false` explicitly rather than leaving it undefined, otherwise `Ctrl+Shift+Z` would match **both** mappings and fire undo then redo in the same keyup. This is a real edge case to get right, not a copy-paste detail.)

**Text-input focus guard — a judgment call, flagged**: unlike the "h" drawer-toggle (safe to fire globally, since it's not a character a user would type while editing a value), `Ctrl+Z`/`Ctrl+Shift+Z` are the browser's own native undo/redo shortcut for whatever text input currently has focus — including, very plausibly, a Tweakpane number/text field the user is mid-edit in inside an open edit window. Firing the engine's undo/redo *at the same time* as the browser's native field-undo would be confusing (two different "undo" behaviors on one keypress). **Recommendation**: gate both new `fn` callbacks (or add a generic guard to `createKeyInputControl` itself, reusable beyond this feature) on `document.activeElement` not being an `<input>`/`<textarea>`/`[contenteditable]` element. This isn't in `p060`/`p061`'s scope and isn't a hard requirement from the request, but is flagged here as a real UX correctness issue discovered while grounding this plan in the actual key-handling code (no such guard exists anywhere in `InputControls.ts` today) — confirm before implementation whether to add it generically or accept the native-undo collision as-is.

### 2.4 Debug Tools "history depth" control (requires a small `p060`/`p061` runtime-setter amendment)

**Amendment**: `_dbg__UndoRedo.ts` gains a runtime-mutable history-size setting, separate from the per-scene history-entries LS bucket (`p060` §2.3) since it's a global setting, not scene data — new LS key `AEK_debugUndoRedoSettings`, shape `{ historySize: number }`, seeded from `AppConfig.undoRedo.historySize` (`p060` §2.4) on first read and overridable thereafter:

```ts
// _dbg__UndoRedo.ts
const SETTINGS_LS_KEY = 'AEK_debugUndoRedoSettings';
let historySize = getConfig().undoRedo?.historySize ?? 50;

export const _initUndoRedoSettings = () => {
  const saved = lsGetItem(SETTINGS_LS_KEY, { historySize }) as { historySize: number };
  historySize = saved.historySize;
};

export const _getUndoRedoHistorySize = () => historySize;

export const _setUndoRedoHistorySize = (size: number) => {
  historySize = size;
  lsSetItem(SETTINGS_LS_KEY, { historySize });
  // trim every scene's (and '_global's) entries array down to the new size immediately, adjusting pointer — reuses the same trim-from-front logic `p060` §2.2 already defines for the write-time trim, just invoked once here too
};
```

Takes effect immediately, no `location.reload()` needed (unlike the ECS storage-mode override this pattern is modeled on) — trimming an array of history entries has no boot-time/allocation constraint the way ECS's storage backend does.

New folder in `_dbg__DebugTools.ts`'s `buildDebugToolsGUI()` (alongside Scenes-listing/Helpers/Logging-actions), e.g. "Undo / Redo":

```ts
const undoRedoFolder = pane.addFolder({ title: 'Undo / Redo' });
undoRedoFolder
  .addBinding({ historySize: getUndoRedoHistorySize() }, 'historySize', { min: 1, max: 500, step: 1 })
  .on('change', (ev) => setUndoRedoHistorySize(ev.value));
```

(via the thin `debug/UndoRedo.ts` entry's public `getUndoRedoHistorySize`/`setUndoRedoHistorySize` wrappers, not the `_`-prefixed impl directly — consistent with every other tab's cross-module calls, e.g. how `_dbg__DebugTools.ts` already calls into `Renderer.ts`/`Scene.ts` through their public entry points). This binding's own fold state isn't persisted as a "folder expanded" flag distinctly (matches the existing tabs' convention of persisting fold state per-folder — add `undoRedoFolderExpanded` to `DebugToolsState`/`defaultDebugToolsState` in `DebugToolsManager.ts` alongside the existing `helpersFolderExpanded`/`loggingFolderExpanded`, same shape).

---

## 3. Files touched

- `src/_engine/core/UI/icons/SvgIcon.ts` + two new `src/_engine/core/UI/icons/svg/*.svg` files — `undo`/`redo` icons (§2.2).
- `src/_engine/core/Debug/_dbg__OnScreenTools.ts` — new `undoRedoTools()` group + fix to `updateTool`'s missing `break`s + `IS_DEBUG_ENV`-only branch for the new group (§2.1).
- `src/_engine/debug/OnScreenTools.ts` — `ToolTypes` gains `'UNDO'`.
- `src/_engine/core/Debug/OnScreenTools.module.scss` — new `:global(.undoRedoTools)` positioning rule (§2.1, including whatever offset resolves the Stats-panel collision).
- `src/_engine/core/InputControls.ts` — `KeyMapping` gains `ctrlKey?`/`shiftKey?`/`altKey?`/`metaKey?`; match logic in `initKeyUpControls`/`initKeyDownControls` checks them (§2.3).
- `src/_engine/core/Config.ts` — `AppConfig.debugKeys`'s per-entry type gains the same four optional fields.
- `src/_engine/core/Debug/_dbg__DebuggerGUI.ts` — pass the four new optional fields through to `createKeyInputControl` (lines 54-60).
- `src/CONFIG.ts` — two new `debugKeys` entries (undo/redo).
- `src/_engine/core/Debug/_dbg__UndoRedo.ts` (from `p060`/`p061`) — `_getUndoRedoHistorySize`/`_setUndoRedoHistorySize`/`_initUndoRedoSettings` + the `updateOnScreenTools('UNDO')` calls from §2.1 (§2.4).
- `src/_engine/debug/UndoRedo.ts` (from `p060`) — thin public wrappers for the two new functions.
- `src/_engine/debug/DebugToolsManager.ts` — `DebugToolsState`/`defaultDebugToolsState` gain `undoRedoFolderExpanded`.
- `src/_engine/core/Debug/_dbg__DebugTools.ts` — new "Undo / Redo" folder + binding (§2.4).

No schema, scene-JSON, or ECS component-type changes.

---

## 4. Phased rollout

- **Phase 1 — Icons.** Add the two new SVG files + `SvgIcon.ts` registration. No behavior change, purely additive assets. Manual verification: temporarily render both icons somewhere (e.g. via the browser console calling `getSvgIcon('undo')`) to confirm they parse/display correctly before wiring them into real buttons.
- **Phase 2 — Keyboard-shortcut core amendment.** `InputControls.ts` + `Config.ts` modifier-field support, with a throwaway `console.log`-based `debugKeys` entry to manually verify `Ctrl+Z`/`Ctrl+Shift+Z`/bare `Z` are now correctly distinguished, and that the existing "h" drawer toggle still works unaffected. Decide and implement the text-input focus guard (§2.3) here or explicitly defer it with a note. Remove the throwaway entry before Phase 4.
- **Phase 3 — Debug Tools history-size control.** `_dbg__UndoRedo.ts` settings additions (§2.4) + the new Debug Tools folder. Manual verification: change the value, confirm it persists across reload (`AEK_debugUndoRedoSettings`) and that recording more actions than the new (lower) limit correctly trims old entries.
- **Phase 4 — OnScreenTools button group + real key bindings.** Wire the actual `undo`/`redo` `debugKeys` entries from Phase 2 into `src/CONFIG.ts` for real, build `undoRedoTools()` (§2.1), fix the `updateTool` fallthrough, and wire the `updateOnScreenTools('UNDO')` refresh calls into `_dbg__UndoRedo.ts`. Manual verification: with `p061`'s recordable actions in place, perform a recordable edit (e.g. Renderer tone mapping, per `p061` §4.1) → confirm the Undo button enables → click it (and separately, press `Ctrl+Z`) → confirm the edit reverts and the Redo button enables → confirm the reverse for Redo/`Ctrl+Shift+Z`. Also confirm the button group's on-screen position doesn't visually collide with the Stats panel in its default (enabled, minimal) state.

---

## 5. Risks and open questions

| Risk / question | Notes |
| --- | --- |
| `InputControls.ts` is not a debug-only file. | Unlike every other file this plan (and `p060`/`p061`) touches, `InputControls.ts` is a general engine module used by gameplay/app input too. The change is additive and optional-field, so existing behavior is unaffected, but it's a wider blast radius than "debugger-only," worth a deliberate go/no-go before implementation rather than assuming it's fine because it's additive. |
| Text-input focus guard for `Ctrl+Z`/`Ctrl+Shift+Z` (§2.3). | Not requested explicitly, discovered as a real UX correctness issue (native browser field-undo colliding with engine undo) while grounding the plan in the actual key-handling code. Needs an explicit decision before Phase 2, not a silent default. |
| Undo/redo `debugKeys` entries need `shiftKey: false`/`shiftKey: true` pinned explicitly, not left `undefined`, to avoid both firing on the same `Ctrl+Shift+Z` keyup. | Called out in §2.3 — an easy mistake to make copy-pasting the "h" entry's shape, since "h" has no modifier fields to get wrong. |
| OnScreenTools' top-left position collides with the Stats panel's hardcoded `top:0;left:0` (§2.1). | Flagged, not silently resolved — `InitApp.ts`'s toaster-offset technique is the suggested fix, but exact values need visual confirmation during implementation, and the Stats panel's size varies by its own config (minimal/horizontal/tracked-metrics). |
| `updateTool`'s missing `break`s (§1.1) is a pre-existing bug, not introduced by this plan. | Fixed in passing since this plan edits that exact function to add a third case — flagged so the fix isn't mistaken for accidental unrelated cleanup during review. |
| New icon choice (`arrow-90deg-left`/`-right`) is a suggestion, not verified against real Bootstrap Icons artwork. | This plan has no network access to fetch/confirm the actual glyph; implementation should source real SVG markup consistent with the project's existing manual-copy convention (same as how `eraser-fill.svg`/`trash3-fill.svg` etc. were added per `p041`). |
| History-size control takes effect immediately (no reload), unlike the ECS storage-mode override it's modeled on. | Deliberate — flagged so it isn't "fixed" to match the ECS reload behavior by mistake; there's no boot-time/allocation reason for undo history size to need a reload. |
