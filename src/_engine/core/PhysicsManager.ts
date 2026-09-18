import * as THREE from 'three/webgpu';

import { ECSSystemStage } from '../../AppECSRegistry';
import { CoreEntityOpts } from '../schemas/_helperSchemas';
import { existsOrThrow } from '../utils/assert';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from './ECS';
import { ComponentType } from './ECS/ECSCoreComponents';
import {
  createColliders,
  createCollidersSync,
  createRigidBody,
  createRigidBodySync,
  deleteCollidersSync,
  deleteRigidBodySync,
  getPhysicsState,
} from './PhysicsAPI';
import { ColliderParams, RigidBodyAPI, RigidBodyParams } from './Physics/PhysicsAPITypes';

export const registerPhysicsManager = (world: ECSWorld) => {
  ECSWorld.registerComponentHooks(ComponentType.TAG_IS_PHYSICS_OBJECT, {
    onDeleteEntity: (entityId, w) => disposePhysicsEntity(entityId, w),
  });
  world.addSystem(
    ECSSystemStage.APP_POST_PHYSICS,
    'physicsToTransformSystem',
    physicsToTransformSystem
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

export const disposePhysicsEntity = (entityId: number, world: ECSWorld) => {
  const rb = world.getRigidBody(entityId);
  const colls = world.getComponent(entityId, ComponentType.COLLIDER);
  if (colls) deleteCollidersSync(colls.map((c) => c.id));
  if (rb) deleteRigidBodySync(rb.id);
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
