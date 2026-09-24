import * as THREE from 'three/webgpu';
import { createSceneAppLooper } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { getTexture, loadTexture } from '../_engine/core/Texture';
import { importAssetAsync } from '../_engine/core/Import/ImportRegistry';
import { spawnImportedAsset } from '../_engine/core/Import/SpawnImported';
import { createMeshEntity, getMeshByAppId } from '../_engine/core/MeshManager';
import { createGroupEntity, addToGroupEntity } from '../_engine/core/GroupManager';
import { transformAppSpeedValue } from '../_engine/core/MainLoop';
import { createSkyBox } from '../_engine/core/SkyBox';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';

export const SCENE01_ID = 'testScene1';

export const scene = async () =>
  new Promise(async (resolve) => {
    const updateLoaderFn = getLoaderStatusUpdater();
    updateLoaderFn({ loadedCount: 0, totalCount: 2 });

    updateLoaderFn({ loadedCount: 1, totalCount: 2 });

    await createSkyBox({
      id: 'emptyBlueSkyEquiRect',
      type: 'EQUIRECTANGULAR',
      params: {
        file: '/debugger/assets/testTextures/skyboxes/sunset_stylized/sky_empty_2k.png',
        textureId: 'equiRectEmptyId',
        colorSpace: THREE.SRGBColorSpace,
      },
    });
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
      id: 'partly-cloudy',
      type: 'EQUIRECTANGULAR',
      params: {
        file: '/debugger/assets/testTextures/kloofendal_48d_partly_cloudy_puresky_4k.hdr',
        textureId: 'equiRectId',
        colorSpace: THREE.LinearSRGBColorSpace,
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
      },
    });

    // Create ground
    const groundWidthAndDepth = 10;
    const groundHeight = 0.2;
    const groundPos = { x: 0, y: -2, z: 0 };
    const groundGeo = createGeometry({
      id: 'ground',
      type: 'BOX',
      params: { width: groundWidthAndDepth, height: groundHeight, depth: groundWidthAndDepth },
    });
    const groundMat = createMaterial({
      id: 'ground',
      type: 'LAMBERT',
      params: { color: 0x556334 },
    });
    const groundEntityId = createMeshEntity(
      {
        geo: groundGeo,
        mat: groundMat,
        receiveShadow: true,
        castShadow: true,
        position: groundPos,
      },
      { appId: 'groundMesh' }
    );
    await createPhysicsEntity(
      {
        type: 'BOX',
        hx: groundWidthAndDepth / 2,
        hy: groundHeight / 2,
        hz: groundWidthAndDepth / 2,
        friction: 0,
      },
      { rigidType: 'FIXED', translation: groundPos },
      groundEntityId
    );

    const geometry1 = createGeometry({ id: 'sphere1', type: 'SPHERE' });
    const material1 = createMaterial({
      id: 'sphere1Material',
      type: 'LAMBERT',
      params: { color: 0xff0000, wireframe: true },
    });
    createMeshEntity({ geo: geometry1, mat: material1 }, { appId: 'sphereMesh1' });
    const sphere = getMeshByAppId('sphereMesh1')!;

    const geometry2 = createGeometry({ id: 'box1', type: 'BOX' });
    const material2 = createMaterial({
      id: 'box1Material',
      type: 'PHONG',
      params: {
        map: loadTexture({
          id: 'box1Texture',
          fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
        }),
      },
    });
    const boxEntityId = createMeshEntity(
      {
        geo: geometry2,
        mat: material2,
        position: { x: 2, y: 0, z: 0 },
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'boxMesh1' }
    );
    await createPhysicsEntity(
      {
        type: 'BOX',
        hx: 0.5,
        hy: 0.5,
        hz: 0.5,
        restitution: 0.5,
        friction: 0,
      },
      {
        rigidType: 'DYNAMIC',
        translation: { x: 2, y: 0, z: 0 },
        angvel: { x: 1, y: -2, z: 20 },
      },
      boxEntityId
    );

    const physBall01EntityId = createMeshEntity(
      {
        geo: { type: 'SPHERE', params: { radius: 1, widthSegments: 32, heightSegments: 32 } },
        mat: material2,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'physicsBall01' }
    );
    // radius explicit: the legacy PhysicsRapier system auto-inferred the collider radius from
    // the attached mesh's SphereGeometry params — the new Physics API has no such inference.
    await createPhysicsEntity(
      { type: 'BALL', radius: 1 },
      { rigidType: 'DYNAMIC', translation: { x: 2, y: 3, z: -2 } },
      physBall01EntityId
    );

    const cylMat = createMaterial({
      id: 'cylinder01Material',
      type: 'PHONG',
      params: {
        map: getTexture('box1Texture'),
      },
    });
    const physCyl01EntityId = createMeshEntity(
      {
        geo: {
          type: 'CYLINDER',
          params: {
            radiusTop: 0.5,
            radiusBottom: 0.5,
            height: 0.25,
            heightSegments: 2,
            radialSegments: 32,
          },
        },
        mat: cylMat,
        castShadow: true,
        receiveShadow: true,
      },
      { appId: 'physicsCyl01' }
    );
    // halfHeight/radius explicit: same mesh-geometry-inference gap as the sphere above
    // (height: 0.25 -> halfHeight: 0.125, radiusBottom: 0.5 -> radius: 0.5).
    await createPhysicsEntity(
      { type: 'CYLINDER', halfHeight: 0.125, radius: 0.5 },
      {
        rigidType: 'DYNAMIC',
        translation: { x: -2, y: 3, z: -2 },
        angvel: { x: 23, y: 1, z: 5 },
      },
      physCyl01EntityId
    );

    // Group example
    const groupEntityId = createGroupEntity({ appId: 'myGroup', position: { x: 0, y: 1.4, z: 0 } });
    createMeshEntity(
      {
        geo: createGeometry<THREE.BoxGeometry>({
          type: 'BOX',
          params: { width: 0.2, height: 0.2, depth: 0.2 },
        }),
        mat: createMaterial({ type: 'BASIC', params: { color: '#f0cc00' } }),
        position: { x: -0.2, y: 0, z: 0 },
      },
      { appId: 'groupBox1', doNotAddToScene: true }
    );
    const groupBox1 = getMeshByAppId('groupBox1')!;

    createMeshEntity(
      {
        geo: createGeometry<THREE.BoxGeometry>({
          type: 'BOX',
          params: { width: 0.2, height: 0.2, depth: 0.2 },
        }),
        mat: createMaterial({ type: 'BASIC', params: { color: '#ff00c0' } }),
        position: { x: 0.2, y: 0, z: 0 },
      },
      { appId: 'groupBox2', doNotAddToScene: true }
    );
    const groupBox2 = getMeshByAppId('groupBox2')!;

    addToGroupEntity(groupEntityId, [groupBox1, groupBox2]);

    // box01 with a TRIMESH collider from its own geometry. The collider values are the Physics
    // API's defaults this box has always had (the importer's custom-prop defaults are 0.2).
    const importedBox01 = await importAssetAsync({
      fileName: '/debugger/assets/testModels/box01.glb',
      throwOnError: true,
    });
    const { physicsEntityIds } = await spawnImportedAsset(importedBox01!, {
      transform: { position: { x: 3, y: 3, z: 2 } },
      material: createMaterial({
        id: 'importedBox01Material',
        type: 'PHONG',
        params: { map: getTexture('box1Texture') },
      }),
      castShadow: true,
      receiveShadow: true,
      physicsParams: {
        isPhysObj: true,
        keepMesh: true,
        rigidBody: {
          rigidType: 'DYNAMIC',
          angvel: { x: 3, y: 1, z: 5 },
          ccdEnabled: true,
        },
        collider: { type: 'TRIMESH', density: 1, friction: 0.5, restitution: 0 },
      },
      entityOpts: { appId: 'importedMesh1' },
    });
    if (!physicsEntityIds.length) throw new Error('Could not spawn the imported box01.');

    // No mesh to hang off, so this one creates its own entity — give it an explicit appId
    // (reusing the old PhysicsObject id string) like the ones above have, otherwise it gets a
    // fresh UUID on every load and any per-entity debug settings can't survive a reload.
    await createPhysicsEntity(
      {
        type: 'BOX',
        hx: 10,
        hy: 0.2,
        hz: 10,
        isSensor: true,
        translation: { x: 0, y: -1.5, z: 0 },
        collisionEventFn: (collider1, collider2, started) => {
          console.log('SENSOR ALERT', collider1, collider2, started);
        },
      },
      undefined,
      undefined,
      { appId: 'sensorTest' }
    );

    createSceneAppLooper(() => {
      sphere.rotation.y -= transformAppSpeedValue(2);
      sphere.rotation.z -= transformAppSpeedValue(2);
    });

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE01_ID);
  });
