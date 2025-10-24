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
  addScenePhysicsLooper,
  getPhysicsObject,
  getPhysicsWorld,
  PhysicsObject,
  switchPhysicsCollider,
} from '../_engine/core/PhysicsRapier';
import { createSceneAppLooper, getRootScene } from '../_engine/core/Scene';
import { castRayFromPoints } from '../_engine/core/Raycast';
import RAPIER from '@dimforge/rapier3d-compat';
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
  _linearVelocityInterval: number;
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
  _linearVelocityInterval: 10,
  _accumulateVeloPerInterval: 80,
  _groundedRayMaxDistance: 1.2,
  _isFallingThreshold: 1200,
  _runningMultiplier: 1.85,
  _crouchingMultiplier: 0.65,
  __isFallingStartTime: 0,
  __lviCheckTime: 0,
  __jumpTime: 0,
};
let characterData = DEFAULT_CHARACTER_DATA;
// let averagedWallNormal: { x: number; y: number; z: number } | null = null;
let nearWall = false;

const eulerForCharRotation = new THREE.Euler();
let thirdPersonCamera: THREE.PerspectiveCamera | null = null;
let thirdPersonCharacterObject: CharacterObject | null = null;

export const createThirdPersonCharacter = (charData?: Partial<CharacterData>, sceneId?: string) => {
  // Combine character data
  characterData = { ...DEFAULT_CHARACTER_DATA, ...charData };

  const CHARACTER_ID = 'thirdPersonCamCharacter';

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

  thirdPersonCharacterObject = createCharacter({
    id: CHARACTER_ID,
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
          collisionEventFn: (_, __, started, obj1, obj2) => {
            if (obj1.id === CHARACTER_ID || obj2.id === CHARACTER_ID) {
              nearWall = started;
            }
            // console.log('SENSOR ALERT', obj1, obj2, coll1, coll2, started);
            // const acc = { x: 0, y: 0, z: 0 };
            // let count = 0;
            // if (started) {
            //   //
            //   // Test contactPairsWith
            //   if (obj1.id === CHARACTER_ID) {
            //     getPhysicsWorld().contactPairsWith(coll2, (coll1) => {
            //       getPhysicsWorld().contactPair(coll2, coll1, (manifold, flipped) => {
            //         const n = manifold.normal();
            //         const nx = flipped ? n.x : -n.x;
            //         const ny = flipped ? n.y : -n.y;
            //         const nz = flipped ? n.z : -n.z;
            //         acc.x += nx;
            //         acc.y += ny;
            //         acc.z += nz;
            //         count++;
            //         console.log('__1__', obj2.id, obj1.id, { x: nx, y: ny, z: nz });
            //       });
            //     });
            //   } else {
            //     getPhysicsWorld().contactPairsWith(coll1, (coll2) => {
            //       getPhysicsWorld().contactPair(coll1, coll2, (manifold, flipped) => {
            //         const n = manifold.normal();
            //         const nx = !flipped ? n.x : -n.x;
            //         const ny = !flipped ? n.y : -n.y;
            //         const nz = !flipped ? n.z : -n.z;
            //         acc.x += nx;
            //         acc.y += ny;
            //         acc.z += nz;
            //         count++;
            //         console.log('__2__', obj2.id, obj1.id, { x: nx, y: ny, z: nz }, n);
            //       });
            //     });
            //   }
            //   if (count === 0) return;
            //   const avg = { x: acc.x / count, y: acc.y / count, z: acc.z / count };
            //   const len = Math.hypot(avg.x, avg.y, avg.z) || 1e-6;
            //   averagedWallNormal = { x: avg.x / len, y: avg.y / len, z: avg.z / len };
            //   console.log('AVERAGED', averagedWallNormal);
            // } else {
            //   //
            //   averagedWallNormal = null;
            // }
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
            const intervalCheckOk =
              charData?._linearVelocityInterval === 0 ||
              (charData?.__lviCheckTime || 0) + (charData?._linearVelocityInterval || 0) <
                performance.now();
            const physObj = data?.physObj as PhysicsObject;
            const rigidBody = physObj.rigidBody;
            if (intervalCheckOk && physObj.rigidBody && rigidBody) {
              const inTheAirDiminisher =
                characterData.isGrounded && !characterData.isFalling
                  ? 1
                  : characterData._inTheAirDiminisher;
              const veloAccu = transformAppSpeedValue(
                characterData._accumulateVeloPerInterval * inTheAirDiminisher
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
              const mainDirection = keysPressed.includes('s') || keysPressed.includes('S') ? -1 : 1;
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
              // @TODO: character gets stuck on walls, add detection and correct the linear velocity direction to the direction of the wall (or cancel it if head on collision)
              const velo = new THREE.Vector3(xAddition, rigidBody.linvel()?.y || 0, zAddition);
              rigidBody.setLinvel(velo, !rigidBody.isMoving());

              // if (averagedWallNormal) {
              //   const n = averagedWallNormal;
              //   let dot = velo.x * n.x + velo.y * n.y + velo.z * n.z;
              //   if (dot < 0) dot = 0;
              //   const slide = {
              //     x: velo.x - dot * n.x,
              //     y: velo.y - dot * n.y,
              //     z: velo.z - dot * n.z,
              //   };

              //   const maxDown = -3.0;
              //   if (slide.y < maxDown) slide.y = maxDown;

              //   rigidBody.setLinvel(slide, true);
              // }
              console.log('NEAR_WALL', nearWall);
              if (nearWall) {
                const wallNormal = getWallNormalFromRaycasts(getPhysicsWorld(), playerBody);
                // console.log('WALL_NORMAL', wallNormal);
                if (wallNormal) {
                  const v = playerBody.linvel();
                  let n = wallNormal;

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

                    // Optional: cap downward slide speed
                    // if (newVel.y < -5.0) newVel.y = -5.0;

                    playerBody.setLinvel(newVel, true);
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

  registerOnDeleteCharacter(CHARACTER_ID, () => {
    deleteCamera(thirdPersonCamera?.userData.id);
  });

  const playerBody = existsOrThrow(
    getPhysicsObject(thirdPersonCharacterObject.physObjectId)?.rigidBody,
    `Could not find character physics object rigid body with id: '${thirdPersonCharacterObject.physObjectId}'.`
  );
  // addScenePhysicsLooper('characterPhysicsLooper', () => {
  //   if (nearWall) {
  //     const wallNormal = getWallNormalFromRaycasts(getPhysicsWorld(), playerBody);
  //     console.log('WALL_NORMAL', wallNormal);
  //     if (wallNormal) {
  //       const v = playerBody.linvel();
  //       const n = wallNormal;

  //       const dot = v.x * n.x + v.y * n.y + v.z * n.z;

  //       // Only cancel the velocity if moving INTO the wall
  //       if (dot < 0) {
  //         const newVel = {
  //           x: v.x - dot * n.x,
  //           y: v.y - dot * n.y,
  //           z: v.z - dot * n.z,
  //         };

  //         // Optional: cap downward slide speed
  //         if (newVel.y < -3.0) newVel.y = -3.0;

  //         console.log('NEWVEL', newVel);

  //         playerBody.setLinvel(newVel, true);
  //       }
  //     }
  //   }
  // });

  return { thirdPersonCharacterObject, charMesh, charData, thirdPersonCamera };
};

const getWallNormalFromRaycasts = (world: RAPIER.World, playerBody: RAPIER.RigidBody) => {
  const vel = playerBody.linvel();
  let dir = { x: vel.x, y: 0, z: vel.z };
  const len = Math.hypot(dir.x, dir.z);

  if (len > 1e-5) {
    dir.x /= len;
    dir.z /= len;
  } else {
    dir = { x: 0, y: 0, z: 1 }; // fallback forward
  }

  const maxToi = 50;

  // Center of the character
  let origin = playerBody.translation();
  let ray = new RAPIER.Ray(playerBody.translation(), dir);
  let hit = world.castRayAndGetNormal(
    ray,
    maxToi,
    true,
    undefined,
    undefined,
    undefined,
    playerBody
  );
  if (hit) {
    const body = hit.collider.parent();
    if (body?.bodyType() === RAPIER.RigidBodyType.Dynamic) return;
    return hit.normal;
  }

  // No hit, try more rays from different origin (top and bottom of the character)
  let collider = playerBody.collider(0);
  if (!collider?.isEnabled()) {
    collider = playerBody.collider(1);
  }
  const capsuleHeight =
    (collider.shape as RAPIER.Capsule).halfHeight * 2 +
    (collider.shape as RAPIER.Capsule).radius * 2;

  // Almost bottom of the character
  origin = playerBody.translation();
  origin.y -= capsuleHeight * 0.49;
  ray = new RAPIER.Ray(origin, dir);
  hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, undefined, undefined, playerBody);
  if (hit) {
    const body = hit.collider.parent();
    if (body?.bodyType() === RAPIER.RigidBodyType.Dynamic) return;
    return hit.normal;
  }

  // Almost top of the character
  origin = playerBody.translation();
  origin.y += capsuleHeight * 0.49;
  ray = new RAPIER.Ray(origin, dir);
  hit = world.castRayAndGetNormal(ray, maxToi, true, undefined, undefined, undefined, playerBody);
  if (hit) {
    const body = hit.collider.parent();
    if (body?.bodyType() === RAPIER.RigidBodyType.Dynamic) return;
    return hit.normal;
  }

  // @TODO: add rays for both sides of the collider as well. So center left, center right, bottom left, bottom right, top left, and top right === 6 more)

  return;

  // const origin = playerBody.translation();
  // const dirs = [
  //   { x: 1, y: 0, z: 0 },
  //   { x: -1, y: 0, z: 0 },
  //   { x: 0, y: 0, z: 1 },
  //   { x: 0, y: 0, z: -1 },
  // ];
  // const maxToi = 1.7; // short distance around the player
  // const accum = { x: 0, y: 0, z: 0 };
  // let count = 0;

  // // for (const dir of dirs) {
  // const vel = playerBody.linvel();
  // let dir = { x: vel.x, y: 0, z: vel.z };
  // let len = Math.hypot(dir.x, dir.z);
  // if (len > 1e-5) {
  //   dir.x /= len;
  //   dir.z /= len;
  // } else {
  //   // default forward if standing still
  //   dir = { x: 0, y: 0, z: 1 };
  // }
  // @CONSIDER: dow we need a physics method for this?
  // Such as "castPhysicsRayFromPoint(origin, dir)" and/or
  // "castPhysicsRayFromDirection(origin, dir)", kinda like we have for Three.js raycasting.
  // const ray = new RAPIER.Ray(origin, dir);
  // const hit = world.castRayAndGetNormal(ray, maxToi, true);
  // if (hit && hit.timeOfImpact < maxToi && Math.abs(hit.normal.y) < 0.6) {
  //   console.log('HIT', hit.normal, len);
  //   accum.x += hit.normal.x;
  //   accum.y += hit.normal.y;
  //   accum.z += hit.normal.z;
  //   count++;
  // }
  // }

  // if (count === 0) return null;
  // len = Math.hypot(accum.x, accum.y, accum.z);
  // if (!len) return { x: 0, y: 0, z: 0 };
  // return { x: accum.x / len, y: accum.y / len, z: accum.z / len };
};
