import * as THREE from 'three/webgpu';
import { createScene } from '../_engine/core/Scene';
import { createLight } from '../_engine/core/Light';
import { createSkyBox } from '../_engine/core/SkyBox';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { createMeshEntity, MeshProps } from '../_engine/core/_MeshManager';
import { getECSWorld } from '../_engine/core/ECS';
import { initECSStressTest } from '../_engine/utils/ECSStressTest';
import { createCameraEntity, setMainCamera } from '../_engine/core/_CameraManager';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { inspectEntity, lookAtPoint } from '../_engine/utils/ECSHelpers';

export const SCENE_TEST_ECS_ID = 'sceneTestECS';

export const sceneTestECS = async () =>
  new Promise<string>(async (resolve) => {
    const updateLoaderFn = getLoaderStatusUpdater();
    updateLoaderFn({ loadedCount: 0, totalCount: 2 });

    const ecsWorld = getECSWorld();

    const camId = createCameraEntity(
      { type: 'PERSPECTIVE', fov: 90, active: true },
      {
        appId: 'mainCamera',
        debugData: { name: 'Main camera', description: 'Main application camera' },
        persistent: true,
      }
    );
    createCameraEntity(
      { type: 'PERSPECTIVE', fov: 90, active: false },
      {
        appId: 'testing',
        debugData: { description: 'Main application camera 2' },
      }
    );
    setMainCamera(ecsWorld, camId);
    ecsWorld.setTransform(camId, {
      pos: { x: 10, y: 5, z: 20 },
    });
    lookAtPoint(camId, { x: 0, y: 0, z: 0 });

    inspectEntity(camId);

    const scene = createScene(SCENE_TEST_ECS_ID, {
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

    // Lights
    const ambient = createLight({
      id: 'ambientLight',
      name: 'Ambient light',
      type: 'AMBIENT',
      params: { color: '#ffffff', intensity: 0.5 },
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

    const point = createLight({
      id: 'pointLight',
      type: 'POINT',
      params: {
        color: 0xffffff,
        intensity: 7,
        distance: 10,
      },
    });
    point.position.set(2, 1, 1);
    scene.add(point);

    const directionalLight = createLight({
      id: 'directionalLight',
      type: 'DIRECTIONAL',
      params: {
        position: { x: -5, y: 2.5, z: 2.5 },
        color: 0xffe5c7,
        // intensity: Math.PI,
        intensity: 5,
        castShadow: true,
        // shadowMapSize: [2048, 2048],
        shadowMapSize: [512, 512],
        shadowCamNearFar: [1, 15],
        shadowCamLeftRightTopBottom: [-10, 10, 10, -10],
        shadowBias: -0.01,
        shadowNormalBias: -0.01,
        shadowRadius: 5, // Not for PCFSoftShadowMap type
        shadowBlurSamples: 10, // Only for VSM shadowmap types
        shadowIntensity: 0.75,
      },
    });
    scene.add(directionalLight);

    const redBallProps: MeshProps = {
      geo: {
        type: 'SPHERE',
        params: {
          radius: 0.5,
          widthSegments: 32,
          heightSegments: 32,
        },
      },
      mat: {
        type: 'LAMBERT',
        params: {
          color: 0xff0000,
          roughness: 0.4,
          metalness: 0.2,
        },
      },
      castShadow: false,
      receiveShadow: false,
      preWarm: true,
    };

    // To spawn it:
    const ballId = createMeshEntity(redBallProps);

    // Add the Hover behavior
    ecsWorld.addComponent(ballId, ComponentType.HOVER, {
      speed: 2.0, // How fast it bobs
      amplitude: 0.5, // How high it bobs
      baseY: 1.0, // The center point of the hover
      time: 0, // Start at 0
    });

    // 3. (Optional) Set the initial position
    ecsWorld.setTransform(ballId, { pos: { x: 0, y: 1, z: 0 } });

    // Stress test ECS
    initECSStressTest(undefined, ballId);

    updateLoaderFn({ loadedCount: 2, totalCount: 2 });

    resolve(SCENE_TEST_ECS_ID);
  });
