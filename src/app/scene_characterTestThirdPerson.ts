import * as THREE from 'three/webgpu';
import { createScene } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createLight } from '../_engine/core/Light';
import { createMesh } from '../_engine/core/Mesh';
import { createSkyBox } from '../_engine/core/SkyBox';
import { createCamera, getCurrentCamera, setCurrentCamera } from '../_engine/core/Camera';
import { createPhysicsObjectWithMesh, PhysicsObject } from '../_engine/core/PhysicsRapier';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { loadTexture } from '../_engine/core/Texture';
import { CharacterObject, createCharacter } from '../_engine/core/Character';
import { transformAppSpeedValue } from '../_engine/core/MainLoop';
import { HALF_PI } from '../_engine/utils/constants';

export const SCENE_TEST_CHARACTER_ID = 'charThirdPerson1';

export const sceneCharacterTest = async () =>
  new Promise<string>(async (resolve) => {
    const updateLoaderFn = getLoaderStatusUpdater();
    updateLoaderFn({ loadedCount: 0, totalCount: 2 });

    // Create third person camera
    const thirdPersonCamera = createCamera('thirdPerson', {
      name: '3rd Person Cam',
      // isCurrentCamera: true,
      fov: 80,
      near: 0.5,
      far: 1000,
    });

    // Position camera
    const camera = getCurrentCamera();
    camera.position.z = 5;
    camera.position.x = 2.5;
    camera.position.y = 1;
    camera.lookAt(new THREE.Vector3(0, 0, 0));

    const scene = createScene(SCENE_TEST_CHARACTER_ID, {
      name: 'Test scene 1',
      isCurrentScene: true,
    });

    updateLoaderFn({ loadedCount: 1, totalCount: 2 });

    await createSkyBox({
      id: 'emptyBlueSkyEquiRect',
      name: 'Empty Blue Sky EquiRect',
      type: 'EQUIRECTANGULAR',
      params: {
        file: '/debugger/assets/testTextures/skyboxes/sunset_stylized/sky_empty_2k.png',
        textureId: 'equiRectEmptyId',
        colorSpace: THREE.SRGBColorSpace,
        // colorSpace: THREE.LinearSRGBColorSpace,
        // colorSpace: THREE.NoColorSpace,
      },
    });
    // await createSkyBox({
    //   id: 'stylizedSunsetEquiRect',
    //   name: 'Stylized Sunset EquiRect 4K',
    //   type: 'EQUIRECTANGULAR',
    //   params: {
    //     file: '/debugger/assets/testTextures/skyboxes/sunset_stylized/sky_41_4k.png',
    //     textureId: 'equiRectSunsetStylizedId',
    //     colorSpace: THREE.SRGBColorSpace,
    //     // colorSpace: THREE.LinearSRGBColorSpace,
    //     // colorSpace: THREE.NoColorSpace,
    //   },
    // });
    // const mapStylizedSunset = ['/px.png', '/nx.png', '/py.png', '/ny.png', '/pz.png', '/nz.png'];
    // await createSkyBox({
    //   id: 'stylizedSunsetCubemap',
    //   name: 'Stylized Sunset Cubemap',
    //   type: 'CUBETEXTURE',
    //   params: {
    //     fileNames: mapStylizedSunset,
    //     path: '/assets/testTextures/skyboxes/sunset_stylized',
    //     textureId: 'cubemapSunsetStylizedId',
    //     cubeTextRotate: 0.625,
    //   },
    // });
    // await createSkyBox({
    //   id: 'partly-cloudy',
    //   type: 'EQUIRECTANGULAR',
    //   params: {
    //     // file: envTexture,
    //     // file: '/assets/testTextures/kloofendal_48d_partly_cloudy_skyandground_8k.png',
    //     file: '/debugger/assets/testTextures/kloofendal_48d_partly_cloudy_puresky_4k.hdr',
    //     // file: '/assets/testTextures/kloofendal_48d_partly_cloudy_puresky_2k.hdr',
    //     // file: '/assets/testTextures/evening_road_01_puresky_8k.hdr',
    //     // file: '/assets/testTextures/pizzo_pernice_puresky_8k.hdr',
    //     textureId: 'equiRectId',
    //     // colorSpace: THREE.SRGBColorSpace,
    //     colorSpace: THREE.LinearSRGBColorSpace,
    //     // colorSpace: THREE.NoColorSpace,
    //   },
    // });
    // const map02 = [
    //   '/cubemap02_positive_x.png',
    //   '/cubemap02_negative_x.png',
    //   '/cubemap02_negative_y.png',
    //   '/cubemap02_positive_y.png',
    //   '/cubemap02_positive_z.png',
    //   '/cubemap02_negative_z.png',
    // ];
    // await createSkyBox({
    //   id: 'desert-dunes',
    //   type: 'CUBETEXTURE',
    //   params: {
    //     fileNames: map02,
    //     path: '/debugger/assets/testTextures',
    //     textureId: 'cubeTextureId',
    //     flipY: true,
    //   },
    // });

    // Ground
    const groundWidthAndDepth = 50;
    const groundHeight = 0.2;
    const groundPos = { x: 0, y: -2, z: 0 };
    const groundGeo = createGeometry({
      id: 'largeGroundGeo',
      type: 'BOX',
      params: { width: groundWidthAndDepth, height: groundHeight, depth: groundWidthAndDepth },
    });
    const groundMat = createMaterial({
      id: 'largeGroundMat',
      type: 'LAMBERT',
      params: { color: 0x556334 },
    });
    const groundMesh = createMesh({
      id: 'largeGroundMesh',
      geo: groundGeo,
      mat: groundMat,
      receiveShadow: true,
      // castShadow: true,
    });
    groundMesh.position.set(groundPos.x, groundPos.y, groundPos.z);
    createPhysicsObjectWithMesh(
      {
        collider: {
          type: 'BOX',
          friction: 2,
        },
        rigidBody: { rigidType: 'FIXED', translation: groundPos },
      },
      groundMesh
    );
    scene.add(groundMesh);

    // BOX
    const geometry2 = createGeometry({
      id: 'testBox1',
      type: 'BOX',
      params: { width: 1, height: 1, depth: 1 },
    });
    const material2 = createMaterial({
      id: 'testBox1Material',
      type: 'PHONG',
      params: {
        map: loadTexture({
          id: 'box1Texture',
          fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
        }),
      },
    });
    const box = createMesh({ id: 'testBox1Mesh', geo: geometry2, mat: material2 });
    createPhysicsObjectWithMesh(
      {
        collider: {
          type: 'BOX',
          restitution: 0.5,
          friction: 0,
        },
        rigidBody: {
          rigidType: 'DYNAMIC',
          translation: { x: 2, y: 0, z: 0 },
          angvel: { x: 1, y: -2, z: 20 },
        },
      },
      box
    );
    box.castShadow = true;
    box.receiveShadow = true;
    scene.add(box);

    // CHARACTER
    const eulerForCharRotation = new THREE.Euler();
    const charCapsule = createGeometry({
      id: 'charCapsuleThirdPerson1',
      type: 'CAPSULE',
      params: { radius: 0.5, height: 0.58 },
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
    thirdPersonCamera.position.set(-8, 2, 0);
    thirdPersonCamera.lookAt(charMesh.position);
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
    createCharacter({
      id: 'testCharacterThirdPerson1',
      physicsParams: {
        collider: {
          type: 'CAPSULE',
          restitution: 0.8,
          friction: 2,
        },
        rigidBody: {
          rigidType: 'DYNAMIC',
          lockRotations: { x: true, y: true, z: true },
          linearDamping: 0.5,
        },
      },
      data: { charRotation: 0, rotateSpeed: 3.5, translateSpeed: 1000 },
      meshOrMeshId: charMesh,
      controls: [
        {
          id: 'charMove',
          key: ['w', 's', 'a', 'd'],
          type: 'KEY_LOOP_ACTION',
          fn: (_, __, data) => {
            const keysPressed = data?.keysPressed as string[];
            const mesh = data?.mesh as THREE.Mesh;
            const charData = (data?.charObject as CharacterObject)?.data as {
              charRotation: number;
              rotateSpeed: number;
              translateSpeed: number;
            };
            // Turn left
            if (keysPressed.includes('a') && mesh && charData) {
              const rotateSpeed = transformAppSpeedValue(charData.rotateSpeed || 0);
              mesh.rotateY(rotateSpeed);
              charData.charRotation = eulerForCharRotation.setFromQuaternion(
                mesh.quaternion,
                'XZY'
              ).y;
            }
            // Turn right
            if (keysPressed.includes('d') && mesh && charData) {
              const rotateSpeed = -transformAppSpeedValue(charData.rotateSpeed || 0);
              mesh.rotateY(rotateSpeed);
              charData.charRotation = eulerForCharRotation.setFromQuaternion(
                mesh.quaternion,
                'XZY'
              ).y;
            }
            // Forward and backward
            if ((keysPressed.includes('w') || keysPressed.includes('s')) && mesh && charData) {
              const mainDirection = keysPressed.includes('s') ? -1 : 1;
              const xDir =
                charData.charRotation < HALF_PI && charData.charRotation >= -HALF_PI ? 1 : -1;
              const zDir = charData.charRotation > 0 && charData.charRotation <= Math.PI ? -1 : 1;
              const xVelo =
                (1 - Math.abs(charData.charRotation) / HALF_PI) *
                charData.translateSpeed *
                mainDirection;
              const zVelo =
                xDir === 1
                  ? (1 - Math.abs(charData.charRotation + HALF_PI) / HALF_PI) *
                    charData.translateSpeed *
                    mainDirection
                  : (1 - Math.abs(charData.charRotation + HALF_PI * zDir) / HALF_PI) *
                    charData.translateSpeed *
                    zDir *
                    mainDirection;
              const physObj = data?.physObj as PhysicsObject;
              const vector3 = new THREE.Vector3(
                transformAppSpeedValue(xVelo),
                physObj.rigidBody?.linvel()?.y || 0,
                transformAppSpeedValue(zVelo)
              );
              physObj.rigidBody?.setLinvel(vector3, !physObj.rigidBody?.isMoving());
            }
          },
        },
      ],
    });
    charMesh.castShadow = true;
    charMesh.receiveShadow = true;
    scene.add(charMesh);

    // Lights
    const ambient = createLight({
      id: 'charSceneAmbiLight',
      name: 'Ambient light',
      type: 'AMBIENT',
      params: { color: '#ffffff', intensity: 0.5 },
    });
    scene.add(ambient);

    const hemisphere = createLight({
      id: 'charScHemisLight',
      type: 'HEMISPHERE',
      params: {
        skyColor: 0x220000,
        groundColor: 0x225599,
        intensity: 1.5,
      },
    });
    scene.add(hemisphere);

    const directionalLight = createLight({
      id: 'charSceneDirLight',
      type: 'DIRECTIONAL',
      params: {
        position: { x: -27, y: 12.5, z: 18.5 },
        color: 0xffe5c7,
        intensity: 5,
        castShadow: true,
        shadowMapSize: [1024, 1024],
        shadowCamNearFar: [10, 105],
        shadowCamLeftRightTopBottom: [-30, 30, 30, -30],
        shadowBias: -0.0009,
        shadowNormalBias: 0.1184,
        shadowRadius: 5, // Not for PCFSoftShadowMap type
        shadowBlurSamples: 10, // Only for VSM shadowmap types
        shadowIntensity: 0.75,
      },
    });
    scene.add(directionalLight);

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    setCurrentCamera(thirdPersonCamera.userData.id);

    resolve(SCENE_TEST_CHARACTER_ID);
  });
