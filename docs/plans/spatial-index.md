Status: draft | research — not-implemented

# Spatial Index (Sparse Grid) — Research & Recommendation

A general-purpose "what's near this point/volume" primitive for the engine. Motivated by two consumers: near-term, unblocking `docs/plans/light-object-culling.md` §2.3 (which explicitly deferred building this); longer-term, NPC spatial-awareness queries ("what's near this entity") once AI/NPC systems exist. This document is research/recommendation only — no NPC system exists yet (confirmed by grep across `src/app`/`src/toolkit`), and this plan does not propose implementing the index itself, only the design it should follow when someone does.

---

## 1. What exists today

Confirmed via codebase research: **no spatial index exists anywhere in the engine** — no octree, BVH, grid, or spatial hash (same finding `light-object-culling.md` §2.1 already made). Two things that might look like candidates on the surface, and why neither is currently sufficient:

- **Rapier's internal broadphase** (`src/_engine/core/PhysicsRapier.ts`): Rapier maintains its own broadphase for collision detection, but (a) it's only reachable through CRUD + stepping today — no shape/point/ray query API (`castShape`, `intersectionsWithShape`, `castRay`, etc.) is exposed to app/toolkit code, and even the commented-out worker rewrite (`core/Physics/EngineRapier.ts` + `PhysicsAPITypes.ts`) only declares ray queries, not shape/point queries; (b) more fundamentally, it only knows about entities with colliders (`TAG_IS_PHYSICS_OBJECT`). Lights and purely decorative meshes — exactly what light-object-culling needs to query — commonly have no collider at all, so a Rapier-only solution can't cover them.
- **`THREE.BufferGeometry.boundingSphere`**: used per-object in a couple of places (`helpers.ts:285`, `PhysicsRapier.ts:1464-1469`), never aggregated into a queryable structure.

So there's genuinely nothing to extend here — this is a from-scratch design decision.

---

## 2. Structure: sparse spatial hash grid, not octree/BVH

**Recommendation: a sparse hash grid** — a hash map from integer cell coordinate (e.g. a packed `(cx, cy, cz)` key) to a list of entity IDs — rather than a dense 3D array, octree, or BVH.

### 2.1 Why not octree/BVH

Both structures earn their complexity when the thing they index is mostly static and query-heavy relative to update-heavy: static level geometry, precomputed occlusion volumes, ray-vs-triangle precision against complex meshes (that's `three-mesh-bvh`'s home turf, and not installed here — see §5). Neither consumer this document targets looks like that:

- Culling candidates (lights, meshes) can move every frame.
- NPC-awareness queries are, by definition, about moving entities tracking other moving entities.

A tree needs rebalancing or refitting as members move; a grid's per-entity cost is O(1) — recompute a cell key, remove from the old bucket, insert into the new one. Octree's real advantage (resolution adapting to non-uniform density) matters more when density is static and known ahead of time; here it isn't, and the added rebuild/rebalance complexity isn't justified for a first version. Worth revisiting only if profiling later exposes a concrete hot spot a uniform grid can't handle.

### 2.2 Why sparse, not a dense array

The world is expected to be large/open with density varying a lot by area. A dense 3D array needs fixed bounds and pre-allocates every cell, including empty ones — wasteful and awkward to resize for an open/streaming world. A hash map keyed by cell coordinate costs nothing for empty regions; the only real risk is an oversized bucket in an unusually dense cluster, which is a tuning problem (cell size), not a structural one.

### 2.3 Cell sizing

Start with a single fixed, tunable cell size, chosen around the typical query radius for the near-term consumer (light influence radius — matches `light-object-culling.md`'s own framing of "what's near this point"). Defer multi-resolution/hierarchical grids unless profiling shows a specific case a single resolution can't serve well (e.g. a mix of very-short-range and very-long-range queries against the same grid).

---

## 3. Data source and update strategy

Build the grid from ECS `Transform` position data, not a separate position cache. In particular, it should read the recently-added `TypedArrayTransformStore` (`src/_engine/core/ECS/TypedArrayTransformStore.ts`) where a world uses that storage mode — flat `posX/posY/posZ` arrays make cell-key computation cache-friendly and avoid per-entity object dereferencing, which fits the direction that store already points the engine in. This also keeps the grid entity-type-agnostic (it indexes whatever has a `Transform`, whether or not it also has a collider), which is the property Rapier's broadphase lacks (§1).

Update policy: start with rebuild-per-frame (simplest, easiest to reason about). If profiling shows this is too costly at the scale this engine targets (large/open world, thousands of dynamic entities), move to incremental updates keyed off `Transform`'s existing `version` dirty-flag counter — only re-bucket entities whose cell changed since the last frame.

Placement in the frame: populate/refresh the grid after `APP_POST_PHYSICS` (physics has written final transforms for the frame) and before `APP_RENDER_SYNC`/`APP_LOGIC` consume it, so culling and any future NPC/AI logic see one consistent snapshot per frame.

---

## 4. Relationship to existing plans

`light-object-culling.md` §2.3 explicitly deferred building a spatial index, calling it "the wrong order of operations" to build as a side effect of a culling nice-to-have, and asked for it to be "scoped and designed as its own initiative with its own consumers in mind" — this document is that initiative. Once an implementation exists, `light-object-culling.md`'s brute-force `buildFrustumVisibleMeshList` scan (§2.2/§3.3 there) should be replaced with a radius query against this grid — per that document's own §5 risk table, the system's external shape (`testLightAgainstMeshList` returning a boolean) doesn't need to change, only its internals.

`object3d-frustum-culling.md` doesn't propose a spatial index and doesn't need one for its per-entity bounding-sphere-vs-frustum tests — it stays out of scope for this document.

---

## 5. Explicitly out of scope here

- **Raycasting against static/complex geometry** (e.g. terrain, level meshes) is a different problem with a different natural fit (`three-mesh-bvh`-style triangle-level BVH). Not installed, not proposed here — the sparse grid this document recommends indexes entity origins/bounding volumes for proximity queries, not triangle-accurate intersection.
- **Exposing Rapier's query pipeline** (`castShape`, `intersectionsWithShape`, `castRay`) through `PhysicsRapier.ts`. Worth doing once NPC AI work starts, as a complement for precision line-of-sight/overlap checks against physics colliders specifically — but it's a separate, smaller piece of work from this grid, and doesn't substitute for it (§1).
- **NPC/AI system design itself.** No such system exists yet; this document only ensures the spatial primitive it will eventually depend on is designed with that consumer in mind, not built as a single-purpose culling helper.

---

## 6. Files touched (if implemented)

- New engine module, e.g. `src/_engine/core/SpatialGrid.ts` (or under `core/ECS/`) — insert/remove/update(entity moved cell)/query(point+radius or AABB) API, entity-ID-keyed, reading from `TypedArrayTransformStore` where available and falling back to Map-backed `Transform` otherwise.
- Registered as an ECS plugin via `ECSWorld.registerPlugin`/`registerComponentHooks`, matching the pattern other managers use; wired into `src/AppECSPlugins.ts` only if an app-level consumer needs direct access, otherwise kept engine-internal behind whatever system(s) query it first (light-object-culling being the first).
- `docs/plans/light-object-culling.md` — revise §2.2/§2.3/§3.3 to depend on this primitive instead of treating a spatial index as out-of-scope, once this is built.

---

## 7. Recommendation

Build a **sparse spatial hash grid over ECS `Transform` data** (§2–3) as a standalone engine primitive, not physics-specific and not culling-specific, so it can serve `light-object-culling.md` first and NPC spatial-awareness queries later without redesign. Do not build an octree or BVH for this — both fit static, query-heavy workloads better than this engine's moving-entity-heavy target use cases. Do not rely on Rapier's broadphase as the primary index — it only covers collider-bearing entities, which excludes exactly the lights/decorative meshes culling needs; treat exposing Rapier's query pipeline as a separate, later, complementary piece of work for NPC line-of-sight/overlap checks specifically.

Sequencing: this is worth building ahead of `light-object-culling.md`'s implementation (reversing that document's own deferral, now that it's been scoped as its own initiative per this document), since the brute-force approach there is explicitly bounded by total mesh count and this primitive removes that ceiling from day one rather than requiring a later rewrite.
