import * as THREE from 'three/webgpu';
import { createSceneMainLooper, createScene } from '../_engine/core/Scene';
import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { getTexture, loadTexture, loadTextures } from '../_engine/core/Texture';
import { llog } from '../_engine/utils/Logger';
import { createLight } from '../_engine/core/Light';
import { importModelAsync } from '../_engine/core/ImportModel';
import { createMesh } from '../_engine/core/Mesh';
import { addToGroup, createGroup } from '../_engine/core/Group';
import { transformSpeedValue } from '../_engine/core/MainLoop';
import { createSkyBox } from '../_engine/core/SkyBox';
import { getCurrentCamera } from '../_engine/core/Camera';
import { createKeyInputControl } from '../_engine/core/InputControls';
import { createPhysicsObjectWithMesh } from '../_engine/core/PhysicsRapier';

export const assets = {};
// export const preloadAssets = () => {};
// export const preloadAssetsAsync = () => {};

export const scene01 = async () =>
  new Promise(async (resolve) => {
    // Position camera
    const camera = getCurrentCamera();
    camera.position.z = 5;
    camera.position.x = 2.5;
    camera.position.y = 1;

    // Init scene
    const scene = createScene('testScene1', {
      // isCurrentScene: true,
      // background: new THREE.Color(0x222222),
    });

    // const envTexture = await loadTextureAsync({
    //   id: 'equiRectId',
    //   fileName: '/testTextures/equi_grass_and_forest_4k.jpg',
    // });
    // await createSkyBox({
    //   type: 'EQUIRECTANGULAR',
    //   params: {
    //     // file: envTexture,
    //     // file: '/assets/testTextures/kloofendal_48d_partly_cloudy_skyandground_8k.png',
    //     file: '/assets/testTextures/kloofendal_48d_partly_cloudy_puresky_4k.hdr',
    //     // file: '/assets/testTextures/kloofendal_48d_partly_cloudy_puresky_2k.hdr',
    //     // file: '/assets/testTextures/evening_road_01_puresky_8k.hdr',
    //     // file: '/assets/testTextures/pizzo_pernice_puresky_8k.hdr',
    //     textureId: 'equiRectId',
    //     isEnvMap: false,
    //     // colorSpace: THREE.SRGBColorSpace,
    //     colorSpace: THREE.LinearSRGBColorSpace,
    //     // colorSpace: THREE.NoColorSpace,
    //   },
    // });

    // const map01 = [
    //   '/cubemap01_positive_x.png',
    //   '/cubemap01_negative_x.png',
    //   '/cubemap01_negative_y.png',
    //   '/cubemap01_positive_y.png',
    //   '/cubemap01_positive_z.png',
    //   '/cubemap01_negative_z.png',
    // ];
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
    const groundMesh = createMesh({ geo: groundGeo, mat: groundMat });
    groundMesh.position.set(groundPos.x, groundPos.y, groundPos.z);
    createPhysicsObjectWithMesh(
      {
        collider: {
          type: 'BOX',
          hx: groundWidthAndDepth / 2,
          hy: groundHeight / 2,
          hz: groundWidthAndDepth / 2,
          friction: 0,
        },
        rigidBody: { rigidType: 'FIXED', translation: groundPos },
      },
      groundMesh
    );
    scene.add(groundMesh);

    const geometry1 = createGeometry({ id: 'sphere1', type: 'SPHERE' });
    const material1 = createMaterial({
      id: 'sphere1Material',
      type: 'BASIC',
      params: { color: 0xff0000, wireframe: true },
    });
    const sphere = createMesh({ id: 'sphereMesh1', geo: geometry1, mat: material1 });
    scene.add(sphere);

    getCurrentCamera().lookAt(sphere.position);

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
    const box = createMesh({ id: 'boxMesh1', geo: geometry2, mat: material2 });
    box.position.set(2, 0, 0);
    createPhysicsObjectWithMesh(
      {
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
      box
    );
    scene.add(box);

    const physBall01 = createMesh({
      id: 'physicsBall01',
      geo: { type: 'SPHERE', params: { radius: 1, widthSegments: 32, heightSegments: 32 } },
      mat: material2,
      phy: {
        collider: { type: 'SPHERE' },
        rigidBody: { rigidType: 'DYNAMIC', translation: { x: 2, y: 3, z: -2 } },
      },
    });
    scene.add(physBall01);

    const cylMat = createMaterial({
      id: 'cylinder01Material',
      type: 'PHONG',
      params: {
        map: getTexture('box1Texture'),
      },
    });
    const physCyl01 = createMesh({
      id: 'physicsCyl01',
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
      phy: {
        collider: { type: 'CYLINDER' },
        rigidBody: {
          rigidType: 'DYNAMIC',
          translation: { x: -2, y: 3, z: -2 },
          angvel: { x: 23, y: 1, z: 5 },
        },
      },
    });
    scene.add(physCyl01);

    // Group example
    const group = createGroup({ id: 'myGroup' });
    const groupBox1 = createMesh({
      geo: createGeometry<THREE.BoxGeometry>({
        type: 'BOX',
        params: { width: 0.2, height: 0.2, depth: 0.2 },
      }),
      mat: createMaterial({ type: 'BASIC', params: { color: '#f0cc00' } }),
    });
    groupBox1.position.set(-0.2, 0, 0);
    const groupBox2 = createMesh({
      geo: createGeometry<THREE.BoxGeometry>({
        type: 'BOX',
        params: { width: 0.2, height: 0.2, depth: 0.2 },
      }),
      mat: createMaterial({ type: 'BASIC', params: { color: '#ff00c0' } }),
    });
    groupBox2.position.set(0.2, 0, 0);
    addToGroup(group, [groupBox1, groupBox2]);
    group.position.y = 1.4;
    scene.add(group);

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

    const importedBox = await importModelAsync<THREE.Mesh>({
      id: 'importedMesh1',
      fileName: '/assets/testModels/box01.glb',
      throwOnError: true,
    });
    if (importedBox) {
      createPhysicsObjectWithMesh(
        {
          collider: { type: 'TRIMESH' },
          rigidBody: {
            rigidType: 'DYNAMIC',
            translation: { x: 3, y: 3, z: 2 },
            angvel: { x: 3, y: 1, z: 5 },
          },
        },
        importedBox
      );
      const material = createMaterial({
        id: 'importedBox01Material',
        type: 'PHONG',
        params: {
          map: getTexture('box1Texture'),
        },
      });
      importedBox.position.set(3, 3, 2);
      importedBox.material = material;
      scene.add(importedBox);

      // createSceneAppLooper(() => {
      //   importedBox.rotation.y += transformSpeedValue(0.2);
      //   importedBox.rotation.z -= transformSpeedValue(0.14);
      // });
    }

    createSceneMainLooper(() => {
      sphere.rotation.z -= transformSpeedValue(0.1);
      sphere.rotation.y += transformSpeedValue(0.1);
    });

    // createSceneAppLooper(() => {
    //   box.rotation.y -= transformSpeedValue(2);
    //   box.rotation.z -= transformSpeedValue(2);
    // });

    const point = createLight({
      id: 'pointLight',
      type: 'POINT',
      params: { color: 0xffffff, intensity: 7, distance: 10 },
    });
    point.position.set(2, 1, 1);
    scene.add(point);

    const ambient = createLight({
      id: 'ambientLight',
      type: 'AMBIENT',
      params: { color: '#ffffff', intensity: 0.8 },
    });
    scene.add(ambient);

    const hemisphere = createLight({
      id: 'hemisphereLight',
      type: 'HEMISPHERE',
      params: {
        skyColor: 0x220000,
        groundColor: 0x225599,
        intensity: 1.5,
      },
    });
    scene.add(hemisphere);

    resolve('testScene1');
  });

// Input
createKeyInputControl({
  type: 'KEY_DOWN',
  key: 'd',
  fn: (_, time) => {
    // eslint-disable-next-line no-console
    console.log('PRESSED', performance.now() - time);
  },
});

// setTimeout(() => {
//   createDebuggerTab({
//     id: 'test-tab',
//     buttonText: 'TADAA',
//     container: () => {
//       const { container } = createNewDebuggerPane('test-scene', 'Testing scene');
//       return container;
//     },
//   });
// }, 2000);
// setTimeout(() => {
//   removeDebuggerTab('test-tab');
// }, 18000);
