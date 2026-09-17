Status: draft | not-implemented
Category: Debugger
Blocks: p061_add-undo-history-action-recording-to-debugger-tools.md and p062_add-undo-and-redo-ui.md
Epic: https://trello.com/c/JYgK1s1u/86-add-undo-redo-system

# Debugger Undo/Redo Engine Core — Plan

Builds the core UNDO/REDO **engine** for the Aekasha debugger: a generic, serializable action-history stack with configurable depth, localStorage persistence, and an extension API (`recordAction`/`registerActionHandler`/`undo`/`redo`) that later work will call into. This plan does **not** wire any actual debugger mutation (onScreenTools, debugger drawer tabs, Camera/Light/etc. edit windows) into the stack — no call site anywhere in the codebase will call `recordUndoRedoAction(...)` when this plan is done, and there is no key binding, button, or UI for undo/redo yet. The engine ships fully functional but inert: it is exercised only via its own API (manually, e.g. from the browser console) until the follow-up plan (see `Blocks` above) registers real action handlers at each debugger mutation site and wires up key presses/UI.

This resolves an apparent tension in the request ("should not cover recording the actions... but it should include that functionality and logic"): the _mechanism_ for recording/undoing/redoing an action (the stack, the handler registry, the persistence) is in scope and must be complete and correct; _applying_ that mechanism to the ~dozens of existing debugger mutation call sites is explicitly out of scope and left to the blocked follow-up plan.

---

## 1. Current state (grounded in the actual code)

- **No undo/redo of any kind exists.** Confirmed via `grep -rniE "undo|redo"` across `src` and `docs` — the only hits are unrelated (`isCompoundObject`). Nothing to extend; this is a from-scratch design.
- **Debug-only tree-shaking pattern**: every dev-only engine feature in this repo follows the same dual-layer split described in `CLAUDE.md` — a thin public entry point in `src/_engine/debug/*.ts` (always bundled) that, only when `IS_DEBUG_ENV` is true, dynamically `import()`s a real implementation via `loadDebugModuleAsync`/`useDebug` (`src/_engine/utils/helpers.ts:475-512`). Concrete examples: `src/_engine/debug/Stats.ts` (thin) → `src/_engine/core/Debug/_dbg__Stats.ts` (impl); `src/_engine/debug/DebugToolsManager.ts` (thin) → `src/_engine/core/Debug/_dbg__DebugTools.ts` (impl). This pattern isn't Tweakpane-GUI-specific — `DebugToolsManager.ts` mixes plain state (`DebugToolsState`) with GUI — so it's the right shape for a non-GUI engine module too. This plan follows it exactly.
- **Gating**: `IS_DEBUG_ENV` (`src/_engine/core/Config.ts:186-187`) is true only when `curEnvironment` is `'development'`/`'test'` **and** the `?isDebug=true` query param is set — there is no environment value that means "development but not test." The request says "only in the development environment"; taken literally that would need a new check, but every other debugger-only feature in this codebase (Stats, DebugTools, ECS panel, Camera/Light GUIs, etc.) gates on `IS_DEBUG_ENV`, not on `curEnvironment === 'development'` alone. **Judgment call**: this plan gates the undo/redo engine on `IS_DEBUG_ENV`, same as every other debugger feature, so it behaves consistently with the rest of the debug tooling (dev and test envs, behind the `?isDebug=true` query param) — flagged here in case "development only, not test" was actually intended. See §6.
- **Bootstrap wiring**: `src/_engine/InitApp.ts:70-78` is where every `IS_DEBUG_ENV`-gated module is registered (`registerDebugToolsModule()`, `registerStatsModule()`, `registerSkyBoxDebugGUI()`, etc., each `await`ed in sequence before `appStartFn()` runs). The new module's registration call belongs in this same block.
- **localStorage utility**: `src/_engine/utils/LocalAndSessionStorage.ts` — `lsGetItem`/`lsSetItem`/`lsRemoveItem`. `lsSetItem` `JSON.stringify`s any object/array value; `lsGetItem` converts back based on the shape of the `defaultValue` passed in. This is a hard constraint on the history entry shape (see §2.1): whatever gets persisted must be plain, JSON-serializable data — no functions, no live `THREE.Object3D`/ECS entity references.
- **Existing scene-scoped LS precedent**: per `docs/plans/p041_clear-local-storage-buttons-for-each-debugger-tab.md` §2.1's research, several debugger tabs already persist state per-scene as `{ [sceneId]: {...} }` (Camera's `AEK_debugCams`, Light's `AEK_debugLights`, SkyBox's `AEK_debugSkyBoxStates`). This plan follows the same shape for history (§2.3) since undo-ing an action from a scene that isn't currently loaded is meaningless (the entities/state it targets may not exist in the newly-loaded scene).
- **No scene-change event/observer system exists.** `src/_engine/core/Scene.ts`'s `setCurrentScene()` (`Scene.ts:259-306`) directly calls whatever needs updating (e.g. `updateDebuggerSceneTitle`) inline — there's no publish/subscribe hook a new module could attach to. Anything that needs to react to "the current scene changed" reads `getCurrentSceneId()` (`Scene.ts:329-336`) on demand rather than subscribing to an event. This plan's engine does the same: it re-reads `getCurrentSceneId()` at the moment of `recordUndoRedoAction`/`undo`/`redo`/`clearUndoRedoHistory`, rather than tracking scene changes itself.
- **Config pattern**: `AppConfig` (`src/_engine/core/Config.ts:13-46`) has top-level feature blocks (`physics`, `ecs`, `draggableWindows`, `debugKeys`), each merged with defaults in the `config` object (`Config.ts:52-68`) and optionally overridden from `VITE_*` env vars inside `loadConfig()` (`Config.ts:90-148`, e.g. `ecs.storageMode`/`ecs.maxEntities`). This plan adds a new `undoRedo` block following that same shape, config-only (no env var override — not asked for, and `ecs`/`physics`'s env-var overrides exist because those need to differ per deploy target, which doesn't apply to a debugger-only history depth).
- **ID generation precedent**: `THREE.MathUtils.generateUUID()` is already the codebase's de facto UUID source (e.g. `src/_engine/utils/CMP.ts:361`'s `createNewId = () => \`c-${THREE.MathUtils.generateUUID()}\`;\`). Reused here for history entry IDs rather than adding a new dependency.

---

## 2. Design

### 2.1 Why entries must be data, not closures

A conventional command-pattern undo stack stores `{ undo: () => void; redo: () => void }` closures per action. That can't satisfy the "history is saved into localStorage as an object" requirement — functions aren't JSON-serializable, and closures captured over live Three.js/ECS references wouldn't survive a page reload anyway (the objects they'd point to may no longer exist).

Instead, a history entry is **pure data**, and undo/redo behavior is looked up from a **registry of handlers keyed by action type** at the moment undo/redo actually runs:

```ts
// src/_engine/core/Debug/_dbg__UndoRedo.ts

export type UndoRedoEntry<TPayload = unknown> = {
  id: string; // THREE.MathUtils.generateUUID()
  actionType: string; // e.g. 'camera.setTransform', 'light.setIntensity' — namespaced by the future consumer plan
  label: string; // human-readable, for a future history-list UI
  timestamp: number;
  payload: TPayload; // must be plain JSON-serializable data (ids/field names/prev+next values) — no object refs, no functions
};

export type UndoRedoActionHandler<TPayload = unknown> = {
  undo: (payload: TPayload) => void;
  redo: (payload: TPayload) => void;
};

const actionHandlers = new Map<string, UndoRedoActionHandler>();

export const _registerUndoRedoActionHandler = <TPayload>(
  actionType: string,
  handler: UndoRedoActionHandler<TPayload>
) => {
  actionHandlers.set(actionType, handler as UndoRedoActionHandler);
};
```

`_registerUndoRedoActionHandler` is the extension point the blocked follow-up plan will call from each debugger mutation site (once per `actionType`, at module load time — same convention as `ECSWorld.registerPlugin`/`registerComponentHooks` in `ECS.ts`). This plan registers zero handlers itself.

### 2.2 Stack mechanics

One array + a pointer (not two separate undo/redo stacks) — simpler to persist as a single object and to reason about truncation:

```ts
type UndoRedoHistoryState = {
  entries: UndoRedoEntry[];
  pointer: number; // index of the last applied entry; -1 means "nothing applied yet"
};
```

- `_recordUndoRedoAction(actionType, label, payload)`: truncates any entries after `pointer` (the redo tail — standard linear-history behavior, no branching), appends the new entry, advances `pointer`, then trims from the front if `entries.length` exceeds the configured `historySize` (§2.4), adjusting `pointer` accordingly. Persists (§2.3) after every mutation.
- `_undoLastAction()`: if `pointer < 0`, no-op. Otherwise looks up `actionHandlers.get(entries[pointer].actionType)`; if found, calls `handler.undo(entries[pointer].payload)` and decrements `pointer`; if not found (e.g. the owning module hasn't registered its handler yet after a reload — see §6), logs a warning via the existing `lwarn` helper and does not move `pointer`, so a later retry (once the handler registers) can still succeed.
- `_redoLastAction()`: symmetric — if `pointer >= entries.length - 1`, no-op; otherwise looks up the handler for `entries[pointer + 1]`, calls `handler.redo(payload)`, increments `pointer`.
- `_canUndo()` / `_canRedo()`: pure boolean checks on `pointer`, for a future UI (not built here).
- `_getUndoRedoHistory()`: returns a read-only copy of the current scene's `entries`/`pointer`, for a future history-list/inspector UI (not built here).
- `_clearUndoRedoHistory(scope: 'currentScene' | 'all')`: `'currentScene'` resets only the current scene's bucket (§2.3); `'all'` wipes every scene's bucket and the LS key entirely.

### 2.3 Persistence and scene scoping

LS key `AEK_debugUndoRedo` (following the `AEK_`-prefixed convention used by newer debugger LS keys per `p041`'s survey), shaped per-scene like Camera/Light/SkyBox's existing state:

```ts
type UndoRedoLSData = {
  [sceneId: string]: UndoRedoHistoryState;
};
```

Actions recorded with no current scene (`getCurrentSceneId()` returns `null`) go into a reserved `'_global'` bucket, mirroring the `getCurrentSceneId() ?? ''` fallback pattern already used elsewhere (`p041` §3.5's Camera example). In-memory state mirrors the LS shape 1:1 (`Record<string, UndoRedoHistoryState>`), loaded once on `_initUndoRedo()` via `lsGetItem('AEK_debugUndoRedo', {})` and written back via `lsSetItem` after every stack mutation — same load-once/write-through pattern `_dbg__CameraGUI.ts`/`_dbg__LightGUI.ts` already use for their own scene-scoped LS state.

Every stack operation (`_recordUndoRedoAction`, `_undoLastAction`, `_redoLastAction`, `_canUndo`, `_canRedo`, `_getUndoRedoHistory`) resolves `const sceneId = getCurrentSceneId() ?? '_global'` first and operates only on `state[sceneId]`, lazily creating `{ entries: [], pointer: -1 }` for a scene bucket the first time it's touched.

### 2.4 Config

New top-level `undoRedo` block in `AppConfig` (`src/_engine/core/Config.ts`), following the shape of the existing `physics`/`ecs` blocks:

```ts
// AppConfig
undoRedo?: {
  /** Max number of history entries kept per scene. Default 50. */
  historySize?: number;
};

// defaults, alongside the existing physics/ecs defaults in `config`
undoRedo: {
  historySize: 50,
},
```

No env var override (§1) — set via the app's `CONFIG.ts` (`src/CONFIG.ts`) like `debugKeys`/`physics` already are, if a project wants a different depth.

### 2.5 Module structure and bootstrap wiring

- New `src/_engine/core/Debug/_dbg__UndoRedo.ts` — the real implementation: `actionHandlers` map, `UndoRedoLSData` state, and `_initUndoRedo`/`_recordUndoRedoAction`/`_undoLastAction`/`_redoLastAction`/`_canUndo`/`_canRedo`/`_registerUndoRedoActionHandler`/`_clearUndoRedoHistory`/`_getUndoRedoHistory`, all prefixed `_` per the existing `_dbg__*` convention.
- New `src/_engine/debug/UndoRedo.ts` — thin public entry, mirroring `src/_engine/debug/Stats.ts`'s exact shape: a module-level `DebugModuleRef`, `registerUndoRedoModule()` (dynamic `import('../core/Debug/_dbg__UndoRedo')`, no-op outside `IS_DEBUG_ENV`), and one public wrapper per `_`-prefixed function via `useDebug(debugGUI)?._fn(...)`.
- `src/_engine/InitApp.ts:70-78` — add `await registerUndoRedoModule()` inside the existing `if (IS_DEBUG_ENV) { ... }` block (alongside `registerDebugToolsModule()`/`registerStatsModule()`/etc.), and call the public `initUndoRedo()` there too (loads persisted state from LS).

No changes to `ECS.ts`, `ECSRegistry.ts`, scene/asset JSON schemas, or any existing debugger tab file — this plan touches only new files plus `Config.ts` and `InitApp.ts`.

---

## 3. Files touched

- `src/_engine/core/Config.ts` — add `undoRedo?: { historySize?: number }` to `AppConfig` + its default value in `config`.
- New `src/_engine/core/Debug/_dbg__UndoRedo.ts` — stack, registry, persistence (real implementation).
- New `src/_engine/debug/UndoRedo.ts` — thin public entry point (dual-layer pattern).
- `src/_engine/InitApp.ts` — register + init the new module inside the existing `IS_DEBUG_ENV` block.

---

## 4. Explicitly out of scope

- Calling `recordUndoRedoAction`/registering handlers from any real debugger mutation site (onScreenTools, debugger drawer tabs, Camera/Light/etc. edit windows) — that's the blocked follow-up plan.
- Any key binding (e.g. Ctrl+Z/Ctrl+Shift+Z), button, or history-list UI. `_canUndo`/`_canRedo`/`_getUndoRedoHistory` exist so a future UI has something to read, but no UI is built here.
- Cross-scene or "redo after switching scenes" semantics beyond simple per-scene bucketing (§2.3) — an action recorded in scene A is only ever undoable while scene A is current, by construction.
- Any change to `ECSWorld`, `ECSRegistry.ts`, or scene/asset JSON schemas.

---

## 5. Phased rollout

- **Phase 1 — Config + module skeleton.** Add the `undoRedo` config block (§2.4), create `_dbg__UndoRedo.ts` and `UndoRedo.ts` with the stack/persistence/registry API (§2.1–2.3) but no bootstrap wiring yet. Manual verification: unit-level sanity only (no test runner in this repo — verify by temporarily calling the exported functions from the browser console after a manual `import()`), confirming `recordUndoRedoAction` → `undoLastAction` → `redoLastAction` round-trips correctly and `AEK_debugUndoRedo` appears in `localStorage` with the expected per-scene shape.
- **Phase 2 — Bootstrap wiring.** Wire `registerUndoRedoModule()` + `initUndoRedo()` into `InitApp.ts:70-78`. Manual verification: with `?isDebug=true`, confirm the module loads (no console errors), `AEK_debugUndoRedo` is read on startup, and reloading the page preserves a manually-recorded entry's data (handler lookup will legitimately warn-and-no-op post-reload until a handler is registered in the same session — expected per §2.2/§6, not a bug).

No further phases — this plan is deliberately small (core engine only); the blocked follow-up plan is where the bulk of the integration work and its own phasing belongs.

---

## 6. Risks and open questions

| Risk / question                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gating on `IS_DEBUG_ENV` (dev **and** test) vs. the request's literal "only in the development environment." | Every other debugger feature gates on `IS_DEBUG_ENV`; a `development`-only carve-out would need a new check (`curEnvironment === 'development'`) not used anywhere else and would make this one debug feature behave inconsistently with the rest of the drawer. Flagging in case "development only, not test" was actually intended — easy to change to a stricter check if so.                                                                                                                                                                                                                                                                     |
| Handlers are in-memory only; persisted entries can outlive the handlers that know how to undo/redo them.     | After a reload, an entry from before the reload is only undo-able once the owning module (registered by the future follow-up plan) re-registers its `actionType` handler during that module's own load. Until then, `_undoLastAction`/`_redoLastAction` warn-and-no-op rather than throwing (§2.2) — acceptable for a core-only plan since no handlers exist yet at all; worth re-confirming once real handlers exist and modules can load in varying orders.                                                                                                                                                                                        |
| Payload serializability isn't enforced at the type level.                                                    | `UndoRedoEntry<TPayload>` doesn't statically prevent a future caller from passing a live object reference or function in `payload` — it's a documented convention (§2.1), matching how e.g. Camera/Light LS state is already "just" plain data by convention rather than by compiler enforcement. A runtime `JSON.stringify`/`parse` round-trip inside `_recordUndoRedoAction` would catch violations early (cheap safety net) but silently mutates any payload containing e.g. `undefined` fields — worth deciding at implementation time whether that tradeoff is worth it.                                                                        |
| No scene-change event system to hook into (§1).                                                              | Every operation re-resolves `getCurrentSceneId()` itself rather than tracking transitions, so there's no risk of stale scene-id caching — but it also means nothing proactively prunes stale scene buckets when a scene is deleted (`Scene.ts` has scene deletion, e.g. the `debugToolsState.debugCamera[id]` cleanup near `Scene.ts:250-253`). This plan doesn't add equivalent cleanup for `AEK_debugUndoRedo`'s per-scene buckets; a deleted scene's history simply becomes unreachable dead data in LS until `_clearUndoRedoHistory('all')` is called. Low-severity (bounded by `historySize` per scene, not unbounded growth) but worth noting. |
| `historySize` config changes don't retroactively trim already-persisted history.                             | If a project lowers `historySize` between sessions, existing entries beyond the new limit aren't purged until the next `_recordUndoRedoAction` call trims from the front. Matches how trimming is defined (§2.2) — only enforced on write, not on load — flagging as a judgment call rather than an oversight.                                                                                                                                                                                                                                                                                                                                       |
