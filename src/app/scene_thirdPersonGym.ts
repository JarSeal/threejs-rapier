import * as THREE from 'three/webgpu';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity, getMeshByAppId } from '../_engine/core/MeshManager';
import { createSkyBox } from '../_engine/core/SkyBox';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { loadTexture, loadTextureAsync } from '../_engine/core/Texture';
import { createDynamicCharacter } from '../_engine/utils/character/dynamicCharacter';
import { characterTestObstacles } from '../_engine/utils/world/characterTestObjects';
import { importModelAsync, type ImportReturnObj } from '../_engine/core/ImportModel';
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

const toIdArray = (ids?: number | number[]) =>
  Array.isArray(ids) ? ids : typeof ids === 'number' ? [ids] : [];

/** Moves a whole imported model so that its anchor lands at `pos`, with every other piece keeping
 * its glTF-authored offset from that anchor. The anchor is either the entity carrying the (first)
 * rigid body, or the first mesh entity when there's no physics ('RIGID_BODY'), or the imported
 * glTF root's origin ('GROUP_ORIGIN', the legacy `physObj.setTranslation(pos, group)` behavior).
 * world.setTransform moves a piece's rigid body too and writes through the ECS TRANSFORM (a bare
 * Object3D mutation would be reverted by the first TRANSFORM -> Object3D sync). */
const placeImportedModel = (
  result: ImportReturnObj,
  pos: { x: number; y: number; z: number },
  anchorType: 'RIGID_BODY' | 'GROUP_ORIGIN' = 'RIGID_BODY'
) => {
  const ids = [...new Set([...toIdArray(result.physicsEntityId), ...toIdArray(result.meshId)])];
  const ecsWorld = getECSWorld();
  // Imported pieces are created at their glTF-root-local transforms, so the root is at 0,0,0
  const anchor =
    anchorType === 'GROUP_ORIGIN'
      ? { x: 0, y: 0, z: 0 }
      : ids.length
        ? ecsWorld.getPosition(ids[0])
        : undefined;
  if (!anchor) return;
  const offset = { x: pos.x - anchor.x, y: pos.y - anchor.y, z: pos.z - anchor.z };
  for (const id of ids) {
    const current = ecsWorld.getPosition(id);
    if (!current) continue;
    ecsWorld.setTransform(id, {
      pos: { x: current.x + offset.x, y: current.y + offset.y, z: current.z + offset.z },
    });
  }
};

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

const getImportedMeshes = (result: ImportReturnObj): THREE.Mesh[] =>
  Array.isArray(result.mesh) ? result.mesh : result.mesh ? [result.mesh] : [];

/** Applies a shared material + shadow flags to every rendered piece of an imported model */
const applyMaterialToImportedPieces = (
  result: ImportReturnObj,
  material: THREE.Material,
  opts?: { castShadow?: boolean; receiveShadow?: boolean }
) => {
  for (const mesh of getImportedMeshes(result)) {
    mesh.castShadow = opts?.castShadow ?? true;
    mesh.receiveShadow = opts?.receiveShadow ?? true;
    mesh.material = material;
  }
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

    const result = await importModelAsync({
      fileName: '/debugger/assets/testModels/customPropTestCube.glb',
      appId: 'customPropTest',
    });
    placeImportedModel(result, { x: 2, y: 2, z: 2 });
    for (const m of getImportedMeshes(result)) {
      addCheckerboardMaterialToMesh('checkerMaterial', m);
      m.castShadow = true;
      m.receiveShadow = true;
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
    placeImportedModel(result2, { x: 4, y: 2, z: 3 });
    for (const m of getImportedMeshes(result2)) {
      addCheckerboardMaterialToMesh('checkerMaterial', m);
      m.castShadow = true;
      m.receiveShadow = true;
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
    placeImportedModel(result2convex, { x: 4, y: 6, z: 3 });
    for (const m of getImportedMeshes(result2convex)) {
      addCheckerboardMaterialToMesh('checkerMaterial', m);
      m.castShadow = true;
      m.receiveShadow = true;
    }

    const slides = await getTestObstacle('slideAngles', {
      collider: { type: 'TRIMESH', friction: 1 },
    });
    if (slides) {
      placeImportedModel(slides, { x: 30, y: -1.9, z: -30 });
      for (const m of getImportedMeshes(slides)) {
        m.castShadow = true;
        m.receiveShadow = true;
      }

      const slideMat = (
        Array.isArray(bigBoxWallMesh.material)
          ? bigBoxWallMesh.material[0]?.clone()
          : bigBoxWallMesh.material?.clone()
      ) as THREE.MeshPhongMaterial;
      slideMat.map = uvTexture.clone();
      slideMat.map.wrapS = THREE.RepeatWrapping;
      slideMat.map.wrapT = THREE.RepeatWrapping;
      slideMat.map.repeat.set(34, 34);
      for (const m of getImportedMeshes(slides)) {
        m.material = slideMat;
      }
    }

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

    const result3 = await importModelAsync({
      fileName: '/debugger/assets/testModels/test_multi_box.glb',
      appId: 'customPropTest3',
      importGroup: true,
    });
    placeImportedModel(result3, { x: 2, y: 2, z: 2 });
    for (const m of getImportedMeshes(result3)) {
      addCheckerboardMaterialToMesh('checkerMaterial', m, { useConstantCheckerSize: true });
      m.castShadow = true;
      m.receiveShadow = true;
    }

    // Straight stairs (TRIMESH)
    const result4 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraightTrimesh.glb',
      appId: 'customPropTest4',
      importGroup: true,
    });
    placeImportedModel(result4, { x: 37, y: -0.4, z: 5 });
    applyMaterialToImportedPieces(
      result4,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Straight stairs (COMPOUND)
    const result5 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraightCompound.glb',
      appId: 'customPropTest5',
      importGroup: true,
    });
    placeImportedModel(result5, { x: 45, y: -0.4, z: 5 });
    applyMaterialToImportedPieces(
      result5,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );
    // Straight stairs 2 (TRIMESH)
    const result6 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraight2Trimesh.glb',
      appId: 'customPropTest6',
      importGroup: true,
    });
    placeImportedModel(result6, { x: 53, y: -0.4, z: 5 });
    applyMaterialToImportedPieces(
      result6,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Straight stairs 2 (COMPOUND)
    const result7 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraight2Compound.glb',
      appId: 'customPropTest7',
      importGroup: true,
    });
    placeImportedModel(result7, { x: 61, y: -0.4, z: 5 });
    applyMaterialToImportedPieces(
      result7,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Straight stairs 3 (TRIMESH)
    const result8 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraight3Trimesh.glb',
      appId: 'customPropTest8',
      importGroup: true,
    });
    placeImportedModel(result8, { x: 69, y: -0.4, z: 5 });
    applyMaterialToImportedPieces(
      result8,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Straight stairs 3 (COMPOUND)
    const result9 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsStraight3Compound.glb',
      appId: 'customPropTest9',
      importGroup: true,
    });
    placeImportedModel(result9, { x: 77, y: -0.4, z: 5 });
    applyMaterialToImportedPieces(
      result9,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Cornered stairs with thick railings (COMPOUND)
    const result10 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsCorneredWithThickRailingsCompound.glb',
      appId: 'customPropTest10',
      importGroup: true,
    });
    placeImportedModel(result10, { x: 45, y: -0.4, z: 35 });
    applyMaterialToImportedPieces(
      result10,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Cornered stairs with thick railings (TRIMESH)
    const result11 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsCorneredWithThickRailingsTrimesh.glb',
      appId: 'customPropTest11',
      importGroup: true,
    });
    placeImportedModel(result11, { x: 60, y: -0.4, z: 35 });
    applyMaterialToImportedPieces(
      result11,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Spiral stairs (TRIMESH)
    const result12 = await importModelAsync({
      fileName: '/debugger/assets/testModels/stairsSpiralTrimesh.glb',
      appId: 'customPropTest12',
      importGroup: true,
    });
    placeImportedModel(result12, { x: 20, y: 1.8, z: 33 });
    applyMaterialToImportedPieces(
      result12,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Spiked terrain
    const result13 = await importModelAsync({
      fileName: '/debugger/assets/testModels/terrainSpiked.glb',
      appId: 'customPropTest13',
      importGroup: true,
      allMeshesVisible: true,
    });
    placeImportedModel(result13, { x: -25, y: -1.8, z: 126.336 }, 'GROUP_ORIGIN');
    applyMaterialToImportedPieces(
      result13,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Smooth terrain
    const result14 = await importModelAsync({
      fileName: '/debugger/assets/testModels/terrainSmooth.glb',
      appId: 'customPropTest14',
      importGroup: true,
      allMeshesVisible: true,
    });
    placeImportedModel(result14, { x: 52.635, y: -1.8, z: 150.833 }, 'GROUP_ORIGIN');
    applyMaterialToImportedPieces(
      result14,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    // Obstacles
    const result15 = await importModelAsync({
      fileName: '/debugger/assets/testModels/obstacles.glb',
      appId: 'customPropTest15',
      importGroup: true,
      allMeshesVisible: true,
    });
    placeImportedModel(result15, { x: -30, y: -1, z: 30 }, 'GROUP_ORIGIN');
    applyMaterialToImportedPieces(
      result15,
      createMaterial({
        id: 'stairsStraightTrimeshMaterial',
        type: 'PHONG',
        params: { color: '#999' },
      })
    );

    initPhysicsStressTest();

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE_THIRD_PERSON_GYM_META.id);
  });
