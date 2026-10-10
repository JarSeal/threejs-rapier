import * as THREE from 'three/webgpu';
import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from './SystemStages';
import { ECSWorld } from '../ECS';
import { getMainCamera } from '../CameraManager';
import { ComponentType } from './ECSCoreComponents';
import { reconcileObject3DVisibility } from './ECSCoreSystems';
import { getMeshWorldBoundingSphere } from './ObjectFrustumCullingSystem';
import type { SpatialGrid } from '../Spatial/SpatialGrid';
import {
  computeLightInfluenceRadius,
  DEFAULT_SPATIAL_DOMAIN,
  getSpatialDomain,
  validateSpatialGridQuery,
} from '../Spatial/SpatialIndexSystem';

// --- OBJECT (CONTRIBUTION) CULLING VISIBILITY HOOK ---
// A third, independent cull reason alongside DISABLED and TAG_FRUSTUM_CULLED,
// reconciled through the shared helper rather than another pairwise
// visibility guard.

ECSWorld.registerComponentHooks(ComponentType.TAG_OBJECT_CULLED, {
  onAddComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isObjectCulled: true });
  },
  onRemoveComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isObjectCulled: false });
  },
});

// --- NEARBY-MESH TEST ---
// Candidates come from the spatial index (docs/plans/_DONE_p050_spatial-index.md);
// this system does the exact test the index's own contract requires (§7 —
// "candidates, not results").

const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _lightSphere = new THREE.Sphere();

function meshIsVisibleReceiver(entityId: number, world: ECSWorld): boolean {
  // Shared with ObjectFrustumCullingSystem.ts's mesh bounding-volume provider
  // (docs/plans/_DONE_p080_object3d-frustum-culling.md §2.2) — same world-space
  // bounding-sphere approximation, one implementation.
  const meshSphere = getMeshWorldBoundingSphere(entityId, world);
  if (!meshSphere) return false; // the index also holds lights, cameras, etc.

  // A mesh only counts if it both receives this light AND would actually be
  // drawn — a mesh lit but itself off-screen contributes nothing to the
  // rendered frame either (§1).
  return _lightSphere.intersectsSphere(meshSphere) && _frustum.intersectsSphere(meshSphere);
}

/**
 * Whether `lightId` has at least one nearby, in-frustum mesh that could
 * receive its light. The caller doesn't need to know this queries a spatial index rather than
 * scanning every mesh.
 */
function testLightAgainstMeshList(
  lightId: number,
  world: ECSWorld,
  grid: SpatialGrid,
  light: THREE.PointLight | THREE.SpotLight
): boolean {
  const radius = computeLightInfluenceRadius(light);
  light.getWorldPosition(_lightSphere.center);
  _lightSphere.radius = radius;

  validateSpatialGridQuery(world, _lightSphere.center, radius);

  let found = false;
  grid.queryVisit(_lightSphere.center, radius, (candidateId) => {
    if (found || candidateId === lightId) return;
    if (meshIsVisibleReceiver(candidateId, world)) found = true;
  });
  return found;
}

// --- THE SYSTEM ---

export const lightObjectCullingSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.OBJECT_CULLING_ENABLED);
  if (storage.size === 0) return; // nothing opted in — skip the frustum build entirely

  const camera = getMainCamera();
  if (!camera) return;

  // Read, never built here: every SPATIAL_INDEXED entity builds DEFAULT's grid, so a scene
  // without one has no indexed receivers, the same result as an empty grid (p349 §3.6)
  const grid = getSpatialDomain(world, DEFAULT_SPATIAL_DOMAIN);

  camera.updateMatrixWorld();
  _frustum.setFromProjectionMatrix(
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  );

  for (const [entityId] of storage) {
    if (world.isDisabled(entityId)) continue; // already invisible; don't fight over .visible
    // Already known to have nothing looking at it this frame — skip the (more expensive) mesh scan.
    if (world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)) continue;

    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (!objComp) continue;
    const light = objComp.value as THREE.PointLight | THREE.SpotLight;
    light.updateWorldMatrix(true, false);

    const hasNearbyVisibleMesh = grid
      ? testLightAgainstMeshList(entityId, world, grid, light)
      : false;
    const isCulled = world.hasComponent(entityId, ComponentType.TAG_OBJECT_CULLED);
    if (hasNearbyVisibleMesh && isCulled) {
      world.removeComponent(entityId, ComponentType.TAG_OBJECT_CULLED);
    } else if (!hasNearbyVisibleMesh && !isCulled) {
      world.addComponent(entityId, ComponentType.TAG_OBJECT_CULLED, true);
    }
  }
};

ECSWorld.registerPlugin((world) => {
  // LIGHT_CULLING (-2), one below objectFrustumCullingSystem's FRUSTUM_CULLING (-1) —
  // runs after frustum culling has updated TAG_FRUSTUM_CULLED for this
  // frame, so the skip above sees this frame's result, not last frame's.
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'lightObjectCullingSystem',
    lightObjectCullingSystem,
    APP_RENDER_SYNC_ORDER.LIGHT_CULLING
  );
});
