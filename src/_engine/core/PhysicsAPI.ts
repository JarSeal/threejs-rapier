// This API is a wrapper to call the actual physics engine.
// It has been created based on the RAPIER API model. Other engines
// may not share the same methods and call signatures (and some
// refactoring might be needed to make others work). The API
// handles the differentiation between different engines
// and threading.

import * as THREE from 'three/webgpu';

import PhysicsWorker from '../workers/physicsWorker?worker';
import { getConfig, isDebugEnvironment } from './Config';
import { PhysicsTransformBuffer } from './Physics/PhysicsTransformBuffer';
import { PhysicsDebugStateBuffer } from './Physics/PhysicsDebugStateBuffer';
import {
  getCollOrRigidId,
  getEngineAPI,
  initPhysicsEngine,
  ValidProtocolTypes,
} from './Physics/PhysicsUtils';
import { lerror, lwarn } from '../utils/Logger';
import { addVisibilityChangeFn, getReadOnlyLoopState, LoopState, toggleMainPlay } from './MainLoop';
import { DebugModuleRef, initWorker, loadDebugModuleAsync, useDebug } from '../utils/helpers';
import {
  ColliderAPI,
  CollBorderRadiusResponse,
  CollHeightsResponse,
  CollIndicesResponse,
  CollNormalResponse,
  CollVerticesResponse,
  EngineAPIType,
  HeightFieldData,
  SetDebugStateTrackingResponse,
  InteractionGroupsAPI,
  PhysicsState,
  PhysicsDownProtocol,
  PhysicsProtocolType,
  PhysicsUpProtocol,
  PhysRay,
  PhysVector,
  RayColliderIntersectionAPI,
  RigidBodyAPI,
  WorldAPI,
  PhysRotation,
  RigidBodyTypeAPI,
  TakeSnapshotResponse,
  CreateWorldResponse,
  DeleteWorldResponse,
  RestoreSnapshotResponse,
  WorldGravityResponse,
  WorldTimestepResponse,
  WorldLengthUnitResponse,
  WorldNumSolverIterationsResponse,
  WorldNumInternalPgsIterationsResponse,
  RigidBodyParams,
  CreateRigidBodyResponse,
  CreateColliderResponse,
  QueryFilterFlags,
  ColliderParams,
  CreateRigidBodiesResponse,
  CreateCollidersResponse,
  ShapeCastHitAPI,
  ShapeParams,
  WorldCastRayResponse,
  WorldCastShapeResponse,
  WorldIntersectionsWithRayResponse,
  WorldContactPairsResponse,
  WorldIntersectionPairResponse,
  WorldIntersectionPairsWithResponse,
  DeleteRigidBodyResponse,
  DeleteRigidBodiesResponse,
  DeleteColliderResponse,
  DeleteCollidersResponse,
  RigidIsValidResponse,
  RigidDominanceGroupResponse,
  RigidAdditionalSolverIterationsResponse,
  RigidSoftCcdPredictionResponse,
  RigidNextTranslationResponse,
  RigidNextRotationResponse,
  RigidGravityScaleResponse,
  RigidVelocityAtPointResponse,
  RigidMassResponse,
  RigidEffectiveInvMassResponse,
  RigidInvMassResponse,
  RigidLocalComResponse,
  RigidWorldComResponse,
  RigidInvPrincipalInertiaResponse,
  RigidPrincipalInertiaResponse,
  RigidPrincipalInertiaLocalFrameResponse,
  RigidIsCcdEnabledResponse,
  RigidNumCollidersResponse,
  RigidColliderResponse,
  RigidUserTorqueResponse,
  RigidUserForceResponse,
  RigidAngularDampingResponse,
  RigidLinearDampingResponse,
  RigidIsDynamicResponse,
  RigidIsKinematicResponse,
  RigidIsFixedResponse,
  RigidIsMovingResponse,
  RigidIsSleepingResponse,
  RigidBodyTypeResponse,
  RigidIsEnabledResponse,
  RigidGetUserDataResponse,
  RigidBodyWorkerEngine,
  RayColliderHitAPI,
  CollUserDataResponse,
  CollIsValidResponse,
  CollTranslationResponse,
  CollRotationResponse,
  CollIsSensorResponse,
  CollIsEnabledResponse,
  CollFrictionResponse,
  CollRestitutionResponse,
  CollMassResponse,
  CollDensityResponse,
  CollShapeTypeResponse,
  CollRadiusResponse,
  CollHalfHeightResponse,
  CollHalfExtentsResponse,
  CollCollisionGroupsResponse,
  CollSolverGroupsResponse,
  ContactForceEventSnapshot,
  TempContactForceEvent,
  EventsPushMessage,
  JointAPI,
  JointParams,
  JointMotorModel,
  CreateJointResponse,
  DeleteJointResponse,
  JointIsValidResponse,
  JointBody1IdResponse,
  JointBody2IdResponse,
  JointAnchor1Response,
  JointAnchor2Response,
  JointContactsEnabledResponse,
  JointLimitsEnabledResponse,
  JointGetUserDataResponse,
} from './Physics/PhysicsAPITypes';
import { createNewResolver, resolveRequest } from '../utils/PromiseResolver';
import { ShapeType } from '@dimforge/rapier3d-compat';
import { existsOrThrow } from '../utils/assert';

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
let worker: Worker | null = null;
let physicsWorld: WorldAPI = { step: () => {} } as unknown as WorldAPI;
let physicsWorldEnabled = false;
let engineInitiated = false;
let engAPI: EngineAPIType | null = null;
/** Main-thread wrapper for the worker's hot-path transform buffer (WORKER_THREAD mode only).
 * SHARED_MEMORY: set once at createPhysicsWorld() and never replaced. MESSAGE_BATCH: undefined
 * until the first TRANSFORMS_PUSH, then replaced on every subsequent push.
 */
let transformBuffer: PhysicsTransformBuffer | undefined;
/** Which hot-path transport createPhysicsWorld() resolved to for the current world (WORKER_THREAD only). */
let resolvedTransportMode: 'SHARED_MEMORY' | 'MESSAGE_BATCH' | undefined;
/** Main-thread wrapper for the worker's debug wireframe state buffer (WORKER_THREAD only,
 * p025). Undefined until setPhysicsDebugStateTracking() turns tracking on for the first
 * time. SHARED_MEMORY: set once and never replaced. MESSAGE_BATCH: replaced on every
 * DEBUG_STATE_PUSH. */
let debugStateBuffer: PhysicsDebugStateBuffer | undefined;

const rigidBodies = new Map<number, RigidBodyAPI>(); // { "Running id", RigidBodyAPI }
const colliders = new Map<number, ColliderAPI>(); // { "Running id", ColliderAPI }
const joints = new Map<number, JointAPI>(); // { "Running id", JointAPI }

type CollisionEventFn = (collider1: ColliderAPI, collider2: ColliderAPI, started: boolean) => void;
type ContactForceEventFn = (event: TempContactForceEvent) => void;
// WORKER_THREAD only: real callback functions can't cross the postMessage boundary (see
// createCollider/createColliders stripping them into hasCollisionEventFn/
// hasContactForceEventFn instead), so they're kept here on the main thread, keyed by
// collider id, and invoked when an EVENTS_PUSH message names that id.
const workerCollisionEventFns = new Map<number, CollisionEventFn[]>();
const workerContactForceEventFns = new Map<number, ContactForceEventFn[]>();

/**
 * Initializes the physics. The MAIN_THREAD branch is the one exercised by this
 * MVP; the WORKER_THREAD branch mirrors createPhysicsWorld/createRigidBody/etc.'s
 * own not-yet-exercised WORKER_THREAD branches further down in this file.
 */
export const initPhysics = async (doNotCreateWorld?: boolean) => {
  const physicsConfig = getConfig().physics;
  if (!physicsConfig?.enabled) return;

  physicsState = { ...physicsState, ...physicsConfig };
  physicsState.timestepRatio = 1 / (physicsState.timestep || 60);
  const target = physicsState.workerTarget;

  if (target === 'MAIN_THREAD') {
    const { engine, engineAPI } = await initPhysicsEngine(physicsState.physicsEngine);
    engineInitiated = Boolean(engine);
    engAPI = engineAPI;
    const worldOrUndefined = engAPI.init(
      physicsState,
      isDebugEnvironment(),
      getReadOnlyLoopState(),
      doNotCreateWorld
    );
    if (worldOrUndefined) physicsWorld = worldOrUndefined;
  } else if (target === 'WORKER_THREAD') {
    worker = await initWorker<PhysicsDownProtocol>(
      PhysicsWorker,
      'Physics Worker',
      onWorkerMessage,
      onWorkerError
    );
    const worldCreated = await messageWorkerAsync<boolean>({
      type: PhysicsProtocolType.INIT_PHYSICS,
      physicsState,
      isDebugEnvironment: isDebugEnvironment(),
      loopState: getReadOnlyLoopState(),
      doNotCreateWorld,
    });
    // Resolving without throwing means the worker's own engAPI.init() already
    // completed — mirrors the MAIN_THREAD branch's engineInitiated = Boolean(engine).
    engineInitiated = true;
    if (worldCreated) physicsWorld = new WorldProxyAPI();
  }
};

/**
 * Steps the physics world (called in the main loop). No-op until a physics world
 * has been created via createPhysicsWorld().
 *
 * Runs a fixed-timestep accumulator so simulated motion doesn't speed up/slow down with
 * the render framerate: real elapsed time (scaled by playSpeedMultiplier, clamped by
 * maxDeltaTime) is accumulated, then drained in physicsState.timestepRatio-sized slices,
 * up to maxSubSteps per frame. Also handles backgroundBehavior/pause bookkeeping the same
 * way legacy PhysicsRapier.ts's baseStepper does (see physicsVisibilityChangeHandler for
 * the window-hidden 'PAUSE' path, which halts the whole main loop before this is reached).
 *
 * Returns how many fixed-timestep slices were actually taken this call (0 if physics is
 * disabled/paused/hasn't accumulated a full slice yet) — MainLoop.ts uses this to call
 * pollHeldKeyBindings() once per slice, matching legacy PhysicsRapier.ts's baseStepper
 * (which polled held keys from inside its own per-substep loop). This system can't do the
 * same from in here: WORKER_THREAD mode's substeps happen off-thread as one batched message,
 * not a JS loop this function controls, so there's no in-between-steps point to call out to
 * held-key handling from — the caller has to do it itself, stepsTaken times.
 */
export const stepPhysics = (loopState: LoopState): number => {
  if (!physicsWorldEnabled || !physicsState.worldStepEnabled) return 0;

  updateTimer();
  let dt = timer.getDelta();

  if (!loopState.masterPlay || !loopState.appPlay) {
    // Explicit pause (unrelated to window visibility) always halts stepping outright —
    // backgroundBehavior only governs what happens while the window is hidden.
    if (!physicsState.isPaused) setPhysicsPauseTime();
    physicsState.isPaused = true;
    timerRunning = false;
    return 0;
  }

  if (loopState.isWindowHidden) {
    if (physicsState.backgroundBehavior === 'PAUSE') {
      // Normally already handled by physicsVisibilityChangeHandler halting the whole main
      // loop (toggleMainPlay(false), which makes loopState.masterPlay false and is caught
      // above) — this is a defensive fallback in case stepPhysics is still reached directly
      // while hidden.
      if (!physicsState.isPaused) setPhysicsPauseTime();
      physicsState.isPaused = true;
      timerRunning = false;
      return 0;
    }
    if (
      physicsState.backgroundBehavior === 'KEEP_RUNNING_USE_MIN_DELTA' &&
      physicsState.minDeltaTime > 0
    ) {
      dt = physicsState.minDeltaTime;
    }
    // 'KEEP_RUNNING': keep the real dt, still subject to the maxDeltaTime clamp below.
  } else if (physicsState.isPaused) {
    // Resuming: the dt just computed above spans the entire paused duration (the timer
    // wasn't updated while timerRunning was false) — discard it and the stale accumulator
    // rather than trying to simulate the whole paused duration in one go. Physics resumes
    // cleanly from next frame's dt instead.
    physicsState.isPaused = false;
    physicsState.pauseDurationTotal += performance.now() - physicsState.pausedTime;
    physicsState.pausedTime = 0;
    accDelta = 0;
    return 0;
  }

  const scaledDelta = dt * loopState.playSpeedMultiplier;
  accDelta +=
    physicsState.maxDeltaTime > 0 ? Math.min(scaledDelta, physicsState.maxDeltaTime) : scaledDelta;

  let stepsTaken = 0;
  while (
    accDelta >= physicsState.timestepRatio &&
    (physicsState.maxSubSteps === 0 || stepsTaken < physicsState.maxSubSteps)
  ) {
    accDelta -= physicsState.timestepRatio;
    stepsTaken++;
  }
  // Hit the sub-step ceiling with backlog still left over: drop it instead of deferring it,
  // so a sustained slowdown can't make the accumulator (and next frame's catch-up cost) grow
  // without bound — the actual "prevent the spiral of death" behavior.
  if (physicsState.maxSubSteps > 0 && stepsTaken >= physicsState.maxSubSteps) {
    accDelta = 0;
  }

  if (stepsTaken === 0) return 0;

  if (physicsState.workerTarget === 'MAIN_THREAD') {
    for (let i = 0; i < stepsTaken; i++) engAPI?.step();
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    // One-way, no response awaited — transform results arrive via the hot-path buffer
    // (transformBuffer), not via a STEP reply. A single message runs all of this frame's
    // sub-steps and writes back exactly once, never one message per sub-step.
    messageWorker({ type: PhysicsProtocolType.STEP, steps: stepsTaken, isOneWay: true });
  }

  return stepsTaken;
};

// WORKER LOGIC -- [ START ] -----------------------

const messageWorker = (message: PhysicsUpProtocol) => {
  if (!worker) return;
  worker.postMessage(message);
};

const messageWorkerAsync = async <T>(message: PhysicsUpProtocol) =>
  new Promise<T>((resolve, reject) => {
    if (!worker) {
      return reject(
        `Worker not found in messageWorkerAsync. Make sure you have initialized the worker before using messageWorkerAsync.`
      );
    }
    const requestId = createNewResolver(resolve);
    worker.postMessage({ ...message, requestId });
  });

const onWorkerError = (err: ErrorEvent) => {
  lerror(`Physics worker error: ${err.message}`);
};

const onWorkerMessage = (event: MessageEvent<PhysicsDownProtocol>) => {
  const data = event.data;
  const type = data.type;
  const requestId = data.requestId;

  if (type === PhysicsProtocolType.ERROR) {
    // @CONSIDER: should we throw an error here??? Maybe a physics setting whether to throw or not?
    lerror(`Error in physics worker, message: ${data.message}`);
    return;
  } else if (type === PhysicsProtocolType.TRANSFORMS_PUSH) {
    // Unsolicited push (MESSAGE_BATCH fallback) — no requestId, not a response to resolve.
    transformBuffer = new PhysicsTransformBuffer(physicsState.maxBodies, data.buffer);
    return;
  } else if (type === PhysicsProtocolType.EVENTS_PUSH) {
    // Unsolicited push, only ever sent when at least one event occurred that step — no
    // requestId, not a response to resolve.
    dispatchPushedEvents(data);
    return;
  } else if (type === PhysicsProtocolType.DEBUG_STATE_PUSH) {
    // Unsolicited push (MESSAGE_BATCH fallback) — only ever sent while debug-state
    // tracking is on. No requestId, not a response to resolve.
    debugStateBuffer = new PhysicsDebugStateBuffer(physicsState.maxBodies, data.buffer);
    return;
  } else if (!ValidProtocolTypes.has(type)) {
    lerror(`Error in physics onWorkerMessage, unknown protocol type: ${type}`);
    return;
  }

  return resolveRequest(data, requestId, type);
};

/** Resolves an EVENTS_PUSH message's plain-data records back to ColliderAPIs (via the
 * locally-registered colliders map) and invokes each side's registered WORKER_THREAD
 * callbacks with the *other* collider as the second argument — mirrors EngineRapier.ts's
 * MAIN_THREAD drainAndDispatchEvents() dispatch. Silently skips any record naming a
 * collider id this thread doesn't (or no longer) know about. */
const dispatchPushedEvents = (data: EventsPushMessage) => {
  for (let i = 0; i < data.collisions.length; i++) {
    const rec = data.collisions[i];
    const collider1 = colliders.get(rec.collider1Id);
    const collider2 = colliders.get(rec.collider2Id);
    if (!collider1 || !collider2) continue;
    const fns1 = workerCollisionEventFns.get(rec.collider1Id);
    if (fns1) for (let j = 0; j < fns1.length; j++) fns1[j](collider1, collider2, rec.started);
    const fns2 = workerCollisionEventFns.get(rec.collider2Id);
    if (fns2) for (let j = 0; j < fns2.length; j++) fns2[j](collider2, collider1, rec.started);
  }

  for (let i = 0; i < data.contactForces.length; i++) {
    const rec = data.contactForces[i];
    const collider1 = colliders.get(rec.collider1Id);
    const collider2 = colliders.get(rec.collider2Id);
    if (!collider1 || !collider2) continue;
    const snapshot = new ContactForceEventSnapshot(rec);
    const fns1 = workerContactForceEventFns.get(rec.collider1Id);
    if (fns1) for (let j = 0; j < fns1.length; j++) fns1[j](snapshot);
    const fns2 = workerContactForceEventFns.get(rec.collider2Id);
    if (fns2) for (let j = 0; j < fns2.length; j++) fns2[j](snapshot);
  }
};

// WORKER LOGIC -- [ END ] -----------------------

const setPhysicsPauseTime = () => {
  const now = performance.now();
  if (physicsState.pausedTime > 0) {
    physicsState.pauseDurationTotal += now - physicsState.pausedTime;
  }
  physicsState.pausedTime = now;
};

/** Get the current phys game time, that is the performance.now()
 * adjusted with the total pause time.
 */
export const getPhysGameTime = () => {
  const now = performance.now();
  let currentTotalPauseDuration = physicsState.pauseDurationTotal;

  // If currently paused, add the time since the last pause began
  if (physicsState.pausedTime > 0) {
    currentTotalPauseDuration += now - physicsState.pausedTime;
  }

  return now - currentTotalPauseDuration;
};

/** Window visibility change handler */
const physicsVisibilityChangeHandler = (isHidden: boolean) => {
  const loopState = getReadOnlyLoopState();
  if (isHidden) {
    if (loopState.masterPlay && physicsState.backgroundBehavior === 'PAUSE') {
      setPhysicsPauseTime();
      physicsState.isPaused = true;
      timerRunning = false;
      physicsState.pauseReason = 'BACKGROUND_BEHAVIOR';
      toggleMainPlay(false);
    }
  } else {
    if (physicsState.pauseReason === 'BACKGROUND_BEHAVIOR') {
      physicsState.pauseReason = null;
      // Re-enable the timer; stepPhysics()'s own resume-detection branch discards the
      // resulting pause-spanning dt and resets accDelta on its next call, so no flush is
      // needed here.
      timerRunning = true;
      toggleMainPlay(true);
    }
  }
};

// Physics step accumulator variables
let timerRunning = true;
let accDelta = 0;
const timer = new THREE.Timer();
const updateTimer = () => {
  if (timerRunning) {
    timer.update();
  }
};

/** Returns the current physicsState */
export const getPhysicsState = () => physicsState;

/** Returns the fixed-timestep accumulator's current interpolation alpha (0..1): how far
 * stepPhysics()'s accumulator is into the next physics step, for 'FIXED_PHYSICS'
 * interpolation mode (see PhysicsManager.ts's physicsInterpolationSystem). 0 means the
 * render is showing the pose from right after the last consumed step (i.e. one step
 * "behind" real time, by design — the standard fixed-timestep interpolation trade-off of
 * never extrapolating into an unknown future state). */
export const getPhysicsInterpolationAlpha = () =>
  physicsState.timestepRatio > 0
    ? Math.min(1, Math.max(0, accDelta / physicsState.timestepRatio))
    : 0;

/** Returns the current WorldAPI instance (for live setGravity/setNumSolverIterations/etc.
 * calls), or the no-op stub if no world has been created yet via createPhysicsWorld(). */
export const getPhysicsWorld = () => physicsWorld;

/** Whether a physics world currently exists (i.e. createPhysicsWorld() has resolved and
 * deletePhysicsWorld() hasn't run since) — guards calls on the getPhysicsWorld() stub. */
export const isPhysicsWorldEnabled = () => physicsWorldEnabled;

export const createPhysicsWorld = async (
  gravity?: PhysVector,
  opts?: {
    /** Timestep as delta time (eg. 1/60 = 0,0166666666667) */
    timestep?: number;
    /** Integer */
    solverIterations?: number;
    /** Integer */
    internalPgsIterations?: number;
  }
) => {
  existsOrThrow(
    engineInitiated,
    'Physics engine not initiated. Initiate the engine (initPhysics) before creating the world'
  );
  if (physicsWorldEnabled) {
    if (isDebugEnvironment())
      lwarn(
        'Trying to create another physics world even though the physics world has been already created.'
      );
    return;
  }

  const gravityArg = gravity || physicsState.gravity;
  const timestep = opts?.timestep || physicsState.timestepRatio;
  const solverIterations = opts?.solverIterations || physicsState.solverIterations;
  const internalPgsIterations = opts?.internalPgsIterations || physicsState.internalPgsIterations;
  const optsArg = {
    timestep,
    numSolverIterations: solverIterations,
    numInternalPgsIterations: internalPgsIterations,
  };

  if (physicsState.workerTarget === 'MAIN_THREAD') {
    physicsWorld = existsOrThrow(
      engAPI?.createWorld(gravityArg, optsArg),
      `Could not create physics world (main thread), engineAPI: ${JSON.stringify(getEngineAPI())}`
    );
    physicsWorldEnabled = true;
    addVisibilityChangeFn('pausePhysicsApiOnVisibilityChange', physicsVisibilityChangeHandler);
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<CreateWorldResponse>({
      type: PhysicsProtocolType.CREATE_WORLD,
      gravity: gravityArg,
      opts: optsArg,
    });
    if (response.worldCreated) {
      physicsWorld = new WorldProxyAPI();
      physicsWorldEnabled = true;
      resolvedTransportMode = response.transportMode;
      if (response.transportMode === 'SHARED_MEMORY' && response.buffer) {
        transformBuffer = new PhysicsTransformBuffer(physicsState.maxBodies, response.buffer);
      }
      // MESSAGE_BATCH: transformBuffer stays undefined until the first TRANSFORMS_PUSH arrives.
      addVisibilityChangeFn('pausePhysicsApiOnVisibilityChange', physicsVisibilityChangeHandler);
    } else {
      lerror(
        `Could not create physics world (WORKER_THREAD), gravity: ${JSON.stringify(gravity)}, opts: ${JSON.stringify(opts)}`
      );
    }
  }

  return physicsWorld;
};

export const deletePhysicsWorld = async () => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting it.'
  );
  let worldDeleted = false;
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteWorld();
    worldDeleted = Boolean(response?.worldDeleted);
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<DeleteWorldResponse>({
      type: PhysicsProtocolType.DELETE_WORLD,
    });
    worldDeleted = Boolean(response.worldDeleted);
  }

  if (worldDeleted) {
    // Reset
    physicsWorldEnabled = false;
    physicsWorld = { step: () => {} } as unknown as WorldAPI;
  } else {
    lerror('Could not delete physics world.');
  }
};

export const takePhysicsSnapshot = async () => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before taking a snapshot.'
  );
  let snapshot;
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    snapshot = engAPI?.takeSnapshot();
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    // @TODO: we probably also need to save the userData for the rigid bodies and colliders (separate object/map).
    const response = await messageWorkerAsync<TakeSnapshotResponse>({
      type: PhysicsProtocolType.TAKE_SNAPSHOT,
    });
    snapshot = response.snapshot;
  }
  return snapshot;
};

export const restorePhysicsSnapshot = async (snapshot: Uint8Array) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before restoring a snapshot.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.restoreSnapshot(snapshot);
    if (response) physicsWorld = response;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    // @TODO: we maybe need check all the rigidBodies and colliders
    // and recreate all the maps here (maybe the new bodies and colliders can come in the response if we also send the next running ids).
    // The problem is the userData. The snapshots do not have that data since the userData is on the rigidBodyAPI and colliderAPI.
    const response = await messageWorkerAsync<RestoreSnapshotResponse>({
      type: PhysicsProtocolType.RESTORE_SNAPSHOT,
      snapshot,
    });
    if (response.worldCreated) physicsWorld = new WorldProxyAPI();
  }
  return physicsWorld;
};

/** Create a rigid body (async). */
export const createRigidBody = async (params: RigidBodyParams) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a rigid body.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const rbAPI = existsOrThrow(
      engAPI?.createRigidBody(params),
      `Could not create a rigid body ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    rigidBodies.set(rbAPI.id, rbAPI);
    return rbAPI;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const res = await messageWorkerAsync<CreateRigidBodyResponse>({
      type: PhysicsProtocolType.CREATE_RIGID_BODY,
      params,
    });
    const rbAPI = new RigidBodyProxyAPI(res.id, res.slot, params.userData) as RigidBodyAPI;
    rigidBodies.set(res.id, rbAPI);
    return rbAPI;
  }
  // Should not get here..
  throw new Error(
    `Could not create rigid bodies (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Create a rigid body (sync). Only for main thread mode. */
export const createRigidBodySync = (params: RigidBodyParams) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a rigid body.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const rbAPI = existsOrThrow(
      engAPI?.createRigidBody(params),
      `Could not create a rigid body ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    rigidBodies.set(rbAPI.id, rbAPI);
    return rbAPI;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error('Cannot use createRigidBodySync in worker mode. Use createRigidBody instead.');
  }
  // Should not get here..
  throw new Error(
    `Could not create rigid bodies (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Create multiple rigid bodies at once (async). */
export const createRigidBodies = async (params: RigidBodyParams[]) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a rigid body.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    return existsOrThrow(
      engAPI?.createRigidBodies(params),
      `Could not create a rigid bodies ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const res = await messageWorkerAsync<CreateRigidBodiesResponse>({
      type: PhysicsProtocolType.CREATE_RIGID_BODIES,
      params,
    });
    existsOrThrow(
      res.ids.length,
      `Could not create a rigid bodies ("WORKER_THREAD"). Params: ${JSON.stringify(params)}`
    );
    const rbAPIs = [];
    for (let i = 0; i < res.ids.length; i++) {
      const id = res.ids[i];
      const rbAPI = new RigidBodyProxyAPI(id, res.slots[i], params[i].userData);
      rbAPIs.push(rbAPI);
      rigidBodies.set(id, rbAPI);
    }
    return rbAPIs;
  }
  // Should not get here..
  throw new Error(
    `Could not create rigid bodies (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Create multiple rigid bodies at once (sync). Only for main thread mode. */
export const createRigidBodiesSync = (params: RigidBodyParams[]) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a rigid body.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    return existsOrThrow(
      engAPI?.createRigidBodies(params),
      `Could not create a rigid bodies ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error(
      'Cannot use createRigidBodiesSync in worker mode. Use createRigidBodies instead.'
    );
  }
  // Should not get here..
  throw new Error(
    `Could not create rigid bodies (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Deletes a rigid body (and all child colliders). Returns the id of the deleted rigidBodyAPI. */
export const deleteRigidBody = async (id: number) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting a rigid body.'
  );
  let deletedId: number | undefined = undefined;
  let deletedColliderIds: number[] = [];
  let deletedJointIds: number[] = [];
  if (rigidBodies.has(id)) rigidBodies.delete(id);
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteRigidBody(id);
    deletedId = response?.id;
    deletedColliderIds = response?.colliderIds || [];
    deletedJointIds = response?.jointIds || [];
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<DeleteRigidBodyResponse>({
      type: PhysicsProtocolType.DELETE_RIGID_BODY,
      id,
    });
    deletedId = response?.id;
    deletedColliderIds = response?.colliderIds || [];
    deletedJointIds = response?.jointIds || [];
  }
  if (deletedId !== id) {
    throw new Error(
      `Could not delete a rigid body, the returned id (${deletedId}) did not match the id: ${id}.`
    );
  }
  // Delete all possible colliderAPIs that are children of the rigid body
  for (let i = 0; i < deletedColliderIds.length; i++) {
    const collId = deletedColliderIds[i];
    if (colliders.has(collId)) colliders.delete(collId);
    cleanupWorkerColliderEventFns(collId);
  }
  // Delete all possible jointAPIs attached to the rigid body
  for (let i = 0; i < deletedJointIds.length; i++) {
    joints.delete(deletedJointIds[i]);
  }

  return deletedId;
};

/** Deletes a rigid body (and all child colliders). Returns the id of the deleted rigidBodyAPI (sync). Only for main thread mode. */
export const deleteRigidBodySync = (id: number) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting a rigid body.'
  );
  let deletedId: number | undefined = undefined;
  let deletedColliderIds: number[] = [];
  let deletedJointIds: number[] = [];
  if (rigidBodies.has(id)) rigidBodies.delete(id);
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteRigidBody(id);
    deletedId = response?.id;
    deletedColliderIds = response?.colliderIds || [];
    deletedJointIds = response?.jointIds || [];
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error('Cannot use deleteRigidBodySync in worker mode. Use deleteRigidBody instead.');
  }
  if (deletedId !== id) {
    throw new Error(
      `Could not delete a rigid body, the returned id (${deletedId}) did not match the id: ${id}.`
    );
  }
  // Delete all possible colliderAPIs that are children of the rigid body
  for (let i = 0; i < deletedColliderIds.length; i++) {
    const collId = deletedColliderIds[i];
    if (colliders.has(collId)) colliders.delete(collId);
    cleanupWorkerColliderEventFns(collId);
  }
  // Delete all possible jointAPIs attached to the rigid body
  for (let i = 0; i < deletedJointIds.length; i++) {
    joints.delete(deletedJointIds[i]);
  }

  return deletedId;
};

/** Deletes multiple rigid bodies (and all child colliders). Returns the ids of the deleted rigidBodyAPIs. */
export const deleteRigidBodies = async (ids: number[]) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting rigid bodies.'
  );
  if (!ids.length) return [];
  let deletedIds: number[] | undefined = undefined;
  let deletedColliderIds: number[] = [];
  let deletedJointIds: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (rigidBodies.has(ids[i])) rigidBodies.delete(ids[i]);
  }
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteRigidBodies(ids);
    deletedIds = response?.ids;
    deletedColliderIds = response?.colliderIds || [];
    deletedJointIds = response?.jointIds || [];
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<DeleteRigidBodiesResponse>({
      type: PhysicsProtocolType.DELETE_RIGID_BODIES,
      ids,
    });
    deletedIds = response?.ids;
    deletedColliderIds = response?.colliderIds || [];
    deletedJointIds = response?.jointIds || [];
  }
  if (deletedIds === undefined) {
    throw new Error(
      `Could not delete rigid bodies, the returned ids was undefined for ids: ${ids.join(', ')}.`
    );
  }
  for (let i = 0; i < ids.length; i++) {
    if (deletedIds[i] !== ids[i]) {
      lwarn(
        `Could not delete all rigid bodies, the returned id (${deletedIds[i]}) did not match the id: ${ids[i]}.`
      );
    }
  }
  // Delete all possible colliderAPIs that are children of the rigid body
  for (let i = 0; i < deletedColliderIds.length; i++) {
    const collId = deletedColliderIds[i];
    if (colliders.has(collId)) colliders.delete(collId);
    cleanupWorkerColliderEventFns(collId);
  }
  // Delete all possible jointAPIs attached to the rigid bodies
  for (let i = 0; i < deletedJointIds.length; i++) {
    joints.delete(deletedJointIds[i]);
  }

  return deletedIds;
};

/** Deletes multiple rigid bodies (and all child colliders). Returns the ids of the deleted rigidBodyAPIs (sync). Only for main thread mode. */
export const deleteRigidBodiesSync = (ids: number[]) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting rigid bodies.'
  );
  if (!ids.length) return [];
  let deletedIds: number[] | undefined = undefined;
  let deletedColliderIds: number[] = [];
  let deletedJointIds: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (rigidBodies.has(ids[i])) rigidBodies.delete(ids[i]);
  }
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteRigidBodies(ids);
    deletedIds = response?.ids;
    deletedColliderIds = response?.colliderIds || [];
    deletedJointIds = response?.jointIds || [];
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error(
      'Cannot use deleteRigidBodiesSync in worker mode. Use deleteRigidBodies instead.'
    );
  }
  if (deletedIds === undefined) {
    throw new Error(
      `Could not delete rigid bodies, the returned ids was undefined for ids: ${ids.join(', ')}.`
    );
  }
  for (let i = 0; i < ids.length; i++) {
    if (deletedIds[i] !== ids[i]) {
      lwarn(
        `Could not delete all rigid bodies, the returned id (${deletedIds[i]}) did not match the id: ${ids[i]}.`
      );
    }
  }
  // Delete all possible colliderAPIs that are children of the rigid body
  for (let i = 0; i < deletedColliderIds.length; i++) {
    const collId = deletedColliderIds[i];
    if (colliders.has(collId)) colliders.delete(collId);
    cleanupWorkerColliderEventFns(collId);
  }
  // Delete all possible jointAPIs attached to the rigid bodies
  for (let i = 0; i < deletedJointIds.length; i++) {
    joints.delete(deletedJointIds[i]);
  }

  return deletedIds;
};

/** Strips collisionEventFn/contactForceEventFn from a ColliderParams before it crosses
 * the postMessage boundary (functions can't be structured-cloned — this is what would
 * otherwise throw DataCloneError), replacing them with the boolean flags EngineRapier.ts
 * uses to still set up the right Rapier ActiveEvents on the worker side. Returns the
 * original object unchanged when there's nothing to strip. */
const toWireColliderParams = (params: ColliderParams): ColliderParams => {
  if (!params.collisionEventFn && !params.contactForceEventFn) return params;
  const { collisionEventFn, contactForceEventFn, ...rest } = params;
  return {
    ...rest,
    hasCollisionEventFn: Boolean(collisionEventFn) || rest.hasCollisionEventFn,
    hasContactForceEventFn: Boolean(contactForceEventFn) || rest.hasContactForceEventFn,
  } as ColliderParams;
};

/** WORKER_THREAD only: registers a collider's real callbacks (once its id is known, i.e.
 * after the CREATE_COLLIDER(S) response resolves) so the EVENTS_PUSH handler can invoke
 * them later. No-op for a collider with neither callback. */
const registerWorkerColliderEventFns = (id: number, params: ColliderParams) => {
  if (params.collisionEventFn) {
    const fns = workerCollisionEventFns.get(id) || [];
    fns.push(params.collisionEventFn);
    workerCollisionEventFns.set(id, fns);
  }
  if (params.contactForceEventFn) {
    const fns = workerContactForceEventFns.get(id) || [];
    fns.push(params.contactForceEventFn);
    workerContactForceEventFns.set(id, fns);
  }
};

/** Removes a collider id's registered WORKER_THREAD event callbacks, if any. Harmless
 * no-op in MAIN_THREAD mode, where these registries are never populated. */
const cleanupWorkerColliderEventFns = (id: number) => {
  workerCollisionEventFns.delete(id);
  workerContactForceEventFns.delete(id);
};

/** Create a collider. */
export const createCollider = async (params: ColliderParams, parentId?: number) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a collider.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const coll = existsOrThrow(
      engAPI?.createCollider(params, parentId),
      `Could not create a collider ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    colliders.set(coll.id, coll);
    return coll;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const res = await messageWorkerAsync<CreateColliderResponse>({
      type: PhysicsProtocolType.CREATE_COLLIDER,
      params: toWireColliderParams(params),
      parentId,
    });
    const collProxy = new ColliderProxyAPI(res.id, res.parentId, params.userData) as ColliderAPI;
    colliders.set(res.id, collProxy); // register locally
    registerWorkerColliderEventFns(res.id, params);
    return collProxy;
  }
  // Should not get here..
  throw new Error(
    `Could not create a collider (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Create a collider (sync). Only for main thread mode. */
export const createColliderSync = (params: ColliderParams, parentId?: number) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a collider.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const coll = existsOrThrow(
      engAPI?.createCollider(params, parentId),
      `Could not create a collider ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    colliders.set(coll.id, coll);
    return coll;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error('Cannot use createColliderSync in worker mode. Use createCollider instead.');
  }
  // Should not get here..
  throw new Error(
    `Could not create a collider (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Create multiple colliders at once. */
export const createColliders = async (params: ColliderParams[]) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a collider.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    return existsOrThrow(
      engAPI?.createColliders(params),
      `Could not create colliders ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const collIds = (
      await messageWorkerAsync<CreateCollidersResponse>({
        type: PhysicsProtocolType.CREATE_COLLIDERS,
        params: params.map(toWireColliderParams),
      })
    ).ids;
    existsOrThrow(
      collIds.length,
      `Could not create colliders ("WORKER_THREAD"). Params: ${JSON.stringify(params)}`
    );
    const collAPIs = [];
    for (let i = 0; i < collIds.length; i++) {
      const id = collIds[i];
      const collAPI = new ColliderProxyAPI(id, params[i].parentId, params[i].userData);
      collAPIs.push(collAPI);
      colliders.set(id, collAPI);
      registerWorkerColliderEventFns(id, params[i]);
    }
    return collAPIs;
  }
  // Should not get here..
  throw new Error(
    `Could not create colliders (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Create multiple colliders at once (sync). Only for main thread mode. */
export const createCollidersSync = (params: ColliderParams[]) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a collider.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    return existsOrThrow(
      engAPI?.createColliders(params),
      `Could not create colliders ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error('Cannot use createCollidersSync in worker mode. Use createColliders instead.');
  }
  // Should not get here..
  throw new Error(
    `Could not create colliders (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Deletes a collider. Returns the id of the deleted colliderAPI. */
export const deleteCollider = async (id: number, wakeUp?: boolean) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting a collider.'
  );
  let deletedId: number | undefined = undefined;
  if (colliders.has(id)) colliders.delete(id);
  cleanupWorkerColliderEventFns(id);
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteCollider(id, wakeUp);
    deletedId = response?.id;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<DeleteColliderResponse>({
      type: PhysicsProtocolType.DELETE_COLLIDER,
      id,
      wakeUp: wakeUp || false,
    });
    deletedId = response?.id;
  }
  if (deletedId !== id) {
    throw new Error(
      `Could not delete a collider, the returned id (${deletedId}) did not match the id: ${id}.`
    );
  }
  return deletedId;
};

/** Deletes a collider. Returns the id of the deleted colliderAPI (sync). Only for main thread mode. */
export const deleteColliderSync = (id: number, wakeUp?: boolean) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting a collider.'
  );
  let deletedId: number | undefined = undefined;
  if (colliders.has(id)) colliders.delete(id);
  cleanupWorkerColliderEventFns(id);
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteCollider(id, wakeUp);
    deletedId = response?.id;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error('Cannot use deleteColliderSync in worker mode. Use deleteCollider instead.');
  }
  if (deletedId !== id) {
    throw new Error(
      `Could not delete a collider, the returned id (${deletedId}) did not match the id: ${id}.`
    );
  }
  return deletedId;
};

/** Deletes multiple colliders. Returns the ids of the deleted colliderAPIs. */
export const deleteColliders = async (ids: number[], wakeUps?: boolean[]) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting colliders.'
  );
  if (!ids.length) return [];
  let deletedIds: number[] | undefined = undefined;
  for (let i = 0; i < ids.length; i++) {
    if (colliders.has(ids[i])) colliders.delete(ids[i]);
    cleanupWorkerColliderEventFns(ids[i]);
  }
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteColliders(ids, wakeUps);
    deletedIds = response?.ids;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<DeleteCollidersResponse>({
      type: PhysicsProtocolType.DELETE_COLLIDERS,
      ids,
      wakeUps: ids.map((_, index) => Boolean(wakeUps && wakeUps[index])),
    });
    deletedIds = response?.ids;
  }
  if (deletedIds === undefined) {
    throw new Error(
      `Could not delete rigid bodies, the returned ids was undefined for ids: ${ids.join(', ')}.`
    );
  }
  for (let i = 0; i < ids.length; i++) {
    if (deletedIds[i] !== ids[i]) {
      lwarn(
        `Could not delete all colliders, the returned id (${deletedIds[i]}) did not match the id: ${ids[i]}.`
      );
    }
  }
  return deletedIds;
};

/** Deletes multiple colliders. Returns the ids of the deleted colliderAPIs (sync). Only for main thread mode. */
export const deleteCollidersSync = (ids: number[], wakeUps?: boolean[]) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting colliders.'
  );
  if (!ids.length) return [];
  let deletedIds: number[] | undefined = undefined;
  for (let i = 0; i < ids.length; i++) {
    if (colliders.has(ids[i])) colliders.delete(ids[i]);
    cleanupWorkerColliderEventFns(ids[i]);
  }
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteColliders(ids, wakeUps);
    deletedIds = response?.ids;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error('Cannot use deleteCollidersSync in worker mode. Use deleteColliders instead.');
  }
  if (deletedIds === undefined) {
    throw new Error(
      `Could not delete rigid bodies, the returned ids was undefined for ids: ${ids.join(', ')}.`
    );
  }
  for (let i = 0; i < ids.length; i++) {
    if (deletedIds[i] !== ids[i]) {
      lwarn(
        `Could not delete all colliders, the returned id (${deletedIds[i]}) did not match the id: ${ids[i]}.`
      );
    }
  }
  return deletedIds;
};

/** Create an impulse joint connecting two rigid bodies (by id). */
export const createJoint = async (params: JointParams) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a joint.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const joint = existsOrThrow(
      engAPI?.createJoint(params),
      `Could not create a joint ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    joints.set(joint.id, joint);
    return joint;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const res = await messageWorkerAsync<CreateJointResponse>({
      type: PhysicsProtocolType.CREATE_JOINT,
      params,
    });
    const jointProxy = new JointProxyAPI(res.id, params.userData) as JointAPI;
    joints.set(res.id, jointProxy);
    return jointProxy;
  }
  // Should not get here..
  throw new Error(
    `Could not create a joint (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Create an impulse joint (sync). Only for main thread mode. */
export const createJointSync = (params: JointParams) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a joint.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const joint = existsOrThrow(
      engAPI?.createJoint(params),
      `Could not create a joint ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    joints.set(joint.id, joint);
    return joint;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error('Cannot use createJointSync in worker mode. Use createJoint instead.');
  }
  // Should not get here..
  throw new Error(
    `Could not create a joint (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Deletes a joint. Returns the id of the deleted jointAPI. */
export const deleteJoint = async (id: number, wakeUp?: boolean) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting a joint.'
  );
  let deletedId: number | undefined = undefined;
  if (joints.has(id)) joints.delete(id);
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteJoint(id, wakeUp);
    deletedId = response?.id;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<DeleteJointResponse>({
      type: PhysicsProtocolType.DELETE_JOINT,
      id,
      wakeUp,
    });
    deletedId = response?.id;
  }
  if (deletedId !== id) {
    throw new Error(
      `Could not delete a joint, the returned id (${deletedId}) did not match the id: ${id}.`
    );
  }
  return deletedId;
};

/** Deletes a joint. Returns the id of the deleted jointAPI (sync). Only for main thread mode. */
export const deleteJointSync = (id: number, wakeUp?: boolean) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting a joint.'
  );
  let deletedId: number | undefined = undefined;
  if (joints.has(id)) joints.delete(id);
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteJoint(id, wakeUp);
    deletedId = response?.id;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    throw new Error('Cannot use deleteJointSync in worker mode. Use deleteJoint instead.');
  }
  if (deletedId !== id) {
    throw new Error(
      `Could not delete a joint, the returned id (${deletedId}) did not match the id: ${id}.`
    );
  }
  return deletedId;
};

export const getRigidBody = (id: number) => rigidBodies.get(id);
export const getCollider = (id: number) => colliders.get(id);
export const getJoint = (id: number) => joints.get(id);
/** All currently tracked rigid bodies, keyed by their physics id (both thread modes). */
export const getAllRigidBodyEntries = (): IterableIterator<[number, RigidBodyAPI]> =>
  rigidBodies.entries();
/** All currently tracked colliders, keyed by their physics id (both thread modes). */
export const getAllColliderEntries = (): IterableIterator<[number, ColliderAPI]> =>
  colliders.entries();
/** All currently tracked joints, keyed by their physics id (both thread modes). */
export const getAllJointEntries = (): IterableIterator<[number, JointAPI]> => joints.entries();
/** Which hot-path transform transport the current world resolved to (WORKER_THREAD only). Undefined before a world is created or in MAIN_THREAD mode. */
export const getResolvedTransportMode = () => resolvedTransportMode;

/**
 * Declares which rigid bodies/colliders the worker should mirror live state for, so the
 * debug wireframes can be colored by sleep/kinematic/enabled/sensor state without an RPC
 * per object per frame (docs/plans/_DONE_p025_debug-drawing-in-physics-api.md).
 *
 * This is a full replacement of the tracked set, not a delta, and a body's/collider's
 * index in the arrays passed here is its slot in the buffer readable via
 * getPhysicsDebugStateBuffer(). Calling it with two empty arrays turns tracking off: the
 * worker then writes nothing and pushes nothing per step.
 *
 * No-op on MAIN_THREAD, where the *Sync state getters are already free.
 */
export const setPhysicsDebugStateTracking = async (
  rigidBodyIds: number[],
  colliderIds: number[]
) => {
  if (physicsState.workerTarget !== 'WORKER_THREAD') return;
  const response = await messageWorkerAsync<SetDebugStateTrackingResponse>({
    type: PhysicsProtocolType.SET_DEBUG_STATE_TRACKING,
    rigidBodyIds,
    colliderIds,
  });
  if (response.buffer) {
    // SHARED_MEMORY, first enable: wrap the worker's SAB once and read it forever after.
    debugStateBuffer = new PhysicsDebugStateBuffer(physicsState.maxBodies, response.buffer);
  }
};

/** The live debug-state buffer, or undefined while tracking has never been enabled (or
 * MESSAGE_BATCH mode hasn't received its first push yet). WORKER_THREAD only. */
export const getPhysicsDebugStateBuffer = () => debugStateBuffer;

/** World, RigidBody, Collider, and Joint API classes -----[ START ]----- */

class WorldProxyAPI implements WorldAPI {
  restoringWorld: boolean;
  // Local cache for sync getters (updated via worker messages or setters)
  private _cache = {
    gravity: physicsState.gravity,
    timestep: physicsState.timestepRatio,
    lengthUnit: 1.0,
    solverIters: physicsState.solverIterations,
    pgsIters: physicsState.internalPgsIterations,
    ccdSubsteps: 1, // TODO: add this as physicsState value, CONFIG value, and physics debugger tab value
  };

  constructor() {
    this.restoringWorld = false;
  }

  // --- Gravity ---
  async getGravity(): Promise<PhysVector> {
    const res = await messageWorkerAsync<WorldGravityResponse>({
      type: PhysicsProtocolType.WORLD_GET_GRAVITY,
    });
    this._cache.gravity = res.gravity;
    return res.gravity;
  }

  getGravitySync(): PhysVector {
    return this._cache.gravity;
  }

  setGravity(gravity: PhysVector): void {
    this._cache.gravity = gravity;
    messageWorker({
      type: PhysicsProtocolType.WORLD_SET_GRAVITY,
      gravity,
      isOneWay: true,
    });
  }

  // --- Lifecycle & Snapshots ---
  free(): void {
    messageWorker({ type: PhysicsProtocolType.WORLD_FREE });
  }

  async takeSnapshot(): Promise<Uint8Array | undefined> {
    return await takePhysicsSnapshot();
  }

  takeSnapshotSync(): Uint8Array | undefined {
    throw new Error(
      'takeSnapshotSync is not supported in Worker thread mode. Use takeSnapshot(data).'
    );
  }

  async restoreSnapshot(data: Uint8Array): Promise<WorldAPI> {
    return restorePhysicsSnapshot(data);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  restoreSnapshotSync(_data: Uint8Array): WorldAPI {
    throw new Error(
      'restoreSnapshotSync is not supported in Worker thread mode. Use restoreSnapshot(data).'
    );
  }

  propagateModifiedBodyPositionsToColliders(): void {
    messageWorker({ type: PhysicsProtocolType.WORLD_PROPAGATE_POSITIONS });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  step(_eventQueue?: unknown, _hooks?: unknown): void {
    throw new Error('step is not yet implemented in Worker thread mode.');
  }

  debugRender(): { vertices: Float32Array; colors: Float32Array } {
    throw new Error('debugRender is not yet implemented in Worker thread mode.');
  }

  // --- Parameters (Timestep, Units, Solver) ---
  async getTimestep(): Promise<number> {
    const res = await messageWorkerAsync<WorldTimestepResponse>({
      type: PhysicsProtocolType.WORLD_GET_TIMESTEP,
    });
    this._cache.timestep = res.dt;
    return res.dt;
  }
  getTimestepSync(): number {
    return this._cache.timestep;
  }
  setTimestep(dt: number): void {
    this._cache.timestep = dt;
    messageWorker({ type: PhysicsProtocolType.WORLD_SET_TIMESTEP, dt });
  }

  async getLengthUnit(): Promise<number> {
    const res = await messageWorkerAsync<WorldLengthUnitResponse>({
      type: PhysicsProtocolType.WORLD_GET_LENGTH_UNIT,
    });
    this._cache.lengthUnit = res.unitsPerMeter;
    return res.unitsPerMeter;
  }
  getLengthUnitSync(): number {
    return this._cache.lengthUnit;
  }
  setLengthUnit(unitsPerMeter: number): void {
    this._cache.lengthUnit = unitsPerMeter;
    messageWorker({ type: PhysicsProtocolType.WORLD_SET_LENGTH_UNIT, unitsPerMeter });
  }

  async getNumSolverIterations(): Promise<number> {
    const res = await messageWorkerAsync<WorldNumSolverIterationsResponse>({
      type: PhysicsProtocolType.WORLD_GET_SOLVER_ITERS,
    });
    this._cache.solverIters = res.solverIterations;
    return res.solverIterations;
  }
  getNumSolverIterationsSync(): number {
    return this._cache.solverIters;
  }
  setNumSolverIterations(niter: number): void {
    this._cache.solverIters = niter;
    messageWorker({ type: PhysicsProtocolType.WORLD_SET_SOLVER_ITERS, niter });
  }

  async getNumInternalPgsIterations(): Promise<number> {
    const res = await messageWorkerAsync<WorldNumInternalPgsIterationsResponse>({
      type: PhysicsProtocolType.WORLD_GET_PGS_ITERS,
    });
    this._cache.pgsIters = res.internalPgsIterations;
    return res.internalPgsIterations;
  }
  getNumInternalPgsIterationsSync(): number {
    return this._cache.pgsIters;
  }
  setNumInternalPgsIterations(niter: number): void {
    this._cache.pgsIters = niter;
    messageWorker({ type: PhysicsProtocolType.WORLD_SET_PGS_ITERS, niter });
  }

  async getMaxCcdSubsteps(): Promise<number> {
    const res = await messageWorkerAsync<{ substeps: number }>({
      type: PhysicsProtocolType.WORLD_GET_CCD_SUBSTEPS,
    });
    this._cache.ccdSubsteps = res.substeps;
    return res.substeps;
  }
  getMaxCcdSubstepsSync(): number {
    return this._cache.ccdSubsteps;
  }
  setMaxCcdSubstepsSync(substeps: number): void {
    this._cache.ccdSubsteps = substeps;
    messageWorker({ type: PhysicsProtocolType.WORLD_SET_CCD_SUBSTEPS, substeps });
  }

  // --- Factories ---
  async createRigidBody(params: RigidBodyParams): Promise<RigidBodyAPI> {
    return await createRigidBody(params);
  }

  createRigidBodySync(params: RigidBodyParams): RigidBodyAPI {
    if (physicsState.workerTarget === 'MAIN_THREAD') {
      return existsOrThrow(
        engAPI?.createRigidBody(params),
        `Could not create a rigid body ("MAIN_THREAD"). Params: ${JSON.stringify(params)}. Has engineAPI: ${Boolean(engAPI)}`
      );
    } else if (physicsState.workerTarget === 'WORKER_THREAD') {
      const msg =
        'Synchronous creation is not supported in Worker thread mode. Use createRigidBody(params).';
      lerror(msg);
      throw new Error(msg);
    }
    // Should not get here
    const msg = `Unknown physicsState.workerTarget: "${physicsState.workerTarget}".`;
    lerror(msg);
    throw new Error(msg);
  }

  async createCollider(params: ColliderParams, parentId?: number): Promise<ColliderAPI> {
    return await createCollider(params, parentId);
  }

  createColliderSync(params: ColliderParams, parentId?: number): ColliderAPI {
    if (physicsState.workerTarget === 'MAIN_THREAD') {
      return existsOrThrow(
        engAPI?.createCollider(params, parentId),
        `Could not create a collider ("MAIN_THREAD"). Params: ${JSON.stringify(params)}. Has engineAPI: ${Boolean(engAPI)}`
      );
    } else if (physicsState.workerTarget === 'WORKER_THREAD') {
      const msg =
        'Synchronous creation is not supported in Worker thread mode. Use createCollider(params, parent?).';
      lerror(msg);
      throw new Error(msg);
    }
    // Should not get here
    const msg = `Unknown physicsState.workerTarget: "${physicsState.workerTarget}".`;
    lerror(msg);
    throw new Error(msg);
  }

  async createJoint(params: JointParams): Promise<JointAPI> {
    return await createJoint(params);
  }

  createJointSync(params: JointParams): JointAPI {
    if (physicsState.workerTarget === 'MAIN_THREAD') {
      return existsOrThrow(
        engAPI?.createJoint(params),
        `Could not create a joint ("MAIN_THREAD"). Params: ${JSON.stringify(params)}. Has engineAPI: ${Boolean(engAPI)}`
      );
    } else if (physicsState.workerTarget === 'WORKER_THREAD') {
      const msg =
        'Synchronous creation is not supported in Worker thread mode. Use createJoint(params).';
      lerror(msg);
      throw new Error(msg);
    }
    // Should not get here
    const msg = `Unknown physicsState.workerTarget: "${physicsState.workerTarget}".`;
    lerror(msg);
    throw new Error(msg);
  }

  // --- Retrieval ---
  /** Returns the main thread rigid body registry rigidBodyAPI promise.
   * It is suggested to use getRigidBodySync(id) method instead of this
   * as it is synchronous and faster.
   */
  async getRigidBody(id: number): Promise<RigidBodyAPI | undefined> {
    // Checks a local registry Map<number, RigidBodyProxy>
    return rigidBodies.get(id);
  }

  /** Returns the main thread rigid body registry rigidBodyAPI. */
  getRigidBodySync(id: number): RigidBodyAPI | undefined {
    return rigidBodies.get(id);
  }

  /** Returns the main thread collider registry colliderAPI as promise.
   * It is suggested to use getColliderSync(id) method instead of this
   * as it is synchronous and faster.
   */
  async getCollider(id: number): Promise<ColliderAPI | undefined> {
    return colliders.get(id);
  }

  /** Returns the main thread collider registry colliderAPI. */
  getColliderSync(id: number): ColliderAPI | undefined {
    return colliders.get(id);
  }

  /** Returns the main thread joint registry jointAPI as promise.
   * It is suggested to use getJointSync(id) method instead of this
   * as it is synchronous and faster.
   */
  async getJoint(id: number): Promise<JointAPI | undefined> {
    return joints.get(id);
  }

  /** Returns the main thread joint registry jointAPI. */
  getJointSync(id: number): JointAPI | undefined {
    return joints.get(id);
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

  removeJoint(jointOrId: JointAPI | number, wakeUp: boolean): void {
    const id = typeof jointOrId === 'number' ? jointOrId : jointOrId.id;
    deleteJoint(id, wakeUp);
  }

  // --- Queries (Raycasting) ---
  async castRay(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
  ): Promise<RayColliderHitAPI | null> {
    const response = (
      await messageWorkerAsync<WorldCastRayResponse>({
        type: PhysicsProtocolType.WORLD_CAST_RAY,
        ray,
        maxToi,
        solid,
        filterFlags,
        filterGroups,
        filterExcludeCollider:
          typeof filterExcludeCollider === 'number'
            ? filterExcludeCollider
            : filterExcludeCollider?.id,
        filterExcludeRigidBody:
          typeof filterExcludeRigidBody === 'number'
            ? filterExcludeRigidBody
            : filterExcludeRigidBody?.id,
      })
    ).hit;
    if (!response) return null;
    const coll = colliders.get(response.collider);
    if (!coll) return null;
    return { ...response, collider: coll };
  }

  castRaySync(): RayColliderHitAPI | null {
    throw new Error('Raycasting must be async in Worker mode.');
  }

  async castShape(
    shapePos: PhysVector,
    shapeRot: PhysRotation,
    shapeVel: PhysVector,
    shape: ShapeParams,
    targetDistance: number,
    maxToi: number,
    stopAtPenetration: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number
  ): Promise<ShapeCastHitAPI | null> {
    const response = (
      await messageWorkerAsync<WorldCastShapeResponse>({
        type: PhysicsProtocolType.WORLD_CAST_SHAPE,
        shapePos,
        shapeRot,
        shapeVel,
        shape,
        targetDistance,
        maxToi,
        stopAtPenetration,
        filterFlags,
        filterGroups,
        filterExcludeCollider:
          typeof filterExcludeCollider === 'number'
            ? filterExcludeCollider
            : filterExcludeCollider?.id,
        filterExcludeRigidBody:
          typeof filterExcludeRigidBody === 'number'
            ? filterExcludeRigidBody
            : filterExcludeRigidBody?.id,
      })
    ).hit;
    if (!response) return null;
    const coll = colliders.get(response.collider);
    if (!coll) return null;
    return { ...response, collider: coll };
  }

  castShapeSync(): ShapeCastHitAPI | null {
    throw new Error('Shape casting must be async in Worker mode.');
  }

  async castRayAndGetNormal(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI
  ): Promise<RayColliderIntersectionAPI | null> {
    return await messageWorkerAsync<RayColliderIntersectionAPI | null>({
      type: PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL,
      ray,
      maxToi,
      solid,
      filterFlags,
      filterGroups,
    });
  }

  castRayAndGetNormalSync(): RayColliderIntersectionAPI | null {
    throw new Error('Raycasting must be async in Worker mode.');
  }

  // --- Interaction Pairs ---
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
    const filtExclColl = getCollOrRigidId(filterExcludeCollider);
    const filtExclRB = getCollOrRigidId(filterExcludeRigidBody);
    const intersections = (
      await messageWorkerAsync<WorldIntersectionsWithRayResponse>({
        type: PhysicsProtocolType.WORLD_INTERSECTIONS_WITH_RAY,
        ray,
        maxToi,
        solid,
        filterFlags,
        filterGroups,
        filterExcludeCollider: filtExclColl,
        filterExcludeRigidBody: filtExclRB,
      })
    ).intersections;
    for (let i = 0; i < intersections.length; i++) {
      const intersectTransfer = intersections[i];
      const collider = colliders.get(intersectTransfer.collider);
      if (collider) callback({ ...intersectTransfer, collider });
    }
  }

  intersectionsWithRaySync(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ray: PhysRay,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _maxToi: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _solid: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _callback: (intersect: RayColliderIntersectionAPI) => boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _filterFlags?: QueryFilterFlags,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _filterGroups?: InteractionGroupsAPI,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _filterExcludeCollider?: ColliderAPI | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _filterExcludeRigidBody?: RigidBodyAPI | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _filterPredicate?: (collider: ColliderAPI) => boolean
  ): void {
    throw new Error('Raycasting must be async in Worker mode.');
  }

  async contactPairsWith(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): Promise<void> {
    const coll1Id = getCollOrRigidId(collider1);
    if (!coll1Id) return;
    const colliderIds = (
      await messageWorkerAsync<WorldContactPairsResponse>({
        type: PhysicsProtocolType.WORLD_CONTACT_PAIRS_WITH,
        colliderId: coll1Id,
      })
    ).colliderIds;
    for (let i = 0; i < colliderIds.length; i++) {
      const coll2 = colliders.get(colliderIds[i]);
      if (coll2) f(coll2);
    }
  }

  contactPairsWithSync(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _collider1: ColliderAPI | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _f: (collider2: ColliderAPI) => void
  ): void {
    throw new Error('Contact pairing must be async in Worker mode.');
  }

  async intersectionPairsWith(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): Promise<void> {
    const coll1Id = getCollOrRigidId(collider1);
    if (coll1Id === undefined) return;
    const colliderIds = (
      await messageWorkerAsync<WorldIntersectionPairsWithResponse>({
        type: PhysicsProtocolType.WORLD_INTERSECTION_PAIRS_WITH,
        colliderId: coll1Id,
      })
    ).colliderIds;
    for (let i = 0; i < colliderIds.length; i++) {
      const coll2 = colliders.get(colliderIds[i]);
      if (coll2) f(coll2);
    }
  }

  intersectionPairsWithSync(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _collider1: ColliderAPI | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _f: (collider2: ColliderAPI) => void
  ): void {
    throw new Error('Intersection pairing must be async in Worker mode.');
  }

  async intersectionPair(
    collider1: ColliderAPI | number,
    collider2: ColliderAPI | number
  ): Promise<boolean> {
    return (
      await messageWorkerAsync<WorldIntersectionPairResponse>({
        type: PhysicsProtocolType.WORLD_INTERSECTION_PAIR,
        colliderId1: typeof collider1 === 'number' ? collider1 : collider1.id,
        colliderId2: typeof collider2 === 'number' ? collider2 : collider2.id,
      })
    ).isIntersecting;
  }

  intersectionPairSync(): boolean {
    throw new Error('Intersection pairing must be async in Worker mode.');
  }
}

class RigidBodyProxyAPI implements RigidBodyWorkerEngine {
  uData: Record<string, unknown> = {};
  isBeingDeleted: boolean = false;
  // @CHORE: add isEnabled cache

  constructor(
    public id: number,
    private slot: number,
    userData?: Record<string, unknown>
  ) {
    if (userData) this.uData = userData;
  }

  // Hot path — reads straight from the shared/latest-pushed transform buffer by slot.
  // Returns zeroed defaults if no buffer has arrived yet (before the first step/push).
  get pos(): PhysVector {
    if (!transformBuffer || this.slot === -1) return { x: 0, y: 0, z: 0 };
    return transformBuffer.getPosition(this.slot);
  }
  get rot(): PhysRotation {
    if (!transformBuffer || this.slot === -1) return { x: 0, y: 0, z: 0, w: 0 };
    return transformBuffer.getRotation(this.slot);
  }
  get lvel(): PhysVector {
    if (!transformBuffer || this.slot === -1) return { x: 0, y: 0, z: 0 };
    return transformBuffer.getLinvel(this.slot);
  }
  get avel(): PhysVector {
    if (!transformBuffer || this.slot === -1) return { x: 0, y: 0, z: 0 };
    return transformBuffer.getAngvel(this.slot);
  }

  async getUserData(): Promise<Record<string, unknown>> {
    const fetchedUserData = (
      await messageWorkerAsync<RigidGetUserDataResponse>({
        type: PhysicsProtocolType.RIGID_GET_USERDATA,
        rigidBodyId: this.id,
      })
    ).userData;
    this.uData = fetchedUserData;
    return fetchedUserData;
  }
  getUserDataSync(): Record<string, unknown> {
    return this.uData;
  }

  setUserData(userData: Record<string, unknown>, addToExisting?: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_SET_USERDATA,
      rigidBodyId: this.id,
      userData,
      addToExisting,
      isOneWay: true,
    });
    if (addToExisting) {
      this.uData = { ...this.uData, ...userData };
    } else {
      this.uData = userData;
    }
  }

  async isValid(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsValidResponse>({
        type: PhysicsProtocolType.RIGID_IS_VALID,
        rigidBodyId: this.id,
      })
    ).isValid;
  }
  isValidSync(): boolean {
    throw new Error(
      'Checking the validity of a rigid body (isValid) cannot be synchronous in the worker mode.'
    );
  }

  lockTranslations(locked: boolean, wakeUp: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_LOCK_TRANSLATIONS,
      rigidBodyId: this.id,
      locked,
      wakeUp,
      isOneWay: true,
    });
  }

  lockRotations(locked: boolean, wakeUp: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_LOCK_ROTATIONS,
      rigidBodyId: this.id,
      locked,
      wakeUp,
      isOneWay: true,
    });
  }

  setEnabledTranslations(
    enableX: boolean,
    enableY: boolean,
    enableZ: boolean,
    wakeUp: boolean
  ): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ENABLED_TRANSLATIONS,
      rigidBodyId: this.id,
      enableX,
      enableY,
      enableZ,
      wakeUp,
      isOneWay: true,
    });
  }

  setEnabledRotations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ENABLED_ROTATIONS,
      rigidBodyId: this.id,
      enableX,
      enableY,
      enableZ,
      wakeUp,
      isOneWay: true,
    });
  }

  async dominanceGroup(): Promise<number> {
    return (
      await messageWorkerAsync<RigidDominanceGroupResponse>({
        type: PhysicsProtocolType.RIGID_DOMINANCE_GROUP,
        rigidBodyId: this.id,
      })
    ).dominanceGroup;
  }
  dominanceGroupSync(): number {
    throw new Error(
      'Getting the dominance group of a rigid body (dominanceGroup) cannot be synchronous in the worker mode.'
    );
  }

  setDominanceGroup(group: number): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_DOMINANCE_GROUP,
      rigidBodyId: this.id,
      group,
    });
  }

  async additionalSolverIterations(): Promise<number> {
    return (
      await messageWorkerAsync<RigidAdditionalSolverIterationsResponse>({
        type: PhysicsProtocolType.RIGID_ADDITIONAL_SOLVER_ITERATIONS,
        rigidBodyId: this.id,
      })
    ).additionalIterations;
  }
  additionalSolverIterationsSync(): number {
    throw new Error(
      'Checking the additional solver iteration of a rigid body (additionalSolverIterations) cannot be synchronous in the worker mode.'
    );
  }

  setAdditionalSolverIterations(iters: number): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ADDITIONAL_SOLVER_ITERATIONS,
      rigidBodyId: this.id,
      iters,
    });
  }

  enableCcd(enabled: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_ENABLE_CCD,
      rigidBodyId: this.id,
      enabled,
    });
  }

  setSoftCcdPrediction(distance: number): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_SOFT_CCD_PREDICTION,
      rigidBodyId: this.id,
      distance,
    });
  }

  async softCcdPrediction(): Promise<number> {
    return (
      await messageWorkerAsync<RigidSoftCcdPredictionResponse>({
        type: PhysicsProtocolType.RIGID_SOFT_CCD_PREDICTION,
        rigidBodyId: this.id,
      })
    ).softCcdPrediction;
  }
  softCcdPredictionSync(): number {
    throw new Error(
      'Checking the soft CCD prediction number of a rigid body (softCcdPrediction) cannot be synchronous in the worker mode.'
    );
  }

  translation(): PhysVector {
    return this.pos;
  }

  rotation(): PhysRotation {
    return this.rot;
  }

  async nextTranslation(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidNextTranslationResponse>({
        type: PhysicsProtocolType.RIGID_NEXT_TRANSLATION,
        rigidBodyId: this.id,
      })
    ).nextTranslation;
  }
  nextTranslationSync(): PhysVector {
    throw new Error(
      'Checking the next translation of a rigid body (nextTranslation) cannot be synchronous in the worker mode.'
    );
  }

  async nextRotation(): Promise<PhysRotation> {
    return (
      await messageWorkerAsync<RigidNextRotationResponse>({
        type: PhysicsProtocolType.RIGID_NEXT_ROTATION,
        rigidBodyId: this.id,
      })
    ).nextRotation;
  }
  nextRotationSync(): PhysRotation {
    throw new Error(
      'Checking the next rotation of a rigid body (nextRotation) cannot be synchronous in the worker mode.'
    );
  }

  setTranslation(tra: PhysVector, wakeUp: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_TRANSLATION,
      rigidBodyId: this.id,
      tra,
      wakeUp,
    });
  }

  setLinvel(vel: PhysVector, wakeUp: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_LINVEL,
      rigidBodyId: this.id,
      vel,
      wakeUp,
    });
  }

  async gravityScale(): Promise<number> {
    return (
      await messageWorkerAsync<RigidGravityScaleResponse>({
        type: PhysicsProtocolType.RIGID_GRAVITY_SCALE,
        rigidBodyId: this.id,
      })
    ).gravityScale;
  }
  gravityScaleSync(): number {
    throw new Error(
      'Checking the gravity scale of a rigid body (gravityScale) cannot be synchronous in the worker mode.'
    );
  }

  setGravityScale(factor: number, wakeUp: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_GRAVITY_SCALE,
      rigidBodyId: this.id,
      factor,
      wakeUp,
    });
  }

  setRotation(rot: PhysRotation, wakeUp: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ROTATION,
      rigidBodyId: this.id,
      rot,
      wakeUp,
    });
  }

  setAngvel(vel: PhysVector, wakeUp: boolean): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ANGVEL,
      rigidBodyId: this.id,
      vel,
      wakeUp,
    });
  }

  setNextKinematicTranslation(t: PhysVector): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_NEXT_KINEMATIC_TRANSLATION,
      rigidBodyId: this.id,
      t,
    });
  }

  setNextKinematicRotation(rot: PhysRotation): void {
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_NEXT_KINEMATIC_ROTATION,
      rigidBodyId: this.id,
      rot,
    });
  }

  linvel(): PhysVector {
    return this.lvel;
  }

  async velocityAtPoint(point: PhysVector): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidVelocityAtPointResponse>({
        type: PhysicsProtocolType.RIGID_VELOCITY_AT_POINT,
        rigidBodyId: this.id,
        point,
      })
    ).velocityAtPoint;
  }
  velocityAtPointSync(): PhysVector {
    throw new Error(
      'Checking the velocity at point of a rigid body (velocityAtPoint) cannot be synchronous in the worker mode.'
    );
  }

  angvel(): PhysVector {
    return this.avel;
  }

  async mass(): Promise<number> {
    return (
      await messageWorkerAsync<RigidMassResponse>({
        type: PhysicsProtocolType.RIGID_MASS,
        rigidBodyId: this.id,
      })
    ).mass;
  }
  massSync(): number {
    throw new Error(
      'Checking the mass of a rigid body (mass) cannot be synchronous in the worker mode.'
    );
  }

  async effectiveInvMass(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidEffectiveInvMassResponse>({
        type: PhysicsProtocolType.RIGID_EFFECTIVE_INV_MASS,
        rigidBodyId: this.id,
      })
    ).effectiveInvMass;
  }
  effectiveInvMassSync(): PhysVector {
    throw new Error(
      'Checking the mass of a rigid body (effectiveInvMass) cannot be synchronous in the worker mode.'
    );
  }

  async invMass(): Promise<number> {
    return (
      await messageWorkerAsync<RigidInvMassResponse>({
        type: PhysicsProtocolType.RIGID_INV_MASS,
        rigidBodyId: this.id,
      })
    ).invMass;
  }
  invMassSync(): number {
    throw new Error(
      'Checking the mass of a rigid body (invMass) cannot be synchronous in the worker mode.'
    );
  }

  async localCom(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidLocalComResponse>({
        type: PhysicsProtocolType.RIGID_LOCAL_COM,
        rigidBodyId: this.id,
      })
    ).localCom;
  }
  localComSync(): PhysVector {
    throw new Error(
      'Checking the local com of a rigid body (localCom) cannot be synchronous in the worker mode.'
    );
  }

  async worldCom(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidWorldComResponse>({
        type: PhysicsProtocolType.RIGID_WORLD_COM,
        rigidBodyId: this.id,
      })
    ).worldCom;
  }
  worldComSync(): PhysVector {
    throw new Error(
      'Checking the world com of a rigid body (worldCom) cannot be synchronous in the worker mode.'
    );
  }

  async invPrincipalInertia(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidInvPrincipalInertiaResponse>({
        type: PhysicsProtocolType.RIGID_INV_PRINCIPAL_INERTIA,
        rigidBodyId: this.id,
      })
    ).invPrincipalInertia;
  }
  invPrincipalInertiaSync(): PhysVector {
    throw new Error(
      'Checking the inertia of a rigid body (invPrincipalInertia) cannot be synchronous in the worker mode.'
    );
  }

  async principalInertia(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidPrincipalInertiaResponse>({
        type: PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA,
        rigidBodyId: this.id,
      })
    ).principalInertia;
  }
  principalInertiaSync(): PhysVector {
    throw new Error(
      'Checking the inertia of a rigid body (principalInertia) cannot be synchronous in the worker mode.'
    );
  }

  async principalInertiaLocalFrame(): Promise<PhysRotation> {
    return (
      await messageWorkerAsync<RigidPrincipalInertiaLocalFrameResponse>({
        type: PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA_LOCAL_FRAME,
        rigidBodyId: this.id,
      })
    ).principalInertiaLocalFrame;
  }
  principalInertiaLocalFrameSync(): PhysRotation {
    throw new Error(
      'Checking the inertia of a rigid body (principalInertiaLocalFrame) cannot be synchronous in the worker mode.'
    );
  }

  sleep(): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_SLEEP,
      rigidBodyId: this.id,
    });
  }

  wakeUp(): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_WAKE_UP,
      rigidBodyId: this.id,
    });
  }

  async isCcdEnabled(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsCcdEnabledResponse>({
        type: PhysicsProtocolType.RIGID_IS_CCD_ENABLED,
        rigidBodyId: this.id,
      })
    ).isCcdEnabled;
  }
  isCcdEnabledSync(): boolean {
    throw new Error(
      'Checking the CCD of a rigid body (isCcdEnabled) cannot be synchronous in the worker mode.'
    );
  }

  async numColliders(): Promise<number> {
    return (
      await messageWorkerAsync<RigidNumCollidersResponse>({
        type: PhysicsProtocolType.RIGID_NUM_COLLIDERS,
        rigidBodyId: this.id,
      })
    ).numColliders;
  }
  numCollidersSync(): number {
    throw new Error(
      'Checking the number of colliders of a rigid body (numColliders) cannot be synchronous in the worker mode.'
    );
  }

  async collider(i: number): Promise<ColliderAPI> {
    const response = await messageWorkerAsync<RigidColliderResponse>({
      type: PhysicsProtocolType.RIGID_COLLIDER,
      rigidBodyId: this.id,
      index: i,
    });
    return existsOrThrow(
      colliders.get(response.colliderId),
      `Could not find collider in ColliderAPI.collider(${i}).`
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  colliderSync(_i: number): ColliderAPI {
    throw new Error(
      'Getting a collider of a rigid body (colllider) cannot be synchronous in the worker mode.'
    );
  }

  setEnabled(enabled: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ENABLED,
      rigidBodyId: this.id,
      enabled,
    });
  }

  async isEnabled(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsEnabledResponse>({
        type: PhysicsProtocolType.RIGID_IS_ENABLED,
        rigidBodyId: this.id,
      })
    ).isEnabled;
  }
  isEnabledSync(): boolean {
    throw new Error(
      'Checking the enabled state of a rigid body (isEnabled) cannot be synchronous in the worker mode.'
    );
  }

  async bodyType(): Promise<RigidBodyTypeAPI> {
    return (
      await messageWorkerAsync<RigidBodyTypeResponse>({
        type: PhysicsProtocolType.RIGID_BODY_TYPE,
        rigidBodyId: this.id,
      })
    ).bodyType;
  }
  bodyTypeSync(): RigidBodyTypeAPI {
    throw new Error(
      'Checking the body type of a rigid body (bodyType) cannot be synchronous in the worker mode.'
    );
  }

  setBodyType(bodyType: RigidBodyTypeAPI, wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_SET_BODY_TYPE,
      rigidBodyId: this.id,
      bodyType,
      wakeUp,
    });
  }

  async isSleeping(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsSleepingResponse>({
        type: PhysicsProtocolType.RIGID_IS_SLEEPING,
        rigidBodyId: this.id,
      })
    ).isSleeping;
  }
  isSleepingSync(): boolean {
    throw new Error(
      'Checking the sleeping state of a rigid body (isSleeping) cannot be synchronous in the worker mode.'
    );
  }

  async isMoving(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsMovingResponse>({
        type: PhysicsProtocolType.RIGID_IS_MOVING,
        rigidBodyId: this.id,
      })
    ).isMoving;
  }
  isMovingSync(): boolean {
    throw new Error(
      'Checking the moving state of a rigid body (isMoving) cannot be synchronous in the worker mode.'
    );
  }

  async isFixed(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsFixedResponse>({
        type: PhysicsProtocolType.RIGID_IS_FIXED,
        rigidBodyId: this.id,
      })
    ).isFixed;
  }
  isFixedSync(): boolean {
    throw new Error(
      'Checking the fixed state of a rigid body (isFixed) cannot be synchronous in the worker mode.'
    );
  }

  async isKinematic(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsKinematicResponse>({
        type: PhysicsProtocolType.RIGID_IS_KINEMATIC,
        rigidBodyId: this.id,
      })
    ).isKinematic;
  }
  isKinematicSync(): boolean {
    throw new Error(
      'Checking the kinematic state of a rigid body (isKinematic) cannot be synchronous in the worker mode.'
    );
  }

  async isDynamic(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsDynamicResponse>({
        type: PhysicsProtocolType.RIGID_IS_DYNAMIC,
        rigidBodyId: this.id,
      })
    ).isDynamic;
  }
  isDynamicSync(): boolean {
    throw new Error(
      'Checking the dynamic state of a rigid body (isDynamic) cannot be synchronous in the worker mode.'
    );
  }

  async linearDamping(): Promise<number> {
    return (
      await messageWorkerAsync<RigidLinearDampingResponse>({
        type: PhysicsProtocolType.RIGID_LINEAR_DAMPING,
        rigidBodyId: this.id,
      })
    ).linearDamping;
  }
  linearDampingSync(): number {
    throw new Error(
      'Getting the linear damping of a rigid body (linearDamping) cannot be synchronous in the worker mode.'
    );
  }

  async angularDamping(): Promise<number> {
    return (
      await messageWorkerAsync<RigidAngularDampingResponse>({
        type: PhysicsProtocolType.RIGID_ANGULAR_DAMPING,
        rigidBodyId: this.id,
      })
    ).angularDamping;
  }
  angularDampingSync(): number {
    throw new Error(
      'Getting the angular damping of a rigid body (angularDamping) cannot be synchronous in the worker mode.'
    );
  }

  setLinearDamping(factor: number): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_SET_LINEAR_DAMPING,
      rigidBodyId: this.id,
      factor,
    });
  }

  setAngularDamping(factor: number): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ANGULAR_DAMPING,
      rigidBodyId: this.id,
      factor,
    });
  }

  recomputeMassPropertiesFromColliders(): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_RECOMPUTE_MASS_PROPERTIES,
      rigidBodyId: this.id,
    });
  }

  setAdditionalMass(mass: number, wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ADDITIONAL_MASS,
      rigidBodyId: this.id,
      mass,
      wakeUp,
    });
  }

  setAdditionalMassProperties(
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation,
    wakeUp: boolean
  ): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ADDITIONAL_MASS_PROPERTIES,
      rigidBodyId: this.id,
      mass,
      centerOfMass,
      principalAngularInertia,
      angularInertiaLocalFrame,
      wakeUp,
    });
  }

  resetForces(wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_RESET_FORCES,
      rigidBodyId: this.id,
      wakeUp,
    });
  }

  resetTorques(wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_RESET_TORQUES,
      rigidBodyId: this.id,
      wakeUp,
    });
  }

  addForce(force: PhysVector, wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_ADD_FORCE,
      rigidBodyId: this.id,
      force,
      wakeUp,
    });
  }

  applyImpulse(impulse: PhysVector, wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_APPLY_IMPULSE,
      rigidBodyId: this.id,
      impulse,
      wakeUp,
    });
  }

  addTorque(torque: PhysVector, wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_ADD_TORQUE,
      rigidBodyId: this.id,
      torque,
      wakeUp,
    });
  }

  applyTorqueImpulse(torqueImpulse: PhysVector, wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_APPLY_TORQUE_IMPULSE,
      rigidBodyId: this.id,
      torqueImpulse,
      wakeUp,
    });
  }

  addForceAtPoint(force: PhysVector, point: PhysVector, wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_ADD_FORCE_AT_POINT,
      rigidBodyId: this.id,
      force,
      point,
      wakeUp,
    });
  }

  applyImpulseAtPoint(impulse: PhysVector, point: PhysVector, wakeUp: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.RIGID_APPLY_IMPULSE_AT_POINT,
      rigidBodyId: this.id,
      impulse,
      point,
      wakeUp,
    });
  }

  async userForce(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidUserForceResponse>({
        type: PhysicsProtocolType.RIGID_USER_FORCE,
        rigidBodyId: this.id,
      })
    ).userForce;
  }
  userForceSync(): PhysVector {
    throw new Error(
      'Getting the user force of a rigid body (userForce) cannot be synchronous in the worker mode.'
    );
  }

  async userTorque(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidUserTorqueResponse>({
        type: PhysicsProtocolType.RIGID_USER_TORQUE,
        rigidBodyId: this.id,
      })
    ).userTorque;
  }
  userTorqueSync(): PhysVector {
    throw new Error(
      'Getting the user torque of a rigid body (userTorque) cannot be synchronous in the worker mode.'
    );
  }
}

class ColliderProxyAPI implements ColliderAPI {
  uData: Record<string, unknown> = {};

  isBeingDeleted: boolean = false;

  constructor(
    public id: number,
    public parentId?: number,
    userData?: Record<string, unknown>
  ) {
    if (userData) this.uData = userData;
  }

  // --- Metadata ---
  async getUserData(): Promise<Record<string, unknown>> {
    const res = await messageWorkerAsync<CollUserDataResponse>({
      type: PhysicsProtocolType.COLL_GET_USERDATA,
      colliderId: this.id,
    });
    this.uData = res.userData;
    return res.userData;
  }
  getUserDataSync(): Record<string, unknown> {
    return this.uData;
  }
  setUserData(userData: Record<string, unknown>, addToExisting?: boolean): void {
    this.uData = addToExisting ? { ...this.uData, ...userData } : userData;
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_USERDATA,
      colliderId: this.id,
      userData,
      addToExisting,
      isOneWay: true,
    });
  }

  async isValid(): Promise<boolean> {
    return (
      await messageWorkerAsync<CollIsValidResponse>({
        type: PhysicsProtocolType.COLL_IS_VALID,
        colliderId: this.id,
      })
    ).isValid;
  }
  isValidSync(): boolean {
    throw new Error('Sync isValid not supported on Proxy');
  }

  // --- Transformation ---
  async translation(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<CollTranslationResponse>({
        type: PhysicsProtocolType.COLL_TRANSLATION,
        colliderId: this.id,
      })
    ).translation;
  }
  translationSync(): PhysVector {
    throw new Error('Sync translation not supported on Proxy');
  }

  async translationWrtParent(): Promise<PhysVector | null> {
    return (
      await messageWorkerAsync<{ translation: PhysVector | null }>({
        type: PhysicsProtocolType.COLL_TRANSLATION_WRT_PARENT,
        colliderId: this.id,
      })
    ).translation;
  }
  translationWrtParentSync(): PhysVector | null {
    throw new Error('Sync translationWrtParent not supported on Proxy');
  }

  async rotation(): Promise<PhysRotation> {
    return (
      await messageWorkerAsync<CollRotationResponse>({
        type: PhysicsProtocolType.COLL_ROTATION,
        colliderId: this.id,
      })
    ).rotation;
  }
  rotationSync(): PhysRotation {
    throw new Error('Sync rotation not supported on Proxy');
  }

  async rotationWrtParent(): Promise<PhysRotation | null> {
    return (
      await messageWorkerAsync<{ rotation: PhysRotation | null }>({
        type: PhysicsProtocolType.COLL_ROTATION_WRT_PARENT,
        colliderId: this.id,
      })
    ).rotation;
  }
  rotationWrtParentSync(): PhysRotation | null {
    throw new Error('Sync rotationWrtParent not supported on Proxy');
  }

  setTranslation(tra: PhysVector): void {
    messageWorker({ type: PhysicsProtocolType.COLL_SET_TRANSLATION, colliderId: this.id, tra });
  }
  setTranslationWrtParent(tra: PhysVector): void {
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_TRANSLATION_WRT_PARENT,
      colliderId: this.id,
      tra,
    });
  }
  setRotation(rot: PhysRotation): void {
    messageWorker({ type: PhysicsProtocolType.COLL_SET_ROTATION, colliderId: this.id, rot });
  }
  setRotationWrtParent(rot: PhysRotation): void {
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_ROTATION_WRT_PARENT,
      colliderId: this.id,
      rot,
    });
  }

  // --- Physical Properties ---
  async isSensor(): Promise<boolean> {
    return (
      await messageWorkerAsync<CollIsSensorResponse>({
        type: PhysicsProtocolType.COLL_IS_SENSOR,
        colliderId: this.id,
      })
    ).isSensor;
  }
  isSensorSync(): boolean {
    throw new Error('Sync isSensor not supported on Proxy');
  }
  setSensor(isSensor: boolean): void {
    messageWorker({ type: PhysicsProtocolType.COLL_SET_SENSOR, colliderId: this.id, isSensor });
  }

  async isEnabled(): Promise<boolean> {
    return (
      await messageWorkerAsync<CollIsEnabledResponse>({
        type: PhysicsProtocolType.COLL_IS_ENABLED,
        colliderId: this.id,
      })
    ).isEnabled;
  }
  isEnabledSync(): boolean {
    throw new Error('Sync isEnabled not supported on Proxy');
  }
  setEnabled(enabled: boolean): void {
    messageWorker({ type: PhysicsProtocolType.COLL_SET_ENABLED, colliderId: this.id, enabled });
  }

  async friction(): Promise<number> {
    return (
      await messageWorkerAsync<CollFrictionResponse>({
        type: PhysicsProtocolType.COLL_FRICTION,
        colliderId: this.id,
      })
    ).friction;
  }
  frictionSync(): number {
    throw new Error('Sync friction not supported on Proxy');
  }
  setFriction(friction: number): void {
    messageWorker({ type: PhysicsProtocolType.COLL_SET_FRICTION, colliderId: this.id, friction });
  }

  async restitution(): Promise<number> {
    return (
      await messageWorkerAsync<CollRestitutionResponse>({
        type: PhysicsProtocolType.COLL_RESTITUTION,
        colliderId: this.id,
      })
    ).restitution;
  }
  restitutionSync(): number {
    throw new Error('Sync restitution not supported on Proxy');
  }
  setRestitution(restitution: number): void {
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_RESTITUTION,
      colliderId: this.id,
      restitution,
    });
  }

  async mass(): Promise<number> {
    return (
      await messageWorkerAsync<CollMassResponse>({
        type: PhysicsProtocolType.COLL_MASS,
        colliderId: this.id,
      })
    ).mass;
  }
  massSync(): number {
    throw new Error('Sync mass not supported on Proxy');
  }
  setMass(mass: number): void {
    messageWorker({ type: PhysicsProtocolType.COLL_SET_MASS, colliderId: this.id, mass });
  }

  setMassProperties(
    mass: number,
    centerOfMass: PhysVector,
    principalAngularInertia: PhysVector,
    angularInertiaLocalFrame: PhysRotation
  ): void {
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_MASS_PROPERTIES,
      colliderId: this.id,
      mass,
      centerOfMass,
      principalAngularInertia,
      angularInertiaLocalFrame,
      isOneWay: true, // Fire-and-forget
    });
  }

  async density(): Promise<number> {
    return (
      await messageWorkerAsync<CollDensityResponse>({
        type: PhysicsProtocolType.COLL_DENSITY,
        colliderId: this.id,
      })
    ).density;
  }
  densitySync(): number {
    throw new Error('Sync density not supported on Proxy');
  }
  setDensity(density: number): void {
    messageWorker({ type: PhysicsProtocolType.COLL_SET_DENSITY, colliderId: this.id, density });
  }

  // --- Geometry Details ---
  async shapeType(): Promise<ShapeType> {
    return (
      await messageWorkerAsync<CollShapeTypeResponse>({
        type: PhysicsProtocolType.COLL_SHAPE_TYPE,
        colliderId: this.id,
      })
    ).shapeType;
  }
  shapeTypeSync(): ShapeType {
    throw new Error('Sync shapeType not supported on Proxy');
  }

  async radius(): Promise<number> {
    return (
      await messageWorkerAsync<CollRadiusResponse>({
        type: PhysicsProtocolType.COLL_RADIUS,
        colliderId: this.id,
      })
    ).radius;
  }
  radiusSync(): number {
    throw new Error('Sync radius not supported on Proxy');
  }

  async halfHeight(): Promise<number> {
    return (
      await messageWorkerAsync<CollHalfHeightResponse>({
        type: PhysicsProtocolType.COLL_HALF_HEIGHT,
        colliderId: this.id,
      })
    ).halfHeight;
  }
  halfHeightSync(): number {
    throw new Error('Sync halfHeight not supported on Proxy');
  }

  async halfExtents(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<CollHalfExtentsResponse>({
        type: PhysicsProtocolType.COLL_HALF_EXTENTS,
        colliderId: this.id,
      })
    ).halfExtents;
  }
  halfExtentsSync(): PhysVector {
    throw new Error('Sync halfExtents not supported on Proxy');
  }

  // --- Geometry (mesh-type shapes) ---
  // One RPC per collider, paid once when its debug wireframe is first built (p025) —
  // never per frame. The worker sends the typed arrays as Transferables rather than
  // structured clones, since mesh data can be large.

  async vertices(): Promise<Float32Array | null> {
    return (
      await messageWorkerAsync<CollVerticesResponse>({
        type: PhysicsProtocolType.COLL_VERTICES,
        colliderId: this.id,
      })
    ).vertices;
  }
  verticesSync(): Float32Array | null {
    throw new Error('Sync vertices not supported on Proxy');
  }

  async indices(): Promise<Uint32Array | null> {
    return (
      await messageWorkerAsync<CollIndicesResponse>({
        type: PhysicsProtocolType.COLL_INDICES,
        colliderId: this.id,
      })
    ).indices;
  }
  indicesSync(): Uint32Array | null {
    throw new Error('Sync indices not supported on Proxy');
  }

  async heights(): Promise<HeightFieldData | null> {
    return (
      await messageWorkerAsync<CollHeightsResponse>({
        type: PhysicsProtocolType.COLL_HEIGHTS,
        colliderId: this.id,
      })
    ).heights;
  }
  heightsSync(): HeightFieldData | null {
    throw new Error('Sync heights not supported on Proxy');
  }

  async normal(): Promise<PhysVector | null> {
    return (
      await messageWorkerAsync<CollNormalResponse>({
        type: PhysicsProtocolType.COLL_NORMAL,
        colliderId: this.id,
      })
    ).normal;
  }
  normalSync(): PhysVector | null {
    throw new Error('Sync normal not supported on Proxy');
  }

  async borderRadius(): Promise<number> {
    return (
      await messageWorkerAsync<CollBorderRadiusResponse>({
        type: PhysicsProtocolType.COLL_BORDER_RADIUS,
        colliderId: this.id,
      })
    ).borderRadius;
  }
  borderRadiusSync(): number {
    throw new Error('Sync borderRadius not supported on Proxy');
  }

  // --- Groups ---
  async collisionGroups(): Promise<InteractionGroupsAPI> {
    return (
      await messageWorkerAsync<CollCollisionGroupsResponse>({
        type: PhysicsProtocolType.COLL_COLLISION_GROUPS,
        colliderId: this.id,
      })
    ).groups;
  }
  collisionGroupsSync(): InteractionGroupsAPI {
    throw new Error('Sync collisionGroups not supported on Proxy');
  }
  setCollisionGroups(groups: InteractionGroupsAPI): void {
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_COLLISION_GROUPS,
      colliderId: this.id,
      groups,
    });
  }

  async solverGroups(): Promise<InteractionGroupsAPI> {
    return (
      await messageWorkerAsync<CollSolverGroupsResponse>({
        type: PhysicsProtocolType.COLL_SOLVER_GROUPS,
        colliderId: this.id,
      })
    ).groups;
  }
  solverGroupsSync(): InteractionGroupsAPI {
    throw new Error('Sync solverGroups not supported on Proxy');
  }
  setSolverGroups(groups: InteractionGroupsAPI): void {
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_SOLVER_GROUPS,
      colliderId: this.id,
      groups,
    });
  }

  // --- Queries ---
  async containsPoint(point: PhysVector): Promise<boolean> {
    return (
      await messageWorkerAsync<{ isInside: boolean }>({
        type: PhysicsProtocolType.COLL_CONTAINS_POINT,
        colliderId: this.id,
        point,
      })
    ).isInside;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  containsPointSync(_point: PhysVector): boolean {
    throw new Error('Sync containsPoint not supported on Proxy');
  }
}

class JointProxyAPI implements JointAPI {
  uData: Record<string, unknown> = {};

  isBeingDeleted: boolean = false;

  constructor(
    public id: number,
    userData?: Record<string, unknown>
  ) {
    if (userData) this.uData = userData;
  }

  // --- Metadata ---
  async getUserData(): Promise<Record<string, unknown>> {
    const res = await messageWorkerAsync<JointGetUserDataResponse>({
      type: PhysicsProtocolType.JOINT_GET_USERDATA,
      jointId: this.id,
    });
    this.uData = res.userData;
    return res.userData;
  }
  getUserDataSync(): Record<string, unknown> {
    return this.uData;
  }
  setUserData(userData: Record<string, unknown>, addToExisting?: boolean): void {
    this.uData = addToExisting ? { ...this.uData, ...userData } : userData;
    messageWorker({
      type: PhysicsProtocolType.JOINT_SET_USERDATA,
      jointId: this.id,
      userData,
      addToExisting,
      isOneWay: true,
    });
  }

  async isValid(): Promise<boolean> {
    return (
      await messageWorkerAsync<JointIsValidResponse>({
        type: PhysicsProtocolType.JOINT_IS_VALID,
        jointId: this.id,
      })
    ).isValid;
  }
  isValidSync(): boolean {
    throw new Error('Sync isValid not supported on Proxy');
  }

  async body1Id(): Promise<number> {
    return (
      await messageWorkerAsync<JointBody1IdResponse>({
        type: PhysicsProtocolType.JOINT_BODY1_ID,
        jointId: this.id,
      })
    ).body1Id;
  }
  body1IdSync(): number {
    throw new Error('Sync body1Id not supported on Proxy');
  }
  async body2Id(): Promise<number> {
    return (
      await messageWorkerAsync<JointBody2IdResponse>({
        type: PhysicsProtocolType.JOINT_BODY2_ID,
        jointId: this.id,
      })
    ).body2Id;
  }
  body2IdSync(): number {
    throw new Error('Sync body2Id not supported on Proxy');
  }

  async anchor1(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<JointAnchor1Response>({
        type: PhysicsProtocolType.JOINT_ANCHOR1,
        jointId: this.id,
      })
    ).anchor1;
  }
  anchor1Sync(): PhysVector {
    throw new Error('Sync anchor1 not supported on Proxy');
  }
  async anchor2(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<JointAnchor2Response>({
        type: PhysicsProtocolType.JOINT_ANCHOR2,
        jointId: this.id,
      })
    ).anchor2;
  }
  anchor2Sync(): PhysVector {
    throw new Error('Sync anchor2 not supported on Proxy');
  }

  async contactsEnabled(): Promise<boolean> {
    return (
      await messageWorkerAsync<JointContactsEnabledResponse>({
        type: PhysicsProtocolType.JOINT_CONTACTS_ENABLED,
        jointId: this.id,
      })
    ).contactsEnabled;
  }
  contactsEnabledSync(): boolean {
    throw new Error('Sync contactsEnabled not supported on Proxy');
  }
  setContactsEnabled(enabled: boolean): void {
    messageWorker({
      type: PhysicsProtocolType.JOINT_SET_CONTACTS_ENABLED,
      jointId: this.id,
      enabled,
    });
  }

  // --- Revolute/Prismatic only ---
  async limitsEnabled(): Promise<boolean> {
    return (
      await messageWorkerAsync<JointLimitsEnabledResponse>({
        type: PhysicsProtocolType.JOINT_LIMITS_ENABLED,
        jointId: this.id,
      })
    ).limitsEnabled;
  }
  limitsEnabledSync(): boolean {
    throw new Error('Sync limitsEnabled not supported on Proxy');
  }
  setLimits(min: number, max: number): void {
    messageWorker({ type: PhysicsProtocolType.JOINT_SET_LIMITS, jointId: this.id, min, max });
  }
  configureMotorModel(model: JointMotorModel): void {
    messageWorker({
      type: PhysicsProtocolType.JOINT_CONFIGURE_MOTOR_MODEL,
      jointId: this.id,
      model,
    });
  }
  configureMotorVelocity(targetVel: number, factor: number): void {
    messageWorker({
      type: PhysicsProtocolType.JOINT_CONFIGURE_MOTOR_VELOCITY,
      jointId: this.id,
      targetVel,
      factor,
    });
  }
  configureMotorPosition(targetPos: number, stiffness: number, damping: number): void {
    messageWorker({
      type: PhysicsProtocolType.JOINT_CONFIGURE_MOTOR_POSITION,
      jointId: this.id,
      targetPos,
      stiffness,
      damping,
    });
  }
  configureMotor(targetPos: number, targetVel: number, stiffness: number, damping: number): void {
    messageWorker({
      type: PhysicsProtocolType.JOINT_CONFIGURE_MOTOR,
      jointId: this.id,
      targetPos,
      targetVel,
      stiffness,
      damping,
    });
  }
}

/** World, RigidBody, Collider, and Joint API classes -----[ END ]----- */

// Debug
type PhysicsAPIGUIModule = typeof import('./Debug/_dbg__PhysicsAPI');
let debugGUI: DebugModuleRef<PhysicsAPIGUIModule> | null = null;

export const createPhysicsAPIDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('./Debug/_dbg__PhysicsAPI'));
  useDebug(debugGUI)?._createPhysicsAPIDebugGUI();
};
