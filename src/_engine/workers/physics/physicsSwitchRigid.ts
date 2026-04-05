/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  EngineAPIType,
  PhysicsProtocolType,
  PhysicsUpProtocol,
  WorldAPI,
} from '../../core/Physics/PhysicsAPITypes';

export const physicsSwitchRigid = async (
  data: PhysicsUpProtocol,
  physicsWorldAPI: WorldAPI,
  engAPI: EngineAPIType,
  sendMessage: (message: any, data: PhysicsUpProtocol) => void
) => {
  const type = data.type;

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
    case PhysicsProtocolType.CREATE_COLLIDER:
      // CREATE_COLLIDER
      const collId = (await physicsWorldAPI.createCollider(data.params)).id;
      return sendMessage({ type, id: collId }, data);
    case PhysicsProtocolType.CREATE_COLLIDERS:
      // CREATE_COLLIDERS
      const collIds = engAPI.createColliders(data.params).map((api) => api.id);
      return sendMessage({ type, ids: collIds }, data);
    case PhysicsProtocolType.DELETE_RIGID_BODY:
    // DELETE_RIGID_BODY
    // const response = engAPI.deleteRigidBody(data.id);
  }
};
