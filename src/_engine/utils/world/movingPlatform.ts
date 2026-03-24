import * as THREE from 'three/webgpu';
import { createGeometry, GeoProps, GeoTypes } from '../../core/Geometry';
import { createMaterial, Materials, MatProps } from '../../core/Material';
import { createMesh, deleteMesh, DeleteMeshOptions, MeshProps } from '../../core/Mesh';
import {
  addScenePhysicsLooper,
  createPhysicsObjectWithMesh,
  createPhysicsObjectWithoutMesh,
  deletePhysicsObject,
  deleteScenePhysicsLooper,
  PhysicsObject,
  PhysicsParams,
} from '../../core/PhysicsRapier';
import { existsOrThrow } from '../helpers';
import { getLogger } from '../Logger';
import { RigidBody } from '@dimforge/rapier3d-compat';

export type MovingPlatformControls = {
  play: (fromSegmentIndex?: number) => void;
  pause: () => void;
  playSegment: (segmentIndex: number) => void;
  stop: () => void; // Resets to start
  delete: () => void;
  setOptions: (options: {
    loopTimes?: number;
    direction?: 'FORWARD' | 'BACKWARD';
    speedMultiplier?: number;
  }) => void;
  getState: () => {
    isPlaying: boolean;
    currentLoopCount: number;
    targetSegmentIndex: number | null;
    speedMultiplier: number;
    curIndex: number;
    nextIndex: number;
    t: number;
    segmentDuration: number;
  };
};

export type MovingPlatformReturn = {
  physicsObject: PhysicsObject;
  mesh?: THREE.Mesh;
  controls: MovingPlatformControls;
};

const DEFAULT_SEGMENT_DURATION = 3000;
export const createMovingPlatform = (props: {
  id: string;
  name?: string;
  scene: THREE.Scene | THREE.Group;
  shape?: {
    geo?: GeoProps | GeoTypes;
    mat?: MatProps | Materials;
    mesh?: MeshProps | THREE.Mesh;
    castShadow?: boolean;
    receiveShadow?: boolean;
  };
  physicsParams: PhysicsParams | PhysicsParams[];
  points: {
    pos: { x: number; y: number; z: number };
    rot?: { x: number; y: number; z: number; w: number };
    dur?: number;
  }[];
  opts?: {
    deleteMeshOptions: DeleteMeshOptions;
    isPlayingFromStart?: boolean; // Default true
    loopTimes?: number;
    direction?: 'FORWARD' | 'BACKWARD';
    speedMultiplier?: number;
  };
}): MovingPlatformReturn => {
  const { id, name, scene, shape, physicsParams, points, opts } = props;

  if (shape && shape.geo && !shape.mesh) {
    const msg = `Could not create moving platform, must have either a geo or mesh to create it (id: ${id}).`;
    getLogger().error(msg);
    throw new Error(msg);
  }
  if (shape && shape.geo && !shape.mat) {
    const msg = `Could not create moving platform, if geo is used then mat is required (id: ${id}).`;
    getLogger().error(msg);
    throw new Error(msg);
  }
  if (Array.isArray(physicsParams)) {
    if (physicsParams[0].rigidBody?.rigidType !== 'POS_BASED') {
      const msg = `Could not create moving platform, rigidBody either missing or rigidType is not of correct type of "POS_BASED" (id: ${id})`;
      getLogger().error(msg);
      throw new Error(msg);
    }
  } else {
    if (!physicsParams || physicsParams.rigidBody?.rigidType !== 'POS_BASED') {
      const msg = `Could not create moving platform, rigidBody either missing or rigidType is not of correct type of "POS_BASED" (id: ${id})`;
      getLogger().error(msg);
      throw new Error(msg);
    }
  }

  // Create mesh
  let movingPlatformMesh: THREE.Mesh | undefined = undefined;
  if (shape) {
    if (shape.mesh && 'isMesh' in shape.mesh) {
      movingPlatformMesh = shape.mesh;
    } else if (shape.mesh) {
      movingPlatformMesh = createMesh(shape.mesh);
    } else if (shape.geo && shape.mat) {
      let movingPlatformGeo: GeoTypes;
      let movingPlatformMat: Materials;
      if ('isBufferGeometry' in shape.geo) {
        movingPlatformGeo = shape.geo;
      } else {
        movingPlatformGeo = createGeometry(shape.geo);
      }
      if ('isMaterial' in shape.mat) {
        movingPlatformMat = shape.mat;
      } else {
        movingPlatformMat = createMaterial(shape.mat);
      }
      movingPlatformMesh = createMesh({
        id: `movingPlatformMesh-${id}`,
        geo: movingPlatformGeo,
        mat: movingPlatformMat,
        castShadow: Boolean(shape.castShadow),
        receiveShadow: Boolean(shape.receiveShadow),
      });
    }
  }

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

  const movingPlatformUserData = {
    isMovingPlatform: true,
    velo: new THREE.Vector3(0, 0, 0),
    angVelo: new THREE.Vector3(0, 0, 0),
    // This is whether the character fully sticks on the platform or slides a bit
    friction: hasMovementAndRotation ? 0 : 0.8,
  };
  if (Array.isArray(physicsParams)) {
    (physicsParams[0].rigidBody as unknown as RigidBody).userData = {
      ...(((physicsParams[0].rigidBody as unknown as RigidBody).userData as {
        [key: string]: unknown;
      }) || {}),
      ...movingPlatformUserData,
    };
  } else {
    (physicsParams.rigidBody as unknown as RigidBody).userData = {
      ...(((physicsParams.rigidBody as unknown as RigidBody).userData as {
        [key: string]: unknown;
      }) || {}),
      ...movingPlatformUserData,
    };
  }

  let movingPlatformPhysicsObject: PhysicsObject | undefined;

  if (movingPlatformMesh) {
    movingPlatformMesh.userData.isMovingPlatform = true;
    movingPlatformPhysicsObject = createPhysicsObjectWithMesh({
      id: `movingPlatform-${id}`,
      name,
      physicsParams: physicsParams,
      meshOrMeshId: movingPlatformMesh,
    });
    existsOrThrow(
      movingPlatformPhysicsObject,
      `Could not create physics object with mesh for moving platform (id: ${id})`
    );
  } else {
    movingPlatformPhysicsObject = createPhysicsObjectWithoutMesh({
      id: `movingPlatform-${id}`,
      name,
      physicsParams: physicsParams,
    });
    existsOrThrow(
      movingPlatformPhysicsObject,
      `Could not create physics object with mesh for moving platform (id: ${id})`
    );
  }

  const body = existsOrThrow(movingPlatformPhysicsObject?.rigidBody, 'No Body');

  // --- STATE VARIABLES ---
  let isPlaying = opts?.isPlayingFromStart !== undefined ? opts.isPlayingFromStart : true;
  let playDirection: 1 | -1 = opts?.direction === 'BACKWARD' ? -1 : 1; // 1 = Forward, -1 = Backward
  let loopTimes = opts?.loopTimes !== undefined ? opts.loopTimes : -1; // -1 = Infinite, 0 = Run once then stop, 1 = Run twice...
  let currentLoopCount = 0;
  let targetSegmentIndex: number | null = null; // If set, stops after this segment
  let speedMultiplier = opts?.speedMultiplier !== undefined ? opts.speedMultiplier : 1;

  let curIndex = 0;
  let nextIndex = 1; // Calculated based on direction
  let t = 0;
  let segmentDuration = (points[curIndex].dur ?? DEFAULT_SEGMENT_DURATION) / 1000;

  // reusable vectors
  const startP = points[0].pos;
  const startR = points[0].rot;
  const fromPos = new THREE.Vector3(startP.x, startP.y, startP.z);
  const toPos = new THREE.Vector3();
  const curPos = new THREE.Vector3(startP.x, startP.y, startP.z);
  const fromRot = new THREE.Quaternion(startR?.x, startR?.y, startR?.z, startR?.w);
  const toRot = new THREE.Quaternion();
  const curRot = new THREE.Quaternion(startR?.x, startR?.y, startR?.z, startR?.w);

  // --- INTERNAL HELPER: UPDATE TARGETS ---
  const updateSegmentTargets = () => {
    // Calculate Next Index based on Direction
    const len = points.length;
    if (playDirection === 1) {
      nextIndex = (curIndex + 1) % len;
    } else {
      // Wrap around backwards: (0 - 1 + 4) % 4 = 3
      nextIndex = (curIndex - 1 + len) % len;
    }

    // Set Pos
    fromPos.set(points[curIndex].pos.x, points[curIndex].pos.y, points[curIndex].pos.z);
    toPos.set(points[nextIndex].pos.x, points[nextIndex].pos.y, points[nextIndex].pos.z);

    // Set Rot (with Normalize fix)
    if (points[curIndex].rot) {
      fromRot
        .set(
          points[curIndex].rot!.x,
          points[curIndex].rot!.y,
          points[curIndex].rot!.z,
          points[curIndex].rot!.w
        )
        .normalize();
    } else fromRot.identity();

    if (points[nextIndex].rot) {
      toRot
        .set(
          points[nextIndex].rot!.x,
          points[nextIndex].rot!.y,
          points[nextIndex].rot!.z,
          points[nextIndex].rot!.w
        )
        .normalize();
    } else toRot.copy(fromRot);

    segmentDuration = (points[curIndex].dur ?? 3000) / 1000;
  };

  // --- INTERNAL HELPER: CALCULATE VELOCITIES ---
  const updateUserDataVelocities = () => {
    const ud = body.userData as { velo: THREE.Vector3; angVelo: THREE.Vector3 };

    // Calculate Linear Velocity
    ud.velo
      .copy(toPos)
      .sub(fromPos)
      .divideScalar(segmentDuration / speedMultiplier);

    // Calculate Angular Velocity (Shortest Path)
    const q1 = fromRot.clone();
    const q2 = toRot.clone();
    if (q1.dot(q2) < 0) q2.x = -q2.x; // Double cover fix (copy rest of components too or negate logic)
    if (q1.dot(q2) < 0) {
      q2.x = -q2.x;
      q2.y = -q2.y;
      q2.z = -q2.z;
      q2.w = -q2.w;
    }

    const qDiff = q2.multiply(q1.invert());
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, qDiff.w)));

    if (angle < 0.0001) {
      ud.angVelo.set(0, 0, 0);
    } else {
      const sinHalfAngle = Math.sqrt(1 - qDiff.w * qDiff.w);
      if (sinHalfAngle > 0.001) {
        const axis = new THREE.Vector3(qDiff.x, qDiff.y, qDiff.z).divideScalar(sinHalfAngle);
        const angularSpeed = angle / (segmentDuration / speedMultiplier);
        ud.angVelo.copy(axis).multiplyScalar(angularSpeed);
      } else ud.angVelo.set(0, 0, 0);
    }
  };

  // --- INITIAL SETUP ---
  updateSegmentTargets();
  updateUserDataVelocities();

  // Initialize Body Position immediately
  body.setTranslation(fromPos, true);
  body.setRotation(fromRot, true);
  body.setNextKinematicTranslation(fromPos);
  body.setNextKinematicRotation(fromRot);
  if (movingPlatformMesh) {
    movingPlatformMesh.position.copy(fromPos);
    movingPlatformMesh.quaternion.copy(fromRot);
    // Update matrix immediately to prevent any single-frame glitches
    movingPlatformMesh.updateMatrix();
    movingPlatformMesh.updateMatrixWorld();
  }

  // --- CONTROL FUNCTIONS ---
  const controls: MovingPlatformControls = {
    play: (fromIdx) => {
      if (fromIdx !== undefined && points[fromIdx]) {
        curIndex = fromIdx;
        t = 0;
        updateSegmentTargets();
        updateUserDataVelocities();
        // Snap to start of this segment
        body.setNextKinematicTranslation(fromPos);
        body.setNextKinematicRotation(fromRot);
      }
      isPlaying = true;
    },
    pause: () => {
      isPlaying = false;
      // Zero out velocity in userData so character stops sliding
      (body.userData as { velo: THREE.Vector3 }).velo.set(0, 0, 0);
      (body.userData as { angVelo: THREE.Vector3 }).angVelo.set(0, 0, 0);
    },
    playSegment: (idx) => {
      if (!points[idx]) return;
      // Reset to start of this segment
      curIndex = idx;
      t = 0;
      targetSegmentIndex = idx; // Stop when this segment finishes
      isPlaying = true;
      updateSegmentTargets();
      updateUserDataVelocities();
      // Snap physics immediately
      body.setTranslation(fromPos, true);
      body.setRotation(fromRot, true);
    },
    stop: () => {
      isPlaying = false;
      curIndex = 0;
      t = 0;
      updateSegmentTargets();
      body.setTranslation(fromPos, true); // Reset to start
      body.setRotation(fromRot, true);
    },
    delete: () => {
      // 1. Remove posiible mesh
      if (movingPlatformMesh) {
        deleteMesh(movingPlatformMesh.userData.id, opts?.deleteMeshOptions);
      }

      deletePhysicsObject(`movingPlatform-${id}`);
      deleteScenePhysicsLooper(`platformLoop-${id}`);
    },
    setOptions: (opts) => {
      if (opts.loopTimes !== undefined) loopTimes = opts.loopTimes;
      if (opts.direction) playDirection = opts.direction === 'FORWARD' ? 1 : -1;
      if (opts.speedMultiplier !== undefined) speedMultiplier = opts.speedMultiplier;

      // Recalculate targets immediately in case direction changed
      updateSegmentTargets();
      updateUserDataVelocities();
    },
    getState: () => ({
      isPlaying,
      currentLoopCount,
      targetSegmentIndex,
      speedMultiplier,
      curIndex,
      nextIndex,
      t,
      segmentDuration,
    }),
  };

  // --- PHYSICS LOOPER ---
  addScenePhysicsLooper(`platformLoop-${id}`, (dt) => {
    if (!isPlaying) return;

    // Increment T
    t += dt / (segmentDuration / speedMultiplier);

    // Clamp
    if (t > 1) t = 1;

    // Lerp/Slerp
    curPos.lerpVectors(fromPos, toPos, t);
    curRot.slerpQuaternions(fromRot, toRot, t);

    // Apply Physics
    body.setNextKinematicTranslation(curPos);
    body.setNextKinematicRotation(curRot);

    // Segment Complete Logic
    if (t === 1) {
      // Check for specific segment play mode
      if (targetSegmentIndex !== null && curIndex === targetSegmentIndex) {
        isPlaying = false;
        targetSegmentIndex = null;
        // Zero velocities
        (body.userData as { velo: THREE.Vector3 }).velo.set(0, 0, 0);
        (body.userData as { angVelo: THREE.Vector3 }).angVelo.set(0, 0, 0);
        return;
      }

      // Loop Logic
      const len = points.length;
      // If we just finished the last segment (forward) or first segment (backward)
      const isLoopComplete =
        (playDirection === 1 && curIndex === len - 1) || (playDirection === -1 && curIndex === 0);

      if (isLoopComplete) {
        if (loopTimes !== -1) {
          currentLoopCount++;
          if (currentLoopCount > loopTimes) {
            isPlaying = false;
            return;
          }
        }
      }

      // Advance Index
      curIndex = nextIndex;
      t = 0;

      // Prepare Next Segment
      updateSegmentTargets();
      updateUserDataVelocities();
    }
  });

  if (movingPlatformMesh) scene.add(movingPlatformMesh);

  return {
    physicsObject: movingPlatformPhysicsObject as PhysicsObject,
    mesh: movingPlatformMesh,
    controls,
  };
};
