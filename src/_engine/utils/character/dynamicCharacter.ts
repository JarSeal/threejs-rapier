import * as THREE from 'three/webgpu';
import { CharacterObject, createCharacter } from '../../core/Character';
import { transformAppSpeedValue } from '../../core/MainLoop';
import {
  addScenePhysicsLooper,
  getPhysGameTime,
  getPhysicsObject,
  getPhysicsState,
  getPhysicsWorld,
  PhysicsObject,
  switchPhysicsCollider,
} from '../../core/PhysicsRapier';
import RAPIER, { type Collider } from '@dimforge/rapier3d-compat';
import { existsOrThrow, roundToDecimal } from '../helpers';
import { GRAVITY_DOWN_NORMAL, LEVEL_GROUND_NORMAL } from '../constants';

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
  __touchingWallColliders: Collider['handle'][];
  __touchingGroundColliders: Collider['handle'][];
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
    rotate: (direction: 'LEFT' | 'RIGHT') => void;
    move: (direction: 'FORWARD' | 'BACKWARD') => void;
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

export const createDynamicCharacter = (opts: {
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
  const controlFns = {
    rotate: (direction: 'LEFT' | 'RIGHT') => {
      if (characterData.isTumbling) return;
      const dir = direction === 'LEFT' ? 1 : -1;
      const speed = characterData._rotateSpeed || 2;
      const physDelta = getPhysicsState().timestepRatio; // This runs in the acc phys loop, so we can use the fixed timestep here.
      const rotationAmount = speed * physDelta * dir;
      charMesh.rotateY(rotationAmount);
      characterData.charRotation = eulerForCharRotation.setFromQuaternion(
        charMesh.quaternion,
        'XZY'
      ).y;
      characterPhysObj?.rigidBody?.setRotation(charMesh.quaternion, true);
    },
    move: (direction: 'FORWARD' | 'BACKWARD') => {
      if (characterData.isTumbling) return;
      const rigidBody = characterPhysObj?.rigidBody;
      if (rigidBody) {
        const vel = moveVector3.set(
          characterBody.linvel().x,
          characterBody.linvel().y,
          characterBody.linvel().z
        );
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
        const veloAccu = transformAppSpeedValue(
          characterData._accumulateVeloPerInterval * inTheAirDiminisher * crouchVeloAccuMultiplier
        );
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
          // const hit = getWallHitFromRaycasts(getPhysicsWorld(), characterBody, characterData);
          const hit = getWallHitFromShapeCast(getPhysicsWorld(), characterBody);

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

        // Unwalkable slope check
        getFloorNormal(getPhysicsWorld(), characterBody, characterData);
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
            vel.x += slopeSlideDir.x * slideSpeed * 0.016;
            vel.z += slopeSlideDir.z * slideSpeed * 0.016;
          }

          // 4. Allow Gravity to do its job
          // If we are on an unwalkable slope, we are technically "falling" or "sliding".
          // Ensure we aren't applying any upward Y velocity (jumping) unless desired.
        }

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
        const physObj = characterPhysObj;
        physObj?.rigidBody?.applyImpulse(jumpAmountVector3.set(0, charData._jumpAmount, 0), true);
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
      switchPhysicsCollider(id, nextIndex);
    },
  };

  const moveInputMappings = [
    ...(inputMappings?.moveForward || []),
    ...(inputMappings?.moveBackward || []),
  ];

  const dynamicCharacterObject = createCharacter({
    id,
    physicsParams: [
      {
        // Main character collider (walk / run) [INDEX: 0]
        collider: {
          type: 'CAPSULE',
          halfHeight: characterData._height / 5,
          // friction: 0.7,
          // frictionCombineRule: 'MULTIPLY',
        },
        rigidBody: {
          rigidType: 'DYNAMIC',
          lockRotations: { x: true, y: true, z: true },
          linearDamping: 0,
        },
      },
      {
        // Crouch collider [INDEX: 1]
        collider: {
          type: 'CAPSULE',
          friction: 0.9,
          halfHeight: characterData._height / 10,
          translation: {
            x: charMesh.position.x,
            y: charMesh.position.y - characterData._height / 10,
            z: charMesh.position.z,
          },
        },
      },
      {
        // Wall sensor [INDEX: 2]
        collider: {
          type: 'CAPSULE',
          halfHeight: characterData._height / 5.5,
          radius: characterData._radius * (characterData._skinThickness + 1),
          isSensor: true,
          density: 0,
          translation: { x: 0, y: 0.05, z: 0 },
          collisionEventFn: (coll1, coll2, started, obj1, obj2) => {
            if (started) {
              let physObj: PhysicsObject;
              if (obj1.id === id) {
                if (coll1.handle !== wallSensorHandle) return;
                // obj1 is the character
                physObj = obj1;
                const bodyType = coll2.parent()?.bodyType();
                if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
                  characterData.__touchingWallColliders.push(coll2.handle);
                }
              } else {
                if (coll2.handle !== wallSensorHandle) return;
                // obj2 is the character
                physObj = obj2;
                const bodyType = coll1.parent()?.bodyType();
                if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
                  characterData.__touchingWallColliders.push(coll1.handle);
                }
              }
              characterData.isNearWall = true;
              if (characterData.relVelocity.length > characterData._tumblingWallSpeedThreshold) {
                startCharacterTumbling(characterData, physObj);
              }
              return;
            }
            if (obj1.id === id) {
              if (coll1.handle !== wallSensorHandle) return;
              characterData.__touchingWallColliders =
                characterData.__touchingWallColliders.filter((handle) => handle !== coll2.handle) ||
                [];
            } else {
              if (coll2.handle !== wallSensorHandle) return;
              characterData.__touchingWallColliders =
                characterData.__touchingWallColliders.filter((handle) => handle !== coll1.handle) ||
                [];
            }
            if (!characterData.__touchingWallColliders.length) characterData.isNearWall = false;
          },
        },
      },
      {
        // Floor sensor [INDEX: 3]
        collider: {
          type: 'BALL',
          radius: characterData._radius * characterData._groundDetectorRadius,
          isSensor: true,
          density: 0,
          translation: {
            x: 0,
            y: -characterData._height / 2 + characterData._groundDetectorOffset,
            z: 0,
          },
          collisionEventFn: (coll1, coll2, started, obj1) => {
            // 1. Identify "The Other Collider" immediately
            // We don't need to create temp variables or complex logic checks repeatedly.
            const isObj1 = obj1.id === id;
            const myHandle = isObj1 ? coll1.handle : coll2.handle;
            const otherCollider = isObj1 ? coll2 : coll1;

            // Security check: ensure we are processing the correct sensor
            if (myHandle !== groundSensorHandle) return;

            // 2. Get UserData ONCE (Expensive WASM call protection)
            // Accessing parent() is a bridge call. Do it once.
            const parentBody = otherCollider.parent();
            const userData = parentBody?.userData as
              | {
                  isStairs?: boolean;
                  stairsColliderIndex?: number | number[]; // Support array or number
                  isMovingPlatform?: boolean;
                }
              | undefined;

            if (started) {
              // --- STARTED TOUCHING ---
              characterData.__touchingGroundColliders.push(otherCollider.handle);
              characterData.isGrounded = true;

              const physObj = getPhysicsObject(dynamicCharacterObject.physObjectId);

              // Tumble Check
              if (
                characterData.relVelocity.length > characterData._tumblingGroundSpeedThreshold &&
                !characterData.__lastIsGroundedState
              ) {
                startCharacterTumbling(characterData, physObj);
                return;
              }

              // Keep Moving / Landing Logic
              if (
                characterData._keepMovingAfterJumpThreshold <
                  (physObj?.rigidBody?.linvel().y || -5) &&
                !characterData.isFalling &&
                !characterData.__lastIsGroundedState &&
                characterData.hasMoveInput
              ) {
                physObj?.rigidBody?.setLinvel(
                  justLandedVector3.set(
                    physObj?.rigidBody.linvel().x,
                    0,
                    physObj?.rigidBody.linvel().z
                  ),
                  true
                );
              }
              characterData.__lastIsGroundedState = characterData.isGrounded;

              // --- OPTIMIZED STAIRS CHECK ---
              // No need to get collider(i) again. We check the index vs handle if needed,
              // or just trust the boolean if the whole object is stairs.
              if (userData?.isStairs) {
                // If checking specific indices is strictly required:
                // (This is rare, usually the whole mesh is stairs)
                // logic to check handle vs index...
                characterData.isOnStairs = true;
              }

              // --- OPTIMIZED PLATFORM CHECK ---
              // If the parent says "I am a moving platform", then 'otherCollider' (its child) IS the platform.
              // No loop required.
              if (userData?.isMovingPlatform) {
                characterData.isOnMovingPlatform = true;
              }
            } else {
              // --- STOPPED TOUCHING (THE JUMP OPTIMIZATION) ---

              // 1. In-Place Removal (No GC, No new Array)
              const index = characterData.__touchingGroundColliders.indexOf(otherCollider.handle);
              if (index !== -1) {
                characterData.__touchingGroundColliders.splice(index, 1);
              }

              if (characterData.__touchingGroundColliders.length === 0) {
                characterData.isGrounded = false;
              }

              characterData.__lastIsGroundedState = characterData.isGrounded;

              // Optimized Boolean Logic (No Loops)
              if (userData?.isStairs) {
                // You might need a check here: "Am I touching ANY OTHER stairs?"
                // If not, set false. For now, simple toggle:
                characterData.isOnStairs = false;
              }

              if (userData?.isMovingPlatform) {
                // Same logic: "Am I touching ANY OTHER platform?"
                // Assuming character only touches one platform at a time usually:
                characterData.isOnMovingPlatform = false;
              }
            }
          },
        },
      },
    ],
    data: characterData,
    meshOrMeshId: charMesh,
    controls: inputMappings
      ? [
          {
            id: 'charMove',
            key: [
              ...inputMappings.rotateLeft,
              ...inputMappings.rotateRight,
              ...inputMappings.moveForward,
              ...inputMappings.moveBackward,
            ],
            type: 'KEY_LOOP_ACTION',
            fn: (_, __, data) => {
              const keysPressed = data?.keysPressed as string[];
              const mesh = data?.mesh as THREE.Mesh;
              const charObj = data?.charObject as CharacterObject;
              const charData = charObj.data as CharacterData;

              if (!mesh || !charData) return;

              // Turn left (only mesh rotation, not physical object)
              if (keysPressed.some((key) => inputMappings.rotateLeft.includes(key)))
                controlFns.rotate('LEFT');
              // Turn right (only mesh rotation, not physical object)
              if (keysPressed.some((key) => inputMappings.rotateRight.includes(key)))
                controlFns.rotate('RIGHT');
              // Forward and backward
              if (keysPressed.some((key) => moveInputMappings.includes(key))) {
                charData.hasMoveInput = true;
                // Set small y force to character for smoother moving if hasMoveInput
                controlFns.move(
                  keysPressed.some((key) => inputMappings.moveForward.includes(key))
                    ? 'FORWARD'
                    : 'BACKWARD'
                );
              }
            },
          },
          {
            id: 'charStopMoveAndRotate',
            key: [...inputMappings.moveForward, ...inputMappings.moveBackward],
            type: 'KEY_UP',
            fn: (e) => {
              e.preventDefault();
              characterData.hasMoveInput = false;
            },
          },
          {
            id: 'charJump',
            key: inputMappings.jump,
            type: 'KEY_DOWN',
            fn: (e) => {
              e.preventDefault();
              if (e.repeat) return;
              controlFns.jump();
            },
          },
          {
            id: 'charRun',
            key: inputMappings.run,
            type: 'KEY_DOWN',
            fn: (e) => {
              e.preventDefault();
              if (e.repeat) return;
              controlFns.run();
            },
          },
          {
            id: 'charCrouch',
            key: inputMappings.crouch,
            type: 'KEY_DOWN',
            fn: (e) => {
              e.preventDefault();
              if (e.repeat) return;
              controlFns.crouch();
            },
          },
        ]
      : undefined,
  });
  const characterPhysObj = getPhysicsObject(dynamicCharacterObject.physObjectId);
  const wallSensorHandle = characterPhysObj?.rigidBody?.collider(2).handle;
  const groundSensorHandle = characterPhysObj?.rigidBody?.collider(3).handle;

  const usableVec = new THREE.Vector3();
  const getUpQuat = new THREE.Quaternion();
  const getUpVector3 = new THREE.Vector3();
  const getUpBodyUpVector3 = new THREE.Vector3();
  const getUpAngVelVector3 = new THREE.Vector3();
  const getUpYawEuler = new THREE.Euler();
  const getUpUprightQuat = new THREE.Quaternion();
  const getUpUprightEuler = new THREE.Euler();
  addScenePhysicsLooper(`characterLooper-${id}`, () => {
    const physObj = getPhysicsObject(dynamicCharacterObject?.physObjectId || '');
    const mesh = physObj?.mesh;
    const body = physObj?.rigidBody;
    if (!mesh || !body) return;

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
    } else if (characterData.isTumbling && physObj.rigidBody) {
      // Clamp angular velocity when tumbling
      const w = physObj.rigidBody.angvel();
      const maxAngVel = characterData._tumblingMaxAngVelo;

      const len = Math.hypot(w.x, w.y, w.z);
      if (len > maxAngVel) {
        const scale = maxAngVel / len;
        physObj.rigidBody.setAngvel({ x: w.x * scale, y: w.y * scale, z: w.z * scale }, true);
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
        // fade-out
        // const ease = 1 - Math.min(Math.max(ratio, 0), 1);
        // ease-in-out
        // const ease =
        //   ratio < 0.5 ? 4 * ratio * ratio * ratio : 1 - Math.pow(-2 * ratio + 2, 3) / 2;
        // ease-out
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
        stopCharacterTumbling(characterData, physObj);
      }
    }

    // Set isAwake (physics isMoving, aka. is awake)
    characterData.isAwake = physObj.rigidBody?.isMoving() || false;

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
    const velo = usableVec.set(
      roundToDecimal(
        physObj.rigidBody?.linvel().x || 0,
        characterData._roundVelocitiesScalingFactor
      ),
      roundToDecimal(
        physObj.rigidBody?.linvel().y || 0,
        characterData._roundVelocitiesScalingFactor
      ),
      roundToDecimal(
        physObj.rigidBody?.linvel().z || 0,
        characterData._roundVelocitiesScalingFactor
      )
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
    const angVelo = usableVec.set(
      physObj.rigidBody?.angvel().x || 0,
      physObj.rigidBody?.angvel().y || 0,
      physObj.rigidBody?.angvel().z || 0
    );
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
        const collider = getPhysicsWorld().colliders.get(
          characterData.__touchingGroundColliders[i]
        );
        if (!collider) continue;
        const pb = collider.parent();
        if (!pb) continue;

        const ud = pb.userData as {
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

          // 4. ROTATION (Visuals)
          if (Math.abs(angVelo.y) > 0.001) {
            const rotationAmount = angVelo.y * getPhysicsState().timestepRatio;
            charMesh.rotateY(rotationAmount);
            characterData.charRotation = eulerForCharRotation.setFromQuaternion(
              charMesh.quaternion,
              'XZY'
            ).y;

            // Optional: Sync physics body rotation if you want (doesn't affect slinging)
            // body.setRotation(charMesh.quaternion, true);
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
    characterData.position = physObj.rigidBody?.translation() || { x: 0, y: 0, z: 0 };
  });

  const characterBody = existsOrThrow(
    getPhysicsObject(dynamicCharacterObject.physObjectId)?.rigidBody,
    `Could not find character physics object rigid body with id: '${dynamicCharacterObject.physObjectId}'.`
  );

  character.charMesh = charMesh;
  character.dynamicCharacterObject = dynamicCharacterObject;
  character.controlFns = controlFns;

  characters[id] = character as DynamicCharacter;

  return characters[id];
};

// MODULE-LEVEL CACHES for getWallHitFromShapeCast (Singletons)
// These persist between frames so we don't recreate them.
let _cachedShape: RAPIER.Cylinder | null = null;
let _lastShapeHeight = 0;
let _lastShapeRadius = 0;
const _moveDir = new THREE.Vector3();
const _returnNormalVector = new THREE.Vector3();

// Reusable Vectors to prevent GC
const _castPos = { x: 0, y: 0, z: 0 }; // Raw object for Rapier
const _castDir = { x: 0, y: 0, z: 0 };
const _castRot = { w: 1, x: 0, y: 0, z: 0 }; // Identity quaternion

export const getWallHitFromShapeCast = (
  world: RAPIER.World,
  characterBody: RAPIER.RigidBody
): { normal: THREE.Vector3; distance: number } | null => {
  const vel = characterBody.linvel();
  // 1. Calculate Base Direction (Velocity based)
  _moveDir.set(vel.x, 0, vel.z);
  // Optimization: If standing still, wall sliding is irrelevant.
  // Return null to prevent jitter/sticking while idle.
  if (_moveDir.lengthSq() < 0.001) return null;
  _moveDir.normalize();

  // Fill cached object instead of 'new Vector3'
  // (We assume inputDir is already normalized, but to be safe we clone/norm if needed outside)
  _castDir.x = _moveDir.x;
  _castDir.y = 0; // Force horizontal
  _castDir.z = _moveDir.z;

  // 2. Get Collider Dimensions
  const collider = characterBody.collider(0) || characterBody.collider(1);
  const capsule = collider.shape as RAPIER.Capsule;

  const targetHeight = capsule.halfHeight * 0.9;
  const targetRadius = capsule.radius * 1.05;

  // 3. Manage Cached Shape
  // Only recreate the shape if dimensions changed (e.g. crouching)
  if (!_cachedShape || _lastShapeHeight !== targetHeight || _lastShapeRadius !== targetRadius) {
    // If a shape existed, we rely on Rapier's GC or explicit free if needed.
    // JS bindings usually garbage collect simple shapes automatically.
    _cachedShape = new RAPIER.Cylinder(targetHeight, targetRadius);
    _lastShapeHeight = targetHeight;
    _lastShapeRadius = targetRadius;
  }

  // 4. Setup Position (Fill cached object)
  const bodyPos = characterBody.translation();
  _castPos.x = bodyPos.x;
  _castPos.y = bodyPos.y + 0.1; // Lift slightly
  _castPos.z = bodyPos.z;

  const maxToi = 0.2;
  const targetDistance = 0.0;

  // 5. CAST
  const hit = world.castShape(
    _castPos,
    _castRot,
    _castDir,
    _cachedShape!, // Use cached shape
    targetDistance,
    maxToi,
    true, // Stop at Penetration
    undefined,
    undefined,
    undefined,
    characterBody // Exclude Self
  );

  if (hit) {
    const n = hit.normal1;

    // Filter Logic
    if (Math.abs(n.y) > 0.7) return null;
    if (hit.collider.isSensor()) return null;

    // Return a clean object.
    return {
      normal: _returnNormalVector.set(n.x, n.y, n.z),
      distance: hit.time_of_impact, // Use snake_case
    };
  }

  return null;
};

// Module level ray cache for getFloorNormal
// This way we only need to define the ray.origin, direction is always the same
const _floorNormalRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

const getFloorNormal = (
  world: RAPIER.World,
  characterBody: RAPIER.RigidBody,
  characterData: CharacterData
) => {
  let collider = characterBody.collider(0);
  if (!collider?.isEnabled()) {
    collider = characterBody.collider(1);
  }
  const capsuleRadius = (collider.shape as RAPIER.Capsule).radius;
  const capsuleHeight = (collider.shape as RAPIER.Capsule).halfHeight * 2 + capsuleRadius * 2;

  const maxToi = capsuleHeight * 2;
  // const ray = new RAPIER.Ray(characterBody.translation(), { x: 0, y: -1, z: 0 });
  _floorNormalRay.origin = characterBody.translation();
  const hit = world.castRayAndGetNormal(
    _floorNormalRay,
    maxToi,
    false,
    undefined,
    undefined,
    undefined,
    characterBody
  );

  const groundNormal = hit?.normal || { x: 0, y: 1, z: 0 };
  characterData.groundNormal = { x: groundNormal.x, y: groundNormal.y, z: groundNormal.z };
  const groundDot = vectors.groundDot
    .set(groundNormal.x, groundNormal.y, groundNormal.z)
    .dot(LEVEL_GROUND_NORMAL);

  // Set groundIsWalkable
  characterData.groundIsWalkable = true;
  if (hit) {
    if (groundDot <= characterData.__maxWalkableAngleCos) {
      characterData.groundIsWalkable = false;
    }
  }
};

const _tumbleStartImpulseVector3 = new THREE.Vector3();
const startCharacterTumbling = (characterData: CharacterData, physObj?: PhysicsObject) => {
  characterData.isGettingUp = false;
  characterData.isTumbling = true;
  characterData.__isTumblingStartTime = getPhysGameTime();
  characterData.__charAngDamping = physObj?.rigidBody?.angularDamping() || 0;
  physObj?.rigidBody?.setAngularDamping(2.5);
  physObj?.rigidBody?.lockRotations(false, true);
  physObj?.rigidBody?.setEnabledRotations(true, true, true, true);
  const rando1 = Math.random() > 0.5 ? 1 : -1;
  const rando2 = Math.random() > 0.5 ? 1 : -1;
  physObj?.rigidBody?.applyImpulse(
    _tumbleStartImpulseVector3.set(Math.random() * rando1, 0, Math.random() * rando2),
    true
  );
  (physObj?.rigidBody?.userData as { [key: string]: unknown }).lockRotationsX = false;
  (physObj?.rigidBody?.userData as { [key: string]: unknown }).lockRotationsY = false;
  (physObj?.rigidBody?.userData as { [key: string]: unknown }).lockRotationsZ = false;
};

const tumbleStopRotationVector4 = new THREE.Vector4();
const tumbleStopRotationQuat = new THREE.Quaternion(0, 0, 0, 1);
const stopCharacterTumbling = (characterData: CharacterData, physObj?: PhysicsObject) => {
  const body = physObj?.rigidBody;
  if (body) {
    (body.userData as { [key: string]: unknown }).lockRotationsX = true;
    (body.userData as { [key: string]: unknown }).lockRotationsY = true;
    (body.userData as { [key: string]: unknown }).lockRotationsZ = true;
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngularDamping(0);
    body.setEnabledRotations(false, false, false, true);
    body.lockRotations(true, true);
    body.setRotation(tumbleStopRotationVector4.set(0, 0, 0, 1), true);
    body.setAngularDamping(characterData.__charAngDamping);
    if (physObj.meshes) {
      const mesh = physObj.meshes[physObj.currentMeshIndex || 0];
      if (mesh) {
        characterData.charRotation = eulerForCharRotation.setFromQuaternion(
          mesh.quaternion,
          'XZY'
        ).y;
        mesh.setRotationFromQuaternion(tumbleStopRotationQuat);
        mesh.rotation.y = characterData.charRotation;
      }
    } else {
      const mesh = physObj.mesh;
      if (mesh) {
        characterData.charRotation = eulerForCharRotation.setFromQuaternion(
          mesh.quaternion,
          'XZY'
        ).y;
        mesh.setRotationFromQuaternion(tumbleStopRotationQuat);
        mesh.rotation.y = characterData.charRotation;
      }
    }
  }
  characterData.__charAngDamping = 0;
  characterData.isTumbling = false;
  characterData.__isTumblingStartTime = 0;
  characterData.isGettingUp = false;
  characterData.__isGettingUpStartTime = 0;
};
