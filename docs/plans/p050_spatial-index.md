Status: draft | research — not-implemented
Category: ECS / Spatial
Blocks: /docs/plans/p081_light-object-culling.md

# Spatial Index (Sparse Grid) — Research & Recommendation

A general-purpose "what's near this point/volume" primitive for the engine. Two consumers motivate it: near-term, unblocking `docs/plans/p081_light-object-culling.md` §2.3 (which explicitly deferred building this); longer-term, NPC spatial-awareness queries once AI/NPC systems exist.

This document is research/recommendation plus an implementation shape — it is not itself an implementation. No NPC system exists yet (confirmed by grep across `src/app`/`src/toolkit`). Phases in §11 are written so the work can land in reviewable, non-breaking chunks.

---

## 1. What exists today

Confirmed via codebase research: **no spatial index exists anywhere in the engine** — no octree, BVH, grid, or spatial hash (the same finding `p081_light-object-culling.md` §2.1 already made). Two things that look like candidates on the surface, and why neither is sufficient:

- **Rapier's internal broadphase** (`src/_engine/core/PhysicsRapier.ts`): Rapier maintains a broadphase for collision detection, but (a) it's only reachable through CRUD + stepping today — no shape/point/ray query API (`castShape`, `intersectionsWithShape`, `castRay`) is exposed to app/toolkit code, and even the commented-out worker rewrite (`core/Physics/EngineRapier.ts` + `PhysicsAPITypes.ts`) declares only ray queries; (b) more fundamentally, it only knows about entities with colliders (`TAG_IS_PHYSICS_OBJECT`). Lights and purely decorative meshes — exactly what light-object-culling needs to query — commonly have no collider, so a Rapier-only solution can't cover them.

  Two further reasons that will harden over time, worth recording now: collider AABBs are tight to *collision* shapes, not render bounds (a character capsule is much smaller than the rendered mesh with attachments, so culling against it pops at screen edges); and physics positions are last-fixed-step, whereas culling wants the transform the renderer will actually use. When the threaded physics path in `src/_engine/workers/physics/*.ts` is revived, a third reason appears — the query pipeline lives with the `World` object, so every query becomes an async round trip. Physics is main-thread-only today, so that one is future tense, but it argues against ever making the broadphase the primary index.

- **`THREE.BufferGeometry.boundingSphere`**: used per-object in a couple of places (`helpers.ts:285`, `PhysicsRapier.ts:1464-1469`), never aggregated into a queryable structure. It is, however, the natural source for the per-entity radius this design needs (§4).

So there is genuinely nothing to extend — this is a from-scratch design decision.

---

## 2. Structure: sparse grid, CSR-backed

**Recommendation: a sparse uniform grid**, keyed by packed integer cell coordinate, with cell contents stored in persistent typed arrays rather than per-cell JS arrays.

### 2.1 Why not octree/BVH

Both structures earn their complexity when the indexed set is mostly static and query-heavy relative to update-heavy: static level geometry, precomputed occlusion volumes, ray-vs-triangle precision against complex meshes (that is `three-mesh-bvh`'s home turf, and it is not installed here — see §10). The *dynamic* half of what this index holds does not look like that: culling candidates can move every frame, and NPC-awareness queries are by definition moving entities tracking moving entities.

A tree needs rebalancing or refitting as members move; a grid's per-entity cost is O(1) — recompute a cell key, place it in a bucket. An octree's real advantage (resolution adapting to non-uniform density) matters most when density is static and known ahead of time.

Note the asymmetry this exposes, though: it argues for a grid over the *dynamic* set, not over everything. §5 splits static from dynamic for exactly this reason, and a tree over the static half stays a live option for a later phase.

### 2.2 Why sparse, not a dense array

The world is expected to be large/open with density varying a lot by area. A dense 3D array needs fixed bounds and pre-allocates every cell including empty ones — wasteful and awkward to resize for an open/streaming world. Sparse keying costs nothing for empty regions; the only real risk is an oversized bucket in a dense cluster, which is a tuning problem (cell size) rather than a structural one.

### 2.3 Storage layout: CSR, not `Map<cellKey, number[]>`

The obvious encoding — a `Map` from cell key to an array of entity IDs — allocates a fresh array per occupied cell on every rebuild. At a few thousand occupied cells that is real allocation churn, and it shows up as frame-time *spikes* rather than average cost. It is also the thing most likely to push us into a premature incremental-update rewrite (§6) for the wrong reason.

Build instead as a counting sort into persistent typed arrays (compressed-sparse-row layout):

```
cellOf:    Uint32Array(n)        // dense cell index per member slot
counts:    Uint32Array(cells)    // zeroed per rebuild
cellStart: Uint32Array(cells+1)  // prefix sum over counts
items:     Uint32Array(n)        // entity indices, grouped by cell
```

Three linear passes, zero allocation after warm-up, sequential reads over the transform position arrays. A `Map<packedKey, denseCellIndex>` still handles sparse key → dense index; alternatively hash into a fixed-size table and tolerate collisions, since two cells sharing a bucket is harmless when the caller does an exact test on candidates anyway (§7).

This resolves the apparent tension between "sparse" and "rebuild per frame" — CSR gives both.

### 2.4 Cell key packing

Two easy-to-miss correctness traps, both worth writing into the implementation as comments:

- JS bitwise operators truncate to 32 bits, so a `(cx << 20) | (cy << 10) | cz` scheme silently caps at ~1000 cells per axis and wraps past it. Either document that bound explicitly and assert on it in debug builds, or pack with multiplication (safe to 2^53), or hash the triple.
- Use `Math.floor` for world-coordinate → cell conversion, **not** `| 0` or `Math.trunc`. Truncation rounds toward zero, which makes the cell straddling the origin double-width on each axis.

---

## 3. Membership: explicit opt-in

**Do not index "everything with a `Transform`."** `createEntity` adds `TRANSFORM` unconditionally, so that rule means every entity in the world — cameras, orbit-control holders, `TARGET_LINK` markers, headless physics bodies, debug symbols, ambient and hemisphere lights (which have no meaningful position at all). The index would pay rebuild cost on all of them and hand every consumer a candidate list full of things it must filter out.

**Recommendation:** a dedicated `SPATIAL_INDEXED` core component, added by the systems that create queryable entities (`MeshManager`, `LightManager`), registered through `ECSWorld.registerComponentHooks` for `onAddComponent` / `onRemoveComponent` / `onDeleteEntity`. Membership is then a set maintained at mutation time; the rebuild iterates members only, and there is no per-entity membership check in the hot loop.

This preserves the entity-type-agnostic property that motivated choosing ECS data over Rapier (§1) — the index holds whatever opted in, collider or not — without indexing the world.

### 3.1 Per-entity opt-out, and the special-case exclusion list

Two related questions came up: should an entity be able to opt *out*, and should certain kinds (ambient light) be excluded automatically?

**Opt-out: yes, as an entity option.** With managers opting entities in by default, there are legitimate cases for suppressing it per entity — always-visible hero geometry, anything whose culling answer is known statically. A `spatialIndex?: boolean` field on `CoreEntityOpts` (default `true` for the entity kinds that opt in) costs one boolean at creation and nothing at runtime, because the manager simply doesn't add the component.

**Automatic exclusion list: not as a runtime filter.** Under opt-in, ambient and hemisphere lights need no handling — `LightManager` just doesn't opt them in, so the list is empty by construction. Adding a denial list on top would mean enumerating every non-spatial entity kind and keeping it current forever, where each omission is a silent bug.

Keep the idea, but as a **debug-build tripwire**: when `SPATIAL_INDEXED` is added to an entity that also carries `TAG_IS_AMBIENT_LIGHT` or `TAG_IS_HEMISPHERE_LIGHT`, warn loudly. Free in production (`IS_DEBUG_ENV`-gated), and it catches the mistake at its source rather than letting a meaningless entity drift through queries.

On cost specifically: the performance question is not opt-in vs opt-out, it is *when the decision is evaluated*. A per-entity `hasComponent(NOT_INDEXED)` check during rebuild is a Map lookup per entity per frame — that is the shape to avoid. Hook-maintained membership resolves it once at mutation time and costs nothing per frame. Either polarity can be built that way, so the choice rests on defaults being right, which favours opt-in.

### 3.2 Two hook-ordering hazards

- **Tags are not available early.** `TAG_IS_AMBIENT_LIGHT` and friends are added by the `OBJECT3D` `onAddComponent` hook, so they do not exist until `OBJECT3D` is attached. Any membership or exclusion logic keyed on tags must run after that, which is a further argument against tag-driven membership and in favour of explicit opt-in. The §3.1 tripwire must handle "tag added after `SPATIAL_INDEXED`" as well as the reverse.
- **`ECSWorld.removeComponent` deletes before firing hooks.** The current implementation calls `storage.delete(entityId)`, *then* fetches and fires the hooks, then deletes again — despite the comment stating hooks fire before the data is gone. A removal hook that wants to read the component's last value (e.g. to compute which cell to evict from) will read `undefined`. Either fix that ordering as a prerequisite, or have the index keep its own last-known cell per member and never depend on reading the component during removal. The second is cheaper and is what §6 assumes.

### 3.3 Disabled entities

Index them, and let consumers check `world.isDisabled(entityId)`. Disabling is already a component add/remove, so excluding them would mean index churn on every enable/disable toggle — churn on a path that fires often (spawning, pooling, respawns) to save a cheap check on a path that fires once per candidate.

---

## 4. Entity extent and cell sizing

The original framing — index entity positions, size cells around the query radius — is incomplete, and the gap is the one most likely to produce visible bugs.

Light-object-culling is a **volume vs volume** test: a light's influence sphere against mesh bounding spheres. A point-based index answers "which entity *origins* are near this point," which is a different question. A 40m ground plane has its origin in one cell but overlaps hundreds; a 6m wall whose origin falls just outside the queried neighbourhood still receives light. Both get wrongly culled, and culling false negatives are the visible kind — geometry that goes unlit as the camera moves.

**Recommendation for the first version:** origin-based insert, plus two corrections.

1. **Query expansion.** Track `maxIndexedRadius` across members; expand every query radius by it before choosing which cells to walk. Conservative (more candidates) but correct, and cheap because insert stays O(1).
2. **Oversized tier.** Entities whose bounding radius exceeds a threshold (start at ~2× cell size) go into a separate flat list scanned on every query, and are excluded from `maxIndexedRadius`. This bounds the expansion — without it, one ground plane inflates every query in the world.

Per-entity radius comes from the render bounding sphere (`geometry.boundingSphere.radius` scaled by the transform's max scale component), or the light's influence radius for lights. It changes rarely, so cache it on the index at opt-in time and provide an explicit `updateRadius(entityId)` for the rare mutation.

If profiling later shows the conservative expansion costs more than it saves, Phase 4 (§11) tightens it to AABB-overlap insert — entities placed into every cell their bounds touch — which lets queries drop the expansion at the cost of multi-cell inserts and mandatory dedup (§7.1). CSR handles that fine; the counting sort just runs over `(cell, entity)` pairs instead of entities.

**Cell size** is therefore a function of *both* typical query radius and entity extent distribution, not query radius alone. Start with a single fixed, tunable size in the neighbourhood of typical light influence radius, and tune against the occupancy histogram from §9. Defer multi-resolution/hierarchical grids — if a mix of very-short-range and very-long-range queries appears, separate grids per domain (§5.1) is the simpler answer than hierarchical cells.

---

## 5. Static / dynamic split

Look at the actual population for the first consumer: lights and decorative meshes are overwhelmingly **static**. Re-bucketing a level's worth of unmoving geometry 60 times a second is pure waste, and it is precisely the cost that would push us into the incremental-update rewrite §6 tries to defer.

Maintain two indices behind one query facade:

- **Static** — built once at scene load, rebuilt only on explicit invalidation. `clearNonPersistent()` is the natural invalidation hook, as is any scene streaming boundary. Can afford a tighter cell size than the dynamic half.
- **Dynamic** — rebuilt per frame over a much smaller set.

Queries hit both and concatenate. This is a larger constant-factor win than any grid-vs-tree choice, and it costs one flag at opt-in time. An entity that changes category (a static prop becoming physics-driven) moves between indices via `removeComponent` + `addComponent`, which the hooks already handle.

### 5.1 Domains, not resolutions

If a future consumer needs different tuning (NPC agents at 5m perception radii vs level geometry at kilometre scale), create a **separate grid instance per domain** rather than a hierarchical one. The index should be instantiable, not a singleton, with domain selected at opt-in. This keeps the per-domain cell size honest and each rebuild small.

---

## 6. Data source and update strategy

Build from ECS `Transform` position data, not a separate position cache.

Read through a **single interface**, not two branches. §3 of the previous draft proposed reading `TypedArrayTransformStore` (`src/_engine/core/ECS/TypedArrayTransformStore.ts`) where available and falling back to the Map-backed `Transform` otherwise; two code paths in the hot loop means the fallback rots and the two drift. Instead give the transform store a bulk `copyPositionsTo(out: Float32Array, members: Uint32Array)` (exact signature TBC against that file's actual API): the typed-array store implements it as a strided copy, the object-backed store as a single gather per frame. The grid then only ever sees flat arrays, and the branch exists once, at a cold call site.

**Update policy:** rebuild-per-frame for the dynamic index (simplest, easiest to reason about, and cheap once the static half is split off per §5 and allocation is eliminated per §2.3). If profiling shows it is still too costly, move to incremental updates keyed off `Transform`'s existing `version` dirty-flag counter — re-bucketing only members whose cell key changed. Keep a per-member `lastCell: Uint32Array` from Phase 1 regardless; it costs 4 bytes per member, makes the incremental path a drop-in later, and sidesteps the `removeComponent` hazard in §3.2.

---

## 7. Query API

**Design for zero allocation per call.** `query(point, radius): number[]` allocating a fresh array defeats the purpose when called once per light per frame. Offer both:

```ts
queryVisit(p: ReadonlyVec3, r: number, visit: (entityId: number) => void): void
queryInto(p: ReadonlyVec3, r: number, out: Uint32Array): number // returns count
```

plus AABB variants. This is an API-shape decision that is painful to change once consumers exist, so settle it in Phase 1.

**Contract:** the index returns *candidates*, not results. The caller performs the exact test. This is already the shape `p081_light-object-culling.md` has — `testLightAgainstMeshList` is the exact test — so its external signature need not change, only its internals. Document the contract prominently; a caller that assumes results are exact will produce over-inclusion bugs that look like the index is broken.

### 7.1 Dedup

Once a query walks a cell neighbourhood (and certainly once Phase 4 adds multi-cell insert), the same entity can surface more than once. Do **not** allocate a `Set` per query. Use a `Uint32Array` of last-seen query stamps indexed by entity index, with a monotonically increasing stamp per query — O(1), allocation-free. The packed entity ID already yields a dense index via the existing `INDEX_MASK`, which is the same property that makes the CSR layout work.

---

## 8. Frame placement

The previous draft said "after `APP_POST_PHYSICS`." That needs to be one notch more precise, because `physicsToTransformSystem` runs *inside* that stage — "after the stage" and "after that system" are different requirements.

Register the dynamic rebuild **in `APP_POST_PHYSICS`, ordered to run last in the stage**. This is a direct use for the system `order` parameter (see the `addSystem` ordering plan); until that lands, registration order within the stage carries it, which should be called out in a comment so it is not silently broken.

Consumers in `APP_LOGIC` and `APP_RENDER_SYNC` then see a consistent, current snapshot. **Anything querying from `MAIN` or `APP_PRE_PHYSICS` sees a one-frame-stale index.** That is a legitimate thing to accept — NPC perception tolerates it easily — but a bad thing to discover by accident, so state it in the module doc comment.

---

## 9. Debug tooling and validation

Spatial index bugs are subtle: an entity missing from a candidate list reads as a rendering artifact, not a query bug. Two debug-build affordances, following the `_dbg__` + dynamic-import pattern (`src/_engine/core/Debug/_dbg__SpatialGrid.ts`):

- **Brute-force oracle.** Under `IS_DEBUG_ENV`, optionally run the linear scan alongside each grid query and assert the sets match. The code to do this already exists — it is `p081`'s `buildFrustumVisibleMeshList` — so the oracle is free during the transition and worth keeping behind a toggle afterwards.
- **Occupancy histogram + counters.** Bucket occupancy distribution, member count, occupied cell count, oversized-list length, average candidates per query, rebuild time. This is how cell size actually gets tuned; §4's "start around light influence radius" is a starting guess, not an answer.

A Tweakpane panel exposing cell size live (with rebuild on change) would shorten that tuning loop considerably.

### 9.1 Per-entity opt-in/opt-out toggle in the edit windows

The manager-level default from §3 (`MeshManager`/`LightManager` opt entities in) shouldn't be the only lever — §3.1's per-entity opt-out needs a UI, and the entity edit windows are the natural place: `_dbg__LightGUI.ts` (`src/_engine/core/Debug/Light/`) and `_dbg__CameraGUI.ts` (`src/_engine/core/Debug/Camera/`) already expose per-entity Tweakpane bindings for these two kinds today (meshes have no edit window yet, so this starts scoped to lights and cameras).

**Precedent to follow exactly:** the existing "Frustum Culling" toggle in `_dbg__LightGUI.ts` — a proxy object seeded from `world.hasComponent(entityId, ...)`, a `pane.addBinding(...).on('change', ...)` that calls a manager function (`setLightFrustumCullingEnabled` in `LightManager.ts`) to `addComponent`/`removeComponent` the ECS component, plus a LocalStorage save of the toggle state. A "Spatial Indexed" checkbox reuses this trio verbatim: proxy seeded from `world.hasComponent(entityId, ComponentType.SPATIAL_INDEXED)`, `on('change')` calling a new `setSpatialIndexed(entityId, value, world)` (mirroring `setLightFrustumCullingEnabled`'s shape), LS-persisted per entity like the other debug prefs in that file.

**Hiding the control for excluded entities:** this must be an *absent* control, not a disabled one — a visible-but-disabled checkbox implies the property exists and is merely locked, which is the wrong signal for an entity that structurally can't be indexed (no meaningful position). Light's GUI already solves exactly this shape of problem: `getLightCharacteristics(light)` (`src/_engine/utils/helpers.ts:515`) centralizes flags like `isAmbientLight`, and the GUI wraps each binding in `if (lightChars.xxx) { ... }`. Add a `canBeSpatiallyIndexed` (or reuse/extend the existing shape) flag there — false for `isAmbientLight`/hemisphere — and wrap the new checkbox in it, so it never renders for those two light kinds. This is also the natural home for the §3.1 tripwire check: since the same characteristics helper already knows "this light can't be indexed," the manager-level `addComponent(SPATIAL_INDEXED, ...)` guard and the GUI's visibility check can both read it, keeping the exclusion defined once.

Camera has no characteristics helper yet (`_dbg__CameraGUI.ts` — single camera type currently, per the research behind this plan), so gating the checkbox there means either adding a minimal equivalent or an inline conditional; since nothing about a camera currently disqualifies it from indexing, this is a smaller, deferrable piece — the checkbox can simply always show for cameras until a non-indexable camera kind exists.

---

## 10. Relationship to existing plans, and out of scope

`p081_light-object-culling.md` §2.3 deferred building a spatial index, calling it "the wrong order of operations" to build as a side effect of a culling nice-to-have and asking for it to be scoped as its own initiative — this document is that initiative. Once implemented, that plan's brute-force `buildFrustumVisibleMeshList` scan (§2.2/§3.3 there) becomes a radius query against this index.

`object3d-frustum-culling.md` doesn't propose a spatial index and doesn't need one for per-entity bounding-sphere-vs-frustum tests — out of scope here.

Also explicitly out of scope:

- **GPU-driven culling.** A compute pass over the position/radius buffers producing a visibility bitmask is the eventual endgame for frustum culling on a WebGPU engine, and the typed-array transform store already points that way. It is a different structure from this index (frustum culling is a plane-vs-bounds test, not a proximity query) and a separate initiative. Nothing here should block it; if anything, CSR + flat position arrays are the right precursor.
- **Raycasting against static/complex geometry** (terrain, level meshes) — a triangle-level BVH problem (`three-mesh-bvh`-style), not installed and not proposed. This index holds entity bounds for proximity queries, not triangle-accurate intersection.
- **Exposing Rapier's query pipeline** (`castShape`, `intersectionsWithShape`, `castRay`). Worth doing when NPC AI work starts, as a *complement*: the grid narrows candidates cheaply, then a handful of physics raycasts do exact line-of-sight against real level geometry. Separate, smaller piece of work; does not substitute for this index (§1).
- **NPC/AI system design itself.** No such system exists; this document only ensures the primitive it will depend on is designed with that consumer in mind rather than as a single-purpose culling helper.

---

## 11. Phases

Non-breaking, individually reviewable and committable.

**Phase 1 — core index, no consumer.**
`SpatialGrid` module with CSR storage, origin insert, query expansion by `maxIndexedRadius`, oversized list, both query API shapes, dedup stamps, `lastCell` tracking. Dynamic index only, rebuilt per frame. Unit-exercised via a scratch scene. Nothing else in the engine references it — fully additive.

**Phase 2 — ECS wiring.**
`SPATIAL_INDEXED` core component + `CoreComponentData` entry, membership hooks, `spatialIndex` opt in `CoreEntityOpts`, `MeshManager`/`LightManager` opting in their entities, debug tripwire (§3.1), rebuild system registered in `APP_POST_PHYSICS` ordered last. Index is populated and correct but still unqueried by production code.

**Phase 3 — first consumer + validation.**
Land `p081_light-object-culling.md` against the index, with the brute-force oracle (§9) running in debug builds and the occupancy histogram driving a first cell-size tuning pass. This is the phase that turns the guesses in §4 into measured numbers — hence the sequencing note below.

**Phase 4 — optimisation, only if measured.**
Any of: static/dynamic split (§5), AABB-overlap insert replacing query expansion (§4), incremental update off `Transform.version` (§6), separate domain grids (§5.1). Each is independently justifiable and independently deferrable. Do not pre-build them.

---

## 12. Files touched (if implemented)

- **New:** `src/_engine/core/Spatial/SpatialGrid.ts` — instantiable index; insert/remove/updateRadius/rebuild/query. Reads positions through the transform-store bulk-copy interface (§6).
- **New:** `src/_engine/core/Debug/_dbg__SpatialGrid.ts` — oracle toggle, occupancy histogram, live cell-size tuning.
- `src/_engine/core/ECS/ECSRegistry.ts` — add `SPATIAL_INDEXED` to `CoreComponentType`.
- `src/_engine/core/ECS/ECSCoreComponents.ts` — add its `CoreComponentData` entry (radius, domain, static flag).
- `src/_engine/schemas/_helperSchemas.ts` — `spatialIndex?: boolean` on `CoreEntityOpts`.
- `src/_engine/core/ECS/TypedArrayTransformStore.ts` (+ the object-backed store) — bulk position copy method.
- `src/_engine/core/MeshManager.ts`, `LightManager.ts` — opt entities in.
- `src/_engine/core/ECS.ts` — fix `removeComponent` hook ordering (§3.2), or document the workaround.
- `docs/plans/p081_light-object-culling.md` — revise §2.2/§2.3/§3.3 to depend on this primitive.

Registered as an ECS plugin via `ECSWorld.registerPlugin` / `registerComponentHooks`, matching the pattern other managers use. Kept engine-internal behind its first consumers; wired into `src/AppECSPlugins.ts` only when an app-level consumer needs direct access.

---

## 13. Recommendation

Build a **sparse, CSR-backed uniform grid over ECS `Transform` data** as a standalone, instantiable engine primitive — not physics-specific, not culling-specific — so it serves `p081_light-object-culling.md` first and NPC spatial-awareness queries later without redesign.

Do not build an octree or BVH for the dynamic set. Do not use Rapier's broadphase as the primary index — it covers only collider-bearing entities, which excludes exactly the lights and decorative meshes culling needs, and its bounds and timing are both wrong for rendering; treat exposing Rapier's query pipeline as separate, later, complementary work for NPC line-of-sight specifically.

Make membership **explicit and opt-in** (§3) rather than "everything with a `Transform`", handle **entity extent** rather than indexing bare origins (§4), and store cells in **persistent typed arrays** rather than per-cell JS arrays (§2.3). Those three are the corrections that keep the first version both correct and worth the effort.

**Sequencing:** build the index ahead of `p081`'s implementation — the brute-force approach there is explicitly bounded by total mesh count, and this removes that ceiling from day one rather than requiring a later rewrite. But land Phases 1–3 as one iteration rather than merging the index standalone. An index with no live consumer means guessing at cell size, extent distribution and query shape, which are exactly the parameters that matter most; landing with the consumer means the first tuning pass has real data and the brute-force oracle is available for free.
