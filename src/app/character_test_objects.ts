import * as THREE from 'three/webgpu';
import { createGeometry, deleteGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createMesh } from '../_engine/core/Mesh';
import { addScenePhysicsLooper, createPhysicsObjectWithMesh } from '../_engine/core/PhysicsRapier';
import { existsOrThrow } from '../_engine/utils/helpers';

// @TODO: refactor this to produce only the needed objects (not all like it is now)

export const characterTestObstacles = () => {
  // Stairs
  // @TODO: remove this when importing stairs from blender is done
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
        rigidBody: { rigidType: 'FIXED', userData: { isStairs: true, stairsColliderIndex: 0 } },
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
  const bigBoxWallMesh = createMesh({
    id: 'bigBoxWallMesh',
    geo: bigBoxWallGeo,
    mat: bigBoxWallMat,
    castShadow: true,
    receiveShadow: true,
  });
  const bigBoxWallPhysicsObject = createPhysicsObjectWithMesh({
    id: 'bigBoxWallPhyObj',
    name: 'Big box wall',
    physicsParams: [
      {
        collider: {
          type: 'BOX',
          friction: 1,
        },
        rigidBody: { rigidType: 'FIXED' },
      },
    ],
    meshOrMeshId: bigBoxWallMesh,
  });

  return { stairsMesh, stairsPhysicsObject, bigBoxWallMesh, bigBoxWallPhysicsObject };
};

export const createMovingPlatform = (
  id: string,
  scene: THREE.Scene | THREE.Group,
  platformSize: { x: number; y: number; z: number },
  points: {
    pos: { x: number; y: number; z: number };
    rot?: { x: number; y: number; z: number; w: number };
    dur?: number;
  }[]
) => {
  const movingPlatformGeo = createGeometry({
    id: `movingPlatform-geo-${id}`,
    type: 'BOX',
    params: { width: platformSize.x, height: platformSize.y, depth: platformSize.z },
  });
  const movingPlatformMat = createMaterial({
    id: `movingPlatform-mat-${id}`,
    type: 'PHONG',
    params: { color: '#999' },
  });
  const movingPlatformMesh = createMesh({
    id: `movingPlatform-${id}`,
    geo: movingPlatformGeo,
    mat: movingPlatformMat,
    castShadow: true,
    receiveShadow: true,
  });
  movingPlatformMesh.userData.isMovingPlatform = true;

  const movingPlatformPhysicsObject = createPhysicsObjectWithMesh({
    id: `movingPlatform-${id}`,
    name: 'Big box wall',
    physicsParams: [
      {
        collider: {
          type: 'BOX',
          friction: 1,
        },
        rigidBody: { rigidType: 'POS_BASED', userData: { isMovingPlatform: true } },
      },
    ],
    meshOrMeshId: movingPlatformMesh,
  });

  const body = existsOrThrow(
    movingPlatformPhysicsObject?.rigidBody,
    'Moving platform body not found'
  );
  body.setTranslation(new THREE.Vector3(points[0].pos.x, points[0].pos.y, points[0].pos.z), true);
  if (points[0].rot) {
    body.setRotation(
      new THREE.Quaternion(points[0].rot.x, points[0].rot.y, points[0].rot.z, points[0].rot.w),
      true
    );
  }
  let curIndex = 0;

  // Pre-allocate vectors to avoid GC
  const fromPos = new THREE.Vector3();
  const toPos = new THREE.Vector3();
  const curPos = new THREE.Vector3();

  let t = 0; // param 0 → 1 along segment
  let segmentDuration = (points[curIndex].dur ?? 3000) / 1000; // seconds
  const nextIndex = (curIndex + 1) % points.length;
  fromPos.set(points[curIndex].pos.x, points[curIndex].pos.y, points[curIndex].pos.z);
  toPos.set(points[nextIndex].pos.x, points[nextIndex].pos.y, points[nextIndex].pos.z);
  // This part is crucial for sticking the player to the platform
  (body.userData as { velo: THREE.Vector3 }).velo = new THREE.Vector3(
    (toPos.x - fromPos.x) / segmentDuration,
    (toPos.y - fromPos.y) / segmentDuration,
    (toPos.z - fromPos.z) / segmentDuration
  );

  addScenePhysicsLooper(id, (dt) => {
    // Increase param by how much of the segment should pass this tick
    t += dt / segmentDuration;

    // Clamp
    if (t > 1) t = 1;

    // Lerp by param t
    curPos.lerpVectors(fromPos, toPos, t);

    // Apply kinematic motion
    body.setNextKinematicTranslation(curPos);

    // End of segment? Move to next one
    if (t === 1) {
      let nextIndex = (curIndex + 1) % points.length;
      curIndex = nextIndex;
      nextIndex = (curIndex + 1) % points.length;
      fromPos.set(points[curIndex].pos.x, points[curIndex].pos.y, points[curIndex].pos.z);
      toPos.set(points[nextIndex].pos.x, points[nextIndex].pos.y, points[nextIndex].pos.z);
      segmentDuration = (points[curIndex].dur ?? 3000) / 1000;
      const ud = body.userData as { velo: THREE.Vector3 };
      ud.velo.set(
        (toPos.x - fromPos.x) / segmentDuration,
        (toPos.y - fromPos.y) / segmentDuration,
        (toPos.z - fromPos.z) / segmentDuration
      );
      t = 0;
    }
  });

  scene.add(movingPlatformMesh);

  return { movingPlatformPhysicsObject, movingPlatformMesh };
};
