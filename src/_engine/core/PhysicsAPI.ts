// This API is a wrapper to call the actual physics engine.
// It has been created based on the RAPIER API model. Other engines
// may not share the same methods and call signatures (and some
// refactoring might be needed to make others work). The API
// handles the differentiation between different engines
// and threading.

import * as THREE from 'three/webgpu';

import PhysicsWorker from '../workers/physicsWorker?worker';
import { getConfig, IS_DEBUG_ENV, isDebugEnvironment } from './Config';
import { PhysicsTransformBuffer } from './Physics/PhysicsTransformBuffer';
import {
  PHYSICS_STEP_STATS_FIELD_COUNT,
  PHYSICS_STEP_STATS_SLOTS,
} from './Physics/PhysicsStepStatsBuffer';
import { PhysicsDebugStateBuffer } from './Physics/PhysicsDebugStateBuffer';
import {
  getCollOrRigidId,
  getEngineAPI,
  initPhysicsEngine,
  ValidProtocolTypes,
} from './Physics/PhysicsUtils';
import { lerror, lwarn } from '../utils/Logger';
// Always-safe thin wrapper: a no-op outside debug builds and tree-shaken out of production.
import { updatePhysicsPanel } from '../debug/Stats';
import { addVisibilityChangeFn, getReadOnlyLoopState, LoopState, toggleMainPlay } from './MainLoop';
import {
  DebugModuleRef,
  initWorker,
  loadDebugModule,
  loadDebugModuleAsync,
  useDebug,
} from '../utils/helpers';
import {
  ColliderAPI,
  CollBorderRadiusResponse,
  CollHeightsResponse,
  CollIndicesResponse,
  CollNormalResponse,
  CollVerticesResponse,
  EngineAPIType,
  PhysicsQueryObserver,
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
  PoseArray,
  RigidBodyTypeAPI,
  TakeSnapshotResponse,
  CreateWorldResponse,
  DeleteWorldResponse,
  FlushResponse,
  RestoreSnapshotResponse,
  WorldGravityResponse,
  WorldTimestepResponse,
  WorldLengthUnitResponse,
  WorldNumSolverIterationsResponse,
  WorldNumInternalPgsIterationsResponse,
  RigidBodyParams,
  CreateRigidBodyResponse,
  CreatePhysicsEntityResponse,
  CreateColliderResponse,
  QueryFilterFlags,
  ColliderParams,
  CreateRigidBodiesResponse,
  CreateCollidersResponse,
  ShapeCastHitAPI,
  ShapeParams,
  WorldCastRayAndGetNormalResponse,
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
  JointAnchor1Response,
  JointAnchor2Response,
  JointContactsEnabledResponse,
  JointLimitsEnabledResponse,
  JointGetUserDataResponse,
  RigidBodyPose,
  RigidDetachResponse,
  RigidReadPositionsResponse,
  RigidReattachResponse,
  type PhysicsBodyActivity,
  type RigidBodyAttachState,
} from './Physics/PhysicsAPITypes';
import { createNewResolver, resolveRequest } from '../utils/PromiseResolver';
import {
  IntervalCounterStats,
  type IntervalCounterSnapshot,
} from '../utils/stats/IntervalCounterStats';
import { RAY_STATS_WINDOWS, RAY_TESTER_ID_PREFIX, type RayDebugOpts } from './RayDebugTypes';
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
  stepStatsEnabled: false,
};
let worker: Worker | null = null;
let physicsWorld: WorldAPI = { step: () => {} } as unknown as WorldAPI;
let physicsWorldEnabled = false;
let engineInitiated = false;
let engAPI: EngineAPIType | null = null;
/** Main-thread wrapper for the worker's hot-path transform buffer (WORKER_THREAD mode only).
 * SHARED_MEMORY: set once at createPhysicsWorld() and never replaced; every read sees the
 * snapshot latched at the start of the frame (latchPhysicsSnapshot). MESSAGE_BATCH: undefined
 * until the first TRANSFORMS_PUSH, then re-pointed at every subsequent push.
 */
let transformBuffer: PhysicsTransformBuffer | undefined;
/** Which hot-path transport createPhysicsWorld() resolved to for the current world (WORKER_THREAD only). */
let resolvedTransportMode: 'SHARED_MEMORY' | 'MESSAGE_BATCH' | undefined;
/** Step statistics (p027), all only ever populated while physicsState.stepStatsEnabled is on.
 * Pure simulation time for the last stepped frame — the sum of that frame's engine step()
 * calls, with nothing else folded in. Deliberately never includes messaging overhead; that
 * is reported separately by lastPhysicsMessagingLatency. */
let lastPhysicsStepDurationMs: number | undefined;
/** Messaging overhead bracketing the step, WORKER_THREAD only (stays undefined on
 * MAIN_THREAD, where no message crosses a thread at all). */
let lastPhysicsMessagingLatency: { dispatchMs: number; writeBackMs: number } | undefined;
/** SHARED_MEMORY-transport view onto the current world's step-stats buffer (handed over at
 * every CREATE_WORLD, whatever stepStatsEnabled is). Undefined in every other configuration
 * (MAIN_THREAD, MESSAGE_BATCH). */
let stepStatsFloats: Float64Array | undefined;
/** Main-thread wrapper for the worker's debug wireframe state buffer (WORKER_THREAD
 * only). Undefined until setPhysicsDebugStateTracking() turns tracking on for the first
 * time. SHARED_MEMORY: set once and never replaced. MESSAGE_BATCH: replaced on every
 * DEBUG_STATE_PUSH. */
let debugStateBuffer: PhysicsDebugStateBuffer | undefined;

/** Dynamic bodies awake and asleep after the last measured step (p352), mutated in place. Only
 * meaningful while hasBodyActivity is set (a measured step has reported it). */
const bodyActivity: PhysicsBodyActivity = { awake: 0, sleeping: 0 };
let hasBodyActivity = false;

/** Rigid body creates refused because the transform buffer was full (WORKER_THREAD), since boot. */
let refusedBodyCount = 0;

/**
 * Rejection reason of a rigid body create that found every transform-buffer slot taken
 * (`WORKER_THREAD` mode, p352): nothing of it was created. Raise `AppConfig.physics.maxBodies`,
 * or create the bodies that never move as `FIXED` (they take no slot).
 */
export class PhysicsCapacityError extends Error {
  constructor(public readonly maxBodies: number) {
    super(
      `Physics transform buffer full: all ${maxBodies} slots are taken (AppConfig.physics.maxBodies). FIXED bodies take no slot.`
    );
    this.name = 'PhysicsCapacityError';
  }
}

/** Counts a refused create and throws its PhysicsCapacityError, if the worker refused it. */
const throwIfCapacityExceeded = (capacityExceeded: number | undefined) => {
  if (capacityExceeded === undefined) return;
  refusedBodyCount++;
  throw new PhysicsCapacityError(capacityExceeded);
};

/** Told the id of every rigid body moved by setTranslation/setRotation (p352). */
let bodyMovedListener: ((rigidBodyId: number) => void) | null = null;

/**
 * Sets (or clears, with null) the one listener told the id of every rigid body moved by
 * `setTranslation` / `setRotation`, in both worker targets. `BODY_STATIC` entities (bodies
 * created `FIXED`, and dynamic ones in the `STATIC` or `DISABLED` physics tier) aren't synced to
 * their entities every frame (p352), so PhysicsManager.ts uses this to bring such a move to the
 * mesh. It's called for every move, so it must be cheap.
 */
export const setBodyMovedListener = (listener: ((rigidBodyId: number) => void) | null) => {
  bodyMovedListener = listener;
  engAPI?.setBodyMovedObserver(listener);
};

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
    engAPI.setQueryObserver(queryObserver);
    engAPI.setBodyMovedObserver(bodyMovedListener);
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
      mainTimeOrigin: performance.timeOrigin,
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
 * up to maxSubSteps per frame. Also handles backgroundBehavior/pause bookkeeping (see
 * physicsVisibilityChangeHandler for the window-hidden 'PAUSE' path, which halts the whole
 * main loop before this is reached).
 *
 * Calls `onBeforeStep` once per fixed-timestep slice, right before that slice's step (held-key
 * polling, event delivery and APP_PHYSICS_STEP systems, see MainLoop.ts's runPhysicsSubStep).
 * In WORKER_THREAD mode the steps themselves run off-thread,
 * so the callbacks all run here up front, and whatever one-way commands each one issues are
 * carried in the STEP message and replayed on the worker right before their own sub-step.
 *
 * Returns how many fixed-timestep slices were actually taken this call (0 if physics is
 * disabled/paused/hasn't accumulated a full slice yet).
 */
export const stepPhysics = (
  loopState: LoopState,
  /** Called once per fixed sub-step, right before it, with dt = the fixed timestep (this is
   * what drives held-key polling, flushPhysicsEvents and the APP_PHYSICS_STEP ECS stage, see
   * MainLoop.ts). Without one, events are flushed before each sub-step here instead. */
  onBeforeStep?: (stepDelta: number) => void
): number => {
  if (!physicsWorldEnabled) return 0;
  // Scene load in progress (holdPhysicsStepping): no timer update either, releasing it
  // resumes through the paused branch below.
  if (isSteppingHeld) return 0;

  updateTimer();
  let dt = timer.getDelta();

  if (
    !loopState.masterPlay ||
    !loopState.appPlay ||
    loopState.isSceneSuspended ||
    !physicsState.worldStepEnabled
  ) {
    // Explicit pause (unrelated to window visibility) always halts stepping outright —
    // backgroundBehavior only governs what happens while the window is hidden. Switching
    // the world step off counts as one too, so switching it back on resumes cleanly instead
    // of catching up on the time it was off, and so does a scene suspended by an editor view
    // (ViewManager.ts).
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
    // Resuming: the dt just computed above is either stale (the timer wasn't updated while
    // timerRunning was false) or spans the entire paused duration — discard it and the stale
    // accumulator rather than trying to simulate the whole paused duration in one go. The
    // timer restarts from now, whatever paused it, so the next frame's dt is one frame long.
    physicsState.isPaused = false;
    physicsState.pauseDurationTotal += performance.now() - physicsState.pausedTime;
    physicsState.pausedTime = 0;
    accDelta = 0;
    simClockEpoch++;
    timerRunning = true;
    timer.update();
    return 0;
  }

  // Debug-only freeze (setPhysicsStepLimit): at the limit, hold there without banking time
  // toward the next step, so releasing it resumes cleanly instead of catching up.
  const stepsToLimit = stepLimit === null ? Infinity : stepLimit - stepsIssued;
  if (stepsToLimit <= 0) {
    accDelta = 0;
    return 0;
  }
  // Step gates (addPhysicsStepGate): unlike the limit, time keeps banking while one holds.
  const stepsToGate = getLowestStepGate() - stepsIssued;

  const scaledDelta = dt * loopState.playSpeedMultiplier;
  accDelta +=
    physicsState.maxDeltaTime > 0 ? Math.min(scaledDelta, physicsState.maxDeltaTime) : scaledDelta;

  const maxSteps = physicsState.maxSubSteps > 0 ? physicsState.maxSubSteps : Infinity;
  let stepsTaken = 0;
  while (
    accDelta >= physicsState.timestepRatio &&
    stepsTaken < maxSteps &&
    stepsTaken < stepsToGate
  ) {
    accDelta -= physicsState.timestepRatio;
    stepsTaken++;
  }
  if (stepsTaken >= maxSteps) {
    // Hit the sub-step ceiling with backlog still left over: drop it instead of deferring it,
    // so a sustained slowdown can't make the accumulator (and next frame's catch-up cost) grow
    // without bound — the actual "prevent the spiral of death" behavior.
    // Only a discontinuity if there was backlog to drop (sitting exactly at the ceiling isn't).
    if (accDelta >= physicsState.timestepRatio) simClockEpoch++;
    accDelta = 0;
  } else if (accDelta >= physicsState.timestepRatio && stepsTaken >= stepsToGate) {
    // Held at a gate with steps due: they wait in the accumulator and run once it's released,
    // but never more of them than one frame could catch up (the ceiling above drops the rest).
    const maxBacklog = maxSteps * physicsState.timestepRatio;
    if (accDelta > maxBacklog) {
      accDelta = maxBacklog;
      simClockEpoch++;
    }
    noteStepGateHeld(true);
  }
  if (stepsTaken > 0 && stepsTaken < stepsToGate) noteStepGateHeld(false);
  if (stepsTaken >= stepsToLimit) {
    stepsTaken = stepsToLimit;
    accDelta = 0;
  }

  if (stepsTaken === 0) return 0;

  const stepDelta = physicsState.timestepRatio;
  const trackStats = physicsState.stepStatsEnabled;
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    let stepMs = 0;
    try {
      for (let i = 0; i < stepsTaken; i++) {
        if (isSubStepGated(i, stepsTaken)) {
          stepsTaken = i;
          break;
        }
        subStepIndex = stepsIssued + i;
        if (onBeforeStep) onBeforeStep(stepDelta);
        else flushPhysicsEvents();
        if (!trackStats) {
          engAPI?.step();
          continue;
        }
        // Timed around step() alone: onBeforeStep above runs app/ECS work, and including it
        // would reproduce exactly the contamination that made the legacy PHY panel misleading.
        const subStepStart = performance.now();
        engAPI?.step();
        stepMs += performance.now() - subStepStart;
      }
    } finally {
      subStepIndex = -1;
    }
    if (trackStats) {
      lastPhysicsStepDurationMs = stepMs;
      if (engAPI) {
        engAPI.countDynamicBodyActivity(bodyActivity);
        hasBodyActivity = true;
      }
      // No thread boundary is crossed here, so there is no messaging overhead to report.
      lastPhysicsMessagingLatency = undefined;
      updatePhysicsPanel(stepMs);
    }
    stampStepBatch(stepsTaken);
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    let substepCommands: PhysicsUpProtocol[][] | undefined;
    if (onBeforeStep) {
      substepCommands = [];
      for (let i = 0; i < stepsTaken; i++) {
        if (isSubStepGated(i, stepsTaken)) {
          stepsTaken = i;
          break;
        }
        substepCommandCapture = [];
        subStepIndex = stepsIssued + i;
        try {
          onBeforeStep(stepDelta);
        } finally {
          substepCommands.push(substepCommandCapture);
          substepCommandCapture = null;
          subStepIndex = -1;
        }
      }
    }
    // One-way, no response awaited — transform results arrive via the hot-path buffer
    // (transformBuffer), not via a STEP reply. A single message runs all of this frame's
    // sub-steps (each preceded by its own captured commands) and writes back exactly once,
    // never one message per sub-step.
    messageWorker({
      type: PhysicsProtocolType.STEP,
      steps: stepsTaken,
      substepCommands,
      isOneWay: true,
      // Only stamped while measuring; the worker derives dispatchMs from it.
      sentAt: trackStats ? performance.now() : undefined,
    });
    stampStepBatch(stepsTaken);
    // SHARED_MEMORY has no per-step return message, so the stats are polled here instead,
    // one frame behind — the same latency tradeoff the transform buffer itself already makes.
    if (trackStats) readSharedStepStats();
  }

  return stepsTaken;
};

/** Polls the SHARED_MEMORY step-stats buffer, if one exists. No-op in every other transport.
 *
 * Note the asymmetry this creates in writeBackMs: in MESSAGE_BATCH mode that figure is real
 * postMessage transit time, whereas here there is no return message to time, so it measures
 * how long after the worker finished stepping the main thread got around to reading — a
 * read-cadence latency. The two transports' writeBackMs are therefore not comparable. */
const readSharedStepStats = () => {
  if (!stepStatsFloats) return;
  const stepEndAt = stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.STEP_END_AT];
  // Zero means the worker hasn't completed a step yet — nothing to report.
  if (!stepEndAt) return;
  lastPhysicsStepDurationMs = stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.STEP_MS];
  lastPhysicsMessagingLatency = {
    dispatchMs: stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.DISPATCH_MS],
    writeBackMs: performance.now() - stepEndAt,
  };
  bodyActivity.awake = stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.AWAKE_BODIES];
  bodyActivity.sleeping = stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.SLEEPING_BODIES];
  hasBodyActivity = true;
  updatePhysicsPanel(lastPhysicsStepDurationMs);
};

/**
 * Time the physics engine spent stepping the world on the last stepped frame, in
 * milliseconds — the sum of that frame's fixed-timestep sub-steps and nothing else.
 *
 * Returns `undefined` until a measured step has happened, and stays frozen at its last value
 * while step stats are off (the default), since nothing measures then. The boot value is
 * `AppConfig.physics.stepStatsEnabled` (the Physics API debug tab's reloading switch);
 * {@link setPhysicsStepStatsEnabled} switches it at runtime, which resets this to `undefined`.
 *
 * This figure never includes main-thread↔worker messaging overhead, in any `workerTarget` or
 * transport configuration — see {@link getLastPhysicsStepMessagingLatency} for that, which is
 * measured independently and is never summed into this one.
 */
export const getLastPhysicsStepDuration = () => lastPhysicsStepDurationMs;

/**
 * Main-thread↔worker messaging overhead bracketing the last measured physics step, in
 * milliseconds. `undefined` in `MAIN_THREAD` mode (nothing crosses a thread boundary), and
 * until a measured step has happened.
 *
 * - `dispatchMs` — main→worker: how long the one-way STEP message took to reach the worker.
 * - `writeBackMs` — worker→main, and **it does not mean the same thing in both transports**:
 *   in `MESSAGE_BATCH` it is real postMessage transit time of the TRANSFORMS_PUSH carrying
 *   the results; in `SHARED_MEMORY` there is no return message at all, so it is instead the
 *   read-cadence latency (worker finished stepping → main thread next polled the shared
 *   buffer). Surface that distinction anywhere these are displayed rather than comparing the
 *   two transports' numbers as like for like.
 *
 * Disjoint from {@link getLastPhysicsStepDuration} by construction: the intervals are
 * adjacent, never overlapping, and the two are never combined into a single figure.
 */
export const getLastPhysicsStepMessagingLatency = () => lastPhysicsMessagingLatency;

/**
 * Dynamic bodies awake and asleep after the last measured physics step (p352): a body that
 * should be resting but stays awake shows here. Measured with the step stats, so `undefined`
 * while they are off and until a measured step has happened, like
 * {@link getLastPhysicsStepDuration}. The returned object is reused: read it, don't keep it.
 */
export const getLastPhysicsBodyActivity = (): Readonly<PhysicsBodyActivity> | undefined =>
  hasBodyActivity ? bodyActivity : undefined;

/**
 * The transform buffer's capacity (`WORKER_THREAD` mode, p352): slots taken by live non-fixed
 * bodies, `AppConfig.physics.maxBodies`, and the creates refused since boot because it was
 * full ({@link PhysicsCapacityError}). `undefined` in `MAIN_THREAD` mode, which has no buffer
 * and no cap. Walks every body: for debug readouts, not per frame.
 */
export const getPhysicsBodyCapacity = () => {
  if (physicsState.workerTarget !== 'WORKER_THREAD') return undefined;
  let used = 0;
  for (const rb of rigidBodies.values()) {
    if (rb instanceof RigidBodyProxyAPI && rb.hasSlot) used++;
  }
  return { used, max: physicsState.maxBodies, refused: refusedBodyCount };
};

/**
 * Switches the physics step measurement ({@link getLastPhysicsStepDuration},
 * {@link getLastPhysicsStepMessagingLatency}) on or off at runtime. Its initial value is
 * `AppConfig.physics.stepStatsEnabled`. The debug "PHY" stats panel exists only when that boot
 * value is on.
 *
 * Switching it on clears the last figures, so a reader sees `undefined` ("no measured step
 * yet") instead of what an earlier measuring period left behind. `WORKER_THREAD`: the worker
 * gets a one-way message and measures from its next STEP message on (in every transport).
 * Called before {@link initPhysics}, the config value replaces it.
 */
export const setPhysicsStepStatsEnabled = (enabled: boolean) => {
  if (physicsState.stepStatsEnabled === enabled) return;
  physicsState.stepStatsEnabled = enabled;
  if (enabled) {
    lastPhysicsStepDurationMs = undefined;
    lastPhysicsMessagingLatency = undefined;
    hasBodyActivity = false;
    // The worker writes it only while measuring, which it isn't yet, so this can't race
    if (stepStatsFloats) stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.STEP_END_AT] = 0;
  }
  if (physicsState.workerTarget === 'WORKER_THREAD') {
    messageWorker({ type: PhysicsProtocolType.SET_STEP_STATS, enabled, isOneWay: true });
  }
};

/** Whether the physics step measurement is on (see {@link setPhysicsStepStatsEnabled}). */
export const isPhysicsStepStatsEnabled = () => physicsState.stepStatsEnabled;

// PHYSICS RAY STATS AND HELPERS (p142) -- [ START ] -----------------------
// Physics queries are counted and drawn by a query observer. It is installed only while the
// stats or the physics ray helpers are on, so a query costs one null check otherwise.
// MAIN_THREAD: the engine backend calls it (engAPI.setQueryObserver). WORKER_THREAD:
// WorldProxyAPI calls it.

/** Physics query statistics, per rendered frame (see {@link getPhysicsRayStats}). */
export type PhysicsRayStats = {
  /** CAST_RAY + CAST_RAY_AND_GET_NORMAL + INTERSECTIONS_WITH_RAY queries */
  rays: Readonly<IntervalCounterSnapshot>;
  /** CAST_SHAPE queries */
  shapeCasts: Readonly<IntervalCounterSnapshot>;
  /** Queries issued but not answered yet (WORKER_THREAD; always 0 on MAIN_THREAD). A number
   * that keeps growing means worker replies are piling up or never arriving. */
  pendingQueries: number;
};

const physicsRaysStats = new IntervalCounterStats(RAY_STATS_WINDOWS);
const physicsShapeCastsStats = new IntervalCounterStats(RAY_STATS_WINDOWS);
const physicsRayStats: PhysicsRayStats = {
  rays: physicsRaysStats.snapshot(),
  shapeCasts: physicsShapeCastsStats.snapshot(),
  pendingQueries: 0,
};
let physicsRayStatsEnabled = false;
/** Debug only: the physics kind's "Show helpers" setting (Ray cast controls tab) */
let physicsRayHelpersEnabled = false;
type RayHelpersModule = typeof import('./Debug/_dbg__RayHelpers');
let rayHelpers: DebugModuleRef<RayHelpersModule> | null = null;

/**
 * Counts queries at issue time, so a frame's count includes every sub-step's queries, and
 * draws each one as a `'PHYSICS'` ray helper right away, even in WORKER_THREAD mode. The
 * helper runs to maxToi until the result sets its hit: in the same call on MAIN_THREAD, about
 * a frame later on WORKER_THREAD.
 *
 * The helper gets the query's own `dir`, not a normalized one: its lengths are then tois, and
 * `origin + dir * toi` is the exact hit point for any `|dir|`. (Only the helpers'
 * maxHelperLength cap on misses is in `|dir|` units then.)
 */
const physicsQueryObserver: PhysicsQueryObserver = {
  onQuery: (kind, origin, dir, maxToi, debug) => {
    // The ray tester windows' queries are drawn, never counted (RAY_TESTER_ID_PREFIX)
    const isCounted = physicsRayStatsEnabled && !debug?.id.startsWith(RAY_TESTER_ID_PREFIX);
    if (isCounted) {
      if (kind === 'CAST_SHAPE') physicsShapeCastsStats.add();
      else physicsRaysStats.add();
      physicsRayStats.pendingQueries++;
    }
    let helperToken = 0;
    if (physicsRayHelpersEnabled) {
      const helpers = useDebug(rayHelpers);
      if (helpers) {
        helperToken = helpers._drawRay(
          'PHYSICS',
          origin,
          dir,
          maxToi,
          null,
          debug,
          performance.now()
        );
      }
    }
    // The token's lowest bit tells onResult whether this query was counted as pending
    return helperToken * 2 + (isCounted ? 1 : 0);
  },
  onResult: (token, firstHitToi) => {
    // Clamped: a reply to a query issued before the last reset has nothing to subtract from
    if (token % 2 === 1 && physicsRayStats.pendingQueries > 0) physicsRayStats.pendingQueries--;
    // A no-op when the helper has been cast again or recycled since
    const helperToken = Math.floor(token / 2);
    if (helperToken) useDebug(rayHelpers)?._updateRayHit(helperToken, firstHitToi);
  },
};

/** The installed query observer, null while nothing needs one. Read by WorldProxyAPI. */
let queryObserver: PhysicsQueryObserver | null = null;

/** Installs the query observer while anything needs it, removes it otherwise. */
const updateQueryObserver = () => {
  queryObserver = physicsRayStatsEnabled || physicsRayHelpersEnabled ? physicsQueryObserver : null;
  engAPI?.setQueryObserver(queryObserver);
};

/**
 * Enables or disables the physics ray statistics. Enabling resets them. While disabled (and no
 * other query instrumentation is on) a query costs one null check and nothing is counted.
 * @param enabled (boolean) whether physics queries are counted
 */
export const setPhysicsRayStatsEnabled = (enabled: boolean) => {
  if (enabled && !physicsRayStatsEnabled) resetPhysicsRayStats();
  physicsRayStatsEnabled = enabled;
  updateQueryObserver();
};

/**
 * Whether the physics ray statistics are enabled
 * @returns boolean
 */
export const isPhysicsRayStatsEnabled = () => physicsRayStatsEnabled;

/**
 * Debug only (a no-op outside the debug env): whether physics queries are drawn as `'PHYSICS'`
 * ray helpers. The Ray cast controls tab calls it with the physics helpers' "Show helpers"
 * setting; the helpers' look is set there too.
 * @param enabled (boolean) whether physics queries are drawn
 */
export const setPhysicsRayHelpersEnabled = (enabled: boolean) => {
  physicsRayHelpersEnabled = enabled && IS_DEBUG_ENV;
  if (physicsRayHelpersEnabled && !rayHelpers) {
    rayHelpers = loadDebugModule(() => import('./Debug/_dbg__RayHelpers'), 'RayHelpers');
  }
  updateQueryObserver();
};

/**
 * The physics query statistics: queries issued per rendered frame (the last frame, the max ever
 * and the min/max/average of rolling intervals), rays and shape casts separately, plus the
 * queries still waiting for a worker reply. Counted when issued, so queries issued in
 * `APP_PHYSICS_STEP` count once per sub-step.
 *
 * The returned object is the same on every call and is updated in place, so polling it
 * allocates nothing. Copy the values out to keep them.
 * @returns ({@link PhysicsRayStats}) the live statistics
 */
export const getPhysicsRayStats = (): Readonly<PhysicsRayStats> => physicsRayStats;

/** Resets the physics ray statistics. The scene loader calls it on every scene enter. */
export const resetPhysicsRayStats = () => {
  const now = performance.now();
  physicsRaysStats.reset(now);
  physicsShapeCastsStats.reset(now);
  physicsRayStats.pendingQueries = 0;
};

/** Ends the physics ray stats frame. Engine internal: PhysicsManager's LATE_MAIN system calls
 * it once per rendered frame. */
export const endPhysicsRayStatsFrame = (nowMs: number) => {
  if (!physicsRayStatsEnabled) return;
  physicsRaysStats.endFrame(nowMs);
  physicsShapeCastsStats.endFrame(nowMs);
};

// PHYSICS RAY STATS AND HELPERS -- [ END ] -----------------------

// WORKER LOGIC -- [ START ] -----------------------

/** postMessage structured-clones only own fields, and a THREE.Quaternion keeps its values in
 * private `_x/_y/_z/_w` fields behind prototype getters — posted as-is, the worker would receive
 * a rotation with no x/y/z/w at all. Every rotation crossing to the worker goes through this. */
const toPlainRot = (rot: PhysRotation): PhysRotation => ({
  x: rot.x,
  y: rot.y,
  z: rot.z,
  w: rot.w,
});

/** While stepPhysics() runs a sub-step's APP_PHYSICS_STEP callback in WORKER_THREAD mode, the
 * one-way commands it issues are collected here instead of posted, and then travel inside that
 * frame's single STEP message to be replayed right before their own sub-step. (Request/response
 * calls via messageWorkerAsync are still posted immediately — they reach the worker ahead of
 * the STEP message, i.e. before this frame's first sub-step.) */
let substepCommandCapture: PhysicsUpProtocol[] | null = null;

/** The transform buffer step index from which a write made right now is visible in it: the
 * worker applies the write before (or, for captured sub-step commands, during) the next STEP,
 * whose steps are all numbered after the ones issued so far. Keyed on the producer's own step
 * stamp, so it can't drift from the worker when a world is recreated (unlike a count of posted
 * messages, which MESSAGE_BATCH never reset — p059 D10). */
const getWriteVisibleStep = () => stepsIssued + 1;

/** Whether a write tagged with getWriteVisibleStep() hasn't reached the transform buffer yet.
 * Without any buffer (MESSAGE_BATCH before its first push) nothing has reached it. */
const isWritePending = (visibleAt: number) =>
  !transformBuffer || transformBuffer.getStepIndex() < visibleAt;

const messageWorker = (message: PhysicsUpProtocol) => {
  if (!worker) return;
  if (substepCommandCapture) {
    // Cloned now, as postMessage would: callers reuse scratch vectors (e.g. a platform's
    // kinematic target), and the STEP message is only cloned after every sub-step's systems
    // ran, so a captured reference would carry the last sub-step's value into all of them.
    substepCommandCapture.push(structuredClone(message));
    return;
  }
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

/** A request that runs where a one-way command would (messageWorker): inside an APP_PHYSICS_STEP
 * sub-step it's captured and replayed right before that sub-step, and the worker replies from
 * the replay. So what it does lands on a fixed step, not on the frame's first one (p352). */
const messageWorkerAtStep = async <T>(message: PhysicsUpProtocol) => {
  if (!substepCommandCapture) return messageWorkerAsync<T>(message);
  const capture = substepCommandCapture;
  return new Promise<T>((resolve) => {
    const requestId = createNewResolver(resolve);
    capture.push(structuredClone({ ...message, requestId }));
  });
};

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
    // The wrapper is built once per world and only re-pointed at each new copy after that.
    if (transformBuffer) transformBuffer.rebind(data.buffer);
    else transformBuffer = new PhysicsTransformBuffer(physicsState.maxBodies, data.buffer);
    // Step stats (p027) ride along on this message in MESSAGE_BATCH mode, so the receipt
    // time here is the return leg's real arrival time. Only present while measuring.
    if (data.stepDuration !== undefined) {
      lastPhysicsStepDurationMs = data.stepDuration;
      lastPhysicsMessagingLatency = {
        dispatchMs: data.dispatchMs ?? 0,
        writeBackMs: data.stepEndAt !== undefined ? performance.now() - data.stepEndAt : 0,
      };
      if (data.awakeBodies !== undefined && data.sleepingBodies !== undefined) {
        bodyActivity.awake = data.awakeBodies;
        bodyActivity.sleeping = data.sleepingBodies;
        hasBodyActivity = true;
      }
      // The panel shows the pure step time only — never step + messaging overhead.
      updatePhysicsPanel(data.stepDuration);
    }
    return;
  } else if (type === PhysicsProtocolType.EVENTS_PUSH) {
    // Unsolicited push, only ever sent when at least one event occurred that step — no
    // requestId, not a response to resolve.
    // Delivered by flushPhysicsEvents() at the start of the next sub-step, not right away.
    pendingEventPushes.push(data);
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

let pendingEventPushes: EventsPushMessage[] = [];

/**
 * Delivers every collision/contact-force event that has become available since the last call to
 * its registered callbacks. The main loop calls this once per fixed sub-step, after held-key
 * polling and before the APP_PHYSICS_STEP systems. Gameplay code depends on that order: e.g. on the
 * sub-step a character leaves a moving platform, its held-key move() still runs with the
 * pre-event "on platform" state (keeping the platform's velocity), and only the character tick
 * after it sees the ground sensor's "stopped touching". Dispatching straight after each step
 * would flip that state before move() and drop the platform's velocity from the jump.
 */
export const flushPhysicsEvents = () => {
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    engAPI?.dispatchPendingEventRecords();
    return;
  }
  if (!pendingEventPushes.length) return;
  const pushes = pendingEventPushes;
  pendingEventPushes = [];
  for (let i = 0; i < pushes.length; i++) dispatchPushedEvents(pushes[i]);
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

/** Whether holdPhysicsStepping() is in effect. */
let isSteppingHeld = false;

/**
 * Stops the world from stepping until releasePhysicsStepping() is called. SceneLoader.ts holds
 * it for the whole scene build, so every body of the next scene starts stepping on the same
 * step no matter how long its assets took to load. Counts as a pause for getPhysGameTime().
 */
export const holdPhysicsStepping = () => {
  if (isSteppingHeld) return;
  isSteppingHeld = true;
  if (!physicsState.isPaused) setPhysicsPauseTime();
  physicsState.isPaused = true;
  physicsState.pauseReason ??= 'SCENE_LOAD';
};

/**
 * Ends holdPhysicsStepping(). The next stepPhysics() call takes the resume-from-pause path: it
 * discards the dt spanning the hold and the accumulator and restarts the timer, so stepping
 * restarts from a clean step boundary. That also covers the first boot, where the loop only
 * starts after the first load.
 */
export const releasePhysicsStepping = () => {
  if (!isSteppingHeld) return;
  isSteppingHeld = false;
  if (physicsState.pauseReason === 'SCENE_LOAD') physicsState.pauseReason = null;
};

export const isPhysicsSteppingHeld = () => isSteppingHeld;

// Physics step accumulator variables
let timerRunning = true;
let accDelta = 0;
const timer = new THREE.Timer();
const updateTimer = () => {
  if (timerRunning) {
    timer.update();
  }
};

// --- Simulated-time clock + snapshot stamps (render interpolation, p059) ---
// Everything here is measured in fixed steps (1 = one timestepRatio of simulated time), so the
// stamps are integers and nothing drifts.

/** Fixed steps issued to the current world since it was created (MAIN_THREAD: stepped;
 * WORKER_THREAD: sent in STEP messages, possibly not executed yet). */
let stepsIssued = 0;
/** Fixed steps issued since boot, over every world (never reset, unlike stepsIssued). */
let subStepTotal = 0;
/** Bumped whenever the simulated-time clock is discontinuous: the accumulator is discarded
 * (pause → resume, maxSubSteps overflow) or the world is replaced. */
let simClockEpoch = 0;
/** Bumped whenever earlier snapshots stop describing the current world (world created/deleted,
 * snapshot restored), so pose histories captured before it must be thrown away. */
let simHistoryEpoch = 0;

// The clock phase each issued batch was stamped with, keyed by the step index its snapshot
// will carry. Only the phase lives here — the step index itself comes from the producer
// (PhysicsTransformBuffer.getStepIndex() on WORKER_THREAD), which can't know the main thread's
// accumulator. 64 steps is over a second of in-flight worker latency at 60Hz; a snapshot older
// than that just gets phase 0.
const SNAPSHOT_PHASE_RING_SIZE = 64;
const snapshotPhaseStep = new Float64Array(SNAPSHOT_PHASE_RING_SIZE).fill(-1);
const snapshotPhase = new Float64Array(SNAPSHOT_PHASE_RING_SIZE);

/** Counts the steps stepPhysics() just issued and records the accumulator's leftover fraction
 * of a step at that moment (the phase of the continuous clock when this batch was issued). */
const stampStepBatch = (stepsTaken: number) => {
  stepsIssued += stepsTaken;
  subStepTotal += stepsTaken;
  const i = stepsIssued % SNAPSHOT_PHASE_RING_SIZE;
  snapshotPhaseStep[i] = stepsIssued;
  snapshotPhase[i] = physicsState.timestepRatio > 0 ? accDelta / physicsState.timestepRatio : 0;
};

/** A new world starts a new simulated timeline: the step count restarts with it (as the
 * worker's own count does at CREATE_WORLD). */
const resetSimClock = () => {
  stepsIssued = 0;
  // A gate's step is the old world's: it would hold the new one at a step it has nothing for
  stepGates.clear();
  noteStepGateHeld(false);
  snapshotPhaseStep.fill(-1);
  simClockEpoch++;
  simHistoryEpoch++;
};

/** Latches the newest physics snapshot for this frame (p063). Called by MainLoop at the very
 * start of every frame, before any stage, held-key polling, APP_PHYSICS_STEP or event callback
 * reads a pose, so all of them see the same complete snapshot. Only SHARED_MEMORY has anything
 * to latch (the worker writes it concurrently); a write-back that lands mid-frame waits for the
 * next frame. MAIN_THREAD and MESSAGE_BATCH are already consistent, and this is a no-op there. */
export const latchPhysicsSnapshot = () => {
  transformBuffer?.latch();
};

/** Step index of the latest physics snapshot readable on the main thread — how many steps had
 * been executed on the current world when its poses were captured (0 before the first one).
 * MAIN_THREAD steps synchronously, so it is simply the steps issued; WORKER_THREAD reads the
 * stamp the worker writes into the transform buffer with every write-back. Changes exactly when
 * a new snapshot becomes visible, and only ever increases within one world. */
export const getPhysicsSnapshotStepIndex = () =>
  physicsState.workerTarget === 'WORKER_THREAD'
    ? transformBuffer?.getStepIndex() ?? 0
    : stepsIssued;

/** The snapshot step index from which a pose/velocity write made right now shows up in the
 * snapshots (see getPhysicsSnapshotStepIndex) — anything stamped earlier predates it. */
export const getPhysicsWriteVisibleStep = () => getWriteVisibleStep();

/** Stamp of the latest visible snapshot: `step` = getPhysicsSnapshotStepIndex(), `phase` = the
 * accumulator's fraction of a step when its batch was issued (0 if no longer known). Returns
 * false before the first snapshot. Writes into `out`, allocation-free. */
export const readPhysicsSnapshotStamp = (out: { step: number; phase: number }): boolean => {
  const step = getPhysicsSnapshotStepIndex();
  if (step <= 0) return false;
  const i = step % SNAPSHOT_PHASE_RING_SIZE;
  out.step = step;
  out.phase = snapshotPhaseStep[i] === step ? snapshotPhase[i] : 0;
  return true;
};

/** The stepper's continuous simulated-time clock, in fixed steps: steps issued to the current
 * world plus the accumulator's fraction of the next one. Advances by exactly what stepPhysics()
 * accumulates, so the render clock can move on the very same number (never a separate timer). */
export const getPhysicsSimClock = () =>
  physicsState.timestepRatio > 0
    ? stepsIssued + accDelta / physicsState.timestepRatio
    : stepsIssued;

/** See simClockEpoch: changes whenever getPhysicsSimClock() jumps. */
export const getPhysicsSimClockEpoch = () => simClockEpoch;

/** See simHistoryEpoch: changes whenever earlier snapshots stop describing the current world. */
export const getPhysicsSimHistoryEpoch = () => simHistoryEpoch;

/** Absolute step index (in stepsIssued) stepPhysics() never steps past; null = no limit. */
let stepLimit: number | null = null;

/**
 * Debug only (a no-op returning null outside IS_DEBUG_ENV): freezes the simulation after
 * `steps` more fixed steps, in both worker targets, until called again with null. Returns the
 * step index it freezes at, which is what getPhysicsSnapshotStepIndex() reads once the frozen
 * pose is visible (WORKER_THREAD mode gets there a frame or more later than MAIN_THREAD).
 * Used by the physics determinism probe (_dbg__PhysicsDeterminism.ts).
 */
export const setPhysicsStepLimit = (steps: number | null) => {
  if (!IS_DEBUG_ENV) return null;
  stepLimit = steps === null ? null : stepsIssued + Math.max(0, Math.floor(steps));
  return stepLimit;
};

/** The sub-step stepPhysics() is in (see getPhysicsSubStepIndex), -1 outside of one. */
let subStepIndex = -1;

/**
 * Inside a sub-step's `APP_PHYSICS_STEP` systems (stepPhysics' onBeforeStep), the index of the
 * fixed step about to run: the steps run on the current world before it, the same in both worker
 * targets. The first step of a world is 0, and a write made in step `k` is in the snapshot
 * stamped `k + 1` (getPhysicsSnapshotStepIndex) and after. -1 outside a sub-step. A step clock
 * for systems that must decide on fixed steps (p343: the deterministic tier policy).
 */
export const getPhysicsSubStepIndex = () => subStepIndex;

/** Held step gates (addPhysicsStepGate): gate id → the step index they hold stepping before. */
const stepGates = new Map<number, number>();
let nextStepGateId = 1;

const getLowestStepGate = () => {
  if (!stepGates.size) return Infinity;
  let lowest = Infinity;
  for (const step of stepGates.values()) if (step < lowest) lowest = step;
  return lowest;
};

/** How often and how long gates held stepping back (getPhysicsStepGateStats). */
const stepGateStats = { waits: 0, heldMs: 0 };
let stepGateHeldSince: number | null = null;

/** Called by stepPhysics: `held` when a gate cut a frame's steps, false once a frame wasn't. */
const noteStepGateHeld = (held: boolean) => {
  if (held) {
    if (stepGateHeldSince !== null) return;
    stepGateHeldSince = performance.now();
    stepGateStats.waits++;
    return;
  }
  if (stepGateHeldSince === null) return;
  stepGateStats.heldMs += performance.now() - stepGateHeldSince;
  stepGateHeldSince = null;
};

/**
 * Whether sub-step `i` of a batch of `stepsTaken` is held by a gate an earlier sub-step of the
 * same batch added (p343: a measurement whose reply its decision step needs). The batch then ends
 * before it, and its remaining steps go back to the accumulator, to run once the gate opens.
 */
const isSubStepGated = (i: number, stepsTaken: number) => {
  if (!stepGates.size || stepsIssued + i < getLowestStepGate()) return false;
  accDelta += (stepsTaken - i) * physicsState.timestepRatio;
  noteStepGateHeld(true);
  return true;
};

/**
 * Holds stepping before the fixed step `step` (a getPhysicsSubStepIndex index): stepPhysics()
 * issues no sub-step with an index of `step` or more until the returned function is called. With
 * several gates the lowest holds. For work that must finish before a given step runs, eg. a worker
 * reply a decision on that step needs (p343). A gate at a step already issued holds from the next.
 * One added by an `APP_PHYSICS_STEP` system also cuts the frame's batch it was added in.
 *
 * Unlike the debug step limit, time keeps accumulating while a gate holds, so a short hold is
 * caught up on the next frames (at most `maxSubSteps` steps of it; more is dropped as a frame over
 * the ceiling would). A new physics world (a scene load) drops every gate, and their release
 * functions do nothing then.
 */
export const addPhysicsStepGate = (step: number): (() => void) => {
  const id = nextStepGateId++;
  stepGates.set(id, step);
  return () => {
    stepGates.delete(id);
  };
};

/**
 * Since boot: `waits`, how many times a gate held back steps that were due, and `heldMs`, for how
 * long in total (wall clock, until a frame stepped without being cut). A hold still going counts
 * up to now.
 */
export const getPhysicsStepGateStats = () => ({
  waits: stepGateStats.waits,
  heldMs:
    stepGateStats.heldMs + (stepGateHeldSince === null ? 0 : performance.now() - stepGateHeldSince),
});

/**
 * Fixed physics sub-steps issued since boot, over every world (WORKER_THREAD: sent, possibly not
 * executed yet). Never reset, so the difference of two reads is the sub-steps in between, eg. per
 * frame (a count near maxSubSteps warns of the spiral of death).
 * @returns (number) sub-step count
 */
export const getPhysicsSubStepTotal = () => subStepTotal;

/**
 * How many physics objects the current world has (counted on the main thread, both worker
 * targets).
 * @returns ({ bodies: number; colliders: number; joints: number })
 */
export const getPhysicsObjectCounts = () => ({
  bodies: rigidBodies.size,
  colliders: colliders.size,
  joints: joints.size,
});

/** Returns the current physicsState */
export const getPhysicsState = () => physicsState;

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
    resetSimClock();
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
      resetSimClock();
      resolvedTransportMode = response.transportMode;
      if (response.transportMode === 'SHARED_MEMORY' && response.buffer) {
        transformBuffer = new PhysicsTransformBuffer(
          physicsState.maxBodies,
          response.buffer,
          response.bankCount ?? 1
        );
        pendingEventPushes = [];
      } else {
        // MESSAGE_BATCH: a previous world's last pushed copy must never be read as this one's.
        transformBuffer = undefined;
      }
      // Handed over in SHARED_MEMORY mode (p027), whatever stepStatsEnabled is, so the flag can
      // be switched at runtime (setPhysicsStepStatsEnabled). A fresh one per world.
      stepStatsFloats = response.statsBuffer
        ? new Float64Array(response.statsBuffer, 0, PHYSICS_STEP_STATS_FIELD_COUNT)
        : undefined;
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

/**
 * Ordering barrier. WORKER_THREAD: resolves once the worker has handled every message posted
 * before this call (including fire-and-forget deletes). MAIN_THREAD: everything already ran
 * synchronously, so it resolves right away.
 */
export const flushPhysics = async () => {
  if (physicsState.workerTarget !== 'WORKER_THREAD' || !worker) return;
  await messageWorkerAsync<FlushResponse>({ type: PhysicsProtocolType.FLUSH });
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
    // Reset. Every API object and callback belonged to the deleted world. Keeps the settings
    // in physicsState (gravity, solver iterations, timestep), which the next world is built from.
    physicsWorldEnabled = false;
    physicsWorld = { step: () => {} } as unknown as WorldAPI;
    rigidBodies.clear();
    colliders.clear();
    joints.clear();
    workerCollisionEventFns.clear();
    workerContactForceEventFns.clear();
    pendingEventPushes = [];
    transformBuffer = undefined;
    accDelta = 0;
    simClockEpoch++;
    simHistoryEpoch++;
  } else {
    lerror('Could not delete physics world.');
  }
};

/**
 * Replaces the physics world with a new, empty one built from the current physicsState
 * settings (so debug-tab edits carry over). SceneLoader.ts calls this on every scene load:
 * a reused world keeps Rapier's internal history (freed handle slots, broadphase, contact
 * graph, islands), which makes the same scene simulate differently on a revisit.
 * Delete every physics entity first; anything still referencing the old world goes stale.
 */
export const resetPhysicsWorld = async () => {
  if (!physicsWorldEnabled) return;
  // Lets in-flight deletes of the previous scene's bodies finish against the old world
  await flushPhysics();
  await deletePhysicsWorld();
  await createPhysicsWorld();
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
  // Every body may have jumped: earlier poses no longer lead up to the restored ones.
  simClockEpoch++;
  simHistoryEpoch++;
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
      params: toWireRigidBodyParams(params),
    });
    throwIfCapacityExceeded(res.capacityExceeded);
    const rbAPI = new RigidBodyProxyAPI(
      res.id,
      res.slot,
      params.userData,
      res.pose
    ) as RigidBodyAPI;
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
    const rbAPIs = existsOrThrow(
      engAPI?.createRigidBodies(params),
      `Could not create a rigid bodies ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    for (const rbAPI of rbAPIs) rigidBodies.set(rbAPI.id, rbAPI);
    return rbAPIs;
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const res = await messageWorkerAsync<CreateRigidBodiesResponse>({
      type: PhysicsProtocolType.CREATE_RIGID_BODIES,
      params,
    });
    throwIfCapacityExceeded(res.capacityExceeded);
    existsOrThrow(
      res.ids.length,
      `Could not create a rigid bodies ("WORKER_THREAD"). Params: ${JSON.stringify(params)}`
    );
    const rbAPIs = [];
    for (let i = 0; i < res.ids.length; i++) {
      const id = res.ids[i];
      const rbAPI = new RigidBodyProxyAPI(id, res.slots[i], params[i].userData, res.poses[i]);
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
    const rbAPIs = existsOrThrow(
      engAPI?.createRigidBodies(params),
      `Could not create a rigid bodies ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    for (const rbAPI of rbAPIs) rigidBodies.set(rbAPI.id, rbAPI);
    return rbAPIs;
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

/** Deletes a rigid body (and all child colliders). Returns the id of the deleted rigidBodyAPI,
 * or undefined (a quiet no-op) if there is no world or no body with that id, e.g. a late delete
 * of a body whose world has already been replaced (resetPhysicsWorld). */
export const deleteRigidBody = async (id: number) => {
  if (!physicsWorldEnabled || !rigidBodies.has(id)) return undefined;
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

/**
 * Engine internal, for the REMOVED physics tier (p352, PhysicsTiers.ts): takes a body and its
 * colliders out of the world with their state, ids and proxies kept (engine side), and frees
 * its transform-buffer slot. Resolves with its pose, or undefined when nothing was detached or
 * a later detach/reattach of the body has overtaken this one. In WORKER_THREAD mode, called
 * from an APP_PHYSICS_STEP system, it runs right before that sub-step.
 */
export const detachRigidBody = async (id: number): Promise<RigidBodyPose | undefined> => {
  if (!physicsWorldEnabled) return undefined;
  if (physicsState.workerTarget === 'MAIN_THREAD') return detachRigidBodySync(id);
  const rb = rigidBodies.get(id);
  if (!(rb instanceof RigidBodyProxyAPI)) return undefined;
  const generation = rb._detach();
  const res = await messageWorkerAtStep<RigidDetachResponse>({
    type: PhysicsProtocolType.RIGID_DETACH,
    id,
  });
  return rb._isAttachGeneration(generation) ? res.pose : undefined;
};

/** detachRigidBody (sync). Only for main thread mode. */
export const detachRigidBodySync = (id: number) => {
  if (physicsState.workerTarget !== 'MAIN_THREAD') {
    throw new Error('Cannot use detachRigidBodySync in worker mode. Use detachRigidBody instead.');
  }
  return physicsWorldEnabled ? engAPI?.detachRigidBody(id) : undefined;
};

/**
 * Engine internal (p352): puts a detached body (detachRigidBody) back, as it was detached
 * except for `state`. Resolves with its pose, or undefined when it wasn't detached or a later
 * detach/reattach has overtaken this one. Rejects with a PhysicsCapacityError when a
 * WORKER_THREAD world's transform buffer is full: the body stays detached. Runs at the sub-step
 * like detachRigidBody.
 */
export const reattachRigidBody = async (
  id: number,
  state: RigidBodyAttachState
): Promise<RigidBodyPose | undefined> => {
  if (!physicsWorldEnabled) return undefined;
  if (physicsState.workerTarget === 'MAIN_THREAD') return reattachRigidBodySync(id, state);
  const rb = rigidBodies.get(id);
  if (!(rb instanceof RigidBodyProxyAPI)) return undefined;
  const generation = rb._beginReattach();
  const res = await messageWorkerAtStep<RigidReattachResponse>({
    type: PhysicsProtocolType.RIGID_REATTACH,
    id,
    state,
  });
  if (!rb._isAttachGeneration(generation)) return undefined;
  throwIfCapacityExceeded(res.capacityExceeded);
  if (!res.pose) return undefined;
  rb._attach(res.slot, res.pose);
  return res.pose;
};

/** reattachRigidBody (sync). Only for main thread mode, which has no capacity limit. */
export const reattachRigidBodySync = (id: number, state: RigidBodyAttachState) => {
  if (physicsState.workerTarget !== 'MAIN_THREAD') {
    throw new Error(
      'Cannot use reattachRigidBodySync in worker mode. Use reattachRigidBody instead.'
    );
  }
  return physicsWorldEnabled ? engAPI?.reattachRigidBody(id, state) : undefined;
};

/**
 * The bodies' translations (x, y, z per id, in order; NaN for an unknown id; a REMOVED-tier body
 * where it was taken out), read on a fixed step: called from an APP_PHYSICS_STEP system, they
 * are read right before that sub-step runs, in both worker targets, so both get the same values
 * (Rapier's own f32). MAIN_THREAD reads at the call; WORKER_THREAD resolves with the worker's
 * reply, a frame or more later. Outside a sub-step the worker reads before the frame's first
 * step. Without a world it resolves with NaNs. For p343's deterministic tier policy.
 */
export const readBodyPositionsAtStep = async (ids: number[]): Promise<Float32Array> => {
  if (!physicsWorldEnabled) return new Float32Array(ids.length * 3).fill(NaN);
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    return readBodyPositionsSync(ids, new Float32Array(ids.length * 3));
  }
  const res = await messageWorkerAtStep<RigidReadPositionsResponse>({
    type: PhysicsProtocolType.RIGID_READ_POSITIONS,
    ids,
  });
  return res.positions;
};

/** readBodyPositionsAtStep (sync), into `out` (3 floats per id). Only for main thread mode. */
export const readBodyPositionsSync = (ids: ArrayLike<number>, out: Float32Array) => {
  if (physicsState.workerTarget !== 'MAIN_THREAD') {
    throw new Error(
      'Cannot use readBodyPositionsSync in worker mode. Use readBodyPositionsAtStep instead.'
    );
  }
  if (!physicsWorldEnabled || !engAPI) return out.fill(NaN);
  return engAPI.readBodyPositions(ids, out);
};

/** A RigidBodyParams for the postMessage boundary: its rotation as a plain object (a
 * THREE.Quaternion would arrive without x/y/z/w, see toPlainRot). Returns the original object
 * when it has no rotation. */
const toWireRigidBodyParams = <T extends RigidBodyParams | undefined>(params: T): T =>
  params?.rotation ? { ...params, rotation: toPlainRot(params.rotation) } : params;

/** Strips collisionEventFn/contactForceEventFn from a ColliderParams before it crosses
 * the postMessage boundary (functions can't be structured-cloned — this is what would
 * otherwise throw DataCloneError), replacing them with the boolean flags EngineRapier.ts
 * uses to still set up the right Rapier ActiveEvents on the worker side, and makes its
 * rotation a plain object (toPlainRot). Returns the original object unchanged when there's
 * nothing to change. */
const toWireColliderParams = (colliderParams: ColliderParams): ColliderParams => {
  const params = colliderParams.rotation
    ? { ...colliderParams, rotation: toPlainRot(colliderParams.rotation) }
    : colliderParams;
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

/** What createRigidBodyWithColliders() creates. */
export type RigidBodyWithColliders = { rigidBody?: RigidBodyAPI; colliders: ColliderAPI[] };

/**
 * Creates an optional rigid body and its colliders together (with a body, every collider's
 * parentId is set to it). In WORKER_THREAD mode this is one message, posted synchronously by
 * this call: the worker creates everything in the order these calls were made (like
 * MAIN_THREAD does), and no step can ever run between a body and its colliders.
 */
export const createRigidBodyWithColliders = async (
  rigidBodyParams: RigidBodyParams | undefined,
  colliderParams: ColliderParams[]
): Promise<RigidBodyWithColliders> => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a rigid body or colliders.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    return createRigidBodyWithCollidersSync(rigidBodyParams, colliderParams);
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const res = await messageWorkerAsync<CreatePhysicsEntityResponse>({
      type: PhysicsProtocolType.CREATE_PHYSICS_ENTITY,
      rigidBody: toWireRigidBodyParams(rigidBodyParams),
      colliders: colliderParams.map(toWireColliderParams),
    });
    throwIfCapacityExceeded(res.capacityExceeded);
    let rigidBody: RigidBodyAPI | undefined;
    if (rigidBodyParams && res.id !== undefined) {
      rigidBody = new RigidBodyProxyAPI(
        res.id,
        res.slot,
        rigidBodyParams.userData,
        res.pose
      ) as RigidBodyAPI;
      rigidBodies.set(res.id, rigidBody);
    }
    const collAPIs: ColliderAPI[] = [];
    for (let i = 0; i < res.colliderIds.length; i++) {
      const id = res.colliderIds[i];
      const params = colliderParams[i];
      const collAPI = new ColliderProxyAPI(
        id,
        rigidBody?.id ?? params.parentId,
        params.userData
      ) as ColliderAPI;
      collAPIs.push(collAPI);
      colliders.set(id, collAPI);
      registerWorkerColliderEventFns(id, params);
    }
    return { rigidBody, colliders: collAPIs };
  }
  // Should not get here..
  throw new Error(
    `Could not create a rigid body with colliders (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** createRigidBodyWithColliders() (sync). Only for main thread mode. */
export const createRigidBodyWithCollidersSync = (
  rigidBodyParams: RigidBodyParams | undefined,
  colliderParams: ColliderParams[]
): RigidBodyWithColliders => {
  const rigidBody = rigidBodyParams ? createRigidBodySync(rigidBodyParams) : undefined;
  const params = rigidBody
    ? colliderParams.map((p) => ({ ...p, parentId: rigidBody.id }))
    : colliderParams;
  return { rigidBody, colliders: params.length ? createCollidersSync(params) : [] };
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
    const collAPIs = existsOrThrow(
      engAPI?.createColliders(params),
      `Could not create colliders ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    // Registered like in WORKER_THREAD mode: deleteColliders skips ids it doesn't know
    for (const coll of collAPIs) colliders.set(coll.id, coll);
    return collAPIs;
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
    const collAPIs = existsOrThrow(
      engAPI?.createColliders(params),
      `Could not create colliders ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
    // Registered like in WORKER_THREAD mode: deleteColliders skips ids it doesn't know
    for (const coll of collAPIs) colliders.set(coll.id, coll);
    return collAPIs;
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

/** Deletes multiple colliders. Returns the ids of the deleted colliderAPIs. Unknown ids are
 * skipped quietly, and without a world nothing happens (see deleteRigidBody). */
export const deleteColliders = async (allIds: number[], allWakeUps?: boolean[]) => {
  if (!physicsWorldEnabled) return [];
  const ids: number[] = [];
  const wakeUps: boolean[] | undefined = allWakeUps ? [] : undefined;
  for (let i = 0; i < allIds.length; i++) {
    if (!colliders.has(allIds[i])) continue;
    ids.push(allIds[i]);
    wakeUps?.push(allWakeUps![i]);
  }
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
    const jointProxy = new JointProxyAPI(
      res.id,
      params.body1Id,
      params.body2Id,
      params.userData
    ) as JointAPI;
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

/** Calls `fn` with the two body ids of every live impulse joint, synchronously in both worker
 * targets (p352's joint groups). */
export const forEachJointBodyPair = (fn: (body1Id: number, body2Id: number) => void) => {
  for (const joint of joints.values()) fn(joint.body1IdSync(), joint.body2IdSync());
};

/** Whether any impulse joint exists, so a joint walk can be skipped. */
export const hasJoints = () => joints.size > 0;

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
 * per object per frame.
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
  // Each query reports to the query observer captured when it was issued: onQuery before the
  // message, onResult when the reply arrives (≥1 frame later). `debug` never crosses to the
  // worker.
  async castRay(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    _filterPredicate?: (collider: ColliderAPI) => boolean,
    debug?: RayDebugOpts
  ): Promise<RayColliderHitAPI | null> {
    const observer = queryObserver;
    const token = observer ? observer.onQuery('CAST_RAY', ray.origin, ray.dir, maxToi, debug) : 0;
    const response = (
      await messageWorkerAsync<WorldCastRayResponse>({
        type: PhysicsProtocolType.WORLD_CAST_RAY,
        ray,
        maxToi,
        solid,
        filterFlags,
        filterGroups,
        filterExcludeCollider: getCollOrRigidId(filterExcludeCollider),
        filterExcludeRigidBody: getCollOrRigidId(filterExcludeRigidBody),
      })
    ).hit;
    const coll = response ? colliders.get(response.collider) : undefined;
    const result = response && coll ? { ...response, collider: coll } : null;
    if (observer) observer.onResult(token, result ? result.timeOfImpact : null, result ? 1 : 0);
    return result;
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
    filterExcludeRigidBody?: RigidBodyAPI | number,
    _filterPredicate?: (collider: ColliderAPI) => boolean,
    debug?: RayDebugOpts
  ): Promise<ShapeCastHitAPI | null> {
    const observer = queryObserver;
    const token = observer ? observer.onQuery('CAST_SHAPE', shapePos, shapeVel, maxToi, debug) : 0;
    const response = (
      await messageWorkerAsync<WorldCastShapeResponse>({
        type: PhysicsProtocolType.WORLD_CAST_SHAPE,
        shapePos,
        shapeRot: toPlainRot(shapeRot),
        shapeVel,
        shape,
        targetDistance,
        maxToi,
        stopAtPenetration,
        filterFlags,
        filterGroups,
        filterExcludeCollider: getCollOrRigidId(filterExcludeCollider),
        filterExcludeRigidBody: getCollOrRigidId(filterExcludeRigidBody),
      })
    ).hit;
    const coll = response ? colliders.get(response.collider) : undefined;
    const result = response && coll ? { ...response, collider: coll } : null;
    if (observer) observer.onResult(token, result ? result.timeOfImpact : null, result ? 1 : 0);
    return result;
  }

  castShapeSync(): ShapeCastHitAPI | null {
    throw new Error('Shape casting must be async in Worker mode.');
  }

  async castRayAndGetNormal(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI,
    filterExcludeCollider?: ColliderAPI | number,
    filterExcludeRigidBody?: RigidBodyAPI | number,
    _filterPredicate?: (collider: ColliderAPI) => boolean,
    debug?: RayDebugOpts
  ): Promise<RayColliderIntersectionAPI | null> {
    const observer = queryObserver;
    const token = observer
      ? observer.onQuery('CAST_RAY_AND_GET_NORMAL', ray.origin, ray.dir, maxToi, debug)
      : 0;
    const intersection = (
      await messageWorkerAsync<WorldCastRayAndGetNormalResponse>({
        type: PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL,
        ray,
        maxToi,
        solid,
        filterFlags,
        filterGroups,
        filterExcludeCollider: getCollOrRigidId(filterExcludeCollider),
        filterExcludeRigidBody: getCollOrRigidId(filterExcludeRigidBody),
      })
    ).intersection;
    const coll = intersection ? colliders.get(intersection.collider) : undefined;
    const result = intersection && coll ? { ...intersection, collider: coll } : null;
    if (observer) observer.onResult(token, result ? result.timeOfImpact : null, result ? 1 : 0);
    return result;
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
    filterExcludeRigidBody?: RigidBodyAPI | number,
    _filterPredicate?: (collider: ColliderAPI) => boolean,
    debug?: RayDebugOpts
  ): Promise<void> {
    const observer = queryObserver;
    const token = observer
      ? observer.onQuery('INTERSECTIONS_WITH_RAY', ray.origin, ray.dir, maxToi, debug)
      : 0;
    const intersections = (
      await messageWorkerAsync<WorldIntersectionsWithRayResponse>({
        type: PhysicsProtocolType.WORLD_INTERSECTIONS_WITH_RAY,
        ray,
        maxToi,
        solid,
        filterFlags,
        filterGroups,
        filterExcludeCollider: getCollOrRigidId(filterExcludeCollider),
        filterExcludeRigidBody: getCollOrRigidId(filterExcludeRigidBody),
      })
    ).intersections;
    let hitCount = 0;
    let firstHitToi = Infinity;
    for (let i = 0; i < intersections.length; i++) {
      const intersectTransfer = intersections[i];
      const collider = colliders.get(intersectTransfer.collider);
      if (!collider) continue;
      hitCount++;
      if (intersectTransfer.timeOfImpact < firstHitToi) {
        firstHitToi = intersectTransfer.timeOfImpact;
      }
      // The worker collects every hit, so `false` (stop) is applied here, as on MAIN_THREAD
      if (callback({ ...intersectTransfer, collider }) === false) break;
    }
    if (observer) observer.onResult(token, hitCount ? firstHitToi : null, hitCount);
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
    _filterPredicate?: (collider: ColliderAPI) => boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _debug?: RayDebugOpts
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

type PendingWrite<T> = { value: T; visibleAt: number };

class RigidBodyProxyAPI implements RigidBodyWorkerEngine {
  uData: Record<string, unknown> = {};
  isBeingDeleted: boolean = false;
  // @CHORE: add isEnabled cache

  // Read-your-writes: a value set here reaches the worker (and then the transform buffer) only
  // a step or more later, but code like a character controller sets a velocity and reads it back
  // within the same sub-step — as it can on MAIN_THREAD, where Rapier applies it immediately.
  // Until the buffer catches up, the reads below return what was last written instead of the
  // stale buffer value (which would otherwise make e.g. a later setLinvel silently undo an
  // earlier one, or an impulse).
  private pendingPos?: PendingWrite<PhysVector>;
  private pendingRot?: PendingWrite<PhysRotation>;
  private pendingLvel?: PendingWrite<PhysVector>;
  private pendingAvel?: PendingWrite<PhysVector>;
  /** Last known mass, for reflecting applyImpulse locally (refreshed by every mass() call) */
  private cachedMass?: number;
  /** A body without a slot (created FIXED, p352) is never written back: it keeps its pose here
   * instead, its creation pose updated by every setTranslation/setRotation, for good. */
  private staticPose?: RigidBodyPose;

  constructor(
    public id: number,
    private slot: number,
    userData?: Record<string, unknown>,
    /** The pose the worker reported at creation. Read until the first transform write-back
     * that includes this body, which (without SAB) can arrive a frame or more later, and
     * until then the slot holds zeros or a deleted body's last pose. */
    initialPose?: RigidBodyPose
  ) {
    if (userData) this.uData = userData;
    if (initialPose && slot === -1) {
      this.staticPose = { pos: { ...initialPose.pos }, rot: { ...initialPose.rot } };
    } else if (initialPose) {
      const visibleAt = getWriteVisibleStep();
      this.pendingPos = { value: { ...initialPose.pos }, visibleAt };
      this.pendingRot = { value: { ...initialPose.rot }, visibleAt };
    }
  }

  /** Whether the body holds a transform-buffer slot (every body not created FIXED, unless it's
   * detached by the REMOVED physics tier). */
  get hasSlot() {
    return this.slot !== -1;
  }

  /** Bumped by every detach and reattach (p352), so a reply to an older one is ignored. */
  private attachGeneration = 0;

  /** @internal detachRigidBody: the slot is the worker's to reuse from now on. Returns the
   * detach's generation. */
  _detach() {
    this.slot = -1;
    this.pendingPos = undefined;
    this.pendingRot = undefined;
    this.pendingLvel = undefined;
    this.pendingAvel = undefined;
    return ++this.attachGeneration;
  }

  /** @internal reattachRigidBody, before its request. Returns the reattach's generation. */
  _beginReattach() {
    return ++this.attachGeneration;
  }

  /** @internal Whether no detach/reattach has been requested since `generation`'s. */
  _isAttachGeneration(generation: number) {
    return this.attachGeneration === generation;
  }

  /** @internal reattachRigidBody's reply: the new slot, and its pose read until a transform
   * write-back includes it (as at creation). */
  _attach(slot: number, pose: RigidBodyPose) {
    this.slot = slot;
    const visibleAt = getWriteVisibleStep();
    this.pendingPos = { value: { ...pose.pos }, visibleAt };
    this.pendingRot = { value: { ...pose.rot }, visibleAt };
  }

  // Hot path — reads straight from the shared/latest-pushed transform buffer by slot.
  // Returns zeroed defaults if no buffer has arrived yet (before the first step/push).
  get pos(): PhysVector {
    if (this.staticPose) return { ...this.staticPose.pos };
    if (this.pendingPos) {
      if (isWritePending(this.pendingPos.visibleAt)) return { ...this.pendingPos.value };
      this.pendingPos = undefined;
    }
    if (!transformBuffer || this.slot === -1) return { x: 0, y: 0, z: 0 };
    return transformBuffer.getPosition(this.slot);
  }
  get rot(): PhysRotation {
    if (this.staticPose) return { ...this.staticPose.rot };
    if (this.pendingRot) {
      if (isWritePending(this.pendingRot.visibleAt)) return { ...this.pendingRot.value };
      this.pendingRot = undefined;
    }
    if (!transformBuffer || this.slot === -1) return { x: 0, y: 0, z: 0, w: 0 };
    return transformBuffer.getRotation(this.slot);
  }
  readPoseInto(out: PoseArray, offset = 0): void {
    const staticPose = this.staticPose;
    if (staticPose) {
      out[offset] = staticPose.pos.x;
      out[offset + 1] = staticPose.pos.y;
      out[offset + 2] = staticPose.pos.z;
      out[offset + 3] = staticPose.rot.x;
      out[offset + 4] = staticPose.rot.y;
      out[offset + 5] = staticPose.rot.z;
      out[offset + 6] = staticPose.rot.w;
      return;
    }
    if (this.pendingPos && !isWritePending(this.pendingPos.visibleAt)) this.pendingPos = undefined;
    if (this.pendingRot && !isWritePending(this.pendingRot.visibleAt)) this.pendingRot = undefined;
    if (transformBuffer && this.slot !== -1) {
      transformBuffer.readPoseInto(this.slot, out, offset);
    } else {
      // Same zeroed defaults as the pos/rot getters before the first step/push
      for (let i = 0; i < 7; i++) out[offset + i] = 0;
    }
    const p = this.pendingPos?.value;
    if (p) {
      out[offset] = p.x;
      out[offset + 1] = p.y;
      out[offset + 2] = p.z;
    }
    const r = this.pendingRot?.value;
    if (r) {
      out[offset + 3] = r.x;
      out[offset + 4] = r.y;
      out[offset + 5] = r.z;
      out[offset + 6] = r.w;
    }
  }
  readVelocitiesInto(out: PoseArray, offset = 0): void {
    if (this.pendingLvel && !isWritePending(this.pendingLvel.visibleAt)) {
      this.pendingLvel = undefined;
    }
    if (this.pendingAvel && !isWritePending(this.pendingAvel.visibleAt)) {
      this.pendingAvel = undefined;
    }
    if (transformBuffer && this.slot !== -1) {
      transformBuffer.readVelocitiesInto(this.slot, out, offset);
    } else {
      // Same zeroed defaults as the lvel/avel getters before the first step/push
      for (let i = 0; i < 6; i++) out[offset + i] = 0;
    }
    const l = this.pendingLvel?.value;
    if (l) {
      out[offset] = l.x;
      out[offset + 1] = l.y;
      out[offset + 2] = l.z;
    }
    const a = this.pendingAvel?.value;
    if (a) {
      out[offset + 3] = a.x;
      out[offset + 4] = a.y;
      out[offset + 5] = a.z;
    }
  }
  get lvel(): PhysVector {
    if (this.pendingLvel) {
      if (isWritePending(this.pendingLvel.visibleAt)) return { ...this.pendingLvel.value };
      this.pendingLvel = undefined;
    }
    if (!transformBuffer || this.slot === -1) return { x: 0, y: 0, z: 0 };
    return transformBuffer.getLinvel(this.slot);
  }
  get avel(): PhysVector {
    if (this.pendingAvel) {
      if (isWritePending(this.pendingAvel.visibleAt)) return { ...this.pendingAvel.value };
      this.pendingAvel = undefined;
    }
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
    if (this.staticPose) {
      const pos = this.staticPose.pos;
      pos.x = tra.x;
      pos.y = tra.y;
      pos.z = tra.z;
    } else {
      this.pendingPos = {
        value: { x: tra.x, y: tra.y, z: tra.z },
        visibleAt: getWriteVisibleStep(),
      };
    }
    bodyMovedListener?.(this.id);
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_TRANSLATION,
      rigidBodyId: this.id,
      tra,
      wakeUp,
    });
  }

  setLinvel(vel: PhysVector, wakeUp: boolean): void {
    this.pendingLvel = {
      value: { x: vel.x, y: vel.y, z: vel.z },
      visibleAt: getWriteVisibleStep(),
    };
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
    if (this.staticPose) {
      this.staticPose.rot = toPlainRot(rot);
    } else {
      this.pendingRot = { value: toPlainRot(rot), visibleAt: getWriteVisibleStep() };
    }
    bodyMovedListener?.(this.id);
    return messageWorker({
      type: PhysicsProtocolType.RIGID_SET_ROTATION,
      rigidBodyId: this.id,
      rot: toPlainRot(rot),
      wakeUp,
    });
  }

  setAngvel(vel: PhysVector, wakeUp: boolean): void {
    this.pendingAvel = {
      value: { x: vel.x, y: vel.y, z: vel.z },
      visibleAt: getWriteVisibleStep(),
    };
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
      rot: toPlainRot(rot),
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
    const mass = (
      await messageWorkerAsync<RigidMassResponse>({
        type: PhysicsProtocolType.RIGID_MASS,
        rigidBodyId: this.id,
      })
    ).mass;
    this.cachedMass = mass;
    return mass;
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
    // Reflected locally as the velocity change it causes (Rapier applies an impulse straight to
    // the velocity too), using the last known mass — refreshed here for the next impulse.
    if (this.cachedMass) {
      const v = this.lvel;
      this.pendingLvel = {
        value: {
          x: v.x + impulse.x / this.cachedMass,
          y: v.y + impulse.y / this.cachedMass,
          z: v.z + impulse.z / this.cachedMass,
        },
        visibleAt: getWriteVisibleStep(),
      };
    }
    void this.mass().catch(() => {});
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
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_ROTATION,
      colliderId: this.id,
      rot: toPlainRot(rot),
    });
  }
  setRotationWrtParent(rot: PhysRotation): void {
    messageWorker({
      type: PhysicsProtocolType.COLL_SET_ROTATION_WRT_PARENT,
      colliderId: this.id,
      rot: toPlainRot(rot),
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
  // One RPC per collider, paid once when its debug wireframe is first built —
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
    private _body1Id: number,
    private _body2Id: number,
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

  // A joint's bodies never change, so they're known here from its creation params (p352: joint
  // groups are resolved on the main thread) and need no round trip.
  async body1Id(): Promise<number> {
    return this._body1Id;
  }
  body1IdSync(): number {
    return this._body1Id;
  }
  async body2Id(): Promise<number> {
    return this._body2Id;
  }
  body2IdSync(): number {
    return this._body2Id;
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

/** Debug env: loads the Physics API debug module and restores its persisted world settings
 * (gravity, timestep, solver iterations...) into the physics state. Call it before the first
 * physics world is created: every world, the boot one and each scene load's, is built from them. */
export const registerPhysicsAPIDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('./Debug/_dbg__PhysicsAPI'));
  useDebug(debugGUI)?._hydratePhysicsLiveSettings();
};

/** Debug env: creates the Physics API debugger tab (after registerPhysicsAPIDebugGUI). */
export const createPhysicsAPIDebugGUI = () => {
  useDebug(debugGUI)?._createPhysicsAPIDebugGUI();
};
