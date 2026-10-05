// The LOD bounds of an `InstancedMesh` entity, eg. a static instance cell
// (docs/plans/_DONE_p348_ecs-lod-selection.md §4.3): its level swaps every instance at once, so its LOD
// measures the whole cell, not one instance. Imports only three: LodSystem.ts and LodAuto.ts (loaded
// on demand) both use it.
import * as THREE from 'three/webgpu';

export type InstancedLodBounds = {
  /** The centre, in the mesh's space. */
  center: THREE.Vector3;
  /** In the mesh's space. 0 without instances. */
  radius: number;
  /** The largest scale of an instance matrix. 1 without instances. */
  maxInstanceScale: number;
};

const _matrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _corner = new THREE.Vector3();

/** `geometrySphere` at instance `index`, into `_sphere`. */
const placeSphere = (mesh: THREE.InstancedMesh, index: number, geometrySphere: THREE.Sphere) => {
  mesh.getMatrixAt(index, _matrix);
  return _sphere.copy(geometrySphere).applyMatrix4(_matrix);
};

/**
 * A sphere around `geometry` placed at each of the mesh's `count` instances, in the mesh's space,
 * centred on their bounding box: tighter than `InstancedMesh.computeBoundingSphere`, whose
 * incremental union depends on the instance order (a 5×5 grid gets a radius 24% too large). It
 * reads the geometry passed (level 0's, whichever level the mesh shows) and leaves
 * `mesh.boundingSphere` alone.
 * @param mesh the instanced mesh, its instance matrices written
 * @param geometry the geometry the bounds are for (level 0's)
 */
export const getInstancedLodBounds = (
  mesh: THREE.InstancedMesh,
  geometry: THREE.BufferGeometry
): InstancedLodBounds => {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const geometrySphere = geometry.boundingSphere;
  if (!geometrySphere || mesh.count === 0) {
    return { center: new THREE.Vector3(), radius: 0, maxInstanceScale: 1 };
  }

  _box.makeEmpty();
  let maxInstanceScale = 0;
  for (let i = 0; i < mesh.count; i++) {
    const { center, radius } = placeSphere(mesh, i, geometrySphere);
    _box.expandByPoint(_corner.copy(center).addScalar(-radius));
    _box.expandByPoint(_corner.copy(center).addScalar(radius));
    maxInstanceScale = Math.max(maxInstanceScale, _matrix.getMaxScaleOnAxis());
  }
  _box.getCenter(_center);
  let radius = 0;
  for (let i = 0; i < mesh.count; i++) {
    const sphere = placeSphere(mesh, i, geometrySphere);
    radius = Math.max(radius, sphere.center.distanceTo(_center) + sphere.radius);
  }
  return {
    center: _center.clone(),
    radius,
    maxInstanceScale: maxInstanceScale > 0 ? maxInstanceScale : 1,
  };
};
