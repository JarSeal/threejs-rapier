Status: draft | not-implemented

# ECS System Ordering + Ordering-Guarantees Docs — Plan

Two small, related changes to `src/_engine/core/ECS.ts`: an optional `order` param on `addSystem`, and doc comments that pin down exactly what ordering is (and isn't) guaranteed. No implementation yet — this is the approach to review first.

---

## 1. Current baseline (verified against every call site)

`addSystem`/`removeSystem`/`_runStage` today (`ECS.ts` L111-125, L518-523):

```ts
private systems: Map<ECSSystemStage, { id: string; fn: ECSSystem }[]> = new Map();

public addSystem(stage, id, fn) {
  const stageSystems = this.systems.get(stage);
  if (stageSystems?.some((s) => s.id === id)) return; // no-op on duplicate id
  stageSystems?.push({ id, fn });
}

public removeSystem(id) {
  this.systems.forEach((list, stage) => {
    this.systems.set(stage, list.filter((s) => s.id !== id));
  });
}

private _runStage(stage, dt) {
  const list = this.systems.get(stage)!;
  for (let i = 0; i < list.length; i++) list[i].fn(this, dt);
}
```

Execution order today is purely "whatever order `addSystem` happened to be called in" — a plain push, no sorting anywhere. Every call site (grepped):

| Stage              | Systems (current call order)                                                                            | How/when registered                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAIN`             | `object3DSyncSystem`, then `debugCameraSystem`                                                          | Former via static `registerPlugin` at module load (`ECSCoreSystems.ts`); latter hot-loaded later, when the debug camera initializes (`_dbg__DebugCamera.ts`) |
| `APP_POST_PHYSICS` | `physicsToTransformSystem`                                                                              | Static plugin, `ECSCoreSystems.ts`                                                                                                                           |
| `APP_LOGIC`        | `hoverToolSystem`, `followToolSystem`, `proximitySystem`                                                | All ad hoc `world.addSystem` calls at runtime, whenever that tool/effect/test is instantiated (`HoverEffect.ts`, `FollowTool.ts`, `ECSStressTest.ts`)        |
| `APP_RENDER_SYNC`  | `lookAtSystem`, then `instancedSync`                                                                    | Former static plugin; latter ad hoc (`ECSStressTest.ts`)                                                                                                     |
| `LATE_MAIN`        | `entityLifetimeSystem`, then `debugSymbolSyncSystem`, `lightHelperSyncSystem`, `cameraHelperSyncSystem` | First is a static plugin; the three debug ones are all hot-loaded later via `registerPlugin`, each from its own dynamically-imported `_dbg__*` module        |

Confirms the thing this change most needs to respect: **hot-loading is already the normal, routine path**, not an edge case — `initDebugCamera()`/debug-symbol/light-helper/camera-helper setup all call `registerPlugin` well after `initECSWorld()` has already constructed the world (per `InitApp.ts`'s call order), and `registerPlugin`'s "Hot Loading" branch (`ECS.ts` L51-54) applies the plugin to `activeWorlds` immediately. `HoverEffect`/`FollowTool`/`ECSStressTest` call `addSystem` directly at arbitrary runtime moments, likely with the main loop already running for many frames. Any ordering design has to work identically whether a system is added at bootstrap or three minutes into a running session.

---

## 2. Where sorting should happen: on every `addSystem` call, not lazily

Two options, as asked:

**A. Resolve order immediately inside `addSystem`** (recommended). Insert the new entry into its stage's array already in final sorted position (either push-then-resort, or a binary-search insert — either is fine given `addSystem` call volume, see below), so the array `_runStage` reads is always already correct.

**B. Leave the array unsorted on insert; sort lazily the first time a stage runs after a change** (a per-stage "dirty" flag, checked and cleared at the top of `_runStage`).

Recommendation: **A**. Reasoning:

- **B still requires a runtime check in `_runStage`** — even a single `if (dirty)` branch, every stage, every frame, forever — which directly conflicts with "no per-frame cost." A costs nothing per frame: `_runStage` doesn't change at all.
- **B doesn't actually save work.** `addSystem` calls are rare (plugin registration at boot + occasional dynamic tool pickup) — nowhere near hot-path frequency — so deferring the sort to "just before first run" instead of "at registration" doesn't reduce total sort operations in practice; it just adds bookkeeping (the dirty flag) for no benefit.
- **B has to define an ambiguity A doesn't have**: when a system is hot-loaded mid-session, does it take effect on the _current_ in-flight frame's `_runStage` call, or only the next one? With A, there's no question — the moment `addSystem` returns, the array is correct, and the very next `_runStage` call (whether that's the current frame or the next) sees it.

So: sort/insert in `addSystem`. Given current system counts (a dozen or so per stage, changing rarely), a full re-sort of the stage's array on every `addSystem` call is more than fast enough — no need for a fancier binary-search insert unless profiling ever says otherwise (it won't, at this scale).

---

## 3. Tiebreaker: explicit monotonic sequence number, not bare `sort` stability

`Array.prototype.sort` has been spec-guaranteed stable since ES2019, and technically, comparing only by `order` (`(a, b) => b.order - a.order`) while always pushing new entries at the end before re-sorting _would_ preserve registration order for ties — stability means equal elements keep their pre-sort relative order, and "push then sort" always puts the newest entry last among any group it's tied with.

Recommendation anyway: **carry an explicit `seq: number` field, incremented once per `addSystem` call, and sort by `(order desc, seq asc)`.** Reasoning:

- It makes the ordering rule **self-documenting in the data itself**. A future maintainer (or a debug dump, §6) can see _why_ two same-order systems are ordered as they are (`seq: 3` vs `seq: 7`) without needing to know, or trust, that "push-then-full-resort" is how insertion happens to be implemented everywhere it might ever be touched.
- It **decouples correctness from the specific insertion strategy**. If `addSystem` is later changed to a binary-search insert (for O(log n)/O(n) placement instead of a full resort) for performance, an off-by-one in "insert before vs. after equal-order entries" is exactly the kind of subtle bug that would silently reorder ties — with an explicit `seq` comparator term, any insertion strategy produces the same, obviously-correct order, because the tiebreak is in the comparator, not in "did I insert in the right spot."
- It costs one extra number per entry and one extra comparator term — effectively free, given how rarely `addSystem` runs.

This is exactly the situation the user is worried about ("I don't want to silently reshuffle my existing systems") — an explicit tiebreaker is the more defensive choice for a guarantee this load-bearing.

**Scope of the counter**: must be an **instance field on `ECSWorld`** (e.g. `private systemSeq = 0`), not static. `activeWorlds` can hold multiple independent worlds (`registerPlugin`'s hot-load branch applies a plugin to _every_ active world), and each world's stage lists must be ordered by _that world's own_ registration history — a shared/static counter would leak sequence numbers across unrelated worlds without meaning anything.

---

## 4. `order`: plain number, not a named tier enum

Agree with the lean toward a plain number. The case _for_ named tiers, for completeness:

- Self-documents intent at call sites (`SystemOrder.EARLY` reads better than a bare `100`).
- Gives one place to see the full priority story instead of grepping for magic numbers scattered across files.
- Reduces the chance of two unrelated features picking arbitrary, uncoordinated numbers that don't actually reflect their real relative-ordering need.

Why plain number wins anyway, here:

1. **Nothing today needs ordering at all** — `order` is a brand-new concept with zero existing non-default users. Introducing a tier enum now is structure built for a usage pattern that doesn't exist yet, which cuts against this project's own stated principle (CLAUDE.md: don't design for hypothetical future requirements).
2. **A closed tier set caps expressiveness at the exact moment it's introduced**, before real usage patterns are known. A plain number lets any future call site say "just barely before `object3DSyncSystem`" without waiting for a new named constant to be added to a shared enum (and bikeshed over its value relative to every other tier).
3. **Nothing forecloses adding tiers later, additively.** A small `const SystemOrder = { ... } as const` of named numeric constants can sit on top of a plain-number `order: number` API at any point, purely as call-site sugar, with zero API break — if/when enough call sites actually want named priorities. No reason to force that decision now.

Recommendation: `order: number = 0`.

---

## 5. API surface changes

- `addSystem(stage: ECSSystemStage, id: string, fn: ECSSystem, order: number = 0)` — default keeps every existing call site compiling and behaving unchanged; no call site needs to change.
- Stored entry shape grows: introduce a named type (e.g. `type SystemEntry = { id: string; fn: ECSSystem; order: number; seq: number }`) and change `systems: Map<ECSSystemStage, { id: string; fn: ECSSystem }[]>` to `Map<ECSSystemStage, SystemEntry[]>`.
- New instance field `private systemSeq = 0` (see §3), incremented in `addSystem` before use.
- `addSystem` body: assign `seq = this.systemSeq++`, insert `{ id, fn, order, seq }` into the stage's array in sorted position (push + `.sort((a, b) => b.order - a.order || a.seq - b.seq)`, or equivalent).
- `removeSystem`: **no logic change needed.** `.filter()` never reorders, so a correctly-sorted array stays correctly sorted after removal — the type change flows through automatically once `SystemEntry` exists. Worth noting as an explicit, intentional behavior: if a system is removed and later re-registered with the same `id`, it gets a _fresh_ `seq` (since the counter never rewinds) and lands at the back of its `order` tier, not back in its original tie position. That's a reasonable semantic ("this is a new registration now") but differs from a naive "removal is temporary" expectation, so it's worth a one-line comment on `removeSystem` too.
- The existing duplicate-id guard (`stageSystems?.some((s) => s.id === id)) return;`) is unaffected — a second `addSystem` call with the same `id` still no-ops even if it passes a different `order` than the first registration. Worth confirming this is the wanted behavior (it matches today's semantics) rather than "later call's order wins" — flagging since it's an easy thing to assume differently.

---

## 6. Debug tooling: dumping resolved order per stage

Worth doing, and cheap. Two parts:

1. **Data**: a small public method on `ECSWorld`, e.g. `getSystemOrder(stage: ECSSystemStage): { id: string; order: number; seq: number }[]`, returning a mapped copy of the (already-sorted) stage array. This doesn't need the `_dbg__` dynamic-import treatment the way Tweakpane/DOM debug code does — it's a trivial, always-cheap read, in the same spirit as the already-unconditional `getStorage`/`getEntitiesWith`. Add it to `ECS.ts` as a normal public method, no debug gating needed.
2. **Display**: the natural home is the ECS debug tab (`src/_engine/core/Debug/_dbg__ECS.ts`, currently a placeholder — see `docs/plans/ecs-typed-arrays-feature.md`, which already proposes upgrading this tab to a Tweakpane pane for the storage-mode setting). A stage picker + a read-only dump of `world.getSystemOrder(stage)` (id/order/seq) is a small, natural addition there once that pane exists — directly useful for verifying "did my systems actually end up in the order I intended," which is the whole motivation for this change. Not required to land this change; flagged as a good, low-effort follow-on.

---

## 7. Doc comments (proposed wording)

On `_runStage`:

```ts
/**
 * Runs every system registered for `stage`, in the order resolved once at
 * registration time by `addSystem` — this function does no sorting and
 * never reorders anything itself, so it has no ordering-related per-frame
 * cost.
 *
 * Stage execution order itself is decided elsewhere: it's the fixed call
 * sequence in `updateMainLoop` / `updateAppLoop` / `updateLateMainLoop`.
 */
```

On `addSystem`:

```ts
/**
 * Registers a system function to run every frame during `stage`.
 *
 * Ordering contract:
 * - Within a stage, systems run in descending `order` — higher runs earlier.
 * - Equal `order` (the default, 0) runs in registration order: the order
 *   `addSystem` was actually called, not source-file position. A system
 *   removed via `removeSystem` and re-registered later is treated as a new
 *   registration and moves to the back of its `order` tier.
 * - Resolved once, here, at registration time. `_runStage` never sorts.
 *
 * `order` is a plain number, not a fixed tier set — pick a value relative
 * to the specific systems you need to run before/after, not as a point on
 * some global priority scale.
 */
```

On `getStorage` (and a shorter cross-reference on `getEntitiesWith`):

```ts
/**
 * Direct access to a storage map for high-speed iteration.
 *
 * Iteration order happens to match `Map` insertion order (the order
 * entities first received this component) as a side effect of using `Map`
 * internally. This is an implementation detail, not a guarantee — systems
 * must not depend on it. It's expected to change for any component type
 * that moves to a different storage backing (e.g. the TypedArray-backed
 * sparse-set storage proposed in docs/plans/ecs-typed-arrays-feature.md,
 * which reorders on removal by design).
 */
```

```ts
/**
 * Returns an iterator for entity IDs... (existing doc)
 * Same iteration-order caveat as `getStorage` applies: insertion-order
 * today, not guaranteed.
 */
```

---

## 8. Risk check

- **No behavior change for any existing call site.** All 11 current `addSystem` calls (table in §1) pass no `order`, default to `0`, and tie-break by `seq` in the exact sequence `addSystem` is already called today — which is precisely today's undocumented behavior (raw push order). Byte-for-byte identical by construction, not by coincidence.
- **Pre-existing nondeterminism, not introduced by this change**: several `LATE_MAIN` systems are registered from separately dynamically-imported `_dbg__*` modules (`_dbg__Symbols.ts`, `_dbg__LightHelpers.ts`, `_dbg__CameraHelpers.ts`), so their relative load/registration timing already isn't strictly deterministic run-to-run. That's true today with zero sorting and remains equally true after this change (all still default to `order: 0`) — worth knowing about, not a new risk.
- **Type ripple**: `systems`'s value type change (`{id,fn}[]` → `SystemEntry[]`) is internal to `ECS.ts`; nothing external touches `systems` directly, so no other file needs edits for typing to hold.

---

## 9. Files/functions to touch

- `src/_engine/core/ECS.ts`:
  - `systems` field type → `Map<ECSSystemStage, SystemEntry[]>` (+ new `SystemEntry` type).
  - New `private systemSeq = 0`.
  - `addSystem` — new `order` param, `seq` assignment, sort-on-insert, new doc comment.
  - `removeSystem` — doc-comment addition only (re: fresh-`seq`-on-re-add behavior); no logic change.
  - `_runStage` — new doc comment only; no logic change.
  - `getStorage`, `getEntitiesWith` — new/extended doc comments only; no logic change.
  - New `getSystemOrder(stage)` method (§6).
- No other files need edits — every existing `addSystem` call site keeps compiling and behaving unchanged.
- Optional follow-on (not required for this change): `src/_engine/core/Debug/_dbg__ECS.ts` — add the resolved-order dump UI once that tab has a Tweakpane pane (tracked separately in `docs/plans/ecs-typed-arrays-feature.md`).

---

## 10. Things worth double-checking before implementing

1. Confirm the duplicate-`id` no-op behavior (§5, last bullet) is actually wanted going forward — i.e. a second `addSystem` call for an existing `id` should keep silently ignoring the call (including any new `order` it passes), matching today. Nothing in the request implies changing this, but it's a real interaction the new param touches.
2. `getSystemOrder` (§6) is scoped as an always-available plain method here, not behind `IS_DEBUG_ENV`/`_dbg__` gating — confirm that's the right call before implementing, since every other piece of GUI/debug-facing code in this engine follows the dual-layer pattern (the data accessor itself is cheap enough that it arguably doesn't need it, but worth a conscious yes/no rather than an assumption).
