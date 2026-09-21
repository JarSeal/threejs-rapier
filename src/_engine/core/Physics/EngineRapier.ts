import Rapier from '@dimforge/rapier3d-compat';
import type { Collider, RigidBody, RigidBodyType } from '@dimforge/rapier3d-compat';
import { getPhysicsEngine } from './PhysicsUtils';
import {
  ColliderAPI,
  ColliderParams,
  CollisionEventRecord,
  ContactForceEventRecord,
  ContactForceEventSnapshot,
  EventQueue,
  InteractionGroupsAPI,
  PhysicsHooks,
  PhysicsState,
  PhysRay,
  PhysRotation,
  PhysVector,
  QueryFilterFlags,
  RayColliderHitAPI,
  RayColliderIntersectionAPI,
  RigidBodyAPI,
  RigidBodyParams,
  RigidBodyTypeAPI,
  ShapeType,
  TempContactForceEvent,
  WorldAPI,
} from './PhysicsAPITypes';
import { LoopState } from '../MainLoop';
import { lwarn } from '../../utils/Logger';
import { existsOrThrow } from '../../utils/assert';

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
  maxSubSteps: 60,
  worldStepEnabled: true,
  visualizerEnabled: false,
  gravity: { x: 0, y: -9.81, z: 0 },
  solverIterations: 10,
  internalPgsIterations: 1,
  interpolationMode: 'NONE',
  useSAB: true,
  maxBodies: 2048,
};

/** NEW STUFF (@CHORE: delete this line when everything is diamonds!!!) */

let nextRigidBodyId = 0;
let nextColliderId = 0;
const rigidBodies = new Map<number, number>(); // { "Running id", RigidBody.handle }
const colliders = new Map<number, number>(); // { "Running id", Collider.handle }
const rigidBodyAPIs = new Map<number, RigidBodyAPI>(); // { "Running id", RigidBodyAPI }
const colliderAPIs = new Map<number, ColliderAPI>(); // { "Running id", ColliderAPI }
// Reverse of `colliders`, needed because getColliderAPI() is handed Rapier's own raw
// collider handles (e.g. from event queue drains, raycast/contact-pair query results) —
// those are Rapier's internal handle values, not our running ids, so colliderAPIs (keyed
// by id) can't be looked up with them directly.
const handleToColliderId = new Map<number, number>(); // { "Collider.handle", "Running id" }
let worldCreated = false;
let isDebugEnvironment = false;
let RAPIER: typeof Rapier;
let physicsWorld: Rapier.World = { step: () => {} } as Rapier.World;
let physicsWorldAPI: WorldAPI;
let eventQueue: Rapier.EventQueue | undefined = undefined;
let collisionEventFnCount = 0;
let contactForceEventFnCount = 0;
type CollisionEventFn = (collider1: ColliderAPI, collider2: ColliderAPI, started: boolean) => void;
type ContactForceEventFn = (event: TempContactForceEvent) => void;
// { "collider id", callbacks[] } — arrays to match the legacy file's multi-callback support
// for compound colliders. MAIN_THREAD only; WORKER_THREAD keeps the real callbacks on the
// main thread in PhysicsAPI.ts and only reads plain records back from this module.
const collisionEventFns = new Map<number, CollisionEventFn[]>();
const contactForceEventFns = new Map<number, ContactForceEventFn[]>();
// WORKER_THREAD only: plain-data records accumulated across every step() call between two
// drainPendingEventRecords() calls (the worker drains once per STEP message, which may run
// multiple sub-steps), pushed to the main thread via EVENTS_PUSH. Never populated in
// MAIN_THREAD mode (dispatch there happens directly through the callback registries above).
let pendingCollisionRecords: CollisionEventRecord[] = [];
let pendingContactForceRecords: ContactForceEventRecord[] = [];
// Tracks which collider ids counted towards collisionEventFnCount/contactForceEventFnCount,
// so deleteCollider()/deleteWorld() can decrement accurately.
const collisionActiveColliderIds = new Set<number>();
const contactForceActiveColliderIds = new Set<number>();

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

/** Get colliderAPI with a Rapier.Collider or a Rapier.Collider.handle */
const getColliderAPI = (collOrHandle?: Collider | number): ColliderAPI | undefined => {
  if (collOrHandle === undefined) return undefined;
  const handle = typeof collOrHandle === 'number' ? collOrHandle : collOrHandle.handle;
  const id = handleToColliderId.get(handle);
  return id !== undefined ? colliderAPIs.get(id) : undefined;
};

/** Get rigidBodyAPI with an id (running id). */
export const getRigidBodyAPIWithId = (id: number): RigidBodyAPI | undefined =>
  rigidBodyAPIs.get(id);

/** Get colliderAPI with an id (running id). */
export const getColliderAPIWithId = (id: number): ColliderAPI | undefined => colliderAPIs.get(id);

/** Enumerates the ids of all currently-live rigid bodies. */
export const getAllRigidBodyIds = (): IterableIterator<number> => rigidBodyAPIs.keys();

export const init = (
  physicsSt: PhysicsState,
  isDebugEnv: boolean,
  _loopSt: LoopState,
  doNotCreateWorld?: boolean
) => {
  try {
    RAPIER = existsOrThrow(
      getPhysicsEngine() as typeof Rapier,
      'Could not initialize RAPIER in EngineRapier.ts init().'
    );
    physicsState = physicsSt;
    isDebugEnvironment = isDebugEnv || false;
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
  physicsWorld.timestep = opts?.timestep ?? physicsState.timestepRatio;
  if (opts?.numSolverIterations) physicsWorld.numSolverIterations = opts.numSolverIterations;
  if (opts?.numInternalPgsIterations)
    physicsWorld.numInternalPgsIterations = opts.numInternalPgsIterations;
  physicsWorldAPI = new EngineWorldProxyAPI();
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
  rigidBodyAPIs.set(id, rigidBodyAPI);

  return rigidBodyAPI;
};

export const createCollider = (params: ColliderParams, parentId?: number) => {
  let shape: Rapier.Shape | null = null;
  let size: { [key: string]: number };

  if (parentId !== undefined) params.parentId = parentId;

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

  // In MAIN_THREAD mode the real callback is available directly on params (no serialization
  // boundary); in WORKER_THREAD mode PhysicsAPI.ts strips it and sends hasCollisionEventFn/
  // hasContactForceEventFn instead. Either one enables the corresponding active events.
  const hasCollisionFn = Boolean(params.collisionEventFn) || Boolean(params.hasCollisionEventFn);
  const hasContactForceFn =
    Boolean(params.contactForceEventFn) || Boolean(params.hasContactForceEventFn);

  let activeEvents: Rapier.ActiveEvents = RAPIER.ActiveEvents.NONE;
  if (
    (params.enableCollisionActiveEvents || hasCollisionFn) &&
    (params.enableContactForceActiveEvents || hasContactForceFn)
  ) {
    activeEvents = RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
  } else if (params.enableCollisionActiveEvents || hasCollisionFn) {
    activeEvents = RAPIER.ActiveEvents.COLLISION_EVENTS;
  } else if (params.enableContactForceActiveEvents || hasContactForceFn) {
    activeEvents = RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
  }

  if (activeEvents !== RAPIER.ActiveEvents.NONE) {
    colliderDesc.setActiveEvents(activeEvents);
    if (!eventQueue) eventQueue = new RAPIER.EventQueue(true);
  }

  const collider = physicsWorld.createCollider(colliderDesc, getRigidBody(params.parentId));
  const id = nextColliderId;
  nextColliderId += 1;
  colliders.set(id, collider.handle);
  handleToColliderId.set(collider.handle, id);
  const colliderAPI = new EngineColliderProxyAPI(id, parentId, params.userData);

  if (hasCollisionFn) {
    collisionActiveColliderIds.add(id);
    collisionEventFnCount++;
  }
  if (hasContactForceFn) {
    contactForceActiveColliderIds.add(id);
    contactForceEventFnCount++;
  }
  if (params.collisionEventFn) {
    const fns = collisionEventFns.get(id) || [];
    fns.push(params.collisionEventFn);
    collisionEventFns.set(id, fns);
  }
  if (params.contactForceEventFn) {
    const fns = contactForceEventFns.get(id) || [];
    fns.push(params.contactForceEventFn);
    contactForceEventFns.set(id, fns);
  }
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
  if (rbHandle === undefined) {
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
    const childHandle = rb.collider(i).handle;
    const colliderId = getColliderAPI(childHandle)?.id;
    if (colliderId !== undefined) {
      colliders.delete(colliderId);
      colliderAPIs.delete(colliderId);
      handleToColliderId.delete(childHandle);
      cleanupColliderEventRegistrations(colliderId);
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

/** Removes id's event callback/counter/registry bookkeeping (does not touch colliders/colliderAPIs). */
const cleanupColliderEventRegistrations = (id: number) => {
  collisionEventFns.delete(id);
  contactForceEventFns.delete(id);
  if (collisionActiveColliderIds.delete(id)) collisionEventFnCount--;
  if (contactForceActiveColliderIds.delete(id)) contactForceEventFnCount--;
};

export const deleteCollider = (id: number, wakeUp?: boolean) => {
  const collHandle = colliders.get(id);
  if (collHandle === undefined) {
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
    handleToColliderId.delete(collHandle);
    cleanupColliderEventRegistrations(id);
    return { id };
  }
  physicsWorld.removeCollider(coll, Boolean(wakeUp));
  colliderAPIs.delete(id);
  colliders.delete(id);
  handleToColliderId.delete(collHandle);
  cleanupColliderEventRegistrations(id);
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
  handleToColliderId.clear();
  collisionEventFns.clear();
  contactForceEventFns.clear();
  collisionActiveColliderIds.clear();
  contactForceActiveColliderIds.clear();

  // Reset
  worldCreated = false;
  physicsWorldAPI = undefined as unknown as WorldAPI;
  eventQueue = undefined;
  collisionEventFnCount = 0;
  contactForceEventFnCount = 0;
  pendingCollisionRecords = [];
  pendingContactForceRecords = [];

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
  physicsWorldAPI = new EngineWorldProxyAPI();
  return physicsWorldAPI;
};

export const debugRender = () => {
  const buffers = physicsWorld.debugRender();
  return { vertices: buffers.vertices, colors: buffers.colors };
};

/** Drains the module's own eventQueue (populated by physicsWorld.step()) and dispatches
 * to the MAIN_THREAD callback registries, gated by the counters so a scene with no
 * collision/contact-force callbacks pays zero per-step cost. Mirrors PhysicsRapier.ts's
 * legacy drain pattern. In WORKER_THREAD mode the callback registries are always empty
 * (the real callbacks can't cross the postMessage boundary — see PhysicsAPI.ts), so this
 * instead accumulates plain-data records into pendingCollisionRecords/
 * pendingContactForceRecords for drainPendingEventRecords() to hand to the worker's STEP
 * handler afterwards.
 */
const drainAndDispatchEvents = () => {
  if (!eventQueue) return;
  const isWorker = physicsState.workerTarget === 'WORKER_THREAD';

  if (collisionEventFnCount) {
    eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      const collider1 = getColliderAPI(handle1);
      const collider2 = getColliderAPI(handle2);
      if (!collider1 || !collider2) return;
      if (isWorker) {
        pendingCollisionRecords.push({
          collider1Id: collider1.id,
          collider2Id: collider2.id,
          started,
        });
        return;
      }
      const fns1 = collisionEventFns.get(collider1.id);
      if (fns1) for (let i = 0; i < fns1.length; i++) fns1[i](collider1, collider2, started);
      const fns2 = collisionEventFns.get(collider2.id);
      if (fns2) for (let i = 0; i < fns2.length; i++) fns2[i](collider2, collider1, started);
    });
  }

  if (contactForceEventFnCount) {
    eventQueue.drainContactForceEvents((event) => {
      const collider1 = getColliderAPI(event.collider1());
      const collider2 = getColliderAPI(event.collider2());
      if (!collider1 || !collider2) return;
      const record: ContactForceEventRecord = {
        collider1Id: collider1.id,
        collider2Id: collider2.id,
        totalForce: event.totalForce(),
        totalForceMagnitude: event.totalForceMagnitude(),
        maxForceDirection: event.maxForceDirection(),
        maxForceMagnitude: event.maxForceMagnitude(),
      };
      if (isWorker) {
        pendingContactForceRecords.push(record);
        return;
      }
      const snapshot = new ContactForceEventSnapshot(record);
      const fns1 = contactForceEventFns.get(collider1.id);
      if (fns1) for (let i = 0; i < fns1.length; i++) fns1[i](snapshot);
      const fns2 = contactForceEventFns.get(collider2.id);
      if (fns2) for (let i = 0; i < fns2.length; i++) fns2[i](snapshot);
    });
  }
};

/** WORKER_THREAD only: returns everything accumulated by drainAndDispatchEvents() since
 * the last call, and clears the accumulators. Called once per STEP message (which may run
 * multiple sub-steps) from physicsWorker.ts's STEP handler.
 */
export const drainPendingEventRecords = (): {
  collisions: CollisionEventRecord[];
  contactForces: ContactForceEventRecord[];
} => {
  const collisions = pendingCollisionRecords;
  const contactForces = pendingContactForceRecords;
  pendingCollisionRecords = [];
  pendingContactForceRecords = [];
  return { collisions, contactForces };
};

export const step = (_eventQueue?: unknown, hooks?: unknown) => {
  physicsWorld.step(eventQueue, hooks as Rapier.PhysicsHooks | undefined);
  drainAndDispatchEvents();
};

/** World, RigidBody, and Collider proxy API definitions -----[ START ]----- */

class EngineWorldProxyAPI implements WorldAPI {
  restoringWorld: boolean = false;

  constructor() {}

  // --- Gravity ---
  getGravitySync(): PhysVector {
    return { x: physicsWorld.gravity.x, y: physicsWorld.gravity.y, z: physicsWorld.gravity.z };
  }
  async getGravity(): Promise<PhysVector> {
    return this.getGravitySync();
  }
  setGravity(gravity: PhysVector): void {
    physicsWorld.gravity = new RAPIER.Vector3(gravity.x, gravity.y, gravity.z);
  }

  // --- Lifecycle ---
  free(): void {
    physicsWorld.free();
  }

  // --- Snapshots ---
  takeSnapshotSync(): Uint8Array | undefined {
    return physicsWorld.takeSnapshot();
  }
  async takeSnapshot(): Promise<Uint8Array | undefined> {
    return this.takeSnapshotSync();
  }

  restoreSnapshotSync(data: Uint8Array): WorldAPI {
    this.restoringWorld = true;
    physicsWorld = RAPIER.World.restoreSnapshot(data);
    // Note: In Rapier, you usually need to re-initialize your local ID maps
    // after a snapshot if the handles changed.
    this.restoringWorld = false;
    return this;
  }
  async restoreSnapshot(data: Uint8Array): Promise<WorldAPI> {
    return this.restoreSnapshotSync(data);
  }

  // --- Stepping & Propagation ---
  step(_eventQueue?: EventQueue, hooks?: PhysicsHooks): void {
    physicsWorld.step(eventQueue, hooks as Rapier.PhysicsHooks | undefined);
    drainAndDispatchEvents();
  }

  debugRender(
    filterFlags?: QueryFilterFlags,
    filterPredicate?: (collider: ColliderAPI) => boolean
  ): { vertices: Float32Array; colors: Float32Array } {
    const rapierFilterPredicate = filterPredicate
      ? (collider: Collider) => {
          const colliderAPI = getColliderAPI(collider.handle);
          return colliderAPI ? filterPredicate(colliderAPI) : false;
        }
      : undefined;
    return physicsWorld.debugRender(filterFlags, rapierFilterPredicate);
  }

  propagateModifiedBodyPositionsToColliders(): void {
    physicsWorld.propagateModifiedBodyPositionsToColliders();
  }

  // --- Parameters ---
  getTimestepSync(): number {
    return physicsWorld.timestep;
  }
  async getTimestep(): Promise<number> {
    return this.getTimestepSync();
  }
  setTimestep(dt: number): void {
    physicsWorld.timestep = dt;
  }

  getLengthUnitSync(): number {
    return physicsWorld.lengthUnit;
  }
  async getLengthUnit(): Promise<number> {
    return this.getLengthUnitSync();
  }
  setLengthUnit(unitsPerMeter: number): void {
    physicsWorld.lengthUnit = unitsPerMeter;
  }

  getNumSolverIterationsSync(): number {
    return physicsWorld.numSolverIterations;
  }
  async getNumSolverIterations(): Promise<number> {
    return this.getNumSolverIterationsSync();
  }
  setNumSolverIterations(niter: number): void {
    physicsWorld.numSolverIterations = niter;
  }

  getNumInternalPgsIterationsSync(): number {
    return physicsWorld.numInternalPgsIterations;
  }
  async getNumInternalPgsIterations(): Promise<number> {
    return this.getNumInternalPgsIterationsSync();
  }
  setNumInternalPgsIterations(niter: number): void {
    physicsWorld.numInternalPgsIterations = niter;
  }

  getMaxCcdSubstepsSync(): number {
    return physicsWorld.maxCcdSubsteps;
  }
  async getMaxCcdSubsteps(): Promise<number> {
    return this.getMaxCcdSubstepsSync();
  }
  setMaxCcdSubstepsSync(substeps: number): void {
    physicsWorld.maxCcdSubsteps = substeps;
  }

  // --- Factories (Calling top-level exports in EngineRapier.ts) ---
  createRigidBodySync(params: RigidBodyParams): RigidBodyAPI {
    return createRigidBody(params);
  }
  async createRigidBody(params: RigidBodyParams): Promise<RigidBodyAPI> {
    return this.createRigidBodySync(params);
  }

  createColliderSync(params: ColliderParams, parentId?: number): ColliderAPI {
    return createCollider(params, parentId);
  }
  async createCollider(params: ColliderParams, parentId?: number): Promise<ColliderAPI> {
    return this.createColliderSync(params, parentId);
  }

  // --- Retrieval ---
  getRigidBodySync(id: number): RigidBodyAPI | undefined {
    return getRigidBodyAPIWithId(id);
  }
  async getRigidBody(id: number): Promise<RigidBodyAPI | undefined> {
    return this.getRigidBodySync(id);
  }

  getColliderSync(id: number): ColliderAPI | undefined {
    return getColliderAPIWithId(id);
  }
  async getCollider(id: number): Promise<ColliderAPI | undefined> {
    return this.getColliderSync(id);
  }

  // --- Removal ---
  removeRigidBody(bodyOrId: RigidBodyAPI | number): void {
    const id = typeof bodyOrId === 'number' ? bodyOrId : bodyOrId.id;
    deleteRigidBody(id);
  }

  removeCollider(colliderOrId: ColliderAPI | number, wakeUp: boolean): void {
    const id = typeof colliderOrId === 'number' ? colliderOrId : colliderOrId.id;
    deleteCollider(id, wakeUp);
  }

  // --- Queries ---
  castRaySync(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
  ): RayColliderHitAPI | null {
    const rapierRay = new RAPIER.Ray(ray.origin, ray.dir);
    const hit = physicsWorld.castRay(
      rapierRay,
      maxToi,
      solid,
      filterFlags,
      filterGroups,
      getCollider(filterExcludeCollider),
      getRigidBody(filterExcludeRigidBody)
    );

    if (!hit) return null;
    const colliderAPI = getColliderAPI(hit.collider.handle);
    return colliderAPI ? { collider: colliderAPI, timeOfImpact: hit.timeOfImpact } : null;
  }
  async castRay(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
  ): Promise<RayColliderHitAPI | null> {
    return this.castRaySync(
      ray,
      maxToi,
      solid,
      filterFlags,
      filterGroups,
      filterExcludeCollider,
      filterExcludeRigidBody
    );
  }

  castRayAndGetNormalSync(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
  ): RayColliderIntersectionAPI | null {
    const rapierRay = new RAPIER.Ray(ray.origin, ray.dir);
    const inter = physicsWorld.castRayAndGetNormal(
      rapierRay,
      maxToi,
      solid,
      filterFlags,
      filterGroups,
      getCollider(filterExcludeCollider),
      getRigidBody(filterExcludeRigidBody)
    );

    if (!inter) return null;
    const colliderAPI = getColliderAPI(inter.collider.handle);
    return colliderAPI
      ? {
          collider: colliderAPI,
          timeOfImpact: inter.timeOfImpact,
          normal: inter.normal,
          featureType: inter.featureType,
          featureId: inter.featureId,
        }
      : null;
  }
  async castRayAndGetNormal(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
  ): Promise<RayColliderIntersectionAPI | null> {
    return this.castRayAndGetNormalSync(
      ray,
      maxToi,
      solid,
      filterFlags,
      filterGroups,
      filterExcludeCollider,
      filterExcludeRigidBody
    );
  }

  intersectionsWithRaySync(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    callback: (intersect: RayColliderIntersectionAPI) => boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
  ): void {
    physicsWorld.intersectionsWithRay(
      new RAPIER.Ray(ray.origin, ray.dir),
      maxToi,
      solid,
      (inter) => {
        const colliderAPI = getColliderAPI(inter.collider.handle);
        if (!colliderAPI) return true;
        return callback({
          collider: colliderAPI,
          timeOfImpact: inter.timeOfImpact,
          normal: inter.normal,
          featureType: inter.featureType,
          featureId: inter.featureId,
        });
      },
      filterFlags,
      filterGroups,
      getCollider(filterExcludeCollider),
      getRigidBody(filterExcludeRigidBody)
    );
  }
  async intersectionsWithRay(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    callback: (intersect: RayColliderIntersectionAPI) => boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
  ): Promise<void> {
    this.intersectionsWithRaySync(
      ray,
      maxToi,
      solid,
      callback,
      filterFlags,
      filterGroups,
      filterExcludeCollider,
      filterExcludeRigidBody
    );
  }

  // --- Interaction Pairs ---
  contactPairsWithSync(collider1: ColliderAPI | number, f: (collider2: ColliderAPI) => void): void {
    const coll = getCollider(collider1);
    if (!coll) return;
    physicsWorld.contactPairsWith(coll, (otherColl) => {
      const api = getColliderAPI(otherColl.handle);
      if (api) f(api);
    });
  }
  async contactPairsWith(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): Promise<void> {
    this.contactPairsWithSync(collider1, f);
  }

  intersectionPairsWithSync(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): void {
    const coll = getCollider(collider1);
    if (!coll) return;
    physicsWorld.intersectionPairsWith(coll, (otherColl) => {
      const api = getColliderAPI(otherColl.handle);
      if (api) f(api);
    });
  }
  async intersectionPairsWith(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): Promise<void> {
    this.intersectionPairsWithSync(collider1, f);
  }

  intersectionPairSync(collider1: ColliderAPI | number, collider2: ColliderAPI | number): boolean {
    const c1 = getCollider(collider1);
    const c2 = getCollider(collider2);
    return c1 && c2 ? physicsWorld.intersectionPair(c1, c2) : false;
  }
  async intersectionPair(
    collider1: ColliderAPI | number,
    collider2: ColliderAPI | number
  ): Promise<boolean> {
    return this.intersectionPairSync(collider1, collider2);
  }
}

class EngineRigidBodyProxyAPI implements RigidBodyAPI {
  private rb: Rapier.RigidBody;
  uData: Record<string, unknown> = {};

  isBeingDeleted: boolean = false;

  // Lazy getters (main-thread mode has no SharedArrayBuffer to write these back into,
  // so there is no hot path to optimize yet; revisit for worker-thread mode).
  get pos(): PhysVector {
    return this.rb.translation();
  }
  get rot(): PhysRotation {
    return this.rb.rotation();
  }
  get lvel(): PhysVector {
    return this.rb.linvel();
  }
  get avel(): PhysVector {
    return this.rb.angvel();
  }

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

class EngineColliderProxyAPI implements ColliderAPI {
  private coll: Rapier.Collider;
  uData: Record<string, unknown> = {};

  isBeingDeleted: boolean = false;

  constructor(
    public id: number,
    public parentId?: number,
    userData?: Record<string, unknown>
  ) {
    if (userData) this.uData = userData;
    // Retrieve the raw Rapier collider using the helper in EngineRapier.ts
    this.coll = existsOrThrow(
      getCollider(id),
      `Could not find collider in the engineAPI with id: ${id}`
    );
  }

  // --- Metadata ---
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
    return this.coll.isValid();
  }
  async isValid() {
    return this.isValidSync();
  }

  // --- Transformation ---
  translationSync(): PhysVector {
    const t = this.coll.translation();
    return { x: t.x, y: t.y, z: t.z };
  }
  async translation() {
    return this.translationSync();
  }

  translationWrtParentSync(): PhysVector | null {
    const t = this.coll.translationWrtParent();
    return t ? { x: t.x, y: t.y, z: t.z } : null;
  }
  async translationWrtParent() {
    return this.translationWrtParentSync();
  }

  rotationSync(): PhysRotation {
    const r = this.coll.rotation();
    return { x: r.x, y: r.y, z: r.z, w: r.w };
  }
  async rotation() {
    return this.rotationSync();
  }

  rotationWrtParentSync(): PhysRotation | null {
    const r = this.coll.rotationWrtParent();
    return r ? { x: r.x, y: r.y, z: r.z, w: r.w } : null;
  }
  async rotationWrtParent() {
    return this.rotationWrtParentSync();
  }

  setTranslation(tra: PhysVector) {
    this.coll.setTranslation(new RAPIER.Vector3(tra.x, tra.y, tra.z));
  }
  setTranslationWrtParent(tra: PhysVector) {
    this.coll.setTranslationWrtParent(new RAPIER.Vector3(tra.x, tra.y, tra.z));
  }
  setRotation(rot: PhysRotation) {
    this.coll.setRotation(new RAPIER.Quaternion(rot.x, rot.y, rot.z, rot.w));
  }
  setRotationWrtParent(rot: PhysRotation) {
    this.coll.setRotationWrtParent(new RAPIER.Quaternion(rot.x, rot.y, rot.z, rot.w));
  }

  // --- Physical Properties ---
  isSensorSync() {
    return this.coll.isSensor();
  }
  async isSensor() {
    return this.isSensorSync();
  }
  setSensor(isSensor: boolean) {
    this.coll.setSensor(isSensor);
  }

  isEnabledSync() {
    return this.coll.isEnabled();
  }
  async isEnabled() {
    return this.isEnabledSync();
  }
  setEnabled(enabled: boolean) {
    this.coll.setEnabled(enabled);
  }

  frictionSync() {
    return this.coll.friction();
  }
  async friction() {
    return this.frictionSync();
  }
  setFriction(friction: number) {
    this.coll.setFriction(friction);
  }

  restitutionSync() {
    return this.coll.restitution();
  }
  async restitution() {
    return this.restitutionSync();
  }
  setRestitution(restitution: number) {
    this.coll.setRestitution(restitution);
  }

  massSync() {
    return this.coll.mass();
  }
  async mass() {
    return this.massSync();
  }

  setMassProperties(
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation
  ): void {
    this.coll.setMassProperties(
      mass,
      new RAPIER.Vector3(centerOfMass.x, centerOfMass.y, centerOfMass.z),
      new RAPIER.Vector3(
        principalAngularInertia.x,
        principalAngularInertia.y,
        principalAngularInertia.z
      ),
      new RAPIER.Quaternion(
        angularInertiaLocalFrame.x,
        angularInertiaLocalFrame.y,
        angularInertiaLocalFrame.z,
        angularInertiaLocalFrame.w
      )
    );
  }

  densitySync() {
    return this.coll.density();
  }
  async density() {
    return this.densitySync();
  }
  setDensity(density: number) {
    this.coll.setDensity(density);
  }
  setMass(mass: number) {
    this.coll.setMass(mass);
  }

  // --- Geometry Details ---
  shapeTypeSync(): ShapeType {
    return this.coll.shapeType() as unknown as ShapeType;
  }
  async shapeType() {
    return this.shapeTypeSync();
  }

  radiusSync(): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.coll.shape as any).radius || 0;
  }
  async radius() {
    return this.radiusSync();
  }

  halfHeightSync(): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.coll.shape as any).halfHeight || 0;
  }
  async halfHeight() {
    return this.halfHeightSync();
  }

  halfExtentsSync(): PhysVector {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const he = (this.coll.shape as any).halfExtents;
    return he ? { x: he.x, y: he.y, z: he.z } : { x: 0, y: 0, z: 0 };
  }
  async halfExtents() {
    return this.halfExtentsSync();
  }

  // --- Groups ---
  collisionGroupsSync(): InteractionGroupsAPI {
    return this.coll.collisionGroups();
  }
  async collisionGroups() {
    return this.collisionGroupsSync();
  }
  setCollisionGroups(groups: InteractionGroupsAPI) {
    this.coll.setCollisionGroups(groups);
  }

  solverGroupsSync(): InteractionGroupsAPI {
    return this.coll.solverGroups();
  }
  async solverGroups() {
    return this.solverGroupsSync();
  }
  setSolverGroups(groups: InteractionGroupsAPI) {
    this.coll.setSolverGroups(groups);
  }

  // --- Queries ---
  containsPointSync(point: PhysVector): boolean {
    return this.coll.containsPoint(new RAPIER.Vector3(point.x, point.y, point.z));
  }
  async containsPoint(point: PhysVector) {
    return this.containsPointSync(point);
  }
}

/** World, RigidBody, and Collider proxy API definitions -----[ END ]----- */
