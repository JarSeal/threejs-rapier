let curEngine: unknown = null;
const engines = {
  RAPIER: async <T>() => {
    const mod = await import('@dimforge/rapier3d-compat');
    const RAPIER = mod.default;
    await RAPIER.init();
    return RAPIER as T;
  },
};
export const initPhysicsEngine = async <T>(engine: PhysicsEngine) => {
  curEngine = await engines[engine]<T>();
  return curEngine;
};
export const getPhysicsEngine = <T>() => curEngine as T;

export type PhysicsEngine = keyof typeof engines; // + possible other engines if implemented
export type WorkerTarget = 'MAIN_THREAD' | 'WORKER_THREAD'; // + possible 'SERVER_AND_MAIN' | 'SERVER_AND_WORKER' if implemented

export type PhysicsState = {
  enabled: boolean;
  physicsEngine: PhysicsEngine;
  workerTarget: WorkerTarget;
  timestep: number;
  timestepRatio: number;
  /** What to do with physics loop if the app window is hidden (under another window, in another tab, minified).
   * 'KEEP_RUNNIN' = Keeps the physics running in the background.
   * 'KEEP_RUNNING_USE_MIN_DELTA' = If for some reason the physics cannot run in the background, the minDeltaTime will be set as new delta time. Requires: minDelta > 0.
   * 'PAUSE' = Pauses the physics when the window is hidden and then uses the minDeltaTime to continue. Requires: minDelta > 0.
   */
  backgroundBehavior: 'KEEP_RUNNING' | 'KEEP_RUNNING_USE_MIN_DELTA' | 'PAUSE';
  isPaused: boolean;
  /** When the physics loop is on pause (backgroundBehavior = 'PAUSE', loopState.masterPlay = false, or loopState.appPlay = false)
   * the time it was paused (performance.now()). 0 = not paused.
   */
  pausedTime: number;
  /** Total pause duration, used for the getPhysGameTime helper (in the helpers.ts) */
  pauseDurationTotal: number;
  /** Keeps track whether the pause reason is the background behavior (if the app window is hidden) */
  pauseReason: 'BACKGROUND_BEHAVIOR' | null;
  /** The minimum delta time to be used for backgroundBehaviors 'USE_MIN_DELTA' and 'PAUSE'.
   * 0 = not in use
   */
  minDeltaTime: number;
  /** Clamping protects against large delta times even in the foreground (e.g., if rendering stalls).
   * 0 = not in use
   */
  maxDeltaTime: number;
  /** This ensures stability by forcing the engine to run at least 'minSubsteps'
   * per frame even if the frame rate is extremely high and deltaTime is tiny.
   * 0 = not in use
   */
  /**  */
  minSubSteps: number;
  /** Prevent the spiral of death (should usually be the same as timestep) */
  maxSubSteps: number;
  scenes: { [sceneId: string]: ScenePhysicsState };
};

export type ScenePhysicsState = {
  worldStepEnabled: boolean;
  visualizerEnabled: boolean;
  gravity: { x: number; y: number; z: number };
  solverIterations: number;
  internalPgsIterations: number;
  interpolationEnabled: boolean;
};

export type PhysicsWorld = {
  gravity: Vector;
  // integrationParameters: IntegrationParameters;
  // islands: IslandManager;
  // broadPhase: BroadPhase;
  // narrowPhase: NarrowPhase;
  // bodies: RigidBodySet;
  // colliders: ColliderSet;
  // impulseJoints: ImpulseJointSet;
  // multibodyJoints: MultibodyJointSet;
  // ccdSolver: CCDSolver;
  // physicsPipeline: PhysicsPipeline;
  // serializationPipeline: SerializationPipeline;
  // debugRenderPipeline: DebugRenderPipeline;
  // characterControllers: Set<KinematicCharacterController>;
  // pidControllers: Set<PidController>;
  // vehicleControllers: Set<DynamicRayCastVehicleController>;
};

interface Vector {
  x: number;
  y: number;
  z: number;
}
