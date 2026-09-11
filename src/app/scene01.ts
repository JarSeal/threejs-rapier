import * as THREE from 'three/webgpu';
import { createSceneMainLooper } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { getTexture, loadTexture, loadTextures } from '../_engine/core/Texture';
import { llog } from '../_engine/utils/Logger';
import { importModelAsync } from '../_engine/core/ImportModel';
import { createMeshEntity, getMeshByAppId } from '../_engine/core/MeshManager';
import { createGroupEntity, addToGroupEntity } from '../_engine/core/GroupManager';
import { transformMainSpeedValue } from '../_engine/core/MainLoop';
import { createSkyBox } from '../_engine/core/SkyBox';
import { createKeyInputControl } from '../_engine/core/InputControls';
import { createPhysicsObjectWithMesh } from '../_engine/core/PhysicsRapier';

export const assets = {};

export const scene01 = async () =>
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
        path: '/assets/testTextures',
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
    createMeshEntity({
      appId: 'groundMesh',
      geo: groundGeo,
      mat: groundMat,
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
      type: 'BASIC',
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
          fileName: '/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
        }),
      },
    });
    createMeshEntity({
      appId: 'boxMesh1',
      geo: geometry2,
      mat: material2,
      position: { x: 2, y: 0, z: 0 },
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
        { fileName: '/assets/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg' },
        { fileName: '/assets/testTextures/Poliigon_MetalRust_7642_AmbientOcclusion.jpg' },
        { fileName: '/assets/testTextures/Poliigon_MetalRust_7642_Metallic.jpg' },
      ],
      updateLoadStatusFn
    );

    const result = await importModelAsync({
      appId: 'importedMesh1',
      fileName: '/assets/testModels/box01.glb',
      throwOnError: true,
    });
    if (result.mesh && !Array.isArray(result.mesh)) {
      const importedBox = result.mesh;
      createPhysicsObjectWithMesh({
        physicsParams: {
          collider: { type: 'TRIMESH' },
          rigidBody: {
            rigidType: 'DYNAMIC',
            translation: { x: 3, y: 3, z: 2 },
            angvel: { x: 3, y: 1, z: 5 },
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

    createSceneMainLooper(() => {
      sphere.rotation.z -= transformMainSpeedValue(0.1);
      sphere.rotation.y += transformMainSpeedValue(0.1);
    });

    resolve('testScene1');
  });

// Input
createKeyInputControl({
  type: 'KEY_DOWN',
  key: 'd',
  fn: (_, time) => {
    console.log('PRESSED', performance.now() - time);
  },
});
