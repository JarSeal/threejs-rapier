Status: draft | not-implemented
Category: Debugger, Refactoring
Related: p100_small-bug-fixes-and-tweaks.md (§8.1 `_disableDebugger` bug lives in the same file), p125_spatial-index-system-visualizer.md (should be built on the new API), p067_character-state-debugger-window.md (touches the Characters tab), p111_skybox-core-refactor-and-layered-schema.md (rewrites the SkyBox tab folder-per-layer; see Phase 4), p080_multi-viewport-rendering-and-axis-gizmo.md and p115_debug-environment-ball-viewport.md (add Debug Tools options this plan migrates)

# Refactor Debugger Drawer Tab Creation — Plan

Replace today's multi-step tab setup with **one declarative call**. The call takes an id, title, icon, optional order number, optional localStorage key and a content array, and builds the whole tab: menu button, heading row, content container, Tweakpane instances and CMP sections. A single `updateDebuggerTab(id)` refreshes a tab, and does nothing unless that tab is the one visible. A new shared `debuggerListCMP` replaces the seven hand-rolled HTML-string lists, and adds small per-row icon toggles. All 14 existing tabs are migrated, then the old API is removed.

## Context (grounded in code)

- **Today a tab takes 3–5 separate calls.** Each tab module does all of this by hand:
  - `createDebuggerTab({ id, buttonText: getSvgIcon(..), title, orderNr, container: () => {...} })` (`debug/DebuggerGUI.ts:46`).
  - `createClearTabLSButton` / `createClearListLSButton` (`core/Debug/_dbg__ClearLSButtons.ts:50,53`).
  - `createNewDebuggerPane(id, `${icon} Heading`, [buttons])` or `createNewDebuggerContainer(...)` (`debug/DebuggerGUI.ts:61,86`).
  - Hand-written `addBinding(...).on('change', () => lsSetItem(KEY, state))` per input.
  - Its own `updateXDebuggerGUI()` function.
  The implementation is `core/Debug/_dbg__DebuggerGUI.ts` (338 lines).
- **The registry is a plain array with no de-duplication** (`_dbg__DebuggerGUI.ts:55`). Every registration rebuilds the whole drawer (`:268-277`). `container()` is re-run on every tab click (`:66-96`), so intervals and subscriptions have to be torn down by hand in `onRemoveCmp`. Comments about this sit at `_dbg__SpatialGrid.ts:142-149`, `_dbg__PhysicsAPI.ts:972-995` and `_dbg__ECS.ts:258-263`.
- **Order is only per-call-site `orderNr`.** Missing values count as 9999 and are sorted at `:166-175`. The values in use are 3, 4, 5, 6, 6, 7, 8, 9, 10, 10, 11, 14, 15, 16. Two collide: DebugTools and PhysicsAPI are both 6, and Raycast and Lights are both 10; ties fall back to registration order. `CONFIG.ts` and `core/Config.ts` have no drawer settings.
- **"Is this tab open?" is checked ad hoc:**
  - `_dbg__Raycast.ts:323-325` compares `getDrawerState().currentTabId`.
  - `_dbg__PostFX.ts:152` and others check `elem.isConnected`.
  - Most tabs don't check at all.
  - `drawerState.currentTabId` defaults to `'stats'` (`:29`), which is not a real id (the real one is `statsControls`).
- **Every tab's persistence is hand-rolled** with `lsGetItem`/`lsSetItem` (`utils/LocalAndSessionStorage.ts:75,92`):
  - Values are persisted per binding with `.on('change', () => lsSetItem(KEY, wholeStateObject))`, e.g. `_dbg__MainLoop.ts:35-66` and `_dbg__Renderer.ts:122-231`.
  - Folder state is persisted through `.on('fold')`, e.g. `_dbg__Stats.ts:307-327`.
  - Values are loaded with `{...defaults, ...lsGetItem(KEY, defaults)}` at module init.
  - `pane.exportState()` is not used anywhere.
  - Most keys are **flat objects of a module-owned state object**. That matters for migration: the new layer can keep the same shape and key names.
- **Some persistence is not "tab state" and must stay module-owned:**
  - Scene-scoped `{ [sceneId]: {...} }` keys: `AEK_debugLights`, `AEK_debugCams`, `AEK_debugSkyBoxStates` (replaced by the deviation-only `AEK_debugSkyBox` in p111), `AEK_debugPostFx`.
  - Boot keys that `core/Config.ts:279-350` reads before any debug module loads: `AEK_debugPhysicsApiBoot`, `AEK_debugAssetsBoot`.
  - p071's deviation-only keys: `AEK_debugPostFxSettings`.
  - List/entity override keys: `AEK_debugPhysicsApiEntities`, `AEK_debugPhysicsApiWireframe`.
- **Undo is recorded from inside tab change handlers**, with `_recordUndoRedoAction(type, label, { prev, next })` (`_dbg__UndoRedo.ts:155`):
  - Renderer (`_dbg__Renderer.ts:77-86`), PhysicsAPI (`:268`), SkyBox (`:427`) and PostFX (`:639`) do this.
  - Each keeps its own `prev` bookkeeping and an `isApplyingUndoRedo` guard around `pane.refresh()` (`_dbg__Renderer.ts:33,58-68`).
  - The guard exists because **Tweakpane's `refresh()` emits `change` events.** `@tweakpane/core` `InputBindingValue.fetch()` sets `rawValue`, which fires the value emitter.
- **There are seven hand-rolled lists and none is shared:**
  - Lights: `Light/_dbg__LightGUI.ts:1004`.
  - Cameras: `Camera/_dbg__CameraGUI.ts:426`.
  - Physics entities: `_dbg__PhysicsAPI.ts:345`.
  - PostFX passes: `_dbg__PostFX.ts:114`.
  - Assets: `_dbg__Assets.ts:199`.
  - Characters: `_dbg__Character.ts:287`.
  - ECS worlds: `_dbg__ECS.ts:299`.

  They all work the same way:
  - The markup is an HTML string: `<ul class="ulList">`, each row `<li data-id>` holding a `CMP({ onClick, html: '<button class="listItemWithId">…' })`, plus `li.emptyState`.
  - A per-module `updateXListSelectedClass(id)` toggles `.selected`.
  - Some lists skip re-rendering with a signature check (`_dbg__PhysicsAPI.ts:981-990`, `_dbg__Assets.ts`).
  - **No list has inline toggles.** Every per-item control lives in an edit window.
- **CMP facts this design relies on (`utils/CMP.ts`):**
  - Every CMP has `isCmp: true` (`:243`), which is how `add()` tells CMP instances from props (`:311`).
  - `cmp.update()` re-runs an `html` function. It rebuilds and replaces the element (`:623-687`), so a Tweakpane mounted inside a plain CMP is lost on update.
  - `remove()` nulls the CMP's fields (`:571-613`), so a removed CMP cannot be mounted again.
- **There is a known leak:** `_dbg__Stats.ts:293` pushes a new `Pane` into `statsDebugGUIs` on every tab click and never removes it.
- **Icons** are `getSvgIcon(key: keyof typeof icons, size?)` in `core/UI/icons/SvgIcon.ts`, which returns an HTML string. No `SvgIconKey` type is exported.
- **Nothing outside `src/_engine/core/Debug/` creates tabs.** `src/app` and `src/toolkit` have zero call sites, so migration is fully inside the engine.

## Design decisions

1. **One call: `createDebuggerTab(def)`.** It lives in `debug/DebuggerGUI.ts` (public, thin), with the implementation in `core/Debug/_dbg__DebuggerGUI.ts`.

   ```ts
   type DebuggerTabDef<S extends object = object> = {
     id: string;                         // unique; re-registering an id replaces the tab
     title: string;                      // heading text + menu button tooltip
     icon: SvgIconKey;                   // menu button + heading icon
     orderNr?: number;                   // explicit override of CONFIG tabOrder (see 3)
     lsKey?: string;                     // no key → nothing is persisted
     state?: S;                          // module-owned object the pane binds to by default
     headerButtons?: () => TCMP[];       // extra heading-row buttons (eg. clear list LS)
     clearLSButton?: boolean;            // default true when lsKey is set
     onClearLS?: () => void;             // optional: also reset live state on clear
     refreshIntervalMs?: number;         // auto updateDebuggerTab(id) while visible
     onOpen?: () => void | (() => void); // runs on mount; returned fn runs on unmount
     content: () => DebuggerTabSection<S>[];
   };
   type DebuggerTabSection<S> = TCMP | DebuggerPaneSection<S>;
   type DebuggerPaneSection<S> = { pane: true; id?: string; title?: string; content: DebuggerPaneItem<S>[] };
   ```

   The call builds these pieces:
   - The menu button from `getSvgIcon(icon)` with `title` as its tooltip.
   - The heading row `${icon} ${title}`, followed by the auto clear-LS button and then `headerButtons()`.
   - The content container.
   - Each section in array order. A section that has `'isCmp' in s` is mounted as is. A section with `pane: true` gets a new `Pane` in its own container. Every pane is disposed when the tab unmounts.

   `SvgIconKey` gets exported from `SvgIcon.ts`.

2. **`content` is a factory, not a static array.** The spec's example lists `CMP(...)` instances. Those can't survive a tab switch, because `remove()` destroys them. The factory runs on every mount and every rebuild, just as `container()` does today, so the array literal from the spec is written unchanged inside `content: () => [ ... ]`.

3. **Ordering: a CONFIG array first, then explicit `orderNr`.**
   - New `AppConfig.debugDrawer?: { tabOrder?: string[] }`, with the engine default in `core/Config.ts`. The app's `CONFIG.ts` can replace it (arrays are replaced whole, not merged).
   - A tab's sort value is `orderNr ?? tabOrder.indexOf(id)`, where **the index is 0-based**. So `orderNr: 1.8` lands between the 2nd tab (1) and the 3rd (2), as specified.
   - A tab that is in neither gets `Infinity` and keeps its registration order. Duplicate values are fine, since the sort is stable.
   - The engine default array freezes **today's on-screen order**. Phase 1 must read the two tie-broken pairs (6 and 10) from the running drawer rather than guessing.
   - `drawerState.currentTabId`'s bogus `'stats'` default becomes "first tab in order".

4. **`updateDebuggerTab(id, opts?: { rebuild?: boolean })` plus `isDebuggerTabOpen(id)`.**
   - `isDebuggerTabOpen` is true when the drawer is built, the drawer is open, and `currentTabId === id`.
   - `updateDebuggerTab` returns early when that is false. A closed tab is rebuilt from `content()` on its next mount anyway, so skipping is always correct.
   - By default it **refreshes**:
     - Each pane re-evaluates `hidden` and `disabled`, then calls `pane.refresh()` with change callbacks suppressed (see 6).
     - Each `debuggerListCMP` re-renders if its data signature changed.
     - Plain CMP sections are updated only if their `html` prop is a function (a dynamic template). Static CMPs are left alone.
   - `{ rebuild: true }` unmounts the tab and re-runs `content()`, for structural changes such as the SkyBox type switch or Raycast's rebuild. Scroll position is kept.
   - Opening the drawer refreshes the current tab once.
   - This replaces `refreshAppPlayBinding`, `_updateStatsDebugGUI`, the Raycast open-check, and the list half of every `updateXDebuggerGUI(only)`. The edit-window half stays in each module.

5. **The declarative pane format.** It keeps flat Tweakpane params, as the spec asks ("inputs with label, min, step…").

   ```ts
   type DebuggerPaneItem<S> =
     | DebuggerPaneBinding<S>
     | { type: 'folder'; id?: string; title: string; expanded?: boolean; persist?: boolean;
         hidden?: Dyn<boolean>; content: DebuggerPaneItem<S>[] }
     | { type: 'button'; title: string; label?: string; hidden?: Dyn<boolean>; disabled?: Dyn<boolean>; onClick: () => void }
     | { type: 'separator'; hidden?: Dyn<boolean> }
     | { type: 'custom'; build: (parent: Pane | FolderApi) => void }; // escape hatch
   type DebuggerPaneBinding<S> = Omit<BindingParams, 'hidden' | 'disabled'> & {
     type?: 'binding';                 // default
     key: string;                      // property on `target` (default: the tab's `state`)
     target?: object;                  // foreign object — never persisted
     persist?: boolean;                // default: inherited (folder → tab), true when lsKey set
     hidden?: Dyn<boolean>; disabled?: Dyn<boolean>;
     onChange?: (value: unknown, e: { prev: unknown; last: boolean; api: BindingApi }) => void;
     onCreate?: (api: BindingApi) => void;
   };
   type Dyn<T> = T | (() => T);
   ```

   - `options` / `readonly` / `view: 'graph'` pass straight through to `addBinding`. That turns today's `addBlade({ view: 'list' })` plus manual `value` sync into ordinary state bindings.
   - The `custom` item is the escape hatch for anything the format doesn't cover (plugins, odd blades). It keeps the refactor from stalling on edge cases.

6. **Built-in `change` semantics.**
   - The builder tracks `prev` per binding and passes it to `onChange`. That lets undo recording drop its hand-kept `prev` values and `isApplyingUndoRedo` guards (e.g. `recordChange(key, e.prev, value)`).
   - `onChange` fires **only for user input.** It is suppressed during hydration, `refresh()`, and rebuild. This is necessary because Tweakpane's `refresh()` emits `change`.
   - `e.last` passes through, which gives `_recordOrCoalesceUndoRedoAction` and drag-end logic what they need.

7. **Persistence.**
   - **Values.** When `lsKey` and `state` are both set, the tab's values are stored under `lsKey` as a **flat object of `state` keys**. That is the same shape most tabs already write, so existing saved settings keep working without a migration.
     - A change writes `{ ...saved, [key]: value }` on `e.last`, never on every drag tick.
     - `persist: false` on a binding or folder opts it out. Nested items inherit the folder's opt-out and can opt back in.
     - Bindings to a foreign `target` are never persisted, because there is nothing to hydrate them into before the tab is first opened. A `persist: true` on one gets a dev `lwarn`.
   - **Hydration** (`Object.assign(state, lsGetItem(lsKey, {}))`) runs synchronously in the **public wrapper** at registration, gated by `IS_DEBUG_ENV || IS_PROD_TEST_MODE`.
     - It does not wait for the lazy module or the first tab open. So a module can apply hydrated values at boot and in prod-test, exactly as its own `lsGetItem` calls do today.
     - Modules still apply side effects themselves (e.g. `maxFPSInterval`) right after registration.
   - **Folder open/closed state** goes to `${lsKey}UI` as `{ folders: { [folderId]: boolean } }`, which follows the existing `…UI` key convention. `folderId` defaults to the folder's title path.
   - **No `lsKey` means nothing is saved,** including folder state.
   - **The auto clear-LS button** is `createClearTabLSButton` with `watchKey: lsKey`. It removes the values key only, and calls `onClearLS` if given. Folder state is UI and stays.
   - **Module-owned keys stay module-owned:** scene-scoped keys, boot keys, list and entity overrides, deviation-only keys. They keep their own `headerButtons` (e.g. `createClearListLSButton`, `confirmClearScope`).

8. **`debuggerListCMP(def)`** is a new shared component in `core/Debug/_dbg__DebuggerList.ts`, with a public wrapper and types in `debug/DebuggerGUI.ts`.

   ```ts
   type DebuggerListDef = {
     id?: string;                                      // DOM id `debuggerList-${id}`; auto if omitted
     heading?: string;                                 // rendered above the list (+ item count)
     emptyText?: string;                               // `li.emptyState`
     perItemConfig?: {
       toggles?: { icon: SvgIconKey; iconOff?: SvgIconKey; title: string;
                   fn: (itemId: string, nextValue: boolean) => void }[];
       onClick?: (itemId: string) => void;             // usually opens the edit window
     };
     selectedItemId?: () => string | null;             // replaces updateXListSelectedClass
     data: DebuggerListItem[] | (() => DebuggerListItem[]);
   };
   type DebuggerListItem = {
     itemId: string; title: string; subTitle?: string; icon?: SvgIconKey;
     toggleValues?: (boolean | null)[];                // index-aligned with toggles; null = not applicable
     disabled?: boolean; tooltip?: string; titlePlaceholder?: boolean; // dimmed row / italic fallback name
   };
   ```

   **Markup.** Each row is `<li data-id>` containing the row button (`.listItemWithId`: `subTitle` in the small `.itemId` line at the top, then optional icon, then the `title` `<h4>`) and a **sibling** `.debuggerListToggles` group. The toggles are small icon `<button aria-pressed title>` elements on the right. They are siblings of the row button because nested buttons are invalid HTML, and it also means a toggle click never triggers the row's `onClick`. The row styles (`.ulList`, `.selected`, `.disabledItem`, `.emptyState`) are reused, so the look doesn't change. The only new SCSS is the toggle group.

   **Behaviour:**
   - A toggle calls `fn(itemId, !current)` and then re-renders the list.
   - A static `data` array flips its value locally. A `data()` function is simply read again.
   - Re-rendering is skipped when the data signature is unchanged, which replaces the per-module signature checks.
   - A `null` in `toggleValues` hides that toggle for that row (e.g. a camera with no helper).

9. **Toggle functions reuse the edit window's setters.** A row toggle must go through the same path the edit window uses, so the undo record, the LS override and an open edit window (`updateDraggableWindow`) stay consistent. The initial toggle set to confirm per phase:

   | List | Toggles |
   | --- | --- |
   | Lights | **Enabled** (`setLightEnabled`) and **Helper** (the per-light helper pref in `AEK_debugLights`) |
   | Physics entities | **Wireframe** (`setWireframeVisible`) |
   | Cameras | **Helper**, if a per-camera helper pref exists; otherwise none |
   | PostFX | none (p071 Design decision 9 deliberately kept the pass toggle off the row: shader recompile hitch) |
   | Assets, Characters, ECS worlds | none |

10. **Lifecycle replaces hand-rolled cleanup.**
    - `refreshIntervalMs` covers the 500 ms intervals in PhysicsAPI, Assets and SpatialGrid. It runs only while the tab is visible and is cleared on switch, close and rebuild.
    - `onOpen` returns a cleanup function (effect-style) for anything else, such as ECS's 1 s benchmark interval or `lsSubscribe`.
    - DebugTools's wrapped `container.props.onRemoveCmp` (`_dbg__DebugTools.ts:133-140`) moves to `onOpen` too.

11. **The migration period is non-breaking.**
    - Phases 1–5 accept both the old shape (`buttonText` plus `container`) and the new one (`title` plus `icon` plus `content`), as a discriminated union on `'content' in def`. Unmigrated tabs keep working.
    - Both kinds share the one registry, the ordering rules and `updateDebuggerTab`.
    - Phase 6 deletes the legacy branch.

12. **Layering is unchanged.** All new logic goes in `_dbg__` files: `_dbg__DebuggerGUI.ts`, plus new `_dbg__DebuggerPaneBuilder.ts` and `_dbg__DebuggerList.ts`. `debug/DebuggerGUI.ts` holds only types (`import type`), thin `useDebug` wrappers, and the small synchronous hydration step. None of it reaches the production chunk.

## Files touched

- `src/_engine/debug/DebuggerGUI.ts`: new types; the new-shape `createDebuggerTab` with hydration; `updateDebuggerTab`, `isDebuggerTabOpen` and `debuggerListCMP` wrappers. `createNewDebuggerPane` and `createNewDebuggerContainer` are removed in Phase 6.
- `src/_engine/core/Debug/_dbg__DebuggerGUI.ts`: registry keyed by id, ordering, heading, section mounting, lifecycle, refresh and rebuild.
- `src/_engine/core/Debug/_dbg__DebuggerPaneBuilder.ts` (new): the declarative pane builder, persistence and change suppression.
- `src/_engine/core/Debug/_dbg__DebuggerList.ts` (new) plus `DebuggerGUI.module.scss`: the list component and its toggle styles.
- `src/_engine/core/Config.ts` (`AppConfig.debugDrawer.tabOrder` and its default) and `src/CONFIG.ts` (a commented example).
- `src/_engine/core/UI/icons/SvgIcon.ts`: `export type SvgIconKey`.
- All 14 tab modules. Representative ones: `_dbg__MainLoop.ts`, `_dbg__Renderer.ts`, `Light/_dbg__LightGUI.ts`, `_dbg__PhysicsAPI.ts`.
- `.claude/CLAUDE.md`: the debug-system paragraph (Phase 6).

## Phases

Each phase is non-breaking and can be committed on its own.

**Phase 1: Registry, ordering and tab shell.**
- Id-keyed registry, where re-registering replaces the tab.
- The union API (Design decision 11) and the heading row with icon, title, auto clear-LS button and `headerButtons`.
- Mounting of CMP sections.
- `debugDrawer.tabOrder` (0-based) plus the `orderNr` override, with the default array frozen from the current on-screen order.
- `updateDebuggerTab` and `isDebuggerTabOpen`, `refreshIntervalMs`, `onOpen` cleanup, and the refresh on drawer open.
- The `currentTabId` default fix.
- Raycast's open-check switches to `isDebuggerTabOpen`.
- No other tab is migrated.

Manual verification (`yarn dev`, `?isDebug=true`):
- All 14 tabs appear in exactly the old order, with the old behaviour.
- Reordering `tabOrder` in `CONFIG.ts` and giving a tab `orderNr: 1.8` place it as specified.
- Reloading restores the selected tab and its scroll position.

**Phase 2: Pane builder and persistence.** Implement `_dbg__DebuggerPaneBuilder.ts` (Design decisions 5–7). Migrate these pilots:
- **Loop**: the simplest tab. `refreshAppPlayBinding` becomes `updateDebuggerTab`.
- **Renderer**: undo through `e.prev`, `options` dropdowns replacing `addBlade` lists, and reload-on-change bindings.
- **SpatialGrid**: its interval becomes `refreshIntervalMs`.

Manual verification:
- Existing saved values in `AEK_debugLoop` and `debugRenderer` survive the migration.
- `persist: false` really doesn't save.
- Folder state survives a reload under `…UI`.
- Undo and redo of tone mapping and shadows work, and the refresh doesn't record anything (no ghost undo entries).
- A tab without `lsKey` writes nothing to LS.
- Loop values still apply at boot, before the tab is opened.

**Phase 3: `debuggerListCMP`.**
- Implement the component and its SCSS.
- Migrate **Lights**, which gets the Enabled and Helper toggles, and **Cameras** and **Characters** (both have simple lists).
- Delete their `updateXListSelectedClass` helpers.

Manual verification:
- The lists look the same as before.
- Toggles flip the light or helper, record undo, update an open edit window, and persist per scene.
- A toggle click never opens the edit window.
- Row click, selected highlight and re-opening the edit window after a reload all still work.
- Keyboard focus reaches the toggles.

**Phase 4: Remaining pane-only tabs.**
- **Stats**: folders with persisted fold state and reload bindings. This also fixes the `statsDebugGUIs` leak.
- **DebugTools**: its `onRemoveCmp` wrapper moves to `onOpen`. The axes gizmo options (p080) and the "Environment ball" section (p115: "Show environment ball [F7]", "Show env ball in main camera", "Env ball roughness", top-level `envBall` state) migrate with the rest of the tab; their F8/F7 shortcuts switch from a manual pane refresh to `updateDebuggerTab`.
- **Raycast**: its rebuild uses `{ rebuild: true }`, and its stats CMP becomes a dynamic-`html` section.
- **SkyBox**: if p111 has landed, migrate its folder-per-layer tab (one pane section per `_dbg__*Folder.ts`, bindings on `skybox.param`). Layer toggles are structural and use `{ rebuild: true }`. The module-owned `AEK_debugSkyBox` key stays module-owned. If p111 has not landed, its in-place blade dispose-and-rebuild becomes `hidden` functions or `{ rebuild: true }`.

Manual verification: each tab works as before, and switching tabs repeatedly leaves no stray intervals or panes (check the console and the DevTools memory snapshot).

**Phase 5: Mixed pane-and-list tabs.** Migrate:
- **PhysicsAPI**: the largest tab, about 1000 lines. Its entity list gets the Wireframe toggle. It may be committed on its own.
- **Assets**
- **PostFX**: no row toggle (Design decision 9).
- **ECS**: its manual `new Pane` becomes a pane section, and the benchmark interval moves to `onOpen`.

Every module-owned LS key keeps its name and shape.

Manual verification: per tab as before. Also check scene switching (the lists repopulate) and a reload with edit windows open.

**Phase 6: Remove the legacy API.**
- Delete the union's legacy branch and the `TabAndContainer` shape.
- Delete `createNewDebuggerContainer`, `createNewDebuggerPane`, and the leftover per-module refresh and selected-class helpers.
- Update CLAUDE.md's debug section. Check `yarn docs` output for the new public API.
- Bump the version (see Risks).

## Non-goals

- **Migrating draggable edit windows to the pane builder.** They are a natural follow-up, since the builder is reusable, but their undo, scene and LS logic (p100 §6, p150) is out of scope here.
- **Renaming non-`AEK_` keys** (`debugRenderer`, `debugRayCast`). A rename would wipe saved settings, so it would need its own migration.
- **Moving scene-scoped, boot or deviation-only persistence into the tab layer** (Design decision 7).
- **Avoiding the full-drawer rebuild on each registration.** It only happens at boot and on scene change, and it isn't a measured problem.
- **Tweakpane plugins.** The `custom` item leaves room for them.

## Risks / open questions

| Risk / question | Notes |
| --- | --- |
| **Engine versioning** | Changing `createDebuggerTab`'s shape and removing `createNewDebuggerPane` / `createNewDebuggerContainer` breaks the documented engine API (TypeDoc covers `src/_engine/**`). Under CLAUDE.md rules that is a **major** bump: engine 1.2.0 "Sunrise" → 2.0.0 "Morning". Nothing in `app` or `toolkit` uses these, so real breakage is nil. The alternative is to keep both as deprecated shims and ship a minor bump. **Decide before Phase 6.** |
| The declarative format can't express some tab | The `custom` item and `onCreate(api)` are the escape hatches. PhysicsAPI and SkyBox are the likely stress points; if a tab needs more than about one `custom` item, extend the format instead. |
| `refresh()` re-entrancy | Tweakpane emits `change` on refresh. The builder's suppression flag must wrap hydration, refresh and rebuild, or undo gets ghost entries and LS gets spurious writes. Phase 2's verification targets this directly. |
| Hydration timing | Hydration runs at registration in the public wrapper. A module that registers its tab *after* using its state at boot would read defaults, so every migration must register first, or keep its old boot read. Check this per tab. |
| LS shape drift | Flat value keys keep their shape. Folder state moves into `…UI` keys, so folds reset once after the upgrade (acceptable: UI-only). `AEK_debugStats`'s old `*FolderExpanded` fields become dead data. |
| Toggle and edit-window consistency | Row toggles are new write paths. They must reuse the edit window's setters (Design decision 9), or undo and LS go out of sync. |
| Large lists | The Large ECS test world can have many physics entities. The signature check keeps refreshes cheap, but a full re-render after a toggle is O(n). Acceptable for now; row-level patching is a follow-up if it becomes measurable. |
| Overlap with p100 §8.1, p067, p125 | p100 fixes `_disableDebugger` in the same file, so land either one first and rebase the other. p067 changes the Characters tab. p125 should be written against the new API. |
| No automated verification | There is no test framework, and headless WebGPU doesn't run under WSL2 (see p071's notes). Every phase relies on manual `?isDebug=true` walkthroughs. |

## Verification

- `tsc --noEmit` and `yarn lint` are clean after every phase (the Stop hook enforces this).
- The per-phase manual checks above (`yarn dev`, `?isDebug=true`; the `run-aekasha-js` skill can drive it).
- End of plan:
  - `grep -rn "createNewDebuggerPane\|createNewDebuggerContainer\|buttonText" src/` returns nothing.
  - `yarn build` → `dist-stats/bundle-stats.html` shows no pane-builder or list code in the main chunk.
  - `?isProdTest=true` still behaves as before: no drawer, but hydrated values such as the Stats settings still apply.
  - Full round trip: change values in every tab, toggle list rows, reload, switch scenes, clear LS. Everything comes back consistent, with no console errors.
