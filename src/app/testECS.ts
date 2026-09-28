import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { createMeshEntity, getMeshByAppId, MeshProps } from '../_engine/core/MeshManager';
import { ECSWorld, getECSWorld } from '../_engine/core/ECS';
import { initECSStressTest } from '../_engine/utils/ECSStressTest';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { createLightEntity } from '../_engine/core/LightManager';
import { createCameraEntity } from '../_engine/core/CameraManager';
import { registerHoverToolEffect } from '../toolkit/ecs/effects/HoverEffect';
import { getMaterial, getMaterialRegistry } from '../_engine/core/Material'; // TEMP p210

export const scene = async () => {
  const updateLoaderFn = getLoaderStatusUpdater();
  updateLoaderFn({ loadedCount: 0, totalCount: 2 });

  const ecsWorld = getECSWorld();

  updateLoaderFn({ loadedCount: 1, totalCount: 2 });

  // --- ECS CAMERA ---

  // Orthographic Camera
  createCameraEntity(
    {
      type: 'ORTHOGRAPHIC',
      frustumSize: 20,
      near: 0.1,
      far: 2000,
      position: { x: 10, y: 10, z: 10 },
      lookAtPoint: { x: 0, y: 0, z: 0 },
    },
    { appId: 'orthoCamera', debugData: { name: 'Ortho camera' } }
  );

  // --- ECS LIGHTS ---

  // Ambient Light
  // createLightEntity(
  //   {
  //     type: 'AMBIENT',
  //     color: '#ffffff',
  //     intensity: 0.5,
  //   },
  //   {
  //     appId: 'ambientLight',
  //     debugData: {
  //       name: 'Ambient light',
  //       description:
  //         'The ambient light for the scene. It colors everything in the scene (except skyboxes and basic materials) whether you like it or not. This is what next gen games is all about.',
  //     },
  //   }
  // );
  // createLightEntity({ type: 'AMBIENT', appId: 'ambientLight' });

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
  ecsWorld.setTransform(pointLightId, { pos: { x: 4, y: 5, z: 4 } });

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

  // TEMP p210 verification: triplanarGrid on a floor, a wall meeting it at a corner, and a rotated box
  const tmpGridMat = getMaterial('triplanarGrid');
  if (tmpGridMat) {
    createMeshEntity(
      {
        geo: { type: 'BOX', params: { width: 8, height: 0.2, depth: 8 } },
        mat: tmpGridMat,
        receiveShadow: true,
        position: { x: 4, y: -0.8, z: 11 },
        matOverrides: { staticDefines: { fitToBounds: true } },
      },
      { appId: 'tmpGridFloor' },
      ecsWorld
    );
    createMeshEntity(
      {
        geo: { type: 'BOX', params: { width: 8, height: 4, depth: 0.2 } },
        mat: tmpGridMat,
        receiveShadow: true,
        position: { x: 4, y: 1.3, z: 7 },
      },
      { appId: 'tmpGridWall' },
      ecsWorld
    );
    createMeshEntity(
      {
        geo: { type: 'BOX', params: { width: 2.6, height: 1.8, depth: 2.2 } },
        mat: tmpGridMat,
        castShadow: true,
        position: { x: 7.6, y: 3.2, z: 15.2 },
        rotation: { y: Math.PI / 4 },
        matOverrides: {
          staticDefines: { fitToBounds: true },
          nodes: {
            colorNode: {
              lineColor: '#1f2a36',
              backgroundColor: '#5d88b0',
              minorLineColor: '#4f779c',
            },
          },
        },
      },
      { appId: 'tmpGridBox' },
      ecsWorld
    );
    createMeshEntity(
      {
        geo: { type: 'SPHERE', params: { radius: 1.2, widthSegments: 48, heightSegments: 32 } },
        mat: tmpGridMat,
        castShadow: true,
        position: { x: 13.5, y: 1.2, z: 9 },
        matOverrides: {
          staticDefines: { seamNormals: false },
          nodes: { colorNode: { lineFrequency: 0.5 } },
        },
      },
      { appId: 'tmpGridSphere' },
      ecsWorld
    );
    // Same overrides as the floor: should share its variant
    createMeshEntity(
      {
        geo: { type: 'BOX', params: { width: 0.7, height: 2.5, depth: 0.7 } },
        mat: tmpGridMat,
        castShadow: true,
        position: { x: 1, y: 0.55, z: 13.5 },
        matOverrides: { staticDefines: { fitToBounds: true } },
      },
      { appId: 'tmpGridPillar' },
      ecsWorld
    );
    // eslint-disable-next-line no-console
    console.log(
      '[TEMP p210] variants:',
      Object.keys(getMaterialRegistry()).filter((id) => id.startsWith('triplanarGrid')),
      ['tmpGridFloor', 'tmpGridWall', 'tmpGridBox', 'tmpGridSphere', 'tmpGridPillar'].map(
        (appId) =>
          `${appId}=${(getMeshByAppId(appId)?.material as { userData: { id?: string } })?.userData.id}`
      )
    );
  }

  // Second world
  const uiWorld = new ECSWorld({ id: 'ui', applyGlobalPlugins: false });
  registerHoverToolEffect(uiWorld);
  const ball2Id = createMeshEntity(redBallProps, undefined, uiWorld);
  uiWorld.setTransform(ball2Id, { pos: { x: 4, y: 6, z: -5 } });
  uiWorld.addComponent(ball2Id, ComponentType.HOVER, {
    speed: 3.14, // How fast it bobs
    amplitude: 0.85, // How high it bobs
    baseY: 6.0, // The center point of the hover
    time: 0, // Start at 0
  });

  // Stress test ECS
  initECSStressTest(undefined, ballId);

  updateLoaderFn({ loadedCount: 2, totalCount: 2 });
};
