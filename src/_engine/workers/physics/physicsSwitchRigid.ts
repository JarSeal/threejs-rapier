/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  PhysicsProtocolType,
  PhysicsUpProtocol,
  WorldAPI,
} from '../../core/Physics/PhysicsAPITypes';

export const physicsSwitchRigid = async (
  data: PhysicsUpProtocol,
  physicsWorldAPI: WorldAPI,
  sendMessage: (message: any, data: PhysicsUpProtocol) => void
) => {
  const type = data.type;

  switch (data.type) {
    // RigidBodyAPI ---------------------------
    case PhysicsProtocolType.CREATE_RIGID_BODY:
      // CREATE_RIGID_BODY
      const rbId = (await physicsWorldAPI.createRigidBody(data.params)).id;
      return sendMessage({ type, id: rbId }, data);
    case PhysicsProtocolType.CREATE_COLLIDER:
      // CREATE_COLLIDER
      const collId = (await physicsWorldAPI.createCollider(data.params)).id;
      return sendMessage({ type, id: collId }, data);
  }
};
