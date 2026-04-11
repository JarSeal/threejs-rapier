// This API is a wrapper to call the actual physics engine.
// It has been created based on the RAPIER API model. Other engines
// may not share the same methods and call signatures (and some
// refactoring might be needed to make others work). The API
// handles the differentiation between different engines
// and threading.

import * as THREE from 'three/webgpu';

import PhysicsWorker from '../workers/physicsWorker?worker';
import { getConfig, isDebugEnvironment } from './Config';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import {
  getColliderShapeName,
  getCollOrRigidId,
  getEngineAPI,
  initPhysicsEngine,
  isDynamicPhysicsObjectValid,
  ValidProtocolTypes,
} from './Physics/PhysicsUtils';
import { getCurrentSceneId, getRootScene, getScene, isCurrentScene } from './Scene';
import { createDebuggerTab, createNewDebuggerPane } from '../debug/DebuggerGUI';
import { getSvgIcon } from './UI/icons/SvgIcon';
import { lerror, llog, lwarn } from '../utils/Logger';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  updateDraggableWindow,
} from './UI/DraggableWindow';
import { CMP, TCMP } from '../utils/CMP';
import { addVisibilityChangeFn, getReadOnlyLoopState, LoopState, toggleMainPlay } from './MainLoop';
import { ListBladeApi, Pane } from 'tweakpane';
import { updatePhysicsPanel } from '../debug/Stats';
import { isCurrentlyLoading } from './SceneLoader';
import { updateOnScreenTools } from '../debug/OnScreenTools';
import { BladeController, View } from '@tweakpane/core';
import { updateInputControllerLoopActions } from './InputControls';
import { existsOrThrow, existsOrWarn, initWorker } from '../utils/helpers';
import { deleteMesh } from './Mesh';
import {
  ColliderAPI,
  EngineAPIType,
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
  WorldMaxCcdSubstepsResponse,
  PhysicsObject,
  RigidBodyParams,
  CreateRigidBodyResponse,
  CreateColliderResponse,
  QueryFilterFlags,
  ColliderParams,
  CreateRigidBodiesResponse,
  CreateCollidersResponse,
  WorldCastRayResponse,
  WorldCastRayAndGetNormalResponse,
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
  RigidTranslationResponse,
  RigidRotationResponse,
  RigidNextTranslationResponse,
  RigidNextRotationResponse,
  RigidGravityScaleResponse,
  RigidLinvelResponse,
  RigidVelocityAtPointResponse,
  RigidAngvelResponse,
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
  WorldProxyAPIType,
  RigidGetUserDataResponse,
  RigidBodyProxyAPIType,
  RigidBodyWorkerEngine,
  RayColliderHitAPI,
} from './Physics/PhysicsAPITypes';
import { createNewResolver, resolveRequest } from '../utils/PromiseResolver';

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
let worker: Worker | null = null;
const LS_KEY = 'debugPhysics';
const DEFAULT_SCENE_PHYS_STATE: ScenePhysicsState = {
  worldStepEnabled: true,
  visualizerEnabled: false,
  gravity: { x: 0, y: -9.81, z: 0 },
  solverIterations: 10,
  internalPgsIterations: 1,
  interpolationEnabled: true,
};
const getDefaultScenePhysParams = () =>
  ({ ...DEFAULT_SCENE_PHYS_STATE, ...getConfig().physics }) as ScenePhysicsState;
let stepperFn: (loopState: LoopState) => void = () => {};
let physicsWorld: WorldAPI = { step: () => {} } as unknown as WorldAPI;
let physicsWorldEnabled = false;
let collisionEventFnCount = 0;
let contactForceEventFnCount = 0;
const physicsObjects: { [id: string]: PhysicsObject } = {};
let currentScenePhysicsObjects: PhysicsObject[] = [];
let debugMesh: THREE.LineSegments;
const INITIAL_DEBUG_MESH_SIZE = 10000;
let physicsDebugGUI: Pane | null = null;
let physicsObjectsDebugList: TCMP | null = null;
let curScenePhysParams = { ...DEFAULT_SCENE_PHYS_STATE };
const scenePhysicsLoopers: { [id: string]: ScenePhysicsLooper } = {};
const scenePhysicsAfterStepLoopers: { [id: string]: ScenePhysicsLooper } = {};
let engineInitiated = false;
let engAPI: EngineAPIType | null = null;

const rigidBodies = new Map<number, RigidBodyAPI>(); // { "Running id", RigidBodyAPI }
const colliders = new Map<number, ColliderAPI>(); // { "Running id", ColliderAPI }

/**
 * Initializes the physics
 */
export const initPhysics = async (doNotCreateWorld?: boolean) => {
  const physicsConfig = getConfig().physics;
  const enabled = physicsConfig?.enabled || false;
  if (!enabled) {
    // @CONSIDER: maybe add the icon and button for the physics here for the debug drawer but make it disabled.
    return;
  }

  if (isDebugEnvironment()) {
    const savedValues = lsGetItem(LS_KEY, physicsState);
    physicsState = {
      ...physicsState,
      ...savedValues,
    };
    physicsState.isPaused = false;
    physicsState.pauseReason = null;
    physicsState.pauseDurationTotal = 0;
  }

  physicsState.timestepRatio = 1 / (physicsState.timestep || 60);
  const curEngineKey = physicsState.physicsEngine;
  const target = physicsState.workerTarget;

  if (target === 'MAIN_THREAD') {
    // Main thread
    const { engine, engineAPI } = await initPhysicsEngine(curEngineKey);
    engineInitiated = Boolean(engine);
    engAPI = engineAPI;
    const worldOrUndefined = engAPI.init(
      physicsState,
      isDebugEnvironment(),
      getReadOnlyLoopState(),
      doNotCreateWorld
    );
    if (worldOrUndefined) physicsWorld = worldOrUndefined;
    if (isDebugEnvironment()) {
      createDebugControls();
      createPhysicsDebugMesh();
      stepperFn = stepperFnDebug;
    } else {
      stepperFn = stepperFnProduction;
    }
  } else if (target === 'WORKER_THREAD') {
    // Worker thread
    stepperFn = () => null;
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
    if (worldCreated) physicsWorld = createWorkerPhysicsWorldAPI();
  }
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

  // @CHORE: finish this
  // if (type === PhysicsProtocolType.STEP) { return; }

  if (type === PhysicsProtocolType.ERROR) {
    // @CONSIDER: should we throw an error here??? Maybe a physics setting whether to throw or not?
    lerror(`Error in physics worker, message: ${data.message}`);
    return;
  } else if (!ValidProtocolTypes.has(type)) {
    lerror(`Error in physics onWorkerMessage, unknown protocol type: ${type}`);
    return;
  }

  return resolveRequest(data, requestId, type);
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
      timerRunning = true;
      updateTimer();
      timer.getDelta();
      accDelta = 0;
      toggleMainPlay(true);
    }
  }
};

// Physics step accumulator variables
let accDelta = 0;
let timerRunning = true;
const timer = new THREE.Timer();
const updateTimer = () => {
  if (timerRunning) {
    timer.update();
  }
};

// Interpolation transforms maps
const prevTransforms = new Map<number, { pos: THREE.Vector3; rot: THREE.Quaternion }>();
const currTransforms = new Map<number, { pos: THREE.Vector3; rot: THREE.Quaternion }>();

// Different stepper functions to use for debug and production.
// baseStepper is used for both (only for MAIN_THREAD target).
const mainThreadBaseStepper = (loopState: LoopState) => {
  // @TODO: we need to really carefully think where this is and how to call this
  if (isCurrentlyLoading()) return;

  updateTimer();
  let delta = timer.getDelta();
  if (loopState.isWindowHidden || !loopState.masterPlay || !loopState.appPlay) {
    if (
      physicsState.backgroundBehavior === 'KEEP_RUNNING_USE_MIN_DELTA' &&
      physicsState.minDeltaTime > 0
    ) {
      delta = physicsState.minDeltaTime;
    } else if (
      physicsState.backgroundBehavior === 'PAUSE' ||
      !loopState.masterPlay ||
      !loopState.appPlay
    ) {
      setPhysicsPauseTime();
      physicsState.isPaused = true;
      timerRunning = false;
      return;
    }
  } else if (physicsState.isPaused) {
    timerRunning = true;
    updateTimer();
    delta = timer.getDelta();
    delta = 0;
    accDelta = 0;
    if (physicsState.minDeltaTime > 0) delta = physicsState.minDeltaTime;
    physicsState.isPaused = false;
    physicsState.pauseDurationTotal += performance.now() - physicsState.pausedTime;
    physicsState.pausedTime = 0;
  }
  let stepsTaken = 0;
  const scaledDelta = delta * loopState.playSpeedMultiplier;
  accDelta += scaledDelta;
  if (physicsState.maxDeltaTime > 0) delta = Math.min(delta, physicsState.maxDeltaTime);

  while (
    accDelta >= physicsState.timestepRatio &&
    (physicsState.minSubSteps === 0 || stepsTaken <= physicsState.minSubSteps) &&
    (physicsState.maxSubSteps === 0 || stepsTaken < physicsState.maxSubSteps)
  ) {
    if (physicsState.isPaused) break;

    // Update loop action inputs
    updateInputControllerLoopActions(physicsState.timestepRatio);

    // Store previous transforms
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      const po = currentScenePhysicsObjects[i];
      if (!isDynamicPhysicsObjectValid(po)) continue;
      const rb = po.rigidBody as RigidBodyAPI;
      const handle = rb.handle;
      const t = rb.translation();
      const r = rb.rotation();
      // 1. Ensure storage exists (allocate once)
      if (!prevTransforms.has(handle)) {
        prevTransforms.set(handle, { pos: new THREE.Vector3(), rot: new THREE.Quaternion() });
        currTransforms.set(handle, { pos: new THREE.Vector3(), rot: new THREE.Quaternion() });
      }
      const prev = prevTransforms.get(handle)!;
      const curr = currTransforms.get(handle)!;
      // 2. Cycle the data: Current becomes Previous
      prev.pos.copy(curr.pos);
      prev.rot.copy(curr.rot);
      // 3. Update Current from Rapier (Zero Allocation)
      curr.pos.set(t.x, t.y, t.z);
      curr.rot.set(r.x, r.y, r.z, r.w);
    }

    // @CHORE: eventQueue (Rapier) does not exist anymore in this context, make an agnostic events handler.
    if (collisionEventFnCount) {
      // eventQueue?.drainCollisionEvents((handle1, handle2, started) => {
      //   let collider1: ColliderAPI | null = null;
      //   let collider2: ColliderAPI | null = null;
      //   const physObj1 = currentScenePhysicsObjects.find((obj) => {
      //     if (Array.isArray(obj.collider)) {
      //       const foundCollider = obj.collider.find((collider) => collider.handle === handle1);
      //       if (foundCollider) {
      //         collider1 = foundCollider;
      //         return true;
      //       }
      //       return false;
      //     }
      //     if (obj.collider.handle === handle1) {
      //       collider1 = obj.collider;
      //       return true;
      //     }
      //     return false;
      //   });
      //   const physObj2 = currentScenePhysicsObjects.find((obj) => {
      //     if (Array.isArray(obj.collider)) {
      //       const foundCollider = obj.collider.find((collider) => collider.handle === handle2);
      //       if (foundCollider) {
      //         collider2 = foundCollider;
      //         return true;
      //       }
      //       return false;
      //     }
      //     if (obj.collider.handle === handle2) {
      //       collider2 = obj.collider;
      //       return true;
      //     }
      //     return false;
      //   });
      //   if (!collider1 || !collider2) return;
      //   if (physObj1?.collisionEventFn && physObj2) {
      //     if (Array.isArray(physObj1.collisionEventFn)) {
      //       for (let i = 0; i < physObj1.collisionEventFn.length; i++) {
      //         physObj1.collisionEventFn[i](collider1, collider2, started, physObj1, physObj2);
      //       }
      //     } else {
      //       physObj1.collisionEventFn(collider1, collider2, started, physObj1, physObj2);
      //     }
      //   }
      //   if (physObj2?.collisionEventFn && physObj1) {
      //     if (Array.isArray(physObj2.collisionEventFn)) {
      //       for (let i = 0; i < physObj2.collisionEventFn.length; i++) {
      //         physObj2.collisionEventFn[i](collider1, collider2, started, physObj1, physObj2);
      //       }
      //     } else {
      //       physObj2.collisionEventFn(collider1, collider2, started, physObj1, physObj2);
      //     }
      //   }
      // });
    }

    // @CHORE: eventQueue (Rapier) does not exist anymore in this context, make an agnostic events handler.
    if (contactForceEventFnCount) {
      // eventQueue?.drainContactForceEvents((event) => {
      //   const handle1 = event.collider1();
      //   const handle2 = event.collider2();
      //   const physObj1 = currentScenePhysicsObjects.find((obj) => {
      //     if (Array.isArray(obj.collider)) {
      //       return Boolean(obj.collider.find((collider) => collider.handle === handle1));
      //     }
      //     return obj.collider.handle === handle1;
      //   });
      //   const physObj2 = currentScenePhysicsObjects.find((obj) => {
      //     if (Array.isArray(obj.collider)) {
      //       return Boolean(obj.collider.find((collider) => collider.handle === handle2));
      //     }
      //     return obj.collider.handle === handle2;
      //   });
      //   if (physObj1?.contactForceEventFn && physObj2) {
      //     if (Array.isArray(physObj1.contactForceEventFn)) {
      //       for (let i = 0; i < physObj1.contactForceEventFn.length; i++) {
      //         physObj1.contactForceEventFn[i](event, physObj1, physObj2);
      //       }
      //     } else {
      //       physObj1.contactForceEventFn(event, physObj1, physObj2);
      //     }
      //   }
      //   if (physObj2?.contactForceEventFn && physObj1) {
      //     if (Array.isArray(physObj2.contactForceEventFn)) {
      //       for (let i = 0; i < physObj2.contactForceEventFn.length; i++) {
      //         physObj2.contactForceEventFn[i](event, physObj1, physObj2);
      //       }
      //     } else {
      //       physObj2.contactForceEventFn(event, physObj1, physObj2);
      //     }
      //   }
      // });
    }

    // Run scenePhysicsLoopers
    const looperKeys = Object.keys(scenePhysicsLoopers);
    for (let i = 0; i < looperKeys.length; i++) {
      scenePhysicsLoopers[looperKeys[i]](physicsState.timestepRatio);
    }

    // Step the world
    const data = (engAPI as EngineAPIType).step();

    accDelta -= physicsState.timestepRatio;
    stepsTaken++;
  }

  // Run scenePhysicsAfterStepLoopers
  const afterStepLooperKeys = Object.keys(scenePhysicsAfterStepLoopers);
  for (let i = 0; i < afterStepLooperKeys.length; i++) {
    scenePhysicsAfterStepLoopers[afterStepLooperKeys[i]](scaledDelta);
  }
};

// PRODUCTION STEPPER
const stepperFnProduction = (loopState: LoopState) => mainThreadBaseStepper(loopState);

// DEBUG STEPPER
const stepperFnDebug = (loopState: LoopState) => {
  const startMeasuring = performance.now();

  mainThreadBaseStepper(loopState);

  if (!loopState.masterPlay || !loopState.appPlay) return;

  if (physicsWorldEnabled && debugMesh && physicsState.visualizerEnabled) {
    // Physics debug visualizer
    const { vertices, colors } = physicsWorld.debugRender();

    debugMesh.visible = true;

    let currentGeo = debugMesh.geometry;
    const posAttr = currentGeo.attributes.position;

    // Check if we need to resize (Grow the buffer)
    if (vertices.length > posAttr.array.length) {
      // 1. Dispose of the old geometry to free GPU memory
      currentGeo.dispose();

      // 2. Create a BRAND NEW Geometry
      const newGeo = new THREE.BufferGeometry();

      // 3. Allocate LARGER buffers
      const newSize = vertices.length + 5000; // Add generous padding to avoid frequent resizing
      newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newSize), 3));
      newGeo.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array((newSize / 3) * 4), 4)
      );
      newGeo.boundingSphere = new THREE.Sphere();
      newGeo.boundingSphere.radius = Infinity;

      // 4. Assign the new geometry to the mesh
      // This forces the renderer to bind the new, larger buffer immediately
      debugMesh.geometry = newGeo;

      // Update local reference
      currentGeo = newGeo;
    }

    // Update Data
    // We get the *latest* attribute reference in case we just resized it
    const finalPosAttr = currentGeo.attributes.position as THREE.BufferAttribute;
    const finalColAttr = currentGeo.attributes.color as THREE.BufferAttribute;

    // Copy data into the existing typed arrays
    // .set is very fast for Float32Array
    finalPosAttr.array.set(vertices);
    finalColAttr.array.set(colors);

    // Mark as needing upload to GPU
    finalPosAttr.needsUpdate = true;
    finalColAttr.needsUpdate = true;

    // CRITICAL: Tell GPU how many vertices to actually draw
    // If buffer has 10,000 spots but we only have 50 vertices, draw only 50.
    // vertices is a Float32Array (x,y,z), so vertex count is length / 3
    currentGeo.setDrawRange(0, vertices.length / 3);
  } else {
    debugMesh.visible = false;
  }

  const stopMeasuring = performance.now();
  updatePhysicsPanel(stopMeasuring - startMeasuring);
};

/**
 * Steps the physics world (called in the main loop) and sets mesh positions and rotations in the current scene.
 */
export const stepPhysicsWorld = (loopState: LoopState) => stepperFn(loopState);

// Reuse scratch objects to avoid GC
const _interpPos = new THREE.Vector3();
const _interpRot = new THREE.Quaternion();
const _prevRot = new THREE.Quaternion();
const _currRot = new THREE.Quaternion();

// @CHORE: rewrite to either use the main thread or the worker thread
export const renderPhysicsObjects = () => {
  if (getCurrentScenePhysParams().interpolationEnabled) {
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      const po = currentScenePhysicsObjects[i];
      // @OPTIMIZATION: check currentScenePhysicsObjects type at the top of the file for more info
      if (!isDynamicPhysicsObjectValid(po)) continue;
      const mesh = po.mesh as THREE.Mesh; // Casting is safe here because we check the validity (isDynamicPhysicsObjectValid)
      const rb = po.rigidBody as RigidBodyAPI; // Casting is safe here because we check the validity (isDynamicPhysicsObjectValid)
      const handle = rb.handle;
      const prev = prevTransforms.get(rb.handle);
      const curr = currTransforms.get(rb.handle);
      // Safety Check: If data is missing (new object), Snap and Init.
      if (!prev || !curr) {
        const t = rb.translation();
        const r = rb.rotation();
        mesh.position.set(t.x, t.y, t.z);
        mesh.quaternion.set(r.x, r.y, r.z, r.w);

        // Initialize the buffers so next frame interpolates correctly
        if (!prevTransforms.has(handle)) {
          const p = new THREE.Vector3(t.x, t.y, t.z);
          const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
          prevTransforms.set(handle, { pos: p, rot: q });
          currTransforms.set(handle, { pos: p.clone(), rot: q.clone() });
        }
        continue;
      }

      const alpha = Math.max(0, Math.min(1, accDelta / physicsState.timestepRatio));

      // 2. Interpolate Position
      _interpPos.copy(prev.pos).lerp(curr.pos, alpha);
      mesh.position.copy(_interpPos);

      // 3. Interpolate Rotation (SAFE MODE)
      // We copy to scratch variables to ensure we don't mutate the storage
      _prevRot.copy(prev.rot).normalize();
      _currRot.copy(curr.rot).normalize();

      _interpRot.copy(_prevRot).slerp(_currRot, alpha);
      _interpRot.normalize();

      const userData = po.rigidBody?.userData as { [key: string]: unknown };
      if (!userData?.lockRotationsX && !userData?.lockRotationsX && !userData?.lockRotationsX) {
        mesh.quaternion.copy(_interpRot);
      } else {
        mesh.quaternion.copy({
          x: userData.lockRotationsX ? mesh.quaternion.x : _interpRot.x,
          y: userData.lockRotationsY ? mesh.quaternion.y : _interpRot.y,
          z: userData.lockRotationsZ ? mesh.quaternion.z : _interpRot.z,
          w: mesh.quaternion.w,
        });
      }
    }
  } else {
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      // --- SNAP, NO INTERPOLATION
      const po = currentScenePhysicsObjects[i];
      // @OPTIMIZATION: check currentScenePhysicsObjects type at the top of the file for more info
      if (!isDynamicPhysicsObjectValid(po)) continue;
      const mesh = po.mesh as THREE.Mesh; // Casting is safe here because we check the validity (isDynamicPhysicsObjectValid)
      const rb = po.rigidBody as RigidBodyAPI; // Casting is safe here because we check the validity (isDynamicPhysicsObjectValid)
      mesh.position.copy(rb.translation());
      const userData = rb.userData as { [key: string]: unknown };
      if (!userData?.lockRotationsX && !userData?.lockRotationsX && !userData?.lockRotationsX) {
        mesh.quaternion.copy(rb.rotation());
      } else {
        const colliderRotation = rb.rotation();
        mesh.quaternion.copy({
          x: userData.lockRotationsX ? mesh.quaternion.x : colliderRotation.x,
          y: userData.lockRotationsY ? mesh.quaternion.y : colliderRotation.y,
          z: userData.lockRotationsZ ? mesh.quaternion.z : colliderRotation.z,
          w: mesh.quaternion.w,
        });
      }
    }
  }
};

// DEBUGGER: ****************************************************

const initDebuggerScenePhysState = () => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  if (!physicsState.scenes[currentSceneId]) {
    physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
  }
  curScenePhysParams = physicsState.scenes[currentSceneId];
  buildPhysicsDebugGUI();
};

const createDebugControls = () => {
  const savedValues = lsGetItem(LS_KEY, physicsState);
  physicsState = {
    ...physicsState,
    ...savedValues,
  };
  physicsState.timestepRatio = 1 / (physicsState.timestep || 60);
  physicsState.isPaused = false;
  physicsState.pauseReason = null;
  physicsState.pauseDurationTotal = 0;

  initDebuggerScenePhysState();

  const icon = getSvgIcon('rocketTakeoff');
  createDebuggerTab({
    id: 'physicsControls',
    buttonText: icon,
    title: 'Physics controls',
    orderNr: 5,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('physics', `${icon} Physics Controls`);
      physicsDebugGUI = debugGUI;
      buildPhysicsDebugGUI();
      container.add(buildPhysicsObjectsDebugList());
      return container;
    },
  });
};

/**
 * Creates physics debug mesh (only in debug mode)
 */
export const createPhysicsDebugMesh = () => {
  const debugGeo = new THREE.BufferGeometry();
  const debugMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    vertexColors: true, // Important for Rapier's debug colors
  });

  // Pre-allocate buffers
  debugGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(INITIAL_DEBUG_MESH_SIZE * 3), 3)
  );
  debugGeo.setAttribute(
    'color',
    new THREE.BufferAttribute(new Float32Array(INITIAL_DEBUG_MESH_SIZE * 4), 4)
  );

  debugMesh = new THREE.LineSegments(debugGeo, debugMat);
  debugMesh.frustumCulled = false; // Physics lines span the whole world, don't cull them!
  if (!debugMesh.geometry.boundingSphere) {
    debugMesh.geometry.boundingSphere = new THREE.Sphere();
  }
  // Set to infinity so it's always visible and never recomputed
  debugMesh.geometry.boundingSphere.radius = Infinity;
  debugMesh.geometry.boundingSphere.center.set(0, 0, 0);
  const scene = getRootScene();
  if (scene) {
    // 1. Assign a unique name to your debug mesh
    debugMesh.name = 'PHYSICS_DEBUG_VISUALIZER';

    // 2. Check if it's actually in the scene
    const existingMesh = scene.getObjectByName('PHYSICS_DEBUG_VISUALIZER');

    if (!existingMesh) {
      // It's missing, add it.
      scene.add(debugMesh);
    } else if (existingMesh !== debugMesh) {
      // CRITICAL: A ghost exists!
      // We found a mesh with the same name, but it's not THIS instance.
      // This happens on Hot Reload or Scene Switch.

      // Remove the old ghost
      scene.remove(existingMesh);

      // Add the new one
      scene.add(debugMesh);
    }
  }
};

export const togglePhysicsVisualizer = (value: boolean) => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  if (!physicsState.scenes[currentSceneId]) {
    physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
  }
  physicsState.scenes[currentSceneId].visualizerEnabled = value;
  curScenePhysParams = physicsState.scenes[currentSceneId];
  updateOnScreenTools('SWITCH');
  lsSetItem(LS_KEY, physicsState);
};

export const buildPhysicsDebugGUI = () => {
  const debugGUI = physicsDebugGUI;
  if (!debugGUI) return;

  const blades = debugGUI?.children || [];
  for (let i = 0; i < blades.length; i++) {
    blades[i].dispose();
  }

  debugGUI
    .addBinding(physicsState, 'timestep', { label: 'Global timestep (1 / ts)', step: 1, min: 1 })
    .on('change', (e) => {
      physicsState.timestepRatio = 1 / e.value;
      lsSetItem(LS_KEY, physicsState);
    });
  debugGUI.addBlade({ view: 'separator' });
  debugGUI
    .addBinding(curScenePhysParams, 'worldStepEnabled', { label: 'Enable world step' })
    .on('change', (e) => {
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!physicsState.scenes[currentSceneId]) {
        physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
      }
      physicsState.scenes[currentSceneId].worldStepEnabled = e.value;
      curScenePhysParams = physicsState.scenes[currentSceneId];
      lsSetItem(LS_KEY, physicsState);
    });
  debugGUI
    .addBinding(curScenePhysParams, 'visualizerEnabled', { label: 'Enable visualizer' })
    .on('change', (e) => {
      togglePhysicsVisualizer(e.value);
    });
  debugGUI.addBinding(curScenePhysParams, 'gravity', { label: 'Gravity' }).on('change', (e) => {
    const currentSceneId = getCurrentSceneId();
    if (!currentSceneId) return;
    if (!physicsState.scenes[currentSceneId]) {
      physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
    }
    physicsState.scenes[currentSceneId].gravity = { ...e.value };
    curScenePhysParams = physicsState.scenes[currentSceneId];
    for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
      currentScenePhysicsObjects[i].rigidBody?.wakeUp();
    }
    lsSetItem(LS_KEY, physicsState);
    if (!physicsWorld?.gravity) return;
    physicsWorld.gravity.x = e.value.x;
    physicsWorld.gravity.y = e.value.y;
    physicsWorld.gravity.z = e.value.z;
  });
  debugGUI
    .addBinding(curScenePhysParams, 'solverIterations', {
      label: 'Solver iterations',
      min: 1,
      step: 1,
    })
    .on('change', (e) => {
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!physicsState.scenes[currentSceneId]) {
        physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
      }
      physicsState.scenes[currentSceneId].solverIterations = e.value;
      curScenePhysParams = physicsState.scenes[currentSceneId];
      for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
        currentScenePhysicsObjects[i].rigidBody?.wakeUp();
      }
      lsSetItem(LS_KEY, physicsState);
      physicsWorld.numSolverIterations = e.value;
    });
  debugGUI
    .addBinding(curScenePhysParams, 'internalPgsIterations', {
      label: 'Internal PGS iterations (run at each solver iteration)',
      min: 1,
      step: 1,
    })
    .on('change', (e) => {
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!physicsState.scenes[currentSceneId]) {
        physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
      }
      physicsState.scenes[currentSceneId].internalPgsIterations = e.value;
      curScenePhysParams = physicsState.scenes[currentSceneId];
      for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
        currentScenePhysicsObjects[i].rigidBody?.wakeUp();
      }
      lsSetItem(LS_KEY, physicsState);
      physicsWorld.numInternalPgsIterations = e.value;
    });
  debugGUI
    .addBinding(curScenePhysParams, 'interpolationEnabled', { label: 'Enable interpolation' })
    .on('change', () => {
      lsSetItem(LS_KEY, physicsState);
    });
  const bgBehaviorDropDown = debugGUI.addBlade({
    view: 'list',
    label:
      'Background behavior (when the loop is not running or the window is hidden, not in view, another tab, or minimized)',
    options: [
      { value: 'KEEP_RUNNING', text: 'Keep running' },
      { value: 'KEEP_RUNNING_USE_MIN_DELTA', text: 'Keep running and use Minimum delta time' },
      { value: 'PAUSE', text: 'Pause' },
    ],
    value: physicsState.backgroundBehavior,
  }) as ListBladeApi<BladeController<View>>;
  bgBehaviorDropDown.on('change', (e) => {
    const value = e.value;
    physicsState.backgroundBehavior = value as unknown as PhysicsState['backgroundBehavior'];
    lsSetItem(LS_KEY, physicsState);
  });
  debugGUI
    .addBinding(physicsState, 'minDeltaTime', {
      label: 'Minimum delta time (eg. 1 / 30fps), 0 = not in use',
      step: 0.0000000001,
      min: 0,
    })
    .on('change', (e) => {
      physicsState.minDeltaTime = 1 / e.value;
      lsSetItem(LS_KEY, physicsState);
    });
  debugGUI
    .addBinding(physicsState, 'maxDeltaTime', {
      label: 'Maximum delta time (clamping to an fps, 1 / 10fps = 0.1), 0 = not in use',
      step: 0.0000000001,
      min: 0,
    })
    .on('change', (e) => {
      physicsState.maxDeltaTime = 1 / e.value;
      lsSetItem(LS_KEY, physicsState);
    });
  debugGUI
    .addBinding(physicsState, 'minSubSteps', {
      label: 'Minimum steps per render frame, 0 = not in use',
      step: 1,
      min: 0,
    })
    .on('change', (e) => {
      physicsState.minSubSteps = e.value;
      lsSetItem(LS_KEY, physicsState);
    });
  debugGUI
    .addBinding(physicsState, 'maxSubSteps', {
      label:
        'Maximum steps per render frame (Prevents the spiral of death, should usually be the same as timestep), 0 = not in use',
      step: 1,
      min: 0,
    })
    .on('change', (e) => {
      physicsState.maxSubSteps = e.value;
      lsSetItem(LS_KEY, physicsState);
    });
};

export const EDIT_PHY_OBJ_WIN_ID = 'physicsObjectEditorWindow';
let debuggerWindowPane: Pane | null = null;
let debuggerWindowCmp: TCMP | null = null;

export const createEditPhysObjContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string; winId: string };
  const obj = currentScenePhysicsObjects.find((obj) => obj.id === d.id);
  if (debuggerWindowPane) {
    debuggerWindowPane.dispose();
    debuggerWindowPane = null;
  }
  if (debuggerWindowCmp) {
    debuggerWindowCmp.remove();
    debuggerWindowCmp = null;
  }
  if (!obj) {
    // We want to close the window when no phys object is found,
    // but we have to return first, so wait one iteration.
    setTimeout(() => {
      closeDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
    }, 0);
    return CMP();
  }

  addOnCloseToWindow(EDIT_PHY_OBJ_WIN_ID, () => {
    updateDebuggerPhysObjListSelectedClass(null);
  });
  updateDebuggerPhysObjListSelectedClass(d.id);

  debuggerWindowCmp = CMP({
    onRemoveCmp: () => (debuggerWindowPane = null),
  });

  debuggerWindowPane = new Pane({ container: debuggerWindowCmp.elem });

  // @TODO: copy code button
  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this physics object to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: () => {
      llog('PHYSICS OBJECT:***************', obj, '**********************');
    },
  });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () =>
      `<button title="Remove physics object (only for this browser load, does not delete character permanently)">${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      deletePhysicsObject(obj.id);
      closeDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
    },
  });

  debuggerWindowCmp.add({
    prepend: true,
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
<div>
  <div><span class="winSmallLabel">Name:</span> ${obj.name || ''}</div>
  <div><span class="winSmallLabel">Id:</span> ${obj.id}</div>
  ${
    Array.isArray(obj.collider)
      ? `<div><span class="winSmallLabel">Colliders (${obj.collider.length}):</span> ${obj.collider.map((coll) => getColliderShapeName(coll.shape.type)).join(', ')}</div>`
      : `<div><span class="winSmallLabel">Collider:</span> ${getColliderShapeName(obj.collider.shape.type)}</div>`
  }
  ${Array.isArray(obj.collider) ? `<div><span class="winSmallLabel">Current obj index:</span> ${obj.currentObjectIndex || 0}</div>` : ''}
  ${
    Array.isArray(obj.meshes)
      ? `<div><span class="winSmallLabel">Meshes (${obj.meshes.length}):</span> ${obj.meshes.map((m) => m.userData.id).join(', ')}</div>`
      : `<div><span class="winSmallLabel">Mesh:</span> ${obj.mesh?.userData.id || '[No mesh]'}</div>`
  }
  ${Array.isArray(obj.collider) ? `<div><span class="winSmallLabel">Current mesh index:</span> ${obj.currentMeshIndex || 0}</div>` : ''}
</div>
<div style="text-align:right">${logButton}${deleteButton}</div>
</div>`,
  });

  if (obj.rigidBody) {
    const rigidBody = {
      position: obj.rigidBody.translation(),
      rotation: new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(
          obj.rigidBody.rotation().x,
          obj.rigidBody.rotation().y,
          obj.rigidBody.rotation().z,
          obj.rigidBody.rotation().w
        )
      ),
    };
    // Position
    const positionInput = debuggerWindowPane.addBinding(rigidBody, 'position', {
      label: 'Position',
    });
    debuggerWindowPane.addButton({ title: 'Set position' }).on('click', () => {
      obj.rigidBody?.setTranslation(
        new THREE.Vector3(rigidBody.position.x, rigidBody.position.y, rigidBody.position.z),
        true
      );
    });
    debuggerWindowPane.addButton({ title: 'Update position input' }).on('click', () => {
      rigidBody.position = obj.rigidBody?.translation() || rigidBody.position;
      positionInput.refresh();
    });
    debuggerWindowPane.addBlade({ view: 'separator' });
    // Rotation
    const rotationInput = debuggerWindowPane.addBinding(rigidBody, 'rotation', {
      label: 'Rotation',
      step: Math.PI / 8,
    });
    debuggerWindowPane.addButton({ title: 'Set rotation' }).on('click', () => {
      obj.rigidBody?.setRotation(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rigidBody.rotation.x, rigidBody.rotation.y, rigidBody.rotation.z)
        ),
        true
      );
    });
    debuggerWindowPane.addButton({ title: 'Update rotation input' }).on('click', () => {
      rigidBody.rotation = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(
          obj.rigidBody?.rotation().x,
          obj.rigidBody?.rotation().y,
          obj.rigidBody?.rotation().z,
          obj.rigidBody?.rotation().w
        )
      );
      rotationInput.refresh();
    });
  }

  return debuggerWindowCmp;
};

const buildPhysicsObjectsDebugList = () => {
  if (!physicsObjectsDebugList) physicsObjectsDebugList = CMP();

  let html = `<div><h3 class="listItemCount">${currentScenePhysicsObjects.length} physics objects:</h3>`;

  html += '<ul class="ulList">';
  for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
    const obj = currentScenePhysicsObjects[i];
    const button = CMP({
      onClick: () => {
        const winState = getDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
        if (winState?.isOpen && winState?.data?.id === obj.id) {
          closeDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
          return;
        }
        openDraggableWindow({
          id: EDIT_PHY_OBJ_WIN_ID,
          position: { x: 110, y: 60 },
          size: { w: 400, h: 400 },
          saveToLS: true,
          title: `Edit physics object: ${obj.name || `[${obj.id}]`}`,
          isDebugWindow: true,
          content: createEditPhysObjContent,
          data: { id: obj.id, winId: EDIT_PHY_OBJ_WIN_ID },
          closeOnSceneChange: true,
          onClose: () => updateDebuggerPhysObjListSelectedClass(null),
        });
        updateDebuggerPhysObjListSelectedClass(obj.id);
      },
      html: `<button class="listItemWithId">
  <span class="itemId">[${obj.id}]${Array.isArray(obj.collider) ? '<span class="additionalInfo">MULTI</span>' : ''}</span>
  <h4>${obj.name || `[${obj.id}]`}</h4>
</button>`,
    });

    html += `<li data-id="${obj.id}">${button}</li>`;
  }

  if (!currentScenePhysicsObjects.length) {
    html += `<li class="emptyState">No physics objects registered..</li>`;
  }
  html += '</ul></div>';

  physicsObjectsDebugList.update({ html: () => html });

  return physicsObjectsDebugList;
};

export const updatePhysObjectDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (!isDebugEnvironment()) return;
  if (only !== 'WINDOW') buildPhysicsObjectsDebugList();
  if (only === 'LIST') return;
  const winState = getDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
  if (winState) updateDraggableWindow(EDIT_PHY_OBJ_WIN_ID);
};

export const updateDebuggerPhysObjListSelectedClass = (id: string | null) => {
  const ulElem = physicsObjectsDebugList?.elem.getElementsByTagName('ul')[0];
  if (!ulElem) return;

  for (const child of ulElem.children) {
    child.classList.remove('selected');
    if (id === null) continue;
    const elemId = child.getAttribute('data-id');
    if (elemId === id) {
      child.classList.add('selected');
    }
  }
};

const getSceneIdForPhysics = (
  sceneId?: string,
  callerMethodString?: string,
  noWarnForUnitializedScene?: boolean
) => {
  let sId = getCurrentSceneId();
  if (sceneId) {
    const scene = getScene(sceneId);
    sId = scene.userData.id;
  }
  if (!sId) {
    const message = sceneId
      ? `Could not find scene with sceneId "${sceneId}" in ${callerMethodString || 'getCurrentSceneId'}. Set noWarnForUnitializedScene to true if need to suppress this warning.`
      : `Could not find current scene id in addPhysicsObject. If `;
    if (sceneId) {
      if (!noWarnForUnitializedScene) lwarn(message);
      sId = sceneId;
    } else {
      lerror(message);
      throw new Error(message);
    }
  }
  return sId;
};

export const getCurrentScenePhysParams = () => {
  const currentSceneId = existsOrThrow(
    getCurrentSceneId(),
    "Could not get current scene id in 'getCurrentScenePhysParams'."
  );
  if (!physicsState.scenes[currentSceneId]) {
    physicsState.scenes[currentSceneId] = getDefaultScenePhysParams();
  }
  curScenePhysParams = physicsState.scenes[currentSceneId];
  return curScenePhysParams;
};

export const addScenePhysicsLooper = (
  id: string,
  looper?: ScenePhysicsLooper,
  afterStepLooper?: ScenePhysicsLooper
) => {
  if (looper) scenePhysicsLoopers[id] = looper;
  if (afterStepLooper) scenePhysicsAfterStepLoopers[id] = afterStepLooper;
};

export const deleteScenePhysicsLooper = (id: string) => {
  delete scenePhysicsLoopers[id];
  delete scenePhysicsAfterStepLoopers[id];
};

export const deleteAllScenePhysicsLoopers = () => {
  const looperKeys = Object.keys(scenePhysicsLoopers);
  for (let i = 0; i < looperKeys.length; i++) {
    deleteScenePhysicsLooper(looperKeys[i]);
  }
  const afterStepLooperKeys = Object.keys(scenePhysicsAfterStepLoopers);
  for (let i = 0; i < afterStepLooperKeys.length; i++) {
    deleteScenePhysicsLooper(afterStepLooperKeys[i]);
  }
};

// @CHORE: refactor (this and the one in EngineRapier.ts)
// @CHORE: add removeRigidBody and removeCollider to physicsWorld
/**
 * Deletes a physics object
 * @param id string
 * @param sceneId optional string, if not provided the current scene id will be used
 */
export const deletePhysicsObject = (id: string, sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'removePhysicsObject');
  const scenePhysicsObjects = physicsObjects[sId];
  if (!scenePhysicsObjects) return;

  const obj = scenePhysicsObjects[id];
  if (!obj) return;
  if (obj.rigidBody) {
    // Delete rigidBody (also deletes all child colliders)
    physicsWorld.removeRigidBody(obj.rigidBody);
  } else {
    // If the object does not have a rigidBody then delete the individual colliders
    if (Array.isArray(obj.collider)) {
      for (let i = 0; i < obj.collider.length; i++) {
        physicsWorld.removeCollider(obj.collider[i], false);
      }
    } else {
      physicsWorld.removeCollider(obj.collider, false);
    }
  }

  delete scenePhysicsObjects[id];

  if (isCurrentScene(sId)) {
    currentScenePhysicsObjects = currentScenePhysicsObjects.filter((obj) => {
      if (obj.id === id) {
        if (obj.collisionEventFn) collisionEventFnCount--;
        if (obj.contactForceEventFn) contactForceEventFnCount--;
        if (collisionEventFnCount < 0) collisionEventFnCount = 0;
        if (contactForceEventFnCount < 0) contactForceEventFnCount = 0;
      }
      return obj.id !== id;
    });
  }

  // Delete possible meshes
  if (obj.meshes?.length) {
    for (let i = 0; i < obj.meshes.length; i++) {
      const mesh = obj.meshes[i];
      if (mesh?.userData.id) deleteMesh(mesh.userData.id, { deleteAll: true });
    }
  }
  if (obj.mesh?.userData.id) deleteMesh(obj.mesh.userData.id, { deleteAll: true });

  updatePhysObjectDebuggerGUI('LIST');
};

/**
 * Deletes all physics objects from a scene
 * @param sceneId (string) scene id
 */
export const deletePhysicsObjectsBySceneId = (sceneId: string) => {
  const objects = physicsObjects[sceneId];
  if (!objects) return;
  const keys = Object.keys(objects);
  for (let i = 0; i < keys.length; i++) {
    deletePhysicsObject(keys[i], sceneId);
  }
  delete physicsObjects[sceneId];
  if (isCurrentScene(sceneId)) deleteCurrentScenePhysicsObjects();

  updatePhysObjectDebuggerGUI();
};

// @CONSIDER: maybe remove this as we anyways destroy all the physics objects during scene (un)load
export const deleteCurrentScenePhysicsObjects = () => {
  for (let i = 0; i < currentScenePhysicsObjects.length; i++) {
    const obj = currentScenePhysicsObjects[i];
    if (obj.rigidBody) {
      obj.rigidBody.setEnabled(false);
      physicsWorld.removeRigidBody(obj.rigidBody);
    } else {
      if (Array.isArray(obj.collider)) {
        for (let i = 0; i < obj.collider.length; i++) {
          obj.collider[i].setEnabled(false);
          physicsWorld.removeCollider(obj.collider[i], false);
        }
      } else {
        obj.collider.setEnabled(false);
        physicsWorld.removeCollider(obj.collider, false);
      }
    }
  }
  currentScenePhysicsObjects = [];

  const currentSceneId = getCurrentSceneId();
  !existsOrWarn(
    currentSceneId,
    `Could not find currentSceneId (id: ${currentSceneId}) in deleteCurrentScenePhysicsObjects`
  );
  if (currentSceneId) physicsObjects[currentSceneId] = {};

  updatePhysObjectDebuggerGUI();
};

/**
 * Deletes all physics objects and clears the currentScenePhysicsObjects
 */
export const deleteAllPhysicsObjects = () => {
  const sceneIds = Object.keys(physicsObjects);
  for (let i = 0; i < sceneIds.length; i++) {
    deletePhysicsObjectsBySceneId(sceneIds[i]);
  }
  currentScenePhysicsObjects = [];
};

/**
 * Checks, with a physics object id, whether a physics object exists or not
 * @param id (string) physics object id
 * @param sceneId (string) optional scene id, if not defined the current scene id will be used
 * @returns boolean
 */
export const doesPOExist = (id: string, sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'doesGeoExist', true);
  return Boolean(physicsObjects[sId][id]);
};

/** Returns the current physicsState */
export const getPhysicsState = () => physicsState;

/**
 * Return a physics object by id and sceneId
 * @param id string
 * @param sceneId optional string, if not provided the current scene id will be used
 * @returns PhysicsObject ({@link PhysicsObject})
 */
export const getPhysicsObject = (id: string, sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'getPhysicsObject');
  const scenePhysicsObjects = physicsObjects[sId];
  if (!scenePhysicsObjects) return undefined;
  return scenePhysicsObjects[id];
};

/**
 * Return a physics objects by array of ids
 * @param ids array of strings
 * @param sceneId optional scene id string where the physics object searched from
 * @returns PhysicsObject[] ({@link PhysicsObject})
 */
export const getPhysicsObjects = (ids: string[], sceneId?: string) => {
  const sId = getSceneIdForPhysics(sceneId, 'getPhysicsObjects');
  const scenePhysicsObjects = physicsObjects[sId] || [];
  const objects: PhysicsObject[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!scenePhysicsObjects[ids[i]]) continue;
    objects.push(scenePhysicsObjects[ids[i]]);
  }
  return objects;
};

/**
 * Returns the current scene physics objects
 * @returns currentScenePhysicsObjects
 */
export const getCurrentScenePhysicsObjects = () => currentScenePhysicsObjects;

/**
 * Changes the scene to be used for the scene's physics objects (optimizes the stepping)
 * @param sceneId string of the new scene id to change to
 */
export const setCurrentScenePhysicsObjects = (sceneId: string | null) => {
  if (!RAPIER) return; // @CHORE: refactor to check a global engine variable set in the init

  initDebuggerScenePhysState();

  currentScenePhysicsObjects = [];
  collisionEventFnCount = 0;
  contactForceEventFnCount = 0;
  if (eventQueue) eventQueue.clear();

  if (!sceneId) return;

  const allNewPhysicsObjects = physicsObjects[sceneId];
  if (!allNewPhysicsObjects) return;

  const keys = Object.keys(allNewPhysicsObjects);
  for (let i = 0; i < keys.length; i++) {
    const obj = allNewPhysicsObjects[keys[i]];
    if (!obj) continue;
    currentScenePhysicsObjects.push(obj);
    if (obj.rigidBody) {
      obj.rigidBody.setEnabled(true);
    } else {
      if (Array.isArray(obj.collider)) {
        obj.collider[obj.currentObjectIndex || 0].setEnabled(true);
      } else {
        obj.collider.setEnabled(true);
      }
    }
    if (obj.collisionEventFn) collisionEventFnCount++;
    if (obj.contactForceEventFn) contactForceEventFnCount++;
  }
};

export const switchPhysicsMesh = (id: string, newIndex: number) => {
  const obj = existsOrThrow(
    getPhysicsObject(id),
    `Could not find physics object with id '${id}' in switchPhysicsMesh.`
  );
  if (!obj.meshes) {
    lwarn(
      `Physics object has only 1 mesh and cannot be switched in switchPhysicsMesh (id: '${id}').`
    );
    return;
  }
  const newMesh = obj.meshes[newIndex];
  if (!newMesh) {
    lwarn(
      `Physics object mesh not found with index ${newIndex} in switchPhysicsMesh (id: '${id}')`
    );
  }

  const currentIndex = obj.currentObjectIndex || 0;
  obj.meshes[currentIndex].visible = false;
  newMesh.visible = true;
  obj.mesh = newMesh;
  obj.currentMeshIndex = newIndex;

  updatePhysObjectDebuggerGUI('WINDOW');
};

export const switchPhysicsCollider = (id: string, newIndex: number) => {
  const obj = existsOrThrow(
    getPhysicsObject(id),
    `Could not find physics object with id '${id}' in switchPhysicsCollider.`
  );
  if (!Array.isArray(obj.collider)) {
    lwarn(
      `Physics object has only 1 collider and cannot be switched in switchPhysicsCollider (id: '${id}').`
    );
    return;
  }
  const newCollider = obj.collider[newIndex];
  if (!newCollider) {
    lwarn(
      `Physics object collider not found with index ${newIndex} in switchPhysicsCollider (id: '${id}')`
    );
  }

  const currentIndex = obj.currentObjectIndex || 0;
  obj.collider[currentIndex].setEnabled(false);
  newCollider.setEnabled(true);
  obj.currentObjectIndex = newIndex;

  updatePhysObjectDebuggerGUI('WINDOW');
};

/** NEW STUFF (@CHORE: delete this line when everything is diamonds!!!) */

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
  if (physicsWorld) {
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
    if (isDebugEnvironment()) initDebuggerScenePhysState();
    addVisibilityChangeFn('pausePhysicsOnVisibilityChange', physicsVisibilityChangeHandler);
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<CreateWorldResponse>({
      type: PhysicsProtocolType.CREATE_WORLD,
      gravity: gravityArg,
      opts: optsArg,
    });
    if (response.worldCreated) {
      physicsWorld = createWorkerPhysicsWorldAPI();
      physicsWorldEnabled = true;
      if (isDebugEnvironment()) initDebuggerScenePhysState(); // @CHORE: this needs to change (no scene stuff)
      addVisibilityChangeFn('pausePhysicsOnVisibilityChange', physicsVisibilityChangeHandler);
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
    collisionEventFnCount = 0;
    contactForceEventFnCount = 0;
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
    physicsWorld = createWorkerPhysicsWorldAPI(); // Not sure if we need to recreate the WorldAPI?
    if (response.worldCreated) physicsWorld = createWorkerPhysicsWorldAPI();
  }
  return physicsWorld;
};

/** Create a rigid body. */
export const createRigidBody = async (params: RigidBodyParams) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a rigid body.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    return existsOrThrow(
      engAPI?.createRigidBody(params),
      `Could not create a rigid body ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const rbId = (
      await messageWorkerAsync<CreateRigidBodyResponse>({
        type: PhysicsProtocolType.CREATE_RIGID_BODY,
        params,
      })
    ).id;
    const rbAPI = existsOrThrow(
      new RigidBodyProxyAPI(rbId, params.userData),
      `Could not create a rigid body ("WORKER_THREAD"). Params: ${JSON.stringify(params)}`
    );
    return rbAPI;
  }
  // Should not get here..
  throw new Error(
    `Could not create rigid bodies (workerTarget was not 'MAIN_THREAD' nor was it 'WORKER_THREAD'), worker target: ${physicsState.workerTarget}`
  );
};

/** Create multiple rigid bodies at once. */
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
    const rbIds = (
      await messageWorkerAsync<CreateRigidBodiesResponse>({
        type: PhysicsProtocolType.CREATE_RIGID_BODIES,
        params,
      })
    ).ids;
    existsOrThrow(
      rbIds.length,
      `Could not create a rigid bodies ("WORKER_THREAD"). Params: ${JSON.stringify(params)}`
    );
    const rbAPIs = [];
    for (let i = 0; i < rbIds.length; i++) {
      const id = rbIds[i];
      const rbAPI = new RigidBodyProxyAPI(id, params[i].userData);
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

/** Deletes a rigid body (and all child colliders). Returns the id of the deleted rigidBodyAPI. */
export const deleteRigidBody = async (id: number /*, deletePhysicsObject?: boolean */) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting a rigid body.'
  );
  let deletedId: number | undefined = undefined;
  let deletedColliderIds: number[] = [];
  if (rigidBodies.has(id)) rigidBodies.delete(id);
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteRigidBody(id);
    deletedId = response?.id;
    deletedColliderIds = response?.colliderIds || [];
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<DeleteRigidBodyResponse>({
      type: PhysicsProtocolType.DELETE_RIGID_BODY,
      id,
    });
    deletedId = response?.id;
    deletedColliderIds = response?.colliderIds || [];
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
  }

  // @CHORE: add deletePhysicsObject flag
  return deletedId;
};

/** Deletes multiple rigid bodies (and all child colliders). Returns the ids of the deleted rigidBodyAPIs. */
export const deleteRigidBodies = async (ids: number[] /*, deletePhysicsObject?: boolean */) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before deleting rigid bodies.'
  );
  if (!ids.length) return [];
  let deletedIds: number[] | undefined = undefined;
  let deletedColliderIds: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (rigidBodies.has(ids[i])) rigidBodies.delete(ids[i]);
  }
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteRigidBodies(ids);
    deletedIds = response?.ids;
    deletedColliderIds = response?.colliderIds || [];
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const response = await messageWorkerAsync<DeleteRigidBodiesResponse>({
      type: PhysicsProtocolType.DELETE_RIGID_BODIES,
      ids,
    });
    deletedIds = response?.ids;
    deletedColliderIds = response?.colliderIds || [];
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
  }

  // @CHORE: add deletePhysicsObject flag
  return deletedIds;
};

/** Create a collider. */
export const createCollider = async (params: ColliderParams) => {
  existsOrThrow(
    physicsWorldEnabled,
    'Physics world is not created. Create the world before creating a collider.'
  );
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    return existsOrThrow(
      engAPI?.createCollider(params),
      `Could not create a collider ("MAIN_THREAD"). Params: ${JSON.stringify(params)}`
    );
  } else if (physicsState.workerTarget === 'WORKER_THREAD') {
    const collId = (
      await messageWorkerAsync<CreateColliderResponse>({
        type: PhysicsProtocolType.CREATE_COLLIDER,
        params,
      })
    ).id;
    const collAPI = existsOrThrow(
      createEnginePhysicsColliderAPI(collId),
      `Could not create a collider ("WORKER_THREAD"). Params: ${JSON.stringify(params)}`
    );
    if (params.userData) {
      // This is okay when creating these, since we know we have the
      // same userData state in the engine (uData should after this
      // set with userData(data) method).
      collAPI.uData = params.userData;
    }
    colliders.set(collId, collAPI);
    return collAPI;
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
        params,
      })
    ).ids;
    existsOrThrow(
      collIds.length,
      `Could not create colliders ("WORKER_THREAD"). Params: ${JSON.stringify(params)}`
    );
    const collAPIs = [];
    for (let i = 0; i < collIds.length; i++) {
      const id = collIds[i];
      const collAPI = createEnginePhysicsColliderAPI(id);
      const userData = params[i].userData;
      if (userData) {
        // This is okay when creating these, since we know we have the
        // same userData state in the engine (uData should after this
        // set with userData(data) method).
        collAPI.uData = userData;
      }
      collAPIs.push(collAPI);
      colliders.set(id, collAPI);
    }
    return collAPIs;
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
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteCollider(id);
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
  }
  if (physicsState.workerTarget === 'MAIN_THREAD') {
    const response = engAPI?.deleteColliders(ids);
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

export const getRigidBody = (id: number) => rigidBodies.get(id);
export const getCollider = (id: number) => colliders.get(id);

/** World, RigidBody, and Collider API definitions -----[ START ]----- */

class WorldProxyAPI implements WorldAPI {
  restoringWorld: boolean;
  // Local cache for sync getters (updated via worker messages or setters)
  private _cache = {
    gravity: physicsState.gravity,
    timestep: 0.016,
    lengthUnit: 1.0,
    solverIters: 4,
    pgsIters: 1,
    ccdSubsteps: 1,
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

  async restoreSnapshot(data: Uint8Array): Promise<WorldAPI> {
    return restorePhysicsSnapshot(data);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  restoreSnapshotSync(_data: Uint8Array): WorldAPI {
    const msg =
      'restoreSnapshotSync is not supported in Worker thread mode. Use restoreSnapshot(data).';
    lerror(msg);
    throw new Error(msg);
  }

  propagateModifiedBodyPositionsToColliders(): void {
    messageWorker({ type: PhysicsProtocolType.WORLD_PROPAGATE_POSITIONS });
  }

  // --- Parameters (Timestep, Units, Solver) ---
  async getTimestep(): Promise<number> {
    const res = await messageWorkerAsync<{ dt: number }>({
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
    const res = await messageWorkerAsync<{ unit: number }>({
      type: PhysicsProtocolType.WORLD_GET_LENGTH_UNIT,
    });
    this._cache.lengthUnit = res.unit;
    return res.unit;
  }
  getLengthUnitSync(): number {
    return this._cache.lengthUnit;
  }
  setLengthUnit(unitsPerMeter: number): void {
    this._cache.lengthUnit = unitsPerMeter;
    messageWorker({ type: PhysicsProtocolType.WORLD_SET_LENGTH_UNIT, unitsPerMeter });
  }

  async getNumSolverIterations(): Promise<number> {
    const res = await messageWorkerAsync<{ iters: number }>({
      type: PhysicsProtocolType.WORLD_GET_SOLVER_ITERS,
    });
    this._cache.solverIters = res.iters;
    return res.iters;
  }
  getNumSolverIterationsSync(): number {
    return this._cache.solverIters;
  }
  setNumSolverIterations(niter: number): void {
    this._cache.solverIters = niter;
    messageWorker({ type: PhysicsProtocolType.WORLD_SET_SOLVER_ITERS, niter });
  }

  async getNumInternalPgsIterations(): Promise<number> {
    const res = await messageWorkerAsync<{ iters: number }>({
      type: PhysicsProtocolType.WORLD_GET_PGS_ITERS,
    });
    this._cache.pgsIters = res.iters;
    return res.iters;
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
    const res = await messageWorkerAsync<{ id: number }>({
      type: PhysicsProtocolType.WORLD_CREATE_RIGID_BODY,
      params,
    });
    return createRigidBodyProxy(res.id); // Helper to instantiate the Proxy
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createRigidBodySync(_params: RigidBodyParams): RigidBodyAPI {
    const msg =
      'Synchronous creation is not supported in Worker thread mode. Use createRigidBody(params).';
    lerror(msg);
    throw new Error(msg);
  }

  async createCollider(params: ColliderParams, parent?: RigidBodyAPI): Promise<ColliderAPI> {
    const res = await messageWorkerAsync<{ id: number }>({
      type: PhysicsProtocolType.WORLD_CREATE_COLLIDER,
      params,
      parentId: parent?.id,
    });
    return createColliderProxy(res.id);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createColliderSync(_params: ColliderParams, _parent?: RigidBodyAPI): ColliderAPI {
    const msg =
      'Synchronous creation is not supported in Worker thread mode. Use createCollider(params, parent?).';
    lerror(msg);
    throw new Error(msg);
  }

  // --- Retrieval ---
  /** Returns the main thread rigid body registry rigidBodyAPI promise.
   * It is suggested to use getRigidBodySync(id) method instead of this
   * as it is synchronous and faster.
   */
  async getRigidBody(id: number): Promise<RigidBodyAPI | undefined> {
    // Usually checks a local registry Map<number, RigidBodyProxy>
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

  // --- Removal ---
  removeRigidBody(bodyOrId: RigidBodyAPI | number): void {
    const id = typeof bodyOrId === 'number' ? bodyOrId : bodyOrId.id;
    messageWorker({ type: PhysicsProtocolType.WORLD_REMOVE_RIGID_BODY, id });
    rigidBodies.delete(id);
  }

  removeCollider(colliderOrId: ColliderAPI | number, wakeUp: boolean): void {
    const id = typeof colliderOrId === 'number' ? colliderOrId : colliderOrId.id;
    messageWorker({ type: PhysicsProtocolType.WORLD_REMOVE_COLLIDER, id, wakeUp });
    colliders.delete(id);
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
        excludeCollider:
          typeof filterExcludeCollider === 'number'
            ? filterExcludeCollider
            : filterExcludeCollider?.id,
        excludeRigidBody:
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

  async castRayAndGetNormal(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroupsAPI
  ): Promise<RayColliderIntersectionAPI | null> {
    return await messageWorkerAsync<RayColliderIntersectionAPI | null>({
      type: PhysicsProtocolType.WORLD_CAST_RAY_AND_NORMAL,
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
  intersectionsWithRay(
    ray: PhysRay,
    maxToi: number,
    solid: boolean,
    callback: (intersect: RayColliderIntersectionAPI) => boolean
  ): void {
    // Implementation usually requires the worker to stream results back or return a batch
    console.warn('Streamed ray intersections over workers require a custom batch implementation.');
  }

  contactPairsWith(collider1: ColliderAPI | number, f: (collider2: ColliderAPI) => void): void {
    // logic to query worker and run f for each ID returned
  }

  intersectionPairsWith(
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ): void {
    // logic to query worker
  }

  async intersectionPair(
    collider1: ColliderAPI | number,
    collider2: ColliderAPI | number
  ): Promise<boolean> {
    return await messageWorkerAsync<boolean>({
      type: PhysicsProtocolType.WORLD_INTERSECTION_PAIR,
      id1: typeof collider1 === 'number' ? collider1 : collider1.id,
      id2: typeof collider2 === 'number' ? collider2 : collider2.id,
    });
  }

  intersectionPairSync(): boolean {
    return false; // Or check a local "Intersection Cache" if you sync contact pairs every frame
  }
}

const createWorkerPhysicsWorldAPI = (): WorldProxyAPIType => ({
  restoringWorld: false,
  gravity: async (gravity?: PhysVector) =>
    (
      await messageWorkerAsync<WorldGravityResponse>({
        type: PhysicsProtocolType.WORLD_GRAVITY,
        gravity,
      })
    )?.gravity,
  free: () => messageWorker({ type: PhysicsProtocolType.WORLD_FREE, isOneWay: true }),
  takeSnapshot: async () => await takePhysicsSnapshot(),
  restoreSnapshot: async (snapshot: Uint8Array) => await restorePhysicsSnapshot(snapshot),
  propagateModifiedBodyPositionsToColliders: () =>
    messageWorker({
      type: PhysicsProtocolType.WORLD_PROPAGATE_MODIFIED_BODY_POSITIONS_TO_COLLIDERS,
      isOneWay: true,
    }),
  timestep: async (dt?: number) =>
    (
      await messageWorkerAsync<WorldTimestepResponse>({
        type: PhysicsProtocolType.WORLD_TIMESTEP,
        dt,
      })
    )?.dt,
  lengthUnit: async (unitsPerMeter?: number) =>
    (
      await messageWorkerAsync<WorldLengthUnitResponse>({
        type: PhysicsProtocolType.WORLD_LENGTH_UNIT,
        unitsPerMeter,
      })
    )?.unitsPerMeter,
  numSolverIterations: async (niter?: number) =>
    (
      await messageWorkerAsync<WorldNumSolverIterationsResponse>({
        type: PhysicsProtocolType.WORLD_NUM_SOLVER_ITERATIONS,
        niter,
      })
    )?.solverIterations,
  numInternalPgsIterations: async (niter?: number) =>
    (
      await messageWorkerAsync<WorldNumInternalPgsIterationsResponse>({
        type: PhysicsProtocolType.WORLD_NUM_INTERNAL_PGS_ITERATIONS,
        niter,
      })
    )?.internalPgsIterations,
  maxCcdSubsteps: async (substeps?: number) =>
    (
      await messageWorkerAsync<WorldMaxCcdSubstepsResponse>({
        type: PhysicsProtocolType.WORLD_MAX_CCD_SUBSTEPS,
        substeps,
      })
    )?.substeps,
  createRigidBody: async (params: RigidBodyParams) => await createRigidBody(params),
  createCollider: async (params: ColliderParams) => await createCollider(params),
  getRigidBody: async (id: number) => rigidBodies.get(id),
  getCollider: async (id: number) => colliders.get(id),
  removeRigidBody: async (bodyOrId: RigidBodyAPI | number) => {
    // @CHORE
  },
  removeCollider: async (bodyOrId: ColliderAPI | number, wakeUp?: boolean) => {
    // @CHORE
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
    const filtExclColl = getCollOrRigidId(filterExcludeCollider);
    const filtExclRB = getCollOrRigidId(filterExcludeRigidBody);
    const hit = (
      await messageWorkerAsync<WorldCastRayResponse>({
        type: PhysicsProtocolType.WORLD_CAST_RAY,
        ray,
        maxToi,
        solid,
        filterFlags,
        filterGroups,
        filterExcludeCollider: filtExclColl,
        filterExcludeRigidBody: filtExclRB,
      })
    ).hit;
    if (hit) {
      const collider = colliders.get(hit.collider);
      if (collider) return { ...hit, collider };
    }
    return null;
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
    const filtExclColl = getCollOrRigidId(filterExcludeCollider);
    const filtExclRB = getCollOrRigidId(filterExcludeRigidBody);
    const intersection = (
      await messageWorkerAsync<WorldCastRayAndGetNormalResponse>({
        type: PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL,
        ray,
        maxToi,
        solid,
        filterFlags,
        filterGroups,
        filterExcludeCollider: filtExclColl,
        filterExcludeRigidBody: filtExclRB,
      })
    ).intersection;
    if (intersection) {
      const collider = colliders.get(intersection.collider);
      if (collider) return { ...intersection, collider };
    }
    return null;
  },
  intersectionsWithRay: async (
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
    const filtExclColl = getCollOrRigidId(filterExcludeCollider);
    const filtExclRB = getCollOrRigidId(filterExcludeRigidBody);
    const intersections = (
      await messageWorkerAsync<WorldIntersectionsWithRayResponse>({
        type: PhysicsProtocolType.WORLD_CAST_RAY_AND_GET_NORMAL,
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
  },
  contactPairsWith: async (
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ) => {
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
  },
  intersectionPairsWith: async (
    collider1: ColliderAPI | number,
    f: (collider2: ColliderAPI) => void
  ) => {
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
  },
  intersectionPair: async (collider1: ColliderAPI | number, collider2: ColliderAPI | number) => {
    const coll1Id = getCollOrRigidId(collider1);
    const coll2Id = getCollOrRigidId(collider2);
    if (coll1Id === undefined || coll2Id === undefined) return false;
    const isIntersecting = (
      await messageWorkerAsync<WorldIntersectionPairResponse>({
        type: PhysicsProtocolType.WORLD_INTERSECTION_PAIR,
        colliderId1: coll1Id,
        colliderId2: coll2Id,
      })
    ).isIntersecting;
    return isIntersecting;
  },
});

class RigidBodyProxyAPI implements RigidBodyWorkerEngine {
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
  }

  async getUserData() {
    const fetchedUserData = (
      await messageWorkerAsync<RigidGetUserDataResponse>({
        type: PhysicsProtocolType.RIGID_GET_USERDATA,
        rigidBodyId: this.id,
      })
    ).userData;
    this.uData = fetchedUserData;
    return fetchedUserData;
  }

  setUserData(userData: Record<string, unknown>, addToExisting?: boolean) {
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

  async nextRotation(): Promise<PhysRotation> {
    return (
      await messageWorkerAsync<RigidNextRotationResponse>({
        type: PhysicsProtocolType.RIGID_NEXT_ROTATION,
        rigidBodyId: this.id,
      })
    ).nextRotation;
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

  async effectiveInvMass(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidEffectiveInvMassResponse>({
        type: PhysicsProtocolType.RIGID_EFFECTIVE_INV_MASS,
        rigidBodyId: this.id,
      })
    ).effectiveInvMass;
  }

  async invMass(): Promise<number> {
    return (
      await messageWorkerAsync<RigidInvMassResponse>({
        type: PhysicsProtocolType.RIGID_INV_MASS,
        rigidBodyId: this.id,
      })
    ).invMass;
  }

  async localCom(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidLocalComResponse>({
        type: PhysicsProtocolType.RIGID_LOCAL_COM,
        rigidBodyId: this.id,
      })
    ).localCom;
  }

  async worldCom(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidWorldComResponse>({
        type: PhysicsProtocolType.RIGID_WORLD_COM,
        rigidBodyId: this.id,
      })
    ).worldCom;
  }

  async invPrincipalInertia(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidInvPrincipalInertiaResponse>({
        type: PhysicsProtocolType.RIGID_INV_PRINCIPAL_INERTIA,
        rigidBodyId: this.id,
      })
    ).invPrincipalInertia;
  }

  async principalInertia(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidPrincipalInertiaResponse>({
        type: PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA,
        rigidBodyId: this.id,
      })
    ).principalInertia;
  }

  async principalInertiaLocalFrame(): Promise<PhysRotation> {
    return (
      await messageWorkerAsync<RigidPrincipalInertiaLocalFrameResponse>({
        type: PhysicsProtocolType.RIGID_PRINCIPAL_INERTIA_LOCAL_FRAME,
        rigidBodyId: this.id,
      })
    ).principalInertiaLocalFrame;
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

  async numColliders(): Promise<number> {
    return (
      await messageWorkerAsync<RigidNumCollidersResponse>({
        type: PhysicsProtocolType.RIGID_NUM_COLLIDERS,
        rigidBodyId: this.id,
      })
    ).numColliders;
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

  async bodyType(): Promise<RigidBodyTypeAPI> {
    return (
      await messageWorkerAsync<RigidBodyTypeResponse>({
        type: PhysicsProtocolType.RIGID_BODY_TYPE,
        rigidBodyId: this.id,
      })
    ).bodyType;
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

  async isMoving(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsMovingResponse>({
        type: PhysicsProtocolType.RIGID_IS_MOVING,
        rigidBodyId: this.id,
      })
    ).isMoving;
  }

  async isFixed(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsFixedResponse>({
        type: PhysicsProtocolType.RIGID_IS_FIXED,
        rigidBodyId: this.id,
      })
    ).isFixed;
  }

  async isKinematic(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsKinematicResponse>({
        type: PhysicsProtocolType.RIGID_IS_KINEMATIC,
        rigidBodyId: this.id,
      })
    ).isKinematic;
  }

  async isDynamic(): Promise<boolean> {
    return (
      await messageWorkerAsync<RigidIsDynamicResponse>({
        type: PhysicsProtocolType.RIGID_IS_DYNAMIC,
        rigidBodyId: this.id,
      })
    ).isDynamic;
  }

  async linearDamping(): Promise<number> {
    return (
      await messageWorkerAsync<RigidLinearDampingResponse>({
        type: PhysicsProtocolType.RIGID_LINEAR_DAMPING,
        rigidBodyId: this.id,
      })
    ).linearDamping;
  }

  async angularDamping(): Promise<number> {
    return (
      await messageWorkerAsync<RigidAngularDampingResponse>({
        type: PhysicsProtocolType.RIGID_ANGULAR_DAMPING,
        rigidBodyId: this.id,
      })
    ).angularDamping;
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

  async userTorque(): Promise<PhysVector> {
    return (
      await messageWorkerAsync<RigidUserTorqueResponse>({
        type: PhysicsProtocolType.RIGID_USER_TORQUE,
        rigidBodyId: this.id,
      })
    ).userTorque;
  }
}

const createWorkerPhysicsRigidBodyAPI = (id: number): RigidBodyAPI => ({
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
  id,
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
