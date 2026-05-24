import * as THREE from 'three/webgpu';
// import { createScene } from '../_engine/core/Scene';
import { createSkyBox } from '../_engine/core/SkyBox';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { createMeshEntity, MeshProps } from '../_engine/core/_MeshManager';
import { getECSWorld } from '../_engine/core/ECS';
import { initECSStressTest } from '../_engine/utils/ECSStressTest';
import { createCameraEntity, setMainCamera } from '../_engine/core/_CameraManager';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { lookAtPoint } from '../_engine/utils/ECSHelpers';
import { createLightEntity } from '../_engine/core/_LightManager';

export const scene = async () => {
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

  // createScene(SCENE_TEST_ECS_ID, {
  //   name: 'Test scene 1',
  //   isCurrentScene: true,
  // });

  // inspectEntity(camId);

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

  // --- ECS LIGHTS ---

  // Ambient Light
  createLightEntity(
    {
      type: 'AMBIENT',
      color: '#ffffff',
      intensity: 0.5,
    },
    {
      appId: 'ambientLight',
      debugData: {
        name: 'Ambient light',
        description:
          'The ambient light for the scene. It colors everything in the scene (except skyboxes and basic materials) whether you like it or not. This is what next gen games is all about.',
      },
    }
  );

  // Hemisphere Light
  createLightEntity(
    {
      type: 'HEMISPHERE',
      color: 0x220000,
      groundColor: 0x225599,
      intensity: 1.5,
    },
    { appId: 'hemisphereLight' }
  );

  // Point Light
  const pointLightId = createLightEntity(
    {
      type: 'POINT',
      color: 0xffffff,
      intensity: 7,
      distance: 10,
    },
    { appId: 'pointLight' }
  );
  ecsWorld.setTransform(pointLightId, { pos: { x: 2, y: 1, z: 1 } });

  // Directional Light
  const dirLightId = createLightEntity(
    {
      type: 'DIRECTIONAL',
      color: 0xffe5c7,
      intensity: 5,
      castShadow: true,
      shadowMapSize: [512, 512],
      shadowCameraNearFar: [1, 15],
      shadowCameraFrustum: [-10, 10, 10, -10], // Left, Right, Top, Bottom
      shadowBias: -0.01,
      shadowNormalBias: -0.01,
      shadowRadius: 5,
      shadowBlurSamples: 10,
      shadowIntensity: 0.75,
    },
    { appId: 'directionalLight' }
  );
  ecsWorld.setTransform(dirLightId, { pos: { x: -5, y: 2.5, z: 2.5 } });

  // Spot Light (From the top)
  createLightEntity(
    {
      type: 'SPOT',
      color: '#ffffff',
      intensity: 10, // Higher intensity for dramatic effect
      distance: 50, // Range of the light
      angle: Math.PI / 6, // The cone angle (30 degrees)
      penumbra: 0.5, // Softness of the cone edges
      decay: 0.5, // Light falloff
      castShadow: true,
      shadowMapSize: [1024, 1024],
      shadowCameraNearFar: [1, 48],
      position: { x: 0, y: 15, z: 0 },
      targetPos: { x: 0, y: 0, z: 0 }, // Point at the center/ball
    },
    {
      appId: 'topSpotLight',
      debugData: { name: 'Top Spot Light' },
    }
  );

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
        // roughness: 0.4,
        // metalness: 0.2,
      },
    },
    castShadow: true,
    receiveShadow: true,
    preWarm: false,
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

  // Ground
  const groundProps: MeshProps = {
    geo: {
      type: 'BOX',
      params: {
        width: 30,
        height: 30,
        depth: 0.1,
      },
    },
    mat: {
      type: 'LAMBERT',
      params: { color: 0x429925 },
    },
    castShadow: true,
    receiveShadow: true,
    preWarm: false,
    position: { y: -1 },
    rotation: { x: Math.PI / 2 },
  };
  createMeshEntity(groundProps, { appId: 'ground', debugData: { name: 'Ground' } }, ecsWorld);

  // Stress test ECS
  initECSStressTest(undefined, ballId);

  updateLoaderFn({ loadedCount: 2, totalCount: 2 });
};
