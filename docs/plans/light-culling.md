Status: draft | not-implemented

# Point/Spot Light Frustum Culling — Plan

Per-light, opt-in camera-frustum culling for `THREE.PointLight` and `THREE.SpotLight` entities: when a light's influence volume (a sphere for point lights, a cone for spot lights) doesn't intersect the active camera's view frustum, the light is set invisible; when it re-enters, it's made visible again. Exposed as a checkbox in the light entity's debug edit window.

Also covers two directly related findings/features that came out of implementing this correctly: (1) a verified fix for camera resolution so culling always tests against the real gameplay camera, never the debug fly-camera (§2.4); and (2) a debug-visualization feature so light symbols stay visible instead of disappearing — outline recolored orange (culled) or red (disabled, including directional lights), with the culled symbol additionally faded to half opacity — so every light can still be found and inspected while flying around with the debug camera (§10).

---

## 1. Goal

Three.js's renderer already frustum-culls **meshes** for free (`Object3D.frustumCulled`, default `true`, tested against `geometry.boundingSphere` at render-list build time). It does **not** do anything analogous for lights — every light in the scene graph is evaluated by the lighting/shading node graph every frame regardless of whether the camera can see it or anything it illuminates. A point light sitting far behind the camera, or a spotlight aimed entirely off-screen, still costs shading work every frame.

This plan adds an opt-in system that tests each point/spot light's bounding volume against the camera frustum once per frame and toggles the light's effective visibility accordingly — a cheap, purely CPU-side, per-light sphere/cone-vs-frustum test in exchange for skipping that light's GPU shading cost when it can't matter.

Scope, per the request: **point and spot lights only** (ambient/hemisphere have no spatial extent to test; directional lights are conceptually infinite/global and are out of scope here). Opt-in per light, defaulting to off, surfaced as a checkbox in the existing Tweakpane light edit window.

---

## 2. Current state (grounded in the actual code)

### 2.1 Light data model — no `visible`, no culling concept today

`LightProps` (`src/_engine/core/LightManager.ts:74-143`) is a discriminated union on `type`. The `POINT` variant (86-102) carries `color`, `intensity`, `distance`, `decay`, `position`, `castShadow` + shadow-tuning fields; the `SPOT` variant (121-142) additionally carries `angle`, `penumbra`, `targetPos`. Base props (74-76) are just `{ enabled?: boolean; appId?: string }`. There is **no `visible` field anywhere in the schema** — "visible" is a purely runtime concept.

`src/_engine/schemas/lightSchema.ts` mirrors this exactly: `LightBaseProps` (10-13) has only `enabled`/`appId`; `Point` (28-44) and `Spot` (64-84) mirror `LightProps`. `LightOverridesSchema` (90-99) spreads every variant's `.shape`, so any field added to `Point`/`Spot` here automatically becomes an authorable/overridable field with zero extra wiring, and flows through `yarn gatherAppData`'s Zod → JSON Schema generation for editor autocomplete on the asset JSON files.

### 2.2 How "enabled/disabled" works today (the pattern to extend, not duplicate)

`setLightEnabled` (`LightManager.ts:400-406`):

```ts
export const setLightEnabled = (lightId: number, enabled: boolean, world: ECSWorld) => {
  if (enabled) {
    world.removeComponent(lightId, ComponentType.DISABLED);
  } else {
    world.addComponent(lightId, ComponentType.DISABLED, true);
  }
};
```

`ComponentType.DISABLED` is a **generic, domain-agnostic tag** — the actual `.visible` mutation happens in one universal hook, not in `LightManager.ts`, so it works identically for meshes/lights/cameras (`src/_engine/core/ECS/ECSCoreSystems.ts:10-51`):

```ts
ECSWorld.registerComponentHooks(ComponentType.DISABLED, {
  onAddComponent: (entityId, world) => {
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (objComp) objComp.value.visible = false;
    if (IS_DEBUG_ENV) {
      const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
      if (helper) helper.value.visible = false;
    }
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink) world.addComponent(targetLink.targetId, ComponentType.DISABLED, true);
  },
  onRemoveComponent: (entityId, world) => {
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (objComp) objComp.value.visible = true;
    if (IS_DEBUG_ENV) {
      const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
      if (helper) helper.value.visible = isAnyLightHelperVisible();
    }
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink) world.removeComponent(targetLink.targetId, ComponentType.DISABLED);
  },
});
```

**This is the precedent this plan follows**: a boolean tag component + a pair of `onAddComponent`/`onRemoveComponent` hooks that flip `Object3D.visible`, not a bespoke per-domain visibility field. The important nuance (see §5) is that frustum culling must **not** simply reuse `DISABLED` itself — that component is already overloaded as the user-authored "this light is turned off" flag (`setLightEnabled`), and a per-frame camera-driven system stomping on it would incorrectly re-enable a light the user explicitly turned off the moment it re-enters frustum.

### 2.3 No existing frustum infrastructure anywhere

Confirmed by grep across `src/_engine` and `src/toolkit`: no `THREE.Frustum` is constructed anywhere in the engine, and no custom frustum-culling logic exists for meshes or lights. The only culling-adjacent code is `debugMesh.frustumCulled = false` in `PhysicsRapier.ts:1463` (opting *out* of Three's default per-mesh culling for physics debug lines, since they span the whole world). Nothing computes a bounding sphere/cone for a light today.

### 2.4 Camera access — `getActiveCamera()` is NOT safe to use here (verified)

`CameraManager.ts` caches the live camera as a module-level pointer whenever `setActiveCamera` runs (`activeCameraObject`, `CameraManager.ts:21,141`), exposed via `getActiveCamera(): THREE.Camera | undefined` (`CameraManager.ts:151`). At first glance this looks like the cheap, no-lookup way to grab "the camera to cull against" every frame — **it is not**, and this was verified directly rather than assumed:

**`getActiveCamera()` does return the debug camera while it's toggled on.** `toggleDebugCamera` (`src/_engine/core/Debug/Camera/_dbg__DebugCamera.ts:80-104`) is the function bound to the debug-drawer's fly-camera toggle, and it drives the same `setActiveCamera` used everywhere else:

```ts
export const toggleDebugCamera = (world, useDebug, setActiveCamera) => {
  const gameCam = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA).next().value;
  const debugCam = world.getEntitiesWith(ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA).next().value;
  if (useDebug && debugCam !== undefined) {
    world.setDisabled(debugCam, false);
    setActiveCamera(debugCam); // <-- activeCameraObject now points at the debug camera
  } else if (!useDebug) {
    if (debugCam !== undefined) world.setDisabled(debugCam, true);
    setActiveCamera(gameCam);
  }
  // ...
};
```

There is no separate "debug camera" return type or parallel accessor — `setActiveCamera(debugCam)` at line 95 mutates the exact same `activeCameraEntityId`/`activeCameraObject` module state that `getActiveCamera()`/`getCurrentCamera()` read. **This is by design, not a bug**: `MainLoop.ts`'s `renderScene()` (`MainLoop.ts:95-105`) renders through `getActiveCamera()` —

```ts
const renderScene = () => {
  const camera = getActiveCamera() as Camera;
  renderer.render(rootScene, camera);
};
```

— so `getActiveCamera()` returning the debug camera while it's active is *required* for the fly-camera feature to work at all (otherwise toggling it on would still render through the game camera). Changing what `getActiveCamera()` returns, or introducing a separate camera "type" that it never resolves to, would break rendering through the debug camera — **not** the right fix, and different from what this plan needs.

**What this plan actually needs**: a light-culling test that keeps testing against the real gameplay camera's frustum even while a developer is flying around with the debug camera, so that (a) toggling the debug camera on doesn't change which lights are culled from the player's actual point of view, and (b) the debug camera can be used to fly around and inspect every light's location/state (§10) without lights popping in and out based on the debug camera's own framing.

The correct primitive already exists and is already maintained independently of debug-camera toggling: `ComponentType.TAG_IS_MAIN_CAMERA`, set by `setMainCamera`/`setCurrentCamera` (`CameraManager.ts:270-293`). Confirmed by reading `toggleDebugCamera` end-to-end: it reads `TAG_IS_MAIN_CAMERA` to find `gameCam` but never adds/removes that tag itself — only `activeCameraEntityId`/`activeCameraObject` change when the debug camera is toggled. So `world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA).next().value` reliably names the real gameplay camera at all times, debug camera on or off. `setMainCamera` itself already accounts for the debug camera correctly too (`CameraManager.ts:270-279`):

```ts
export const setMainCamera = (world: ECSWorld, newMainId: number) => {
  const mainCams = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA);
  for (const oldId of mainCams) world.removeComponent(oldId, ComponentType.TAG_IS_MAIN_CAMERA);
  world.addComponent(newMainId, ComponentType.TAG_IS_MAIN_CAMERA, true);
  if (!isDebugCameraActive()) setActiveCamera(newMainId); // doesn't yank the view out from under a flying debug camera
};
```

**One real gap found, needs a small fix**: `createCameraEntity`'s fallback branch (`CameraManager.ts:111-115`) does *not* go through `setMainCamera`:

```ts
if (props.active) {
  setMainCamera(world, entityId);
} else if (activeCameraEntityId === null) {
  setActiveCamera(entityId); // <-- bypasses setMainCamera, so TAG_IS_MAIN_CAMERA is never set here
}
```

If a scene's designated camera is created without an explicit `active: true` (relying instead on simply being the first camera created, so `activeCameraEntityId === null` at that point), it becomes the active camera via `setActiveCamera` directly but is **never tagged `TAG_IS_MAIN_CAMERA`** — so a `TAG_IS_MAIN_CAMERA`-based lookup would find nothing for that scene. **Required fix**: change that branch to call `setMainCamera(world, entityId)` instead of `setActiveCamera(entityId)` directly. This is behavior-preserving (`setMainCamera` calls `setActiveCamera` internally whenever the debug camera isn't active, which is always true this early — `isDebugCameraActive()` returns `false` whenever `activeCameraEntityId === null`, `CameraManager.ts:377-380`) and additionally makes `TAG_IS_MAIN_CAMERA` reliably present the moment any camera exists.

**New helper needed**: no existing function returns the main camera's actual `THREE.Camera` object — `getMainAppCameraId()` (`CameraManager.ts:247-255`) only returns its `appId` string. Add:

```ts
export const getMainCamera = (): THREE.Camera | undefined => {
  const world = getECSWorld();
  const mainCamId = world.getEntitiesWith(ComponentType.TAG_IS_MAIN_CAMERA).next().value;
  if (mainCamId === undefined) return undefined;
  return world.getComponent(mainCamId, ComponentType.OBJECT3D)?.value as THREE.Camera | undefined;
};
```

The light-culling system (§4.3) must call **`getMainCamera()`, not `getActiveCamera()`** — this is the actual fix this investigation produces. §10 covers the companion debug-visualization feature this unlocks (light symbols that stay visible and are tinted, rather than vanishing, while flying the debug camera around a culled or disabled light).

### 2.5 System stage timing

`ECSSystemStage` (`src/AppECSRegistry.ts:39-51`): `MAIN → APP_PRE_PHYSICS → APP_POST_PHYSICS → APP_LOGIC → APP_RENDER_SYNC → LATE_MAIN`. `MainLoop.ts` calls `ecsWorld.updateAppLoop(deltaApp)` (which runs `APP_POST_PHYSICS → APP_LOGIC → APP_RENDER_SYNC`), then `renderScene()`, then `ecsWorld.updateLateMainLoop(delta)` (`MainLoop.ts:150,172-174` — this shape repeats at 194/207/217/219 and 249/264/276/278 for the fixed-timestep/interpolated loop variants). So **`APP_RENDER_SYNC` is the last ECS stage before the renderer draws** — the correct hook point for a culling system, so its result is applied before that frame's render call.

`ECSWorld.addSystem(stage, id, fn, order = 0)` (`ECS.ts:161-167`) sorts by `order` descending, ties broken by registration sequence — **higher `order` runs earlier** within a stage. Existing registrations in `ECSCoreSystems.ts:102-120` (all default `order = 0`):

```ts
ECSWorld.registerPlugin((world) => {
  world.addSystem(ECSSystemStage.MAIN, 'object3DSyncSystem', object3DSyncSystem);
  world.addSystem(ECSSystemStage.LATE_MAIN, 'entityLifetimeSystem', entityLifetimeSystem);
  world.addSystem(ECSSystemStage.APP_RENDER_SYNC, 'lookAtSystem', lookAtSystem);
  world.addSystem(ECSSystemStage.APP_POST_PHYSICS, 'physicsToTransformSystem', physicsToTransformSystem);
  return world;
});
```

`lookAtSystem` (also `APP_RENDER_SYNC`, default order 0) is what rotates a light with a `TARGET_LINK` to face its target each frame. This plan's system doesn't strictly depend on that rotation (see §4.2 — the cone axis is computed directly from target/light world positions, not from the light's quaternion), but registering with `order: -1` (runs after order-0 systems in the same stage) costs nothing and keeps the ordering intuitively "after everything else that moves things this frame."

### 2.6 Tag derivation for point/spot lights

`OBJECT3D_TAGS` (`ECSCoreComponents.ts:77-95`) auto-derives `TAG_IS_POINT_LIGHT`/`TAG_IS_SPOT_LIGHT` etc. from `Object3D` boolean flags (`isPointLight`, `isSpotLight`) whenever `ComponentType.OBJECT3D` is added (hook in `ECSCoreSystems.ts:54-70`). Not strictly needed by this plan (see §5 — iteration is driven by the new opt-in component instead), but confirms the type-narrowing primitive already exists if needed.

### 2.7 Debug edit window — the checkbox precedent to copy

`src/_engine/core/Debug/Light/_dbg__LightGUI.ts` is the Tweakpane-based light edit window (opened per-entity, `EDIT_LIGHT_WIN_ID`). Two existing checkboxes show the two wiring patterns available:

**(a) Binding directly to a native Three.js property** — the "Enabled" checkbox (222-226):

```ts
pane.addBinding(light, 'visible', { label: 'Enabled' }).on('change', (e) => {
  const value = e.value;
  setLightEnabled(entityId, value, world);
  saveLightToLS(entityId, 'enabled', value);
});
```

and "Cast Shadow" (356-361), which also demonstrates a `disabled`-when-not-castingShadow-yet reconciliation call:

```ts
pane.addBinding(light, 'castShadow', { label: 'Cast Shadow' }).on('change', (ev) => {
  reconcileDebugVisuals(entityId, world);
  setTimeout(() => updateDraggableWindow(EDIT_LIGHT_WIN_ID), 0);
  saveLightToLS(entityId, 'castShadow', ev.value);
});
```

**(b) Binding to a plain proxy object**, for state that isn't a native property on the `THREE.Light` instance — e.g. the helper-visibility toggle (228-238):

```ts
const helperProxy = { visible: prefs.helper };
pane.addBinding(helperProxy, 'visible', { label: 'Show Helper' }).on('change', (e) => {
  const show = e.value;
  saveLightToLS(entityId, 'helperVisible', show);
  setLightDebugPreference(entityId, world, 'helperVisible', show);
  updateOnScreenTools('SWITCH');
});
```

Since "frustum culling enabled" is ECS-only state (not a `THREE.Light` property), it needs pattern **(b)**.

Gating on light type uses `getLightCharacteristics(light)` (`src/_engine/utils/helpers.ts:515-555`), which returns booleans like `hasDistance`/`hasDecay` keyed off `light.type`, already used to conditionally render the Distance/Decay bindings (`_dbg__LightGUI.ts:296-310`):

```ts
if (lightChars.hasDistance) {
  const l = light as THREE.PointLight | THREE.SpotLight;
  pane.addBinding(l, 'distance', { label: 'Distance', min: 0, step: 0.01 })
    .on('change', (ev) => saveLightToLS(entityId, 'distance', ev.value));
}
```

`hasDistance` is already exactly "is point or spot" (`helpers.ts:542-544`: `if (c.isPointLight || c.isSpotLight) c.hasPosition = true;` plus the distance-specific check further down) — this plan adds a same-shaped `supportsFrustumCulling` flag to `getLightCharacteristics`'s return object.

### 2.8 Debug-state persistence (local, session-only — not the authored JSON)

`LightEntityDebugState` (`_dbg__LightGUI.ts:25-50`) is a per-scene, per-light-appId record persisted to `localStorage` under `AEK_debugLights` (`LS_LIGHTS_KEY`, line 64), purely for restoring the debug pane's UI state across reloads while `IS_DEBUG_ENV`. `saveLightToLS<K extends keyof LightEntityDebugState>(entityId, key, value)` (794-815) writes one field; `loadLightDebugData(appId)` (774-788) reads the whole per-light record back when the pane is rebuilt. This is separate from the authored scene JSON / `LightOverridesSchema` — adding a field here only affects the debug pane's own state restoration, not the saved asset data (that's §2.1/§6).

---

## 3. Bounding-volume math

### 3.1 Point light → sphere (exact)

A point light's influence is exactly a sphere: `center = light world position`, `radius = light.distance`. `THREE.PointLight.distance` is already the authoritative cutoff Three.js itself uses for attenuation (passed straight into the `THREE.PointLight` constructor in `LightManager.ts:172`). **Special case**: Three.js convention is `distance === 0` means "never attenuate / infinite range" — such a light can't be usefully culled by a finite sphere test, so it should be treated as **always visible** (skip the test, never add `TAG_FRUSTUM_CULLED`).

### 3.2 Spot light → cone, approximated as a sphere (conservative)

A spot light's influence is a right circular cone: apex at the light's world position, axis pointing from light → target, height `h = light.distance`, half-angle `light.angle`. Exact cone-vs-frustum intersection is nontrivial (6-plane vs. cone); the pragmatic, cheap, and still-correct-in-the-conservative-sense approach is a **bounding sphere centered at the apex**:

```
radius = distance / cos(angle)
```

Derivation: every point on the cone's lateral surface at axial distance `u` from the apex (0 ≤ u ≤ h) lies at Euclidean distance `u / cos(angle)` from the apex; this is maximized at `u = h`, i.e. at the rim of the far cap. Every point in the solid interior of the cone at a given axial position is strictly closer to the apex than the surface point at that same position, so `distance / cos(angle)` is a valid (if not perfectly tight for wide angles) enclosing radius for the entire volume, centered exactly at the light's own position — no extra "cone center" computation needed.

- Same `distance === 0` → infinite range → always-visible special case as §3.1.
- **Degenerate-angle guard**: as `angle → 90°`, `cos(angle) → 0` and the radius blows up toward infinity — meaningless as a culling test. Three.js clamps `SpotLight.angle` to `< Math.PI / 2` internally, but as a defensive measure, treat any `angle` above a safety threshold (e.g. `> 89.9°` in degrees) the same as the infinite-range case: skip the test, always visible.
- This intentionally over-culls conservatively for wide-angle spotlights (a large sphere around a possibly-narrow cone) rather than under-culling — i.e., it will sometimes fail to cull a spotlight whose actual cone doesn't touch the frustum but whose bounding sphere does, but it will never incorrectly hide a spotlight that should be visible. A tighter cone-vs-frustum test is a valid future refinement (§9 open questions), not required for v1.

### 3.3 World position, without a full scene-graph update

`createLightEntity` adds both the light and its target directly to the root scene (`LightManager.ts:292,317`: `rootScene.add(targetObj)` / `rootScene.add(light)`), so for the common case `light.position`/`target.position` already **are** world-space coordinates — no `updateMatrixWorld()` needed. For robustness against a future/custom case where a light or its target is nested under a transformed parent group, call the cheap, single-object `light.updateWorldMatrix(true, false)` / `target.updateWorldMatrix(true, false)` (walks up ancestors only, not a scene-wide traversal) before reading `getWorldPosition()`, rather than a full `scene.updateMatrixWorld()`.

Similarly, the camera's own `matrixWorldInverse` needs to be current for this frame before building the frustum; since this system runs in `APP_RENDER_SYNC` — before `renderScene()`'s internal `camera.updateMatrixWorld()` — call `camera.updateMatrixWorld()` explicitly, once per frame (not per light), immediately before building the frustum.

---

## 4. Architecture

### 4.1 New component types

Add to `CoreComponentType` (`src/_engine/core/ECS/ECSRegistry.ts`), following the existing `CORE_*` naming convention:

```ts
FRUSTUM_CULLING_ENABLED = 'CORE_FRUSTUM_CULLING_ENABLED', // opt-in, user-authored
TAG_FRUSTUM_CULLED = 'CORE_TAG_FRUSTUM_CULLED',           // runtime-only, current culled state
```

And their data shapes in `CoreComponentData` (`ECSCoreComponents.ts:18-66`), both plain `boolean` (presence-as-true, mirroring `DISABLED`/`PERSISTENT`):

```ts
[CoreType.FRUSTUM_CULLING_ENABLED]: boolean;
[CoreType.TAG_FRUSTUM_CULLED]: boolean;
```

**Two separate components, not one**, and deliberately **not** a reuse of `DISABLED` — see §2.2's warning. `FRUSTUM_CULLING_ENABLED` is the opt-in flag set once at entity creation / toggled from the debug checkbox; `TAG_FRUSTUM_CULLED` is the fast-changing, camera-dependent runtime state the culling system flips every frame. Keeping them distinct means:

- The culling system only needs to iterate entities that opted in (`world.getStorage(FRUSTUM_CULLING_ENABLED)`), not every light.
- Toggling the opt-in flag off cleanly removes any current cull state (§4.4) without touching user-authored `DISABLED`.
- `DISABLED` keeps meaning exactly one thing: "the user/game logic turned this light off," never conflated with "the camera currently can't see it."

### 4.2 Component hooks — separate from, and coordinated with, `DISABLED`

New hook, in the same universal style as `ECSCoreSystems.ts`'s `DISABLED` hook, but **deliberately not touching `DEBUG_LIGHT_HELPER`** — the debug gizmo should stay visible per its own `helperVisible` preference even while the light itself is momentarily culled, so a developer can still see where every light is placed while moving the camera around:

```ts
ECSWorld.registerComponentHooks(ComponentType.TAG_FRUSTUM_CULLED, {
  onAddComponent: (entityId, world) => {
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (objComp) objComp.value.visible = false;
  },
  onRemoveComponent: (entityId, world) => {
    // Respect an explicit user-authored "off" — don't let re-entering the
    // frustum resurrect a light the user (or game logic) deliberately disabled.
    if (world.isDisabled(entityId)) return;
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (objComp) objComp.value.visible = true;
  },
});
```

**Required companion change to the existing `DISABLED` hook** (`ECSCoreSystems.ts:31-34`) — this is the one piece of *existing* shared code this plan must modify, and it's a genuine latent bug this feature would otherwise introduce: today, `DISABLED`'s `onRemoveComponent` unconditionally sets `.visible = true`. If a light is simultaneously frustum-culled and then the user calls `setLightEnabled(id, true, world)` (removing `DISABLED`) while the light is *still* out of frustum, this would incorrectly force it visible, fighting with the culling system's own state. Fix:

```ts
onRemoveComponent: (entityId, world) => {
  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (objComp && !world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)) {
    objComp.value.visible = true;
  }
  // ...helper/target-link logic unchanged
},
```

This makes the final visibility invariant explicit and symmetric: **`Object3D.visible === !isDisabled(entityId) && !hasComponent(entityId, TAG_FRUSTUM_CULLED)`**, maintained by two independent hooks that each only ever set `.visible = true` after checking the other's state.

### 4.3 The system

New file `src/_engine/core/ECS/LightFrustumCullingSystem.ts` (self-registering plugin, mirroring `ECSCoreSystems.ts`'s own top-level `ECSWorld.registerPlugin(...)` call so it wires up purely via import — see §6):

```ts
const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _targetPos = new THREE.Vector3();

export const lightFrustumCullingSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.FRUSTUM_CULLING_ENABLED);
  if (storage.size === 0) return; // nothing opted in — skip the frustum build entirely

  // Deliberately getMainCamera(), not getActiveCamera() — the latter becomes the
  // debug fly-camera while it's toggled on (§2.4), which must not change which
  // lights are culled from the actual gameplay camera's point of view.
  const camera = getMainCamera();
  if (!camera) return;

  camera.updateMatrixWorld();
  _frustum.setFromProjectionMatrix(
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  );

  for (const [entityId] of storage) {
    if (world.isDisabled(entityId)) continue; // already invisible; don't fight over .visible

    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (!objComp) continue;
    const light = objComp.value as THREE.PointLight | THREE.SpotLight;

    light.updateWorldMatrix(true, false);
    const isVisible = computeIsVisible(entityId, light, world); // §3.1/§3.2, returns true for the infinite-range/degenerate-angle cases

    const isCulled = world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED);
    if (isVisible && isCulled) {
      world.removeComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED);
    } else if (!isVisible && !isCulled) {
      world.addComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED, true);
    }
  }
};
```

`computeIsVisible` branches on `light instanceof THREE.PointLight` vs `THREE.SpotLight` to build `_sphere` per §3.1/§3.2 (point: `light.getWorldPosition(_sphere.center)`, `_sphere.radius = light.distance`; spot: same center, radius via the `distance / cos(angle)` formula, target position read via `getLightTargetId(entityId, world)` + the target's `OBJECT3D` component), then `_frustum.intersectsSphere(_sphere)`.

Registration (`order: -1`, per §2.5):

```ts
ECSWorld.registerPlugin((world) => {
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'lightFrustumCullingSystem',
    lightFrustumCullingSystem,
    -1
  );
  return world;
});
```

### 4.4 `setLightFrustumCullingEnabled` — the opt-in toggle, mirroring `setLightShadowEnabled`

New exported helper in `LightManager.ts`, alongside `setLightEnabled`/`setLightShadowEnabled` (391-406):

```ts
export const setLightFrustumCullingEnabled = (lightId: number, enabled: boolean, world: ECSWorld) => {
  if (enabled) {
    world.addComponent(lightId, ComponentType.FRUSTUM_CULLING_ENABLED, true);
  } else {
    world.removeComponent(lightId, ComponentType.FRUSTUM_CULLING_ENABLED);
    // Opting out must also clear any current culled state — otherwise a light
    // that was invisible when culling was turned off would stay invisible forever.
    if (world.hasComponent(lightId, ComponentType.TAG_FRUSTUM_CULLED)) {
      world.removeComponent(lightId, ComponentType.TAG_FRUSTUM_CULLED);
    }
  }
};
```

`createLightEntity` (`LightManager.ts:145-330`) calls this once at creation time when `props.frustumCullingEnabled` is set (only reachable for `POINT`/`SPOT`, mirroring the existing `if (props.enabled === false) setLightEnabled(...)` call at line 321-323).

---

## 5. Data model changes

### 5.1 `LightProps` (`LightManager.ts:86-102, 121-142`)

Add `frustumCullingEnabled?: boolean` to the `POINT` and `SPOT` variants only — **not** to `AMBIENT`/`HEMISPHERE`/`DIRECTIONAL`, matching the "point and spot lights only" scope. Defaults to `false`/unset (opt-in, no behavior change for existing scenes).

### 5.2 `lightSchema.ts` (Zod)

Same addition to `Point` (28-44) and `Spot` (64-84): `frustumCullingEnabled: z.boolean().optional()`. Because `LightOverridesSchema` (90-99) already spreads `Point.shape`/`Spot.shape`, this is authorable/overridable in scene JSON and flows through `yarn gatherAppData`'s JSON-Schema generation for editor autocomplete with no further changes — a direct benefit of the existing schema architecture (§2.1).

### 5.3 `getLightCharacteristics` (`src/_engine/utils/helpers.ts:515-555`)

Add `supportsFrustumCulling: false` to the returned object's initial shape, then `c.supportsFrustumCulling = c.isPointLight || c.isSpotLight;` alongside the existing `hasDistance` derivation — this is the gate the debug checkbox uses (§6).

### 5.4 `LightEntityDebugState` (`_dbg__LightGUI.ts:25-50`)

Add `frustumCullingEnabled?: boolean;` — same generic `saveLightToLS`/`loadLightDebugData` machinery (§2.8) picks it up with no further changes since both are typed generically over `keyof LightEntityDebugState`.

---

## 6. Debug edit-window checkbox

In `_dbg__LightGUI.ts`, immediately after the existing Distance/Decay bindings (296-310, which already gate on `lightChars.hasDistance`/`hasDecay` — same point/spot-only scope), add:

```ts
if (lightChars.supportsFrustumCulling) {
  const cullProxy = { enabled: world.hasComponent(entityId, ComponentType.FRUSTUM_CULLING_ENABLED) };
  pane.addBinding(cullProxy, 'enabled', { label: 'Frustum Culling' }).on('change', (ev) => {
    setLightFrustumCullingEnabled(entityId, ev.value, world);
    saveLightToLS(entityId, 'frustumCullingEnabled', ev.value);
  });
}
```

This uses the proxy pattern (§2.7(b)), not a direct binding, since "frustum culling enabled" is ECS-only state with no corresponding `THREE.Light` property — same shape as the existing `helperProxy` binding at lines 231-238. `setLightFrustumCullingEnabled` needs to be imported from `LightManager.ts` alongside the existing `setLightEnabled` import (line 15).

No changes needed to `loadLightDebugData`'s call site (197) or `saveLightToLS`'s generic signature (794-815) — both already handle arbitrary `LightEntityDebugState` keys.

---

## 7. Files touched

- `src/_engine/core/ECS/ECSRegistry.ts` — add `FRUSTUM_CULLING_ENABLED`/`TAG_FRUSTUM_CULLED` to `CoreComponentType`.
- `src/_engine/core/ECS/ECSCoreComponents.ts` — add both to `CoreComponentData`.
- `src/_engine/core/ECS/ECSCoreSystems.ts` — **modify** the existing `DISABLED` hook's `onRemoveComponent` to check `TAG_FRUSTUM_CULLED` before setting `.visible = true` (§4.2, required companion fix).
- `src/_engine/core/ECS/LightFrustumCullingSystem.ts` (new) — the `TAG_FRUSTUM_CULLED` hooks, `lightFrustumCullingSystem`, bounding-volume math, plugin registration.
- `src/_engine/InitApp.ts` — add `import './core/ECS/LightFrustumCullingSystem';` alongside the existing `import './core/ECS/ECSCoreSystems';` (line 18), so the system self-registers on boot exactly like the core systems do.
- `src/_engine/core/LightManager.ts` — add `frustumCullingEnabled?: boolean` to `LightProps`'s `POINT`/`SPOT` variants; add `setLightFrustumCullingEnabled`; call it from `createLightEntity` when the prop is set.
- `src/_engine/schemas/lightSchema.ts` — add `frustumCullingEnabled: z.boolean().optional()` to `Point`/`Spot`.
- `src/_engine/utils/helpers.ts` — add `supportsFrustumCulling` to `getLightCharacteristics`.
- `src/_engine/core/Debug/Light/_dbg__LightGUI.ts` — add `frustumCullingEnabled?: boolean` to `LightEntityDebugState`; add the checkbox binding; import `setLightFrustumCullingEnabled`.
- `.schemas/light.schema.json` (generated) — regenerated automatically by `yarn gatherAppData` once the Zod schema changes; not hand-edited.
- `src/_engine/core/CameraManager.ts` — **modify** `createCameraEntity`'s fallback branch (111-115) to call `setMainCamera(world, entityId)` instead of `setActiveCamera(entityId)`; add the new `getMainCamera()` export (§2.4, required for correct camera resolution).
- `src/_engine/debug/3DSymbols.ts` — tag the icon mesh (`icon.userData.isIcon = true`, symmetric with the existing `outline.userData.isOutline`); per-instance-clone `icon`/`outline` materials with `transparent = true` set, so each light's gizmo can have its outline recolored and its opacity faded independently of every other symbol (§10.2).
- `src/_engine/core/Debug/_dbg__Symbols.ts` — **modify** `debugSymbolSyncSystem` so light symbols stay visible instead of hidden when disabled/culled; add `applySymbolTint` (outline recolor + culled-state opacity fade, §10.3).

---

## 8. Phased rollout

**Phase 1 — Component + hook plumbing.** Add the two new component types, the `TAG_FRUSTUM_CULLED` hook, and the `DISABLED` hook fix. No system yet — verify by manually adding/removing `TAG_FRUSTUM_CULLED` on a light entity (e.g. from a debug console) and confirming `.visible` behaves per the invariant in §4.2, including the DISABLED-interaction edge case.

**Phase 2 — The culling system.** Implement `LightFrustumCullingSystem.ts`, wire it into `InitApp.ts`, add `setLightFrustumCullingEnabled` + the `LightProps`/schema fields. Manually opt a point light and a spot light into culling in a test scene; confirm each goes invisible when panned out of frame and reappears when panned back, at both extremes of `distance`/`angle` (including `distance === 0` and near-90° `angle` staying always-visible).

**Phase 3 — Debug GUI.** Add the checkbox, `getLightCharacteristics.supportsFrustumCulling`, `LightEntityDebugState` field. Confirm the checkbox reflects live ECS state on window open, toggling it in both directions produces the correct immediate visual result (including un-hiding a currently-culled light when turned off, per §4.4), and the setting persists across a debug-pane close/reopen via `AEK_debugLights`.

**Phase 4 — Camera resolution fix + debug symbol visualization (§2.4, §10).** Fix `createCameraEntity`'s fallback branch, add `getMainCamera()`, and switch `lightFrustumCullingSystem` to call it. Then implement the light-symbol visualization: per-instance material cloning (with `transparent = true`) in `3DSymbols.ts`, and the `debugSymbolSyncSystem` rewrite so light symbols stay visible with `applySymbolTint` driving an orange outline + 50% opacity for culled, or a red outline at full opacity for disabled, instead of disappearing. Verify by toggling the debug fly-camera on with a point/spot light opted into culling and panned out of the *game* camera's view: the light's own contribution should stay off (culled from the game camera's perspective, unaffected by where the debug camera looks), while its symbol should remain visible in the debug view with an orange, half-opacity outline; disabling the light (any type, including directional) should show a full-opacity red outline instead, whether or not the debug camera is active.

**Exit criteria**: a scene with several point/spot lights, culling enabled on some, shows only the in-frustum ones' contribution while panning/rotating the camera, with no visible popping beyond what's expected at the exact frustum boundary (same as normal mesh culling); disabling a light via the existing "Enabled" checkbox always wins regardless of frustum state; toggling the debug fly-camera never changes which lights are culled from the game camera's perspective; and every light's symbol remains visible and correctly tinted (orange/red/untinted) while flying around with the debug camera, regardless of that camera's own framing.

---

## 9. Risks and open questions

| Risk / question | Notes |
| --- | --- |
| Conservative spot-light sphere over-culls less than it could | A wide-angle spotlight's bounding sphere is much larger than its actual cone, so some spotlights that are geometrically out-of-frustum will still test as "visible." Acceptable for v1 (never wrongly hides a light); a tighter cone-vs-frustum test (e.g. sampling rim points, or a proper separating-axis test) is a valid future refinement if profiling shows it matters. |
| Popping at the exact frustum boundary | Same behavior as Three.js's own default mesh frustum culling — a light very near the frustum edge can flicker visible/invisible across frames as the camera moves slightly. Not a bug, but a margin (e.g. inflate the test sphere radius by ~5-10%) is an easy opt-in refinement if it's visually distracting for a specific light (e.g. a bright point light popping its contribution off right at screen edge). Not built in v1. |
| Interaction with shadow maps | Setting `.visible = false` on a culled light also means the renderer skips generating its shadow map that frame — a bonus perf win, but means a light's shadow can "pop" in/out at the same moment as the light itself. This is consistent with the light not contributing to the visible frame at all, so treated as expected, not a defect. |
| Per-frame cost | O(1) frustum build (only when the opted-in storage is non-empty) + O(n) sphere test over only the lights that opted in — negligible next to the shading cost avoided. No spatial index needed since this tests the light's own bounding volume against one frustum, not against other objects (contrast with the object-culling plan, which is a different and more expensive problem — see `docs/plans/light-object-culling.md`). |
| Nested/parented lights | §3.3's `updateWorldMatrix(true, false)` handles arbitrary nesting depth correctly and cheaply (walks only the ancestor chain), but every light/target pair pays that call each frame it's tested. For the common case (lights added directly to the root scene, per `createLightEntity`), this is a near-no-op since `matrixWorldNeedsUpdate` bookkeeping short-circuits unchanged branches — not separately benchmarked here, flagged as worth a quick check once implemented if a scene has very deep light nesting. |
| Global kill-switch | No engine-wide "force disable all light culling" setting is proposed here (parity with the per-light opt-in the user asked for) — if useful for troubleshooting later, a `CONFIG.rendering?.disableLightCulling` flag (mirroring `CONFIG.physics`'s pattern, `Config.ts:22,55`) would be a small addition, checked once at the top of `lightFrustumCullingSystem`. Not built in v1 — open question whether it's worth the config surface. |
| `getActiveCamera()` silently becomes the debug camera | Verified, not assumed (§2.4) — `toggleDebugCamera` routes the fly-camera through the same `setActiveCamera` every other camera uses, and `renderScene()` depends on that for rendering to work at all. Fixed by having the culling system resolve `getMainCamera()` (new, `TAG_IS_MAIN_CAMERA`-based) instead — not by changing `getActiveCamera()`/`setActiveCamera()` themselves, which would break the debug camera's actual purpose. |
| `TAG_IS_MAIN_CAMERA` not always set | Found via code reading, not hypothetical: `createCameraEntity`'s no-explicit-`active`-prop fallback (`CameraManager.ts:113-114`) calls `setActiveCamera` directly, skipping the tag. Required fix included in this plan (§2.4) — route that branch through `setMainCamera` instead. Until fixed, `getMainCamera()` can return `undefined` for a scene whose main camera was never explicitly marked `active: true` and happened to be the first camera created. |
| Symbol materials are shared across every gizmo instance | `3DSymbols.ts`'s `symbolMaterial`/`outlineMaterial` are two singletons reused by every cloned symbol of every type (`Object3D.clone()` copies material references, not values) — mutating a symbol's material color today would recolor every light/camera gizmo in the scene at once. §10.2's per-instance material clone is required before any per-light tinting is possible; without it, this feature cannot be built as described. |
| Opacity has no effect without `transparent = true` | `THREE.Material.opacity` is ignored by the renderer while `transparent` is `false` — easy to implement the culled-state fade (§10.3) and see no visible change if the per-instance material clone (§10.2) doesn't also flip that flag. Called out explicitly as a required part of the material-clone step, not just the opacity assignment itself. |

---

## 10. Debug symbol visualization: culled vs. disabled state

Prompted by the camera investigation in §2.4: once frustum culling sets `light.visible = false`, it collides with an **existing** debug feature that this plan needs to explicitly account for and adjust.

### 10.1 The collision: light symbols already hide themselves off `Object3D.visible`

Every light (and camera) gets a small 3D gizmo ("symbol") marking its position in the debug view, created by `attachToEntity` (`src/_engine/core/Debug/_dbg__Symbols.ts:16-45`) and synced every frame by `debugSymbolSyncSystem` (`_dbg__Symbols.ts:67-105`, `LATE_MAIN` stage). Its visibility line, today:

```ts
const isCurrentActiveCam = entityId === activeCamId;
const isEnabled = parent.visible && !w.isDisabled(entityId);
symbol.visible = isEnabled && !isCurrentActiveCam && symbolComp.userVisible;
```

`parent` is the light's own `THREE.Light` object. **This reads `parent.visible` directly** — so once `lightFrustumCullingSystem` (§4.3) sets a culled light's `.visible = false`, this existing sync system will hide that light's *symbol* too, the moment the light is culled. That's the opposite of what's needed: the whole reason to fly around with the debug camera is to find and inspect lights, including ones currently invisible from the game camera's perspective — their symbols disappearing defeats that purpose entirely. The same is already true today for `DISABLED` lights (a disabled light's symbol is already fully hidden, not just tinted), which is the second half of the request: show state via color instead of hiding the gizmo, for both reasons a light can currently go invisible.

### 10.2 Prerequisite: symbols don't have per-instance materials today

Symbols are built once as four shared templates in `src/_engine/debug/3DSymbols.ts` (`processMeshIntoGroup`, lines 45-80): each symbol is `root → inner (isLookAtHolder) → [icon, outline]`, where `icon.material = symbolMaterial` and `outline.material = outlineMaterial` are **two singleton `THREE.MeshBasicMaterial` instances shared by every symbol of every type** (lines 32-40). `createNewPointLightSymbol()` etc. (`createSymbolClone`, lines 103-108) call `template.clone()` — `Object3D.clone()`/`Mesh.clone()` copy the `.material` *reference*, not a copy — so today, **every light and camera gizmo in the entire scene points at the same two material objects**. Mutating `icon.material.color` to tint one light's symbol would recolor every symbol in the scene simultaneously.

**Required fix, before any tinting is possible**: clone `icon.material`/`outline.material` per symbol instance right after `createSymbolClone` in `attachToEntity` (`_dbg__Symbols.ts:16-45`), e.g.:

```ts
symbol.traverse((child) => {
  if (child instanceof THREE.Mesh) child.material = (child.material as THREE.Material).clone();
});
```

Also add `icon.userData.isIcon = true` in `processMeshIntoGroup` (`3DSymbols.ts`), symmetric with the existing `outline.userData.isOutline` flag, so the tint helper (§10.3) can find the icon mesh reliably without assuming child order — needed because the icon's *opacity* (not its color) is part of the culled treatment (§10.3). This is `IS_DEBUG_ENV`-only code (`_dbg__` dual-layer pattern, per CLAUDE.md) — the extra per-instance materials never ship in production and the small clone cost is irrelevant at debug-gizmo counts.

**Also required**: both cloned materials need `transparent = true` set once, at clone time. `THREE.Material.opacity` has no visual effect while `transparent` is `false` (the renderer treats the object as fully opaque and ignores `opacity`) — since the culled state needs to actually fade the symbol (§10.3), the per-instance `icon.material`/`outline.material` clones must flip this flag, e.g. `clonedMat.transparent = true;` alongside the `.clone()` call above. Minor cost (transparent objects sort back-to-front and typically skip `depthWrite`), irrelevant at debug-gizmo counts and again `IS_DEBUG_ENV`-only.

### 10.3 Proposed behavior and tint design

Change `debugSymbolSyncSystem` so **light** symbols (not camera symbols — see below) stay visible and are tinted instead of hidden:

```ts
const isLight = w.hasComponent(entityId, ComponentType.TAG_IS_LIGHT);
if (isLight) {
  symbol.visible = symbolComp.userVisible; // no longer hidden by disabled/culled state
  const state = w.isDisabled(entityId)
    ? 'disabled'
    : w.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)
      ? 'culled'
      : 'normal';
  applySymbolTint(symbol, state); // no-ops if already applied last frame — see below
} else {
  // Cameras: unchanged existing behavior — still hidden when disabled or when it's the active camera.
  const isEnabled = parent.visible && !w.isDisabled(entityId);
  symbol.visible = isEnabled && !isCurrentActiveCam && symbolComp.userVisible;
}
```

Camera symbols are deliberately **not** changed — the request is specifically about light symbols ("we should also add a red color hue for the disabled light symbols"), and a camera's `isCurrentActiveCam`-hides-itself behavior is unrelated to culling/disabling.

**Precedence**: disabled (red) wins over culled (orange) when both are true. In practice this is also how the states actually interact — `lightFrustumCullingSystem` skips testing disabled lights entirely (`if (world.isDisabled(entityId)) continue;`, §4.3), so a disabled light's `TAG_FRUSTUM_CULLED` state is simply whatever it was before being disabled, not actively maintained — checking `isDisabled` first is both the more meaningful signal and the more accurate one.

**Design (updated per feedback): tint the outline, not the icon; add reduced opacity for the culled state.** The icon mesh's own texture/colors are left alone in every state (preserves each light type's glyph at a glance — a point/spot/directional icon still reads as itself even when flagged). State is instead communicated by (a) recoloring the outline rim, and (b) for culled specifically, additionally fading the whole symbol:

| State | Outline color | Symbol opacity (icon + outline) |
| --- | --- | --- |
| Normal | `0x333333` (existing dark rim) | `1.0` |
| Culled | orange, e.g. `0xff9900` | `0.5` |
| Disabled | red, e.g. `0xff3333` | `1.0` |

```ts
const applySymbolTint = (symbol: THREE.Group, state: 'normal' | 'culled' | 'disabled') => {
  if (symbol.userData.tintState === state) return; // skip redundant writes — runs every frame
  symbol.userData.tintState = state;

  const outlineColor = state === 'culled' ? 0xff9900 : state === 'disabled' ? 0xff3333 : 0x333333;
  const opacity = state === 'culled' ? 0.5 : 1.0;

  symbol.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = child.material as THREE.MeshBasicMaterial;
    if (child.userData.isOutline) mat.color.setHex(outlineColor);
    mat.opacity = opacity; // applies to icon and outline alike
  });
};
```

Both meshes' opacity move together for the culled case (per the request: "the symbol has 0.5 opacity when culled (+ orange outline)") — the icon fading along with the outline is what reads as "this whole gizmo is currently inactive," rather than just a recolored ring around a full-strength icon. Disabled stays fully opaque; the red outline alone is a strong enough, deliberate-looking signal for an explicit "off," where a permanent fade would work against being noticed as unusual/come back to fix. Requires the `transparent = true` fix on both cloned materials (§10.2) for `opacity` to have any visible effect.

**Still worth considering, if this doesn't read clearly enough once tried**: a slow pulsing opacity/color for the culled state specifically (it's the fast-changing, camera-dependent one, vs. disabled's stable "set and forget" state) — reinforces "this is live, reactive state" rather than a fixed setting. Meaningfully more implementation work (a per-frame animation phase, not just a static value set on state change) — not recommended for v1, noted only as a follow-up if outline color + opacity alone proves ambiguous in practice.

### 10.4 Directional lights: red only, no orange (by design, not oversight)

Directional lights are explicitly out of scope for frustum culling (§1 — conceptually infinite/global, no bounding volume) but **are** in scope for the disabled-tint, since they can still be turned off via `setLightEnabled` like any other light type and already get a symbol (`_dbg__Symbols.ts:30`: `createNewDirectionalLightSymbol()`). The `isLight` branch in §10.3 applies uniformly to every light type with a symbol (point/spot/directional — ambient/hemisphere have no symbol at all, §10.1's `attachToEntity` only creates one for those three `obj.type` values), so a directional light naturally gets the red disabled-tint through the same code path, while `w.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)` is simply always `false` for it (that component is only ever added by `lightFrustumCullingSystem`, which only iterates `FRUSTUM_CULLING_ENABLED` entities — point/spot only, §5.1) — so it can never show orange, correctly.

---

## 11. Relationship to the other two culling plans

This plan is written so the mechanism (opt-in boolean component + runtime tag + paired hooks + a bounding-volume-vs-frustum test) generalizes cleanly:

- `docs/plans/light-object-culling.md` studies a **different, harder** problem — culling a light based on whether anything is actually present to be lit within its volume, not just whether the volume overlaps the frustum — and is a separate opt-in on top of this one, not a replacement.
- `docs/plans/object3d-frustum-culling.md` studies generalizing *this exact* frustum-vs-bounding-volume mechanism to any `Object3D` entity (meshes, groups), for exposing on/off-screen state to gameplay systems (AI, audio, LOD) rather than for rendering (which Three.js already culls for free). If that plan is approved, its shared system would supersede `LightFrustumCullingSystem.ts`'s system function (the component/hook shape stays the same); this plan does not need to wait for that one to ship value on its own.
