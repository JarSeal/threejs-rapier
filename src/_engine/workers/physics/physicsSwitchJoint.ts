/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  EngineAPIType,
  PhysicsProtocolType,
  PhysicsUpProtocol,
  WorldAPI,
} from '../../core/Physics/PhysicsAPITypes';

const sendNoJointErrorMessage = (
  sendMessage: (message: any, data: PhysicsUpProtocol, isError?: boolean) => void,
  data: PhysicsUpProtocol
) =>
  sendMessage(
    {
      type: PhysicsProtocolType.ERROR,
      message: `Could not find JointAPI in worker (physicsSwitchJoint) for ID: ${(data as any).jointId}`,
    },
    data
  );

export const physicsSwitchJoint = async (
  data: PhysicsUpProtocol,
  physicsWorldAPI: WorldAPI,
  engAPI: EngineAPIType,
  sendMessage: (
    message: any,
    data: PhysicsUpProtocol,
    isError?: boolean,
    transfer?: Transferable[]
  ) => void
) => {
  const type = data.type;

  // Resolve the Engine-side API instance using the ID from the message
  const jointAPI = 'jointId' in data ? engAPI.getJointAPIWithId(data.jointId) : undefined;

  switch (type) {
    // --- Lifecycle ---
    case PhysicsProtocolType.CREATE_JOINT: {
      const joint = await physicsWorldAPI.createJoint(data.params);
      return sendMessage({ type, id: joint.id }, data);
    }

    case PhysicsProtocolType.CREATE_JOINTS: {
      const joints = await engAPI.createJoints(data.params);
      const ids = joints.map((j) => j.id);
      return sendMessage({ type, ids }, data);
    }

    case PhysicsProtocolType.DELETE_JOINT: {
      return sendMessage({ type, ...engAPI.deleteJoint(data.id, data.wakeUp) }, data);
    }

    case PhysicsProtocolType.DELETE_JOINTS: {
      return sendMessage({ type, ...engAPI.deleteJoints(data.ids, data.wakeUps) }, data);
    }

    // --- Metadata & Validity ---
    case PhysicsProtocolType.JOINT_GET_USERDATA: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return sendMessage({ type, userData: jointAPI.getUserDataSync() }, data);
    }

    case PhysicsProtocolType.JOINT_SET_USERDATA: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return jointAPI.setUserData(data.userData, data.addToExisting);
    }

    case PhysicsProtocolType.JOINT_IS_VALID: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return sendMessage({ type, isValid: jointAPI.isValidSync() }, data);
    }

    // --- Bodies & Anchors ---
    case PhysicsProtocolType.JOINT_BODY1_ID: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return sendMessage({ type, body1Id: jointAPI.body1IdSync() }, data);
    }

    case PhysicsProtocolType.JOINT_BODY2_ID: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return sendMessage({ type, body2Id: jointAPI.body2IdSync() }, data);
    }

    case PhysicsProtocolType.JOINT_ANCHOR1: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return sendMessage({ type, anchor1: jointAPI.anchor1Sync() }, data);
    }

    case PhysicsProtocolType.JOINT_ANCHOR2: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return sendMessage({ type, anchor2: jointAPI.anchor2Sync() }, data);
    }

    // --- Contacts ---
    case PhysicsProtocolType.JOINT_CONTACTS_ENABLED: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return sendMessage({ type, contactsEnabled: jointAPI.contactsEnabledSync() }, data);
    }

    case PhysicsProtocolType.JOINT_SET_CONTACTS_ENABLED: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return jointAPI.setContactsEnabled(data.enabled);
    }

    // --- Revolute/Prismatic only: limits & motor ---
    case PhysicsProtocolType.JOINT_LIMITS_ENABLED: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return sendMessage({ type, limitsEnabled: jointAPI.limitsEnabledSync() }, data);
    }

    case PhysicsProtocolType.JOINT_SET_LIMITS: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return jointAPI.setLimits(data.min, data.max);
    }

    case PhysicsProtocolType.JOINT_CONFIGURE_MOTOR_MODEL: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return jointAPI.configureMotorModel(data.model);
    }

    case PhysicsProtocolType.JOINT_CONFIGURE_MOTOR_VELOCITY: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return jointAPI.configureMotorVelocity(data.targetVel, data.factor);
    }

    case PhysicsProtocolType.JOINT_CONFIGURE_MOTOR_POSITION: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return jointAPI.configureMotorPosition(data.targetPos, data.stiffness, data.damping);
    }

    case PhysicsProtocolType.JOINT_CONFIGURE_MOTOR: {
      if (!jointAPI) return sendNoJointErrorMessage(sendMessage, data);
      return jointAPI.configureMotor(data.targetPos, data.targetVel, data.stiffness, data.damping);
    }

    default:
      sendMessage(
        {
          type: PhysicsProtocolType.ERROR,
          message: `Unknown physics worker (up) protocol type: ${type} (in JOINT sub type)`,
        },
        data
      );
  }
};
