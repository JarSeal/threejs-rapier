/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  PhysicsProtocolType,
  PhysicsUpProtocol,
  RayColliderIntersectionAPI,
  WorldAPI,
  WorldCastRayAndGetNormalResponse,
  WorldCastRayResponse,
  WorldIntersectionsWithRayResponse,
} from '../../core/Physics/PhysicsAPITypes';
import { getCollOrRigidId } from '../../core/Physics/PhysicsUtils';

export const physicsSwitchWorld = async (
  data: PhysicsUpProtocol,
  physicsWorldAPI: WorldAPI,
  sendMessage: (message: any, data: PhysicsUpProtocol) => void
) => {
  const type = data.type;

  switch (data.type) {
    // WorldAPI ---------------------------
    case PhysicsProtocolType.WORLD_GET_GRAVITY:
      // WORLD_GET_GRAVITY
      const gravity = physicsWorldAPI.getGravitySync();
      return sendMessage({ type, gravity }, data);
    case PhysicsProtocolType.WORLD_SET_GRAVITY:
      // WORLD_SET_GRAVITY
      return physicsWorldAPI.setGravity(data.gravity);
    case PhysicsProtocolType.WORLD_FREE:
      // WORLD_FREE
      return physicsWorldAPI.free();
    case PhysicsProtocolType.WORLD_PROPAGATE_POSITIONS:
      // WORLD_PROPAGATE_MODIFIED_BODY_POSITIONS_TO_COLLIDERS
      return physicsWorldAPI.propagateModifiedBodyPositionsToColliders();
    case PhysicsProtocolType.WORLD_GET_TIMESTEP:
      // WORLD_GET_TIMESTEP
      const dt = physicsWorldAPI.getTimestepSync();
      return sendMessage({ type, dt }, data);
    case PhysicsProtocolType.WORLD_SET_TIMESTEP:
      // WORLD_SET_TIMESTEP
      return physicsWorldAPI.setTimestep(data.dt);
    case PhysicsProtocolType.WORLD_GET_LENGTH_UNIT:
      // WORLD_GET_LENGTH_UNIT
      const unitsPerMeter = physicsWorldAPI.getLengthUnitSync();
      return sendMessage({ type, unitsPerMeter }, data);
    case PhysicsProtocolType.WORLD_SET_LENGTH_UNIT:
      // WORLD_SET_LENGTH_UNIT
      return physicsWorldAPI.setLengthUnit(data.unitsPerMeter);
    case PhysicsProtocolType.WORLD_GET_SOLVER_ITERS:
      // WORLD_GET_SOLVER_ITERS
      const solverIterations = physicsWorldAPI.getNumSolverIterationsSync();
      return sendMessage({ type, solverIterations }, data);
    case PhysicsProtocolType.WORLD_SET_SOLVER_ITERS:
      // WORLD_SET_SOLVER_ITERS
      return physicsWorldAPI.setNumSolverIterations(data.niter);
    case PhysicsProtocolType.WORLD_GET_PGS_ITERS:
      // WORLD_GET_PGS_ITERS
      const internalPgsIterations = physicsWorldAPI.getNumInternalPgsIterationsSync();
      return sendMessage({ type, internalPgsIterations }, data);
    case PhysicsProtocolType.WORLD_SET_PGS_ITERS:
      // WORLD_SET_PGS_ITERS
      return physicsWorldAPI.setNumInternalPgsIterations(data.niter);
    case PhysicsProtocolType.WORLD_GET_CCD_SUBSTEPS:
      // WORLD_GET_CCD_SUBSTEPS
      const substeps = physicsWorldAPI.getMaxCcdSubstepsSync();
      return sendMessage({ type, substeps }, data);
    case PhysicsProtocolType.WORLD_SET_CCD_SUBSTEPS:
      // WORLD_SET_CCD_SUBSTEPS
      return physicsWorldAPI.setMaxCcdSubstepsSync(data.substeps);
    case PhysicsProtocolType.WORLD_CAST_RAY:
      // WORLD_CAST_RAY
      let hitTransfer: WorldCastRayResponse['hit'] = null;
      const hit = physicsWorldAPI.castRaySync(
        data.ray,
        data.maxToi,
        data.solid,
        data.filterFlags,
        data.filterGroups,
        data.filterExcludeCollider,
        data.filterExcludeRigidBody
      );
      if (hit) {
        const colliderId = getCollOrRigidId(hit.collider);
        if (colliderId) {
          hitTransfer = { ...hit, collider: colliderId };
        }
      }
      return sendMessage({ type, hit: hitTransfer }, data);
    case PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL: {
      // WORLD_CAST_RAY_AND_GET_NORMAL
      let intersectionTransfer: WorldCastRayAndGetNormalResponse['intersection'] = null;
      const intersection = physicsWorldAPI.castRayAndGetNormalSync(
        data.ray,
        data.maxToi,
        data.solid,
        data.filterFlags,
        data.filterGroups,
        data.filterExcludeCollider,
        data.filterExcludeRigidBody
      );
      if (intersection) {
        const colliderId = getCollOrRigidId(intersection.collider);
        if (colliderId) {
          intersectionTransfer = { ...intersection, collider: colliderId };
        }
      }
      return sendMessage({ type, intersection: intersectionTransfer }, data);
    }
    case PhysicsProtocolType.WORLD_INTERSECTIONS_WITH_RAY: {
      // WORLD_INTERSECTIONS_WITH_RAY
      const hits: WorldIntersectionsWithRayResponse['intersections'] = [];
      physicsWorldAPI.intersectionsWithRaySync(
        data.ray,
        data.maxToi,
        data.solid,
        (intersect: RayColliderIntersectionAPI) => {
          const colliderId = getCollOrRigidId(intersect.collider);
          if (colliderId) {
            const hit = { ...intersect, collider: colliderId };
            hits.push(hit);
          }
          return true;
        },
        data.filterFlags,
        data.filterGroups,
        data.filterExcludeCollider,
        data.filterExcludeRigidBody
      );
      return sendMessage({ type, hits }, data);
    }
    case PhysicsProtocolType.WORLD_CONTACT_PAIRS_WITH: {
      // WORLD_CONTACT_PAIRS_WITH
      const colliderIds: number[] = [];
      physicsWorldAPI.contactPairsWithSync(data.colliderId, (collider2) => {
        const coll2Id = getCollOrRigidId(collider2);
        if (coll2Id) colliderIds.push(coll2Id);
      });
      return sendMessage({ type, colliderIds }, data);
    }
    case PhysicsProtocolType.WORLD_INTERSECTION_PAIRS_WITH: {
      // WORLD_INTERSECTION_PAIRS_WITH
      const colliderIds: number[] = [];
      physicsWorldAPI.intersectionPairsWithSync(data.colliderId, (collider2) => {
        const coll2Id = getCollOrRigidId(collider2);
        if (coll2Id) colliderIds.push(coll2Id);
      });
      return sendMessage({ type, colliderIds }, data);
    }
    case PhysicsProtocolType.WORLD_INTERSECTION_PAIR: {
      // WORLD_INTERSECTION_PAIR
      const isIntersecting = physicsWorldAPI.intersectionPairSync(
        data.colliderId1,
        data.colliderId2
      );
      return sendMessage({ type, isIntersecting }, data);
    }

    default:
      // ERROR
      sendMessage(
        {
          type: PhysicsProtocolType.ERROR,
          message: `Unknown physics worker (up) protocol type: ${type} (in WORLD sub type)`,
        },
        data
      );
  }
};
