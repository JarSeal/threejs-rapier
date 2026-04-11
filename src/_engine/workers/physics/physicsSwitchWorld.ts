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
    case PhysicsProtocolType.WORLD_GRAVITY:
      // WORLD_GRAVITY
      const gravity = await physicsWorldAPI.gravity(data.gravity);
      return sendMessage({ type, gravity }, data);
    case PhysicsProtocolType.WORLD_FREE:
      // WORLD_FREE
      return physicsWorldAPI.free();
    case PhysicsProtocolType.WORLD_PROPAGATE_MODIFIED_BODY_POSITIONS_TO_COLLIDERS:
      // WORLD_PROPAGATE_MODIFIED_BODY_POSITIONS_TO_COLLIDERS
      return physicsWorldAPI.propagateModifiedBodyPositionsToColliders();
    case PhysicsProtocolType.WORLD_TIMESTEP:
      // WORLD_TIMESTEP
      const dt = await physicsWorldAPI.timestep(data.dt);
      return sendMessage({ type, dt }, data);
    case PhysicsProtocolType.WORLD_LENGTH_UNIT:
      // WORLD_LENGTH_UNIT
      const unitsPerMeter = await physicsWorldAPI.lengthUnit(data.unitsPerMeter);
      return sendMessage({ type, unitsPerMeter }, data);
    case PhysicsProtocolType.WORLD_NUM_SOLVER_ITERATIONS:
      // WORLD_NUM_SOLVER_ITERATIONS
      const solverIterations = await physicsWorldAPI.numSolverIterations(data.niter);
      return sendMessage({ type, solverIterations }, data);
    case PhysicsProtocolType.WORLD_NUM_INTERNAL_PGS_ITERATIONS:
      // WORLD_NUM_INTERNAL_PGS_ITERATIONS
      const internalPgsIterations = await physicsWorldAPI.numSolverIterations(data.niter);
      return sendMessage({ type, internalPgsIterations }, data);
    case PhysicsProtocolType.WORLD_MAX_CCD_SUBSTEPS:
      // WORLD_MAX_CCD_SUBSTEPS
      const substeps = await physicsWorldAPI.maxCcdSubsteps(data.substeps);
      return sendMessage({ type, substeps }, data);
    case PhysicsProtocolType.WORLD_CAST_RAY:
      // WORLD_CAST_RAY
      let hitTransfer: WorldCastRayResponse['hit'] = null;
      const hit = await physicsWorldAPI.castRay(
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
      const intersection = await physicsWorldAPI.castRayAndGetNormal(
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
      physicsWorldAPI.intersectionsWithRay(
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
      physicsWorldAPI.contactPairsWith(data.colliderId, (collider2) => {
        const coll2Id = getCollOrRigidId(collider2);
        if (coll2Id) colliderIds.push(coll2Id);
      });
      return sendMessage({ type, colliderIds }, data);
    }
    case PhysicsProtocolType.WORLD_INTERSECTION_PAIRS_WITH: {
      // WORLD_INTERSECTION_PAIRS_WITH
      const colliderIds: number[] = [];
      physicsWorldAPI.intersectionPairsWith(data.colliderId, (collider2) => {
        const coll2Id = getCollOrRigidId(collider2);
        if (coll2Id) colliderIds.push(coll2Id);
      });
      return sendMessage({ type, colliderIds }, data);
    }
    case PhysicsProtocolType.WORLD_INTERSECTION_PAIR: {
      // WORLD_INTERSECTION_PAIR
      const isIntersecting = physicsWorldAPI.intersectionPair(data.colliderId1, data.colliderId2);
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
