import * as THREE from 'three/webgpu';
import { createScene } from '../_engine/core/Scene';
import { createLight } from '../_engine/core/Light';
import { createSkyBox } from '../_engine/core/SkyBox';
import { getCamera, setCurrentCamera } from '../_engine/core/Camera';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { MAIN_APP_CAM_ID } from '../CONFIG';
import { createMeshEntity, MeshProps } from '../_engine/core/_MeshManager';
import { ECSSystemStage, ECSWorld, getECSWorld } from '../_engine/core/ECS';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { initECSStressTest } from '../_engine/utils/ECSStressTest';

export const SCENE_TEST_ECS_ID = 'sceneTestECS';

export const sceneTestECS = async () =>
  new Promise<string>(async (resolve) => {
    const updateLoaderFn = getLoaderStatusUpdater();
    updateLoaderFn({ loadedCount: 0, totalCount: 2 });

    // Set current camera and position it
    const camera = getCamera(MAIN_APP_CAM_ID);
    setCurrentCamera(MAIN_APP_CAM_ID);
    camera.position.z = 3;
    camera.position.x = 2.5;
    camera.position.y = 1;

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

    const ecsWorld = getECSWorld();

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
    console.log('BALL IS ALIVE', ballId);

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
