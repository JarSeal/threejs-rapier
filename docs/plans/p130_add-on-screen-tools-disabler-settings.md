Status: draft | not-implemented
Category: Debugger
Related: p080_multi-viewport-rendering-and-axis-gizmo.md and p115_debug-environment-ball-viewport.md (add clickable on-screen gizmos that should join the disabled set), p105_refactor-debugger-drawer-tab-creation.md (will migrate the Debug Tools options this plan adds)

# Add On-Screen Tools Disabler Settings — Plan

In debug mode, the on-screen tools, the debug drawer handle and the stats panel sit on top of the canvas and catch clicks. That gets in the way of clicking or dragging the canvas under them: raycast picking, OrbitControls drags, and app input. This plan adds a switch to the Debug Tools Controls tab that makes all three **click-through** (`pointer-events: none`) and dims them to a configurable opacity. Keyboard shortcuts and the drawer contents keep working. The switch has a keyboard shortcut (§), which shows a toast. The tab's "Production test mode" folder is renamed "On-screen tools" and holds the new settings.

## Context (grounded in code)

- **The Debug Tools Controls tab** is in `src/_engine/core/Debug/_dbg__DebugTools.ts`, registered as `createDebuggerTab({ id: 'debugToolsControls', orderNr: 6 })` (`:112-144`).
  - The "Production test mode" folder (`:255-271`) holds one binding, "Show top on screen tools in prod test mode" (`prodTestMode.showOnScreenToolsInProdTest`).
  - `_dbg__OnScreenTools.ts:49-53` reads that value from LS in prod test mode, because the tab never runs there.
- **State:** the `DebugToolsState` type and its defaults are in `src/_engine/debug/DebugToolsManager.ts:8-90`. The defaults are duplicated in `_dbg__DebugTools.ts:44-84`.
  - **The LS load is a shallow merge** (`_dbg__DebugTools.ts:96-97` and `_getDebugToolsState` `:152-157`: `{ ...debugToolsState, ...saved }`). Any saved state has a `prodTestMode` object, and a new field inside it would load as `undefined`. Tweakpane throws on binding to `undefined`. New fields must therefore go in a new top-level key (the same rule as p080 DD12 and p115).
  - `registerDebugToolsModule()` (`DebugToolsManager.ts:93-100`) runs in debug and prod test (`InitApp.ts:110-118`). That is before the first scene load, so before the on-screen tools are built.
  - `_initDebugTools()` builds the tab much later, from `initMainLoop` (`MainLoop.ts:381-383`), after `appStartFn`.
- **The three elements to disable**, all children of the HUD root:
  - **On-screen tools:** play, switch and undo/redo groups. Each is a `CMP` with the global class `onScreenToolGroup` (`_dbg__OnScreenTools.ts:56,140,338`). They are torn down and rebuilt on every update, so a class set on the group itself would be lost. A **body class** is not.
  - **Drawer handle:** `#debugDrawerToggler`, the "Debug" button. It is a child of the drawer, placed with `right: 100%` (`_dbg__DebuggerGUI.ts:124-130`, `DebuggerGUI.module.scss:38-63`). It has only a hashed module class, and CMP renders its `id` as an attribute only with `idAttr: true`. It needs a global class added.
  - **Stats panel:** `.statsContainer` (global, `_dbg__Stats.ts:109-114`, styled in `styles/index.scss:44-59`). stats-gl's canvases inside already have `opacity: 0.45 !important`.
- **Precedent for body-class-driven debug CSS:** `debugDrawerOpen` (`_dbg__DebuggerGUI.ts:18, 246-266`), which `OnScreenTools.module.scss` already reacts to through `:global(.debugDrawerOpen) &`.
- **Shortcuts:** `DEFAULT_DEBUG_KEY_BINDINGS` in `src/_engine/core/Input/DefaultDebugKeyBindings.ts` (debug env only, registered in `InitApp.ts:105`).
  - Every binding can be rebound or disabled by id from `CONFIG.ts` `debugKeys`.
  - `isTypingInField()` guards letter-like keys.
  - `KeyChord.key` matches `KeyboardEvent.key`. `ignoreModifiers` matches regardless of modifiers (`KeyboardInput.ts:21-24`).
- **Toasts:** the debug toaster (`DEBUG_TOASTER_ID`) is created at the very end of `InitEngine` (`InitApp.ts:141-164`). `_dbg__UndoRedo.ts:209-221` (`showActionToast`) shows the pattern: `addToast({ toasterId: DEBUG_TOASTER_ID, ... })` inside a `try/catch`, for when the toaster doesn't exist yet.

## Design decisions

- **DD1: a body class plus a CSS variable, not per-element JS.**
  - A new body class `aekOnScreenToolsDisabled` and a variable `--aek-disabled-on-screen-tools-opacity`, both set on `document.body`.
  - This survives the on-screen tool groups being rebuilt, and it doesn't care which of the three elements exists yet or in what order they are created.
  - Future on-screen elements (p080 axes gizmo slot, p115 env ball slot) opt in by adding their selector to the same rule.
- **DD2: `pointer-events: none` on the element and all its descendants** (`&, & *`, with `!important`).
  - Declaring it only on the parent isn't enough: a child with its own `pointer-events` value (buttons, `<select>`, stats-gl's canvases with their click-to-cycle listener) would still catch clicks.
  - Opacity goes on the container element only. On the stats panel it multiplies with the canvases' existing 0.45. That's acceptable, and the slider still controls it relative to the normal look.
- **DD3: only the three listed elements.**
  - The drawer itself stays interactive when open, including its close button, so it can still be closed with `h` or the close button. The handle is click-through and dimmed even while the drawer is open.
  - Also not affected: toasts, draggable and dialog windows, and the debugger scene loader.
- **DD4: debug env only.**
  - Prod test mode has no debug key bindings and no debug toaster.
  - Its own switch (show or hide the play tools in prod test) stays as it is, moved into the renamed folder.
  - The body class is never set outside `IS_DEBUG_ENV`.
- **DD5: state moves to a new top-level `onScreenTools` key**, replacing `prodTestMode`:
  - `onScreenTools: { onScreenToolsFolderExpanded: boolean; showOnScreenToolsInProdTest: boolean; disableOnScreenTools: boolean; disabledOnScreenToolsOpacity: number }`
  - Defaults: `{ false, true, false, 0.5 }`.
  - `prodTestMode` is dropped from the type and both default objects.
  - One small migration in a shared load helper: if the saved state has `prodTestMode` but no `onScreenTools`, carry `showOnScreenToolsInProdTest` and the folder-expanded flag over. The next save drops `prodTestMode`.
- **DD6: applied at `registerDebugToolsModule()` time,** not `_initDebugTools()`, so the tools never start out fully visible and clickable during the first scene load.
- **DD7: the shortcut is `§`.**
  - `KEY_UP` with `ignoreModifiers: true`, so it also works where § is a shifted key (German layout: Shift+3).
  - Guarded by `isTypingInField()`.
  - It has no key on US ANSI keyboards. Those users rebind it through `AppConfig.debugKeys` (`id: 'sc-toggle-on-screen-tools'`).
- **DD8: the toast is shown only for the shortcut,** as the spec says, not for the checkbox.
- **DD9: no undo/redo.** The switch is cosmetic, like the p115 env ball options (per `_DONE_p061`).

## Implementation

### Phase 1: state, folder rename, settings and CSS

1. **State** (`debug/DebugToolsManager.ts`, `core/Debug/_dbg__DebugTools.ts`)
   - Replace `prodTestMode` with the `onScreenTools` key (DD5) in the type and both default objects.
   - Add a `loadDebugToolsStateFromLS()` helper in `_dbg__DebugTools.ts`. It does the shallow merge plus the `prodTestMode` migration. Use it at both load sites (`createDebugToolsDebugGUI` and `_getDebugToolsState`).
   - Update the reader in `_dbg__OnScreenTools.ts:49-53` (`getDebugToolsState(true).onScreenTools.showOnScreenToolsInProdTest`) and its comment ("On-screen tools" folder).
2. **Apply function** (`_dbg__DebugTools.ts`)
   - `_applyOnScreenToolsDisabled()` reads `debugToolsState.onScreenTools`.
   - It returns early unless `IS_DEBUG_ENV`.
   - It toggles `document.body.classList` `aekOnScreenToolsDisabled`, and sets `--aek-disabled-on-screen-tools-opacity` with `document.body.style.setProperty`.
   - A public wrapper in `DebugToolsManager.ts` calls it right after the module loads in `registerDebugToolsModule()`, when `IS_DEBUG_ENV`, after `_getDebugToolsState(true)` (DD6).
3. **Folder** (`_dbg__DebugTools.ts:255-271`)
   - Retitle it "On-screen tools" and bind its fold state to `onScreenTools.onScreenToolsFolderExpanded`.
   - Bindings, in order:
     - "Disable on-screen tools [§]": `disableOnScreenTools`, a checkbox.
     - "Disabled on-screen tools opacity": `disabledOnScreenToolsOpacity`, `min: 0, max: 1, step: 0.01`. Applied live on every slide tick.
     - The existing "Show top on screen tools in prod test mode".
   - Each `on('change')` calls `_applyOnScreenToolsDisabled()` and `lsSetItem(LS_KEY, debugToolsState)`. Both are idempotent, which Phase 2's `refresh()` depends on.
   - Keep a module-level reference to the "Disable" binding. Null it in the existing `onRemoveCmp` wrapper (`:133-140`), so a torn-down pane is never refreshed.
4. **Drawer handle class** (`_dbg__DebuggerGUI.ts:128`): add the global class `'debugDrawerToggler'` next to `styles.debugDrawerToggler`.
5. **CSS** (`core/Debug/OnScreenTools.module.scss`, which only loads in debug or prod test):
   ```scss
   // Set on <body> by the Debug Tools "On-screen tools" folder / § shortcut. Makes the on-screen
   // tools, the drawer handle and the stats panel click-through so the whole canvas is clickable.
   // Future on-screen elements (e.g. p080 axes gizmo) add their selector here.
   :global(body.aekOnScreenToolsDisabled) {
     :global(.onScreenToolGroup),
     :global(.debugDrawerToggler),
     :global(.statsContainer) {
       opacity: var(--aek-disabled-on-screen-tools-opacity, 0.5);
       &,
       & * {
         pointer-events: none !important;
       }
     }
   }
   ```
   Add an `opacity 0.2s` transition to `.onScreenToolGroup`, the toggler and `.statsContainer`, so the change fades. The toggler and the switch/play groups already have `transition: transform`, so combine the two into one list.

### Phase 2: shortcut and toast

1. **Toggle function** (`_dbg__DebugTools.ts` `_toggleOnScreenToolsDisabled()`, with a public wrapper `toggleOnScreenToolsDisabled()` in `DebugToolsManager.ts`)
   - Flips `disableOnScreenTools`, saves to LS and applies.
   - Refreshes the "Disable" binding if the pane is open. `refresh()` re-emits `change`, which is harmless (step 3).
   - Shows a toast in a `try/catch`, like `showActionToast`:
     - Title: `On-screen tools`.
     - Message: `Disabled (click-through). Press § to enable.` or `Enabled`.
     - `toasterId: DEBUG_TOASTER_ID`, `showingTime` of about 2000 ms.
   - The toast message shows the key that is actually bound, not a hard-coded `§`, if the rebound chord is easy to read. Otherwise it drops the key hint.
2. **Binding** (`DefaultDebugKeyBindings.ts`): a new entry:
   ```ts
   {
     id: 'sc-toggle-on-screen-tools',
     type: 'KEY_UP',
     chord: { key: '§' },
     ignoreModifiers: true,
     name: 'Toggle on-screen tools click-through',
     fn: () => { if (!isTypingInField()) toggleOnScreenToolsDisabled(); },
   }
   ```
3. **p105 note:** when p105 lands, this folder migrates with the rest of the tab, and `updateDebuggerTab` replaces the manual binding refresh. Add it to p105's Phase 4 DebugTools bullet next to p080 and p115.

## Files touched

| File                                                       | Change                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/_engine/debug/DebugToolsManager.ts`                   | `onScreenTools` state type and defaults (replaces `prodTestMode`); apply on register; public `toggleOnScreenToolsDisabled` |
| `src/_engine/core/Debug/_dbg__DebugTools.ts`               | Defaults, LS load helper and migration, "On-screen tools" folder, apply and toggle functions, toast                        |
| `src/_engine/core/Debug/_dbg__OnScreenTools.ts`            | Read `onScreenTools.showOnScreenToolsInProdTest`; update comment                                                           |
| `src/_engine/core/Debug/_dbg__DebuggerGUI.ts`              | Global `debugDrawerToggler` class on the handle                                                                            |
| `src/_engine/core/Debug/OnScreenTools.module.scss`         | Body-class rule and opacity transitions                                                                                    |
| `src/_engine/core/Input/DefaultDebugKeyBindings.ts`        | `sc-toggle-on-screen-tools` (§) binding                                                                                    |
| `docs/plans/p105_refactor-debugger-drawer-tab-creation.md` | Phase 4 DebugTools bullet mentions this folder                                                                             |
| `package.json`                                             | Engine minor bump at merge (per CLAUDE.md versioning)                                                                      |

## Verification

Run `yarn dev` and open `?isDebug=true`.

1. **Tab:** the "On-screen tools" folder replaced "Production test mode" and holds the three settings. Its fold state persists.
2. **Disable on:**
   - The play, switch and undo/redo groups, the "Debug" handle and the stats panel all dim to 0.5.
   - Clicks and drags on them reach the canvas: the debug camera orbits when dragging over the switch tools, and raycast picking works under the stats panel.
   - The slider changes the opacity live, including 0 and 1.
3. **Still working:**
   - `h` opens and closes the drawer, and the drawer contents and close button are clickable.
   - F1, Ctrl+Z and Ctrl+Shift+Z work.
   - Toasts and draggable windows are clickable.
4. **Rebuilds:** switch camera with F1, change scene, and undo. The rebuilt tool groups are still disabled.
5. **Shortcut:**
   - § toggles and shows the enabled or disabled toast. The checkbox updates while the tab is open.
   - Toggle with the tab closed, then open it: no errors, and the value is correct.
   - § in a text field does nothing.
6. **Persistence:**
   - Reload: the state and opacity are restored, and the tools are dimmed from the first frame (no full-opacity flash during scene load).
   - With an old `AEK_debugTools` in LS that has `prodTestMode.showOnScreenToolsInProdTest: false`, the value migrates, and no Tweakpane errors are thrown.
7. **Prod test** (`?isProdTest=true`): the play tools show or hide per the migrated setting, and they are never click-through.
8. `yarn lint` and `yarn build` pass.
