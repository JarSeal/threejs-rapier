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
  createCollider: (params: ColliderParams) => ColliderAPI;
  createRigidBodys: (params: RigidBodyParams[]) => RigidBodyAPI[];
  createColliders: (params: ColliderParams[]) => ColliderAPI[];
  deleteWorld: () => { worldDeleted: boolean };
  takeSnapshot: () => Uint8Array | undefined;
  restoreSnapshot: (snapshot: Uint8Array) => WorldAPI;
};

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
export declare enum RigidBodyTypeAPI {
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
 * A rigid-body.
 */
export type RigidBodyAPI = {
  /**
   * Rigid body id (a running integer id).
   */
  readonly id: number;
  /** Get or set the userData. Leave argument empty to get. */
  userData: (userData?: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  /**
   * Checks if this rigid-body is still valid (i.e. that it has
   * not been deleted from the rigid-body set yet.
   */
  isValid(): boolean;
  /**
   * Locks or unlocks the ability of this rigid-body to translate.
   *
   * @param locked - If `true`, this rigid-body will no longer translate due to forces and impulses.
   * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
   */
  lockTranslations(locked: boolean, wakeUp: boolean): void;
  /**
   * Locks or unlocks the ability of this rigid-body to rotate.
   *
   * @param locked - If `true`, this rigid-body will no longer rotate due to torques and impulses.
   * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
   */
  lockRotations(locked: boolean, wakeUp: boolean): void;
  /**
   * Locks or unlocks the ability of this rigid-body to translate along individual coordinate axes.
   *
   * @param enableX - If `false`, this rigid-body will no longer translate due to torques and impulses, along the X coordinate axis.
   * @param enableY - If `false`, this rigid-body will no longer translate due to torques and impulses, along the Y coordinate axis.
   * @param enableZ - If `false`, this rigid-body will no longer translate due to torques and impulses, along the Z coordinate axis.
   * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
   */
  setEnabledTranslations(
    enableX: boolean,
    enableY: boolean,
    enableZ: boolean,
    wakeUp: boolean
  ): void;
  /**
   * Locks or unlocks the ability of this rigid-body to rotate along individual coordinate axes.
   *
   * @param enableX - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the X coordinate axis.
   * @param enableY - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the Y coordinate axis.
   * @param enableZ - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the Z coordinate axis.
   * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
   */
  setEnabledRotations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean): void;
  /**
   * The dominance group, in [-127, +127] this rigid-body is part of.
   */
  dominanceGroup(): number;
  /**
   * Sets the dominance group of this rigid-body.
   *
   * @param group - The dominance group of this rigid-body. Must be a signed integer in the range [-127, +127].
   */
  setDominanceGroup(group: number): void;
  /**
   * The number of additional solver iterations that will be run for this
   * rigid-body and everything that interacts with it directly or indirectly
   * through contacts or joints.
   */
  additionalSolverIterations(): number;
  /**
   * Sets the number of additional solver iterations that will be run for this
   * rigid-body and everything that interacts with it directly or indirectly
   * through contacts or joints.
   *
   * Compared to increasing the global `World.numSolverIteration`, setting this
   * value lets you increase accuracy on only a subset of the scene, resulting in reduced
   * performance loss.
   *
   * @param iters - The new number of additional solver iterations (default: 0).
   */
  setAdditionalSolverIterations(iters: number): void;
  /**
   * Enable or disable CCD (Continuous Collision Detection) for this rigid-body.
   *
   * @param enabled - If `true`, CCD will be enabled for this rigid-body.
   */
  enableCcd(enabled: boolean): void;
  /**
   * Sets the soft-CCD prediction distance for this rigid-body.
   *
   * See the documentation of `RigidBodyDesc.setSoftCcdPrediction` for
   * additional details.
   */
  setSoftCcdPrediction(distance: number): void;
  /**
   * Gets the soft-CCD prediction distance for this rigid-body.
   *
   * See the documentation of `RigidBodyDesc.setSoftCcdPrediction` for
   * additional details.
   */
  softCcdPrediction(): number;
  /**
   * The world-space translation of this rigid-body.
   */
  translation(): PhysVector;
  /**
   * The world-space orientation of this rigid-body.
   */
  rotation(): PhysRotation;
  /**
   * The world-space next translation of this rigid-body.
   *
   * If this rigid-body is kinematic this value is set by the `setNextKinematicTranslation`
   * method and is used for estimating the kinematic body velocity at the next timestep.
   * For non-kinematic bodies, this value is currently unspecified.
   */
  nextTranslation(): PhysVector;
  /**
   * The world-space next orientation of this rigid-body.
   *
   * If this rigid-body is kinematic this value is set by the `setNextKinematicRotation`
   * method and is used for estimating the kinematic body velocity at the next timestep.
   * For non-kinematic bodies, this value is currently unspecified.
   */
  nextRotation(): PhysRotation;
  /**
   * Sets the translation of this rigid-body.
   *
   * @param tra - The world-space position of the rigid-body.
   * @param wakeUp - Forces the rigid-body to wake-up so it is properly affected by forces if it
   *                 wasn't moving before modifying its position.
   */
  setTranslation(tra: PhysVector, wakeUp: boolean): void;
  /**
   * Sets the linear velocity of this rigid-body.
   *
   * @param vel - The linear velocity to set.
   * @param wakeUp - Forces the rigid-body to wake-up if it was asleep.
   */
  setLinvel(vel: PhysVector, wakeUp: boolean): void;
  /**
   * The scale factor applied to the gravity affecting
   * this rigid-body.
   */
  gravityScale(): number;
  /**
   * Sets the scale factor applied to the gravity affecting
   * this rigid-body.
   *
   * @param factor - The scale factor to set. A value of 0.0 means
   *   that this rigid-body will on longer be affected by gravity.
   * @param wakeUp - Forces the rigid-body to wake-up if it was asleep.
   */
  setGravityScale(factor: number, wakeUp: boolean): void;
  /**
   * Sets the rotation quaternion of this rigid-body.
   *
   * This does nothing if a zero quaternion is provided.
   *
   * @param rotation - The rotation to set.
   * @param wakeUp - Forces the rigid-body to wake-up so it is properly affected by forces if it
   * wasn't moving before modifying its position.
   */
  setRotation(rot: PhysRotation, wakeUp: boolean): void;
  /**
   * Sets the angular velocity fo this rigid-body.
   *
   * @param vel - The angular velocity to set.
   * @param wakeUp - Forces the rigid-body to wake-up if it was asleep.
   */
  setAngvel(vel: PhysVector, wakeUp: boolean): void;
  /**
   * If this rigid body is kinematic, sets its future translation after the next timestep integration.
   *
   * This should be used instead of `rigidBody.setTranslation` to make the dynamic object
   * interacting with this kinematic body behave as expected. Internally, Rapier will compute
   * an artificial velocity for this rigid-body from its current position and its next kinematic
   * position. This velocity will be used to compute forces on dynamic bodies interacting with
   * this body.
   *
   * @param t - The kinematic translation to set.
   */
  setNextKinematicTranslation(t: PhysVector): void;
  /**
   * If this rigid body is kinematic, sets its future rotation after the next timestep integration.
   *
   * This should be used instead of `rigidBody.setRotation` to make the dynamic object
   * interacting with this kinematic body behave as expected. Internally, Rapier will compute
   * an artificial velocity for this rigid-body from its current position and its next kinematic
   * position. This velocity will be used to compute forces on dynamic bodies interacting with
   * this body.
   *
   * @param rot - The kinematic rotation to set.
   */
  setNextKinematicRotation(rot: PhysRotation): void;
  /**
   * The linear velocity of this rigid-body.
   */
  linvel(): PhysVector;
  /**
   * The velocity of the given world-space point on this rigid-body.
   */
  velocityAtPoint(point: PhysVector): PhysVector;
  /**
   * The angular velocity of this rigid-body.
   */
  angvel(): PhysVector;
  /**
   * The mass of this rigid-body.
   */
  mass(): number;
  /**
   * The inverse mass taking into account translation locking.
   */
  effectiveInvMass(): PhysVector;
  /**
   * The inverse of the mass of a rigid-body.
   *
   * If this is zero, the rigid-body is assumed to have infinite mass.
   */
  invMass(): number;
  /**
   * The center of mass of a rigid-body expressed in its local-space.
   */
  localCom(): PhysVector;
  /**
   * The world-space center of mass of the rigid-body.
   */
  worldCom(): PhysVector;
  /**
   * The inverse of the principal angular inertia of the rigid-body.
   *
   * Components set to zero are assumed to be infinite along the corresponding principal axis.
   */
  invPrincipalInertia(): PhysVector;
  /**
   * The angular inertia along the principal inertia axes of the rigid-body.
   */
  principalInertia(): PhysVector;
  /**
   * The principal vectors of the local angular inertia tensor of the rigid-body.
   */
  principalInertiaLocalFrame(): PhysRotation;
  /**
   * Put this rigid body to sleep.
   *
   * A sleeping body no longer moves and is no longer simulated by the physics engine unless
   * it is waken up. It can be woken manually with `this.wakeUp()` or automatically due to
   * external forces like contacts.
   */
  sleep(): void;
  /**
   * Wakes this rigid-body up.
   *
   * A dynamic rigid-body that does not move during several consecutive frames will
   * be put to sleep by the physics engine, i.e., it will stop being simulated in order
   * to avoid useless computations.
   * This methods forces a sleeping rigid-body to wake-up. This is useful, e.g., before modifying
   * the position of a dynamic body so that it is properly simulated afterwards.
   */
  wakeUp(): void;
  /**
   * Is CCD enabled for this rigid-body?
   */
  isCcdEnabled(): boolean;
  /**
   * The number of colliders attached to this rigid-body.
   */
  numColliders(): number;
  /**
   * Retrieves the `i-th` collider attached to this rigid-body.
   *
   * @param i - The index of the collider to retrieve. Must be a number in `[0, this.numColliders()[`.
   *         This index is **not** the same as the unique identifier of the collider.
   */
  collider(i: number): ColliderAPI;
  /**
   * Sets whether this rigid-body is enabled or not.
   *
   * @param enabled - Set to `false` to disable this rigid-body and all its attached colliders.
   */
  setEnabled(enabled: boolean): void;
  /**
   * Is this rigid-body enabled?
   */
  isEnabled(): boolean;
  /**
   * The status of this rigid-body: static, dynamic, or kinematic.
   */
  bodyType(): RigidBodyTypeAPI;
  /**
   * Set a new status for this rigid-body: static, dynamic, or kinematic.
   */
  setBodyType(type: RigidBodyTypeAPI, wakeUp: boolean): void;
  /**
   * Is this rigid-body sleeping?
   */
  isSleeping(): boolean;
  /**
   * Is the velocity of this rigid-body not zero?
   */
  isMoving(): boolean;
  /**
   * Is this rigid-body static?
   */
  isFixed(): boolean;
  /**
   * Is this rigid-body kinematic?
   */
  isKinematic(): boolean;
  /**
   * Is this rigid-body dynamic?
   */
  isDynamic(): boolean;
  /**
   * The linear damping coefficient of this rigid-body.
   */
  linearDamping(): number;
  /**
   * The angular damping coefficient of this rigid-body.
   */
  angularDamping(): number;
  /**
   * Sets the linear damping factor applied to this rigid-body.
   *
   * @param factor - The damping factor to set.
   */
  setLinearDamping(factor: number): void;
  /**
   * Recompute the mass-properties of this rigid-bodies based on its currently attached colliders.
   */
  recomputeMassPropertiesFromColliders(): void;
  /**
   * Sets the rigid-body's additional mass.
   *
   * The total angular inertia of the rigid-body will be scaled automatically based on this additional mass. If this
   * scaling effect isn’t desired, use Self::additional_mass_properties instead of this method.
   *
   * This is only the "additional" mass because the total mass of the rigid-body is equal to the sum of this
   * additional mass and the mass computed from the colliders (with non-zero densities) attached to this rigid-body.
   *
   * That total mass (which includes the attached colliders’ contributions) will be updated at the name physics step,
   * or can be updated manually with `this.recomputeMassPropertiesFromColliders`.
   *
   * This will override any previous additional mass-properties set by `this.setAdditionalMass`,
   * `this.setAdditionalMassProperties`, `RigidBodyDesc::setAdditionalMass`, or
   * `RigidBodyDesc.setAdditionalMassfProperties` for this rigid-body.
   *
   * @param mass - The additional mass to set.
   * @param wakeUp - If `true` then the rigid-body will be woken up if it was put to sleep because it did not move for a while.
   */
  setAdditionalMass(mass: number, wakeUp: boolean): void;
  /**
   * Sets the rigid-body's additional mass-properties.
   *
   * This is only the "additional" mass-properties because the total mass-properties of the rigid-body is equal to the
   * sum of this additional mass-properties and the mass computed from the colliders (with non-zero densities) attached
   * to this rigid-body.
   *
   * That total mass-properties (which include the attached colliders’ contributions) will be updated at the name
   * physics step, or can be updated manually with `this.recomputeMassPropertiesFromColliders`.
   *
   * This will override any previous mass-properties set by `this.setAdditionalMass`,
   * `this.setAdditionalMassProperties`, `RigidBodyDesc.setAdditionalMass`, or `RigidBodyDesc.setAdditionalMassProperties`
   * for this rigid-body.
   *
   * If `wake_up` is true then the rigid-body will be woken up if it was put to sleep because it did not move for a while.
   */
  setAdditionalMassProperties(
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation,
    wakeUp: boolean
  ): void;
  /**
   * Sets the linear damping factor applied to this rigid-body.
   *
   * @param factor - The damping factor to set.
   */
  setAngularDamping(factor: number): void;
  /**
   * Resets to zero the user forces (but not torques) applied to this rigid-body.
   *
   * @param wakeUp - should the rigid-body be automatically woken-up?
   */
  resetForces(wakeUp: boolean): void;
  /**
   * Resets to zero the user torques applied to this rigid-body.
   *
   * @param wakeUp - should the rigid-body be automatically woken-up?
   */
  resetTorques(wakeUp: boolean): void;
  /**
   * Adds a force at the center-of-mass of this rigid-body.
   *
   * @param force - the world-space force to add to the rigid-body.
   * @param wakeUp - should the rigid-body be automatically woken-up?
   */
  addForce(force: PhysVector, wakeUp: boolean): void;
  /**
   * Applies an impulse at the center-of-mass of this rigid-body.
   *
   * @param impulse - the world-space impulse to apply on the rigid-body.
   * @param wakeUp - should the rigid-body be automatically woken-up?
   */
  applyImpulse(impulse: PhysVector, wakeUp: boolean): void;
  /**
   * Adds a torque at the center-of-mass of this rigid-body.
   *
   * @param torque - the world-space torque to add to the rigid-body.
   * @param wakeUp - should the rigid-body be automatically woken-up?
   */
  addTorque(torque: PhysVector, wakeUp: boolean): void;
  /**
   * Applies an impulsive torque at the center-of-mass of this rigid-body.
   *
   * @param torqueImpulse - the world-space torque impulse to apply on the rigid-body.
   * @param wakeUp - should the rigid-body be automatically woken-up?
   */
  applyTorqueImpulse(torqueImpulse: PhysVector, wakeUp: boolean): void;
  /**
   * Adds a force at the given world-space point of this rigid-body.
   *
   * @param force - the world-space force to add to the rigid-body.
   * @param point - the world-space point where the impulse is to be applied on the rigid-body.
   * @param wakeUp - should the rigid-body be automatically woken-up?
   */
  addForceAtPoint(force: PhysVector, point: PhysVector, wakeUp: boolean): void;
  /**
   * Applies an impulse at the given world-space point of this rigid-body.
   *
   * @param impulse - the world-space impulse to apply on the rigid-body.
   * @param point - the world-space point where the impulse is to be applied on the rigid-body.
   * @param wakeUp - should the rigid-body be automatically woken-up?
   */
  applyImpulseAtPoint(impulse: PhysVector, point: PhysVector, wakeUp: boolean): void;
  /**
   * Retrieves the constant force(s) the user added to this rigid-body
   * Returns zero if the rigid-body is not dynamic.
   */
  userForce(): PhysVector;
  /**
   * Retrieves the constant torque(s) the user added to this rigid-body
   * Returns zero if the rigid-body is not dynamic.
   */
  userTorque(): PhysVector;
};

/**
 * An enumeration representing the type of a shape.
 */
export declare enum ShapeType {
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
  /**
   * Rigid body id (a running integer id).
   */
  readonly id: number;
  /** Get or set the userData. Leave argument empty to get. */
  userData: (userData?: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  /**
   * Possible parent rigid body id
   */
  readonly parentId?: number;
  /**
   * Set the internal cached JS shape to null.
   *
   * This can be useful if you want to free some memory (assuming you are not
   * holding any other references to the shape object), or in order to force
   * the recalculation of the JS shape (the next time the `shape` getter is
   * accessed) from the WASM source of truth.
   */
  clearShapeCache(): void;
  /**
   * Checks if this collider is still valid (i.e. that it has
   * not been deleted from the collider set yet).
   */
  isValid(): boolean;
  /**
   * The world-space translation of this collider.
   */
  translation(): PhysVector;
  /**
   * The translation of this collider relative to its parent rigid-body.
   *
   * Returns `null` if the collider doesn’t have a parent rigid-body.
   */
  translationWrtParent(): PhysVector | null;
  /**
   * The world-space orientation of this collider.
   */
  rotation(): PhysRotation;
  /**
   * The orientation of this collider relative to its parent rigid-body.
   *
   * Returns `null` if the collider doesn’t have a parent rigid-body.
   */
  rotationWrtParent(): PhysRotation | null;
  /**
   * Is this collider a sensor?
   */
  isSensor(): boolean;
  /**
   * Sets whether this collider is a sensor.
   * @param isSensor - If `true`, the collider will be a sensor.
   */
  setSensor(isSensor: boolean): void;
  /**
   * Sets whether this collider is enabled or not.
   *
   * @param enabled - Set to `false` to disable this collider (its parent rigid-body won’t be disabled automatically by this).
   */
  setEnabled(enabled: boolean): void;
  /**
   * Is this collider enabled?
   */
  isEnabled(): boolean;
  /**
   * Sets the restitution coefficient of the collider to be created.
   *
   * @param restitution - The restitution coefficient in `[0, 1]`. A value of 0 (the default) means no bouncing behavior
   *                   while 1 means perfect bouncing (though energy may still be lost due to numerical errors of the
   *                   constraints solver).
   */
  setRestitution(restitution: number): void;
  /**
   * Sets the friction coefficient of the collider to be created.
   *
   * @param friction - The friction coefficient. Must be greater or equal to 0. This is generally smaller than 1. The
   *                   higher the coefficient, the stronger friction forces will be for contacts with the collider
   *                   being built.
   */
  setFriction(friction: number): void;
  /**
   * Gets the rule used to combine the friction coefficients of two colliders
   * colliders involved in a contact.
   */
  frictionCombineRule(): CoefficientCombineRule;
  /**
   * Sets the rule used to combine the friction coefficients of two colliders
   * colliders involved in a contact.
   *
   * @param rule − The combine rule to apply.
   */
  setFrictionCombineRule(rule: CoefficientCombineRule): void;
  /**
   * Gets the rule used to combine the restitution coefficients of two colliders
   * colliders involved in a contact.
   */
  restitutionCombineRule(): CoefficientCombineRule;
  /**
   * Sets the rule used to combine the restitution coefficients of two colliders
   * colliders involved in a contact.
   *
   * @param rule − The combine rule to apply.
   */
  setRestitutionCombineRule(rule: CoefficientCombineRule): void;
  /**
   * Sets the collision groups used by this collider.
   *
   * Two colliders will interact iff. their collision groups are compatible.
   * See the documentation of `InteractionGroups` for details on teh used bit pattern.
   *
   * @param groups - The collision groups used for the collider being built.
   */
  setCollisionGroups(groups: InteractionGroupsAPI): void;
  /**
   * Sets the solver groups used by this collider.
   *
   * Forces between two colliders in contact will be computed iff their solver
   * groups are compatible.
   * See the documentation of `InteractionGroups` for details on the used bit pattern.
   *
   * @param groups - The solver groups used for the collider being built.
   */
  setSolverGroups(groups: InteractionGroupsAPI): void;
  /**
   * Sets the contact skin for this collider.
   *
   * See the documentation of `ColliderDesc.setContactSkin` for additional details.
   */
  contactSkin(): number;
  /**
   * Sets the contact skin for this collider.
   *
   * See the documentation of `ColliderDesc.setContactSkin` for additional details.
   *
   * @param thickness - The contact skin thickness.
   */
  setContactSkin(thickness: number): void;
  /**
   * Get the physics hooks active for this collider.
   */
  activeHooks(): ActiveHooks;
  /**
   * Set the physics hooks active for this collider.
   *
   * Use this to enable custom filtering rules for contact/intersecstion pairs involving this collider.
   *
   * @param activeHooks - The hooks active for contact/intersection pairs involving this collider.
   */
  setActiveHooks(activeHooks: ActiveHooks): void;
  /**
   * The events active for this collider.
   */
  activeEvents(): ActiveEvents;
  /**
   * Set the events active for this collider.
   *
   * Use this to enable contact and/or intersection event reporting for this collider.
   *
   * @param activeEvents - The events active for contact/intersection pairs involving this collider.
   */
  setActiveEvents(activeEvents: ActiveEvents): void;
  /**
   * Gets the collision types active for this collider.
   */
  activeCollisionTypes(): ActiveCollisionTypes;
  /**
   * Sets the total force magnitude beyond which a contact force event can be emitted.
   *
   * @param threshold - The new force threshold.
   */
  setContactForceEventThreshold(threshold: number): void;
  /**
   * The total force magnitude beyond which a contact force event can be emitted.
   */
  contactForceEventThreshold(): number;
  /**
   * Set the collision types active for this collider.
   *
   * @param activeCollisionTypes - The hooks active for contact/intersection pairs involving this collider.
   */
  setActiveCollisionTypes(activeCollisionTypes: ActiveCollisionTypes): void;
  /**
   * Sets the uniform density of this collider.
   *
   * This will override any previous mass-properties set by `this.setDensity`,
   * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
   * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
   *
   * The mass and angular inertia of this collider will be computed automatically based on its
   * shape.
   */
  setDensity(density: number): void;
  /**
   * Sets the mass of this collider.
   *
   * This will override any previous mass-properties set by `this.setDensity`,
   * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
   * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
   *
   * The angular inertia of this collider will be computed automatically based on its shape
   * and this mass value.
   */
  setMass(mass: number): void;
  /**
   * Sets the mass of this collider.
   *
   * This will override any previous mass-properties set by `this.setDensity`,
   * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
   * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
   */
  setMassProperties(
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation
  ): void;
  /**
   * Sets the translation of this collider.
   *
   * @param tra - The world-space position of the collider.
   */
  setTranslation(tra: PhysVector): void;
  /**
   * Sets the translation of this collider relative to its parent rigid-body.
   *
   * Does nothing if this collider isn't attached to a rigid-body.
   *
   * @param tra - The new translation of the collider relative to its parent.
   */
  setTranslationWrtParent(tra: PhysVector): void;
  /**
   * Sets the rotation quaternion of this collider.
   *
   * This does nothing if a zero quaternion is provided.
   *
   * @param rotation - The rotation to set.
   */
  setRotation(rot: PhysRotation): void;
  /**
   * Sets the rotation quaternion of this collider relative to its parent rigid-body.
   *
   * This does nothing if a zero quaternion is provided or if this collider isn't
   * attached to a rigid-body.
   *
   * @param rotation - The rotation to set.
   */
  setRotationWrtParent(rot: PhysRotation): void;
  /**
   * The type of the shape of this collider.
   */
  shapeType(): ShapeType;
  /**
   * The half-extents of this collider if it is a cuboid shape.
   */
  halfExtents(): PhysVector;
  /**
   * Sets the half-extents of this collider if it is a cuboid shape.
   *
   * @param newHalfExtents - desired half extents.
   */
  setHalfExtents(newHalfExtents: PhysVector): void;
  /**
   * The radius of this collider if it is a ball, cylinder, capsule, or cone shape.
   */
  radius(): number;
  /**
   * Sets the radius of this collider if it is a ball, cylinder, capsule, or cone shape.
   *
   * @param newRadius - desired radius.
   */
  setRadius(newRadius: number): void;
  /**
   * The radius of the round edges of this collider if it is a round cylinder.
   */
  roundRadius(): number;
  /**
   * Sets the radius of the round edges of this collider if it has round edges.
   *
   * @param newBorderRadius - desired round edge radius.
   */
  setRoundRadius(newBorderRadius: number): void;
  /**
   * The half height of this collider if it is a cylinder, capsule, or cone shape.
   */
  halfHeight(): number;
  /**
   * Sets the half height of this collider if it is a cylinder, capsule, or cone shape.
   *
   * @param newHalfheight - desired half height.
   */
  setHalfHeight(newHalfheight: number): void;
  /**
   * If this collider has a Voxels shape, this will mark the voxel at the
   * given grid coordinates as filled or empty (depending on the `filled`
   * argument).
   *
   * Each input value is assumed to be an integer.
   *
   * The operation is O(1), unless the provided coordinates are out of the
   * bounds of the currently allocated internal grid in which case the grid
   * will be grown automatically.
   */
  setVoxel(ix: number, iy: number, iz: number, filled: boolean): void;
  /**
   * If this and `voxels2` are voxel colliders, and a voxel from `this` was
   * modified with `setVoxel`, this will ensure that a
   * moving object transitioning across the boundaries of these colliders
   * won’t suffer from the "internal edges" artifact.
   *
   * The indices `ix, iy, iz` indicate the integer coordinates of the voxel in
   * the local coordinate frame of `this`.
   *
   * If the voxels in `voxels2` live in a different coordinate space from `this`,
   * then the `shift_*` argument indicate the distance, in voxel units, between
   * the origin of `this` to the origin of `voxels2`.
   *
   * This method is intended to be called between `this` and all the other
   * voxels colliders with a domain intersecting `this` or sharing a domain
   * boundary. This is an incremental maintenance of the effect of
   * `combineVoxelStates`.
   */
  propagateVoxelChange(
    voxels2: ColliderAPI,
    ix: number,
    iy: number,
    iz: number,
    shift_x: number,
    shift_y: number,
    shift_z: number
  ): void;
  /**
   * If this and `voxels2` are voxel colliders, this will ensure that a
   * moving object transitioning across the boundaries of these colliders
   * won’t suffer from the "internal edges" artifact.
   *
   * If the voxels in `voxels2` live in a different coordinate space from `this`,
   * then the `shift_*` argument indicate the distance, in voxel units, between
   * the origin of `this` to the origin of `voxels2`.
   *
   * This method is intended to be called once between all pairs of voxels
   * colliders with intersecting domains or shared boundaries.
   *
   * If either voxels collider is then modified with `setVoxel`, the
   * `propagateVoxelChange` method must be called to maintain the coupling
   * between the voxels shapes after the modification.
   */
  combineVoxelStates(voxels2: ColliderAPI, shift_x: number, shift_y: number, shift_z: number): void;
  /**
   * If this collider has a triangle mesh, polyline, convex polygon, or convex polyhedron shape,
   * this returns the vertex buffer of said shape.
   */
  vertices(): Float32Array;
  /**
   * If this collider has a triangle mesh, polyline, or convex polyhedron shape,
   * this returns the index buffer of said shape.
   */
  indices(): Uint32Array | undefined;
  /**
   * If this collider has a heightfield shape, this returns the heights buffer of
   * the heightfield.
   * In 3D, the returned height matrix is provided in column-major order.
   */
  heightfieldHeights(): Float32Array;
  /**
   * If this collider has a heightfield shape, this returns the scale
   * applied to it.
   */
  heightfieldScale(): PhysVector;
  /**
   * If this collider has a heightfield shape, this returns the number of
   * rows of its height matrix.
   */
  heightfieldNRows(): number;
  /**
   * If this collider has a heightfield shape, this returns the number of
   * columns of its height matrix.
   */
  heightfieldNCols(): number;
  /**
   * The rigid-body this collider is attached to.
   */
  parent(): RigidBodyAPI | null;
  /**
   * The friction coefficient of this collider.
   */
  friction(): number;
  /**
   * The restitution coefficient of this collider.
   */
  restitution(): number;
  /**
   * The density of this collider.
   */
  density(): number;
  /**
   * The mass of this collider.
   */
  mass(): number;
  /**
   * The volume of this collider.
   */
  volume(): number;
  /**
   * The collision groups of this collider.
   */
  collisionGroups(): InteractionGroupsAPI;
  /**
   * The solver groups of this collider.
   */
  solverGroups(): InteractionGroupsAPI;
  /**
   * Tests if this collider contains a point.
   *
   * @param point - The point to test.
   */
  containsPoint(point: PhysVector): boolean;
  /**
   * Find the projection of a point on this collider.
   *
   * @param point - The point to project.
   * @param solid - If this is set to `true` then the collider shapes are considered to
   *   be plain (if the point is located inside of a plain shape, its projection is the point
   *   itself). If it is set to `false` the collider shapes are considered to be hollow
   *   (if the point is located inside of an hollow shape, it is projected on the shape's
   *   boundary).
   */
  projectPoint(point: PhysVector, solid: boolean): PointProjection | null;
  /**
   * Tests if this collider intersects the given ray.
   *
   * @param ray - The ray to cast.
   * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
   *   limits the length of the ray to `ray.dir.norm() * maxToi`.
   */
  intersectsRay(ray: PhysRay, maxToi: number): boolean;
  /**
   * Find the closest intersection between a ray and this collider.
   *
   * This also computes the normal at the hit point.
   * @param ray - The ray to cast.
   * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
   *   limits the length of the ray to `ray.dir.norm() * maxToi`.
   * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
   *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
   *   whereas `false` implies that all shapes are hollow for this ray-cast.
   * @returns The time-of-impact between this collider and the ray, or `-1` if there is no intersection.
   */
  castRay(ray: PhysRay, maxToi: number, solid: boolean): number;
  /**
   * Find the closest intersection between a ray and this collider.
   *
   * This also computes the normal at the hit point.
   * @param ray - The ray to cast.
   * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
   *   limits the length of the ray to `ray.dir.norm() * maxToi`.
   * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
   *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
   *   whereas `false` implies that all shapes are hollow for this ray-cast.
   */
  castRayAndGetNormal(ray: PhysRay, maxToi: number, solid: boolean): RayIntersection | null;
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
export declare type InteractionGroupsAPI = number;

/**
 * A rule applied to combine coefficients.
 *
 * Use this when configuring the `ColliderDesc` to specify
 * how friction and restitution coefficient should be combined
 * in a contact.
 */
export declare enum CoefficientCombineRule {
  Average = 0,
  Min = 1,
  Multiply = 2,
  Max = 3,
}

export declare enum ActiveHooks {
  NONE = 0,
  FILTER_CONTACT_PAIRS = 1,
  FILTER_INTERSECTION_PAIRS = 2,
}

/**
 * Flags indicating what events are enabled for colliders.
 */
export declare enum ActiveEvents {
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
export declare enum ActiveCollisionTypes {
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
export declare type PointProjection = {
  /**
   * The projection of the point on the collider.
   */
  point: PhysVector;
  /**
   * Is the point inside of the collider?
   */
  isInside: boolean;
};

export declare enum FeatureType {
  Vertex = 0,
  Edge = 1,
  Face = 2,
  Unknown = 3,
}

/**
 * The intersection between a ray and a collider.
 */
export declare type RayIntersection = {
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
export declare class TempContactForceEvent {
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
export declare type EventQueue = {
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
export declare enum QueryFilterFlags {
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

export declare enum SolverFlags {
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
  userData?: { [key: string]: unknown };

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
  /** Get or set the gravity. Leave argument empty to get. */
  gravity: (gravity?: PhysVector) => Promise<PhysVector | void>;
  /**
   * Release the WASM memory occupied by this physics world.
   *
   * All the fields of this physics world will be freed as well,
   * so there is no need to call their `.free()` methods individually.
   */
  free: () => void;
  /**
   * Takes a snapshot of this world.
   *
   * Use `World.restoreSnapshot` to create a new physics world with a state identical to
   * the state when `.takeSnapshot()` is called.
   */
  takeSnapshot: () => Promise<Uint8Array | undefined>;
  /**
   * Creates a new physics world from a snapshot.
   *
   * This new physics world will be an identical copy of the snapshoted physics world.
   */
  restoreSnapshot: (data: Uint8Array) => Promise<WorldAPI>;
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
  propagateModifiedBodyPositionsToColliders: () => void;
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
  timestep: (dt?: number) => Promise<number | void>;
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
  lengthUnit: (unitsPerMeter?: number) => Promise<number | void>;
  /**
   * Get or set the numSolverIterations. Leave argument empty to get. Sets the number of solver iterations
   * run by the constraints solver for calculating forces (default: `4`).
   *
   * The greater this value is, the most rigid and realistic the physics simulation will be.
   * However a greater number of iterations is more computationally intensive.
   *
   * @param niter - The new number of solver iterations.
   */
  numSolverIterations: (niter?: number) => Promise<number | void>;
  /**
   * Get or set the numSolverIterations. Leave argument empty to get. Sets the Number of internal
   * Project Gauss Seidel (PGS) iterations run at each solver iteration (default: `1`).
   *
   * Increasing this parameter will improve stability of the simulation. It will have a lesser effect than
   * increasing `numSolverIterations` but is also less computationally expensive.
   *
   * @param niter - The new number of internal PGS iterations.
   */
  numInternalPgsIterations: (niter?: number) => Promise<number | void>;
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
  maxCcdSubsteps: (substeps?: number) => Promise<number | void>;
  /**
   * Creates a new rigid-body from the given rigid-body descriptor.
   *
   * @param params - The parameters of the rigid-body.
   */
  createRigidBody: (params: RigidBodyParams) => Promise<RigidBodyAPI>;
  /**
   * Creates a new collider.
   *
   * @param params - The parameters of the collider.
   * @param parent - The rigid-body this collider is attached to.
   */
  createCollider: (params: ColliderParams, parent?: RigidBodyAPI) => Promise<ColliderAPI>;
  /**
   * Retrieves a rigid-body from its handle.
   *
   * @param id - The integer handle of the rigid-body to retrieve.
   */
  getRigidBody: (id: number) => Promise<RigidBodyAPI | undefined>;
  /**
   * Retrieves a collider from its handle.
   *
   * @param id - The integer handle of the collider to retrieve.
   */
  getCollider: (id: number) => Promise<ColliderAPI | undefined>;
  /**
   * Removes the given rigid-body from this physics world.
   *
   * This will remove this rigid-body as well as all its attached colliders and joints.
   * Every other bodies touching or attached by joints to this rigid-body will be woken-up.
   *
   * @param bodyOrId - The rigid-body or id to remove.
   */
  removeRigidBody: (bodyOrId: RigidBodyAPI | number) => void;
  /**
   * Removes the given collider from this physics world.
   *
   * @param colliderOrId - The collider or id to remove.
   * @param wakeUp - If set to `true`, the rigid-body this collider is attached to will be awaken.
   */
  removeCollider: (colliderOrId: ColliderAPI | number, wakeUp: boolean) => void;
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
  castRay: (
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ) => Promise<RayColliderHitAPI | null>;
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
  castRayAndGetNormal: (
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ) => Promise<RayColliderIntersectionAPI | null>;
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
  intersectionsWithRay: (
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    callback: (intersect: RayColliderIntersectionAPI) => boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI,
    filterExcludeRigidBody?: RigidBodyAPI,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ) => void;
  /**
   * Enumerates all the colliders potentially in contact with the given collider.
   *
   * @param collider1 - The second collider involved in the contact.
   * @param f - Closure that will be called on each collider that is in contact with `collider1`.
   */
  contactPairsWith: (collider1: ColliderAPI, f: (collider2: ColliderAPI) => void) => void;
  /**
   * Enumerates all the colliders intersecting the given colliders, assuming one of them
   * is a sensor.
   */
  intersectionPairsWith: (collider1: ColliderAPI, f: (collider2: ColliderAPI) => void) => void;
  /**
   * Returns `true` if `collider1` and `collider2` intersect and at least one of them is a sensor.
   * @param collider1 − The first collider involved in the intersection.
   * @param collider2 − The second collider involved in the intersection.
   */
  intersectionPair: (collider1: ColliderAPI, collider2: ColliderAPI) => Promise<boolean>;
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

/** Physics worker UP protocol (from main thread to worker) */
export type PhysicsUpProtocol = // Engine
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
    // World
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
    | {
        type: PhysicsProtocolType.WORLD_GRAVITY;
        gravity?: PhysVector;
      }
    | {
        type: PhysicsProtocolType.WORLD_FREE;
      }
    | {
        type: PhysicsProtocolType.WORLD_PROPAGATE_MODIFIED_BODY_POSITIONS_TO_COLLIDERS;
      }
    | {
        type: PhysicsProtocolType.WORLD_TIMESTEP;
        dt?: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_LENGTH_UNIT;
        unitsPerMeter?: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_NUM_SOLVER_ITERATIONS;
        niter?: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_NUM_INTERNAL_PGS_ITERATIONS;
        niter?: number;
      }
    | { type: PhysicsProtocolType.WORLD_MAX_CCD_SUBSTEPS; substeps?: number }
    // World queries
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
      }
    | { type: PhysicsProtocolType.WORLD_CONTACT_PAIRS_WITH; colliderId: number }
    | { type: PhysicsProtocolType.WORLD_INTERSECTION_PAIRS_WITH; colliderId: number }
    | {
        type: PhysicsProtocolType.WORLD_INTERSECTION_PAIR;
        colliderId1: number;
        colliderId2: number;
      }
    // RigidBody
    | { type: PhysicsProtocolType.CREATE_RIGID_BODY; params: RigidBodyParams }
    | { type: PhysicsProtocolType.GET_RIGID_BODY; id: number }
    | { type: PhysicsProtocolType.REMOVE_RIGID_BODY; id: number }
    // Collider
    | { type: PhysicsProtocolType.CREATE_COLLIDER; params: ColliderParams; parentId?: number }
    | { type: PhysicsProtocolType.GET_COLLIDER; id: number }
    | { type: PhysicsProtocolType.REMOVE_COLLIDER; id: number; wakeUp: boolean }
  ) & { requestId?: number; isOneWay?: boolean };

/** Physics worker DOWN protocol (from worker to main thread) */
export type PhysicsDownProtocol = // Engine
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
    // World
    | { type: PhysicsProtocolType.CREATE_WORLD; worldCreated: boolean }
    | { type: PhysicsProtocolType.DELETE_WORLD; worldDeleted: boolean }
    | {
        type: PhysicsProtocolType.WORLD_GRAVITY;
        gravity?: PhysVector;
      }
    | {
        type: PhysicsProtocolType.WORLD_TIMESTEP;
        dt?: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_LENGTH_UNIT;
        unitsPerMeter?: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_NUM_SOLVER_ITERATIONS;
        solverIterations?: number;
      }
    | {
        type: PhysicsProtocolType.WORLD_NUM_INTERNAL_PGS_ITERATIONS;
        internalPgsIterations?: number;
      }
    | { type: PhysicsProtocolType.WORLD_MAX_CCD_SUBSTEPS; substeps?: number }
    // World query Results
    | { type: PhysicsProtocolType.WORLD_CAST_RAY; hit: RayColliderHitAPI | null }
    | {
        type: PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL;
        intersection: RayColliderIntersectionAPI | null;
      }
    | {
        type: PhysicsProtocolType.WORLD_INTERSECTIONS_WITH_RAY;
        intersections: RayColliderIntersectionAPI[];
      }
    | { type: PhysicsProtocolType.WORLD_CONTACT_PAIRS_WITH; otherIds: number[] }
    | { type: PhysicsProtocolType.WORLD_INTERSECTION_PAIRS_WITH; otherIds: number[] }
    | { type: PhysicsProtocolType.WORLD_INTERSECTION_PAIR; isIntersecting: boolean }
    // Rigid body
    | { type: PhysicsProtocolType.CREATE_RIGID_BODY; id: number }
    | { type: PhysicsProtocolType.GET_RIGID_BODY; exists: boolean }
    // Collider
    | { type: PhysicsProtocolType.CREATE_COLLIDER; id: number }
    | { type: PhysicsProtocolType.GET_COLLIDER; exists: boolean }
    // Error
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
export type WorldGravityResponse = PhysicsResponse<PhysicsProtocolType.WORLD_GRAVITY>;
export type WorldTimestepResponse = PhysicsResponse<PhysicsProtocolType.WORLD_TIMESTEP>;
export type WorldLengthUnitResponse = PhysicsResponse<PhysicsProtocolType.WORLD_LENGTH_UNIT>;
export type WorldNumSolverIterationsResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_NUM_SOLVER_ITERATIONS>;
export type WorldNumInternalPgsIterationsResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_NUM_INTERNAL_PGS_ITERATIONS>;
export type WorldMaxCcdSubstepsResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_MAX_CCD_SUBSTEPS>;
// World query
export type WorldCastRayResponse = PhysicsResponse<PhysicsProtocolType.WORLD_CAST_RAY>;
export type WorldCastRayAndNormalResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL>;
export type WorldIntersectionsWithRayResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_INTERSECTIONS_WITH_RAY>;
export type WorldContactPairsResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_CONTACT_PAIRS_WITH>;
export type WorldIntersectionPairResponse =
  PhysicsResponse<PhysicsProtocolType.WORLD_INTERSECTION_PAIR>;
// Rigid body
export type CreateRigidBodyResponse = PhysicsResponse<PhysicsProtocolType.CREATE_RIGID_BODY>;
// Collider
export type CreateColliderResponse = PhysicsResponse<PhysicsProtocolType.CREATE_COLLIDER>;

export declare enum PhysicsProtocolType {
  ERROR = 0,

  // ENGINE
  INIT_PHYSICS = 1,
  TAKE_SNAPSHOT = 2,
  RESTORE_SNAPSHOT = 3,
  STEP = 4,
  CREATE_WORLD = 100,
  DELETE_WORLD = 101,

  // WORLD >= 200 && WORLD < 400
  WORLD_GRAVITY = 200,
  WORLD_FREE = 201,
  WORLD_PROPAGATE_MODIFIED_BODY_POSITIONS_TO_COLLIDERS = 202,
  WORLD_TIMESTEP = 203,
  WORLD_LENGTH_UNIT = 204,
  WORLD_NUM_SOLVER_ITERATIONS = 205,
  WORLD_NUM_INTERNAL_PGS_ITERATIONS = 206,
  WORLD_MAX_CCD_SUBSTEPS = 207,
  // WORLD QUERIES
  WORLD_CAST_RAY = 300,
  WORLD_CAST_RAY_AND_GET_NORMAL = 301,
  WORLD_INTERSECTIONS_WITH_RAY = 302,
  WORLD_CONTACT_PAIRS_WITH = 303,
  WORLD_INTERSECTION_PAIRS_WITH = 304,
  WORLD_INTERSECTION_PAIR = 305,

  // RIGID >= 400 && RIGID < 600
  CREATE_RIGID_BODY = 400,
  GET_RIGID_BODY = 401,
  REMOVE_RIGID_BODY = 402,

  // COLLIDER >= 600 && COLLIDER < 800
  CREATE_COLLIDER = 600,
  GET_COLLIDER = 601,
  REMOVE_COLLIDER = 602,
}
