import * as THREE from 'three/webgpu';
import { createGeometry, GeoProps, GeoTypes } from '../../core/Geometry';
import { createMaterial, Materials, MatProps } from '../../core/Material';
import { createMeshEntity, getMeshByAppId, MeshProps } from '../../core/MeshManager';
import { getECSWorld, type ECSWorld } from '../../core/ECS';
import { createPhysicsEntity } from '../../core/PhysicsManager';
import type { ColliderParams, RigidBodyParams } from '../../core/Physics/PhysicsAPITypes';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { existsOrThrow } from '../assert';
import { getLogger } from '../Logger';

/** This file's own internal grouping of one collider (+ optionally the shared rigid body),
 * mirroring ImportModel.ts's identically-named local type — the engine-agnostic Physics API has
 * no single equivalent combined type since createPhysicsEntity takes collider(s) and the rigid
 * body as separate params. Kept as the public physicsParams shape below so callers (still on
 * the legacy shape until they're ported in a later phase) don't need to change at all. */
export type PhysicsParams = {
  collider: ColliderParams;
  rigidBody?: RigidBodyParams;
};

// --- Shared ECS system (design decision: keyframe-path movement is one system, registered
// once, not one addScenePhysicsLooper registration per platform instance) ---------------------
// Each tick is owned by its platform's entity: it only runs for that entity's world, and is
// dropped once the entity is gone (e.g. deleted with its scene) — otherwise it would keep
// driving a rigid body that no longer exists.
type PlatformTick = { world: ECSWorld; entityId: number; tick: (dt: number) => void };
const activePlatformTicks = new Map<string, PlatformTick>();

const movingPlatformSystemFn = (world: ECSWorld, dt: number) => {
  for (const [key, platform] of activePlatformTicks) {
    if (platform.world !== world) continue;
    if (!world.isAlive(platform.entityId)) {
      activePlatformTicks.delete(key);
      continue;
    }
    platform.tick(dt);
  }
};

/** Registers the single shared moving-platform system on `world`, driving every active
 * createMovingPlatform() instance's keyframe-path movement at APP_PHYSICS_STEP — once per fixed
 * physics sub-step with dt = the fixed timestep, writing that step's kinematic target pose right
 * before it (the legacy scene physics looper cadence; a once-per-frame tick moves the platform
 * unevenly whenever a frame runs 0 or 2+ sub-steps). Ordered after the default-order systems of
 * the same stage (character controllers, scene loopers), matching legacy's looper order where
 * platforms were created last. Call this once per world before creating any moving platforms on
 * it — mirrors toolkit/ecs/effects/HoverEffect.ts's registerHoverToolEffect(world) convention:
 * the caller registers the system once, individual instances just add themselves to it. */
export const registerMovingPlatformSystem = (world: ECSWorld) => {
  world.addSystem(
    ECSSystemStage.APP_PHYSICS_STEP,
    'movingPlatformSystem',
    movingPlatformSystemFn,
    -100
  );
  return world;
};

export type DeleteMeshOptions = {
  deleteGeometries?: boolean;
  deleteMaterials?: boolean;
  deleteTextures?: boolean;
  deleteAll?: boolean;
};

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
  entityId: number;
  mesh?: THREE.Mesh;
  controls: MovingPlatformControls;
};

const DEFAULT_SEGMENT_DURATION = 3000;
export const createMovingPlatform = async (props: {
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
    deleteMeshOptions?: DeleteMeshOptions;
    isPlayingFromStart?: boolean; // Default true
    loopTimes?: number;
    direction?: 'FORWARD' | 'BACKWARD';
    speedMultiplier?: number;
  };
}): Promise<MovingPlatformReturn> => {
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

  // Create mesh entity
  let movingPlatformMesh: THREE.Mesh | undefined = undefined;
  if (shape) {
    if (shape.mesh && 'isMesh' in shape.mesh) {
      movingPlatformMesh = shape.mesh;
    } else if (shape.mesh) {
      const meshAppId = shape.mesh.appId || `movingPlatformMesh-${id}`;
      createMeshEntity({ ...shape.mesh, appId: meshAppId });
      movingPlatformMesh = getMeshByAppId(meshAppId);
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
      const meshAppId = `movingPlatformMesh-${id}`;
      createMeshEntity({
        appId: meshAppId,
        geo: movingPlatformGeo,
        mat: movingPlatformMat,
        castShadow: Boolean(shape.castShadow),
        receiveShadow: Boolean(shape.receiveShadow),
      });
      movingPlatformMesh = getMeshByAppId(meshAppId);
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

  const movingPlatformUserData: { [key: string]: unknown } = {
    isMovingPlatform: true,
    velo: { x: 0, y: 0, z: 0 },
    angVelo: { x: 0, y: 0, z: 0 },
    // This is whether the character fully sticks on the platform or slides a bit
    friction: hasMovementAndRotation ? 0 : 0.8,
  };
  const paramsArray = Array.isArray(physicsParams) ? physicsParams : [physicsParams];
  const rigidBodyParams: RigidBodyParams = existsOrThrow(
    paramsArray[0].rigidBody,
    `Could not create moving platform, rigidBody is missing (id: ${id}).`
  );
  rigidBodyParams.userData = { ...rigidBodyParams.userData, ...movingPlatformUserData };
  const colliderParamsArray = paramsArray.map((p) => p.collider);

  if (movingPlatformMesh) movingPlatformMesh.userData.isMovingPlatform = true;

  // Three ways movingPlatformMesh can arrive here:
  // 1. Built from GeoProps/MeshProps above via createMeshEntity — already has its own entity;
  //    attach physics to that existing entity by id (passing the raw mesh again as target would
  //    create a second, duplicate entity for it).
  // 2. A raw THREE.Mesh passed in directly (shape.mesh with 'isMesh') — has no entity yet, since
  //    the new ECS-based Physics API (unlike the legacy mesh-coupled one) can only keep a mesh's
  //    position in sync via an ECS entity's Transform/OBJECT3D component. Pass the mesh itself
  //    as target so createPhysicsEntity creates that entity and attaches it as a side effect.
  // 3. No mesh at all — a fully invisible physics-only platform.
  const meshEntityId: number | undefined = movingPlatformMesh?.userData.entityId;
  const target: THREE.Object3D | number | undefined =
    meshEntityId !== undefined ? meshEntityId : movingPlatformMesh;
  const entityId = await createPhysicsEntity(
    colliderParamsArray,
    rigidBodyParams,
    target,
    target === undefined ? { appId: `movingPlatform-${id}`, debugData: { name } } : undefined
  );
  const body = existsOrThrow(
    getECSWorld().getRigidBody(entityId),
    `Could not find rigid body for moving platform (id: ${id})`
  );

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

  // Reusable vectors
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

    fromPos.set(points[curIndex].pos.x, points[curIndex].pos.y, points[curIndex].pos.z);
    toPos.set(points[nextIndex].pos.x, points[nextIndex].pos.y, points[nextIndex].pos.z);

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
  // The new Physics API's rigid body userData (RigidBodyAPI.uData) is a plain snapshot pushed
  // via setUserData(...) — in WORKER_THREAD mode it round-trips a message to the worker, unlike
  // the legacy system's raw Rapier RigidBody.userData object, which callers (e.g. a future
  // dynamicCharacter.ts port) could read AND mutate as one shared live reference. So velo/
  // angVelo are computed into local scratch vectors, then explicitly pushed with setUserData
  // instead of being mutated in place.
  const veloScratch = new THREE.Vector3();
  const angVeloScratch = new THREE.Vector3();
  const updateUserDataVelocities = () => {
    veloScratch
      .copy(toPos)
      .sub(fromPos)
      .divideScalar(segmentDuration / speedMultiplier);

    const q1 = fromRot.clone();
    const q2 = toRot.clone();
    if (q1.dot(q2) < 0) {
      q2.x = -q2.x;
      q2.y = -q2.y;
      q2.z = -q2.z;
      q2.w = -q2.w;
    }

    const qDiff = q2.multiply(q1.invert());
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, qDiff.w)));

    if (angle < 0.0001) {
      angVeloScratch.set(0, 0, 0);
    } else {
      const sinHalfAngle = Math.sqrt(1 - qDiff.w * qDiff.w);
      if (sinHalfAngle > 0.001) {
        const axis = new THREE.Vector3(qDiff.x, qDiff.y, qDiff.z).divideScalar(sinHalfAngle);
        const angularSpeed = angle / (segmentDuration / speedMultiplier);
        angVeloScratch.copy(axis).multiplyScalar(angularSpeed);
      } else angVeloScratch.set(0, 0, 0);
    }

    body.setUserData(
      {
        velo: { x: veloScratch.x, y: veloScratch.y, z: veloScratch.z },
        angVelo: { x: angVeloScratch.x, y: angVeloScratch.y, z: angVeloScratch.z },
      },
      true
    );
  };
  const zeroUserDataVelocities = () => {
    body.setUserData({ velo: { x: 0, y: 0, z: 0 }, angVelo: { x: 0, y: 0, z: 0 } }, true);
  };

  // --- INITIAL SETUP ---
  updateSegmentTargets();
  updateUserDataVelocities();

  body.setTranslation(fromPos, true);
  body.setRotation(fromRot, true);
  body.setNextKinematicTranslation(fromPos);
  body.setNextKinematicRotation(fromRot);
  if (movingPlatformMesh) {
    movingPlatformMesh.position.copy(fromPos);
    movingPlatformMesh.quaternion.copy(fromRot);
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
        body.setNextKinematicTranslation(fromPos);
        body.setNextKinematicRotation(fromRot);
      }
      isPlaying = true;
    },
    pause: () => {
      isPlaying = false;
      zeroUserDataVelocities();
    },
    playSegment: (idx) => {
      if (!points[idx]) return;
      curIndex = idx;
      t = 0;
      targetSegmentIndex = idx;
      isPlaying = true;
      updateSegmentTargets();
      updateUserDataVelocities();
      body.setTranslation(fromPos, true);
      body.setRotation(fromRot, true);
    },
    stop: () => {
      isPlaying = false;
      curIndex = 0;
      t = 0;
      updateSegmentTargets();
      body.setTranslation(fromPos, true);
      body.setRotation(fromRot, true);
    },
    delete: () => {
      // entityId is shared by the mesh (when one exists) and its physics components — deleting
      // it cleans up both (physics entity cleanup happens via the existing
      // TAG_IS_PHYSICS_OBJECT.onDeleteEntity hook, same as everywhere else on the new API).
      getECSWorld().deleteEntity(entityId);
      activePlatformTicks.delete(`platformLoop-${id}`);
    },
    setOptions: (opts) => {
      if (opts.loopTimes !== undefined) loopTimes = opts.loopTimes;
      if (opts.direction) playDirection = opts.direction === 'FORWARD' ? 1 : -1;
      if (opts.speedMultiplier !== undefined) speedMultiplier = opts.speedMultiplier;

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

  // --- TICK (driven by the shared movingPlatformSystemFn, not a per-instance registration) ---
  activePlatformTicks.set(`platformLoop-${id}`, {
    world: getECSWorld(),
    entityId,
    tick: (dt) => {
      if (!isPlaying) return;

      t += dt / (segmentDuration / speedMultiplier);

      if (t > 1) t = 1;

      curPos.lerpVectors(fromPos, toPos, t);
      curRot.slerpQuaternions(fromRot, toRot, t);

      body.setNextKinematicTranslation(curPos);
      body.setNextKinematicRotation(curRot);

      if (t === 1) {
        if (targetSegmentIndex !== null && curIndex === targetSegmentIndex) {
          isPlaying = false;
          targetSegmentIndex = null;
          zeroUserDataVelocities();
          return;
        }

        const len = points.length;
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

        curIndex = nextIndex;
        t = 0;

        updateSegmentTargets();
        updateUserDataVelocities();
      }
    },
  });

  if (movingPlatformMesh && !movingPlatformMesh.parent) scene.add(movingPlatformMesh);

  return {
    entityId,
    mesh: movingPlatformMesh,
    controls,
  };
};
