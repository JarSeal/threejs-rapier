import * as THREE from 'three/webgpu';
import { createSceneMainLooper } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { getTexture, loadTexture, loadTextures } from '../_engine/core/Texture';
import { llog } from '../_engine/utils/Logger';
import { importAssetAsync } from '../_engine/core/Import/ImportRegistry';
import { spawnImportedAsset } from '../_engine/core/Import/SpawnImported';
import { createMeshEntity, getMeshByAppId } from '../_engine/core/MeshManager';
import { createGroupEntity, addToGroupEntity } from '../_engine/core/GroupManager';
import { transformMainSpeedValue } from '../_engine/core/MainLoop';
import { createSkyBox } from '../_engine/core/SkyBox';
import { createKeyBinding } from '../_engine/core/Input/KeyboardInput';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';

export const assets = {};

export const scene = async () =>
  new Promise(async (resolve) => {
    // Init scene
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
    const groundMat = createMaterial({ id: 'ground', type: 'BASIC', params: { color: 0x0024000 } });
    const groundEntityId = createMeshEntity(
      { geo: groundGeo, mat: groundMat, position: groundPos },
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
      type: 'BASIC',
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
      { geo: geometry2, mat: material2, position: { x: 2, y: 0, z: 0 } },
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

    // Batch load textures example
    const updateLoadStatusFn = (
      loadedTextures: { [id: string]: THREE.Texture },
      loadedCount: number,
      totalCount: number
    ) => {
      llog(`Loaded textures: ${loadedCount}/${totalCount}`, loadedTextures);
    };
    loadTextures(
      [
        { fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg' },
        { fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_AmbientOcclusion.jpg' },
        { fileName: '/debugger/assets/testTextures/Poliigon_MetalRust_7642_Metallic.jpg' },
      ],
      updateLoadStatusFn
    );

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
      physicsParams: {
        isPhysObj: true,
        keepMesh: true,
        rigidBody: {
          rigidType: 'DYNAMIC',
          angvel: { x: 3, y: 1, z: 5 },
        },
        collider: { type: 'TRIMESH', density: 1, friction: 0.5, restitution: 0 },
      },
      entityOpts: { appId: 'importedMesh1' },
    });
    if (!physicsEntityIds.length) throw new Error('Could not spawn the imported box01.');

    createSceneMainLooper(() => {
      sphere.rotation.z -= transformMainSpeedValue(0.1);
      sphere.rotation.y += transformMainSpeedValue(0.1);
    });

    resolve('testScene1');
  });

// Input
createKeyBinding({
  id: 'scene01-log-d-press',
  type: 'KEY_DOWN',
  chord: { key: 'd' },
  fn: (_, time) => {
    console.log('PRESSED', performance.now() - time);
  },
});
