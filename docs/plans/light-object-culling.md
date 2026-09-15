Status: draft | feasibility study — not-implemented

# Light "Object Culling" (Contribution Culling) — Feasibility Study + Plan

An extension beyond `docs/plans/light-culling.md`'s camera-frustum test: cull a point/spot light not just when its influence volume is outside the camera frustum, but also when its influence volume overlaps the frustum yet **nothing renderable actually sits inside it** — i.e. the light is technically "on screen" but illuminating empty space. Opt-in per light, independent of (and layered on top of) the frustum-culling opt-in.

---

## 1. What this is actually asking, precisely

`light-culling.md`'s frustum test answers "could this light possibly matter to what's on screen?" using only the light's own geometry (position + distance/angle) against the camera frustum. It is deliberately conservative — a light whose bounding sphere pokes into the frustum is kept visible even if that sliver of the sphere contains no geometry at all.

"Object culling for lights" asks a strictly harder question: "is there anything within this light's influence volume that could actually receive its light?" This catches cases the frustum test can't, e.g.:

- A point light placed inside a wall or far from any prop (illuminates nothing, ever, regardless of camera).
- A light whose volume is in-frustum, but every mesh near it also happens to be off-screen or itself culled.

This is sometimes called "contribution culling" or "light-object visibility culling" in graphics literature — distinct from (and easily confused with) **clustered/tiled light culling**, the common real-time-rendering technique for culling *lights per screen tile/object* in a forward+/deferred pipeline. That technique solves a different problem (which of many lights affect a given fragment/tile, computed on the GPU, at draw time) and isn't what's being asked here or what this document evaluates.

---

## 2. Is it possible? Yes. Is it cheap? Not without new infrastructure.

### 2.1 What exists to build on

Confirmed by grep across `src/_engine`/`src/toolkit`: **no spatial index exists anywhere in the engine** — no octree, BVH, grid, or spatial hash. `THREE.BufferGeometry.boundingSphere` is used in a few places (`helpers.ts:285`, `PhysicsRapier.ts:1464-1469`) but only ever per-object, never aggregated into a queryable structure. Rapier's physics world does maintain its own broad-phase internally for collision detection, but it only knows about entities with colliders (`ComponentType.COLLIDER`/`TAG_IS_PHYSICS_OBJECT`) — plenty of scenes will have purely decorative meshes with no physics body at all, which a Rapier-based query would silently miss.

So there is no existing "give me everything near this point" primitive to reuse. This plan has to either build one, or accept a brute-force cost model.

### 2.2 Brute-force cost model (no new spatial index)

The direct approach: once per frame, for each light with object-culling enabled, iterate every mesh entity (`world.getStorage(ComponentType.TAG_IS_MESH)`) and test its world-space bounding sphere against the light's influence volume (reusing `light-culling.md`'s sphere/cone math) **and** against the camera frustum (reusing that same plan's frustum). If at least one mesh passes both tests, the light stays visible; if none do, cull it.

Naively this is **O(lights_with_object_culling × total_meshes)** per frame. That's the actual cost to be honest about — for a scene with, say, 20 such lights and 5,000 meshes, that's up to 100,000 sphere-vs-sphere + sphere-vs-frustum tests per frame just for this feature. Two mitigations that don't require a full spatial index:

1. **Compute the frustum-visible mesh list once per frame, not once per light.** "Is this mesh in-frustum" doesn't depend on which light is asking. Build one array of `{ entityId, worldSphere }` for meshes currently intersecting the camera frustum (this is itself useful groundwork for `docs/plans/object3d-frustum-culling.md`), then each object-culling-enabled light only needs to test *that* (already frustum-filtered, presumably much smaller) list against its own volume. Cost becomes O(total_meshes) once + O(lights_with_object_culling × frustum_visible_mesh_count).
2. **Throttle, don't run every frame.** Whether a static light has anything nearby rarely changes frame-to-frame for typical scenes (props don't teleport constantly). Re-testing every 5-10 frames (or on a per-light staggered schedule) instead of every frame is a straightforward way to amortize the cost, at the price of a small reaction-time lag when something does change. Reasonable default for a first implementation.

Even with both mitigations, this remains fundamentally an O(n) or worse per-frame scan with no early-out better than "check everything relevant." It's a defensible, honest engineering tradeoff for an **opt-in, presumably-rare** feature (most lights won't need it), but it is categorically more expensive than `light-culling.md`'s O(opted-in lights) test, and its cost scales with total scene mesh count in a way the frustum-only plan does not.

### 2.3 What a "real" solution looks like (explicitly out of scope for now)

A proper implementation would maintain a spatial index (uniform grid keyed by world position is the simplest fit for "what's near this point," cheaper to build/update than an octree/BVH for a general moving-object scene) that all mesh entities are inserted into/removed from as they move, letting a light query "what's within radius R of point P" in roughly O(1) amortized instead of O(total_meshes). This is real, ongoing engine infrastructure — insertion/removal on every mesh move, cell-size tuning, and it's useful for far more than this one feature (AI proximity queries, audio occlusion, gameplay triggers). Building it **as a side effect of a light-culling nice-to-have** is the wrong order of operations; if a spatial index is ever justified, it should be scoped and designed as its own initiative with its own consumers in mind, not bolted on here. This plan explicitly does not propose building one.

### 2.4 Verdict

**Feasible, with an honest caveat**: only the brute-force (§2.2) approach is proposed here, it is opt-in per light (so scenes that don't use it pay nothing), and its cost is bounded by total mesh count, not lights — meaning it could become a real cost center in a mesh-heavy scene even with only one or two lights opted in. This plan should be built **after** `light-culling.md` ships, and only if there's a concrete scene that needs it (e.g. a level with many static point lights scattered through open/empty space, where camera-frustum-only culling leaves too many "on but illuminating nothing" lights active). It should not be treated as an automatic follow-up.

---

## 3. Proposed design (brute-force, opt-in)

### 3.1 Data model

Add a second, independent opt-in boolean, parallel to `frustumCullingEnabled` (`docs/plans/light-culling.md` §5.1), to `LightProps`'s `POINT`/`SPOT` variants and `lightSchema.ts`'s `Point`/`Spot`:

```ts
objectCullingEnabled?: boolean; // requires frustumCullingEnabled semantics for its volume math; independently toggleable
```

Deliberately a **separate flag**, not a mode of the frustum-culling flag — a light can have frustum culling on with object culling off (cheap, camera-only test) or both on (expensive but more aggressive). Enforce in the debug GUI that the "Object Culling" checkbox is only meaningful/enabled once the light also has frustum culling on... **actually, reconsider**: object culling could stand alone (test volume-vs-meshes without also testing volume-vs-camera-frustum) if the intent is "cull whenever nothing is near this light, regardless of camera" — that's a legitimate, slightly different feature (removes lights illuminating permanently-empty space even when the camera could theoretically frame that space) at the cost of never re-enabling them if a mesh is added/moved into range... which the throttled re-check (§2.2.2) already handles correctly since it's a continuous test, not a one-time bake. **Decision for this plan**: object culling is independent and composes with frustum culling via AND — a light is visible only if it passes *every* culling test it has opted into. This keeps each flag's meaning simple and matches "opt-in/opt-out independently" from the request.

### 3.2 Component/tag shape

Mirrors `light-culling.md` §4.1 exactly, with its own pair:

```ts
OBJECT_CULLING_ENABLED = 'CORE_OBJECT_CULLING_ENABLED', // opt-in
TAG_OBJECT_CULLED = 'CORE_TAG_OBJECT_CULLED',           // runtime state
```

Final visibility invariant becomes a three-way AND, extending `light-culling.md` §4.2's invariant:

```
Object3D.visible === !isDisabled(entityId)
                   && !hasComponent(entityId, TAG_FRUSTUM_CULLED)
                   && !hasComponent(entityId, TAG_OBJECT_CULLED)
```

Which means the `DISABLED` hook fix from `light-culling.md` §4.2 needs a second guard clause (`&& !world.hasComponent(entityId, ComponentType.TAG_OBJECT_CULLED)`), and `TAG_OBJECT_CULLED`'s own `onRemoveComponent` hook needs to check **both** `isDisabled` and `TAG_FRUSTUM_CULLED` before restoring `.visible = true` (and symmetrically for `TAG_FRUSTUM_CULLED`'s hook once this plan exists). This N-way visibility coordination is the main reason to build a small shared helper once two independent cull reasons exist — e.g. a single `reconcileLightVisibility(entityId, world)` function called from every hook, that recomputes the full AND and sets `.visible` once, rather than each hook trying to reason about every other flag pairwise. Flagged here as a required refactor at the point this plan is actually implemented, not before.

### 3.3 System

New system `lightObjectCullingSystem`, registered after `lightFrustumCullingSystem` in the same `APP_RENDER_SYNC` stage (order `-2`, so it runs after the frustum test has updated `TAG_FRUSTUM_CULLED` for this frame — object culling can reuse that result to skip its (more expensive) mesh scan entirely for lights already frustum-culled):

```ts
export const lightObjectCullingSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.OBJECT_CULLING_ENABLED);
  if (storage.size === 0) return;

  const visibleMeshes = buildFrustumVisibleMeshList(world); // §2.2 mitigation 1, computed once

  for (const [entityId] of storage) {
    if (world.isDisabled(entityId)) continue;
    // Already known to have nothing looking at it this frame — skip the mesh scan.
    if (world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)) continue;

    const hasNearbyVisibleMesh = testLightAgainstMeshList(entityId, world, visibleMeshes);
    const isCulled = world.hasComponent(entityId, ComponentType.TAG_OBJECT_CULLED);
    if (hasNearbyVisibleMesh && isCulled) {
      world.removeComponent(entityId, ComponentType.TAG_OBJECT_CULLED);
    } else if (!hasNearbyVisibleMesh && !isCulled) {
      world.addComponent(entityId, ComponentType.TAG_OBJECT_CULLED, true);
    }
  }
};
```

`buildFrustumVisibleMeshList` iterates `world.getStorage(ComponentType.TAG_IS_MESH)`, for each computes a world-space bounding sphere (mesh's `geometry.boundingSphere`, computed lazily via `computeBoundingSphere()` if absent, transformed by the mesh's world position + max-scale-component-scaled radius), tests against the same frustum `lightFrustumCullingSystem` already built this frame (needs that frustum exposed, e.g. via a shared module or by having this system rebuild its own — duplicating the ~10-line frustum construction is simpler and cheap enough to not need cross-module coupling). `testLightAgainstMeshList` reuses the light's own sphere/cone volume (from `light-culling.md` §3.1/§3.2) and checks for any list entry within range.

### 3.4 Debug GUI

Second checkbox in `_dbg__LightGUI.ts`, directly below the "Frustum Culling" one from `light-culling.md` §6, same proxy pattern, gated on the same `lightChars.supportsFrustumCulling` (point/spot only):

```ts
if (lightChars.supportsFrustumCulling) {
  const objCullProxy = { enabled: world.hasComponent(entityId, ComponentType.OBJECT_CULLING_ENABLED) };
  pane.addBinding(objCullProxy, 'enabled', { label: 'Object Culling' }).on('change', (ev) => {
    setLightObjectCullingEnabled(entityId, ev.value, world); // mirrors setLightFrustumCullingEnabled
    saveLightToLS(entityId, 'objectCullingEnabled', ev.value);
  });
}
```

---

## 4. Files touched (if implemented)

Additive to every file `light-culling.md` §7 already lists, plus:

- `src/_engine/core/ECS/LightObjectCullingSystem.ts` (new) — `OBJECT_CULLING_ENABLED`/`TAG_OBJECT_CULLED` hooks (or the shared `reconcileLightVisibility` refactor, §3.2), `buildFrustumVisibleMeshList`, `lightObjectCullingSystem`.
- `src/_engine/core/ECS/ECSCoreSystems.ts` — extend the `DISABLED` hook's guard to also check `TAG_OBJECT_CULLED` (or replace both this and `light-culling.md`'s guard with the shared reconciliation helper).
- Same `LightProps`/`lightSchema.ts`/`LightEntityDebugState`/`_dbg__LightGUI.ts` files as `light-culling.md`, with the second flag/checkbox added alongside the first.

---

## 5. Risks and open questions

| Risk / question | Notes |
| --- | --- |
| Cost scales with total mesh count, not light count | The core tradeoff of the brute-force approach (§2.2). Fine for an opt-in feature used sparingly; would need the spatial-index escalation (§2.3) if ever applied broadly across many lights in a mesh-heavy scene. Not solved here — explicitly deferred. |
| Groups/instanced meshes have no single meaningful bounding sphere | An `InstancedMesh` represents many instances at once; testing its aggregate bounding sphere against a light's small volume could produce false "something is near" positives for lights nowhere near any individual instance. Out of scope for a first pass — restrict `buildFrustumVisibleMeshList` to non-instanced `TAG_IS_MESH` entities initially, revisit if instanced-heavy scenes need this feature. |
| Reaction lag from throttling (§2.2.2) | A light re-enabled by a mesh moving into range won't visibly relight until the next throttled check — acceptable for ambient/decorative lights, possibly wrong for gameplay-critical lighting cues. Should be a per-light or global tunable check interval, not hardcoded, if built. |
| Three-way (or more) visibility coordination | Concretely motivates the `reconcileLightVisibility` shared-helper refactor (§3.2) at implementation time rather than continuing to add pairwise hook guards — flagged so it isn't skipped under time pressure. |
| Interaction with a future spatial index | If `docs/plans/object3d-frustum-culling.md` or some other initiative later adds a real spatial structure, `buildFrustumVisibleMeshList`'s brute-force scan should be swapped for a radius query against it — the system's external shape (`testLightAgainstMeshList` returning a boolean) doesn't need to change, only its internals. Worth keeping that boundary clean if this is built before a spatial index exists. |

---

## 6. Recommendation

Treat this as a **studied-but-not-scheduled** feature: the mechanism is sound and composes cleanly with `light-culling.md`, but it introduces a real, scene-size-dependent cost for a benefit (culling lights that illuminate empty space) that's likely to matter only in specific scene layouts. Build `light-culling.md` first, measure whether its frustum-only test already covers the practical cases that come up, and only pick this plan up if a concrete scene demonstrates the gap (many lights, sparse geometry, frustum test alone leaving too many "on but pointless" lights active).
