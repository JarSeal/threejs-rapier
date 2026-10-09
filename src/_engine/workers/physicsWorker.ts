/// <reference lib="webworker" />

import type { LoopState } from '../core/MainLoop';
import type {
  EngineAPIType,
  PhysicsBodyActivity,
  PhysicsState,
  PhysicsUpProtocol,
  WorldAPI,
} from '../core/Physics/PhysicsAPITypes';
import { PhysicsProtocolType } from '../core/Physics/PhysicsAPITypes';
import { initPhysicsEngine } from '../core/Physics/PhysicsUtils';
import { readStatsClock } from '../utils/StatsClock';
import {
  createPhysicsTransformArrayBuffer,
  PHYSICS_TRANSFORM_SHARED_BANKS,
  PhysicsTransformBuffer,
} from '../core/Physics/PhysicsTransformBuffer';
import {
  createPhysicsDebugStateArrayBuffer,
  DebugBodyFlag,
  DebugColliderFlag,
  PhysicsDebugStateBuffer,
} from '../core/Physics/PhysicsDebugStateBuffer';
import {
  createPhysicsStepStatsArrayBuffer,
  PHYSICS_STEP_STATS_FIELD_COUNT,
  PHYSICS_STEP_STATS_SLOTS,
} from '../core/Physics/PhysicsStepStatsBuffer';
import { physicsSwitchColl } from './physics/physicsSwitchColl';
import { physicsSwitchJoint } from './physics/physicsSwitchJoint';
import { physicsSwitchRigid } from './physics/physicsSwitchRigid';
import { physicsSwitchWorld } from './physics/physicsSwitchWorld';

const STATUS_READY_STRING = 'INIT_READY';
let engAPI: EngineAPIType;
let physicsWorldAPI: WorldAPI;
let workerPhysicsState: PhysicsState | undefined;
let transformBuffer: PhysicsTransformBuffer | undefined;
let resolvedUseSAB = false;
/** Steps executed on the current world since CREATE_WORLD — the step index every transform
 * write-back is stamped with. Mirrors the main thread's own count of steps issued (reset at the
 * same CREATE_WORLD), so the two agree exactly once a STEP has been processed. Deliberately
 * not reset by RESTORE_SNAPSHOT: the timeline keeps going, only the poses jump. */
let stepsExecuted = 0;
/** Debug wireframe state mirror. Stays undefined until the main thread enables
 * tracking, which is what keeps the feature's cost at zero while no wireframe is on. */
let debugStateBuffer: PhysicsDebugStateBuffer | undefined;
/** Tracked ids, in the order the main thread sent them — index IS slot on both sides. */
let debugTrackedRigidBodyIds: number[] = [];
let debugTrackedColliderIds: number[] = [];
/** Step-statistics scratch view (p027). Allocated at every CREATE_WORLD with the SHARED_MEMORY
 * transport, whatever stepStatsEnabled is (it can be switched at runtime, SET_STEP_STATS), and
 * written only while it is on. In MESSAGE_BATCH mode the stats ride on TRANSFORMS_PUSH and this
 * stays undefined. */
let stepStatsFloats: Float64Array | undefined;
/** Added to this worker's `performance.now()` to read the main thread's clock: a dedicated
 * worker's clock counts from the worker's own creation, not from the page's time origin. Set
 * at INIT_PHYSICS. Only the step stats' timestamps (receipt, step end) use it. */
let mainClockOffset = 0;

/** One frame's step measurements, kept as three independent numbers all the way through —
 * they are never added together (p027). */
type StepStats = {
  /** Pure simulation time: the sum of this message's engAPI.step() calls, with sub-step
   * command replay and write-back excluded. */
  stepMs: number;
  /** main→worker latency of the STEP message itself. */
  dispatchMs: number;
  /** Worker clock at the instant the last sub-step returned, for the main thread to derive
   * the return-leg latency from. */
  stepEndAt: number;
  /** Dynamic bodies awake and asleep after the last sub-step (p352). */
  awake: number;
  sleeping: number;
};

/** Reused by every measured STEP (countDynamicBodyActivity writes into it). */
const bodyActivity: PhysicsBodyActivity = { awake: 0, sleeping: 0 };

const handleMessage = async (data: PhysicsUpProtocol) => {
  const type = data.type;

  try {
    const subType = getSubType(type);
    if (subType) {
      switch (subType) {
        case 'WORLD':
          // WORLD
          return await physicsSwitchWorld(data, physicsWorldAPI, sendMessage);
        case 'RIGID':
          // RIGID BODY
          return physicsSwitchRigid(data, physicsWorldAPI, engAPI, sendMessage, transformBuffer);
        case 'COLL':
          // COLLIDER
          return physicsSwitchColl(data, physicsWorldAPI, engAPI, sendMessage);
        case 'JOINT':
          // JOINT
          return physicsSwitchJoint(data, physicsWorldAPI, engAPI, sendMessage);
        default:
          sendMessage(
            {
              type: PhysicsProtocolType.ERROR,
              message: `Unknown physics worker (up) protocol sub type: ${subType} (type: ${type})`,
            },
            data,
            true
          );
      }
    }

    switch (type) {
      // EngineAPI
      case PhysicsProtocolType.STEP:
        // STEP (one-way, no response — transform results arrive via the hot-path buffer,
        // and collision/contact-force events via EVENTS_PUSH). `steps` (from the main
        // thread's fixed-timestep accumulator) may run 0-N Rapier steps here, but only
        // ever one transform write-back and one (conditional) events push per message.
        // Commands the main thread's APP_PHYSICS_STEP systems issued for each sub-step (e.g.
        // a kinematic platform's next pose) are replayed right before that sub-step, so they
        // land on the step they were computed for, exactly like on MAIN_THREAD.
        {
          // Step statistics (p027) are entirely opt-in: with stepStatsEnabled off, not even
          // a performance.now() call is made here. Read once per message, so a SET_STEP_STATS
          // replayed as a sub-step command applies from the next STEP.
          const trackStats = Boolean(workerPhysicsState?.stepStatsEnabled);
          const receivedAt = trackStats ? readStatsClock() + mainClockOffset : 0;
          let stepMs = 0;
          let stepEndAt = 0;
          for (let i = 0; i < (data.steps ?? 1); i++) {
            const commands = data.substepCommands?.[i];
            if (commands)
              for (let j = 0; j < commands.length; j++) await handleMessage(commands[j]);
            if (!trackStats) {
              engAPI.step();
              stepsExecuted++;
              continue;
            }
            // Timed around step() alone — replaying this sub-step's commands above is main-
            // thread-issued work, not simulation cost, and folding it in would repeat the
            // legacy PHY panel's contamination bug in a new place.
            const subStepStart = readStatsClock();
            engAPI.step();
            stepsExecuted++;
            const subStepEnd = readStatsClock();
            stepMs += subStepEnd - subStepStart;
            stepEndAt = subStepEnd + mainClockOffset;
          }
          if (trackStats) engAPI.countDynamicBodyActivity(bodyActivity);
          writeBackTransforms(
            trackStats
              ? {
                  stepMs,
                  dispatchMs: receivedAt - (data.sentAt ?? receivedAt),
                  stepEndAt,
                  ...bodyActivity,
                }
              : undefined
          );
        }
        writeBackDebugState();
        return pushPendingEvents();
      case PhysicsProtocolType.SET_DEBUG_STATE_TRACKING: {
        // SET_DEBUG_STATE_TRACKING — full replacement of the tracked set.
        debugTrackedRigidBodyIds = data.rigidBodyIds;
        debugTrackedColliderIds = data.colliderIds;
        const isTracking =
          debugTrackedRigidBodyIds.length > 0 || debugTrackedColliderIds.length > 0;
        let buffer: SharedArrayBuffer | undefined = undefined;
        if (isTracking && !debugStateBuffer) {
          // First enable: allocate, and hand the main thread the SAB if we have one. The
          // buffer outlives later disable/enable cycles — it's a few KB, and reallocating
          // would mean re-handshaking the SAB every time a wireframe is toggled.
          const maxSlots = workerPhysicsState?.maxBodies || 2048;
          debugStateBuffer = new PhysicsDebugStateBuffer(
            maxSlots,
            createPhysicsDebugStateArrayBuffer(maxSlots, resolvedUseSAB)
          );
          if (resolvedUseSAB) buffer = debugStateBuffer.buffer as SharedArrayBuffer;
        }
        // Slots are positional, so any set change invalidates every previous slot's
        // meaning — zero them rather than let a stale flag paint the wrong color.
        debugStateBuffer?.clear();
        if (isTracking) writeBackDebugState();
        return sendMessage(
          {
            type,
            transportMode: resolvedUseSAB ? 'SHARED_MEMORY' : 'MESSAGE_BATCH',
            buffer,
          },
          data
        );
      }
      case PhysicsProtocolType.SET_STEP_STATS:
        // SET_STEP_STATS (one-way). Read at the start of each STEP message, so it applies from
        // the next one. workerPhysicsState outlives world resets, so the flag does too.
        if (workerPhysicsState) workerPhysicsState.stepStatsEnabled = data.enabled;
        return;
      case PhysicsProtocolType.FLUSH:
        // FLUSH (ordering barrier: messages are handled in arrival order, so replying is enough)
        return sendMessage({ type }, data);
      case PhysicsProtocolType.TAKE_SNAPSHOT:
        // TAKE_SNAPSHOT
        const snapshot = engAPI.takeSnapshot();
        return sendMessage({ type, snapshot }, data);
      case PhysicsProtocolType.RESTORE_SNAPSHOT:
        // RESTORE_SNAPSHOT
        physicsWorldAPI = engAPI.restoreSnapshot(data.snapshot);
        return sendMessage({ type, worldCreated: true }, data);
      case PhysicsProtocolType.CREATE_WORLD: {
        // CREATE_WORLD
        physicsWorldAPI = engAPI.createWorld(data.gravity, data.opts);
        stepsExecuted = 0;
        const maxBodies = workerPhysicsState?.maxBodies || 2048;
        resolvedUseSAB = Boolean(
          workerPhysicsState?.useSAB &&
            typeof SharedArrayBuffer !== 'undefined' &&
            self.crossOriginIsolated
        );
        // SHARED_MEMORY triple-buffers (p063): the main thread reads the SAB concurrently, so a
        // single bank tears. MESSAGE_BATCH pushes private copies of one bank.
        const bankCount = resolvedUseSAB ? PHYSICS_TRANSFORM_SHARED_BANKS : 1;
        transformBuffer = new PhysicsTransformBuffer(
          maxBodies,
          createPhysicsTransformArrayBuffer(maxBodies, resolvedUseSAB, bankCount),
          bankCount
        );
        // Step-stats buffer (p027): only in SHARED_MEMORY mode, where there is no per-step
        // message to carry the numbers on. Allocated whatever stepStatsEnabled is, so the
        // measurement can be switched on at runtime (SET_STEP_STATS); it is 24 bytes.
        let statsBuffer: SharedArrayBuffer | undefined = undefined;
        stepStatsFloats = undefined;
        if (resolvedUseSAB) {
          statsBuffer = createPhysicsStepStatsArrayBuffer();
          stepStatsFloats = new Float64Array(statsBuffer, 0, PHYSICS_STEP_STATS_FIELD_COUNT);
        }
        return sendMessage(
          {
            type,
            worldCreated: true,
            transportMode: resolvedUseSAB ? 'SHARED_MEMORY' : 'MESSAGE_BATCH',
            buffer: resolvedUseSAB ? transformBuffer.buffer : undefined,
            bankCount: resolvedUseSAB ? bankCount : undefined,
            statsBuffer,
          },
          data
        );
      }
      case PhysicsProtocolType.DELETE_WORLD: {
        // DELETE_WORLD
        const createdStatus = engAPI.deleteWorld();
        // CREATE_WORLD allocates a fresh transform buffer and restarts the step count. The
        // debug-state buffer is kept (the main thread may hold it as a SAB), but its tracked
        // ids all named bodies/colliders of the deleted world.
        transformBuffer = undefined;
        stepsExecuted = 0;
        debugTrackedRigidBodyIds = [];
        debugTrackedColliderIds = [];
        debugStateBuffer?.clear();
        return sendMessage({ type, ...createdStatus }, data);
      }
      case PhysicsProtocolType.INIT_PHYSICS:
        // INIT_PHYSICS
        workerPhysicsState = data.physicsState;
        mainClockOffset = performance.timeOrigin - data.mainTimeOrigin;
        const response = await initPhysics(
          data.physicsState,
          data.isDebugEnvironment,
          data.loopState,
          data.doNotCreateWorld
        );
        if (response) physicsWorldAPI = response;
        return sendMessage(
          {
            type,
            worldCreated: !Boolean(data.doNotCreateWorld) && Boolean(response),
          },
          data
        );

      // ERROR
      default:
        sendMessage(
          {
            type: PhysicsProtocolType.ERROR,
            message: `Unknown physics worker (up) protocol type: ${type}`,
          },
          data
        );
    }
  } catch (err) {
    let message: string | undefined = undefined;
    if (typeof err === 'string') {
      message = err.toUpperCase();
    } else if (err instanceof Error) {
      message = err.message;
    } else {
      const e = err as { message: string };
      message = e?.message ? String(e.message) : undefined;
    }
    if (!message) {
      message = `Unknown physics worker error. Protocol type: ${type}, request id: ${data.requestId}.`;
    }
    sendMessage(
      {
        type: PhysicsProtocolType.ERROR,
        message,
        requestId: data.requestId,
      },
      data
    );
  }
};

self.addEventListener('message', (event: MessageEvent<PhysicsUpProtocol>) =>
  handleMessage(event.data)
);

const sendMessage = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  data: PhysicsUpProtocol,
  isError?: boolean,
  transfer?: Transferable[]
) => {
  // If the up message has 'isOneWay: true', don't reply
  if (data.isOneWay && isError) return;
  const requestId = data.requestId;
  if (requestId === undefined) return sendMessageSimple(message, transfer);
  return transfer
    ? self.postMessage({ ...message, requestId }, transfer)
    : self.postMessage({ ...message, requestId });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendMessageSimple = (message: any, transfer?: Transferable[]) =>
  transfer ? self.postMessage(message, transfer) : self.postMessage(message);

/** Writes every slotted rigid body's transform into the hot-path buffer after a step, then
 * (MESSAGE_BATCH fallback only) pushes a fresh copy to the main thread as one Transferable
 * message — never one message per body. Bodies created FIXED have no slot (p352): they never
 * move under simulation, and an explicit reposition (setTranslation/setRotation) reaches the
 * main thread through the body's proxy, which keeps the pose it was given. */
const writeBackTransforms = (stats?: StepStats) => {
  // Stats go out first, and outside the transformBuffer guard, so the measurement doesn't
  // silently depend on a world having a transform buffer.
  if (stats && stepStatsFloats) {
    stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.STEP_MS] = stats.stepMs;
    stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.DISPATCH_MS] = stats.dispatchMs;
    stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.STEP_END_AT] = stats.stepEndAt;
    stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.AWAKE_BODIES] = stats.awake;
    stepStatsFloats[PHYSICS_STEP_STATS_SLOTS.SLEEPING_BODIES] = stats.sleeping;
  }
  if (!transformBuffer) return;
  for (const id of engAPI.getAllRigidBodyIds()) {
    const slot = transformBuffer.getSlot(id);
    if (slot === -1) continue;
    const rb = engAPI.getRigidBodyAPIWithId(id);
    if (!rb) continue;
    transformBuffer.setTransform(slot, rb.pos, rb.rot);
    transformBuffer.setVelocity(slot, rb.linvel(), rb.angvel());
  }
  transformBuffer.publish(stepsExecuted);
  if (!resolvedUseSAB) {
    const copy = transformBuffer.buffer.slice(0) as ArrayBuffer;
    sendMessageSimple(
      {
        type: PhysicsProtocolType.TRANSFORMS_PUSH,
        buffer: copy,
        // MESSAGE_BATCH only: piggyback the stats on the message that already goes out every
        // step rather than inventing a second one. Three separate fields, never combined.
        stepDuration: stats?.stepMs,
        dispatchMs: stats?.dispatchMs,
        stepEndAt: stats?.stepEndAt,
        awakeBodies: stats?.awake,
        sleepingBodies: stats?.sleeping,
      },
      [copy]
    );
  }
};

/** Mirrors the tracked bodies'/colliders' live state into the debug-state buffer after a
 * step, then (MESSAGE_BATCH fallback only) pushes a copy as one Transferable message.
 * Returns immediately — allocating nothing and posting nothing — whenever no wireframe is
 * switched on, which is the normal case. */
const writeBackDebugState = () => {
  if (!debugStateBuffer) return;
  if (!debugTrackedRigidBodyIds.length && !debugTrackedColliderIds.length) return;

  for (let slot = 0; slot < debugTrackedRigidBodyIds.length; slot++) {
    const rb = engAPI.getRigidBodyAPIWithId(debugTrackedRigidBodyIds[slot]);
    if (!rb || !rb.isValidSync()) {
      debugStateBuffer.setBodyFlags(slot, 0);
      continue;
    }
    let flags = DebugBodyFlag.VALID;
    if (rb.isSleepingSync()) flags |= DebugBodyFlag.SLEEPING;
    if (rb.isEnabledSync()) flags |= DebugBodyFlag.ENABLED;
    if (rb.isKinematicSync()) flags |= DebugBodyFlag.KINEMATIC;
    if (rb.isFixedSync()) flags |= DebugBodyFlag.FIXED;
    debugStateBuffer.setBodyFlags(slot, flags);
  }

  for (let slot = 0; slot < debugTrackedColliderIds.length; slot++) {
    const coll = engAPI.getColliderAPIWithId(debugTrackedColliderIds[slot]);
    if (!coll || !coll.isValidSync()) {
      debugStateBuffer.setColliderFlags(slot, 0);
      continue;
    }
    let flags = DebugColliderFlag.VALID;
    if (coll.isEnabledSync()) flags |= DebugColliderFlag.ENABLED;
    if (coll.isSensorSync()) flags |= DebugColliderFlag.SENSOR;
    debugStateBuffer.setColliderFlags(slot, flags);
  }

  if (!resolvedUseSAB) {
    const copy = debugStateBuffer.buffer.slice(0) as ArrayBuffer;
    sendMessageSimple({ type: PhysicsProtocolType.DEBUG_STATE_PUSH, buffer: copy }, [copy]);
  }
};

/** Pushes whatever collision/contact-force events were collected during the STEP that
 * just ran, but only when at least one occurred — these are sparse and discrete, unlike
 * the continuously-valid transform buffer, so there's no reason to pay a postMessage
 * every frame when nothing collided. */
const pushPendingEvents = () => {
  const { collisions, contactForces } = engAPI.drainPendingEventRecords();
  if (!collisions.length && !contactForces.length) return;
  sendMessageSimple({ type: PhysicsProtocolType.EVENTS_PUSH, collisions, contactForces });
};

const initPhysics = async (
  physicsState: PhysicsState,
  isDebugEnvironment: boolean,
  loopState: LoopState,
  doNotCreateWorld?: boolean
): Promise<WorldAPI | undefined> => {
  const curEngineKey = physicsState.physicsEngine;
  const { engineAPI } = await initPhysicsEngine(curEngineKey);
  engAPI = engineAPI as EngineAPIType;
  return engAPI.init(physicsState, isDebugEnvironment, loopState, doNotCreateWorld);
};

const getSubType = (type: PhysicsProtocolType) => {
  const numberOfType = Number(type);
  if (numberOfType >= 200 && numberOfType < 400) {
    return 'WORLD';
  }
  if (numberOfType >= 400 && numberOfType < 600) {
    return 'RIGID';
  }
  if (numberOfType >= 600 && numberOfType < 800) {
    return 'COLL';
  }
  if (numberOfType >= 800 && numberOfType < 1000) {
    return 'JOINT';
  }
  return null;
};

// Automatically send STATUS_READY_STRING when this file is executed (handshake)
self.postMessage({ status: STATUS_READY_STRING });
