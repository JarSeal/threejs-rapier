Status: draft | not-implemented
Category: Physics, ECS
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Physics API Worker-Thread MVP — Plan

Make the engine-agnostic Physics API (`PhysicsAPI.ts` / `EngineRapier.ts` / `PhysicsAPITypes.ts` / `workers/physicsWorker.ts` / `workers/physics/physicsSwitch{World,Rigid,Coll}.ts`) actually run its simulation inside a Web Worker, building on [_DONE_p020_main-thread-physics-api-mvp.md](./_DONE_p020_main-thread-physics-api-mvp.md), which proved out main-thread mode and explicitly scoped worker-thread mode out (§5/§6). Most of the worker-side infrastructure already exists (a complete RPC switchboard for world/rigid-body/collider CRUD and queries) — what's missing is the ability to actually advance the simulation off the main thread and get its results back every frame without per-body message overhead. This plan implements the `STEP` protocol end-to-end, a physics-owned per-frame transform hot path (`SharedArrayBuffer`-backed where available, with an automatic message-batch fallback where it isn't), and makes `src/app/physicsTest.ts` run under worker-thread mode as the MVP's proof. Rapier remains the only physics engine; no second backend is added here.

## 1. Goal

With `AppConfig.physics.workerTarget === 'WORKER_THREAD'`, the physics test scene (`src/app/physicsTest.scene.json` / `physicsTest.ts`) behaves identically to main-thread mode: the ball and box fall under gravity and settle on the ground plane, driven entirely by a `Rapier.World` living inside `physicsWorker.ts`, with zero per-body message round trips per frame. `SharedArrayBuffer` is used as the hot-path transport when the runtime is actually cross-origin-isolated; otherwise the system automatically falls back to a single batched, transferable message per frame — both paths avoid the "N messages per frame" trap. `AppConfig.physics.useSAB` is the one new configurable threading option this MVP introduces, matching the request that SAB support be optional since it isn't available in every deployment environment.

## 2. Current state (grounded in code)

Confirmed by direct read of the branch (`physics-api-finalization`, superseding the stale `docs/analysis/physics-api-state.md` dated 2026-09-17 and the equally stale note in `.claude/CLAUDE.md` that `PhysicsAPI.ts` is "entirely commented-out" — both predate the just-completed p020 MVP):

- **Two physics systems run in parallel.** `PhysicsRapier.ts` (old, mesh-coupled, 17+ importers) is untouched by this plan and has no concept of `workerTarget`. The new system (`PhysicsAPI.ts` facade + `PhysicsManager.ts` ECS integration) is main-thread-only today and is this plan's target.
- **`AppConfig.physics.workerTarget: PhysicsWorkerTarget`** (`'MAIN_THREAD' | 'WORKER_THREAD'`, `PhysicsAPITypes.ts:5`) is already threaded through every CRUD/init function in `PhysicsAPI.ts` (~20+ call sites, each with a `MAIN_THREAD`/`WORKER_THREAD` branch) and the engine default (`Config.ts:58`) is `'MAIN_THREAD'`. `src/CONFIG.ts` doesn't set it, so it always resolves to `'MAIN_THREAD'`.
- **World create/delete/snapshot already work in both modes.** `createPhysicsWorld`/`deletePhysicsWorld`/snapshot take-restore in `PhysicsAPI.ts` have real `WORKER_THREAD` branches that `await messageWorkerAsync(...)`, and `physicsWorker.ts` correctly handles `INIT_PHYSICS`/`CREATE_WORLD`/`DELETE_WORLD`/snapshot messages. The worker bootstrap handshake (`initWorker()` in `src/_engine/utils/helpers.ts:400`, waiting for `physicsWorker.ts`'s trailing `self.postMessage({ status: 'INIT_READY' })`) is generic and already correct.
- **Stepping is the actual gap.** `PhysicsAPI.ts:192-195`'s `stepPhysics(loopState)` unconditionally calls `engAPI?.step()` — it never branches on `workerTarget` and never sends a worker message, so worker-mode physics never advances even one frame. `physicsWorker.ts:24-27` has the receiving side explicitly commented out (`// @CHORE: implement stepping`). `PhysicsProtocolType.STEP = 4` already exists in the enum (`PhysicsAPITypes.ts:2300`) but is unused end-to-end. `WorldProxyAPI.step()` (`PhysicsAPI.ts:982-985`) is a literal `throw new Error('step is not yet implemented in Worker thread mode.')`; `debugRender()` (line 986-988) throws the same way and stays out of scope here (matches p020 §5).
- **The hot-path fields are declared but never populated in worker mode.** `RigidBodyAPI.pos/rot/lvel/avel` (`PhysicsAPITypes.ts` "Hot Path" fields) are what `PhysicsManager.ts`'s `physicsToTransformSystem` (`PhysicsManager.ts:108-133`) reads every frame at `ECSSystemStage.APP_POST_PHYSICS`. In `MAIN_THREAD` mode these are real getters on `EngineRigidBodyProxyAPI` (`EngineRapier.ts:906-917`, calling `rb.translation()`/`.rotation()`/etc. directly — per p020 §3.1, a deliberate main-thread-only design, unchanged by this plan). In `WORKER_THREAD` mode, `RigidBodyProxyAPI` (`PhysicsAPI.ts:1336`+) initializes `pos`/`rot`/`lvel`/`avel` to zero in its constructor and **never updates them** — no `SharedArrayBuffer`, no `Atomics`, no batch message exists anywhere today. If a body were spawned in worker mode right now, `physicsToTransformSystem` would copy `{0,0,0}`/identity into the transform forever, silently.
- **`PhysicsManager.createPhysicsEntity`** (`PhysicsManager.ts:27-94`) unconditionally calls `createRigidBodySync`/`createCollidersSync` (`PhysicsAPI.ts`). These throw in `WORKER_THREAD` mode (sync APIs are main-thread-only by design — confirmed: the `*Sync` variants only have `MAIN_THREAD` implementations, `WORKER_THREAD` isn't a valid branch for them). `createPhysicsEntity` needs a worker-mode path that awaits the async `createRigidBody`/`createColliders` instead.
- **The worker-side RPC switchboard is complete and correct.** `workers/physics/physicsSwitchWorld.ts` (168 lines), `physicsSwitchRigid.ts` (368 lines), `physicsSwitchColl.ts` (240 lines) are full 1:1 wrappers of `WorldAPI`/`RigidBodyAPI`/`ColliderAPI`, dispatched by `physicsWorker.ts`'s numeric-range router (`getSubType`, `physicsWorker.ts:147-159`). None of this needs to change for `STEP` or the hot path — it's the right place to extend later (e.g. bulk kinematic-target updates) but out of scope here.
- **No `SharedArrayBuffer` is ever allocated today.** `TypedArrayTransformStore.createTransformBuffer(maxEntities, useSAB = false)` (`ECS/TypedArrayTransformStore.ts:16-22`) is a factory with a `useSAB` flag that's never passed `true` anywhere, and its own doc comment flags this exact plan's prerequisite: "cross-origin isolation (COOP/COEP) is required for `SharedArrayBuffer` and isn't configured anywhere in this project." Confirmed via full read of `vite.config.ts`: `server.headers` is unset; only `server.fs.strict: false` is configured. This plan does **not** reuse this ECS store (see §3.3 — a separate, physics-owned buffer was chosen instead, to avoid coupling worker-thread physics to `ecs.storageMode`).
- **WASM-in-worker is unverified.** `vite-plugin-wasm` (the only plugin resolving `@dimforge/rapier3d-compat`'s `.wasm` import) has only ever been exercised on the main thread in this project; `PhysicsAPI.ts:10`'s `import PhysicsWorker from '../workers/physicsWorker?worker'` is genuine Vite worker-import syntax, but because `WORKER_THREAD` has never been reachable, `physicsWorker.ts`'s own `RAPIER.init()` call (inside `initPhysicsEngine()`) has never actually executed. This is the single largest unknown and is de-risked first (Phase 2).
- **No double-WASM-init risk here** (unlike p020 §8's flagged risk): the worker runs in a fully separate JS realm/global scope from the main thread, so `PhysicsRapier.ts`'s main-thread `RAPIER.init()` and the worker's own `RAPIER.init()` are two independent WASM module instances that never contend.

## 3. Design

### 3.1 Config surface: `useSAB` and `maxBodies` (the one new threading option)

Add to `AppConfig.physics` (`Config.ts:22-34`) and `PhysicsState` (`PhysicsAPITypes.ts:45`+):
- `useSAB?: boolean` — intent to use `SharedArrayBuffer` for the hot path. Engine default: `true` (matches the decision to make `WORKER_THREAD` the new default). At `initPhysics()` time, resolve actual capability defensively: `const resolvedUseSAB = physicsState.useSAB && typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;` — if the config asked for SAB but the runtime isn't actually cross-origin-isolated (headers missing, unsupported browser, or someone reused the built app on a host that doesn't set them), log a warning once and silently use the message-batch fallback (§3.3) instead of throwing. This is what satisfies "SharedArrayBuffer might not work for all environments" — the config expresses intent, capability is verified at runtime, and the fallback exists unconditionally.
- `maxBodies?: number` — fixed capacity for the physics-owned transform buffer (§3.3), analogous to the existing `AppConfig.ecs.maxEntities` (`Config.ts:66`) pattern. Engine default: `2048`. Exceeding it throws a clear error at rigid-body creation time (mirroring `TypedArrayTransformStore.set()`'s capacity-exceeded error, `TypedArrayTransformStore.ts:176-180`), not a silent slot collision.
- Add a `VITE_PHYS_USE_SAB` env override, mirroring the existing `VITE_PHYS_ENABLED`/`VITE_PHYS_GRAVITY`/`VITE_PHYS_TIMESTEP` pattern already in `Config.ts`'s `loadConfig()`.
- `useSAB` is explicitly the *only* configurable threading option for this MVP — no other physics behavior becomes configurable here.

### 3.2 `STEP` protocol, end-to-end

- `PhysicsAPI.ts`'s `stepPhysics(loopState)` (currently line 192-195) branches on `physicsState.workerTarget`: `MAIN_THREAD` keeps calling `engAPI?.step()` as today; `WORKER_THREAD` sends a one-way `messageWorker({ type: PhysicsProtocolType.STEP, isOneWay: true })` — fire-and-forget, no response awaited, since transform results arrive via the hot-path buffer (§3.3), not via the STEP response. This is called once per main-loop tick, same cadence/call sites as today (`MainLoop.ts`'s existing `stepPhysics(loopState)` calls — unchanged).
- `physicsWorker.ts`: uncomment and implement the `PhysicsProtocolType.STEP` case (currently commented out at lines 24-27) — call `engAPI.step()` (the real Rapier `physicsWorld.step()`, already implemented per p020 phase 2), then run the hot-path write-back (§3.3) for every live dynamic rigid body.
- No fixed-timestep accumulator, interpolation, or background-pause porting here — `stepPhysics` stays exactly as simple as p020 left it (§3.4/§5 of that plan); this is an explicit non-goal carried forward (§5 below).

### 3.3 Hot-path transform buffer: `PhysicsTransformBuffer.ts` (new file, physics-owned)

A small new module in `src/_engine/core/Physics/PhysicsTransformBuffer.ts`, independent of ECS's `TypedArrayTransformStore` (per the confirmed design decision — this avoids forcing `ecs.storageMode: 'TYPED_ARRAY'` as a prerequisite for worker-thread physics, keeping the two config axes orthogonal):

- **Layout**: `[posX, posY, posZ, rotX, rotY, rotZ, rotW] × maxBodies` — 7 floats/slot (no `lvel`/`avel` in the buffer; those stay zero/RPC-only for this MVP, since `physicsToTransformSystem` only ever reads `pos`/`rot` — deferred per §5/§6).
- **Buffer factory**, mirroring `TypedArrayTransformStore`'s existing `useSAB ? new SharedArrayBuffer(...) : new ArrayBuffer(...)` pattern (`ECS/TypedArrayTransformStore.ts:16-22`) but sized for `maxBodies * 7 * 4` bytes.
- **Slot allocation**: a simple free-list keyed by the existing rigid-body `id` (the same running id already returned as `RigidBodyAPI.id` from `createRigidBodySync`/the worker's `createRigidBody`) — `allocateSlot(id)`, `freeSlot(id)`, `getSlot(id)`. The worker owns allocation authority (ties naturally to where rigid bodies are actually created/deleted in worker mode).
- **Two transport modes**, both O(1) messages per frame regardless of body count (never O(n) — this is the exact trap flagged by `docs/analysis/physics-api-state.md` §5 and must not be reintroduced):
  - **`SHARED_MEMORY` (when `resolvedUseSAB` is true)**: the worker creates the canonical `PhysicsTransformBuffer` once, at `CREATE_WORLD` time, backed by a real `SharedArrayBuffer`. Its raw buffer reference is included once in the `CreateWorldResponse` payload (structured-cloning a `SharedArrayBuffer` shares memory, it does not copy it). Main thread wraps that same buffer in its own `PhysicsTransformBuffer` instance (read-only usage). After `step()`, the worker writes directly into the shared memory; the main thread's `RigidBodyProxyAPI.pos`/`.rot` getters read directly from it by slot — **zero messages per step** for the hot path itself (the one-way `STEP` message is still sent, but carries no payload and needs no reply). Torn reads (main thread reading mid-write) are accepted as an unlocked read for this MVP — floats are small and the visual impact at 60fps is expected to be negligible; a proper seqlock/double-buffer is deferred (§6).
  - **`MESSAGE_BATCH` (fallback, whenever `resolvedUseSAB` is false)**: the worker keeps its own local `PhysicsTransformBuffer` (plain `ArrayBuffer`), and after each `step()`'s write-back, `postMessage`s a **copy** of the buffer as a new protocol push — `PhysicsProtocolType.TRANSFORMS_PUSH` (new enum value, next available engine-level slot after `DELETE_WORLD = 101`, e.g. `102`) — as a `Transferable` (zero-copy transfer of that one `ArrayBuffer`, not structured-clone-copied). This is unsolicited/push, not request-response (same category as the collision/contact-force event transport p020 explicitly deferred, §6 item 3 there — worth noting as the same future push channel). Main thread's `onWorkerMessage` handles `TRANSFORMS_PUSH` by swapping its "latest received buffer" reference and rewrapping it in a fresh `PhysicsTransformBuffer`; `RigidBodyProxyAPI.pos`/`.rot` getters read from whatever is currently latest (returning `{0,0,0}`/identity if no message has arrived yet, e.g. before the first step completes — same as today's zeroed default, just transient instead of permanent).
- **Slot delivery to the main-thread proxy**: `CreateRigidBodyResponse`/`CreateRigidBodiesResponse` (`PhysicsAPITypes.ts`) gain a `slot: number` field, set by the worker's `physicsSwitchRigid.ts` handlers at creation and read by `RigidBodyProxyAPI`'s constructor so its `pos`/`.rot` getters know which slot to index. `DELETE_RIGID_BODY(S)` handlers call `freeSlot(id)`.
- Only **dynamic** rigid bodies are written into the buffer each step (static/fixed bodies never move — checked via the existing `isDynamic`-style body-type query already used elsewhere in `EngineRapier.ts`); this is a small, clear-win filter, not a separate optimization pass.
- `EngineRapier.ts` gains one small export to enumerate live rigid bodies for the worker's per-step write-back loop (e.g. `getAllRigidBodyIds(): IterableIterator<number>` over the existing `rigidBodyAPIs` map, `EngineRapier.ts:57`) — the only change needed in this file; its CRUD and `MAIN_THREAD` getters (§3.1 of p020) are untouched.

### 3.4 `PhysicsManager.createPhysicsEntity` becomes async in worker mode

`createPhysicsEntity` (`PhysicsManager.ts:27-94`) becomes `async`, returning `Promise<number>`. It branches on `physicsState.workerTarget`: `MAIN_THREAD` keeps calling `createRigidBodySync`/`createCollidersSync` exactly as today (no behavior change, still synchronous under the hood); `WORKER_THREAD` awaits the async `createRigidBody`/`createColliders` (already-implemented `WORKER_THREAD` branches in `PhysicsAPI.ts`). `src/app/physicsTest.ts`'s `scene()` function is already `async` — its three `createPhysicsEntity(...)` call sites just gain `await`. No other current caller of `createPhysicsEntity` exists (confirmed — `physicsTest.ts` is its only consumer today), so this is a low-blast-radius signature change.

### 3.5 Vite dev-server COOP/COEP headers

Add `server.headers` to `vite.config.ts`:
```ts
server: {
  fs: { strict: false },
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
```
These are required for `self.crossOriginIsolated`/`SharedArrayBuffer` to be available at all in dev. Since the confirmed decision is to make `WORKER_THREAD` (+ SAB) the new default, these are unconditional (not gated behind an env var) — matching the "threaded reality" default. **Production hosting is out of scope for this plan** (see §5) — whatever serves `dist/` in production must set the same two headers, or `useSAB`'s runtime capability check (§3.1) will correctly and automatically fall back to `MESSAGE_BATCH` there instead of breaking.

### 3.6 Switching the default (`src/CONFIG.ts`)

Once §3.2-3.5 are implemented and manually verified (Phase 5), flip `src/CONFIG.ts`'s `physics` block to set `workerTarget: 'WORKER_THREAD'` explicitly (currently unset, falling through to the engine default — the engine default in `Config.ts:58` also moves to `'WORKER_THREAD'` at the same time, so both the app config and the library default agree). `PhysicsRapier.ts`-driven scenes are entirely unaffected by this (that system has no concept of `workerTarget`).

## 4. Files touched

| File | Change |
|---|---|
| `src/_engine/core/Physics/PhysicsAPITypes.ts` | Add `useSAB`/`maxBodies` to `PhysicsState`; add `slot` to `CreateRigidBodyResponse`/`CreateRigidBodiesResponse`; add `PhysicsProtocolType.TRANSFORMS_PUSH`; uncomment/finalize `WorldAPI.step()`'s worker-facing message shape where needed |
| `src/_engine/core/Physics/PhysicsTransformBuffer.ts` (new) | Buffer factory + slot allocator + typed views for the physics-owned hot path |
| `src/_engine/core/Physics/EngineRapier.ts` | Add `getAllRigidBodyIds()` export for the worker's per-step write-back loop |
| `src/_engine/workers/physicsWorker.ts` | Implement the `STEP` case: `engAPI.step()` + hot-path write-back + `TRANSFORMS_PUSH` in fallback mode |
| `src/_engine/workers/physics/physicsSwitchRigid.ts` | `CREATE_RIGID_BODY(S)` allocate + return a buffer slot; `DELETE_RIGID_BODY(S)` free it |
| `src/_engine/core/PhysicsAPI.ts` | `stepPhysics()` worker-mode branch; `createPhysicsWorld()` builds the main-thread `PhysicsTransformBuffer` wrapper in SAB mode; `onWorkerMessage` handles `TRANSFORMS_PUSH`; `RigidBodyProxyAPI.pos`/`.rot` become slot-indexed getters |
| `src/_engine/core/PhysicsManager.ts` | `createPhysicsEntity` becomes `async` with a worker-mode branch |
| `src/app/physicsTest.ts` | `await` the three `createPhysicsEntity(...)` calls |
| `src/_engine/core/Config.ts` | Add `physics.useSAB`/`physics.maxBodies` to `AppConfig` + engine defaults; add `VITE_PHYS_USE_SAB` env override; default `workerTarget` becomes `'WORKER_THREAD'` (Phase 6) |
| `src/CONFIG.ts` | Set `workerTarget: 'WORKER_THREAD'` explicitly (Phase 6) |
| `vite.config.ts` | Add COOP/COEP dev-server headers |
| `.claude/CLAUDE.md` | Update the stale "physics currently only runs on the main thread... worker file body is commented out" paragraph to reflect this MVP |

## 5. Explicitly out of scope / non-goals

- Collision/contact-force events over the worker boundary — still fully deferred, same as p020 §5/§6 item 3. `TRANSFORMS_PUSH` (§3.3) is introduced only for hot-path transforms; a future events push channel is a natural follow-on but not built here.
- `debugRender()` in worker mode — stays a `throw`, same as p020 §5; no Tweakpane/line-visualizer wiring for either mode yet.
- Fixed-timestep accumulator, background-pause handling, position/rotation interpolation in `stepPhysics` — carried forward as deferred from p020 §5; this MVP's stepper stays as simple as p020 left it.
- A proper lock-free seqlock/double-buffer for the `SHARED_MEMORY` hot path — accepted torn-read risk for MVP (§3.3), revisit only if visibly jittery.
- Configuring production/hosting COOP/COEP headers — this plan only touches `vite.config.ts`'s dev server; production hosting is external to this repo and must set matching headers itself, or the automatic fallback (§3.1) engages there instead.
- A second physics engine (Jolt/Ammo) — `ENGINES.ts` stays single-entry, same as p020 §5.
- Migrating `PhysicsRapier.ts`'s 17 importers to the new API — unrelated, separate future plan (p020 §6 item 9, still open).
- Joints and the character-controller section of `PhysicsAPITypes.ts` — untouched.
- `lvel`/`avel` in the hot-path buffer — only `pos`/`rot` are synced per-frame; velocity stays RPC-only (unused by `physicsToTransformSystem` today).
- Bulk/stress-test physics scenes (many bodies) — `physicsTest.ts`'s existing 3-body scene (1 static, 2 dynamic) is reused as-is for verification; a dedicated many-body worker-mode stress scene is a reasonable follow-up but not required to prove the MVP.

## 6. Follow-up work (post-MVP)

1. Collision/contact-force event system over the worker boundary, likely reusing the `TRANSFORMS_PUSH`-style unsolicited-message pattern established here.
2. A proper seqlock/double-buffer for the `SHARED_MEMORY` hot path if torn reads prove visible.
3. `debugRender` wired into a real visualizer, for both main-thread and worker modes.
4. Fixed-timestep accumulator + interpolation in `stepPhysics` (both modes).
5. A many-body stress-test scene specifically for worker-mode performance validation (message-batch vs. shared-memory comparison).
6. Production-hosting documentation/checklist for COOP/COEP headers (once an actual hosting target is chosen).
7. Second physics engine backend (Jolt/Ammo), per p020 §6 item 7 — still blocked on the same rationale (contract should stop moving first).
8. Migrate `PhysicsRapier.ts`'s importers to the new API and retire it (p020 §6 item 9) — this plan doesn't change that dependency.

## 7. Phased rollout

**Phase 1 — Config + buffer scaffolding. No behavior change (workerTarget stays main-thread-default until Phase 6).** Add `useSAB`/`maxBodies` to `Config.ts`/`PhysicsAPITypes.ts`, add the `VITE_PHYS_USE_SAB` env override, create `PhysicsTransformBuffer.ts` (factory + slot allocator, unit-testable in isolation via manual console checks — no test runner in this repo), add `TRANSFORMS_PUSH` to the protocol enum. Manual verification: `tsc --noEmit` clean, `yarn lint` clean, nothing imports the new file yet so no runtime change.

**Phase 2 — De-risk WASM-in-worker + implement `STEP` end-to-end (still not the default).** Implement `physicsWorker.ts`'s `STEP` case (call `engAPI.step()` only, no hot-path write-back yet) and `PhysicsAPI.ts`'s worker-mode branch in `stepPhysics()`. Manual verification (via the `run-aekasha-js` skill, using the browser console with `workerTarget` temporarily forced to `'WORKER_THREAD'` in a local `CONFIG.ts` edit or override): `initPhysics()` → `createPhysicsWorld()` → `createRigidBody(...)` → repeated `stepPhysics(...)` calls complete with no console errors — this is the go/no-go check for whether Rapier's WASM actually loads and runs inside a Vite-bundled worker at all. If it fails to load/initialize, stop and reassess before continuing (see §8).

**Phase 3 — Hot-path buffer wiring, both transport modes.** Implement the `SHARED_MEMORY` and `MESSAGE_BATCH` paths in `physicsWorker.ts`/`physicsSwitchRigid.ts`/`PhysicsAPI.ts` per §3.3. Manual verification: with a rigid body created under `WORKER_THREAD`, confirm `getRigidBodyAPIWithId(id).pos` changes frame-to-frame under gravity via the browser console, tested once with `useSAB: true` (in a session where the COOP/COEP headers are present) and once with `useSAB: false` (fallback forced) — both must show live-updating positions.

**Phase 4 — `PhysicsManager.createPhysicsEntity` async branch.** Per §3.4. Manual verification: `tsc --noEmit` clean; `physicsTest.ts`'s three `createPhysicsEntity` calls succeed under `WORKER_THREAD` without throwing the current "`*Sync` not supported in worker mode" errors.

**Phase 5 — End-to-end verification with the physics test scene, still opt-in.** With `workerTarget: 'WORKER_THREAD'` forced locally (not yet the committed default), load `physicsTest.scene.json` via the debug scene switcher (`run-aekasha-js` skill) and confirm the ball and box fall and settle on the ground exactly as in main-thread mode, with no console errors, tested under both `useSAB: true` and `useSAB: false`. Also confirm switching back to `MAIN_THREAD` still works with no regression, and that a `PhysicsRapier.ts`-driven scene (e.g. `scene01.ts`) is unaffected throughout.

**Phase 6 — Flip the default, update docs.** Set `workerTarget: 'WORKER_THREAD'` in both `Config.ts`'s engine default and `src/CONFIG.ts` (§3.6), add the COOP/COEP headers to `vite.config.ts` unconditionally (§3.5), update the stale physics paragraph in `.claude/CLAUDE.md`. Manual verification: fresh `yarn dev` boot with no local overrides shows the physics test scene running under worker-thread mode by default; `tsc --noEmit` and `yarn lint` clean across the whole repo.

## 8. Risks and open questions

| Risk / question | Notes |
|---|---|
| Rapier's WASM has never been runtime-verified inside a Vite `?worker` module | The single biggest unknown in this plan — de-risked explicitly and early in Phase 2, before any hot-path work is built on top of it. If `vite-plugin-wasm` doesn't resolve correctly in the worker's separate module graph, the fallback is investigating `vite-plugin-wasm`'s worker-specific options or a manual `fetch()`+`WebAssembly.instantiate()` init path inside `physicsWorker.ts` — a materially bigger change than anything else in this plan, worth flagging to the user immediately if hit. |
| COOP/COEP headers becoming the default dev-server behavior | These headers can break loading of any cross-origin resource that doesn't itself send CORP/CORS headers (external CDN fonts, iframes, some third-party embeds). No such cross-origin resource loading was found in this repo during research, but this is a standing constraint on future asset choices once Phase 6 lands — worth a one-line callout in `CLAUDE.md`. |
| Torn reads on the `SharedArrayBuffer` hot path (no locking) | Accepted for MVP (§3.3/§5) — floats are small, and this matches how many real-time shared-memory designs start. Revisit (seqlock/double-buffer, §6 item 2) only if visibly jittery in Phase 5's manual check. |
| `maxBodies` capacity exceeded | Must throw a clear, immediate error at creation time (mirroring `TypedArrayTransformStore`'s existing capacity-exceeded error), not silently corrupt another body's slot. Confirm this is actually implemented and tested (e.g. temporarily set `maxBodies: 1` and try creating 2 bodies) during Phase 3. |
| Production hosting headers are outside this repo's control | This plan only configures `vite.config.ts`'s dev server (§3.5). Explicitly flagged as out of scope (§5) rather than silently assumed — the runtime capability check (§3.1) degrades gracefully to `MESSAGE_BATCH` wherever COOP/COEP aren't present, so this is a performance-only risk in production, not a correctness one. |
| `MESSAGE_BATCH` fallback bit-rotting since `useSAB: true` is the new default | Both transport modes must be explicitly exercised in Phase 3 and Phase 5's manual verification (not just the default SAB path), since the whole point of this option is that some environments need the fallback. |
| `EngineRigidBodyProxyAPI` (main-thread mode, p020 §3.1) | Untouched by this plan — confirm in Phase 4/5 manual checks that `MAIN_THREAD` mode's existing getter-based hot path still works exactly as before, since `CONFIG.ts`'s default flip (Phase 6) means `MAIN_THREAD` becomes the non-default-but-still-supported path going forward. |

## 9. Verification

- `tsc --noEmit` and `yarn lint` clean after every phase (per the Stop hook).
- Phase 2: browser-console proof that `stepPhysics()` in worker mode runs without error.
- Phase 3: browser-console proof that a worker-mode rigid body's `pos` updates frame-to-frame, under both `useSAB: true` and `useSAB: false`.
- Phase 5: full `physicsTest.scene.json` run under worker-thread mode (both SAB and fallback), visually matching main-thread mode's behavior (ball/box fall and settle, no console errors), plus a regression check that `MAIN_THREAD` mode and an old-system (`PhysicsRapier.ts`-driven) scene are both unaffected.
- Phase 6: a completely fresh `yarn dev` (no local config overrides) boots with worker-thread physics running by default.
