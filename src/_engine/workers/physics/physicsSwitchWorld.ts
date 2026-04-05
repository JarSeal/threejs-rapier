/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  PhysicsProtocolType,
  PhysicsUpProtocol,
  WorldAPI,
} from '../../core/Physics/PhysicsAPITypes';

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
      const hit = await physicsWorldAPI.castRay(
        data.ray,
        data.maxToi,
        data.solid,
        data.filterFlags,
        data.filterGroups,
        data.filterExcludeCollider,
        data.filterExcludeRigidBody
      );
      return sendMessage({ type, hit }, data);
  }
};
