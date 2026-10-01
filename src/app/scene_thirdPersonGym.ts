import * as THREE from 'three/webgpu';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial, getMaterial, getMaterialVariant } from '../_engine/core/Material';
import { createMeshEntity, getMeshByAppId, setMeshMaterial } from '../_engine/core/MeshManager';
import { createSkyBox } from '../_engine/core/SkyBox/SkyBox';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { loadTexture } from '../_engine/core/Texture';
import { createDynamicCharacter } from '../_engine/core/Character/DynamicCharacter';
import { characterTestObstacles } from '../_engine/utils/world/characterTestObjects';
import { importAssetAsync } from '../_engine/core/Import/ImportRegistry';
import { spawnImportedAsset } from '../_engine/core/Import/SpawnImported';
import type { ImportedAssetManifest } from '../_engine/core/Import/ImportTypes';
import { ComponentType, Transform } from '../_engine/core/ECS/ECSCoreComponents';
import { getQuatFromAngle } from '../_engine/utils/helpers';
import { createMovingPlatform } from '../_engine/utils/world/movingPlatform';
import { initPhysicsStressTest } from '../_engine/utils/PhysicsStressTest';
import { getTestObstacle } from '../_engine/utils/world/characterTestObstacles';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from '../_engine/core/ECS';
import { getScene, registerOnSceneExit } from '../_engine/core/Scene';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';
import { getCameraByAppId } from '../_engine/core/CameraManager';
import { getLightByAppId, getLightTargetId } from '../_engine/core/LightManager';
import {
  createFollowObjectCameraRig,
  deleteFollowObjectCameraRig,
} from '../_engine/utils/cameras/followObjectCameraRig';
import { ECSSystemStage } from '../AppECSRegistry';

export const SCENE_THIRD_PERSON_GYM_META = {
  id: 'thirdPersonGymScene',
};

/** Sky (environment map) light strength: at full strength the blue sky tints every face turned
 * away from the sun blue on the PBR (triplanar) materials. */
const GYM_ENVIRONMENT_INTENSITY = 0.3;

const TEST_MODELS = '/debugger/assets/testModels';

/** Off when probing physics determinism (`?physicsProbe=N`): the characters aren't deterministic,
 * and the dummy one walks into the test props, so the probe would report their differences. */
const ARE_CHARACTERS_ENABLED = true;

/** Root transform that puts an import's first visible node (its first mesh, which is also its
 * physics anchor) at `pos`: these models were positioned by that node, not by their glTF root. */
const rootPlacing = (manifest: ImportedAssetManifest, pos: { x: number; y: number; z: number }) => {
  const anchor = manifest.geometries.find(
    ({ customProps }) => !customProps.isPhysObj || customProps.keepMesh
  );
  const offset = anchor?.transform.position || { x: 0, y: 0, z: 0 };
  return { position: { x: pos.x - offset.x, y: pos.y - offset.y, z: pos.z - offset.z } };
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

const snapToStep = (value: number, step: number) => Math.round(value / step) * step;

/**
 * An ECS system moving a directional light (and its target) with an entity, so its shadow frustum
 * covers the area around it wherever it goes. The light's direction and distance stay as authored
 * (its position - target offset). The frustum moves in whole shadow map texels in light space, or
 * shadow edges would shimmer as it slides. The light is looked up lazily: a scene's JSON lights are
 * created after its scene function runs.
 * @param centerOffset shifts the frustum center from the followed entity (eg. toward where the
 * camera sees more ground)
 */
const followWithSun = (
  sunAppId: string,
  followEntityId: number,
  centerOffset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
) => {
  const center = new THREE.Vector3();
  let sun: {
    id: number;
    targetId: number;
    transform: Transform;
    targetTransform: Transform;
    offset: THREE.Vector3;
    axisX: THREE.Vector3;
    axisY: THREE.Vector3;
    axisZ: THREE.Vector3;
    texelSize: number;
  } | null = null;

  const resolveSun = (world: ECSWorld) => {
    const light = getLightByAppId(sunAppId, world) as THREE.DirectionalLight | undefined;
    const id = getEntityIdByAppId(sunAppId, world);
    const targetId = id !== undefined ? getLightTargetId(id, world) : undefined;
    if (!light?.isDirectionalLight || id === undefined || targetId === undefined) return null;
    const transform = world.getComponent(id, ComponentType.TRANSFORM);
    const targetTransform = world.getComponent(targetId, ComponentType.TRANSFORM);
    if (!transform || !targetTransform) return null;

    const offset = transform.position.clone().sub(targetTransform.position);
    // Light-space axes (as the shadow camera's lookAt builds them)
    const axisZ = offset.clone().normalize();
    const axisX = new THREE.Vector3(0, 1, 0).cross(axisZ).normalize();
    const axisY = axisZ.clone().cross(axisX);
    const shadowCam = light.shadow.camera;
    const texelSize = (shadowCam.right - shadowCam.left) / light.shadow.mapSize.width;
    return { id, targetId, transform, targetTransform, offset, axisX, axisY, axisZ, texelSize };
  };

  return (world: ECSWorld) => {
    sun ??= resolveSun(world);
    const followed = world.getComponent(followEntityId, ComponentType.TRANSFORM);
    if (!sun || !followed) return;

    const { axisX, axisY, axisZ, texelSize } = sun;
    const p = center.copy(followed.position).add(centerOffset);
    sun.targetTransform.position
      .copy(axisX)
      .multiplyScalar(snapToStep(p.dot(axisX), texelSize))
      .addScaledVector(axisY, snapToStep(p.dot(axisY), texelSize))
      .addScaledVector(axisZ, p.dot(axisZ));
    sun.transform.position.copy(sun.targetTransform.position).add(sun.offset);
    sun.targetTransform.setDirty();
    world.commitTransform(sun.targetId, sun.targetTransform);
    sun.transform.setDirty();
    world.commitTransform(sun.id, sun.transform);
  };
};

/** The player character (with its follow camera) and an input-less dummy that walks and jumps
 * around. Both are frame-timing dependent (wall clock, random tumbling, async shape casts in
 * WORKER_THREAD mode), so they're left out when ARE_CHARACTERS_ENABLED is off (p101 §1). */
const createGymCharacters = async () => {
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

  // Sun follows the player (the follow camera's focus), see followWithSun. The camera looks down
  // at the player from its (7, 20, 7) offset, so it sees more ground ahead (~20m) than behind
  // (~11m): center the shadow frustum ~4m ahead, along the camera's ground-forward (-x, -z).
  // The frustum size (thirdPersonGymSun.light.json) covers the ~±23m screen width at the player.
  const world = getECSWorld();
  world.removeSystem('gymSunFollow');
  const followSun = followWithSun('thirdPersonGymSun', characterMesh.userData.entityId as number, {
    x: -3,
    y: 0,
    z: -3,
  });
  world.addSystem(ECSSystemStage.APP_LOGIC, 'gymSunFollow', followSun);

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

  const { controlFns, dynamicCharacterObject: dummyCharacterObject } = await createDynamicCharacter(
    {
      id: 'testDummyChar',
      charMesh: characterMesh2,
      charData: characterData,
    }
  );
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
  // ...and it's removed on leaving too (see the scene's exit callback), or it would keep driving
  // the deleted dummy character.
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
      controlFns.rotate('LEFT', dt);
    }
    accDelta += dt;
  });
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

    // Clean up on leaving: the characters' systems and follow camera rig would otherwise keep
    // running against their deleted entities/meshes (all no-ops when ARE_CHARACTERS_ENABLED is off).
    // (One exit callback per scene — registerOnSceneExit replaces any earlier one.)
    registerOnSceneExit(SCENE_THIRD_PERSON_GYM_META.id, () => {
      getECSWorld().removeSystem('dummyCharLooper');
      getECSWorld().removeSystem('gymSunFollow');
      deleteFollowObjectCameraRig('thirdPersonGymFollowCam');
    });

    await createSkyBox({
      id: 'stylizedSunsetEquiRect',
      base: {
        type: 'EQUIRECTANGULAR',
        file: '/debugger/assets/testTextures/skyboxes/sunset_stylized/sky_41_4k.png',
        textureId: 'equiRectSunsetStylizedId',
        colorSpace: THREE.SRGBColorSpace,
        rotate: Math.PI,
      },
      env: { environmentIntensity: GYM_ENVIRONMENT_INTENSITY },
    });

    await createSkyBox({
      id: 'emptyBlueSkyEquiRect',
      base: {
        type: 'EQUIRECTANGULAR',
        file: '/debugger/assets/testTextures/skyboxes/sunset_stylized/sky_empty_2k.png',
        textureId: 'equiRectEmptyId',
        colorSpace: THREE.SRGBColorSpace,
        rotate: Math.PI,
      },
      env: { environmentIntensity: GYM_ENVIRONMENT_INTENSITY },
    });

    // Static physics meshes use the toolkit's triplanar grid material (listed in the scene JSON)
    const gridMat = getMaterial('triplanarGrid');
    if (!gridMat) throw new Error('Could not find the triplanarGrid material for the gym scene.');
    // Flat slopes (ramps, stair flights): one projection only, or two blended ones show doubled
    // lines there (see the grid's dominantAxis define)
    const gridFlatSlopesMat = getMaterialVariant('triplanarGrid', {
      staticDefines: { dominantAxis: true },
    });
    // Dynamic physics objects and moving platforms use the toolkit's triplanar checkerboard (listed
    // in the scene JSON); the platforms get fitted amber cells so the moving pieces stand out (a
    // cached material variant, see getMaterialVariant)
    const dynamicMat = getMaterial('triplanarCheckerboard');
    if (!dynamicMat) {
      throw new Error('Could not find the triplanarCheckerboard material for the gym scene.');
    }
    const platformMat = getMaterialVariant('triplanarCheckerboard', {
      staticDefines: { fitToBounds: true },
      nodes: {
        colorNode: { checkerSize: 0.5, checkerColorA: '#a18862', checkerColorB: '#7b6b54' },
      },
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
    const groundEntityId = createMeshEntity(
      {
        geo: groundGeo,
        mat: gridMat,
        receiveShadow: true,
        position: groundPos,
        // A slightly lighter tint than the other static meshes (a material variant, same shader)
        matOverrides: {
          staticDefines: {
            minorLines: false,
          },
          nodes: {
            colorNode: {
              backgroundColor: '#9c9c9c',
              lineColor: '#a5a5a5',
            },
          },
        },
      },
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
    // setMeshMaterial moves the ref counts (the obstacles' own materials are then disposed)
    setMeshMaterial(stairsMesh, gridMat);
    setImportedRigidBodyTranslationPartial(stairsEntityId, { x: 5, y: -1.8 });

    setMeshMaterial(bigBoxWallMesh, gridMat);
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
    const boxEntityId = createMeshEntity(
      { geo: geometry2, mat: dynamicMat, castShadow: true, receiveShadow: true },
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

    if (ARE_CHARACTERS_ENABLED) await createGymCharacters();

    const cube = await importAssetAsync({ fileName: `${TEST_MODELS}/customPropTestCube.glb` });
    const monkey = await importAssetAsync({ fileName: `${TEST_MODELS}/customPropTestMonkey.glb` });
    const multiBox = await importAssetAsync({ fileName: `${TEST_MODELS}/test_multi_box.glb` });
    if (!cube || !monkey || !multiBox) throw new Error('Could not import the gym test models.');

    await spawnImportedAsset(cube, {
      transform: rootPlacing(cube, { x: 2, y: 2, z: 2 }),
      material: dynamicMat,
      castShadow: true,
      receiveShadow: true,
      entityOpts: { appId: 'customPropTest' },
    });

    // Suzanne (monkey TRIMESH)
    await spawnImportedAsset(monkey, {
      transform: rootPlacing(monkey, { x: 4, y: 2, z: 3 }),
      material: dynamicMat,
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

    // Suzanne (monkey CONVEXHULL)
    await spawnImportedAsset(monkey, {
      transform: rootPlacing(monkey, { x: 4, y: 6, z: 3 }),
      material: dynamicMat,
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

    await getTestObstacle('slideAngles', {
      transform: { position: { x: 30, y: -1.9, z: -30 } },
      material: gridFlatSlopesMat,
      castShadow: true,
      receiveShadow: true,
      physicsParams: { collider: { type: 'TRIMESH', friction: 1 } },
    });

    createMeshEntity(
      {
        geo: createGeometry({
          id: 'movingPlatform1-geo',
          type: 'BOX',
          params: { width: 2, height: 0.2, depth: 4 },
        }),
        mat: platformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'sideWaysPlatformMesh' }
    );
    const sideWaysPlatformMesh = getMeshByAppId('sideWaysPlatformMesh')!;

    await createMovingPlatform({
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
        mat: platformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'elevatorPlatformMesh' }
    );
    const elevatorPlatformMesh = getMeshByAppId('elevatorPlatformMesh')!;

    await createMovingPlatform({
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
        mat: platformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'carouselPlatformMesh1' }
    );
    const carouselPlatformMesh1 = getMeshByAppId('carouselPlatformMesh1')!;

    await createMovingPlatform({
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
        mat: platformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'carouselPlatformMesh2' }
    );
    const carouselPlatformMesh2 = getMeshByAppId('carouselPlatformMesh2')!;

    await createMovingPlatform({
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
        mat: platformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'carouselPlatformMesh3' }
    );
    const carouselPlatformMesh3 = getMeshByAppId('carouselPlatformMesh3')!;

    await createMovingPlatform({
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
        mat: platformMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'ferrisWheelPlatformMesh' }
    );
    const ferrisWheelPlatformMesh = getMeshByAppId('ferrisWheelPlatformMesh')!;

    await createMovingPlatform({
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

    await spawnImportedAsset(multiBox, {
      transform: rootPlacing(multiBox, { x: 2, y: 2, z: 2 }),
      material: dynamicMat,
      castShadow: true,
      receiveShadow: true,
      entityOpts: { appId: 'customPropTest3' },
    });

    // Stairs are positioned by their first visible node, terrains and obstacles by their glTF root
    const staticModels: {
      file: string;
      appId: string;
      pos: { x: number; y: number; z: number };
      placeBy: 'FIRST_MESH' | 'ROOT';
      /** Flat slopes: use gridFlatSlopesMat */
      flatSlopes?: boolean;
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
        flatSlopes: true,
        pos: { x: 45, y: -0.4, z: 35 },
        placeBy: 'FIRST_MESH',
      },
      // Cornered stairs with thick railings (TRIMESH)
      {
        file: 'stairsCorneredWithThickRailingsTrimesh',
        appId: 'customPropTest11',
        flatSlopes: true,
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
    for (const { file, appId, pos, placeBy, flatSlopes } of staticModels) {
      const manifest = await importAssetAsync({ fileName: `${TEST_MODELS}/${file}.glb` });
      if (!manifest) continue;
      await spawnImportedAsset(manifest, {
        transform: placeBy === 'ROOT' ? { position: pos } : rootPlacing(manifest, pos),
        material: flatSlopes ? gridFlatSlopesMat : gridMat,
        castShadow: true,
        receiveShadow: true,
        entityOpts: { appId },
      });
    }

    initPhysicsStressTest();

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE_THIRD_PERSON_GYM_META.id);
  });
