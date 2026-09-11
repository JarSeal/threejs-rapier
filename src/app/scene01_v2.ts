import * as THREE from 'three/webgpu';
import { createSceneAppLooper } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { getTexture, loadTexture } from '../_engine/core/Texture';
import { importModelAsync } from '../_engine/core/ImportModel';
import { createMeshEntity, getMeshByAppId } from '../_engine/core/MeshManager';
import { createGroupEntity, addToGroupEntity } from '../_engine/core/GroupManager';
import { transformAppSpeedValue } from '../_engine/core/MainLoop';
import { createSkyBox } from '../_engine/core/SkyBox';
import {
  createPhysicsObjectWithMesh,
  createPhysicsObjectWithoutMesh,
} from '../_engine/core/PhysicsRapier';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';

export const SCENE01_ID = 'testScene1';

export const scene01 = async () =>
  new Promise<string>(async (resolve) => {
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
    createMeshEntity({
      appId: 'groundMesh',
      geo: groundGeo,
      mat: groundMat,
      receiveShadow: true,
      castShadow: true,
      position: groundPos,
    });
    const groundMesh = getMeshByAppId('groundMesh')!;
    createPhysicsObjectWithMesh({
      physicsParams: {
        collider: {
          type: 'BOX',
          hx: groundWidthAndDepth / 2,
          hy: groundHeight / 2,
          hz: groundWidthAndDepth / 2,
          friction: 0,
        },
        rigidBody: { rigidType: 'FIXED', translation: groundPos },
      },
      meshOrMeshId: groundMesh,
    });

    const geometry1 = createGeometry({ id: 'sphere1', type: 'SPHERE' });
    const material1 = createMaterial({
      id: 'sphere1Material',
      type: 'LAMBERT',
      params: { color: 0xff0000, wireframe: true },
    });
    createMeshEntity({ appId: 'sphereMesh1', geo: geometry1, mat: material1 });
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
    createMeshEntity({
      appId: 'boxMesh1',
      geo: geometry2,
      mat: material2,
      position: { x: 2, y: 0, z: 0 },
      castShadow: true,
      receiveShadow: true,
    });
    const box = getMeshByAppId('boxMesh1')!;
    createPhysicsObjectWithMesh({
      physicsParams: {
        collider: {
          type: 'BOX',
          hx: 0.5,
          hy: 0.5,
          hz: 0.5,
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

    createMeshEntity({
      appId: 'physicsBall01',
      geo: { type: 'SPHERE', params: { radius: 1, widthSegments: 32, heightSegments: 32 } },
      mat: material2,
      castShadow: true,
      receiveShadow: true,
    });
    const physBall01 = getMeshByAppId('physicsBall01')!;
    createPhysicsObjectWithMesh({
      physicsParams: {
        collider: { type: 'SPHERE' },
        rigidBody: { rigidType: 'DYNAMIC', translation: { x: 2, y: 3, z: -2 } },
      },
      meshOrMeshId: physBall01,
    });

    const cylMat = createMaterial({
      id: 'cylinder01Material',
      type: 'PHONG',
      params: {
        map: getTexture('box1Texture'),
      },
    });
    createMeshEntity({
      appId: 'physicsCyl01',
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
    });
    const physCyl01 = getMeshByAppId('physicsCyl01')!;
    createPhysicsObjectWithMesh({
      physicsParams: {
        collider: { type: 'CYLINDER' },
        rigidBody: {
          rigidType: 'DYNAMIC',
          translation: { x: -2, y: 3, z: -2 },
          angvel: { x: 23, y: 1, z: 5 },
        },
      },
      meshOrMeshId: physCyl01,
    });

    // Group example
    const groupEntityId = createGroupEntity({ appId: 'myGroup', position: { x: 0, y: 1.4, z: 0 } });
    createMeshEntity(
      {
        appId: 'groupBox1',
        geo: createGeometry<THREE.BoxGeometry>({
          type: 'BOX',
          params: { width: 0.2, height: 0.2, depth: 0.2 },
        }),
        mat: createMaterial({ type: 'BASIC', params: { color: '#f0cc00' } }),
        position: { x: -0.2, y: 0, z: 0 },
      },
      { doNotAddToScene: true }
    );
    const groupBox1 = getMeshByAppId('groupBox1')!;

    createMeshEntity(
      {
        appId: 'groupBox2',
        geo: createGeometry<THREE.BoxGeometry>({
          type: 'BOX',
          params: { width: 0.2, height: 0.2, depth: 0.2 },
        }),
        mat: createMaterial({ type: 'BASIC', params: { color: '#ff00c0' } }),
        position: { x: 0.2, y: 0, z: 0 },
      },
      { doNotAddToScene: true }
    );
    const groupBox2 = getMeshByAppId('groupBox2')!;

    addToGroupEntity(groupEntityId, [groupBox1, groupBox2]);

    const result = await importModelAsync({
      appId: 'importedMesh1',
      fileName: '/debugger/assets/testModels/box01.glb',
      throwOnError: true,
    });
    const importedBox = result.mesh as THREE.Mesh;
    if (importedBox) {
      importedBox.receiveShadow = true;
      importedBox.castShadow = true;
      createPhysicsObjectWithMesh({
        physicsParams: {
          collider: { type: 'TRIMESH' },
          rigidBody: {
            rigidType: 'DYNAMIC',
            translation: { x: 3, y: 3, z: 2 },
            angvel: { x: 3, y: 1, z: 5 },
            ccdEnabled: true,
          },
        },
        meshOrMeshId: importedBox,
      });
      const material = createMaterial({
        id: 'importedBox01Material',
        type: 'PHONG',
        params: {
          map: getTexture('box1Texture'),
        },
      });
      importedBox.position.set(3, 3, 2);
      importedBox.material = material;
    }

    createPhysicsObjectWithoutMesh({
      id: 'sensorTest',
      physicsParams: {
        collider: {
          type: 'BOX',
          hx: 10,
          hy: 0.2,
          hz: 10,
          isSensor: true,
          collisionEventFn: (coll1, coll2, started, obj1, obj2) => {
            console.log('SENSOR ALERT', obj1, obj2, coll1, coll2, started);
          },
          translation: { x: 0, y: -1.5, z: 0 },
        },
      },
    });

    createSceneAppLooper(() => {
      sphere.rotation.y -= transformAppSpeedValue(2);
      sphere.rotation.z -= transformAppSpeedValue(2);
    });

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE01_ID);
  });
