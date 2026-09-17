import * as THREE from 'three/webgpu';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld } from '../ECS';
import { getMainCamera } from '../CameraManager';
import { ComponentType } from './ECSCoreComponents';
import { reconcileObject3DVisibility } from './ECSCoreSystems';

// --- FRUSTUM CULLING VISIBILITY HOOK ---
// Deliberately a separate component/hook from DISABLED (see docs/plans/_DONE_light-culling.md
// §2.2, §4.2): FRUSTUM_CULLING_ENABLED is the opt-in flag, TAG_FRUSTUM_CULLED is the
// fast-changing runtime state. DISABLED must keep meaning exactly one thing: "user/game logic
// turned this off." Generic across entity types (docs/plans/_DONE_p080_object3d-frustum-culling.md
// §2.1) — nothing here is light-specific, it just reads OBJECT3D/hooks generically.

ECSWorld.registerComponentHooks(ComponentType.TAG_FRUSTUM_CULLED, {
  onAddComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isFrustumCulled: true });
  },
  onRemoveComponent: (entityId, world) => {
    // reconcileObject3DVisibility's own isDisabled/isObjectCulled checks already
    // respect an explicit user-authored "off" or an active object-cull — don't
    // let re-entering the frustum resurrect an entity either of those is hiding.
    reconcileObject3DVisibility(entityId, world, { isFrustumCulled: false });
  },
});

/** Mirrors `LightManager.ts`'s `setLightFrustumCullingEnabled` (which now delegates here) —
 * generic across whatever entity type opts in (docs/plans/_DONE_p080_object3d-frustum-culling.md §2.4). */
export const setFrustumCullingEnabled = (entityId: number, enabled: boolean, world: ECSWorld) => {
  if (enabled) {
    world.addComponent(entityId, ComponentType.FRUSTUM_CULLING_ENABLED, true);
  } else {
    world.removeComponent(entityId, ComponentType.FRUSTUM_CULLING_ENABLED);
    // Opting out must also clear any current culled state — otherwise an entity
    // that was invisible when culling was turned off would stay invisible forever.
    if (world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)) {
      world.removeComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED);
    }
  }
};

// --- BOUNDING-VOLUME PROVIDERS ---
// docs/plans/_DONE_p080_object3d-frustum-culling.md §2.3's provider abstraction: each entity "kind"
// that can opt into FRUSTUM_CULLING_ENABLED gets a provider that returns a world-space bounding
// sphere for the frustum test, or `undefined` to mean "always visible" (used both by lights'
// infinite-range/degenerate-angle special cases and by anything the provider can't measure).

type BoundingVolumeProvider = (entityId: number, world: ECSWorld) => THREE.Sphere | undefined;

// Three.js clamps SpotLight.angle to < PI/2 internally; this is a defensive backstop against
// cos(angle) blowing up toward infinity for a near-90-degree cone. Exported so other consumers
// of the same distance/cos(angle) influence-sphere formula (e.g. SpatialIndexSystem.ts) share
// one cutoff instead of drifting.
export const MAX_SPOT_ANGLE = (89.9 * Math.PI) / 180;

// Point/spot light: influence is a sphere (point, exact) or a cone conservatively approximated
// as a sphere centered at the apex with radius = distance / cos(angle) (spot — docs/plans/
// _DONE_light-culling.md §3.1/§3.2). distance === 0 is Three's own "never attenuate / infinite
// range" convention — such a light can't be usefully culled by a finite sphere, hence `undefined`.

const _pointLightSphere = new THREE.Sphere();

const getPointLightBoundingSphere: BoundingVolumeProvider = (entityId, world) => {
  const light = world.getComponent(entityId, ComponentType.OBJECT3D)?.value as
    | THREE.PointLight
    | undefined;
  if (!light) return undefined;
  if (light.distance === 0) return undefined;

  light.updateWorldMatrix(true, false);
  light.getWorldPosition(_pointLightSphere.center);
  _pointLightSphere.radius = light.distance;
  return _pointLightSphere;
};

const _spotLightSphere = new THREE.Sphere();

const getSpotLightBoundingSphere: BoundingVolumeProvider = (entityId, world) => {
  const light = world.getComponent(entityId, ComponentType.OBJECT3D)?.value as
    | THREE.SpotLight
    | undefined;
  if (!light) return undefined;
  if (light.distance === 0) return undefined;
  if (light.angle > MAX_SPOT_ANGLE) return undefined;

  light.updateWorldMatrix(true, false);
  light.getWorldPosition(_spotLightSphere.center);
  _spotLightSphere.radius = light.distance / Math.cos(light.angle);
  return _spotLightSphere;
};

// Mesh: geometry.boundingSphere, computed lazily if missing, transformed to world space
// (translate by world position, scale radius by the max scale-axis component — an
// approximation for non-uniformly-scaled meshes, not exact; docs/plans/_DONE_p080_object3d-
// frustum-culling.md §2.2). No explicit updateWorldMatrix here, matching the established precedent in
// LightObjectCullingSystem.ts's (now shared) mesh bounding-sphere logic — meshes are kept
// current by object3DSyncSystem earlier in the frame.

const _meshBoundingSphere = new THREE.Sphere();

export const getMeshWorldBoundingSphere: BoundingVolumeProvider = (entityId, world) => {
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  if (!(obj instanceof THREE.Mesh)) return undefined;

  const geometry = obj.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const localRadius = geometry.boundingSphere?.radius ?? 0;
  const maxScale = Math.max(Math.abs(obj.scale.x), Math.abs(obj.scale.y), Math.abs(obj.scale.z));

  obj.getWorldPosition(_meshBoundingSphere.center);
  _meshBoundingSphere.radius = localRadius * maxScale;
  return _meshBoundingSphere;
};

// Checked in this order per entity — first tag present wins. An entity carrying
// FRUSTUM_CULLING_ENABLED but none of these tags (e.g. opted in on an unsupported entity kind)
// is simply skipped, matching docs/plans/_DONE_p080_object3d-frustum-culling.md §2.2's "only ever
// applies to entities tagged for a kind this system knows how to measure."
const boundingVolumeProviders: [ComponentType, BoundingVolumeProvider][] = [
  [ComponentType.TAG_IS_POINT_LIGHT, getPointLightBoundingSphere],
  [ComponentType.TAG_IS_SPOT_LIGHT, getSpotLightBoundingSphere],
  [ComponentType.TAG_IS_MESH, getMeshWorldBoundingSphere],
];

// --- THE SYSTEM ---

const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();

export const objectFrustumCullingSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.FRUSTUM_CULLING_ENABLED);
  if (storage.size === 0) return; // nothing opted in — skip the frustum build entirely

  // Deliberately getMainCamera(), not getActiveCamera() — the latter resolves to the debug
  // fly-camera while it's toggled on (docs/plans/_DONE_light-culling.md §2.4), which must not
  // change which entities are culled from the actual gameplay camera's point of view.
  const camera = getMainCamera();
  if (!camera) return;

  camera.updateMatrixWorld();
  _frustum.setFromProjectionMatrix(
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  );

  for (const [entityId] of storage) {
    if (world.isDisabled(entityId)) continue; // already invisible; don't fight over .visible

    let provider: BoundingVolumeProvider | undefined;
    for (const [tag, candidate] of boundingVolumeProviders) {
      if (world.hasComponent(entityId, tag)) {
        provider = candidate;
        break;
      }
    }
    if (!provider) continue;

    const sphere = provider(entityId, world);
    const isVisible = !sphere || _frustum.intersectsSphere(sphere);

    const isCulled = world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED);
    if (isVisible && isCulled) {
      world.removeComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED);
    } else if (!isVisible && !isCulled) {
      world.addComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED, true);
    }
  }
};

ECSWorld.registerPlugin((world) => {
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'objectFrustumCullingSystem',
    objectFrustumCullingSystem,
    -1
  );
  return world;
});
