import * as THREE from 'three/webgpu';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld } from '../ECS';
import { getMainCamera } from '../CameraManager';
import { ComponentType } from './ECSCoreComponents';
import { reconcileObject3DVisibility } from './ECSCoreSystems';

// --- FRUSTUM CULLING VISIBILITY HOOK ---
// Deliberately a separate component/hook from DISABLED (see docs/plans/light-culling.md §2.2,
// §4.2): FRUSTUM_CULLING_ENABLED is the opt-in flag, TAG_FRUSTUM_CULLED is the fast-changing
// runtime state. DISABLED must keep meaning exactly one thing: "user/game logic turned this off."

ECSWorld.registerComponentHooks(ComponentType.TAG_FRUSTUM_CULLED, {
  onAddComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isFrustumCulled: true });
  },
  onRemoveComponent: (entityId, world) => {
    // reconcileObject3DVisibility's own isDisabled/isObjectCulled checks already
    // respect an explicit user-authored "off" or an active object-cull — don't
    // let re-entering the frustum resurrect a light either of those is hiding.
    reconcileObject3DVisibility(entityId, world, { isFrustumCulled: false });
  },
});

// --- BOUNDING-VOLUME TEST ---
// Point light: influence is exactly a sphere (center = world position, radius = distance).
// Spot light: influence is a cone, conservatively approximated as a sphere centered at the
// apex with radius = distance / cos(angle) (docs/plans/light-culling.md §3.2) — the axis
// direction never enters the formula, so no target lookup is needed for this test.

const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

// Three.js clamps SpotLight.angle to < PI/2 internally; this is a defensive backstop against
// cos(angle) blowing up toward infinity for a near-90-degree cone. Exported so other consumers
// of the same distance/cos(angle) influence-sphere formula (e.g. SpatialIndexSystem.ts) share
// one cutoff instead of drifting.
export const MAX_SPOT_ANGLE = (89.9 * Math.PI) / 180;

const computeIsVisible = (light: THREE.PointLight | THREE.SpotLight): boolean => {
  // distance === 0 is Three.js's own convention for "never attenuate / infinite range" —
  // such a light can't be usefully culled by a finite bounding sphere.
  if (light.distance === 0) return true;

  light.getWorldPosition(_sphere.center);

  if (light instanceof THREE.SpotLight) {
    if (light.angle > MAX_SPOT_ANGLE) return true;
    _sphere.radius = light.distance / Math.cos(light.angle);
  } else {
    _sphere.radius = light.distance;
  }

  return _frustum.intersectsSphere(_sphere);
};

// --- THE SYSTEM ---

export const lightFrustumCullingSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.FRUSTUM_CULLING_ENABLED);
  if (storage.size === 0) return; // nothing opted in — skip the frustum build entirely

  // Deliberately getMainCamera(), not getActiveCamera() — the latter resolves to the debug
  // fly-camera while it's toggled on (docs/plans/light-culling.md §2.4), which must not
  // change which lights are culled from the actual gameplay camera's point of view.
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
    const isVisible = computeIsVisible(light);

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
    'lightFrustumCullingSystem',
    lightFrustumCullingSystem,
    -1
  );
  return world;
});
