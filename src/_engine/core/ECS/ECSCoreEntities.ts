import * as THREE from 'three/webgpu';

import { ComponentType, ECSWorld } from '../ECS';
import {
  ColliderAPI,
  ColliderParams,
  RigidBodyAPI,
  RigidBodyParams,
} from '../Physics/PhysicsAPITypes';
import { createColliders, createRigidBody } from '../PhysicsAPI';

export type ECSPosition = { x: number; y: number; z: number };
export type ECSRotation = { x: number; y: number; z: number; w: number };

/**
 * Engine Core Components.
 * Sorted into buckets to eliminate "if" statements in the main loop.
 */
export enum CoreComponentType {
  TRANSFORM = 'CORE_TRANSFORM',
  ENABLED = 'CORE_ENABLED',
  MESH = 'CORE_MESH',
  COLLIDER = 'CORE_COLLIDER',
  // Movement Buckets
  BODY_DYNAMIC_VISUAL = 'CORE_BODY_DYNAMIC_VISUAL', // Moving + Has Mesh
  BODY_DYNAMIC_HEADLESS = 'CORE_BODY_DYNAMIC_HEADLESS', // Moving + No Mesh
  BODY_STATIC = 'CORE_BODY_STATIC', // Never moves
}

export interface CoreComponentData {
  [CoreComponentType.TRANSFORM]: Transform;
  [CoreComponentType.ENABLED]: boolean;
  [CoreComponentType.MESH]: THREE.Object3D;
  [CoreComponentType.COLLIDER]: ColliderAPI[];
  [CoreComponentType.BODY_DYNAMIC_VISUAL]: RigidBodyAPI;
  [CoreComponentType.BODY_DYNAMIC_HEADLESS]: RigidBodyAPI;
  [CoreComponentType.BODY_STATIC]: RigidBodyAPI;
}

/**
 * Custom Transform Class
 * Built with a 'version' flag to optimize synchronization.
 */
export class Transform {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly scale = new THREE.Vector3(1, 1, 1);
  version = 0;

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
  mesh?: THREE.Object3D
): Promise<number> => {
  const entityId = world.createEntity();

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
  const transform = new Transform();

  if (rb) {
    // Sync Transform to initial Physics state
    transform.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
    transform.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
  } else if (mesh) {
    // If no physics, use where the developer placed the mesh
    transform.position.copy(mesh.position);
    transform.quaternion.copy(mesh.quaternion);
    transform.scale.copy(mesh.scale);
  }

  // We align the mesh to the transform NOW, before the loop starts.
  if (mesh) {
    mesh.position.copy(transform.position);
    mesh.quaternion.copy(transform.quaternion);
    mesh.scale.copy(transform.scale);

    // Also set the 'version' so the first loop iteration knows it's already synced
    mesh.userData.lastVersion = transform.version;

    world.addComponent(entityId, ComponentType.MESH, mesh);
  }

  // Register remaining components
  world.addComponent(entityId, ComponentType.TRANSFORM, transform);
  world.addComponent(entityId, ComponentType.COLLIDER, colls);

  // Bucket Sorting
  const isStatic = !rb || rigidBodyParams?.rigidType === 'FIXED';
  if (isStatic) {
    if (rb) world.addComponent(entityId, ComponentType.BODY_STATIC, rb);
  } else {
    const bucket = mesh ? ComponentType.BODY_DYNAMIC_VISUAL : ComponentType.BODY_DYNAMIC_HEADLESS;
    world.addComponent(entityId, bucket, rb!);
  }

  return entityId;
};
