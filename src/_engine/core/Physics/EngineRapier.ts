import Rapier from '@dimforge/rapier3d-compat';
import { existsOrThrow } from '../../utils/helpers';
import type {
  Collider,
  RayColliderIntersection,
  RigidBody,
  RigidBodyType,
} from '@dimforge/rapier3d-compat';
import { getPhysicsEngine } from './PhysicsUtils';
import {
  ActiveCollisionTypes,
  ActiveEvents,
  ActiveHooks,
  CoefficientCombineRule,
  ColliderAPI,
  ColliderParams,
  InteractionGroupsAPI,
  PhysicsState,
  PhysRay,
  PhysRotation,
  PhysVector,
  QueryFilterFlags,
  RayColliderIntersectionAPI,
  RigidBodyAPI,
  RigidBodyParams,
  RigidBodyTypeAPI,
  WorldAPI,
} from './PhysicsAPITypes';
import { LoopState } from '../MainLoop';
import { lwarn } from '../../utils/Logger';

// @CHORE: needs a setter function
let physicsState: PhysicsState = {
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

let nextRigidBodyId = 0;
let nextColliderId = 0;
const rigidBodies = new Map<number, number>(); // { "Running id", RigidBody.handle }
const colliders = new Map<number, number>(); // { "Running id", Collider.handle }
const rigidBodyAPIs = new Map<number, RigidBodyAPI>(); // { "Rapier handle", RigidBodyAPI }
const colliderAPIs = new Map<number, ColliderAPI>(); // { "Running handle", ColliderAPI }
let worldCreated = false;
let isDebugEnvironment = false;
let loopState: LoopState;
let RAPIER: typeof Rapier;
let physicsWorld: Rapier.World = { step: () => {} } as Rapier.World;
let physicsWorldAPI: WorldAPI;
let eventQueue: Rapier.EventQueue | undefined = undefined;
let collisionEventFnCount = 0;
let contactForceEventFnCount = 0;

/** Get Rapier.RigidBody with RigidBodyAPI or id */
const getRigidBody = (bodyOrId?: RigidBodyAPI | number): RigidBody | undefined => {
  if (bodyOrId === undefined) return undefined;
  const id = typeof bodyOrId === 'number' ? bodyOrId : bodyOrId.id;
  const handle = rigidBodies.get(id);
  return handle !== undefined ? physicsWorld.getRigidBody(handle) : undefined;
};

/** Get Rapier.Collider with ColliderAPI or id */
const getCollider = (collOrId?: ColliderAPI | number): Collider | undefined => {
  if (collOrId === undefined) return undefined;
  const id = typeof collOrId === 'number' ? collOrId : collOrId.id;
  const handle = colliders.get(id);
  return handle !== undefined ? physicsWorld.getCollider(handle) : undefined;
};

/** Get rigidBodyAPI with a Rapier.RigidBody or a Rapier.RigidBody.handle */
const getRigidBodyAPI = (bodyOrHandle?: RigidBody | number): RigidBodyAPI | undefined => {
  if (bodyOrHandle === undefined) return undefined;
  const handle = typeof bodyOrHandle === 'number' ? bodyOrHandle : bodyOrHandle.handle;
  return rigidBodyAPIs.get(handle);
};

/** Get colliderAPI with a Rapier.Collider or a Rapier.Collider.handle */
const getColliderAPI = (collOrHandle?: Collider | number): ColliderAPI | undefined => {
  if (collOrHandle === undefined) return undefined;
  const handle = typeof collOrHandle === 'number' ? collOrHandle : collOrHandle.handle;
  return colliderAPIs.get(handle);
};

/** Get rigidBodyAPI with an id (running id). */
export const getRigidBodyAPIWithId = (id: number): RigidBodyAPI | undefined =>
  rigidBodyAPIs.get(id);

/** Get colliderAPI with an id (running id). */
export const getColliderAPIWithId = (id: number): ColliderAPI | undefined => colliderAPIs.get(id);

export const init = (
  physicsSt: PhysicsState,
  isDebugEnv: boolean,
  loopSt: LoopState,
  doNotCreateWorld?: boolean
) => {
  try {
    RAPIER = existsOrThrow(
      getPhysicsEngine() as typeof Rapier,
      'Could not initialize RAPIER in EngineRapier.ts init().'
    );
    physicsState = physicsSt;
    isDebugEnvironment = isDebugEnv || false;
    loopState = loopSt;
    if (doNotCreateWorld) return;
    physicsWorldAPI = createWorld(physicsState.gravity, {
      timestep: physicsState.timestepRatio,
      numSolverIterations: physicsState.solverIterations,
      numInternalPgsIterations: physicsState.internalPgsIterations,
    });
    return physicsWorldAPI;
  } catch (err) {
    throw new Error('Failed to initialize Rapier physics.');
  }
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
  if (worldCreated) return physicsWorldAPI;
  existsOrThrow(
    RAPIER,
    'Could not get physics engine. Make sure the physics is initialized before creating a world.'
  );
  physicsWorld = new RAPIER.World(new RAPIER.Vector3(gravity.x, gravity.y, gravity.z));
  physicsWorld.timestep = physicsState.timestep;
  if (opts?.numSolverIterations) physicsWorld.numSolverIterations = opts.numSolverIterations;
  if (opts?.numInternalPgsIterations)
    physicsWorld.numInternalPgsIterations = opts.numInternalPgsIterations;
  physicsWorldAPI = createEnginePhysicsWorldAPI();
  worldCreated = true;
  return physicsWorldAPI;
};

const getCombineRule = (rule?: 'MAX' | 'MULTIPLY' | 'MIN' | 'AVERAGE') => {
  switch (rule) {
    case 'MAX':
      return RAPIER.CoefficientCombineRule.Max;
    case 'MULTIPLY':
      return RAPIER.CoefficientCombineRule.Multiply;
    case 'MIN':
      return RAPIER.CoefficientCombineRule.Min;
    case 'AVERAGE':
    default:
      return RAPIER.CoefficientCombineRule.Average;
  }
};

export const createRigidBody = (params: RigidBodyParams) => {
  let rigidBody: Rapier.RigidBody | undefined = undefined;
  let rigidBodyDesc: Rapier.RigidBodyDesc;

  switch (params.rigidType) {
    case 'DYNAMIC':
      rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic();
      rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);
      break;
    case 'POS_BASED':
      rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
      rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);
      break;
    case 'VELO_BASED':
      rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicVelocityBased();
      rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);
      break;
    case 'FIXED':
    default:
      rigidBodyDesc = RAPIER.RigidBodyDesc.fixed();
      rigidBody = physicsWorld.createRigidBody(rigidBodyDesc);
      break;
  }

  const wakeUp = params.wakeUp !== false ? true : false;

  if (params.translation) rigidBody.setTranslation(params.translation, wakeUp);
  if (params.rotation) rigidBody.setRotation(params.rotation, wakeUp);
  if (params.linvel) rigidBody.setLinvel(params.linvel, wakeUp);
  if (params.angvel) rigidBody.setAngvel(params.angvel, wakeUp);
  if (params.gravityScale) rigidBody.setGravityScale(params.gravityScale, wakeUp);
  if (params.force) rigidBody.addForce(params.force, wakeUp);
  if (params.torqueForce) rigidBody.addTorque(params.torqueForce, wakeUp);
  if (params.forceAtPoint)
    rigidBody.addForceAtPoint(params.forceAtPoint.force, params.forceAtPoint.point, wakeUp);
  if (params.impulse) rigidBody.applyImpulse(params.impulse, wakeUp);
  if (params.torqueImpulse) rigidBody.applyTorqueImpulse(params.torqueImpulse, wakeUp);
  if (params.impulseAtPoint)
    rigidBody.applyImpulseAtPoint(params.impulseAtPoint.force, params.impulseAtPoint.point, wakeUp);
  if (params.additionalMass !== undefined)
    rigidBody.setAdditionalMass(params.additionalMass, wakeUp);
  if (params.lockTranslations) {
    rigidBody.lockTranslations(true, wakeUp);
    rigidBody.setEnabledTranslations(
      !params.lockTranslations.x,
      !params.lockTranslations.y,
      !params.lockTranslations.z,
      wakeUp
    );
  }
  if (params.lockRotations) {
    rigidBody.lockRotations(true, wakeUp);
    rigidBody.setEnabledRotations(
      !params.lockRotations.x,
      !params.lockRotations.y,
      !params.lockRotations.z,
      wakeUp
    );
    if (!rigidBody.userData) rigidBody.userData = {};
    (rigidBody.userData as { [key: string]: unknown }).lockRotationsX = params.lockRotations.x;
    (rigidBody.userData as { [key: string]: unknown }).lockRotationsY = params.lockRotations.y;
    (rigidBody.userData as { [key: string]: unknown }).lockRotationsZ = params.lockRotations.z;
  }
  if (params.linearDamping) rigidBody.setLinearDamping(params.linearDamping);
  if (params.angularDamping) rigidBody.setAngularDamping(params.angularDamping);
  if (params.dominance) rigidBody.setDominanceGroup(params.dominance);
  if (params.ccdEnabled) rigidBody.enableCcd(params.ccdEnabled);
  if (params.softCcdDistance) rigidBody.setSoftCcdPrediction(params.softCcdDistance);

  if (params.userData) rigidBody.userData = params.userData;

  const id = nextRigidBodyId;
  nextRigidBodyId += 1;
  rigidBodies.set(id, rigidBody.handle);
  const rigidBodyAPI = new EngineRigidBodyProxyAPI(id, params.userData);
  if (params.userData) rigidBodyAPI.setUserData(params.userData);
  rigidBodyAPIs.set(id, rigidBodyAPI);

  return rigidBodyAPI;
};

export const createCollider = (params: ColliderParams) => {
  let shape: Rapier.Shape | null = null;
  let size: { [key: string]: number };

  switch (params.type) {
    case 'CUBOID':
    case 'BOX':
      size = { hx: 0.5, hy: 0.5, hz: 0.5 }; // Default size
      shape = params.borderRadius
        ? new RAPIER.RoundCuboid(
            params.hx || size.hx,
            params.hy || size.hy,
            params.hz || size.hz,
            params.borderRadius
          )
        : new RAPIER.Cuboid(params.hx || size.hx, params.hy || size.hy, params.hz || size.hz);
      break;
    case 'BALL':
    case 'SPHERE':
      const radius = 0.5; // Default radius
      shape = new RAPIER.Ball(params.radius || radius);
      break;
    case 'CAPSULE':
      {
        size = { halfHeight: 0.25, radius: 0.25 }; // Default size
        shape = new RAPIER.Capsule(
          params.halfHeight || size.halfHeight,
          params.radius || size.radius
        );
      }
      break;
    case 'CONE':
      {
        size = { halfHeight: 0.25, radius: 0.25 }; // Default size
        shape = params.borderRadius
          ? new RAPIER.RoundCone(
              params.halfHeight || size.halfHeight,
              params.radius || size.radius,
              params.borderRadius
            )
          : new RAPIER.Cone(params.halfHeight || size.halfHeight, params.radius || size.radius);
      }
      break;
    case 'CYLINDER':
      size = { halfHeight: 0.5, radius: 1 }; // Default size
      shape = params.borderRadius
        ? new RAPIER.RoundCylinder(
            params.halfHeight || size.halfHeight,
            params.radius || size.radius,
            params.borderRadius
          )
        : new RAPIER.Cylinder(params.halfHeight || size.halfHeight, params.radius || size.radius);
      break;
    case 'TRIANGLE':
      shape = params.borderRadius
        ? new RAPIER.RoundTriangle(params.a, params.b, params.c, params.borderRadius)
        : new RAPIER.Triangle(params.a, params.b, params.c);
      break;
    case 'TRIMESH':
      // @TODO: Make error handling better by returning an error back to the PhysicsAPI.ts
      const vertices = existsOrThrow(
        params.vertices,
        'Could not find vertices when creating a TRIMESH shape.'
      );
      const indices = existsOrThrow(
        params.indices,
        'Could not find indices when creating a TRIMESH shape.'
      );
      shape = new RAPIER.TriMesh(vertices, indices);
      break;
    case 'HEIGHTFIELD':
      // @TODO: Make error handling better by returning an error back to the PhysicsAPI.ts
      const nRows = existsOrThrow(
        params.nrows,
        'Could not find nRows when creating a HEIGHTFIELD shape.'
      );
      const nCols = existsOrThrow(
        params.nrows,
        'Could not find nRows when creating a HEIGHTFIELD shape.'
      );
      const heights = existsOrThrow(
        params.heights,
        'Could not find heights when creating a HEIGHTFIELD shape.'
      );
      const scale = existsOrThrow(
        params.scale,
        'Could not find scale when creating a HEIGHTFIELD shape.'
      );
      shape = new RAPIER.Heightfield(
        Math.round(nRows),
        Math.round(nCols),
        new Float32Array(heights),
        scale
      );
      break;
    case 'CONVEXHULL':
      // @TODO: Make error handling better by returning an error back to the PhysicsAPI.ts
      const vertParams = existsOrThrow(
        params.vertices,
        'Could not find vertices when creating a CONVEXHULL shape.'
      );
      shape = new RAPIER.ConvexPolyhedron(new Float32Array(vertParams));
      break;
  }

  existsOrThrow(shape, 'Could not create collider in createCollider, shape is undefined.');

  const colliderDesc = new RAPIER.ColliderDesc(shape);

  // For importing models: since Rapier shapes start on Y, we rotate them if the Blender spine was X or Z (for CYLINDER and CAPSULE)
  if (params.orientation) {
    colliderDesc.setRotation(
      new RAPIER.Quaternion(
        params.orientation.x,
        params.orientation.y,
        params.orientation.z,
        params.orientation.w
      )
    );
  }

  if (params.density !== undefined) colliderDesc.setDensity(params.density);
  if (params.translation)
    colliderDesc.setTranslation(params.translation.x, params.translation.y, params.translation.z);
  if (params.rotation) colliderDesc.setRotation(params.rotation);
  if (params.friction) colliderDesc.setFriction(params.friction);
  if (params.restitution) colliderDesc.setRestitution(params.restitution);
  if (params.frictionCombineRule)
    colliderDesc.setFrictionCombineRule(getCombineRule(params.frictionCombineRule));
  if (params.restitutionCombineRule)
    colliderDesc.setRestitutionCombineRule(getCombineRule(params.restitutionCombineRule));
  if (params.isSensor !== undefined) colliderDesc.setSensor(params.isSensor);

  if (
    params.enableCollisionActiveEvents ||
    params.enableContactForceActiveEvents ||
    params.hasCollisionEventFn ||
    params.hasContactForceEventFn
  ) {
    let activeEvents: Rapier.ActiveEvents = RAPIER.ActiveEvents.NONE;
    if (
      (params.enableCollisionActiveEvents && params.enableContactForceActiveEvents) ||
      (params.hasCollisionEventFn && params.hasContactForceEventFn)
    ) {
      activeEvents =
        RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
    } else if (params.enableCollisionActiveEvents || params.hasCollisionEventFn) {
      activeEvents = RAPIER.ActiveEvents.COLLISION_EVENTS;
      if (params.hasCollisionEventFn) collisionEventFnCount++;
    } else if (params.enableContactForceActiveEvents || params.hasContactForceEventFn) {
      activeEvents = RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
      if (params.hasContactForceEventFn) contactForceEventFnCount++;
    }

    colliderDesc.setActiveEvents(activeEvents);
    if (!eventQueue && activeEvents !== RAPIER.ActiveEvents.NONE) {
      eventQueue = new RAPIER.EventQueue(true);
    }
  }

  const collider = physicsWorld.createCollider(colliderDesc, getRigidBody(params.parentId));
  const id = nextColliderId;
  nextColliderId += 1;
  colliders.set(id, collider.handle);
  const colliderAPI = createEnginePhysicsColliderAPI(id);
  if (params.userData) colliderAPI.setUserData(params.userData);
  colliderAPIs.set(id, colliderAPI);

  return colliderAPI;
};

export const createRigidBodies = (paramsArray: RigidBodyParams[]) =>
  paramsArray.map((params) => createRigidBody(params));

export const createColliders = (paramsArray: ColliderParams[]) =>
  paramsArray.map((params) => createCollider(params));

export const deleteRigidBody = (id: number) => {
  const colliderIds: number[] = [];
  const rbHandle = rigidBodies.get(id);
  if (!rbHandle) {
    if (isDebugEnvironment) {
      lwarn(`Trying to remove a non existing rigid body (no handle found), handle: ${rbHandle}`);
    }
    return { id, colliderIds };
  }
  const rb = physicsWorld.getRigidBody(rbHandle);
  // @CHORE: we need to get the child collider ids and send them to the
  if (!rb) {
    if (!isDebugEnvironment) {
      lwarn(
        `Trying to remove a non existing rigid body (no rigid body found), handle: ${rbHandle}`
      );
    }
    rigidBodies.delete(id);
    return { id, colliderIds };
  }
  const colliderCount = rb.numColliders();
  for (let i = 0; i < colliderCount; i++) {
    const colliderId = getColliderAPI(rb.collider(i).handle)?.id;
    if (colliderId !== undefined) {
      colliders.delete(colliderId);
      colliderAPIs.delete(colliderId);
      colliderIds.push(colliderId);
    }
  }
  physicsWorld.removeRigidBody(rb);
  rigidBodyAPIs.delete(id);
  rigidBodies.delete(id);
  return { id, colliderIds };
};

export const deleteRigidBodies = (ids: number[]) => {
  const deletedIds: number[] = [];
  const deletedColliderIds: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const { id, colliderIds } = deleteRigidBody(ids[i]);
    deletedIds.push(id);
    deletedColliderIds.push(...colliderIds);
  }
  return { ids: deletedIds, colliderIds: deletedColliderIds };
};

export const deleteCollider = (id: number, wakeUp?: boolean) => {
  const collHandle = colliders.get(id);
  if (!collHandle) {
    if (isDebugEnvironment) {
      lwarn(`Trying to remove a non existing collider (no handle found), handle: ${collHandle}`);
    }
    return { id };
  }
  const coll = physicsWorld.getCollider(collHandle);
  if (!coll) {
    if (!isDebugEnvironment) {
      lwarn(`Trying to remove a non existing collider (no collider found), handle: ${collHandle}`);
    }
    colliders.delete(id);
    return { id };
  }
  physicsWorld.removeCollider(coll, Boolean(wakeUp));
  colliderAPIs.delete(id);
  colliders.delete(id);
  return { id };
};

export const deleteColliders = (ids: number[], wakeUps?: boolean[]) => {
  const deletedIds = [];
  for (let i = 0; i < ids.length; i++) {
    const { id } = deleteCollider(ids[i], Boolean(wakeUps && wakeUps[i]));
    if (id !== undefined) deletedIds.push(id);
  }
  return { ids: deletedIds };
};

export const deleteWorld = () => {
  // Clear the maps
  rigidBodies.clear();
  colliders.clear();
  rigidBodyAPIs.clear();
  colliderAPIs.clear();

  // Reset
  worldCreated = false;
  physicsWorldAPI = undefined as unknown as WorldAPI;
  eventQueue = undefined;
  collisionEventFnCount = 0;
  contactForceEventFnCount = 0;

  // Free the world
  physicsWorld.free();
  physicsWorld = { step: () => {} } as Rapier.World;

  return { worldDeleted: true };
};

export const takeSnapshot = () => physicsWorld?.takeSnapshot();

export const restoreSnapshot = (snapshot: Uint8Array) => {
  // @TODO: we maybe need check all the rigidBodies and colliders
  // and recreate all the maps (rigidBodies, rigidBodyAPIs, colliders, colliderAPIs) here.
  physicsWorld = Rapier.World.restoreSnapshot(snapshot);
  physicsWorldAPI = createEnginePhysicsWorldAPI(); // Not sure if we need to recreate the WorldAPI?
  return physicsWorldAPI;
};

export const debugRenderAPI = () => {
  // @CHORE: FINISH THIS
};

export const stepAPI = () => {
  // @CHORE: FINISH THIS
};

/** World, RigidBody, and Collider API definitions -----[ START ]----- */

const createEnginePhysicsWorldAPI = (): WorldAPI => ({
  restoringWorld: false,
  gravity: async (gravity?: PhysVector) => {
    if (gravity === undefined) return physicsWorld.gravity as PhysVector;
    physicsWorld.gravity = gravity;
  },
  free: () => physicsWorld.free(),
  takeSnapshot: async () => physicsWorld.takeSnapshot(),
  restoreSnapshot: async (data: Uint8Array) => {
    const newWorld = RAPIER.World.restoreSnapshot(data);
    physicsWorld = newWorld;
    physicsWorldAPI = createEnginePhysicsWorldAPI();
    return physicsWorldAPI;
  },
  propagateModifiedBodyPositionsToColliders: () =>
    physicsWorld.propagateModifiedBodyPositionsToColliders(),
  /** Get or set the timestep. Leave argument empty to get. */
  timestep: async (dt?: number) => {
    if (dt === undefined) return physicsWorld.timestep;
    physicsWorld.timestep = dt;
  },
  /** Get or set the lengthUnit. Leave argument empty to get. */
  lengthUnit: async (unitsPerMeter?: number) => {
    if (unitsPerMeter === undefined) return physicsWorld.lengthUnit;
    physicsWorld.lengthUnit = unitsPerMeter;
  },
  numSolverIterations: async (niter?: number) => {
    if (niter === undefined) return physicsWorld.numSolverIterations;
    physicsWorld.numSolverIterations = niter;
  },
  numInternalPgsIterations: async (niter?: number) => {
    if (niter === undefined) return physicsWorld.numInternalPgsIterations;
    physicsWorld.numInternalPgsIterations = niter;
  },
  maxCcdSubsteps: async (substeps?: number) => {
    if (substeps === undefined) return physicsWorld.maxCcdSubsteps;
    physicsWorld.maxCcdSubsteps = substeps;
  },
  createRigidBody: async (params: RigidBodyParams) => createRigidBody(params),
  createCollider: async (params: ColliderParams) => createCollider(params),
  getRigidBody: async (id: number) => {
    const rbHandle = rigidBodies.get(id);
    if (rbHandle) return rigidBodyAPIs.get(rbHandle);
    return undefined;
  },
  getCollider: async (id: number) => {
    const collHandle = colliders.get(id);
    if (collHandle) return colliderAPIs.get(collHandle);
    return undefined;
  },
  removeRigidBody: (bodyOrId: RigidBodyAPI | number) => {
    const id = typeof bodyOrId === 'number' ? bodyOrId : bodyOrId.id;
    const rbHandle = rigidBodies.get(id);
    if (rbHandle) {
      rigidBodyAPIs.delete(rbHandle);
      const rb = physicsWorld.getRigidBody(rbHandle);
      if (rb) physicsWorld.removeRigidBody(rb);
    }
    rigidBodies.delete(id);
  },
  removeCollider: (bodyOrId: ColliderAPI | number, wakeUp?: boolean) => {
    const id = typeof bodyOrId === 'number' ? bodyOrId : bodyOrId.id;
    const collHandle = colliders.get(id);
    if (collHandle) {
      colliderAPIs.delete(collHandle);
      const coll = physicsWorld.getCollider(collHandle);
      if (coll) physicsWorld.removeCollider(coll, wakeUp || false);
    }
    rigidBodies.delete(id);
  },
  castRay: async (
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
    // filterPredicate?: (collider: ColliderAPI) => boolean
  ) => {
    const filterCollider = getCollider(filterExcludeCollider);
    const filterRigidBody = getRigidBody(filterExcludeRigidBody);
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
    const colliderAPI = getColliderAPI(hit.collider.handle);
    if (!colliderAPI) return null;
    return { collider: colliderAPI, timeOfImpact: hit.timeOfImpact };
  },
  castRayAndGetNormal: async (
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
    // filterPredicate?: (collider: ColliderAPI) => boolean
  ) => {
    const filterCollider = getCollider(filterExcludeCollider);
    const filterRigidBody = getRigidBody(filterExcludeRigidBody);
    const intersection = physicsWorld.castRayAndGetNormal(
      new RAPIER.Ray(ray.origin, ray.dir),
      maxToi,
      solid,
      filterFlags,
      filterGroups,
      filterCollider,
      filterRigidBody
      // filterPredicate
    );
    if (!intersection) return null;
    const colliderAPI = getColliderAPI(intersection.collider.handle);
    if (!colliderAPI) return null;
    return {
      collider: colliderAPI,
      timeOfImpact: intersection.timeOfImpact,
      normal: intersection.normal,
      featureType: intersection.featureType,
      featureId: intersection.featureId,
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
    const filterCollider = getCollider(filterExcludeCollider);
    const filterRigidBody = getRigidBody(filterExcludeRigidBody);
    physicsWorld.intersectionsWithRay(
      new RAPIER.Ray(ray.origin, ray.dir),
      maxToi,
      solid,
      (intersect: RayColliderIntersection) => {
        const intersectColliderAPI = getColliderAPI(intersect.collider.handle);
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
  contactPairsWith: (collider1: ColliderAPI | number, f: (collider2: ColliderAPI) => void) => {
    const coll1 = getCollider(collider1);
    if (!coll1) return;
    const fn = (collider2: Collider) => {
      const coll2 = getColliderAPI(collider2.handle);
      if (coll2) f(coll2);
    };
    physicsWorld.contactPairsWith(coll1, fn);
  },
  intersectionPairsWith: (collider1: ColliderAPI | number, f: (collider2: ColliderAPI) => void) => {
    const coll1 = getCollider(collider1);
    if (!coll1) return;
    const fn = (collider2: Collider) => {
      const coll2 = getColliderAPI(collider2.handle);
      if (coll2) f(coll2);
    };
    physicsWorld.intersectionPairsWith(coll1, fn);
  },
  intersectionPair: async (collider1: ColliderAPI | number, collider2: ColliderAPI | number) => {
    const coll1 = getCollider(collider1);
    const coll2 = getCollider(collider2);
    if (!coll1 || !coll2) return false;
    return physicsWorld.intersectionPair(coll1, coll2);
  },
});

class EngineWorldProxyAPI implements WorldAPI {}

class EngineRigidBodyProxyAPI implements RigidBodyAPI {
  private rb: Rapier.RigidBody;
  uData: Record<string, unknown> = {};
  pos: PhysVector = { x: 0, y: 0, z: 0 };
  rot: PhysRotation = { x: 0, y: 0, z: 0, w: 0 };
  lvel: PhysVector = { x: 0, y: 0, z: 0 };
  avel: PhysVector = { x: 0, y: 0, z: 0 };

  constructor(
    public id: number,
    userData?: Record<string, unknown>
  ) {
    if (userData) this.uData = userData;
    const rb = existsOrThrow(
      getRigidBody(id),
      `Could not find rigid body in the engineAPI with id: ${id}`
    );
    this.rb = rb;
  }

  getUserDataSync() {
    return this.uData;
  }
  async getUserData() {
    return this.getUserDataSync();
  }

  setUserData(userData: Record<string, unknown>, addToExisting?: boolean) {
    this.uData = addToExisting ? { ...this.uData, ...userData } : userData;
  }

  isValidSync() {
    return this.rb.isValid();
  }
  async isValid() {
    return this.isValidSync();
  }

  lockTranslations(locked: boolean, wakeUp: boolean) {
    this.rb.lockTranslations(locked, wakeUp);
  }

  lockRotations(locked: boolean, wakeUp: boolean) {
    this.rb.lockRotations(locked, wakeUp);
  }

  setEnabledTranslations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean) {
    this.rb.setEnabledTranslations(enableX, enableY, enableZ, wakeUp);
  }

  setEnabledRotations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean) {
    this.rb.setEnabledRotations(enableX, enableY, enableZ, wakeUp);
  }

  dominanceGroupSync() {
    return this.rb.dominanceGroup();
  }
  async dominanceGroup() {
    return this.dominanceGroupSync();
  }

  setDominanceGroup(group: number) {
    this.rb.setDominanceGroup(group);
  }

  additionalSolverIterationsSync() {
    return this.rb.additionalSolverIterations();
  }
  async additionalSolverIterations() {
    return this.additionalSolverIterationsSync();
  }

  setAdditionalSolverIterations(iters: number) {
    this.rb.setAdditionalSolverIterations(iters);
  }

  enableCcd(enabled: boolean) {
    this.rb.enableCcd(enabled);
  }

  setSoftCcdPrediction(distance: number) {
    this.rb.setSoftCcdPrediction(distance);
  }

  softCcdPredictionSync() {
    return this.rb.softCcdPrediction();
  }
  async softCcdPrediction() {
    return this.softCcdPredictionSync();
  }

  translation() {
    return this.rb.translation();
  }

  rotation() {
    return this.rb.rotation();
  }

  nextTranslationSync() {
    return this.rb.nextTranslation();
  }
  async nextTranslation() {
    return this.nextTranslationSync();
  }

  nextRotationSync() {
    return this.rb.nextRotation();
  }
  async nextRotation() {
    return this.nextRotationSync();
  }

  setTranslation(tra: PhysVector, wakeUp: boolean) {
    this.rb.setTranslation(tra, wakeUp);
  }

  setLinvel(vel: PhysVector, wakeUp: boolean) {
    this.rb.setLinvel(vel, wakeUp);
  }

  gravityScaleSync() {
    return this.rb.gravityScale();
  }
  async gravityScale() {
    return this.gravityScaleSync();
  }

  setGravityScale(factor: number, wakeUp: boolean) {
    this.rb.setGravityScale(factor, wakeUp);
  }

  setRotation(rot: PhysRotation, wakeUp: boolean) {
    this.rb.setRotation(rot, wakeUp);
  }

  setAngvel(vel: PhysVector, wakeUp: boolean) {
    this.rb.setAngvel(vel, wakeUp);
  }

  setNextKinematicTranslation(t: PhysVector) {
    this.rb.setNextKinematicTranslation(t);
  }

  setNextKinematicRotation(rot: PhysRotation) {
    this.rb.setNextKinematicRotation(rot);
  }

  linvel() {
    return this.rb.linvel();
  }

  velocityAtPointSync(point: PhysVector) {
    return this.rb.velocityAtPoint(point);
  }
  async velocityAtPoint(point: PhysVector) {
    return this.velocityAtPointSync(point);
  }

  angvel() {
    return this.rb.angvel();
  }

  massSync() {
    return this.rb.mass();
  }
  async mass() {
    return this.massSync();
  }

  effectiveInvMassSync() {
    return this.rb.effectiveInvMass();
  }
  async effectiveInvMass() {
    return this.effectiveInvMassSync();
  }

  invMassSync() {
    return this.rb.invMass();
  }
  async invMass() {
    return this.invMassSync();
  }

  localComSync() {
    return this.rb.localCom();
  }
  async localCom() {
    return this.localComSync();
  }

  worldComSync() {
    return this.rb.worldCom();
  }
  async worldCom() {
    return this.worldComSync();
  }

  invPrincipalInertiaSync() {
    return this.rb.invPrincipalInertia();
  }
  async invPrincipalInertia() {
    return this.invPrincipalInertiaSync();
  }

  principalInertiaSync() {
    return this.rb.principalInertia();
  }
  async principalInertia() {
    return this.principalInertiaSync();
  }

  principalInertiaLocalFrameSync() {
    return this.rb.principalInertiaLocalFrame();
  }
  async principalInertiaLocalFrame() {
    return this.principalInertiaLocalFrameSync();
  }

  sleep() {
    this.rb.sleep();
  }

  wakeUp() {
    this.rb.wakeUp();
  }

  isCcdEnabledSync() {
    return this.rb.isCcdEnabled();
  }
  async isCcdEnabled() {
    return this.isCcdEnabledSync();
  }

  numCollidersSync() {
    return this.rb.numColliders();
  }
  async numColliders() {
    return this.numCollidersSync();
  }

  colliderSync(i: number) {
    const coll = this.rb.collider(i);
    const collAPI = existsOrThrow(
      getColliderAPI(coll.handle),
      `Could not find collider in ColliderAPI.collider(${i}).`
    );
    return collAPI;
  }
  async collider(i: number) {
    return this.colliderSync(i);
  }

  setEnabled(enabled: boolean) {
    this.rb.setEnabled(enabled);
  }

  isEnabledSync() {
    return this.rb.isEnabled();
  }
  async isEnabled() {
    return this.isEnabledSync();
  }

  bodyTypeSync() {
    return this.rb.bodyType() as unknown as RigidBodyTypeAPI;
  }
  async bodyType() {
    return this.bodyTypeSync();
  }

  setBodyType(type: RigidBodyTypeAPI, wakeUp: boolean) {
    this.rb.setBodyType(type as unknown as RigidBodyType, wakeUp);
  }

  isSleepingSync() {
    return this.rb.isSleeping();
  }
  async isSleeping() {
    return this.isSleepingSync();
  }

  isMovingSync() {
    return this.rb.isMoving();
  }
  async isMoving() {
    return this.isMovingSync();
  }

  isFixedSync() {
    return this.rb.isFixed();
  }
  async isFixed() {
    return this.isFixedSync();
  }

  isKinematicSync() {
    return this.rb.isKinematic();
  }
  async isKinematic() {
    return this.isKinematicSync();
  }

  isDynamicSync() {
    return this.rb.isDynamic();
  }
  async isDynamic() {
    return this.isDynamicSync();
  }

  linearDampingSync() {
    return this.rb.linearDamping();
  }
  async linearDamping() {
    return this.linearDampingSync();
  }

  angularDampingSync() {
    return this.rb.angularDamping();
  }
  async angularDamping() {
    return this.angularDampingSync();
  }

  setLinearDamping(factor: number) {
    this.rb.setLinearDamping(factor);
  }

  recomputeMassPropertiesFromColliders() {
    this.rb.recomputeMassPropertiesFromColliders();
  }

  setAdditionalMass(mass: number, wakeUp: boolean) {
    this.rb.setAdditionalMass(mass, wakeUp);
  }

  setAdditionalMassProperties(
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation,
    wakeUp: boolean
  ) {
    this.rb.setAdditionalMassProperties(
      mass,
      centerOfMass,
      principalAngularInertia,
      angularInertiaLocalFrame,
      wakeUp
    );
  }

  setAngularDamping(factor: number) {
    this.rb.setAngularDamping(factor);
  }

  resetForces(wakeUp: boolean) {
    this.rb.resetForces(wakeUp);
  }

  resetTorques(wakeUp: boolean) {
    this.rb.resetTorques(wakeUp);
  }

  addForce(force: PhysVector, wakeUp: boolean) {
    this.rb.addForce(force, wakeUp);
  }

  applyImpulse(impulse: PhysVector, wakeUp: boolean) {
    this.rb.applyImpulse(impulse, wakeUp);
  }

  addTorque(torque: PhysVector, wakeUp: boolean) {
    this.rb.addTorque(torque, wakeUp);
  }

  applyTorqueImpulse(torqueImpulse: PhysVector, wakeUp: boolean) {
    this.rb.applyTorqueImpulse(torqueImpulse, wakeUp);
  }

  addForceAtPoint(force: PhysVector, point: PhysVector, wakeUp: boolean) {
    this.rb.addForceAtPoint(force, point, wakeUp);
  }

  applyImpulseAtPoint(impulse: PhysVector, point: PhysVector, wakeUp: boolean) {
    this.rb.applyImpulseAtPoint(impulse, point, wakeUp);
  }

  userForceSync() {
    return this.rb.userForce();
  }
  async userForce() {
    return this.userForceSync();
  }

  userTorqueSync() {
    return this.rb.userTorque();
  }
  async userTorque() {
    return this.userTorqueSync();
  }
}

// @CHORE: change to a class
const createEnginePhysicsColliderAPI = (id: number): ColliderAPI => ({
  id,
  userData: async function (userData?: { [key: string]: unknown }, addToExisting?: boolean) {
    if (userData !== undefined) {
      if (addToExisting) {
        this.uData = { ...this.uData, ...userData };
      } else {
        this.uData = userData;
      }
    }
    return this.uData;
  },
  clearShapeCache: function () {
    // returns void;
  },
  isValid: function () {
    // returns boolean;
  },
  translation: function () {
    // returns PhysVector;
  },
  translationWrtParent: function () {
    // returns PhysVector | null;
  },
  rotation: function () {
    // returns PhysRotation;
  },
  rotationWrtParent: function () {
    // returns PhysRotation | null;
  },
  isSensor: function () {
    // returns boolean;
  },
  setSensor: function (isSensor: boolean) {
    // returns void;
  },
  setEnabled: function (enabled: boolean) {
    // returns void;
  },
  isEnabled: function () {
    // returns boolean;
  },
  setRestitution: function (restitution: number) {
    // returns
  },
  setFriction: function (friction: number) {
    // returns void;
  },
  frictionCombineRule: function () {
    // returns CoefficientCombineRule;
  },
  setFrictionCombineRule: function (rule: CoefficientCombineRule) {
    // returns void;
  },
  restitutionCombineRule: function () {
    // returns CoefficientCombineRule;
  },
  setRestitutionCombineRule: function (rule: CoefficientCombineRule) {
    // returns void;
  },
  setCollisionGroups: function (groups: InteractionGroupsAPI) {
    // returns void;
  },
  setSolverGroups: function (groups: InteractionGroupsAPI) {
    // returns void;
  },
  contactSkin: function () {
    // returns number;
  },
  setContactSkin: function (thickness: number) {
    // returns void;
  },
  activeHooks: function () {
    // returns ActiveHooks;
  },
  setActiveHooks: function (activeHooks: ActiveHooks) {
    // returns void;
  },
  activeEvents: function () {
    // returns ActiveEvents;
  },
  setActiveEvents: function (activeEvents: ActiveEvents) {
    // returns void;
  },
  activeCollisionTypes: function () {
    // returns ActiveCollisionTypes;
  },
  setContactForceEventThreshold: function (threshold: number) {
    // returns void;
  },
  contactForceEventThreshold: function () {
    // returns number;
  },
  setActiveCollisionTypes: function (activeCollisionTypes: ActiveCollisionTypes) {
    // returns void;
  },
  setDensity: function (density: number) {
    // returns void;
  },
  setMass: function (mass: number) {
    // returns void;
  },
  setMassProperties: function (
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation
  ) {
    // returns void;
  },
  setTranslation: function (tra: PhysVector) {
    // returns void;
  },
  setTranslationWrtParent: function (tra: PhysVector) {
    // returns void;
  },
  setRotation: function (rot: PhysRotation) {
    // returns void;
  },
  setRotationWrtParent: function (rot: PhysRotation) {
    // returns void;
  },
  shapeType: function () {
    // returns ShapeType;
  },
  halfExtents: function () {
    // returns PhysVector;
  },
  setHalfExtents: function (newHalfExtents: PhysVector) {
    // returns void;
  },
  radius: function () {
    // returns number;
  },
  setRadius: function (newRadius: number) {
    // returns void;
  },
  roundRadius: function () {
    // returns number;
  },
  setRoundRadius: function (newBorderRadius: number) {
    // returns void;
  },
  halfHeight: function () {
    // returns number;
  },
  setHalfHeight: function (newHalfheight: number) {
    // returns void;
  },
  setVoxel: function (ix: number, iy: number, iz: number, filled: boolean) {
    // returns void;
  },
  propagateVoxelChange: function (
    voxels2: ColliderAPI,
    ix: number,
    iy: number,
    iz: number,
    shift_x: number,
    shift_y: number,
    shift_z: number
  ) {
    // returns void;
  },
  combineVoxelStates: function (
    voxels2: ColliderAPI,
    shift_x: number,
    shift_y: number,
    shift_z: number
  ) {
    // returns void;
  },
  vertices: function () {
    // returns Float32Array;
  },
  indices: function () {
    // returns Uint32Array | undefined;
  },
  heightfieldHeights: function () {
    // returns Float32Array;
  },
  heightfieldScale: function () {
    // returns PhysVector;
  },
  heightfieldNRows: function () {
    // returns number;
  },
  heightfieldNCols: function () {
    // returns number;
  },
  parent: function () {
    // returns RigidBodyAPI | null;
  },
  friction: function () {
    // returns number;
  },
  restitution: function () {
    // returns number;
  },
  density: function () {
    // returns number;
  },
  mass: function () {
    // returns number;
  },
  volume: function () {
    // returns number;
  },
  collisionGroups: function () {
    // returns InteractionGroupsAPI;
  },
  solverGroups: function () {
    // returns InteractionGroupsAPI;
  },
  containsPoint: function (point: PhysVector) {
    // returns boolean;
  },
  projectPoint: function (point: PhysVector, solid: boolean) {
    // returns PointProjection | null;
  },
  intersectsRay: function (ray: PhysRay, maxToi: number) {
    // returns boolean;
  },
  castRay: function (ray: PhysRay, maxToi: number, solid: boolean) {
    // returns number;
  },
  castRayAndGetNormal: function (ray: PhysRay, maxToi: number, solid: boolean) {
    // returns RayIntersection | null;
  },
});

/** World, RigidBody, and Collider API definitions -----[ END ]----- */
