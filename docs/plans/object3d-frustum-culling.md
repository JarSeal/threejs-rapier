Status: draft | feasibility study — not-implemented

# Generic Object3D Frustum Culling (ECS-Visible) — Feasibility Study + Plan

Generalizing `docs/plans/light-culling.md`'s mechanism (opt-in boolean + runtime tag + paired visibility hooks + bounding-volume-vs-frustum test) from "point/spot lights only" to **any entity with an `OBJECT3D` component** — meshes, groups, and beyond — with the same per-entity opt-in checkbox pattern.

---

## 1. The key distinction this plan has to make honestly

For **meshes**, Three.js already does per-object frustum culling for free, today, with zero engine code: `Object3D.frustumCulled` defaults to `true`, and the renderer's render-list build step tests each mesh's `geometry.boundingSphere` against the camera frustum before submitting a draw call. Confirmed by grep: the only place this flag is touched in the codebase is `PhysicsRapier.ts:1463` (`debugMesh.frustumCulled = false`, opting a physics-debug line mesh _out_ of that default behavior because it intentionally spans the whole world). **There is no rendering-cost gap to close for meshes** — building an ECS-level system that re-tests mesh bounding spheres against the frustum purely to decide whether to render them would duplicate work the renderer already does, for no additional GPU/draw-call savings.

So the real value of this plan isn't rendering performance — it's making "is this entity currently visible to the camera" a piece of **ECS-queryable state** that other systems can react to, which Three.js's internal render-list culling doesn't expose today. Concrete uses this would unlock, none of which exist in the engine yet but all of which are standard patterns in shipped games:

- Pausing/throttling AI decision-making or animation updates for off-screen characters.
- Skipping particle-emitter spawning or expensive shader-driven effects (e.g. `HoverEffect`/`FollowTool` in `src/toolkit/ecs/effects/`) for entities nobody can see.
- Muting or distance-culling audio sources tied to off-screen objects.
- Feeding a simple LOD switch (swap to a cheaper mesh/material) based on on/off-screen state, as a cruder alternative to distance-only LOD.

This reframing matters for scoping: **this plan is a gameplay/ECS convenience feature, not a rendering optimization**, and should be evaluated (and pitched to a future implementer) as such.

---

## 2. Is it feasible? Yes — it's the natural generalization of `light-culling.md`

### 2.1 What generalizes directly

- **Component/hook shape**: `light-culling.md` §4.1/§4.2's `FRUSTUM_CULLING_ENABLED` (opt-in boolean) + `TAG_FRUSTUM_CULLED` (runtime tag) + paired `onAddComponent`/`onRemoveComponent` hooks generalizes unchanged — nothing about that mechanism is light-specific. In fact, if this plan is approved, it should **reuse the exact same two component types** rather than defining light-specific ones, so a light and a mesh opting into culling go through one shared code path. (`light-culling.md` should be read as this plan's first concrete instance, not a separate parallel mechanism — see that plan's §10.)
- **Frustum construction**: identical (`light-culling.md` §3.3/§4.3 — camera lookup, `updateMatrixWorld()`, `Frustum.setFromProjectionMatrix`).
- **System registration**: same `APP_RENDER_SYNC` stage, same reasoning for running late in the frame.
- **Debug checkbox pattern**: same proxy-binding approach, just needs a home in whatever debug edit window exists for the entity type in question (see §4 — this is actually the biggest practical gap, not the culling logic itself).

### 2.2 What does not generalize directly — bounding-volume sourcing

`light-culling.md`'s bounding volumes are derived from light-specific properties (`distance`, `angle`) that only point/spot lights have. A generic Object3D has no such uniform source of "how big am I":

- **Mesh**: has `geometry.boundingSphere` — but it isn't guaranteed to be computed (Three.js computes it lazily, e.g. during raycasting, or when explicitly requested via `computeBoundingSphere()`; a freshly created `BufferGeometry` has `boundingSphere === null` until something asks for it). A generic system would need to call `computeBoundingSphere()` once at entity-creation/opt-in time if missing, then transform `{center, radius}` into world space (translate by world position, scale radius by the object's max scale-axis component — a `THREE.Object3D` can have non-uniform scale, so this is an approximation, not exact, for non-uniformly-scaled meshes).
- **Group**: has no geometry at all. Its "bounds" only make sense as the union of its children's bounds (recursive, and expensive to keep current if children move independently — this is `THREE.Box3.setFromObject()`'s job today, an O(all-descendant-vertices) operation, unsuitable to run every frame). Two honest options: (a) restrict this feature to leaf mesh entities only, requiring the app to opt in per-mesh rather than per-group; or (b) require an explicit, manually-authored bounding sphere override in `entityOpts` for group entities that want to opt in, computed once by the app author rather than derived automatically. Recommend (b) as the pragmatic default, with (a) as the simpler fallback if (b)'s authoring burden isn't worth it.
- **Camera/other Object3D subtypes**: don't have a meaningful "am I visible" concept in the first place (a camera doesn't need to know if it's in its own frustum) — this feature should only ever apply to entities tagged `TAG_IS_MESH` (and, per `light-culling.md`, `TAG_IS_POINT_LIGHT`/`TAG_IS_SPOT_LIGHT`), not blindly to every `OBJECT3D` entity.

So "generic" here means "the same mechanism, pluggable per entity-type via a small bounding-volume-provider abstraction" — not literally one-size-fits-all bounds logic.

### 2.3 Proposed abstraction

```ts
type BoundingVolumeProvider = (entityId: number, world: ECSWorld) => THREE.Sphere | undefined;

const boundingVolumeProviders: Partial<Record<ComponentType, BoundingVolumeProvider>> = {
  [ComponentType.TAG_IS_MESH]: getMeshWorldBoundingSphere,
  [ComponentType.TAG_IS_POINT_LIGHT]: getPointLightBoundingSphere, // from light-culling.md §3.1
  [ComponentType.TAG_IS_SPOT_LIGHT]: getSpotLightBoundingSphere, // from light-culling.md §3.2
};
```

The shared `frustumCullingSystem` iterates `world.getStorage(ComponentType.FRUSTUM_CULLING_ENABLED)` once (type-agnostic), looks up which tag the entity carries to pick the right provider, and applies the same `intersectsSphere` test and `TAG_FRUSTUM_CULLED` toggle regardless of entity type. This is a strict superset of `light-culling.md`'s system — implementing this plan, if done first or alongside, would let `light-culling.md` simply register two more provider entries instead of writing its own system function. Given the ordering the user asked for (light plan first, then study whether it generalizes), the pragmatic sequencing is: ship `light-culling.md`'s light-specific system now, and treat "extract it into this shared provider-keyed system, adding mesh support" as this plan's actual unit of work later — a refactor-plus-extension, not a from-scratch rebuild.

### 2.4 Data model

Since this spans multiple entity types with no single natural schema home (unlike lights, which all funnel through `LightProps`), the opt-in flag belongs on the **shared entity-creation options**, not a light/mesh-specific props type:

`src/_engine/schemas/_helperSchemas.ts`'s `CoreEntityOptsSchema` (referenced as `CoreEntityOpts` throughout `LightManager.ts`/`MeshManager.ts`/`CameraManager.ts` as the common `entityOpts` parameter) is the natural place: add `frustumCullingEnabled?: boolean` there once, and every `create*Entity` function (`createMeshEntity`, `createLightEntity`, future ones) that accepts `entityOpts` picks it up uniformly, calling the same `world.addComponent(entityId, ComponentType.FRUSTUM_CULLING_ENABLED, true)` when set — no per-manager duplication needed for the opt-in flag itself (only the bounding-volume provider differs per type, and that's keyed off the existing type tags, not off `entityOpts`).

For a group's manual bounding-sphere override (§2.2), a separate optional field would be needed, e.g. `entityOpts.cullingBoundingSphere?: { center: {x,y,z}; radius: number }`, consumed only by a group-specific provider.

### 2.5 Debug GUI — the actual friction point

Lights have exactly one edit window (`_dbg__LightGUI.ts`) all point/spot lights go through, making `light-culling.md` §6's single checkbox addition trivial. **Meshes do not have an equivalent debug edit window in this codebase today** — `MeshManager.ts` has no `_dbg__MeshGUI.ts` counterpart (confirmed: `src/_engine/core/Debug/` only has `Light/` and `Camera/` subfolders per the existing dual-layer debug pattern CLAUDE.md documents). Adding a mesh-entity edit window is out of scope for a culling feature — it's a much larger, separate piece of debug tooling. Until/unless one exists, a mesh-level "Frustum Culling" checkbox has nowhere to live in the debug drawer; this plan's mesh support would need either (a) an app/scene-JSON-only opt-in (`entityOpts.frustumCullingEnabled` authored directly in the mesh's `.mesh.json`, no debug-time toggle), or (b) building a minimal mesh debug panel first, which is a materially bigger undertaking than this plan's actual culling logic. Recommend (a) for a first cut, explicitly deferring (b).

---

## 3. Recommendation on scope and sequencing

This is feasible and architecturally clean, but it is **two separable pieces of work bundled under one name**:

1. **The mechanism generalization** (§2.3's provider abstraction) — small, a natural refactor once `light-culling.md` exists, low risk.
2. **Mesh-level debug/authoring support** (§2.5) — either trivial (JSON-only opt-in, no UI) or substantial (a new debug edit window), depending on whether debug-time toggling is required.

Given the reframing in §1 (this is a gameplay-state feature, not a rendering optimization, since Three.js already culls mesh rendering for free), the honest recommendation is: **build this only when a concrete gameplay system needs "is this entity on-screen" as ECS state** (an AI throttling system, an audio culling system, etc.) — building it speculatively ahead of such a consumer risks becoming unused engine surface area, which CLAUDE.md's "Treat [`_engine`] as stable/library code; changes here should be minimal and purposeful" guidance argues against. When that consumer exists, implement it as the §2.3 refactor of `light-culling.md`'s system plus JSON-only mesh opt-in (§2.5(a)), and treat the debug-panel UI as a follow-up only if hands-on debug-time toggling turns out to matter in practice.

---

## 4. Files touched (if implemented)

- `src/_engine/schemas/_helperSchemas.ts` — `frustumCullingEnabled?: boolean` (and optionally `cullingBoundingSphere`) added to `CoreEntityOptsSchema`.
- `src/_engine/core/ECS/LightFrustumCullingSystem.ts` (from `light-culling.md`) — refactored into a generic `FrustumCullingSystem.ts` keyed by the `boundingVolumeProviders` map (§2.3); light-specific math moves into two provider functions but is otherwise unchanged.
- `src/_engine/core/MeshManager.ts` — `createMeshEntity` reads `entityOpts.frustumCullingEnabled` and calls the same opt-in `addComponent` used by `createLightEntity`; a `getMeshWorldBoundingSphere` provider added (computing/caching `geometry.boundingSphere`, transforming to world space).
- No new debug GUI file, per §2.5(a) — deferred.

---

## 5. Risks and open questions

| Risk / question                       | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redundant-with-the-renderer confusion | Must be documented clearly (in code comments and any future docs) that this does **not** replace or improve on `Object3D.frustumCulled`'s rendering-time culling — it's parallel ECS-visible state for gameplay systems. Easy to misread as a performance feature otherwise.                                                                                                |
| Non-uniform scale approximation       | World-space bounding-sphere radius via "scale by max scale-axis component" over-estimates for non-uniformly-scaled meshes (a mesh stretched long on one axis gets a sphere sized to its longest axis in all directions). Acceptable conservative bound for a gameplay-state signal; not acceptable if ever repurposed for a tight rendering optimization.                   |
| Group/composite bounding volumes      | No good automatic answer (§2.2) — requires either restricting to leaf meshes or manual authoring. Whichever is chosen constrains which entities can realistically opt in.                                                                                                                                                                                                   |
| Mesh debug UI gap                     | A real, pre-existing gap in the engine (no mesh edit window at all), not something this plan should try to solve as a side effect. Keep scoped to JSON-authored opt-in until a mesh debug panel is separately justified.                                                                                                                                                    |
| Value without a concrete consumer     | The single biggest open question: is there an actual planned gameplay system (AI/audio/LOD) that would consume `TAG_FRUSTUM_CULLED` state for non-light entities? Without one, this plan has no forcing function and risks being built and never used — recommend treating it as blocked on that consumer existing, not as a standalone next step after `light-culling.md`. |

---

## 6. Relationship to the other two culling plans

- `docs/plans/light-culling.md` is this plan's first, narrower, already-justified instance (lights have an immediate real cost — shading — that this generalization's target entity types don't share, since mesh rendering is already culled by Three.js). Ship that first regardless of this plan's fate.
- `docs/plans/light-object-culling.md`'s `buildFrustumVisibleMeshList` (its §2.2, mitigation 1) independently needs "which meshes are currently in the camera frustum" — if this plan's mesh support is ever built, that list-building logic and this plan's mesh `TAG_FRUSTUM_CULLED` state are the same underlying computation and should be unified rather than duplicated.
