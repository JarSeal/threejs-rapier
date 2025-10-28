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
  PhysicsObject,
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
  isMoving: boolean;
  isGrounded: boolean;
  isFalling: boolean;
  isRunning: boolean;
  isCrouching: boolean; // @TODO: add physics object switching (several physic objects)
  _height: number;
  _radius: number;
  _rotateSpeed: number;
  _maxVelocity: number;
  _jumpAmount: number;
  _inTheAirDiminisher: number;
  _accumulateVeloPerInterval: number;
  _groundedRayMaxDistance: number;
  /** How much time is there when the character is not touching the ground and goes into the "isFalling" state (in milliseconds) */
  _isFallingThreshold: number;
  _runningMultiplier: number;
  _crouchingMultiplier: number;
  __isFallingStartTime: number;
  __lviCheckTime: number;
  __jumpTime: number;
};

export type ThirdPersonCharacter = {
  thirdPersonCharacterObject: CharacterObject;
  charMesh: THREE.Mesh;
  charData: CharacterData;
  camera?: THREE.PerspectiveCamera;
  nearWall?: boolean;
  touchingWallColliders: Collider['handle'][];
};

const DEFAULT_CHARACTER_DATA: CharacterData = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0, world: 0 },
  charRotation: 0,
  isMoving: false,
  isGrounded: false,
  isFalling: false,
  isRunning: false,
  isCrouching: false,
  _height: 1.6,
  _radius: 0.5,
  _rotateSpeed: 5,
  _maxVelocity: 3.7,
  _jumpAmount: 5,
  _inTheAirDiminisher: 0.2,
  _accumulateVeloPerInterval: 30,
  _groundedRayMaxDistance: 1.2,
  _isFallingThreshold: 1200,
  _runningMultiplier: 1.5,
  _crouchingMultiplier: 0.7,
  __isFallingStartTime: 0,
  __lviCheckTime: 0,
  __jumpTime: 0,
};

const eulerForCharRotation = new THREE.Euler();
let thirdPersonCamera: THREE.PerspectiveCamera | null = null;

// @TODO: make this file support several characters
const characters: { [id: string]: ThirdPersonCharacter } = {};

export const createThirdPersonCharacter = (
  id: string,
  charData?: Partial<CharacterData>,
  sceneId?: string
) => {
  // Combine character data
  const characterData = { ...DEFAULT_CHARACTER_DATA, ...charData };
  const character: Partial<ThirdPersonCharacter> = {
    charData: characterData,
    touchingWallColliders: [],
  };

  // Create third person camera
  thirdPersonCamera = createCamera('thirdPerson', {
    name: '3rd Person Cam',
    isCurrentCamera: true,
    fov: 80,
    near: 0.5,
    far: 1000,
  });

  const charCapsule = createGeometry({
    id: 'charCapsuleThirdPerson1',
    type: 'CAPSULE',
    params: {
      radius: characterData._radius,
      height: characterData._height - characterData._radius * 2,
    },
  });
  const charMaterial = createMaterial({
    id: 'box1MaterialThirdPerson',
    type: 'PHONG',
    params: {
      map: loadTexture({
        id: 'box1Texture',
        fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
      }),
    },
  });
  const charMesh = createMesh({
    id: 'charMeshThirdPerson1',
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
    id: 'directionBeakMeshThirdPerson',
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

  const thirdPersonCharacterObject = createCharacter({
    id,
    physicsParams: [
      {
        collider: {
          type: 'CAPSULE',
          friction: 0,
        },
        rigidBody: {
          rigidType: 'DYNAMIC',
          lockRotations: { x: true, y: true, z: true },
          linearDamping: 0,
        },
      },
      {
        collider: {
          type: 'CAPSULE',
          friction: 1.5,
          halfHeight: charCapsule.userData.props?.params.height / 4,
          translation: {
            x: charMesh.position.x,
            y: charMesh.position.y - charCapsule.userData.props?.params.height / 4,
            z: charMesh.position.z,
          },
        },
      },
      {
        collider: {
          type: 'CAPSULE',
          halfHeight: (charCapsule.userData.props?.params.height / 2.5) * 1.05,
          radius: charCapsule.userData.props?.params.radius * 1.05,
          isSensor: true,
          density: 0,
          collisionEventFn: (coll1, coll2, started, obj1) => {
            // @IDEA: when started becomes false, then we could create another sensor to double check if we are still touching the wall.
            // This would double check the nearWall result and minimize character being stuck in the wall.
            if (started) {
              if (obj1.id === id) {
                // obj1 is the character
                const bodyType = coll2.parent()?.bodyType();
                if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
                  character.nearWall = true;
                  character.touchingWallColliders?.push(coll2.handle);
                }
              } else {
                // obj2 is the character
                const bodyType = coll1.parent()?.bodyType();
                if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
                  character.nearWall = true;
                  character.touchingWallColliders?.push(coll1.handle);
                }
              }
              return;
            }
            if (obj1.id === id) {
              character.touchingWallColliders =
                character.touchingWallColliders?.filter((handle) => handle !== coll2.handle) || [];
            } else {
              character.touchingWallColliders =
                character.touchingWallColliders?.filter((handle) => handle !== coll1.handle) || [];
            }
            if (!character.touchingWallColliders?.length) character.nearWall = false;
          },
          translation: { x: 0, y: 0.05, z: 0 },
        },
      },
    ],
    data: characterData,
    meshOrMeshId: charMesh,
    controls: [
      {
        id: 'charMove',
        key: ['w', 's', 'a', 'd', 'W', 'S', 'A', 'D'],
        type: 'KEY_LOOP_ACTION',
        fn: (_, __, data) => {
          const keysPressed = data?.keysPressed as string[];
          const mesh = data?.mesh as THREE.Mesh;
          const charObj = data?.charObject as CharacterObject;
          const charData = charObj.data as CharacterData;

          if (!mesh || !charData) return;

          // Turn left (only mesh rotation, not physical object)
          if (keysPressed.includes('a') || keysPressed.includes('A')) {
            const rotateSpeed = transformAppSpeedValue(charData._rotateSpeed || 0);
            mesh.rotateY(rotateSpeed);
            charData.charRotation = eulerForCharRotation.setFromQuaternion(
              mesh.quaternion,
              'XZY'
            ).y;
          }
          // Turn right (only mesh rotation, not physical object)
          if (keysPressed.includes('d') || keysPressed.includes('D')) {
            const rotateSpeed = -transformAppSpeedValue(charData._rotateSpeed || 0);
            mesh.rotateY(rotateSpeed);
            charData.charRotation = eulerForCharRotation.setFromQuaternion(
              mesh.quaternion,
              'XZY'
            ).y;
          }
          // Forward and backward
          if (
            keysPressed.includes('w') ||
            keysPressed.includes('s') ||
            keysPressed.includes('W') ||
            keysPressed.includes('S')
          ) {
            // @TODO: add a check whether the character is moving forward or backward and first slow down the character to 0 before setting full linear velocity addition.
            // @TODO: when landing from a jump, the character slows down significantly (probably friction) and then accelerates back to full speed, try to fix this.
            const physObj = data?.physObj as PhysicsObject;
            const rigidBody = physObj.rigidBody;
            if (physObj.rigidBody && rigidBody) {
              const maxVeloMultiplier =
                // isRunning
                characterData.isRunning && characterData.isGrounded && !characterData.isCrouching
                  ? characterData._runningMultiplier
                  : // isCrouching
                    characterData.isGrounded && characterData.isCrouching
                    ? characterData._crouchingMultiplier
                    : 1;
              const maxVelo = characterData._maxVelocity * maxVeloMultiplier;
              const mainDirection = keysPressed.includes('s') || keysPressed.includes('S') ? -1 : 1;
              const inTheAirDiminisher =
                characterData.isGrounded && !characterData.isFalling
                  ? 1
                  : characterData._inTheAirDiminisher;
              const crouchVeloAccuMultiplier = characterData.isCrouching
                ? characterData._crouchingMultiplier + 1
                : 1;
              const veloAccu = transformAppSpeedValue(
                characterData._accumulateVeloPerInterval *
                  inTheAirDiminisher *
                  crouchVeloAccuMultiplier
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

              const velo = new THREE.Vector3(xAddition, rigidBody.linvel()?.y || 0, zAddition);
              rigidBody.setLinvel(velo, !rigidBody.isMoving());

              if (character.nearWall) {
                const hit = getWallHitFromRaycasts(getPhysicsWorld(), characterBody, character);
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

              charData.__lviCheckTime = performance.now();
            }
          }
        },
      },
      {
        id: 'charJump',
        key: ' ', // Space
        type: 'KEY_DOWN',
        fn: (e, __, data) => {
          e.preventDefault();
          if (e.repeat) return;
          // Jump
          const charObj = data?.charObject as CharacterObject;
          const charData = charObj.data as CharacterData;
          // @TODO: add check if on the ground
          const jumpCheckOk =
            charData.isGrounded &&
            !charData.isCrouching &&
            charData.__jumpTime + 100 < performance.now();
          if (jumpCheckOk) {
            const physObj = data?.physObj as PhysicsObject;
            physObj.rigidBody?.applyImpulse(new THREE.Vector3(0, charData._jumpAmount, 0), true);
            charData.__jumpTime = performance.now();
          }
        },
      },
      {
        id: 'charRun',
        key: 'Shift',
        type: 'KEY_DOWN',
        fn: (e, __, data) => {
          e.preventDefault();
          if (e.repeat) return;
          // Set isRunning state
          const charObj = data?.charObject as CharacterObject;
          const charData = charObj.data as CharacterData;
          charData.isRunning = !charData.isRunning;
        },
      },
      {
        id: 'charCrouch',
        key: 'Control',
        type: 'KEY_DOWN',
        fn: (e, __, data) => {
          e.preventDefault();
          if (e.repeat) return;
          // Set isCrouching state
          const charObj = data?.charObject as CharacterObject;
          const charData = charObj.data as CharacterData;
          charData.isCrouching = !charData.isCrouching;
          const nextIndex = charData.isCrouching ? 1 : 0;
          switchPhysicsCollider(charObj.id, nextIndex);
        },
      },
    ],
  });

  // Ground detection with rays
  const groundRaycaster = new THREE.Raycaster();
  groundRaycaster.near = 0.01;
  groundRaycaster.far = 10;
  const usableVec = new THREE.Vector3();
  const groundRaycastVecDir = new THREE.Vector3(0, -1, 0).normalize();
  const charHalfRadius = characterData._radius / 2;
  const detectGround = () => {
    characterData.isGrounded = false;

    // First ray from the middle of the character
    castRayFromPoints<THREE.Mesh>(
      getRootScene()?.children || [],
      charMesh.position,
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
      charMesh.position.clone().sub({ x: charHalfRadius, y: 0, z: 0 }),
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
      charMesh.position.clone().sub({ x: -charHalfRadius, y: 0, z: 0 }),
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
      charMesh.position.clone().sub({ x: 0, y: 0, z: charHalfRadius }),
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
      charMesh.position.clone().sub({ x: 0, y: 0, z: -charHalfRadius }),
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

    // Set isMoving (physics isMoving, aka. is awake)
    characterData.isMoving = physObj.rigidBody?.isMoving() || false;

    // No need to calculate anything if the character is not moving
    if (!characterData.isMoving) return;

    detectGround();

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
    characterData.position.x = physObj.mesh?.position.x || 0;
    characterData.position.y = physObj.mesh?.position.y || 0;
    characterData.position.z = physObj.mesh?.position.z || 0;
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

  characters[id] = character as ThirdPersonCharacter;

  return characters[id];
};

const getWallHitFromRaycasts = (
  world: RAPIER.World,
  characterBody: RAPIER.RigidBody,
  character: Partial<ThirdPersonCharacter>
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
  if (hit && character.touchingWallColliders?.includes(hit.collider.handle)) {
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
    if (hit && character.touchingWallColliders?.includes(hit.collider.handle)) {
      const bodyType = hit?.collider.parent()?.bodyType();
      if (bodyType !== RAPIER.RigidBodyType.Dynamic) {
        return hit;
      }
    }
  }

  return;
};
