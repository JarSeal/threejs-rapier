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
export declare type PhysRay = {
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
 * The simulation status of a rigid-body.
 */
export declare enum RigidBodyType {
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
export type RigidBody = {
  userData: { [key: string]: unknown };
  setUserData(userData: { [key: string]: unknown }): void;
  /**
   * Rigid body handle.
   */
  readonly handle: number;
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
   * Locks or unlocks the ability of this rigid-body to translate along individual coordinate axes.
   *
   * @param enableX - If `false`, this rigid-body will no longer translate due to torques and impulses, along the X coordinate axis.
   * @param enableY - If `false`, this rigid-body will no longer translate due to torques and impulses, along the Y coordinate axis.
   * @param enableZ - If `false`, this rigid-body will no longer translate due to torques and impulses, along the Z coordinate axis.
   * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
   * @deprecated use `this.setEnabledTranslations` with the same arguments instead.
   */
  restrictTranslations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean): void;
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
   * Locks or unlocks the ability of this rigid-body to rotate along individual coordinate axes.
   *
   * @param enableX - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the X coordinate axis.
   * @param enableY - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the Y coordinate axis.
   * @param enableZ - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the Z coordinate axis.
   * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
   * @deprecated use `this.setEnabledRotations` with the same arguments instead.
   */
  restrictRotations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean): void;
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
  collider(i: number): Collider;
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
  bodyType(): RigidBodyType;
  /**
   * Set a new status for this rigid-body: static, dynamic, or kinematic.
   */
  setBodyType(type: RigidBodyType, wakeUp: boolean): void;
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
export type Collider = {
  /**
   * Collider handle.
   */
  readonly handle: number;
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
  setCollisionGroups(groups: InteractionGroups): void;
  /**
   * Sets the solver groups used by this collider.
   *
   * Forces between two colliders in contact will be computed iff their solver
   * groups are compatible.
   * See the documentation of `InteractionGroups` for details on the used bit pattern.
   *
   * @param groups - The solver groups used for the collider being built.
   */
  setSolverGroups(groups: InteractionGroups): void;
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
    voxels2: Collider,
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
  combineVoxelStates(voxels2: Collider, shift_x: number, shift_y: number, shift_z: number): void;
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
  parent(): RigidBody | null;
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
  collisionGroups(): InteractionGroups;
  /**
   * The solver groups of this collider.
   */
  solverGroups(): InteractionGroups;
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
export declare type InteractionGroups = number;

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
