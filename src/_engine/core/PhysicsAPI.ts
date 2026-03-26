// import {
//   type PhysicsObject,
//   type ColliderParams,
//   type RigidBodyParams,
//   type PhysicsParams,
//   createRigidBody,
//   createCollider,
//   createPhysicsObjectWithoutMesh,
//   createPhysicsObjectWithMesh,
//   switchPhysicsCollider,
//   switchPhysicsMesh,
//   deletePhysicsObject,
//   deletePhysicsObjectsBySceneId,
//   deleteCurrentScenePhysicsObjects,
//   deleteAllPhysicsObjects,
//   doesPOExist,
//   createPhysicsWorld,
//   deletePhysicsWorld,
//   getPhysicsObject,
//   getPhysicsObjects,
//   getRAPIER,
//   getPhysicsWorld,
//   createPhysicsDebugMesh,
//   stepPhysicsWorld,
//   setCurrentScenePhysicsObjects,
//   getCurrentScenePhysicsObjects,
//   togglePhysicsVisualizer,
//   InitRapierPhysics,
//   addScenePhysicsLooper,
//   deleteScenePhysicsLooper,
//   deleteAllScenePhysicsLoopers,
//   getCurrentScenePhysParams,
// } from './PhysicsRapier';

import PhysicsWorker from '../workers/physicsWorker?worker';
import { PhysicsMessageDownEvent, PhysicsMessageUpEvent } from '../workers/physicsWorker';
import { getConfig, isDebugEnvironment } from './Config';
import { lsGetItem } from '../utils/LocalAndSessionStorage';
import { initPhysicsEngine, PhysicsState } from './PhysicsTypes';

// @TODO: refactor the current PhysicsRapier.ts to not return any actual Rapier physics entities (RigidBody, Collider, World etc.).
// Replace the current physics entities as APIs: eg. physObj = { rigidBody: setLinvel = (Vec3, wakeUp) => { // Custom function here that checks whether we are using threaded version or not and also if we are in the worker or in the main thread. } }
// Also eg. getPhysicsWorld = () => { // Same check here... }

const LS_KEY = 'debugPhysics';

let worker: Worker | null = null;
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
  scenes: {},
};

/**
 * Initializes the physics if enabled
 * @param initPhysicsCallback ((PhysicsWorld, ) => void) optional function that will be called after the physics have been initalized
 * @returns Promise<PhysicsWorld>
 */
export const InitPhysics = async () => {
  const physicsConfig = getConfig().physics;
  const enabled = physicsConfig?.enabled || false;
  if (!enabled) return;

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
  const curEngine = physicsState.physicsEngine;
  const target = physicsState.workerTarget;

  if (target === 'MAIN_THREAD') {
    // Main thread
    return initPhysicsEngine(curEngine).then(() => {
      // @TODO...
      // if (isDebugEnvironment()) {
      //   createDebugControls();
      //   createPhysicsDebugMesh();
      //   stepperFn = stepperFnDebug;
      // } else {
      //   stepperFn = stepperFnProduction;
      // }
    });
  } else {
    // Worker thread
    initPhysicsWorker();
    // @TODO...
    // messageWorker(message.........)
  }
  // return enabled
  //   ? initRapier().then((rapier) => {
  //       physicsState = {
  //         ...physicsState,
  //         ...(physicsConfig?.timestep ? { timestep: physicsConfig.timestep } : {}),
  //         enabled,
  //       };
  //       physicsState.timestepRatio = 1 / (physicsState.timestep || 60);

  //       RAPIER = rapier;
  //       if (isDebugEnvironment()) {
  //         createDebugControls();
  //         createPhysicsDebugMesh();
  //         stepperFn = stepperFnDebug;
  //       } else {
  //         stepperFn = stepperFnProduction;
  //       }
  //       if (initPhysicsCallback) initPhysicsCallback(physicsWorld);

  //       return rapier;
  //     })
  //   : null;
};

export const messageWorker = (message: PhysicsMessageUpEvent) => {
  if (!worker) return;
  worker.postMessage(message);
};

export const initPhysicsWorker = () => {
  worker = new PhysicsWorker();
  worker.onmessage = onWorkerMessage;
};

export const onWorkerMessage = (event: MessageEvent<PhysicsMessageDownEvent>) => {
  console.log('Main thread received:', event.data);
};
