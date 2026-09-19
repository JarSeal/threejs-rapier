import * as THREE from 'three/webgpu';

import { ECSSystemStage } from '../../AppECSRegistry';
import { CoreEntityOpts } from '../schemas/_helperSchemas';
import { existsOrThrow } from '../utils/assert';
import { lerror } from '../utils/Logger';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import {
  createColliders,
  createCollidersSync,
  createRigidBody,
  createRigidBodySync,
  deleteColliders,
  deleteRigidBody,
  getPhysicsInterpolationAlpha,
  getPhysicsState,
} from './PhysicsAPI';
import { ColliderParams, RigidBodyAPI, RigidBodyParams } from './Physics/PhysicsAPITypes';

export const registerPhysicsManager = (world: ECSWorld) => {
  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_PHYSICS_OBJECT, {
    onDeleteEntity: (entityId, w) => {
      // onDeleteEntity is synchronous; disposal is fire-and-forget (WORKER_THREAD mode
      // has no synchronous delete path, see disposePhysicsEntity).
      disposePhysicsEntity(entityId, w).catch((err) =>
        lerror(`Failed to dispose physics entity ${entityId}.`, err)
      );
      interpolationStates.delete(entityId);
    },
  });
  world.addSystem(
    ECSSystemStage.APP_POST_PHYSICS,
    'physicsToTransformSystem',
    physicsToTransformSystem
  );
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'physicsInterpolationSystem',
    physicsInterpolationSystem
  );
};

export const createPhysicsEntity = async (
  colliderParams: ColliderParams | ColliderParams[],
  rigidBodyParams?: RigidBodyParams,
  /**
   * Either a raw Object3D (a new entity is created and this is attached to it as its
   * OBJECT3D component, same as before), or the id of an existing entity to attach the
   * physics components to directly (e.g. one already created by createMeshEntity) —
   * no new entity is created, and its own OBJECT3D/other components (if any) already
   * on it govern the BODY_DYNAMIC_VISUAL/HEADLESS bucket choice below.
   */
  target?: THREE.Object3D | number,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): Promise<number> => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in createPhysicsEntity.');

  const object3D = target instanceof THREE.Object3D ? target : undefined;
  const entityId = typeof target === 'number' ? target : world.createEntity(entityOpts);

  world.addComponent(entityId, ComponentType.TAG_IS_PHYSICS_OBJECT, true);

  const isWorkerThread = getPhysicsState().workerTarget === 'WORKER_THREAD';

  let rb: RigidBodyAPI | undefined;
  if (rigidBodyParams) {
    rb = isWorkerThread
      ? await createRigidBody(rigidBodyParams)
      : createRigidBodySync(rigidBodyParams);
  }

  const paramsArray = Array.isArray(colliderParams) ? colliderParams : [colliderParams];
  if (rb) for (const p of paramsArray) p.parentId = rb.id;
  const colls = paramsArray.length
    ? isWorkerThread
      ? await createColliders(paramsArray)
      : createCollidersSync(paramsArray)
    : [];

  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  if (rb) {
    transform?.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
    transform?.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
  } else if (object3D) {
    transform?.position.copy(object3D.position);
    transform?.quaternion.copy(object3D.quaternion);
    transform?.scale.copy(object3D.scale);
  }
  // Persists the in-place mutation above for TYPED_ARRAY storage mode too
  // (ECS.ts's commitTransform doc comment: MAP mode returns a live reference
  // and doesn't strictly need this, TYPED_ARRAY mode does).
  if (transform) world.commitTransform(entityId, transform);

  if (object3D) {
    if (transform) {
      object3D.position.copy(transform.position);
      object3D.quaternion.copy(transform.quaternion);
      object3D.scale.copy(transform.scale);
      object3D.userData._lastVersion = transform.version;
    }
    world.addComponent(entityId, ComponentType.OBJECT3D, { value: object3D, _lastVersion: -1 });
  }

  world.addComponent(entityId, ComponentType.COLLIDER, colls);

  const hasVisual = world.hasComponent(entityId, ComponentType.OBJECT3D);
  const isStatic = !rb || rigidBodyParams?.rigidType === 'FIXED';
  if (isStatic) {
    if (rb) world.addComponent(entityId, ComponentType.BODY_STATIC, rb);
  } else {
    const bucket = hasVisual
      ? ComponentType.BODY_DYNAMIC_VISUAL
      : ComponentType.BODY_DYNAMIC_HEADLESS;
    world.addComponent(entityId, bucket, rb!);
  }

  return entityId;
};

export const disposePhysicsEntity = async (entityId: number, world: ECSWorld) => {
  const rb = world.getRigidBody(entityId);
  const colls = world.getComponent(entityId, ComponentType.COLLIDER);
  if (colls) await deleteColliders(colls.map((c) => c.id));
  if (rb) await deleteRigidBody(rb.id);
};

export const getPhysicsEntityByAppId = (appId: string) => getEntityIdByAppId(appId);

/**
 * Update transform from physics
 */
export const physicsToTransformSystem = (world: ECSWorld) => {
  // We ONLY iterate over entities that are dynamic and have visuals
  const dynamicVisuals = world.getStorage(ComponentType.BODY_DYNAMIC_VISUAL);
  const transformStore = world.getTypedTransformStore();

  for (const [entityId, rb] of dynamicVisuals) {
    if (transformStore) {
      const slot = transformStore.getSlot(entityId);
      if (slot === -1) continue;
      // Direct SAB access from your Physics Proxy
      transformStore.setPosition(slot, rb.pos.x, rb.pos.y, rb.pos.z);
      transformStore.setQuaternion(slot, rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
      continue;
    }

    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (!transform) continue;

    // Direct SAB access from your Physics Proxy
    transform.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
    transform.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);

    // Mark as changed so the Render System knows to update the Mesh
    transform.setDirty();
  }
};

type InterpolationState = {
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currPos: THREE.Vector3;
  currQuat: THREE.Quaternion;
  /** performance.now() timestamps of when prev/curr were captured — only used by
   * 'RENDERER' mode's wall-clock-based alpha; 'FIXED_PHYSICS' uses the physics
   * accumulator's own alpha instead (getPhysicsInterpolationAlpha()). */
  prevTime: number;
  currTime: number;
};

// Per-entity interpolation history, keyed by entity id — allocated once per entity (on
// first sight) and mutated in place every frame, matching PhysicsTransformBuffer's
// zero-per-frame-allocation hot path. Cleaned up in registerPhysicsManager's
// onDeleteEntity hook.
const interpolationStates = new Map<number, InterpolationState>();
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

/**
 * Render-only smoothing on top of the discrete physics-step pose (Design Decision 4 of
 * docs/plans/p024_interpolation-in-the-physics-api.md): reads the same live rb.pos/rb.rot
 * physicsToTransformSystem already wrote into ECS TRANSFORM this frame, but writes the
 * blended pose only into the Object3D — TRANSFORM stays the authoritative, non-interpolated
 * pose for gameplay code (collision queries, AI, etc.). No-ops entirely for 'NONE' (the
 * default), leaving today's behavior — including object3DSyncSystem's own MAIN-stage sync —
 * completely untouched.
 */
export const physicsInterpolationSystem = (world: ECSWorld) => {
  const mode = getPhysicsState().interpolationMode;
  if (mode !== 'RENDERER' && mode !== 'FIXED_PHYSICS') return;

  const dynamicVisuals = world.getStorage(ComponentType.BODY_DYNAMIC_VISUAL);
  const now = performance.now();
  const fixedAlpha = mode === 'FIXED_PHYSICS' ? getPhysicsInterpolationAlpha() : 0;

  for (const [entityId, rb] of dynamicVisuals) {
    const obj3D = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
    if (!obj3D) continue;

    let state = interpolationStates.get(entityId);
    if (!state) {
      state = {
        prevPos: new THREE.Vector3(rb.pos.x, rb.pos.y, rb.pos.z),
        prevQuat: new THREE.Quaternion(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w),
        currPos: new THREE.Vector3(rb.pos.x, rb.pos.y, rb.pos.z),
        currQuat: new THREE.Quaternion(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w),
        prevTime: now,
        currTime: now,
      };
      interpolationStates.set(entityId, state);
    } else if (
      state.currPos.x !== rb.pos.x ||
      state.currPos.y !== rb.pos.y ||
      state.currPos.z !== rb.pos.z ||
      state.currQuat.x !== rb.rot.x ||
      state.currQuat.y !== rb.rot.y ||
      state.currQuat.z !== rb.rot.z ||
      state.currQuat.w !== rb.rot.w
    ) {
      // A new physics step's result became visible since we last looked (works the same
      // way for MAIN_THREAD's always-fresh reads and WORKER_THREAD's SAB/MESSAGE_BATCH
      // reads — this is "received", not "stepped", which is exactly Design Decision 3's
      // Option A: decoupled from physics cadence).
      state.prevPos.copy(state.currPos);
      state.prevQuat.copy(state.currQuat);
      state.prevTime = state.currTime;
      state.currPos.set(rb.pos.x, rb.pos.y, rb.pos.z);
      state.currQuat.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
      state.currTime = now;
    }

    let alpha: number;
    if (mode === 'FIXED_PHYSICS') {
      alpha = fixedAlpha;
    } else {
      const interval = state.currTime - state.prevTime;
      alpha = interval > 0 ? Math.min(1, Math.max(0, (now - state.currTime) / interval)) : 1;
    }

    scratchPos.copy(state.prevPos).lerp(state.currPos, alpha);
    scratchQuat.copy(state.prevQuat).slerp(state.currQuat, alpha);
    obj3D.position.copy(scratchPos);
    obj3D.quaternion.copy(scratchQuat);
  }
};
