Status: draft | not-implemented
Category: Debugger
Blocked by: p060_debugger-undo-engine-core.md and p061_add-undo-history-action-recording-to-debugger-tools.md (keyboard shortcuts also depend on p050_input-system-refactoring.md — implemented)
Epic: https://trello.com/c/JYgK1s1u/86-add-undo-redo-system

# Add Undo Engine UI and History Setting — Plan

Adds the user-facing surface for the undo/redo engine (`p060`) once it's wired to real actions (`p061`): an OnScreenTools button group (top-left corner) for Undo/Redo, two new SVG icons for them, `Ctrl+Z`/`Ctrl+Shift+Z` keyboard shortcuts, and a "history depth" number control in the Debug Tools tab. No other UI (history list, per-action inspector, etc.) is in scope.

Two of the four asks in this plan originally required small, well-scoped amendments to engine code that isn't part of `p060`/`p061` — flagged prominently here, not just in the risk table. The first has since been delivered by `p050`; the second still stands:

1. ~~The keyboard-shortcut system has no modifier-key (Ctrl/Shift) support.~~ **Resolved by `p050_input-system-refactoring.md`** (implemented): `InputControls.ts` was replaced by `src/_engine/core/Input/KeyboardInput.ts`, which has first-class `ctrl`/`shift`/`alt`/`meta` chords with exact modifier matching, plus an engine-owned default-debug-keys mechanism (`Input/DefaultDebugKeyBindings.ts`). `Ctrl+Z`/`Ctrl+Shift+Z` therefore need **no engine amendment** anymore — see §1.3/§2.3. This plan's keyboard work is now confined to registering two bindings.
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

### 1.3 Keyboard shortcuts — current mechanism (after p050)

Debug shortcuts are defined by `src/_engine/core/Input/DefaultDebugKeyBindings.ts`: an engine-owned `DEFAULT_DEBUG_KEY_BINDINGS` array (`sc-toggle-debug-drawer` = `h`, `sc-toggle-debug-camera` = `F1`) registered by `registerDefaultDebugKeyBindings()` from `InitApp.ts`'s `IS_DEBUG_ENV` block. Each default's chord is reserved via `markChordReserved`, so app code binding the same chord under a different id gets a console warning. `src/CONFIG.ts`'s `debugKeys` (`AppConfig.debugKeys: DebugKeyBindingConfig[]`) can override a default by reusing its id, or add extra debug-only bindings (new id + `chord` + `fn`).

Bindings are `KeyBinding`s (`Input/KeyboardInput.ts`): `chord: { key, ctrl?, shift?, alt?, meta? }` (or an array = "any of these"), `caseInsensitive` (default `true`), `type: 'KEY_UP' | 'KEY_DOWN' | 'KEY_HELD'`. Matching is **exact on modifiers**: `{ key: 'z', ctrl: true }` matches `Ctrl+Z` but not bare `Z` nor `Ctrl+Shift+Z`. The input system itself has no text-input-focus guard (deliberately unopinionated); the two default debug bindings guard in their own `fn` via a private `isTypingInField()` helper (`document.activeElement` matching `input, textarea, select, [contenteditable]`). F1's default is `KEY_DOWN` with `preventDefault()` + an `e.repeat` check — the precedent for shortcuts the browser itself acts on.

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

### 2.3 Keyboard shortcuts (no engine amendment needed — uses p050's mechanism)

Register two bindings:

```ts
{
  id: 'sc-undo',
  type: 'KEY_DOWN',
  chord: [{ key: 'z', ctrl: true }, { key: 'z', meta: true }], // Ctrl+Z, and Cmd+Z on macOS
  name: 'Undo',
  fn: (e) => {
    if (isTypingInField()) return; // let the focused field's native undo run
    e.preventDefault();
    if (!e.repeat) undoLastAction();
  },
},
{
  id: 'sc-redo',
  type: 'KEY_DOWN',
  chord: [{ key: 'z', ctrl: true, shift: true }, { key: 'z', meta: true, shift: true }],
  name: 'Redo',
  fn: (e) => { /* same guard, redoLastAction() */ },
},
```

Notes:

- **No modifier pinning gotcha anymore.** The old draft needed `shiftKey: false` pinned on undo so `Ctrl+Shift+Z` wouldn't fire both undo and redo; `KeyboardInput.ts`'s exact-modifier match already makes `{ key: 'z', ctrl: true }` not match `Ctrl+Shift+Z`. `caseInsensitive` (default `true`) covers Shift turning `e.key` into `'Z'`.
- **`KEY_DOWN`, not `KEY_UP`.** On macOS, browsers don't fire `keyup` for other keys while ⌘ is held, so a `KEY_UP` Cmd+Z would never fire. `KEY_DOWN` also lets `preventDefault()` stop the browser's own undo. Hence the `e.repeat` check (holding the chord shouldn't undo repeatedly — or, if key-repeat undo is wanted, drop it deliberately).
- **Where to register them — flagged call for the implementer:**
  (a) add both to `DEFAULT_DEBUG_KEY_BINDINGS` in `Input/DefaultDebugKeyBindings.ts` — engine-owned debugger feature, chords reserved (collision warning), overridable from `CONFIG.ts` by id, and `isTypingInField()` is already right there; or
  (b) plain `createKeyBinding` calls from the undo/redo debug module (`_dbg__UndoRedo.ts`) or entries in `src/CONFIG.ts`'s `debugKeys` — no chord reservation, and the focus guard must be written again.
  (a) fits best since undo/redo is an engine debugger feature, not app-specific — but the choice is left open.
- **Text-input focus guard — resolved direction.** `KeyboardInput.ts` stays unopinionated (per p050); each binding's `fn` checks focus itself. With (a), reuse `isTypingInField()`; with (b), export it from `DefaultDebugKeyBindings.ts` (or move it into a small shared helper) instead of duplicating it. When focus is in a field, return **without** `preventDefault()` so the field's native undo still works.

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
- `src/_engine/core/Input/DefaultDebugKeyBindings.ts` — two new `DEFAULT_DEBUG_KEY_BINDINGS` entries (undo/redo), **or**, per §2.3's flagged call, `createKeyBinding` calls in `_dbg__UndoRedo.ts` / `debugKeys` entries in `src/CONFIG.ts` instead. No changes to `KeyboardInput.ts` or `Config.ts` needed.
- `src/_engine/core/Debug/_dbg__UndoRedo.ts` (from `p060`/`p061`) — `_getUndoRedoHistorySize`/`_setUndoRedoHistorySize`/`_initUndoRedoSettings` + the `updateOnScreenTools('UNDO')` calls from §2.1 (§2.4).
- `src/_engine/debug/UndoRedo.ts` (from `p060`) — thin public wrappers for the two new functions.
- `src/_engine/debug/DebugToolsManager.ts` — `DebugToolsState`/`defaultDebugToolsState` gain `undoRedoFolderExpanded`.
- `src/_engine/core/Debug/_dbg__DebugTools.ts` — new "Undo / Redo" folder + binding (§2.4).

No schema, scene-JSON, or ECS component-type changes.

---

## 4. Phased rollout

- **Phase 1 — Icons.** Add the two new SVG files + `SvgIcon.ts` registration. No behavior change, purely additive assets. Manual verification: temporarily render both icons somewhere (e.g. via the browser console calling `getSvgIcon('undo')`) to confirm they parse/display correctly before wiring them into real buttons.
- **Phase 2 — (obsolete)** The keyboard-shortcut core amendment this phase used to cover was delivered by `p050_input-system-refactoring.md` (modifier chords, exact matching, default debug keys). Nothing to do here; the undo/redo bindings themselves are registered in Phase 4.
- **Phase 3 — Debug Tools history-size control.** `_dbg__UndoRedo.ts` settings additions (§2.4) + the new Debug Tools folder. Manual verification: change the value, confirm it persists across reload (`AEK_debugUndoRedoSettings`) and that recording more actions than the new (lower) limit correctly trims old entries.
- **Phase 4 — OnScreenTools button group + real key bindings.** Register the `sc-undo`/`sc-redo` bindings per §2.3 (including the text-input focus guard), and in a quick manual check confirm `Ctrl+Z`/`Ctrl+Shift+Z` (and `Cmd+Z`/`Cmd+Shift+Z` on macOS) are distinguished from each other and from bare `Z`, and that the "h"/F1 defaults still work; build `undoRedoTools()` (§2.1), fix the `updateTool` fallthrough, and wire the `updateOnScreenTools('UNDO')` refresh calls into `_dbg__UndoRedo.ts`. Manual verification: with `p061`'s recordable actions in place, perform a recordable edit (e.g. Renderer tone mapping, per `p061` §4.1) → confirm the Undo button enables → click it (and separately, press `Ctrl+Z`) → confirm the edit reverts and the Redo button enables → confirm the reverse for Redo/`Ctrl+Shift+Z`. Also confirm the button group's on-screen position doesn't visually collide with the Stats panel in its default (enabled, minimal) state.

---

## 5. Risks and open questions

| Risk / question | Notes |
| --- | --- |
| Where to register the undo/redo bindings (§2.3). | `DefaultDebugKeyBindings.ts` (recommended: chord reservation + id-based CONFIG override for free) vs. `createKeyBinding` from `_dbg__UndoRedo.ts` / `CONFIG.ts` `debugKeys`. Flagged call for the implementer, per p050. |
| Text-input focus guard for `Ctrl+Z`/`Ctrl+Shift+Z` (§2.3). | Direction decided by p050: the guard lives in each binding's `fn` (`KeyboardInput.ts` stays unopinionated), reusing `isTypingInField()` from `DefaultDebugKeyBindings.ts`. Returning early without `preventDefault()` keeps native field undo working. |
| Cmd+Z on macOS needs `KEY_DOWN`. | Browsers don't deliver `keyup` for other keys while ⌘ is held on macOS; a `KEY_UP` binding would never fire for Cmd+Z/Cmd+Shift+Z. Covered in §2.3. |
| OnScreenTools' top-left position collides with the Stats panel's hardcoded `top:0;left:0` (§2.1). | Flagged, not silently resolved — `InitApp.ts`'s toaster-offset technique is the suggested fix, but exact values need visual confirmation during implementation, and the Stats panel's size varies by its own config (minimal/horizontal/tracked-metrics). |
| `updateTool`'s missing `break`s (§1.1) is a pre-existing bug, not introduced by this plan. | Fixed in passing since this plan edits that exact function to add a third case — flagged so the fix isn't mistaken for accidental unrelated cleanup during review. |
| New icon choice (`arrow-90deg-left`/`-right`) is a suggestion, not verified against real Bootstrap Icons artwork. | This plan has no network access to fetch/confirm the actual glyph; implementation should source real SVG markup consistent with the project's existing manual-copy convention (same as how `eraser-fill.svg`/`trash3-fill.svg` etc. were added per `p041`). |
| History-size control takes effect immediately (no reload), unlike the ECS storage-mode override it's modeled on. | Deliberate — flagged so it isn't "fixed" to match the ECS reload behavior by mistake; there's no boot-time/allocation reason for undo history size to need a reload. |
