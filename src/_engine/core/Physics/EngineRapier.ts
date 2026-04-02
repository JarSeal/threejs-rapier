import Rapier from '@dimforge/rapier3d-compat';
import { existsOrThrow } from '../../utils/helpers';
import type { Collider, RayColliderIntersection, RigidBody } from '@dimforge/rapier3d-compat';
import { getPhysicsEngine } from './PhysicsUtils';
import {
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

// @CHORE: needs a setter function
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
const colliderAPIs = new Map<number, ColliderAPI>(); // { "Running handle", ColliderAPI }
let worldCreated = false;
let RAPIER: typeof Rapier;
let physicsWorld: Rapier.World = { step: () => {} } as Rapier.World;
let physicsWorldAPI: WorldAPI;
let eventQueue: Rapier.EventQueue | undefined = undefined;
let collisionEventFnCount = 0;
let contactForceEventFnCount = 0;

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
  physicsWorldAPI = createWorld(physicsState.gravity, {
    timestep: physicsState.timestepRatio,
    numSolverIterations: physicsState.solverIterations,
    numInternalPgsIterations: physicsState.internalPgsIterations,
  });
  return physicsWorldAPI;
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
  const id = existsOrThrow(params.id, 'Rigid body params is missing the running id.');
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

  rigidBodies.set(id, rigidBody.handle);
  const rigidBodyAPI = createEnginePhysicsRigidBodyAPI(id);
  rigidBodyAPIs.set(id, rigidBodyAPI);

  return rigidBodyAPI;
};

export const createCollider = (params: ColliderParams) => {
  const id = existsOrThrow(params.id, 'Collider params is missing the running id.');
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

  const collider = physicsWorld.createCollider(colliderDesc, _getRigidBody(params.parentId));
  colliders.set(id, collider.handle);
  const colliderAPI = createEnginePhysicsColliderAPI(id);
  colliderAPIs.set(id, colliderAPI);

  return colliderAPI;
};

export const createRigidBodies = (paramsArray: RigidBodyParams[]) =>
  paramsArray.map((params) => createRigidBody(params));

export const createColliders = (paramsArray: ColliderParams[]) =>
  paramsArray.map((params) => createCollider(params));

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

export const debugRenderAPI = () => {
  // @CHORE: FINISH THIS
};

export const stepAPI = () => {
  // @CHORE: FINISH THIS
};

/** World, RigidBody, and Collider API definitions -----[ START ]----- */

const createEnginePhysicsWorldAPI = (): WorldAPI => ({
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
  createRigidBody: async (params: RigidBodyParams) => {
    // @CHORE: add createRigidBodyDesc
  },
  createCollider: async (params: ColliderParams) => {
    // @CHORE: add createRigidBodyDesc
  },
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
  intersectionPair: async (collider1: ColliderAPI, collider2: ColliderAPI) => {
    const coll1 = _getCollider(collider1);
    const coll2 = _getCollider(collider2);
    if (!coll1 || !coll2) return false;
    return physicsWorld.intersectionPair(coll1, coll2);
  },
});

const createEnginePhysicsRigidBodyAPI = (id: number): RigidBodyAPI => ({
  id,
  userData: function (userData?: { [key: string]: unknown }) {
    // returns { [key: string]: unknown } | void;
  },
  isValid: function () {
    // returns boolean;
  },
  lockTranslations: function (locked: boolean, wakeUp: boolean) {
    // returns void;
  },
  lockRotations: function (locked: boolean, wakeUp: boolean) {
    // returns void;
  },
  setEnabledTranslations: function (
    enableX: boolean,
    enableY: boolean,
    enableZ: boolean,
    wakeUp: boolean
  ) {
    // returns void;
  },
  setEnabledRotations: function (
    enableX: boolean,
    enableY: boolean,
    enableZ: boolean,
    wakeUp: boolean
  ) {
    // returns void;
  },
  dominanceGroup: function () {
    // returns number;
  },
  setDominanceGroup: function (group: number) {
    // returns void;
  },
  additionalSolverIterations: function () {
    // returns number;
  },
  setAdditionalSolverIterations: function (iters: number) {
    // returns void;
  },
  enableCcd: function (enabled: boolean) {
    // returns void;
  },
  setSoftCcdPrediction: function (distance: number) {
    // returns void;
  },
  softCcdPrediction: function () {
    // returns number;
  },
  translation: function () {
    // returns PhysVector;
  },
  rotation: function () {
    // returns PhysRotation;
  },
  nextTranslation: function () {
    // returns PhysVector;
  },
  nextRotation: function () {
    // returns PhysRotation;
  },
  setTranslation: function (tra: PhysVector, wakeUp: boolean) {
    // returns void;
  },
  setLinvel: function (vel: PhysVector, wakeUp: boolean) {
    // returns void;
  },
  gravityScale: function () {
    // returns number;
  },
  setGravityScale: function (factor: number, wakeUp: boolean) {
    // returns void;
  },
  setRotation: function (rot: PhysRotation, wakeUp: boolean) {
    // returns void;
  },
  setAngvel: function (vel: PhysVector, wakeUp: boolean) {
    // returns void;
  },
  setNextKinematicTranslation: function (t: PhysVector) {
    // returns void;
  },
  setNextKinematicRotation: function (rot: PhysRotation) {
    // returns void;
  },
  linvel: function () {
    // returns PhysVector;
  },
  velocityAtPoint: function (point: PhysVector) {
    // returns PhysVector;
  },
  angvel: function () {
    // returns PhysVector;
  },
  mass: function () {
    // returns number;
  },
  effectiveInvMass: function () {
    // returns PhysVector;
  },
  invMass: function () {
    // returns number;
  },
  localCom: function () {
    // returns PhysVector;
  },
  worldCom: function () {
    // returns PhysVector;
  },
  invPrincipalInertia: function () {
    // returns PhysVector;
  },
  principalInertia: function () {
    // returns PhysVector;
  },
  principalInertiaLocalFrame: function () {
    // returns PhysRotation;
  },
  sleep: function () {
    // returns void;
  },
  wakeUp: function () {
    // returns void;
  },
  isCcdEnabled: function () {
    // returns boolean;
  },
  numColliders: function () {
    // returns number;
  },
  collider: function (i: number) {
    // returns ColliderAPI;
  },
  setEnabled: function (enabled: boolean) {
    // returns void;
  },
  isEnabled: function () {
    // returns boolean;
  },
  bodyType: function () {
    // returns RigidBodyTypeAPI;
  },
  setBodyType: function (type: RigidBodyTypeAPI, wakeUp: boolean) {
    // returns void;
  },
  isSleeping: function () {
    // returns boolean;
  },
  isMoving: function () {
    // returns boolean;
  },
  isFixed: function () {
    // returns boolean;
  },
  isKinematic: function () {
    // returns boolean;
  },
  isDynamic: function () {
    // returns boolean;
  },
  linearDamping: function () {
    // returns number;
  },
  angularDamping: function () {
    // returns number;
  },
  setLinearDamping: function (factor: number) {
    // returns void;
  },
  recomputeMassPropertiesFromColliders: function () {
    // returns void;
  },
  setAdditionalMass: function (mass: number, wakeUp: boolean) {
    // returns void;
  },
  setAdditionalMassProperties: function (
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation,
    wakeUp: boolean
  ) {
    // returns void;
  },
  setAngularDamping: function (factor: number) {
    // returns void;
  },
  resetForces: function (wakeUp: boolean) {
    // returns void;
  },
  resetTorques: function (wakeUp: boolean) {
    // returns void;
  },
  addForce: function (force: PhysVector, wakeUp: boolean) {
    // returns void;
  },
  applyImpulse: function (impulse: PhysVector, wakeUp: boolean) {
    // returns void;
  },
  addTorque: function (torque: PhysVector, wakeUp: boolean) {
    // returns void;
  },
  applyTorqueImpulse: function (torqueImpulse: PhysVector, wakeUp: boolean) {
    // returns void;
  },
  addForceAtPoint: function (force: PhysVector, point: PhysVector, wakeUp: boolean) {
    // return void;
  },
  applyImpulseAtPoint: function (impulse: PhysVector, point: PhysVector, wakeUp: boolean) {
    // returns void;
  },
  userForce: function () {
    // returns PhysVector;
  },
  userTorque: function () {
    // returns PhysVector;
  },
});

export const createEnginePhysicsColliderAPI = (id: number): ColliderAPI => ({
  //   /**
  //    * Rigid body id (a running integer id).
  //    */
  //   readonly id: number;
  //   /**
  //    * Set the internal cached JS shape to null.
  //    *
  //    * This can be useful if you want to free some memory (assuming you are not
  //    * holding any other references to the shape object), or in order to force
  //    * the recalculation of the JS shape (the next time the `shape` getter is
  //    * accessed) from the WASM source of truth.
  //    */
  //   clearShapeCache(): void;
  //   /**
  //    * Checks if this collider is still valid (i.e. that it has
  //    * not been deleted from the collider set yet).
  //    */
  //   isValid(): boolean;
  //   /**
  //    * The world-space translation of this collider.
  //    */
  //   translation(): PhysVector;
  //   /**
  //    * The translation of this collider relative to its parent rigid-body.
  //    *
  //    * Returns `null` if the collider doesn’t have a parent rigid-body.
  //    */
  //   translationWrtParent(): PhysVector | null;
  //   /**
  //    * The world-space orientation of this collider.
  //    */
  //   rotation(): PhysRotation;
  //   /**
  //    * The orientation of this collider relative to its parent rigid-body.
  //    *
  //    * Returns `null` if the collider doesn’t have a parent rigid-body.
  //    */
  //   rotationWrtParent(): PhysRotation | null;
  //   /**
  //    * Is this collider a sensor?
  //    */
  //   isSensor(): boolean;
  //   /**
  //    * Sets whether this collider is a sensor.
  //    * @param isSensor - If `true`, the collider will be a sensor.
  //    */
  //   setSensor(isSensor: boolean): void;
  //   /**
  //    * Sets whether this collider is enabled or not.
  //    *
  //    * @param enabled - Set to `false` to disable this collider (its parent rigid-body won’t be disabled automatically by this).
  //    */
  //   setEnabled(enabled: boolean): void;
  //   /**
  //    * Is this collider enabled?
  //    */
  //   isEnabled(): boolean;
  //   /**
  //    * Sets the restitution coefficient of the collider to be created.
  //    *
  //    * @param restitution - The restitution coefficient in `[0, 1]`. A value of 0 (the default) means no bouncing behavior
  //    *                   while 1 means perfect bouncing (though energy may still be lost due to numerical errors of the
  //    *                   constraints solver).
  //    */
  //   setRestitution(restitution: number): void;
  //   /**
  //    * Sets the friction coefficient of the collider to be created.
  //    *
  //    * @param friction - The friction coefficient. Must be greater or equal to 0. This is generally smaller than 1. The
  //    *                   higher the coefficient, the stronger friction forces will be for contacts with the collider
  //    *                   being built.
  //    */
  //   setFriction(friction: number): void;
  //   /**
  //    * Gets the rule used to combine the friction coefficients of two colliders
  //    * colliders involved in a contact.
  //    */
  //   frictionCombineRule(): CoefficientCombineRule;
  //   /**
  //    * Sets the rule used to combine the friction coefficients of two colliders
  //    * colliders involved in a contact.
  //    *
  //    * @param rule − The combine rule to apply.
  //    */
  //   setFrictionCombineRule(rule: CoefficientCombineRule): void;
  //   /**
  //    * Gets the rule used to combine the restitution coefficients of two colliders
  //    * colliders involved in a contact.
  //    */
  //   restitutionCombineRule(): CoefficientCombineRule;
  //   /**
  //    * Sets the rule used to combine the restitution coefficients of two colliders
  //    * colliders involved in a contact.
  //    *
  //    * @param rule − The combine rule to apply.
  //    */
  //   setRestitutionCombineRule(rule: CoefficientCombineRule): void;
  //   /**
  //    * Sets the collision groups used by this collider.
  //    *
  //    * Two colliders will interact iff. their collision groups are compatible.
  //    * See the documentation of `InteractionGroups` for details on teh used bit pattern.
  //    *
  //    * @param groups - The collision groups used for the collider being built.
  //    */
  //   setCollisionGroups(groups: InteractionGroupsAPI): void;
  //   /**
  //    * Sets the solver groups used by this collider.
  //    *
  //    * Forces between two colliders in contact will be computed iff their solver
  //    * groups are compatible.
  //    * See the documentation of `InteractionGroups` for details on the used bit pattern.
  //    *
  //    * @param groups - The solver groups used for the collider being built.
  //    */
  //   setSolverGroups(groups: InteractionGroupsAPI): void;
  //   /**
  //    * Sets the contact skin for this collider.
  //    *
  //    * See the documentation of `ColliderDesc.setContactSkin` for additional details.
  //    */
  //   contactSkin(): number;
  //   /**
  //    * Sets the contact skin for this collider.
  //    *
  //    * See the documentation of `ColliderDesc.setContactSkin` for additional details.
  //    *
  //    * @param thickness - The contact skin thickness.
  //    */
  //   setContactSkin(thickness: number): void;
  //   /**
  //    * Get the physics hooks active for this collider.
  //    */
  //   activeHooks(): ActiveHooks;
  //   /**
  //    * Set the physics hooks active for this collider.
  //    *
  //    * Use this to enable custom filtering rules for contact/intersecstion pairs involving this collider.
  //    *
  //    * @param activeHooks - The hooks active for contact/intersection pairs involving this collider.
  //    */
  //   setActiveHooks(activeHooks: ActiveHooks): void;
  //   /**
  //    * The events active for this collider.
  //    */
  //   activeEvents(): ActiveEvents;
  //   /**
  //    * Set the events active for this collider.
  //    *
  //    * Use this to enable contact and/or intersection event reporting for this collider.
  //    *
  //    * @param activeEvents - The events active for contact/intersection pairs involving this collider.
  //    */
  //   setActiveEvents(activeEvents: ActiveEvents): void;
  //   /**
  //    * Gets the collision types active for this collider.
  //    */
  //   activeCollisionTypes(): ActiveCollisionTypes;
  //   /**
  //    * Sets the total force magnitude beyond which a contact force event can be emitted.
  //    *
  //    * @param threshold - The new force threshold.
  //    */
  //   setContactForceEventThreshold(threshold: number): void;
  //   /**
  //    * The total force magnitude beyond which a contact force event can be emitted.
  //    */
  //   contactForceEventThreshold(): number;
  //   /**
  //    * Set the collision types active for this collider.
  //    *
  //    * @param activeCollisionTypes - The hooks active for contact/intersection pairs involving this collider.
  //    */
  //   setActiveCollisionTypes(activeCollisionTypes: ActiveCollisionTypes): void;
  //   /**
  //    * Sets the uniform density of this collider.
  //    *
  //    * This will override any previous mass-properties set by `this.setDensity`,
  //    * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
  //    * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
  //    *
  //    * The mass and angular inertia of this collider will be computed automatically based on its
  //    * shape.
  //    */
  //   setDensity(density: number): void;
  //   /**
  //    * Sets the mass of this collider.
  //    *
  //    * This will override any previous mass-properties set by `this.setDensity`,
  //    * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
  //    * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
  //    *
  //    * The angular inertia of this collider will be computed automatically based on its shape
  //    * and this mass value.
  //    */
  //   setMass(mass: number): void;
  //   /**
  //    * Sets the mass of this collider.
  //    *
  //    * This will override any previous mass-properties set by `this.setDensity`,
  //    * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
  //    * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
  //    */
  //   setMassProperties(
  //     mass: number,
  //     centerOfMass: PhysVector,
  //     principalAngularInertia: PhysVector,
  //     angularInertiaLocalFrame: PhysRotation
  //   ): void;
  //   /**
  //    * Sets the translation of this collider.
  //    *
  //    * @param tra - The world-space position of the collider.
  //    */
  //   setTranslation(tra: PhysVector): void;
  //   /**
  //    * Sets the translation of this collider relative to its parent rigid-body.
  //    *
  //    * Does nothing if this collider isn't attached to a rigid-body.
  //    *
  //    * @param tra - The new translation of the collider relative to its parent.
  //    */
  //   setTranslationWrtParent(tra: PhysVector): void;
  //   /**
  //    * Sets the rotation quaternion of this collider.
  //    *
  //    * This does nothing if a zero quaternion is provided.
  //    *
  //    * @param rotation - The rotation to set.
  //    */
  //   setRotation(rot: PhysRotation): void;
  //   /**
  //    * Sets the rotation quaternion of this collider relative to its parent rigid-body.
  //    *
  //    * This does nothing if a zero quaternion is provided or if this collider isn't
  //    * attached to a rigid-body.
  //    *
  //    * @param rotation - The rotation to set.
  //    */
  //   setRotationWrtParent(rot: PhysRotation): void;
  //   /**
  //    * The type of the shape of this collider.
  //    */
  //   shapeType(): ShapeType;
  //   /**
  //    * The half-extents of this collider if it is a cuboid shape.
  //    */
  //   halfExtents(): PhysVector;
  //   /**
  //    * Sets the half-extents of this collider if it is a cuboid shape.
  //    *
  //    * @param newHalfExtents - desired half extents.
  //    */
  //   setHalfExtents(newHalfExtents: PhysVector): void;
  //   /**
  //    * The radius of this collider if it is a ball, cylinder, capsule, or cone shape.
  //    */
  //   radius(): number;
  //   /**
  //    * Sets the radius of this collider if it is a ball, cylinder, capsule, or cone shape.
  //    *
  //    * @param newRadius - desired radius.
  //    */
  //   setRadius(newRadius: number): void;
  //   /**
  //    * The radius of the round edges of this collider if it is a round cylinder.
  //    */
  //   roundRadius(): number;
  //   /**
  //    * Sets the radius of the round edges of this collider if it has round edges.
  //    *
  //    * @param newBorderRadius - desired round edge radius.
  //    */
  //   setRoundRadius(newBorderRadius: number): void;
  //   /**
  //    * The half height of this collider if it is a cylinder, capsule, or cone shape.
  //    */
  //   halfHeight(): number;
  //   /**
  //    * Sets the half height of this collider if it is a cylinder, capsule, or cone shape.
  //    *
  //    * @param newHalfheight - desired half height.
  //    */
  //   setHalfHeight(newHalfheight: number): void;
  //   /**
  //    * If this collider has a Voxels shape, this will mark the voxel at the
  //    * given grid coordinates as filled or empty (depending on the `filled`
  //    * argument).
  //    *
  //    * Each input value is assumed to be an integer.
  //    *
  //    * The operation is O(1), unless the provided coordinates are out of the
  //    * bounds of the currently allocated internal grid in which case the grid
  //    * will be grown automatically.
  //    */
  //   setVoxel(ix: number, iy: number, iz: number, filled: boolean): void;
  //   /**
  //    * If this and `voxels2` are voxel colliders, and a voxel from `this` was
  //    * modified with `setVoxel`, this will ensure that a
  //    * moving object transitioning across the boundaries of these colliders
  //    * won’t suffer from the "internal edges" artifact.
  //    *
  //    * The indices `ix, iy, iz` indicate the integer coordinates of the voxel in
  //    * the local coordinate frame of `this`.
  //    *
  //    * If the voxels in `voxels2` live in a different coordinate space from `this`,
  //    * then the `shift_*` argument indicate the distance, in voxel units, between
  //    * the origin of `this` to the origin of `voxels2`.
  //    *
  //    * This method is intended to be called between `this` and all the other
  //    * voxels colliders with a domain intersecting `this` or sharing a domain
  //    * boundary. This is an incremental maintenance of the effect of
  //    * `combineVoxelStates`.
  //    */
  //   propagateVoxelChange(
  //     voxels2: ColliderAPI,
  //     ix: number,
  //     iy: number,
  //     iz: number,
  //     shift_x: number,
  //     shift_y: number,
  //     shift_z: number
  //   ): void;
  //   /**
  //    * If this and `voxels2` are voxel colliders, this will ensure that a
  //    * moving object transitioning across the boundaries of these colliders
  //    * won’t suffer from the "internal edges" artifact.
  //    *
  //    * If the voxels in `voxels2` live in a different coordinate space from `this`,
  //    * then the `shift_*` argument indicate the distance, in voxel units, between
  //    * the origin of `this` to the origin of `voxels2`.
  //    *
  //    * This method is intended to be called once between all pairs of voxels
  //    * colliders with intersecting domains or shared boundaries.
  //    *
  //    * If either voxels collider is then modified with `setVoxel`, the
  //    * `propagateVoxelChange` method must be called to maintain the coupling
  //    * between the voxels shapes after the modification.
  //    */
  //   combineVoxelStates(voxels2: ColliderAPI, shift_x: number, shift_y: number, shift_z: number): void;
  //   /**
  //    * If this collider has a triangle mesh, polyline, convex polygon, or convex polyhedron shape,
  //    * this returns the vertex buffer of said shape.
  //    */
  //   vertices(): Float32Array;
  //   /**
  //    * If this collider has a triangle mesh, polyline, or convex polyhedron shape,
  //    * this returns the index buffer of said shape.
  //    */
  //   indices(): Uint32Array | undefined;
  //   /**
  //    * If this collider has a heightfield shape, this returns the heights buffer of
  //    * the heightfield.
  //    * In 3D, the returned height matrix is provided in column-major order.
  //    */
  //   heightfieldHeights(): Float32Array;
  //   /**
  //    * If this collider has a heightfield shape, this returns the scale
  //    * applied to it.
  //    */
  //   heightfieldScale(): PhysVector;
  //   /**
  //    * If this collider has a heightfield shape, this returns the number of
  //    * rows of its height matrix.
  //    */
  //   heightfieldNRows(): number;
  //   /**
  //    * If this collider has a heightfield shape, this returns the number of
  //    * columns of its height matrix.
  //    */
  //   heightfieldNCols(): number;
  //   /**
  //    * The rigid-body this collider is attached to.
  //    */
  //   parent(): RigidBodyAPI | null;
  //   /**
  //    * The friction coefficient of this collider.
  //    */
  //   friction(): number;
  //   /**
  //    * The restitution coefficient of this collider.
  //    */
  //   restitution(): number;
  //   /**
  //    * The density of this collider.
  //    */
  //   density(): number;
  //   /**
  //    * The mass of this collider.
  //    */
  //   mass(): number;
  //   /**
  //    * The volume of this collider.
  //    */
  //   volume(): number;
  //   /**
  //    * The collision groups of this collider.
  //    */
  //   collisionGroups(): InteractionGroupsAPI;
  //   /**
  //    * The solver groups of this collider.
  //    */
  //   solverGroups(): InteractionGroupsAPI;
  //   /**
  //    * Tests if this collider contains a point.
  //    *
  //    * @param point - The point to test.
  //    */
  //   containsPoint(point: PhysVector): boolean;
  //   /**
  //    * Find the projection of a point on this collider.
  //    *
  //    * @param point - The point to project.
  //    * @param solid - If this is set to `true` then the collider shapes are considered to
  //    *   be plain (if the point is located inside of a plain shape, its projection is the point
  //    *   itself). If it is set to `false` the collider shapes are considered to be hollow
  //    *   (if the point is located inside of an hollow shape, it is projected on the shape's
  //    *   boundary).
  //    */
  //   projectPoint(point: PhysVector, solid: boolean): PointProjection | null;
  //   /**
  //    * Tests if this collider intersects the given ray.
  //    *
  //    * @param ray - The ray to cast.
  //    * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
  //    *   limits the length of the ray to `ray.dir.norm() * maxToi`.
  //    */
  //   intersectsRay(ray: PhysRay, maxToi: number): boolean;
  //   /**
  //    * Find the closest intersection between a ray and this collider.
  //    *
  //    * This also computes the normal at the hit point.
  //    * @param ray - The ray to cast.
  //    * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
  //    *   limits the length of the ray to `ray.dir.norm() * maxToi`.
  //    * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
  //    *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
  //    *   whereas `false` implies that all shapes are hollow for this ray-cast.
  //    * @returns The time-of-impact between this collider and the ray, or `-1` if there is no intersection.
  //    */
  //   castRay(ray: PhysRay, maxToi: number, solid: boolean): number;
  //   /**
  //    * Find the closest intersection between a ray and this collider.
  //    *
  //    * This also computes the normal at the hit point.
  //    * @param ray - The ray to cast.
  //    * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
  //    *   limits the length of the ray to `ray.dir.norm() * maxToi`.
  //    * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
  //    *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
  //    *   whereas `false` implies that all shapes are hollow for this ray-cast.
  //    */
  //   castRayAndGetNormal(ray: PhysRay, maxToi: number, solid: boolean): RayIntersection | null;
});

/** World, RigidBody, and Collider API definitions -----[ END ]----- */
