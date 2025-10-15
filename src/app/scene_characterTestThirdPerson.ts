import * as THREE from 'three/webgpu';
import { createScene, createSceneAppLooper } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createLight } from '../_engine/core/Light';
import { createMesh } from '../_engine/core/Mesh';
import { createSkyBox } from '../_engine/core/SkyBox';
import { getCurrentCamera } from '../_engine/core/Camera';
import { createPhysicsObjectWithMesh, getPhysicsObject } from '../_engine/core/PhysicsRapier';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { loadTexture, loadTextureAsync } from '../_engine/core/Texture';
import { createThirdPersonCharacter } from './character_thirdPerson';
import { characterTestObjects } from './character_test_objects';
import { castRayFromAngle, castRayFromPoints } from '../_engine/core/Raycast';

export const SCENE_TEST_CHARACTER_ID = 'charThirdPerson1';

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

    // UV texture
    const uvTexture = await loadTextureAsync({
      id: 'largeGroundTexture',
      fileName: '/debugger/assets/testTextures/UVMaps/UVCheckerMap-grey-white-512.png',
    });

    // Ground
    const groundWidthAndDepth = 50;
    const groundHeight = 0.2;
    const groundPos = { x: 0, y: -2, z: 0 };
    const groundGeo = createGeometry({
      id: 'largeGroundGeo',
      type: 'BOX',
      params: { width: groundWidthAndDepth, height: groundHeight, depth: groundWidthAndDepth },
    });
    const groundTexture = uvTexture.clone();
    groundTexture.wrapS = THREE.RepeatWrapping;
    groundTexture.wrapT = THREE.RepeatWrapping;
    groundTexture.repeat.set(groundWidthAndDepth / 4, groundWidthAndDepth / 4);
    const groundMat = createMaterial({
      id: 'largeGroundMat',
      type: 'PHONG',
      params: { map: groundTexture },
    });
    const groundMesh = createMesh({
      id: 'largeGroundMesh',
      geo: groundGeo,
      mat: groundMat,
      receiveShadow: true,
    });
    groundMesh.position.set(groundPos.x, groundPos.y, groundPos.z);
    createPhysicsObjectWithMesh({
      physicsParams: {
        collider: {
          type: 'BOX',
          friction: 2,
        },
        rigidBody: { rigidType: 'FIXED', translation: groundPos },
      },
      meshOrMeshId: groundMesh,
    });
    scene.add(groundMesh);

    // OBSTACLES
    const { stairsMesh, stairsPhysicsObject, bigBoxWallMesh, bigBoxWallPhysicsObject } =
      characterTestObjects();
    (stairsMesh.material as THREE.MeshPhongMaterial).map = uvTexture.clone();
    scene.add(stairsMesh);
    stairsPhysicsObject?.setTranslation({ x: 5, y: -1.8 });

    const bigBoxWallMat = bigBoxWallMesh.material as THREE.MeshPhongMaterial;
    bigBoxWallMat.map = uvTexture.clone();
    bigBoxWallMat.map.wrapS = THREE.RepeatWrapping;
    bigBoxWallMat.map.wrapT = THREE.RepeatWrapping;
    bigBoxWallMat.map.repeat.set(2.5, 2.5);
    bigBoxWallPhysicsObject?.setTranslation({ x: -2, y: -5 + groundHeight / 2 });
    scene.add(bigBoxWallMesh);

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
    createPhysicsObjectWithMesh({
      physicsParams: {
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
      meshOrMeshId: box,
    });
    box.castShadow = true;
    box.receiveShadow = true;
    scene.add(box);

    // CHARACTER
    const { charMesh, thirdPersonCharacterObject } = createThirdPersonCharacter();
    const charPhysObj = getPhysicsObject(thirdPersonCharacterObject.physObjectId);
    charPhysObj?.setTranslation({ x: 5, y: 5, z: -5 });
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

    createSceneAppLooper(() => {
      castRayFromAngle(
        scene.children,
        new THREE.Vector3(0, 3, 0),
        new THREE.Euler(0, Math.PI / 2, Math.PI / 4),
        {
          startLength: 0,
          endLength: 2,
          helperId: 'helper1',
          helperColor: '#ff0000',
          directionForAngle: 'RIGHT',
        }
      );
      castRayFromPoints(scene.children, new THREE.Vector3(0, 5, 0), new THREE.Vector3(1, 0, 0), {
        startLength: 0,
        endLength: 2,
        helperId: 'helper2',
        helperColor: '#ffee22',
      });
    });

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE_TEST_CHARACTER_ID);
  });
