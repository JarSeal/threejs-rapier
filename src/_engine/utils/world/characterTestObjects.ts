import * as THREE from 'three/webgpu';
import { createGeometry, deleteGeometry } from '../../core/Geometry';
import { createMaterial } from '../../core/Material';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createMeshEntity, getMeshByAppId } from '../../core/MeshManager';
import { createPhysicsEntity } from '../../core/PhysicsManager';

export const characterTestObstacles = async () => {
  // Stairs
  const stairOffsetW = 0.4;
  const stairOffsetH = 0.2;
  const oneStairGeo = createGeometry({
    id: 'oneStairGeo',
    type: 'BOX',
    params: { width: 4, height: stairOffsetH, depth: 4 },
  });
  const stairGeos = [];
  const count = 10;
  for (let i = 0; i < count; i++) {
    const newGeo = oneStairGeo.clone();
    newGeo.translate(0, stairOffsetH * i, stairOffsetW * i);
    stairGeos.push(newGeo);
  }
  const stairsGeo = mergeGeometries(stairGeos, true);
  deleteGeometry(oneStairGeo.userData.id);
  const stairsMat = createMaterial({
    id: 'largeGroundUvMat',
    type: 'PHONG',
    params: { color: '#999' },
  });

  const stairsEntityId = createMeshEntity(
    { geo: stairsGeo, mat: stairsMat, castShadow: true, receiveShadow: true },
    { appId: 'stairsMesh' }
  );
  const stairsMesh = getMeshByAppId('stairsMesh')!;
  stairsMesh.userData.isStairsObject = true;
  stairsMesh.userData.stairsOffsetW = stairOffsetW;
  stairsMesh.userData.stairsOffsetH = stairOffsetH;

  const quaternionForRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.PI / 6.8, 0, 0)
  );
  await createPhysicsEntity(
    [
      {
        type: 'BOX',
        friction: 1,
        hx: 2,
        hy: 0.1,
        hz: 2.2,
        translation: { x: 0, y: 0.83, z: -0.32 },
        rotation: {
          x: quaternionForRotation.x,
          y: quaternionForRotation.y,
          z: quaternionForRotation.z,
          w: quaternionForRotation.w,
        },
      },
      {
        type: 'BOX',
        friction: 1,
        hx: 2,
        hy: 0.1,
        hz: 2,
        translation: { x: 0, y: 1.8, z: 3.6 },
      },
    ],
    { rigidType: 'FIXED', userData: { isStairs: true, stairsColliderIndex: 0 } },
    stairsEntityId
  );

  // Walls
  const bigBoxWallGeo = createGeometry({
    id: 'bigBoxWallGeo',
    type: 'BOX',
    params: { width: 10, height: 10, depth: 10 },
  });
  const bigBoxWallMat = createMaterial({
    id: 'bigBoxWallUvMat',
    type: 'PHONG',
    params: { color: '#999' },
  });

  const bigBoxWallEntityId = createMeshEntity(
    { geo: bigBoxWallGeo, mat: bigBoxWallMat, castShadow: true, receiveShadow: true },
    { appId: 'bigBoxWallMesh' }
  );
  const bigBoxWallMesh = getMeshByAppId('bigBoxWallMesh')!;

  await createPhysicsEntity(
    { type: 'BOX', friction: 1 },
    { rigidType: 'FIXED' },
    bigBoxWallEntityId
  );

  return { stairsMesh, stairsEntityId, bigBoxWallMesh, bigBoxWallEntityId };
};
