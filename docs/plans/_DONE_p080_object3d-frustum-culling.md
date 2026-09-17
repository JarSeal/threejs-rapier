Status: implemented
Category: Culling

# Generic Object3D Frustum Culling (ECS-Visible) — Feasibility Study + Plan

Generalized `docs/plans/_DONE_light-culling.md`'s mechanism (opt-in boolean + runtime tag + paired visibility hooks + bounding-volume-vs-frustum test) from "point/spot lights only" to **any entity with an `OBJECT3D` component** — meshes today, extensible to other kinds — with the same per-entity opt-in pattern, built without a config-schema debug checkbox (see §0).

---

## 0. Implementation summary (read this first)

This plan was originally written as a feasibility study, before `light-culling.md`, `light-object-culling.md`, and the spatial index had shipped. All three landed first (see §2 for how that changed the feasibility calculus), and the mechanism generalization itself has now also shipped — deliberately, without a named concrete gameplay consumer, overriding §3's own original recommendation to gate on one. That's an explicit decision, not an oversight: kept here for anyone reading this later and wondering why the "wait for a consumer" advice below wasn't followed.

**What shipped:**

- `src/_engine/core/ECS/LightFrustumCullingSystem.ts` was renamed to `ObjectFrustumCullingSystem.ts` and generalized per §2.3's provider abstraction: light-specific `computeIsVisible` became three `BoundingVolumeProvider`s (`getPointLightBoundingSphere`, `getSpotLightBoundingSphere`, `getMeshWorldBoundingSphere`), each returning a world-space `THREE.Sphere | undefined` (`undefined` means "always visible" — covers lights' infinite-range/degenerate-angle special cases). The system, renamed `objectFrustumCullingSystem`, iterates `FRUSTUM_CULLING_ENABLED` once and dispatches to whichever provider matches the entity's tag (`TAG_IS_POINT_LIGHT` / `TAG_IS_SPOT_LIGHT` / `TAG_IS_MESH`, checked in that order). Registration unchanged: `APP_RENDER_SYNC`, order `-1`.
- `getMeshWorldBoundingSphere` is exported and shared with `LightObjectCullingSystem.ts`'s `meshIsVisibleReceiver`, which previously duplicated the same bounding-sphere math inline — that duplication is gone, one implementation now.
- A generic `setFrustumCullingEnabled(entityId, enabled, world)` toggle lives in `ObjectFrustumCullingSystem.ts`. `LightManager.ts`'s `setLightFrustumCullingEnabled` (still the name `_dbg__LightGUI.ts`/`createLightEntity` call) is now a thin wrapper around it.
- `CoreEntityOptsSchema.ecsFrustumCullingEnabled?: boolean` (`_helperSchemas.ts`) is the mesh opt-in — off by default, deliberately named apart from the unrelated native `MeshProps.frustumCullingEnabled` (§0 below, next bullet). `MeshManager.ts`'s `createMeshEntity` calls `setFrustumCullingEnabled` when it's set.
- **Real gotcha hit and fixed during implementation, worth knowing about**: making `setLightFrustumCullingEnabled` a direct `const` alias (`export const setLightFrustumCullingEnabled = setFrustumCullingEnabled;`) introduced a 3-module circular import (`LightManager.ts` → `ObjectFrustumCullingSystem.ts` → `ECSCoreSystems.ts` → `LightManager.ts`, closing a loop that `ECSCoreSystems.ts`'s pre-existing `isAnyLightHelperVisible` import from `LightManager.ts` was already half of). That eager top-level read raced module-evaluation order and threw `ReferenceError: Cannot access 'setFrustumCullingEnabled' before initialization` in the browser — invisible to `tsc`/eslint/the IDE (pure type-level checks, no runtime evaluation-order analysis) and invisible to `yarn build` (Rollup's bundling order didn't happen to trigger it; only the dev server's real per-module ESM graph did). Fixed by making it a wrapper function instead, deferring the read to call time. If this mechanism is extended further and starts threading through more manager files, watch for the same pattern: an eager top-level `const` alias into a module that's part of a cycle is fragile in a way a lazy function wrapper isn't.
- Separately (and prior to the above): native `Object3D.frustumCulled` — Three's own free renderer-level culling (§1), **not** this ECS mechanism — is now authorable per-mesh via `MeshProps.frustumCullingEnabled` (`MeshManager.ts`, `meshSchema.ts`), default `true` matching Three's own default, wired through `ImportModel.ts`'s four `createMeshEntity` call sites and (for free, via schema composition) `ImportedMeshPropsSchema.meshProps`.

**Deliberately not built**, consistent with the plan's own original recommendations for these specific sub-parts (§2.2/§2.5, both below, left otherwise as originally reasoned):

- No group/composite bounding-volume support (`entityOpts.cullingBoundingSphere` override) — leaf-mesh-only opt-in, per §2.2's option (a).
- No mesh debug-window checkbox — no `_dbg__MeshGUI.ts` exists in the engine at all, so there's nowhere for one to live yet (§2.5, unchanged conclusion).

**Not yet exercised in any real scene.** Every scene in the app today either doesn't opt any mesh into `ecsFrustumCullingEnabled`, or doesn't yet exist — this mechanism has shipped but has zero live usage. `docs/plans/p090_large-ecs-test-world-scene.md` is the first plan to actually put it under load (§6).

---

## 1. The key distinction this plan has to make honestly

For **meshes**, Three.js already does per-object frustum culling for free, today, with zero engine code: `Object3D.frustumCulled` defaults to `true`, and the renderer's render-list build step tests each mesh's `geometry.boundingSphere` against the camera frustum before submitting a draw call. As of §0, this flag is authorable per-mesh via `MeshProps.frustumCullingEnabled` (defaulting to Three's own `true`) instead of only ever being flipped in code — but that's orthogonal to this plan's actual subject. **There is no rendering-cost gap to close for meshes** — an ECS-level system that re-tests mesh bounding spheres against the frustum purely to decide whether to render them would duplicate work the renderer already does, for no additional GPU/draw-call savings.

So the real value of this plan isn't rendering performance — it's making "is this entity currently visible to the camera" a piece of **ECS-queryable state** that other systems can react to, which Three.js's internal render-list culling doesn't expose. Concrete uses this unlocks, none of which exist in the engine yet but all of which are standard patterns in shipped games:

- Pausing/throttling AI decision-making or animation updates for off-screen characters.
- Skipping particle-emitter spawning or expensive shader-driven effects (e.g. `HoverEffect`/`FollowTool` in `src/toolkit/ecs/effects/`) for entities nobody can see.
- Muting or distance-culling audio sources tied to off-screen objects.
- Feeding a simple LOD switch (swap to a cheaper mesh/material) based on on/off-screen state, as a cruder alternative to distance-only LOD.

This reframing matters for scoping: **this is a gameplay/ECS convenience feature, not a rendering optimization**.

---

## 2. Is it feasible? Yes — it was the natural generalization of `light-culling.md`, and half the plumbing had already shipped generically

### 2.1 What generalized directly

- **Component/hook shape**: `light-culling.md` §4.1/§4.2's `FRUSTUM_CULLING_ENABLED` (opt-in boolean) + `TAG_FRUSTUM_CULLED` (runtime tag) + paired `onAddComponent`/`onRemoveComponent` hooks generalized unchanged — nothing about that mechanism was light-specific, and it had already shipped under generic names, already routed through the generic `reconcileObject3DVisibility`. A light and a mesh opting into culling go through one shared visibility-reconciliation code path (`ECSCoreSystems.ts`'s `reconcileObject3DVisibility`); the piece that generalized was the *system* deciding when to add/remove `TAG_FRUSTUM_CULLED` (now `ObjectFrustumCullingSystem.ts`, §0).
- **Frustum construction**: identical (`light-culling.md` §3.3/§4.3 — camera lookup via `getMainCamera()`, `updateMatrixWorld()`, `Frustum.setFromProjectionMatrix`), built once per frame and shared across every entity kind the system tests, not rebuilt per provider.
- **System registration**: same `APP_RENDER_SYNC` stage. `objectFrustumCullingSystem` runs at `order: -1`, `lightObjectCullingSystem` at `order: -2` (deliberately after, so it can skip meshes already known frustum-culled that frame) — unchanged ordering from before the rename.
- **Debug checkbox pattern**: same proxy-binding approach (§2.7 of `light-culling.md`) would apply if a mesh edit window ever exists — still the biggest practical gap, not the culling logic itself (§2.5).

### 2.2 What did not generalize directly — bounding-volume sourcing (the spatial index changed this)

A generic Object3D has no uniform source of "how big am I":

- **Mesh**: has `geometry.boundingSphere` — not guaranteed to be computed (Three.js computes it lazily). A generic provider needs to call `computeBoundingSphere()` once if missing, then transform `{center, radius}` into world space. This logic already existed, in `LightObjectCullingSystem.ts`'s `meshIsVisibleReceiver` — extracted as `getMeshWorldBoundingSphere` per §0, now the one shared implementation, not new math:

  ```ts
  const geometry = obj.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const localRadius = geometry.boundingSphere?.radius ?? 0;
  const maxScale = Math.max(Math.abs(obj.scale.x), Math.abs(obj.scale.y), Math.abs(obj.scale.z));
  obj.getWorldPosition(_meshBoundingSphere.center);
  _meshBoundingSphere.radius = localRadius * maxScale;
  ```

  Still an approximation, not exact, for non-uniformly-scaled meshes ("scale by max scale-axis component" over-estimates) — accepted tradeoff, same one `LightObjectCullingSystem.ts` already shipped with.

- **Group**: still has no geometry of its own. The recursive-bounds problem (`THREE.Box3.setFromObject()`, O(all-descendant-vertices)) is unsuitable to run every frame. The spatial index changed the calculus here: option (a) (restrict to leaf mesh entities) no longer means "no way to reason about a group's occupants at all" — every leaf mesh under a group is independently `SPATIAL_INDEXED` (opt-out, not opt-in) and independently queryable/testable. A "is this group currently on-screen" signal can reasonably be defined as "does any indexed descendant mesh currently carry `TAG_FRUSTUM_CULLED` == false," sidestepping the expensive-union problem rather than solving it. **This is what shipped** — leaf-mesh-only (option a), per §0. Option (b) (a manual bounding-sphere override in `entityOpts`, e.g. `cullingBoundingSphere?: { center; radius }`) was scoped but not built — nothing has needed it yet.
- **Camera/other Object3D subtypes**: don't have a meaningful "am I visible" concept, so this feature only ever applies to entities tagged `TAG_IS_MESH` (and, per `light-culling.md`, `TAG_IS_POINT_LIGHT`/`TAG_IS_SPOT_LIGHT`), never blindly to every `OBJECT3D` entity.

### 2.3 The provider abstraction (as shipped)

```ts
type BoundingVolumeProvider = (entityId: number, world: ECSWorld) => THREE.Sphere | undefined;

const boundingVolumeProviders: [ComponentType, BoundingVolumeProvider][] = [
  [ComponentType.TAG_IS_POINT_LIGHT, getPointLightBoundingSphere],
  [ComponentType.TAG_IS_SPOT_LIGHT, getSpotLightBoundingSphere],
  [ComponentType.TAG_IS_MESH, getMeshWorldBoundingSphere],
];
```

`objectFrustumCullingSystem` (`ObjectFrustumCullingSystem.ts`) iterates `world.getStorage(ComponentType.FRUSTUM_CULLING_ENABLED)` once (type-agnostic — this storage was already shared, not light-specific), checks each entity against the tuple list in order (first tag present wins), and applies the same `intersectsSphere` test and `TAG_FRUSTUM_CULLED` toggle regardless of entity type. An entity opted in but carrying none of these tags is simply skipped — matching §2.2's "only ever applies to a kind this system knows how to measure."

### 2.4 Data model (as shipped)

`src/_engine/schemas/_helperSchemas.ts`'s `CoreEntityOptsSchema` (already extended once for this same kind of cross-entity-type opt-in — its `spatialIndex?: boolean` field, added for `docs/plans/_DONE_p050_spatial-index.md`) gained `ecsFrustumCullingEnabled?: boolean` — name deliberately distinguished from `MeshProps.frustumCullingEnabled`, which means something different (the native render-time flag, not this ECS-state opt-in; §5's risk table flagged this exact naming collision ahead of time). `MeshManager.ts`'s `createMeshEntity` picks it up and calls the same `setFrustumCullingEnabled` used by lights.

A group's manual bounding-sphere override (§2.2's option b) was not built — only relevant if the "test descendant meshes individually" approach turns out not to cover a real use case.

### 2.5 Debug GUI — still the actual friction point

Lights have exactly one edit window (`_dbg__LightGUI.ts`) all point/spot lights go through, making `light-culling.md` §6's checkbox additions trivial (it has two — Frustum Culling and Object Culling). **Meshes still do not have an equivalent debug edit window in this codebase** — `src/_engine/core/Debug/` has `Light/`, `Camera/`, and `Spatial/`-adjacent tooling (`_dbg__SpatialGrid.ts`), but no `Mesh/` subfolder or `_dbg__MeshGUI.ts`. This blocks a checkbox for two features now, not one: this plan's `ecsFrustumCullingEnabled` and the native `MeshProps.frustumCullingEnabled` (§0). Both are JSON-authored only for now. Recommend continuing to defer building a mesh debug panel purely for this; build one when enough mesh-level debug affordances (these two, materials, shadow toggles, etc.) accumulate to justify it as its own piece of work.

---

## 3. Original recommendation on scope and sequencing (superseded — see §0)

This section is kept as written for the record; §0 documents what actually happened.

This was judged feasible and architecturally clean. The honest original recommendation was: **build the ECS-level mechanism only when a concrete gameplay system needs "is this entity on-screen" as ECS state** (an AI throttling system, an audio culling system, etc.) — building it speculatively ahead of such a consumer risks becoming unused engine surface area, per CLAUDE.md's "Treat [`_engine`] as stable/library code; changes here should be minimal and purposeful" guidance.

**What actually happened**: it was built anyway, as a deliberate, explicit call to proceed without a named consumer — not a rediscovery of a consumer that turned out to exist. §5's "value without a concrete consumer" risk is therefore live, not hypothetical, until something actually uses `TAG_FRUSTUM_CULLED` for a non-light entity. `docs/plans/p090_large-ecs-test-world-scene.md` gives it its first real exercise (load-testing the mechanism, not yet a gameplay consumer of the resulting state) — see §6.

---

## 4. Files touched (implemented)

- `src/_engine/schemas/_helperSchemas.ts` — `ecsFrustumCullingEnabled?: boolean` added to `CoreEntityOptsSchema`, alongside `spatialIndex`.
- `src/_engine/core/ECS/LightFrustumCullingSystem.ts` → renamed `ObjectFrustumCullingSystem.ts` and generalized: `boundingVolumeProviders` (§2.3), `getPointLightBoundingSphere`/`getSpotLightBoundingSphere`/`getMeshWorldBoundingSphere`, `objectFrustumCullingSystem` (renamed from `lightFrustumCullingSystem`), `setFrustumCullingEnabled` (new generic toggle). `MAX_SPOT_ANGLE` re-exported from the new path — `Spatial/SpatialIndexSystem.ts`'s import updated accordingly.
- `src/_engine/core/ECS/LightObjectCullingSystem.ts` — `meshIsVisibleReceiver` now calls the shared `getMeshWorldBoundingSphere` instead of duplicating the bounding-sphere math inline.
- `src/_engine/core/LightManager.ts` — `setLightFrustumCullingEnabled` is now a wrapper function delegating to `ObjectFrustumCullingSystem.ts`'s `setFrustumCullingEnabled` (see §0's circular-import note for why it's a wrapper and not a direct `const` alias).
- `src/_engine/core/MeshManager.ts` — `createMeshEntity` reads `entityOpts.ecsFrustumCullingEnabled` and calls `setFrustumCullingEnabled`.
- `src/_engine/InitApp.ts` — side-effect import path updated to `./core/ECS/ObjectFrustumCullingSystem`.
- Not touched: no new debug GUI file (§2.5, deliberately deferred); no group/composite bounding-volume override field (§2.2, deliberately deferred).

Separately, already covered before this mechanism work began: `MeshProps.frustumCullingEnabled` / `meshSchema.ts`'s matching field / `ImportModel.ts`'s four `createMeshEntity` call sites (§0) — the native-Three-flag half of "frustum culling for object3d," not the ECS mechanism this section covers.

---

## 5. Risks and open questions

| Risk / question | Notes |
| --- | --- |
| Redundant-with-the-renderer confusion | The ECS `TAG_FRUSTUM_CULLED` mechanism does **not** replace or improve on `Object3D.frustumCulled`'s rendering-time culling — it's parallel ECS-visible state for gameplay systems. Doubly important since §0 shipped a same-named-sounding but functionally different `MeshProps.frustumCullingEnabled` (the native flag) — the two are easy to conflate and are kept deliberately distinct in naming (§2.4). |
| Non-uniform scale approximation | World-space bounding-sphere radius via "scale by max scale-axis component" over-estimates for non-uniformly-scaled meshes. Inherited, accepted tradeoff from `LightObjectCullingSystem.ts`'s original implementation, now the one shared `getMeshWorldBoundingSphere`. |
| Group/composite bounding volumes | No free aggregate-bounds answer for a group as a single volume; shipped as leaf-mesh-only (§2.2 option a). A manual override (option b) remains unbuilt, add only if a real case needs it. |
| Mesh debug UI gap | A real, pre-existing gap in the engine (no mesh edit window at all). Now blocks two features (this opt-in and the native `MeshProps.frustumCullingEnabled`) instead of one — worth reconsidering the "defer indefinitely" stance once a second or third mesh-level debug need shows up. |
| Value without a concrete consumer | **Live risk, not hypothetical** — this was built without a named gameplay consumer (§3), overriding the plan's own original gating recommendation. `TAG_FRUSTUM_CULLED` on meshes has no reader anywhere in the engine yet (no AI throttling, audio culling, or LOD system exists). `docs/plans/p090_large-ecs-test-world-scene.md` exercises the mechanism under load but is not itself a consumer of the resulting state — the risk stays open until one exists. |
| Circular-import fragility | See §0's implementation note. A future extension of this mechanism to another manager file should use a function wrapper for any alias/re-export that crosses into `ObjectFrustumCullingSystem.ts` (or anything that transitively imports it), not a direct top-level `const` alias — the latter is only safe if you can prove there's no cycle, which is easy to get wrong as more files start depending on this module. |

---

## 6. Relationship to the other culling and spatial-index plans

- `docs/plans/_DONE_light-culling.md` (implemented) was this plan's first, narrower, already-justified instance — lights have an immediate real cost (shading) that mesh rendering, already culled by Three.js, doesn't share. Its component types (`FRUSTUM_CULLING_ENABLED`/`TAG_FRUSTUM_CULLED`) and its visibility-reconciliation helper (`reconcileObject3DVisibility`) were already generic; this plan's mechanism work was a refactor against that live reference implementation, not new design.
- `docs/plans/_DONE_p081_light-object-culling.md` (implemented) independently needed "which meshes are actually near/visible to a light," and was built directly against a spatial index rather than a brute-force mesh scan. Its `meshIsVisibleReceiver` (`LightObjectCullingSystem.ts`) computed exactly the mesh world-space bounding sphere this plan needed — now the shared `getMeshWorldBoundingSphere` (§2.2/§4).
- `docs/plans/_DONE_p050_spatial-index.md` (implemented) provides `SpatialGrid`/`SPATIAL_INDEXED` — the single biggest thing that changed this plan's feasibility since it was first written, removing "there's no queryable structure at all" as a blocker for group/composite handling (§2.2), even though group support itself wasn't built.
- `docs/plans/p090_large-ecs-test-world-scene.md` is where this mechanism gets its first real-world exercise — see that plan's scene composition/phases for meshes opted into `ecsFrustumCullingEnabled` and how it's measured via `?isDebug=true`. It is a load/scale test of the mechanism, not a gameplay consumer of `TAG_FRUSTUM_CULLED` — §5's "value without a concrete consumer" risk stays open regardless of that plan's outcome.
