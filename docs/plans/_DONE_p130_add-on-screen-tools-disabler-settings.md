Status: implemented
Category: Debugger
Related: \_DONE_p080_multi-viewport-rendering-and-axis-gizmo.md (its axes gizmo is in the disabled set), p083_editor-creator-view.md (its view tools group joins the disabled set), \_DONE_p105_refactor-debugger-drawer-tab-creation.md (the declarative tab this folder is built with)

# Add On-Screen Tools Disabler Settings — Plan

In debug mode, the on-screen tools, the debug drawer handle, the stats panel and the axes gizmo sit on top of the canvas and catch clicks. That gets in the way of clicking or dragging the canvas under them: raycast picking, OrbitControls drags, and app input. This plan adds a switch to the Debug Tools Controls tab that makes all four **click-through** (`pointer-events: none`) and dims the first three to a configurable opacity. Keyboard shortcuts and the drawer contents keep working. The switch has a keyboard shortcut (§), which shows a toast. The tab's "Production test mode" folder is renamed "On-screen tools" and holds the new settings.

Implemented in engine 2.3.0. This file describes what was built; where it differs from the original draft, the reason is noted.

## Context (grounded in code)

- **The Debug Tools Controls tab** is in `src/_engine/core/Debug/_dbg__DebugTools.ts`, a declarative `createDebuggerTab({ id: 'debugToolsControls', lsKey: 'AEK_debugTools', state, persistKeys, content })` (p105).
  - Persisted keys are hydrated whole at registration and written on a finished user change. `persistDebuggerTabStateValue` rewrites only the `persistKeys` already in LS, so a key that isn't one of them is dropped on the next write.
  - Folder open states are in `AEK_debugToolsUI` by folder `id`. The `*FolderExpanded` state fields are no longer used.
  - Binding `onChange` fires on user input only, never on hydration or refresh.
  - `_dbg__OnScreenTools.ts` reads `showOnScreenToolsInProdTest` through `getDebugToolsState(true)` in prod test mode, because the tab never runs there.
- **Boot order** (`InitApp.ts`):
  1. `registerDefaultDebugKeyBindings()` (debug env).
  2. `registerDebugToolsModule()` (debug and prod test).
  3. `appStartFn()`, which does the first scene load.
  4. `initMainLoop()`, which builds the tab (`_initDebugTools()`).
  5. The debug toaster (`DEBUG_TOASTER_ID`), created at the very end.
- **The disabled elements**, all children of the HUD root or the viewports layer:
  - **On-screen tools:** the play, switch and undo/redo groups. Each is a `CMP` with the global class `onScreenToolGroup`. They are torn down and rebuilt on every update, so a class set on the group itself would be lost.
  - **Drawer handle:** `#debugDrawerToggler`, which already had the global class `debugDrawerToggler`.
  - **Stats panel:** `.statsContainer`. stats-gl's canvases inside already have `opacity: 0.45 !important`.
  - **Axes gizmo** (p080): an `interactive` viewport slot while the debug camera is active. The slot is an empty DOM box, because the gizmo renders into the canvas, so CSS opacity on it does nothing.
- **Precedent for body-class-driven debug CSS:** `debugDrawerOpen`, which `OnScreenTools.module.scss` reacts to through `:global(.debugDrawerOpen) &`.

## Design decisions

- **DD1: a body class plus a CSS variable, not per-element JS.**
  - A body class `aekOnScreenToolsDisabled` and a variable `--aek-disabled-on-screen-tools-opacity`, both set on `document.body`.
  - This survives the on-screen tool groups being rebuilt, and it doesn't care which element exists yet or in what order they are created.
  - New on-screen elements (eg. p083's view tools group) opt in by adding their selector to the same rule.
- **DD2: `pointer-events: none` on the element and all its descendants** (`&, & *`, with `!important`).
  - Declaring it only on the parent isn't enough: a child with its own `pointer-events` value (buttons, `<select>`, stats-gl's canvases with their click-to-cycle listener) would still catch clicks.
  - Opacity goes on the container element only. On the stats panel it multiplies with the canvases' existing 0.45.
- **DD3: only the four listed elements.**
  - The drawer itself stays interactive, including its close button. The handle is click-through and dimmed even while the drawer is open, so with the setting on the drawer opens with `h` only.
  - Also not affected: toasts, draggable and dialog windows, and the debugger scene loader.
- **DD4: the axes gizmo is click-through but not dimmed.** It gets the global slot class `aekAxesGizmoSlot`, rather than the rule matching `.aekViewportSlot`, so app viewports (eg. minimaps) are never caught by it. Dimming it would need an opacity option on viewports, which was out of scope. (Not in the original draft, which predates p080 landing.)
- **DD5: debug env only.**
  - Prod test mode has no debug key bindings and no debug toaster.
  - Its own switch (show or hide the play tools in prod test) stays as it is, moved into the renamed folder.
  - The body class is never set outside `IS_DEBUG_ENV`.
- **DD6: state is a new top-level `onScreenTools` key**, replacing `prodTestMode`:
  - `onScreenTools: { showOnScreenToolsInProdTest: boolean; disableOnScreenTools: boolean; disabledOnScreenToolsOpacity: number }`, defaults `{ true, false, 0.5 }`.
  - A top-level key because hydration replaces a persisted key whole: a new field inside `prodTestMode` would be `undefined` for anyone with saved state, and Tweakpane throws on binding to `undefined`.
  - The draft's `onScreenToolsFolderExpanded` field was dropped: folder states are in the UI key. The folder id changed from `prodTest` to `onScreenTools`, so its saved fold state is lost once.
  - **Migration:** if the saved state has `prodTestMode` but no `onScreenTools`, `showOnScreenToolsInProdTest` is carried over and the result is **written back to LS right away**. The draft said "the next save drops `prodTestMode`", but that would lose the migrated value: the next persist write keeps only the `persistKeys` already in LS, so it would drop `prodTestMode` without adding `onScreenTools`.
- **DD7: applied at `registerDebugToolsModule()` time,** not when the tab is built, so the tools never start out fully visible and clickable during the first scene load.
- **DD8: the shortcut is `§`, on keydown.**
  - `KEY_DOWN` with a repeat guard, like F1 and F8. The draft had `KEY_UP`, but where § is a shifted key (German layout: Shift+3), releasing Shift first makes the keyup's key `'3'`, so the binding would miss.
  - `ignoreModifiers: true`, so the shifted § matches.
  - Guarded by `isTypingInField()`.
  - It has no key on US ANSI keyboards. Those users rebind it through `AppConfig.debugKeys` (`id: 'sc-toggle-on-screen-tools'`).
- **DD9: the toast is shown only for the shortcut,** not for the checkbox. Its key hint is built from the pressed event (modifiers + `e.key`, eg. "Shift+§"), so it is right for a rebound key and for shifted layouts. Keys with no readable name (`Dead`, `Unidentified`) get no hint.
- **DD10: no undo/redo.** The switch is cosmetic, like the p115 env ball options (per `_DONE_p061`).

## Implementation

### Phase 1: state, folder rename, settings and CSS

1. **State** (`debug/DebugToolsManager.ts`, `core/Debug/_dbg__DebugTools.ts`): `onScreenTools` replaces `prodTestMode` in the type, both default objects and `persistKeys`. `loadDebugToolsStateFromLS()` does the shallow merge plus the migration (DD6), used by `_getDebugToolsState(true)`. The reader in `_dbg__OnScreenTools.ts` and its comment are updated.
2. **Apply function:** `_applyOnScreenToolsDisabled()` toggles the body class and sets the CSS variable. It is idempotent, and returns early unless `IS_DEBUG_ENV`. `registerDebugToolsModule()` loads the state from LS and calls it (DD7).
3. **Folder** "On-screen tools" (`id: 'onScreenTools'`), bindings in order:
   - "Disable on-screen tools [§]": `onScreenTools.disableOnScreenTools`.
   - "Disabled on-screen tools opacity": `onScreenTools.disabledOnScreenToolsOpacity`, `min: 0, max: 1, step: 0.01`, applied on every slide tick.
   - "Show top on screen tools in prod test mode".
   - The first two call `_applyOnScreenToolsDisabled` in `onChange`. Persistence is the tab's own.
4. **Gizmo slot class** (`_dbg__AxesGizmo.ts`): `slotClass` also gets `aekAxesGizmoSlot`.
5. **CSS** (`core/Debug/OnScreenTools.module.scss`, which only loads in debug or prod test):

   ```scss
   :global(body.aekOnScreenToolsDisabled) {
     :global(.onScreenToolGroup),
     :global(.debugDrawerToggler),
     :global(.statsContainer) {
       opacity: var(--aek-disabled-on-screen-tools-opacity, 0.5);
     }

     :global(.onScreenToolGroup),
     :global(.debugDrawerToggler),
     :global(.statsContainer),
     :global(.aekAxesGizmoSlot) {
       &,
       & * {
         pointer-events: none !important;
       }
     }
   }
   ```

   An `opacity 0.2s` transition on `.onScreenToolGroup`, the toggler (combined with its `background` transition), `.switchTools`/`.playTools` (combined with their `transform` transition) and `.statsContainer` (`styles/index.scss`).

### Phase 2: shortcut and toast

1. **Toggle function** (`_dbg__DebugTools.ts` `_toggleOnScreenToolsDisabled(keyHint?)`, public wrapper `toggleOnScreenToolsDisabled(keyHint?)` in `DebugToolsManager.ts`):
   - Flips `disableOnScreenTools` and applies it.
   - Once the tab is registered: `persistDebuggerTabValue` + `updateDebuggerTab` (refreshes the checkbox only if the tab is open), like `_toggleAxesGizmo`.
   - Before that (§ pressed during the first scene load, between the key bindings and the tab being registered): writes `onScreenTools` to LS directly. Otherwise the tab's hydration would restore the old value over the toggled one.
   - Shows a toast in a `try/catch` (the toaster is created last): title `On-screen tools`, message `Disabled (click-through). Press <key> to enable.` or `Enabled`, 2000 ms.
2. **Binding** (`DefaultDebugKeyBindings.ts`): `sc-toggle-on-screen-tools` (DD8), with `getPressedChordHint(e)` for the toast (DD9).

## Files touched

| File                                                | Change                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/_engine/debug/DebugToolsManager.ts`            | `onScreenTools` state type and defaults; apply on register; `toggleOnScreenToolsDisabled` |
| `src/_engine/core/Debug/_dbg__DebugTools.ts`        | Defaults, LS load helper and migration, "On-screen tools" folder, apply and toggle, toast |
| `src/_engine/core/Debug/_dbg__OnScreenTools.ts`     | Reads `onScreenTools.showOnScreenToolsInProdTest`                                         |
| `src/_engine/core/Debug/_dbg__AxesGizmo.ts`         | Global `aekAxesGizmoSlot` slot class                                                      |
| `src/_engine/core/Debug/OnScreenTools.module.scss`  | Body-class rule and opacity transitions                                                   |
| `src/_engine/core/Debug/DebuggerGUI.module.scss`    | Toggler opacity transition                                                                |
| `src/_engine/styles/index.scss`                     | Stats container opacity transition                                                        |
| `src/_engine/core/Input/DefaultDebugKeyBindings.ts` | `sc-toggle-on-screen-tools` (§) binding and `getPressedChordHint`                         |
| `package.json`, `CHANGELOG.md`                      | Engine (and project) 2.2.0 → 2.3.0                                                        |

## Verification

Run `yarn dev` and open `?isDebug=true`.

1. **Tab:** the "On-screen tools" folder replaced "Production test mode" and holds the three settings. Its fold state persists.
2. **Disable on:**
   - The play, switch and undo/redo groups, the "Debug" handle and the stats panel all dim to the set opacity.
   - Clicks and drags on them reach the canvas. With the debug camera, so does a drag over the axes gizmo.
   - The slider changes the opacity live, including 0 and 1.
3. **Still working:** `h` opens and closes the drawer, and its contents and close button are clickable. F1, Ctrl+Z and Ctrl+Shift+Z work. Toasts and draggable windows are clickable.
4. **Rebuilds:** switch camera with F1, change scene, and undo. The rebuilt tool groups are still disabled.
5. **Shortcut:**
   - § (and Shift+§) toggles and shows the toast. The checkbox updates while the tab is open.
   - Toggle with the tab closed, then open it: no errors, and the value is correct.
   - § in a text field does nothing.
6. **Persistence:**
   - Reload: the state and opacity are restored, and the tools are dimmed from the first frame.
   - With an old `AEK_debugTools` in LS that has `prodTestMode.showOnScreenToolsInProdTest: false`, the value migrates, `prodTestMode` is removed from LS, and no Tweakpane errors are thrown.
7. **Prod test** (`?isProdTest=true`): the play tools show or hide per the migrated setting, and they are never click-through.
8. `yarn lint` and `yarn build` pass.
