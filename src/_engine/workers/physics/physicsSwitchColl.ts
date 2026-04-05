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
    // EngineAPI ---------------------------
    case PhysicsProtocolType.CREATE_COLLIDER:
      // CREATE_COLLIDER
      const collId = (await physicsWorldAPI.createCollider(data.params)).id;
      return sendMessage({ type, id: collId }, data);
    case PhysicsProtocolType.CREATE_COLLIDERS:
      // CREATE_COLLIDERS
      const collIds = engAPI.createColliders(data.params).map((api) => api.id);
      return sendMessage({ type, ids: collIds }, data);
    case PhysicsProtocolType.DELETE_COLLIDER:
      // DELETE_COLLIDER
      return sendMessage({ type, ...engAPI.deleteCollider(data.id, data.wakeUp) }, data);
    case PhysicsProtocolType.DELETE_COLLIDERS:
      // DELETE_COLLIDERS
      return sendMessage({ type, ...engAPI.deleteColliders(data.ids, data.wakeUp) }, data);
  }
};
