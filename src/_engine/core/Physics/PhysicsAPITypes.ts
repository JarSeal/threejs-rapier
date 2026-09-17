import type * as THREE from 'three/webgpu';

import { ENGINES } from './ENGINES';
import { LoopState } from '../MainLoop';

export type PhysicsEngine = keyof typeof ENGINES;
export type PhysicsWorkerTarget = 'MAIN_THREAD' | 'WORKER_THREAD'; // + possible 'SERVER_AND_MAIN' | 'SERVER_AND_WORKER' if implemented
export type PhysicsBackgroundBehavior = 'KEEP_RUNNING' | 'KEEP_RUNNING_USE_MIN_DELTA' | 'PAUSE';

/**
 * Physics Engine API, which handles the communication between
 * PhysicsAPI and EngineAPI. Each physics engine file (eg. EngineRapier.ts)
 * needs to have this signature.
 */
export type EngineAPIType = {
  init: (
    physicsState: PhysicsState,
    isDebugEnvironment: boolean,
    loopState: LoopState,
    doNotCreateWorld?: boolean
  ) => WorldAPI | undefined;
  createWorld: (
    gravity: PhysVector,
    opts?: {
      timestep?: number;
      numSolverIterations?: number;
      numInternalPgsIterations?: number;
    }
  ) => WorldAPI;
  createRigidBody: (params: RigidBodyParams) => RigidBodyAPI;
  createCollider: (params: ColliderParams, parentId?: number) => ColliderAPI;
  createRigidBodies: (params: RigidBodyParams[]) => RigidBodyAPI[];
  createColliders: (params: ColliderParams[]) => ColliderAPI[];
  deleteWorld: () => { worldDeleted: boolean };
  deleteRigidBody: (id: number) => { id: number; colliderIds: number[] };
  deleteRigidBodies: (id: number[]) => { ids: number[]; colliderIds: number[] };
  deleteCollider: (id: number, wakeUp?: boolean) => { id: number };
  deleteColliders: (ids: number[], wakeUps?: boolean[]) => { ids: number[] };
  takeSnapshot: () => Uint8Array | undefined;
  restoreSnapshot: (snapshot: Uint8Array) => WorldAPI;
  getRigidBodyAPIWithId: (id: number) => RigidBodyAPI | undefined;
  getColliderAPIWithId: (id: number) => ColliderAPI | undefined;
};

export type PhysicsState = {
  enabled: boolean;
  physicsEngine: PhysicsEngine;
  workerTarget: PhysicsWorkerTarget;
  timestep: number;
  timestepRatio: number;
  /** What to do with physics loop if the app window is hidden (under another window, in another tab, minified).
   * 'KEEP_RUNNING' = Keeps the physics running in the background.
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
  worldStepEnabled: boolean;
  visualizerEnabled: boolean;
  gravity: { x: number; y: number; z: number };
  solverIterations: number;
  internalPgsIterations: number;
  interpolationEnabled: boolean;
};

export interface PhysVector {
  x: number;
  y: number;
  z: number;
}
export interface PhysRotation {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * A ray. This is a directed half-line.
 */
export type PhysRay = {
  /**
   * The starting point of the ray.
   */
  origin: PhysVector;
  /**
   * The direction of propagation of the ray.
   */
  dir: PhysVector;
};

/**
 * The intersection between a ray and a collider (includes the collider handle).
 */
export type RayColliderIntersectionAPI = {
  /**
   * The collider hit by the ray.
   */
  collider: ColliderAPI;
  /**
   * The time-of-impact of the ray with the collider.
   *
   * The hit point is obtained from the ray's origin and direction: `origin + dir * timeOfImpact`.
   */
  timeOfImpact: number;
  /**
   * The normal of the collider at the hit point.
   */
  normal: PhysVector;
  /**
   * The type of the geometric feature the point was projected on.
   */
  featureType: FeatureType;
  /**
   * The id of the geometric feature the point was projected on.
   */
  featureId: number | undefined;
};

export type RayColliderHitAPI = {
  /**
   * The handle of the collider hit by the ray.
   */
  collider: ColliderAPI;
  /**
   * The time-of-impact of the ray with the collider.
   *
   * The hit point is obtained from the ray's origin and direction: `origin + dir * timeOfImpact`.
   */
  timeOfImpact: number;
};

/**
 * The simulation status of a rigid-body.
 */
export enum RigidBodyTypeAPI {
  /**
   * A `RigidBodyType::Dynamic` body can be affected by all external forces.
   */
  Dynamic = 0,
  /**
   * A `RigidBodyType::Fixed` body cannot be affected by external forces.
   */
  Fixed = 1,
  /**
   * A `RigidBodyType::KinematicPositionBased` body cannot be affected by any external forces but can be controlled
   * by the user at the position level while keeping realistic one-way interaction with dynamic bodies.
   *
   * One-way interaction means that a kinematic body can push a dynamic body, but a kinematic body
   * cannot be pushed by anything. In other words, the trajectory of a kinematic body can only be
   * modified by the user and is independent from any contact or joint it is involved in.
   */
  KinematicPositionBased = 2,
  /**
   * A `RigidBodyType::KinematicVelocityBased` body cannot be affected by any external forces but can be controlled
   * by the user at the velocity level while keeping realistic one-way interaction with dynamic bodies.
   *
   * One-way interaction means that a kinematic body can push a dynamic body, but a kinematic body
   * cannot be pushed by anything. In other words, the trajectory of a kinematic body can only be
   * modified by the user and is independent from any contact or joint it is involved in.
   */
  KinematicVelocityBased = 3,
}

/**
 * Transforms an engine interface into a Main Thread Proxy interface.
 * - Methods returning 'void' stay 'void' (Fire-and-forget).
 * - Methods returning a value become 'Promise<value>' (Request-Response).
 */
export type PhysicsBridge<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => void
    ? (...args: A) => void // Setters stay void
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>> // Getters become Promises
      : T[K]; // Non-functions stay as-is
};

/**
 * Removes all properties and methods that end with the suffix "Sync".
 */
export type OmitSync<T> = {
  [K in keyof T as K extends `${string}Sync` ? never : K]: T[K];
};

/**
 * A rigid-body.
 */
export type RigidBodyAPI = {
  /** Rigid body id (a running integer id). */
  readonly id: number;

  // --- Hot Path (Shared Memory / Sync Access) ---
  pos: PhysVector;
  rot: PhysRotation;
  lvel: PhysVector;
  avel: PhysVector;

  isBeingDeleted: boolean;

  // --- Metadata & Validity ---
  uData: Record<string, unknown>;
  getUserData(): Promise<Record<string, unknown>>;
  getUserDataSync(): Record<string, unknown>;
  setUserData(userData?: Record<string, unknown>, addToExisting?: boolean): void;

  isValid(): Promise<boolean>;
  isValidSync(): boolean;

  // --- Transformation & Prediction ---
  translation(): PhysVector;
  rotation(): PhysRotation;

  nextTranslation(): Promise<PhysVector>;
  nextTranslationSync(): PhysVector;
  nextRotation(): Promise<PhysRotation>;
  nextRotationSync(): PhysRotation;

  setTranslation(tra: PhysVector, wakeUp: boolean): void;
  setRotation(rot: PhysRotation, wakeUp: boolean): void;

  /** For kinematic bodies: sets future transform for interpolation. */
  setNextKinematicTranslation(t: PhysVector): void;
  setNextKinematicRotation(rot: PhysRotation): void;

  // --- Mass Properties ---
  mass(): Promise<number>;
  massSync(): number;
  invMass(): Promise<number>;
  invMassSync(): number;
  effectiveInvMass(): Promise<PhysVector>;
  effectiveInvMassSync(): PhysVector;

  localCom(): Promise<PhysVector>;
  localComSync(): PhysVector;
  worldCom(): Promise<PhysVector>;
  worldComSync(): PhysVector;

  invPrincipalInertia(): Promise<PhysVector>;
  invPrincipalInertiaSync(): PhysVector;
  principalInertia(): Promise<PhysVector>;
  principalInertiaSync(): PhysVector;
  principalInertiaLocalFrame(): Promise<PhysRotation>;
  principalInertiaLocalFrameSync(): PhysRotation;

  recomputeMassPropertiesFromColliders(): void;
  setAdditionalMass(mass: number, wakeUp: boolean): void;
  setAdditionalMassProperties(
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation,
    wakeUp: boolean
  ): void;

  // --- Dynamics & Velocity ---
  linvel(): PhysVector;
  angvel(): PhysVector;
  velocityAtPoint(point: PhysVector): Promise<PhysVector>;
  velocityAtPointSync(point: PhysVector): PhysVector;

  setLinvel(vel: PhysVector, wakeUp: boolean): void;
  setAngvel(vel: PhysVector, wakeUp: boolean): void;

  gravityScale(): Promise<number>;
  gravityScaleSync(): number;
  setGravityScale(factor: number, wakeUp: boolean): void;

  linearDamping(): Promise<number>;
  linearDampingSync(): number;
  setLinearDamping(factor: number): void;
  angularDamping(): Promise<number>;
  angularDampingSync(): number;
  setAngularDamping(factor: number): void;

  // --- Forces & Impulses (Fire-and-Forget) ---
  resetForces(wakeUp: boolean): void;
  resetTorques(wakeUp: boolean): void;
  addForce(force: PhysVector, wakeUp: boolean): void;
  addTorque(torque: PhysVector, wakeUp: boolean): void;
  applyImpulse(impulse: PhysVector, wakeUp: boolean): void;
  applyTorqueImpulse(torqueImpulse: PhysVector, wakeUp: boolean): void;
  addForceAtPoint(force: PhysVector, point: PhysVector, wakeUp: boolean): void;
  applyImpulseAtPoint(impulse: PhysVector, point: PhysVector, wakeUp: boolean): void;

  userForce(): Promise<PhysVector>;
  userForceSync(): PhysVector;
  userTorque(): Promise<PhysVector>;
  userTorqueSync(): PhysVector;

  // --- Constraints & Locking ---
  lockTranslations(locked: boolean, wakeUp: boolean): void;
  lockRotations(locked: boolean, wakeUp: boolean): void;
  setEnabledTranslations(x: boolean, y: boolean, z: boolean, wakeUp: boolean): void;
  setEnabledRotations(x: boolean, y: boolean, z: boolean, wakeUp: boolean): void;

  // --- Simulation Configuration ---
  dominanceGroup(): Promise<number>;
  dominanceGroupSync(): number;
  setDominanceGroup(group: number): void;

  additionalSolverIterations(): Promise<number>;
  additionalSolverIterationsSync(): number;
  setAdditionalSolverIterations(iters: number): void;

  enableCcd(enabled: boolean): void;
  isCcdEnabled(): Promise<boolean>;
  isCcdEnabledSync(): boolean;
  setSoftCcdPrediction(distance: number): void;
  softCcdPrediction(): Promise<number>;
  softCcdPredictionSync(): number;

  // --- State & Activation ---
  sleep(): void;
  wakeUp(): void;
  isEnabled(): Promise<boolean>;
  isEnabledSync(): boolean;
  setEnabled(enabled: boolean): void;
  isSleeping(): Promise<boolean>;
  isSleepingSync(): boolean;
  isMoving(): Promise<boolean>;
  isMovingSync(): boolean;

  bodyType(): Promise<RigidBodyTypeAPI>;
  bodyTypeSync(): RigidBodyTypeAPI;
  setBodyType(type: RigidBodyTypeAPI, wakeUp: boolean): void;
  isFixed(): Promise<boolean>;
  isFixedSync(): boolean;
  isKinematic(): Promise<boolean>;
  isKinematicSync(): boolean;
  isDynamic(): Promise<boolean>;
  isDynamicSync(): boolean;

  // --- Colliders ---
  numColliders(): Promise<number>;
  numCollidersSync(): number;
  /** Returns a ColliderAPI (Proxy on Main, Real on Worker) or an ID. */
  collider(i: number): Promise<ColliderAPI | number>;
  colliderSync(i: number): ColliderAPI | number;
};

/**
 * An enumeration representing the type of a shape.
 */
export enum ShapeType {
  Ball = 0,
  Cuboid = 1,
  Capsule = 2,
  Segment = 3,
  Polyline = 4,
  Triangle = 5,
  TriMesh = 6,
  HeightField = 7,
  ConvexPolyhedron = 9,
  Cylinder = 10,
  Cone = 11,
  RoundCuboid = 12,
  RoundTriangle = 13,
  RoundCylinder = 14,
  RoundCone = 15,
  RoundConvexPolyhedron = 16,
  HalfSpace = 17,
  Voxels = 18,
}

/**
 * A geometric entity that can be attached to a body so it can be affected
 * by contacts and proximity queries.
 */
export type ColliderAPI = {
  readonly id: number;
  parentId?: number;

  isBeingDeleted: boolean;

  // --- Metadata ---
  uData: Record<string, unknown>;
  getUserData(): Promise<Record<string, unknown>>;
  getUserDataSync(): Record<string, unknown>;
  setUserData(userData?: Record<string, unknown>, addToExisting?: boolean): void;

  isValid(): Promise<boolean>;
  isValidSync(): boolean;

  // --- Transformation ---
  translation(): Promise<PhysVector>;
  translationSync(): PhysVector;
  translationWrtParent(): Promise<PhysVector | null>;
  translationWrtParentSync(): PhysVector | null;
  rotation(): Promise<PhysRotation>;
  rotationSync(): PhysRotation;
  rotationWrtParent(): Promise<PhysRotation | null>;
  rotationWrtParentSync(): PhysRotation | null;

  setTranslation(tra: PhysVector): void;
  setTranslationWrtParent(tra: PhysVector): void;
  setRotation(rot: PhysRotation): void;
  setRotationWrtParent(rot: PhysRotation): void;

  // --- Physical Properties ---
  isSensor(): Promise<boolean>;
  isSensorSync(): boolean;
  setSensor(isSensor: boolean): void;

  isEnabled(): Promise<boolean>;
  isEnabledSync(): boolean;
  setEnabled(enabled: boolean): void;

  friction(): Promise<number>;
  frictionSync(): number;
  setFriction(friction: number): void;
  restitution(): Promise<number>;
  restitutionSync(): number;
  setRestitution(restitution: number): void;

  mass(): Promise<number>;
  massSync(): number;
  density(): Promise<number>;
  densitySync(): number;
  setDensity(density: number): void;
  setMass(mass: number): void;
  setMassProperties(
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation
  ): void;

  // --- Geometry ---
  shapeType(): Promise<ShapeType>;
  shapeTypeSync(): ShapeType;
  radius(): Promise<number>;
  radiusSync(): number;
  halfHeight(): Promise<number>;
  halfHeightSync(): number;
  halfExtents(): Promise<PhysVector>;
  halfExtentsSync(): PhysVector;

  // --- Collision Filtering ---
  collisionGroups(): Promise<InteractionGroupsAPI>;
  collisionGroupsSync(): InteractionGroupsAPI;
  setCollisionGroups(groups: InteractionGroupsAPI): void;
  solverGroups(): Promise<InteractionGroupsAPI>;
  solverGroupsSync(): InteractionGroupsAPI;
  setSolverGroups(groups: InteractionGroupsAPI): void;

  // --- Spatial Queries ---
  containsPoint(point: PhysVector): Promise<boolean>;
  containsPointSync(point: PhysVector): boolean;
};

/**
 * Pairwise filtering using bit masks.
 *
 * This filtering method is based on two 16-bit values:
 * - The interaction groups (the 16 left-most bits of `self.0`).
 * - The interaction mask (the 16 right-most bits of `self.0`).
 *
 * An interaction is allowed between two filters `a` and `b` two conditions
 * are met simultaneously:
 * - The interaction groups of `a` has at least one bit set to `1` in common with the interaction mask of `b`.
 * - The interaction groups of `b` has at least one bit set to `1` in common with the interaction mask of `a`.
 * In other words, interactions are allowed between two filter iff. the following condition is met:
 *
 * ```
 * ((a >> 16) & b) != 0 && ((b >> 16) & a) != 0
 * ```
 */
export type InteractionGroupsAPI = number;

/**
 * A rule applied to combine coefficients.
 *
 * Use this when configuring the `ColliderDesc` to specify
 * how friction and restitution coefficient should be combined
 * in a contact.
 */
export enum CoefficientCombineRule {
  Average = 0,
  Min = 1,
  Multiply = 2,
  Max = 3,
}

export enum ActiveHooks {
  NONE = 0,
  FILTER_CONTACT_PAIRS = 1,
  FILTER_INTERSECTION_PAIRS = 2,
}

/**
 * Flags indicating what events are enabled for colliders.
 */
export enum ActiveEvents {
  NONE = 0,
  /**
   * Enable collision events.
   */
  COLLISION_EVENTS = 1,
  /**
   * Enable contact force events.
   */
  CONTACT_FORCE_EVENTS = 2,
}

/**
 * Flags affecting whether collision-detection happens between two colliders
 * depending on the type of rigid-bodies they are attached to.
 */
export enum ActiveCollisionTypes {
  /**
   * Enable collision-detection between a collider attached to a dynamic body
   * and another collider attached to a dynamic body.
   */
  DYNAMIC_DYNAMIC = 1,
  /**
   * Enable collision-detection between a collider attached to a dynamic body
   * and another collider attached to a kinematic body.
   */
  DYNAMIC_KINEMATIC = 12,
  /**
   * Enable collision-detection between a collider attached to a dynamic body
   * and another collider attached to a fixed body (or not attached to any body).
   */
  DYNAMIC_FIXED = 2,
  /**
   * Enable collision-detection between a collider attached to a kinematic body
   * and another collider attached to a kinematic body.
   */
  KINEMATIC_KINEMATIC = 52224,
  /**
   * Enable collision-detection between a collider attached to a kinematic body
   * and another collider attached to a fixed body (or not attached to any body).
   */
  KINEMATIC_FIXED = 8704,
  /**
   * Enable collision-detection between a collider attached to a fixed body (or
   * not attached to any body) and another collider attached to a fixed body (or
   * not attached to any body).
   */
  FIXED_FIXED = 32,
  /**
   * The default active collision types, enabling collisions between a dynamic body
   * and another body of any type, but not enabling collisions between two non-dynamic bodies.
   */
  DEFAULT = 15,
  /**
   * Enable collisions between any kind of rigid-bodies (including between two non-dynamic bodies).
   */
  ALL = 60943,
}

/**
 * The projection of a point on a collider.
 */
export type PointProjection = {
  /**
   * The projection of the point on the collider.
   */
  point: PhysVector;
  /**
   * Is the point inside of the collider?
   */
  isInside: boolean;
};

export enum FeatureType {
  Vertex = 0,
  Edge = 1,
  Face = 2,
  Unknown = 3,
}

/**
 * The intersection between a ray and a collider.
 */
export type RayIntersection = {
  /**
   * The time-of-impact of the ray with the collider.
   *
   * The hit point is obtained from the ray's origin and direction: `origin + dir * timeOfImpact`.
   */
  timeOfImpact: number;
  /**
   * The normal of the collider at the hit point.
   */
  normal: PhysVector;
  /**
   * The type of the geometric feature the point was projected on.
   */
  featureType: FeatureType;
  /**
   * The id of the geometric feature the point was projected on.
   */
  featureId: number | undefined;
};

/**
 * Event occurring when the sum of the magnitudes of the
 * contact forces between two colliders exceed a threshold.
 *
 * This object should **not** be stored anywhere. Its properties can only be
 * read from within the closure given to `EventHandler.drainContactForceEvents`.
 */
// USED TO BE (@TODO: remove this line at some point): export declare class TempContactForceEvent {
export interface TempContactForceEvent {
  /**
   * The first collider handle involved in the contact.
   */
  collider1(): number;
  /**
   * The second collider handle involved in the contact.
   */
  collider2(): number;
  /**
   * The sum of all the forces between the two colliders.
   */
  totalForce(): PhysVector;
  /**
   * The sum of the magnitudes of each force between the two colliders.
   *
   * Note that this is **not** the same as the magnitude of `self.total_force`.
   * Here we are summing the magnitude of all the forces, instead of taking
   * the magnitude of their sum.
   */
  totalForceMagnitude(): number;
  /**
   * The world-space (unit) direction of the force with strongest magnitude.
   */
  maxForceDirection(): PhysVector;
  /**
   * The magnitude of the largest force at a contact point of this contact pair.
   */
  maxForceMagnitude(): number;
}

/**
 * A structure responsible for collecting events generated
 * by the physics engine.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `eventQueue.free()`
 * once you are done using it.
 */
export type EventQueue = {
  /**
   * Release the WASM memory occupied by this event-queue.
   */
  free(): void;
  /**
   * Applies the given javascript closure on each collision event of this collector, then clear
   * the internal collision event buffer.
   *
   * @param f - JavaScript closure applied to each collision event. The
   * closure must take three arguments: two integers representing the handles of the colliders
   * involved in the collision, and a boolean indicating if the collision started (true) or stopped
   * (false).
   */
  drainCollisionEvents(f: (handle1: number, handle2: number, started: boolean) => void): void;
  /**
   * Applies the given javascript closure on each contact force event of this collector, then clear
   * the internal collision event buffer.
   *
   * @param f - JavaScript closure applied to each collision event. The
   *            closure must take one `TempContactForceEvent` argument.
   */
  drainContactForceEvents(f: (event: TempContactForceEvent) => void): void;
  /**
   * Removes all events contained by this collector
   */
  clear(): void;
};

/**
 * Flags for excluding whole sets of colliders from a scene query.
 */
export enum QueryFilterFlags {
  /**
   * Exclude from the query any collider attached to a fixed rigid-body and colliders with no rigid-body attached.
   */
  EXCLUDE_FIXED = 1,
  /**
   * Exclude from the query any collider attached to a dynamic rigid-body.
   */
  EXCLUDE_KINEMATIC = 2,
  /**
   * Exclude from the query any collider attached to a kinematic rigid-body.
   */
  EXCLUDE_DYNAMIC = 4,
  /**
   * Exclude from the query any collider that is a sensor.
   */
  EXCLUDE_SENSORS = 8,
  /**
   * Exclude from the query any collider that is not a sensor.
   */
  EXCLUDE_SOLIDS = 16,
  /**
   * Excludes all colliders not attached to a dynamic rigid-body.
   */
  ONLY_DYNAMIC = 3,
  /**
   * Excludes all colliders not attached to a kinematic rigid-body.
   */
  ONLY_KINEMATIC = 5,
  /**
   * Exclude all colliders attached to a non-fixed rigid-body
   * (this will not exclude colliders not attached to any rigid-body).
   */
  ONLY_FIXED = 6,
}

export enum SolverFlags {
  EMPTY = 0,
  COMPUTE_IMPULSE = 1,
}

export interface PhysicsHooks {
  /**
   * Function that determines if contacts computation should happen between two colliders, and how the
   * constraints solver should behave for these contacts.
   *
   * This will only be executed and taken into account if at least one of the involved colliders contains the
   * `ActiveHooks.FILTER_CONTACT_PAIR` flag in its active hooks.
   *
   * @param collider1 − Handle of the first collider involved in the potential contact.
   * @param collider2 − Handle of the second collider involved in the potential contact.
   * @param body1 − Handle of the first body involved in the potential contact.
   * @param body2 − Handle of the second body involved in the potential contact.
   */
  filterContactPair(
    collider1: number,
    collider2: number,
    body1: number,
    body2: number
  ): SolverFlags | null;
  /**
   * Function that determines if intersection computation should happen between two colliders (where at least
   * one is a sensor).
   *
   * This will only be executed and taken into account if `one of the involved colliders contains the
   * `ActiveHooks.FILTER_INTERSECTION_PAIR` flag in its active hooks.
   *
   * @param collider1 − Handle of the first collider involved in the potential contact.
   * @param collider2 − Handle of the second collider involved in the potential contact.
   * @param body1 − Handle of the first body involved in the potential contact.
   * @param body2 − Handle of the second body involved in the potential contact.
   */
  filterIntersectionPair(
    collider1: number,
    collider2: number,
    body1: number,
    body2: number
  ): boolean;
}

type CollisionEventFn = (
  collider1: ColliderAPI,
  collider2: ColliderAPI,
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
  collider: ColliderAPI | ColliderAPI[];
  rigidBody?: RigidBodyAPI;
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

export type RigidBodyParams = {
  /** Type of rigid body */
  rigidType: 'FIXED' | 'DYNAMIC' | 'POS_BASED' | 'VELO_BASED';

  /** Enabled */
  enabled?: boolean;

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
  userData?: Record<string, unknown>;
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
      a: PhysVector;
      b: PhysVector;
      c: PhysVector;
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
      scale?: PhysVector;
      heights?: Float32Array;
    }
  | {
      type: 'CONVEXHULL';
      vertices?: Float32Array;
    }
) & {
  /** Enabled (default true)  */
  enabled?: boolean;

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

  /** Do not set manually! Whether the collider has a collision event function or not */
  hasCollisionEventFn?: boolean;

  /** Creates a collision event callback, automatically sets enableCollisionActiveEvents to true for the collider */
  collisionEventFn?: (
    collider1: ColliderAPI,
    collider2: ColliderAPI,
    started: boolean,
    physObj1: PhysicsObject,
    physObj2: PhysicsObject
  ) => void;

  /** Do not set manually! Whether the collider has a contact force event function or not */
  hasContactForceEventFn?: boolean;

  /** Creates a contact force event callback, automatically sets enableContactForceActiveEvents to true for the collider */
  contactForceEventFn?: (
    e: TempContactForceEvent,
    physObj1: PhysicsObject,
    physObj2: PhysicsObject
  ) => void;

  /** User data to be added to the collider */
  userData?: Record<string, unknown>;

  /** Possible parent id (rigid body) to attach the collider to */
  parentId?: number;

  /** Do not set manually! Orientation to set for imported models (custom property "orientation: 'x' | 'z'" defines this). */
  orientation?: PhysRotation;
};

/**
 * The physics world.
 *
 * This contains all the data-structures necessary for creating and simulating
 * bodies with contacts, joints, and external forces.
 */
export type WorldAPI = {
  /** Whether the world is being restored from a snaphot or not. */
  restoringWorld: boolean;
  /** Get gravity vector */
  getGravity(): Promise<PhysVector>;
  getGravitySync(): PhysVector;
  /** Set gravity vector */
  setGravity(gravity: PhysVector): void;
  /**
   * Release the WASM memory occupied by this physics world.
   *
   * All the fields of this physics world will be freed as well,
   * so there is no need to call their `.free()` methods individually.
   */
  free(): void;
  /**
   * Takes a snapshot of this world.
   *
   * Use `World.restoreSnapshot` to create a new physics world with a state identical to
   * the state when `.takeSnapshot()` is called.
   */
  takeSnapshot(): Promise<Uint8Array | undefined>; // @CHORE: change the type to have the rb and coll data
  takeSnapshotSync(): Uint8Array | undefined; // @CHORE: change the type to have the rb and coll data
  /**
   * Creates a new physics world from a snapshot.
   *
   * This new physics world will be an identical copy of the snapshoted physics world.
   */
  restoreSnapshot(data: Uint8Array): Promise<WorldAPI>; // @CHORE: change the type to have the rb and coll data
  restoreSnapshotSync(data: Uint8Array): WorldAPI; // @CHORE: change the type to have the rb and coll data
  /**
   * Computes all the lines (and their colors) needed to render the scene.
   *
   * @param filterFlags - Flags for excluding whole subsets of colliders from rendering.
   * @param filterPredicate - Any collider for which this closure returns `false` will be excluded from the
   *                          debug rendering.
   */
  // debugRender(
  //   filterFlags?: QueryFilterFlags,
  //   filterPredicate?: (collider: Collider) => boolean
  // ): {
  //   /**
  //    * The lines to render. This is a flat array containing all the lines
  //    * to render. Each line is described as two consecutive point. Each
  //    * point is described as two (in 2D) or three (in 3D) consecutive
  //    * floats. For example, in 2D, the array: `[1, 2, 3, 4, 5, 6, 7, 8]`
  //    * describes the two segments `[[1, 2], [3, 4]]` and `[[5, 6], [7, 8]]`.
  //    */
  //   vertices: Float32Array;
  //   /**
  //    * The color buffer. There is one color per vertex, and each color
  //    * has four consecutive components (in RGBA format).
  //    */
  //   colors: Float32Array;
  // };
  /**
   * Advance the simulation by one time step.
   *
   * All events generated by the physics engine are ignored.
   *
   * @param EventQueue - (optional) structure responsible for collecting
   *   events generated by the physics engine.
   */
  // step(eventQueue?: EventQueue, hooks?: PhysicsHooks): void;
  /**
   * Update colliders positions after rigid-bodies moved.
   *
   * When a rigid-body moves, the positions of the colliders attached to it need to be updated. This update is
   * generally automatically done at the beginning and the end of each simulation step with World.step.
   * If the positions need to be updated without running a simulation step this method can be called manually.
   */
  propagateModifiedBodyPositionsToColliders(): void;
  /**
   * Get or set the timestep. Leave argument empty to get.
   *
   * The simulation timestep governs by how much the physics state of the world will
   * be integrated. A simulation timestep should:
   * - be as small as possible. Typical values evolve around 0.016 (assuming the chosen unit is milliseconds,
   * corresponds to the time between two frames of a game running at 60FPS).
   * - not vary too much during the course of the simulation. A timestep with large variations may
   * cause instabilities in the simulation.
   *
   * @param dt - The timestep length, in seconds.
   */
  getTimestep(): Promise<number>;
  getTimestepSync(): number;
  setTimestep(dt: number): void;
  /**
   * Get or set the lengthUnit. Leave argument empty to get.
   *
   * The approximate size of most dynamic objects in the scene.
   *
   * This value is used internally to estimate some length-based tolerance. In particular, the
   * values `IntegrationParameters.allowedLinearError`,
   * `IntegrationParameters.maxPenetrationCorrection`,
   * `IntegrationParameters.predictionDistance`, `RigidBodyActivation.linearThreshold`
   * are scaled by this value implicitly.
   *
   * This value can be understood as the number of units-per-meter in your physical world compared
   * to a human-sized world in meter. For example, in a 2d game, if your typical object size is 100
   * pixels, set the `[`Self::length_unit`]` parameter to 100.0. The physics engine will interpret
   * it as if 100 pixels is equivalent to 1 meter in its various internal threshold.
   * (default `1.0`).
   */
  getLengthUnit(): Promise<number>;
  getLengthUnitSync(): number;
  setLengthUnit(unitsPerMeter: number): void;
  /**
   * Get or set the numSolverIterations. Leave argument empty to get. Sets the number of solver iterations
   * run by the constraints solver for calculating forces (default: `4`).
   *
   * The greater this value is, the most rigid and realistic the physics simulation will be.
   * However a greater number of iterations is more computationally intensive.
   *
   * @param niter - The new number of solver iterations.
   */
  getNumSolverIterations(): Promise<number>;
  getNumSolverIterationsSync(): number;
  setNumSolverIterations(niter: number): void;
  /**
   * Get or set the numSolverIterations. Leave argument empty to get. Sets the Number of internal
   * Project Gauss Seidel (PGS) iterations run at each solver iteration (default: `1`).
   *
   * Increasing this parameter will improve stability of the simulation. It will have a lesser effect than
   * increasing `numSolverIterations` but is also less computationally expensive.
   *
   * @param niter - The new number of internal PGS iterations.
   */
  getNumInternalPgsIterations(): Promise<number>;
  getNumInternalPgsIterationsSync(): number;
  setNumInternalPgsIterations(niter: number): void;
  /**
   * Get or set the numSolverIterations. Leave argument empty to get. Sets the number of substeps
   * continuous collision-detection can run (default: `1`).
   *
   * CCD operates using a "motion clamping" mechanism where all fast-moving object trajectories will
   * be truncated to their first impact on their path. The number of CCD substeps beyond 1 indicate how
   * many times that trajectory will be updated and continued after a hit. This can results in smoother
   * paths, but at a significant computational cost.
   *
   * @param substeps - The new maximum number of CCD substeps. Setting to `0` disables CCD entirely.
   */
  getMaxCcdSubsteps(): Promise<number>;
  getMaxCcdSubstepsSync(): number;
  setMaxCcdSubstepsSync(substeps: number): void;
  /**
   * Creates a new rigid-body from the given rigid-body descriptor.
   *
   * @param params - The parameters of the rigid-body.
   */
  createRigidBody: (params: RigidBodyParams) => Promise<RigidBodyAPI>;
  createRigidBodySync: (params: RigidBodyParams) => RigidBodyAPI;
  /**
   * Creates a new collider.
   *
   * @param params - The parameters of the collider.
   * @param parent - The rigid-body this collider is attached to.
   */
  createCollider: (params: ColliderParams, parent?: number) => Promise<ColliderAPI>;
  createColliderSync: (params: ColliderParams, parent?: number) => ColliderAPI;
  /**
   * Retrieves a rigid-body from its handle.
   *
   * @param id - The integer handle of the rigid-body to retrieve.
   */
  getRigidBody(id: number): Promise<RigidBodyAPI | undefined>;
  getRigidBodySync(id: number): RigidBodyAPI | undefined;
  /**
   * Retrieves a collider from its handle.
   *
   * @param id - The integer handle of the collider to retrieve.
   */
  getCollider(id: number): Promise<ColliderAPI | undefined>;
  getColliderSync(id: number): ColliderAPI | undefined;
  /**
   * Removes the given rigid-body from this physics world.
   *
   * This will remove this rigid-body as well as all its attached colliders and joints.
   * Every other bodies touching or attached by joints to this rigid-body will be woken-up.
   *
   * @param bodyOrId - The rigid-body or id to remove.
   */
  removeRigidBody(bodyOrId: RigidBodyAPI | number): void;
  /**
   * Removes the given collider from this physics world.
   *
   * @param colliderOrId - The collider or id to remove.
   * @param wakeUp - If set to `true`, the rigid-body this collider is attached to will be awaken.
   */
  removeCollider(colliderOrId: ColliderAPI | number, wakeUp: boolean): void;
  /**
   * Find the closest intersection between a ray and the physics world.
   *
   * @param ray - The ray to cast.
   * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
   *   limits the length of the ray to `ray.dir.norm() * maxToi`.
   * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
   *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
   *   whereas `false` implies that all shapes are hollow for this ray-cast.
   * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
   * @param filter - The callback to filter out which collider will be hit.
   */
  castRay(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ): Promise<RayColliderHitAPI | null>;
  castRaySync(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ): RayColliderHitAPI | null;
  /**
   * Find the closest intersection between a ray and the physics world.
   *
   * This also computes the normal at the hit point.
   * @param ray - The ray to cast.
   * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
   *   limits the length of the ray to `ray.dir.norm() * maxToi`.
   * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
   *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
   *   whereas `false` implies that all shapes are hollow for this ray-cast.
   * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
   */
  castRayAndGetNormal(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ): Promise<RayColliderIntersectionAPI | null>;
  castRayAndGetNormalSync(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ): RayColliderIntersectionAPI | null;
  /**
   * Cast a ray and collects all the intersections between a ray and the scene.
   *
   * @param ray - The ray to cast.
   * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
   *   limits the length of the ray to `ray.dir.norm() * maxToi`.
   * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
   *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
   *   whereas `false` implies that all shapes are hollow for this ray-cast.
   * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
   * @param callback - The callback called once per hit (in no particular order) between a ray and a collider.
   *   If this callback returns `false`, then the cast will stop and no further hits will be detected/reported.
   */
  intersectionsWithRay(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    callback: (intersect: RayColliderIntersectionAPI) => boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ): Promise<void>;
  intersectionsWithRaySync(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    callback: (intersect: RayColliderIntersectionAPI) => boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ): void;
  /**
   * Enumerates all the colliders potentially in contact with the given collider.
   *
   * @param collider1 - The second collider involved in the contact.
   * @param f - Closure that will be called on each collider that is in contact with `collider1`.
   */
  contactPairsWith(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): Promise<void>;
  contactPairsWithSync(collider1: ColliderAPI | number, f: (collider2: ColliderAPI) => void): void;
  /**
   * Enumerates all the colliders intersecting the given colliders, assuming one of them
   * is a sensor.
   */
  intersectionPairsWith(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): Promise<void>;
  intersectionPairsWithSync(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): void;
  /**
   * Returns `true` if `collider1` and `collider2` intersect and at least one of them is a sensor.
   * @param collider1 − The first collider involved in the intersection.
   * @param collider2 − The second collider involved in the intersection.
   */
  intersectionPair(
    collider1: ColliderAPI | number,
    collider2: ColliderAPI | number
  ): Promise<boolean>;
  intersectionPairSync(collider1: ColliderAPI | number, collider2: ColliderAPI | number): boolean;
  /**
   * Creates a new character controller.
   *
   * @param offset - The artificial gap added between the character’s chape and its environment.
   */
  // createCharacterController(offset: number): KinematicCharacterController;
  /**
   * Removes a character controller from this world.
   *
   * @param controller - The character controller to remove.
   */
  // removeCharacterController(controller: KinematicCharacterController): void;
  /**
   * Creates a new PID (Proportional-Integral-Derivative) controller.
   *
   * @param kp - The Proportional gain applied to the instantaneous linear position errors.
   *             This is usually set to a multiple of the inverse of simulation step time
   *             (e.g. `60` if the delta-time is `1.0 / 60.0`).
   * @param ki - The linear gain applied to the Integral part of the PID controller.
   * @param kd - The Derivative gain applied to the instantaneous linear velocity errors.
   *             This is usually set to a value in `[0.0, 1.0]` where `0.0` implies no damping
   *             (no correction of velocity errors) and `1.0` implies complete damping (velocity errors
   *             are corrected in a single simulation step).
   * @param axes - The axes affected by this controller.
   *               Only coordinate axes with a bit flags set to `true` will be taken into
   *               account when calculating the errors and corrections.
   */
  // createPidController(kp: number, ki: number, kd: number, axes: PidAxesMask): PidController;
  /**
   * Removes a PID controller from this world.
   *
   * @param controller - The PID controller to remove.
   */
  // removePidController(controller: PidController): void;
  /**
   * Creates a new vehicle controller.
   *
   * @param chassis - The rigid-body used as the chassis of the vehicle controller. When the vehicle
   *                  controller is updated, it will change directly the rigid-body’s velocity. This
   *                  rigid-body must be a dynamic or kinematic-velocity-based rigid-body.
   */
  // createVehicleController(chassis: RigidBody): DynamicRayCastVehicleController;
  /**
   * Removes a vehicle controller from this world.
   *
   * @param controller - The vehicle controller to remove.
   */
  // removeVehicleController(controller: DynamicRayCastVehicleController): void;
  /**
   * Creates a new impulse joint from the given joint descriptor.
   *
   * @param params - The description of the joint to create.
   * @param parent1 - The first rigid-body attached to this joint.
   * @param parent2 - The second rigid-body attached to this joint.
   * @param wakeUp - Should the attached rigid-bodies be awakened?
   */
  // createImpulseJoint(
  //   params: JointData,
  //   parent1: RigidBody,
  //   parent2: RigidBody,
  //   wakeUp: boolean
  // ): ImpulseJoint;
  /**
   * Creates a new multibody joint from the given joint descriptor.
   *
   * @param params - The description of the joint to create.
   * @param parent1 - The first rigid-body attached to this joint.
   * @param parent2 - The second rigid-body attached to this joint.
   * @param wakeUp - Should the attached rigid-bodies be awakened?
   */
  // createMultibodyJoint(
  //   params: JointData,
  //   parent1: RigidBody,
  //   parent2: RigidBody,
  //   wakeUp: boolean
  // ): MultibodyJoint;
  /**
   * Retrieves an impulse joint from its handle.
   *
   * @param handle - The integer handle of the impulse joint to retrieve.
   */
  // getImpulseJoint(handle: ImpulseJointHandle): ImpulseJoint;
  /**
   * Retrieves an multibody joint from its handle.
   *
   * @param handle - The integer handle of the multibody joint to retrieve.
   */
  // getMultibodyJoint(handle: MultibodyJointHandle): MultibodyJoint;
  /**
   * Removes the given impulse joint from this physics world.
   *
   * @param joint - The impulse joint to remove.
   * @param wakeUp - If set to `true`, the rigid-bodies attached by this joint will be awaken.
   */
  // removeImpulseJoint(joint: ImpulseJoint, wakeUp: boolean): void;
  /**
   * Removes the given multibody joint from this physics world.
   *
   * @param joint - The multibody joint to remove.
   * @param wakeUp - If set to `true`, the rigid-bodies attached by this joint will be awaken.
   */
  // removeMultibodyJoint(joint: MultibodyJoint, wakeUp: boolean): void;
  /**
   * Applies the given closure to each collider managed by this physics world.
   *
   * @param f(collider) - The function to apply to each collider managed by this physics world. Called as `f(collider)`.
   */
  // forEachCollider(f: (collider: Collider) => void): void;
  /**
   * Applies the given closure to each rigid-body managed by this physics world.
   *
   * @param f(body) - The function to apply to each rigid-body managed by this physics world. Called as `f(collider)`.
   */
  // forEachRigidBody(f: (body: RigidBody) => void): void;
  /**
   * Applies the given closure to each active rigid-body managed by this physics world.
   *
   * After a short time of inactivity, a rigid-body is automatically deactivated ("asleep") by
   * the physics engine in order to save computational power. A sleeping rigid-body never moves
   * unless it is moved manually by the user.
   *
   * @param f - The function to apply to each active rigid-body managed by this physics world. Called as `f(collider)`.
   */
  // forEachActiveRigidBody(f: (body: RigidBody) => void): void;
  /**
   * Gets the handle of up to one collider intersecting the given shape.
   *
   * @param shapePos - The position of the shape used for the intersection test.
   * @param shapeRot - The orientation of the shape used for the intersection test.
   * @param shape - The shape used for the intersection test.
   * @param groups - The bit groups and filter associated to the ray, in order to only
   *   hit the colliders with collision groups compatible with the ray's group.
   */
  // intersectionWithShape(
  //   shapePos: PhysVector,
  //   shapeRot: PhysRotation,
  //   shape: Shape,
  //   filterFlags?: QueryFilterFlags,
  //   filterGroups?: InteractionGroups,
  //   filterExcludeCollider?: Collider,
  //   filterExcludeRigidBody?: RigidBody,
  //   filterPredicate?: (collider: Collider) => boolean
  // ): Collider | null;
  /**
   * Find the projection of a point on the closest collider.
   *
   * @param point - The point to project.
   * @param solid - If this is set to `true` then the collider shapes are considered to
   *   be plain (if the point is located inside of a plain shape, its projection is the point
   *   itself). If it is set to `false` the collider shapes are considered to be hollow
   *   (if the point is located inside of an hollow shape, it is projected on the shape's
   *   boundary).
   * @param groups - The bit groups and filter associated to the point to project, in order to only
   *   project on colliders with collision groups compatible with the ray's group.
   */
  // projectPoint(
  //   point: Vector,
  //   solid: boolean,
  //   filterFlags?: QueryFilterFlags,
  //   filterGroups?: InteractionGroups,
  //   filterExcludeCollider?: Collider,
  //   filterExcludeRigidBody?: RigidBody,
  //   filterPredicate?: (collider: Collider) => boolean
  // ): PointColliderProjection | null;
  /**
   * Find the projection of a point on the closest collider.
   *
   * @param point - The point to project.
   * @param groups - The bit groups and filter associated to the point to project, in order to only
   *   project on colliders with collision groups compatible with the ray's group.
   */
  // projectPointAndGetFeature(
  //   point: Vector,
  //   filterFlags?: QueryFilterFlags,
  //   filterGroups?: InteractionGroups,
  //   filterExcludeCollider?: Collider,
  //   filterExcludeRigidBody?: RigidBody,
  //   filterPredicate?: (collider: Collider) => boolean
  // ): PointColliderProjection | null;
  /**
   * Find all the colliders containing the given point.
   *
   * @param point - The point used for the containment test.
   * @param groups - The bit groups and filter associated to the point to test, in order to only
   *   test on colliders with collision groups compatible with the ray's group.
   * @param callback - A function called with the handles of each collider with a shape
   *   containing the `point`.
   */
  // intersectionsWithPoint(
  //   point: Vector,
  //   callback: (handle: Collider) => boolean,
  //   filterFlags?: QueryFilterFlags,
  //   filterGroups?: InteractionGroups,
  //   filterExcludeCollider?: Collider,
  //   filterExcludeRigidBody?: RigidBody,
  //   filterPredicate?: (collider: Collider) => boolean
  // ): void;
  /**
   * Casts a shape at a constant linear velocity and retrieve the first collider it hits.
   * This is similar to ray-casting except that we are casting a whole shape instead of
   * just a point (the ray origin).
   *
   * @param shapePos - The initial position of the shape to cast.
   * @param shapeRot - The initial rotation of the shape to cast.
   * @param shapeVel - The constant velocity of the shape to cast (i.e. the cast direction).
   * @param shape - The shape to cast.
   * @param targetDistance − If the shape moves closer to this distance from a collider, a hit
   *                         will be returned.
   * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
   *   limits the distance traveled by the shape to `shapeVel.norm() * maxToi`.
   * @param stopAtPenetration - If set to `false`, the linear shape-cast won’t immediately stop if
   *   the shape is penetrating another shape at its starting point **and** its trajectory is such
   *   that it’s on a path to exit that penetration state.
   * @param groups - The bit groups and filter associated to the shape to cast, in order to only
   *   test on colliders with collision groups compatible with this group.
   */
  // castShape(
  //   shapePos: Vector,
  //   shapeRot: Rotation,
  //   shapeVel: Vector,
  //   shape: Shape,
  //   targetDistance: number,
  //   maxToi: number,
  //   stopAtPenetration: boolean,
  //   filterFlags?: QueryFilterFlags,
  //   filterGroups?: InteractionGroups,
  //   filterExcludeCollider?: Collider,
  //   filterExcludeRigidBody?: RigidBody,
  //   filterPredicate?: (collider: Collider) => boolean
  // ): ColliderShapeCastHit | null;
  /**
   * Retrieve all the colliders intersecting the given shape.
   *
   * @param shapePos - The position of the shape to test.
   * @param shapeRot - The orientation of the shape to test.
   * @param shape - The shape to test.
   * @param groups - The bit groups and filter associated to the shape to test, in order to only
   *   test on colliders with collision groups compatible with this group.
   * @param callback - A function called with the handles of each collider intersecting the `shape`.
   */
  // intersectionsWithShape(
  //   shapePos: Vector,
  //   shapeRot: Rotation,
  //   shape: Shape,
  //   callback: (collider: Collider) => boolean,
  //   filterFlags?: QueryFilterFlags,
  //   filterGroups?: InteractionGroups,
  //   filterExcludeCollider?: Collider,
  //   filterExcludeRigidBody?: RigidBody,
  //   filterPredicate?: (collider: Collider) => boolean
  // ): void;
  /**
   * Finds the handles of all the colliders with an AABB intersecting the given AABB.
   *
   * @param aabbCenter - The center of the AABB to test.
   * @param aabbHalfExtents - The half-extents of the AABB to test.
   * @param callback - The callback that will be called with the handles of all the colliders
   *                   currently intersecting the given AABB.
   */
  // collidersWithAabbIntersectingAabb(
  //   aabbCenter: Vector,
  //   aabbHalfExtents: Vector,
  //   callback: (handle: Collider) => boolean
  // ): void;
  /**
   * Iterates through all the contact manifolds between the given pair of colliders.
   *
   * @param collider1 - The first collider involved in the contact.
   * @param collider2 - The second collider involved in the contact.
   * @param f - Closure that will be called on each contact manifold between the two colliders. If the second argument
   *            passed to this closure is `true`, then the contact manifold data is flipped, i.e., methods like `localNormal1`
   *            actually apply to the `collider2` and fields like `localNormal2` apply to the `collider1`.
   */
  // contactPair(
  //   collider1: Collider,
  //   collider2: Collider,
  //   f: (manifold: TempContactManifold, flipped: boolean) => void
  // ): void;
  /**
   * Sets whether internal performance profiling is enabled (default: false).
   *
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // set profilerEnabled(enabled: boolean);
  /**
   * Indicates if the internal performance profiling is enabled.
   *
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // get profilerEnabled(): boolean;
  /**
   * The time spent in milliseconds by the last step to run the entire simulation step.
   *
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingStep(): number;
  /**
   * The time spent in milliseconds by the last step to run the collision-detection
   * (broad-phase + narrow-phase).
   *
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingCollisionDetection(): number;
  /**
   * The time spent in milliseconds by the last step to run the broad-phase.
   *
   * This timing is included in `timingCollisionDetection`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingBroadPhase(): number;
  /**
   * The time spent in milliseconds by the last step to run the narrow-phase.
   *
   * This timing is included in `timingCollisionDetection`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingNarrowPhase(): number;
  /**
   * The time spent in milliseconds by the last step to run the constraint solver.
   *
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingSolver(): number;
  /**
   * The time spent in milliseconds by the last step to run the constraint
   * initialization.
   *
   * This timing is included in `timingSolver`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingVelocityAssembly(): number;
  /**
   * The time spent in milliseconds by the last step to run the constraint
   * resolution.
   *
   * This timing is included in `timingSolver`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingVelocityResolution(): number;
  /**
   * The time spent in milliseconds by the last step to run the rigid-body
   * velocity update.
   *
   * This timing is included in `timingSolver`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingVelocityUpdate(): number;
  /**
   * The time spent in milliseconds by writing rigid-body velocities
   * calculated by the solver back into the rigid-bodies.
   *
   * This timing is included in `timingSolver`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingVelocityWriteback(): number;
  /**
   * The total time spent in CCD detection and resolution.
   *
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingCcd(): number;
  /**
   * The total time spent searching for the continuous hits during CCD.
   *
   * This timing is included in `timingCcd`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingCcdToiComputation(): number;
  /**
   * The total time spent in the broad-phase during CCD.
   *
   * This timing is included in `timingCcd`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingCcdBroadPhase(): number;
  /**
   * The total time spent in the narrow-phase during CCD.
   *
   * This timing is included in `timingCcd`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingCcdNarrowPhase(): number;
  /**
   * The total time spent in the constraints resolution during CCD.
   *
   * This timing is included in `timingCcd`.
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingCcdSolver(): number;
  /**
   * The total time spent in the islands calculation during CCD.
   *
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingIslandConstruction(): number;
  /**
   * The total time spent propagating detected user changes.
   *
   * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
   */
  // timingUserChanges(): number;
};

export type WorldProxyAPIType = OmitSync<WorldAPI>;
export type RigidBodyWorkerEngine = OmitSync<RigidBodyAPI>;
export type ColliderProxyAPIType = PhysicsBridge<ColliderAPI>;

/** Physics worker UP protocol (from main thread to worker) */
export type PhysicsUpProtocol =
  // Engine --------------------------------------
  (
    | {
        type: PhysicsProtocolType.TAKE_SNAPSHOT;
      }
    | {
        type: PhysicsProtocolType.RESTORE_SNAPSHOT;
        snapshot: Uint8Array;
      }
    | {
        type: PhysicsProtocolType.INIT_PHYSICS;
        physicsState: PhysicsState;
        isDebugEnvironment: boolean;
        loopState: LoopState;
        doNotCreateWorld?: boolean;
      }
    // World --------------------------------------
    | {
        type: PhysicsProtocolType.CREATE_WORLD;
        gravity: PhysVector;
        opts?: {
          timestep?: number;
          numSolverIterations?: number;
          numInternalPgsIterations?: number;
        };
      }
    | { type: PhysicsProtocolType.DELETE_WORLD }
    | { type: PhysicsProtocolType.WORLD_GET_GRAVITY }
    | { type: PhysicsProtocolType.WORLD_SET_GRAVITY; gravity: PhysVector }
    | {
        type: PhysicsProtocolType.WORLD_FREE;
      }
    | {
        type: PhysicsProtocolType.WORLD_PROPAGATE_POSITIONS;
      }
    | { type: PhysicsProtocolType.WORLD_GET_TIMESTEP }
    | {
        type: PhysicsProtocolType.WORLD_SET_TIMESTEP;
        dt: number;
      }
    | { type: PhysicsProtocolType.WORLD_GET_LENGTH_UNIT }
    | {
        type: PhysicsProtocolType.WORLD_SET_LENGTH_UNIT;
        unitsPerMeter: number;
      }
    | { type: PhysicsProtocolType.WORLD_GET_SOLVER_ITERS }
    | {
        type: PhysicsProtocolType.WORLD_SET_SOLVER_ITERS;
        niter: number;
      }
    | { type: PhysicsProtocolType.WORLD_GET_PGS_ITERS }
    | {
        type: PhysicsProtocolType.WORLD_SET_PGS_ITERS;
        niter: number;
      }
    | { type: PhysicsProtocolType.WORLD_GET_CCD_SUBSTEPS }
    | { type: PhysicsProtocolType.WORLD_SET_CCD_SUBSTEPS; substeps: number }
    // World queries --------------------------------------
    | {
        type: PhysicsProtocolType.WORLD_CAST_RAY;
        ray: PhysRay;
        maxToi: number;
        solid: boolean;
        filterFlags?: QueryFilterFlags;
        filterGroups?: InteractionGroupsAPI;
        filterExcludeCollider?: number;
        filterExcludeRigidBody?: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL;
        ray: PhysRay;
        maxToi: number;
        solid: boolean;
        filterFlags?: QueryFilterFlags;
        filterGroups?: InteractionGroupsAPI;
        filterExcludeCollider?: number;
        filterExcludeRigidBody?: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_INTERSECTIONS_WITH_RAY;
        ray: PhysRay;
        maxToi: number;
        solid: boolean;
        filterFlags?: QueryFilterFlags;
        filterGroups?: InteractionGroupsAPI;
        filterExcludeCollider?: number;
        filterExcludeRigidBody?: number;
      }
    | { type: PhysicsProtocolType.WORLD_CONTACT_PAIRS_WITH; colliderId: number }
    | { type: PhysicsProtocolType.WORLD_INTERSECTION_PAIRS_WITH; colliderId: number }
    | {
        type: PhysicsProtocolType.WORLD_INTERSECTION_PAIR;
        colliderId1: number;
        colliderId2: number;
      }
    // RigidBody --------------------------------------
    | { type: PhysicsProtocolType.CREATE_RIGID_BODY; params: RigidBodyParams }
    | { type: PhysicsProtocolType.CREATE_RIGID_BODIES; params: RigidBodyParams[] }
    | { type: PhysicsProtocolType.DELETE_RIGID_BODY; id: number }
    | { type: PhysicsProtocolType.DELETE_RIGID_BODIES; ids: number[] }
    | { type: PhysicsProtocolType.RIGID_GET_USERDATA; rigidBodyId: number }
    | {
        type: PhysicsProtocolType.RIGID_SET_USERDATA;
        rigidBodyId: number;
        userData: Record<string, unknown>;
        addToExisting?: boolean;
      }
    | { type: PhysicsProtocolType.RIGID_IS_VALID; rigidBodyId: number }
    | {
        type: PhysicsProtocolType.RIGID_LOCK_TRANSLATIONS;
        rigidBodyId: number;
        locked: boolean;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_LOCK_ROTATIONS;
        rigidBodyId: number;
        locked: boolean;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_SET_ENABLED_TRANSLATIONS;
        rigidBodyId: number;
        enableX: boolean;
        enableY: boolean;
        enableZ: boolean;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_SET_ENABLED_ROTATIONS;
        rigidBodyId: number;
        enableX: boolean;
        enableY: boolean;
        enableZ: boolean;
        wakeUp: boolean;
      }
    | { type: PhysicsProtocolType.RIGID_DOMINANCE_GROUP; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_SET_DOMINANCE_GROUP; group: number; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_ADDITIONAL_SOLVER_ITERATIONS; rigidBodyId: number }
    | {
        type: PhysicsProtocolType.RIGID_SET_ADDITIONAL_SOLVER_ITERATIONS;
        iters: number;
        rigidBodyId: number;
      }
    | { type: PhysicsProtocolType.RIGID_ENABLE_CCD; enabled: boolean; rigidBodyId: number }
    | {
        type: PhysicsProtocolType.RIGID_SET_SOFT_CCD_PREDICTION;
        distance: number;
        rigidBodyId: number;
      }
    | { type: PhysicsProtocolType.RIGID_SOFT_CCD_PREDICTION; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_TRANSLATION; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_ROTATION; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_NEXT_TRANSLATION; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_NEXT_ROTATION; rigidBodyId: number }
    | {
        type: PhysicsProtocolType.RIGID_SET_TRANSLATION;
        tra: PhysVector;
        wakeUp: boolean;
        rigidBodyId: number;
      }
    | {
        type: PhysicsProtocolType.RIGID_SET_LINVEL;
        vel: PhysVector;
        wakeUp: boolean;
        rigidBodyId: number;
      }
    | { type: PhysicsProtocolType.RIGID_GRAVITY_SCALE; rigidBodyId: number }
    | {
        type: PhysicsProtocolType.RIGID_SET_GRAVITY_SCALE;
        factor: number;
        wakeUp: boolean;
        rigidBodyId: number;
      }
    | {
        type: PhysicsProtocolType.RIGID_SET_ROTATION;
        rot: PhysRotation;
        wakeUp: boolean;
        rigidBodyId: number;
      }
    | {
        type: PhysicsProtocolType.RIGID_SET_ANGVEL;
        vel: PhysVector;
        wakeUp: boolean;
        rigidBodyId: number;
      }
    | {
        type: PhysicsProtocolType.RIGID_SET_NEXT_KINEMATIC_TRANSLATION;
        t: PhysVector;
        rigidBodyId: number;
      }
    | {
        type: PhysicsProtocolType.RIGID_SET_NEXT_KINEMATIC_ROTATION;
        rot: PhysRotation;
        rigidBodyId: number;
      }
    | { type: PhysicsProtocolType.RIGID_LINVEL; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_VELOCITY_AT_POINT; point: PhysVector; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_ANGVEL; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_MASS; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_EFFECTIVE_INV_MASS; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_INV_MASS; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_LOCAL_COM; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_WORLD_COM; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_INV_PRINCIPAL_INERTIA; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA_LOCAL_FRAME; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_SLEEP; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_WAKE_UP; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_IS_CCD_ENABLED; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_NUM_COLLIDERS; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_COLLIDER; rigidBodyId: number; index: number }
    | { type: PhysicsProtocolType.RIGID_SET_ENABLED; rigidBodyId: number; enabled: boolean }
    | { type: PhysicsProtocolType.RIGID_IS_ENABLED; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_BODY_TYPE; rigidBodyId: number }
    | {
        type: PhysicsProtocolType.RIGID_SET_BODY_TYPE;
        rigidBodyId: number;
        bodyType: RigidBodyTypeAPI;
        wakeUp: boolean;
      }
    | { type: PhysicsProtocolType.RIGID_IS_SLEEPING; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_IS_MOVING; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_IS_FIXED; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_IS_KINEMATIC; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_IS_DYNAMIC; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_LINEAR_DAMPING; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_ANGULAR_DAMPING; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_SET_LINEAR_DAMPING; rigidBodyId: number; factor: number }
    | { type: PhysicsProtocolType.RIGID_SET_ANGULAR_DAMPING; rigidBodyId: number; factor: number }
    | { type: PhysicsProtocolType.RIGID_RECOMPUTE_MASS_PROPERTIES; rigidBodyId: number }
    | {
        type: PhysicsProtocolType.RIGID_SET_ADDITIONAL_MASS;
        rigidBodyId: number;
        mass: number;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_SET_ADDITIONAL_MASS_PROPERTIES;
        rigidBodyId: number;
        mass: number;
        centerOfMass: PhysVector;
        principalAngularInertia: PhysVector;
        angularInertiaLocalFrame: PhysRotation;
        wakeUp: boolean;
      }
    | { type: PhysicsProtocolType.RIGID_RESET_FORCES; rigidBodyId: number; wakeUp: boolean }
    | { type: PhysicsProtocolType.RIGID_RESET_TORQUES; rigidBodyId: number; wakeUp: boolean }
    | {
        type: PhysicsProtocolType.RIGID_ADD_FORCE;
        rigidBodyId: number;
        force: PhysVector;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_APPLY_IMPULSE;
        rigidBodyId: number;
        impulse: PhysVector;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_ADD_TORQUE;
        rigidBodyId: number;
        torque: PhysVector;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_APPLY_TORQUE_IMPULSE;
        rigidBodyId: number;
        torqueImpulse: PhysVector;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_ADD_FORCE_AT_POINT;
        rigidBodyId: number;
        force: PhysVector;
        point: PhysVector;
        wakeUp: boolean;
      }
    | {
        type: PhysicsProtocolType.RIGID_APPLY_IMPULSE_AT_POINT;
        rigidBodyId: number;
        impulse: PhysVector;
        point: PhysVector;
        wakeUp: boolean;
      }
    | { type: PhysicsProtocolType.RIGID_USER_FORCE; rigidBodyId: number }
    | { type: PhysicsProtocolType.RIGID_USER_TORQUE; rigidBodyId: number }
    // Collider --------------------------------------
    | { type: PhysicsProtocolType.CREATE_COLLIDER; params: ColliderParams; parentId?: number }
    | { type: PhysicsProtocolType.CREATE_COLLIDERS; params: ColliderParams[]; parentIds?: number[] }
    | { type: PhysicsProtocolType.DELETE_COLLIDER; id: number; wakeUp: boolean }
    | { type: PhysicsProtocolType.DELETE_COLLIDERS; ids: number[]; wakeUps: boolean[] }
    | { type: PhysicsProtocolType.COLL_GET_USERDATA; colliderId: number }
    | {
        type: PhysicsProtocolType.COLL_SET_USERDATA;
        colliderId: number;
        userData: Record<string, unknown>;
        addToExisting?: boolean;
      }
    | { type: PhysicsProtocolType.COLL_IS_VALID; colliderId: number }
    | { type: PhysicsProtocolType.COLL_TRANSLATION; colliderId: number }
    | { type: PhysicsProtocolType.COLL_ROTATION; colliderId: number }
    | { type: PhysicsProtocolType.COLL_TRANSLATION_WRT_PARENT; colliderId: number }
    | { type: PhysicsProtocolType.COLL_ROTATION_WRT_PARENT; colliderId: number }
    | { type: PhysicsProtocolType.COLL_SET_TRANSLATION; colliderId: number; tra: PhysVector }
    | { type: PhysicsProtocolType.COLL_SET_ROTATION; colliderId: number; rot: PhysRotation }
    | {
        type: PhysicsProtocolType.COLL_SET_TRANSLATION_WRT_PARENT;
        colliderId: number;
        tra: PhysVector;
      }
    | {
        type: PhysicsProtocolType.COLL_SET_ROTATION_WRT_PARENT;
        colliderId: number;
        rot: PhysRotation;
      }
    | { type: PhysicsProtocolType.COLL_IS_SENSOR; colliderId: number }
    | { type: PhysicsProtocolType.COLL_SET_SENSOR; colliderId: number; isSensor: boolean }
    | { type: PhysicsProtocolType.COLL_IS_ENABLED; colliderId: number }
    | { type: PhysicsProtocolType.COLL_SET_ENABLED; colliderId: number; enabled: boolean }
    | { type: PhysicsProtocolType.COLL_FRICTION; colliderId: number }
    | { type: PhysicsProtocolType.COLL_SET_FRICTION; colliderId: number; friction: number }
    | { type: PhysicsProtocolType.COLL_RESTITUTION; colliderId: number }
    | { type: PhysicsProtocolType.COLL_SET_RESTITUTION; colliderId: number; restitution: number }
    | { type: PhysicsProtocolType.COLL_MASS; colliderId: number }
    | { type: PhysicsProtocolType.COLL_DENSITY; colliderId: number }
    | { type: PhysicsProtocolType.COLL_SET_DENSITY; colliderId: number; density: number }
    | { type: PhysicsProtocolType.COLL_SET_MASS; colliderId: number; mass: number }
    | {
        type: PhysicsProtocolType.COLL_SET_MASS_PROPERTIES;
        colliderId: number;
        mass: number;
        centerOfMass: PhysVector;
        principalAngularInertia: PhysVector;
        angularInertiaLocalFrame: PhysRotation;
      }
    | { type: PhysicsProtocolType.COLL_SHAPE_TYPE; colliderId: number }
    | { type: PhysicsProtocolType.COLL_RADIUS; colliderId: number }
    | { type: PhysicsProtocolType.COLL_HALF_HEIGHT; colliderId: number }
    | { type: PhysicsProtocolType.COLL_HALF_EXTENTS; colliderId: number }
    | { type: PhysicsProtocolType.COLL_COLLISION_GROUPS; colliderId: number }
    | {
        type: PhysicsProtocolType.COLL_SET_COLLISION_GROUPS;
        colliderId: number;
        groups: InteractionGroupsAPI;
      }
    | { type: PhysicsProtocolType.COLL_SOLVER_GROUPS; colliderId: number }
    | {
        type: PhysicsProtocolType.COLL_SET_SOLVER_GROUPS;
        colliderId: number;
        groups: InteractionGroupsAPI;
      }
    | { type: PhysicsProtocolType.COLL_CONTAINS_POINT; colliderId: number; point: PhysVector }
  ) & { requestId?: number; isOneWay?: boolean };

/** Physics worker DOWN protocol (from worker to main thread) */
export type PhysicsDownProtocol =
  // Engine --------------------------------------
  (
    | {
        type: PhysicsProtocolType.TAKE_SNAPSHOT;
        snapshot: Uint8Array | undefined;
      }
    | {
        type: PhysicsProtocolType.RESTORE_SNAPSHOT;
        worldCreated: boolean;
      }
    | {
        type: PhysicsProtocolType.INIT_PHYSICS;
        worldCreated: boolean;
      }
    // World --------------------------------------
    | { type: PhysicsProtocolType.CREATE_WORLD; worldCreated: boolean }
    | { type: PhysicsProtocolType.DELETE_WORLD; worldDeleted: boolean }
    | {
        type: PhysicsProtocolType.WORLD_GET_GRAVITY;
        gravity: PhysVector;
      }
    | {
        type: PhysicsProtocolType.WORLD_GET_TIMESTEP;
        dt: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_GET_LENGTH_UNIT;
        unitsPerMeter: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_GET_SOLVER_ITERS;
        solverIterations: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_GET_PGS_ITERS;
        internalPgsIterations: number;
      }
    | { type: PhysicsProtocolType.WORLD_GET_CCD_SUBSTEPS; substeps: number }
    // World query Results --------------------------------------
    | {
        type: PhysicsProtocolType.WORLD_CAST_RAY;
        hit: (Omit<RayColliderHitAPI, 'collider'> & { collider: number }) | null;
      }
    | {
        type: PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL;
        intersection: (Omit<RayColliderIntersectionAPI, 'collider'> & { collider: number }) | null;
      }
    | {
        type: PhysicsProtocolType.WORLD_INTERSECTIONS_WITH_RAY;
        intersections: (Omit<RayColliderIntersectionAPI, 'collider'> & { collider: number })[];
      }
    | { type: PhysicsProtocolType.WORLD_CONTACT_PAIRS_WITH; colliderIds: number[] }
    | { type: PhysicsProtocolType.WORLD_INTERSECTION_PAIRS_WITH; colliderIds: number[] }
    | { type: PhysicsProtocolType.WORLD_INTERSECTION_PAIR; isIntersecting: boolean }
    // Rigid body --------------------------------------
    | { type: PhysicsProtocolType.CREATE_RIGID_BODY; id: number }
    | { type: PhysicsProtocolType.CREATE_RIGID_BODIES; ids: number[] }
    | { type: PhysicsProtocolType.DELETE_RIGID_BODY; id: number; colliderIds: number[] }
    | { type: PhysicsProtocolType.DELETE_RIGID_BODIES; ids: number[]; colliderIds: number[] }
    | { type: PhysicsProtocolType.RIGID_GET_USERDATA; userData: Record<string, unknown> }
    | { type: PhysicsProtocolType.RIGID_IS_VALID; isValid: boolean }
    | { type: PhysicsProtocolType.RIGID_DOMINANCE_GROUP; dominanceGroup: number }
    | { type: PhysicsProtocolType.RIGID_ADDITIONAL_SOLVER_ITERATIONS; additionalIterations: number }
    | { type: PhysicsProtocolType.RIGID_SOFT_CCD_PREDICTION; softCcdPrediction: number }
    | { type: PhysicsProtocolType.RIGID_TRANSLATION; translation: PhysVector }
    | { type: PhysicsProtocolType.RIGID_ROTATION; rotation: PhysRotation }
    | { type: PhysicsProtocolType.RIGID_NEXT_TRANSLATION; nextTranslation: PhysVector }
    | { type: PhysicsProtocolType.RIGID_NEXT_ROTATION; nextRotation: PhysRotation }
    | { type: PhysicsProtocolType.RIGID_GRAVITY_SCALE; gravityScale: number }
    | { type: PhysicsProtocolType.RIGID_LINVEL; linvel: PhysVector }
    | { type: PhysicsProtocolType.RIGID_VELOCITY_AT_POINT; velocityAtPoint: PhysVector }
    | { type: PhysicsProtocolType.RIGID_ANGVEL; angvel: PhysVector }
    | { type: PhysicsProtocolType.RIGID_MASS; mass: number }
    | { type: PhysicsProtocolType.RIGID_EFFECTIVE_INV_MASS; effectiveInvMass: PhysVector }
    | { type: PhysicsProtocolType.RIGID_INV_MASS; invMass: number }
    | { type: PhysicsProtocolType.RIGID_LOCAL_COM; localCom: PhysVector }
    | { type: PhysicsProtocolType.RIGID_WORLD_COM; worldCom: PhysVector }
    | { type: PhysicsProtocolType.RIGID_INV_PRINCIPAL_INERTIA; invPrincipalInertia: PhysVector }
    | { type: PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA; principalInertia: PhysVector }
    | {
        type: PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA_LOCAL_FRAME;
        principalInertiaLocalFrame: PhysRotation;
      }
    | { type: PhysicsProtocolType.RIGID_IS_CCD_ENABLED; isCcdEnabled: boolean }
    | { type: PhysicsProtocolType.RIGID_NUM_COLLIDERS; numColliders: number }
    | { type: PhysicsProtocolType.RIGID_COLLIDER; colliderId: number }
    | { type: PhysicsProtocolType.RIGID_IS_ENABLED; isEnabled: boolean }
    | { type: PhysicsProtocolType.RIGID_BODY_TYPE; bodyType: RigidBodyTypeAPI }
    | { type: PhysicsProtocolType.RIGID_IS_SLEEPING; isSleeping: boolean }
    | { type: PhysicsProtocolType.RIGID_IS_MOVING; isMoving: boolean }
    | { type: PhysicsProtocolType.RIGID_IS_FIXED; isFixed: boolean }
    | { type: PhysicsProtocolType.RIGID_IS_KINEMATIC; isKinematic: boolean }
    | { type: PhysicsProtocolType.RIGID_IS_DYNAMIC; isDynamic: boolean }
    | { type: PhysicsProtocolType.RIGID_LINEAR_DAMPING; linearDamping: number }
    | { type: PhysicsProtocolType.RIGID_ANGULAR_DAMPING; angularDamping: number }
    | { type: PhysicsProtocolType.RIGID_USER_FORCE; userForce: PhysVector }
    | { type: PhysicsProtocolType.RIGID_USER_TORQUE; userTorque: PhysVector }
    // Collider --------------------------------------
    | { type: PhysicsProtocolType.CREATE_COLLIDER; id: number; parentId?: number }
    | { type: PhysicsProtocolType.CREATE_COLLIDERS; ids: number[]; parentIds?: number[] }
    | { type: PhysicsProtocolType.DELETE_COLLIDER; id: number }
    | { type: PhysicsProtocolType.DELETE_COLLIDERS; ids: number[] }
    | { type: PhysicsProtocolType.COLL_GET_USERDATA; userData: Record<string, unknown> }
    | { type: PhysicsProtocolType.COLL_IS_VALID; isValid: boolean }
    | { type: PhysicsProtocolType.COLL_TRANSLATION; translation: PhysVector }
    | { type: PhysicsProtocolType.COLL_ROTATION; rotation: PhysRotation }
    | { type: PhysicsProtocolType.COLL_TRANSLATION_WRT_PARENT; translation: PhysVector | null }
    | { type: PhysicsProtocolType.COLL_ROTATION_WRT_PARENT; rotation: PhysRotation | null }
    | { type: PhysicsProtocolType.COLL_IS_SENSOR; isSensor: boolean }
    | { type: PhysicsProtocolType.COLL_IS_ENABLED; isEnabled: boolean }
    | { type: PhysicsProtocolType.COLL_FRICTION; friction: number }
    | { type: PhysicsProtocolType.COLL_RESTITUTION; restitution: number }
    | { type: PhysicsProtocolType.COLL_MASS; mass: number }
    | { type: PhysicsProtocolType.COLL_DENSITY; density: number }
    | { type: PhysicsProtocolType.COLL_SHAPE_TYPE; shapeType: ShapeType }
    | { type: PhysicsProtocolType.COLL_RADIUS; radius: number }
    | { type: PhysicsProtocolType.COLL_HALF_HEIGHT; halfHeight: number }
    | { type: PhysicsProtocolType.COLL_HALF_EXTENTS; halfExtents: PhysVector }
    | { type: PhysicsProtocolType.COLL_COLLISION_GROUPS; groups: InteractionGroupsAPI }
    | { type: PhysicsProtocolType.COLL_SOLVER_GROUPS; groups: InteractionGroupsAPI }
    | { type: PhysicsProtocolType.COLL_CONTAINS_POINT; isInside: boolean }
    // Error --------------------------------------
    | {
        type: PhysicsProtocolType.ERROR;
        message: string;
      }
  ) & { requestId?: number };

/**
 * Helper utility to extract a specific sub-type from the protocol union
 */
type PhysicsResponse<T extends PhysicsProtocolType> = Extract<PhysicsDownProtocol, { type: T }>;

// --- Extracted Sub-types ---
// Engine
export type InitPhysicsResponse = PhysicsResponse<PhysicsProtocolType.INIT_PHYSICS>;
export type TakeSnapshotResponse = PhysicsResponse<PhysicsProtocolType.TAKE_SNAPSHOT>;
export type RestoreSnapshotResponse = PhysicsResponse<PhysicsProtocolType.RESTORE_SNAPSHOT>;
export type ErrorResponse = PhysicsResponse<PhysicsProtocolType.ERROR>;
// World
export type CreateWorldResponse = PhysicsResponse<PhysicsProtocolType.CREATE_WORLD>;
export type DeleteWorldResponse = PhysicsResponse<PhysicsProtocolType.DELETE_WORLD>;
export type WorldGravityResponse = PhysicsResponse<PhysicsProtocolType.WORLD_GET_GRAVITY>;
export type WorldTimestepResponse = PhysicsResponse<PhysicsProtocolType.WORLD_GET_TIMESTEP>;
export type WorldLengthUnitResponse = PhysicsResponse<PhysicsProtocolType.WORLD_GET_LENGTH_UNIT>;
export type WorldNumSolverIterationsResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_GET_SOLVER_ITERS>;
export type WorldNumInternalPgsIterationsResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_GET_PGS_ITERS>;
export type WorldMaxCcdSubstepsResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_GET_CCD_SUBSTEPS>;
// World query
export type WorldCastRayResponse = PhysicsResponse<PhysicsProtocolType.WORLD_CAST_RAY>;
export type WorldCastRayAndGetNormalResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL>;
export type WorldIntersectionsWithRayResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_INTERSECTIONS_WITH_RAY>;
export type WorldContactPairsResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_CONTACT_PAIRS_WITH>;
export type WorldIntersectionPairsWithResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_INTERSECTION_PAIRS_WITH>;
export type WorldIntersectionPairResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_INTERSECTION_PAIR>;
// Rigid body
export type CreateRigidBodyResponse = PhysicsResponse<PhysicsProtocolType.CREATE_RIGID_BODY>;
export type CreateRigidBodiesResponse = PhysicsResponse<PhysicsProtocolType.CREATE_RIGID_BODIES>;
export type DeleteRigidBodyResponse = PhysicsResponse<PhysicsProtocolType.DELETE_RIGID_BODY>;
export type DeleteRigidBodiesResponse = PhysicsResponse<PhysicsProtocolType.DELETE_RIGID_BODIES>;
export type RigidGetUserDataResponse = PhysicsResponse<PhysicsProtocolType.RIGID_GET_USERDATA>;
export type RigidIsValidResponse = PhysicsResponse<PhysicsProtocolType.RIGID_IS_VALID>;
export type RigidDominanceGroupResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_DOMINANCE_GROUP>;
export type RigidAdditionalSolverIterationsResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_ADDITIONAL_SOLVER_ITERATIONS>;
export type RigidSoftCcdPredictionResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_SOFT_CCD_PREDICTION>;
export type RigidTranslationResponse = PhysicsResponse<PhysicsProtocolType.RIGID_TRANSLATION>;
export type RigidRotationResponse = PhysicsResponse<PhysicsProtocolType.RIGID_ROTATION>;
export type RigidNextTranslationResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_NEXT_TRANSLATION>;
export type RigidNextRotationResponse = PhysicsResponse<PhysicsProtocolType.RIGID_NEXT_ROTATION>;
export type RigidGravityScaleResponse = PhysicsResponse<PhysicsProtocolType.RIGID_GRAVITY_SCALE>;
export type RigidLinvelResponse = PhysicsResponse<PhysicsProtocolType.RIGID_LINVEL>;
export type RigidVelocityAtPointResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_VELOCITY_AT_POINT>;
export type RigidAngvelResponse = PhysicsResponse<PhysicsProtocolType.RIGID_ANGVEL>;
export type RigidMassResponse = PhysicsResponse<PhysicsProtocolType.RIGID_MASS>;
export type RigidEffectiveInvMassResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_EFFECTIVE_INV_MASS>;
export type RigidInvMassResponse = PhysicsResponse<PhysicsProtocolType.RIGID_INV_MASS>;
export type RigidLocalComResponse = PhysicsResponse<PhysicsProtocolType.RIGID_LOCAL_COM>;
export type RigidWorldComResponse = PhysicsResponse<PhysicsProtocolType.RIGID_WORLD_COM>;
export type RigidInvPrincipalInertiaResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_INV_PRINCIPAL_INERTIA>;
export type RigidPrincipalInertiaResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA>;
export type RigidPrincipalInertiaLocalFrameResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA_LOCAL_FRAME>;
export type RigidIsCcdEnabledResponse = PhysicsResponse<PhysicsProtocolType.RIGID_IS_CCD_ENABLED>;
export type RigidNumCollidersResponse = PhysicsResponse<PhysicsProtocolType.RIGID_NUM_COLLIDERS>;
export type RigidColliderResponse = PhysicsResponse<PhysicsProtocolType.RIGID_COLLIDER>;
export type RigidIsEnabledResponse = PhysicsResponse<PhysicsProtocolType.RIGID_IS_ENABLED>;
export type RigidBodyTypeResponse = PhysicsResponse<PhysicsProtocolType.RIGID_BODY_TYPE>;
export type RigidIsSleepingResponse = PhysicsResponse<PhysicsProtocolType.RIGID_IS_SLEEPING>;
export type RigidIsMovingResponse = PhysicsResponse<PhysicsProtocolType.RIGID_IS_MOVING>;
export type RigidIsFixedResponse = PhysicsResponse<PhysicsProtocolType.RIGID_IS_FIXED>;
export type RigidIsKinematicResponse = PhysicsResponse<PhysicsProtocolType.RIGID_IS_KINEMATIC>;
export type RigidIsDynamicResponse = PhysicsResponse<PhysicsProtocolType.RIGID_IS_DYNAMIC>;
export type RigidLinearDampingResponse = PhysicsResponse<PhysicsProtocolType.RIGID_LINEAR_DAMPING>;
export type RigidAngularDampingResponse =
  PhysicsResponse<PhysicsProtocolType.RIGID_ANGULAR_DAMPING>;
export type RigidUserForceResponse = PhysicsResponse<PhysicsProtocolType.RIGID_USER_FORCE>;
export type RigidUserTorqueResponse = PhysicsResponse<PhysicsProtocolType.RIGID_USER_TORQUE>;

// Collider
export type CreateColliderResponse = PhysicsResponse<PhysicsProtocolType.CREATE_COLLIDER>;
export type CreateCollidersResponse = PhysicsResponse<PhysicsProtocolType.CREATE_COLLIDERS>;
export type DeleteColliderResponse = PhysicsResponse<PhysicsProtocolType.DELETE_COLLIDER>;
export type DeleteCollidersResponse = PhysicsResponse<PhysicsProtocolType.DELETE_COLLIDERS>;
export type CollUserDataResponse = PhysicsResponse<PhysicsProtocolType.COLL_GET_USERDATA>;
export type CollIsValidResponse = PhysicsResponse<PhysicsProtocolType.COLL_IS_VALID>;
export type CollTranslationResponse = PhysicsResponse<PhysicsProtocolType.COLL_TRANSLATION>;
export type CollRotationResponse = PhysicsResponse<PhysicsProtocolType.COLL_ROTATION>;
export type CollWrtParentTranslationResponse =
  PhysicsResponse<PhysicsProtocolType.COLL_TRANSLATION_WRT_PARENT>;
export type CollWrtParentRotationResponse =
  PhysicsResponse<PhysicsProtocolType.COLL_ROTATION_WRT_PARENT>;
export type CollIsSensorResponse = PhysicsResponse<PhysicsProtocolType.COLL_IS_SENSOR>;
export type CollIsEnabledResponse = PhysicsResponse<PhysicsProtocolType.COLL_IS_ENABLED>;
export type CollFrictionResponse = PhysicsResponse<PhysicsProtocolType.COLL_FRICTION>;
export type CollRestitutionResponse = PhysicsResponse<PhysicsProtocolType.COLL_RESTITUTION>;
export type CollMassResponse = PhysicsResponse<PhysicsProtocolType.COLL_MASS>;
export type CollDensityResponse = PhysicsResponse<PhysicsProtocolType.COLL_DENSITY>;
export type CollShapeTypeResponse = PhysicsResponse<PhysicsProtocolType.COLL_SHAPE_TYPE>;
export type CollRadiusResponse = PhysicsResponse<PhysicsProtocolType.COLL_RADIUS>;
export type CollHalfHeightResponse = PhysicsResponse<PhysicsProtocolType.COLL_HALF_HEIGHT>;
export type CollHalfExtentsResponse = PhysicsResponse<PhysicsProtocolType.COLL_HALF_EXTENTS>;
export type CollCollisionGroupsResponse =
  PhysicsResponse<PhysicsProtocolType.COLL_COLLISION_GROUPS>;
export type CollSolverGroupsResponse = PhysicsResponse<PhysicsProtocolType.COLL_SOLVER_GROUPS>;
export type CollContainsPointResponse = PhysicsResponse<PhysicsProtocolType.COLL_CONTAINS_POINT>;

export enum PhysicsProtocolType {
  ERROR = 0,

  // ENGINE
  INIT_PHYSICS = 1,
  TAKE_SNAPSHOT = 2,
  RESTORE_SNAPSHOT = 3,
  STEP = 4,
  CREATE_WORLD = 100,
  DELETE_WORLD = 101,

  // WORLD >= 200 && WORLD < 400
  WORLD_GET_GRAVITY = 200,
  WORLD_SET_GRAVITY = 201,
  WORLD_FREE = 202,
  WORLD_PROPAGATE_POSITIONS = 203,
  WORLD_GET_TIMESTEP = 204,
  WORLD_SET_TIMESTEP = 205,
  WORLD_GET_LENGTH_UNIT = 206,
  WORLD_SET_LENGTH_UNIT = 207,
  WORLD_GET_SOLVER_ITERS = 208,
  WORLD_SET_SOLVER_ITERS = 209,
  WORLD_GET_PGS_ITERS = 210,
  WORLD_SET_PGS_ITERS = 211,
  WORLD_GET_CCD_SUBSTEPS = 212,
  WORLD_SET_CCD_SUBSTEPS = 213,
  // WORLD QUERIES
  WORLD_CAST_RAY = 300,
  WORLD_CAST_RAY_AND_GET_NORMAL = 301,
  WORLD_INTERSECTIONS_WITH_RAY = 302,
  WORLD_CONTACT_PAIRS_WITH = 303,
  WORLD_INTERSECTION_PAIRS_WITH = 304,
  WORLD_INTERSECTION_PAIR = 305,

  // RIGID >= 400 && RIGID < 600
  CREATE_RIGID_BODY = 400,
  CREATE_RIGID_BODIES = 401,
  DELETE_RIGID_BODY = 402,
  DELETE_RIGID_BODIES = 403,
  RIGID_GET_USERDATA = 404,
  RIGID_SET_USERDATA = 405,
  RIGID_IS_VALID = 406,
  RIGID_LOCK_TRANSLATIONS = 407,
  RIGID_LOCK_ROTATIONS = 408,
  RIGID_SET_ENABLED_TRANSLATIONS = 409,
  RIGID_SET_ENABLED_ROTATIONS = 410,
  RIGID_DOMINANCE_GROUP = 411,
  RIGID_SET_DOMINANCE_GROUP = 412,
  RIGID_ADDITIONAL_SOLVER_ITERATIONS = 413,
  RIGID_SET_ADDITIONAL_SOLVER_ITERATIONS = 414,
  RIGID_ENABLE_CCD = 415,
  RIGID_SET_SOFT_CCD_PREDICTION = 416,
  RIGID_SOFT_CCD_PREDICTION = 417,
  RIGID_TRANSLATION = 418,
  RIGID_ROTATION = 419,
  RIGID_NEXT_TRANSLATION = 420,
  RIGID_NEXT_ROTATION = 421,
  RIGID_SET_TRANSLATION = 422,
  RIGID_SET_LINVEL = 423,
  RIGID_GRAVITY_SCALE = 424,
  RIGID_SET_GRAVITY_SCALE = 425,
  RIGID_SET_ROTATION = 426,
  RIGID_SET_ANGVEL = 427,
  RIGID_SET_NEXT_KINEMATIC_TRANSLATION = 428,
  RIGID_SET_NEXT_KINEMATIC_ROTATION = 429,
  RIGID_LINVEL = 430,
  RIGID_VELOCITY_AT_POINT = 431,
  RIGID_ANGVEL = 432,
  RIGID_MASS = 433,
  RIGID_EFFECTIVE_INV_MASS = 434,
  RIGID_INV_MASS = 435,
  RIGID_LOCAL_COM = 436,
  RIGID_WORLD_COM = 437,
  RIGID_INV_PRINCIPAL_INERTIA = 438,
  RIGID_PRINCIPAL_INERTIA = 439,
  RIGID_PRINCIPAL_INERTIA_LOCAL_FRAME = 440,
  RIGID_SLEEP = 441,
  RIGID_WAKE_UP = 442,
  RIGID_IS_CCD_ENABLED = 443,
  RIGID_NUM_COLLIDERS = 444,
  RIGID_COLLIDER = 445,
  RIGID_SET_ENABLED = 446,
  RIGID_IS_ENABLED = 447,
  RIGID_BODY_TYPE = 448,
  RIGID_SET_BODY_TYPE = 449,
  RIGID_IS_SLEEPING = 450,
  RIGID_IS_MOVING = 451,
  RIGID_IS_FIXED = 452,
  RIGID_IS_KINEMATIC = 453,
  RIGID_IS_DYNAMIC = 454,
  RIGID_LINEAR_DAMPING = 455,
  RIGID_ANGULAR_DAMPING = 456,
  RIGID_SET_LINEAR_DAMPING = 457,
  RIGID_SET_ANGULAR_DAMPING = 458,
  RIGID_RECOMPUTE_MASS_PROPERTIES = 459,
  RIGID_SET_ADDITIONAL_MASS = 460,
  RIGID_SET_ADDITIONAL_MASS_PROPERTIES = 461,
  RIGID_RESET_FORCES = 462,
  RIGID_RESET_TORQUES = 463,
  RIGID_ADD_FORCE = 464,
  RIGID_APPLY_IMPULSE = 465,
  RIGID_ADD_TORQUE = 466,
  RIGID_APPLY_TORQUE_IMPULSE = 467,
  RIGID_ADD_FORCE_AT_POINT = 468,
  RIGID_APPLY_IMPULSE_AT_POINT = 469,
  RIGID_USER_FORCE = 470,
  RIGID_USER_TORQUE = 471,

  // COLLIDER >= 600 && COLLIDER < 800
  CREATE_COLLIDER = 600,
  CREATE_COLLIDERS = 601,
  DELETE_COLLIDER = 602,
  DELETE_COLLIDERS = 603,
  COLL_GET_USERDATA = 604,
  COLL_SET_USERDATA = 605,
  COLL_IS_VALID = 606,
  COLL_TRANSLATION = 607,
  COLL_ROTATION = 608,
  COLL_TRANSLATION_WRT_PARENT = 609,
  COLL_ROTATION_WRT_PARENT = 610,
  COLL_SET_TRANSLATION = 611,
  COLL_SET_ROTATION = 612,
  COLL_SET_TRANSLATION_WRT_PARENT = 613,
  COLL_SET_ROTATION_WRT_PARENT = 614,
  COLL_IS_SENSOR = 615,
  COLL_SET_SENSOR = 616,
  COLL_IS_ENABLED = 617,
  COLL_SET_ENABLED = 618,
  COLL_FRICTION = 619,
  COLL_SET_FRICTION = 620,
  COLL_RESTITUTION = 621,
  COLL_SET_RESTITUTION = 622,
  COLL_MASS = 623,
  COLL_DENSITY = 624,
  COLL_SET_DENSITY = 625,
  COLL_SET_MASS = 626,
  COLL_SET_MASS_PROPERTIES = 627,
  COLL_SHAPE_TYPE = 628,
  COLL_RADIUS = 629,
  COLL_HALF_HEIGHT = 630,
  COLL_HALF_EXTENTS = 631,
  COLL_COLLISION_GROUPS = 632,
  COLL_SET_COLLISION_GROUPS = 633,
  COLL_SOLVER_GROUPS = 634,
  COLL_SET_SOLVER_GROUPS = 635,
  COLL_CONTAINS_POINT = 636,
}
