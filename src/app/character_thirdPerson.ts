import * as THREE from 'three/webgpu';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { loadTexture } from '../_engine/core/Texture';
import { createMesh } from '../_engine/core/Mesh';
import { createCamera, deleteCamera } from '../_engine/core/Camera';
import {
  CharacterObject,
  createCharacter,
  registerOnDeleteCharacter,
} from '../_engine/core/Character';
import { transformAppSpeedValue } from '../_engine/core/MainLoop';
import {
  getPhysicsObject,
  getPhysicsWorld,
  switchPhysicsCollider,
} from '../_engine/core/PhysicsRapier';
import { createSceneAppLooper, getRootScene } from '../_engine/core/Scene';
import { castRayFromPoints } from '../_engine/core/Raycast';
import RAPIER, { type Collider } from '@dimforge/rapier3d-compat';
import { existsOrThrow } from '../_engine/utils/helpers';

// @TODO: add comments for each
// If a prop has one underscore (_) then it means it is a configuration,
// if a prop has two underscores (__) then it means it is a memory slot for data (not configurable)
export type CharacterData = {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number; world: number };
  charRotation: number;
  isAwake: boolean;
  hasMoveInput: boolean;
  isGrounded: boolean;
  isFalling: boolean;
  isRunning: boolean;
  isCrouching: boolean;
  isNearWall: boolean;
  isOnStairs: boolean;
  isSliding: boolean;
  groundNormal: { x: number; y: number; z: number };
  _height: number;
  _radius: number;
  _skinThickness: number;
  _groundDetectorOffset: number;
  _groundDetectorRadius: number;
  _rotateSpeed: number;
  _maxVelocity: number;
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
  __isFallingStartTime: number;
  __lviCheckTime: number;
  __jumpTime: number;
  __lastIsGroundedState: boolean;
  __touchingWallColliders: Collider['handle'][];
  __touchingGroundColliders: Collider['handle'][];
};

export type ThirdPersonCharacter = {
  thirdPersonCharacterObject: CharacterObject;
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
  velocity: { x: 0, y: 0, z: 0, world: 0 },
  charRotation: 0,
  isAwake: false,
  hasMoveInput: false,
  isGrounded: false,
  isFalling: false,
  isRunning: false,
  isCrouching: false,
  isNearWall: false,
  isOnStairs: false,
  isSliding: false,
  groundNormal: { x: 0, y: 1, z: 0 },
  _height: 1.6,
  _radius: 0.5,
  _skinThickness: 0.05,
  _groundDetectorOffset: 0.3,
  _groundDetectorRadius: 0.8,
  _rotateSpeed: 5,
  _maxVelocity: 3.7,
  _moveYOffset: 0, // something like 0.15 makes climb steeper slopes
  _jumpAmount: 5,
  _inTheAirDiminisher: 0.2,
  _accumulateVeloPerInterval: 30,
  _groundedRayMaxDistance: 0.82,
  _isFallingThreshold: 1200,
  _runningMultiplier: 1.5,
  _crouchingMultiplier: 0.9,
  _keepMovingAfterJumpThreshold: -10,
  __isFallingStartTime: 0,
  __lviCheckTime: 0,
  __jumpTime: 0,
  __lastIsGroundedState: false,
  __touchingWallColliders: [],
  __touchingGroundColliders: [],
};
const getDefaultCharacterData = () => {
  // We need to copy all object and arrays
  const position = { ...DEFAULT_CHARACTER_DATA.position };
  const velocity = { ...DEFAULT_CHARACTER_DATA.velocity };
  const groundNormal = { ...DEFAULT_CHARACTER_DATA.groundNormal };
  const __touchingWallColliders = [...DEFAULT_CHARACTER_DATA.__touchingWallColliders];
  const __touchingGroundColliders = [...DEFAULT_CHARACTER_DATA.__touchingGroundColliders];
  return {
    ...DEFAULT_CHARACTER_DATA,
    position,
    velocity,
    groundNormal,
    __touchingWallColliders,
    __touchingGroundColliders,
  };
};

const eulerForCharRotation = new THREE.Euler();
let thirdPersonCamera: THREE.PerspectiveCamera | null = null;

// @TODO: make this file support several characters
const characters: { [id: string]: ThirdPersonCharacter } = {};

export const createThirdPersonCharacter = (opts: {
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
  const { id, charData, sceneId, inputMappings } = opts;

  // Combine character data
  const characterData = { ...getDefaultCharacterData(), ...charData };
  const character: Partial<ThirdPersonCharacter> = { charData: characterData };

  // Create third person camera
  thirdPersonCamera = createCamera(`thirdPersonCam-${id}`, {
    name: '3rd Person Cam',
    isCurrentCamera: true,
    fov: 80,
    near: 0.5,
    far: 1000,
  });

  const charCapsule = createGeometry({
    id: `charCapsuleThirdPerson1-${id}`,
    type: 'CAPSULE',
    params: {
      radius: characterData._radius,
      height: characterData._height - characterData._radius * 2,
    },
  });
  const charMaterial = createMaterial({
    id: `box1MaterialThirdPerson-${id}`,
    type: 'PHONG',
    params: {
      map: loadTexture({
        id: 'box1Texture',
        fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
      }),
    },
  });
  const charMesh = createMesh({
    id: `charMeshThirdPerson1-${id}`,
    geo: charCapsule,
    mat: charMaterial,
  });
  charMesh.position.set(0, 0, 0);
  charMesh.rotation.set(0, 0, 0);
  thirdPersonCamera.position.set(
    charMesh.position.x - 8,
    charMesh.position.y + 5,
    charMesh.position.z
  );
  thirdPersonCamera.rotation.set(0, 0, 0);
  thirdPersonCamera.lookAt(charMesh.position.x, charMesh.position.y + 2, charMesh.position.z);
  charMesh.add(thirdPersonCamera);

  const directionBeakMesh = createMesh({
    id: `directionBeakMeshThirdPerson-${id}`,
    geo: createGeometry({
      id: 'directionBeakGeoThirdPerson',
      type: 'BOX',
      params: { width: 0.25, height: 0.25, depth: 0.7 },
    }),
    mat: createMaterial({
      id: 'directionBeakMatThirdPerson',
      type: 'BASIC',
      params: { color: '#333' },
    }),
  });
  directionBeakMesh.position.set(0.35, 0.43, 0);
  charMesh.add(directionBeakMesh);

  const controlFns = {
    rotate: (direction: 'LEFT' | 'RIGHT') => {
      const dir = direction === 'LEFT' ? 1 : -1;
      const rotateSpeed = transformAppSpeedValue(characterData._rotateSpeed || 2) * dir;
      charMesh.rotateY(rotateSpeed);
      characterData.charRotation = eulerForCharRotation.setFromQuaternion(
        charMesh.quaternion,
        'XZY'
      ).y;
    },
    move: (direction: 'FORWARD' | 'BACKWARD') => {
      // @TODO: when landing from a jump, the character slows down significantly (probably friction) and then accelerates back to full speed, try to fix this.
      const rigidBody = characterPhysObj?.rigidBody;
      if (rigidBody) {
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
        const xAddition =
          xVelo > 0
            ? Math.min((rigidBody.linvel()?.x || 0) + xVelo, xMaxVelo)
            : Math.max((rigidBody.linvel()?.x || 0) + xVelo, xMaxVelo);
        const zAddition =
          zVelo > 0
            ? Math.min((rigidBody.linvel()?.z || 0) + zVelo, zMaxVelo)
            : Math.max((rigidBody.linvel()?.z || 0) + zVelo, zMaxVelo);

        let charLinvelY = rigidBody.linvel()?.y || 0;
        if (characterData.isGrounded) {
          charLinvelY += characterData._moveYOffset;
        }

        const velo = new THREE.Vector3(xAddition, charLinvelY, zAddition);
        rigidBody.setLinvel(velo, !rigidBody.isMoving());

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
              const newVel = {
                x: v.x - dot * n.x,
                y: v.y - dot * n.y,
                z: v.z - dot * n.z,
              };
              characterBody.setLinvel(newVel, true);
            }
          }
        }

        characterData.__lviCheckTime = performance.now();
      }
    },
    jump: () => {
      // Jump
      const charData = characterData;
      const jumpCheckOk =
        charData.isGrounded &&
        !charData.isCrouching &&
        charData.__jumpTime + 100 < performance.now();
      if (jumpCheckOk) {
        const physObj = characterPhysObj;
        physObj?.rigidBody?.applyImpulse(new THREE.Vector3(0, charData._jumpAmount, 0), true);
        charData.__jumpTime = performance.now();
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

  const thirdPersonCharacterObject = createCharacter({
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
          collisionEventFn: (coll1, coll2, started, obj1) => {
            if (started) {
              if (obj1.id === id) {
                if (coll1.handle !== wallSensorHandle) return;
                // obj1 is the character
                const bodyType = coll2.parent()?.bodyType();
                if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
                  characterData.__touchingWallColliders.push(coll2.handle);
                }
              } else {
                if (coll2.handle !== wallSensorHandle) return;
                // obj2 is the character
                const bodyType = coll1.parent()?.bodyType();
                if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
                  characterData.__touchingWallColliders.push(coll1.handle);
                }
              }
              characterData.isNearWall = true;
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
            let stairsCollider = null;
            if (started) {
              if (obj1.id === id) {
                if (coll1.handle !== groundSensorHandle) return;
                // obj1 is the character
                // isGrounded check:
                characterData.__touchingGroundColliders.push(coll2.handle);
                stairsCollider = coll2;
              } else {
                if (coll2.handle !== groundSensorHandle) return;
                // obj2 is the character
                // isGrounded check:
                characterData.__touchingGroundColliders.push(coll1.handle);
                stairsCollider = coll1;
              }
              characterData.isGrounded = true;
              getFloorNormal(getPhysicsWorld(), characterBody, characterData);

              const physObj = getPhysicsObject(thirdPersonCharacterObject.physObjectId);
              if (
                characterData._keepMovingAfterJumpThreshold <
                  (physObj?.rigidBody?.linvel().y || -5) &&
                !characterData.isFalling &&
                !characterData.__lastIsGroundedState &&
                characterData.hasMoveInput
              ) {
                // If just landed, then apply Y linvel to the rigidBody
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
              const userData = stairsCollider.parent()?.userData as {
                isStairs: boolean;
                stairsColliderIndex: number;
              };
              if (userData.isStairs && userData.stairsColliderIndex !== undefined) {
                if (Array.isArray(userData.stairsColliderIndex)) {
                  for (let i = 0; i < userData.stairsColliderIndex.length; i++) {
                    const targetCollider = stairsCollider
                      .parent()
                      ?.collider(userData.stairsColliderIndex[i]);
                    if (targetCollider && targetCollider.handle === stairsCollider.handle) {
                      characterData.isOnStairs = true;
                    }
                  }
                } else {
                  const targetCollider = stairsCollider
                    .parent()
                    ?.collider(userData.stairsColliderIndex);
                  if (targetCollider && targetCollider.handle === stairsCollider.handle) {
                    characterData.isOnStairs = true;
                  }
                }
              }

              // isSliding check:
              // is not on stairs, has world velocity
              // if (!characterData.isOnStairs && characterData.) {}
              return;
            }
            // isGrounded check:
            if (obj1.id === id) {
              if (coll1.handle !== groundSensorHandle) return;
              characterData.__touchingGroundColliders =
                characterData.__touchingGroundColliders.filter((handle) => handle !== coll2.handle);
              stairsCollider = coll2;
            } else {
              if (coll2.handle !== groundSensorHandle) return;
              characterData.__touchingGroundColliders =
                characterData.__touchingGroundColliders.filter((handle) => handle !== coll1.handle);
              stairsCollider = coll1;
            }
            if (!characterData.__touchingGroundColliders.length) characterData.isGrounded = false;
            if (characterData.isGrounded) {
              getFloorNormal(getPhysicsWorld(), characterBody, characterData);
            }

            characterData.__lastIsGroundedState = characterData.isGrounded;

            // isOnStairs check:
            const userData = stairsCollider.parent()?.userData as {
              isStairs: boolean;
              stairsColliderIndex: number;
            };
            if (userData.isStairs && userData.stairsColliderIndex !== undefined) {
              if (Array.isArray(userData.stairsColliderIndex)) {
                for (let i = 0; i < userData.stairsColliderIndex.length; i++) {
                  const targetCollider = stairsCollider
                    .parent()
                    ?.collider(userData.stairsColliderIndex[i]);
                  if (targetCollider && targetCollider.handle === stairsCollider.handle) {
                    characterData.isOnStairs = false;
                  }
                }
              } else {
                const targetCollider = stairsCollider
                  .parent()
                  ?.collider(userData.stairsColliderIndex);
                if (targetCollider && targetCollider.handle === stairsCollider.handle) {
                  characterData.isOnStairs = false;
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
  const characterPhysObj = getPhysicsObject(thirdPersonCharacterObject.physObjectId);
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

  createSceneAppLooper(() => {
    const physObj = getPhysicsObject(thirdPersonCharacterObject?.physObjectId || '');
    const mesh = physObj?.mesh;
    if (!physObj || !mesh) return;

    // Set isAwake (physics isMoving, aka. is awake)
    characterData.isAwake = physObj.rigidBody?.isMoving() || false;

    // No need to calculate anything if the character is not moving
    if (!characterData.isAwake) return;

    // This is the backup 'isGrounded' check
    if (!characterData.__touchingGroundColliders.length) detectGround();

    // Set isFalling
    if (characterData.isGrounded) {
      characterData.__isFallingStartTime = 0;
      characterData.isFalling = false;
    } else if (!characterData.__isFallingStartTime) {
      characterData.__isFallingStartTime = performance.now();
    } else if (
      characterData.__isFallingStartTime + characterData._isFallingThreshold <
      performance.now()
    ) {
      characterData.isFalling = true;
    }

    // Set velocity
    const velo = usableVec.set(
      Math.round(Math.abs(physObj.rigidBody?.linvel().x || 0) * 1000) / 1000,
      Math.round(Math.abs(physObj.rigidBody?.linvel().y || 0) * 1000) / 1000,
      Math.round(Math.abs(physObj.rigidBody?.linvel().z || 0) * 1000) / 1000
    );
    characterData.velocity = {
      x: velo.x,
      y: velo.y,
      z: velo.z,
      world: Math.round(new THREE.Vector3(velo.x, velo.y, velo.z).length() * 1000) / 1000,
    };

    // Set position
    characterData.position = physObj.rigidBody?.translation() || { x: 0, y: 0, z: 0 };
  }, sceneId);

  charMesh.castShadow = true;
  charMesh.receiveShadow = true;

  registerOnDeleteCharacter(id, () => {
    deleteCamera(thirdPersonCamera?.userData.id);
  });

  const characterBody = existsOrThrow(
    getPhysicsObject(thirdPersonCharacterObject.physObjectId)?.rigidBody,
    `Could not find character physics object rigid body with id: '${thirdPersonCharacterObject.physObjectId}'.`
  );

  character.camera = thirdPersonCamera;
  character.charMesh = charMesh;
  character.thirdPersonCharacterObject = thirdPersonCharacterObject;
  character.controlFns = controlFns;

  characters[id] = character as ThirdPersonCharacter;

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

  const maxToi = capsuleHeight / 2 + 0.25;
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

  characterData.groundNormal = hit?.normal || { x: 0, y: 1, z: 0 };
};
