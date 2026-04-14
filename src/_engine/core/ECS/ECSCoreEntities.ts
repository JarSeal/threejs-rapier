import * as THREE from 'three/webgpu';

import { ComponentType, CreateEntityOpts, ECSWorld } from '../ECS';
import {
  ColliderAPI,
  ColliderParams,
  RigidBodyAPI,
  RigidBodyParams,
} from '../Physics/PhysicsAPITypes';
import { createColliders, createRigidBody } from '../PhysicsAPI';

export type ECSPosition = { x: number; y: number; z: number };
export type ECSRotation = { x: number; y: number; z: number; w: number };

/** Engine Core Components */
export enum CoreComponentType {
  APP_ID = 'CORE_APP_ID',
  TRANSFORM = 'CORE_TRANSFORM',
  ENABLED = 'CORE_ENABLED',
  USER_DATA = 'CORE_USER_DATA',
  OBJECT3D = 'CORE_MESH',
  COLLIDER = 'CORE_COLLIDER',
  // Movement Buckets
  BODY_DYNAMIC_VISUAL = 'CORE_BODY_DYNAMIC_VISUAL', // Moving + Has Mesh
  BODY_DYNAMIC_HEADLESS = 'CORE_BODY_DYNAMIC_HEADLESS', // Moving + No Mesh
  BODY_STATIC = 'CORE_BODY_STATIC', // Never moves
  // Tags
  TAG_IS_MESH = 'CORE_TAG_IS_MESH',
  TAG_IS_GROUP = 'CORE_TAG_IS_GROUP',
  TAG_IS_LIGHT = 'CORE_TAG_IS_LIGHT',
  TAG_IS_CAMERA = 'CORE_TAG_IS_CAMERA',
  TAG_IS_CHARACTER = 'CORE_TAG_IS_CHARACTER',
  TAG_IS_PHYSICS_OBJECT = 'CORE_TAG_IS_PHYSICS_OBJECT',
}

export interface CoreComponentData {
  [CoreComponentType.APP_ID]: string;
  [CoreComponentType.TRANSFORM]: Transform;
  [CoreComponentType.ENABLED]: boolean;
  [CoreComponentType.USER_DATA]: Record<string, unknown>;
  [CoreComponentType.OBJECT3D]: THREE.Object3D;
  [CoreComponentType.COLLIDER]: ColliderAPI[];
  // Movement Buckets (rigid bodies)
  [CoreComponentType.BODY_DYNAMIC_VISUAL]: RigidBodyAPI;
  [CoreComponentType.BODY_DYNAMIC_HEADLESS]: RigidBodyAPI;
  [CoreComponentType.BODY_STATIC]: RigidBodyAPI;
  // Tags
  [CoreComponentType.TAG_IS_MESH]: boolean;
  [CoreComponentType.TAG_IS_GROUP]: boolean;
  [CoreComponentType.TAG_IS_LIGHT]: boolean;
  [CoreComponentType.TAG_IS_CAMERA]: boolean;
  [CoreComponentType.TAG_IS_CHARACTER]: boolean;
  [CoreComponentType.TAG_IS_PHYSICS_OBJECT]: boolean;
}

/** Engine Debug Components */
export enum DebugComponentType {
  DEBUG_DATA = 'DEBUG_DATA',
}

export type EntityDebugData = {
  name?: string;
  description?: string;
  comments?: { timestamp: number; comment: string }[];
  debugObj?: Record<string, unknown>;
};

export interface DebugComponentData {
  [DebugComponentType.DEBUG_DATA]: EntityDebugData;
}

/**
 * Custom Transform Class for ECS.
 * Built with a 'version' flag to optimize synchronization.
 */
export class Transform {
  readonly position = new THREE.Vector3(0, 0, 0);
  readonly quaternion = new THREE.Quaternion(0, 0, 0, 1);
  readonly scale = new THREE.Vector3(1, 1, 1);
  version = 0;

  constructor(opts?: {
    pos?: ECSPosition;
    rot?: ECSRotation;
    scale?: { x: number; y: number; z: number };
  }) {
    if (opts?.pos) this.position.set(opts.pos.x, opts.pos.y, opts.pos.z);
    if (opts?.rot) this.quaternion.set(opts.rot.x, opts.rot.y, opts.rot.z, opts.rot.w);
    if (opts?.scale) this.scale.set(opts.scale.x, opts.scale.y, opts.scale.z);
  }

  /** Call this whenever you manually change pos/rot/scale */
  setDirty() {
    this.version++;
  }

  copy(other: Transform) {
    this.position.copy(other.position);
    this.quaternion.copy(other.quaternion);
    this.scale.copy(other.scale);
    this.setDirty();
  }
}

export const createPhysicsEntity = async (
  world: ECSWorld,
  colliderParams: ColliderParams | ColliderParams[],
  rigidBodyParams?: RigidBodyParams,
  object3D?: THREE.Object3D,
  entityOpts?: CreateEntityOpts
): Promise<number> => {
  const entityId = world.createEntity(entityOpts);
  world.addComponent(entityId, ComponentType.TAG_IS_PHYSICS_OBJECT, true);

  // Create Physics (Master Source of Truth)
  let rb: RigidBodyAPI | undefined = undefined;
  if (rigidBodyParams) {
    rb = await createRigidBody(rigidBodyParams);
  }

  const paramsArray = Array.isArray(colliderParams) ? colliderParams : [colliderParams];
  if (rb) {
    for (let i = 0; i < paramsArray.length; i++) {
      paramsArray[i].parentId = rb.id;
    }
  }
  const colls: ColliderAPI[] = paramsArray.length ? await createColliders(paramsArray) : [];

  // Create ECS Transform (Local Cache)
  const transform = world.getComponent(entityId, CoreComponentType.TRANSFORM);

  if (rb) {
    // Sync Transform to initial Physics state
    transform?.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
    transform?.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
  } else if (object3D) {
    // If no physics, use where the app developer placed the mesh
    transform?.position.copy(object3D.position);
    transform?.quaternion.copy(object3D.quaternion);
    transform?.scale.copy(object3D.scale);
  }

  // We align the mesh to the transform NOW, before the loop starts.
  if (object3D) {
    if (transform) {
      object3D.position.copy(transform.position);
      object3D.quaternion.copy(transform.quaternion);
      object3D.scale.copy(transform.scale);

      // Also set the 'version' so the first loop iteration knows it's already synced
      object3D.userData._lastVersion = transform.version;
    }
    world.addComponent(entityId, ComponentType.OBJECT3D, object3D);
  }

  world.addComponent(entityId, ComponentType.COLLIDER, colls);

  // Bucket Sorting
  const isStatic = !rb || rigidBodyParams?.rigidType === 'FIXED';
  if (isStatic) {
    if (rb) world.addComponent(entityId, ComponentType.BODY_STATIC, rb);
  } else {
    const bucket = object3D
      ? ComponentType.BODY_DYNAMIC_VISUAL
      : ComponentType.BODY_DYNAMIC_HEADLESS;
    world.addComponent(entityId, bucket, rb!);
  }

  return entityId;
};
