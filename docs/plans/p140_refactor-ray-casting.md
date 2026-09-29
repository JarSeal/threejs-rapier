Status: draft | not-implemented
Category: Refactor, Debugger
Blocks: p141_ray-debug-line-helpers.md, p142_physics-ray-debugging-and-stats.md, p143_ray-cast-tester-windows.md
Related: \_DONE_p105_refactor-debugger-drawer-tab-creation.md (will change how the Ray Cast tab is built), p220_stats-profiler-mega-window.md (still a prompt in `docs/templates/todo-plan-prompts.txt`; consumes the stats API defined here), \_DONE_p061_add-undo-history-action-recording-to-debugger-tools.md (§2.2 classifies the Ray Cast settings as no-undo)

# Refactor Ray Casting — Plan

The Three.js ray casting module (`src/_engine/core/Raycast.ts` + `src/_engine/core/Debug/_dbg__Raycast.ts`)
grew organically: a misleading API, post-hoc distance filtering, per-cast allocations, ray-count
statistics that are copy-pasted four times and re-rendered as a full HTML string every frame, and a
Percentage pie made of 7 nested inline-styled spans. This plan cleans up the core API, turns the
measuring into a small reusable, O(1)-per-frame stats API that the future Statistics Profiler mega
window (p220) can read, and optimizes the Percentage pie.

It is also the **entry point of the "ray casting" plan set** (see §1.1). The debug line helpers, the
physics rays and the ray tester windows are split into their own plans because each touches a
different subsystem (line renderer, physics query API, debug windows) and can be reviewed alone.

---

## 1. Goal

- A clean, intuitive, allocation-free Three.js ray casting API with one options type.
- Ray measuring as a public API (`getRayCastStats()` etc.) built on a generic interval-stats util that
  physics rays (p142) and the profiler (p220) reuse.
- The Ray Cast Controls tab updates its stats cheaply (no per-frame HTML rebuild) and the Percentage
  pie becomes a single, cheaply-updatable element.
- No behaviour change for the only live consumer (mouse/touch picking).

### 1.1 The plan set

| Plan | Scope | Order |
|---|---|---|
| **p140** (this) | Three.js raycast API cleanup, stats util + stats API, Percentage pie, cheap stats view | 1 |
| p141_ray-debug-line-helpers.md | Opt-in dashes for the FAT line backend; shared, pooled, fading thick-line ray helpers with active/inactive styles; helper settings + per-kind colors in the tab | 2 |
| p142_physics-ray-debugging-and-stats.md | Fix two worker-mode query bugs; physics-owned ray instrumentation (stats + helpers); "Physics rays" section in the tab | 3 |
| p143_ray-cast-tester-windows.md | Three.js and physics ray tester draggable windows, per-scene localStorage params, multi-ray-ready state | 4 |

### 1.2 Ownership decision (physics rays)

**Physics owns the physics-ray instrumentation; `Raycast.ts` owns only Three.js rays; the Ray Cast
Controls tab is only a view composing both.** Rationale:

- Only `PhysicsAPI.ts` sees every physics query in both `workerTarget` modes, including the async
  results (worker replies arrive ≥1 frame later through `messageWorkerAsync`). `Raycast.ts` never
  sees them.
- It keeps `Raycast.ts` free of any physics import, and puts the hook next to the engine-agnostic
  `WorldAPI`, so a future Jolt/Ammo backend (`Physics/ENGINES.ts`) implements the same hook.
- The **shared pieces are engine-agnostic modules** used by both kinds: the stats util
  (`utils/stats/IntervalCounterStats.ts`, this plan) and the ray helper renderer
  (`core/Debug/_dbg__RayHelpers.ts`, p141). Each kind has its own stats instance, settings and
  helper colors.

---

## 2. Current state (grounded in the actual code)

### 2.1 `src/_engine/core/Raycast.ts` (216 lines)

- `let ray: THREE.Raycaster | null` is created in `initRayCasting()` (called from `MainLoop.ts:379`),
  so every cast does `ray as THREE.Raycaster`, and `castRayFromScreenPosition` has a lazy-init
  workaround ("Input events can arrive before initMainLoop has called initRayCasting").
- **`castRayFromPoints(objects, from, to)` treats `to` as a direction**: it calls
  `ray.set(from, to)` and `Raycaster.set(origin, direction)` expects a normalized direction. The debug
  helper is drawn the same (wrong) way. The name promises point-to-point.
- `startLength`/`endLength` are applied **after** `intersectObject(s)` in `getRayCastIntersects`,
  and only when `perIntersectFn` is passed. The returned array is never filtered by them. Setting
  `Raycaster.near/far` instead would prune inside the intersection tests.
- `perIntersectFn` is typed `(…) => void | boolean`, but the return value is ignored.
- `getAngleDirectionPoint` does `DIRECTIONS[...].clone()` on every `castRayFromAngle` call.
- The three `castRayFrom*` functions each destructure the same opts and repeat the same body.
- Debug: every cast calls `useDebug(debugGUI)?._drawRayHelper(...)`, which also **counts the ray for
  the stats** (see 2.2). So counting only works in debug and is tied to the helper call.

### 2.2 `src/_engine/core/Debug/_dbg__Raycast.ts` (380 lines)

- The state is `rayCastState = { showAllRayDebugHelpers, enableRayStatistics }` in LS key
  `debugRayCast` (not `AEK_`-prefixed; p105 says not to rename it).
- `DEFAULT_STATS` has 24 fields. `_updateStats()` (:226-338) repeats the same "interval elapsed →
  publish + reset, else compute progress %" block four times (3s max/min, 10s max/min, 3s average,
  20s average).
- **Two frame boundaries.** `_countRayCastFrames()` is called from `MainLoop.ts:214` (only while the
  app is playing, including frames the FPS limiter skips). `_updateStats()` runs from the LATE_MAIN
  `rayHelperCleanupSystem` (:73-80, only on rendered frames). Averages therefore divide the rays of
  rendered frames by a frame count that includes skipped frames.
- `countStats()` runs before the helperId check in `_drawRayHelper` (:98), so every cast is counted
  but only rays with a `helperId` get a helper. No real caller passes one.
- **Per-frame DOM rebuild.** While the drawer is open on this tab, every rendered frame calls
  `statsCMP.update({ html: statsHtml(...) })` (:325-329). `CMP.update({html})`
  (`src/_engine/utils/CMP.ts:623-687`) builds a new `<template>`, re-parses the HTML, does
  `elem.replaceWith(newElem)`, runs `querySelectorAll('cmp')` on it and re-attaches listeners. The
  HTML contains 6 Percentage pies (2 of them duplicates), about 1.5 kB of inline styles each.
- Reset hooks: `deleteAllRayHelpers` from `SceneLoader.ts:504` (scene exit) and `resetRayCastStats`
  from `SceneLoader.ts:561` (scene enter).

### 2.3 `src/_engine/utils/UI/PercentagePieHtml.ts`

- It returns a 7-span HTML string with long inline styles. Only two rotation values change.
- Bug: `class="${class0}"` interpolates an array, so an extra `mainClass`/`fillClass` becomes
  `"percentagePie,foo"`.
- `size` is typed `number`, but the default is the string `'200'`.
- The only user is `_dbg__Raycast.ts:345-353`. No CSS targets `.percentagePie`
  (`src/_engine/styles/debugger.scss:3-29` only styles `.rayCastStats`).

### 2.4 Consumers

| Function | Call sites |
|---|---|
| `castRayFromScreenPosition` | `core/Input/InputPicking.ts:34` (`pickTargetsAt`, with `{recursive, optionalTargetArr}`), used by `MouseInput.ts:124` and `TouchInput.ts:130` |
| `castRayFromPoints`, `castRayFromAngle` | none in `src/` |
| `initRayCasting` | `MainLoop.ts:379` |
| `registerRaycastDebugGUI` | `InitApp.ts:103` (debug env) |
| `countRayCastFrames` | `MainLoop.ts:214` |
| `deleteAllRayHelpers` / `resetRayCastStats` | `SceneLoader.ts:504` / `:561` |
| `cleanUpRayHelpers` (wrapper) | none (`_cleanUpRayHelpers` runs only as the plugin system) |

### 2.5 No reusable stats util exists

`_dbg__Stats.ts` (interval max for the PHY panel; a 60-sample `push`/`shift`/`reduce` average for
TFPS), `_dbg__PostFXProfiler.ts` (a private EMA helper) and `_dbg__Raycast.ts` each roll their own.

---

## 3. Design

### 3.1 Raycast API (`src/_engine/core/Raycast.ts`)

- One module-level `const raycaster = new THREE.Raycaster()`, created on import. No nullable ray, no
  casts, no lazy init. `initRayCasting()` stays but only wires up the debug side. Its body is a no-op
  outside debug, and it is kept so `MainLoop.ts:379` doesn't change.
- One options type:

  ```ts
  export type RayCastOpts<T extends THREE.Object3D = THREE.Object3D> = {
    /** Minimum hit distance (Raycaster.near), default 0 */
    near?: number;
    /** Maximum hit distance (Raycaster.far), default Infinity (castRayFromPoints: the from→to distance) */
    far?: number;
    recursive?: boolean;             // default true (three's default)
    /** Reused result array (cleared by three before filling) */
    target?: Array<THREE.Intersection<T>>;
    /** Called per hit in distance order; return false to stop iterating */
    perIntersect?: (intersect: THREE.Intersection<T>) => void | boolean;
    /** Count this ray in the ray stats (default true; the ray testers pass false) */
    countInStats?: boolean;
    /** Debug helper options (shape defined in p141); ignored outside debug */
    debug?: RayDebugOpts;
    /** @deprecated use `debug.id` */ helperId?: string;
    /** @deprecated use `debug.color` */ helperColor?: THREE.ColorRepresentation;
    /** @deprecated use `near` */ startLength?: number;
    /** @deprecated use `far` */ endLength?: number;
    /** @deprecated use `target` */ optionalTargetArr?: Array<THREE.Intersection<T>>;
    /** Only castRayFromAngle: the local axis rotated by the angle (default FORWARD) */
    directionForAngle?: keyof typeof DIRECTIONS;
  };
  ```

  Until p141 lands, `RayDebugOpts` is `{ id: string; color?: THREE.ColorRepresentation }`, which is
  exactly what the deprecated `helperId`/`helperColor` map to.

- Public functions:
  - `castRayFromDirection(objects, origin, direction, opts?)` is **new** and does what
    `castRayFromPoints` does today.
  - `castRayFromPoints(objects, from, to, opts?)` becomes **truly point-to-point**:
    direction = `normalize(to − from)` (into a scratch vector), and `far` defaults to
    `from.distanceTo(to)`. This is a behaviour change, documented in the TypeDoc. There are no
    callers in `src/`.
  - `castRayFromAngle(objects, origin, angle, opts?)` keeps its signature. It uses a module scratch
    vector instead of `.clone()`.
  - `castRayFromScreenPosition(objects, ndcX, ndcY, camera, opts?)` keeps its signature.
- All four funnel into one private `castPrepared(objects, opts)`. It:
  1. sets `raycaster.near/far`;
  2. calls `intersectObject(s)`;
  3. runs `perIntersect` with early-out on `false`;
  4. counts the ray (§3.2);
  5. calls the debug helper hook via `useDebug(...)` with origin, direction, far and the first hit
     distance.

  `near`/`far` are restored to 0/Infinity after each cast, because the raycaster is shared.
- The deprecated aliases are resolved in one place (`resolveOpts`). They are removed in a follow-up
  release.

### 3.2 Stats util and stats API

New generic util **`src/_engine/utils/stats/IntervalCounterStats.ts`** (engine-level, no debug
imports, tiny):

```ts
export type IntervalWindowConfig = { id: string; intervalMs: number; kind: 'MIN_MAX' | 'AVERAGE' };
export type IntervalWindowSnapshot = {
  id: string; intervalMs: number; kind: 'MIN_MAX' | 'AVERAGE';
  min: number; max: number; average: number;   // last published values
  progress: number;                            // 0..1 through the current interval
};
export type IntervalCounterSnapshot = {
  current: number;        // count accumulated so far this frame
  lastFrame: number;      // count of the last finished frame
  maxEver: number;
  windows: readonly IntervalWindowSnapshot[];
};
export class IntervalCounterStats {
  constructor(windows: IntervalWindowConfig[]);
  add(n?: number): void;          // hot path: one integer add
  endFrame(nowMs: number): void;  // once per rendered frame, O(windows)
  reset(nowMs?: number): void;
  snapshot(): Readonly<IntervalCounterSnapshot>; // the same pre-allocated object every call
}
```

- The implementation is plain field arithmetic, with no arrays created per frame. It replaces the
  four copy-pasted blocks and the 24-field `DEFAULT_STATS`.
- `snapshot()` returns the same object every call, so the profiler can poll it without allocating.
  Callers must not keep a reference expecting it not to change.
- Raycast keeps one instance with the current default windows: MIN_MAX 3s and 10s, AVERAGE 3s and
  20s.

Public API in `Raycast.ts`, part of the documented engine surface for p220:

```ts
export const setRayCastStatsEnabled = (enabled: boolean) => { … };
export const isRayCastStatsEnabled = () => statsEnabled;
export const getRayCastStats = (): Readonly<IntervalCounterSnapshot> => stats.snapshot();
export const resetRayCastStats = () => { … };           // existing name, now core (not debug-only)
```

- **Counting is core.** It is not in the `_dbg__` module anymore. The hot-path cost when disabled is
  one boolean check per cast. This lets p220's planned prodTest option ("Enable measuring display
  panels in prodTest") read ray stats later without loading the debug module. Enabling is driven by
  the tab's "Enable ray cast statistics" toggle, which stays persisted in `debugRayCast`.
- **One frame boundary.** `endFrame(performance.now())` runs from a single LATE_MAIN system (only on
  rendered frames). The `countRayCastFrames()` call in `MainLoop.ts:214` and the export are removed,
  so averages become "rays per rendered frame". Ray casts made on skipped frames still count toward
  the next rendered frame. This is documented.
- The system is registered through `ECSWorld.registerPlugin` from `Raycast.ts` (core), with the same
  stage and priority as today's `rayHelperCleanupSystem`. p141 hooks the helper update into the same
  pass.
- Scene hooks stay where they are: `SceneLoader.ts:561` → `resetRayCastStats()` (now core) and
  `SceneLoader.ts:504` → `deleteAllRayHelpers()`.

### 3.3 Stats view in the Ray Cast Controls tab

- The stats block is built **once per tab open** as static markup with cached element references:
  one text node per value and one pie per window.
- A throttled refresh (default 200 ms / 5 Hz, a `STATS_VIEW_REFRESH_MS` constant) writes only
  `textContent` and `pie.set(progress)`, and only while
  `getDrawerState()?.isOpen && currentTabId === 'rayCastControls'`. After p105 lands this becomes
  `isDebuggerTabOpen('rayCastControls')` / `refreshIntervalMs`.
- When statistics are disabled, the block gets an `inactive` class and shows `-` values, with no
  rebuild.
- The duplicated pies go away: the max and min rows share one pie per window, next to a combined
  "max / min" row.
- The tab state stays a flat object (`rayCastState`) so p105's declarative `state`/`lsKey`
  migration is mechanical.

### 3.4 Percentage pie (`src/_engine/utils/UI/PercentagePieHtml.ts`)

- The rendering becomes a single element:
  `<span class="percentagePie" style="--p: 42">`, styled in `src/_engine/styles/debugger.scss`:

  ```scss
  .percentagePie {
    display: inline-block; width: 1rem; height: 1rem; border-radius: 50%;
    background: conic-gradient(var(--pie-fill, #fff) calc(var(--p, 0) * 1%), var(--pie-bg, transparent) 0);
    vertical-align: middle;
  }
  ```

- New `createPercentagePie(opts?) → { cmp: TCMP; set(percentage: number): void }`. `set` clamps,
  rounds, and writes `style.setProperty('--p', …)` only when the rounded value changed. It never
  touches innerHTML.
- `PercentagePieHtml(percentage, opts)` stays as the string version for one-off markup, now one span.
  The class join bug is fixed (`class0.join(' ')`), and `size` is removed in favour of `height`
  (`size` only enlarged the old span-geometry hack).
- The `opts` keep `height`, `mainClass`, `fillClass` (mapped onto the element) and `fillColor`
  (mapped to `--pie-fill`).

---

## 4. Phases (each non-breaking and committable on its own)

### Phase 1: stats util, stats API, one frame boundary

- Add `utils/stats/IntervalCounterStats.ts`.
- Move counting into `Raycast.ts` (core). Add `get/set/isRayCastStatsEnabled` and core
  `resetRayCastStats`.
- Register the LATE_MAIN `endFrame` system in core. Remove `countRayCastFrames` (`MainLoop.ts:214`
  and the export).
- `_dbg__Raycast.ts` reads `getRayCastStats()` instead of its own `stats` object. The view is still
  built the old way.

### Phase 2: Percentage pie and cheap stats view

- Rewrite `PercentagePieHtml.ts` and add `createPercentagePie`. Add the `.percentagePie` style.
- Rebuild the stats block as cached DOM with a throttled refresh (§3.3).

### Phase 3: Raycast API cleanup

- Add `RayCastOpts`, `castPrepared`, `castRayFromDirection` and `resolveOpts` (deprecated aliases).
- Make `castRayFromPoints` point-to-point and remove the per-cast allocations.
- Make `initRayCasting` debug-only.
- Update `InputPicking.ts` to `target` instead of `optionalTargetArr`. This isn't required, since
  the alias works, but it keeps the engine free of deprecated calls.

### Phase 4: documentation

- TypeDoc on every public export: the stats contract (snapshot object reuse, per-rendered-frame
  semantics) and the `castRayFromPoints` behaviour change.
- Update CLAUDE.md if the debug stats wording changes. Mark this plan done.

---

## 5. Risks, notes, out of scope

- **Engine API change.** The `castRayFromPoints` semantics change is technically breaking, but it
  fixes a bug and has no callers. With the deprecated option aliases, the engine bump for the branch
  stays **minor** (per CLAUDE.md "Versioning"). Removing the aliases later is a major bump, or it
  gets folded into the next planned major.
- **Shared raycaster.** `near`/`far` must be reset after every cast (a `try/finally` in
  `castPrepared`). A `perIntersect` callback that casts another ray re-enters `castPrepared` and
  overwrites the shared state, so this is documented as unsupported. The workaround is to collect
  the hits first and cast afterwards.
- **Stats semantics change.** Averages change from "rays per app frame" to "rays per rendered
  frame". Values rise slightly with the FPS limiter active. This is intentional and documented.
- **p105 interplay.** Build with the current tab API. p105's Phase 1/4 migrate the open-check and the
  dynamic stats section. Nothing here blocks p105, and p105 doesn't block this plan.
- **Out of scope:** debug line helpers (p141), physics rays (p142), testers (p143), a BVH
  (three-mesh-bvh) or spatial-index-accelerated raycasting (possible follow-up: `firstHitOnly` +
  p050's spatial index for broadphase), and the profiler window itself (p220).

---

## 6. Verification

- `yarn lint` and `yarn build` are clean (the Stop hook also runs them).
- `yarn dev`, then open `?isDebug=true`:
  - Mouse/touch picking behaves exactly as before.
  - Enable "Enable ray cast statistics" and move and click the mouse over pickable targets. The
    counts and pies move, and the windows roll at 3s/10s/20s.
  - Switch scenes. The stats reset.
  - DevTools Performance recording with the Ray Cast tab open: no per-frame DOM subtree
    replacement or style recalculation from the stats block, only about 5 Hz text/`--p` writes.
  - With the tab closed, there are no stats DOM writes at all.
- Temporary console check (not committed):
  - `castRayFromPoints(scene, a, b)` hits only between `a` and `b`.
  - `castRayFromDirection` matches the old `castRayFromPoints` results.
  - `getRayCastStats()` returns the same object reference across calls.
- A production build (`yarn build`) still contains no `_dbg__Raycast` chunk in the main bundle.
  Check `dist-stats/bundle-stats.html`.

---

## 7. Follow-up plans

- p141, p142, p143 (see §1.1).
- p220 Statistics Profiler mega window: reads `getRayCastStats()` and `getPhysicsRayStats()` (p142).
  A generic `registerStatsSource(id, getter)` registry can be introduced there if the profiler needs
  to enumerate sources.
- Remove the deprecated `RayCastOpts` aliases in a later release.
