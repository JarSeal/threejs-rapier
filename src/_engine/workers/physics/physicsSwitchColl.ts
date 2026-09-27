/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  EngineAPIType,
  PhysicsProtocolType,
  PhysicsUpProtocol,
  WorldAPI,
} from '../../core/Physics/PhysicsAPITypes';

const sendNoCollErrorMessage = (
  sendMessage: (message: any, data: PhysicsUpProtocol, isError?: boolean) => void,
  data: PhysicsUpProtocol
) =>
  sendMessage(
    {
      type: PhysicsProtocolType.ERROR,
      message: `Could not find ColliderAPI in worker (physicsSwitchColl) for ID: ${(data as any).colliderId}`,
    },
    data
  );

export const physicsSwitchColl = async (
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
  const collAPI = 'colliderId' in data ? engAPI.getColliderAPIWithId(data.colliderId) : undefined;

  switch (type) {
    // --- Lifecycle ---
    case PhysicsProtocolType.CREATE_COLLIDER: {
      const coll = await physicsWorldAPI.createCollider(data.params, data.parentId);
      return sendMessage({ type, id: coll.id, parentId: data.parentId }, data);
    }

    case PhysicsProtocolType.CREATE_COLLIDERS: {
      const colls = await engAPI.createColliders(data.params);
      const ids = colls.map((c) => c.id);
      return sendMessage({ type, ids }, data);
    }

    case PhysicsProtocolType.DELETE_COLLIDER: {
      return sendMessage({ type, ...engAPI.deleteCollider(data.id, data.wakeUp) }, data);
    }

    case PhysicsProtocolType.DELETE_COLLIDERS: {
      return sendMessage({ type, ...engAPI.deleteColliders(data.ids, data.wakeUps) }, data);
    }

    // --- Metadata & Validity ---
    case PhysicsProtocolType.COLL_GET_USERDATA: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, userData: collAPI.getUserDataSync() }, data);
    }

    case PhysicsProtocolType.COLL_SET_USERDATA: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setUserData(data.userData, data.addToExisting);
    }

    case PhysicsProtocolType.COLL_IS_VALID: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, isValid: collAPI.isValidSync() }, data);
    }

    // --- Transformation (Getters) ---
    case PhysicsProtocolType.COLL_TRANSLATION: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, translation: collAPI.translationSync() }, data);
    }

    case PhysicsProtocolType.COLL_ROTATION: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, rotation: collAPI.rotationSync() }, data);
    }

    case PhysicsProtocolType.COLL_TRANSLATION_WRT_PARENT: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, translation: collAPI.translationWrtParentSync() }, data);
    }

    case PhysicsProtocolType.COLL_ROTATION_WRT_PARENT: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, rotation: collAPI.rotationWrtParentSync() }, data);
    }

    // --- Transformation (Setters) ---
    case PhysicsProtocolType.COLL_SET_TRANSLATION: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setTranslation(data.tra);
    }

    case PhysicsProtocolType.COLL_SET_ROTATION: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setRotation(data.rot);
    }

    case PhysicsProtocolType.COLL_SET_TRANSLATION_WRT_PARENT: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setTranslationWrtParent(data.tra);
    }

    case PhysicsProtocolType.COLL_SET_ROTATION_WRT_PARENT: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setRotationWrtParent(data.rot);
    }

    // --- State & Config ---
    case PhysicsProtocolType.COLL_IS_SENSOR: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, isSensor: collAPI.isSensorSync() }, data);
    }

    case PhysicsProtocolType.COLL_SET_SENSOR: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setSensor(data.isSensor);
    }

    case PhysicsProtocolType.COLL_IS_ENABLED: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, isEnabled: collAPI.isEnabledSync() }, data);
    }

    case PhysicsProtocolType.COLL_SET_ENABLED: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setEnabled(data.enabled);
    }

    case PhysicsProtocolType.COLL_FRICTION: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, friction: collAPI.frictionSync() }, data);
    }

    case PhysicsProtocolType.COLL_SET_FRICTION: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setFriction(data.friction);
    }

    case PhysicsProtocolType.COLL_RESTITUTION: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, restitution: collAPI.restitutionSync() }, data);
    }

    case PhysicsProtocolType.COLL_SET_RESTITUTION: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setRestitution(data.restitution);
    }

    // --- Mass Properties ---
    case PhysicsProtocolType.COLL_MASS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, mass: collAPI.massSync() }, data);
    }

    case PhysicsProtocolType.COLL_DENSITY: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, density: collAPI.densitySync() }, data);
    }

    case PhysicsProtocolType.COLL_SET_DENSITY: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setDensity(data.density);
    }

    case PhysicsProtocolType.COLL_SET_MASS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setMass(data.mass);
    }

    case PhysicsProtocolType.COLL_SET_MASS_PROPERTIES: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setMassProperties(
        data.mass,
        data.centerOfMass,
        data.principalAngularInertia,
        data.angularInertiaLocalFrame
      );
    }

    // --- Geometry ---
    case PhysicsProtocolType.COLL_SHAPE_TYPE: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, shapeType: collAPI.shapeTypeSync() }, data);
    }

    case PhysicsProtocolType.COLL_RADIUS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, radius: collAPI.radiusSync() }, data);
    }

    case PhysicsProtocolType.COLL_HALF_HEIGHT: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, halfHeight: collAPI.halfHeightSync() }, data);
    }

    case PhysicsProtocolType.COLL_HALF_EXTENTS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, halfExtents: collAPI.halfExtentsSync() }, data);
    }

    // --- Geometry (mesh-type shapes) ---
    // Mesh data can be megabytes, so these three travel as Transferables rather than
    // through structured clone. They are copied first: the arrays the getters return
    // belong to the live Rapier shape, and transferring those would neuter the shape
    // the simulation is still using. The cost is paid once per collider, the moment its
    // wireframe is first requested — never per frame.
    case PhysicsProtocolType.COLL_VERTICES: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      const live = collAPI.verticesSync();
      const vertices = live ? new Float32Array(live) : null;
      return sendMessage({ type, vertices }, data, false, vertices ? [vertices.buffer] : undefined);
    }

    case PhysicsProtocolType.COLL_INDICES: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      const live = collAPI.indicesSync();
      const indices = live ? new Uint32Array(live) : null;
      return sendMessage({ type, indices }, data, false, indices ? [indices.buffer] : undefined);
    }

    case PhysicsProtocolType.COLL_HEIGHTS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      const live = collAPI.heightsSync();
      const heights = live ? { ...live, heights: new Float32Array(live.heights) } : null;
      return sendMessage(
        { type, heights },
        data,
        false,
        heights ? [heights.heights.buffer] : undefined
      );
    }

    case PhysicsProtocolType.COLL_NORMAL: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, normal: collAPI.normalSync() }, data);
    }

    case PhysicsProtocolType.COLL_BORDER_RADIUS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, borderRadius: collAPI.borderRadiusSync() }, data);
    }

    // --- Filtering Groups ---
    case PhysicsProtocolType.COLL_COLLISION_GROUPS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, groups: collAPI.collisionGroupsSync() }, data);
    }

    case PhysicsProtocolType.COLL_SET_COLLISION_GROUPS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setCollisionGroups(data.groups);
    }

    case PhysicsProtocolType.COLL_SOLVER_GROUPS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, groups: collAPI.solverGroupsSync() }, data);
    }

    case PhysicsProtocolType.COLL_SET_SOLVER_GROUPS: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return collAPI.setSolverGroups(data.groups);
    }

    // --- Queries ---
    case PhysicsProtocolType.COLL_CONTAINS_POINT: {
      if (!collAPI) return sendNoCollErrorMessage(sendMessage, data);
      return sendMessage({ type, isInside: collAPI.containsPointSync(data.point) }, data);
    }

    default:
      sendMessage(
        {
          type: PhysicsProtocolType.ERROR,
          message: `Unknown physics worker (up) protocol type: ${type} (in COLL sub type)`,
        },
        data
      );
  }
};
