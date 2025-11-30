import * as THREE from 'three/webgpu';
import { createGeometry } from '../../core/Geometry';
import { createMaterial } from '../../core/Material';
import { loadTexture } from '../../core/Texture';
import { createMesh } from '../../core/Mesh';
import { createCamera, deleteCamera } from '../../core/Camera';
import { CharacterObject, createCharacter, registerOnDeleteCharacter } from '../../core/Character';
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
import { getRootScene } from '../../core/Scene';
import { castRayFromPoints } from '../../core/Raycast';
import RAPIER, { type Collider } from '@dimforge/rapier3d-compat';
import { existsOrThrow, roundToDecimal } from '../helpers';
import { LEVEL_GROUND_NORMAL } from '../constants';

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
// @TODO: remove this and add camera functionality from outside the creation of the character
let thirdPersonCamera: THREE.PerspectiveCamera | null = null;

const characters: { [id: string]: DynamicCharacter } = {};

export const createDynamicCharacter = (opts: {
  id: string;
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
  const { id, charData, inputMappings } = opts;

  // Combine character data
  const characterData = { ...getDefaultCharacterData(), ...charData };
  const character: Partial<DynamicCharacter> = { charData: characterData };

  // Set __maxWalkableAngleCos
  characterData.__maxWalkableAngleCos = Math.cos(characterData._maxWalkableAngle);

  // Create third person camera
  // @TODO: remove this and add camera functionality from outside the creation of the character
  thirdPersonCamera = createCamera(`thirdPersonCam-${id}`, {
    name: '3rd Person Cam',
    isCurrentCamera: true,
    fov: 80,
    near: 0.5,
    far: 1000,
  });

  // @TODO: add the mesh as a parameter
  const charCapsule = createGeometry({
    id: `capsuleDynamicChar-${id}`,
    type: 'CAPSULE',
    params: {
      radius: characterData._radius,
      height: characterData._height - characterData._radius * 2,
    },
  });
  const charMaterial = createMaterial({
    id: `box1MaterialDynamicChar-${id}`,
    type: 'PHONG',
    params: {
      map: loadTexture({
        id: 'box1Texture',
        fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
      }),
    },
  });
  const charMesh = createMesh({
    id: `meshDynamicChar-${id}`,
    geo: charCapsule,
    mat: charMaterial,
  });
  charMesh.position.set(0, 0, 0);
  charMesh.rotation.set(0, 0, 0);
  // @TODO: remove this and add camera functionality from outside the creation of the character
  thirdPersonCamera.position.set(
    charMesh.position.x - 8,
    charMesh.position.y + 5,
    charMesh.position.z
  );
  // @TODO: remove this and add camera functionality from outside the creation of the character
  thirdPersonCamera.rotation.set(0, 0, 0);
  // @TODO: remove this and add camera functionality from outside the creation of the character
  thirdPersonCamera.lookAt(charMesh.position.x, charMesh.position.y + 2, charMesh.position.z);
  // @TODO: remove this and add camera functionality from outside the creation of the character
  charMesh.add(thirdPersonCamera);

  // @TODO: add the mesh as parameter
  const directionBeakMesh = createMesh({
    id: `directionBeakMeshDynamicChar-${id}`,
    geo: createGeometry({
      id: 'directionBeakGeoDynamicChar',
      type: 'BOX',
      params: { width: 0.25, height: 0.25, depth: 0.7 },
    }),
    mat: createMaterial({
      id: 'directionBeakMatDynamicChar',
      type: 'BASIC',
      params: { color: '#333' },
    }),
  });
  directionBeakMesh.position.set(0.35, 0.43, 0);
  charMesh.add(directionBeakMesh);

  const controlFns = {
    rotate: (direction: 'LEFT' | 'RIGHT') => {
      if (characterData.isTumbling) return;
      const dir = direction === 'LEFT' ? 1 : -1;
      const rotateSpeed = transformAppSpeedValue(characterData._rotateSpeed || 2) * dir;
      charMesh.rotateY(rotateSpeed);
      characterData.charRotation = eulerForCharRotation.setFromQuaternion(
        charMesh.quaternion,
        'XZY'
      ).y;
    },
    move: (direction: 'FORWARD' | 'BACKWARD') => {
      if (characterData.isTumbling) return;
      const rigidBody = characterPhysObj?.rigidBody;
      if (rigidBody) {
        const vel = new THREE.Vector3(
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

        // @TODO: remove the commented lines after the relVelocity on moving platform has been tested enough and is working
        // const curLinvelX = rigidBody.linvel()?.x || 0;
        // const curLinvelZ = rigidBody.linvel()?.z || 0;
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
          const hit = getWallHitFromRaycasts(getPhysicsWorld(), characterBody, characterData);
          const bodyType = hit?.collider.parent()?.bodyType();
          if (hit && bodyType !== RAPIER.RigidBodyType.Dynamic) {
            const v = characterBody.linvel();
            let n = hit.normal;
            let dot = v.x * n.x + v.y * n.y + v.z * n.z;
            if (dot > 0) {
              // Flip normal so it's always wall → player
              n = { x: -n.x, y: -n.y, z: -n.z };
              dot = v.x * n.x + v.y * n.y + v.z * n.z;
            }
            // Only cancel the velocity if moving INTO the wall
            if (dot < 0) {
              vel.set(v.x - dot * n.x, v.y - dot * n.y, v.z - dot * n.z);
            }
          }
        }

        // Unwalkable slope check (and possible cancelation)
        if (!characterData.groundIsWalkable) {
          // 1. Normal
          const n = new THREE.Vector3(
            characterData.groundNormal.x,
            characterData.groundNormal.y,
            characterData.groundNormal.z
          ).normalize();

          const gravity = new THREE.Vector3(0, -1, 0);

          // 2. Correct downhill direction = gravity projected onto surface
          const downhill = gravity
            .clone()
            .sub(n.clone().multiplyScalar(gravity.dot(n)))
            .normalize();

          // 3. Movement direction from input (NOT velocity!)
          const moveDir = new THREE.Vector3(xVelo > 0 ? 1 : -1, 0, zVelo > 0 ? 1 : -1).normalize();
          const uphillDot = moveDir.dot(downhill);
          const movingDownHill = uphillDot > 0;

          const downhill2 = gravity.clone().projectOnPlane(n).normalize();
          const charVel = new THREE.Vector3(
            rigidBody.linvel().x,
            rigidBody.linvel().y,
            rigidBody.linvel().z
          );
          const horiz = charVel.clone().projectOnPlane(n);
          const horizDir = horiz.clone().normalize();
          const dot = horizDir.dot(downhill2);
          const isSideways = dot < 0.643 && dot > -0.342; // between 50 and 110 degrees

          vel.set(characterBody.linvel().x, characterBody.linvel().y, characterBody.linvel().z);
          if (!isSideways && movingDownHill) {
            vel.set(xAddition, rigidBody.linvel().y, zAddition);
          }
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
        physObj?.rigidBody?.applyImpulse(new THREE.Vector3(0, charData._jumpAmount, 0), true);
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
        // Main character collider (walk / run)
        collider: {
          type: 'CAPSULE',
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
        // Crouch collider
        collider: {
          type: 'CAPSULE',
          friction: 0.9,
          halfHeight: charCapsule.userData.props?.params.height / 4,
          translation: {
            x: charMesh.position.x,
            y: charMesh.position.y - charCapsule.userData.props?.params.height / 4,
            z: charMesh.position.z,
          },
        },
      },
      {
        // Wall sensor
        collider: {
          type: 'CAPSULE',
          halfHeight:
            (charCapsule.userData.props?.params.height / 2.5) * (characterData._skinThickness + 1),
          radius: charCapsule.userData.props?.params.radius * (characterData._skinThickness + 1),
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
        // Floor sensor
        collider: {
          type: 'BALL',
          radius: charCapsule.userData.props?.params.radius * characterData._groundDetectorRadius,
          isSensor: true,
          density: 0,
          translation: {
            x: 0,
            y: -characterData._height / 2 + characterData._groundDetectorOffset,
            z: 0,
          },
          collisionEventFn: (coll1, coll2, started, obj1) => {
            let curCollider = null;
            if (started) {
              if (obj1.id === id) {
                if (coll1.handle !== groundSensorHandle) return;
                // obj1 is the character
                // isGrounded check:
                characterData.__touchingGroundColliders.push(coll2.handle);
                curCollider = coll2;
              } else {
                if (coll2.handle !== groundSensorHandle) return;
                // obj2 is the character
                // isGrounded check:
                characterData.__touchingGroundColliders.push(coll1.handle);
                curCollider = coll1;
              }
              characterData.isGrounded = true;
              getFloorNormal(getPhysicsWorld(), characterBody, characterData);

              const physObj = getPhysicsObject(dynamicCharacterObject.physObjectId);

              // Check if speed too fast to land, then tumble
              if (
                characterData.relVelocity.length > characterData._tumblingGroundSpeedThreshold &&
                !characterData.__lastIsGroundedState
              ) {
                startCharacterTumbling(characterData, physObj);
                return;
              }

              if (
                characterData._keepMovingAfterJumpThreshold <
                  (physObj?.rigidBody?.linvel().y || -5) &&
                !characterData.isFalling &&
                !characterData.__lastIsGroundedState &&
                characterData.hasMoveInput
              ) {
                // Just landed, then apply Y linvel to the rigidBody
                physObj?.rigidBody?.setLinvel(
                  new THREE.Vector3(
                    physObj?.rigidBody.linvel().x,
                    0,
                    physObj?.rigidBody.linvel().z
                  ),
                  true
                );
              }
              characterData.__lastIsGroundedState = characterData.isGrounded;

              // isOnStairs check:
              const userData = curCollider.parent()?.userData as {
                isStairs?: boolean;
                stairsColliderIndex?: number;
                isMovingPlatform?: boolean;
              };
              if (userData.isStairs && userData.stairsColliderIndex !== undefined) {
                if (Array.isArray(userData.stairsColliderIndex)) {
                  for (let i = 0; i < userData.stairsColliderIndex.length; i++) {
                    const targetCollider = curCollider
                      .parent()
                      ?.collider(userData.stairsColliderIndex[i]);
                    if (targetCollider && targetCollider.handle === curCollider.handle) {
                      characterData.isOnStairs = true;
                    }
                  }
                } else {
                  const targetCollider = curCollider
                    .parent()
                    ?.collider(userData.stairsColliderIndex);
                  if (targetCollider && targetCollider.handle === curCollider.handle) {
                    characterData.isOnStairs = true;
                  }
                }
              }

              // isOnMovingPlatform check:
              if (userData.isMovingPlatform) {
                const numColliders = curCollider.parent()?.numColliders() || 0;
                for (let i = 0; i < numColliders; i++) {
                  const targetCollider = curCollider.parent()?.collider(i);
                  if (targetCollider && targetCollider.handle === curCollider.handle) {
                    characterData.isOnMovingPlatform = true;
                  }
                }
              }
              return;
            }
            // isGrounded check:
            if (obj1.id === id) {
              if (coll1.handle !== groundSensorHandle) return;
              characterData.__touchingGroundColliders =
                characterData.__touchingGroundColliders.filter((handle) => handle !== coll2.handle);
              curCollider = coll2;
            } else {
              if (coll2.handle !== groundSensorHandle) return;
              characterData.__touchingGroundColliders =
                characterData.__touchingGroundColliders.filter((handle) => handle !== coll1.handle);
              curCollider = coll1;
            }
            if (!characterData.__touchingGroundColliders.length) characterData.isGrounded = false;
            if (characterData.isGrounded) {
              getFloorNormal(getPhysicsWorld(), characterBody, characterData);
            }

            characterData.__lastIsGroundedState = characterData.isGrounded;

            // isOnStairs check:
            const userData = curCollider.parent()?.userData as {
              isStairs?: boolean;
              stairsColliderIndex?: number;
              isMovingPlatform?: boolean;
            };
            if (userData.isStairs && userData.stairsColliderIndex !== undefined) {
              if (Array.isArray(userData.stairsColliderIndex)) {
                for (let i = 0; i < userData.stairsColliderIndex.length; i++) {
                  const targetCollider = curCollider
                    .parent()
                    ?.collider(userData.stairsColliderIndex[i]);
                  if (targetCollider && targetCollider.handle === curCollider.handle) {
                    characterData.isOnStairs = false;
                  }
                }
              } else {
                const targetCollider = curCollider.parent()?.collider(userData.stairsColliderIndex);
                if (targetCollider && targetCollider.handle === curCollider.handle) {
                  characterData.isOnStairs = false;
                }
              }
            }

            // isOnMovingPlatform check:
            if (userData.isMovingPlatform) {
              const numColliders = curCollider.parent()?.numColliders() || 0;
              for (let i = 0; i < numColliders; i++) {
                const targetCollider = curCollider.parent()?.collider(i);
                if (targetCollider && targetCollider.handle === curCollider.handle) {
                  characterData.isOnMovingPlatform = false;
                }
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

  // Ground detection with rays (backup 'isGrounded' check)
  const groundRaycaster = new THREE.Raycaster();
  groundRaycaster.near = 0.01;
  groundRaycaster.far = 10;
  const usableVec = new THREE.Vector3();
  const groundRaycastVecDir = new THREE.Vector3(0, -1, 0).normalize();
  const charHalfRadius = characterData._radius / 2;
  const detectGround = () => {
    characterData.isGrounded = false;
    const rigidBodyTranslation = characterPhysObj?.rigidBody?.translation();

    // First ray from the middle of the character
    castRayFromPoints<THREE.Mesh>(
      getRootScene()?.children || [],
      usableVec.set(
        rigidBodyTranslation?.x || charMesh.position.x,
        rigidBodyTranslation?.y || charMesh.position.y,
        rigidBodyTranslation?.z || charMesh.position.z
      ),
      groundRaycastVecDir,
      {
        helperId: 'middleGroundDetector',
        startLength: characterData._height / 3,
        endLength: characterData._groundedRayMaxDistance,
        perIntersectFn: (intersect) => {
          if (intersect.object.userData.isPhysicsObject) {
            characterData.isGrounded = true;
            return true;
          }
        },
      }
    );
    if (characterData.isGrounded) return;

    // Four rays from the edges of the character
    castRayFromPoints<THREE.Mesh>(
      getRootScene()?.children || [],
      usableVec
        .set(
          rigidBodyTranslation?.x || charMesh.position.x,
          rigidBodyTranslation?.y || charMesh.position.y,
          rigidBodyTranslation?.z || charMesh.position.z
        )
        .sub({ x: charHalfRadius, y: 0, z: 0 }),
      groundRaycastVecDir,
      {
        helperId: 'off1GroundDetector',
        startLength: characterData._height / 3,
        endLength: characterData._groundedRayMaxDistance,
        perIntersectFn: (intersect) => {
          if (intersect.object.userData.isPhysicsObject) {
            characterData.isGrounded = true;
            return true;
          }
        },
      }
    );
    if (characterData.isGrounded) return;
    castRayFromPoints<THREE.Mesh>(
      getRootScene()?.children || [],
      usableVec
        .set(
          rigidBodyTranslation?.x || charMesh.position.x,
          rigidBodyTranslation?.y || charMesh.position.y,
          rigidBodyTranslation?.z || charMesh.position.z
        )
        .sub({ x: -charHalfRadius, y: 0, z: 0 }),
      groundRaycastVecDir,
      {
        helperId: 'off2GroundDetector',
        startLength: characterData._height / 3,
        endLength: characterData._groundedRayMaxDistance,
        perIntersectFn: (intersect) => {
          if (intersect.object.userData.isPhysicsObject) {
            characterData.isGrounded = true;
            return true;
          }
        },
      }
    );
    if (characterData.isGrounded) return;
    castRayFromPoints<THREE.Mesh>(
      getRootScene()?.children || [],
      usableVec
        .set(
          rigidBodyTranslation?.x || charMesh.position.x,
          rigidBodyTranslation?.y || charMesh.position.y,
          rigidBodyTranslation?.z || charMesh.position.z
        )
        .sub({ x: 0, y: 0, z: charHalfRadius }),
      groundRaycastVecDir,
      {
        helperId: 'off3GroundDetector',
        startLength: characterData._height / 3,
        endLength: characterData._groundedRayMaxDistance,
        perIntersectFn: (intersect) => {
          if (intersect.object.userData.isPhysicsObject) {
            characterData.isGrounded = true;
            return true;
          }
        },
      }
    );
    if (characterData.isGrounded) return;
    castRayFromPoints<THREE.Mesh>(
      getRootScene()?.children || [],
      usableVec
        .set(
          rigidBodyTranslation?.x || charMesh.position.x,
          rigidBodyTranslation?.y || charMesh.position.y,
          rigidBodyTranslation?.z || charMesh.position.z
        )
        .sub({ x: 0, y: 0, z: -charHalfRadius }),
      groundRaycastVecDir,
      {
        helperId: 'off4GroundDetector',
        startLength: characterData._height / 3,
        endLength: characterData._groundedRayMaxDistance,
        perIntersectFn: (intersect) => {
          if (intersect.object.userData.isPhysicsObject) {
            characterData.isGrounded = true;
            return true;
          }
        },
      }
    );
  };

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
      const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
      // Compute body's current up direction
      const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
      // Axis of rotation required to align bodyUp → worldUp
      const axis = bodyUp.clone().cross(LEVEL_GROUND_NORMAL);
      const dot = bodyUp.dot(LEVEL_GROUND_NORMAL);
      const angle = Math.acos(Math.min(Math.max(dot, -1), 1)); // clamp to valid range
      const ang = body.angvel();
      const angVel = new THREE.Vector3(ang.x, ang.y, ang.z);
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
        const yaw = new THREE.Euler().setFromQuaternion(q.clone(), 'YXZ').y;
        const uprightQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
        body.setRotation(uprightQuat, true);

        // Clear any leftover rotational velocity
        stopCharacterTumbling(characterData, physObj);
      }
    }

    // Set isAwake (physics isMoving, aka. is awake)
    characterData.isAwake = physObj.rigidBody?.isMoving() || false;

    // This is the backup 'isGrounded' check
    if (!characterData.__touchingGroundColliders.length) detectGround();

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

  charMesh.castShadow = true;
  charMesh.receiveShadow = true;

  registerOnDeleteCharacter(id, () => {
    deleteCamera(thirdPersonCamera?.userData.id);
  });

  const characterBody = existsOrThrow(
    getPhysicsObject(dynamicCharacterObject.physObjectId)?.rigidBody,
    `Could not find character physics object rigid body with id: '${dynamicCharacterObject.physObjectId}'.`
  );

  character.camera = thirdPersonCamera;
  character.charMesh = charMesh;
  character.dynamicCharacterObject = dynamicCharacterObject;
  character.controlFns = controlFns;

  characters[id] = character as DynamicCharacter;

  return characters[id];
};

const getWallHitFromRaycasts = (
  world: RAPIER.World,
  characterBody: RAPIER.RigidBody,
  characterData: CharacterData
) => {
  const vel = characterBody.linvel();
  let dir = { x: vel.x, y: 0, z: vel.z };
  const len = Math.hypot(dir.x, dir.z);

  if (len > 1e-5) {
    dir.x /= len;
    dir.z /= len;
  } else {
    dir = { x: 0, y: 0, z: 1 }; // fallback forward
  }

  let collider = characterBody.collider(0);
  if (!collider?.isEnabled()) {
    collider = characterBody.collider(1);
  }
  const capsuleRadius = (collider.shape as RAPIER.Capsule).radius;
  const capsuleHeight = (collider.shape as RAPIER.Capsule).halfHeight * 2 + capsuleRadius * 2;

  const maxToi = capsuleRadius * 4 + 0.5;

  // Center of the character
  let origin = characterBody.translation();
  let ray = new RAPIER.Ray(characterBody.translation(), dir);
  let hit = world.castRayAndGetNormal(
    ray,
    maxToi,
    true,
    undefined,
    undefined,
    undefined,
    characterBody
  );
  if (hit && characterData.__touchingWallColliders?.includes(hit.collider.handle)) {
    const bodyType = hit?.collider.parent()?.bodyType();
    if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
      return hit;
    }
  }

  // No hit, try more rays from different origin (top and bottom of the character)
  const vertOffset = capsuleHeight * 0.499;
  const horiOffset = capsuleRadius * 0.999;
  const positions = [
    { x: 0, y: -vertOffset, z: 0 },
    { x: 0, y: vertOffset, z: 0 },
    { x: -horiOffset, y: 0, z: 0 },
    { x: horiOffset, y: 0, z: 0 },
    { x: -horiOffset, y: -vertOffset, z: 0 },
    { x: horiOffset, y: -vertOffset, z: 0 },
    { x: -horiOffset, y: vertOffset, z: 0 },
    { x: horiOffset, y: vertOffset, z: 0 },
    { x: 0, y: 0, z: -horiOffset },
    { x: 0, y: 0, z: horiOffset },
    { x: 0, y: -vertOffset, z: -horiOffset },
    { x: 0, y: -vertOffset, z: horiOffset },
    { x: 0, y: vertOffset, z: -horiOffset },
    { x: 0, y: vertOffset, z: horiOffset },
    { x: -horiOffset, y: 0, z: -horiOffset },
    { x: horiOffset, y: 0, z: horiOffset },
    { x: -horiOffset, y: -vertOffset, z: -horiOffset },
    { x: horiOffset, y: -vertOffset, z: horiOffset },
    { x: -horiOffset, y: vertOffset, z: -horiOffset },
    { x: horiOffset, y: vertOffset, z: horiOffset },
  ];

  for (let i = 0; i < positions.length; i++) {
    origin = characterBody.translation();
    origin.x = origin.x + positions[i].x;
    origin.y = origin.y + positions[i].y;
    origin.z = origin.z + positions[i].z;
    ray = new RAPIER.Ray(origin, dir);
    hit = world.castRayAndGetNormal(
      ray,
      maxToi,
      true,
      undefined,
      undefined,
      undefined,
      characterBody
    );
    if (hit && characterData.__touchingWallColliders?.includes(hit.collider.handle)) {
      const bodyType = hit?.collider.parent()?.bodyType();
      if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
        return hit;
      }
    }
  }

  return;
};

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

  const maxToi = capsuleHeight / 2 + 0.5;
  const ray = new RAPIER.Ray(characterBody.translation(), { x: 0, y: -1, z: 0 });
  const hit = world.castRayAndGetNormal(
    ray,
    maxToi,
    true,
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
  if (hit && characterData.__touchingGroundColliders.includes(hit.collider.handle)) {
    if (groundDot <= characterData.__maxWalkableAngleCos) {
      characterData.groundIsWalkable = false;
    }
  }
};

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
    new THREE.Vector3(Math.random() * rando1, 0, Math.random() * rando2),
    true
  );
  (physObj?.rigidBody?.userData as { [key: string]: unknown }).lockRotationsX = false;
  (physObj?.rigidBody?.userData as { [key: string]: unknown }).lockRotationsY = false;
  (physObj?.rigidBody?.userData as { [key: string]: unknown }).lockRotationsZ = false;
};

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
    body.setRotation(new THREE.Vector4(0, 0, 0, 1), true);
    body.setAngularDamping(characterData.__charAngDamping);
    if (physObj.meshes) {
      const mesh = physObj.meshes[physObj.currentMeshIndex || 0];
      if (mesh) {
        characterData.charRotation = eulerForCharRotation.setFromQuaternion(
          mesh.quaternion,
          'XZY'
        ).y;
        mesh.setRotationFromQuaternion(new THREE.Quaternion(0, 0, 0, 1));
        mesh.rotation.y = characterData.charRotation;
      }
    } else {
      const mesh = physObj.mesh;
      if (mesh) {
        characterData.charRotation = eulerForCharRotation.setFromQuaternion(
          mesh.quaternion,
          'XZY'
        ).y;
        mesh.setRotationFromQuaternion(new THREE.Quaternion(0, 0, 0, 1));
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
