import * as THREE from 'three/webgpu';
import { createGeometry } from '../../core/Geometry';
import { createMaterial } from '../../core/Material';
import { createMesh } from '../../core/Mesh';
import { addScenePhysicsLooper, createPhysicsObjectWithMesh } from '../../core/PhysicsRapier';
import { existsOrThrow } from '../helpers';

const DEFAULT_SEGMENT_DURATION = 3000;
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

  let hasMovement = false;
  let hasRotation = false;
  let hasMovementAndRotation = false;
  for (let i = 0; i < points.length; i++) {
    if (i === 0) continue;
    const p = points[i];
    const prevP = points[i - 1];
    if (p.pos.x !== prevP.pos.x || p.pos.y !== prevP.pos.y || p.pos.z !== prevP.pos.z) {
      hasMovement = true;
    }
    if (
      p.rot?.x !== prevP.rot?.x ||
      p.rot?.y !== prevP.rot?.y ||
      p.rot?.z !== prevP.rot?.z ||
      p.rot?.w !== prevP.rot?.w
    ) {
      hasRotation = true;
    }
    if (hasMovement && hasRotation) {
      hasMovementAndRotation = true;
      break;
    }
    hasMovement = false;
    hasRotation = false;
  }

  const movingPlatformPhysicsObject = createPhysicsObjectWithMesh({
    id: `movingPlatform-${id}`,
    name: 'Big box wall',
    physicsParams: [
      {
        collider: {
          type: 'BOX',
          friction: 0,
        },
        rigidBody: {
          rigidType: 'POS_BASED',
          userData: {
            isMovingPlatform: true,
            velo: new THREE.Vector3(0, 0, 0),
            angVelo: new THREE.Vector3(0, 0, 0),
            // This is whether the character fully sticks on the platform or slides a bit
            friction: hasMovementAndRotation ? 0 : 0.8,
          },
        },
      },
    ],
    meshOrMeshId: movingPlatformMesh,
  });

  const body = existsOrThrow(
    movingPlatformPhysicsObject?.rigidBody,
    'Moving platform body not found'
  );

  // Initial Position
  movingPlatformPhysicsObject?.setTranslation({
    x: points[0].pos.x,
    y: points[0].pos.y,
    z: points[0].pos.z,
  });

  // Initial Rotation
  if (points[0].rot) {
    body.setRotation(
      new THREE.Quaternion(
        points[0].rot.x,
        points[0].rot.y,
        points[0].rot.z,
        points[0].rot.w
      ).normalize(),
      true
    );
  }

  let curIndex = 0;

  const fromPos = new THREE.Vector3();
  const toPos = new THREE.Vector3();
  const curPos = new THREE.Vector3();

  const fromRot = new THREE.Quaternion();
  const toRot = new THREE.Quaternion();
  const curRot = new THREE.Quaternion();

  let t = 0;
  let segmentDuration = (points[curIndex].dur ?? 3000) / 1000;
  let nextIndex = (curIndex + 1) % points.length;

  // --- HELPER: SET FROM/TO STATE ---
  const updateSegmentState = (idx: number, nIdx: number) => {
    // Position
    fromPos.set(points[idx].pos.x, points[idx].pos.y, points[idx].pos.z);
    toPos.set(points[nIdx].pos.x, points[nIdx].pos.y, points[nIdx].pos.z);

    // Rotation
    if (points[idx].rot) {
      fromRot
        .set(points[idx].rot!.x, points[idx].rot!.y, points[idx].rot!.z, points[idx].rot!.w)
        .normalize();
    } else {
      fromRot.identity();
    }

    if (points[nIdx].rot) {
      toRot
        .set(points[nIdx].rot!.x, points[nIdx].rot!.y, points[nIdx].rot!.z, points[nIdx].rot!.w)
        .normalize();
    } else {
      toRot.copy(fromRot);
    }
  };

  // --- HELPER: CALCULATE VELOCITIES ---
  const updateUserDataVelocities = () => {
    const ud = body.userData as { velo: THREE.Vector3; angVelo: THREE.Vector3 };

    // 1. Linear Velocity (Same as before)
    ud.velo.set(
      (toPos.x - fromPos.x) / segmentDuration,
      (toPos.y - fromPos.y) / segmentDuration,
      (toPos.z - fromPos.z) / segmentDuration
    );

    // 2. Angular Velocity
    const q1 = fromRot.clone();
    const q2 = toRot.clone();

    // If the dot product is negative, q2 is on the "opposite side" of the sphere.
    // We negate q2 so it represents the same rotation but is mathematically closer to q1.
    if (q1.dot(q2) < 0) {
      q2.x = -q2.x;
      q2.y = -q2.y;
      q2.z = -q2.z;
      q2.w = -q2.w;
    }

    // Now calculate the difference as normal
    const qDiff = q2.multiply(q1.invert());
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, qDiff.w)));

    if (angle < 0.0001) {
      ud.angVelo.set(0, 0, 0);
    } else {
      const sinHalfAngle = Math.sqrt(1 - qDiff.w * qDiff.w);
      if (sinHalfAngle > 0.001) {
        const axis = new THREE.Vector3(qDiff.x, qDiff.y, qDiff.z).divideScalar(sinHalfAngle);
        const angularSpeed = angle / segmentDuration;
        ud.angVelo.copy(axis).multiplyScalar(angularSpeed);
      } else {
        ud.angVelo.set(0, 0, 0);
      }
    }
  };

  updateSegmentState(curIndex, nextIndex);
  updateUserDataVelocities();

  addScenePhysicsLooper(id, (dt) => {
    t += dt / segmentDuration;

    if (t > 1) t = 1;

    // Lerp Position
    curPos.lerpVectors(fromPos, toPos, t);
    // Slerp Rotation
    curRot.slerpQuaternions(fromRot, toRot, t);

    body.setNextKinematicTranslation(curPos);
    body.setNextKinematicRotation(curRot);

    if (t === 1) {
      let nextIndexLocal = (curIndex + 1) % points.length;
      curIndex = nextIndexLocal;
      nextIndexLocal = (curIndex + 1) % points.length;
      nextIndex = nextIndexLocal;

      segmentDuration = (points[curIndex].dur ?? DEFAULT_SEGMENT_DURATION) / 1000;

      updateSegmentState(curIndex, nextIndex);
      updateUserDataVelocities();

      t = 0;
    }
  });

  scene.add(movingPlatformMesh);

  return { movingPlatformPhysicsObject, movingPlatformMesh };
};
