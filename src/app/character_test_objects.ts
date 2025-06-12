import * as THREE from 'three/webgpu';
import { createGeometry, deleteGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createMesh } from '../_engine/core/Mesh';
import { createPhysicsObjectWithMesh } from '../_engine/core/PhysicsRapier';

export const characterTestObjects = () => {
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
  const stairsMesh = createMesh({ id: 'stairsMesh', geo: stairsGeo, mat: stairsMat });
  stairsMesh.castShadow = true;
  stairsMesh.receiveShadow = true;
  stairsMesh.userData.isStairsObject = true;
  stairsMesh.userData.stairsOffsetW = stairOffsetW;
  stairsMesh.userData.stairsOffsetH = stairOffsetH;
  // const stairsPhysicsObject = createPhysicsObjectWithMesh({
  //   id: 'stairsPhyObj',
  //   name: 'Stairs',
  //   physicsParams: {
  //     collider: {
  //       type: 'TRIMESH',
  //       friction: 2,
  //     },
  //     rigidBody: { rigidType: 'FIXED' },
  //   },
  //   meshOrMeshId: stairsMesh,
  // });
  const quaternionForRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.PI / 6.8, 0, 0)
  );
  const stairsPhysicsObject = createPhysicsObjectWithMesh({
    id: 'stairsPhyObj',
    name: 'Stairs',
    physicsParams: [
      {
        collider: {
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
        rigidBody: { rigidType: 'FIXED' },
      },
      {
        collider: {
          type: 'BOX',
          friction: 1,
          hx: 2,
          hy: 0.1,
          hz: 2,
          translation: { x: 0, y: 1.8, z: 3.6 },
        },
      },
    ],
    isCompoundObject: true,
    meshOrMeshId: stairsMesh,
  });

  return { stairsMesh, stairsPhysicsObject };
};
