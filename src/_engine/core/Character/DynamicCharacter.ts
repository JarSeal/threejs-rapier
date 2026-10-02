import * as THREE from 'three/webgpu';
import { createCharacter, emitLocomotionStateChange, onLocomotionStateChange } from '../Character';
import type {
  CharacterBodyPlan,
  CharacterCastRecord,
  CharacterColliderRole,
  CharacterControlMode,
  CharacterIntent,
  CharacterObject,
  CharacterProbes,
  LocomotionState,
  LocomotionStateListener,
} from './CharacterTypes';
import { HUMANOID_CAPSULE } from './CharacterBodyPlans';
import {
  clearIntentSubStep,
  createIntent,
  hasMoveIntent,
  wrapToPi,
  yawFromDirection,
} from './CharacterIntent';
import {
  createCharacterInput,
  SCHEME_TURNS_TO_MOVE_DIRECTION,
  type CharacterInputOpts,
} from './CharacterInputSchemes';
import { getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { getPhysGameTime, getPhysicsWorld } from '../PhysicsAPI';
import {
  QueryFilterFlags,
  RigidBodyTypeAPI,
  type ColliderAPI,
  type ColliderParams,
  type PhysVector,
  type RigidBodyAPI,
  type RigidBodyParams,
} from '../Physics/PhysicsAPITypes';
import type { RayDebugOpts } from '../RayDebugTypes';
import { LEVEL_GROUND_NORMAL } from '../../utils/constants';
import { existsOrThrow } from '../../utils/assert';

/**
 * A dynamic character's live data. Prop name prefixes: none = state (written by the controller),
 * one underscore (`_`) = configuration, two underscores (`__`) = internal memory (not configurable).
 * The nested objects are mutated in place every tick: re-read `data.velocity` etc., never keep a
 * reference to one across ticks expecting a snapshot. Times are physics game time in milliseconds.
 */
export type CharacterData = {
  /** What the body is doing (see {@link LocomotionState}), derived at the end of every tick. */
  locomotionState: LocomotionState;
  /** World position of the body's center. */
  position: { x: number; y: number; z: number };
  /** World linear velocity (m/s) and its length. */
  velocity: { x: number; y: number; z: number; length: number };
  /** Linear velocity relative to the moving platform under the character (= `velocity` elsewhere). */
  relVelocity: { x: number; y: number; z: number; length: number };
  /** Angular velocity (rad/s) and its length. */
  angularVelocity: { x: number; y: number; z: number; length: number };
  /** Facing yaw around the world up axis, in radians (0 faces +X, π/2 faces -Z). */
  charRotation: number;
  /** Whether the body moves or turns (derived from its velocities, not the physics sleep state). */
  isAwake: boolean;
  /** Whether the intent asked for a move this sub-step (moves that cancel out don't count). */
  hasMoveInput: boolean;
  /** Whether the floor sensor touches anything. */
  isGrounded: boolean;
  /** Whether the character has been off the ground for longer than `_isFallingThreshold`. */
  isFalling: boolean;
  /** Running (the intent's `run`): raises the max speed by `_runningMultiplier` while grounded
   * and standing. */
  isRunning: boolean;
  /** Crouching (the intent's `crouch`): the crouch capsule replaces the walk capsule. */
  isCrouching: boolean;
  /** Whether the wall sensor touches a non-dynamic body. */
  isNearWall: boolean;
  /** Whether the floor sensor touches a body whose user data has `isStairs`. */
  isOnStairs: boolean;
  /** Whether the floor sensor touches a body whose user data has `isMovingPlatform`. */
  isOnMovingPlatform: boolean;
  /** Grounded, off stairs and faster than `_minSlidingVelocity` without move input (or on
   * unwalkable ground). */
  isSliding: boolean;
  /** Knocked over: rotations are unlocked and the controls do nothing. */
  isTumbling: boolean;
  /** Turning upright again after tumbling (for `_gettingUpDuration`). */
  isGettingUp: boolean;
  /** Whether the ground under the character is no steeper than `_maxWalkableAngle`. */
  groundIsWalkable: boolean;
  /** Reserved, never set yet. */
  isMovingTowardsImpossibleSlope: boolean;
  /** Normal of the ground under the character, from the floor ray (resolves a sub-step or more
   * late). */
  groundNormal: { x: number; y: number; z: number };
  /** Standing height, from the capsule's bottom to its top (m). */
  _height: number;
  /** Capsule radius (m). */
  _radius: number;
  /** Crouching height, from the crouch capsule's bottom to its top (m). Its bottom stays where the
   * walk capsule's is. */
  _crouchHeight: number;
  /** How much wider than the capsule the wall sensor is, as a fraction of `_radius`. */
  _skinThickness: number;
  /** Height of the floor sensor's center above the capsule's bottom (m). */
  _groundDetectorOffset: number;
  /** Floor sensor radius, as a fraction of `_radius`. */
  _groundDetectorRadius: number;
  /** Relative speed (m/s) above which landing starts tumbling. */
  _tumblingGroundSpeedThreshold: number;
  /** Relative speed (m/s) above which touching a wall starts tumbling. */
  _tumblingWallSpeedThreshold: number;
  /** Minimum tumbling time (ms) before getting up. */
  _tumblingMinTime: number;
  /** Tumbling can end only below this relative speed (m/s). */
  _tumblingEndMinVelo: number;
  /** Tumbling can end only below this angular speed (rad/s). */
  _tumblingEndMinAngVelo: number;
  /** Max angular speed while tumbling (rad/s). */
  _tumblingMaxAngVelo: number;
  /** The body's angular damping while tumbling. */
  _tumblingAngularDamping: number;
  /** How long getting up takes (ms). */
  _gettingUpDuration: number;
  /** The body's angular damping while getting up. */
  _gettingUpAngularDamping: number;
  /** Max angular speed while getting up (rad/s). */
  _gettingUpMaxAngVelo: number;
  /** Strength of the uprighting torque impulse (per radian off upright), once fully eased in. */
  _gettingUpTorque: number;
  /** Turn speed (rad/s), for turn input and for turning toward a yaw or the move direction. */
  _rotateSpeed: number;
  /** Turn toward the move direction while moving (default: per input scheme, on for
   * `WORLD_FIXED` and `CAMERA_RELATIVE`). The intent's `turn` and `faceYaw` override it. */
  _turnToMoveDirection: boolean;
  /** Max walking speed (m/s). */
  _maxVelocity: number;
  /** Steepest walkable slope (radians). */
  _maxWalkableAngle: number;
  /** Speed (m/s) above which a grounded character without move input is sliding. */
  _minSlidingVelocity: number;
  /** Upward velocity (m/s) added to grounded moves (eg. 0.15 climbs steeper slopes). */
  _moveYOffset: number;
  /** Upward jump impulse. */
  _jumpAmount: number;
  /** Minimum time between jumps (ms). */
  _jumpCooldown: number;
  /** Acceleration multiplier while in the air. */
  _inTheAirDiminisher: number;
  /** Acceleration toward the max speed (m/s²). */
  _accumulateVeloPerInterval: number;
  /** How long (ms) the character can be off the ground before it is falling (`isFalling`). */
  _isFallingThreshold: number;
  /** Max speed multiplier while running. */
  _runningMultiplier: number;
  /** Max speed multiplier while crouching (the acceleration gets 1 + this). */
  _crouchingMultiplier: number;
  /** Landing with move input and a vertical speed above this (m/s) zeroes the vertical speed. */
  _keepMovingAfterJumpThreshold: number;
  /** Speed (m/s) away from a wall added while sliding along it: it breaks the contact whose
   * friction would otherwise hold the character up. */
  _wallMicroPush: number;
  /** Wall cast hits with a normal steeper than this (|y|) are floors or ceilings, not walls. */
  _wallNormalMaxY: number;
  /** How far ahead (m) the wall cast looks. */
  _wallCastDistance: number;
  /** Downhill acceleration (m/s²) on unwalkable slopes, up to `_maxVelocity` (gravity can slide
   * the character faster). */
  _slopeSlideSpeed: number;
  /** How long (ms) the character must be off the ground, without a jump, before its locomotion
   * state is `FALL` (shorter gaps, like a stair step, keep the grounded state). */
  _fallStateDelay: number;
  /** When `locomotionState` last changed. */
  __locomotionStateStartTime: number;
  /** In a jump (locomotionState `JUMP`): from the jump until the character stops rising in the
   * air or lands. */
  __isJumping: boolean;
  /** Whether the current jump has left the ground yet. */
  __jumpLeftGround: boolean;
  /** When the character left the ground (0 while grounded). */
  __isFallingStartTime: number;
  /** When tumbling started (0 while not tumbling). */
  __isTumblingStartTime: number;
  /** When the last jump was applied. */
  __jumpTime: number;
  /** `isGrounded` as of the floor sensor's last collision event (the landing logic reads it). */
  __lastIsGroundedState: boolean;
  /** cos(`_maxWalkableAngle`), computed at creation. */
  __maxWalkableAngleCos: number;
  /** Ids of the non-dynamic colliders the wall sensor touches. */
  __touchingWallColliders: number[];
  /** Ids of the colliders the floor sensor touches. */
  __touchingGroundColliders: number[];
  /** The angular damping restored when tumbling ends (the body's default, 0). */
  __charAngDamping: number;
  /** When getting up started (0 while not getting up). */
  __isGettingUpStartTime: number;
  /** The moving platform's velocity the tick added to the body on the last sub-step. */
  __lastAppliedPlatformVelocity: { x: number; y: number; z: number };
  /** The velocity of the moving platform's floor under the character this sub-step. */
  __currentPlatformVelocity: { x: number; y: number; z: number };
};

/** {@link createDynamicCharacter}'s options. */
export type DynamicCharacterOpts = {
  /** The character's id (namespaces its binding ids). An existing character with it is replaced. */
  id: string;
  /** A display name (the debug tools show it). */
  name?: string;
  /** The visual root the body moves (eg. a mesh or a group), with an entity (made with
   * createMeshEntity or createGroupEntity): that entity becomes the character. The controller
   * never reads it, so any Object3D works (a capsule, a skinned mesh, a group). */
  visual: THREE.Object3D;
  /** The body's shape and kind (default {@link HUMANOID_CAPSULE}). */
  body?: CharacterBodyPlan;
  /** Overrides of the default {@link CharacterData} (usually `_` configuration keys). */
  charData?: Partial<CharacterData>;
  /** Keyboard input: a scheme and its key mappings. Without it the character is driven by code,
   * through its intent. */
  input?: CharacterInputOpts;
  /** Called on every locomotion state change (the same as registering it with
   * `onLocomotionStateChange` right after creation). */
  onLocomotionStateChange?: LocomotionStateListener;
};

/** What {@link createDynamicCharacter} returns. */
export type DynamicCharacter = {
  /** The registry entry (the entity's `CHARACTER` component). */
  character: CharacterObject;
  /** The live data (the same object as `character.data`). */
  data: CharacterData;
  /** The character's intent (the same object as `character.intent`). */
  intent: CharacterIntent;
  /** Shorthands that write the intent (nothing else: the tick is what moves the body). Call the
   * per-sub-step ones (rotate, move) once per sub-step, eg. from an APP_PHYSICS_STEP system. */
  controlFns: {
    /** Turns this sub-step (the intent's `turn`). */
    rotate: (direction: 'LEFT' | 'RIGHT') => void;
    /** Moves along the facing this sub-step (the intent's `moveForward`): FORWARD + BACKWARD
     * cancel out. */
    move: (direction: 'FORWARD' | 'BACKWARD') => void;
    /** Jumps on the next tick, if grounded, standing and off the jump cooldown. */
    jump: () => void;
    /** Toggles running. */
    run: () => void;
    /** Toggles crouching. */
    crouch: () => void;
  };
};

const DEFAULT_CHARACTER_DATA: CharacterData = {
  locomotionState: 'IDLE',
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0, length: 0 },
  relVelocity: { x: 0, y: 0, z: 0, length: 0 },
  angularVelocity: { x: 0, y: 0, z: 0, length: 0 },
  charRotation: 0,
  isAwake: false,
  hasMoveInput: false,
  isGrounded: false,
  isFalling: false,
  isRunning: false,
  isCrouching: false,
  isNearWall: false,
  isOnStairs: false,
  isOnMovingPlatform: false,
  isSliding: false,
  isTumbling: false,
  isGettingUp: false,
  groundIsWalkable: true,
  isMovingTowardsImpossibleSlope: false,
  groundNormal: { x: 0, y: 1, z: 0 },
  _height: 1.6,
  _radius: 0.5,
  _crouchHeight: 1.32,
  _skinThickness: 0.05,
  _groundDetectorOffset: 0.3,
  _groundDetectorRadius: 0.8,
  _tumblingGroundSpeedThreshold: 9,
  _tumblingWallSpeedThreshold: 6,
  _tumblingMinTime: 2200,
  _tumblingEndMinVelo: 1.4,
  _tumblingEndMinAngVelo: 0.5,
  _tumblingMaxAngVelo: 4.6,
  _tumblingAngularDamping: 2.5,
  _gettingUpDuration: 1000,
  _gettingUpAngularDamping: 25,
  _gettingUpMaxAngVelo: 2,
  _gettingUpTorque: 0.2,
  _rotateSpeed: 5,
  _turnToMoveDirection: false,
  _maxVelocity: 3.7,
  _maxWalkableAngle: Math.PI / 4, // 45 degrees (radians)
  _minSlidingVelocity: 2,
  _moveYOffset: 0,
  _jumpAmount: 5,
  _jumpCooldown: 100,
  _inTheAirDiminisher: 0.6,
  _accumulateVeloPerInterval: 30,
  _isFallingThreshold: 1200,
  _runningMultiplier: 1.5,
  _crouchingMultiplier: 0.9,
  _keepMovingAfterJumpThreshold: -10,
  _wallMicroPush: 0.05,
  _wallNormalMaxY: 0.7,
  _wallCastDistance: 0.2,
  _slopeSlideSpeed: 15,
  _fallStateDelay: 100,
  __locomotionStateStartTime: 0,
  __isJumping: false,
  __jumpLeftGround: false,
  __isFallingStartTime: 0,
  __isTumblingStartTime: 0,
  __jumpTime: 0,
  __lastIsGroundedState: false,
  __maxWalkableAngleCos: 0,
  __touchingWallColliders: [],
  __touchingGroundColliders: [],
  __charAngDamping: 0,
  __isGettingUpStartTime: 0,
  __lastAppliedPlatformVelocity: { x: 0, y: 0, z: 0 },
  __currentPlatformVelocity: { x: 0, y: 0, z: 0 },
};
const getDefaultCharacterData = (): CharacterData => {
  // We need to copy all object and arrays
  const d = DEFAULT_CHARACTER_DATA;
  return {
    ...d,
    position: { ...d.position },
    velocity: { ...d.velocity },
    relVelocity: { ...d.relVelocity },
    angularVelocity: { ...d.angularVelocity },
    groundNormal: { ...d.groundNormal },
    __touchingWallColliders: [...d.__touchingWallColliders],
    __touchingGroundColliders: [...d.__touchingGroundColliders],
    __lastAppliedPlatformVelocity: { ...d.__lastAppliedPlatformVelocity },
    __currentPlatformVelocity: { ...d.__currentPlatformVelocity },
  };
};

/** Below this (rad/s), a platform's spin doesn't turn the character. */
const PLATFORM_ROTATION_EPSILON = 0.001;
/** Below this (m/s or rad/s), the character counts as resting (isAwake = false). */
const AWAKE_EPSILON = 0.001;
/** Below this squared length (of the intent's summed move), there is no move input. */
const MOVE_EPSILON_SQ = 1e-6;
/** Closer than this (rad) to a target yaw, the character doesn't turn. */
const YAW_EPSILON = 1e-4;
/** A jump that hasn't left the ground after this long (ms, eg. under a low ceiling) is over. */
const JUMP_LIFT_OFF_GRACE = 250;
/** How much faster (m/s) than its own top speed a sliding character must go to be in `SLIDE`. */
const SLIDE_STATE_SPEED_MARGIN = 0.1;

/** The locomotion state from the controller's data (see {@link LocomotionState}). */
const deriveLocomotionState = (
  d: CharacterData,
  now: number,
  isControlled: boolean
): LocomotionState => {
  // Physics alone moves the body (eg. a ragdoll): it's tumbling as far as animation goes
  if (!isControlled) return 'TUMBLE';
  if (d.isGettingUp) return 'GET_UP';
  if (d.isTumbling) return 'TUMBLE';
  if (d.__isJumping) return 'JUMP';
  // A short time off the ground (a stair step, a bump) keeps the grounded state
  if (!d.isGrounded && now - d.__isFallingStartTime >= d._fallStateDelay) return 'FALL';
  // Only a slide the character can't make by itself: on too steep ground, or faster than it moves
  // (isSliding alone is also true while it slows down after a move)
  if (
    d.isSliding &&
    (!d.groundIsWalkable ||
      Math.hypot(d.relVelocity.x, d.relVelocity.z) >
        d._maxVelocity * Math.max(1, d._runningMultiplier) + SLIDE_STATE_SPEED_MARGIN)
  ) {
    return 'SLIDE';
  }
  if (d.isCrouching) return d.hasMoveInput ? 'CROUCH_WALK' : 'CROUCH';
  if (d.hasMoveInput) return d.isRunning ? 'RUN' : 'WALK';
  return 'IDLE';
};

const eulerForCharRotation = new THREE.Euler();
const vectors = {
  r: new THREE.Vector3(),
  omega: new THREE.Vector3(),
  vTan: new THREE.Vector3(),
  currentRelVelo: new THREE.Vector3(),
  groundDot: new THREE.Vector3(),
};

// Per-tick scratch, shared by every character (ticks never interleave). Passing these to the
// physics calls is safe in both worker targets: MAIN_THREAD copies them into Rapier, and
// WORKER_THREAD clones them when the command is captured or posted (the ray helpers copy too).
/** [posX, posY, posZ, rotX, rotY, rotZ, rotW] of the ticking character's body. */
const _pose = new Float64Array(7);
/** [linvelX, linvelY, linvelZ, angvelX, angvelY, angvelZ] of the ticking character's body. */
const _vels = new Float64Array(6);
const _platformPose = new Float64Array(7);
const _vec = { x: 0, y: 0, z: 0 };
const _rot = { x: 0, y: 0, z: 0, w: 1 };
const _moveDir = new THREE.Vector3();
const _castPos = { x: 0, y: 0, z: 0 };
const _castDir = { x: 0, y: 0, z: 0 };
const _castRot = { w: 1, x: 0, y: 0, z: 0 }; // Identity quaternion
const _rayDown = { x: 0, y: -1, z: 0 };
const _floorRay = { origin: _castPos, dir: _rayDown };

const setVec = (x: number, y: number, z: number) => {
  _vec.x = x;
  _vec.y = y;
  _vec.z = z;
  return _vec;
};

const copyVec = (to: PhysVector, from: PhysVector) => {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
};

const createCastRecord = (): CharacterCastRecord => ({
  resolvedAt: 0,
  isCrouching: false,
  origin: { x: 0, y: 0, z: 0 },
  dir: { x: 0, y: 0, z: 0 },
  maxDistance: 0,
  isHit: false,
  distance: 0,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
});

/** Keeps a cast as it fires, in `shot`: the cast scratch is reused before the result arrives. */
const recordCastShot = (
  shot: CharacterCastRecord,
  origin: PhysVector,
  dir: PhysVector,
  maxDistance: number,
  isCrouching: boolean
) => {
  copyVec(shot.origin, origin);
  copyVec(shot.dir, dir);
  shot.maxDistance = maxDistance;
  shot.isCrouching = isCrouching;
};

/** Publishes a cast's result into its record, with the cast it belongs to (`shot`). A hit's
 * point and normal are the caller's to write, right after (`distance` < 0 = a miss). */
const resolveCastRecord = (
  record: CharacterCastRecord,
  shot: CharacterCastRecord,
  distance: number
) => {
  record.resolvedAt = getPhysGameTime();
  copyVec(record.origin, shot.origin);
  copyVec(record.dir, shot.dir);
  record.maxDistance = shot.maxDistance;
  record.isCrouching = shot.isCrouching;
  record.isHit = distance >= 0;
  record.distance = Math.max(0, distance);
};

/** The collider roles the controller needs from a body plan. */
const REQUIRED_COLLIDER_ROLES: CharacterColliderRole[] = [
  'MAIN',
  'CROUCH',
  'WALL_SENSOR',
  'FLOOR_SENSOR',
];

/**
 * Creates a dynamic character: a dynamic, rotation-locked rigid body moved by setting its
 * velocities, with gravity and contacts left to the physics engine. It walks, runs, crouches,
 * jumps, slides down too steep slopes, rides moving platforms, and tumbles and gets up again.
 *
 * The body's shape comes from the body plan (`body`, default {@link HUMANOID_CAPSULE}), its
 * tuning from `charData` (see {@link CharacterData}). It moves only by its intent, which the
 * `input` scheme's key bindings, `controlFns` or game code (eg. an AI in an APP_PHYSICS_STEP
 * system) write; the controller's tick reads it once per physics sub-step. Deleting the
 * character's entity any way deletes the character.
 * @returns the character, its live data, its intent and the `controlFns` shorthands
 */
export const createDynamicCharacter = async (
  opts: DynamicCharacterOpts
): Promise<DynamicCharacter> => {
  const {
    id,
    name,
    visual,
    body = HUMANOID_CAPSULE,
    charData,
    input: inputOpts,
    onLocomotionStateChange: locomotionStateListener,
  } = opts;

  // Combine character data
  const characterData: CharacterData = { ...getDefaultCharacterData(), ...charData };
  if (charData?._turnToMoveDirection === undefined && inputOpts) {
    characterData._turnToMoveDirection = SCHEME_TURNS_TO_MOVE_DIRECTION[inputOpts.scheme];
  }
  const dims = body.getDimensions(characterData);

  // Set __maxWalkableAngleCos
  characterData.__maxWalkableAngleCos = Math.cos(characterData._maxWalkableAngle);

  const moveVector3 = new THREE.Vector3();
  const flatNormalVector3 = new THREE.Vector3();
  const jumpAmountVector3 = new THREE.Vector3();
  const justLandedVector3 = new THREE.Vector3();

  // Forward-declared: closures below (controlFns, collider collisionEventFn) close over
  // these and are only ever invoked after createCharacter() resolves and assigns them once.
  // eslint-disable-next-line prefer-const
  let characterBody: RigidBodyAPI;
  let characterBodyId = -1;
  // The standing (MAIN, enabled at creation) and crouching (CROUCH) colliders
  // eslint-disable-next-line prefer-const
  let mainCollider: ColliderAPI, crouchCollider: ColliderAPI;
  /** The control mode the tick last applied (the character's `controlMode` takes effect on the
   * next tick). */
  let appliedControlMode: CharacterControlMode = 'CONTROLLED';

  // Written by the input scheme's bindings, controlFns and game code; read only by the tick
  const intent = createIntent();
  const input = inputOpts ? createCharacterInput(id, intent, inputOpts) : undefined;

  // WorldAPI.castShapeSync()/castRayAndGetNormalSync() throw in WORKER_THREAD mode (spatial
  // queries need the live physics world, which lives off-thread there — unlike pos/rot/lvel/
  // avel there's no hot-path buffer that could make this synchronous). The tick needs a same-
  // sub-step value for wall-slide/slope math, so each async cast is fired again once the previous
  // one resolved, and the latest resolved result is used meanwhile — a frame of latency at most,
  // imperceptible for both effects. At most one wall cast and one floor ray are in flight.
  const wallHit = { isValid: false, normal: new THREE.Vector3(), distance: 0 };
  let wallHitCastInFlight = false;
  let floorRayCastInFlight = false;
  // The casts' last results for diagnostics (CharacterController.probes), and the cast in flight
  const wallCastRecord = createCastRecord();
  const floorRayRecord = createCastRecord();
  const wallCastShot = createCastRecord();
  const floorRayShot = createCastRecord();
  // The casts' physics ray helper ids (drawn only while the physics helpers are on), set once
  // the character entity exists
  const wallCastDebug: RayDebugOpts = { id: '' };
  const floorRayDebug: RayDebugOpts = { id: '' };

  /** Fires an async wall shape-cast (fire-and-forget) along the horizontal velocity if one isn't
   * already in flight, updating wallHit once it resolves. Reads the tick's pose and velocity
   * scratch. */
  const refreshWallHit = () => {
    if (wallHitCastInFlight) return;
    _moveDir.set(_vels[0], 0, _vels[2]);
    // Optimization: If standing still, wall sliding is irrelevant.
    if (_moveDir.lengthSq() < 0.001) {
      wallHit.isValid = false;
      return;
    }
    _moveDir.normalize();
    _castDir.x = _moveDir.x;
    _castDir.y = 0; // Force horizontal
    _castDir.z = _moveDir.z;

    // The body plan's creation-time sizes (geometry can't be queried off the active collider
    // synchronously in WORKER_THREAD mode)
    const probes = characterData.isCrouching ? dims.crouching : dims.standing;

    _castPos.x = _pose[0];
    _castPos.y = _pose[1] + probes.wallCastOffsetY;
    _castPos.z = _pose[2];

    recordCastShot(
      wallCastShot,
      _castPos,
      _castDir,
      characterData._wallCastDistance,
      characterData.isCrouching
    );
    wallHitCastInFlight = true;
    getPhysicsWorld()
      .castShape(
        _castPos,
        _castRot,
        _castDir,
        {
          type: 'CYLINDER',
          halfHeight: probes.wallCastHalfHeight,
          radius: probes.wallCastRadius,
        },
        0.0,
        characterData._wallCastDistance,
        true, // Stop at Penetration
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        characterBody, // Exclude Self
        undefined,
        wallCastDebug
      )
      .then((hit) => {
        wallHitCastInFlight = false;
        resolveCastRecord(wallCastRecord, wallCastShot, hit ? hit.timeOfImpact : -1);
        if (hit) {
          // Both on the hit collider, in world space
          copyVec(wallCastRecord.point, hit.witness1);
          copyVec(wallCastRecord.normal, hit.normal1);
        }
        if (!hit || Math.abs(hit.normal1.y) > characterData._wallNormalMaxY) {
          wallHit.isValid = false;
          return;
        }
        wallHit.isValid = true;
        wallHit.normal.set(hit.normal1.x, hit.normal1.y, hit.normal1.z);
        wallHit.distance = hit.timeOfImpact;
      })
      .catch(() => {
        wallHitCastInFlight = false;
      });
  };

  /** Fires an async floor ray-cast (fire-and-forget) if one isn't already in flight, updating
   * characterData.groundNormal/groundIsWalkable once it resolves. Reads the tick's pose scratch. */
  const refreshFloorNormal = () => {
    if (floorRayCastInFlight) return;
    _castPos.x = _pose[0];
    _castPos.y = _pose[1];
    _castPos.z = _pose[2];
    const probes = characterData.isCrouching ? dims.crouching : dims.standing;
    recordCastShot(
      floorRayShot,
      _castPos,
      _rayDown,
      probes.floorRayLength,
      characterData.isCrouching
    );
    floorRayCastInFlight = true;
    getPhysicsWorld()
      .castRayAndGetNormal(
        _floorRay,
        probes.floorRayLength,
        false,
        QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        characterBody,
        undefined,
        floorRayDebug
      )
      .then((hit) => {
        floorRayCastInFlight = false;
        resolveCastRecord(floorRayRecord, floorRayShot, hit ? hit.timeOfImpact : -1);
        if (hit) {
          const { origin, dir, point } = floorRayRecord;
          point.x = origin.x + dir.x * hit.timeOfImpact;
          point.y = origin.y + dir.y * hit.timeOfImpact;
          point.z = origin.z + dir.z * hit.timeOfImpact;
          copyVec(floorRayRecord.normal, hit.normal);
        }
        const groundNormal = characterData.groundNormal;
        if (hit) {
          groundNormal.x = hit.normal.x;
          groundNormal.y = hit.normal.y;
          groundNormal.z = hit.normal.z;
        } else {
          groundNormal.x = 0;
          groundNormal.y = 1;
          groundNormal.z = 0;
        }
        const groundDot = vectors.groundDot
          .set(groundNormal.x, groundNormal.y, groundNormal.z)
          .dot(LEVEL_GROUND_NORMAL);
        characterData.groundIsWalkable = !hit || groundDot > characterData.__maxWalkableAngleCos;
      })
      .catch(() => {
        floorRayCastInFlight = false;
      });
  };

  const yawQuat = new THREE.Quaternion();
  /** Turns the character by `amount` radians around the world up axis. The yaw accumulates in
   * characterData.charRotation and goes only into the body: the body is the single source of
   * truth and the mesh follows it like any other physics-driven Object3D. Never write
   * the visual's quaternion here: it is rewritten from the physics pose (interpolated, and one step
   * late in WORKER_THREAD mode), and since this only runs on frames with a physics sub-step, a
   * direct write makes the rendered yaw alternate between the live and the physics yaw whenever
   * the render rate exceeds the physics rate. */
  const turnCharacter = (amount: number) => {
    characterData.charRotation += amount;
    yawQuat.setFromAxisAngle(LEVEL_GROUND_NORMAL, characterData.charRotation);
    // Plain object, not the THREE.Quaternion: its values live in private fields that don't
    // survive the WORKER_THREAD postMessage structured clone.
    _rot.x = yawQuat.x;
    _rot.y = yawQuat.y;
    _rot.z = yawQuat.z;
    _rot.w = yawQuat.w;
    characterBody?.setRotation(_rot, true);
  };

  /** Ground steeper than `_maxWalkableAngle` (groundIsWalkable false) can't be climbed: the uphill
   * part of `vel`'s horizontal velocity is dropped, and the rest kept, so the character can still
   * cross the slope. While grounded on it, the character also slides down: the downhill speed is
   * at least the body's current one (`bodyVelX`/`bodyVelZ`, so a move never cancels the slide)
   * plus `_slopeSlideSpeed` × `delta`. */
  const applySteepSlope = (
    vel: THREE.Vector3,
    bodyVelX: number,
    bodyVelZ: number,
    delta: number
  ) => {
    // The ground normal leans downhill: its horizontal part is the downhill direction
    const n = characterData.groundNormal;
    const horizontalLength = Math.hypot(n.x, n.z);
    if (horizontalLength < 1e-4) return;
    const downhillX = n.x / horizontalLength;
    const downhillZ = n.z / horizontalLength;
    const velDownhill = vel.x * downhillX + vel.z * downhillZ;
    let targetDownhill = Math.max(0, velDownhill);
    if (characterData.isGrounded && !characterData.isOnStairs) {
      // The slide push stops at the walking speed; gravity alone takes it any faster
      const bodyDownhill = Math.max(0, bodyVelX * downhillX + bodyVelZ * downhillZ);
      const pushed = Math.min(
        bodyDownhill + characterData._slopeSlideSpeed * delta,
        characterData._maxVelocity
      );
      targetDownhill = Math.max(targetDownhill, bodyDownhill, pushed);
    }
    vel.x += (targetDownhill - velDownhill) * downhillX;
    vel.z += (targetDownhill - velDownhill) * downhillZ;
  };

  /** Applies one sub-step's move to the body's velocity: along the unit horizontal direction
   * (`dirX`, `dirZ`), at `magnitude` (0..1) of the max speed. Called by the tick, with the pose
   * and velocity scratch already read. */
  const applyMove = (dirX: number, dirZ: number, magnitude: number, delta: number) => {
    const rigidBody = characterBody;
    const bodyVelX = _vels[0];
    const bodyVelZ = _vels[2];
    const vel = moveVector3.set(_vels[0], _vels[1], _vels[2]);
    const maxVeloMultiplier =
      // isRunning
      characterData.isRunning && characterData.isGrounded && !characterData.isCrouching
        ? characterData._runningMultiplier
        : // isCrouching
          characterData.isGrounded && characterData.isCrouching
          ? characterData._crouchingMultiplier
          : 1;
    const maxVelo = characterData._maxVelocity * maxVeloMultiplier * magnitude;
    const inTheAirDiminisher =
      characterData.isGrounded && !characterData.isFalling ? 1 : characterData._inTheAirDiminisher;
    const crouchVeloAccuMultiplier = characterData.isCrouching
      ? characterData._crouchingMultiplier + 1
      : 1;
    const veloAccu =
      characterData._accumulateVeloPerInterval *
      inTheAirDiminisher *
      crouchVeloAccuMultiplier *
      delta;

    // The velocity the move builds on: on a moving platform it's relative to the platform. This
    // sub-step's collision events ran before the tick, so when one of them just took the character
    // off a platform, relVelocity is still relative to it: the platform velocity last applied
    // (only non-zero until this tick resets it) is added back, keeping the momentum it gave.
    const lastPlatformVelo = characterData.__lastAppliedPlatformVelocity;
    const leftPlatformVeloX = characterData.isOnMovingPlatform ? 0 : lastPlatformVelo.x;
    const leftPlatformVeloZ = characterData.isOnMovingPlatform ? 0 : lastPlatformVelo.z;
    const curLinvelX = (characterData.relVelocity.x || 0) + leftPlatformVeloX;
    const curLinvelZ = (characterData.relVelocity.z || 0) + leftPlatformVeloZ;

    // The horizontal velocity moves toward dir × maxVelo by at most veloAccu. Along the
    // direction, grounded speed over the max is cut to it at once, while in the air it's kept
    // (the target is then the current speed).
    const along = curLinvelX * dirX + curLinvelZ * dirZ;
    const overMax = characterData.isGrounded ? Math.max(0, along - maxVelo) : 0;
    const startX = curLinvelX - overMax * dirX;
    const startZ = curLinvelZ - overMax * dirZ;
    const targetAlong = characterData.isGrounded ? maxVelo : Math.max(maxVelo, along);
    let stepX = dirX * targetAlong - startX;
    let stepZ = dirZ * targetAlong - startZ;
    const stepLength = Math.hypot(stepX, stepZ);
    if (stepLength > veloAccu) {
      stepX *= veloAccu / stepLength;
      stepZ *= veloAccu / stepLength;
    }
    const xAddition = startX + stepX;
    const zAddition = startZ + stepZ;

    let charLinvelY = _vels[1];
    if (characterData.isGrounded) {
      charLinvelY += characterData._moveYOffset;
    }

    vel.set(xAddition, charLinvelY, zAddition);

    // Is on moving platform compensation
    if (characterData.isOnMovingPlatform) {
      vel.set(
        xAddition + characterData.velocity.x - curLinvelX,
        charLinvelY,
        zAddition + characterData.velocity.z - curLinvelZ
      );
    }

    // Near wall check (and possible cancelation)
    if (characterData.isNearWall) {
      refreshWallHit();

      if (wallHit.isValid) {
        // 1. Flatten the Normal (Critical for Vertical Stability)
        // We strictly ignore the Y component of the wall.
        // This prevents the wall from pushing us UP or holding us in the air.
        const rawNormal = wallHit.normal;
        const flatNormal = flatNormalVector3.set(rawNormal.x, 0, rawNormal.z).normalize();

        // 2. Use the INTENDED velocity 'vel', not the old body velocity
        // 'vel' is the vector you calculated from inputs (xAddition, zAddition)
        const currentX = vel.x;
        const currentZ = vel.z;

        // 3. Calculate Dot Product (Horizontal Only)
        const dot = currentX * flatNormal.x + currentZ * flatNormal.z;

        // 4. Only slide if we are pushing INTO the wall
        if (dot < 0) {
          // Slide Math: Remove the velocity component that points into the wall
          let slideX = currentX - dot * flatNormal.x;
          let slideZ = currentZ - dot * flatNormal.z;

          // 5. THE MICRO-PUSH (Fixes "Sticky/Floating" walls)
          // We add a tiny velocity AWAY from the wall.
          // This breaks physical contact for the next frame, ensuring Rapier
          // doesn't apply vertical friction that fights gravity.
          slideX += flatNormal.x * characterData._wallMicroPush;
          slideZ += flatNormal.z * characterData._wallMicroPush;

          // 6. Apply back to the output vector
          vel.x = slideX;
          vel.z = slideZ;
          // We explicitly leave vel.y alone so gravity/jumping works perfectly
        }
      }
    }

    // Unwalkable slope check (uses the latest resolved ground normal)
    if (!characterData.groundIsWalkable) applySteepSlope(vel, bodyVelX, bodyVelZ, delta);

    rigidBody.setLinvel(setVec(vel.x, vel.y, vel.z), true);
    _vels[0] = vel.x;
    _vels[1] = vel.y;
    _vels[2] = vel.z;
  };

  const controlFns: DynamicCharacter['controlFns'] = {
    rotate: (direction) => (intent.turn += direction === 'LEFT' ? 1 : -1),
    move: (direction) => (intent.moveForward += direction === 'FORWARD' ? 1 : -1),
    jump: () => (intent.jump = true),
    run: () => (intent.run = !intent.run),
    crouch: () => (intent.crouch = !intent.crouch),
  };

  /** Swaps the standing (MAIN) and crouching (CROUCH) colliders. */
  const setCrouching = (isCrouching: boolean) => {
    characterData.isCrouching = isCrouching;
    (isCrouching ? mainCollider : crouchCollider).setEnabled(false);
    (isCrouching ? crouchCollider : mainCollider).setEnabled(true);
  };

  /** The wall sensor's collisions: counts the touching non-dynamic bodies (isNearWall), and a
   * fast enough hit starts tumbling. */
  const onWallSensorCollision = (
    collider1: ColliderAPI,
    collider2: ColliderAPI,
    started: boolean
  ) => {
    // Whichever of the pair belongs to the character's own rigid body is "me" — the
    // wall sensor's own collisionEventFn only ever fires for events that include it.
    const isColl1Mine = collider1.parentId === characterBodyId;
    const otherCollider = isColl1Mine ? collider2 : collider1;

    if (started) {
      void getPhysicsWorld()
        .getRigidBodySync(otherCollider.parentId ?? -1)
        ?.bodyType()
        .then((bodyType) => {
          if (bodyType !== RigidBodyTypeAPI.Dynamic) {
            characterData.__touchingWallColliders.push(otherCollider.id);
            characterData.isNearWall = true;
          }
          if (
            appliedControlMode === 'CONTROLLED' &&
            characterData.relVelocity.length > characterData._tumblingWallSpeedThreshold
          ) {
            startCharacterTumbling(characterData, characterBody);
          }
        });
      return;
    }
    const indexToRemove = characterData.__touchingWallColliders.indexOf(otherCollider.id);
    if (indexToRemove !== -1) {
      characterData.__touchingWallColliders.splice(indexToRemove, 1);
    }
    if (!characterData.__touchingWallColliders.length) characterData.isNearWall = false;
  };

  /** The floor sensor's collisions: grounded, stairs and moving platform state, landing, and
   * tumbling on a hard landing. */
  const onFloorSensorCollision = (
    collider1: ColliderAPI,
    collider2: ColliderAPI,
    started: boolean
  ) => {
    // 1. Identify "The Other Collider" immediately
    const isColl1Mine = collider1.parentId === characterBodyId;
    const otherCollider = isColl1Mine ? collider2 : collider1;

    // 2. Get the other body's userData ONCE
    const otherBody = getPhysicsWorld().getRigidBodySync(otherCollider.parentId ?? -1);
    const userData = otherBody?.getUserDataSync() as
      | {
          isStairs?: boolean;
          stairsColliderIndex?: number | number[]; // Support array or number
          isMovingPlatform?: boolean;
        }
      | undefined;

    if (started) {
      // --- STARTED TOUCHING ---
      characterData.__touchingGroundColliders.push(otherCollider.id);
      characterData.isGrounded = true;

      // Tumble Check (in PHYSICS_ONLY mode, physics alone moves the body)
      const isControlled = appliedControlMode === 'CONTROLLED';
      if (
        isControlled &&
        characterData.relVelocity.length > characterData._tumblingGroundSpeedThreshold &&
        !characterData.__lastIsGroundedState
      ) {
        startCharacterTumbling(characterData, characterBody);
        return;
      }

      // Keep Moving / Landing Logic. Collision events run before the tick, so this sub-step's
      // move input is still only in the intent.
      if (
        isControlled &&
        !characterData.isFalling &&
        !characterData.__lastIsGroundedState &&
        (characterData.hasMoveInput || hasMoveIntent(intent)) &&
        characterBody
      ) {
        const linvel = characterBody.lvel;
        if (characterData._keepMovingAfterJumpThreshold < linvel.y) {
          characterBody.setLinvel(justLandedVector3.set(linvel.x, 0, linvel.z), true);
        }
      }
      characterData.__lastIsGroundedState = characterData.isGrounded;

      // --- STAIRS CHECK ---
      if (userData?.isStairs) {
        characterData.isOnStairs = true;
      }

      // --- MOVING PLATFORM CHECK ---
      if (userData?.isMovingPlatform) {
        characterData.isOnMovingPlatform = true;
      }
    } else {
      // --- STOPPED TOUCHING ---
      const index = characterData.__touchingGroundColliders.indexOf(otherCollider.id);
      if (index !== -1) {
        characterData.__touchingGroundColliders.splice(index, 1);
      }

      if (characterData.__touchingGroundColliders.length === 0) {
        characterData.isGrounded = false;
      }

      characterData.__lastIsGroundedState = characterData.isGrounded;

      if (userData?.isStairs) {
        characterData.isOnStairs = false;
      }

      if (userData?.isMovingPlatform) {
        characterData.isOnMovingPlatform = false;
      }
    }
  };

  // The body plan's colliders (all sharing one rigid body), with the controller's parts added by
  // role: the crouch collider starts disabled, and the sensors get their collision handlers.
  // Capsule radii must be explicit: the Physics API doesn't derive them from the mesh.
  const bodyColliders = body.getColliders(dims, characterData);
  const colliderIndexes = {} as Record<CharacterColliderRole, number>;
  for (let i = 0; i < REQUIRED_COLLIDER_ROLES.length; i++) {
    const role = REQUIRED_COLLIDER_ROLES[i];
    const index = bodyColliders.findIndex((collider) => collider.role === role);
    if (index === -1) {
      throw new Error(
        `createDynamicCharacter: body plan '${body.kind}' has no '${role}' collider (character '${id}').`
      );
    }
    colliderIndexes[role] = index;
  }
  const colliders: ColliderParams[] = bodyColliders.map(({ role, params }) => {
    switch (role) {
      case 'MAIN':
        return { ...params, enabled: true };
      case 'CROUCH':
        return { ...params, enabled: false };
      case 'WALL_SENSOR':
        return { ...params, collisionEventFn: onWallSensorCollision };
      case 'FLOOR_SENSOR':
        return { ...params, collisionEventFn: onFloorSensorCollision };
      default:
        return params;
    }
  });

  const rigidBodyParams: RigidBodyParams = {
    rigidType: 'DYNAMIC',
    lockRotations: { x: true, y: true, z: true },
    linearDamping: 0,
  };

  const ecsWorld = getECSWorld();

  const character = await createCharacter({
    id,
    name,
    kind: body.kind,
    physicsParams: { colliders, rigidBody: rigidBodyParams },
    visual,
    data: characterData,
    intent,
    controls: input?.bindings,
  });
  const entityId = character.entityId;

  characterBody = existsOrThrow(
    ecsWorld.getRigidBody(entityId),
    `Could not find character physics object rigid body with id: '${entityId}'.`
  );
  characterBodyId = characterBody.id;
  wallCastDebug.id = `char_wall_${entityId}`;
  floorRayDebug.id = `char_floor_${entityId}`;
  // The entity's colliders are in the order of their params
  const liveColliders = existsOrThrow(
    ecsWorld.getComponent(entityId, ComponentType.COLLIDER),
    `Could not find character colliders for entity id: '${entityId}'.`
  );
  mainCollider = liveColliders[colliderIndexes.MAIN];
  crouchCollider = liveColliders[colliderIndexes.CROUCH];
  if (locomotionStateListener) onLocomotionStateChange(id, locomotionStateListener);

  const getUpQuat = new THREE.Quaternion();
  const getUpVector3 = new THREE.Vector3();
  const getUpBodyUpVector3 = new THREE.Vector3();
  const getUpYawEuler = new THREE.Euler();
  const getUpUprightQuat = new THREE.Quaternion();
  const getUpUprightEuler = new THREE.Euler();

  const probes: CharacterProbes = {
    body,
    dims,
    colliderRoles: bodyColliders.map((collider) => collider.role),
    floorRay: floorRayRecord,
    wallCast: wallCastRecord,
  };

  // Run by Character.ts's character system once per fixed physics sub-step. The tick's per-step
  // amounts (eg. turning with a rotating platform by angVelo * timestep) are only right at that
  // cadence. It goes with the entity: no cleanup needed.
  character.controller = {
    probes,
    tick: (dt: number) => {
      const body = characterBody;
      if (!body) return;
      const now = getPhysGameTime();

      // The body's state, read once (no allocation); every velocity write below updates _vels too
      body.readPoseInto(_pose);
      body.readVelocitiesInto(_vels);

      // A control mode change (setControlMode) applies here, so only the tick touches the body
      if (character.controlMode !== appliedControlMode) {
        appliedControlMode = character.controlMode;
        if (appliedControlMode === 'PHYSICS_ONLY') {
          // Physics alone: free rotations and the body's own (default) angular damping
          characterData.isGettingUp = false;
          characterData.__isGettingUpStartTime = 0;
          body.setAngularDamping(0);
          body.lockRotations(false, true);
          body.setEnabledRotations(true, true, true, true);
        } else {
          // Back from physics: get up first (the getting-up path locks the rotations at its end)
          characterData.isTumbling = true;
          characterData.isGettingUp = true;
          characterData.__isGettingUpStartTime = now;
        }
      }
      const isControlled = appliedControlMode === 'CONTROLLED';

      // The intent of this sub-step, read once (its per-sub-step fields are cleared right away)
      input?.beforeTick?.();
      const turnInput = Math.max(-1, Math.min(1, intent.turn));
      const worldMoveX = intent.moveX;
      const worldMoveZ = intent.moveZ;
      const moveForward = intent.moveForward;
      const wantsJump = intent.jump;
      clearIntentSubStep(intent);
      characterData.isRunning = intent.run;
      if (isControlled && intent.crouch !== characterData.isCrouching) {
        setCrouching(intent.crouch);
      }

      // Turn: turn input, else toward faceYaw, else toward the move direction (at most
      // _rotateSpeed). Before the move, so a forward move goes along the new facing.
      if (isControlled && !characterData.isTumbling) {
        const maxTurn = characterData._rotateSpeed * dt;
        if (turnInput !== 0) {
          turnCharacter(turnInput * maxTurn);
        } else {
          const hasWorldMove = worldMoveX * worldMoveX + worldMoveZ * worldMoveZ > MOVE_EPSILON_SQ;
          const targetYaw =
            intent.faceYaw ??
            (characterData._turnToMoveDirection && hasWorldMove
              ? yawFromDirection(worldMoveX, worldMoveZ)
              : null);
          if (targetYaw !== null) {
            const yawDiff = wrapToPi(targetYaw - characterData.charRotation);
            if (Math.abs(yawDiff) > YAW_EPSILON) {
              turnCharacter(Math.max(-maxTurn, Math.min(maxTurn, yawDiff)));
            }
          }
        }
      }

      // Move: the world move plus the forward move along the (new) facing, up to length 1
      const moveX = worldMoveX + moveForward * Math.cos(characterData.charRotation);
      const moveZ = worldMoveZ - moveForward * Math.sin(characterData.charRotation);
      const moveLength = Math.hypot(moveX, moveZ);
      characterData.hasMoveInput = moveLength * moveLength > MOVE_EPSILON_SQ;
      if (isControlled && characterData.hasMoveInput && !characterData.isTumbling) {
        applyMove(moveX / moveLength, moveZ / moveLength, Math.min(1, moveLength), dt);
      } else if (
        isControlled &&
        !characterData.groundIsWalkable &&
        characterData.isGrounded &&
        !characterData.isTumbling &&
        !characterData.isOnMovingPlatform
      ) {
        // Without a move, too steep ground still slides the character down
        const vel = moveVector3.set(_vels[0], _vels[1], _vels[2]);
        applySteepSlope(vel, _vels[0], _vels[2], dt);
        if (vel.x !== _vels[0] || vel.z !== _vels[2]) {
          body.setLinvel(setVec(vel.x, vel.y, vel.z), true);
          _vels[0] = vel.x;
          _vels[2] = vel.z;
        }
      }

      // Check isTumbling
      if (
        isControlled &&
        characterData.isTumbling &&
        !characterData.isGettingUp &&
        characterData.__isTumblingStartTime + characterData._tumblingMinTime < now &&
        characterData.relVelocity.length < characterData._tumblingEndMinVelo &&
        characterData.angularVelocity.length < characterData._tumblingEndMinAngVelo
      ) {
        // End tumbling and start isGettingUp phase
        characterData.isGettingUp = true;
        characterData.__isGettingUpStartTime = now;
      } else if (isControlled && characterData.isTumbling) {
        // Clamp angular velocity when tumbling
        const maxAngVel = characterData._tumblingMaxAngVelo;
        const len = Math.hypot(_vels[3], _vels[4], _vels[5]);
        if (len > maxAngVel) {
          const scale = maxAngVel / len;
          _vels[3] *= scale;
          _vels[4] *= scale;
          _vels[5] *= scale;
          body.setAngvel(setVec(_vels[3], _vels[4], _vels[5]), true);
        }
      }

      // Perform isGettingUp
      if (isControlled && characterData.isGettingUp) {
        body.setAngularDamping(characterData._gettingUpAngularDamping);
        const ratio = Math.min(
          (now - characterData.__isGettingUpStartTime) / characterData._gettingUpDuration,
          1
        );
        const q = getUpQuat.set(_pose[3], _pose[4], _pose[5], _pose[6]);
        // Compute body's current up direction
        const bodyUp = getUpVector3.set(0, 1, 0).applyQuaternion(q).normalize();
        // Axis of rotation required to align bodyUp → worldUp
        const axis = getUpBodyUpVector3.copy(bodyUp).cross(LEVEL_GROUND_NORMAL);
        const dot = bodyUp.dot(LEVEL_GROUND_NORMAL);
        const angle = Math.acos(Math.min(Math.max(dot, -1), 1)); // clamp to valid range
        const maxAngVel = characterData._gettingUpMaxAngVelo;
        const angVelLength = Math.hypot(_vels[3], _vels[4], _vels[5]);
        if (angVelLength > maxAngVel) {
          const scale = maxAngVel / angVelLength;
          _vels[3] *= scale;
          _vels[4] *= scale;
          _vels[5] *= scale;
          body.setAngvel(setVec(_vels[3], _vels[4], _vels[5]), true);
        }
        // Prevent NaN or tiny oscillations
        if (angle > 0.00005) {
          axis.normalize();
          const ease = 1 - Math.pow(1 - ratio, 3);
          const torqueStrength = characterData._gettingUpTorque * ease;
          const torque = axis.multiplyScalar(angle * torqueStrength);
          body.applyTorqueImpulse(setVec(torque.x, torque.y, torque.z), true);
        }
        if (ratio >= 1) {
          // Fully upright the player, preserving yaw
          const yaw = getUpYawEuler.setFromQuaternion(q, 'YXZ').y;
          const uprightQuat = getUpUprightQuat.setFromEuler(getUpUprightEuler.set(0, yaw, 0));
          _rot.x = uprightQuat.x;
          _rot.y = uprightQuat.y;
          _rot.z = uprightQuat.z;
          _rot.w = uprightQuat.w;
          body.setRotation(_rot, true);

          // Clear any leftover rotational velocity
          stopCharacterTumbling(characterData, body);
          _vels[3] = 0;
          _vels[4] = 0;
          _vels[5] = 0;
        }
      }

      // Set isFalling
      if (characterData.isGrounded) {
        characterData.__isFallingStartTime = 0;
        characterData.isFalling = false;
      } else if (!characterData.__isFallingStartTime) {
        characterData.__isFallingStartTime = now;
      } else if (characterData.__isFallingStartTime + characterData._isFallingThreshold < now) {
        characterData.isFalling = true;
      }

      // Set velocity and relative velocity data
      const velocity = characterData.velocity;
      velocity.x = _vels[0];
      velocity.y = _vels[1];
      velocity.z = _vels[2];
      velocity.length = Math.hypot(_vels[0], _vels[1], _vels[2]);
      const relVelocity = characterData.relVelocity;
      relVelocity.x = velocity.x;
      relVelocity.y = velocity.y;
      relVelocity.z = velocity.z;
      relVelocity.length = velocity.length;
      // isSliding reads the speed before the moving platform correction below
      const worldVelo = velocity.length;

      // Set angular velocity data
      const angularVelocity = characterData.angularVelocity;
      angularVelocity.x = _vels[3];
      angularVelocity.y = _vels[4];
      angularVelocity.z = _vels[5];
      angularVelocity.length = Math.hypot(_vels[3], _vels[4], _vels[5]);

      const currentPlatformVelo = characterData.__currentPlatformVelocity;
      const lastAppliedPlatformVelo = characterData.__lastAppliedPlatformVelocity;
      currentPlatformVelo.x = 0;
      currentPlatformVelo.y = 0;
      currentPlatformVelo.z = 0;

      // Handle character on moving platform
      if (isControlled && characterData.isOnMovingPlatform) {
        for (let i = 0; i < characterData.__touchingGroundColliders.length; i++) {
          const collider = getPhysicsWorld().getColliderSync(
            characterData.__touchingGroundColliders[i]
          );
          if (!collider) continue;
          const pb = getPhysicsWorld().getRigidBodySync(collider.parentId ?? -1);
          if (!pb) continue;

          const ud = pb.getUserDataSync() as {
            isMovingPlatform: boolean;
            currentPos: THREE.Vector3;
            prevPos: THREE.Vector3;
            velo: THREE.Vector3;
            angVelo: THREE.Vector3;
            friction: number;
          };
          if (ud?.isMovingPlatform) {
            // 1. GET CORRECT ANGULAR VELOCITY
            // Rapier's angvel() is often 0 for kinematic bodies. We MUST use the one we calculated
            // (the physics engine's only as a fallback when the user data is missing).
            const udAngVel = ud.angVelo;
            const physicsAngVel = udAngVel ? null : pb.avel;
            const angVeloX = udAngVel ? udAngVel.x : physicsAngVel!.x;
            const angVeloY = udAngVel ? udAngVel.y : physicsAngVel!.y;
            const angVeloZ = udAngVel ? udAngVel.z : physicsAngVel!.z;

            // 2. CALCULATE VECTORS
            pb.readPoseInto(_platformPose);

            // Flatten Y to prevent "wobble" errors in the radius
            const r = vectors.r.set(_pose[0] - _platformPose[0], 0, _pose[2] - _platformPose[2]);

            const omega = vectors.omega.set(angVeloX, angVeloY, angVeloZ);
            const vTan = vectors.vTan.crossVectors(omega, r);

            // 3. CALCULATE TOTAL FLOOR VELOCITY
            // This is the absolute world speed of the floor under the player's feet.
            currentPlatformVelo.x = ud.velo.x + vTan.x;
            currentPlatformVelo.y = ud.velo.y + vTan.y;
            currentPlatformVelo.z = ud.velo.z + vTan.z;

            // 4. ROTATION (turn with the platform — through the body, like input turning,
            // since the body's rotation is what the mesh gets synced from)
            const hasPlatformRotation = Math.abs(angVeloY) > PLATFORM_ROTATION_EPSILON;
            if (hasPlatformRotation && !characterData.isTumbling) {
              turnCharacter(angVeloY * dt);
            }

            // 5. VELOCITY RECONSTRUCTION (The Sling Fix)

            // A/B. Extract Relative Velocity from the current world velocity:
            // we subtract the TOTAL platform velocity we applied last sub-step.
            const currentRelVelo = vectors.currentRelVelo.set(
              _vels[0] - lastAppliedPlatformVelo.x,
              _vels[1] - lastAppliedPlatformVelo.y,
              _vels[2] - lastAppliedPlatformVelo.z
            );

            if (hasPlatformRotation) {
              // Rotate the vector around the Y axis
              currentRelVelo.applyAxisAngle(LEVEL_GROUND_NORMAL, angVeloY * dt);
            }

            // C. STABILIZATION (Critical)
            // If the player is not trying to move, Force Relative X/Z to 0.
            // This kills the "Centrifugal Drift" that causes the slinging.
            if (!characterData.hasMoveInput && !characterData.isTumbling) {
              // Apply Friction (Decay the relative velocity)
              // 0.8 = slippery, 0.95 = icy, 0.5 = sticky
              currentRelVelo.x *= ud.friction;
              currentRelVelo.z *= ud.friction;

              // Snap to zero if very slow to prevent micro-sliding forever
              if (Math.abs(currentRelVelo.x) < 0.01) currentRelVelo.x = 0;
              if (Math.abs(currentRelVelo.z) < 0.01) currentRelVelo.z = 0;
            }

            // D. Reconstruct New World Velocity
            // New World = Clean Relative + New Platform Total
            const newVelX = currentRelVelo.x + currentPlatformVelo.x;
            const newVelY = currentRelVelo.y + currentPlatformVelo.y;
            const newVelZ = currentRelVelo.z + currentPlatformVelo.z;

            // 6. APPLY AND STORE
            body.setLinvel(setVec(newVelX, newVelY, newVelZ), true);
            _vels[0] = newVelX;
            _vels[1] = newVelY;
            _vels[2] = newVelZ;
            lastAppliedPlatformVelo.x = currentPlatformVelo.x;
            lastAppliedPlatformVelo.y = currentPlatformVelo.y;
            lastAppliedPlatformVelo.z = currentPlatformVelo.z;

            // 7. UPDATE STATUS
            velocity.x = newVelX;
            velocity.y = newVelY;
            velocity.z = newVelZ;
            velocity.length = Math.hypot(newVelX, newVelY, newVelZ);
            relVelocity.x = newVelX - currentPlatformVelo.x;
            relVelocity.y = newVelY - currentPlatformVelo.y;
            relVelocity.z = newVelZ - currentPlatformVelo.z;
            relVelocity.length = Math.hypot(relVelocity.x, relVelocity.y, relVelocity.z);
            angularVelocity.x = angVeloX;
            angularVelocity.y = angVeloY;
            angularVelocity.z = angVeloZ;
            angularVelocity.length = Math.hypot(angVeloX, angVeloY, angVeloZ);

            // Stop processing other platforms
            break;
          }
        }
      } else {
        lastAppliedPlatformVelo.x = 0;
        lastAppliedPlatformVelo.y = 0;
        lastAppliedPlatformVelo.z = 0;
      }

      // Set isAwake (from the velocities: Rapier's isMoving() is an RPC in WORKER_THREAD mode)
      characterData.isAwake =
        velocity.length > AWAKE_EPSILON || angularVelocity.length > AWAKE_EPSILON;

      // Set isSliding
      characterData.isSliding =
        characterData.isGrounded &&
        worldVelo > characterData._minSlidingVelocity &&
        (!characterData.hasMoveInput || !characterData.groundIsWalkable) &&
        !characterData.isOnStairs;

      // Set position
      characterData.position.x = _pose[0];
      characterData.position.y = _pose[1];
      characterData.position.z = _pose[2];

      // Ground normal for the next sub-steps (also while idle or sliding)
      refreshFloorNormal();

      // The jump phase (JUMP) lasts until the character stops rising in the air or lands
      if (characterData.__isJumping) {
        if (!characterData.isGrounded) characterData.__jumpLeftGround = true;
        if (
          characterData.isTumbling ||
          (characterData.__jumpLeftGround && (characterData.isGrounded || relVelocity.y <= 0)) ||
          (!characterData.__jumpLeftGround && now - characterData.__jumpTime > JUMP_LIFT_OFF_GRACE)
        ) {
          characterData.__isJumping = false;
        }
      }

      // Jump last: an impulse after this tick's setLinvel calls adds to them instead of being
      // overwritten (the WORKER_THREAD commands replay in order)
      if (
        wantsJump &&
        isControlled &&
        !characterData.isTumbling &&
        characterData.isGrounded &&
        !characterData.isCrouching &&
        characterData.__jumpTime + characterData._jumpCooldown < now
      ) {
        body.applyImpulse(jumpAmountVector3.set(0, characterData._jumpAmount, 0), true);
        characterData.__jumpTime = now;
        characterData.__isJumping = true;
        characterData.__jumpLeftGround = false;
      }

      // Locomotion state, once per change
      const prevState = characterData.locomotionState;
      const nextState = deriveLocomotionState(characterData, now, isControlled);
      if (nextState !== prevState) {
        characterData.locomotionState = nextState;
        characterData.__locomotionStateStartTime = now;
        emitLocomotionStateChange(character, nextState, prevState);
      }
    },
  };

  return { character, data: characterData, intent, controlFns };
};

const _tumbleStartImpulseVector3 = new THREE.Vector3();
const startCharacterTumbling = (characterData: CharacterData, body?: RigidBodyAPI) => {
  characterData.isGettingUp = false;
  characterData.isTumbling = true;
  characterData.__isTumblingStartTime = getPhysGameTime();
  // angularDampingSync() throws in WORKER_THREAD mode (not backed by the hot-path buffer).
  // The body's angular damping is never touched by anything except this tumble/getting-up/
  // stop cycle, and the walk-capsule rigidBodyParams never set one at creation — so the value
  // to restore once tumbling ends is always the engine default (0), not something that needs
  // querying live.
  characterData.__charAngDamping = 0;
  body?.setAngularDamping(characterData._tumblingAngularDamping);
  body?.lockRotations(false, true);
  body?.setEnabledRotations(true, true, true, true);
  const rando1 = Math.random() > 0.5 ? 1 : -1;
  const rando2 = Math.random() > 0.5 ? 1 : -1;
  body?.applyImpulse(
    _tumbleStartImpulseVector3.set(Math.random() * rando1, 0, Math.random() * rando2),
    true
  );
};

const tumbleStopRotationVector4 = new THREE.Vector4();
const tumbleStopRotationQuat = new THREE.Quaternion(0, 0, 0, 1);
const stopCharacterTumbling = (characterData: CharacterData, body: RigidBodyAPI) => {
  body.setAngvel(setVec(0, 0, 0), true);
  body.setAngularDamping(0);
  body.setEnabledRotations(false, false, false, true);
  body.lockRotations(true, true);
  // The facing is read from the body, not the mesh: in the interpolation modes the mesh holds
  // a blended in-between pose (and in 'NONE' last frame's), while body.rotation() already
  // returns a rotation set earlier this sub-step, in both MAIN_THREAD and WORKER_THREAD mode.
  const rot = body.rotation();
  tumbleStopRotationQuat.set(rot.x, rot.y, rot.z, rot.w);
  characterData.charRotation = eulerForCharRotation.setFromQuaternion(
    tumbleStopRotationQuat,
    'XZY'
  ).y;
  // Upright, but keeping the facing: the body's rotation is what the mesh gets synced from,
  // so resetting it to identity would snap the character to face the default direction.
  const q = tumbleStopRotationQuat.setFromAxisAngle(
    LEVEL_GROUND_NORMAL,
    characterData.charRotation
  );
  body.setRotation(tumbleStopRotationVector4.set(q.x, q.y, q.z, q.w), true);
  body.setAngularDamping(characterData.__charAngDamping);
  characterData.__charAngDamping = 0;
  characterData.isTumbling = false;
  characterData.__isTumblingStartTime = 0;
  characterData.isGettingUp = false;
  characterData.__isGettingUpStartTime = 0;
};
