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
import { createDynamicCharacter } from '../_engine/utils/character/dynamicCharacter';
import { characterTestObstacles } from '../_engine/utils/world/characterTestObjects';
import { importModelAsync } from '../_engine/core/ImportModel';
import { addCheckerboardMaterialToMesh } from '../public/debugger/assets/materials/checkerBoardPattern';
import { getTestObstacle } from '../public/debugger/assets/obstacles/characterTestObstacles';
import { getQuatFromAngle } from '../_engine/utils/helpers';
import { createMovingPlatform } from '../_engine/utils/world/movingPlatform';
import { initPhysicsStressTest } from '../_engine/utils/PhysicsStressTest';

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
      id: 'stylizedSunsetEquiRect',
      name: 'Stylized Sunset EquiRect 4K',
      type: 'EQUIRECTANGULAR',
      params: {
        file: '/debugger/assets/testTextures/skyboxes/sunset_stylized/sky_41_4k.png',
        textureId: 'equiRectSunsetStylizedId',
        colorSpace: THREE.SRGBColorSpace,
        // colorSpace: THREE.LinearSRGBColorSpace,
        // colorSpace: THREE.NoColorSpace,
      },
    });
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
    await createSkyBox({
      id: 'partly-cloudy',
      type: 'EQUIRECTANGULAR',
      params: {
        // file: envTexture,
        // file: '/assets/testTextures/kloofendal_48d_partly_cloudy_skyandground_8k.png',
        file: '/debugger/assets/testTextures/kloofendal_48d_partly_cloudy_puresky_4k.hdr',
        // file: '/assets/testTextures/kloofendal_48d_partly_cloudy_puresky_2k.hdr',
        // file: '/assets/testTextures/evening_road_01_puresky_8k.hdr',
        // file: '/assets/testTextures/pizzo_pernice_puresky_8k.hdr',
        textureId: 'equiRectId',
        // colorSpace: THREE.SRGBColorSpace,
        colorSpace: THREE.LinearSRGBColorSpace,
        // colorSpace: THREE.NoColorSpace,
      },
    });
    const map02 = [
      '/cubemap02_positive_x.png',
      '/cubemap02_negative_x.png',
      '/cubemap02_negative_y.png',
      '/cubemap02_positive_y.png',
      '/cubemap02_positive_z.png',
      '/cubemap02_negative_z.png',
    ];
    await createSkyBox({
      id: 'desert-dunes',
      type: 'CUBETEXTURE',
      params: {
        fileNames: map02,
        path: '/debugger/assets/testTextures',
        textureId: 'cubeTextureId',
        flipY: true,
      },
    });
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

    // UV texture
    const uvTexture = await loadTextureAsync({
      id: 'largeGroundTexture',
      fileName: '/debugger/assets/testTextures/UVMaps/UVCheckerMap-grey-white-512.png',
    });

    // Ground
    const groundWidthAndDepth = 200;
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
      characterTestObstacles();
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
    const { charMesh, dynamicCharacterObject } = createDynamicCharacter({
      id: 'thirdPersonChar',
      inputMappings: {
        rotateLeft: ['a', 'A'],
        rotateRight: ['d', 'D'],
        moveForward: ['w', 'W'],
        moveBackward: ['s', 'S'],
        jump: [' '],
        run: ['Shift'],
        crouch: ['Control'],
      },
    });
    const charPhysObj = getPhysicsObject(dynamicCharacterObject.physObjectId);
    charPhysObj?.setTranslation({ x: 5, y: 5, z: -5 });
    scene.add(charMesh);

    // Another character without input
    const {
      controlFns,
      dynamicCharacterObject: dummyCharacterObject,
      charMesh: dummyCharMesh,
    } = createDynamicCharacter({ id: 'testDummyChar' });
    const dummyCharPhysObj = getPhysicsObject(dummyCharacterObject.physObjectId);
    dummyCharPhysObj?.setTranslation({ x: -2, y: 5, z: -2 });
    scene.add(dummyCharMesh);

    // @TEMP: Set an interval to move the dummy
    let action: 'F' | 'T' | null = null;
    let accDelta = 0;
    createSceneAppLooper((delta) => {
      if (accDelta > 1.5) {
        if (action !== 'F') {
          action = 'F';
          controlFns.jump();
        } else {
          action = 'T';
          controlFns.jump();
        }
        accDelta = 0;
      }
      if (action === 'F') {
        controlFns.move('FORWARD');
      } else {
        controlFns.rotate('LEFT');
      }
      accDelta += delta;
    });

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
        position: { x: -40, y: 12.5, z: 30 },
        color: 0xffe5c7,
        intensity: 5,
        castShadow: true,
        shadowMapSize: [2048, 2048],
        shadowCamNearFar: [10, 250],
        shadowCamLeftRightTopBottom: [-80, 80, 80, -80],
        shadowBias: -0.0009,
        shadowNormalBias: 0.1184,
        shadowRadius: 5, // Not for PCFSoftShadowMap type
        shadowBlurSamples: 10, // Only for VSM shadowmap types
        shadowIntensity: 0.75,
      },
    });
    scene.add(directionalLight);

    // @TODO: remove this test when custom prop importing is done
    const result = await importModelAsync({
      fileName: '/debugger/assets/testModels/customPropTestCube.glb',
      id: 'customPropTest',
      importGroup: true,
      // physicsParams: {
      //   rigidBody: { rigidType: 'FIXED' },
      // },
    });
    if (result.mesh && !Array.isArray(result.mesh)) {
      result.mesh?.position.set(2, 2, 2);
      if (!Array.isArray(result.physObj))
        result.physObj?.rigidBody?.setTranslation(new THREE.Vector3(2, 2, 2), true);
      addCheckerboardMaterialToMesh('checkerMaterial', result.mesh);
      result.mesh.castShadow = true;
      result.mesh.receiveShadow = true;
      scene.add(result.mesh);
    }
    const result2 = await importModelAsync({
      fileName: '/debugger/assets/testModels/customPropTestMonkey.glb',
      id: 'customPropTest',
      importGroup: true,
      physicsParams: {
        isPhysObj: true,
        keepMesh: true,
        rigidBody: { rigidType: 'DYNAMIC' },
        collider: { type: 'TRIMESH', density: 2 },
      },
    });
    if (result2.mesh && !Array.isArray(result2.mesh)) {
      result2.mesh?.position.set(4, 2, 3);
      if (!Array.isArray(result2.physObj))
        result2.physObj?.rigidBody?.setTranslation(new THREE.Vector3(4, 2, 3), true);
      addCheckerboardMaterialToMesh('checkerMaterial', result2.mesh);
      result2.mesh.castShadow = true;
      result2.mesh.receiveShadow = true;
      scene.add(result2.mesh);
    }

    const slides = await getTestObstacle('slideAngles', {
      collider: { type: 'TRIMESH', friction: 1 },
    });
    if (
      slides?.mesh &&
      !Array.isArray(slides.mesh) &&
      slides.physObj &&
      !Array.isArray(slides.physObj)
    ) {
      slides.mesh.castShadow = true;
      slides.mesh.receiveShadow = true;
      slides.mesh.position.set(30, -1.9, -30);
      slides.physObj.rigidBody?.setTranslation(slides.mesh.position, true);

      const slideMat = (
        Array.isArray(bigBoxWallMesh.material)
          ? bigBoxWallMesh.material[0]?.clone()
          : bigBoxWallMesh.material?.clone()
      ) as THREE.MeshPhongMaterial;
      slideMat.map = uvTexture.clone();
      slideMat.map.wrapS = THREE.RepeatWrapping;
      slideMat.map.wrapT = THREE.RepeatWrapping;
      slideMat.map.repeat.set(34, 34);
      slides.mesh.material = slideMat;

      scene.add(slides.mesh);
    }

    const movingPlatformMat = createMaterial({
      id: 'movingPlatform1-mat',
      type: 'PHONG',
      params: { color: '#999' },
    });

    createMovingPlatform({
      id: 'sideWaysPlatform',
      scene,
      shape: {
        mesh: createMesh({
          id: 'sideWaysPlatformMesh',
          geo: createGeometry({
            id: 'movingPlatform1-geo',
            type: 'BOX',
            params: { width: 2, height: 0.2, depth: 4 },
          }),
          mat: movingPlatformMat,
          castShadow: true,
          receiveShadow: true,
        }),
      },
      physicsParams: [
        {
          collider: { type: 'BOX', friction: 0 },
          rigidBody: { rigidType: 'POS_BASED' },
        },
      ],
      points: [
        { pos: { x: -15, y: -1, z: -7 }, dur: 10000 },
        { pos: { x: 5, y: -1, z: -7 }, dur: 5000 },
      ],
    });

    // @TODO: the first point starts at the center (0, 0, 0) and then actually starts from point[1], fix this!
    createMovingPlatform({
      id: 'elevatorPlatform',
      scene,
      shape: {
        mesh: createMesh({
          id: 'elevatorPlatformMesh',
          geo: createGeometry({
            id: 'movingPlatform2-geo',
            type: 'BOX',
            params: { width: 4, height: 0.2, depth: 4 },
          }),
          mat: movingPlatformMat,
          castShadow: true,
          receiveShadow: true,
        }),
      },
      physicsParams: [
        {
          collider: { type: 'BOX', friction: 0 },
          rigidBody: { rigidType: 'POS_BASED' },
        },
      ],
      points: [
        { pos: { x: -12, y: -1.8, z: -12 }, dur: 2000 },
        { pos: { x: -12, y: -1.8, z: -12 }, dur: 3000 },
        { pos: { x: -12, y: 8, z: -12 }, dur: 2000 },
        { pos: { x: -12, y: 8, z: -12 }, dur: 2000 },
        { pos: { x: -12, y: 2, z: -12 }, dur: 2000 },
      ],
    });

    const carouselPos = { x: 14, y: -1.9, z: -4 };
    const oneLapDuration = 4000; // Total time for 360 degrees (ms)
    const segmentDur = oneLapDuration / 4; // Time per 90 degrees
    createMovingPlatform({
      id: 'carouselPlatform',
      scene,
      shape: {
        mesh: createMesh({
          id: 'carouselPlatformMesh1',
          geo: createGeometry({
            id: 'movingPlatform3-geo',
            type: 'CYLINDER',
            params: { radiusTop: 4, radiusBottom: 4, height: 0.2 },
          }),
          mat: movingPlatformMat,
          castShadow: true,
          receiveShadow: true,
        }),
      },
      physicsParams: [
        {
          collider: { type: 'CYLINDER', friction: 0 },
          rigidBody: { rigidType: 'POS_BASED' },
        },
      ],
      points: [
        { pos: carouselPos, dur: segmentDur, rot: getQuatFromAngle(0) },
        { pos: carouselPos, dur: segmentDur, rot: getQuatFromAngle(90) },
        { pos: carouselPos, dur: segmentDur, rot: getQuatFromAngle(180) },
        { pos: carouselPos, dur: segmentDur, rot: getQuatFromAngle(270) },
      ],
    });
    const carouselPos2 = { x: 25, y: -1.9, z: -4 };
    const oneLapDuration2 = 8000; // Total time for 360 degrees (ms)
    const segmentDur2 = oneLapDuration2 / 4; // Time per 90 degrees
    createMovingPlatform({
      id: 'carouselPlatform2',
      scene,
      shape: {
        mesh: createMesh({
          id: 'carouselPlatformMesh2',
          geo: createGeometry({
            id: 'movingPlatform4-geo',
            type: 'BOX',
            params: { width: 4, height: 0.2, depth: 4 },
          }),
          mat: movingPlatformMat,
          castShadow: true,
          receiveShadow: true,
        }),
      },
      physicsParams: [
        {
          collider: { type: 'BOX', friction: 0 },
          rigidBody: { rigidType: 'POS_BASED' },
        },
      ],
      points: [
        { pos: carouselPos2, dur: segmentDur2, rot: getQuatFromAngle(0) },
        { pos: { ...carouselPos2, z: 0 }, dur: segmentDur2, rot: getQuatFromAngle(-90) },
        { pos: { ...carouselPos2, z: 4 }, dur: segmentDur2, rot: getQuatFromAngle(-180) },
        { pos: { ...carouselPos2, z: 0 }, dur: segmentDur2, rot: getQuatFromAngle(-270) },
      ],
    });
    const carouselPos3 = { x: 25, y: -1.9, z: 12 };
    const oneLapDuration3 = 8000; // Total time for 360 degrees (ms)
    const segmentDur3 = oneLapDuration3 / 4; // Time per 90 degrees
    createMovingPlatform({
      id: 'carouselPlatform3',
      scene,
      shape: {
        mesh: createMesh({
          id: 'carouselPlatformMesh3',
          geo: createGeometry({
            id: 'movingPlatform5-geo',
            type: 'CYLINDER',
            params: { radiusTop: 4, radiusBottom: 4, height: 0.2 },
          }),
          mat: movingPlatformMat,
          castShadow: true,
          receiveShadow: true,
        }),
      },
      physicsParams: [
        {
          collider: { type: 'CYLINDER', friction: 0 },
          rigidBody: { rigidType: 'POS_BASED' },
        },
      ],
      points: [
        { pos: carouselPos3, dur: segmentDur3, rot: getQuatFromAngle(0) },
        { pos: { ...carouselPos3, x: 21 }, dur: segmentDur3, rot: getQuatFromAngle(90) },
        { pos: { ...carouselPos3, x: 17 }, dur: segmentDur3, rot: getQuatFromAngle(180) },
        { pos: { ...carouselPos3, x: 21 }, dur: segmentDur3, rot: getQuatFromAngle(270) },
      ],
    });

    const carouselOneSegDur = 1500;
    createMovingPlatform({
      id: 'ferrisWheelPlatform',
      scene,
      shape: {
        mesh: createMesh({
          id: 'ferrisWheelPlatformMesh',
          geo: createGeometry({
            id: 'movingPlatform6-geo',
            type: 'BOX',
            params: { width: 2, height: 0.2, depth: 4 },
          }),
          mat: movingPlatformMat,
          castShadow: true,
          receiveShadow: true,
        }),
      },
      physicsParams: [
        {
          collider: { type: 'BOX', friction: 0 },
          rigidBody: { rigidType: 'POS_BASED' },
        },
      ],
      points: [
        { pos: { x: 5, y: -1.9, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(0) },
        { pos: { x: 7.5, y: -1, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(45) },
        { pos: { x: 10, y: 0, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(90) },
        { pos: { x: 12.5, y: 1, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(135) },
        { pos: { x: 15, y: 2, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(180) },
        { pos: { x: 12.5, y: 3, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(225) },
        { pos: { x: 10, y: 4, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(270) },
        { pos: { x: 7.5, y: 5, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(315) },
        { pos: { x: 5, y: 6, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(0) },
        { pos: { x: 2.5, y: 5, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(45) },
        { pos: { x: 0, y: 4, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(90) },
        { pos: { x: -2.5, y: 3, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(135) },
        { pos: { x: -5, y: 2, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(180) },
        { pos: { x: -2.5, y: 1, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(225) },
        { pos: { x: 0, y: 0, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(270) },
        { pos: { x: 2.5, y: -1, z: 15 }, dur: carouselOneSegDur, rot: getQuatFromAngle(315) },
      ],
    });

    initPhysicsStressTest(scene);

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE_TEST_CHARACTER_ID);
  });
