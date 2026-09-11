import * as THREE from 'three/webgpu';
import { createScene } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity, getMeshByAppId } from '../_engine/core/MeshManager';
import { createSkyBox } from '../_engine/core/SkyBox';
import {
  addScenePhysicsLooper,
  createPhysicsObjectWithMesh,
  getPhysicsObject,
} from '../_engine/core/PhysicsRapier';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { loadTexture, loadTextureAsync } from '../_engine/core/Texture';
import { createDynamicCharacter } from '../_engine/utils/character/dynamicCharacter';
import { characterTestObstacles } from '../_engine/utils/world/characterTestObjects';
import { importModelAsync } from '../_engine/core/ImportModel';
import { addCheckerboardMaterialToMesh } from '../_engine/utils/materials/checkerBoardPattern';
import { getQuatFromAngle } from '../_engine/utils/helpers';
import { createMovingPlatform } from '../_engine/utils/world/movingPlatform';
import { initPhysicsStressTest } from '../_engine/utils/PhysicsStressTest';
import { getTestObstacle } from '../_engine/utils/world/characterTestObstacles';

export const SCENE_THIRD_PERSON_GYM_META = {
  id: 'thirdPersonGymScene',
  text: 'GYM (3rd person)',
};

export const sceneThirdPersonGym = async () =>
  new Promise<string>(async (resolve) => {
    const updateLoaderFn = getLoaderStatusUpdater();
    updateLoaderFn({ loadedCount: 0, totalCount: 2 });

    const scene = createScene(SCENE_THIRD_PERSON_GYM_META.id, {
      name: 'Test scene 1',
      isCurrentScene: true,
    });

    updateLoaderFn({ loadedCount: 1, totalCount: 2 });

    await createSkyBox({
      id: 'stylizedSunsetEquiRect',
      type: 'EQUIRECTANGULAR',
      params: {
        file: '/debugger/assets/testTextures/skyboxes/sunset_stylized/sky_41_4k.png',
        textureId: 'equiRectSunsetStylizedId',
        colorSpace: THREE.SRGBColorSpace,
      },
    });

    await createSkyBox({
      id: 'emptyBlueSkyEquiRect',
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
    createMeshEntity({
      appId: 'largeGroundMesh',
      geo: groundGeo,
      mat: groundMat,
      receiveShadow: true,
      position: groundPos,
    });
    const groundMesh = getMeshByAppId('largeGroundMesh')!;
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

    // OBSTACLES
    const { stairsMesh, stairsPhysicsObject, bigBoxWallMesh, bigBoxWallPhysicsObject } =
      characterTestObstacles();
    (stairsMesh.material as THREE.MeshPhongMaterial).map = uvTexture.clone();
    stairsPhysicsObject?.setTranslation({ x: 5, y: -1.8 });

    const bigBoxWallMat = bigBoxWallMesh.material as THREE.MeshPhongMaterial;
    bigBoxWallMat.map = uvTexture.clone();
    bigBoxWallMat.map.wrapS = THREE.RepeatWrapping;
    bigBoxWallMat.map.wrapT = THREE.RepeatWrapping;
    bigBoxWallMat.map.repeat.set(2.5, 2.5);
    bigBoxWallPhysicsObject?.setTranslation({ x: -2, y: -5 + groundHeight / 2 });

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
    createMeshEntity({
      appId: 'testBox1Mesh',
      geo: geometry2,
      mat: material2,
      castShadow: true,
      receiveShadow: true,
    });
    const box = getMeshByAppId('testBox1Mesh')!;
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

    // CHARACTER
    const characterData = {
      _height: 1.6,
      _radius: 0.5,
    };
    const charCapsule = createGeometry({
      id: 'capsuleDynamicChar',
      type: 'CAPSULE',
      params: {
        radius: characterData._radius,
        height: characterData._height - characterData._radius * 2,
      },
    });
    const charMaterial = createMaterial({
      id: 'materialDynamicChar',
      type: 'PHONG',
      params: {
        map: loadTexture({
          id: 'box1Texture',
          fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
        }),
      },
    });
    createMeshEntity(
      {
        appId: 'directionBeakMeshDynamicChar-1',
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
        position: { x: 0.35, y: 0.43, z: 0 },
      },
      { doNotAddToScene: true }
    );
    const directionBeakMesh = getMeshByAppId('directionBeakMeshDynamicChar-1')!;

    createMeshEntity({
      appId: 'meshDynamicChar-1',
      geo: charCapsule,
      mat: charMaterial,
      receiveShadow: true,
      castShadow: true,
    });
    const characterMesh = getMeshByAppId('meshDynamicChar-1')!;
    characterMesh.add(directionBeakMesh);

    const { dynamicCharacterObject } = createDynamicCharacter({
      id: 'topDownChar',
      charMesh: characterMesh,
      charData: characterData,
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
    charPhysObj?.setTranslation({ x: 5, y: 3, z: -5 });

    // Another character without input
    createMeshEntity(
      {
        appId: 'directionBeakMeshDynamicChar-2',
        geo: createGeometry({
          id: 'directionBeakGeoDynamicChar2',
          type: 'BOX',
          params: { width: 0.25, height: 0.25, depth: 0.7 },
        }),
        mat: createMaterial({
          id: 'directionBeakMatDynamicChar',
          type: 'BASIC',
          params: { color: '#333' },
        }),
        position: { x: 0.35, y: 0.43, z: 0 },
      },
      { doNotAddToScene: true }
    );
    const directionBeakMesh2 = getMeshByAppId('directionBeakMeshDynamicChar-2')!;

    createMeshEntity({
      appId: 'meshDynamicChar-2',
      geo: charCapsule,
      mat: charMaterial,
      receiveShadow: true,
      castShadow: true,
    });
    const characterMesh2 = getMeshByAppId('meshDynamicChar-2')!;
    characterMesh2.add(directionBeakMesh2);

    const { controlFns, dynamicCharacterObject: dummyCharacterObject } = createDynamicCharacter({
      id: 'testDummyChar',
      charMesh: characterMesh2,
      charData: characterData,
    });
    const dummyCharPhysObj = getPhysicsObject(dummyCharacterObject.physObjectId);
    dummyCharPhysObj?.setTranslation({ x: -2, y: 5, z: -2 });

    let action: 'F' | 'T' | null = null;
    let accDelta = 0;
    addScenePhysicsLooper('dummyCharLooper', (delta) => {
      if (accDelta > 1) {
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

    const result = await importModelAsync({
      fileName: '/debugger/assets/testModels/customPropTestCube.glb',
      appId: 'customPropTest',
    });
    if (result.mesh && !Array.isArray(result.mesh)) {
      result.mesh?.position.set(2, 2, 2);
      if (!Array.isArray(result.physObj))
        result.physObj?.rigidBody?.setTranslation(new THREE.Vector3(2, 2, 2), true);
      addCheckerboardMaterialToMesh('checkerMaterial', result.mesh);
      result.mesh.castShadow = true;
      result.mesh.receiveShadow = true;
    }

    // Suzanne (monkey TRIMESH)
    const result2 = await importModelAsync({
      fileName: '/debugger/assets/testModels/customPropTestMonkey.glb',
      appId: 'customPropTest2',
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
    }

    // Suzanne (monkey TRIMESH)
    const result2convex = await importModelAsync({
      fileName: '/debugger/assets/testModels/customPropTestMonkey.glb',
      appId: 'customPropTest2_2',
      importGroup: true,
      physicsParams: {
        isPhysObj: true,
        keepMesh: true,
        rigidBody: { rigidType: 'DYNAMIC' },
        collider: { type: 'CONVEXHULL', density: 2 },
      },
    });
    if (result2convex.mesh && !Array.isArray(result2convex.mesh)) {
      const result2convexPos = [4, 6, 3];
      if (!Array.isArray(result2convex.physObj) && result2convex.physObj) {
        result2convex.physObj.setTranslation({
          x: result2convexPos[0],
          y: result2convexPos[1],
          z: result2convexPos[2],
        });
      }
      addCheckerboardMaterialToMesh('checkerMaterial', result2convex.mesh);
      result2convex.mesh.castShadow = true;
      result2convex.mesh.receiveShadow = true;
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
    }

    const movingPlatformMat = createMaterial({
      id: 'movingPlatform1-mat',
      type: 'PHONG',
      params: { color: '#999' },
    });

    createMeshEntity({
      appId: 'sideWaysPlatformMesh',
      geo: createGeometry({
        id: 'movingPlatform1-geo',
        type: 'BOX',
        params: { width: 2, height: 0.2, depth: 4 },
      }),
      mat: movingPlatformMat,
      castShadow: true,
      receiveShadow: true,
    });
    const sideWaysPlatformMesh = getMeshByAppId('sideWaysPlatformMesh')!;

    createMovingPlatform({
      id: 'sideWaysPlatform',
      scene,
      shape: {
        mesh: sideWaysPlatformMesh,
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

    createMeshEntity({
      appId: 'elevatorPlatformMesh',
      geo: createGeometry({
        id: 'movingPlatform2-geo',
        type: 'BOX',
        params: { width: 4, height: 0.2, depth: 4 },
      }),
      mat: movingPlatformMat,
      castShadow: true,
      receiveShadow: true,
    });
    const elevatorPlatformMesh = getMeshByAppId('elevatorPlatformMesh')!;

    createMovingPlatform({
      id: 'elevatorPlatform',
      scene,
      shape: {
        mesh: elevatorPlatformMesh,
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
    const oneLapDuration = 4000;
    const segmentDur = oneLapDuration / 4;

    createMeshEntity({
      appId: 'carouselPlatformMesh1',
      geo: createGeometry({
        id: 'movingPlatform3-geo',
        type: 'CYLINDER',
        params: { radiusTop: 4, radiusBottom: 4, height: 0.2 },
      }),
      mat: movingPlatformMat,
      castShadow: true,
      receiveShadow: true,
    });
    const carouselPlatformMesh1 = getMeshByAppId('carouselPlatformMesh1')!;

    createMovingPlatform({
      id: 'carouselPlatform',
      scene,
      shape: {
        mesh: carouselPlatformMesh1,
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
    const oneLapDuration2 = 8000;
    const segmentDur2 = oneLapDuration2 / 4;

    createMeshEntity({
      appId: 'carouselPlatformMesh2',
      geo: createGeometry({
        id: 'movingPlatform4-geo',
        type: 'BOX',
        params: { width: 4, height: 0.2, depth: 4 },
      }),
      mat: movingPlatformMat,
      castShadow: true,
      receiveShadow: true,
    });
    const carouselPlatformMesh2 = getMeshByAppId('carouselPlatformMesh2')!;

    createMovingPlatform({
      id: 'carouselPlatform2',
      scene,
      shape: {
        mesh: carouselPlatformMesh2,
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
    const oneLapDuration3 = 8000;
    const segmentDur3 = oneLapDuration3 / 4;

    createMeshEntity({
      appId: 'carouselPlatformMesh3',
      geo: createGeometry({
        id: 'movingPlatform5-geo',
        type: 'CYLINDER',
        params: { radiusTop: 4, radiusBottom: 4, height: 0.2 },
      }),
      mat: movingPlatformMat,
      castShadow: true,
      receiveShadow: true,
    });
    const carouselPlatformMesh3 = getMeshByAppId('carouselPlatformMesh3')!;

    createMovingPlatform({
      id: 'carouselPlatform3',
      scene,
      shape: {
        mesh: carouselPlatformMesh3,
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
    createMeshEntity({
      appId: 'ferrisWheelPlatformMesh',
      geo: createGeometry({
        id: 'movingPlatform6-geo',
        type: 'BOX',
        params: { width: 2, height: 0.2, depth: 4 },
      }),
      mat: movingPlatformMat,
      castShadow: true,
      receiveShadow: true,
    });
    const ferrisWheelPlatformMesh = getMeshByAppId('ferrisWheelPlatformMesh')!;

    createMovingPlatform({
      id: 'ferrisWheelPlatform',
      scene,
      shape: {
        mesh: ferrisWheelPlatformMesh,
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

    const result3 = await importModelAsync({
      fileName: '/debugger/assets/testModels/test_multi_box.glb',
      appId: 'customPropTest3',
      importGroup: true,
    });
    if (result3.mesh && !Array.isArray(result3.mesh)) {
      result3.mesh?.position.set(2, 2, 2);
      if (!Array.isArray(result3.physObj))
        result3.physObj?.rigidBody?.setTranslation(new THREE.Vector3(2, 2, 2), true);
      addCheckerboardMaterialToMesh('checkerMaterial', result3.mesh, {
        useConstantCheckerSize: true,
      });
      result3.mesh.castShadow = true;
      result3.mesh.receiveShadow = true;
    }

    // Straight stairs (TRIMESH)
    const result4 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraightTrimesh.glb',
      appId: 'customPropTest4',
      importGroup: true,
    });
    if (result4.mesh && !Array.isArray(result4.mesh)) {
      const result4Position = [37, -0.4, 5];
      result4.mesh?.position.set(result4Position[0], result4Position[1], result4Position[2]);
      if (!Array.isArray(result4.physObj))
        result4.physObj?.rigidBody?.setTranslation(
          new THREE.Vector3(result4Position[0], result4Position[1], result4Position[2]),
          true
        );
      result4.mesh.castShadow = true;
      result4.mesh.receiveShadow = true;
      result4.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Straight stairs (COMPOUND)
    const result5 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraightCompound.glb',
      appId: 'customPropTest5',
      importGroup: true,
    });
    if (result5.mesh && !Array.isArray(result5.mesh)) {
      const result5Position = [45, -0.4, 5];
      result5.mesh.position.set(result5Position[0], result5Position[1], result5Position[2]);
      if (!Array.isArray(result5.physObj))
        result5.physObj?.rigidBody?.setTranslation(
          new THREE.Vector3(result5Position[0], result5Position[1], result5Position[2]),
          true
        );
      result5.mesh.castShadow = true;
      result5.mesh.receiveShadow = true;
      result5.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Straight stairs 2 (TRIMESH)
    const result6 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraight2Trimesh.glb',
      appId: 'customPropTest6',
      importGroup: true,
    });
    if (result6.mesh && !Array.isArray(result6.mesh)) {
      const result6Position = [53, -0.4, 5];
      result6.mesh?.position.set(result6Position[0], result6Position[1], result6Position[2]);
      if (!Array.isArray(result6.physObj))
        result6.physObj?.rigidBody?.setTranslation(
          new THREE.Vector3(result6Position[0], result6Position[1], result6Position[2]),
          true
        );
      result6.mesh.castShadow = true;
      result6.mesh.receiveShadow = true;
      result6.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Straight stairs 2 (COMPOUND)
    const result7 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraight2Compound.glb',
      appId: 'customPropTest7',
      importGroup: true,
    });
    if (result7.mesh && !Array.isArray(result7.mesh)) {
      const result7Position = [61, -0.4, 5];
      result7.mesh.position.set(result7Position[0], result7Position[1], result7Position[2]);
      if (!Array.isArray(result7.physObj))
        result7.physObj?.rigidBody?.setTranslation(
          new THREE.Vector3(result7Position[0], result7Position[1], result7Position[2]),
          true
        );
      result7.mesh.castShadow = true;
      result7.mesh.receiveShadow = true;
      result7.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Straight stairs 3 (TRIMESH)
    const result8 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraight3Trimesh.glb',
      appId: 'customPropTest8',
      importGroup: true,
    });
    if (result8.mesh && !Array.isArray(result8.mesh)) {
      const result8Position = [69, -0.4, 5];
      result8.mesh?.position.set(result8Position[0], result8Position[1], result8Position[2]);
      if (!Array.isArray(result8.physObj))
        result8.physObj?.rigidBody?.setTranslation(
          new THREE.Vector3(result8Position[0], result8Position[1], result8Position[2]),
          true
        );
      result8.mesh.castShadow = true;
      result8.mesh.receiveShadow = true;
      result8.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Straight stairs 3 (COMPOUND)
    const result9 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraight3Compound.glb',
      appId: 'customPropTest9',
      importGroup: true,
    });
    if (result9.mesh && !Array.isArray(result9.mesh)) {
      const result9Position = [77, -0.4, 5];
      result9.mesh.position.set(result9Position[0], result9Position[1], result9Position[2]);
      if (!Array.isArray(result9.physObj))
        result9.physObj?.rigidBody?.setTranslation(
          new THREE.Vector3(result9Position[0], result9Position[1], result9Position[2]),
          true
        );
      result9.mesh.castShadow = true;
      result9.mesh.receiveShadow = true;
      result9.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Cornered stairs with thick railings (COMPOUND)
    const result10 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsCorneredWithThickRailingsCompound.glb',
      appId: 'customPropTest10',
      importGroup: true,
    });
    if (result10.mesh && !Array.isArray(result10.mesh)) {
      const result10Position = [45, -0.4, 35];
      if (!Array.isArray(result10.physObj)) {
        result10.physObj?.setTranslation({
          x: result10Position[0],
          y: result10Position[1],
          z: result10Position[2],
        });
      }
      result10.mesh.castShadow = true;
      result10.mesh.receiveShadow = true;
      result10.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Cornered stairs with thick railings (TRIMESH)
    const result11 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsCorneredWithThickRailingsTrimesh.glb',
      appId: 'customPropTest11',
      importGroup: true,
    });
    if (result11.mesh && !Array.isArray(result11.mesh)) {
      const result11Position = [60, -0.4, 35];
      if (!Array.isArray(result11.physObj)) {
        result11.physObj?.setTranslation({
          x: result11Position[0],
          y: result11Position[1],
          z: result11Position[2],
        });
      }
      result11.mesh.castShadow = true;
      result11.mesh.receiveShadow = true;
      result11.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Spiral stairs (TRIMESH)
    const result12 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsSpiralTrimesh.glb',
      appId: 'customPropTest12',
      importGroup: true,
    });
    if (result12.mesh && !Array.isArray(result12.mesh)) {
      const result12Position = [20, 1.8, 33];
      if (!Array.isArray(result12.physObj)) {
        result12.physObj?.setTranslation({
          x: result12Position[0],
          y: result12Position[1],
          z: result12Position[2],
        });
      }
      result12.mesh.castShadow = true;
      result12.mesh.receiveShadow = true;
      result12.mesh.material = createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      });
    }

    // Spiked terrain
    const result13 = await importModelAsync({
      fileName: '/debugger/assets/testModels/terrainSpiked.glb',
      appId: 'customPropTest13',
      importGroup: true,
      allMeshesVisible: true,
    });
    if (result13.group) {
      const result13Position = [-25, -1.8, 126.336];
      for (let i = 0; i < result13.group.children.length; i++) {
        const child = result13.group.children[i] as THREE.Mesh;
        child.castShadow = true;
        child.receiveShadow = true;
        child.material = createMaterial({
          id: 'stairsStraightTrimeshMaterial',
          type: 'PHONG',
          params: { color: '#999' },
        });
      }
      if (!Array.isArray(result13.physObj)) {
        result13.physObj?.setTranslation(
          {
            x: result13Position[0],
            y: result13Position[1],
            z: result13Position[2],
          },
          result13.group
        );
      }
    }

    // Smooth terrain
    const result14 = await importModelAsync({
      fileName: '/debugger/assets/testModels/terrainSmooth.glb',
      appId: 'customPropTest14',
      importGroup: true,
      allMeshesVisible: true,
    });
    if (result14.group) {
      const result14Position = [52.635, -1.8, 150.833];
      for (let i = 0; i < result14.group.children.length; i++) {
        const child = result14.group.children[i] as THREE.Mesh;
        child.castShadow = true;
        child.receiveShadow = true;
        child.material = createMaterial({
          id: 'stairsStraightTrimeshMaterial',
          type: 'PHONG',
          params: { color: '#999' },
        });
      }
      if (!Array.isArray(result14.physObj)) {
        result14.physObj?.setTranslation(
          {
            x: result14Position[0],
            y: result14Position[1],
            z: result14Position[2],
          },
          result14.group
        );
      }
    }

    // Obstacles
    const result15 = await importModelAsync({
      fileName: '/debugger/assets/testModels/obstacles.glb',
      appId: 'customPropTest15',
      importGroup: true,
      allMeshesVisible: true,
    });
    if (result15.group) {
      const result15Position = [-30, -1, 30];
      for (let i = 0; i < result15.group.children.length; i++) {
        const child = result15.group.children[i] as THREE.Mesh;
        child.castShadow = true;
        child.receiveShadow = true;
        child.material = createMaterial({
          id: 'stairsStraightTrimeshMaterial',
          type: 'PHONG',
          params: { color: '#999' },
        });
      }
      if (!Array.isArray(result15.physObj)) {
        result15.physObj?.setTranslation(
          {
            x: result15Position[0],
            y: result15Position[1],
            z: result15Position[2],
          },
          result15.group
        );
      }
    }

    initPhysicsStressTest();

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE_THIRD_PERSON_GYM_META.id);
  });
