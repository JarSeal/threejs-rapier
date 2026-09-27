import * as THREE from 'three/webgpu';
import { CharacterObject, createCharacter, deleteCharacter } from '../../core/Character';
import { getECSWorld, type ECSWorld } from '../../core/ECS';
import { ComponentType } from '../../core/ECS/ECSCoreComponents';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { getPhysGameTime, getPhysicsState, getPhysicsWorld } from '../../core/PhysicsAPI';
import {
  RigidBodyTypeAPI,
  type ColliderAPI,
  type ColliderParams,
  type PhysVector,
  type RigidBodyAPI,
  type RigidBodyParams,
} from '../../core/Physics/PhysicsAPITypes';
import { roundToDecimal } from '../helpers';
import { GRAVITY_DOWN_NORMAL, LEVEL_GROUND_NORMAL } from '../constants';
import { existsOrThrow } from '../assert';

// @TODO: add comments for each
// If a prop has one underscore (_) then it means it is a configuration,
// if a prop has two underscores (__) then it means it is a memory slot for data (not configurable)
export type CharacterData = {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number; length: number };
  relVelocity: { x: number; y: number; z: number; length: number };
  angularVelocity: { x: number; y: number; z: number; length: number };
  charRotation: number;
  isAwake: boolean;
  hasMoveInput: boolean;
  isGrounded: boolean;
  isFalling: boolean;
  isRunning: boolean;
  isCrouching: boolean;
  isNearWall: boolean;
  isOnStairs: boolean;
  isOnMovingPlatform: boolean;
  isSliding: boolean;
  isTumbling: boolean;
  isGettingUp: boolean;
  groundIsWalkable: boolean;
  isMovingTowardsImpossibleSlope: boolean;
  groundNormal: { x: number; y: number; z: number };
  _height: number;
  _radius: number;
  _skinThickness: number;
  _groundDetectorOffset: number;
  _groundDetectorRadius: number;
  _tumblingGroundSpeedThreshold: number;
  _tumblingWallSpeedThreshold: number;
  _tumblingMinTime: number;
  _tumblingEndMinVelo: number;
  _tumblingEndMinAngVelo: number;
  _tumblingMaxAngVelo: number;
  _tumblingAngDamping: number;
  _gettingUpDuration: number;
  _rotateSpeed: number;
  _maxVelocity: number;
  _maxWalkableAngle: number;
  _minSlidingVelocity: number;
  _moveYOffset: number;
  _jumpAmount: number;
  _inTheAirDiminisher: number;
  _accumulateVeloPerInterval: number;
  _groundedRayMaxDistance: number;
  /** How much time is there when the character is not touching the ground and goes into the "isFalling" state (in milliseconds) */
  _isFallingThreshold: number;
  _runningMultiplier: number;
  _crouchingMultiplier: number;
  _keepMovingAfterJumpThreshold: number;
  _roundVelocitiesScalingFactor: number;
  __isFallingStartTime: number;
  __isTumblingStartTime: number;
  __jumpTime: number;
  __lastIsGroundedState: boolean;
  __maxWalkableAngleCos: number;
  __touchingWallColliders: number[];
  __touchingGroundColliders: number[];
  __charAngDamping: number;
  __isGettingUpStartTime: number;
  __wasOnMovingPlatformLastFrame: boolean; // @TODO: remove
  __lastAppliedPlatformVelocity: { x: number; y: number; z: number };
  __currentPlatformVelocity: { x: number; y: number; z: number };
};

export type DynamicCharacter = {
  dynamicCharacterObject: CharacterObject;
  charMesh: THREE.Mesh;
  charData: CharacterData;
  controlFns: {
    /** `delta` = simulated seconds this call covers (default: the fixed physics timestep —
     * correct when called once per sub-step, e.g. from an APP_PHYSICS_STEP system). */
    rotate: (direction: 'LEFT' | 'RIGHT', delta?: number) => void;
    /** `delta` = simulated seconds this call covers (default: the fixed physics timestep —
     * correct when called once per sub-step, e.g. from an APP_PHYSICS_STEP system). */
    move: (direction: 'FORWARD' | 'BACKWARD', delta?: number) => void;
    jump: () => void;
  };
  camera?: THREE.PerspectiveCamera;
};

const DEFAULT_CHARACTER_DATA: CharacterData = {
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
  _skinThickness: 0.05,
  _groundDetectorOffset: 0.3,
  _groundDetectorRadius: 0.8,
  _tumblingGroundSpeedThreshold: 9,
  _tumblingWallSpeedThreshold: 6,
  _tumblingMinTime: 2200,
  _tumblingEndMinVelo: 1.4,
  _tumblingEndMinAngVelo: 0.5,
  _tumblingMaxAngVelo: 4.6,
  _tumblingAngDamping: 10,
  _gettingUpDuration: 1000,
  _rotateSpeed: 5,
  _maxVelocity: 3.7,
  _maxWalkableAngle: Math.PI / 4, // 45 degrees (radians)
  _minSlidingVelocity: 2,
  _moveYOffset: 0, // something like 0.15 makes climb steeper slopes
  _jumpAmount: 5,
  _inTheAirDiminisher: 0.6,
  _accumulateVeloPerInterval: 30,
  _groundedRayMaxDistance: 0.82,
  _isFallingThreshold: 1200,
  _runningMultiplier: 1.5,
  _crouchingMultiplier: 0.9,
  _keepMovingAfterJumpThreshold: -10,
  _roundVelocitiesScalingFactor: 1000,
  __isFallingStartTime: 0,
  __isTumblingStartTime: 0,
  __jumpTime: 0,
  __lastIsGroundedState: false,
  __maxWalkableAngleCos: 0,
  __touchingWallColliders: [],
  __touchingGroundColliders: [],
  __charAngDamping: 0,
  __isGettingUpStartTime: 0,
  __wasOnMovingPlatformLastFrame: false,
  __lastAppliedPlatformVelocity: { x: 0, y: 0, z: 0 },
  __currentPlatformVelocity: { x: 0, y: 0, z: 0 },
};
const getDefaultCharacterData = () => {
  // We need to copy all object and arrays
  const position = { ...DEFAULT_CHARACTER_DATA.position };
  const velocity = { ...DEFAULT_CHARACTER_DATA.velocity };
  const relVelocity = { ...DEFAULT_CHARACTER_DATA.relVelocity };
  const angularVelocity = { ...DEFAULT_CHARACTER_DATA.angularVelocity };
  const groundNormal = { ...DEFAULT_CHARACTER_DATA.groundNormal };
  const __touchingWallColliders = [...DEFAULT_CHARACTER_DATA.__touchingWallColliders];
  const __touchingGroundColliders = [...DEFAULT_CHARACTER_DATA.__touchingGroundColliders];
  return {
    ...DEFAULT_CHARACTER_DATA,
    position,
    velocity,
    relVelocity,
    angularVelocity,
    groundNormal,
    __touchingWallColliders,
    __touchingGroundColliders,
  };
};

const eulerForCharRotation = new THREE.Euler();
const vectors = {
  r: new THREE.Vector3(),
  omega: new THREE.Vector3(),
  vTan: new THREE.Vector3(),
  currentRelVelo: new THREE.Vector3(),
  angularVelocity: new THREE.Vector3(),
  groundDot: new THREE.Vector3(),
};

const characters: { [id: string]: DynamicCharacter } = {};

// Per-instance tick closures for the shared APP_PHYSICS_STEP system (mirrors the
// movingPlatform.ts / followObjectCameraRig.ts registerXSystem(world) convention).
// Each tick is owned by its character's entity: it only runs for that entity's world, and the
// character is cleaned up once the entity is gone (e.g. deleted with its scene) — otherwise the
// tick would keep driving a rigid body that no longer exists.
type CharacterTick = { world: ECSWorld; entityId: number; tick: (dt: number) => void };
const activeCharacterTicks = new Map<string, CharacterTick>();

// Shared scratch objects for refreshWallHit (below) — reused across all character instances
// and frames to avoid per-frame allocation. Safe across concurrent in-flight casts: each
// call spreads these into a fresh object before handing it to castShape().
const _moveDir = new THREE.Vector3();
const _returnNormalVector = new THREE.Vector3();
const _castPos = { x: 0, y: 0, z: 0 };
const _castDir = { x: 0, y: 0, z: 0 };
const _castRot = { w: 1, x: 0, y: 0, z: 0 }; // Identity quaternion

const characterMovementSystemFn = (world: ECSWorld, dt: number) => {
  for (const [id, character] of activeCharacterTicks) {
    if (character.world !== world) continue;
    if (!world.isAlive(character.entityId)) {
      activeCharacterTicks.delete(id);
      delete characters[id];
      continue;
    }
    character.tick(dt);
  }
};

/** Registers the shared per-tick character-movement system, run once per fixed physics
 * sub-step (APP_PHYSICS_STEP) like the legacy scene physics looper it replaces — the tick's
 * per-step amounts (e.g. turning with a rotating platform by angVelo * timestep) are only right
 * at that cadence. Idempotent to call more than once (world.addSystem dedupes by name) — call
 * once from wherever the owning scene/app wires up its ECS systems. */
export const registerDynamicCharacterSystem = (world: ECSWorld) => {
  world.addSystem(
    ECSSystemStage.APP_PHYSICS_STEP,
    'dynamicCharacterSystem',
    characterMovementSystemFn
  );
};

export const createDynamicCharacter = async (opts: {
  id: string;
  charMesh: THREE.Mesh;
  charData?: Partial<CharacterData>;
  sceneId?: string;
  inputMappings?: {
    rotateLeft: string[];
    rotateRight: string[];
    moveForward: string[];
    moveBackward: string[];
    jump: string[];
    run: string[];
    crouch: string[];
  };
}) => {
  const { id, charMesh, charData, inputMappings } = opts;

  // Combine character data
  const characterData = { ...getDefaultCharacterData(), ...charData };
  const character: Partial<DynamicCharacter> = { charData: characterData };

  // Set __maxWalkableAngleCos
  characterData.__maxWalkableAngleCos = Math.cos(characterData._maxWalkableAngle);

  const moveVector3 = new THREE.Vector3();
  const groundVector3 = new THREE.Vector3();
  const moveDirVector3 = new THREE.Vector3();
  const gravityDownVector3 = GRAVITY_DOWN_NORMAL.clone();
  const slopeSlideVector3 = new THREE.Vector3();
  const uphillNormalVector3 = new THREE.Vector3();
  const flatNormalVector3 = new THREE.Vector3();
  const jumpAmountVector3 = new THREE.Vector3();
  const justLandedVector3 = new THREE.Vector3();

  // currentColliderIndex tracks which of the walk (0) / crouch (1) colliders is enabled,
  // mirroring legacy switchPhysicsCollider's default (index 0 enabled at creation).
  let currentColliderIndex = 0;
  // Forward-declared: closures below (controlFns, collider collisionEventFn) close over
  // this and are only ever invoked after createCharacter() resolves and assigns it once.
  // eslint-disable-next-line prefer-const
  let characterBody: RigidBodyAPI;
  let characterBodyId = -1;
  let liveColliders: ColliderAPI[] = [];

  // WorldAPI.castShapeSync()/castRayAndGetNormalSync() throw in WORKER_THREAD mode (spatial
  // queries need the live physics world, which lives off-thread there — unlike pos/rot/lvel/
  // avel there's no hot-path buffer that could make this synchronous). move() needs a same-
  // frame value for wall-slide/slope math, so the async cast is fired fresh every frame it's
  // needed and the PREVIOUS frame's resolved result is used meanwhile — one frame of latency,
  // imperceptible for both effects (also how the wall/floor sensors' bodyType() check above
  // and the isAwake update below cope with the same async-only constraint).
  let cachedWallHit: { normal: PhysVector; distance: number } | null = null;
  let wallHitCastInFlight = false;

  /** Fires an async wall shape-cast (fire-and-forget) if one isn't already in flight,
   * updating cachedWallHit once it resolves. move() reads cachedWallHit synchronously —
   * see the comment above on why this can't be a same-frame synchronous cast. */
  const refreshWallHit = () => {
    if (wallHitCastInFlight) return;
    const vel = characterBody.linvel();
    _moveDir.set(vel.x, 0, vel.z);
    // Optimization: If standing still, wall sliding is irrelevant.
    if (_moveDir.lengthSq() < 0.001) {
      cachedWallHit = null;
      return;
    }
    _moveDir.normalize();
    _castDir.x = _moveDir.x;
    _castDir.y = 0; // Force horizontal
    _castDir.z = _moveDir.z;

    // Known collider dimensions (walk/crouch capsule, tracked from creation-time params —
    // geometry can't be queried off the active collider synchronously in WORKER_THREAD mode).
    const activeHalfHeight = characterData.isCrouching
      ? characterData._height / 10
      : characterData._height / 5;
    const targetHeight = activeHalfHeight * 0.9;
    const targetRadius = characterData._radius * 1.05;

    const bodyPos = characterBody.pos;
    _castPos.x = bodyPos.x;
    _castPos.y = bodyPos.y + 0.1; // Lift slightly
    _castPos.z = bodyPos.z;

    wallHitCastInFlight = true;
    getPhysicsWorld()
      .castShape(
        { ..._castPos },
        { ..._castRot },
        { ..._castDir },
        { type: 'CYLINDER', halfHeight: targetHeight, radius: targetRadius },
        0.0,
        0.2,
        true, // Stop at Penetration
        undefined,
        undefined,
        undefined,
        characterBody // Exclude Self
      )
      .then(async (hit) => {
        wallHitCastInFlight = false;
        if (!hit) {
          cachedWallHit = null;
          return;
        }
        const n = hit.normal1;
        if (Math.abs(n.y) > 0.7 || (await hit.collider.isSensor())) {
          cachedWallHit = null;
          return;
        }
        cachedWallHit = {
          normal: _returnNormalVector.set(n.x, n.y, n.z),
          distance: hit.timeOfImpact,
        };
      })
      .catch(() => {
        wallHitCastInFlight = false;
      });
  };

  /** Fires an async floor ray-cast (fire-and-forget), updating characterData.groundNormal/
   * groundIsWalkable once it resolves — see the comment above on the async-only constraint. */
  const refreshFloorNormal = () => {
    const origin = characterBody.pos;
    getPhysicsWorld()
      .castRayAndGetNormal(
        { origin: { ...origin }, dir: { x: 0, y: -1, z: 0 } },
        (characterData.isCrouching ? characterData._height / 10 : characterData._height / 5) * 2 +
          characterData._radius * 4,
        false,
        undefined,
        undefined,
        undefined,
        characterBody
      )
      .then((hit) => {
        const groundNormal = hit?.normal || { x: 0, y: 1, z: 0 };
        characterData.groundNormal = {
          x: groundNormal.x,
          y: groundNormal.y,
          z: groundNormal.z,
        };
        const groundDot = vectors.groundDot
          .set(groundNormal.x, groundNormal.y, groundNormal.z)
          .dot(LEVEL_GROUND_NORMAL);

        characterData.groundIsWalkable = true;
        if (hit && groundDot <= characterData.__maxWalkableAngleCos) {
          characterData.groundIsWalkable = false;
        }
      })
      .catch(() => {});
  };

  const yawQuat = new THREE.Quaternion();
  /** Turns the character by `amount` radians around the world up axis. The yaw accumulates in
   * characterData.charRotation and goes only into the body: the body is the single source of
   * truth and the mesh follows it like any other physics-driven Object3D. Never write
   * charMesh.quaternion here: it is rewritten from the physics pose (interpolated, and one step
   * late in WORKER_THREAD mode), and since this only runs on frames with a physics sub-step, a
   * direct write makes the rendered yaw alternate between the live and the physics yaw whenever
   * the render rate exceeds the physics rate. */
  const turnCharacter = (amount: number) => {
    characterData.charRotation += amount;
    yawQuat.setFromAxisAngle(LEVEL_GROUND_NORMAL, characterData.charRotation);
    // Plain object, not the THREE.Quaternion: its values live in private fields that don't
    // survive the WORKER_THREAD postMessage structured clone.
    characterBody?.setRotation({ x: yawQuat.x, y: yawQuat.y, z: yawQuat.z, w: yawQuat.w }, true);
  };

  const controlFns = {
    // Both take the simulation delta they are driven with (KEY_HELD bindings pass the fixed
    // sub-step delta), never the render-frame delta: they run once per physics sub-step, so a
    // render-rate delta would make turning/acceleration depend on the display's refresh rate.
    rotate: (direction: 'LEFT' | 'RIGHT', delta = getPhysicsState().timestepRatio) => {
      if (characterData.isTumbling) return;
      const dir = direction === 'LEFT' ? 1 : -1;
      const speed = characterData._rotateSpeed || 2;
      turnCharacter(speed * delta * dir);
    },
    move: (direction: 'FORWARD' | 'BACKWARD', delta = getPhysicsState().timestepRatio) => {
      if (characterData.isTumbling) return;
      const rigidBody = characterBody;
      if (rigidBody) {
        const linvel = rigidBody.linvel();
        const vel = moveVector3.set(linvel.x, linvel.y, linvel.z);
        const maxVeloMultiplier =
          // isRunning
          characterData.isRunning && characterData.isGrounded && !characterData.isCrouching
            ? characterData._runningMultiplier
            : // isCrouching
              characterData.isGrounded && characterData.isCrouching
              ? characterData._crouchingMultiplier
              : 1;
        const maxVelo = characterData._maxVelocity * maxVeloMultiplier;
        const mainDirection = direction === 'FORWARD' ? 1 : -1;
        const inTheAirDiminisher =
          characterData.isGrounded && !characterData.isFalling
            ? 1
            : characterData._inTheAirDiminisher;
        const crouchVeloAccuMultiplier = characterData.isCrouching
          ? characterData._crouchingMultiplier + 1
          : 1;
        const veloAccu =
          characterData._accumulateVeloPerInterval *
          inTheAirDiminisher *
          crouchVeloAccuMultiplier *
          delta;
        const xVelo = Math.cos(characterData.charRotation) * veloAccu * mainDirection;
        const zVelo = -Math.sin(characterData.charRotation) * veloAccu * mainDirection;

        const xMaxVelo = Math.cos(characterData.charRotation) * maxVelo * mainDirection;
        const zMaxVelo = -Math.sin(characterData.charRotation) * maxVelo * mainDirection;

        const curLinvelX = characterData.relVelocity.x || 0;
        const curLinvelZ = characterData.relVelocity.z || 0;
        const xAddition =
          xVelo > 0
            ? Math.min(
                curLinvelX + xVelo,
                characterData.isGrounded ? xMaxVelo : curLinvelX > xMaxVelo ? curLinvelX : xMaxVelo
              )
            : Math.max(
                curLinvelX + xVelo,
                characterData.isGrounded ? xMaxVelo : curLinvelX < xMaxVelo ? curLinvelX : xMaxVelo
              );
        const zAddition =
          zVelo > 0
            ? Math.min(
                curLinvelZ + zVelo,
                characterData.isGrounded ? zMaxVelo : curLinvelZ > zMaxVelo ? curLinvelZ : zMaxVelo
              )
            : Math.max(
                curLinvelZ + zVelo,
                characterData.isGrounded ? zMaxVelo : curLinvelZ < zMaxVelo ? curLinvelZ : zMaxVelo
              );

        let charLinvelY = rigidBody.linvel()?.y || 0;
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
          const hit = cachedWallHit;

          if (hit) {
            // 1. Flatten the Normal (Critical for Vertical Stability)
            // We strictly ignore the Y component of the wall.
            // This prevents the wall from pushing us UP or holding us in the air.
            const rawNormal = hit.normal;
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

              // 🛑 5. THE MICRO-PUSH (Fixes "Sticky/Floating" walls)
              // We add a tiny velocity AWAY from the wall.
              // This breaks physical contact for the next frame, ensuring Rapier
              // doesn't apply vertical friction that fights gravity.
              const pushForce = 0.05;

              slideX += flatNormal.x * pushForce;
              slideZ += flatNormal.z * pushForce;

              // 6. Apply back to the output vector
              vel.x = slideX;
              vel.z = slideZ;
              // We explicitly leave vel.y alone so gravity/jumping works perfectly
            }
          }
        }

        // Unwalkable slope check (uses the previous frame's resolved ground normal;
        // refreshFloorNormal() fires the next cast below, after vel/slope math is done)
        if (!characterData.groundIsWalkable) {
          // 1. Get the Slope Normal
          const n = groundVector3
            .set(
              characterData.groundNormal.x,
              characterData.groundNormal.y,
              characterData.groundNormal.z
            )
            .normalize();

          // 2. Calculate the "Steep Slope Slide" Direction
          // This vector points straight down the slope face.
          // slideDir = (gravity - (gravity . n) * n).normalize()
          const gravityDot = gravityDownVector3.dot(n);
          const slopeSlideDir = slopeSlideVector3
            .copy(n) // 1. Copy Normal into helper (so we don't mutate n)
            .multiplyScalar(gravityDot) // 2. Scale the helper
            .subVectors(gravityDownVector3, slopeSlideVector3) // 3. Set helper to: (Gravity - Helper)
            .normalize(); // 4. Normalize

          // 3. Project your Intended Velocity (vel)
          // We want to see if your intended movement pushes you UPHILL.
          const currentX = vel.x; // Use 'vel' (your input), NOT 'linvel'
          const currentZ = vel.z;

          // Create a vector for your intended horizontal movement
          const inputDir = moveDirVector3.set(currentX, 0, currentZ);

          // Calculate how much of your input aligns with the DOWNHILL direction
          // dot > 0 : You are moving downhill (Allowed)
          // dot < 0 : You are trying to climb uphill (Forbidden)
          const dot = inputDir.dot(slopeSlideDir);

          if (dot < 0) {
            // 🛑 UPHILL MOVEMENT: Cancel it!
            // We remove the component of velocity that opposes the slide.
            // Effectively, we "project" the velocity onto the slide direction,
            // keeping only the part that isn't climbing.

            // Simple version: Zero out X/Z input if trying to climb.
            // Better version: Deflect input sideways so you can still strafe across the slope.

            // Let's effectively treat the slope as a wall for uphill movement.
            // Wall Normal = -slopeSlideDir (pointing uphill)
            const uphillNormal = uphillNormalVector3.copy(slopeSlideDir).negate();

            // Project velocity against this "uphill wall"
            const inputDotNormal = inputDir.dot(uphillNormal);

            // v_slide = v - (v . n) * n
            const correctedX = currentX - inputDotNormal * uphillNormal.x;
            const correctedZ = currentZ - inputDotNormal * uphillNormal.z;

            vel.x = correctedX;
            vel.z = correctedZ;

            // Optional: Add extra downward slide force so you don't just stick
            const slideSpeed = 15.0; // Adjust for slippiness
            vel.x += slopeSlideDir.x * slideSpeed * delta;
            vel.z += slopeSlideDir.z * slideSpeed * delta;
          }

          // 4. Allow Gravity to do its job
          // If we are on an unwalkable slope, we are technically "falling" or "sliding".
          // Ensure we aren't applying any upward Y velocity (jumping) unless desired.
        }
        refreshFloorNormal();

        rigidBody.setLinvel(vel, true);
      }
    },
    jump: () => {
      // Jump
      const charData = characterData;
      if (charData.isTumbling) return;
      const jumpCheckOk =
        charData.isGrounded &&
        !charData.isCrouching &&
        charData.__jumpTime + 100 < getPhysGameTime();
      if (jumpCheckOk) {
        characterBody?.applyImpulse(jumpAmountVector3.set(0, charData._jumpAmount, 0), true);
        charData.__jumpTime = getPhysGameTime();
      }
    },
    run: () => {
      // Set isRunning state
      characterData.isRunning = !characterData.isRunning;
    },
    crouch: () => {
      // Set isCrouching state
      characterData.isCrouching = !characterData.isCrouching;
      const nextIndex = characterData.isCrouching ? 1 : 0;
      liveColliders[currentColliderIndex].setEnabled(false);
      liveColliders[nextIndex].setEnabled(true);
      currentColliderIndex = nextIndex;
    },
  };

  // Compound colliders (all sharing one rigid body). Radius is set explicitly to
  // characterData._radius on the walk/crouch capsules: legacy derived this from the
  // character mesh's CapsuleGeometry (radius: characterData._radius) when the collider
  // params omitted their own radius — the new Physics API has no such mesh-derivation
  // fallback (EngineRapier.ts defaults an unset capsule radius to 0.25), so it must be
  // explicit here to reproduce the same collision size.
  const colliders: ColliderParams[] = [
    {
      // Main character collider (walk / run) [INDEX: 0]
      type: 'CAPSULE',
      halfHeight: characterData._height / 5,
      radius: characterData._radius,
      // friction: 0.7,
      // frictionCombineRule: 'MULTIPLY',
    },
    {
      // Crouch collider [INDEX: 1]
      type: 'CAPSULE',
      friction: 0.9,
      halfHeight: characterData._height / 10,
      radius: characterData._radius,
      enabled: false,
      // Offset from the body so the shorter capsule's bottom lines up with the walk capsule's
      translation: { x: 0, y: -characterData._height / 10, z: 0 },
    },
    {
      // Wall sensor [INDEX: 2]
      type: 'CAPSULE',
      halfHeight: characterData._height / 5.5,
      radius: characterData._radius * (characterData._skinThickness + 1),
      isSensor: true,
      density: 0,
      translation: { x: 0, y: 0.05, z: 0 },
      collisionEventFn: (collider1: ColliderAPI, collider2: ColliderAPI, started: boolean) => {
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
              if (characterData.relVelocity.length > characterData._tumblingWallSpeedThreshold) {
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
      },
    },
    {
      // Floor sensor [INDEX: 3]
      type: 'BALL',
      radius: characterData._radius * characterData._groundDetectorRadius,
      isSensor: true,
      density: 0,
      translation: {
        x: 0,
        y: -characterData._height / 2 + characterData._groundDetectorOffset,
        z: 0,
      },
      collisionEventFn: (collider1: ColliderAPI, collider2: ColliderAPI, started: boolean) => {
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

          // Tumble Check
          if (
            characterData.relVelocity.length > characterData._tumblingGroundSpeedThreshold &&
            !characterData.__lastIsGroundedState
          ) {
            startCharacterTumbling(characterData, characterBody);
            return;
          }

          // Keep Moving / Landing Logic
          if (
            characterData._keepMovingAfterJumpThreshold < (characterBody?.linvel().y ?? -5) &&
            !characterData.isFalling &&
            !characterData.__lastIsGroundedState &&
            characterData.hasMoveInput
          ) {
            const linvel = characterBody.linvel();
            characterBody.setLinvel(justLandedVector3.set(linvel.x, 0, linvel.z), true);
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
      },
    },
  ];

  const rigidBodyParams: RigidBodyParams = {
    rigidType: 'DYNAMIC',
    lockRotations: { x: true, y: true, z: true },
    linearDamping: 0,
  };

  const ecsWorld = getECSWorld();

  const dynamicCharacterObject = await createCharacter({
    id,
    physicsParams: { colliders, rigidBody: rigidBodyParams },
    meshOrMeshId: charMesh,
    // Every binding ignores modifiers (as the legacy input system did): Shift and Ctrl are the
    // run/crouch toggles themselves, and pressing one must not interrupt a held move/turn key.
    controls: inputMappings
      ? [
          {
            id: 'charRotateLeft',
            ignoreModifiers: true,
            type: 'KEY_HELD',
            chord: inputMappings.rotateLeft.map((key) => ({ key })),
            fn: (delta) => controlFns.rotate('LEFT', delta),
          },
          {
            id: 'charRotateRight',
            ignoreModifiers: true,
            type: 'KEY_HELD',
            chord: inputMappings.rotateRight.map((key) => ({ key })),
            fn: (delta) => controlFns.rotate('RIGHT', delta),
          },
          {
            id: 'charMoveForward',
            ignoreModifiers: true,
            type: 'KEY_HELD',
            chord: inputMappings.moveForward.map((key) => ({ key })),
            fn: (delta) => {
              characterData.hasMoveInput = true;
              controlFns.move('FORWARD', delta);
            },
          },
          {
            id: 'charMoveBackward',
            ignoreModifiers: true,
            type: 'KEY_HELD',
            chord: inputMappings.moveBackward.map((key) => ({ key })),
            fn: (delta) => {
              characterData.hasMoveInput = true;
              controlFns.move('BACKWARD', delta);
            },
          },
          {
            id: 'charStopMoveAndRotate',
            ignoreModifiers: true,
            type: 'KEY_UP',
            chord: [...inputMappings.moveForward, ...inputMappings.moveBackward].map((key) => ({
              key,
            })),
            fn: (e) => {
              e.preventDefault();
              characterData.hasMoveInput = false;
            },
          },
          {
            id: 'charJump',
            ignoreModifiers: true,
            type: 'KEY_DOWN',
            chord: inputMappings.jump.map((key) => ({ key })),
            fn: (e) => {
              e.preventDefault();
              if (e.repeat) return;
              controlFns.jump();
            },
          },
          {
            id: 'charRun',
            ignoreModifiers: true,
            type: 'KEY_DOWN',
            chord: inputMappings.run.map((key) => ({ key })),
            fn: (e) => {
              e.preventDefault();
              if (e.repeat) return;
              controlFns.run();
            },
          },
          {
            id: 'charCrouch',
            ignoreModifiers: true,
            type: 'KEY_DOWN',
            chord: inputMappings.crouch.map((key) => ({ key })),
            fn: (e) => {
              e.preventDefault();
              if (e.repeat) return;
              controlFns.crouch();
            },
          },
        ]
      : undefined,
  });

  characterBody = existsOrThrow(
    ecsWorld.getRigidBody(dynamicCharacterObject.entityId),
    `Could not find character physics object rigid body with id: '${dynamicCharacterObject.entityId}'.`
  );
  characterBodyId = characterBody.id;
  liveColliders = existsOrThrow(
    ecsWorld.getComponent(dynamicCharacterObject.entityId, ComponentType.COLLIDER),
    `Could not find character colliders for entity id: '${dynamicCharacterObject.entityId}'.`
  );

  const usableVec = new THREE.Vector3();
  const getUpQuat = new THREE.Quaternion();
  const getUpVector3 = new THREE.Vector3();
  const getUpBodyUpVector3 = new THREE.Vector3();
  const getUpAngVelVector3 = new THREE.Vector3();
  const getUpYawEuler = new THREE.Euler();
  const getUpUprightQuat = new THREE.Quaternion();
  const getUpUprightEuler = new THREE.Euler();

  activeCharacterTicks.set(id, {
    world: ecsWorld,
    entityId: dynamicCharacterObject.entityId,
    tick: () => {
      const body = characterBody;
      if (!body) return;

      // Check isTumbling
      if (
        characterData.isTumbling &&
        !characterData.isGettingUp &&
        characterData.__isTumblingStartTime + characterData._tumblingMinTime < getPhysGameTime() &&
        characterData.relVelocity.length < characterData._tumblingEndMinVelo &&
        characterData.angularVelocity.length < characterData._tumblingEndMinAngVelo
      ) {
        // End tumbling and start isGettingUp phase
        characterData.isGettingUp = true;
        characterData.__isGettingUpStartTime = getPhysGameTime();
      } else if (characterData.isTumbling) {
        // Clamp angular velocity when tumbling
        const w = body.angvel();
        const maxAngVel = characterData._tumblingMaxAngVelo;

        const len = Math.hypot(w.x, w.y, w.z);
        if (len > maxAngVel) {
          const scale = maxAngVel / len;
          body.setAngvel({ x: w.x * scale, y: w.y * scale, z: w.z * scale }, true);
        }
      }

      // Perform isGettingUp
      if (characterData.isGettingUp) {
        body.setAngularDamping(25.0);
        const ratio = Math.min(
          getPhysGameTime() /
            (characterData.__isGettingUpStartTime + characterData._gettingUpDuration),
          1
        );
        const rot = body.rotation();
        const q = getUpQuat.set(rot.x, rot.y, rot.z, rot.w);
        // Compute body's current up direction
        const bodyUp = getUpVector3.set(0, 1, 0).applyQuaternion(q).normalize();
        // Axis of rotation required to align bodyUp → worldUp
        const axis = getUpBodyUpVector3.copy(bodyUp).cross(LEVEL_GROUND_NORMAL);
        const dot = bodyUp.dot(LEVEL_GROUND_NORMAL);
        const angle = Math.acos(Math.min(Math.max(dot, -1), 1)); // clamp to valid range
        const ang = body.angvel();
        const angVel = getUpAngVelVector3.set(ang.x, ang.y, ang.z);
        const maxAngVel = 2.0;
        if (angVel.length() > maxAngVel) {
          angVel.setLength(maxAngVel);
          body.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);
        }
        // Prevent NaN or tiny oscillations
        if (angle > 0.00005) {
          axis.normalize();
          const ease = 1 - Math.pow(1 - ratio, 3);
          const torqueStrength = 0.2 * ease;
          const torque = axis.multiplyScalar(angle * torqueStrength);
          body.applyTorqueImpulse({ x: torque.x, y: torque.y, z: torque.z }, true);
        }
        if (ratio >= 1) {
          // Fully upright the player, preserving yaw
          const yaw = getUpYawEuler.setFromQuaternion(q, 'YXZ').y;
          const uprightQuat = getUpUprightQuat.setFromEuler(getUpUprightEuler.set(0, yaw, 0));
          body.setRotation(uprightQuat, true);

          // Clear any leftover rotational velocity
          stopCharacterTumbling(characterData, body);
        }
      }

      // Set isAwake (physics isMoving, aka. is awake)
      // isMovingSync() throws in WORKER_THREAD mode (not backed by the hot-path buffer) — use
      // the async form and accept a one-tick-latent update, same tradeoff as the wall sensor's
      // bodyType() check below.
      void body.isMoving().then((isMoving) => {
        characterData.isAwake = isMoving;
      });

      // Set isFalling
      if (characterData.isGrounded) {
        characterData.__isFallingStartTime = 0;
        characterData.isFalling = false;
      } else if (!characterData.__isFallingStartTime) {
        characterData.__isFallingStartTime = getPhysGameTime();
      } else if (
        characterData.__isFallingStartTime + characterData._isFallingThreshold <
        getPhysGameTime()
      ) {
        characterData.isFalling = true;
      }

      // Set velocity and relative velocity data
      const linvel = body.linvel();
      const velo = usableVec.set(
        roundToDecimal(linvel.x || 0, characterData._roundVelocitiesScalingFactor),
        roundToDecimal(linvel.y || 0, characterData._roundVelocitiesScalingFactor),
        roundToDecimal(linvel.z || 0, characterData._roundVelocitiesScalingFactor)
      );
      const worldVelo = roundToDecimal(velo.length(), characterData._roundVelocitiesScalingFactor);
      characterData.velocity = {
        x: velo.x,
        y: velo.y,
        z: velo.z,
        length: worldVelo,
      };
      characterData.relVelocity.x = characterData.velocity.x;
      characterData.relVelocity.y = characterData.velocity.y;
      characterData.relVelocity.z = characterData.velocity.z;
      characterData.relVelocity.length = worldVelo;

      // Set angular and relative angular velocity data
      const bodyAngVelo = body.angvel();
      const angVelo = usableVec.set(bodyAngVelo.x || 0, bodyAngVelo.y || 0, bodyAngVelo.z || 0);
      characterData.angularVelocity = {
        x: roundToDecimal(angVelo.x, characterData._roundVelocitiesScalingFactor),
        y: roundToDecimal(angVelo.y, characterData._roundVelocitiesScalingFactor),
        z: roundToDecimal(angVelo.z, characterData._roundVelocitiesScalingFactor),
        length: roundToDecimal(angVelo.length(), characterData._roundVelocitiesScalingFactor),
      };

      characterData.__currentPlatformVelocity = { x: 0, y: 0, z: 0 };

      // Handle character on moving platform
      if (characterData.isOnMovingPlatform) {
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
            // Rapier's angvel() is often 0 for kinematic bodies. We MUST use the one we calculated.
            const physicsAngVel = pb.angvel();
            const udAngVel = ud.angVelo;

            // Fallback to physics engine if userData is missing, but prefer userData
            const angVelo = {
              x: udAngVel ? udAngVel.x : physicsAngVel.x,
              y: udAngVel ? udAngVel.y : physicsAngVel.y,
              z: udAngVel ? udAngVel.z : physicsAngVel.z,
            };

            // 2. CALCULATE VECTORS
            const platformPos = pb.translation();
            const charPos = body.translation();

            // Flatten Y to prevent "wobble" errors in the radius
            const r = vectors.r.set(charPos.x - platformPos.x, 0, charPos.z - platformPos.z);

            const omega = vectors.omega.set(angVelo.x, angVelo.y, angVelo.z);
            const vTan = vectors.vTan.crossVectors(omega, r);

            // 3. CALCULATE TOTAL FLOOR VELOCITY
            // This is the absolute world speed of the floor under the player's feet.
            const totalPlatformVeloAtPoint = {
              x: ud.velo.x + vTan.x,
              y: ud.velo.y + vTan.y,
              z: ud.velo.z + vTan.z,
            };

            // 4. ROTATION (turn with the platform — through the body, like input turning,
            // since the body's rotation is what the mesh gets synced from)
            if (Math.abs(angVelo.y) > 0.001 && !characterData.isTumbling) {
              turnCharacter(angVelo.y * getPhysicsState().timestepRatio);
            }

            // 5. VELOCITY RECONSTRUCTION (The Sling Fix)

            // A. Get Current World Velocity
            const currentWorldVelo = body.linvel();

            // B. Extract Relative Velocity
            // We subtract the TOTAL platform velocity we applied last frame.
            const currentRelVelo = vectors.currentRelVelo.set(
              currentWorldVelo.x - characterData.__lastAppliedPlatformVelocity.x,
              currentWorldVelo.y - characterData.__lastAppliedPlatformVelocity.y,
              currentWorldVelo.z - characterData.__lastAppliedPlatformVelocity.z
            );

            if (Math.abs(angVelo.y) > 0.001) {
              const rotationStep = angVelo.y * getPhysicsState().timestepRatio;
              // Rotate the vector around the Y axis
              currentRelVelo.applyAxisAngle(LEVEL_GROUND_NORMAL, rotationStep);
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
            const newVelX = currentRelVelo.x + totalPlatformVeloAtPoint.x;
            const newVelY = currentRelVelo.y + totalPlatformVeloAtPoint.y;
            const newVelZ = currentRelVelo.z + totalPlatformVeloAtPoint.z;

            // 6. APPLY AND STORE
            body.setLinvel({ x: newVelX, y: newVelY, z: newVelZ }, true);

            characterData.__lastAppliedPlatformVelocity = {
              x: totalPlatformVeloAtPoint.x,
              y: totalPlatformVeloAtPoint.y,
              z: totalPlatformVeloAtPoint.z,
            };
            characterData.__currentPlatformVelocity = totalPlatformVeloAtPoint;

            // 7. UPDATE STATUS
            // Set new character velocity
            const v = usableVec.set(newVelX, newVelY, newVelZ);
            characterData.velocity.x = roundToDecimal(
              newVelX,
              characterData._roundVelocitiesScalingFactor
            );
            characterData.velocity.y = roundToDecimal(
              newVelY,
              characterData._roundVelocitiesScalingFactor
            );
            characterData.velocity.z = roundToDecimal(
              newVelZ,
              characterData._roundVelocitiesScalingFactor
            );
            characterData.velocity.length = roundToDecimal(
              v.length(),
              characterData._roundVelocitiesScalingFactor
            );

            // Set new character relative velocity
            const newRelVelX = newVelX - ud.velo.x - vTan.x;
            const newRelVelY = newVelY - ud.velo.y - vTan.y;
            const newRelVelZ = newVelZ - ud.velo.z - vTan.z;
            const vRel = usableVec.set(newRelVelX, newRelVelY, newRelVelZ);
            const vRelLength = vRel.length();
            characterData.relVelocity.x = roundToDecimal(
              vRel.x,
              characterData._roundVelocitiesScalingFactor
            );
            characterData.relVelocity.y = roundToDecimal(
              vRel.y,
              characterData._roundVelocitiesScalingFactor
            );
            characterData.relVelocity.z = roundToDecimal(
              vRel.z,
              characterData._roundVelocitiesScalingFactor
            );
            characterData.relVelocity.length = roundToDecimal(
              vRelLength,
              characterData._roundVelocitiesScalingFactor
            );
            characterData.__lastAppliedPlatformVelocity = {
              x: totalPlatformVeloAtPoint.x,
              y: totalPlatformVeloAtPoint.y,
              z: totalPlatformVeloAtPoint.z,
            };

            // Set character angular velocity
            characterData.angularVelocity = {
              x: roundToDecimal(angVelo.x, characterData._roundVelocitiesScalingFactor),
              y: roundToDecimal(angVelo.y, characterData._roundVelocitiesScalingFactor),
              z: roundToDecimal(angVelo.z, characterData._roundVelocitiesScalingFactor),
              length: roundToDecimal(
                vectors.angularVelocity.set(angVelo.x, angVelo.y, angVelo.z).length(),
                characterData._roundVelocitiesScalingFactor
              ),
            };

            // Stop processing other platforms
            break;
          }
        }
      } else {
        characterData.__lastAppliedPlatformVelocity = { x: 0, y: 0, z: 0 };
      }

      // Set isSliding
      characterData.isSliding = false;
      if (
        characterData.isGrounded &&
        worldVelo > characterData._minSlidingVelocity &&
        (!characterData.hasMoveInput || !characterData.groundIsWalkable) &&
        !characterData.isOnStairs
      ) {
        characterData.isSliding = true;
      }

      // Set position
      characterData.position = body.translation();
    },
  });

  character.charMesh = charMesh;
  character.dynamicCharacterObject = dynamicCharacterObject;
  character.controlFns = controlFns;

  characters[id] = character as DynamicCharacter;

  return characters[id];
};

/** Deletes a dynamic character: disposes its ECS entity (physics body/colliders, mesh, key
 * bindings — via Character.ts's deleteCharacter) and stops its per-tick movement/tumbling
 * system entry. Without this second part, deleting only via Character.ts's deleteCharacter()
 * would leave a zombie entry in activeCharacterTicks referencing a disposed rigid body. */
export const deleteDynamicCharacter = (id: string) => {
  deleteCharacter(id);
  activeCharacterTicks.delete(id);
  delete characters[id];
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
  body?.setAngularDamping(2.5);
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
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
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
