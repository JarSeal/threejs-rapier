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
import { getPhysicsObject, PhysicsObject } from '../_engine/core/PhysicsRapier';
import { createSceneAppLooper, getRootScene } from '../_engine/core/Scene';

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
  _height: 1.74,
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
    params: { radius: characterData._radius, height: characterData._height / 3 },
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
          // restitution: 0.8,
          friction: 0.5,
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
          friction: 0.5,
          halfHeight: charCapsule.userData.props?.params.height / 2,
        },
        rigidBody: {
          rigidType: 'DYNAMIC',
          lockRotations: { x: true, y: true, z: true },
          linearDamping: 0.5,
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
              const vector3 = new THREE.Vector3(xAddition, rigidBody.linvel()?.y || 0, zAddition);
              rigidBody.setLinvel(vector3, !rigidBody.isMoving());
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
        },
      },
    ],
  });

  // Ground detection with rays
  const groundRaycaster = new THREE.Raycaster();
  groundRaycaster.near = 0.01;
  groundRaycaster.far = 10;
  const usableVec = new THREE.Vector3();
  const groundRaycastVecDir = new THREE.Vector3(0, -1, 0);
  const checkIntersectsObjectAndDistance = (intersects: THREE.Intersection[]) => {
    for (let i = 0; i < intersects.length; i++) {
      if (
        (intersects[i].object as unknown as { userData?: { [key: string]: unknown } }).userData
          ?.isPhysicsObject &&
        intersects[i].distance < characterData._groundedRayMaxDistance
      ) {
        return true;
      }
    }
    return false;
  };
  const detectGround = () => {
    // First ray from the middle of the character
    groundRaycaster.set(charMesh.position, groundRaycastVecDir);
    let intersects = groundRaycaster.intersectObjects(getRootScene()?.children || []);
    // console.log('GROUND', intersects.length);
    let isGroundedCheck = checkIntersectsObjectAndDistance(intersects);
    if (isGroundedCheck) {
      characterData.isGrounded = true;
      return;
    }

    // Four rays from the edges of the character
    usableVec.copy(charMesh.position).sub({ x: characterData._radius, y: 0, z: 0 });
    groundRaycaster.set(usableVec, groundRaycastVecDir);
    intersects = groundRaycaster.intersectObjects(getRootScene()?.children || []);
    isGroundedCheck = checkIntersectsObjectAndDistance(intersects);
    if (isGroundedCheck) {
      characterData.isGrounded = true;
      return;
    }
    usableVec.copy(charMesh.position).sub({ x: 0, y: 0, z: characterData._radius });
    groundRaycaster.set(usableVec, groundRaycastVecDir);
    intersects = groundRaycaster.intersectObjects(getRootScene()?.children || []);
    isGroundedCheck = checkIntersectsObjectAndDistance(intersects);
    if (isGroundedCheck) {
      characterData.isGrounded = true;
      return;
    }
    usableVec.copy(charMesh.position).add({ x: characterData._radius, y: 0, z: 0 });
    groundRaycaster.set(usableVec, groundRaycastVecDir);
    intersects = groundRaycaster.intersectObjects(getRootScene()?.children || []);
    isGroundedCheck = checkIntersectsObjectAndDistance(intersects);
    if (isGroundedCheck) {
      characterData.isGrounded = true;
      return;
    }
    usableVec.copy(charMesh.position).add({ x: 0, y: 0, z: characterData._radius });
    groundRaycaster.set(usableVec, groundRaycastVecDir);
    intersects = groundRaycaster.intersectObjects(getRootScene()?.children || []);
    isGroundedCheck = checkIntersectsObjectAndDistance(intersects);
    if (isGroundedCheck) {
      characterData.isGrounded = true;
      return;
    }

    characterData.isGrounded = false;
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

  return { thirdPersonCharacterObject, charMesh, charData, thirdPersonCamera };
};
