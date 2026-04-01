import Rapier from '@dimforge/rapier3d-compat';
import { existsOrThrow } from '../../utils/helpers';
import type { Collider, RayColliderIntersection, RigidBody } from '@dimforge/rapier3d-compat';
import { ColliderParams, getPhysicsEngine, RigidBodyParams } from './PhysicsUtils';
import {
  ColliderAPI,
  InteractionGroupsAPI,
  PhysicsState,
  PhysRay,
  PhysVector,
  QueryFilterFlags,
  RayColliderIntersectionAPI,
  RigidBodyAPI,
  WorldAPI,
} from './PhysicsAPITypes';
import { lerror, lwarn } from '../../utils/Logger';

// @CHORE: needs a getter/setter function
const physicsState: PhysicsState = {
  enabled: false,
  physicsEngine: 'RAPIER',
  workerTarget: 'MAIN_THREAD',
  timestep: 60,
  timestepRatio: 1 / 60,
  backgroundBehavior: 'PAUSE',
  isPaused: false,
  pausedTime: 0,
  pauseDurationTotal: 0,
  pauseReason: null,
  minDeltaTime: 1 / 30,
  maxDeltaTime: 1 / 10,
  minSubSteps: 0,
  maxSubSteps: 60,
  worldStepEnabled: true,
  visualizerEnabled: false,
  gravity: { x: 0, y: -9.81, z: 0 },
  solverIterations: 10,
  internalPgsIterations: 1,
  interpolationEnabled: true,
};

/** NEW STUFF (@CHORE: delete this line when everything is diamonds!!!) */

const rigidBodies = new Map<number, number>(); // { "Running id", RigidBody.handle }
const colliders = new Map<number, number>(); // { "Running id", Collider.handle }
const rigidBodyAPIs = new Map<number, RigidBodyAPI>(); // { "Rapier handle", RigidBodyAPI }
const colliderAPIs = new Map<number, ColliderAPI>(); // { "Running id", ColliderAPI }
const rigidBodyNextIndex = 0;
const colliderNextIndex = 0;
const rigidBodyAPINextIndex = 0;
const colliderAPINextIndex = 0;
let worldCreated = false;
let RAPIER: typeof Rapier;
let physicsWorld: Rapier.World = { step: () => {} } as Rapier.World;
let physicsWorldAPI: WorldAPI;

/** Get Rapier.RigidBody with RigidBodyAPI or id */
const _getRigidBody = (bodyOrId?: RigidBodyAPI | number): RigidBody | undefined => {
  if (bodyOrId === undefined) return undefined;
  const id = typeof bodyOrId === 'number' ? bodyOrId : bodyOrId.id;
  const handle = rigidBodies.get(id);
  return handle !== undefined ? physicsWorld.getRigidBody(handle) : undefined;
};

/** Get Rapier.Collider with ColliderAPI or id */
const _getCollider = (collOrId?: ColliderAPI | number): Collider | undefined => {
  if (collOrId === undefined) return undefined;
  const id = typeof collOrId === 'number' ? collOrId : collOrId.id;
  const handle = colliders.get(id);
  return handle !== undefined ? physicsWorld.getCollider(handle) : undefined;
};

/** Get rigidBodyAPI with a Rapier.RigidBody or a Rapier.RigidBody.handle */
const _getRigidBodyAPI = (bodyOrHandle?: RigidBody | number): RigidBodyAPI | undefined => {
  if (bodyOrHandle === undefined) return undefined;
  const handle = typeof bodyOrHandle === 'number' ? bodyOrHandle : bodyOrHandle.handle;
  return rigidBodyAPIs.get(handle);
};

/** Get colliderAPI with a Rapier.Collider or a Rapier.Collider.handle */
const _getColliderAPI = (collOrHandle?: Collider | number): ColliderAPI | undefined => {
  if (collOrHandle === undefined) return undefined;
  const handle = typeof collOrHandle === 'number' ? collOrHandle : collOrHandle.handle;
  return colliderAPIs.get(handle);
};

export const init = (physicsState: PhysicsState, doNotCreateWorld?: boolean) => {
  RAPIER = existsOrThrow(
    getPhysicsEngine() as typeof Rapier,
    'Could not initialize RAPIER in EngineRapier.ts init().'
  );
  if (doNotCreateWorld) return;
  createWorld(physicsState.gravity, {
    timestep: physicsState.timestepRatio,
    numSolverIterations: physicsState.solverIterations,
    numInternalPgsIterations: physicsState.internalPgsIterations,
  });
};

export const createWorld = (
  gravity: PhysVector,
  opts?: {
    /** Timestep as delta time (eg. 1/60 = 0,0166666666667) */
    timestep?: number;
    /** Integer */
    numSolverIterations?: number;
    /** Integer */
    numInternalPgsIterations?: number;
  }
) => {
  if (worldCreated) return;
  existsOrThrow(
    RAPIER,
    'Could not get physics engine. Make sure the physics is initialized before creating a world.'
  );
  physicsWorld = new RAPIER.World(new RAPIER.Vector3(gravity.x, gravity.y, gravity.z));
  physicsWorld.timestep = physicsState.timestep;
  if (opts?.numSolverIterations) physicsWorld.numSolverIterations = opts.numSolverIterations;
  if (opts?.numInternalPgsIterations)
    physicsWorld.numInternalPgsIterations = opts.numInternalPgsIterations;
  physicsWorldAPI = createPhysicsWorldAPI();
  worldCreated = true;
};

const createRigidBodyDesc = (params: RigidBodyParams) => {
  // @CHORE: FINISH THIS
};

const createColliderDesc = (params: ColliderParams) => {
  // @CHORE: FINISH THIS
};

export const createRigidBody = (params: RigidBodyParams) => {
  // @CHORE: FINISH THIS
};

export const createCollider = (params: ColliderParams) => {
  // @CHORE: FINISH THIS
};

export const debugRenderAPI = () => {
  // @CHORE: FINISH THIS
};

export const stepAPI = () => {
  // @CHORE: FINISH THIS
};

/** Objects to return ----------------------------- */

const createPhysicsWorldAPI = (): WorldAPI => ({
  gravity: (gravity?: PhysVector) => {
    if (gravity === undefined) return physicsWorld.gravity as PhysVector;
    physicsWorld.gravity = gravity;
  },
  free: () => physicsWorld.free(),
  takeSnapshot: () => physicsWorld.takeSnapshot(),
  restoreSnapshot: (data: Uint8Array) => {
    const newWorld = RAPIER.World.restoreSnapshot(data);
    physicsWorld = newWorld;
    physicsWorldAPI = createPhysicsWorldAPI();
    return physicsWorldAPI;
  },
  // Maybe we don't call these two (debugRender and step) like this...?
  // debugRender: (
  //     filterFlags?: QueryFilterFlags,
  //     filterPredicate?: (collider: Collider) => boolean
  //   ) => {
  //     const coll = getCo
  //   },
  // step: (eventQueue?: EventQueue, hooks?: PhysicsHooks) => physicsWorld.step(),
  propagateModifiedBodyPositionsToColliders: () =>
    physicsWorld.propagateModifiedBodyPositionsToColliders(),
  /** Get or set the timestep. Leave argument empty to get. */
  timestep: (dt?: number) => {
    if (dt === undefined) return physicsWorld.timestep;
    physicsWorld.timestep = dt;
  },
  /** Get or set the lengthUnit. Leave argument empty to get. */
  lengthUnit: (unitsPerMeter?: number) => {
    if (unitsPerMeter === undefined) return physicsWorld.lengthUnit;
    physicsWorld.lengthUnit = unitsPerMeter;
  },
  numSolverIterations: (niter?: number) => {
    if (niter === undefined) return physicsWorld.numSolverIterations;
    physicsWorld.numSolverIterations = niter;
  },
  numInternalPgsIterations: (niter?: number) => {
    if (niter === undefined) return physicsWorld.numInternalPgsIterations;
    physicsWorld.numInternalPgsIterations = niter;
  },
  maxCcdSubsteps: (substeps?: number) => {
    if (substeps === undefined) return physicsWorld.maxCcdSubsteps;
    physicsWorld.maxCcdSubsteps = substeps;
  },
  createRigidBody: (params: RigidBodyParams) => {
    // @CHORE: add createRigidBodyDesc
  },
  createCollider: (params: RigidBodyParams) => {
    // @CHORE: add createRigidBodyDesc
  },
  getRigidBody: (id: number) => {
    const rb = rigidBodies.get(id);
    if (rb) return rigidBodyAPIs.get(rb.handle);
    return undefined;
  },
  getCollider: (id: number) => {
    const coll = colliders.get(id);
    if (coll) return colliderAPIs.get(coll.handle);
    return undefined;
  },
  removeRigidBody: (bodyOrId: RigidBodyAPI | number) => {
    const id = typeof bodyOrId === 'number' ? bodyOrId : bodyOrId.id;
    const rb = rigidBodies.get(id);
    if (rb) {
      rigidBodyAPIs.delete(rb.handle);
      physicsWorld.removeRigidBody(rb);
    }
    rigidBodies.delete(id);
  },
  removeCollider: (bodyOrId: ColliderAPI | number, wakeUp?: boolean) => {
    const id = typeof bodyOrId === 'number' ? bodyOrId : bodyOrId.id;
    const coll = colliders.get(id);
    if (coll) {
      colliderAPIs.delete(coll.handle);
      physicsWorld.removeCollider(coll, wakeUp || false);
    }
    rigidBodies.delete(id);
  },
  castRay: (
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
    // filterPredicate?: (collider: ColliderAPI) => boolean
  ) => {
    const filterCollider = _getCollider(filterExcludeCollider);
    const filterRigidBody = _getRigidBody(filterExcludeRigidBody);
    const hit = physicsWorld.castRay(
      new RAPIER.Ray(ray.origin, ray.dir),
      maxToi,
      solid,
      filterFlags,
      filterGroups,
      filterCollider,
      filterRigidBody
      // filterPredicate
    );
    if (!hit) return null;
    const colliderAPI = _getColliderAPI(hit.collider.handle);
    if (!colliderAPI) return null;
    return { collider: colliderAPI, timeOfImpact: hit.timeOfImpact };
  },
  castRayAndGetNormal: (
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
    // filterPredicate?: (collider: ColliderAPI) => boolean
  ) => {
    const filterCollider = _getCollider(filterExcludeCollider);
    const filterRigidBody = _getRigidBody(filterExcludeRigidBody);
    const hit = physicsWorld.castRayAndGetNormal(
      new RAPIER.Ray(ray.origin, ray.dir),
      maxToi,
      solid,
      filterFlags,
      filterGroups,
      filterCollider,
      filterRigidBody
      // filterPredicate
    );
    if (!hit) return null;
    const colliderAPI = _getColliderAPI(hit.collider.handle);
    if (!colliderAPI) return null;
    return {
      collider: colliderAPI,
      timeOfImpact: hit.timeOfImpact,
      normal: hit.normal,
      featureType: hit.featureType,
      featureId: hit.featureId,
    };
  },
  intersectionsWithRay: (
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    callback: (intersect: RayColliderIntersectionAPI) => boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
    // filterPredicate?: (collider: ColliderAPI) => boolean
  ) => {
    const filterCollider = _getCollider(filterExcludeCollider);
    const filterRigidBody = _getRigidBody(filterExcludeRigidBody);
    physicsWorld.intersectionsWithRay(
      new RAPIER.Ray(ray.origin, ray.dir),
      maxToi,
      solid,
      (intersect: RayColliderIntersection) => {
        const intersectColliderAPI = _getColliderAPI(intersect.collider.handle);
        if (!intersectColliderAPI) return false;
        return callback({
          collider: intersectColliderAPI,
          timeOfImpact: intersect.timeOfImpact,
          normal: { x: intersect.normal.x, y: intersect.normal.y, z: intersect.normal.z },
          featureType: intersect.featureType,
          featureId: intersect.featureId,
        });
      },
      filterFlags,
      filterGroups,
      filterCollider,
      filterRigidBody
      // filterPredicate
    );
  },
  contactPairsWith: (collider1: ColliderAPI, f: (collider2: ColliderAPI) => void) => {
    const coll1 = _getCollider(collider1);
    if (!coll1) return;
    const fn = (collider2: Collider) => {
      const coll2 = _getColliderAPI(collider2.handle);
      if (coll2) f(coll2);
    };
    physicsWorld.contactPairsWith(coll1, fn);
  },
  intersectionPairsWith: (collider1: ColliderAPI, f: (collider2: ColliderAPI) => void) => {
    const coll1 = _getCollider(collider1);
    if (!coll1) return;
    const fn = (collider2: Collider) => {
      const coll2 = _getColliderAPI(collider2.handle);
      if (coll2) f(coll2);
    };
    physicsWorld.intersectionPairsWith(coll1, fn);
  },
  intersectionPair: (collider1: ColliderAPI, collider2: ColliderAPI) => {
    const coll1 = _getCollider(collider1);
    const coll2 = _getCollider(collider2);
    if (!coll1 || !coll2) return false;
    return physicsWorld.intersectionPair(coll1, coll2);
  },
});
physicsWorldAPI = createPhysicsWorldAPI();
