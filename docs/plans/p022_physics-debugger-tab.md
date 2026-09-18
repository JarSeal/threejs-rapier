Status: draft | not-implemented
Category: Physics, Debugger
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Physics API Debugger Tab — Plan

Add a debugger tab for the new engine-agnostic Physics API (`PhysicsAPI.ts` / `PhysicsManager.ts` / `EngineRapier.ts` / worker), matching everything the legacy `PhysicsRapier.ts` debug tab already offers (all its Tweakpane fields + the physics-object list with an edit window), plus new controls for the two settings unique to the new system: `workerTarget` (`MAIN_THREAD` / `WORKER_THREAD`) and `useSAB`. `_DONE_p020` §6 and `_DONE_p021` §6 both explicitly deferred this as follow-up work; it has not been started.

## Context (grounded in code)

- **The legacy tab is not a `_dbg__` module.** Unlike every other subsystem, `PhysicsRapier.ts`'s debug GUI (`createDebugControls`, `buildPhysicsDebugGUI`, `buildPhysicsObjectsDebugList`, `createEditPhysObjContent`, lines ~1953-2418) lives directly inside the core file, imported eagerly and gated only by a runtime `isDebugEnvironment()` check — not code-split via `loadDebugModuleAsync`/`useDebug`. It registers via `createDebuggerTab({ id: 'physicsControls', buttonText: getSvgIcon('rocketTakeoff'), title: 'Physics controls', orderNr: 5, container: () => {...} })` (`PhysicsRapier.ts:1976-2020`), using `createNewDebuggerPane` for the Tweakpane instance and a plain-DOM (`CMP`) list below it.
- **Legacy fields** (all on a mutable `physicsState`/per-scene `curScenePhysParams`, persisted to LS): `timestep`, `worldStepEnabled`, `visualizerEnabled` (toggles `togglePhysicsVisualizer`), `gravity`, `solverIterations`, `internalPgsIterations`, `interpolationEnabled`, `backgroundBehavior` (list), `minDeltaTime`, `maxDeltaTime`, `minSubSteps`, `maxSubSteps`. The new `PhysicsState` (`Physics/PhysicsAPITypes.ts:47-97`) already has a matching field for every one of these (plus `workerTarget`, `useSAB`, `maxBodies`) — it is **not** scene-scoped, so there is no per-scene equivalent to port.
- **Legacy entity list**: `buildPhysicsObjectsDebugList()` renders `id`/`name`/`MULTI`-collider-badge rows from `currentScenePhysicsObjects`; clicking a row opens a draggable window (`createEditPhysObjContent`) with position/rotation Tweakpane bindings (`rigidBody.setTranslation`/`.setRotation`) and delete/console-log buttons.
- **New API already tracks everything needed for an entity list, in both thread modes.** `PhysicsAPI.ts` maintains its own `rigidBodies: Map<number, RigidBodyAPI>` / `colliders: Map<number, ColliderAPI>`, updated by every create/delete call regardless of `workerTarget` (confirmed via direct read — `rigidBodies.set(...)`/`.delete(...)` appear in both the `MAIN_THREAD` and `WORKER_THREAD` branches of every CRUD function). **No new worker protocol message is needed** to enumerate bodies — only a new exported accessor over these already-private maps. Separately, `PhysicsManager.ts` buckets each physics entity's rigid body into ECS storage `ComponentType.BODY_STATIC` / `BODY_DYNAMIC_VISUAL` / `BODY_DYNAMIC_HEADLESS` (plus `COLLIDER`), giving an ECS-level view (`world.getStorage(...)`, `getECSWorld()`) with entity ids, which is more useful for a debug list than the physics-level ids alone.
- **`workerTarget`/`useSAB` are boot-time-only.** `initPhysics()` reads `AppConfig.physics.workerTarget`/`.useSAB` once; there is no `.terminate()` call on the worker anywhere and no teardown/recreate path for the world/worker/bodies. `PhysicsTransformBuffer`'s SAB-vs-fallback resolution (`resolvedUseSAB`) happens once per `CREATE_WORLD` inside the worker and is never re-evaluated. **Decision (confirmed with user): reload-on-change**, not a live switch — matching the existing `_dbg__Renderer.ts` pattern where `antialias` (also boot-time-only) writes to LS and calls `location.reload()` on change.
- **No existing debug module for the new API.** No `_dbg__Physics*.ts` file exists. The clean, established pattern to follow is the thin-public-wrapper + `_dbg__X.ts` split (e.g. `core/Renderer.ts` → `core/Debug/_dbg__Renderer.ts`), not `PhysicsRapier.ts`'s inline anti-pattern — this plan does not copy that inconsistency forward.
- Tab registration goes through `createDebuggerTab`/`createNewDebuggerPane` (`src/_engine/debug/DebuggerGUI.ts`, real impl in `core/Debug/_dbg__DebuggerGUI.ts`), same as every other tab; `orderNr` sorts the tab menu (legacy Physics tab is `5`).

## Design decisions

1. **New file, not an extension of `PhysicsRapier.ts`.** Create `src/_engine/core/Debug/_dbg__PhysicsAPI.ts` + a thin public wrapper `createPhysicsAPIDebugGUI()` in `PhysicsAPI.ts`, following the `Renderer.ts`/`_dbg__Renderer.ts` split exactly (`loadDebugModuleAsync(() => import('./Debug/_dbg__PhysicsAPI'))` + `useDebug(ref)?._createPhysicsAPIDebugGUI()`). This keeps the new tab's code out of production bundles, unlike the legacy tab.
2. **Same icon, different tooltip.** Reuse `getSvgIcon('rocketTakeoff')` for the new tab (per the user's explicit ask), with `title: 'Physics API controls'` (vs. legacy's `'Physics controls'`) so the tab menu tooltip still disambiguates the two. Both tabs coexist — no migration of the legacy tab.
3. **Thread/SAB/maxBodies are reload-on-change, with a visible "reload to apply" affordance.** New Phase 1 engine-side addition: a debug-only localStorage override (e.g. key `AEK_debugPhysicsApiBoot`) read in `Config.ts`'s `loadConfig()`, gated behind `isDebugEnvironment()`, layered on top of `config.physics` the same way the existing `VITE_PHYS_*` env overrides are. The tab's `workerTarget`/`useSAB`/`maxBodies` bindings write to this key and surface a "Reload to apply" button next to them, exactly mirroring `_dbg__Renderer.ts`'s `antialias` field's `.on('change', ...) => location.reload()` pattern.
4. **All other `PhysicsState` fields are live, same as legacy.** `timestep`, `worldStepEnabled`, `visualizerEnabled`, `gravity`, `solverIterations`, `internalPgsIterations`, `interpolationEnabled`, `backgroundBehavior`, `minDeltaTime`, `maxDeltaTime`, `minSubSteps`, `maxSubSteps` bind directly to the live `getPhysicsState()` object (no scene-scoping needed, per Context) and persist to a dedicated LS key (e.g. `AEK_debugPhysicsApi`), with the same "Clear tab LS" header button (`createClearTabLSButton`) legacy has.
5. **Read-only status field for resolved transport mode.** `createPhysicsWorld()`'s worker response already carries `transportMode: 'SHARED_MEMORY' | 'MESSAGE_BATCH'` but nothing stores it after that call resolves. Add a small module-level capture + `getResolvedTransportMode()` export in `PhysicsAPI.ts`, shown as a read-only monitor binding (not editable — it's a runtime-resolved fact, not a setting).
6. **Entity list sourced from ECS storages, not the raw physics maps.** Combine `world.getStorage(ComponentType.BODY_STATIC | BODY_DYNAMIC_VISUAL | BODY_DYNAMIC_HEADLESS)` (via `getECSWorld()`) for entity id + `RigidBodyAPI`, plus `world.getComponent(entityId, ComponentType.COLLIDER)` for shape info (`collider.shapeType()` — async; row shows a brief loading state, then the resolved shape name) — this gives the same id/name/shape-badge shape as the legacy list, with entity ids instead of raw physics ids. Row label falls back to `[id]` when no `OBJECT3D.name` is present (no direct legacy-style "name" field exists on the new API's rigid bodies).
7. **List refresh via polling, not a new hook.** There's no "entity created/deleted" event to piggyback on without threading a new callback through `PhysicsManager.createPhysicsEntity`/`disposePhysicsEntity`. Mirror `_dbg__SpatialGrid.ts`'s existing `setInterval(..., 500)` precedent instead — simplest option, acceptable staleness window for a debug tool, no new coupling in a core file.
8. **Edit window mirrors legacy's `createEditPhysObjContent`.** Position/rotation Tweakpane bindings call `RigidBodyAPI.setTranslation(tra, wakeUp)`/`.setRotation(rot, wakeUp)` (both synchronous-signature on the type, fire-and-forget under the hood in worker mode — no async handling needed in the UI). Delete button removes the ECS entity (`world.deleteEntity`), which already triggers `PhysicsManager.ts`'s existing `TAG_IS_PHYSICS_OBJECT` delete hook (`disposePhysicsEntity`) — no new disposal code needed.

## Engine-side gaps to close first (Phase 1, additive/non-breaking)

- `PhysicsAPI.ts`: export `getAllRigidBodyEntries(): IterableIterator<[number, RigidBodyAPI]>` and `getAllColliderEntries(): IterableIterator<[number, ColliderAPI]>` over the existing private `rigidBodies`/`colliders` maps (available for main-thread-level introspection/parity checks; the debug tab's entity list itself uses the ECS-level view per Design Decision 6, but this is useful for cross-checking counts).
- `PhysicsAPI.ts`: capture `transportMode` from `createPhysicsWorld()`'s worker response into a module variable; export `getResolvedTransportMode(): 'SHARED_MEMORY' | 'MESSAGE_BATCH' | undefined`.
- `Config.ts`: in `loadConfig()`, after the existing `VITE_PHYS_*` env-var overrides, check a new debug-only LS key (only when `isDebugEnvironment()`) for `workerTarget`/`useSAB`/`maxBodies` overrides and merge them onto `config.physics`.
- No behavior change for any existing consumer — purely additive exports/reads.

Manual verification: from the browser console, after creating a few bodies under both `MAIN_THREAD` and `WORKER_THREAD` configs, confirm `getAllRigidBodyEntries()`/`getAllColliderEntries()` return the expected entries; confirm `getResolvedTransportMode()` reflects `SHARED_MEMORY` vs `MESSAGE_BATCH` correctly for `useSAB: true`/`false`; manually set the new LS override key, reload, confirm `getPhysicsState().workerTarget`/`.useSAB`/`.maxBodies` reflect it.

## Phases

**Phase 1 — Engine API additions.** Per "Engine-side gaps to close first" above. Non-breaking, no UI yet.

**Phase 2 — New debug module, config fields only (no entity list yet).** Create `core/Debug/_dbg__PhysicsAPI.ts` + `createPhysicsAPIDebugGUI()` thin wrapper in `PhysicsAPI.ts`. Register tab (`id: 'physicsApiControls'`, icon `rocketTakeoff`, `title: 'Physics API controls'`, `orderNr: 6`). Add all live `PhysicsState` bindings (Design Decision 4) + the reload-on-change `workerTarget`/`useSAB`/`maxBodies` bindings (Design Decision 3) + the read-only transport-mode monitor (Design Decision 5) + "Clear tab LS" header button. Manual verification: `?isDebug=true` boot, confirm the new tab appears next to the legacy Physics tab with the same icon and a distinguishable tooltip; toggle each live field and confirm effect (e.g. gravity change visibly affects falling bodies); toggle `workerTarget`/`useSAB`, reload, confirm the change actually took effect via the transport-mode monitor.

**Phase 3 — Physics entity list + edit window.** Per Design Decisions 6-8. Manual verification: create several physics entities via `createPhysicsEntity` in a test scene, confirm the list shows correct id/bucket/shape for each, confirm editing position/rotation from the opened window moves the object, confirm delete removes it from both the list and the scene — repeated once under `MAIN_THREAD` and once under `WORKER_THREAD`.

**Phase 4 — Bootstrap wiring.** Add `await createPhysicsAPIDebugGUI()` to `InitApp.ts`'s `IS_DEBUG_ENV` block, alongside the other `createXxxDebugGUI()` calls. Manual verification: fresh `yarn dev` boot with `?isDebug=true` shows no console errors with both Physics tabs present; a plain `yarn build` (no debug flags) bundle-stats output shows `_dbg__PhysicsAPI.ts` code-split out (not present in the main chunk).

## Non-goals

- **Live (no-reload) thread/SAB switching.** Confirmed with the user: out of scope. Would require new teardown/recreate machinery for the physics world/worker/all bodies that doesn't exist today; reload-on-change is the chosen approach instead.
- **Wiring a real 3D visualizer for `debugRender()`.** The `visualizerEnabled` field is included for parity with the legacy tab's field set, but toggling it has no visual effect yet — `debugRender()` wiring was already flagged as deferred future work in `_DONE_p020` §6 / `_DONE_p021` §6, independent of this plan.
- **Touching the legacy `PhysicsRapier.ts` tab.** Both tabs coexist permanently for now; no migration, no dedup.
- **Any new worker protocol/RPC message.** Not needed — `PhysicsAPI.ts` already tracks all bodies/colliders locally in both thread modes (see Context).
- **Per-scene physics params.** The new `PhysicsState` is a single global object; no scene-scoped equivalent of legacy's `physicsState.scenes[sceneId]` is introduced.

## Risks / open questions

| Risk / question | Notes |
|---|---|
| Reload-required UX for thread/SAB toggles may surprise users expecting a live switch | Mitigated with an explicit "Reload to apply" button/label, consistent with `_dbg__Renderer.ts`'s existing precedent for its own boot-time-only settings. |
| Entity-list polling (Design Decision 7) means brief staleness after create/delete outside the tab | Acceptable for a debug tool; same tradeoff already accepted in `_dbg__SpatialGrid.ts`. |
| `collider.shapeType()` is async (unlike legacy's fully-synchronous main-thread-only list) | List rows must tolerate a brief per-row loading state; confirm this reads cleanly during Phase 3's manual check. |
| Same icon on two simultaneously-visible tabs | Per the user's explicit request; disambiguated by tooltip title only — worth a quick visual check in Phase 2's manual verification. |
| `getResolvedTransportMode()` before any world exists | Should show an explicit "not created yet" state rather than blank/stale — confirm during Phase 2. |

## Verification

- `tsc --noEmit` and `yarn lint` clean after every phase (per the repo's Stop hook).
- Phase 1: console-level checks per its own manual verification above.
- Phase 2: visual confirmation of the new tab + live/reload field behavior.
- Phase 3: full entity-list + edit-window walkthrough in both `MAIN_THREAD` and `WORKER_THREAD` configs.
- Phase 4: fresh dev boot + a plain production build's bundle-stats confirming code-splitting.
