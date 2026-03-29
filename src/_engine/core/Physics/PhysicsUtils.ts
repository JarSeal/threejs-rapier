import * as THREE from 'three/webgpu';
import type Rapier from '@dimforge/rapier3d-compat';

import * as RapierAPI from './EngineRapier';
import { Collider, PhysVector, RigidBody, TempContactForceEvent } from './PhysicsAPITypes';
import { Collider, Collider } from '@dimforge/rapier3d-compat';
import { LoopState } from '../MainLoop';

let curEngineObj: unknown = null;
let curEngineKey: string | null = null;

// Define the engines (key) and their init functions
const engines = {
  RAPIER: {
    init: async () => {
      const mod = await import('@dimforge/rapier3d-compat');
      const RAPIER = mod.default;
      await RAPIER.init();
      return RAPIER as typeof Rapier;
    },
    forceTypeEngine: (engineObj: unknown) => engineObj as typeof Rapier,
    engineAPI: RapierAPI,
  },
};

let curEngineAPI: EngineAPIType | null = null;

export const initPhysicsEngine = async (engineKey: PhysicsEngine) => {
  const engineFns = engines[engineKey];
  curEngineObj = await engineFns.init();
  curEngineKey = engineKey;
  curEngineAPI = engineFns.engineAPI;
  return { engine: engineFns.forceTypeEngine(curEngineObj), engineAPI: engineFns.engineAPI };
};

export const getPhysicsEngine = () => curEngineObj;
export const getPhysicsEngineKey = () => curEngineKey;
export const getEngineAPI = () => curEngineAPI;

export const getColliderShapeName = (enumNumber: number) => {
  switch (enumNumber) {
    case 0:
      return 'Ball';
    case 2:
      return 'Capsule';
    case 11:
      return 'Cone';
    case 9:
      return 'ConvexPolyhedron';
    case 1:
      return 'Cuboid';
    case 10:
      return 'Cylinder';
    case 17:
      return 'HalfSpace';
    case 7:
      return 'HeightField';
    case 4:
      return 'Polyline';
    case 15:
      return 'RoundCone';
    case 16:
      return 'RoundConvexPolyhedron';
    case 12:
      return 'RoundCuboid';
    case 14:
      return 'RoundCylinder';
    case 13:
      return 'RoundTriangle';
    case 3:
      return 'Segment';
    case 6:
      return 'TriMesh';
    case 5:
      return 'Triangle';
  }
  return '[UNKNOWN]';
};

export const isDynamicPhysicsObjectValid = (po: PhysicsObject) =>
  po.mesh &&
  po.rigidBody &&
  !po.rigidBody?.isSleeping() &&
  po.rigidBody?.isMoving() &&
  !po.rigidBody.isFixed() &&
  po.rigidBody.isEnabled();

export const setPhysicsPauseTime = (physicsState: PhysicsState) => {
  const now = performance.now();
  if (physicsState.pausedTime > 0) {
    physicsState.pauseDurationTotal += now - physicsState.pausedTime;
  }
  physicsState.pausedTime = now;
};

// TYPES: ---------------------------------------------------------------

export type PhysicsEngine = keyof typeof engines; // + possible other engines if implemented
export type PhysicsWorkerTarget = 'MAIN_THREAD' | 'WORKER_THREAD'; // + possible 'SERVER_AND_MAIN' | 'SERVER_AND_WORKER' if implemented
export type PhysicsBackgroundBehavior = 'KEEP_RUNNING' | 'KEEP_RUNNING_USE_MIN_DELTA' | 'PAUSE';

export type PhysicsState = {
  enabled: boolean;
  physicsEngine: PhysicsEngine;
  workerTarget: PhysicsWorkerTarget;
  timestep: number;
  timestepRatio: number;
  /** What to do with physics loop if the app window is hidden (under another window, in another tab, minified).
   * 'KEEP_RUNNIN' = Keeps the physics running in the background.
   * 'KEEP_RUNNING_USE_MIN_DELTA' = If for some reason the physics cannot run in the background, the minDeltaTime will be set as new delta time. Requires: minDelta > 0.
   * 'PAUSE' = Pauses the physics when the window is hidden and then uses the minDeltaTime to continue. Requires: minDelta > 0.
   */
  backgroundBehavior: PhysicsBackgroundBehavior;
  isPaused: boolean;
  /** When the physics loop is on pause (backgroundBehavior = 'PAUSE', loopState.masterPlay = false, or loopState.appPlay = false)
   * the time it was paused (performance.now()). 0 = not paused.
   */
  pausedTime: number;
  /** Total pause duration, used for the getPhysGameTime helper (in the helpers.ts) */
  pauseDurationTotal: number;
  /** Keeps track whether the pause reason is the background behavior (if the app window is hidden) */
  pauseReason: 'BACKGROUND_BEHAVIOR' | null;
  /** The minimum delta time to be used for backgroundBehaviors 'USE_MIN_DELTA' and 'PAUSE'.
   * 0 = not in use
   */
  minDeltaTime: number;
  /** Clamping protects against large delta times even in the foreground (e.g., if rendering stalls).
   * 0 = not in use
   */
  maxDeltaTime: number;
  /** This ensures stability by forcing the engine to run at least 'minSubsteps'
   * per frame even if the frame rate is extremely high and deltaTime is tiny.
   * 0 = not in use
   */
  /**  */
  minSubSteps: number;
  /** Prevent the spiral of death (should usually be the same as timestep) */
  maxSubSteps: number;
  scenes: { [sceneId: string]: ScenePhysicsState };
};

export type ScenePhysicsState = {
  worldStepEnabled: boolean;
  visualizerEnabled: boolean;
  gravity: { x: number; y: number; z: number };
  solverIterations: number;
  internalPgsIterations: number;
  interpolationEnabled: boolean;
};

export type PhysicsWorld = {
  gravity: PhysVector;
  step: () => void;
  // integrationParameters: IntegrationParameters;
  // islands: IslandManager;
  // broadPhase: BroadPhase;
  // narrowPhase: NarrowPhase;
  // bodies: RigidBodySet;
  // colliders: ColliderSet;
  // impulseJoints: ImpulseJointSet;
  // multibodyJoints: MultibodyJointSet;
  // ccdSolver: CCDSolver;
  // physicsPipeline: PhysicsPipeline;
  // serializationPipeline: SerializationPipeline;
  // debugRenderPipeline: DebugRenderPipeline;
  // characterControllers: Set<KinematicCharacterController>;
  // pidControllers: Set<PidController>;
  // vehicleControllers: Set<DynamicRayCastVehicleController>;
};

type CollisionEventFn = (
  collider1: Collider,
  collider2: Collider,
  started: boolean,
  physObj1: PhysicsObject,
  physObj2: PhysicsObject
) => void;

type ContactForceEventFn = (
  event: TempContactForceEvent,
  physObj1: PhysicsObject,
  physObj2: PhysicsObject
) => void;

export type PhysicsObject = {
  id: string;
  name?: string;
  mesh?: THREE.Mesh;
  meshes?: THREE.Mesh[];
  collider: Collider | Collider[];
  rigidBody?: RigidBody;
  hasCollisionEventFn?: boolean | boolean[];
  collisionEventFn?: CollisionEventFn | CollisionEventFn[];
  hasContactForceEventFn?: boolean | boolean[];
  contactForceEventFn?: ContactForceEventFn | ContactForceEventFn[];
  currentObjectIndex?: number;
  currentMeshIndex?: number;
  setTranslation: (
    translation: { x?: number; y?: number; z?: number; wakeUp?: boolean },
    meshGroup?: THREE.Group
  ) => void;
  setRotation: (
    rotation: { x?: number; y?: number; z?: number; w?: number; wakeUp?: boolean },
    meshGroup?: THREE.Group
  ) => void;
};

export type ScenePhysicsLooper = (delta: number) => void;

export type PhysicsParams = {
  /** Collider type and params {@link ColliderParams} */
  collider: ColliderParams;

  /** Rigid body type and params {@link RigidBodyParams} */
  rigidBody?: RigidBodyParams;

  /** Mesh id to be used in multi object importing */
  meshId?: string;
};

export type RigidBodyParams = {
  /** Type of rigid body */
  rigidType: 'FIXED' | 'DYNAMIC' | 'POS_BASED' | 'VELO_BASED';

  /** Translation (position) */
  translation?: { x: number; y: number; z: number };

  /** Rotation (position) in quaternion */
  rotation?: { x: number; y: number; z: number; w: number };

  /** Linear (translation) velocity */
  linvel?: { x: number; y: number; z: number };

  /** Angular (rotation) velocity */
  angvel?: { x: number; y: number; z: number };

  /** Gravity scale */
  gravityScale?: number;

  /** Force to be applied (constant force) */
  force?: { x: number; y: number; z: number };

  /** Torque force to be applied (constant force) */
  torqueForce?: { x: number; y: number; z: number };

  /** Force at point to be applied (constant force) */
  forceAtPoint?: {
    force: { x: number; y: number; z: number };
    point: { x: number; y: number; z: number };
  };

  /** Impulse force to be applied */
  impulse?: { x: number; y: number; z: number };

  /** Impulse torque force to be applied */
  torqueImpulse?: { x: number; y: number; z: number };

  /** Impulse at point to be applied (constant force) */
  impulseAtPoint?: {
    force: { x: number; y: number; z: number };
    point: { x: number; y: number; z: number };
  };

  /** Additional mass of the object. Rapier calculates mass = (Volume * Density) + AdditionalMass. Density is set for the collider. */
  additionalMass?: number;

  /** Translation locks */
  lockTranslations?: { x: boolean; y: boolean; z: boolean };

  /** Rotation locks */
  lockRotations?: { x: boolean; y: boolean; z: boolean };

  /** Linear damping (slowing down of movement, eg. air friction) */
  linearDamping?: number;

  /** Angular damping (slowing down of rotation, eg. air friction) */
  angularDamping?: number;

  /** Dominance group, from -127 to 127 (default 0) */
  dominance?: number;

  /** Continuous Collision Detection (CCD) enabled (default false) */
  ccdEnabled?: boolean;

  /** Soft CCD prediction distance */
  softCcdDistance?: number;

  /** Whether the body should be waken up or not (default true) */
  wakeUp?: boolean;

  /** User data to be added to the rigid body */
  userData?: { [key: string]: unknown };
};

export type ColliderParams = (
  | {
      /** Means the same thing (alias) */
      type: 'CUBOID' | 'BOX';
      hx?: number;
      hy?: number;
      hz?: number;
      borderRadius?: number;
    }
  | {
      /** Means the same thing (alias) */
      type: 'BALL' | 'SPHERE';
      radius?: number;
    }
  | {
      /** Three different shapes (they just have the same props) */
      type: 'CAPSULE' | 'CONE' | 'CYLINDER';
      halfHeight?: number;
      radius?: number;
      borderRadius?: number;
    }
  | {
      type: 'TRIANGLE';
      a: Rapier.Vector3; // @CHORE: change these to not use Rapier
      b: Rapier.Vector3;
      c: Rapier.Vector3;
      borderRadius?: number;
    }
  | {
      type: 'TRIMESH';
      vertices?: Float32Array;
      indices?: Uint32Array;
    }
  | {
      type: 'HEIGHTFIELD';
      nrows?: number;
      ncols?: number;
    }
  | {
      type: 'CONVEXHULL';
      vertices?: Float32Array;
    }
) & {
  /** Mass (default 1.0) */
  density?: number;

  /** Translation (position), only has affect if there is no rigid body */
  translation?: { x: number; y: number; z: number };

  /** Rotation (position) in quaternion, only has affect if there is no rigid body */
  rotation?: { x: number; y: number; z: number; w: number };

  /** Object's friction value, usually between 0 to 1 but can me more (default is @TODO: find out default) */
  friction?: number;

  /** How two colliding objects apply friction (default AVERAGE). The following precedence is used: MAX > MULTIPLY > MIN > AVERAGE. */
  frictionCombineRule?: 'MAX' | 'MULTIPLY' | 'MIN' | 'AVERAGE';

  /** Object restitution (bounce) value, usually between 0 to 1 but can me more (default is @TODO: find out default) */
  restitution?: number;

  /** How two colliding objects apply restitution (default AVERAGE). The following precedence is used: MAX > MULTIPLY > MIN > AVERAGE. */
  restitutionCombineRule?: 'MAX' | 'MULTIPLY' | 'MIN' | 'AVERAGE';

  /** Whether the collider is a sensor or not */
  isSensor?: boolean;

  /** Enables collision events, if collisionEventFn is defined this is enabled automatically */
  enableCollisionActiveEvents?: boolean;

  /** Enables collision events, if collisionEventFn is defined this is enabled automatically */
  enableContactForceActiveEvents?: boolean;

  /** Whether the collider has a collision event function or not */
  hasCollisionEventFn?: boolean;

  /** Creates a collision event callback, automatically sets enableCollisionActiveEvents to true for the collider */
  collisionEventFn?: (
    collider1: Collider,
    collider2: Collider,
    started: boolean,
    physObj1: PhysicsObject,
    physObj2: PhysicsObject
  ) => void;

  /** Whether the collider has a contact force event function or not */
  hasContactForceEventFn?: boolean;

  /** Creates a contact force event callback, automatically sets enableContactForceActiveEvents to true for the collider */
  contactForceEventFn?: (
    e: TempContactForceEvent,
    physObj1: PhysicsObject,
    physObj2: PhysicsObject
  ) => void;
};

/**
 * Physics Engine API, which handles the communication between
 * PhysicsAPI and EngineAPI. Each physics engine file (eg. EngineRapier.ts)
 * needs to have this signature.
 */
export type EngineAPIType = {
  createPhysicsObject: (params: {
    id: string;
    name?: string;
    physicsParams: PhysicsParams | PhysicsParams[];
    sceneId?: string;
    noWarnForUnitializedScene?: boolean;
    currentObjectIndex?: number;
    isCompoundObject?: boolean;
  }) => PhysicsObject; // @TODO: this needs to return a reduced version of PhysicsObject (no meshes or functions)
  deletePhysicsObject: (id: string) => void;
  getPhysicsObject: (id: string) => PhysicsObject;
  createPhysicsWorld: (physicsState: PhysicsState) => void;
  deletePhysicsWorld: () => void;
  stepPhysicsWorld: (loopState: LoopState) => void;
};
