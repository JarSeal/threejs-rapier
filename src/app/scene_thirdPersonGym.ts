import * as THREE from 'three/webgpu';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity, getMeshByAppId } from '../_engine/core/MeshManager';
import { createSkyBox } from '../_engine/core/SkyBox';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { loadTexture, loadTextureAsync } from '../_engine/core/Texture';
import { createDynamicCharacter } from '../_engine/utils/character/dynamicCharacter';
import { characterTestObstacles } from '../_engine/utils/world/characterTestObjects';
import { importAssetAsync } from '../_engine/core/Import/ImportRegistry';
import { spawnImportedAsset } from '../_engine/core/Import/SpawnImported';
import type {
  ImportedAssetManifest,
  SpawnImportedResult,
} from '../_engine/core/Import/ImportTypes';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { addCheckerboardMaterialToMesh } from '../_engine/utils/materials/checkerBoardPattern';
import { getQuatFromAngle } from '../_engine/utils/helpers';
import { createMovingPlatform } from '../_engine/utils/world/movingPlatform';
import { initPhysicsStressTest } from '../_engine/utils/PhysicsStressTest';
import { getTestObstacle } from '../_engine/utils/world/characterTestObstacles';
import { getECSWorld } from '../_engine/core/ECS';
import { getScene, registerOnSceneExit } from '../_engine/core/Scene';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';
import { getCameraByAppId } from '../_engine/core/CameraManager';
import { createFollowObjectCameraRig } from '../_engine/utils/cameras/followObjectCameraRig';
import { ECSSystemStage } from '../AppECSRegistry';

export const SCENE_THIRD_PERSON_GYM_META = {
  id: 'thirdPersonGymScene',
};

const TEST_MODELS = '/debugger/assets/testModels';

/** Root transform that puts an import's first visible node (its first mesh, which is also its
 * physics anchor) at `pos`: these models were positioned by that node, not by their glTF root. */
const rootPlacing = (manifest: ImportedAssetManifest, pos: { x: number; y: number; z: number }) => {
  const anchor = manifest.geometries.find(
    ({ customProps }) => !customProps.isPhysObj || customProps.keepMesh
  );
  const offset = anchor?.transform.position || { x: 0, y: 0, z: 0 };
  return { position: { x: pos.x - offset.x, y: pos.y - offset.y, z: pos.z - offset.z } };
};

/** The rendered meshes of a spawned import (for per-mesh materials like the checkerboard). */
const getSpawnedMeshes = (result: SpawnImportedResult) =>
  result.meshEntityIds.map(
    (id) => getECSWorld().getComponent(id, ComponentType.OBJECT3D)?.value as THREE.Mesh
  );

/** Same as setImportedRigidBodyTranslation, but for a partial {x?, y?, z?} update (matching the
 * legacy PhysicsObject.setTranslation's partial-update signature) — reads the body's current
 * position for any axis not provided. */
const setImportedRigidBodyTranslationPartial = (
  entityId: number,
  pos: { x?: number; y?: number; z?: number }
) => {
  const body = getECSWorld().getRigidBody(entityId);
  if (!body) return;
  body.setTranslation(
    { x: pos.x ?? body.pos.x, y: pos.y ?? body.pos.y, z: pos.z ?? body.pos.z },
    true
  );
};

export const scene = async () =>
  new Promise(async (resolve) => {
    const updateLoaderFn = getLoaderStatusUpdater();
    updateLoaderFn({ loadedCount: 0, totalCount: 2 });

    // Scene itself is already created by registerScenesFromGeneratedData() from this scene's
    // *.scene.json before this function ever runs (matches scene01.ts/physicsTest.ts) —
    // createMovingPlatform still needs the THREE.Group to add a platform mesh to if one isn't
    // already parented (it normally is, via createMeshEntity's own scene-add default).
    const scene = getScene(SCENE_THIRD_PERSON_GYM_META.id, false, true)!;

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
    const groundEntityId = createMeshEntity(
      { geo: groundGeo, mat: groundMat, receiveShadow: true, position: groundPos },
      { appId: 'largeGroundMesh' }
    );
    await createPhysicsEntity(
      { type: 'BOX', friction: 2 },
      { rigidType: 'FIXED', translation: groundPos },
      groundEntityId
    );
    // OBSTACLES
    const { stairsMesh, stairsEntityId, bigBoxWallMesh, bigBoxWallEntityId } =
      await characterTestObstacles();
    (stairsMesh.material as THREE.MeshPhongMaterial).map = uvTexture.clone();
    setImportedRigidBodyTranslationPartial(stairsEntityId, { x: 5, y: -1.8 });

    const bigBoxWallMat = bigBoxWallMesh.material as THREE.MeshPhongMaterial;
    bigBoxWallMat.map = uvTexture.clone();
    bigBoxWallMat.map.wrapS = THREE.RepeatWrapping;
    bigBoxWallMat.map.wrapT = THREE.RepeatWrapping;
    bigBoxWallMat.map.repeat.set(2.5, 2.5);
    setImportedRigidBodyTranslationPartial(bigBoxWallEntityId, {
      x: -2,
      y: -5 + groundHeight / 2,
    });

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
    const boxEntityId = createMeshEntity(
      { geo: geometry2, mat: material2, castShadow: true, receiveShadow: true },
      { appId: 'testBox1Mesh' }
    );
    await createPhysicsEntity(
      { type: 'BOX', restitution: 0.5, friction: 0 },
      {
        rigidType: 'DYNAMIC',
        translation: { x: 2, y: 0, z: 0 },
        angvel: { x: 1, y: -2, z: 20 },
      },
      boxEntityId
    );

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
      { appId: 'directionBeakMeshDynamicChar-1', doNotAddToScene: true }
    );
    const directionBeakMesh = getMeshByAppId('directionBeakMeshDynamicChar-1')!;

    createMeshEntity(
      { geo: charCapsule, mat: charMaterial, receiveShadow: true, castShadow: true },
      { appId: 'meshDynamicChar-1' }
    );
    const characterMesh = getMeshByAppId('meshDynamicChar-1')!;
    characterMesh.add(directionBeakMesh);

    const { dynamicCharacterObject } = await createDynamicCharacter({
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
    getECSWorld()
      .getRigidBody(dynamicCharacterObject.entityId)
      ?.setTranslation({ x: 5, y: 3, z: -5 }, true);

    // Follow camera tracking the player-controlled character from above.
    createFollowObjectCameraRig({
      id: 'thirdPersonGymFollowCam',
      camera: getCameraByAppId('thirdPersonGymCamera')!,
      targetMesh: characterMesh,
      // Legacy gym's rig values (world-space offset, aimed at the character's center)
      offset: { x: 7, y: 20, z: 7 },
      smoothingTime: 0.2,
    });

    // Another character without input
    createMeshEntity(
      {
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
      { appId: 'directionBeakMeshDynamicChar-2', doNotAddToScene: true }
    );
    const directionBeakMesh2 = getMeshByAppId('directionBeakMeshDynamicChar-2')!;

    createMeshEntity(
      { geo: charCapsule, mat: charMaterial, receiveShadow: true, castShadow: true },
      { appId: 'meshDynamicChar-2' }
    );
    const characterMesh2 = getMeshByAppId('meshDynamicChar-2')!;
    characterMesh2.add(directionBeakMesh2);

    const { controlFns, dynamicCharacterObject: dummyCharacterObject } =
      await createDynamicCharacter({
        id: 'testDummyChar',
        charMesh: characterMesh2,
        charData: characterData,
      });
    getECSWorld()
      .getRigidBody(dummyCharacterObject.entityId)
      ?.setTranslation({ x: -2, y: 5, z: -2 }, true);

    // A named ECS system re-registered on every scene load would be a silent no-op the second
    // time (world.addSystem ignores a duplicate id) — remove any stale registration from a
    // previous load of this scene first, since it'd otherwise keep running against this
    // instance's now-deleted character/controlFns closure.
    let action: 'F' | 'T' | null = null;
    let accDelta = 0;
    getECSWorld().removeSystem('dummyCharLooper');
    // ...and remove it on leaving too, or it would keep driving the deleted dummy character.
    registerOnSceneExit(SCENE_THIRD_PERSON_GYM_META.id, () =>
      getECSWorld().removeSystem('dummyCharLooper')
    );
    getECSWorld().addSystem(ECSSystemStage.APP_PHYSICS_STEP, 'dummyCharLooper', (_world, dt) => {
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
      accDelta += dt;
    });

    const cube = await importAssetAsync({ fileName: `${TEST_MODELS}/customPropTestCube.glb` });
    const monkey = await importAssetAsync({ fileName: `${TEST_MODELS}/customPropTestMonkey.glb` });
    const multiBox = await importAssetAsync({ fileName: `${TEST_MODELS}/test_multi_box.glb` });
    if (!cube || !monkey || !multiBox) throw new Error('Could not import the gym test models.');

    const cubeResult = await spawnImportedAsset(cube, {
      transform: rootPlacing(cube, { x: 2, y: 2, z: 2 }),
      castShadow: true,
      receiveShadow: true,
      entityOpts: { appId: 'customPropTest' },
    });
    for (const m of getSpawnedMeshes(cubeResult))
      addCheckerboardMaterialToMesh('checkerMaterial', m);

    // Suzanne (monkey TRIMESH)
    const monkeyTrimesh = await spawnImportedAsset(monkey, {
      transform: rootPlacing(monkey, { x: 4, y: 2, z: 3 }),
      castShadow: true,
      receiveShadow: true,
      physicsParams: {
        isPhysObj: true,
        keepMesh: true,
        rigidBody: { rigidType: 'DYNAMIC' },
        collider: { type: 'TRIMESH', density: 2 },
      },
      entityOpts: { appId: 'customPropTest2' },
    });
    for (const m of getSpawnedMeshes(monkeyTrimesh)) {
      addCheckerboardMaterialToMesh('checkerMaterial', m);
    }

    // Suzanne (monkey CONVEXHULL)
    const monkeyConvex = await spawnImportedAsset(monkey, {
      transform: rootPlacing(monkey, { x: 4, y: 6, z: 3 }),
      castShadow: true,
      receiveShadow: true,
      physicsParams: {
        isPhysObj: true,
        keepMesh: true,
        rigidBody: { rigidType: 'DYNAMIC' },
        collider: { type: 'CONVEXHULL', density: 2 },
      },
      entityOpts: { appId: 'customPropTest2_2' },
    });
    for (const m of getSpawnedMeshes(monkeyConvex)) {
      addCheckerboardMaterialToMesh('checkerMaterial', m);
    }

    const slideTexture = uvTexture.clone();
    slideTexture.wrapS = THREE.RepeatWrapping;
    slideTexture.wrapT = THREE.RepeatWrapping;
    slideTexture.repeat.set(34, 34);
    // Registered (not a clone of bigBoxWallMesh's material, which would carry its id) so it and
    // its map are disposed when the slide is deleted
    const slideMat = createMaterial({
      id: 'slideAnglesMat',
      type: 'PHONG',
      params: { color: '#999', map: slideTexture },
    });
    await getTestObstacle('slideAngles', {
      transform: { position: { x: 30, y: -1.9, z: -30 } },
      material: slideMat,
      castShadow: true,
      receiveShadow: true,
      physicsParams: { collider: { type: 'TRIMESH', friction: 1 } },
    });

    const movingPlatformMat = createMaterial({
      id: 'movingPlatform1-mat',
      type: 'PHONG',
      params: { color: '#999' },
    });

    createMeshEntity(
      {
        geo: createGeometry({
          id: 'movingPlatform1-geo',
          type: 'BOX',
          params: { width: 2, height: 0.2, depth: 4 },
        }),
        mat: movingPlatformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'sideWaysPlatformMesh' }
    );
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

    createMeshEntity(
      {
        geo: createGeometry({
          id: 'movingPlatform2-geo',
          type: 'BOX',
          params: { width: 4, height: 0.2, depth: 4 },
        }),
        mat: movingPlatformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'elevatorPlatformMesh' }
    );
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

    createMeshEntity(
      {
        geo: createGeometry({
          id: 'movingPlatform3-geo',
          type: 'CYLINDER',
          params: { radiusTop: 4, radiusBottom: 4, height: 0.2 },
        }),
        mat: movingPlatformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'carouselPlatformMesh1' }
    );
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

    createMeshEntity(
      {
        geo: createGeometry({
          id: 'movingPlatform4-geo',
          type: 'BOX',
          params: { width: 4, height: 0.2, depth: 4 },
        }),
        mat: movingPlatformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'carouselPlatformMesh2' }
    );
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

    createMeshEntity(
      {
        geo: createGeometry({
          id: 'movingPlatform5-geo',
          type: 'CYLINDER',
          params: { radiusTop: 4, radiusBottom: 4, height: 0.2 },
        }),
        mat: movingPlatformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'carouselPlatformMesh3' }
    );
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
    createMeshEntity(
      {
        geo: createGeometry({
          id: 'movingPlatform6-geo',
          type: 'BOX',
          params: { width: 2, height: 0.2, depth: 4 },
        }),
        mat: movingPlatformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'ferrisWheelPlatformMesh' }
    );
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

    const multiBoxResult = await spawnImportedAsset(multiBox, {
      transform: rootPlacing(multiBox, { x: 2, y: 2, z: 2 }),
      castShadow: true,
      receiveShadow: true,
      entityOpts: { appId: 'customPropTest3' },
    });
    for (const m of getSpawnedMeshes(multiBoxResult)) {
      addCheckerboardMaterialToMesh('checkerMaterial', m, { useConstantCheckerSize: true });
    }

    const stairsAndTerrainMat = createMaterial({
      id: 'stairsStraightTrimeshMaterial',
      type: 'PHONG',
      params: { color: '#999' },
    });
    // Stairs are positioned by their first visible node, terrains and obstacles by their glTF root
    const staticModels: {
      file: string;
      appId: string;
      pos: { x: number; y: number; z: number };
      placeBy: 'FIRST_MESH' | 'ROOT';
    }[] = [
      // Straight stairs (TRIMESH)
      {
        file: 'stairsStraightTrimesh',
        appId: 'customPropTest4',
        pos: { x: 37, y: -0.4, z: 5 },
        placeBy: 'FIRST_MESH',
      },
      // Straight stairs (COMPOUND)
      {
        file: 'stairsStraightCompound',
        appId: 'customPropTest5',
        pos: { x: 45, y: -0.4, z: 5 },
        placeBy: 'FIRST_MESH',
      },
      // Straight stairs 2 (TRIMESH)
      {
        file: 'stairsStraight2Trimesh',
        appId: 'customPropTest6',
        pos: { x: 53, y: -0.4, z: 5 },
        placeBy: 'FIRST_MESH',
      },
      // Straight stairs 2 (COMPOUND)
      {
        file: 'stairsStraight2Compound',
        appId: 'customPropTest7',
        pos: { x: 61, y: -0.4, z: 5 },
        placeBy: 'FIRST_MESH',
      },
      // Straight stairs 3 (TRIMESH)
      {
        file: 'stairsStraight3Trimesh',
        appId: 'customPropTest8',
        pos: { x: 69, y: -0.4, z: 5 },
        placeBy: 'FIRST_MESH',
      },
      // Straight stairs 3 (COMPOUND)
      {
        file: 'stairsStraight3Compound',
        appId: 'customPropTest9',
        pos: { x: 77, y: -0.4, z: 5 },
        placeBy: 'FIRST_MESH',
      },
      // Cornered stairs with thick railings (COMPOUND)
      {
        file: 'stairsCorneredWithThickRailingsCompound',
        appId: 'customPropTest10',
        pos: { x: 45, y: -0.4, z: 35 },
        placeBy: 'FIRST_MESH',
      },
      // Cornered stairs with thick railings (TRIMESH)
      {
        file: 'stairsCorneredWithThickRailingsTrimesh',
        appId: 'customPropTest11',
        pos: { x: 60, y: -0.4, z: 35 },
        placeBy: 'FIRST_MESH',
      },
      // Spiral stairs (TRIMESH)
      {
        file: 'stairsSpiralTrimesh',
        appId: 'customPropTest12',
        pos: { x: 20, y: 1.8, z: 33 },
        placeBy: 'FIRST_MESH',
      },
      // Spiked terrain
      {
        file: 'terrainSpiked',
        appId: 'customPropTest13',
        pos: { x: -25, y: -1.8, z: 126.336 },
        placeBy: 'ROOT',
      },
      // Smooth terrain
      {
        file: 'terrainSmooth',
        appId: 'customPropTest14',
        pos: { x: 52.635, y: -1.8, z: 150.833 },
        placeBy: 'ROOT',
      },
      // Obstacles
      {
        file: 'obstacles',
        appId: 'customPropTest15',
        pos: { x: -30, y: -1, z: 30 },
        placeBy: 'ROOT',
      },
    ];
    for (const { file, appId, pos, placeBy } of staticModels) {
      const manifest = await importAssetAsync({ fileName: `${TEST_MODELS}/${file}.glb` });
      if (!manifest) continue;
      await spawnImportedAsset(manifest, {
        transform: placeBy === 'ROOT' ? { position: pos } : rootPlacing(manifest, pos),
        material: stairsAndTerrainMat,
        castShadow: true,
        receiveShadow: true,
        entityOpts: { appId },
      });
    }

    initPhysicsStressTest();

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE_THIRD_PERSON_GYM_META.id);
  });
