Status: in progress | Phases 1-3 implemented
Category: Debugger, UI Component

# Refactor Draggable Windows and Dialogs — Plan

Refactors `core/UI/DraggableWindow.ts` (and `DialogWindow.ts` on top of it) into smaller, typed pieces with per-window pointer handling and a real stacking order. It fixes the position bugs: non-px units, and windows lost off screen after a viewport resize. It adds a header double-click and a Debug tools button that center windows and fit them to the screen. It also lets the debugger's edit windows (Light, Camera, ECS world, PostFX pass, Physics entity, Assets info, Character) open one window per entity instead of one window per kind that swaps its content.

---

## 1. Goal

- `DraggableWindow.ts` is readable and cheap:
  - persisted state and runtime objects are separate types
  - `openDraggableWindow` is split into steps
  - input is handled per window with pointer events, not by one global `mousedown` that parses class names
  - the stacking order is real, not just active and inactive
  - nothing parses localStorage on the hot path
- Several edit windows can be open at a time, one per entity. Clicking a list row whose window is open brings that window to the front, or closes it if it is already on top. The list shows every entity with an open window as selected.
- Windows with non-px positions (`%`, `vw`, `vh`) drag and clamp correctly.
- After a viewport resize, every window is back on screen, and a window can never end up with no grabbable header part.
- Double-clicking the header of a draggable window (not a dialog) moves it to the top center of the screen. If it still overflows and is resizable, it shrinks to fit.
- A Debug tools button does the same for every open draggable window, cascaded so every header stays visible.
- The public API keeps working: callers that use one fixed window id behave as before.

---

## 2. Current state (grounded in the actual code)

### 2.1 `core/UI/DraggableWindow.ts` (1214 lines)

- **State.** `DraggableWindow` (`:10-55`) mixes persisted fields (geometry, flags, `data`, `title`) with runtime objects (`windowCMP`, `backDropCMP`, `content`, `onClose`). The LS save filters the runtime keys out with `DO_NOT_SAVE_KEYS` (`:712-733`).
- **`openDraggableWindow` (`:178-452`)** does three jobs in one function:
  - resolves about 20 props against the stored state, with a different "prop wins / stored wins" rule per flag (`:224-297`)
  - updates a live window: z-index, backdrop, a content rebuild when `JSON.stringify(data)` changed (`:341`), title
  - or creates a new one
- **`createWindowCMP` (`:524-662`)** takes 18 positional parameters.
- **Input:**
  - One `window` `mousedown` (`:749`) finds the window from the header class and `parentElement.id`.
  - Four near-identical branches handle move, vertical, horizontal and corner resize (`:758-887`). Each adds a capture-phase `mousemove`.
  - The drag state is spread over `draggingPosId`, `draggingVertId`, `draggingHoriId`, `rightMouseClickDown` and `listeners` (`:123-136`).
  - The listeners and the resizer exist only while a window is open (`createListeners` `:735`, `removeListeners` `:946`).
- **Stacking.** There are only two z levels per layer: active 105 / 20005 and inactive 100 / 20000 (`:142-145`). `setAllOpenWindowsZIndexInactive` (`:976`) restyles every window on each click. Inactive windows stack in DOM order, so with several windows the order is effectively random.
- **Bugs found while reading:**
  - `windowClassList.concat(winClass)` (`:559`) and `backDropClasses.concat(bdClass)` (`:692`) throw their result away, so array classes are ignored.
  - The height clamps use `minSize.w` (`:811`, `:881`).
  - The content update tests `typeof content` instead of `contentFnOrCMP` (`:349`). A reopen without `content` but with stored content adds `undefined`. No caller hits this today.
  - `closeDraggableWindow` with `removeOnClose` calls `onClose` (`:486`), and then `removeDraggableWindow` calls it again (`:1035`).
  - `updateDraggableWindow` (`:664`) rebuilds through `removeDraggableWindow`, so every rebuild also runs `onClose`.
  - Reopening a live window sets `position = resetPosition && pos ? pos : foundWindow.defaultPosition` (`:311`, `@TODO: FIX THIS`). The stored position is overwritten while the DOM stays where it was. `resetPosition`/`resetSize` never restyle a live window.
  - `saveDraggableWindowStatesToLS` returns without writing when no saveable window is left (`:731`), so the last removed window stays in LS.
  - `getDraggableWindow` (`:1153`) parses LS on every miss. The list `selectedItemId` callbacks call it on every list refresh.
  - The default `maxSize` is the viewport size in px when the window opens (`:248`), so it is stale after a resize.

### 2.2 Issue: non-px units

- `createWindowCMP` writes `left/top` in the given unit and adds `translate3D(-50%, -50%, 0)` when a position unit isn't px (`:574-580`). A non-px position therefore means "the window's centre", in viewport units.
- **Drag start.** The pointer offset is `e.clientX - winElem.offsetLeft` (`:766`). `offsetLeft` ignores the transform, and the first move writes px `left/top` while the translate stays. The window jumps by half its size.
- **Mouseup.** It stores `offsetLeft/Top` as the position (`:905-906`), but `units.position` stays `%`. After a reload, the px number is applied as a percentage.
- **Clamp.** `checkAndSetMaxWindowPosition` (`:1006`) also uses `offsetLeft/Top`, writes px, and ignores the translate.
- Today only dialogs pass non-px units (`DialogWindow.ts:73-80`), and they can't be dragged. They still go through the open-time and resize clamps.

### 2.3 Issue: windows lost off screen after a resize

- The clamp keeps `MAX_OFF_SCREEN_HORI_THRESHOLD = 65` px on screen horizontally and 20 px vertically (`:162-163`, `:1013-1027`).
- At the right edge, those 65 px are the header's collapse and close buttons (two `3rem` buttons). A mousedown on a `BUTTON` never starts a drag (`:758`), so the window can't be grabbed.
- A viewport resize (debounced 200 ms through `addResizer`, `:932-937`) applies the same rule. Shrinking the screen therefore leaves windows that can't be reached.
- A window restored from LS after a reload on a smaller screen has the same problem.

### 2.4 The edit windows ("one window at a time")

Each kind uses one fixed window id. Opening another entity's window calls `openDraggableWindow` again with new `data`, and the data compare at `:341` rebuilds the content in place.

| Kind            | Module / opener                                                                      | Window id                                          | Click on an open row | Scene target resolver                 |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- | -------------------- | ------------------------------------- |
| Light           | `Debug/Light/_dbg__LightGUI.ts` `openEditLightWindow` (`:1199`)                      | `lightEditorWindow`                                | reopens              | `:1150`                               |
| Camera          | `Debug/Camera/_dbg__CameraGUI.ts` `openEditCameraWindow` (`:452`)                    | `cameraEditorWindow`                               | reopens              | `:687`                                |
| ECS world       | `Debug/_dbg__ECS.ts` `openEditECSWorldWindow` (`:305`)                               | `ecsWorldEditorWindow`                             | reopens              | `:176`                                |
| PostFX pass     | `Debug/_dbg__PostFX.ts` `toggleEditPostFxPassWindow` (`:113`)                        | `postFxPassEditorWindow`                           | toggles              | `:480`                                |
| Physics entity  | `Debug/_dbg__PhysicsAPI.ts` `toggleEditPhysicsEntityWindow` (`:337`)                 | `physicsApiEntityEditorWindow`                     | toggles              | `:318`                                |
| Assets info     | `Debug/_dbg__Assets.ts` `openInfoWindow` (`:175`)                                    | `assetsInfoWindow`                                 | toggles              | `:198`                                |
| Character edit  | `Debug/_dbg__Character.ts` `toggleEditCharacterWindow` (`:243`)                      | `characterEditorWindow_<charId>` (per entity)      | toggles              | none (`removeOnSceneChange`, `@TODO`) |
| Character state | `Debug/Character/_dbg__CharacterStateWindow.ts` `_openCharacterStateWindow` (`:831`) | `characterDataTrackerWindow_<charId>` (per entity) | n/a                  | per window id (`:826`, `:833`)        |

- **List selection.** The list's `selectedItemId` reads `getDraggableWindow(ID)?.data` (e.g. `_dbg__LightGUI.ts:1131`). Characters already return an array of every open window (`_dbg__Character.ts:282-284`), and `debuggerListCMP` accepts arrays (`_dbg__DebuggerList.ts:20`).
- **Registries are per exact id:** `registerDraggableWindowContentFn` (`:1206`) and `registerDraggableWindowSceneTargetResolver` (`:1199`). Per-entity windows have to register once per window id (the Character state window does), or re-attach content after a reload (`_updateCharactersDebuggerGUI` with `getDraggableWindowsStartingWith`).
- **Module state that assumes one window:**
  - `openWorldEditRefresh` (`_dbg__ECS.ts:63`)
  - `infoWindowCmp` (`_dbg__Assets.ts:67`)
  - `entityWindowCmp` and `entityWindowPane` (`_dbg__PhysicsAPI.ts:96-97`)
  - `windowBuiltFor` (`_dbg__PostFX.ts:84`)
- **Refreshes rebuild the one window.** The module update functions (e.g. `updateLightsDebuggerGUI('WINDOW')`, `_dbg__LightGUI.ts:1241`) are also what the undo/redo handlers call. No undo action stores a window id: payloads are keyed by app id or character id.
- **Not edit windows:** the ray tester windows (one per tester kind, no target), the dialogs, and the test windows in the Debug tools tab.

### 2.5 Other facts this design relies on

- **`DialogWindow.ts`.** `openDialog` forces a `%` centre position, a backdrop, and disables dragging, resizing and collapsing (`:67-88`). The Escape stack reads `getDraggableWindow(id)` `isOpen` and `windowCMP` (`:34-35`).
- **State read outside the module:** `.isOpen`, `.data`, `.isCollapsed` (`_dbg__CharacterStateWindow.ts:583`), `.windowCMP` (`DialogWindow.ts`), and `.content` (`_dbg__Assets.ts:694`, `_dbg__PhysicsAPI.ts:987`, `_dbg__Character.ts:318`). Nobody reads `position` or `size`. No code outside the module uses its internal class names.
- **Z-index layers:** app windows 100–105, `index.ts` and the debugger scene loader 1000, on-screen tools and `styles/index.scss` 10000, the debug drawer 10200, debug windows 20000+.
- **Debug tools tab:** `buildDebugToolsItems` (`Debug/_dbg__DebugTools.ts:382`). Its top-level buttons ("Debug key shortcuts [I]", "App key shortcuts …", `:416-425`) are followed by a separator (`:426`). `addDebugToast` (`debug/DebuggerGUI.ts`) is available.
- **Helpers:** `addResizer`/`deleteResizer` (`core/MainLoop.ts:416`/`:429`) and `getWindowSize` (`utils/Window.ts:5`, `innerWidth`/`innerHeight`).

---

## 3. Design

### 3.1 State: config plus runtime

- `DraggableWindowConfig` is the persisted, serializable part:
  - `id`, `kind?`, `title`, `data`
  - `geometry: { x, y, w, h }` in **px**
  - `units` for the size, min size and max size only (§3.5)
  - the behaviour flags, `isOpen`, `isCollapsed`, `saveToLS`
- `DraggableWindowRuntime` is never persisted: `windowCMP`, `backDropCMP`, `content`, `onClose`, the header and handle elements, and the active drag session.
- The module keeps a `Map<id, { config, runtime? }>`.
  - `getDraggableWindow(id)` keeps its return shape (`isOpen`, `data`, `isCollapsed`, `windowCMP`, `content`), so `DialogWindow.ts` and the edit-window modules don't change.
  - It reads LS once, at `loadDraggableWindowStatesFromLS`, and never again.
- **LS.** The key stays `AEK_popupWindows`. A write happens on finished changes only (open, close, drag end, resize end, collapse, fit) and writes only the `saveToLS` configs. An empty result writes `{}` (fixes §2.1's stale entry). Old entries load as they are: the extra runtime-free keys they carry are mapped into the config.

### 3.2 Opening: resolve, then mount or update

`openDraggableWindow` becomes three small steps. The public signature doesn't change.

1. **`resolveWindowConfig(props, stored)`** applies one rule set, written down once as a doc comment:
   - Behaviour flags: a passed prop wins, then the stored value, then the default (what most flags do today).
   - Geometry: the stored value wins, unless `resetPosition`/`resetSize` is set. Then the prop wins, and the default comes last.
   - Title and `data`: the passed value wins.
2. **`mountWindow(config, runtime)`** builds the DOM from an options object (no positional parameters). It wires the per-window listeners (§3.3) and puts the window on top of its layer (§3.4).
3. **`updateMountedWindow`** applies a changed title, classes, collapsed state and geometry (a reset now really moves the window). It rebuilds the content when `data` changed.

Also in this step:

- `updateDraggableWindow` rebuilds without running `onClose` (an `isRebuild` path, not `removeDraggableWindow`).
- A close with `removeOnClose` runs `onClose` once.

### 3.3 Input: per-window pointer sessions

- On mount, each window adds `pointerdown` listeners to its title area and resize handles, and one `dblclick` listener on the header (§3.7).
- A primary-button `pointerdown` calls `setPointerCapture` and starts one `DragSession { mode: 'MOVE' | 'RESIZE_H' | 'RESIZE_V' | 'RESIZE_HV', startPointer, startGeometry }`.
- `pointermove` stores the latest pointer. The geometry is written at most once per animation frame, through `requestAnimationFrame` coalescing.
- `pointerup` and `pointercancel` commit the geometry to the config and save.
- This removes:
  - the global `mousedown`
  - the class-name and `parentElement.id` lookups
  - the capture-phase `mousemove`
  - `rightMouseClickDown`
  - `createListeners`/`removeListeners`
  - the four copy-pasted branches
- The viewport resize handler is registered once, at the first mount, and stays. It is a no-op when no window is open.
- Header buttons never start a drag, because they get no `pointerdown` handler.

### 3.4 Stacking order

- Each layer (app, debug) keeps a stack of open window ids. `bringDraggableWindowToFront(id)` moves the id to the top and sets `z = layerBase + 2 × index`. Only windows whose index changed get a style write.
  - A window's backdrop gets `z − 1`.
  - Bases: app 100, staying below 1000 (enough for about 450 windows); debug 20000.
  - `customZIndex` windows keep their fixed value, as today.
- A click anywhere in a window brings it to the front (a `pointerdown` in the capture phase on the window element). `isActive` follows the top of the stack.
- `isDraggableWindowOnTop(id)` is exported (§3.8).
- The LS `orderNr` becomes the stack index, so a reload restores the full order, not just "active last".

### 3.5 Geometry and units (fixes §2.2)

- **Draggable windows always store and render `left/top` in px.**
  - A non-px position prop is converted when the window first mounts, keeping today's meaning (the value is the window's centre): `left = value × viewport / 100 − w / 2`, with `%` and `vw` using the width and `vh` the height.
  - It is then stored as px, and `units.position` is dropped.
  - There is no translate on draggable windows.
- **Non-draggable windows with a non-px position (dialogs)** stay CSS-centred: unit `left/top` plus the translate, so they follow a resize without JS. The clamp and fit (§3.6, §3.7) skip them.
- **Size units** (`size`, `minSize`, `maxSize`) stay CSS units. A manual resize writes the new size in px and switches that axis's unit to px.
- **The default `maxSize`** is `100vw × 100vh` instead of the px snapshot taken at open time.
- **All geometry reads** come from `getBoundingClientRect()`, never from `offsetLeft`/`offsetTop`.

### 3.6 Keeping windows reachable (fixes §2.3)

The title area of the header is the part that can be dragged (the header minus its buttons). There are two rules:

- **While dragging and at drag end, `clampToGrabbable`:**
  - at least `MIN_GRAB_VISIBLE_PX` (80) of the title area stays horizontally inside the viewport
  - the header stays vertically inside the viewport: `0 ≤ y ≤ viewportH − headerH`
  - so a window can hang off an edge, but never with only its buttons showing
- **On a viewport resize (debounced, about 150 ms), at mount and at a restore from LS, `keepOnScreen`:**
  - a window that fits is shifted until it is fully visible
  - a window larger than the viewport is aligned to the top-left edge (x and y = 0)
  - the size doesn't change (only the fit actions in §3.7 resize)
  - the changed geometry is saved once per resize, not per window

### 3.7 Fit to screen (double-click and the Debug tools button)

**`fitDraggableWindowToScreen(id, cascadeIndex = 0)`** (exported):

- **Skips** closed windows and windows with `disableDragging`. Dialogs always set it, so they are excluded.
- **Steps:**
  1. Place the window at `y = FIT_MARGIN_PX` (8) and center it horizontally.
  2. If it is wider than `viewportW − 2 × margin` and horizontally resizable, shrink it to that width, but never below `minSize`.
  3. If it is taller than `viewportH − 2 × margin − cascadeOffset` and vertically resizable, shrink it the same way.
  4. A window that still overflows (not resizable, or at its `minSize`) falls back to `keepOnScreen`.
- **Collapsed windows** move, and their stored expanded height is fitted, so they fit when expanded.
- **Cascade:** `cascadeOffset = cascadeIndex × headerH`, added to both x and y. The index wraps when the offset would pass a third of the viewport.
- **Header double-click** (outside the buttons) calls it with index 0.

**`fitAllDraggableWindowsToScreen()`** (exported):

- Fits every open draggable window, app and debug windows alike.
- The cascade index is each window's position in its layer's stack, counted from the bottom. The top window therefore lands last, at the largest offset, and every header stays visible.
- It saves once.
- **Debug tools button:** "Center and fit all windows", added after "App key shortcuts" (`_dbg__DebugTools.ts:425`), before the separator. With no window open it shows `addDebugToast('No open windows')`.
- No undo. Window layout isn't scene data, so it is treated like navigation.

### 3.8 Window kinds (multi-window support)

**The window props get `kind?: string`, which is persisted.**

- Kind windows have ids made by `getKindWindowId(kind, key)` = `${kind}_${key}`. The Character windows already use this format, so their saved ids don't change.
- Without `kind`, a window's kind is its id, so every single-window caller works as before.

**The registries are keyed by kind.**

- `registerDraggableWindowContentFn` and `registerDraggableWindowSceneTargetResolver` look up `config.kind ?? config.id`.
- One registration covers every window of the kind, including windows restored from LS. This replaces the per-window resolver registration and `registerDraggableWindowCmp` re-attaching in the Character modules.

**New helpers:**

- `getDraggableWindowsOfKind(kind, onlyOpen = true)`.
- `updateDraggableWindowsOfKind(kind)`, which rebuilds all open windows of the kind.
- `toggleDraggableWindow(props)`, the list-row click rule:
  - not open → open it
  - open but not on top → bring it to the front
  - on top → close it
- `getDraggableWindowsStartingWith` and `closeAllDraggableWindowsStartingWith` stay, marked `@deprecated` in favour of the kind helpers.

**Placement of a new kind window:**

- It starts from the kind's last geometry (`kindGeometry[kind]`, in LS under the same key). That geometry is updated whenever any window of the kind ends a drag or resize, or closes.
- When the kind has no geometry yet, the caller's position and size are used.
- It is offset by `headerH × number of open windows of the kind` (wrapping like §3.7), then `keepOnScreen` is applied.

**Closing a kind window removes it** (its config and LS entry), after its geometry is stored as the kind's. Closed per-entity windows therefore don't pile up in LS. This replaces the Character state window's `removeOnClose` `@TODO`.

**LS migration:**

- A stored entry whose id equals a now-registered kind (the old fixed ids such as `lightEditorWindow`) seeds that kind's geometry and is dropped.
- That window doesn't reopen once after the update. This is acceptable for a debug-only window and is noted in the changelog.

### 3.9 Edit windows: one window per entity

Each edit-window module moves to the same pattern:

- **The kind** is the old fixed id constant (e.g. `EDIT_LIGHT_WIN_ID`). The key is the list row id, i.e. the app id, or the entity id when there is none.
- **The row click** calls `toggleDraggableWindow(...)`. `data` keeps the target as today, and `winId` becomes the per-entity id.
- **`selectedItemId`** returns the target keys of every open window of the kind (an array), like Characters.
- **Module update functions** take an optional target key:
  - Undo handlers, field edits and per-entity deletes rebuild only that target's window: `updateDraggableWindow(getKindWindowId(kind, key))`, or close it on delete.
  - Global actions (e.g. `_toggleAllLightHelpers`, `_dbg__LightGUI.ts:1288`) call `updateDraggableWindowsOfKind`.
- **Module state that assumed one window becomes per window**, a `Map` keyed by window id that is cleaned up in the content CMP's `onRemoveCmp`. This covers `openWorldEditRefresh`, `infoWindowCmp`, `entityWindowCmp`/`entityWindowPane` and `windowBuiltFor` (§2.4). Each module is also checked for closures that assume one window.
- **The `setTimeout` / `queueMicrotask` `onClose` re-attach workarounds** (e.g. `_dbg__Assets.ts:693-700`, `_dbg__PhysicsAPI.ts:985-993`) go away where kind registration (§3.8) covers them.
- **The Character edit window** uses `closeOnSceneChange` with a kind resolver (`getCharacterById`) instead of `removeOnSceneChange` (the `@TODO` at `_dbg__Character.ts:259`). If a rebuild across scenes still fails, it keeps `removeOnSceneChange`, and the reason is recorded here.
- **Not changed:** the ray tester windows, the dialogs and the Debug tools test windows.

---

## 4. Phases (each non-breaking and committable on its own)

### Phase 1: Internal refactor and small bug fixes — done

- §3.1, §3.2, §3.3 and §3.4. The public API and the props stay as they are.
- Fix the §2.1 bugs: the dropped `concat`, the `minSize.w` height clamp, the `typeof content` check, the double `onClose`, `onClose` on rebuild, live reset not moving the window, the stale last LS entry, and the LS parse on every lookup.
- Visible change: windows stack in click order.
- Check: every window kind still opens, drags, resizes, collapses, restores after a reload and handles a scene change as before (Verification 2–3).
- As built, where it differs from §3:
  - LS is read once, on the module's first use, not in `loadDraggableWindowStatesFromLS`. The Assets and Physics modules look their window up (to re-attach its content) from a `setTimeout(0)` that can run before the load.
  - A closed window keeps no DOM: closing tears its content down, and reopening builds it fresh (a reopened dialog no longer shows its previous content).
  - `updateDraggableWindow` rebuilds only the content, so a refresh doesn't bring the window to the front or reset its scroll.
  - A reopen that changes a structural flag (resize handles, header buttons, backdrop, layer) remounts the window.
  - Also fixed: the clear-LS scope dialog (`confirmClearScope`) opened in the app layer, under the debug windows.

### Phase 2: Units and keeping windows reachable — done

- §3.5 and §3.6.
- Fixes issue 1 (non-px units) and issue 2 (lost windows).
- As built, where it differs from §3:
  - `keepOnScreen` works per axis: a window wider than the viewport goes to x = 0 but keeps its y (and the other way round).
  - `keepOnScreen` runs when a window mounts (open, reload restore, scene change rebuild) and on a `resetPosition`/`resetSize` reopen. A reopen of a live window without a reset keeps its place, so a window hung off an edge on purpose stays there.
  - The default position (no `position` prop) is the viewport's centre as `50% / 50%`, converted at mount like any non-px position. A non-draggable px window without a position is therefore CSS-centred now.
  - Units go with their value when resolving: a stored position or size keeps its stored units, a passed one takes the passed units. A caller that passes a `%` position on every open keeps the user's stored px place.
  - `maxSize` is optional in the config and is always stored with its `units.maxSize`. A stored `maxSize` without units is a pre-p094 viewport snapshot and is dropped on load.
  - The grab area is the header's `h3` title (measured at drag start), and a resize end always saves (its units may change while the numbers don't).
  - Verification 4: the Debug tools test window uses a px position, so the `%` path was checked by opening windows through the module in a headless browser.

### Phase 3: Fit to screen — done

- §3.7: `fitDraggableWindowToScreen`, the header double-click, `fitAllDraggableWindowsToScreen` and the Debug tools button.
- As built, where it differs from §3:
  - The cascade index runs over the app stack and then the debug stack, not per layer: per-layer indices would put the bottom debug window exactly over the bottom app window's header. Only fitted windows count.
  - The width is fitted to `viewportW − 2 × margin` without the cascade offset. The x position is clamped so the right edge stays inside the margin, so a wide window gives up its x offset; the y offset alone keeps the headers apart.
  - The CSS min/max size clamps the shrunk size (like a manual resize), and a shrunk axis is stored in px.
  - A collapsed window is measured and fitted with `collapsed` removed and transitions off, then collapsed again in the same frame (no flash, no animation).
  - A window that still overflows after the fit (not resizable, or held by its min size) takes `keepOnScreen` and loses its cascade offset on that axis. Its title stays visible, but it can cover the header buttons of windows below it.
  - `fitDraggableWindowToScreen` returns whether the window was fitted, and `fitAllDraggableWindowsToScreen` returns the number of windows fitted (the button's toast uses it).

### Phase 4: Window kinds

- §3.8, in `DraggableWindow.ts` only.
- No caller changes yet, so single-id windows behave exactly as before.

### Phase 5: Edit windows, one per entity

- §3.9, one commit per group:
  - **5a:** Light and Camera
  - **5b:** ECS world, PostFX pass, Physics entity and Assets info (these hold the single-window module state)
  - **5c:** Character edit and Character state (kind registries; drop the per-window resolver and the `registerDraggableWindowCmp` re-attach)

### Phase 6: Docs and version

- Engine minor bump with a `CHANGELOG.md` entry. It mentions the one-time loss of the old fixed-id edit windows' open state (§3.8).
- `CLAUDE.md` Debug system: one line on window kinds, `toggleDraggableWindow`, the fit actions and the header double-click.
- `readme.md` only if its debug suite line lists window features.

---

## 5. Risks and notes

- **Hidden single-window assumptions** in the edit-window modules beyond the four known ones (§2.4). This is the main risk of Phase 5. Each group audits its module's module-level `let`s and closures before switching, and runs Verification 5 with two windows of the kind.
- **Code that relied on `onClose` running on rebuild** (Phase 1), e.g. a list refresh after `updateDraggableWindow`. Audit the `onClose` handlers (they are mostly `updateDebuggerTab` / `refresh*Tab`), and call them explicitly where a rebuild needs them.
- **Rebuild cost.** Global actions now rebuild N Tweakpane windows instead of one. This is fine for debug tooling. Targeted updates (§3.9) keep the common path at one rebuild.
- **The one-time LS loss** of the old fixed-id windows (§3.8). It is debug-only and in the changelog.
- **Pointer capture** only applies to the header and handles. Content (Tweakpane, inputs) never sees a captured pointer.
- **`DialogWindow.ts`** keeps working: it passes `disableDragging` and a `%` centre position (§3.5), and the Escape stack still gets `windowCMP` from `getDraggableWindow`.

---

## 6. Out of scope / related plans

- **Migrating the edit windows to the declarative pane builder** (the p105 follow-up in `p990_follow-ups-from-done-plans.md`). This plan only changes how many windows can be open and how they are managed.
- **`p150_current-entity-data-source-info-on-edit-windows.md`** extends the Light and Camera window footers. There is no conflict, but its line references will move after Phase 5a.
- **Touch-specific window handling.** Pointer events make touch dragging work as a side effect, but it isn't a goal.
- **A key binding for "Center and fit all windows".** Easy to add later through `DefaultDebugKeyBindings.ts` with a `category`.

---

## 7. Verification

There is no test suite. Check in the running app (`yarn dev`, `?isDebug=true`, headless Chrome through the run skill or by hand):

1. `yarn lint` and `yarn build` pass after every phase.
2. **Phase 1:**
   - Open, drag, resize (each handle), collapse and close a Light edit window, a Character state window, the ray tester windows, the Debug key shortcuts dialog (Escape still closes it) and the clear-LS confirm dialog.
   - Reload: windows come back in the same order and place.
   - Switch scenes: windows with a resolver stay or close as before.
   - Clicking through three windows stacks them in click order.
3. **LS:** close the last saveable window and reload. It doesn't come back. `AEK_popupWindows` has no runtime keys.
4. **Phase 2:**
   - Open the Debug tools test window with `units.position` `%`: no jump at drag start. Reload: it is in the same place.
   - Drag a window to the right edge: at least 80 px of its title stays visible, and it can be dragged back.
   - Shrink the browser window: every window comes fully back on screen, or to the top-left if it is larger than the viewport.
   - Reload on a smaller viewport: the same.
5. **Phases 3–5:**
   - Double-click a header: the window moves to the top center, and a tall resizable window shrinks to fit. Double-clicking a dialog does nothing.
   - Open three Light and two Camera windows. They cascade from the kind's last spot, and the list shows all of them as selected.
   - Clicking a row whose window is buried brings it to the front. Clicking it again closes it.
   - Edit one light: only its window rebuilds. Undo and redo refresh the right window.
   - Delete an entity: only its window closes.
   - Switch to a scene that has some of the lights: only those windows stay.
   - Reload: all of them come back.
   - Repeat with two windows each for ECS world, PostFX, Physics and Assets: no cross-talk between windows.
   - "Center and fit all windows" cascades every open window with every header visible.
6. **Bundle:** `dist-stats/bundle-stats.html` shows no new debug code in the production main chunk (the fit and kind helpers are small engine code; the Debug tools button stays in its `_dbg__` chunk).
