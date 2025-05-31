import * as THREE from 'three/webgpu';
import { createScene } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createLight } from '../_engine/core/Light';
import { createMesh } from '../_engine/core/Mesh';
import { createSkyBox } from '../_engine/core/SkyBox';
import { getCurrentCamera } from '../_engine/core/Camera';
import { createPhysicsObjectWithMesh, PhysicsObject } from '../_engine/core/PhysicsRapier';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { loadTexture } from '../_engine/core/Texture';
import { createCharacter } from '../_engine/core/Character';

export const SCENE_TEST_CHARACTER_ID = 'characterTest1';

export const sceneCharacterTest = async () =>
  new Promise<string>(async (resolve) => {
    const updateLoaderFn = getLoaderStatusUpdater();
    updateLoaderFn({ loadedCount: 0, totalCount: 2 });

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
    const charCapsule = createGeometry({
      id: 'charCapsule1',
      type: 'CAPSULE',
      params: { radius: 0.5, height: 0.58 },
    });
    const charMaterial = createMaterial({
      id: 'box1Material',
      type: 'PHONG',
      params: {
        map: loadTexture({
          id: 'box1Texture',
          fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
        }),
      },
    });
    const charMesh = createMesh({ id: 'charMesh1', geo: charCapsule, mat: charMaterial });
    const directionBeakMesh = createMesh({
      id: 'directionBeakMesh',
      geo: createGeometry({
        id: 'directionBeakGeo',
        type: 'BOX',
        params: { width: 0.25, height: 0.25, depth: 0.44 },
      }),
      mat: createMaterial({ id: 'directionBeakMat', type: 'BASIC', params: { color: '#a3650d' } }),
    });
    directionBeakMesh.position.set(0.35, 0.43, 0);
    charMesh.add(directionBeakMesh);
    const maxSpeed = 5;
    createCharacter(
      'testCharacter1',
      {
        collider: {
          type: 'CAPSULE',
          restitution: 0.8,
          friction: 2,
        },
        rigidBody: {
          rigidType: 'DYNAMIC',
          lockRotations: { x: true, y: true, z: true },
        },
      },
      charMesh,
      [
        {
          id: 'charForward',
          key: 'w',
          type: 'KEY_DOWN',
          fn: (_, __, data) => {
            if (data && 'physObj' in data) {
              const physObj = data.physObj as PhysicsObject;
              const linvel = physObj.rigidBody?.linvel();
              console.log('LINVEL W', linvel?.x);
              let velX = (linvel?.x || 0) > maxSpeed ? maxSpeed : linvel?.x || 0;
              let velY = linvel?.y || 0;
              let velZ = (linvel?.z || 0) > maxSpeed ? maxSpeed : linvel?.z || 0;
              if (velX < maxSpeed) {
                physObj.rigidBody?.addForce(new THREE.Vector3(30, 0, 0), true);
              }
              physObj.rigidBody?.setLinvel(new THREE.Vector3(velX, velY, velZ), true);
            }
          },
        },
        {
          id: 'charBackward',
          key: 's',
          type: 'KEY_DOWN',
          fn: (_, __, data) => {
            if (data && 'physObj' in data) {
              const physObj = data.physObj as PhysicsObject;
              const linvel = physObj.rigidBody?.linvel();
              console.log('LINVEL S', linvel?.x);
              let velX = (linvel?.x || 0) < -maxSpeed ? -maxSpeed : linvel?.x || 0;
              let velY = linvel?.y || 0;
              let velZ = (linvel?.z || 0) > maxSpeed ? maxSpeed : linvel?.z || 0;
              if (velX > -maxSpeed) {
                physObj.rigidBody?.addForce(new THREE.Vector3(-30, 0, 0), true);
              }
              physObj.rigidBody?.setLinvel(new THREE.Vector3(velX, velY, velZ), true);
            }
          },
        },
        {
          id: 'charLeft',
          key: 'a',
          type: 'KEY_DOWN',
          fn: (_, __, data) => {
            if (data && 'physObj' in data) {
              const physObj = data.physObj as PhysicsObject;
              const linvel = physObj.rigidBody?.linvel();
              let velX = (linvel?.x || 0) > maxSpeed ? maxSpeed : linvel?.x || 0;
              let velY = linvel?.y || 0;
              let velZ = (linvel?.z || 0) > maxSpeed ? maxSpeed : linvel?.z || 0;
              if (velX < maxSpeed) {
                physObj.rigidBody?.addForce(new THREE.Vector3(0, 0, 30), true);
              }
              physObj.rigidBody?.setLinvel(new THREE.Vector3(velX, velY, velZ), true);
            }
          },
        },
        {
          id: 'charRight',
          key: 'd',
          type: 'KEY_DOWN',
          fn: (_, __, data) => {
            if (data && 'physObj' in data) {
              const physObj = data.physObj as PhysicsObject;
              const linvel = physObj.rigidBody?.linvel();
              let velX = (linvel?.x || 0) > maxSpeed ? maxSpeed : linvel?.x || 0;
              let velY = linvel?.y || 0;
              let velZ = (linvel?.z || 0) > maxSpeed ? maxSpeed : linvel?.z || 0;
              if (velX < maxSpeed) {
                physObj.rigidBody?.addForce(new THREE.Vector3(0, 0, -30), true);
              }
              physObj.rigidBody?.setLinvel(new THREE.Vector3(velX, velY, velZ), true);
            }
          },
        },
        {
          id: 'charStop',
          key: ['w', 's', 'a', 'd'],
          type: 'KEY_UP',
          fn: (_, __, data) => {
            if (data && 'physObj' in data) {
              const physObj = data.physObj as PhysicsObject;
              physObj.rigidBody?.resetForces(true);
            }
          },
        },
      ]
    );
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

    resolve(SCENE_TEST_CHARACTER_ID);
  });
