/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  EngineAPIType,
  PhysicsProtocolType,
  PhysicsUpProtocol,
  RigidBodyAPI,
  WorldAPI,
} from '../../core/Physics/PhysicsAPITypes';

const sendNoRigidBodyErrorMessage = (
  sendMessage: (message: any, data: PhysicsUpProtocol) => void,
  data: PhysicsUpProtocol
) =>
  sendMessage(
    {
      type: PhysicsProtocolType.ERROR,
      message: `Could not find rigidBodyAPI (in ${data.type}).`,
    },
    data
  );

export const physicsSwitchRigid = async (
  data: PhysicsUpProtocol,
  physicsWorldAPI: WorldAPI,
  engAPI: EngineAPIType,
  sendMessage: (message: any, data: PhysicsUpProtocol) => void
) => {
  const type = data.type;
  const rigidBodyAPI =
    'rigidBodyId' in data ? engAPI.getRigidBodyAPIWithId(data.rigidBodyId) : undefined;

  switch (data.type) {
    // RigidBodyAPI ---------------------------
    case PhysicsProtocolType.CREATE_RIGID_BODY:
      // CREATE_RIGID_BODY
      const rbId = (await physicsWorldAPI.createRigidBody(data.params)).id;
      return sendMessage({ type, id: rbId }, data);
    case PhysicsProtocolType.CREATE_RIGID_BODIES:
      // CREATE_RIGID_BODIES
      const rbIds = engAPI.createRigidBodies(data.params).map((api) => api.id);
      return sendMessage({ type, ids: rbIds }, data);
    case PhysicsProtocolType.DELETE_RIGID_BODY:
      // DELETE_RIGID_BODY
      return sendMessage({ type, ...engAPI.deleteRigidBody(data.id) }, data);
    case PhysicsProtocolType.DELETE_RIGID_BODIES:
      // DELETE_RIGID_BODIES
      return sendMessage({ type, ...engAPI.deleteRigidBodies(data.ids) }, data);
    case PhysicsProtocolType.RIGID_GET_USERDATA: {
      // RIGID_GET_USERDATA
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, userData: rigidBodyAPI.getUserDataSync() }, data);
    }
    case PhysicsProtocolType.RIGID_SET_USERDATA: {
      // RIGID_SET_USERDATA
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setUserData(data.userData);
    }
    case PhysicsProtocolType.RIGID_IS_VALID:
      // RIGID_IS_VALID
      return sendMessage({ type, isValid: Boolean(rigidBodyAPI?.isValidSync()) }, data);
    case PhysicsProtocolType.RIGID_LOCK_TRANSLATIONS:
      // RIGID_LOCK_TRANSLATIONS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.lockTranslations(data.locked, data.wakeUp);
    case PhysicsProtocolType.RIGID_LOCK_ROTATIONS:
      // RIGID_LOCK_ROTATIONS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.lockRotations(data.locked, data.wakeUp);
    case PhysicsProtocolType.RIGID_SET_ENABLED_TRANSLATIONS:
      // RIGID_SET_ENABLED_TRANSLATIONS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setEnabledTranslations(
        data.enableX,
        data.enableY,
        data.enableZ,
        data.wakeUp
      );
    case PhysicsProtocolType.RIGID_SET_ENABLED_ROTATIONS:
      // RIGID_SET_ENABLED_ROTATIONS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setEnabledRotations(
        data.enableX,
        data.enableY,
        data.enableZ,
        data.wakeUp
      );
    case PhysicsProtocolType.RIGID_DOMINANCE_GROUP:
      // RIGID_DOMINANCE_GROUP
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, dominanceGroup: rigidBodyAPI.dominanceGroupSync() }, data);
    case PhysicsProtocolType.RIGID_SET_DOMINANCE_GROUP:
      // RIGID_SET_DOMINANCE_GROUP
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setDominanceGroup(data.group);
    case PhysicsProtocolType.RIGID_ADDITIONAL_SOLVER_ITERATIONS:
      // RIGID_ADDITIONAL_SOLVER_ITERATIONS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage(
        { type, additionalIterations: rigidBodyAPI.additionalSolverIterationsSync() },
        data
      );
    case PhysicsProtocolType.RIGID_SET_ADDITIONAL_SOLVER_ITERATIONS:
      // RIGID_SET_ADDITIONAL_SOLVER_ITERATIONS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setAdditionalSolverIterations(data.iters);
    case PhysicsProtocolType.RIGID_ENABLE_CCD:
      // RIGID_ENABLE_CCD
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.enableCcd(data.enabled);
    case PhysicsProtocolType.RIGID_SET_SOFT_CCD_PREDICTION:
      // RIGID_SET_SOFT_CCD_PREDICTION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setSoftCcdPrediction(data.distance);
    case PhysicsProtocolType.RIGID_SOFT_CCD_PREDICTION:
      // RIGID_SOFT_CCD_PREDICTION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, softCcdPrediction: rigidBodyAPI.softCcdPredictionSync() }, data);
    // @CHORE: remove
    case PhysicsProtocolType.RIGID_TRANSLATION:
      // RIGID_TRANSLATION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, translation: rigidBodyAPI.translation() }, data);
    // @CHORE: remove
    case PhysicsProtocolType.RIGID_ROTATION:
      // RIGID_ROTATION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, rotation: rigidBodyAPI.rotation() }, data);
    case PhysicsProtocolType.RIGID_NEXT_TRANSLATION:
      // RIGID_NEXT_TRANSLATION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, nextTranslation: rigidBodyAPI.nextTranslationSync() }, data);
    case PhysicsProtocolType.RIGID_NEXT_ROTATION:
      // RIGID_NEXT_ROTATION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, nextRotation: rigidBodyAPI.nextRotationSync() }, data);
    case PhysicsProtocolType.RIGID_SET_TRANSLATION:
      // RIGID_SET_TRANSLATION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setTranslation(data.tra, data.wakeUp);
    case PhysicsProtocolType.RIGID_SET_LINVEL:
      // RIGID_SET_LINVEL
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setLinvel(data.vel, data.wakeUp);
    case PhysicsProtocolType.RIGID_GRAVITY_SCALE:
      // RIGID_GRAVITY_SCALE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, gravityScale: rigidBodyAPI.gravityScaleSync() }, data);
    case PhysicsProtocolType.RIGID_SET_GRAVITY_SCALE:
      // RIGID_SET_GRAVITY_SCALE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setGravityScale(data.factor, data.wakeUp);
    case PhysicsProtocolType.RIGID_SET_ROTATION:
      // RIGID_SET_ROTATION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setRotation(data.rot, data.wakeUp);
    case PhysicsProtocolType.RIGID_SET_ANGVEL:
      // RIGID_SET_ANGVEL
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setAngvel(data.vel, data.wakeUp);
    case PhysicsProtocolType.RIGID_SET_NEXT_KINEMATIC_TRANSLATION:
      // RIGID_SET_NEXT_KINEMATIC_TRANSLATION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setNextKinematicTranslation(data.t);
    case PhysicsProtocolType.RIGID_SET_NEXT_KINEMATIC_ROTATION:
      // RIGID_SET_NEXT_KINEMATIC_ROTATION
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setNextKinematicRotation(data.rot);
    // @CHORE: remove
    case PhysicsProtocolType.RIGID_LINVEL:
      // RIGID_LINVEL
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, linvel: rigidBodyAPI.linvel() }, data);
    case PhysicsProtocolType.RIGID_VELOCITY_AT_POINT:
      // RIGID_VELOCITY_AT_POINT
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage(
        { type, velocityAtPoint: rigidBodyAPI.velocityAtPointSync(data.point) },
        data
      );
    // @CHORE: remove
    case PhysicsProtocolType.RIGID_ANGVEL:
      // RIGID_ANGVEL
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, angvel: rigidBodyAPI.angvel() }, data);
    case PhysicsProtocolType.RIGID_MASS:
      // RIGID_MASS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, mass: rigidBodyAPI.massSync() }, data);
    case PhysicsProtocolType.RIGID_EFFECTIVE_INV_MASS:
      // RIGID_EFFECTIVE_INV_MASS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, effectiveInvMass: rigidBodyAPI.effectiveInvMassSync() }, data);
    case PhysicsProtocolType.RIGID_INV_MASS:
      // RIGID_INV_MASS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, invMass: rigidBodyAPI.invMassSync() }, data);
    case PhysicsProtocolType.RIGID_LOCAL_COM:
      // RIGID_LOCAL_COM
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, localCom: rigidBodyAPI.localComSync() }, data);
    case PhysicsProtocolType.RIGID_WORLD_COM:
      // RIGID_WORLD_COM
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, worldCom: rigidBodyAPI.worldComSync() }, data);
    case PhysicsProtocolType.RIGID_INV_PRINCIPAL_INERTIA:
      // RIGID_INV_PRINCIPAL_INERTIA
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage(
        { type, invPrincipalInertia: rigidBodyAPI.invPrincipalInertiaSync() },
        data
      );
    case PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA:
      // RIGID_PRINCIPAL_INERTIA
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, principalInertia: rigidBodyAPI.principalInertiaSync() }, data);
    case PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA_LOCAL_FRAME:
      // RIGID_PRINCIPAL_INERTIA_LOCAL_FRAME
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage(
        { type, principalInertiaLocalFrame: rigidBodyAPI.principalInertiaLocalFrameSync() },
        data
      );
    case PhysicsProtocolType.RIGID_SLEEP:
      // RIGID_SLEEP
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.sleep();
    case PhysicsProtocolType.RIGID_WAKE_UP:
      // RIGID_WAKE_UP
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.wakeUp();
    case PhysicsProtocolType.RIGID_IS_CCD_ENABLED:
      // RIGID_IS_CCD_ENABLED
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, isCcdEnabled: rigidBodyAPI.isCcdEnabledSync() }, data);
    case PhysicsProtocolType.RIGID_NUM_COLLIDERS:
      // RIGID_NUM_COLLIDERS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, numColliders: rigidBodyAPI.numCollidersSync() }, data);
    case PhysicsProtocolType.RIGID_COLLIDER:
      // RIGID_COLLIDER
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      // Returns the colliderAPI id
      const colliderAPI = rigidBodyAPI.collider(data.index);
      return sendMessage(
        { type, colliderId: typeof colliderAPI === 'number' ? colliderAPI : colliderAPI.id },
        data
      );
    case PhysicsProtocolType.RIGID_SET_ENABLED:
      // RIGID_SET_ENABLED
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setEnabled(data.enabled);
    case PhysicsProtocolType.RIGID_IS_ENABLED:
      // RIGID_IS_ENABLED
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, isEnabled: rigidBodyAPI.isEnabledSync() }, data);
    case PhysicsProtocolType.RIGID_BODY_TYPE:
      // RIGID_BODY_TYPE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, bodyType: rigidBodyAPI.bodyTypeSync() }, data);
    case PhysicsProtocolType.RIGID_SET_BODY_TYPE:
      // RIGID_SET_BODY_TYPE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setBodyType(data.bodyType, data.wakeUp);
    case PhysicsProtocolType.RIGID_IS_SLEEPING:
      // RIGID_IS_SLEEPING
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, isSleeping: rigidBodyAPI.isSleepingSync() }, data);
    case PhysicsProtocolType.RIGID_IS_MOVING:
      // RIGID_IS_MOVING
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, isMoving: rigidBodyAPI.isMovingSync() }, data);
    case PhysicsProtocolType.RIGID_IS_FIXED:
      // RIGID_IS_FIXED
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, isFixed: rigidBodyAPI.isFixedSync() }, data);
    case PhysicsProtocolType.RIGID_IS_KINEMATIC:
      // RIGID_IS_KINEMATIC
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, isKinematic: rigidBodyAPI.isKinematicSync() }, data);
    case PhysicsProtocolType.RIGID_IS_DYNAMIC:
      // RIGID_IS_DYNAMIC
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, isDynamic: rigidBodyAPI.isDynamicSync() }, data);
    case PhysicsProtocolType.RIGID_LINEAR_DAMPING:
      // RIGID_LINEAR_DAMPING
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, linearDamping: rigidBodyAPI.linearDampingSync() }, data);
    case PhysicsProtocolType.RIGID_ANGULAR_DAMPING:
      // RIGID_ANGULAR_DAMPING
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, angularDamping: rigidBodyAPI.angularDampingSync() }, data);
    case PhysicsProtocolType.RIGID_SET_LINEAR_DAMPING:
      // RIGID_SET_LINEAR_DAMPING
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setLinearDamping(data.factor);
    case PhysicsProtocolType.RIGID_SET_ANGULAR_DAMPING:
      // RIGID_SET_ANGULAR_DAMPING
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setAngularDamping(data.factor);
    case PhysicsProtocolType.RIGID_RECOMPUTE_MASS_PROPERTIES:
      // RIGID_RECOMPUTE_MASS_PROPERTIES
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.recomputeMassPropertiesFromColliders();
    case PhysicsProtocolType.RIGID_SET_ADDITIONAL_MASS:
      // RIGID_SET_ADDITIONAL_MASS
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setAdditionalMass(data.mass, data.wakeUp);
    case PhysicsProtocolType.RIGID_SET_ADDITIONAL_MASS_PROPERTIES:
      // RIGID_SET_ADDITIONAL_MASS_PROPERTIES
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.setAdditionalMassProperties(
        data.mass,
        data.centerOfMass,
        data.principalAngularInertia,
        data.angularInertiaLocalFrame,
        data.wakeUp
      );
    case PhysicsProtocolType.RIGID_RESET_FORCES:
      // RIGID_RESET_FORCES
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.resetForces(data.wakeUp);
    case PhysicsProtocolType.RIGID_RESET_TORQUES:
      // RIGID_RESET_TORQUES
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.resetTorques(data.wakeUp);
    case PhysicsProtocolType.RIGID_ADD_FORCE:
      // RIGID_ADD_FORCE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.addForce(data.force, data.wakeUp);
    case PhysicsProtocolType.RIGID_APPLY_IMPULSE:
      // RIGID_APPLY_IMPULSE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.applyImpulse(data.impulse, data.wakeUp);
    case PhysicsProtocolType.RIGID_ADD_TORQUE:
      // RIGID_ADD_TORQUE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.addTorque(data.torque, data.wakeUp);
    case PhysicsProtocolType.RIGID_APPLY_TORQUE_IMPULSE:
      // RIGID_APPLY_TORQUE_IMPULSE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.applyTorqueImpulse(data.torqueImpulse, data.wakeUp);
    case PhysicsProtocolType.RIGID_ADD_FORCE_AT_POINT:
      // RIGID_ADD_FORCE_AT_POINT
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.addForceAtPoint(data.force, data.point, data.wakeUp);
    case PhysicsProtocolType.RIGID_APPLY_IMPULSE_AT_POINT:
      // RIGID_APPLY_IMPULSE_AT_POINT
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return rigidBodyAPI.applyImpulseAtPoint(data.impulse, data.point, data.wakeUp);
    case PhysicsProtocolType.RIGID_USER_FORCE:
      // RIGID_USER_FORCE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, userForce: rigidBodyAPI.userForceSync() }, data);
    case PhysicsProtocolType.RIGID_USER_TORQUE:
      // RIGID_USER_TORQUE
      if (!rigidBodyAPI) return sendNoRigidBodyErrorMessage(sendMessage, data);
      return sendMessage({ type, userTorque: rigidBodyAPI.userTorqueSync() }, data);

    default:
      // ERROR
      sendMessage(
        {
          type: PhysicsProtocolType.ERROR,
          message: `Unknown physics worker (up) protocol type: ${type} (in RIGID sub type)`,
        },
        data
      );
  }
};
