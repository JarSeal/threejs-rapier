import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/Addons.js';

import { ColliderAPI, RigidBodyAPI } from '../Physics/PhysicsAPITypes';
import { CoreComponentType, EntityDebugData } from './ECSRegistry';
import { AppComponentData, AppComponentType } from '../../../AppECSRegistry';

export type ECSPosition = { x: number; y: number; z: number };
export type ECSRotation = { x: number; y: number; z: number; w: number };
export interface LifetimeData {
  remaining: number; // Seconds until death
  total: number; // Starting duration
}

export interface CoreComponentData {
  [CoreComponentType.APP_ID]: { id: string; isFixed: boolean };
  [CoreComponentType.TRANSFORM]: Transform;
  [CoreComponentType.DISABLED]: boolean;
  [CoreComponentType.PERSISTENT]: boolean;
  [CoreComponentType.USER_DATA]: Record<string, unknown>;
  [CoreComponentType.LIFETIME]: LifetimeData;
  [CoreComponentType.OBJECT3D]: { value: THREE.Object3D; _lastVersion: number };
  [CoreComponentType.TARGET_LINK]: { targetId: number };
  [CoreComponentType.CAMERA_SETTINGS]: {
    type: 'PERSPECTIVE' | 'ORTHOGRAPHIC';
    fov: number; // Only for Perspective
    near: number;
    far: number;
    zoom: number;
    frustumSize: number; // Only for Orthographic (Standard vertical size)
  };
  [CoreComponentType.ORBIT_CONTROLS]: {
    controls: OrbitControls;
    sceneId: string;
  };
  // Physics
  [CoreComponentType.COLLIDER]: ColliderAPI[];
  [CoreComponentType.BODY_DYNAMIC_VISUAL]: RigidBodyAPI;
  [CoreComponentType.BODY_DYNAMIC_HEADLESS]: RigidBodyAPI;
  [CoreComponentType.BODY_STATIC]: RigidBodyAPI;
  // Tags
  [CoreComponentType.TAG_IS_MESH]: boolean;
  [CoreComponentType.TAG_IS_GROUP]: boolean;
  [CoreComponentType.TAG_IS_LIGHT]: boolean;
  [CoreComponentType.TAG_IS_AMBIENT_LIGHT]: boolean;
  [CoreComponentType.TAG_IS_HEMISPHERE_LIGHT]: boolean;
  [CoreComponentType.TAG_IS_POINT_LIGHT]: boolean;
  [CoreComponentType.TAG_IS_DIRECTIONAL_LIGHT]: boolean;
  [CoreComponentType.TAG_IS_SPOT_LIGHT]: boolean;
  [CoreComponentType.TAG_IS_CAMERA]: boolean;
  [CoreComponentType.TAG_IS_MAIN_CAMERA]: boolean;
  [CoreComponentType.TAG_IS_CHARACTER]: boolean;
  [CoreComponentType.TAG_IS_PHYSICS_OBJECT]: boolean;
  // Debug
  [CoreComponentType.DEBUG_DATA]: EntityDebugData;
  [CoreComponentType.DEBUG_LIGHT_HELPER]: {
    value: THREE.PointLightHelper | THREE.DirectionalLightHelper | THREE.SpotLightHelper;
  };
  [CoreComponentType.DEBUG_CAMERA_HELPER]: { value: THREE.CameraHelper };
  [CoreComponentType.DEBUG_TAG_IS_DEBUG_CAMERA]: boolean;
}

// --- Union Types of the core components and app components for the World ---
export const ComponentType = {
  ...CoreComponentType,
  ...AppComponentType,
};
export type ComponentData = CoreComponentData & AppComponentData;

/** This just makes shit faster... */
export const OBJECT3D_TAGS = [
  { prop: 'isMesh', tag: ComponentType.TAG_IS_MESH },
  { prop: 'isGroup', tag: ComponentType.TAG_IS_GROUP },
  { prop: 'isLight', tag: ComponentType.TAG_IS_LIGHT },
  { prop: 'isCamera', tag: ComponentType.TAG_IS_CAMERA },
  { prop: 'isAmbientLight', tag: ComponentType.TAG_IS_AMBIENT_LIGHT },
  { prop: 'isHemisphereLight', tag: ComponentType.TAG_IS_HEMISPHERE_LIGHT },
  { prop: 'isPointLight', tag: ComponentType.TAG_IS_POINT_LIGHT },
  { prop: 'isDirectionalLight', tag: ComponentType.TAG_IS_DIRECTIONAL_LIGHT },
  { prop: 'isSpotLight', tag: ComponentType.TAG_IS_SPOT_LIGHT },

  // @QUESTION: What other type of Three.js Object3Ds should we tag? Points/Particles?
  // From GEMINI (ask more about the SKINNED and BONE when you get there):
  // TAG_IS_POINTS
  // TAG_IS_LINE
  // TAG_IS_SPRITE
  // TAG_IS_SKINNED
  // TAG_IS_BONE
] as const;

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

// @CHORE: move this to PhysicsAPI
// @CHORE: refactor the object3D to just use an entityId
// export const createPhysicsEntity = async (
//   colliderParams: ColliderParams | ColliderParams[],
//   rigidBodyParams?: RigidBodyParams,
//   object3D?: THREE.Object3D,
//   entityOpts?: CoreEntityOpts,
//   ecsWorld?: ECSWorld
// ): Promise<number> => {
//   const world =
//     ecsWorld || existsOrThrow(getECSWorld(), 'Could no get ECS world in createPhysicsEntity.');

//   const entityId = world.createEntity(entityOpts);
//   world.addComponent(entityId, ComponentType.TAG_IS_PHYSICS_OBJECT, true);

//   // Create Physics (Master Source of Truth)
//   let rb: RigidBodyAPI | undefined = undefined;
//   if (rigidBodyParams) {
//     rb = await createRigidBody(rigidBodyParams);
//   }

//   const paramsArray = Array.isArray(colliderParams) ? colliderParams : [colliderParams];
//   if (rb) {
//     for (let i = 0; i < paramsArray.length; i++) {
//       paramsArray[i].parentId = rb.id;
//     }
//   }

//   const colls: ColliderAPI[] = paramsArray.length ? await createColliders(paramsArray) : [];

//   // Create ECS Transform (Local Cache)
//   const transform = world.getComponent(entityId, CoreComponentType.TRANSFORM);

//   if (rb) {
//     // Sync Transform to initial Physics state
//     transform?.position.set(rb.pos.x, rb.pos.y, rb.pos.z);
//     transform?.quaternion.set(rb.rot.x, rb.rot.y, rb.rot.z, rb.rot.w);
//   } else if (object3D) {
//     // If no physics, use where the app developer placed the mesh
//     transform?.position.copy(object3D.position);
//     transform?.quaternion.copy(object3D.quaternion);
//     transform?.scale.copy(object3D.scale);
//   }

//   // We align the mesh to the transform NOW, before the loop starts.
//   if (object3D) {
//     if (transform) {
//       object3D.position.copy(transform.position);
//       object3D.quaternion.copy(transform.quaternion);
//       object3D.scale.copy(transform.scale);

//       // Also set the 'version' so the first loop iteration knows it's already synced
//       object3D.userData._lastVersion = transform.version;
//     }
//     world.addComponent(entityId, ComponentType.OBJECT3D, { value: object3D, _lastVersion: -1 });
//   }

//   world.addComponent(entityId, ComponentType.COLLIDER, colls);

//   // Bucket Sorting
//   const isStatic = !rb || rigidBodyParams?.rigidType === 'FIXED';
//   if (isStatic) {
//     if (rb) world.addComponent(entityId, ComponentType.BODY_STATIC, rb);
//   } else {
//     const bucket = object3D
//       ? ComponentType.BODY_DYNAMIC_VISUAL
//       : ComponentType.BODY_DYNAMIC_HEADLESS;
//     world.addComponent(entityId, bucket, rb!);
//   }

//   return entityId;
// };
