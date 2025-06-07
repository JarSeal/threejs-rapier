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
export type CharacterData = {
  height: number;
  radius: number;
  charRotation: number;
  rotateSpeed: number;
  maxVelocity: number;
  inTheAirDiminisher: number;
  // @TODO: isRunning
  // @TODO: runningMultiplier
  linearVelocityInterval: number;
  lviCheckTime: number;
  accumulateVeloPerInterval: number;
  isMoving: boolean;
  isGrounded: boolean;
  groundedRayMaxDistance: number;
  isFalling: boolean;
  jumpTime: number;
  jumpAmount: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number; world: number };
};

const DEFAULT_CHARACTER_DATA: CharacterData = {
  height: 1.74,
  radius: 0.5,
  charRotation: 0,
  rotateSpeed: 5,
  maxVelocity: 7,
  inTheAirDiminisher: 0.2,
  linearVelocityInterval: 10,
  lviCheckTime: 0,
  accumulateVeloPerInterval: 40,
  isMoving: false,
  isGrounded: false,
  groundedRayMaxDistance: 1.2,
  isFalling: false,
  jumpTime: 0,
  jumpAmount: 5,
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0, world: 0 },
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
    params: { radius: characterData.radius, height: characterData.height / 3 },
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
    physicsParams: {
      collider: {
        type: 'CAPSULE',
        // restitution: 0.8,
        friction: 2,
      },
      rigidBody: {
        rigidType: 'DYNAMIC',
        lockRotations: { x: true, y: true, z: true },
        linearDamping: 0.5,
      },
    },
    data: characterData,
    meshOrMeshId: charMesh,
    controls: [
      {
        id: 'charMove',
        key: ['w', 's', 'a', 'd'],
        type: 'KEY_LOOP_ACTION',
        fn: (_, __, data) => {
          const keysPressed = data?.keysPressed as string[];
          const mesh = data?.mesh as THREE.Mesh;
          const charObj = data?.charObject as CharacterObject;
          const charData = charObj.data as CharacterData;

          if (!mesh || !charData) return;

          // Turn left (only mesh rotation, not physical object)
          if (keysPressed.includes('a')) {
            const rotateSpeed = transformAppSpeedValue(charData.rotateSpeed || 0);
            mesh.rotateY(rotateSpeed);
            charData.charRotation = eulerForCharRotation.setFromQuaternion(
              mesh.quaternion,
              'XZY'
            ).y;
          }
          // Turn right (only mesh rotation, not physical object)
          if (keysPressed.includes('d')) {
            const rotateSpeed = -transformAppSpeedValue(charData.rotateSpeed || 0);
            mesh.rotateY(rotateSpeed);
            charData.charRotation = eulerForCharRotation.setFromQuaternion(
              mesh.quaternion,
              'XZY'
            ).y;
          }
          // Forward and backward
          if (keysPressed.includes('w') || keysPressed.includes('s')) {
            // @TODO: add check if not touching ground, then make the moving amount much smaller (xVelo * 0.2 or something)
            const intervalCheckOk =
              charData?.linearVelocityInterval === 0 ||
              (charData?.lviCheckTime || 0) + (charData?.linearVelocityInterval || 0) <
                performance.now();
            const physObj = data?.physObj as PhysicsObject;
            const rigidBody = physObj.rigidBody;
            if (intervalCheckOk && physObj.rigidBody && rigidBody) {
              const inTheAirDiminisher = characterData.isGrounded
                ? 1
                : characterData.inTheAirDiminisher;
              const veloAccu = characterData.accumulateVeloPerInterval * inTheAirDiminisher;
              const mainDirection = keysPressed.includes('s') ? -1 : 1;
              const xVelo = Math.cos(characterData.charRotation) * veloAccu * mainDirection;
              const zVelo = -Math.sin(characterData.charRotation) * veloAccu * mainDirection;
              const xMaxVelo =
                Math.cos(characterData.charRotation) * characterData.maxVelocity * mainDirection;
              const zMaxVelo =
                -Math.sin(characterData.charRotation) * characterData.maxVelocity * mainDirection;
              const xAddition =
                xVelo > 0
                  ? Math.min((rigidBody.linvel()?.x || 0) + transformAppSpeedValue(xVelo), xMaxVelo)
                  : Math.max(
                      (rigidBody.linvel()?.x || 0) + transformAppSpeedValue(xVelo),
                      xMaxVelo
                    );
              const zAddition =
                zVelo > 0
                  ? Math.min((rigidBody.linvel()?.z || 0) + transformAppSpeedValue(zVelo), zMaxVelo)
                  : Math.max(
                      (rigidBody.linvel()?.z || 0) + transformAppSpeedValue(zVelo),
                      zMaxVelo
                    );
              const vector3 = new THREE.Vector3(xAddition, rigidBody.linvel()?.y || 0, zAddition);
              rigidBody.setLinvel(vector3, !rigidBody.isMoving());
              charData.lviCheckTime = performance.now();
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
          const jumpCheckOk = charData.isGrounded && charData.jumpTime + 100 < performance.now();
          if (jumpCheckOk) {
            const physObj = data?.physObj as PhysicsObject;
            physObj.rigidBody?.applyImpulse(new THREE.Vector3(0, charData.jumpAmount, 0), true);
            charData.jumpTime = performance.now();
          }
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
        intersects[i].distance < characterData.groundedRayMaxDistance
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
    usableVec.copy(charMesh.position).sub({ x: characterData.radius, y: 0, z: 0 });
    groundRaycaster.set(usableVec, groundRaycastVecDir);
    intersects = groundRaycaster.intersectObjects(getRootScene()?.children || []);
    isGroundedCheck = checkIntersectsObjectAndDistance(intersects);
    if (isGroundedCheck) {
      characterData.isGrounded = true;
      return;
    }
    usableVec.copy(charMesh.position).sub({ x: 0, y: 0, z: characterData.radius });
    groundRaycaster.set(usableVec, groundRaycastVecDir);
    intersects = groundRaycaster.intersectObjects(getRootScene()?.children || []);
    isGroundedCheck = checkIntersectsObjectAndDistance(intersects);
    if (isGroundedCheck) {
      characterData.isGrounded = true;
      return;
    }
    usableVec.copy(charMesh.position).add({ x: characterData.radius, y: 0, z: 0 });
    groundRaycaster.set(usableVec, groundRaycastVecDir);
    intersects = groundRaycaster.intersectObjects(getRootScene()?.children || []);
    isGroundedCheck = checkIntersectsObjectAndDistance(intersects);
    if (isGroundedCheck) {
      characterData.isGrounded = true;
      return;
    }
    usableVec.copy(charMesh.position).add({ x: 0, y: 0, z: characterData.radius });
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
    detectGround();
    const physObj = getPhysicsObject(thirdPersonCharacterObject?.physObjectId || '');
    const mesh = physObj?.mesh;
    if (!physObj || !mesh) return;
    characterData.isMoving = physObj.rigidBody?.isMoving() || false;
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
